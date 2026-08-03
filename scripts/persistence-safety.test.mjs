import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createProjectFromMarkdown,
  discardPreparedProjectMutationSnapshot,
  getProjectPersistenceDebugState,
  openProjectFolder,
  prepareProjectMutationSnapshot,
  readProjectComments,
  readProjectPatches,
  readProjectRewriteSessionRecords,
  resetProjectPersistenceDebugState,
  restoreProjectLastKnownGood,
  saveProjectRewriteSessionRecord,
  saveProjectStateWithRewriteSessionRecord,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import {
  buildRewriteReviewRequest,
  createRewriteSession,
  importRewriteReview,
  updateRewriteDraft
} from "../lib/rewrite-workspace/rewrite-review-protocol.ts";
import {
  createRewriteSessionPersistenceCoordinator,
  RewriteSessionPersistenceError
} from "../lib/rewrite-workspace/rewrite-session-persistence.ts";
import {
  createMemoryRewriteSessionStorage,
  readLegacyRewriteSessions,
  readRewriteRecoveryCopies,
  saveLegacyRewriteSessionForTests,
  saveRewriteRecoveryCopy,
  setRewriteSessionStorageForTests
} from "../lib/rewrite-workspace/rewrite-session-storage.ts";

const picker = { root: null };
globalThis.window = {
  showDirectoryPicker: async () => picker.root
};

async function run() {
const noOpFixture = await createInitializedFixture("no-op");
resetProjectPersistenceDebugState(noOpFixture.project);
const noOpResult = await saveProjectState({
  comments: noOpFixture.comments,
  markdown: noOpFixture.markdown,
  patches: noOpFixture.patches,
  project: noOpFixture.project,
  reason: "test_no_op"
});
const noOpDebug = getProjectPersistenceDebugState(noOpFixture.project);
assert.equal(noOpResult.status, "unchanged");
assert.equal(noOpResult.generation, 0);
assert.equal(noOpDebug.serializationCount, 0);
assert.equal(noOpDebug.writeCount, 0);
assert.equal(noOpDebug.bytesWritten, 0);

const rapidFixture = await createInitializedFixture("rapid");
resetProjectPersistenceDebugState(rapidFixture.project);
const rapidRequests = [];
for (let index = 1; index <= 100; index += 1) {
  rapidRequests.push(
    saveProjectState({
      comments: [createComment(`rapid-${index}`)],
      project: rapidFixture.project,
      reason: "rapid_background_edit",
      allowSupersede: true
    })
  );
}
const rapidResults = await Promise.all(rapidRequests);
const rapidDebug = getProjectPersistenceDebugState(rapidFixture.project);
assert.equal(rapidResults.filter((result) => result.status === "committed").length, 1);
assert.equal(rapidResults.filter((result) => result.status === "superseded").length, 99);
assert.equal(rapidFixture.project.persistence?.generation ?? rapidResults.at(-1).generation, 1);
assert.equal(rapidDebug.committedGenerations, 1);
assert.equal(rapidDebug.staleRequestsSkipped, 99);
assert.equal(
  JSON.parse(rapidFixture.root.read(".patchmark/comments.json"))[0].comment,
  "rapid-100"
);

const delayedFixture = await createInitializedFixture("delayed");
delayedFixture.root.controller.delayNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("comments.json"),
  50
);
const older = saveProjectState({
  comments: [createComment("older")],
  project: delayedFixture.project,
  reason: "delayed_older",
  allowSupersede: true
});
await wait(5);
const newer = saveProjectState({
  comments: [createComment("newer")],
  project: delayedFixture.project,
  reason: "newer",
  allowSupersede: true
});
const [olderResult, newerResult] = await Promise.all([older, newer]);
assert.equal(olderResult.status, "superseded");
assert.equal(newerResult.status, "committed");
assert.equal(
  JSON.parse(delayedFixture.root.read(".patchmark/comments.json"))[0].comment,
  "newer"
);

const patchAcceptanceFixture = await createCommittedFixture("patch-acceptance");
const patchAcceptanceResult = await saveProjectState({
  ...createPatchAcceptanceRequest(patchAcceptanceFixture),
  project: patchAcceptanceFixture.project,
  reason: "accept_patch:PM-PATCH-TEST"
});
assert.equal(patchAcceptanceResult.status, "committed");
assert.equal(patchAcceptanceResult.generation, 2);
assert.equal(
  patchAcceptanceFixture.root.read("document.md"),
  `${patchAcceptanceFixture.markdown}\nAccepted patch content.\n`
);
assert.equal(
  JSON.parse(
    patchAcceptanceFixture.root.read(".patchmark/comments.json")
  )[0].comment,
  "accepted patch comment state"
);
assert.equal(
  JSON.parse(patchAcceptanceFixture.root.read(".patchmark/patches.json"))[0]
    .status,
  "accepted"
);

const dependencyFixture = await createCommittedFixture("patch-dependencies");
const dependencyPatches = [
  {
    ...createPatch("dependency prerequisite"),
    id: "PM-PATCH-DEPENDENCY-1",
    source_import_id: "PM-IMPORT-DEPENDENCY",
    source_patch_key: "base-change",
    depends_on_patch_ids: [],
    depends_on_patch_keys_snapshot: []
  },
  {
    ...createPatch("dependent change"),
    id: "PM-PATCH-DEPENDENCY-2",
    source_import_id: "PM-IMPORT-DEPENDENCY",
    source_patch_key: "dependent-change",
    depends_on_patch_ids: ["PM-PATCH-DEPENDENCY-1"],
    depends_on_patch_keys_snapshot: ["base-change"]
  }
];
await saveProjectState({
  patches: dependencyPatches,
  project: dependencyFixture.project,
  reason: "persist_patch_dependencies"
});
picker.root = dependencyFixture.root;
const reopenedDependencyFixture = await openProjectFolder();
assert.ok(reopenedDependencyFixture);
const reopenedDependencyPatches = await readProjectPatches(
  reopenedDependencyFixture.project
);
assert.deepEqual(
  reopenedDependencyPatches.map((patch) => ({
    dependsOnIds: patch.depends_on_patch_ids,
    dependsOnKeys: patch.depends_on_patch_keys_snapshot,
    id: patch.id,
    sourcePatchKey: patch.source_patch_key
  })),
  [
    {
      dependsOnIds: [],
      dependsOnKeys: [],
      id: "PM-PATCH-DEPENDENCY-1",
      sourcePatchKey: "base-change"
    },
    {
      dependsOnIds: ["PM-PATCH-DEPENDENCY-1"],
      dependsOnKeys: ["base-change"],
      id: "PM-PATCH-DEPENDENCY-2",
      sourcePatchKey: "dependent-change"
    }
  ]
);

const dependencyFailureFixture = await createCommittedFixture(
  "patch-dependency-failure"
);
const dependencyFailurePatchesBefore = dependencyFailureFixture.root.read(
  ".patchmark/patches.json"
);
const dependencyFailureCommitBefore = dependencyFailureFixture.root.read(
  ".patchmark/save-commit.json"
);
dependencyFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/patches.json"
);
await assert.rejects(() =>
  saveProjectState({
    patches: dependencyPatches,
    project: dependencyFailureFixture.project,
    reason: "persist_patch_dependencies_failure"
  })
);
assert.equal(
  dependencyFailureFixture.root.read(".patchmark/patches.json"),
  dependencyFailurePatchesBefore
);
assert.equal(
  dependencyFailureFixture.root.read(".patchmark/save-commit.json"),
  dependencyFailureCommitBefore
);

const commentTrashFailureFixture = await createCommittedFixture(
  "comment-trash-failure"
);
const commentTrashCommentsBefore = commentTrashFailureFixture.root.read(
  ".patchmark/comments.json"
);
const commentTrashCommitBefore = commentTrashFailureFixture.root.read(
  ".patchmark/save-commit.json"
);
const commentTrashNextComments = commentTrashFailureFixture.comments.map(
  (comment) => ({
    ...comment,
    trashed_at: "2026-07-31T04:00:00.000Z",
    trash_operation_id: "comment_trash_fault_injection"
  })
);
commentTrashFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/comments.json"
);
await assert.rejects(() =>
  saveProjectState({
    comments: commentTrashNextComments,
    project: commentTrashFailureFixture.project,
    reason: "comment_trash_fault_injection",
    rollbackOnFailure: true
  })
);
assert.equal(
  commentTrashFailureFixture.root.read(".patchmark/comments.json"),
  commentTrashCommentsBefore
);
assert.equal(
  commentTrashFailureFixture.root.read(".patchmark/save-commit.json"),
  commentTrashCommitBefore
);

const commentRestoreFailureFixture = await createCommittedFixture(
  "comment-restore-failure"
);
const committedTrashedComments = commentRestoreFailureFixture.comments.map(
  (comment) => ({
    ...comment,
    trashed_at: "2026-07-31T04:00:00.000Z",
    trash_operation_id: "comment_trash_before_restore_failure"
  })
);
await saveProjectState({
  comments: committedTrashedComments,
  project: commentRestoreFailureFixture.project,
  reason: "establish_trashed_comments",
  rollbackOnFailure: true
});
const commentRestoreCommentsBefore =
  commentRestoreFailureFixture.root.read(".patchmark/comments.json");
const commentRestoreCommitBefore = commentRestoreFailureFixture.root.read(
  ".patchmark/save-commit.json"
);
commentRestoreFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/comments.json"
);
await assert.rejects(() =>
  saveProjectState({
    comments: committedTrashedComments.map((comment) => ({
      ...comment,
      trashed_at: undefined,
      trash_operation_id: undefined,
      restored_at: "2026-07-31T05:00:00.000Z"
    })),
    project: commentRestoreFailureFixture.project,
    reason: "comment_restore_fault_injection",
    rollbackOnFailure: true
  })
);
assert.equal(
  commentRestoreFailureFixture.root.read(".patchmark/comments.json"),
  commentRestoreCommentsBefore
);
assert.equal(
  commentRestoreFailureFixture.root.read(".patchmark/save-commit.json"),
  commentRestoreCommitBefore
);

const permanentDeleteFailureFixture = await createCommittedFixture(
  "comment-permanent-delete-failure"
);
const permanentlyDeletedComment = {
  ...permanentDeleteFailureFixture.comments[0],
  trashed_at: "2026-07-31T06:00:00.000Z",
  trash_operation_id: "comment_trash_before_permanent_delete_failure"
};
const permanentlyDeletedPatch = {
  ...createPatch("permanent deletion fault injection"),
  comment_id: permanentlyDeletedComment.id
};
await saveProjectState({
  comments: [permanentlyDeletedComment],
  patches: [permanentlyDeletedPatch],
  project: permanentDeleteFailureFixture.project,
  reason: "establish_permanent_delete_fixture",
  rollbackOnFailure: true
});
const permanentDeleteCommentsBefore =
  permanentDeleteFailureFixture.root.read(".patchmark/comments.json");
const permanentDeletePatchesBefore =
  permanentDeleteFailureFixture.root.read(".patchmark/patches.json");
const permanentDeleteManifestBefore =
  permanentDeleteFailureFixture.root.read(".patchmark/manifest.json");
const permanentDeleteCommitBefore =
  permanentDeleteFailureFixture.root.read(".patchmark/save-commit.json");
const permanentDeleteNextManifest = {
  ...permanentDeleteFailureFixture.project.manifest,
  comment_deletion_tombstones: [
    {
      schema_version: 1,
      project_id:
        permanentDeleteFailureFixture.project.manifest.project_id,
      document_id:
        permanentDeleteFailureFixture.project.manifest.document_id,
      comment_id: permanentlyDeletedComment.id,
      permanently_deleted_at: "2026-07-31T07:00:00.000Z",
      permanent_delete_operation_id: "comment_delete_fault_injection",
      original_status: permanentlyDeletedComment.status,
      had_accepted_patches: false,
      patches: [
        {
          patch_id: permanentlyDeletedPatch.id,
          status: permanentlyDeletedPatch.status
        }
      ]
    }
  ]
};
permanentDeleteFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/manifest.json"
);
await assert.rejects(() =>
  saveProjectState({
    comments: [],
    manifest: permanentDeleteNextManifest,
    patches: [],
    project: permanentDeleteFailureFixture.project,
    reason: "comment_delete_fault_injection",
    rollbackOnFailure: true
  })
);
assert.equal(
  permanentDeleteFailureFixture.root.read(".patchmark/comments.json"),
  permanentDeleteCommentsBefore
);
assert.equal(
  permanentDeleteFailureFixture.root.read(".patchmark/patches.json"),
  permanentDeletePatchesBefore
);
assert.equal(
  permanentDeleteFailureFixture.root.read(".patchmark/manifest.json"),
  permanentDeleteManifestBefore
);
assert.equal(
  permanentDeleteFailureFixture.root.read(".patchmark/save-commit.json"),
  permanentDeleteCommitBefore
);
const permanentDeleteDocumentBefore =
  permanentDeleteFailureFixture.root.read("document.md");
await saveProjectState({
  comments: [],
  manifest: permanentDeleteNextManifest,
  patches: [],
  project: permanentDeleteFailureFixture.project,
  reason: "comment_delete_success_after_retry",
  rollbackOnFailure: true
});
picker.root = permanentDeleteFailureFixture.root;
const reopenedPermanentDeleteFixture = await openProjectFolder();
assert.ok(reopenedPermanentDeleteFixture);
assert.equal(
  (await readProjectComments(reopenedPermanentDeleteFixture.project)).length,
  0
);
assert.equal(
  (await readProjectPatches(reopenedPermanentDeleteFixture.project)).length,
  0
);
assert.equal(
  reopenedPermanentDeleteFixture.project.manifest
    .comment_deletion_tombstones?.[0]?.comment_id,
  permanentlyDeletedComment.id
);
assert.equal(
  permanentDeleteFailureFixture.root.read("document.md"),
  permanentDeleteDocumentBefore
);

const authoritativeRewriteFixture = await createCommittedFixture(
  "authoritative-rewrite"
);
const authoritativeRewriteSession = await createReviewedRewriteSession(
  authoritativeRewriteFixture
);
const authoritativeContentBefore = snapshotPaths(authoritativeRewriteFixture.root, [
  "document.md",
  ".patchmark/comments.json",
  ".patchmark/patches.json"
]);
const authoritativeVersionsBefore =
  authoritativeRewriteFixture.project.manifest.versions?.length ?? 0;
const authoritativeRewriteSave = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: authoritativeRewriteFixture.project,
  reason: "save_human_rewrite_draft",
  record: authoritativeRewriteSession
});
assert.equal(authoritativeRewriteSave.record.status, "draft");
assert.equal(authoritativeRewriteSave.record.authoritative_revision, 1);
assert.equal(
  authoritativeRewriteSave.record.authoritative_generation,
  authoritativeRewriteSave.commit.generation
);
assert.equal(authoritativeRewriteSave.commit.changedFiles.includes("rewrite_sessions"), true);
assert.equal(authoritativeRewriteSave.commit.changedFiles.includes("document"), false);
assert.deepEqual(
  snapshotPaths(authoritativeRewriteFixture.root, Object.keys(authoritativeContentBefore)),
  authoritativeContentBefore,
  "Saving a Human Rewrite draft must not alter document content stores."
);
assert.equal(
  authoritativeRewriteFixture.project.manifest.versions?.length ?? 0,
  authoritativeVersionsBefore
);
const authoritativeStore = JSON.parse(
  authoritativeRewriteFixture.root.read(".patchmark/rewrite-sessions.json")
);
assert.equal(authoritativeStore.sessions[0].human_draft, authoritativeRewriteSession.human_draft);
assert.equal(authoritativeStore.sessions[0].review_rounds.length, 1);
picker.root = authoritativeRewriteFixture.root;
const reopenedAuthoritativeRewrite = await openProjectFolder();
assert.ok(reopenedAuthoritativeRewrite);
const reopenedRewriteRecords = await readProjectRewriteSessionRecords(
  reopenedAuthoritativeRewrite.project
);
assert.equal(reopenedRewriteRecords[0].human_draft, authoritativeRewriteSession.human_draft);
assert.equal(reopenedRewriteRecords[0].review_rounds[0].status, "imported");

const concurrentRewriteFixture = await createCommittedFixture("concurrent-rewrite");
picker.root = concurrentRewriteFixture.root;
const concurrentWindowA = await openProjectFolder();
const concurrentWindowB = await openProjectFolder();
assert.ok(concurrentWindowA && concurrentWindowB);
const concurrentSessionA = await createRewriteFixtureSession(concurrentRewriteFixture, "Window A");
const concurrentSessionB = await createRewriteFixtureSession(concurrentRewriteFixture, "Window B");
await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: concurrentWindowA.project,
  reason: "concurrent_window_a",
  record: concurrentSessionA
});
await assert.rejects(
  saveProjectRewriteSessionRecord({
    expectedRevision: 0,
    project: concurrentWindowB.project,
    reason: "concurrent_window_b",
    record: concurrentSessionB
  }),
  /changed in another Patchmark window|project changed before this save could finish/
);
assert.equal(
  JSON.parse(concurrentRewriteFixture.root.read(".patchmark/rewrite-sessions.json"))
    .sessions[0].human_draft,
  concurrentSessionA.human_draft
);

const orderedRewriteFixture = await createCommittedFixture("ordered-rewrite");
setRewriteSessionStorageForTests(createMemoryRewriteSessionStorage());
const orderedRewriteCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: "local_rewrite_test",
  project: orderedRewriteFixture.project
});
const orderedRewriteFirst = await createRewriteFixtureSession(
  orderedRewriteFixture,
  "First queued draft."
);
const orderedRewriteSecond = await updateRewriteDraft({
  humanDraft: `${orderedRewriteFirst.base_text}\n\nSecond queued draft.`,
  intentNote: orderedRewriteFirst.intent_note,
  session: orderedRewriteFirst
});
orderedRewriteFixture.root.controller.delayNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("rewrite-sessions.json"),
  40
);
const [orderedFirstResult, orderedSecondResult] = await Promise.all([
  orderedRewriteCoordinator.persist(orderedRewriteFirst, "ordered_rewrite_first"),
  orderedRewriteCoordinator.persist(orderedRewriteSecond, "ordered_rewrite_second")
]);
assert.equal(orderedFirstResult.queueLength, 1);
assert.equal(orderedSecondResult.queueLength, 2);
assert.equal(orderedSecondResult.session.authoritative_revision, 2);
assert.equal(
  JSON.parse(orderedRewriteFixture.root.read(".patchmark/rewrite-sessions.json"))
    .sessions[0].human_draft,
  orderedRewriteSecond.human_draft
);
setRewriteSessionStorageForTests(null);

const identicalRecoveryFixture = await createCommittedFixture(
  "identical-rewrite-recovery"
);
const identicalRecoveryStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(identicalRecoveryStorage);
const identicalRecoverySession = await createRewriteFixtureSession(
  identicalRecoveryFixture,
  "Identical project and browser draft."
);
const identicalRecoveryProjectSave = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: identicalRecoveryFixture.project,
  reason: "identical_recovery_project_save",
  record: identicalRecoverySession
});
await saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision:
    identicalRecoveryProjectSave.record.authoritative_revision,
  recoveryRevision: 2,
  session: identicalRecoveryProjectSave.record
});
const identicalRecoveryLoad = await createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: identicalRecoverySession.local_project_instance_id,
  project: identicalRecoveryFixture.project
}).load();
assert.equal(identicalRecoveryLoad.conflict, null);
assert.equal(identicalRecoveryLoad.source, "project");
assert.deepEqual(
  await readRewriteRecoveryCopies({
    documentId: identicalRecoverySession.document_id,
    localProjectInstanceId: identicalRecoverySession.local_project_instance_id,
    projectId: identicalRecoverySession.project_id
  }),
  []
);

const newerRecoveryFixture = await createCommittedFixture("newer-rewrite-recovery");
const newerRecoveryStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(newerRecoveryStorage);
const newerRecoverySession = await createRewriteFixtureSession(
  newerRecoveryFixture,
  "Project draft before a browser-only edit."
);
const newerRecoveryProjectSave = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: newerRecoveryFixture.project,
  reason: "newer_recovery_project_save",
  record: newerRecoverySession
});
const browserOnlyNewerSession = await updateRewriteDraft({
  humanDraft: `${newerRecoveryProjectSave.record.human_draft}\n\nNewer browser-only edit.`,
  intentNote: newerRecoveryProjectSave.record.intent_note,
  session: newerRecoveryProjectSave.record
});
await saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision:
    newerRecoveryProjectSave.record.authoritative_revision,
  recoveryRevision: 3,
  session: browserOnlyNewerSession
});
const newerRecoveryCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: newerRecoverySession.local_project_instance_id,
  project: newerRecoveryFixture.project
});
const newerRecoveryLoad = await newerRecoveryCoordinator.load();
assert.equal(newerRecoveryLoad.conflict?.kind, "newer_recovery");
assert.equal(newerRecoveryLoad.session?.human_draft, newerRecoverySession.human_draft);
const recoveredBrowserSession = await newerRecoveryCoordinator.resolveConflict(
  newerRecoveryLoad.conflict,
  "recovery"
);
assert.equal(recoveredBrowserSession?.human_draft, browserOnlyNewerSession.human_draft);
assert.equal(recoveredBrowserSession?.authoritative_revision, 2);

const recoveryOnlyFixture = await createCommittedFixture("recovery-only-rewrite");
const recoveryOnlyStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(recoveryOnlyStorage);
const recoveryOnlyCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: "local_rewrite_test",
  project: recoveryOnlyFixture.project
});
const recoveryOnlySession = await createRewriteFixtureSession(
  recoveryOnlyFixture,
  "Recovery survives the failed project save."
);
recoveryOnlyFixture.root.controller.failNext(
  (path) => path === ".patchmark/rewrite-sessions.json"
);
await assert.rejects(
  recoveryOnlyCoordinator.persist(recoveryOnlySession, "injected_rewrite_failure"),
  (error) =>
    error instanceof RewriteSessionPersistenceError && error.recoverySaved === true
);
assert.equal(
  (await readRewriteRecoveryCopies({
    documentId: recoveryOnlySession.document_id,
    localProjectInstanceId: recoveryOnlySession.local_project_instance_id,
    projectId: recoveryOnlySession.project_id
  }))[0]?.session.human_draft,
  recoveryOnlySession.human_draft
);
const recoveredProjectSave = await recoveryOnlyCoordinator.persist(
  recoveryOnlySession,
  "retry_rewrite_project_save"
);
assert.equal(recoveredProjectSave.session.authoritative_revision, 1);
assert.deepEqual(
  await readRewriteRecoveryCopies({
    documentId: recoveryOnlySession.document_id,
    localProjectInstanceId: recoveryOnlySession.local_project_instance_id,
    projectId: recoveryOnlySession.project_id
  }),
  []
);

recoveryOnlyFixture.root.controller.failNext(
  (path) => path === ".patchmark/rewrite-sessions.json"
);
await assert.rejects(
  recoveryOnlyCoordinator.discard(recoveredProjectSave.session),
  (error) =>
    error instanceof RewriteSessionPersistenceError && error.recoverySaved === true
);
assert.equal(
  (await readProjectRewriteSessionRecords(recoveryOnlyFixture.project))[0].status,
  "draft"
);

const bothWritesFailFixture = await createCommittedFixture("rewrite-both-writes-fail");
const unavailableRecoveryStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests({
  ...unavailableRecoveryStorage,
  async put() {
    throw new Error("Injected browser recovery failure.");
  }
});
const bothWritesFailSession = await createRewriteFixtureSession(
  bothWritesFailFixture,
  "Unsaved in-memory draft"
);
const bothWritesFailCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: "local_rewrite_test",
  project: bothWritesFailFixture.project
});
bothWritesFailFixture.root.controller.failNext(
  (path) => path === ".patchmark/rewrite-sessions.json"
);
await assert.rejects(
  bothWritesFailCoordinator.persist(bothWritesFailSession, "both_writes_fail"),
  (error) =>
    error instanceof RewriteSessionPersistenceError && error.recoverySaved === false
);
assert.equal(bothWritesFailFixture.root.has(".patchmark/rewrite-sessions.json"), false);

const legacyMigrationFixture = await createCommittedFixture("legacy-rewrite-migration");
const legacyMigrationStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(legacyMigrationStorage);
const legacyMigrationSession = await createReviewedRewriteSession(legacyMigrationFixture);
await saveLegacyRewriteSessionForTests(legacyMigrationSession);
const legacyMigrationCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: legacyMigrationSession.local_project_instance_id,
  project: legacyMigrationFixture.project
});
const legacyMigrationResult = await legacyMigrationCoordinator.load();
assert.equal(legacyMigrationResult.notice, "legacy_migrated");
assert.equal(legacyMigrationResult.source, "project");
assert.equal(legacyMigrationResult.session?.human_draft, legacyMigrationSession.human_draft);
assert.equal(legacyMigrationResult.session?.review_rounds.length, 1);
assert.deepEqual(
  await readLegacyRewriteSessions({
    documentId: legacyMigrationSession.document_id,
    localProjectInstanceId: legacyMigrationSession.local_project_instance_id,
    projectId: legacyMigrationSession.project_id
  }),
  []
);

const terminalRewriteFixture = await createCommittedFixture("terminal-rewrite");
const terminalStorage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(terminalStorage);
const terminalSession = await createRewriteFixtureSession(
  terminalRewriteFixture,
  "This stale browser draft must not return."
);
const activeTerminalSave = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: terminalRewriteFixture.project,
  reason: "terminal_fixture_active",
  record: terminalSession
});
await saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision: activeTerminalSave.record.authoritative_revision,
  recoveryRevision: 2,
  session: activeTerminalSave.record
});
await saveProjectRewriteSessionRecord({
  expectedRevision: activeTerminalSave.record.authoritative_revision,
  project: terminalRewriteFixture.project,
  reason: "terminal_fixture_discard",
  record: {
    schema_version: 1,
    rewrite_session_id: activeTerminalSave.record.rewrite_session_id,
    local_project_instance_id: activeTerminalSave.record.local_project_instance_id,
    project_id: activeTerminalSave.record.project_id,
    document_id: activeTerminalSave.record.document_id,
    status: "discarded",
    authoritative_revision: activeTerminalSave.record.authoritative_revision,
    authoritative_generation: activeTerminalSave.record.authoritative_generation,
    human_draft_sha256: activeTerminalSave.record.human_draft_sha256,
    updated_at: "2026-08-02T03:00:00.000Z",
    discarded_at: "2026-08-02T03:00:00.000Z"
  }
});
const terminalCoordinator = createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId: terminalSession.local_project_instance_id,
  project: terminalRewriteFixture.project
});
setRewriteSessionStorageForTests({
  ...terminalStorage,
  async delete() {
    throw new Error("Injected terminal recovery cleanup failure.");
  }
});
const terminalLoad = await terminalCoordinator.load();
assert.equal(terminalLoad.session, null);
assert.equal(terminalLoad.source, "none");
assert.equal(
  (await readRewriteRecoveryCopies({
    documentId: terminalSession.document_id,
    localProjectInstanceId: terminalSession.local_project_instance_id,
    projectId: terminalSession.project_id
  })).length,
  1,
  "A failed recovery cleanup may leave bytes behind, but a terminal project record must still block resurrection."
);
setRewriteSessionStorageForTests(null);

const humanRewriteFailureFixture = await createCommittedFixture(
  "human-rewrite-failure"
);
const humanRewriteFailureSession = await createRewriteFixtureSession(
  humanRewriteFailureFixture,
  "The authoritative draft must survive an apply failure."
);
const humanRewriteFailureActive = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: humanRewriteFailureFixture.project,
  reason: "human_rewrite_failure_active_session",
  record: humanRewriteFailureSession
});
const humanRewriteFilesBefore = Object.fromEntries(
  [
    "document.md",
    ".patchmark/comments.json",
    ".patchmark/patches.json",
    ".patchmark/manifest.json",
    ".patchmark/save-commit.json",
    ".patchmark/rewrite-sessions.json"
  ].map((path) => [path, humanRewriteFailureFixture.root.read(path)])
);
const preparedHumanRewriteSnapshot = await prepareProjectMutationSnapshot({
  audit: {
    author_type: "human",
    mutation_type: "human_rewrite",
    rewrite_session_id: "rewrite_session_fault_injection",
    target_kind: "selection",
    heading_snapshot: "human-rewrite-failure",
    base_text_sha256: "a".repeat(64),
    applied_text_sha256: "b".repeat(64),
    semantic_review_status: "not_reviewed"
  },
  markdown: humanRewriteFailureFixture.markdown,
  project: humanRewriteFailureFixture.project,
  reason: "before human rewrite rewrite_session_fault_injection"
});
const preparedHumanRewriteSnapshotPath =
  `.patchmark/versions/${preparedHumanRewriteSnapshot.snapshotFileName}`;
assert.equal(
  humanRewriteFailureFixture.root.has(preparedHumanRewriteSnapshotPath),
  true
);
humanRewriteFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/manifest.json"
);
await assert.rejects(() =>
  saveProjectStateWithRewriteSessionRecord({
    comments: [createComment("human rewrite transformed comment")],
    expectedRevision:
      humanRewriteFailureActive.record.authoritative_revision,
    manifest: preparedHumanRewriteSnapshot.manifest,
    markdown: `${humanRewriteFailureFixture.markdown}\nHuman rewrite.\n`,
    patches: [
      {
        ...createPatch("human rewrite overlapping patch"),
        status: "stale",
        human_rewrite_impact: {
          rewrite_session_id: "rewrite_session_fault_injection",
          applied_at: "2026-08-02T01:00:00.000Z",
          target_kind: "selection",
          heading_snapshot: "human-rewrite-failure",
          reason: "overlapping_human_rewrite"
        }
      }
    ],
    project: humanRewriteFailureFixture.project,
    reason: "apply_human_rewrite:rewrite_session_fault_injection",
    rewriteSessionRecord: {
      schema_version: 1,
      rewrite_session_id: humanRewriteFailureActive.record.rewrite_session_id,
      local_project_instance_id:
        humanRewriteFailureActive.record.local_project_instance_id,
      project_id: humanRewriteFailureActive.record.project_id,
      document_id: humanRewriteFailureActive.record.document_id,
      status: "applied",
      authoritative_revision:
        humanRewriteFailureActive.record.authoritative_revision,
      authoritative_generation:
        humanRewriteFailureActive.record.authoritative_generation,
      human_draft_sha256: humanRewriteFailureActive.record.human_draft_sha256,
      updated_at: "2026-08-02T01:00:00.000Z",
      applied_at: "2026-08-02T01:00:00.000Z",
      version_id: preparedHumanRewriteSnapshot.version.id
    }
  })
);
for (const [path, contents] of Object.entries(humanRewriteFilesBefore)) {
  assert.equal(
    humanRewriteFailureFixture.root.read(path),
    contents,
    `${path} must remain authoritative after a failed human rewrite.`
  );
}
assert.equal(
  humanRewriteFailureFixture.project.manifest.versions?.some(
    (version) => version.id === preparedHumanRewriteSnapshot.version.id
  ) ?? false,
  false
);
assert.equal(
  (await readProjectRewriteSessionRecords(humanRewriteFailureFixture.project))[0]
    .status,
  "draft"
);
await discardPreparedProjectMutationSnapshot({
  project: humanRewriteFailureFixture.project,
  snapshotFileName: preparedHumanRewriteSnapshot.snapshotFileName
});
assert.equal(
  humanRewriteFailureFixture.root.has(preparedHumanRewriteSnapshotPath),
  false
);

const interruptionStages = [
  {
    name: "lkg",
    matcher: (path) => path === ".patchmark/recovery/comments.json.lkg",
    expectsRecovery: false
  },
  {
    name: "temporary",
    matcher: (path) => path.includes(".patchmark-tmp-") && path.endsWith("document.md"),
    expectsRecovery: false
  },
  {
    name: "document_install",
    matcher: (path) => path === "document.md",
    expectsRecovery: false
  },
  {
    name: "comments_install",
    matcher: (path) => path === ".patchmark/comments.json",
    expectsRecovery: true
  },
  {
    name: "patches_install",
    matcher: (path) => path === ".patchmark/patches.json",
    expectsRecovery: true
  },
  {
    name: "manifest_install",
    matcher: (path) => path === ".patchmark/manifest.json",
    expectsRecovery: true
  },
  {
    name: "commit_install",
    matcher: (path) => path === ".patchmark/save-commit.json",
    expectsRecovery: true
  }
];
const interruptionResults = [];

for (const stage of interruptionStages) {
  const fixture = await createCommittedFixture(`failure-${stage.name}`);
  const previousCommit = fixture.root.read(".patchmark/save-commit.json");
  fixture.root.controller.failNext(stage.matcher);
  await assert.rejects(() =>
    saveProjectState({
      ...createPatchAcceptanceRequest(fixture),
      project: fixture.project,
      reason: `failure_${stage.name}`
    })
  );
  assert.equal(
    fixture.root.read(".patchmark/save-commit.json"),
    previousCommit,
    `${stage.name} must not advance commit metadata.`
  );
  picker.root = fixture.root;
  const reopened = await openProjectFolder();
  assert.ok(reopened);
  assert.equal(Boolean(reopened.recovery), stage.expectsRecovery);
  interruptionResults.push({
    stage: stage.name,
    recoveryOffered: Boolean(reopened.recovery)
  });
}

const malformedFixture = await createCommittedFixture("malformed");
const malformedSource = '{"truncated":';
malformedFixture.root.writeDirect(".patchmark/comments.json", malformedSource);
picker.root = malformedFixture.root;
const malformedOpen = await openProjectFolder();
assert.ok(malformedOpen?.recovery?.canRestore);
assert.equal(
  malformedFixture.root.read(".patchmark/comments.json"),
  malformedSource,
  "Startup validation must preserve malformed source bytes."
);
const restored = await restoreProjectLastKnownGood(malformedOpen.project);
assert.equal(restored.recovery, undefined);
assert.doesNotThrow(() => JSON.parse(malformedFixture.root.read(".patchmark/comments.json")));
assert.ok(
  malformedFixture.root.findPaths((path) =>
    path.includes(".patchmark/recovery/questionable-") &&
    path.endsWith("comments.json")
  ).some((path) => malformedFixture.root.read(path) === malformedSource),
  "Restore must retain the questionable malformed file."
);

const malformedRewriteFixture = await createCommittedFixture("malformed-rewrite");
const malformedRewriteFirst = await createRewriteFixtureSession(
  malformedRewriteFixture,
  "Last-known-good rewrite draft."
);
const malformedRewriteFirstSave = await saveProjectRewriteSessionRecord({
  expectedRevision: 0,
  project: malformedRewriteFixture.project,
  reason: "malformed_rewrite_first",
  record: malformedRewriteFirst
});
const malformedRewriteSecond = await updateRewriteDraft({
  humanDraft: `${malformedRewriteFirst.human_draft}\n\nNewer draft that will be corrupted.`,
  intentNote: malformedRewriteFirst.intent_note,
  session: malformedRewriteFirstSave.record
});
await saveProjectRewriteSessionRecord({
  expectedRevision: malformedRewriteFirstSave.record.authoritative_revision,
  project: malformedRewriteFixture.project,
  reason: "malformed_rewrite_second",
  record: malformedRewriteSecond
});
malformedRewriteFixture.root.writeDirect(
  ".patchmark/rewrite-sessions.json",
  '{"truncated":'
);
picker.root = malformedRewriteFixture.root;
const malformedRewriteOpen = await openProjectFolder();
assert.ok(malformedRewriteOpen?.recovery?.canRestore);
const restoredMalformedRewrite = await restoreProjectLastKnownGood(
  malformedRewriteOpen.project
);
const restoredRewriteRecords = await readProjectRewriteSessionRecords(
  restoredMalformedRewrite.project
);
assert.equal(restoredRewriteRecords[0].human_draft, malformedRewriteFirst.human_draft);

const staleTemporaryFixture = await createCommittedFixture("stale-temporary");
staleTemporaryFixture.root.writeDirect(
  ".patchmark/.patchmark-tmp-stale-comments.json",
  "stale"
);
picker.root = staleTemporaryFixture.root;
const staleTemporaryOpen = await openProjectFolder();
assert.ok(staleTemporaryOpen);
assert.equal(
  staleTemporaryFixture.root.has(
    ".patchmark/.patchmark-tmp-stale-comments.json"
  ),
  false
);

const legacyRoot = createLegacyFixture("legacy");
picker.root = legacyRoot;
legacyRoot.controller.resetLog();
const legacyOpen = await openProjectFolder();
assert.ok(legacyOpen);
assert.equal(legacyOpen.recovery, undefined);
assert.equal(legacyRoot.controller.completedWrites.length, 0);
const legacyComments = await readProjectComments(legacyOpen.project);
const legacyPatches = await readProjectPatches(legacyOpen.project);
const legacyCommit = await saveProjectState({
  comments: [...legacyComments, createComment("legacy first change")],
  patches: legacyPatches,
  project: legacyOpen.project,
  reason: "legacy_first_change"
});
assert.equal(legacyCommit.generation, 1);
assert.ok(legacyRoot.has(".patchmark/save-commit.json"));

const verifiedCommit = JSON.parse(legacyRoot.read(".patchmark/save-commit.json"));
for (const [key, path] of Object.entries({
  document: "document.md",
  comments: ".patchmark/comments.json",
  patches: ".patchmark/patches.json",
  manifest: ".patchmark/manifest.json"
})) {
  const text = legacyRoot.read(path);
  assert.equal(verifiedCommit.files[key].bytes, Buffer.byteLength(text));
  assert.equal(
    verifiedCommit.files[key].sha256,
    crypto.createHash("sha256").update(text).digest("hex")
  );
}

process.stdout.write(
  `${JSON.stringify({
    noOp: noOpDebug,
    rapidEdits: rapidDebug,
    delayedWrite: { older: olderResult.status, newer: newerResult.status },
    patchAcceptanceGeneration: patchAcceptanceResult.generation,
    dependencyPersistenceRestart: true,
    dependencyFailurePreservedCommit: true,
    commentTrashFailureRolledBackAtomically: true,
    commentRestoreFailureRolledBackAtomically: true,
    permanentDeleteFailureRolledBackAtomically: true,
    permanentDeleteRestartPersistence: true,
    authoritativeRewritePersistence: true,
    authoritativeRewriteRestart: true,
    rewriteVersionHistoryIsolation: true,
    concurrentRewriteStaleWriteRejected: true,
    orderedRewriteSaves: true,
    identicalRewriteRecoveryDeduplicated: true,
    newerRewriteRecoveryExplicitlyRecovered: true,
    recoveryOnlyFailureState: true,
    rewriteDiscardFailurePreservesDraft: true,
    bothRewriteStoresFailureState: true,
    legacyRewriteMigration: true,
    terminalRewriteResurrectionBlocked: true,
    humanRewriteFailureRolledBackAtomically: true,
    interruptionResults,
    malformedRecovery: true,
    malformedRewriteRecovery: true,
    staleTemporaryCleanup: true,
    legacyBaselineGeneration: legacyCommit.generation,
    commitHashesVerified: true
  }, null, 2)}\n`
);
}

function snapshotPaths(root, paths) {
  return Object.fromEntries(paths.map((path) => [path, root.read(path)]));
}

async function createRewriteFixtureSession(fixture, draftSuffix = "Project-backed draft") {
  const projectId =
    fixture.project.projectManifest?.project_id ?? fixture.project.manifest.project_id;
  const documentId =
    fixture.project.document?.document_id ?? fixture.project.manifest.document_id;
  assert.ok(projectId && documentId);
  const baseText = "Initial document.";
  const baseStart = fixture.markdown.indexOf(baseText);
  const session = await createRewriteSession({
    baseDocumentGeneration: fixture.project.persistence.generation,
    baseText,
    documentId,
    documentTitle: fixture.project.document?.title ?? fixture.project.manifest.project_name,
    localProjectInstanceId: "local_rewrite_test",
    markdown: fixture.markdown,
    projectId,
    projectTitle:
      fixture.project.projectManifest?.project_title ?? fixture.project.manifest.project_name,
    target: {
      kind: "selection",
      heading_snapshot: fixture.project.manifest.project_name,
      heading_level: 1,
      heading_path: [fixture.project.manifest.project_name],
      base_start: baseStart,
      base_end: baseStart + baseText.length,
      context_before: fixture.markdown.slice(Math.max(0, baseStart - 64), baseStart),
      context_after: fixture.markdown.slice(baseStart + baseText.length, baseStart + baseText.length + 64)
    }
  });
  return updateRewriteDraft({
    humanDraft: `${baseText}\n\n${draftSuffix}`,
    intentNote: "Preserve meaning while improving clarity.",
    session
  });
}

async function createReviewedRewriteSession(fixture) {
  const session = await createRewriteFixtureSession(
    fixture,
    "A semantic review is stored with this draft."
  );
  const request = await buildRewriteReviewRequest(session);
  const round = request.session.review_rounds.at(-1);
  assert.ok(round);
  return importRewriteReview({
    responseText: JSON.stringify({
      protocol: "patchmark.human_rewrite_review_import",
      protocol_version: 1,
      rewrite_session_id: request.session.rewrite_session_id,
      rewrite_review_id: round.rewrite_review_id,
      project_id: round.request_project_id,
      document_id: round.request_document_id,
      base_text_sha256: round.base_text_sha256,
      human_draft_sha256: round.human_draft_sha256,
      overall_assessment: "meaning_preserved",
      summary: "The draft preserves the source meaning.",
      meaning_preserved: [],
      meaning_changed: [],
      omitted_points: [],
      new_claims: [],
      contradictions: [],
      certainty_changes: [],
      source_impacts: [],
      ambiguities: [],
      suggested_draft_edits: []
    }),
    session: request.session
  }).session;
}

async function createInitializedFixture(name) {
  const root = new MemoryDirectoryHandle(name);
  picker.root = root;
  const markdown = `# ${name}\n\nInitial document.\n`;
  const loaded = await createProjectFromMarkdown({
    markdown,
    suggestedProjectName: name
  });
  assert.ok(loaded);
  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  return { root, markdown, project: loaded.project, comments, patches };
}

async function createCommittedFixture(name) {
  const fixture = await createInitializedFixture(name);
  await saveProjectState({
    comments: [createComment("committed baseline")],
    project: fixture.project,
    reason: "establish_generation"
  });
  fixture.comments = await readProjectComments(fixture.project);
  fixture.patches = await readProjectPatches(fixture.project);
  fixture.root.controller.resetLog();
  return fixture;
}

function createLegacyFixture(name) {
  const root = new MemoryDirectoryHandle(name);
  root.writeDirect("document.md", `# ${name}\n\nLegacy project.\n`);
  root.writeDirect(
    ".patchmark/manifest.json",
    `${JSON.stringify({
      schema_version: 1,
      project_name: name,
      document_file: "document.md",
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z"
    }, null, 2)}\n`
  );
  root.writeDirect(".patchmark/comments.json", "[]\n");
  root.writeDirect(".patchmark/patches.json", "[]\n");
  return root;
}

function createComment(comment) {
  return {
    id: "PM-COMMENT-TEST",
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

function createPatch(reason) {
  return {
    id: "PM-PATCH-TEST",
    status: "pending",
    original_text: "Initial document.",
    suggested_text: "Changed document.",
    reason,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function createPatchAcceptanceRequest(fixture) {
  const acceptedAt = "2026-07-15T01:00:00.000Z";
  return {
    comments: [createComment("accepted patch comment state")],
    markdown: `${fixture.markdown}\nAccepted patch content.\n`,
    patches: [
      {
        ...createPatch("accepted patch"),
        status: "accepted",
        resolved_at: acceptedAt,
        accepted_at: acceptedAt,
        applied_at: acceptedAt
      }
    ]
  };
}

class MemoryWriteController {
  constructor() {
    this.completedWrites = [];
    this.failures = [];
    this.delays = [];
  }

  failNext(matcher) {
    this.failures.push({ matcher, used: false });
  }

  delayNext(matcher, milliseconds) {
    this.delays.push({ matcher, milliseconds, used: false });
  }

  consumeFailure(path) {
    const failure = this.failures.find((entry) => !entry.used && entry.matcher(path));
    if (!failure) return false;
    failure.used = true;
    return true;
  }

  consumeDelay(path) {
    const delay = this.delays.find((entry) => !entry.used && entry.matcher(path));
    if (!delay) return 0;
    delay.used = true;
    return delay.milliseconds;
  }

  resetLog() {
    this.completedWrites = [];
  }
}

class MemoryFileHandle {
  constructor(name, path, controller) {
    this.name = name;
    this.path = path;
    this.controller = controller;
    this.contents = "";
  }

  async getFile() {
    const contents = this.contents;
    return {
      name: this.name,
      size: Buffer.byteLength(contents),
      text: async () => contents
    };
  }

  async createWritable() {
    const chunks = [];
    const path = this.path;
    const controller = this.controller;
    return {
      write: async (value) => chunks.push(String(value)),
      close: async () => {
        const delay = controller.consumeDelay(path);
        if (delay > 0) await wait(delay);
        if (controller.consumeFailure(path)) {
          throw new Error(`Injected write failure: ${path}`);
        }
        this.contents = chunks.join("");
        controller.completedWrites.push({
          bytes: Buffer.byteLength(this.contents),
          path
        });
      }
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name, parent = null, controller = null) {
    this.name = name;
    this.parent = parent;
    this.controller = controller ?? new MemoryWriteController();
    this.files = new Map();
    this.directories = new Map();
  }

  get path() {
    if (!this.parent) return "";
    const parentPath = this.parent.path;
    return parentPath ? `${parentPath}/${this.name}` : this.name;
  }

  async getFileHandle(name, options = {}) {
    let file = this.files.get(name);
    if (!file && options.create) {
      const path = this.path ? `${this.path}/${name}` : name;
      file = new MemoryFileHandle(name, path, this.controller);
      this.files.set(name, file);
    }
    if (!file) throw new DOMException(`Missing ${name}`, "NotFoundError");
    return file;
  }

  async getDirectoryHandle(name, options = {}) {
    let directory = this.directories.get(name);
    if (!directory && options.create) {
      directory = new MemoryDirectoryHandle(name, this, this.controller);
      this.directories.set(name, directory);
    }
    if (!directory) throw new DOMException(`Missing ${name}`, "NotFoundError");
    return directory;
  }

  async removeEntry(name, options = {}) {
    if (this.files.delete(name)) return;
    if (this.directories.has(name) && options.recursive) {
      this.directories.delete(name);
      return;
    }
    throw new DOMException(`Missing ${name}`, "NotFoundError");
  }

  async *entries() {
    for (const [name] of this.files) yield [name, { kind: "file" }];
    for (const [name] of this.directories) yield [name, { kind: "directory" }];
  }

  has(path) {
    try {
      this.resolveFile(path);
      return true;
    } catch {
      return false;
    }
  }

  read(path) {
    return this.resolveFile(path).contents;
  }

  writeDirect(path, contents) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const directory = this.resolveDirectory(parts, true);
    let file = directory.files.get(fileName);
    if (!file) {
      const filePath = directory.path ? `${directory.path}/${fileName}` : fileName;
      file = new MemoryFileHandle(fileName, filePath, this.controller);
      directory.files.set(fileName, file);
    }
    file.contents = contents;
  }

  findPaths(predicate) {
    const paths = [];
    this.walkFiles((path) => {
      if (predicate(path)) paths.push(path);
    });
    return paths;
  }

  walkFiles(visitor) {
    for (const file of this.files.values()) visitor(file.path);
    for (const directory of this.directories.values()) directory.walkFiles(visitor);
  }

  resolveFile(path) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const directory = this.resolveDirectory(parts, false);
    const file = directory.files.get(fileName);
    if (!file) throw new Error(`Missing file ${path}`);
    return file;
  }

  resolveDirectory(parts, create) {
    return parts.reduce((directory, part) => {
      let child = directory.directories.get(part);
      if (!child && create) {
        child = new MemoryDirectoryHandle(part, directory, this.controller);
        directory.directories.set(part, child);
      }
      if (!child) throw new Error(`Missing directory ${part}`);
      return child;
    }, this);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await run();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addExistingDocumentToProject,
  archiveProjectDocument,
  convertProjectToMultiDocument,
  createNewProjectDocument,
  getProjectDocumentList,
  getProjectDocumentExportIdentity,
  isProjectDocumentListCurrentForManifest,
  locateProjectDocument,
  moveProjectDocument,
  openProjectDocument,
  openProjectFolder,
  readProjectComments,
  readProjectPatches,
  readProjectRewriteSessionRecords,
  listProjectVersions,
  resolveDocumentPathFromFileHandle,
  restoreProjectDocument,
  saveProjectRewriteSessionRecord,
  saveProjectState,
  switchProjectDocument,
  updateProjectDocumentMetadata
} from "../lib/project/patchmark-project.ts";
import {
  convertLegacyProject,
  createProjectDocument as createProjectDocumentTransaction,
  parseProjectManifest,
  readProjectManifest,
  validateRegisteredDocumentPath,
  writeProjectManifestAtomic
} from "../lib/project/multi-document-project.ts";
import {
  createRewriteSession,
  updateRewriteDraft
} from "../lib/rewrite-workspace/rewrite-review-protocol.ts";
import {
  NodeDirectoryHandle,
  createNodeHandleController
} from "./lib/node-directory-handle.mjs";

const picker = { root: null };
globalThis.window = {
  showDirectoryPicker: async () => picker.root
};

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patchmark-multi-"));

try {
  await runDomainValidationTests();
  await runLifecycleIntegrationTest();
  await runMigrationFailureTests();
  process.stdout.write(
    `${JSON.stringify({
      manifestValidation: true,
      legacyOpenWithoutWrites: true,
      conversionCopyVerifyCommitLast: true,
      createAndAddExisting: true,
      independentDocumentGenerations: true,
      identicalTextIsolation: true,
      switchSaveBarrier: true,
      archiveRestore: true,
      missingLocate: true,
      rewriteArchiveRestore: true,
      rewriteMissingLocate: true,
      folderPortability: true,
      rewriteFolderPortability: true,
      migrationFaultBoundaries: true
    }, null, 2)}\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

async function runDomainValidationTests() {
  assert.equal(
    validateRegisteredDocumentPath("research/ready-to-eat.md"),
    "research/ready-to-eat.md"
  );
  for (const unsafe of [
    "../outside.md",
    "/absolute.md",
    "C:/absolute.md",
    ".patchmark/secret.md",
    "folder/../../outside.md",
    "notes.txt",
    "folder\\notes.md"
  ]) {
    assert.throws(() => validateRegisteredDocumentPath(unsafe));
  }

  const now = "2026-07-17T00:00:00.000Z";
  const base = {
    format: "patchmark-project",
    schema_version: 1,
    project_id: "prj_test",
    title: "Test",
    created_at: now,
    manifest_revision: 1,
    documents: [createRegistryDocument("doc_a", "a.md", now)]
  };
  assert.equal(parseProjectManifest(base).project_id, "prj_test");
  assert.throws(() =>
    parseProjectManifest({
      ...base,
      documents: [
        createRegistryDocument("doc_a", "a.md", now),
        createRegistryDocument("doc_b", "A.md", now)
      ]
    })
  );
  assert.throws(() =>
    parseProjectManifest({
      ...base,
      documents: [
        createRegistryDocument("doc_a", "a.md", now),
        createRegistryDocument("doc_a", "b.md", now)
      ]
    })
  );
}

async function runLifecycleIntegrationTest() {
  const projectPath = path.join(temporaryRoot, "lifecycle");
  const legacyBytes = createLegacyFixture(projectPath, "Crust Chant");
  const writes = [];
  const root = new NodeDirectoryHandle(
    projectPath,
    createNodeHandleController({
      beforeWrite(filePath) {
        writes.push(filePath);
      }
    })
  );
  picker.root = root;
  const legacy = await openProjectFolder();
  assert.ok(legacy);
  assert.equal(writes.length, 0, "Legacy open must not write or convert.");
  assert.equal(await readProjectManifest(root), null);

  const legacyComments = await readProjectComments(legacy.project);
  const legacyPatches = await readProjectPatches(legacy.project);
  assert.deepEqual(legacyComments.map(({ id }) => id), ["PM-COMMENT-LEGACY"]);
  assert.deepEqual(legacyPatches.map(({ id }) => id), ["PM-PATCH-LEGACY"]);

  const converted = await convertProjectToMultiDocument(legacy.project);
  const firstDocument = converted.project.document;
  const convertedManifest = converted.project.projectManifest;
  assert.ok(firstDocument);
  assert.ok(convertedManifest);
  assert.equal(convertedManifest.manifest_revision, 1);
  assert.equal(convertedManifest.documents.length, 1);
  assert.equal(firstDocument.path, "document.md");
  assertLegacyBytesUnchanged(projectPath, legacyBytes);
  assert.equal(
    fs.readFileSync(
      path.join(
        projectPath,
        ".patchmark",
        "documents",
        firstDocument.document_id,
        "comments.json"
      ),
      "utf8"
    ),
    legacyBytes.comments
  );

  const second = await createNewProjectDocument({
    displayTitle: "Ready-to-Eat Investigation",
    path: "ready-to-eat-investigation.md",
    project: converted.project,
    role: "research"
  });
  const secondDocument = second.project.document;
  assert.ok(secondDocument);
  assert.notEqual(secondDocument.document_id, firstDocument.document_id);
  assert.equal(second.project.projectManifest.manifest_revision, 2);
  assert.equal(
    fs.readFileSync(path.join(projectPath, secondDocument.path), "utf8"),
    "# Ready-to-Eat Investigation\n"
  );

  const existingPath = path.join(projectPath, "evidence.md");
  const existingBytes = "# Evidence\n\nIndependent evidence.\n";
  fs.writeFileSync(existingPath, existingBytes);
  const projectHandleBeforeExisting = second.project;
  const revisionBeforeExisting = second.project.projectManifest.manifest_revision;
  const projectedBeforeExisting = await getProjectDocumentList(second.project);
  const evidence = await addExistingDocumentToProject({
    path: "evidence.md",
    project: second.project,
    role: "evidence"
  });
  assert.equal(fs.readFileSync(existingPath, "utf8"), existingBytes);
  assert.equal(evidence.project.document.display_title, "Evidence");
  assert.notEqual(projectHandleBeforeExisting, evidence.project);
  assert.notEqual(
    revisionBeforeExisting,
    evidence.project.projectManifest.manifest_revision
  );
  assert.equal(
    projectHandleBeforeExisting.projectManifest.manifest_revision,
    evidence.project.projectManifest.manifest_revision,
    "The in-place handle mutation reproduces the revision-only cache false positive."
  );
  assert.equal(
    isProjectDocumentListCurrentForManifest(
      projectedBeforeExisting,
      evidence.project.projectManifest
    ),
    false,
    "A projection from before an in-place manifest mutation must not be reused."
  );
  assert.equal(
    isProjectDocumentListCurrentForManifest(
      await getProjectDocumentList(evidence.project),
      evidence.project.projectManifest
    ),
    true
  );
  await assert.rejects(() =>
    addExistingDocumentToProject({
      path: "EVIDENCE.md",
      project: evidence.project,
      role: null
    })
  );

  const symlinkPath = path.join(projectPath, "linked-evidence.md");
  fs.symlinkSync(existingPath, symlinkPath);
  await assert.rejects(
    () =>
      addExistingDocumentToProject({
        path: "linked-evidence.md",
        project: evidence.project,
        role: null
      }),
    /Symbolic links/
  );

  const sharedMarkdown = "# Shared text\n\nIdentical paragraph.\n";
  const secondLoaded = await openProjectDocument(
    evidence.project,
    secondDocument.document_id
  );
  const registryBeforeDocumentEdits = fs.readFileSync(
    path.join(projectPath, ".patchmark", "project.json"),
    "utf8"
  );
  const secondComment = {
    ...createComment(
      "PM-COMMENT-SECOND",
      "Identical paragraph.",
      15,
      35
    ),
    trashed_at: "2026-07-17T01:00:00.000Z",
    trash_operation_id: "comment_trash_lifecycle"
  };
  await saveProjectState({
    comments: [secondComment],
    markdown: sharedMarkdown,
    patches: [],
    project: secondLoaded.project,
    reason: "second_document_state"
  });
  assert.equal(
    fs.readFileSync(path.join(projectPath, ".patchmark", "project.json"), "utf8"),
    registryBeforeDocumentEdits,
    "Ordinary document persistence must not rewrite the project registry."
  );
  const secondRewriteSession = await createDocumentRewriteSession({
    draft: "Identical paragraph with a saved human clarification.",
    loaded: secondLoaded,
    localProjectInstanceId: "multi_document_lifecycle",
    markdown: sharedMarkdown,
    selectedText: "Identical paragraph."
  });
  await saveProjectRewriteSessionRecord({
    expectedRevision: 0,
    project: secondLoaded.project,
    reason: "second_document_rewrite_state",
    record: secondRewriteSession
  });
  const secondGeneration = secondLoaded.project.persistence.generation;

  const firstLoaded = await openProjectDocument(
    secondLoaded.project,
    firstDocument.document_id
  );
  const firstComments = await readProjectComments(firstLoaded.project);
  const firstOwnedComment = createComment(
    "PM-COMMENT-FIRST-ONLY",
    "Identical paragraph.",
    15,
    35
  );
  await saveProjectState({
    comments: [...firstComments, firstOwnedComment],
    markdown: sharedMarkdown,
    patches: await readProjectPatches(firstLoaded.project),
    project: firstLoaded.project,
    reason: "first_document_state"
  });
  assert.equal(secondLoaded.project.persistence.generation, secondGeneration);

  const reopenedSecond = await openProjectDocument(
    firstLoaded.project,
    secondDocument.document_id
  );
  const reopenedSecondComments = await readProjectComments(
    reopenedSecond.project
  );
  assert.deepEqual(reopenedSecondComments.map(({ id }) => id), [
    "PM-COMMENT-SECOND"
  ]);
  assert.equal(
    reopenedSecondComments[0].trash_operation_id,
    "comment_trash_lifecycle"
  );
  assert.equal(reopenedSecond.markdown, sharedMarkdown);
  assert.equal(reopenedSecond.project.persistence.generation, secondGeneration);
  assert.deepEqual(await listProjectVersions(reopenedSecond.project), []);
  assert.deepEqual(
    getProjectDocumentExportIdentity(reopenedSecond.project),
    {
      project_name: "Crust Chant",
      project_id: reopenedSecond.project.projectManifest.project_id,
      document_file: secondDocument.path,
      document_id: secondDocument.document_id,
      document_title: "Ready-to-Eat Investigation",
      document_role: "research"
    }
  );

  const firstHistoryCheck = await openProjectDocument(
    reopenedSecond.project,
    firstDocument.document_id
  );
  assert.deepEqual(
    (await listProjectVersions(firstHistoryCheck.project)).map(({ id }) => id),
    ["snapshot-legacy"]
  );

  const failedSwitchSource = await openProjectDocument(
    firstHistoryCheck.project,
    firstDocument.document_id
  );
  const failingRoot = failedSwitchSource.project.projectDirectoryHandle;
  const failingController = failingRoot.controller;
  const previousBeforeWrite = failingController.beforeWrite;
  let failedDocumentWrite = false;
  failingController.beforeWrite = (filePath, contents) => {
    previousBeforeWrite?.(filePath, contents);
    if (!failedDocumentWrite && filePath === path.join(projectPath, "document.md")) {
      failedDocumentWrite = true;
      throw new Error("simulated switch save failure");
    }
  };
  await assert.rejects(() =>
    switchProjectDocument({
      comments: awaitable(firstComments),
      documentId: secondDocument.document_id,
      markdown: `${failedSwitchSource.markdown}\nUnsaved boundary edit.\n`,
      patches: legacyPatches,
      project: failedSwitchSource.project
    })
  );
  failingController.beforeWrite = previousBeforeWrite;
  assert.equal(
    failedSwitchSource.project.document.document_id,
    firstDocument.document_id,
    "Failed save must not replace the active document handle."
  );

  await updateProjectDocumentMetadata({
    displayTitle: "Action Plan",
    documentId: firstDocument.document_id,
    project: reopenedSecond.project,
    role: "decision"
  });
  await moveProjectDocument({
    direction: "up",
    documentId: secondDocument.document_id,
    project: reopenedSecond.project
  });
  const beforeArchiveId = evidence.project.document.document_id;
  await archiveProjectDocument({
    documentId: beforeArchiveId,
    project: reopenedSecond.project
  });
  let documents = await getProjectDocumentList(reopenedSecond.project);
  assert.equal(
    documents.find(({ document_id }) => document_id === beforeArchiveId).status,
    "archived"
  );
  assert.equal(fs.readFileSync(existingPath, "utf8"), existingBytes);
  await restoreProjectDocument({
    documentId: beforeArchiveId,
    project: reopenedSecond.project
  });
  documents = await getProjectDocumentList(reopenedSecond.project);
  assert.equal(
    documents.find(({ document_id }) => document_id === beforeArchiveId).status,
    "active"
  );
  await archiveProjectDocument({
    documentId: secondDocument.document_id,
    project: reopenedSecond.project
  });
  await restoreProjectDocument({
    documentId: secondDocument.document_id,
    project: reopenedSecond.project
  });
  const restoredSecond = await openProjectDocument(
    reopenedSecond.project,
    secondDocument.document_id
  );
  assert.equal(
    (await readProjectComments(restoredSecond.project))[0].trash_operation_id,
    "comment_trash_lifecycle"
  );
  assert.equal(
    (await readProjectRewriteSessionRecords(restoredSecond.project))[0].human_draft,
    secondRewriteSession.human_draft
  );

  const movedPath = path.join(projectPath, "ready-to-eat-moved.md");
  fs.renameSync(path.join(projectPath, secondDocument.path), movedPath);
  documents = await getProjectDocumentList(reopenedSecond.project);
  assert.equal(
    documents.find(({ document_id }) => document_id === secondDocument.document_id)
      .availability,
    "missing"
  );
  const missing = await openProjectDocument(
    reopenedSecond.project,
    secondDocument.document_id
  );
  assert.equal(missing.project.documentAvailability, "missing");
  const located = await locateProjectDocument({
    documentId: secondDocument.document_id,
    path: "ready-to-eat-moved.md",
    project: missing.project
  });
  assert.equal(located.project.document.document_id, secondDocument.document_id);
  assert.equal(located.project.documentAvailability, "available");
  const locatedComments = await readProjectComments(located.project);
  assert.deepEqual(locatedComments.map(({ id }) => id), [
    "PM-COMMENT-SECOND"
  ]);
  assert.equal(
    locatedComments[0].trash_operation_id,
    "comment_trash_lifecycle"
  );
  assert.equal(
    (await readProjectRewriteSessionRecords(located.project))[0].human_draft,
    secondRewriteSession.human_draft
  );

  const selectedInside = await root.getFileHandle("evidence.md");
  assert.equal(
    await resolveDocumentPathFromFileHandle(located.project, selectedInside),
    "evidence.md"
  );
  const outsidePath = path.join(temporaryRoot, "outside.md");
  fs.writeFileSync(outsidePath, "# Outside\n");
  const outsideDirectory = new NodeDirectoryHandle(temporaryRoot);
  const selectedOutside = await outsideDirectory.getFileHandle("outside.md");
  await assert.rejects(() =>
    resolveDocumentPathFromFileHandle(located.project, selectedOutside)
  );

  const movedProjectPath = path.join(temporaryRoot, "lifecycle-copy");
  fs.cpSync(projectPath, movedProjectPath, { recursive: true });
  picker.root = new NodeDirectoryHandle(movedProjectPath);
  const movedProject = await openProjectFolder();
  assert.ok(movedProject);
  assert.equal(
    movedProject.project.projectManifest.project_id,
    located.project.projectManifest.project_id
  );
  assert.deepEqual(
    movedProject.project.projectManifest.documents.map(({ document_id }) => document_id),
    located.project.projectManifest.documents.map(({ document_id }) => document_id)
  );
  const movedSecond = await openProjectDocument(
    movedProject.project,
    secondDocument.document_id
  );
  assert.equal(
    (await readProjectRewriteSessionRecords(movedSecond.project))[0].human_draft,
    secondRewriteSession.human_draft
  );
  const ownershipTarget = movedProject.project.projectManifest.documents.find(
    ({ document_id }) => document_id !== movedProject.project.document.document_id
  );
  fs.writeFileSync(
    path.join(
      movedProjectPath,
      ".patchmark",
      "documents",
      ownershipTarget.document_id,
      "document.json"
    ),
    `${JSON.stringify({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: movedProject.project.document.document_id,
      created_at: "2026-07-17T00:00:00.000Z",
      source: "created"
    })}\n`
  );
  await assert.rejects(
    () => openProjectDocument(movedProject.project, ownershipTarget.document_id),
    /ownership mismatch/
  );

  const currentManifest = await readProjectManifest(root);
  const failManifestRoot = new NodeDirectoryHandle(
    projectPath,
    createNodeHandleController({
      beforeWrite(filePath) {
        if (filePath.endsWith(`${path.sep}.patchmark${path.sep}project.json`)) {
          throw new Error("simulated manifest install failure");
        }
      }
    })
  );
  await assert.rejects(() =>
    writeProjectManifestAtomic(failManifestRoot, {
      ...currentManifest,
      title: "Must not install",
      manifest_revision: currentManifest.manifest_revision + 1
    })
  );
  assert.equal((await readProjectManifest(root)).title, currentManifest.title);
  await assert.rejects(() =>
    createProjectDocumentTransaction({
      displayTitle: "Interrupted document",
      manifest: currentManifest,
      path: "interrupted-document.md",
      role: null,
      root: failManifestRoot
    })
  );
  assert.equal(
    fs.readFileSync(path.join(projectPath, "interrupted-document.md"), "utf8"),
    "# Interrupted document\n"
  );
  assert.equal(
    (await readProjectManifest(root)).documents.some(
      ({ path: documentPath }) => documentPath === "interrupted-document.md"
    ),
    false,
    "Manifest-last ordering must not register an interrupted document."
  );
}

async function createDocumentRewriteSession({
  draft,
  loaded,
  localProjectInstanceId,
  markdown = loaded.markdown,
  selectedText
}) {
  const identity = {
    projectId: loaded.project.projectManifest.project_id,
    documentId: loaded.project.document.document_id
  };
  const start = markdown.indexOf(selectedText);
  assert.ok(start >= 0);
  const session = await createRewriteSession({
    baseDocumentGeneration: loaded.project.persistence.generation,
    baseText: selectedText,
    documentId: identity.documentId,
    documentTitle: loaded.project.document.display_title,
    localProjectInstanceId,
    markdown,
    projectId: identity.projectId,
    projectTitle: loaded.project.projectManifest.title,
    target: {
      kind: "selection",
      heading_snapshot: loaded.project.document.display_title,
      heading_level: 1,
      heading_path: [loaded.project.document.display_title],
      base_start: start,
      base_end: start + selectedText.length,
      context_before: markdown.slice(Math.max(0, start - 64), start),
      context_after: markdown.slice(start + selectedText.length, start + selectedText.length + 64)
    }
  });
  return updateRewriteDraft({
    humanDraft: draft,
    intentNote: "Keep this draft scoped to the second document.",
    session
  });
}

async function runMigrationFailureTests() {
  for (const stage of [
    "preflight",
    "staging",
    "verified",
    "document_store_committed"
  ]) {
    const projectPath = path.join(temporaryRoot, `failure-${stage}`);
    const bytes = createLegacyFixture(projectPath, `Failure ${stage}`);
    const root = new NodeDirectoryHandle(projectPath);
    await assert.rejects(() =>
      convertLegacyProject({
        projectTitle: `Failure ${stage}`,
        root,
        onStage(currentStage) {
          if (currentStage === stage) {
            throw new Error(`simulated ${stage} failure`);
          }
        }
      })
    );
    assert.equal(await readProjectManifest(root), null);
    assertLegacyBytesUnchanged(projectPath, bytes);
  }

  const committedPath = path.join(temporaryRoot, "failure-manifest-committed");
  createLegacyFixture(committedPath, "Committed recovery");
  const committedRoot = new NodeDirectoryHandle(committedPath);
  await assert.rejects(() =>
    convertLegacyProject({
      projectTitle: "Committed recovery",
      root: committedRoot,
      onStage(stage) {
        if (stage === "manifest_committed") {
          throw new Error("simulated post-commit crash");
        }
      }
    })
  );
  assert.ok(await readProjectManifest(committedRoot));
  picker.root = committedRoot;
  const recovered = await openProjectFolder();
  assert.ok(recovered?.project.projectManifest);

  const invalidCommittedPath = path.join(
    temporaryRoot,
    "failure-invalid-committed-candidate"
  );
  const invalidCommittedBytes = createLegacyFixture(
    invalidCommittedPath,
    "Invalid committed candidate"
  );
  const invalidCommittedRoot = new NodeDirectoryHandle(invalidCommittedPath);
  const invalidConversion = await convertLegacyProject({
    projectTitle: "Invalid committed candidate",
    root: invalidCommittedRoot
  });
  fs.writeFileSync(
    path.join(
      invalidCommittedPath,
      ".patchmark",
      "documents",
      invalidConversion.document.document_id,
      "document.json"
    ),
    "{\"document_id\":\"wrong-document\"}\n"
  );
  picker.root = invalidCommittedRoot;
  const rolledBack = await openProjectFolder();
  assert.equal(rolledBack.project.projectMode, "legacy");
  assert.equal(rolledBack.recovery?.kind, "migration_rolled_back");
  assert.equal(await readProjectManifest(invalidCommittedRoot), null);
  assertLegacyBytesUnchanged(invalidCommittedPath, invalidCommittedBytes);

  const manifestFailurePath = path.join(temporaryRoot, "failure-manifest-write");
  const manifestFailureBytes = createLegacyFixture(
    manifestFailurePath,
    "Manifest failure"
  );
  const manifestFailureRoot = new NodeDirectoryHandle(
    manifestFailurePath,
    createNodeHandleController({
      beforeWrite(filePath) {
        if (filePath.endsWith(`${path.sep}.patchmark${path.sep}project.json`)) {
          throw new Error("simulated project manifest write failure");
        }
      }
    })
  );
  await assert.rejects(() =>
    convertLegacyProject({
      projectTitle: "Manifest failure",
      root: manifestFailureRoot
    })
  );
  assert.equal(await readProjectManifest(manifestFailureRoot), null);
  assertLegacyBytesUnchanged(manifestFailurePath, manifestFailureBytes);
}

function createLegacyFixture(projectPath, projectName) {
  fs.mkdirSync(path.join(projectPath, ".patchmark", "versions"), {
    recursive: true
  });
  const markdown = `# ${projectName}\n\nLegacy source.\n`;
  const comments = `${JSON.stringify([
    {
      id: "PM-COMMENT-LEGACY",
      type: "note",
      status: "open",
      anchor: { kind: "document" },
      comment: "Preserve this comment.",
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      future_field: { preserve: true }
    }
  ], null, 2)}\n`;
  const patches = `${JSON.stringify([
    {
      id: "PM-PATCH-LEGACY",
      status: "pending",
      comment_id: "PM-COMMENT-LEGACY",
      original_text: "Legacy source.",
      suggested_text: "Reviewed source.",
      reason: "Test preservation",
      created_at: "2026-07-17T00:00:00.000Z",
      future_field: "preserve"
    }
  ], null, 2)}\n`;
  const version = markdown;
  const manifest = `${JSON.stringify({
    schema_version: 1,
    project_name: projectName,
    document_file: "document.md",
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
    current_version: "snapshot-legacy",
    versions: [
      {
        id: "snapshot-legacy",
        file: ".patchmark/versions/snapshot-legacy.md",
        created_at: "2026-07-17T00:00:00.000Z",
        reason: "legacy baseline"
      }
    ],
    future_manifest_field: "preserve"
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(projectPath, "document.md"), markdown);
  fs.writeFileSync(path.join(projectPath, ".patchmark", "manifest.json"), manifest);
  fs.writeFileSync(path.join(projectPath, ".patchmark", "comments.json"), comments);
  fs.writeFileSync(path.join(projectPath, ".patchmark", "patches.json"), patches);
  fs.writeFileSync(path.join(projectPath, ".patchmark", "tasks.json"), "[]\n");
  fs.writeFileSync(
    path.join(projectPath, ".patchmark", "versions", "snapshot-legacy.md"),
    version
  );
  return { comments, manifest, markdown, patches, version };
}

function assertLegacyBytesUnchanged(projectPath, expected) {
  assert.equal(fs.readFileSync(path.join(projectPath, "document.md"), "utf8"), expected.markdown);
  assert.equal(
    fs.readFileSync(path.join(projectPath, ".patchmark", "manifest.json"), "utf8"),
    expected.manifest
  );
  assert.equal(
    fs.readFileSync(path.join(projectPath, ".patchmark", "comments.json"), "utf8"),
    expected.comments
  );
  assert.equal(
    fs.readFileSync(path.join(projectPath, ".patchmark", "patches.json"), "utf8"),
    expected.patches
  );
  assert.equal(
    fs.readFileSync(
      path.join(projectPath, ".patchmark", "versions", "snapshot-legacy.md"),
      "utf8"
    ),
    expected.version
  );
}

function createRegistryDocument(documentId, documentPath, now) {
  return {
    document_id: documentId,
    path: documentPath,
    display_title: documentId,
    role: null,
    status: "active",
    position: 1000,
    added_at: now,
    archived_at: null
  };
}

function createComment(id, selectedText, start, end) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: end
    },
    comment: id,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

function awaitable(value) {
  return value;
}

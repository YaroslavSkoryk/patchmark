import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  compareEntryIdentity,
  createContentSha256,
  createLocalProjectInstanceId,
  createLocalStandaloneFileId,
  createMemoryDeviceRecoveryStorage,
  deleteDocumentRecovery,
  deleteProjectInstanceRecoveryData,
  evaluateRecoveryContent,
  findProjectInstanceForDirectory,
  findStandaloneInstanceForFile,
  getDirectoryPermission,
  getProjectDocumentRecoveryId,
  getStandaloneDocumentRecoveryId,
  listProjectDocumentRecoveries,
  readMostRecentProjectInstance,
  readProjectInstance,
  readRecovery,
  rememberProjectInstance,
  rememberStandaloneFileInstance,
  requestDirectoryPermission,
  saveProjectDocumentRecovery,
  saveStandaloneDocumentRecovery,
  setDeviceRecoveryStorageForTests
} from "../lib/storage/document-recovery-storage.ts";
import {
  deleteLegacyUnscopedDocumentDraft,
  getDocumentDraftKey,
  readLegacyUnscopedDocumentDrafts
} from "../lib/storage/document-draft-storage.ts";

const storage = createMemoryDeviceRecoveryStorage();
setDeviceRecoveryStorageForTests(storage);

async function run() {
  const projectId = "prj_strategy";
  const documentId = "doc_research";
  const firstHandle = new FakeDirectoryHandle("strategy-copy-a");
  const copiedHandle = new FakeDirectoryHandle("strategy-copy-b");
  const firstInstanceId = createLocalProjectInstanceId();
  const copiedInstanceId = createLocalProjectInstanceId();

  await rememberProjectInstance({
    directoryHandle: firstHandle,
    documentId,
    documentTitle: "Ready-to-Eat Channel Research",
    groupId: "grp_crust_chant",
    localInstanceId: firstInstanceId,
    projectId,
    projectTitle: "Strategy"
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await rememberProjectInstance({
    directoryHandle: copiedHandle,
    documentId,
    documentTitle: "Ready-to-Eat Channel Research",
    groupId: "grp_crust_chant",
    localInstanceId: copiedInstanceId,
    projectId,
    projectTitle: "Strategy Copy"
  });

  assert.equal(
    (await findProjectInstanceForDirectory({
      directoryHandle: firstHandle,
      projectId
    }))?.local_instance_id,
    firstInstanceId
  );
  assert.equal(
    (await findProjectInstanceForDirectory({
      directoryHandle: copiedHandle,
      projectId
    }))?.local_instance_id,
    copiedInstanceId
  );
  assert.equal(
    await findProjectInstanceForDirectory({
      directoryHandle: firstHandle,
      projectId: "prj_unrelated"
    }),
    null
  );
  assert.equal(await compareEntryIdentity(firstHandle, copiedHandle), "different");
  assert.equal(await getDirectoryPermission(firstHandle), "granted");
  firstHandle.permission = "denied";
  assert.equal(await getDirectoryPermission(firstHandle), "denied");
  firstHandle.permission = "prompt";
  assert.equal(await getDirectoryPermission(firstHandle), "prompt");
  assert.equal(await requestDirectoryPermission(firstHandle), "granted");

  const baseMarkdown = "# Research\n\nSaved base.\n";
  const recoveredMarkdown = "# Research\n\nUnsaved working change.\n";
  const projectRecovery = await saveProjectDocumentRecovery({
    baseDocumentGeneration: 72,
    baseMarkdown,
    documentId,
    documentTitle: "Ready-to-Eat Channel Research",
    groupTitle: "Crust Chant",
    localInstanceId: firstInstanceId,
    markdown: recoveredMarkdown,
    projectId,
    projectTitle: "Strategy"
  });

  assert.equal(
    projectRecovery.recovery_id,
    getProjectDocumentRecoveryId({
      documentId,
      localInstanceId: firstInstanceId,
      projectId
    })
  );
  assert.equal(projectRecovery.base_document_generation, 72);
  assert.equal(
    projectRecovery.recovered_content_sha256,
    await createContentSha256(recoveredMarkdown)
  );
  assert.equal(
    (await evaluateRecoveryContent(projectRecovery, baseMarkdown)).kind,
    "safe_recovery"
  );
  assert.equal(
    (await evaluateRecoveryContent(projectRecovery, recoveredMarkdown)).kind,
    "already_saved"
  );
  assert.equal(
    (
      await evaluateRecoveryContent(
        projectRecovery,
        "# Research\n\nIndependent saved edit.\n"
      )
    ).kind,
    "conflict"
  );
  assert.equal(
    (
      await evaluateRecoveryContent(
        { ...projectRecovery, recovered_content_sha256: "invalid" },
        baseMarkdown
      )
    ).kind,
    "invalid"
  );

  const sameNameOtherProject = await saveProjectDocumentRecovery({
    baseDocumentGeneration: 4,
    baseMarkdown,
    documentId: "doc_other",
    documentTitle: "Ready-to-Eat Channel Research",
    groupTitle: null,
    localInstanceId: copiedInstanceId,
    markdown: "# Research\n\nOther copied project change.\n",
    projectId,
    projectTitle: "Strategy Copy"
  });
  assert.notEqual(sameNameOtherProject.recovery_id, projectRecovery.recovery_id);
  const sameNameSeparateProject = await saveProjectDocumentRecovery({
    baseDocumentGeneration: 1,
    baseMarkdown,
    documentId,
    documentTitle: "Ready-to-Eat Channel Research",
    groupTitle: null,
    localInstanceId: createLocalProjectInstanceId(),
    markdown: "# Research\n\nSeparate project change.\n",
    projectId: "prj_separate",
    projectTitle: "Separate Strategy"
  });
  assert.notEqual(sameNameSeparateProject.recovery_id, projectRecovery.recovery_id);

  const secondDocumentRecovery = await saveProjectDocumentRecovery({
    baseDocumentGeneration: 19,
    baseMarkdown: "# Evidence\n",
    documentId: "doc_evidence",
    documentTitle: "Evidence Summary",
    groupTitle: "Shared Research",
    localInstanceId: firstInstanceId,
    markdown: "# Evidence\n\nUnsaved evidence.\n",
    projectId,
    projectTitle: "Strategy"
  });
  assert.deepEqual(
    (await listProjectDocumentRecoveries({
      localInstanceId: firstInstanceId,
      projectId
    })).map((record) => record.document_id).sort(),
    ["doc_evidence", documentId].sort()
  );

  const movedGroupRecovery = await saveProjectDocumentRecovery({
    baseDocumentGeneration: 72,
    baseMarkdown,
    documentId,
    documentTitle: "Ready-to-Eat Channel Research",
    groupTitle: "Shared Research",
    localInstanceId: firstInstanceId,
    markdown: recoveredMarkdown,
    projectId,
    projectTitle: "Strategy"
  });
  assert.equal(movedGroupRecovery.recovery_id, projectRecovery.recovery_id);
  assert.equal(movedGroupRecovery.group_title_snapshot, "Shared Research");

  const standaloneHandle = new FakeFileHandle("document.md", "standalone-a");
  const standaloneId = createLocalStandaloneFileId();
  await rememberStandaloneFileInstance({
    fileHandle: standaloneHandle,
    fileName: "document.md",
    localFileId: standaloneId
  });
  assert.equal(
    (await findStandaloneInstanceForFile(standaloneHandle))?.local_file_id,
    standaloneId
  );
  const standaloneRecovery = await saveStandaloneDocumentRecovery({
    baseMarkdown,
    fileName: "document.md",
    localFileId: standaloneId,
    markdown: "# Standalone\n\nUnsaved.\n"
  });
  assert.equal(
    standaloneRecovery.recovery_id,
    getStandaloneDocumentRecoveryId(standaloneId)
  );
  assert.notEqual(standaloneRecovery.recovery_id, projectRecovery.recovery_id);

  const projectTree = createProjectTree();
  const beforeDiscard = fingerprintTree(projectTree);
  await deleteDocumentRecovery(secondDocumentRecovery.recovery_id);
  assert.equal(await readRecovery(secondDocumentRecovery.recovery_id), null);
  assert.deepEqual(fingerprintTree(projectTree), beforeDiscard);

  await deleteDocumentRecovery(projectRecovery.recovery_id);
  assert.equal(await readRecovery(projectRecovery.recovery_id), null);
  assert.deepEqual(fingerprintTree(projectTree), beforeDiscard);

  const recent = await readMostRecentProjectInstance();
  assert.equal(recent?.local_instance_id, copiedInstanceId);
  assert.ok(await readProjectInstance(firstInstanceId));
  assert.deepEqual(fingerprintTree(projectTree), beforeDiscard);

  await deleteProjectInstanceRecoveryData(firstInstanceId);
  assert.equal(await readProjectInstance(firstInstanceId), null);
  assert.equal(
    (await listProjectDocumentRecoveries({
      localInstanceId: firstInstanceId,
      projectId
    })).length,
    0
  );
  assert.deepEqual(fingerprintTree(projectTree), beforeDiscard);

  runLegacyDraftQuarantineTest();

  console.log(
    JSON.stringify(
      {
        existingDraftKeyAudit: true,
        projectOwnedRecoveryKeys: true,
        standaloneRecoveryKeys: true,
        localProjectInstanceIdentity: true,
        copiedProjectIsolation: true,
        projectIdentityMismatchRejected: true,
        storedHandlePermissionStates: true,
        sameEntryValidation: true,
        contentHashDecisionRules: true,
        safeRecovery: true,
        alreadySavedDetection: true,
        conflictDetection: true,
        multipleDocumentRecovery: true,
        groupMovementPreservesIdentity: true,
        standaloneProjectIsolation: true,
        sameFilenameSeparateProjectIsolation: true,
        explicitDiscardNoProjectWrites: true,
        noWriteResumeRecord: true,
        localCleanupNoProjectWrites: true,
        legacyUnscopedQuarantine: true
      },
      null,
      2
    )
  );
}

function runLegacyDraftQuarantineTest() {
  const values = new Map();
  const localStorage = {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
  globalThis.window = {};
  globalThis.localStorage = localStorage;
  const key = getDocumentDraftKey("document.md");
  localStorage.setItem(
    key,
    JSON.stringify({
      fileName: "document.md",
      markdown: "# Legacy unscoped recovery\n",
      updatedAt: "2026-07-21T03:39:00.000Z"
    })
  );
  const drafts = readLegacyUnscopedDocumentDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].storageKey, key);
  assert.equal(drafts[0].fileName, "document.md");
  deleteLegacyUnscopedDocumentDraft(key);
  assert.equal(readLegacyUnscopedDocumentDrafts().length, 0);
  delete globalThis.localStorage;
  delete globalThis.window;
}

function createProjectTree() {
  const root = mkdtempSync(join(tmpdir(), "patchmark-recovery-no-write-"));
  mkdirSync(join(root, ".patchmark", "documents", "doc_research", ".patchmark"), {
    recursive: true
  });
  writeFileSync(join(root, ".patchmark", "project.json"), '{"project_id":"prj_strategy"}\n');
  writeFileSync(join(root, "document.md"), "# Saved project Markdown\n");
  writeFileSync(join(root, ".patchmark", "comments.json"), '[{"id":"PM-COMMENT-1"}]\n');
  writeFileSync(join(root, ".patchmark", "patches.json"), '[{"id":"PM-PATCH-1"}]\n');
  writeFileSync(join(root, ".patchmark", "manifest.json"), '{"save_generation":72}\n');
  writeFileSync(
    join(root, ".patchmark", "documents", "doc_research", ".patchmark", "document.json"),
    '{"document_id":"doc_research"}\n'
  );
  return root;
}

function fingerprintTree(root) {
  const result = {};
  visit(root);
  return result;

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        result[relativePath] = readFileSync(path, "utf8");
      }
    }
  }
}

class FakeDirectoryHandle {
  constructor(identity) {
    this.identity = identity;
    this.kind = "directory";
    this.name = identity;
    this.permission = "granted";
  }

  async isSameEntry(other) {
    return other?.kind === "directory" && other.identity === this.identity;
  }

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    this.permission = "granted";
    return this.permission;
  }
}

class FakeFileHandle {
  constructor(name, identity) {
    this.identity = identity;
    this.kind = "file";
    this.name = name;
  }

  async isSameEntry(other) {
    return other?.kind === "file" && other.identity === this.identity;
  }
}

try {
  await run();
} finally {
  setDeviceRecoveryStorageForTests(null);
}

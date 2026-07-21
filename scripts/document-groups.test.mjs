import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveRegisteredDocument,
  addExistingProjectDocument,
  assignDocumentToGroup,
  createDocumentGroup,
  createProjectDocument,
  parseProjectManifest,
  readProjectManifest,
  removeDocumentGroup,
  renameDocumentGroup,
  reorderDocumentGroup,
  reorderRegisteredDocument,
  restoreRegisteredDocument,
  locateProjectDocument as locateRegisteredProjectDocument,
  writeProjectManifestAtomic
} from "../lib/project/multi-document-project.ts";
import {
  NodeDirectoryHandle,
  createNodeHandleController
} from "./lib/node-directory-handle.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patchmark-groups-"));

try {
  runDomainTests();
  await runPersistenceTests();
  process.stdout.write(
    `${JSON.stringify({
      backwardCompatibleRead: true,
      schemaUpgradeOnMutation: true,
      stableGroupIdentity: true,
      duplicateTitleRejected: true,
      danglingMembershipRejected: true,
      lifecycleAndOrdering: true,
      activeAndArchivedUngrouping: true,
      groupedCreateAndAddExisting: true,
      archiveRestoreAndLocatePreserveGroup: true,
      groupedProjectPortability: true,
      manifestOnlyPersistence: true,
      failedMutationPreservesManifest: true
    }, null, 2)}\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

function runDomainTests() {
  const original = createManifest();
  const parsed = parseProjectManifest(original);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.groups, undefined);
  assert.equal(parsed.documents.every((document) => document.group_id === undefined), true);

  const withShared = createDocumentGroup(parsed, "Shared Research", "2026-07-21T00:01:00.000Z");
  assert.equal(withShared.schema_version, 2);
  assert.deepEqual(withShared.documents.map(({ group_id }) => group_id), [null, null, null]);
  assert.match(withShared.groups[0].group_id, /^grp_/);
  const sharedId = withShared.groups[0].group_id;

  const withCrust = createDocumentGroup(
    withShared,
    "Crust Chant",
    "2026-07-21T00:02:00.000Z"
  );
  const crustId = withCrust.groups[1].group_id;
  assert.throws(() => createDocumentGroup(withCrust, "  crust   chant  "));
  assert.throws(() =>
    parseProjectManifest({
      ...withCrust,
      documents: withCrust.documents.map((document, index) =>
        index === 0 ? { ...document, group_id: "grp_missing" } : document
      )
    })
  );

  const renamed = renameDocumentGroup(withCrust, crustId, "Crust Chant Business");
  assert.equal(renamed.groups[1].group_id, crustId);
  assert.equal(renamed.groups[1].title, "Crust Chant Business");
  const reorderedGroups = reorderDocumentGroup(renamed, crustId, "up");
  assert.equal(
    [...reorderedGroups.groups].sort((left, right) => left.position - right.position)[0]
      .group_id,
    crustId
  );

  let assigned = assignDocumentToGroup(reorderedGroups, "doc_action", crustId);
  assigned = assignDocumentToGroup(assigned, "doc_research", crustId);
  assigned = assignDocumentToGroup(assigned, "doc_framework", sharedId);
  const actionPosition = assigned.documents.find(
    ({ document_id }) => document_id === "doc_action"
  ).position;
  const researchPosition = assigned.documents.find(
    ({ document_id }) => document_id === "doc_research"
  ).position;
  assert.ok(researchPosition > actionPosition);
  const reorderedDocuments = reorderRegisteredDocument(
    assigned,
    "doc_research",
    "up"
  );
  assert.ok(
    reorderedDocuments.documents.find(({ document_id }) => document_id === "doc_research")
      .position <
      reorderedDocuments.documents.find(({ document_id }) => document_id === "doc_action")
        .position
  );

  const moved = assignDocumentToGroup(reorderedDocuments, "doc_action", sharedId);
  assert.equal(
    moved.documents.find(({ document_id }) => document_id === "doc_action").group_id,
    sharedId
  );
  const ungrouped = assignDocumentToGroup(moved, "doc_action", null);
  assert.equal(
    ungrouped.documents.find(({ document_id }) => document_id === "doc_action").group_id,
    null
  );

  const archived = archiveRegisteredDocument(ungrouped, "doc_research");
  const restored = restoreRegisteredDocument(archived, "doc_research");
  assert.equal(
    restored.documents.find(({ document_id }) => document_id === "doc_research").group_id,
    crustId
  );
  const removed = removeDocumentGroup(
    archiveRegisteredDocument(restored, "doc_research"),
    crustId
  );
  assert.equal(removed.groups.some(({ group_id }) => group_id === crustId), false);
  const formerMember = removed.documents.find(
    ({ document_id }) => document_id === "doc_research"
  );
  assert.equal(formerMember.status, "archived");
  assert.equal(formerMember.group_id, null);
}

async function runPersistenceTests() {
  const projectRoot = path.join(temporaryRoot, "strategy");
  const metadataRoot = path.join(projectRoot, ".patchmark");
  fs.mkdirSync(metadataRoot, { recursive: true });
  const manifestPath = path.join(metadataRoot, "project.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);
  for (const document of createManifest().documents) {
    fs.writeFileSync(path.join(projectRoot, document.path), `# ${document.display_title}\n`);
    const store = path.join(metadataRoot, "documents", document.document_id);
    fs.mkdirSync(path.join(store, "versions"), { recursive: true });
    fs.writeFileSync(path.join(store, "comments.json"), `[{"id":"PM-COMMENT-SHARED"}]\n`);
    fs.writeFileSync(path.join(store, "patches.json"), "[]\n");
    fs.writeFileSync(
      path.join(store, "manifest.json"),
      `{"schema_version":1,"reading_bookmark":{"document_id":"${document.document_id}"}}\n`
    );
  }

  const writes = [];
  const controller = createNodeHandleController({
    beforeWrite(filePath) {
      writes.push(filePath);
    }
  });
  const root = new NodeDirectoryHandle(projectRoot, controller);
  const opened = await readProjectManifest(root);
  assert.ok(opened);
  assert.equal(writes.length, 0, "Opening a schema-v1 manifest must not write it.");
  const fingerprints = fingerprintDocumentData(projectRoot, opened.documents);

  let grouped = createDocumentGroup(opened, "Shared Research");
  const groupId = grouped.groups[0].group_id;
  grouped = assignDocumentToGroup(grouped, "doc_framework", groupId);
  await writeProjectManifestAtomic(root, grouped);
  assert.deepEqual(
    fingerprintDocumentData(projectRoot, opened.documents),
    fingerprints,
    "Group-only persistence must not rewrite Markdown or document stores."
  );
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).schema_version, 2);

  const created = await createProjectDocument({
    displayTitle: "Shared Notes",
    groupId,
    manifest: grouped,
    path: "shared-notes.md",
    role: "research",
    root
  });
  assert.equal(created.document.group_id, groupId);
  fs.writeFileSync(path.join(projectRoot, "existing-research.md"), "# Existing Research\n");
  const added = await addExistingProjectDocument({
    groupId: null,
    manifest: created.manifest,
    path: "existing-research.md",
    role: null,
    root
  });
  assert.equal(added.document.group_id, null);
  grouped = added.manifest;

  let failureBase = createDocumentGroup(
    grouped,
    "Crust Chant",
    "2026-07-21T00:03:00.000Z"
  );
  const secondGroupId = failureBase.groups.find(
    ({ title }) => title === "Crust Chant"
  ).group_id;
  failureBase = assignDocumentToGroup(failureBase, "doc_action", groupId);
  const failedMutations = [
    createDocumentGroup(failureBase, "Operations"),
    renameDocumentGroup(failureBase, groupId, "Research Library"),
    reorderDocumentGroup(failureBase, secondGroupId, "up"),
    assignDocumentToGroup(failureBase, "doc_research", secondGroupId),
    reorderRegisteredDocument(failureBase, "doc_action", "up"),
    removeDocumentGroup(failureBase, groupId)
  ];
  const previousBeforeWrite = controller.beforeWrite;
  controller.beforeWrite = (filePath, contents) => {
    previousBeforeWrite?.(filePath, contents);
    if (filePath === manifestPath) {
      throw new Error("simulated group manifest failure");
    }
  };
  for (const failed of failedMutations) {
    const previousManifest = `${JSON.stringify(failureBase, null, 2)}\n`;
    fs.writeFileSync(manifestPath, previousManifest);
    await assert.rejects(() => writeProjectManifestAtomic(root, failed));
    assert.equal(fs.readFileSync(manifestPath, "utf8"), previousManifest);
  }
  controller.beforeWrite = previousBeforeWrite;
  assert.deepEqual(fingerprintDocumentData(projectRoot, opened.documents), fingerprints);
  grouped = failureBase;

  const framework = grouped.documents.find(
    ({ document_id }) => document_id === "doc_framework"
  );
  fs.renameSync(
    path.join(projectRoot, framework.path),
    path.join(projectRoot, "business-dimensions-moved.md")
  );
  const located = await locateRegisteredProjectDocument({
    documentId: framework.document_id,
    manifest: grouped,
    path: "business-dimensions-moved.md",
    root
  });
  assert.equal(
    located.documents.find(({ document_id }) => document_id === framework.document_id)
      .group_id,
    groupId
  );

  const copiedRoot = path.join(temporaryRoot, "strategy-copy");
  fs.cpSync(projectRoot, copiedRoot, { recursive: true });
  const copiedManifest = await readProjectManifest(new NodeDirectoryHandle(copiedRoot));
  assert.deepEqual(copiedManifest.groups, located.groups);
  assert.deepEqual(
    copiedManifest.documents.map(({ document_id, group_id }) => ({ document_id, group_id })),
    located.documents.map(({ document_id, group_id }) => ({ document_id, group_id }))
  );
}

function createManifest() {
  const now = "2026-07-21T00:00:00.000Z";
  return {
    format: "patchmark-project",
    schema_version: 1,
    project_id: "prj_strategy",
    title: "Strategy",
    created_at: now,
    manifest_revision: 1,
    documents: [
      createDocument("doc_action", "action-plan.md", "Action Plan", 1000, now),
      createDocument(
        "doc_research",
        "ready-to-eat.md",
        "Ready-to-Eat Channel Research",
        2000,
        now
      ),
      createDocument(
        "doc_framework",
        "business-dimensions.md",
        "Business Dimensions Framework",
        3000,
        now
      )
    ]
  };
}

function createDocument(documentId, documentPath, displayTitle, position, now) {
  return {
    document_id: documentId,
    path: documentPath,
    display_title: displayTitle,
    role: "research",
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function fingerprintDocumentData(projectRoot, documents) {
  return Object.fromEntries(
    documents.flatMap((document) => {
      const storeRoot = path.join(
        projectRoot,
        ".patchmark",
        "documents",
        document.document_id
      );
      const paths = [document.path, ...listFiles(storeRoot).map((filePath) =>
        path.relative(projectRoot, filePath)
      )];
      return paths.map((relativePath) => [
        relativePath,
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(projectRoot, relativePath)))
          .digest("hex")
      ]);
    })
  );
}

function listFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

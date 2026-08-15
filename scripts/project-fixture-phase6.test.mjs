import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProjectDocumentIdentity,
  listProjectVersions,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { createDocumentSwitchProject } from "./lib/fixtures/create-document-switch-project.mjs";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";
import {
  PROJECT_FIXTURE_IDS,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const generatedRoot = mkdtempSync(join(tmpdir(), "patchmark-fixture-phase6-"));
const retiredRealProjectVariable = ["PATCHMARK", "REAL", "PROJECT", "DIR"].join(
  "_"
);
const sourceDigests = Object.fromEntries(
  Object.entries(PROJECT_FIXTURE_IDS).map(([name, fixtureId]) => [
    name,
    digestProjectTree(getProjectFixtureRoot(fixtureId))
  ])
);
const browserOptions = {
  bookmarkDocumentIndex: 1,
  commentCountPerDocument: 31,
  documentCount: 3,
  historyCountPerDocument: 49,
  includeMissingDocument: true,
  paragraphCountPerDocument: 85,
  paragraphRepeatCount: 12,
  patchCountPerDocument: 59,
  seed: "document-switch-browser-v1"
};
const results = {};

try {
  const firstRoot = createDestination("first");
  const secondRoot = createDestination("second");
  const first = createDocumentSwitchProject(firstRoot, browserOptions);
  const second = createDocumentSwitchProject(secondRoot, browserOptions);
  const initialDigest = digestProjectTree(firstRoot);
  assert.deepEqual(first, second);
  assert.deepEqual(initialDigest, digestProjectTree(secondRoot));
  assert.equal(first.documents.length, 3);
  assert.equal(first.missingDocument.writeMarkdown, false);
  assert.equal(existsSync(join(firstRoot, first.missingDocument.path)), false);
  assert.equal(first.bookmarkDocumentId, first.documents[1].documentId);
  assertFixturePrivacy(firstRoot);

  const projectManifest = readJson(join(firstRoot, ".patchmark", "project.json"));
  assert.equal(projectManifest.schema_version, 2);
  assert.equal(projectManifest.project_id, first.projectId);
  assert.deepEqual(
    projectManifest.documents.map((document) => ({
      documentId: document.document_id,
      path: document.path
    })),
    [...first.documents, first.missingDocument].map((document) => ({
      documentId: document.documentId,
      path: document.path
    }))
  );

  const opened = await openProjectFolderHandle(new NodeDirectoryHandle(firstRoot), {
    readOnly: false
  });
  assert.equal(opened.project.projectManifest.schema_version, 2);
  for (const document of first.documents) {
    const loaded = await openProjectDocument(opened.project, document.documentId);
    assert.deepEqual(getProjectDocumentIdentity(loaded.project), {
      documentId: document.documentId,
      projectId: first.projectId
    });
    assert.equal(loaded.markdown.includes(document.sentinel), true);
    for (const unrelated of first.documents.filter(
      (candidate) => candidate.documentId !== document.documentId
    )) {
      assert.equal(loaded.markdown.includes(unrelated.sentinel), false);
    }
    assert.equal((await readProjectComments(loaded.project)).length, 31);
    assert.equal((await readProjectPatches(loaded.project)).length, 59);
    assert.equal((await listProjectVersions(loaded.project)).length, 49);
    if (document.documentId === first.bookmarkDocumentId) {
      assert.deepEqual(loaded.project.manifest.reading_bookmark.document, {
        document_id: document.documentId,
        project_id: first.projectId
      });
    }
  }
  const missing = await openProjectDocument(
    opened.project,
    first.missingDocument.documentId
  );
  assert.equal(missing.project.documentAvailability, "missing");

  const target = first.documents[0];
  const targetLoaded = await openProjectDocument(opened.project, target.documentId);
  const comments = await readProjectComments(targetLoaded.project);
  const patches = await readProjectPatches(targetLoaded.project);
  const unrelatedBefore = first.documents.slice(1).map((document) => ({
    document: readFileSync(join(firstRoot, document.path)),
    manifest: readFileSync(join(firstRoot, document.manifestPath)),
    patches: readFileSync(
      join(firstRoot, ".patchmark", "documents", document.documentId, "patches.json")
    )
  }));
  const savedMarkdown = `${targetLoaded.markdown}\nPHASE 6 SAVE REOPEN SENTINEL\n`;
  const saveResult = await saveProjectState({
    comments,
    markdown: savedMarkdown,
    patches,
    project: targetLoaded.project,
    reason: "fixture_phase6_round_trip",
    rollbackOnFailure: true
  });
  assert.equal(saveResult.status, "committed");
  const savedManifest = readJson(join(firstRoot, target.manifestPath));
  const savedCommit = readJson(join(firstRoot, target.saveCommitPath));
  assert.equal(savedManifest.schema_version, 1);
  assert.equal(savedManifest.project_id, first.projectId);
  assert.equal(savedManifest.document_id, target.documentId);
  assert.equal(savedManifest.save_generation, 8);
  assert.equal(savedManifest.save_commit_id, savedCommit.commit_id);
  assert.equal(savedCommit.format_version, 1);
  assert.equal(savedCommit.generation, savedManifest.save_generation);
  assert.deepEqual(Object.keys(savedCommit.files).sort(), [
    "comments",
    "document",
    "manifest",
    "patches"
  ]);
  assert.equal(savedManifest.versions.length, target.historyCount);

  const reopenedProject = await openProjectFolderHandle(
    new NodeDirectoryHandle(firstRoot),
    { readOnly: true }
  );
  const reopenedTarget = await openProjectDocument(
    reopenedProject.project,
    target.documentId
  );
  assert.equal(reopenedTarget.markdown, savedMarkdown);
  assert.equal((await readProjectComments(reopenedTarget.project)).length, 31);
  assert.equal((await readProjectPatches(reopenedTarget.project)).length, 59);
  for (const [index, document] of first.documents.slice(1).entries()) {
    assert.deepEqual(
      readFileSync(join(firstRoot, document.path)),
      unrelatedBefore[index].document
    );
    assert.deepEqual(
      readFileSync(join(firstRoot, document.manifestPath)),
      unrelatedBefore[index].manifest
    );
    assert.deepEqual(
      readFileSync(
        join(firstRoot, ".patchmark", "documents", document.documentId, "patches.json")
      ),
      unrelatedBefore[index].patches
    );
  }
  assert.deepEqual(digestProjectTree(secondRoot), initialDigest);

  const concurrent = await Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const root = createDestination(`concurrent-${index + 1}`);
      const contract = createDocumentSwitchProject(root, browserOptions);
      return { contract, digest: digestProjectTree(root), root };
    })
  );
  assert.equal(new Set(concurrent.map(({ root }) => root)).size, 3);
  for (const entry of concurrent) {
    assert.deepEqual(entry.contract, second);
    assert.deepEqual(entry.digest, initialDigest);
  }
  writeFileSync(join(concurrent[0].root, "owned-run-only.txt"), "OWNED RUN ONLY\n");
  for (const entry of concurrent.slice(1)) {
    assert.equal(existsSync(join(entry.root, "owned-run-only.txt")), false);
  }

  const gateInventory = collectGateInventory();
  assert.deepEqual(gateInventory, []);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PROJECT_FIXTURE_IDS).map(([name, fixtureId]) => [
        name,
        digestProjectTree(getProjectFixtureRoot(fixtureId))
      ])
    ),
    sourceDigests
  );
  results.builder = {
    bytes: first.documents.map((document) => document.bytes),
    commentsPerDocument: first.commentCountPerDocument,
    deterministicDigest: initialDigest.digest,
    documents: first.documentCount,
    historiesPerDocument: first.historyCountPerDocument,
    missingDocument: first.missingDocument.documentId,
    patchesPerDocument: first.patchCountPerDocument
  };
  results.persistence = {
    commitFormatVersion: savedCommit.format_version,
    generation: savedCommit.generation,
    identitiesPreserved: true,
    reloadStable: true,
    unrelatedDocumentsUnchanged: true
  };
  results.isolation = {
    canonicalFixturesUnchanged: true,
    concurrentRoots: concurrent.length,
    privatePathMatches: 0,
    realProjectReferences: gateInventory.length
  };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  rmSync(generatedRoot, { force: true, recursive: true });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PROJECT_FIXTURE_IDS).map(([name, fixtureId]) => [
        name,
        digestProjectTree(getProjectFixtureRoot(fixtureId))
      ])
    ),
    sourceDigests
  );
}

function createDestination(name) {
  const destination = join(generatedRoot, name);
  mkdirSync(destination, { recursive: false });
  return destination;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertFixturePrivacy(root) {
  const forbidden = [
    "/Users/",
    "/private/tmp/",
    retiredRealProjectVariable,
    process.env.HOME ?? "",
    process.env.TMPDIR ?? ""
  ].filter(Boolean);
  for (const entry of digestProjectTree(root).entries) {
    if (entry.kind !== "file") continue;
    const contents = readFileSync(join(root, ...entry.path.split("/")), "utf8");
    for (const value of forbidden) {
      assert.equal(contents.includes(value), false, `${entry.path} leaked ${value}.`);
    }
  }
}

function collectGateInventory() {
  const paths = [
    "scripts/document-switch-performance-browser.test.mjs",
    "scripts/persistence-consistency-audit.test.mjs",
    "scripts/lib/fixtures/create-document-switch-project.mjs",
    "docs/multi-document-switching-performance.md",
    "docs/phase-7b-persistence-safety.md"
  ];
  return paths.filter((path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8").includes(
      retiredRealProjectVariable
    )
  );
}

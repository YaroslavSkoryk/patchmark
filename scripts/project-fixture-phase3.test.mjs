import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createVersionRef } from "../lib/project/document-scoped-identity.ts";
import {
  getProjectDocumentIdentity,
  getProjectDocumentScopeId,
  listProjectVersions,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  readProjectVersionMarkdownByRef
} from "../lib/project/patchmark-project.ts";
import { createVersionHistoryEntries } from "../lib/project/version-history-display.ts";
import {
  VERSION_HISTORY_FIXTURE,
  applyVersionHistoryProject
} from "./lib/fixtures/apply-version-history-project.mjs";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const copies = [];
const results = {};

try {
  assert.throws(
    () => applyVersionHistoryProject(sourceRoot),
    /fresh fixture copy/
  );

  const first = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const second = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(first, second);
  assert.deepEqual(digestProjectTree(first.projectRoot), sourceDigest);
  assert.deepEqual(digestProjectTree(second.projectRoot), sourceDigest);
  const firstContract = applyVersionHistoryProject(first.projectRoot);
  const secondContract = applyVersionHistoryProject(second.projectRoot);
  const variantDigest = digestProjectTree(first.projectRoot);
  assert.deepEqual(firstContract, secondContract);
  assert.deepEqual(digestProjectTree(second.projectRoot), variantDigest);
  assert.notEqual(variantDigest.digest, sourceDigest.digest);
  assert.notDeepEqual(
    firstContract.manifestOrder,
    [...firstContract.newestFirst.map((entry) => entry.id)].reverse()
  );
  assert.notDeepEqual(firstContract.fileWriteOrder, firstContract.manifestOrder);

  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(first.projectRoot),
    { readOnly: true }
  );
  assert.deepEqual(getProjectDocumentIdentity(loaded.project), {
    projectId: VERSION_HISTORY_FIXTURE.projectId,
    documentId: VERSION_HISTORY_FIXTURE.documentId
  });
  assert.equal(loaded.markdown, firstContract.currentMarkdown);
  assert.equal(
    getProjectDocumentScopeId(loaded.project),
    VERSION_HISTORY_FIXTURE.versionScopeId
  );
  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  const versions = await listProjectVersions(loaded.project);
  assert.equal(comments.length, firstContract.commentCount);
  assert.equal(comments[0].id, VERSION_HISTORY_FIXTURE.activeCommentId);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].pre_apply_snapshot_id, "PM-VERSION-HISTORY-05");
  assert.deepEqual(
    versions.map((version) => version.id),
    firstContract.manifestOrder
  );

  const displayEntries = createVersionHistoryEntries({
    comments,
    patches,
    versions
  });
  assert.deepEqual(
    displayEntries.map((entry) => ({
      id: entry.version.id,
      title: entry.title
    })),
    firstContract.newestFirst.map((entry) => ({
      id: entry.id,
      title: entry.title
    }))
  );

  for (const expected of firstContract.newestFirst) {
    const version = versions.find((candidate) => candidate.id === expected.id);
    assert.ok(version, `Missing version ${expected.id}.`);
    const markdown = await readProjectVersionMarkdownByRef(
      loaded.project,
      createVersionRef(VERSION_HISTORY_FIXTURE.versionScopeId, version.id),
      version
    );
    assert.equal(markdown, expected.markdown);
    assert.equal(version.file, expected.file);
    assert.equal(version.content_hash, expected.content_hash);
  }

  const scopedVersion = versions.find(
    (version) => version.id === VERSION_HISTORY_FIXTURE.versionIds[0]
  );
  await assert.rejects(
    () =>
      readProjectVersionMarkdownByRef(
        loaded.project,
        createVersionRef("doc_fixture_other", scopedVersion.id),
        scopedVersion
      ),
    /belongs to doc_fixture_other, not legacy-document/
  );
  await assert.rejects(
    () =>
      readProjectVersionMarkdownByRef(
        loaded.project,
        createVersionRef(VERSION_HISTORY_FIXTURE.versionScopeId, "wrong-version"),
        scopedVersion
      ),
    /does not match/
  );
  assert.deepEqual(digestProjectTree(first.projectRoot), variantDigest);
  assert.deepEqual(digestProjectTree(second.projectRoot), variantDigest);

  const concurrent = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
      copies.push(copy);
      const contract = applyVersionHistoryProject(copy.projectRoot);
      return { contract, copy };
    })
  );
  assert.equal(
    new Set(concurrent.map(({ copy }) => copy.projectRoot)).size,
    concurrent.length
  );
  const concurrentDigest = digestProjectTree(concurrent[0].copy.projectRoot);
  for (const { contract, copy } of concurrent.slice(1)) {
    assert.deepEqual(contract, concurrent[0].contract);
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
  }
  appendFileSync(
    join(
      concurrent[0].copy.projectRoot,
      ".patchmark",
      "versions",
      "pm-version-history-01.md"
    ),
    "\nOwned-copy mutation.\n"
  );
  for (const { copy } of concurrent.slice(1)) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
  }

  const targetSource = readFileSync(
    new URL("version-history-browser.test.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(
    targetSource.includes(["PATCHMARK", "REAL", "PROJECT", "DIR"].join("_")),
    false,
    "Version-history required modes must not read the real-project gate."
  );
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
  results.history = {
    currentVersionId: firstContract.currentVersionId,
    digest: variantDigest.digest,
    identity: getProjectDocumentIdentity(loaded.project),
    manifestOrder: firstContract.manifestOrder,
    newestFirst: firstContract.newestFirst.map(({ id, title }) => ({ id, title })),
    snapshotCount: versions.length
  };
  results.concurrent = {
    copies: concurrent.length,
    digest: concurrentDigest.digest,
    isolated: true
  };
  results.source = {
    digest: sourceDigest.digest,
    unchanged: true
  };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  for (const copy of copies.reverse()) {
    copy.cleanup();
    assert.equal(existsSync(copy.temporaryRoot), false);
  }
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
}

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getProjectDocumentIdentity,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches
} from "../lib/project/patchmark-project.ts";
import {
  COMMENT_EDIT_FIXTURE,
  applyCommentEditProject
} from "./lib/fixtures/apply-comment-edit-project.mjs";
import {
  COMMENT_RAIL_FIXTURE,
  applyCommentRailProject
} from "./lib/fixtures/apply-comment-rail-project.mjs";
import {
  PERSISTENCE_FIXTURE,
  applyPersistenceProject
} from "./lib/fixtures/apply-persistence-project.mjs";
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
    () => applyCommentRailProject(sourceRoot),
    /fresh fixture copy/
  );
  assert.throws(
    () => applyPersistenceProject(sourceRoot),
    /fresh fixture copy/
  );
  assert.throws(
    () => applyCommentEditProject(sourceRoot),
    /fresh fixture copy/
  );

  results.commentRail = await verifyOverlay({
    apply: applyCommentRailProject,
    verify: async ({ contract, loaded }) => {
      const comments = await readProjectComments(loaded.project);
      const patches = await readProjectPatches(loaded.project);
      const top = comments.find(
        (comment) => comment.id === COMMENT_RAIL_FIXTURE.topCommentId
      );
      const lower = comments.find(
        (comment) => comment.id === COMMENT_RAIL_FIXTURE.lowerCommentId
      );
      assert.equal(comments.length, 13);
      assert.equal(top?.anchor.kind, "document");
      assert.equal(top?.status, "resolved");
      assert.equal(top?.thread.length, 11);
      assert.equal(lower?.anchor.kind, "selected_text");
      assert.ok(lower.anchor.markdown_start_offset > 3_000);
      assert.equal(patches.length, 1);
      assert.equal(patches[0].status, "accepted");
      assert.equal(contract.commentCount, comments.length);
    }
  });

  results.persistence = await verifyOverlay({
    apply: applyPersistenceProject,
    verify: async ({ contract, loaded }) => {
      const comments = await readProjectComments(loaded.project);
      const patches = await readProjectPatches(loaded.project);
      assert.equal(comments.length, 5);
      assert.equal(comments[0].id, PERSISTENCE_FIXTURE.primaryCommentId);
      assert.equal(patches.length, 1);
      assert.equal(patches[0].comment_id, PERSISTENCE_FIXTURE.primaryCommentId);
      assert.equal(contract.markdown, loaded.markdown);
    }
  });

  results.commentEdit = await verifyOverlay({
    apply: (root) =>
      applyCommentEditProject(root, {
        commentCount: 12,
        paragraphCount: 48
      }),
    verify: async ({ contract, loaded }) => {
      const comments = await readProjectComments(loaded.project);
      const target = comments.find(
        (comment) => comment.id === COMMENT_EDIT_FIXTURE.targetCommentId
      );
      const unrelated = comments.find(
        (comment) => comment.id === COMMENT_EDIT_FIXTURE.unrelatedCommentId
      );
      assert.equal(comments.length, 12);
      assert.equal(target?.thread.length, 2);
      assert.equal(unrelated?.thread.length, 1);
      assert.match(loaded.markdown, /Purpose\./);
      assert.match(loaded.markdown, /Working principle\./);
      assert.match(loaded.markdown, /Source Notes/);
      assert.match(loaded.markdown, /\| Signal \| State \|/);
      assert.equal(contract.documentBytes, Buffer.byteLength(loaded.markdown));
    }
  });

  const concurrent = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
      copies.push(copy);
      applyCommentEditProject(copy.projectRoot);
      return copy;
    })
  );
  assert.equal(new Set(concurrent.map((copy) => copy.projectRoot)).size, 3);
  const concurrentDigest = digestProjectTree(concurrent[0].projectRoot);
  for (const copy of concurrent.slice(1)) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
  }
  appendFileSync(join(concurrent[0].projectRoot, "document.md"), "mutation\n");
  for (const copy of concurrent.slice(1)) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
  }
  results.concurrent = {
    copies: concurrent.length,
    digest: concurrentDigest.digest,
    isolated: true
  };

  for (const targetSuite of [
    "comment-rail-editor-browser-regression.test.mjs",
    "persistence-browser-audit.mjs",
    "comment-edit-performance-browser.test.mjs"
  ]) {
    const source = readFileSync(new URL(targetSuite, import.meta.url), "utf8");
    assert.equal(
      source.includes(["PATCHMARK", "REAL", "PROJECT", "DIR"].join("_")),
      false,
      `${targetSuite} must not read the real-project environment gate.`
    );
  }

  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
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

async function verifyOverlay({ apply, verify }) {
  const first = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const second = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(first, second);
  assert.deepEqual(digestProjectTree(first.projectRoot), sourceDigest);
  assert.deepEqual(digestProjectTree(second.projectRoot), sourceDigest);
  const firstContract = apply(first.projectRoot);
  const secondContract = apply(second.projectRoot);
  const firstDigest = digestProjectTree(first.projectRoot);
  const secondDigest = digestProjectTree(second.projectRoot);
  assert.deepEqual(firstContract, secondContract);
  assert.deepEqual(firstDigest, secondDigest);
  assert.notEqual(firstDigest.digest, sourceDigest.digest);
  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(first.projectRoot),
    { readOnly: true }
  );
  assert.deepEqual(getProjectDocumentIdentity(loaded.project), {
    projectId: "prj_fixture_atlas",
    documentId: "doc_fixture_atlas"
  });
  assert.equal(loaded.recovery, undefined);
  await verify({ contract: firstContract, loaded });
  assert.deepEqual(digestProjectTree(second.projectRoot), secondDigest);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
  return {
    digest: firstDigest.digest,
    identity: getProjectDocumentIdentity(loaded.project)
  };
}

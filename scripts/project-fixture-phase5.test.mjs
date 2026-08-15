import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  getProjectDocumentIdentity,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { getPatchFollowUpRelationship } from "../lib/patches/comment-patch-history.ts";
import { getPatchDependencyReviewStatus } from "../lib/patches/patch-dependencies.ts";
import {
  PATCH_CONTINUATION_FIXTURE,
  applyPatchContinuationProject
} from "./lib/fixtures/apply-patch-continuation-project.mjs";
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
    () => applyPatchContinuationProject(sourceRoot),
    /fresh fixture copy/
  );

  const first = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const second = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(first, second);
  const firstContract = applyPatchContinuationProject(first.projectRoot);
  const secondContract = applyPatchContinuationProject(second.projectRoot);
  const overlayDigest = digestProjectTree(first.projectRoot);
  assert.deepEqual(firstContract, secondContract);
  assert.deepEqual(digestProjectTree(second.projectRoot), overlayDigest);
  assert.notEqual(overlayDigest.digest, sourceDigest.digest);

  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(first.projectRoot),
    { readOnly: true }
  );
  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  assert.deepEqual(getProjectDocumentIdentity(loaded.project), {
    projectId: PATCH_CONTINUATION_FIXTURE.projectId,
    documentId: PATCH_CONTINUATION_FIXTURE.documentId
  });
  assert.equal(loaded.markdown, firstContract.initialMarkdown);
  assert.doesNotMatch(
    loaded.markdown,
    new RegExp(PATCH_CONTINUATION_FIXTURE.unrelatedDocumentSentinel)
  );
  assert.equal(comments.length, 14);
  assert.equal(patches.length, 5);

  const linkedPatch = patches.find(
    (patch) => patch.id === PATCH_CONTINUATION_FIXTURE.linkedPatchId
  );
  const basePatch = patches.find(
    (patch) => patch.id === PATCH_CONTINUATION_FIXTURE.basePatchId
  );
  const linkedComment = comments.find(
    (comment) => comment.id === PATCH_CONTINUATION_FIXTURE.linkedCommentId
  );
  assert.equal(basePatch?.status, "accepted");
  assert.equal(linkedPatch?.status, "pending");
  assert.deepEqual(linkedPatch?.depends_on_patch_ids, [basePatch?.id]);
  assert.equal(linkedComment?.status, "open");
  assert.equal(
    getPatchFollowUpRelationship({
      comment: linkedComment,
      patch: linkedPatch,
      patches
    }),
    null
  );
  assert.deepEqual(
    getPatchDependencyReviewStatus({
      applicability: "exact_match",
      patch: linkedPatch,
      patches
    }),
    {
      acceptedCount: 1,
      directDependencies: [{ id: basePatch.id, patch: basePatch }],
      pendingCount: 0,
      rejectedCount: 0,
      state: "ready",
      totalCount: 1,
      unavailableCount: 0
    }
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        patches.find(
          (patch) => patch.id === PATCH_CONTINUATION_FIXTURE.unrelatedPatchId
        )
      )
    ),
    firstContract.unrelatedPatch
  );
  assert.equal(
    readFileSync(
      join(
        first.projectRoot,
        PATCH_CONTINUATION_FIXTURE.unrelatedDocumentFileName
      ),
      "utf8"
    ),
    firstContract.unrelatedDocumentMarkdown
  );

  const privacyText = [
    loaded.markdown,
    JSON.stringify(comments),
    JSON.stringify(patches),
    firstContract.unrelatedDocumentMarkdown
  ].join("\n");
  for (const forbidden of [
    sourceRoot,
    first.projectRoot,
    first.temporaryRoot,
    process.env.HOME ?? "",
    process.env.TMPDIR ?? ""
  ].filter(Boolean)) {
    assert.doesNotMatch(privacyText, new RegExp(escapeRegExp(forbidden)));
  }

  const savedMarkdown = `${loaded.markdown}\n\nFRESH COPY SAVE ISOLATION SENTINEL\n`;
  const saveResult = await saveProjectState({
    comments,
    markdown: savedMarkdown,
    patches,
    project: loaded.project,
    reason: "fixture_phase5_save_isolation",
    rollbackOnFailure: true
  });
  assert.equal(saveResult.status, "committed");
  const reopened = await openProjectFolderHandle(
    new NodeDirectoryHandle(first.projectRoot),
    { readOnly: true }
  );
  assert.equal(reopened.markdown, savedMarkdown);
  assert.equal(
    readFileSync(join(second.projectRoot, "document.md"), "utf8"),
    secondContract.initialMarkdown
  );
  assert.deepEqual(digestProjectTree(second.projectRoot), overlayDigest);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);

  const concurrent = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
      copies.push(copy);
      const contract = applyPatchContinuationProject(copy.projectRoot);
      return { contract, copy, digest: digestProjectTree(copy.projectRoot) };
    })
  );
  assert.equal(
    new Set(concurrent.map(({ copy }) => copy.projectRoot)).size,
    concurrent.length
  );
  for (const entry of concurrent.slice(1)) {
    assert.deepEqual(entry.contract, concurrent[0].contract);
    assert.deepEqual(entry.digest, concurrent[0].digest);
  }
  writeFileSync(
    join(concurrent[0].copy.projectRoot, "owned-run-only.txt"),
    "OWNED RUN ONLY\n"
  );
  for (const entry of concurrent.slice(1)) {
    assert.equal(
      existsSync(join(entry.copy.projectRoot, "owned-run-only.txt")),
      false
    );
    assert.deepEqual(entry.digest, concurrent[0].digest);
  }

  let failedTemporaryRoot = null;
  assert.throws(
    () =>
      createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore, {
        copyTree: (_sourceRoot, projectRoot) => {
          failedTemporaryRoot = dirname(projectRoot);
          mkdirSync(projectRoot);
          writeFileSync(join(projectRoot, "partial.txt"), "partial\n");
          throw new Error("Injected Phase 5 copy failure");
        }
      }),
    /Injected Phase 5 copy failure/
  );
  assert.equal(existsSync(failedTemporaryRoot), false);

  const targetSource = readFileSync(
    new URL("patch-continuation-browser.test.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(
    targetSource.includes(["PATCHMARK", "REAL", "PROJECT", "DIR"].join("_")),
    false,
    "Required patch continuation coverage must not read the real-project gate."
  );
  assert.match(targetSource, /createProjectFixtureCopy/);
  assert.match(targetSource, /applyPatchContinuationProject/);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);

  results.patchContinuation = {
    digest: overlayDigest.digest,
    identity: getProjectDocumentIdentity(loaded.project),
    linkedPatchId: linkedPatch.id,
    prerequisitePatchId: basePatch.id,
    unrelatedPatchId: firstContract.unrelatedPatch.id
  };
  results.saveIsolation = {
    firstChanged: true,
    reopened: reopened.markdown === savedMarkdown,
    secondUnchanged: true,
    sourceUnchanged: true
  };
  results.concurrent = {
    copies: concurrent.length,
    digest: concurrent[0].digest.digest,
    isolated: true
  };
  results.failureCleanup = {
    injectedCopyRemoved: true
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

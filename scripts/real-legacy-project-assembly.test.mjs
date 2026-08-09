import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeLegacyProjectIdentityCompatibility,
  createLegacyProjectAssemblyPlan,
  executeLegacyProjectAssembly,
  inspectLegacyProjectAssemblySource
} from "../lib/project/legacy-project-assembly.ts";
import {
  getProjectDocumentExportIdentity,
  listProjectVersions,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches
} from "../lib/project/patchmark-project.ts";
import { resolveCanonicalCommentTarget } from "../lib/comments/canonical-target-resolution.ts";
import { getContinuableLinkedComment } from "../lib/patches/comment-patch-history.ts";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";

const actionPath =
  process.env.PATCHMARK_REAL_ACTION_SOURCE ??
  "/Users/yskoryk/Documents/patchmark_docs/action_plan_market_growthb";
const researchPath =
  process.env.PATCHMARK_REAL_RESEARCH_SOURCE ??
  "/Users/yskoryk/Documents/patchmark_docs/ready-to-eat-research";

if (!fs.existsSync(actionPath) || !fs.existsSync(researchPath)) {
  process.stdout.write(
    `${JSON.stringify({
      realCrustChantAssembly: "skipped",
      reason: "Set PATCHMARK_REAL_ACTION_SOURCE and PATCHMARK_REAL_RESEARCH_SOURCE to run the read-only real-project audit."
    }, null, 2)}\n`
  );
  process.exit(0);
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "patchmark-real-document-identity-")
);
const destinationPath = path.join(temporaryRoot, "assembled-project");
fs.mkdirSync(destinationPath);

try {
  const actionBefore = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(actionPath),
    "Crust Chant Action Plan"
  );
  const researchBefore = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(researchPath),
    "Ready-to-Eat Investigation"
  );
  const identityAnalysis = analyzeLegacyProjectIdentityCompatibility([
    actionBefore,
    researchBefore
  ]);
  const duplicateComments = identityAnalysis.allowedDocumentLocalDuplicates
    .filter((duplicate) => duplicate.namespace === "comment")
    .map((duplicate) => duplicate.id)
    .sort();
  const knownBaselineDuplicateComments = [
    "PM-COMMENT-0005",
    "PM-COMMENT-0008",
    "PM-COMMENT-0011",
    "PM-COMMENT-0013",
    "PM-COMMENT-0014",
    "PM-COMMENT-0015"
  ];
  for (const duplicateId of knownBaselineDuplicateComments) {
    assert.equal(duplicateComments.includes(duplicateId), true);
  }
  assert.equal(identityAnalysis.unsafeCollisions.length, 0);

  const plan = await createLegacyProjectAssemblyPlan({
    destination: new NodeDirectoryHandle(destinationPath),
    projectTitle: "Crust Chant Multi-Document Project",
    documents: [
      {
        source: actionBefore,
        destinationPath: "action-plan.md",
        displayTitle: "Action Plan",
        role: "decision"
      },
      {
        source: researchBefore,
        destinationPath: "ready-to-eat-investigation.md",
        displayTitle: "Ready-to-Eat Investigation",
        role: "research"
      }
    ]
  });
  const result = await executeLegacyProjectAssembly(plan);
  const openedDocuments = [];
  for (const entry of plan.entries) {
    const loaded = await openProjectDocument(
      result.loaded.project,
      entry.document.document_id
    );
    const comments = await readProjectComments(loaded.project);
    const patches = await readProjectPatches(loaded.project);
    const versions = await listProjectVersions(loaded.project);
    assert.equal(comments.length, entry.source.summary.comments);
    assert.equal(patches.length, entry.source.summary.patches);
    assert.equal(versions.length, entry.source.summary.versions);
    assert.equal(
      comments.reduce((count, comment) => count + comment.thread.length, 0),
      entry.source.summary.replies
    );
    const relationshipReport = inspectLocalRelationships({ comments, patches });
    for (const comment of comments) {
      const resolution = resolveCanonicalCommentTarget(comment, {
        markdown: loaded.markdown,
        patches
      });
      assert.ok(
        resolution.state === "resolved" ||
          resolution.state === "ambiguous" ||
          resolution.state === "not_found"
      );
    }
    const exportIdentity = getProjectDocumentExportIdentity(loaded.project);
    assert.equal(exportIdentity.project_id, plan.manifest.project_id);
    assert.equal(exportIdentity.document_id, entry.document.document_id);
    assert.equal(exportIdentity.document_title, entry.document.display_title);
    openedDocuments.push({
      comments,
      documentId: entry.document.document_id,
      markdown: loaded.markdown,
      patches,
      relationshipReport,
      versions
    });
  }

  for (const duplicateId of duplicateComments) {
    const actionComment = openedDocuments[0].comments.find(
      (comment) => comment.id === duplicateId
    );
    const researchComment = openedDocuments[1].comments.find(
      (comment) => comment.id === duplicateId
    );
    assert.ok(actionComment);
    assert.ok(researchComment);
    assert.equal(actionComment.id, duplicateId);
    assert.equal(researchComment.id, duplicateId);
    assert.notEqual(
      openedDocuments[0].documentId,
      openedDocuments[1].documentId
    );
  }
  assert.deepEqual(openedDocuments[0].relationshipReport.orphanPatchLinks, [
    { commentId: "PM-COMMENT-0003", patchId: "PM-PATCH-0001" },
    { commentId: "PM-COMMENT-0017", patchId: "PM-PATCH-0021" }
  ]);
  assert.deepEqual(openedDocuments[1].relationshipReport.orphanPatchLinks, []);
  assert.ok(
    openedDocuments[1].comments.some(
      (comment) => comment.id === "PM-COMMENT-0003"
    )
  );
  for (const { patchId } of openedDocuments[0].relationshipReport.orphanPatchLinks) {
    const patch = openedDocuments[0].patches.find(
      (candidate) => candidate.id === patchId
    );
    assert.ok(patch);
    assert.equal(
      getContinuableLinkedComment({
        comments: openedDocuments[0].comments,
        patch
      }),
      null
    );
  }

  const destinationFingerprintBeforeReopen = fingerprintTree(destinationPath);
  const reopened = await openProjectFolderHandle(
    new NodeDirectoryHandle(destinationPath)
  );
  for (const [index, entry] of plan.entries.entries()) {
    const loaded = await openProjectDocument(
      reopened.project,
      entry.document.document_id
    );
    assert.equal(loaded.markdown, openedDocuments[index].markdown);
    assert.deepEqual(
      await readProjectComments(loaded.project),
      openedDocuments[index].comments
    );
    assert.deepEqual(
      await readProjectPatches(loaded.project),
      openedDocuments[index].patches
    );
    assert.deepEqual(
      await listProjectVersions(loaded.project),
      openedDocuments[index].versions
    );
  }
  assert.equal(fingerprintTree(destinationPath), destinationFingerprintBeforeReopen);

  const actionAfter = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(actionPath),
    "Crust Chant Action Plan"
  );
  const researchAfter = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(researchPath),
    "Ready-to-Eat Investigation"
  );
  assert.equal(
    actionAfter.summary.sourceFingerprintSha256,
    actionBefore.summary.sourceFingerprintSha256
  );
  assert.equal(
    researchAfter.summary.sourceFingerprintSha256,
    researchBefore.summary.sourceFingerprintSha256
  );
  assert.equal(actionAfter.summary.comments, actionBefore.summary.comments);
  assert.equal(researchAfter.summary.comments, researchBefore.summary.comments);

  process.stdout.write(
    `${JSON.stringify({
      realCrustChantAssembly: true,
      duplicateCommentIds: duplicateComments,
      unsafeCollisions: identityAnalysis.unsafeCollisions.length,
      actionSourceFingerprintBefore:
        actionBefore.summary.sourceFingerprintSha256,
      actionSourceFingerprintAfter:
        actionAfter.summary.sourceFingerprintSha256,
      researchSourceFingerprintBefore:
        researchBefore.summary.sourceFingerprintSha256,
      researchSourceFingerprintAfter:
        researchAfter.summary.sourceFingerprintSha256,
      actionCounts: {
        comments: actionBefore.summary.comments,
        replies: actionBefore.summary.replies,
        patches: actionBefore.summary.patches,
        versions: actionBefore.summary.versions
      },
      researchCounts: {
        comments: researchBefore.summary.comments,
        replies: researchBefore.summary.replies,
        patches: researchBefore.summary.patches,
        versions: researchBefore.summary.versions
      },
      localRelationshipVerification: true,
      preservedLegacyOrphanPatchLinks:
        openedDocuments[0].relationshipReport.orphanPatchLinks,
      documentExportIdentityVerification: true,
      postAssemblyReopen: true,
      destinationFingerprintStable: true,
      sourcesRemainLoadable: true
    }, null, 2)}\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

function inspectLocalRelationships({ comments, patches }) {
  const commentIds = new Set(comments.map((comment) => comment.id));
  const patchIds = new Set(patches.map((patch) => patch.id));
  const orphanPatchLinks = [];
  for (const patch of patches) {
    if (patch.comment_id && !commentIds.has(patch.comment_id)) {
      orphanPatchLinks.push({
        commentId: patch.comment_id,
        patchId: patch.id
      });
    }
  }
  for (const comment of comments) {
    for (const reply of comment.thread) {
      if (reply.source_patch_id) {
        assert.equal(patchIds.has(reply.source_patch_id), true);
      }
    }
    for (const history of comment.anchor_history ?? []) {
      if (history.source_patch_id) {
        assert.equal(patchIds.has(history.source_patch_id), true);
      }
    }
    for (const impact of comment.patch_impacts ?? []) {
      assert.equal(patchIds.has(impact.patch_id), true);
    }
  }
  return {
    orphanPatchLinks: orphanPatchLinks.sort((left, right) =>
      left.patchId.localeCompare(right.patchId)
    )
  };
}

function fingerprintTree(rootPath) {
  const entries = [];
  walk(rootPath, "");
  return JSON.stringify(entries);

  function walk(currentPath, relativePath) {
    for (const entry of fs
      .readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const entryRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", path: entryRelativePath });
        walk(entryPath, entryRelativePath);
      } else {
        entries.push({
          bytes: fs.statSync(entryPath).size,
          contents: fs.readFileSync(entryPath).toString("base64"),
          kind: "file",
          path: entryRelativePath
        });
      }
    }
  }
}

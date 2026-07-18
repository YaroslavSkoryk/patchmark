import assert from "node:assert/strict";
import {
  assertDocumentScope,
  assertUniqueDocumentLocalIds,
  createAnchorHistoryRef,
  createCommentRef,
  createDocumentScopedKey,
  createPatchRef,
  createReplyRef,
  createVersionRef,
  documentScopedIdentifierKinds,
  findDocumentScopedValue,
  isDocumentScopeCurrent,
  projectScopedIdentifierKinds
} from "../lib/project/document-scoped-identity.ts";
import {
  analyzeLegacyProjectIdentityCompatibility,
  findLegacyProjectIdentityCollisions
} from "../lib/project/legacy-project-assembly.ts";

const actionComment = createCommentRef("doc-action-plan", "pm-comment-0001");
const researchComment = createCommentRef(
  "doc-ready-to-eat",
  "pm-comment-0001"
);
assert.notEqual(
  createDocumentScopedKey(actionComment),
  createDocumentScopedKey(researchComment)
);
assert.equal(isDocumentScopeCurrent(actionComment, "doc-action-plan"), true);
assert.equal(isDocumentScopeCurrent(actionComment, "doc-ready-to-eat"), false);
assert.doesNotThrow(() => assertDocumentScope(actionComment, "doc-action-plan"));
assert.throws(
  () => assertDocumentScope(actionComment, "doc-ready-to-eat"),
  /belongs to doc-action-plan/
);

const actionComments = [
  { id: "pm-comment-0001", text: "Action Plan comment" },
  { id: "pm-comment-0002", text: "Action Plan second comment" }
];
const researchComments = [
  { id: "pm-comment-0001", text: "Ready-to-Eat comment" }
];
assert.equal(
  findDocumentScopedValue({
    documentId: "doc-action-plan",
    getId: (comment) => comment.id,
    reference: actionComment,
    values: actionComments
  })?.text,
  "Action Plan comment"
);
assert.equal(
  findDocumentScopedValue({
    documentId: "doc-ready-to-eat",
    getId: (comment) => comment.id,
    reference: researchComment,
    values: researchComments
  })?.text,
  "Ready-to-Eat comment"
);
assert.throws(
  () =>
    findDocumentScopedValue({
      documentId: "doc-ready-to-eat",
      getId: (comment) => comment.id,
      reference: actionComment,
      values: researchComments
    }),
  /not doc-ready-to-eat/
);

const actionPatch = createPatchRef("doc-action-plan", "pm-patch-0001");
const researchPatch = createPatchRef("doc-ready-to-eat", "pm-patch-0001");
const actionVersion = createVersionRef("doc-action-plan", "snapshot-0001");
const researchVersion = createVersionRef(
  "doc-ready-to-eat",
  "snapshot-0001"
);
assert.notEqual(
  createDocumentScopedKey(actionPatch),
  createDocumentScopedKey(researchPatch)
);
assert.notEqual(
  createDocumentScopedKey(actionVersion),
  createDocumentScopedKey(researchVersion)
);

const actionReply = createReplyRef(
  "doc-action-plan",
  "pm-comment-0001",
  "pm-thread-0001"
);
const actionOtherThreadReply = createReplyRef(
  "doc-action-plan",
  "pm-comment-0002",
  "pm-thread-0001"
);
const researchReply = createReplyRef(
  "doc-ready-to-eat",
  "pm-comment-0001",
  "pm-thread-0001"
);
assert.notEqual(
  createDocumentScopedKey(actionReply),
  createDocumentScopedKey(actionOtherThreadReply)
);
assert.notEqual(
  createDocumentScopedKey(actionReply),
  createDocumentScopedKey(researchReply)
);

const actionHistory = createAnchorHistoryRef(
  "doc-action-plan",
  "pm-comment-0001",
  "history-0001"
);
const researchHistory = createAnchorHistoryRef(
  "doc-ready-to-eat",
  "pm-comment-0001",
  "history-0001"
);
assert.notEqual(
  createDocumentScopedKey(actionHistory),
  createDocumentScopedKey(researchHistory)
);

assert.doesNotThrow(() =>
  assertUniqueDocumentLocalIds({
    documentId: "doc-action-plan",
    ids: ["pm-comment-0001", "pm-comment-0002"],
    kind: "comment"
  })
);
assert.throws(
  () =>
    assertUniqueDocumentLocalIds({
      documentId: "doc-action-plan",
      ids: ["pm-comment-0001", "pm-comment-0001"],
      kind: "comment"
    }),
  /Duplicate comment ID pm-comment-0001 inside document doc-action-plan/
);

const sharedIdentifiers = {
  comment: ["pm-comment-0001"],
  reply: ["pm-comment-0001::pm-thread-0001"],
  patch: ["pm-patch-0001"],
  version: ["snapshot-0001"],
  anchor_history: ["pm-comment-0001::history-0001"],
  patch_group: ["patch-group-0001"],
  source_import: ["import-0001"]
};
const sources = [
  {
    identifiers: sharedIdentifiers,
    summary: { sourceLabel: "Action Plan" }
  },
  {
    identifiers: sharedIdentifiers,
    summary: { sourceLabel: "Ready-to-Eat" }
  }
];
const compatibility = analyzeLegacyProjectIdentityCompatibility(sources);
assert.equal(findLegacyProjectIdentityCollisions(sources).length, 0);
assert.equal(compatibility.unsafeCollisions.length, 0);
assert.equal(compatibility.allowedDocumentLocalDuplicates.length, 7);
assert.ok(
  compatibility.allowedDocumentLocalDuplicates.every(
    (duplicate) =>
      duplicate.classification === "allowed_document_local_duplicate"
  )
);

assert.ok(documentScopedIdentifierKinds.includes("comment"));
assert.ok(documentScopedIdentifierKinds.includes("patch"));
assert.ok(documentScopedIdentifierKinds.includes("version"));
assert.ok(projectScopedIdentifierKinds.includes("project"));
assert.ok(projectScopedIdentifierKinds.includes("document"));
assert.ok(projectScopedIdentifierKinds.includes("assembly_transaction"));

process.stdout.write(
  `${JSON.stringify({
    identifierScopeInventory: true,
    compositeCommentLookup: true,
    duplicateCommentsAcrossDocuments: true,
    duplicatePatchesAcrossDocuments: true,
    duplicateRepliesAcrossDocuments: true,
    duplicateVersionsAcrossDocuments: true,
    anchorHistoryIsolation: true,
    sameDocumentDuplicateRejected: true,
    assemblyDuplicatesClassifiedSafe: true,
    projectScopedIdentifiersRemainGlobal: true
  }, null, 2)}\n`
);

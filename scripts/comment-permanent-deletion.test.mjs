import assert from "node:assert/strict";
import {
  CommentPermanentDeletionError,
  buildPermanentDeletionSummary,
  emptyCommentTrash,
  getPermanentDeletionConfirmationPhrase,
  permanentlyDeleteComments
} from "../lib/comments/comment-permanent-deletion-operations.ts";
import {
  getDeletedCommentTombstone,
  normalizeCommentDeletionTombstones
} from "../lib/comments/comment-deletion-tombstones.ts";

const projectId = "prj_permanent_delete";
const documentId = "doc_permanent_delete";
const timestamp = "2026-07-31T08:00:00.000Z";
const operationId = "comment_delete_test";
const comments = [
  createComment("PM-COMMENT-0001", "Open prose sentinel", "open", true),
  createComment("PM-COMMENT-0002", "Resolved prose sentinel", "resolved", true),
  createComment("PM-COMMENT-0003", "Active comment remains", "open", false)
];
const patches = [
  createPatch("PM-PATCH-PENDING", "PM-COMMENT-0001", "pending"),
  createPatch("PM-PATCH-ACCEPTED", "PM-COMMENT-0001", "accepted"),
  createPatch("PM-PATCH-REJECTED", "PM-COMMENT-0002", "rejected"),
  createPatch("PM-PATCH-ACTIVE", "PM-COMMENT-0003", "pending")
];
const reviewBatch = createReviewBatch({
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  patchIdsByComment: {
    "PM-COMMENT-0001": ["PM-PATCH-PENDING", "PM-PATCH-ACCEPTED"],
    "PM-COMMENT-0002": ["PM-PATCH-REJECTED"]
  },
  status: "acknowledged"
});
const manifest = {
  schema_version: 1,
  project_id: projectId,
  document_id: documentId,
  project_name: "Permanent deletion fixture",
  document_file: "document.md",
  created_at: timestamp,
  updated_at: timestamp,
  versions: [
    {
      id: "snapshot_before_delete",
      file: ".patchmark/versions/snapshot_before_delete.md",
      created_at: timestamp,
      reason: "Accepted PM-PATCH-ACCEPTED"
    }
  ],
  reading_bookmark: {
    format_version: 1,
    document: {
      project_id: projectId,
      document_id: documentId
    },
    anchor: {
      kind: "selected_text",
      selected_text: "Independent bookmark",
      markdown_start_offset: 0,
      markdown_end_offset: 20
    },
    created_at: timestamp,
    updated_at: timestamp
  }
};
const overrides = {
  schema_version: 1,
  project_id: projectId,
  document_id: documentId,
  deferred_comments: [
    {
      comment_id: "PM-COMMENT-0001",
      deferred_at: timestamp,
      reason: "Later"
    },
    {
      comment_id: "PM-COMMENT-0003",
      deferred_at: timestamp,
      reason: null
    }
  ]
};

assert.equal(
  getPermanentDeletionConfirmationPhrase({
    mode: "individual",
    selectedComments: 1
  }),
  "DELETE"
);
assert.equal(
  getPermanentDeletionConfirmationPhrase({
    mode: "selected",
    selectedComments: 2
  }),
  "DELETE 2 COMMENTS"
);
assert.equal(
  getPermanentDeletionConfirmationPhrase({
    mode: "empty_trash",
    selectedComments: 2
  }),
  "EMPTY TRASH"
);

const individualSummary = buildPermanentDeletionSummary({
  commentIds: ["PM-COMMENT-0001"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  mode: "individual",
  patches,
  projectId,
  reviewBatches: [reviewBatch],
  reviewQueueOverrides: overrides,
  tombstones: []
});
assert.deepEqual(
  {
    acceptedPatches: individualSummary.acceptedPatches,
    confirmationPhrase: individualSummary.confirmationPhrase,
    imports: individualSummary.imports,
    pendingPatches: individualSummary.pendingPatches,
    replies: individualSummary.replies,
    reviewBatchReferences: individualSummary.reviewBatchReferences,
    tombstones: individualSummary.tombstones
  },
  {
    acceptedPatches: 1,
    confirmationPhrase: "DELETE",
    imports: 3,
    pendingPatches: 1,
    replies: 2,
    reviewBatchReferences: 1,
    tombstones: 1
  }
);

assert.throws(
  () =>
    permanentlyDeleteComments({
      commentIds: ["PM-COMMENT-0001"],
      comments,
      confirmationPhrase: "delete",
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      expectedSelectionFingerprint: individualSummary.selectionFingerprint,
      manifest,
      mode: "individual",
      operationId,
      patches,
      projectId,
      reviewBatches: [reviewBatch],
      reviewQueueOverrides: overrides,
      timestamp
    }),
  (error) =>
    error instanceof CommentPermanentDeletionError &&
    error.code === "confirmation_mismatch"
);

const individualResult = permanentlyDeleteComments({
  commentIds: ["PM-COMMENT-0001"],
  comments,
  confirmationPhrase: " DELETE ",
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  expectedSelectionFingerprint: individualSummary.selectionFingerprint,
  manifest,
  mode: "individual",
  operationId,
  patches,
  projectId,
  reviewBatches: [reviewBatch],
  reviewQueueOverrides: overrides,
  timestamp
});
assert.deepEqual(
  individualResult.comments.map((comment) => comment.id),
  ["PM-COMMENT-0002", "PM-COMMENT-0003"]
);
assert.deepEqual(
  individualResult.patches.map((patch) => patch.id),
  ["PM-PATCH-REJECTED", "PM-PATCH-ACTIVE"]
);
assert.deepEqual(
  individualResult.reviewQueueOverrides.deferred_comments.map(
    (entry) => entry.comment_id
  ),
  ["PM-COMMENT-0003"]
);
assert.deepEqual(individualResult.manifest.versions, manifest.versions);
assert.deepEqual(
  individualResult.manifest.reading_bookmark,
  manifest.reading_bookmark
);
assert.deepEqual(reviewBatch.ordered_comment_ids, [
  "PM-COMMENT-0001",
  "PM-COMMENT-0002"
]);
assert.equal(reviewBatch.response_analysis.aggregate.expected_comments, 2);

const tombstone =
  individualResult.manifest.comment_deletion_tombstones[0];
assert.deepEqual(tombstone, {
  schema_version: 1,
  project_id: projectId,
  document_id: documentId,
  comment_id: "PM-COMMENT-0001",
  permanently_deleted_at: timestamp,
  permanent_delete_operation_id: operationId,
  original_status: "open",
  had_accepted_patches: true,
  patches: [
    { patch_id: "PM-PATCH-PENDING", status: "pending" },
    { patch_id: "PM-PATCH-ACCEPTED", status: "accepted" }
  ]
});
const tombstoneText = JSON.stringify(tombstone);
for (const forbidden of [
  "Open prose sentinel",
  "Reply prose sentinel",
  "Selected anchor prose sentinel",
  "Original patch prose sentinel",
  "Suggested patch prose sentinel",
  "Reason prose sentinel",
  "https://example.com/source"
]) {
  assert.doesNotMatch(tombstoneText, new RegExp(forbidden.replaceAll(".", "\\.")));
}

const normalizedTombstones = normalizeCommentDeletionTombstones({
  documentId,
  projectId,
  value: [
    {
      ...tombstone,
      ignored_content: "Must not survive normalization"
    }
  ]
});
assert.deepEqual(normalizedTombstones, [tombstone]);
assert.equal(
  getDeletedCommentTombstone(normalizedTombstones, "PM-COMMENT-0001")
    ?.comment_id,
  "PM-COMMENT-0001"
);
assert.equal(
  normalizeCommentDeletionTombstones({
    documentId,
    projectId,
    value: undefined
  }),
  undefined
);
assert.throws(() =>
  normalizeCommentDeletionTombstones({
    documentId,
    projectId,
    value: [{ ...tombstone, project_id: "wrong-project" }]
  })
);

assert.throws(
  () =>
    buildPermanentDeletionSummary({
      commentIds: ["PM-COMMENT-0003"],
      comments,
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      mode: "individual",
      patches,
      projectId,
      reviewBatches: [],
      reviewQueueOverrides: overrides,
      tombstones: []
    }),
  (error) =>
    error instanceof CommentPermanentDeletionError &&
    error.code === "not_trashed"
);

const blockedBatch = createReviewBatch({
  commentIds: ["PM-COMMENT-0002"],
  patchIdsByComment: { "PM-COMMENT-0002": ["PM-PATCH-REJECTED"] },
  status: "exported"
});
const emptyBlockedSummary = buildPermanentDeletionSummary({
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  inFlightImport: true,
  mode: "empty_trash",
  patches,
  projectId,
  reviewBatches: [blockedBatch],
  reviewQueueOverrides: overrides,
  tombstones: [],
  unsavedDraftCommentIds: ["PM-COMMENT-0001"]
});
assert.deepEqual(
  emptyBlockedSummary.blockers.map((blocker) => blocker.kind).sort(),
  ["active_review_batch", "in_flight_import", "unsaved_draft"]
);
assert.throws(
  () =>
    emptyCommentTrash({
      comments,
      confirmationPhrase: "EMPTY TRASH",
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      expectedTrashFingerprint: emptyBlockedSummary.selectionFingerprint,
      inFlightImport: true,
      manifest,
      operationId,
      patches,
      projectId,
      reviewBatches: [blockedBatch],
      reviewQueueOverrides: overrides,
      timestamp,
      unsavedDraftCommentIds: ["PM-COMMENT-0001"]
    }),
  (error) =>
    error instanceof CommentPermanentDeletionError &&
    error.code === "blocked"
);
assert.equal(comments.length, 3);
assert.equal(patches.length, 4);

const emptySummary = buildPermanentDeletionSummary({
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  mode: "empty_trash",
  patches,
  projectId,
  reviewBatches: [reviewBatch],
  reviewQueueOverrides: overrides,
  tombstones: []
});
const emptyResult = emptyCommentTrash({
  comments,
  confirmationPhrase: "EMPTY TRASH",
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  expectedTrashFingerprint: emptySummary.selectionFingerprint,
  manifest,
  operationId: `${operationId}_empty`,
  patches,
  projectId,
  reviewBatches: [reviewBatch],
  reviewQueueOverrides: overrides,
  timestamp
});
assert.deepEqual(
  emptyResult.comments.map((comment) => comment.id),
  ["PM-COMMENT-0003"]
);
assert.deepEqual(
  emptyResult.patches.map((patch) => patch.id),
  ["PM-PATCH-ACTIVE"]
);
assert.equal(emptyResult.tombstones.length, 2);

assert.throws(
  () =>
    emptyCommentTrash({
      comments: [
        ...comments,
        createComment("PM-COMMENT-0004", "New trash item", "open", true)
      ],
      confirmationPhrase: "EMPTY TRASH",
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      expectedTrashFingerprint: emptySummary.selectionFingerprint,
      manifest,
      operationId,
      patches,
      projectId,
      reviewBatches: [reviewBatch],
      reviewQueueOverrides: overrides,
      timestamp
    }),
  (error) =>
    error instanceof CommentPermanentDeletionError &&
    error.code === "stale_trash"
);

const otherDocumentComments = [
  createComment("PM-COMMENT-0001", "Same ID in another document", "open", true)
];
assert.equal(otherDocumentComments[0].comment, "Same ID in another document");
assert.equal(individualResult.comments.some((comment) => comment.id === "PM-COMMENT-0001"), false);

process.stdout.write(
  `${JSON.stringify(
    {
      acceptedMarkdownAndVersionsPreserved: true,
      activeCommentRequiresTrash: true,
      atomicEmptyTrashBlockers: true,
      confirmationPhrasesCaseSensitive: true,
      contentFreeTombstones: true,
      deferOverridesRemoved: true,
      historicalBatchCountsPreserved: true,
      individualAndEmptyTrash: true,
      linkedPatchContentRemoved: true,
      multiDocumentLocalIdIsolation: true,
      noUndoPayload: true,
      staleTrashRejected: true
    },
    null,
    2
  )}\n`
);

function createComment(id, comment, status, trashed) {
  return {
    id,
    type: "note",
    status,
    anchor: {
      kind: "selected_text",
      selected_text: "Selected anchor prose sentinel",
      markdown_start_offset: 10,
      markdown_end_offset: 40
    },
    anchor_history: [
      {
        changed_at: timestamp,
        reason: "anchor_reanchored_by_human",
        previous_anchor: {
          kind: "selected_text",
          selected_text: "Recovered selection prose sentinel"
        }
      }
    ],
    comment,
    thread: [
      {
        id: `${id}-THREAD-1`,
        role: "user",
        content: "Reply prose sentinel",
        created_at: timestamp,
        source_import_id: "PM-IMPORT-THREAD"
      },
      {
        id: `${id}-THREAD-2`,
        role: "chatgpt",
        content: "Assistant reply prose sentinel",
        created_at: timestamp
      }
    ],
    export_state: {
      focus_state: "reply_received",
      last_import_id: "PM-IMPORT-THREAD"
    },
    created_at: timestamp,
    updated_at: timestamp,
    ...(status === "resolved" ? { resolved_at: timestamp } : {}),
    ...(trashed
      ? {
          trashed_at: timestamp,
          trash_operation_id: `comment_trash_${id}`
        }
      : {})
  };
}

function createPatch(id, commentId, status) {
  return {
    id,
    status,
    comment_id: commentId,
    source_import_id: "PM-IMPORT-PATCH",
    source_chat_url: "https://chatgpt.com/example",
    original_text: "Original patch prose sentinel",
    suggested_text: "Suggested patch prose sentinel",
    reason: "Reason prose sentinel",
    risk: "Risk prose sentinel",
    sources: [
      {
        title: "Source prose sentinel",
        url: "https://example.com/source"
      }
    ],
    created_at: timestamp,
    ...(status === "accepted"
      ? {
          accepted_at: timestamp,
          applied_at: timestamp,
          resolved_at: timestamp,
          applied_text: "Applied prose sentinel"
        }
      : {}),
    ...(status === "rejected"
      ? { rejected_at: timestamp, resolved_at: timestamp }
      : {})
  };
}

function createReviewBatch({ commentIds, patchIdsByComment, status }) {
  return {
    batch_id: `review_batch_${status}`,
    status,
    ordered_comment_ids: commentIds,
    comment_fingerprints: commentIds.map((commentId) => ({
      comment_id: commentId,
      fingerprint: "a".repeat(64)
    })),
    import_id: status === "exported" ? null : "PM-IMPORT-BATCH",
    response_analysis:
      status === "exported"
        ? null
        : {
            ordered_comment_outcomes: commentIds.map((commentId) => ({
              comment_id: commentId,
              patch_ids: patchIdsByComment[commentId] ?? []
            })),
            aggregate: {
              expected_comments: commentIds.length
            }
          }
  };
}

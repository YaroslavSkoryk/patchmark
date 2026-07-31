import assert from "node:assert/strict";
import {
  buildCommentTrashSummary,
  createCommentTrashSelectionKey,
  getActiveComments,
  getTrashedComments,
  getVisibleActiveComments,
  isCommentTrashed,
  moveCommentsToTrash,
  restoreCommentsFromTrash
} from "../lib/comments/comment-trash-operations.ts";
import { normalizeCommentTrashMetadata } from "../lib/comments/comment-trash-schema.ts";
import { resolveCanonicalCommentTarget } from "../lib/comments/canonical-target-resolution.ts";

const projectId = "prj_comment_trash";
const documentId = "doc_strategy";
const now = "2026-07-31T04:00:00.000Z";

function createComment({
  anchor = { kind: "document" },
  id,
  status = "open",
  thread = []
}) {
  return {
    id,
    type: "note",
    status,
    anchor,
    comment: `Comment ${id}`,
    thread,
    export_state: {
      focus_state: "idle"
    },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    ...(status === "resolved"
      ? { resolved_at: "2026-07-03T00:00:00.000Z" }
      : {})
  };
}

const comments = [
  createComment({
    id: "PM-COMMENT-0001",
    anchor: {
      kind: "selected_text",
      selected_text: "evidence",
      markdown_start_offset: 10,
      markdown_end_offset: 18
    },
    thread: [
      {
        id: "PM-REPLY-0001",
        role: "user",
        content: "Please verify.",
        created_at: "2026-07-02T00:00:00.000Z"
      },
      {
        id: "PM-REPLY-0002",
        role: "chatgpt",
        content: "Verified.",
        created_at: "2026-07-02T01:00:00.000Z"
      }
    ]
  }),
  createComment({
    id: "PM-COMMENT-0002",
    status: "resolved"
  }),
  createComment({
    id: "PM-COMMENT-0003",
    anchor: {
      kind: "section",
      heading: "Risks"
    }
  })
];

const patches = [
  {
    id: "PM-PATCH-0001",
    status: "pending",
    comment_id: "PM-COMMENT-0001",
    original_text: "old",
    suggested_text: "new",
    reason: "Improve",
    created_at: now
  },
  {
    id: "PM-PATCH-0002",
    status: "accepted",
    comment_id: "PM-COMMENT-0001",
    original_text: "before",
    suggested_text: "after",
    reason: "Accepted",
    created_at: now,
    accepted_at: now,
    applied_at: now
  },
  {
    id: "PM-PATCH-0003",
    status: "rejected",
    comment_id: "PM-COMMENT-0002",
    original_text: "x",
    suggested_text: "y",
    reason: "Rejected",
    created_at: now,
    rejected_at: now
  }
];

function createBatch(status) {
  return {
    schema_version: 1,
    batch_id: `review_batch_${status}`,
    project_id: projectId,
    document_id: documentId,
    source: "guided_review",
    batch_type: "section",
    ordered_comment_ids: ["PM-COMMENT-0003"],
    section: null,
    algorithm_version: 1,
    prompt_builder_version: 1,
    document_generation: 1,
    batch_record_generation: 2,
    document_content_sha256: "a".repeat(64),
    comment_fingerprints: [],
    estimated_prompt_tokens: 10,
    over_limit_warning: false,
    prompt_sha256: "b".repeat(64),
    context_pack: {
      relative_path: ".patchmark/context-packs/review.md",
      content_sha256: "c".repeat(64),
      bytes: 10
    },
    document_title_snapshot: "Strategy",
    status,
    created_at: now,
    exported_at: now,
    response_received_at: status === "exported" ? null : now,
    cancelled_at: status === "cancelled" ? now : null,
    cancel_reason: status === "cancelled" ? "user_cancelled" : null,
    import_id: status === "exported" || status === "cancelled" ? null : "import_1"
  };
}

assert.deepEqual(normalizeCommentTrashMetadata({}), {});
assert.deepEqual(
  normalizeCommentTrashMetadata({
    trashed_at: now,
    trash_operation_id: "comment_trash_1"
  }),
  {
    trashed_at: now,
    trash_operation_id: "comment_trash_1"
  }
);
assert.throws(
  () => normalizeCommentTrashMetadata({ trashed_at: now }),
  /inconsistent comment Trash metadata/
);

const firstSelectionKey = createCommentTrashSelectionKey({
  projectId,
  documentId,
  commentId: "PM-COMMENT-0001"
});
const duplicateLocalIdKey = createCommentTrashSelectionKey({
  projectId,
  documentId: "doc_appendix",
  commentId: "PM-COMMENT-0001"
});
assert.notEqual(firstSelectionKey, duplicateLocalIdKey);

const commentsBeforeSummary = JSON.stringify(comments);
const patchesBeforeSummary = JSON.stringify(patches);
const summary = buildCommentTrashSummary({
  anchorStatuses: {
    "PM-COMMENT-0001": "not_found",
    "PM-COMMENT-0002": "document"
  },
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  patches,
  projectId,
  reviewBatches: [createBatch("acknowledged")]
});
assert.equal(JSON.stringify(comments), commentsBeforeSummary);
assert.equal(JSON.stringify(patches), patchesBeforeSummary);
assert.deepEqual(
  {
    acceptedPatches: summary.acceptedPatches,
    activeOrUnresolvedAnchors: summary.activeOrUnresolvedAnchors,
    blockedComments: summary.blockedComments,
    documentComments: summary.documentComments,
    pendingPatches: summary.pendingPatches,
    rejectedPatches: summary.rejectedPatches,
    replies: summary.replies,
    selectedComments: summary.selectedComments,
    unresolvedAnchors: summary.unresolvedAnchors
  },
  {
    acceptedPatches: 1,
    activeOrUnresolvedAnchors: 1,
    blockedComments: 0,
    documentComments: 1,
    pendingPatches: 1,
    rejectedPatches: 1,
    replies: 2,
    selectedComments: 2,
    unresolvedAnchors: 1
  }
);

const moved = moveCommentsToTrash({
  anchorStatuses: {
    "PM-COMMENT-0001": "not_found",
    "PM-COMMENT-0002": "document"
  },
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  expectedSelectionFingerprint: summary.selectionFingerprint,
  operationId: "comment_trash_1",
  patches,
  projectId,
  reviewBatches: [createBatch("acknowledged")],
  timestamp: now
});
assert.equal(getActiveComments(moved.comments).length, 1);
assert.equal(getTrashedComments(moved.comments).length, 2);
assert.equal(isCommentTrashed(moved.comments[0]), true);
assert.equal(moved.comments[0].status, "open");
assert.equal(moved.comments[1].status, "resolved");
assert.equal(moved.comments[0].thread.length, 2);
assert.deepEqual(patches, patches);

const restored = restoreCommentsFromTrash({
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments: moved.comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  projectId,
  timestamp: "2026-07-31T05:00:00.000Z"
});
assert.equal(getActiveComments(restored).length, 3);
assert.equal(restored[0].id, comments[0].id);
assert.equal(restored[0].thread.length, comments[0].thread.length);
assert.equal(restored[1].status, "resolved");
assert.equal(restored[1].resolved_at, comments[1].resolved_at);
assert.equal(restored[0].updated_at, comments[0].updated_at);
assert.equal(
  resolveCanonicalCommentTarget(restored[0], {
    headings: [],
    markdown: "# Current document\n\nThe original selection is gone.",
    patches
  }).state,
  "not_found"
);
assert.equal(
  resolveCanonicalCommentTarget(restored[1], {
    headings: [],
    markdown: "# Current document",
    patches
  }).state,
  "resolved"
);

const activeBatchSummary = buildCommentTrashSummary({
  commentIds: ["PM-COMMENT-0003"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  patches,
  projectId,
  reviewBatches: [createBatch("exported")]
});
assert.equal(activeBatchSummary.blockedComments, 1);
assert.equal(activeBatchSummary.blockers[0].kind, "active_review_batch");
assert.throws(
  () =>
    moveCommentsToTrash({
      commentIds: ["PM-COMMENT-0003"],
      comments,
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      expectedSelectionFingerprint: activeBatchSummary.selectionFingerprint,
      operationId: "comment_trash_blocked",
      patches,
      projectId,
      reviewBatches: [createBatch("exported")],
      timestamp: now
    }),
  /must be unblocked/
);
assert.equal(getTrashedComments(comments).length, 0);
assert.deepEqual(
  getVisibleActiveComments({
    comments: moved.comments,
    status: "open"
  }).map((comment) => comment.id),
  ["PM-COMMENT-0003"]
);
assert.deepEqual(
  getVisibleActiveComments({
    comments,
    searchQuery: "0002",
    status: "resolved"
  }).map((comment) => comment.id),
  ["PM-COMMENT-0002"]
);

const transientBlockerSummary = buildCommentTrashSummary({
  activeReanchorCommentId: "PM-COMMENT-0001",
  commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
  comments,
  currentDocumentId: documentId,
  currentProjectId: projectId,
  documentId,
  patches,
  projectId,
  reviewBatches: [],
  unsavedDraftCommentIds: ["PM-COMMENT-0002"]
});
assert.deepEqual(
  transientBlockerSummary.blockers.map((blocker) => blocker.kind),
  ["active_reanchor", "unsaved_draft"]
);

assert.throws(
  () =>
    buildCommentTrashSummary({
      commentIds: ["PM-COMMENT-0001", "PM-COMMENT-0001"],
      comments,
      currentDocumentId: documentId,
      currentProjectId: projectId,
      documentId,
      patches,
      projectId,
      reviewBatches: []
    }),
  /duplicate IDs/
);
assert.throws(
  () =>
    restoreCommentsFromTrash({
      commentIds: ["PM-COMMENT-0001"],
      comments: moved.comments,
      currentDocumentId: "doc_appendix",
      currentProjectId: projectId,
      documentId,
      projectId,
      timestamp: now
    }),
  /active project or document changed/
);

console.log(
  JSON.stringify(
    {
      activeBatchBlockedAtomically: true,
      backwardCompatibleMetadata: true,
      connectedHistoryPreserved: true,
      documentScopedSelectionIdentity: true,
      noWriteSummary: true,
      restoredResolvedStatus: true,
      staleAndDocumentAnchorsRestored: true,
      summaryCounts: true,
      selectAllVisibleProjection: true,
      transientBlockers: true,
      trashCount: getTrashedComments(moved.comments).length
    },
    null,
    2
  )
);

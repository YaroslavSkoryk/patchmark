import assert from "node:assert/strict";
import { createReviewBatchExportLifecycleEvidence } from "../lib/review-batches/review-batch-active-evidence.ts";
import {
  createRespondedReviewBatchRecords,
  getPendingReviewResponseBatch
} from "../lib/review-batches/review-batch-progression.ts";
import {
  associateReviewBatchResponse,
  ReviewBatchResponseValidationError,
  validateExactReviewBatchResponseComments
} from "../lib/review-batches/review-batch-response-receipt.ts";
import {
  parseReviewBatchRecords,
  serializeReviewBatchRecords
} from "../lib/review-batches/review-batch-schema.ts";
import {
  analyzeImportedReviewBatchResponse,
  hasExactImportedReviewBatchContributions
} from "../lib/review-batches/review-response-analysis.ts";
import { deriveReviewQueue } from "../lib/review-queue/review-queue-engine.ts";

const projectId = "prj_phase_4";
const documentId = "doc_phase_4";
const importId = "PM-IMPORT-20260724-060000-000";
const importedAt = "2026-07-24T06:00:00.000Z";
const commentIds = [
  "PM-COMMENT-0001",
  "PM-COMMENT-0002",
  "PM-COMMENT-0003",
  "PM-COMMENT-0004"
];
const batch = createBatch(commentIds);
const comments = [
  createComment(commentIds[0], {
    thread: [
      assistantEntry("PM-THREAD-OLD", "old-import"),
      assistantEntry("PM-THREAD-NEW", importId)
    ]
  }),
  createComment(commentIds[1]),
  createComment(commentIds[2], {
    thread: [
      assistantEntry("PM-THREAD-QUESTION", importId, {
        suggested_user_action: "clarify"
      })
    ]
  }),
  createComment(commentIds[3], {
    export_state: {
      focus_state: "awaiting_reply",
      last_export_id: "legacy-export",
      last_exported_at: "2026-07-24T05:00:00.000Z"
    }
  })
];
const patches = [
  createPatch("PM-PATCH-OLD", commentIds[0], "old-import"),
  createPatch("PM-PATCH-NEW-1", commentIds[1], importId),
  createPatch("PM-PATCH-NEW-2", commentIds[1], importId)
];

const partialAnalysis = analyzeImportedReviewBatchResponse({
  analyzedAt: importedAt,
  batch,
  comments,
  importId,
  patches
});
assert.equal(partialAnalysis.coverage_status, "partial");
assert.deepEqual(partialAnalysis.aggregate, {
  expected_comments: 4,
  addressed_comments: 3,
  unanswered_comments: 1,
  replies_added: 1,
  patch_proposals_added: 2,
  clarification_questions: 1,
  explicit_no_change_responses: 0
});
assert.deepEqual(
  partialAnalysis.ordered_comment_outcomes.map((outcome) => ({
    addressed: outcome.addressed,
    clarificationCount: outcome.clarification_count,
    commentId: outcome.comment_id,
    patchCount: outcome.patch_count,
    replyCount: outcome.reply_count
  })),
  [
    {
      addressed: true,
      clarificationCount: 0,
      commentId: commentIds[0],
      patchCount: 0,
      replyCount: 1
    },
    {
      addressed: true,
      clarificationCount: 0,
      commentId: commentIds[1],
      patchCount: 2,
      replyCount: 0
    },
    {
      addressed: true,
      clarificationCount: 1,
      commentId: commentIds[2],
      patchCount: 0,
      replyCount: 0
    },
    {
      addressed: false,
      clarificationCount: 0,
      commentId: commentIds[3],
      patchCount: 0,
      replyCount: 0
    }
  ]
);
assert.equal(
  partialAnalysis.ordered_comment_outcomes[0].reply_ids.includes(
    "PM-THREAD-OLD"
  ),
  false
);
assert.equal(
  partialAnalysis.ordered_comment_outcomes[0].patch_ids.includes(
    "PM-PATCH-OLD"
  ),
  false
);
assert.equal(
  hasExactImportedReviewBatchContributions({
    batch,
    comments,
    importId,
    patches
  }),
  true
);

const zeroAnalysis = analyzeImportedReviewBatchResponse({
  analyzedAt: importedAt,
  batch,
  comments: commentIds.map((commentId) => createComment(commentId)),
  importId,
  patches: []
});
assert.equal(zeroAnalysis.coverage_status, "partial");
assert.equal(zeroAnalysis.aggregate.addressed_comments, 0);
assert.equal(zeroAnalysis.aggregate.unanswered_comments, 4);

const completeAnalysis = analyzeImportedReviewBatchResponse({
  analyzedAt: importedAt,
  batch,
  comments: commentIds.map((commentId, index) =>
    createComment(commentId, {
      thread: [assistantEntry(`PM-THREAD-COMPLETE-${index}`, importId)]
    })
  ),
  importId,
  patches: []
});
assert.equal(completeAnalysis.coverage_status, "complete");
assert.equal(completeAnalysis.aggregate.addressed_comments, 4);

const responded = createRespondedReviewBatchRecords({
  analysis: partialAnalysis,
  batchId: batch.batch_id,
  batches: [batch],
  importId,
  responseReceivedAt: importedAt
});
assert.equal(responded[0].status, "responded_partial");
assert.equal(getPendingReviewResponseBatch(responded)?.batch_id, batch.batch_id);
assert.strictEqual(responded[0].response_analysis, partialAnalysis);

const serialized = serializeReviewBatchRecords({
  identity: { documentId, projectId },
  records: responded
});
const reopened = parseReviewBatchRecords({
  identity: { documentId, projectId },
  text: serialized
});
assert.deepEqual(reopened[0].response_analysis, partialAnalysis);
const acknowledgedReopened = parseReviewBatchRecords({
  identity: { documentId, projectId },
  text: serializeReviewBatchRecords({
    identity: { documentId, projectId },
    records: [
      {
        ...responded[0],
        status: "acknowledged",
        acknowledged_at: "2026-07-24T06:30:00.000Z"
      }
    ]
  })
});
assert.equal(acknowledgedReopened[0].status, "acknowledged");
assert.deepEqual(
  acknowledgedReopened[0].response_analysis,
  partialAnalysis
);
const corruptedAnalysisRecords = JSON.parse(serialized);
corruptedAnalysisRecords[0].response_analysis.aggregate.replies_added = 99;
assert.throws(() =>
  parseReviewBatchRecords({
    identity: { documentId, projectId },
    text: JSON.stringify(corruptedAnalysisRecords)
  })
);

comments[0].thread.push({
  id: "PM-THREAD-HUMAN-LATER",
  role: "user",
  content: "Please continue.",
  created_at: "2026-07-24T07:00:00.000Z"
});
patches[1].status = "accepted";
assert.deepEqual(reopened[0].response_analysis, partialAnalysis);

const queue = deriveReviewQueue({
  activeExportEvidence: createReviewBatchExportLifecycleEvidence(responded),
  buildPromptPreview: ({ selectedCommentIds }) =>
    selectedCommentIds.join(","),
  comments,
  deferredCommentIds: new Set(),
  documentGeneration: 20,
  documentId,
  markdown: "# Phase 4\n",
  patches,
  projectId
});
assert.equal(
  queue.comments.find((comment) => comment.commentId === commentIds[0])?.state,
  "ready_for_chatgpt"
);
assert.equal(
  queue.comments.find((comment) => comment.commentId === commentIds[1])?.state,
  "awaiting_human_review"
);
assert.equal(
  queue.comments.find((comment) => comment.commentId === commentIds[2])?.state,
  "awaiting_human_review"
);
assert.equal(
  queue.comments.find((comment) => comment.commentId === commentIds[3])?.state,
  "ready_for_chatgpt"
);
assert.deepEqual(queue.proposal?.commentIds, [commentIds[0]]);

const deferredQueue = deriveReviewQueue({
  activeExportEvidence: createReviewBatchExportLifecycleEvidence(responded),
  buildPromptPreview: ({ selectedCommentIds }) =>
    selectedCommentIds.join(","),
  comments,
  deferredCommentIds: new Set([commentIds[3]]),
  documentGeneration: 20,
  documentId,
  markdown: "# Phase 4\n",
  patches,
  projectId
});
assert.equal(
  deferredQueue.comments.find(
    (comment) => comment.commentId === commentIds[3]
  )?.state,
  "deferred"
);
const resolvedComments = comments.map((comment) =>
  comment.id === commentIds[3]
    ? { ...comment, status: "resolved" }
    : comment
);
const resolvedQueue = deriveReviewQueue({
  activeExportEvidence: createReviewBatchExportLifecycleEvidence(responded),
  buildPromptPreview: ({ selectedCommentIds }) =>
    selectedCommentIds.join(","),
  comments: resolvedComments,
  deferredCommentIds: new Set(),
  documentGeneration: 20,
  documentId,
  markdown: "# Phase 4\n",
  patches,
  projectId
});
assert.equal(
  resolvedQueue.comments.find(
    (comment) => comment.commentId === commentIds[3]
  )?.state,
  "resolved"
);
const blockedComments = comments.map((comment) =>
  comment.id === commentIds[3]
    ? {
        ...comment,
        anchor: {
          kind: "selected_text",
          selected_text: "Missing response target",
          markdown_start_offset: 400,
          markdown_end_offset: 423,
          context_before: "",
          context_after: "",
          anchor_source: "markdown"
        }
      }
    : comment
);
const blockedQueue = deriveReviewQueue({
  activeExportEvidence: createReviewBatchExportLifecycleEvidence(responded),
  buildPromptPreview: ({ selectedCommentIds }) =>
    selectedCommentIds.join(","),
  comments: blockedComments,
  deferredCommentIds: new Set(),
  documentGeneration: 20,
  documentId,
  markdown: "# Phase 4\n",
  patches,
  projectId
});
assert.equal(
  blockedQueue.comments.find(
    (comment) => comment.commentId === commentIds[3]
  )?.state,
  "blocked"
);

const exactAssociation = associateReviewBatchResponse({
  batches: [batch],
  response: {
    review_batch_id: batch.batch_id,
    project_id: projectId,
    document_id: documentId
  },
  target: { documentId, projectId }
});
assert.equal(exactAssociation.kind, "exact");
assert.throws(
  () =>
    validateExactReviewBatchResponseComments({
      batch,
      response: {
        replies: [{ comment_id: "PM-COMMENT-OUTSIDE" }],
        patch_proposals: [],
        open_questions: []
      }
    }),
  (error) =>
    error instanceof ReviewBatchResponseValidationError &&
    error.code === "unexpected_batch_comment"
);
assert.throws(
  () =>
    associateReviewBatchResponse({
      batches: responded,
      response: {
        review_batch_id: batch.batch_id,
        project_id: projectId,
        document_id: documentId
      },
      target: { documentId, projectId }
    }),
  (error) =>
    error instanceof ReviewBatchResponseValidationError &&
    error.code === "review_batch_already_responded"
);
assert.throws(
  () =>
    associateReviewBatchResponse({
      batches: [batch],
      response: {
        review_batch_id: batch.batch_id,
        project_id: projectId,
        document_id: "doc_other"
      },
      target: { documentId, projectId }
    }),
  (error) =>
    error instanceof ReviewBatchResponseValidationError &&
    error.code === "review_batch_identity_mismatch"
);

const otherDocumentAnalysis = analyzeImportedReviewBatchResponse({
  analyzedAt: importedAt,
  batch: createBatch(commentIds, {
    document_id: "doc_other",
    batch_id: "review_batch_other"
  }),
  comments: commentIds.map((commentId) => createComment(commentId)),
  importId,
  patches: []
});
assert.equal(otherDocumentAnalysis.document_id, "doc_other");
assert.equal(otherDocumentAnalysis.aggregate.addressed_comments, 0);
assert.equal(partialAnalysis.document_id, documentId);

console.log(
  JSON.stringify(
    {
      completeCoverage: completeAnalysis.aggregate.addressed_comments,
      duplicateResponseRejected: true,
      historicalRecordsExcluded: true,
      immutablePersistedAnalysis: true,
      manualOrderPreserved:
        partialAnalysis.ordered_comment_outcomes
          .map((outcome) => outcome.comment_id)
          .join(",") === commentIds.join(","),
      partialCoverage: partialAnalysis.aggregate,
      queueAfterAcknowledgment: {
        answeredPatchOnly: "awaiting_human_review",
        explicitHumanFollowUp: "ready_for_chatgpt",
        unanswered: "ready_for_chatgpt"
      },
      unexpectedBatchCommentRejected: true,
      zeroCoverage: zeroAnalysis.aggregate
    },
    null,
    2
  )
);

function createBatch(orderedCommentIds, overrides = {}) {
  const batchId = overrides.batch_id ?? "review_batch_phase_4";
  const ownedDocumentId = overrides.document_id ?? documentId;
  return {
    schema_version: 1,
    batch_id: batchId,
    project_id: projectId,
    document_id: ownedDocumentId,
    source: "manual",
    batch_type: "manual",
    ordered_comment_ids: [...orderedCommentIds],
    section: null,
    algorithm_version: null,
    prompt_builder_version: 1,
    document_generation: 10,
    batch_record_generation: 11,
    document_content_sha256: "a".repeat(64),
    comment_fingerprints: orderedCommentIds.map((commentId) => ({
      comment_id: commentId,
      fingerprint: "b".repeat(64)
    })),
    estimated_prompt_tokens: 100,
    over_limit_warning: false,
    prompt_sha256: "c".repeat(64),
    context_pack: {
      relative_path: `.patchmark/context-packs/${batchId}.md`,
      content_sha256: "c".repeat(64),
      bytes: 100
    },
    document_title_snapshot: "Phase 4",
    status: "exported",
    created_at: "2026-07-24T05:00:00.000Z",
    exported_at: "2026-07-24T05:00:00.000Z",
    response_received_at: null,
    acknowledged_at: null,
    cancelled_at: null,
    cancel_reason: null,
    import_id: null,
    response_analysis: null
  };
}

function createComment(id, overrides = {}) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: `Review ${id}.`,
    thread: overrides.thread ?? [],
    export_state: overrides.export_state ?? { focus_state: "in_focus" },
    created_at: "2026-07-24T04:00:00.000Z",
    updated_at: "2026-07-24T04:00:00.000Z"
  };
}

function assistantEntry(id, sourceImportId, overrides = {}) {
  return {
    id,
    role: "chatgpt",
    content: `Assistant contribution ${id}.`,
    created_at: importedAt,
    source_import_id: sourceImportId,
    ...overrides
  };
}

function createPatch(id, commentId, sourceImportId) {
  return {
    id,
    comment_id: commentId,
    status: "pending",
    target_kind: "document",
    original_text: "",
    suggested_text: "Updated",
    reason: "Test",
    created_at: importedAt,
    source_import_id: sourceImportId
  };
}

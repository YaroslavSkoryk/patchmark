import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import {
  REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION,
  type PatchmarkReviewBatch,
  type PatchmarkReviewResponseAnalysis,
  type ReviewResponseCommentOutcome
} from "./review-batch-types.ts";

export function analyzeImportedReviewBatchResponse({
  analyzedAt,
  batch,
  comments,
  importId,
  patches
}: {
  analyzedAt: string;
  batch: PatchmarkReviewBatch;
  comments: PatchmarkComment[];
  importId: string;
  patches: PatchmarkPatch[];
}): PatchmarkReviewResponseAnalysis {
  const commentsById = new Map(
    comments.map((comment) => [comment.id, comment])
  );
  const orderedCommentOutcomes = batch.ordered_comment_ids.map(
    (commentId): ReviewResponseCommentOutcome => {
      const comment = commentsById.get(commentId);
      const importedEntries =
        comment?.thread.filter(
          (entry) =>
            entry.role === "chatgpt" &&
            entry.source_import_id === importId
        ) ?? [];
      const clarificationIds = importedEntries
        .filter((entry) => entry.suggested_user_action === "clarify")
        .map((entry) => entry.id);
      const replyIds = importedEntries
        .filter((entry) => entry.suggested_user_action !== "clarify")
        .map((entry) => entry.id);
      const patchIds = patches
        .filter(
          (patch) =>
            patch.comment_id === commentId &&
            patch.source_import_id === importId
        )
        .map((patch) => patch.id);
      const explicitNoChangeIds: string[] = [];
      const addressed =
        replyIds.length +
          patchIds.length +
          clarificationIds.length +
          explicitNoChangeIds.length >
        0;

      return {
        comment_id: commentId,
        addressed,
        reply_ids: replyIds,
        patch_ids: patchIds,
        clarification_ids: clarificationIds,
        explicit_no_change_ids: explicitNoChangeIds,
        reply_count: replyIds.length,
        patch_count: patchIds.length,
        clarification_count: clarificationIds.length,
        explicit_no_change_count: explicitNoChangeIds.length
      };
    }
  );
  const addressedComments = orderedCommentOutcomes.filter(
    (outcome) => outcome.addressed
  ).length;
  const expectedComments = orderedCommentOutcomes.length;
  const coverageStatus =
    addressedComments === expectedComments ? "complete" : "partial";

  return {
    schema_version: REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION,
    review_batch_id: batch.batch_id,
    project_id: batch.project_id,
    document_id: batch.document_id,
    import_id: importId,
    coverage_status: coverageStatus,
    analyzed_at: analyzedAt,
    ordered_comment_outcomes: orderedCommentOutcomes,
    aggregate: {
      expected_comments: expectedComments,
      addressed_comments: addressedComments,
      unanswered_comments: expectedComments - addressedComments,
      replies_added: sumOutcomeCount(orderedCommentOutcomes, "reply_count"),
      patch_proposals_added: sumOutcomeCount(
        orderedCommentOutcomes,
        "patch_count"
      ),
      clarification_questions: sumOutcomeCount(
        orderedCommentOutcomes,
        "clarification_count"
      ),
      explicit_no_change_responses: sumOutcomeCount(
        orderedCommentOutcomes,
        "explicit_no_change_count"
      )
    }
  };
}

export function hasExactImportedReviewBatchContributions({
  batch,
  comments,
  importId,
  patches
}: {
  batch: PatchmarkReviewBatch;
  comments: PatchmarkComment[];
  importId: string;
  patches: PatchmarkPatch[];
}): boolean {
  const expectedCommentIds = new Set(batch.ordered_comment_ids);

  return (
    comments.some(
      (comment) =>
        expectedCommentIds.has(comment.id) &&
        comment.thread.some(
          (entry) =>
            entry.role === "chatgpt" &&
            entry.source_import_id === importId
        )
    ) ||
    patches.some(
      (patch) =>
        Boolean(
          patch.comment_id &&
            expectedCommentIds.has(patch.comment_id) &&
            patch.source_import_id === importId
        )
    )
  );
}

function sumOutcomeCount(
  outcomes: ReviewResponseCommentOutcome[],
  key:
    | "reply_count"
    | "patch_count"
    | "clarification_count"
    | "explicit_no_change_count"
): number {
  return outcomes.reduce((total, outcome) => total + outcome[key], 0);
}

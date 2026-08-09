import type { ReviewQueueActiveExportEvidence } from "../review-queue/review-queue-types.ts";
import type { PatchmarkReviewBatch } from "./review-batch-types.ts";

export function createReviewBatchActiveExportEvidence(
  batch: PatchmarkReviewBatch | null
): ReviewQueueActiveExportEvidence[] {
  if (!batch || batch.status !== "exported") {
    return [];
  }
  return batch.ordered_comment_ids.map((commentId) => ({
    commentId,
    documentId: batch.document_id,
    exportId: batch.batch_id,
    projectId: batch.project_id,
    responseImported: false
  }));
}

export function createReviewBatchExportLifecycleEvidence(
  batches: PatchmarkReviewBatch[]
): ReviewQueueActiveExportEvidence[] {
  const evidenceByCommentId = new Map<
    string,
    ReviewQueueActiveExportEvidence
  >();
  const relevantBatches = [...batches]
    .filter((batch) => batch.status !== "cancelled")
    .sort(
      (left, right) =>
        left.exported_at.localeCompare(right.exported_at) ||
        left.batch_id.localeCompare(right.batch_id)
    );

  relevantBatches.forEach((batch) => {
    const responseImported = batch.status !== "exported";
    batch.ordered_comment_ids.forEach((commentId) => {
      evidenceByCommentId.set(commentId, {
        commentId,
        documentId: batch.document_id,
        exportId: batch.batch_id,
        projectId: batch.project_id,
        responseImported
      });
    });
  });

  return [...evidenceByCommentId.values()];
}

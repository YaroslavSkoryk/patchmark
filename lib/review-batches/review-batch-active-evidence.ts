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

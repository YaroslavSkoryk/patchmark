import {
  commitProjectReviewBatchUpdate,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type {
  PatchmarkReviewBatch,
  PatchmarkReviewResponseAnalysis
} from "./review-batch-types.ts";

export function getPendingReviewResponseBatch(
  batches: PatchmarkReviewBatch[]
): PatchmarkReviewBatch | null {
  return (
    [...batches]
      .reverse()
      .find(
        (batch) =>
          batch.status === "responded" ||
          batch.status === "responded_partial" ||
          batch.status === "response_received"
      ) ?? null
  );
}

export function createRespondedReviewBatchRecords({
  analysis,
  batchId,
  batches,
  importId,
  responseReceivedAt
}: {
  analysis: PatchmarkReviewResponseAnalysis;
  batchId: string;
  batches: PatchmarkReviewBatch[];
  importId: string;
  responseReceivedAt: string;
}): PatchmarkReviewBatch[] {
  const target = batches.find((batch) => batch.batch_id === batchId);
  if (!target || target.status !== "exported") {
    throw new ReviewBatchProgressionError(
      "review_batch_already_responded",
      "The Review Batch is no longer awaiting its first response."
    );
  }
  if (
    analysis.review_batch_id !== target.batch_id ||
    analysis.project_id !== target.project_id ||
    analysis.document_id !== target.document_id ||
    analysis.import_id !== importId
  ) {
    throw new ReviewBatchProgressionError(
      "response_analysis_identity_mismatch",
      "The response analysis does not belong to this Review Batch import."
    );
  }

  return batches.map((batch) =>
    batch.batch_id === batchId
      ? {
          ...batch,
          status:
            analysis.coverage_status === "complete"
              ? ("responded" as const)
              : ("responded_partial" as const),
          response_received_at: responseReceivedAt,
          acknowledged_at: null,
          import_id: importId,
          response_analysis: analysis
        }
      : batch
  );
}

export async function acknowledgeReviewBatchResponse({
  acknowledgedAt,
  batchId,
  project
}: {
  acknowledgedAt: string;
  batchId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkReviewBatch[]> {
  return commitProjectReviewBatchUpdate({
    project,
    reason: `acknowledge_review_batch_response:${batchId}`,
    update: (current) => {
      const target = current.find((batch) => batch.batch_id === batchId);
      if (
        !target ||
        (target.status !== "responded" &&
          target.status !== "responded_partial" &&
          target.status !== "response_received")
      ) {
        throw new ReviewBatchProgressionError(
          "review_batch_not_acknowledgeable",
          "The Review Batch response is no longer awaiting acknowledgment."
        );
      }
      return current.map((batch) =>
        batch.batch_id === batchId
          ? {
              ...batch,
              status: "acknowledged" as const,
              acknowledged_at: acknowledgedAt
            }
          : batch
      );
    }
  });
}

export async function upgradeLegacyReviewBatchResponse({
  analysis,
  batchId,
  project
}: {
  analysis: PatchmarkReviewResponseAnalysis;
  batchId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkReviewBatch[]> {
  return commitProjectReviewBatchUpdate({
    project,
    reason: `analyze_legacy_review_batch_response:${batchId}`,
    update: (current) => {
      const target = current.find((batch) => batch.batch_id === batchId);
      if (!target || target.status !== "response_received") {
        return current;
      }
      if (
        target.batch_id !== analysis.review_batch_id ||
        target.project_id !== analysis.project_id ||
        target.document_id !== analysis.document_id ||
        target.import_id !== analysis.import_id
      ) {
        throw new ReviewBatchProgressionError(
          "response_analysis_identity_mismatch",
          "The response analysis does not belong to this historical Review Batch."
        );
      }
      return current.map((batch) =>
        batch.batch_id === batchId
          ? {
              ...batch,
              status:
                analysis.coverage_status === "complete"
                  ? ("responded" as const)
                  : ("responded_partial" as const),
              response_analysis: analysis
            }
          : batch
      );
    }
  });
}

export class ReviewBatchProgressionError extends Error {
  readonly code:
    | "review_batch_already_responded"
    | "review_batch_not_acknowledgeable"
    | "response_analysis_identity_mismatch";

  constructor(
    code: ReviewBatchProgressionError["code"],
    message: string
  ) {
    super(message);
    this.name = "ReviewBatchProgressionError";
    this.code = code;
  }
}

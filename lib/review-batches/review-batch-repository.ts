import {
  commitProjectReviewBatchUpdate,
  getProjectDocumentIdentity,
  readProjectReviewBatchRecords,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type {
  PatchmarkReviewBatch,
  ReviewBatchCancelReason
} from "./review-batch-types.ts";

export async function listReviewBatches(
  project: PatchmarkProjectHandle
): Promise<PatchmarkReviewBatch[]> {
  return readProjectReviewBatchRecords(project);
}

export function getActiveReviewBatch(
  batches: PatchmarkReviewBatch[]
): PatchmarkReviewBatch | null {
  return batches.find((batch) => batch.status === "exported") ?? null;
}

export async function createReviewBatchRecord({
  batch,
  expectedDocumentGeneration,
  project,
  validateBeforeCommit
}: {
  batch: PatchmarkReviewBatch;
  expectedDocumentGeneration: number;
  project: PatchmarkProjectHandle;
  validateBeforeCommit?: () => void;
}): Promise<PatchmarkReviewBatch[]> {
  return commitProjectReviewBatchUpdate({
    project,
    reason: `create_review_batch:${batch.batch_id}`,
    update: (current) => {
      validateBeforeCommit?.();
      assertBatchOwnership(project, batch);
      if (project.persistence.generation !== expectedDocumentGeneration) {
        throw new Error(
          "The document changed after the Review Batch proposal. Refresh the proposal and try again."
        );
      }
      const active = getActiveReviewBatch(current);
      if (active) {
        throw new Error(
          `Review Batch ${active.batch_id} is already awaiting a response for this document.`
        );
      }
      if (current.some((candidate) => candidate.batch_id === batch.batch_id)) {
        throw new Error(`Review Batch ${batch.batch_id} already exists.`);
      }
      return [...current, batch];
    }
  });
}

export async function cancelReviewBatch({
  batchId,
  cancelledAt,
  project,
  reason = "user_cancelled"
}: {
  batchId: string;
  cancelledAt: string;
  project: PatchmarkProjectHandle;
  reason?: ReviewBatchCancelReason;
}): Promise<PatchmarkReviewBatch[]> {
  return commitProjectReviewBatchUpdate({
    project,
    reason: `cancel_review_batch:${batchId}`,
    update: (current) => {
      const target = current.find((batch) => batch.batch_id === batchId);
      if (!target || target.status !== "exported") {
        throw new Error("The active Review Batch is no longer available to cancel.");
      }
      assertBatchOwnership(project, target);
      return current.map((batch) =>
        batch.batch_id === batchId
          ? {
              ...batch,
              status: "cancelled" as const,
              cancelled_at: cancelledAt,
              cancel_reason: reason
            }
          : batch
      );
    }
  });
}

export async function recordReviewBatchResponseReceipt({
  batchId,
  importId,
  project,
  responseReceivedAt
}: {
  batchId: string;
  importId: string;
  project: PatchmarkProjectHandle;
  responseReceivedAt: string;
}): Promise<PatchmarkReviewBatch[]> {
  return commitProjectReviewBatchUpdate({
    project,
    reason: `record_review_batch_response:${batchId}`,
    update: (current) => {
      const target = current.find((batch) => batch.batch_id === batchId);
      if (!target || target.status !== "exported") {
        throw new Error("The response does not match an active exported Review Batch.");
      }
      assertBatchOwnership(project, target);
      return current.map((batch) =>
        batch.batch_id === batchId
          ? {
              ...batch,
              status: "response_received" as const,
              response_received_at: responseReceivedAt,
              import_id: importId
            }
          : batch
      );
    }
  });
}

function assertBatchOwnership(
  project: PatchmarkProjectHandle,
  batch: PatchmarkReviewBatch
): void {
  const identity = getProjectDocumentIdentity(project);
  if (
    batch.project_id !== identity.projectId ||
    batch.document_id !== identity.documentId
  ) {
    throw new Error("The Review Batch does not belong to this project document.");
  }
}

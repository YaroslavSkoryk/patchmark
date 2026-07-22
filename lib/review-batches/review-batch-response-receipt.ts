import type { ProjectDocumentIdentity } from "../project/document-scoped-identity.ts";
import type {
  PatchmarkReviewBatch,
  ReviewBatchResponseIdentity
} from "./review-batch-types.ts";

export type ReviewBatchResponseAssociation =
  | { kind: "exact"; batchId: string }
  | { kind: "legacy_missing_identity" }
  | { kind: "identity_mismatch"; message: string }
  | { kind: "batch_not_active"; message: string };

export function classifyReviewBatchResponseAssociation({
  activeBatch,
  response,
  target
}: {
  activeBatch: PatchmarkReviewBatch | null;
  response: ReviewBatchResponseIdentity;
  target: ProjectDocumentIdentity;
}): ReviewBatchResponseAssociation {
  const supplied = Boolean(
    response.review_batch_id || response.project_id || response.document_id
  );
  const complete = Boolean(
    response.review_batch_id && response.project_id && response.document_id
  );
  if (!supplied) {
    return { kind: "legacy_missing_identity" };
  }
  if (!complete) {
    return {
      kind: "identity_mismatch",
      message: "The response contains incomplete Review Batch identity."
    };
  }
  if (
    response.project_id !== target.projectId ||
    response.document_id !== target.documentId
  ) {
    return {
      kind: "identity_mismatch",
      message: "The response Review Batch belongs to another project or document."
    };
  }
  if (
    !activeBatch ||
    activeBatch.status !== "exported" ||
    activeBatch.batch_id !== response.review_batch_id
  ) {
    return {
      kind: "batch_not_active",
      message: "The response does not identify this document's active exported batch."
    };
  }
  return { kind: "exact", batchId: activeBatch.batch_id };
}

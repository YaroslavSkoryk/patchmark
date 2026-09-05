import type { ProjectDocumentIdentity } from "../project/document-scoped-identity.ts";
import type { PatchmarkCommentReplyImport } from "../project/project-types.ts";
import type {
  PatchmarkReviewBatch,
  ReviewBatchResponseIdentity
} from "./review-batch-types.ts";

export type ReviewBatchResponseAssociation =
  | { kind: "exact"; batchId: string }
  | { kind: "legacy_missing_identity" }
  | { kind: "identity_mismatch"; message: string }
  | { kind: "batch_not_active"; message: string };

export type ExactReviewBatchResponseAssociation =
  | { kind: "exact"; batch: PatchmarkReviewBatch }
  | { kind: "legacy_missing_identity" };

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

export function associateReviewBatchResponse({
  batches,
  response,
  target
}: {
  batches: PatchmarkReviewBatch[];
  response: ReviewBatchResponseIdentity;
  target: ProjectDocumentIdentity;
}): ExactReviewBatchResponseAssociation {
  const supplied = Boolean(
    response.review_batch_id || response.project_id || response.document_id
  );
  if (!supplied) {
    return { kind: "legacy_missing_identity" };
  }
  if (
    !response.review_batch_id ||
    !response.project_id ||
    !response.document_id
  ) {
    throw new ReviewBatchResponseValidationError(
      "review_batch_identity_mismatch",
      "The response contains incomplete Review Batch identity."
    );
  }
  if (
    response.project_id !== target.projectId ||
    response.document_id !== target.documentId
  ) {
    throw new ReviewBatchResponseValidationError(
      "review_batch_identity_mismatch",
      "The response Review Batch belongs to another project or document."
    );
  }
  const batch = batches.find(
    (candidate) => candidate.batch_id === response.review_batch_id
  );
  if (!batch) {
    throw new ReviewBatchResponseValidationError(
      "review_batch_identity_mismatch",
      "The response identifies a Review Batch that does not belong to this document."
    );
  }
  if (
    batch.status === "responded" ||
    batch.status === "responded_partial" ||
    batch.status === "acknowledged" ||
    batch.status === "response_received"
  ) {
    throw new ReviewBatchResponseValidationError(
      "review_batch_already_responded",
      `Review Batch ${batch.batch_id} already has an associated response.`
    );
  }
  if (batch.status !== "exported") {
    throw new ReviewBatchResponseValidationError(
      "review_batch_not_active",
      `Review Batch ${batch.batch_id} is not awaiting a response.`
    );
  }
  return { kind: "exact", batch };
}

export function validateExactReviewBatchResponseComments({
  batch,
  response
}: {
  batch: PatchmarkReviewBatch;
  response: PatchmarkCommentReplyImport;
}): void {
  const expectedCommentIds = new Set(batch.ordered_comment_ids);
  const unexpectedCommentIds = Array.from(
    new Set(
      [
        ...response.replies.map((reply) => reply.comment_id),
        ...response.patch_proposals.flatMap((patch) =>
          patch.comment_target?.kind === "existing_comment"
            ? [patch.comment_target.comment_id]
            : patch.comment_id
              ? [patch.comment_id]
              : []
        ),
        ...response.open_questions.map((question) => question.comment_id)
      ].filter((commentId) => !expectedCommentIds.has(commentId))
    )
  );
  if (unexpectedCommentIds.length > 0) {
    throw new ReviewBatchResponseValidationError(
      "unexpected_batch_comment",
      `The exact Review Batch response contains item${
        unexpectedCommentIds.length === 1 ? "" : "s"
      } for comment${
        unexpectedCommentIds.length === 1 ? "" : "s"
      } outside the exported batch: ${unexpectedCommentIds.join(", ")}.`
    );
  }
}

export class ReviewBatchResponseValidationError extends Error {
  readonly code:
    | "review_batch_already_responded"
    | "review_batch_identity_mismatch"
    | "review_batch_not_active"
    | "unexpected_batch_comment";

  constructor(
    code: ReviewBatchResponseValidationError["code"],
    message: string
  ) {
    super(message);
    this.name = "ReviewBatchResponseValidationError";
    this.code = code;
  }
}

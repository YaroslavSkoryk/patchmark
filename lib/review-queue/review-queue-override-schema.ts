import type { ProjectDocumentIdentity } from "../project/document-scoped-identity.ts";
import {
  REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION,
  type PatchmarkReviewQueueOverrides
} from "./review-queue-override-types.ts";

export function createEmptyReviewQueueOverrides(
  identity: ProjectDocumentIdentity
): PatchmarkReviewQueueOverrides {
  return {
    schema_version: REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION,
    project_id: identity.projectId,
    document_id: identity.documentId,
    deferred_comments: []
  };
}

export function parseReviewQueueOverrides({
  identity,
  text
}: {
  identity: ProjectDocumentIdentity;
  text: string;
}): PatchmarkReviewQueueOverrides {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      ".patchmark/review-queue-overrides.json contains malformed JSON."
    );
  }
  return normalizeReviewQueueOverrides(value, identity);
}

export function serializeReviewQueueOverrides({
  identity,
  overrides
}: {
  identity: ProjectDocumentIdentity;
  overrides: PatchmarkReviewQueueOverrides;
}): string {
  return `${JSON.stringify(normalizeReviewQueueOverrides(overrides, identity), null, 2)}\n`;
}

function normalizeReviewQueueOverrides(
  value: unknown,
  identity: ProjectDocumentIdentity
): PatchmarkReviewQueueOverrides {
  if (
    !isRecord(value) ||
    value.schema_version !== REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION ||
    value.project_id !== identity.projectId ||
    value.document_id !== identity.documentId ||
    !Array.isArray(value.deferred_comments)
  ) {
    throw invalidOverrides();
  }
  const deferredComments = value.deferred_comments.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.comment_id !== "string" ||
      candidate.comment_id.length === 0 ||
      typeof candidate.deferred_at !== "string" ||
      candidate.deferred_at.length === 0 ||
      (candidate.reason !== null && typeof candidate.reason !== "string")
    ) {
      throw invalidOverrides();
    }
    return {
      comment_id: candidate.comment_id,
      deferred_at: candidate.deferred_at,
      reason: candidate.reason
    };
  });
  if (
    new Set(deferredComments.map((entry) => entry.comment_id)).size !==
    deferredComments.length
  ) {
    throw new Error(
      ".patchmark/review-queue-overrides.json contains duplicate deferred comment IDs."
    );
  }
  return {
    schema_version: REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION,
    project_id: identity.projectId,
    document_id: identity.documentId,
    deferred_comments: deferredComments
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidOverrides(): Error {
  return new Error(".patchmark/review-queue-overrides.json is invalid.");
}

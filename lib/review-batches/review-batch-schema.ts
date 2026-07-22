import type { ProjectDocumentIdentity } from "../project/document-scoped-identity.ts";
import { isReviewBatchSha256 } from "./review-batch-fingerprints.ts";
import {
  REVIEW_BATCH_PROMPT_BUILDER_VERSION,
  REVIEW_BATCH_SCHEMA_VERSION,
  type PatchmarkReviewBatch,
  type ReviewBatchCancelReason,
  type ReviewBatchSource,
  type ReviewBatchStatus,
  type ReviewBatchType
} from "./review-batch-types.ts";

const sources: ReviewBatchSource[] = ["guided_review", "manual"];
const batchTypes: ReviewBatchType[] = [
  "follow_up",
  "document_level",
  "section",
  "manual"
];
const statuses: ReviewBatchStatus[] = [
  "exported",
  "response_received",
  "cancelled"
];
const cancelReasons: ReviewBatchCancelReason[] = [
  "user_cancelled",
  "context_pack_unavailable"
];

export function parseReviewBatchRecords({
  identity,
  text
}: {
  identity: ProjectDocumentIdentity;
  text: string;
}): PatchmarkReviewBatch[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(".patchmark/review-batches.json contains malformed JSON.");
  }
  if (!Array.isArray(value)) {
    throw new Error(".patchmark/review-batches.json must contain an array.");
  }
  const records = value.map((candidate, index) =>
    normalizeReviewBatch(candidate, identity, index)
  );
  assertReviewBatchCollection(records, identity);
  return records;
}

export function serializeReviewBatchRecords({
  identity,
  records
}: {
  identity: ProjectDocumentIdentity;
  records: PatchmarkReviewBatch[];
}): string {
  assertReviewBatchCollection(records, identity);
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function assertReviewBatchCollection(
  records: PatchmarkReviewBatch[],
  identity: ProjectDocumentIdentity
): void {
  const batchIds = new Set<string>();
  let activeCount = 0;
  records.forEach((record, index) => {
    const normalized = normalizeReviewBatch(record, identity, index);
    if (batchIds.has(normalized.batch_id)) {
      throw new Error(`Duplicate Review Batch ID: ${normalized.batch_id}.`);
    }
    batchIds.add(normalized.batch_id);
    if (normalized.status === "exported") {
      activeCount += 1;
    }
  });
  if (activeCount > 1) {
    throw new Error("A document may have at most one active exported Review Batch.");
  }
}

function normalizeReviewBatch(
  value: unknown,
  identity: ProjectDocumentIdentity,
  index: number
): PatchmarkReviewBatch {
  if (!isRecord(value)) {
    throw invalidBatch(index);
  }
  const orderedCommentIds = normalizeNonEmptyStringArray(
    value.ordered_comment_ids,
    "ordered_comment_ids",
    index
  );
  if (new Set(orderedCommentIds).size !== orderedCommentIds.length) {
    throw new Error(`Review Batch ${index + 1} contains duplicate comment IDs.`);
  }
  if (
    value.schema_version !== REVIEW_BATCH_SCHEMA_VERSION ||
    typeof value.batch_id !== "string" ||
    !value.batch_id.startsWith("review_batch_") ||
    value.project_id !== identity.projectId ||
    value.document_id !== identity.documentId ||
    !sources.includes(value.source as ReviewBatchSource) ||
    !batchTypes.includes(value.batch_type as ReviewBatchType) ||
    !statuses.includes(value.status as ReviewBatchStatus) ||
    value.prompt_builder_version !== REVIEW_BATCH_PROMPT_BUILDER_VERSION ||
    !isNonNegativeInteger(value.document_generation) ||
    !isNonNegativeInteger(value.batch_record_generation) ||
    value.batch_record_generation <= value.document_generation ||
    !isReviewBatchSha256(value.document_content_sha256) ||
    !isReviewBatchSha256(value.prompt_sha256) ||
    !isNonNegativeInteger(value.estimated_prompt_tokens) ||
    typeof value.over_limit_warning !== "boolean" ||
    typeof value.document_title_snapshot !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.exported_at !== "string"
  ) {
    throw invalidBatch(index);
  }
  if (
    value.source === "manual" && value.batch_type !== "manual" ||
    value.source === "guided_review" && value.batch_type === "manual"
  ) {
    throw new Error(`Review Batch ${index + 1} has incompatible source and type.`);
  }
  const algorithmVersion =
    value.algorithm_version === null
      ? null
      : isNonNegativeInteger(value.algorithm_version)
        ? value.algorithm_version
        : undefined;
  if (
    algorithmVersion === undefined ||
    (value.source === "guided_review" && algorithmVersion === null) ||
    (value.source === "manual" && algorithmVersion !== null)
  ) {
    throw invalidBatch(index);
  }
  const section = normalizeSection(value.section, value.batch_type, index);
  const commentFingerprints = normalizeCommentFingerprints(
    value.comment_fingerprints,
    orderedCommentIds,
    index
  );
  const contextPack = normalizeContextPack(value.context_pack, index);
  const responseReceivedAt = normalizeNullableString(
    value.response_received_at,
    "response_received_at",
    index
  );
  const cancelledAt = normalizeNullableString(
    value.cancelled_at,
    "cancelled_at",
    index
  );
  const importId = normalizeNullableString(value.import_id, "import_id", index);
  const cancelReason =
    value.cancel_reason === null
      ? null
      : cancelReasons.includes(value.cancel_reason as ReviewBatchCancelReason)
        ? (value.cancel_reason as ReviewBatchCancelReason)
        : undefined;
  if (cancelReason === undefined) {
    throw invalidBatch(index);
  }
  assertStatusFields({
    cancelReason,
    cancelledAt,
    importId,
    index,
    responseReceivedAt,
    status: value.status as ReviewBatchStatus
  });
  return {
    schema_version: REVIEW_BATCH_SCHEMA_VERSION,
    batch_id: value.batch_id,
    project_id: identity.projectId,
    document_id: identity.documentId,
    source: value.source as ReviewBatchSource,
    batch_type: value.batch_type as ReviewBatchType,
    ordered_comment_ids: orderedCommentIds,
    section,
    algorithm_version: algorithmVersion,
    prompt_builder_version: REVIEW_BATCH_PROMPT_BUILDER_VERSION,
    document_generation: value.document_generation,
    batch_record_generation: value.batch_record_generation,
    document_content_sha256: value.document_content_sha256,
    comment_fingerprints: commentFingerprints,
    estimated_prompt_tokens: value.estimated_prompt_tokens,
    over_limit_warning: value.over_limit_warning,
    prompt_sha256: value.prompt_sha256,
    context_pack: contextPack,
    document_title_snapshot: value.document_title_snapshot,
    status: value.status as ReviewBatchStatus,
    created_at: value.created_at,
    exported_at: value.exported_at,
    response_received_at: responseReceivedAt,
    cancelled_at: cancelledAt,
    cancel_reason: cancelReason,
    import_id: importId
  };
}

function normalizeSection(
  value: unknown,
  batchType: unknown,
  index: number
): PatchmarkReviewBatch["section"] {
  if (batchType !== "section") {
    if (value !== null) {
      throw invalidBatch(index);
    }
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.section_key_snapshot !== "string" ||
    (value.heading_snapshot !== null && typeof value.heading_snapshot !== "string")
  ) {
    throw invalidBatch(index);
  }
  return {
    section_key_snapshot: value.section_key_snapshot,
    heading_snapshot: value.heading_snapshot
  };
}

function normalizeCommentFingerprints(
  value: unknown,
  orderedCommentIds: string[],
  index: number
): PatchmarkReviewBatch["comment_fingerprints"] {
  if (!Array.isArray(value) || value.length !== orderedCommentIds.length) {
    throw invalidBatch(index);
  }
  return value.map((candidate, fingerprintIndex) => {
    if (
      !isRecord(candidate) ||
      candidate.comment_id !== orderedCommentIds[fingerprintIndex] ||
      !isReviewBatchSha256(candidate.fingerprint)
    ) {
      throw invalidBatch(index);
    }
    return {
      comment_id: candidate.comment_id,
      fingerprint: candidate.fingerprint
    };
  });
}

function normalizeContextPack(
  value: unknown,
  index: number
): PatchmarkReviewBatch["context_pack"] {
  if (
    !isRecord(value) ||
    typeof value.relative_path !== "string" ||
    !/^\.patchmark\/context-packs\/[^/]+$/.test(value.relative_path) ||
    value.relative_path.includes("..") ||
    !isReviewBatchSha256(value.content_sha256) ||
    !isNonNegativeInteger(value.bytes)
  ) {
    throw invalidBatch(index);
  }
  return {
    relative_path: value.relative_path,
    content_sha256: value.content_sha256,
    bytes: value.bytes
  };
}

function assertStatusFields({
  cancelReason,
  cancelledAt,
  importId,
  index,
  responseReceivedAt,
  status
}: {
  cancelReason: ReviewBatchCancelReason | null;
  cancelledAt: string | null;
  importId: string | null;
  index: number;
  responseReceivedAt: string | null;
  status: ReviewBatchStatus;
}): void {
  const valid =
    status === "exported"
      ? !responseReceivedAt && !cancelledAt && !cancelReason && !importId
      : status === "response_received"
        ? Boolean(responseReceivedAt && importId && !cancelledAt && !cancelReason)
        : Boolean(cancelledAt && cancelReason && !responseReceivedAt && !importId);
  if (!valid) {
    throw invalidBatch(index);
  }
}

function normalizeNonEmptyStringArray(
  value: unknown,
  field: string,
  index: number
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(`Review Batch ${index + 1} has invalid ${field}.`);
  }
  return [...value];
}

function normalizeNullableString(
  value: unknown,
  field: string,
  index: number
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Review Batch ${index + 1} has invalid ${field}.`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidBatch(index: number): Error {
  return new Error(`.patchmark/review-batches.json contains invalid Review Batch ${index + 1}.`);
}

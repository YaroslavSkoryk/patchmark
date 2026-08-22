import {
  canonicalArray,
  canonicalMap,
  canonicalText,
  canonicalUint,
  encodeCanonicalCbor,
  type CanonicalValue
} from "./canonical-cbor.ts";
import { bytesEqual, bytesToHex } from "./bytes.ts";
import { collaborationHashDomains } from "./domains.ts";
import {
  parseDigestId,
  parseEntityId,
  type ProjectId,
  type ReviewBatchId,
  type SemanticPayloadId
} from "./identities.ts";
import { sha256, type Sha256Provider } from "./sha256.ts";
import {
  expectNonEmptyString,
  parseSortedUniqueArray
} from "./validation.ts";

declare const responseEvidenceCommitmentBrand: unique symbol;
declare const responseImportIdBrand: unique symbol;

export const REVIEW_RESPONSE_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type ReviewResponseEvidenceCommitment = string & {
  readonly [responseEvidenceCommitmentBrand]: "review-response-evidence-commitment";
};

export type ReviewResponseImportId = string & {
  readonly [responseImportIdBrand]: "review-response-import-id";
};

export type ReviewResponseEvidenceCore = Readonly<{
  schema_version: typeof REVIEW_RESPONSE_EVIDENCE_SCHEMA_VERSION;
  project_id: ProjectId;
  review_batch_id: ReviewBatchId;
  response_import_id: ReviewResponseImportId;
  contribution_payload_ids: readonly SemanticPayloadId[];
}>;

export type DerivedReviewResponseEvidence = Readonly<{
  core: ReviewResponseEvidenceCore;
  canonical_preimage_bytes: Uint8Array;
  commitment: ReviewResponseEvidenceCommitment;
}>;

export function parseReviewResponseImportId(value: unknown): ReviewResponseImportId {
  const parsed = expectNonEmptyString(value, "review response import ID");
  if (
    parsed.length > 256 ||
    parsed.normalize("NFC") !== parsed ||
    !/^[A-Za-z0-9._:-]+$/.test(parsed)
  ) {
    throw new Error(
      "Review response import ID must be a short NFC local provenance token without paths or URLs."
    );
  }
  return parsed as ReviewResponseImportId;
}

export function parseReviewResponseEvidenceCommitment(
  value: unknown
): ReviewResponseEvidenceCommitment {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Review response evidence commitment must be lowercase SHA-256.");
  }
  return value as ReviewResponseEvidenceCommitment;
}

export function parseReviewContributionPayloadIds(
  value: unknown
): readonly SemanticPayloadId[] {
  return parseSortedUniqueArray(
    value,
    "review contribution payload IDs",
    (candidate) => parseDigestId("semantic-payload", candidate),
    { allowEmpty: true }
  );
}

export function parseReviewResponseEvidenceCore(
  value: ReviewResponseEvidenceCore | Readonly<{
    schema_version: unknown;
    project_id: unknown;
    review_batch_id: unknown;
    response_import_id: unknown;
    contribution_payload_ids: unknown;
  }>
): ReviewResponseEvidenceCore {
  if (value.schema_version !== REVIEW_RESPONSE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported review response evidence schema version.");
  }
  return Object.freeze({
    schema_version: REVIEW_RESPONSE_EVIDENCE_SCHEMA_VERSION,
    project_id: parseEntityId("project", value.project_id),
    review_batch_id: parseEntityId("review-batch", value.review_batch_id),
    response_import_id: parseReviewResponseImportId(value.response_import_id),
    contribution_payload_ids: parseReviewContributionPayloadIds(
      value.contribution_payload_ids
    )
  });
}

/**
 * Factory input may arrive in any contribution order. It produces the one
 * canonical sorted representation and still rejects duplicate identities.
 */
export function createReviewResponseEvidenceCore(
  value: ReviewResponseEvidenceCore | Readonly<{
    schema_version: unknown;
    project_id: unknown;
    review_batch_id: unknown;
    response_import_id: unknown;
    contribution_payload_ids: unknown;
  }>
): ReviewResponseEvidenceCore {
  if (!Array.isArray(value.contribution_payload_ids)) {
    throw new Error("Review contribution payload IDs must be an array.");
  }
  const contributionPayloadIds = value.contribution_payload_ids.map(
    (candidate) => parseDigestId("semantic-payload", candidate)
  ).sort();
  if (new Set(contributionPayloadIds).size !== contributionPayloadIds.length) {
    throw new Error("Review contribution payload IDs must be unique.");
  }
  return parseReviewResponseEvidenceCore({
    schema_version: REVIEW_RESPONSE_EVIDENCE_SCHEMA_VERSION,
    project_id: value.project_id,
    review_batch_id: value.review_batch_id,
    response_import_id: value.response_import_id,
    contribution_payload_ids: contributionPayloadIds
  });
}

/**
 * Exact v1 preimage:
 * CBOR(["patchmark/review-response-evidence/v1", {
 *   schema_version: 1,
 *   project_id,
 *   review_batch_id,
 *   response_import_id,
 *   contribution_payload_ids
 * }])
 */
export function buildReviewResponseEvidencePreimage(
  value: ReviewResponseEvidenceCore
): CanonicalValue {
  const core = parseReviewResponseEvidenceCore(value);
  return canonicalArray([
    canonicalText(collaborationHashDomains.reviewResponseEvidence),
    canonicalMap([
      ["schema_version", canonicalUint(BigInt(core.schema_version))],
      ["project_id", canonicalText(core.project_id)],
      ["review_batch_id", canonicalText(core.review_batch_id)],
      ["response_import_id", canonicalText(core.response_import_id)],
      [
        "contribution_payload_ids",
        canonicalArray(core.contribution_payload_ids.map(canonicalText))
      ]
    ])
  ]);
}

export async function deriveReviewResponseEvidence(
  value: ReviewResponseEvidenceCore,
  provider?: Sha256Provider
): Promise<DerivedReviewResponseEvidence> {
  const core = createReviewResponseEvidenceCore(value);
  const canonicalBytes = encodeCanonicalCbor(
    buildReviewResponseEvidencePreimage(core)
  );
  const digest = provider === undefined
    ? await sha256(canonicalBytes)
    : await sha256(canonicalBytes, provider);
  return Object.freeze({
    core,
    canonical_preimage_bytes: Uint8Array.from(canonicalBytes),
    commitment: bytesToHex(digest) as ReviewResponseEvidenceCommitment
  });
}

export async function verifyReviewResponseEvidenceCommitment(
  value: ReviewResponseEvidenceCore,
  expected: ReviewResponseEvidenceCommitment
): Promise<boolean> {
  const derived = await deriveReviewResponseEvidence(value);
  return bytesEqual(
    new TextEncoder().encode(derived.commitment),
    new TextEncoder().encode(parseReviewResponseEvidenceCommitment(expected))
  );
}

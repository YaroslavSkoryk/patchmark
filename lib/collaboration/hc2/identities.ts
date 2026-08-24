import { canonicalArray, canonicalText, encodeCanonicalCbor, type CanonicalValue } from "../canonical-cbor.ts";
import { decodeSha256Base32, encodeSha256Base32 } from "../base32.ts";
import { sha256, type Sha256Digest, type Sha256Provider } from "../sha256.ts";
import { hc2HashDomains } from "./versions.ts";

declare const hc2DigestIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;
declare const envelopeIdBrand: unique symbol;

export const hc2DigestIdKinds = [
  "portable-batch",
  "chunk-commitment",
  "bundle-root",
  "encrypted-container",
  "object-commit-marker",
  "recovery-envelope",
  "transaction-intent",
  "writer-continuity",
  "invitation-evidence",
  "invitation-handoff",
  "enrollment-request",
  "possession-challenge",
  "possession-proof",
  "membership-transition",
  "recipient-manifest",
  "delivery-set",
  "epoch-delivery",
  "admission-package",
  "epoch-receipt",
  "enrollment-ceremony",
  "enrollment-batch"
] as const;

export type Hc2DigestIdKind = (typeof hc2DigestIdKinds)[number];
export type Hc2DigestId<TKind extends Hc2DigestIdKind> = string & {
  readonly [hc2DigestIdBrand]: TKind;
};

export type PortableBatchId = Hc2DigestId<"portable-batch">;
export type ChunkCommitmentId = Hc2DigestId<"chunk-commitment">;
export type BundleRootId = Hc2DigestId<"bundle-root">;
export type EncryptedContainerId = Hc2DigestId<"encrypted-container">;
export type ObjectCommitMarkerId = Hc2DigestId<"object-commit-marker">;
export type RecoveryEnvelopeId = Hc2DigestId<"recovery-envelope">;
export type TransactionIntentCommitmentId = Hc2DigestId<"transaction-intent">;
export type WriterContinuityId = Hc2DigestId<"writer-continuity">;
export type InvitationEvidenceId = Hc2DigestId<"invitation-evidence">;
export type InvitationHandoffId = Hc2DigestId<"invitation-handoff">;
export type EnrollmentRequestId = Hc2DigestId<"enrollment-request">;
export type PossessionChallengeId = Hc2DigestId<"possession-challenge">;
export type PossessionProofId = Hc2DigestId<"possession-proof">;
export type MembershipTransitionId = Hc2DigestId<"membership-transition">;
export type RecipientManifestId = Hc2DigestId<"recipient-manifest">;
export type DeliverySetId = Hc2DigestId<"delivery-set">;
export type EpochDeliveryId = Hc2DigestId<"epoch-delivery">;
export type AdmissionPackageId = Hc2DigestId<"admission-package">;
export type EpochReceiptId = Hc2DigestId<"epoch-receipt">;
export type EnrollmentCeremonyId = Hc2DigestId<"enrollment-ceremony">;
export type EnrollmentBatchId = Hc2DigestId<"enrollment-batch">;

export type OperationId = string & { readonly [operationIdBrand]: "operation" };
export type EnvelopeId = string & { readonly [envelopeIdBrand]: "envelope" };

const randomIdPattern = /^[a-z2-7]{26}$/;

const domainByKind = Object.freeze({
  "portable-batch": hc2HashDomains.portableBatch,
  "chunk-commitment": hc2HashDomains.chunkCommitment,
  "bundle-root": hc2HashDomains.bundleRoot,
  "encrypted-container": hc2HashDomains.encryptedContainer,
  "object-commit-marker": hc2HashDomains.objectCommitMarker,
  "recovery-envelope": hc2HashDomains.recoveryEnvelope,
  "transaction-intent": hc2HashDomains.transactionIntent,
  "writer-continuity": hc2HashDomains.writerContinuity,
  "invitation-evidence": hc2HashDomains.invitationEvidence,
  "invitation-handoff": hc2HashDomains.invitationHandoff,
  "enrollment-request": hc2HashDomains.enrollmentRequest,
  "possession-challenge": hc2HashDomains.possessionChallenge,
  "possession-proof": hc2HashDomains.possessionProof,
  "membership-transition": hc2HashDomains.membershipTransition,
  "recipient-manifest": hc2HashDomains.recipientManifest,
  "delivery-set": hc2HashDomains.deliverySet,
  "epoch-delivery": hc2HashDomains.epochDelivery,
  "admission-package": hc2HashDomains.admissionPackage,
  "epoch-receipt": hc2HashDomains.epochReceipt,
  "enrollment-ceremony": hc2HashDomains.enrollmentCeremony,
  "enrollment-batch": hc2HashDomains.enrollmentBatch
} as const satisfies Readonly<Record<Hc2DigestIdKind, string>>);

export type DerivedHc2Identity<TKind extends Hc2DigestIdKind> = Readonly<{
  canonical_preimage_bytes: Uint8Array;
  digest: Sha256Digest;
  id: Hc2DigestId<TKind>;
}>;

export function parseHc2DigestId<TKind extends Hc2DigestIdKind>(
  kind: TKind,
  value: unknown
): Hc2DigestId<TKind> {
  if (!hc2DigestIdKinds.includes(kind)) {
    throw new Error("HC-2 digest ID kind is unsupported.");
  }
  if (typeof value !== "string") {
    throw new Error(`${kind} ID must be a string.`);
  }
  const prefix = `pm:${kind}:v1:`;
  if (!value.startsWith(prefix)) {
    throw new Error(`${kind} ID must use the canonical ${prefix} namespace.`);
  }
  try {
    decodeSha256Base32(value.slice(prefix.length));
  } catch {
    throw new Error(`${kind} ID must use lowercase unpadded SHA-256 Base32.`);
  }
  return value as Hc2DigestId<TKind>;
}

export function parseOperationId(value: unknown): OperationId {
  return parseRandomId(value, "operation") as OperationId;
}

export function parseEnvelopeId(value: unknown): EnvelopeId {
  return parseRandomId(value, "envelope") as EnvelopeId;
}

export function hc2DigestSuffix<TKind extends Hc2DigestIdKind>(
  kind: TKind,
  value: Hc2DigestId<TKind>
): string {
  const parsed = parseHc2DigestId(kind, value);
  return parsed.slice(parsed.lastIndexOf(":") + 1);
}

export async function deriveHc2Identity<TKind extends Hc2DigestIdKind>(
  kind: TKind,
  core: CanonicalValue,
  provider?: Sha256Provider
): Promise<DerivedHc2Identity<TKind>> {
  const domain = domainByKind[kind];
  if (domain === undefined) {
    throw new Error("HC-2 digest identity domain is unsupported.");
  }
  const canonicalPreimageBytes = encodeCanonicalCbor(
    canonicalArray([canonicalText(domain), core])
  );
  const digest = await sha256(canonicalPreimageBytes, provider);
  const id = parseHc2DigestId(
    kind,
    `pm:${kind}:v1:${encodeSha256Base32(digest)}`
  );
  return Object.freeze({
    canonical_preimage_bytes: Uint8Array.from(canonicalPreimageBytes),
    digest,
    id
  });
}

function parseRandomId(value: unknown, label: string): string {
  if (typeof value !== "string" || !randomIdPattern.test(value)) {
    throw new Error(`${label} ID must contain exactly 26 lowercase unpadded Base32 characters.`);
  }
  return value;
}

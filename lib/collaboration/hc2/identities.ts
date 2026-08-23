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
  "writer-continuity"
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
  "writer-continuity": hc2HashDomains.writerContinuity
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

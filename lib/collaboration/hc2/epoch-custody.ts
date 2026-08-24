import {
  canonicalArray,
  canonicalBytes,
  canonicalMap,
  canonicalText,
  canonicalUint,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import {
  parseDigestId,
  parseEntityId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type ProjectId
} from "../identities.ts";
import { deriveKeyEpochCommitment } from "../projection-roots.ts";
import { sha256 } from "../sha256.ts";
import { expectBytes, expectExactRecord, expectLiteral, expectUInt64, freezeRecord } from "../validation.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_EPOCH_WRAP_VERSION,
  HC2_LOCAL_EPOCH_WRAP_PROFILE_ID,
  hc2HashDomains
} from "./versions.ts";

export const HC2_EPOCH_SECRET_BYTES = 32 as const;
export const HC2_EPOCH_WRAP_NONCE_BYTES = 12 as const;
export const HC2_EPOCH_WRAP_TAG_BYTES = 16 as const;

export type WrappedLocalEpochRecord = Readonly<{
  schema_version: typeof HC2_EPOCH_WRAP_VERSION;
  record_kind: "wrapped_local_epoch_secret";
  project_id: ProjectId;
  device_id: DeviceId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  public_commitment_bytes: Uint8Array;
  wrapping_key_generation: bigint;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  wrap_profile_id: typeof HC2_LOCAL_EPOCH_WRAP_PROFILE_ID;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}>;

export type EpochCommitment = Readonly<{
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  public_commitment_bytes: Uint8Array;
}>;

export async function deriveEpochCommitment(input: Readonly<{
  project_id: ProjectId;
  key_epoch_id: KeyEpochId;
  epoch_secret: Uint8Array;
}>): Promise<EpochCommitment> {
  const project = parseEntityId("project", input.project_id);
  const epoch = parseEntityId("key-epoch", input.key_epoch_id);
  const secret = requireLength(input.epoch_secret, HC2_EPOCH_SECRET_BYTES, "epoch secret");
  try {
    const publicBytes = await sha256(encodeCanonicalCbor(canonicalArray([
      canonicalText(hc2HashDomains.epochSecretCommitment),
      canonicalText(project),
      canonicalText(epoch),
      canonicalBytes(secret)
    ])));
    const commitment = await deriveKeyEpochCommitment({
      schema_version: 1,
      object_kind: "key_epoch_public_commitment",
      project_id: project,
      key_epoch_id: epoch,
      commitment_algorithm: "sha256-public-commitment-v1",
      public_commitment_bytes: publicBytes
    });
    return freezeRecord({
      key_epoch_id: epoch,
      key_epoch_commitment: commitment.id,
      public_commitment_bytes: Uint8Array.from(publicBytes)
    });
  } finally {
    secret.fill(0);
  }
}

export function buildEpochWrapAad(input: Omit<WrappedLocalEpochRecord, "schema_version" | "record_kind" | "suite_id" | "wrap_profile_id" | "nonce" | "ciphertext">): Uint8Array {
  const project = parseEntityId("project", input.project_id);
  const device = parseEntityId("device", input.device_id);
  const epoch = parseEntityId("key-epoch", input.key_epoch_id);
  const commitment = parseDigestId("key-epoch-commitment", input.key_epoch_commitment);
  const publicBytes = requireLength(input.public_commitment_bytes, 32, "epoch public commitment");
  const generation = expectUInt64(input.wrapping_key_generation, "wrapping-key generation");
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(HC2_LOCAL_EPOCH_WRAP_PROFILE_ID),
    canonicalMap([
      ["schema_version", canonicalUint(BigInt(HC2_EPOCH_WRAP_VERSION))],
      ["project_id", canonicalText(project)],
      ["device_id", canonicalText(device)],
      ["key_epoch_id", canonicalText(epoch)],
      ["key_epoch_commitment", canonicalText(commitment)],
      ["public_commitment_bytes", canonicalBytes(publicBytes)],
      ["wrapping_key_generation", canonicalUint(generation)],
      ["suite_id", canonicalText(HC2_CRYPTO_SUITE_ID)],
      ["wrap_profile_id", canonicalText(HC2_LOCAL_EPOCH_WRAP_PROFILE_ID)]
    ])
  ]));
}

export async function wrapEpochSecret(input: Readonly<{
  key: CryptoKey;
  project_id: ProjectId;
  device_id: DeviceId;
  key_epoch_id: KeyEpochId;
  wrapping_key_generation: bigint;
  epoch_secret: Uint8Array;
  nonce: Uint8Array;
  subtle?: SubtleCrypto;
}>): Promise<WrappedLocalEpochRecord> {
  validateWrappingKey(input.key);
  const subtle = input.subtle ?? requireSubtle();
  const secret = requireLength(input.epoch_secret, HC2_EPOCH_SECRET_BYTES, "epoch secret");
  const nonce = requireLength(input.nonce, HC2_EPOCH_WRAP_NONCE_BYTES, "epoch-wrap nonce");
  try {
    const commitment = await deriveEpochCommitment({
      project_id: input.project_id,
      key_epoch_id: input.key_epoch_id,
      epoch_secret: secret
    });
    const aad = buildEpochWrapAad({
      project_id: input.project_id,
      device_id: input.device_id,
      key_epoch_id: commitment.key_epoch_id,
      key_epoch_commitment: commitment.key_epoch_commitment,
      public_commitment_bytes: commitment.public_commitment_bytes,
      wrapping_key_generation: input.wrapping_key_generation
    });
    const ciphertext = new Uint8Array(await subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad), tagLength: 128 },
      input.key,
      asArrayBuffer(secret)
    ));
    if (ciphertext.length !== HC2_EPOCH_SECRET_BYTES + HC2_EPOCH_WRAP_TAG_BYTES) {
      throw new Error("Epoch wrapping produced an unexpected ciphertext length.");
    }
    return parseWrappedLocalEpochRecord({
      schema_version: HC2_EPOCH_WRAP_VERSION,
      record_kind: "wrapped_local_epoch_secret",
      project_id: input.project_id,
      device_id: input.device_id,
      key_epoch_id: commitment.key_epoch_id,
      key_epoch_commitment: commitment.key_epoch_commitment,
      public_commitment_bytes: commitment.public_commitment_bytes,
      wrapping_key_generation: input.wrapping_key_generation,
      suite_id: HC2_CRYPTO_SUITE_ID,
      wrap_profile_id: HC2_LOCAL_EPOCH_WRAP_PROFILE_ID,
      nonce,
      ciphertext
    });
  } finally {
    secret.fill(0);
  }
}

export async function withUnwrappedEpoch<T>(input: Readonly<{
  key: CryptoKey;
  record: WrappedLocalEpochRecord;
  expected_project_id: ProjectId;
  expected_device_id: DeviceId;
  use: (epochSecret: Uint8Array) => T | Promise<T>;
  subtle?: SubtleCrypto;
}>): Promise<T> {
  validateWrappingKey(input.key);
  if (typeof input.use !== "function") throw new Error("Epoch access requires a bounded callback.");
  const record = parseWrappedLocalEpochRecord(input.record);
  if (record.project_id !== parseEntityId("project", input.expected_project_id) ||
      record.device_id !== parseEntityId("device", input.expected_device_id)) {
    throw new Error("Wrapped epoch ownership does not match the installed device.");
  }
  const aad = buildEpochWrapAad(record);
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = new Uint8Array(await (input.subtle ?? requireSubtle()).decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(record.nonce),
        additionalData: asArrayBuffer(aad),
        tagLength: 128
      },
      input.key,
      asArrayBuffer(record.ciphertext)
    ));
    if (plaintext.length !== HC2_EPOCH_SECRET_BYTES) throw new Error("Unwrapped epoch length is invalid.");
    const commitment = await deriveEpochCommitment({
      project_id: record.project_id,
      key_epoch_id: record.key_epoch_id,
      epoch_secret: plaintext
    });
    if (commitment.key_epoch_commitment !== record.key_epoch_commitment ||
        !sameBytes(commitment.public_commitment_bytes, record.public_commitment_bytes)) {
      throw new Error("Unwrapped epoch does not match its public commitment.");
    }
    const callbackSecret = Uint8Array.from(plaintext);
    try {
      return await input.use(callbackSecret);
    } finally {
      callbackSecret.fill(0);
    }
  } finally {
    plaintext?.fill(0);
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function parseWrappedLocalEpochRecord(value: unknown): WrappedLocalEpochRecord {
  const record = expectExactRecord(value, "wrapped local epoch", [
    "schema_version", "record_kind", "project_id", "device_id", "key_epoch_id", "key_epoch_commitment",
    "public_commitment_bytes", "wrapping_key_generation", "suite_id", "wrap_profile_id", "nonce", "ciphertext"
  ]);
  const nonce = expectBytes(record.nonce, "epoch-wrap nonce");
  const ciphertext = expectBytes(record.ciphertext, "wrapped epoch ciphertext");
  if (nonce.length !== HC2_EPOCH_WRAP_NONCE_BYTES) throw new Error("Epoch-wrap nonce must contain exactly 96 bits.");
  if (ciphertext.length !== HC2_EPOCH_SECRET_BYTES + HC2_EPOCH_WRAP_TAG_BYTES) throw new Error("Wrapped epoch ciphertext length is invalid.");
  const publicBytes = expectBytes(record.public_commitment_bytes, "epoch public commitment");
  if (publicBytes.length !== 32) throw new Error("Epoch public commitment must contain exactly 32 bytes.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_EPOCH_WRAP_VERSION, "epoch-wrap schema version"),
    record_kind: expectLiteral(record.record_kind, "wrapped_local_epoch_secret", "epoch-wrap record kind"),
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    public_commitment_bytes: Uint8Array.from(publicBytes),
    wrapping_key_generation: expectUInt64(record.wrapping_key_generation, "wrapping-key generation"),
    suite_id: expectLiteral(record.suite_id, HC2_CRYPTO_SUITE_ID, "epoch-wrap suite"),
    wrap_profile_id: expectLiteral(record.wrap_profile_id, HC2_LOCAL_EPOCH_WRAP_PROFILE_ID, "epoch-wrap profile"),
    nonce: Uint8Array.from(nonce),
    ciphertext: Uint8Array.from(ciphertext)
  });
}

export function validateWrappingKey(key: CryptoKey): void {
  if (!(key instanceof CryptoKey) || key.type !== "secret" || key.algorithm.name !== "AES-GCM" || key.extractable ||
      !sameUsages(key.usages, ["encrypt", "decrypt"])) {
    throw new Error("Local wrapping key must be a non-extractable AES-GCM encrypt/decrypt key.");
  }
  const length = (key.algorithm as AesKeyAlgorithm).length;
  if (length !== 256) throw new Error("Local wrapping key must contain 256 bits.");
}

function requireLength(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`${label} must contain exactly ${length} bytes.`);
  return Uint8Array.from(value);
}

function sameUsages(actual: readonly KeyUsage[], expected: readonly KeyUsage[]): boolean {
  return actual.length === expected.length && expected.every((usage) => actual.includes(usage));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function requireSubtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable.");
  return globalThis.crypto.subtle;
}

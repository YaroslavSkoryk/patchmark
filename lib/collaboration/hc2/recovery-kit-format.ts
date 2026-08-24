import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue
} from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import {
  parseEntityId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import { expectBytes, expectExactRecord, expectLiteral, expectUInt64, freezeRecord } from "../validation.ts";
import type { AlgorithmTaggedPublicKeyBytes } from "./crypto-contracts.ts";
import { decodeAlgorithmTaggedPublicKey } from "./providers/public-key-codec.ts";
import {
  HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
  HC2_RECOVERY_ARGON2_OPSLIMIT,
  HC2_RECOVERY_ARGON2_VERSION,
  HC2_RECOVERY_NONCE_BYTES,
  HC2_RECOVERY_PARALLELISM,
  HC2_RECOVERY_SALT_BYTES,
  HC2_RECOVERY_TAG_BYTES
} from "./providers/recovery-format.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_RECOVERY_KIT_PROFILE_ID,
  HC2_RECOVERY_KIT_VERSION,
  hc2HashDomains
} from "./versions.ts";

export const HC2_RECOVERY_KIT_MAXIMUM_BYTES = 64 * 1024;
export type RecoveryKitPublicHeader = Readonly<{
  schema_version: typeof HC2_RECOVERY_KIT_VERSION;
  record_kind: "recovery_kit_header";
  profile_id: typeof HC2_RECOVERY_KIT_PROFILE_ID;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  kdf: "argon2id";
  argon2_version: typeof HC2_RECOVERY_ARGON2_VERSION;
  argon2_opslimit: typeof HC2_RECOVERY_ARGON2_OPSLIMIT;
  argon2_memlimit_bytes: typeof HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES;
  argon2_parallelism: typeof HC2_RECOVERY_PARALLELISM;
  aead: "xchacha20-poly1305";
  salt: Uint8Array;
  nonce: Uint8Array;
  encrypted_payload_length: bigint;
  project_id: ProjectId;
  root_key_id: PublicKeyId;
  root_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  root_generation: bigint;
}>;

export type RecoveryKitContainer = Readonly<{
  schema_version: typeof HC2_RECOVERY_KIT_VERSION;
  record_kind: "project_root_recovery_kit";
  public_header: RecoveryKitPublicHeader;
  encrypted_payload: Uint8Array;
}>;

export function buildRecoveryKitAad(value: RecoveryKitPublicHeader): Uint8Array {
  const header = parseRecoveryKitPublicHeader(value);
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(`${hc2HashDomains.recoveryKit}/aad`),
    canonicalProtocolValue(header)
  ]));
}

export function encodeRecoveryKitContainer(value: RecoveryKitContainer): Uint8Array {
  const container = parseRecoveryKitContainer(value);
  const bytes = encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2HashDomains.recoveryKit),
    canonicalProtocolValue(container)
  ]));
  if (bytes.length > HC2_RECOVERY_KIT_MAXIMUM_BYTES) throw new Error("Recovery kit exceeds the exact size limit.");
  return Uint8Array.from(bytes);
}

export function decodeRecoveryKitContainer(value: Uint8Array): RecoveryKitContainer {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > HC2_RECOVERY_KIT_MAXIMUM_BYTES) {
    throw new Error("Recovery kit bytes are outside the exact size limit.");
  }
  const bytes = Uint8Array.from(value);
  const decoded = decodeCanonicalCbor(bytes);
  if (!sameBytes(bytes, encodeCanonicalCbor(decoded))) throw new Error("Recovery kit must use its exact canonical encoding.");
  const root = inspectCanonicalValue(decoded);
  if (root.kind !== "array" || root.values.length !== 2) throw new Error("Recovery kit framing is invalid.");
  const domain = inspectCanonicalValue(root.values[0]);
  if (domain.kind !== "text" || domain.value !== hc2HashDomains.recoveryKit) throw new Error("Recovery kit domain is invalid.");
  return parseRecoveryKitContainer(protocolValueFromCanonical(root.values[1]));
}

export function parseRecoveryKitPublicHeader(value: unknown): RecoveryKitPublicHeader {
  const record = expectExactRecord(value, "recovery-kit public header", [
    "schema_version", "record_kind", "profile_id", "suite_id", "kdf", "argon2_version", "argon2_opslimit",
    "argon2_memlimit_bytes", "argon2_parallelism", "aead", "salt", "nonce", "encrypted_payload_length",
    "project_id", "root_key_id", "root_public_key_bytes", "root_generation"
  ]);
  const salt = expectBytes(record.salt, "recovery-kit salt");
  const nonce = expectBytes(record.nonce, "recovery-kit nonce");
  const publicKeyBytes = expectBytes(record.root_public_key_bytes, "recovery-kit root public key");
  if (salt.length !== HC2_RECOVERY_SALT_BYTES || nonce.length !== HC2_RECOVERY_NONCE_BYTES) {
    throw new Error("Recovery-kit salt or nonce length is invalid.");
  }
  const rootKeyId = parseEntityId("public-key", record.root_key_id);
  const decodedKey = decodeAlgorithmTaggedPublicKey(publicKeyBytes, "ed25519");
  if (decodedKey.key_id !== rootKeyId) throw new Error("Recovery-kit root public key identity is inconsistent.");
  const encryptedLength = expectWireUInt64(record.encrypted_payload_length, "recovery-kit encrypted payload length");
  if (encryptedLength < BigInt(HC2_RECOVERY_TAG_BYTES) || encryptedLength > BigInt(HC2_RECOVERY_KIT_MAXIMUM_BYTES)) {
    throw new Error("Recovery-kit encrypted payload length is invalid.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_RECOVERY_KIT_VERSION, "recovery-kit header version"),
    record_kind: expectLiteral(record.record_kind, "recovery_kit_header", "recovery-kit header kind"),
    profile_id: expectLiteral(record.profile_id, HC2_RECOVERY_KIT_PROFILE_ID, "recovery-kit profile"),
    suite_id: expectLiteral(record.suite_id, HC2_CRYPTO_SUITE_ID, "recovery-kit suite"),
    kdf: expectLiteral(record.kdf, "argon2id", "recovery-kit KDF"),
    argon2_version: expectLiteral(record.argon2_version, HC2_RECOVERY_ARGON2_VERSION, "Argon2 version"),
    argon2_opslimit: expectLiteral(record.argon2_opslimit, HC2_RECOVERY_ARGON2_OPSLIMIT, "Argon2 operations limit"),
    argon2_memlimit_bytes: expectLiteral(record.argon2_memlimit_bytes, HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES, "Argon2 memory limit"),
    argon2_parallelism: expectLiteral(record.argon2_parallelism, HC2_RECOVERY_PARALLELISM, "Argon2 parallelism"),
    aead: expectLiteral(record.aead, "xchacha20-poly1305", "recovery-kit AEAD"),
    salt: Uint8Array.from(salt),
    nonce: Uint8Array.from(nonce),
    encrypted_payload_length: encryptedLength,
    project_id: parseEntityId("project", record.project_id),
    root_key_id: rootKeyId,
    root_public_key_bytes: Uint8Array.from(publicKeyBytes) as AlgorithmTaggedPublicKeyBytes,
    root_generation: expectWireUInt64(record.root_generation, "root generation")
  });
}

export function parseRecoveryKitContainer(value: unknown): RecoveryKitContainer {
  const record = expectExactRecord(value, "recovery-kit container", [
    "schema_version", "record_kind", "public_header", "encrypted_payload"
  ]);
  const header = parseRecoveryKitPublicHeader(record.public_header);
  const encrypted = expectBytes(record.encrypted_payload, "recovery-kit encrypted payload");
  if (BigInt(encrypted.length) !== header.encrypted_payload_length) throw new Error("Recovery-kit ciphertext length does not match its header.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_RECOVERY_KIT_VERSION, "recovery-kit version"),
    record_kind: expectLiteral(record.record_kind, "project_root_recovery_kit", "recovery-kit kind"),
    public_header: header,
    encrypted_payload: Uint8Array.from(encrypted)
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function expectWireUInt64(value: unknown, label: string): bigint {
  return expectUInt64(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : value, label);
}

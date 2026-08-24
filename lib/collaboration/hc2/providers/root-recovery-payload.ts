/** Worker-internal encrypted payload codec. Never import this module from application code. */
import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue
} from "../../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../../canonical-protocol.ts";
import { parseEntityId, type ProjectId, type PublicKeyId } from "../../identities.ts";
import { expectBytes, expectExactRecord, expectLiteral, expectUInt64, freezeRecord } from "../../validation.ts";
import type { AlgorithmTaggedPublicKeyBytes } from "../crypto-contracts.ts";
import { HC2_RECOVERY_KIT_MAXIMUM_BYTES } from "../recovery-kit-format.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_RECOVERY_KIT_PROFILE_ID, HC2_RECOVERY_KIT_VERSION, hc2HashDomains } from "../versions.ts";
import { decodeAlgorithmTaggedPublicKey } from "./public-key-codec.ts";

export const HC2_ROOT_SEED_BYTES = 32 as const;

export type RecoveryKitPayload = Readonly<{
  schema_version: typeof HC2_RECOVERY_KIT_VERSION;
  record_kind: "project_root_recovery_payload";
  profile_id: typeof HC2_RECOVERY_KIT_PROFILE_ID;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  project_id: ProjectId;
  root_key_id: PublicKeyId;
  root_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  root_generation: bigint;
  root_seed: Uint8Array;
}>;

export function encodeRecoveryKitPayload(value: RecoveryKitPayload): Uint8Array {
  const payload = parseRecoveryKitPayload(value);
  try {
    return encodeCanonicalCbor(canonicalArray([
      canonicalText(hc2HashDomains.recoveryKitPayload),
      canonicalProtocolValue(payload)
    ]));
  } finally {
    payload.root_seed.fill(0);
  }
}

export function decodeRecoveryKitPayload(value: Uint8Array): RecoveryKitPayload {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > HC2_RECOVERY_KIT_MAXIMUM_BYTES) throw new Error("Recovery payload is invalid.");
  const bytes = Uint8Array.from(value);
  const decoded = decodeCanonicalCbor(bytes);
  if (!sameBytes(bytes, encodeCanonicalCbor(decoded))) throw new Error("Recovery payload is noncanonical.");
  const root = inspectCanonicalValue(decoded);
  if (root.kind !== "array" || root.values.length !== 2) throw new Error("Recovery payload framing is invalid.");
  const domain = inspectCanonicalValue(root.values[0]);
  if (domain.kind !== "text" || domain.value !== hc2HashDomains.recoveryKitPayload) throw new Error("Recovery payload domain is invalid.");
  return parseRecoveryKitPayload(protocolValueFromCanonical(root.values[1]));
}

function parseRecoveryKitPayload(value: unknown): RecoveryKitPayload {
  const record = expectExactRecord(value, "recovery-kit payload", [
    "schema_version", "record_kind", "profile_id", "suite_id", "project_id", "root_key_id",
    "root_public_key_bytes", "root_generation", "root_seed"
  ]);
  const rootSeed = expectBytes(record.root_seed, "offline root seed");
  if (rootSeed.length !== HC2_ROOT_SEED_BYTES) throw new Error("Offline root seed length is invalid.");
  const rootKeyBytes = expectBytes(record.root_public_key_bytes, "offline root public key");
  const rootKeyId = parseEntityId("public-key", record.root_key_id);
  if (decodeAlgorithmTaggedPublicKey(rootKeyBytes, "ed25519").key_id !== rootKeyId) throw new Error("Offline root key identity is inconsistent.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_RECOVERY_KIT_VERSION, "recovery payload version"),
    record_kind: expectLiteral(record.record_kind, "project_root_recovery_payload", "recovery payload kind"),
    profile_id: expectLiteral(record.profile_id, HC2_RECOVERY_KIT_PROFILE_ID, "recovery payload profile"),
    suite_id: expectLiteral(record.suite_id, HC2_CRYPTO_SUITE_ID, "recovery payload suite"),
    project_id: parseEntityId("project", record.project_id),
    root_key_id: rootKeyId,
    root_public_key_bytes: Uint8Array.from(rootKeyBytes) as AlgorithmTaggedPublicKeyBytes,
    root_generation: expectWireUInt64(record.root_generation, "root generation"),
    root_seed: Uint8Array.from(rootSeed)
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

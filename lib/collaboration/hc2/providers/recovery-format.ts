import {
  canonicalArray,
  canonicalBytes,
  canonicalText,
  canonicalUint,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue,
  type CanonicalValue
} from "../../canonical-cbor.ts";
import { parseEntityId, type PersonId } from "../../identities.ts";
import { HC2_CRYPTO_SUITE_ID } from "../versions.ts";
import { cryptoFailure, Hc2CryptoProviderError } from "./provider-errors.ts";

export const HC2_RECOVERY_PROTECTED_DOMAIN = "patchmark/hc2/recovery-protected/v1" as const;
export const HC2_RECOVERY_AAD_DOMAIN = "patchmark/hc2/recovery-aad/v1" as const;
export const HC2_RECOVERY_PARAMETER_VERSION = 1 as const;
export const HC2_RECOVERY_ARGON2_VERSION = 19 as const;
export const HC2_RECOVERY_ARGON2_OPSLIMIT = 3 as const;
export const HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES = 64 * 1024 * 1024;
export const HC2_RECOVERY_DERIVED_KEY_BYTES = 32 as const;
export const HC2_RECOVERY_SALT_BYTES = 16 as const;
export const HC2_RECOVERY_NONCE_BYTES = 24 as const;
export const HC2_RECOVERY_TAG_BYTES = 16 as const;
export const HC2_RECOVERY_PARALLELISM = "provider_managed_not_configurable" as const;

export type Hc2RecoveryRecord = Readonly<{
  person_id: PersonId;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}>;

export function encodeRecoveryProtectedRecord(record: Hc2RecoveryRecord): Uint8Array {
  const parsed = validateRecord(record);
  return encodeCanonicalCbor(canonicalArray([
    ...parameterValues(HC2_RECOVERY_PROTECTED_DOMAIN),
    canonicalText(parsed.person_id),
    canonicalBytes(parsed.salt),
    canonicalBytes(parsed.nonce),
    canonicalBytes(parsed.ciphertext)
  ]));
}

export function decodeRecoveryProtectedRecord(bytes: Uint8Array): Hc2RecoveryRecord {
  if (!(bytes instanceof Uint8Array)) throw cryptoFailure("recovery_authentication_failure");
  try {
    const copied = Uint8Array.from(bytes);
    const decoded = decodeCanonicalCbor(copied);
    if (!sameBytes(copied, encodeCanonicalCbor(decoded))) throw cryptoFailure("parameter_mismatch");
    const root = inspectCanonicalValue(decoded);
    if (root.kind !== "array" || root.values.length !== 14) throw cryptoFailure("parameter_mismatch");
    validateParameters(root.values, HC2_RECOVERY_PROTECTED_DOMAIN);
    const personId = readText(root.values[10]);
    const salt = readBytes(root.values[11], HC2_RECOVERY_SALT_BYTES);
    const nonce = readBytes(root.values[12], HC2_RECOVERY_NONCE_BYTES);
    const ciphertext = readBytes(root.values[13]);
    if (ciphertext.length < HC2_RECOVERY_TAG_BYTES) throw cryptoFailure("recovery_authentication_failure");
    return validateRecord({
      person_id: parseEntityId("person", personId),
      salt,
      nonce,
      ciphertext
    });
  } catch (error) {
    if (error instanceof Hc2CryptoProviderError) throw error;
    throw cryptoFailure("recovery_authentication_failure");
  }
}

export function buildRecoveryAad(input: Readonly<{
  person_id: PersonId;
  salt: Uint8Array;
  nonce: Uint8Array;
}>): Uint8Array {
  const personId = parseEntityId("person", input.person_id);
  const salt = requireLength(input.salt, HC2_RECOVERY_SALT_BYTES);
  const nonce = requireLength(input.nonce, HC2_RECOVERY_NONCE_BYTES);
  return encodeCanonicalCbor(canonicalArray([
    ...parameterValues(HC2_RECOVERY_AAD_DOMAIN),
    canonicalText(personId),
    canonicalBytes(salt),
    canonicalBytes(nonce)
  ]));
}

function parameterValues(domain: typeof HC2_RECOVERY_PROTECTED_DOMAIN | typeof HC2_RECOVERY_AAD_DOMAIN): CanonicalValue[] {
  return [
    canonicalText(domain),
    canonicalUint(BigInt(HC2_RECOVERY_PARAMETER_VERSION)),
    canonicalText(HC2_CRYPTO_SUITE_ID),
    canonicalText("argon2id"),
    canonicalUint(BigInt(HC2_RECOVERY_ARGON2_VERSION)),
    canonicalUint(BigInt(HC2_RECOVERY_ARGON2_OPSLIMIT)),
    canonicalUint(BigInt(HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES)),
    canonicalUint(BigInt(HC2_RECOVERY_DERIVED_KEY_BYTES)),
    canonicalText(HC2_RECOVERY_PARALLELISM),
    canonicalText("xchacha20-poly1305")
  ];
}

function validateParameters(
  values: readonly CanonicalValue[],
  domain: typeof HC2_RECOVERY_PROTECTED_DOMAIN | typeof HC2_RECOVERY_AAD_DOMAIN
): void {
  const expected = parameterValues(domain);
  for (let index = 0; index < expected.length; index += 1) {
    if (!sameBytes(encodeCanonicalCbor(values[index]), encodeCanonicalCbor(expected[index]))) {
      throw cryptoFailure(index === 2 ? "unsupported_suite" : "parameter_mismatch");
    }
  }
}

function validateRecord(record: Hc2RecoveryRecord): Hc2RecoveryRecord {
  const personId = parseEntityId("person", record.person_id);
  const salt = requireLength(record.salt, HC2_RECOVERY_SALT_BYTES);
  const nonce = requireLength(record.nonce, HC2_RECOVERY_NONCE_BYTES);
  if (!(record.ciphertext instanceof Uint8Array) || record.ciphertext.length < HC2_RECOVERY_TAG_BYTES) {
    throw cryptoFailure("recovery_authentication_failure");
  }
  return Object.freeze({
    person_id: personId,
    salt,
    nonce,
    ciphertext: Uint8Array.from(record.ciphertext)
  });
}

function readText(value: CanonicalValue): string {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "text") throw cryptoFailure("parameter_mismatch");
  return view.value;
}

function readBytes(value: CanonicalValue, length?: number): Uint8Array {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "bytes" || (length !== undefined && view.value.length !== length)) {
    throw cryptoFailure("recovery_authentication_failure");
  }
  return Uint8Array.from(view.value);
}

function requireLength(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw cryptoFailure("parameter_mismatch");
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

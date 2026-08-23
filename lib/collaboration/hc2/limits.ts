import {
  HC2_CRYPTO_SUITE_ID,
  HC2_LIMIT_PROFILE_ID,
  HC2_LIMIT_PROFILE_VERSION
} from "./versions.ts";

const KIB = BigInt(1024);
const MIB = KIB * KIB;
const MAX_SUPPORTED_BYTE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

/** Every property names both its encoded layer and its measurement unit. */
export const hc2ProtocolLimits = Object.freeze({
  profile_id: HC2_LIMIT_PROFILE_ID,
  profile_version: HC2_LIMIT_PROFILE_VERSION,
  maximum_canonical_object_bytes: BigInt(16) * MIB,
  maximum_total_object_bytes_per_chunk: BigInt(16) * MIB,
  maximum_manifest_canonical_bytes: MIB,
  maximum_chunk_payload_core_structural_overhead_bytes: BigInt(896) * KIB,
  maximum_chunk_payload_core_canonical_bytes: BigInt(18) * MIB - BigInt(128) * KIB,
  maximum_signed_plaintext_core_structural_overhead_bytes: BigInt(64) * KIB,
  maximum_signed_plaintext_core_canonical_bytes: BigInt(18) * MIB - BigInt(64) * KIB,
  maximum_signed_plaintext_record_structural_overhead_bytes: BigInt(64) * KIB,
  maximum_signed_plaintext_record_canonical_bytes: BigInt(18) * MIB,
  aes_256_gcm_authentication_tag_bytes: BigInt(16),
  maximum_aead_ciphertext_bytes: BigInt(18) * MIB + BigInt(16),
  maximum_public_header_canonical_bytes: BigInt(4) * KIB,
  maximum_encrypted_container_framing_bytes: BigInt(60) * KIB - BigInt(16),
  maximum_encrypted_container_canonical_bytes: BigInt(18) * MIB + BigInt(64) * KIB,
  maximum_portable_bundle_canonical_bytes: BigInt(256) * MIB,
  maximum_objects_per_chunk: 1024,
  maximum_chunks_per_bundle: 4096,
  maximum_dependency_depth: 256,
  fixed_recovery_headroom_bytes: BigInt(64) * MIB,
  maximum_supported_byte_count: MAX_SUPPORTED_BYTE_COUNT,
  compression: "none" as const
});

export type Hc2LimitProfile = typeof hc2ProtocolLimits;

export const hc2ByteLimitSemantics = Object.freeze({
  maximum_canonical_object_bytes: "canonical CBOR bytes of one immutable collaboration object",
  maximum_total_object_bytes_per_chunk: "sum of exact canonical object byte strings carried by one chunk",
  maximum_manifest_canonical_bytes: "canonical CBOR bytes of the complete chunk manifest array",
  maximum_chunk_payload_core_structural_overhead_bytes: "bounded canonical map, array, identifier, and metadata framing inside ChunkPayloadCore beyond object and manifest bytes",
  maximum_chunk_payload_core_canonical_bytes: "canonical CBOR bytes of one complete ChunkPayloadCore",
  maximum_signed_plaintext_core_structural_overhead_bytes: "bounded canonical wrapper bytes added around ChunkPayloadCore by SignedPlaintextCore",
  maximum_signed_plaintext_core_canonical_bytes: "canonical CBOR bytes of one complete SignedPlaintextCore",
  maximum_signed_plaintext_record_structural_overhead_bytes: "bounded canonical signature-record wrapper bytes added around SignedPlaintextCore",
  maximum_signed_plaintext_record_canonical_bytes: "plaintext passed once to HPKE: canonical CBOR of SignedPlaintextRecord",
  aes_256_gcm_authentication_tag_bytes: "fixed bytes appended by the frozen AES-256-GCM suite to exact plaintext",
  maximum_aead_ciphertext_bytes: "AES-256-GCM ciphertext bytes including the fixed authentication tag",
  maximum_public_header_canonical_bytes: "canonical CBOR bytes of the complete public header used as AAD",
  maximum_encrypted_container_framing_bytes: "bounded canonical container map/key framing outside the separately counted header and ciphertext",
  maximum_encrypted_container_canonical_bytes: "canonical CBOR bytes of EncryptedContainerCore including header and ciphertext",
  maximum_portable_bundle_canonical_bytes: "canonical CBOR array framing plus complete transferred EncryptedContainerRecord encodings",
  fixed_recovery_headroom_bytes: "local quota bytes reserved beyond twice the bounded operation",
  maximum_supported_byte_count: "largest byte count accepted by the JavaScript-facing contract before bigint-to-number interop becomes unsafe"
} as const);

export type Hc2EncodedLayer =
  | "canonical_object"
  | "chunk_object_total"
  | "manifest"
  | "chunk_payload_core"
  | "signed_plaintext_core"
  | "signed_plaintext_record"
  | "aead_ciphertext"
  | "public_header"
  | "encrypted_container"
  | "portable_bundle";

const maximumByEncodedLayer: Readonly<Record<Hc2EncodedLayer, bigint>> = Object.freeze({
  canonical_object: hc2ProtocolLimits.maximum_canonical_object_bytes,
  chunk_object_total: hc2ProtocolLimits.maximum_total_object_bytes_per_chunk,
  manifest: hc2ProtocolLimits.maximum_manifest_canonical_bytes,
  chunk_payload_core: hc2ProtocolLimits.maximum_chunk_payload_core_canonical_bytes,
  signed_plaintext_core: hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes,
  signed_plaintext_record: hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes,
  aead_ciphertext: hc2ProtocolLimits.maximum_aead_ciphertext_bytes,
  public_header: hc2ProtocolLimits.maximum_public_header_canonical_bytes,
  encrypted_container: hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes,
  portable_bundle: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes
});

export function parseHc2LimitProfileId(value: unknown): typeof HC2_LIMIT_PROFILE_ID {
  if (value !== HC2_LIMIT_PROFILE_ID) throw new Error("Unknown HC-2 limit profile.");
  return value;
}

export function assertHc2EncodedLayerByteLength(layer: Hc2EncodedLayer, byteLength: bigint): bigint {
  if (typeof layer !== "string" || !(layer in maximumByEncodedLayer)) throw new Error("Unknown HC-2 encoded layer.");
  assertBoundedNonnegative(byteLength, maximumByEncodedLayer[layer], `${layer} byte length`);
  return byteLength;
}

export function calculateHc2AesGcmCiphertextLength(
  signedPlaintextRecordBytes: bigint,
  suiteId: unknown = HC2_CRYPTO_SUITE_ID
): bigint {
  if (suiteId !== HC2_CRYPTO_SUITE_ID) {
    throw new Error("Unknown HC-2 cryptographic suite; the v1 AEAD length formula cannot be reused.");
  }
  assertHc2EncodedLayerByteLength("signed_plaintext_record", signedPlaintextRecordBytes);
  const result = signedPlaintextRecordBytes + hc2ProtocolLimits.aes_256_gcm_authentication_tag_bytes;
  return assertHc2EncodedLayerByteLength("aead_ciphertext", result);
}

export function calculateChunkPayloadCoreBudgetBytes(
  totalObjectBytes: bigint,
  manifestCanonicalBytes: bigint,
  structuralOverheadBytes: bigint
): bigint {
  assertHc2EncodedLayerByteLength("chunk_object_total", totalObjectBytes);
  assertHc2EncodedLayerByteLength("manifest", manifestCanonicalBytes);
  assertBoundedNonnegative(
    structuralOverheadBytes,
    hc2ProtocolLimits.maximum_chunk_payload_core_structural_overhead_bytes,
    "ChunkPayloadCore structural overhead"
  );
  const total = checkedAdd(
    checkedAdd(totalObjectBytes, manifestCanonicalBytes, "ChunkPayloadCore budget"),
    structuralOverheadBytes,
    "ChunkPayloadCore budget"
  );
  return assertHc2EncodedLayerByteLength("chunk_payload_core", total);
}

export function calculateSignedPlaintextCoreBudgetBytes(
  chunkPayloadCoreBytes: bigint,
  structuralOverheadBytes: bigint
): bigint {
  assertHc2EncodedLayerByteLength("chunk_payload_core", chunkPayloadCoreBytes);
  assertBoundedNonnegative(
    structuralOverheadBytes,
    hc2ProtocolLimits.maximum_signed_plaintext_core_structural_overhead_bytes,
    "SignedPlaintextCore structural overhead"
  );
  return assertHc2EncodedLayerByteLength(
    "signed_plaintext_core",
    checkedAdd(chunkPayloadCoreBytes, structuralOverheadBytes, "SignedPlaintextCore budget")
  );
}

export function calculateSignedPlaintextRecordBudgetBytes(
  signedPlaintextCoreBytes: bigint,
  structuralOverheadBytes: bigint
): bigint {
  assertHc2EncodedLayerByteLength("signed_plaintext_core", signedPlaintextCoreBytes);
  assertBoundedNonnegative(
    structuralOverheadBytes,
    hc2ProtocolLimits.maximum_signed_plaintext_record_structural_overhead_bytes,
    "SignedPlaintextRecord structural overhead"
  );
  return assertHc2EncodedLayerByteLength(
    "signed_plaintext_record",
    checkedAdd(signedPlaintextCoreBytes, structuralOverheadBytes, "SignedPlaintextRecord budget")
  );
}

export function assertHc2AesGcmCiphertextLength(
  signedPlaintextRecordBytes: bigint,
  actualCiphertextBytes: bigint,
  suiteId: unknown = HC2_CRYPTO_SUITE_ID
): bigint {
  const expected = calculateHc2AesGcmCiphertextLength(signedPlaintextRecordBytes, suiteId);
  if (actualCiphertextBytes !== expected) {
    throw new Error("AES-256-GCM ciphertext length must equal the exact signed-record length plus the 16-byte authentication tag.");
  }
  return expected;
}

export function calculateEncryptedContainerBudgetBytes(
  ciphertextBytes: bigint,
  publicHeaderBytes: bigint,
  framingBytes: bigint
): bigint {
  assertHc2EncodedLayerByteLength("aead_ciphertext", ciphertextBytes);
  assertHc2EncodedLayerByteLength("public_header", publicHeaderBytes);
  assertBoundedNonnegative(framingBytes, hc2ProtocolLimits.maximum_encrypted_container_framing_bytes, "encrypted container framing");
  const total = checkedAdd(checkedAdd(ciphertextBytes, publicHeaderBytes, "encrypted container"), framingBytes, "encrypted container");
  return assertHc2EncodedLayerByteLength("encrypted_container", total);
}

export function calculatePortableBundleEncodedLength(containerRecordByteLengths: readonly bigint[]): bigint {
  const lengths = assertDenseArray(
    containerRecordByteLengths,
    hc2ProtocolLimits.maximum_chunks_per_bundle,
    "portable bundle container lengths"
  );
  if (lengths.length === 0) throw new Error("Portable bundle must contain at least one encrypted container.");
  let total = canonicalCborArrayHeaderByteLength(lengths.length);
  for (const value of lengths) {
    if (typeof value !== "bigint" || value <= BigInt(0)) {
      throw new Error("Portable bundle container length must be a positive bigint.");
    }
    if (value > hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes + BigInt(1024)) {
      throw new Error("Portable bundle container record exceeds its bounded core and identity framing allowance.");
    }
    total = checkedAdd(total, value, "portable bundle");
    assertHc2EncodedLayerByteLength("portable_bundle", total);
  }
  return total;
}

export function calculateRequiredQuotaBytes(operationBytes: bigint): bigint {
  assertHc2EncodedLayerByteLength("portable_bundle", operationBytes);
  const doubled = checkedAdd(operationBytes, operationBytes, "quota calculation");
  return checkedAdd(doubled, hc2ProtocolLimits.fixed_recovery_headroom_bytes, "quota calculation");
}

export function assertByteLengthWithin(value: Uint8Array, maximum: bigint, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array.`);
  assertBoundedNonnegative(BigInt(value.byteLength), maximum, label);
  return Uint8Array.from(value);
}

export function assertBoundedNonnegative(value: bigint, maximum: bigint, label: string): void {
  if (typeof value !== "bigint" || value < BigInt(0) || value > maximum || value > MAX_SUPPORTED_BYTE_COUNT) {
    throw new Error(`${label} is outside the HC-2 limit profile.`);
  }
}

export function assertDenseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a bounded array.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${label} must be dense and cannot contain holes.`);
    }
  }
  return value;
}

export function parseSafeCount(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded nonnegative safe integer.`);
  }
  return value as number;
}

function canonicalCborArrayHeaderByteLength(count: number): bigint {
  parseSafeCount(count, hc2ProtocolLimits.maximum_chunks_per_bundle, "portable bundle count");
  if (count < 24) return BigInt(1);
  if (count <= 0xff) return BigInt(2);
  return BigInt(3);
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  if (typeof left !== "bigint" || typeof right !== "bigint" || left < BigInt(0) || right < BigInt(0)) {
    throw new Error(`${label} operands must be nonnegative bigint byte lengths.`);
  }
  const result = left + right;
  if (result > MAX_SUPPORTED_BYTE_COUNT) throw new Error(`${label} exceeds the supported byte-count range.`);
  return result;
}

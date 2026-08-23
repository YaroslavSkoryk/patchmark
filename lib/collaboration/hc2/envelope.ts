import {
  canonicalArray,
  canonicalBytes,
  canonicalText,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import { parseSha256Digest, sha256, type Sha256Digest, type Sha256Provider } from "../sha256.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectUInt64,
  freezeRecord
} from "../validation.ts";
import type {
  EnvelopeAadBytes,
  HpkeInfoBytes,
  SenderSignaturePreimageBytes
} from "./crypto-contracts.ts";
import { parseHc2CryptoSuiteId } from "./crypto-contracts.ts";
import {
  deriveHc2Identity,
  parseEnvelopeId,
  parseHc2DigestId,
  type BundleRootId,
  type ChunkCommitmentId,
  type EncryptedContainerId,
  type EnvelopeId
} from "./identities.ts";
import {
  assertHc2AesGcmCiphertextLength,
  assertHc2EncodedLayerByteLength,
  assertByteLengthWithin,
  assertDenseArray,
  calculatePortableBundleEncodedLength,
  hc2ProtocolLimits,
  parseHc2LimitProfileId,
  parseSafeCount
} from "./limits.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_ENVELOPE_MAGIC,
  HC2_ENVELOPE_VERSION,
  HC2_HPKE_INFO_PROTOCOL_DOMAIN,
  HC2_LIMIT_PROFILE_ID,
  hc2SignatureDomains
} from "./versions.ts";

export type ChunkManifestEntry = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  byte_length: bigint;
  stored_sha256: Sha256Digest;
  dependency_ids: readonly CollaborationObjectId[];
  dependency_depth: number;
}>;

export type ChunkObjectBytes = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  exact_bytes: Uint8Array;
}>;

export type ChunkPayloadCore = Readonly<{
  schema_version: typeof HC2_ENVELOPE_VERSION;
  record_kind: "chunk_payload_core";
  project_id: ProjectId;
  scope_id: AccessScopeId;
  sender_person_id: PersonId;
  sender_device_id: DeviceId;
  recipient_device_id: DeviceId;
  recipient_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  accepted_control_head_id: ControlEventId;
  bundle_kind: "collaboration_exchange" | "enrollment_delivery" | "recovery_delivery";
  limit_profile_id: typeof HC2_LIMIT_PROFILE_ID;
  manifest: readonly ChunkManifestEntry[];
  object_bytes: readonly ChunkObjectBytes[];
}>;

export type ChunkPayloadObjectInput = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  exact_bytes: Uint8Array;
  dependency_ids: readonly CollaborationObjectId[];
  dependency_depth: number;
}>;

export async function createChunkPayloadCore(
  value: Omit<ChunkPayloadCore, "schema_version" | "record_kind" | "limit_profile_id" | "manifest" | "object_bytes"> & {
    objects: readonly ChunkPayloadObjectInput[];
  },
  provider?: Sha256Provider
): Promise<ChunkPayloadCore> {
  expectExactRecord(value, "chunk payload input", [
    "project_id", "scope_id", "sender_person_id", "sender_device_id", "recipient_device_id",
    "recipient_key_id", "key_epoch_id", "accepted_control_head_id", "bundle_kind", "objects"
  ]);
  const objects = assertDenseArray(value.objects, hc2ProtocolLimits.maximum_objects_per_chunk, "chunk objects");
  assertObjectInputsFitBeforeCopy(objects);
  const parsed = await Promise.all(objects.map(async (entry) => {
    const item = entry as ChunkPayloadObjectInput;
    const kind = parseCollaborationObjectKind(item.object_kind);
    const id = parseCollaborationObjectId(kind, item.object_id);
    const exactBytes = assertByteLengthWithin(item.exact_bytes, hc2ProtocolLimits.maximum_canonical_object_bytes, "chunk object bytes");
    return Object.freeze({
      manifest: freezeRecord({
        object_kind: kind,
        object_id: id,
        byte_length: BigInt(exactBytes.length),
        stored_sha256: await sha256(exactBytes, provider),
        dependency_ids: parseSortedUniqueObjectIds(item.dependency_ids, "chunk object dependencies"),
        dependency_depth: parseSafeCount(item.dependency_depth, hc2ProtocolLimits.maximum_dependency_depth, "dependency depth")
      }),
      bytes: freezeRecord({ object_kind: kind, object_id: id, exact_bytes: Uint8Array.from(exactBytes) })
    });
  }));
  parsed.sort((left, right) => {
    const leftKey = objectKey(left.manifest);
    const rightKey = objectKey(right.manifest);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  assertStrictObjectOrder(parsed.map((entry) => entry.manifest), "chunk manifest");
  const totalBytes = parsed.reduce((sum, entry) => sum + BigInt(entry.bytes.exact_bytes.length), BigInt(0));
  assertHc2EncodedLayerByteLength("chunk_object_total", totalBytes);
  const core = parseChunkPayloadCore({
    schema_version: HC2_ENVELOPE_VERSION,
    record_kind: "chunk_payload_core",
    project_id: value.project_id,
    scope_id: value.scope_id,
    sender_person_id: value.sender_person_id,
    sender_device_id: value.sender_device_id,
    recipient_device_id: value.recipient_device_id,
    recipient_key_id: value.recipient_key_id,
    key_epoch_id: value.key_epoch_id,
    accepted_control_head_id: value.accepted_control_head_id,
    bundle_kind: value.bundle_kind,
    limit_profile_id: HC2_LIMIT_PROFILE_ID,
    manifest: parsed.map((entry) => entry.manifest),
    object_bytes: parsed.map((entry) => entry.bytes)
  });
  return core;
}

export function parseChunkPayloadCore(value: unknown): ChunkPayloadCore {
  const record = expectExactRecord(value, "chunk payload core", [
    "schema_version", "record_kind", "project_id", "scope_id", "sender_person_id", "sender_device_id",
    "recipient_device_id", "recipient_key_id", "key_epoch_id", "accepted_control_head_id",
    "bundle_kind", "limit_profile_id", "manifest", "object_bytes"
  ]);
  const manifest = parseManifest(record.manifest);
  const objectBytes = parseObjectBytes(record.object_bytes);
  if (manifest.length !== objectBytes.length) throw new Error("Chunk manifest and object byte counts must match.");
  let totalBytes = BigInt(0);
  for (let index = 0; index < manifest.length; index += 1) {
    const descriptor = manifest[index];
    const stored = objectBytes[index];
    if (objectKey(descriptor) !== objectKey(stored) || descriptor.byte_length !== BigInt(stored.exact_bytes.length)) {
      throw new Error("Chunk manifest must exactly match supplied object bytes.");
    }
    totalBytes += BigInt(stored.exact_bytes.length);
  }
  assertHc2EncodedLayerByteLength("chunk_object_total", totalBytes);
  assertHc2EncodedLayerByteLength("manifest", canonicalByteLength(manifest));
  const core = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_ENVELOPE_VERSION, "chunk payload schema version"),
    record_kind: expectLiteral(record.record_kind, "chunk_payload_core", "chunk payload record kind"),
    project_id: parseEntityId("project", record.project_id),
    scope_id: parseEntityId("access-scope", record.scope_id),
    sender_person_id: parseEntityId("person", record.sender_person_id),
    sender_device_id: parseEntityId("device", record.sender_device_id),
    recipient_device_id: parseEntityId("device", record.recipient_device_id),
    recipient_key_id: parseEntityId("public-key", record.recipient_key_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    bundle_kind: expectEnum(record.bundle_kind, ["collaboration_exchange", "enrollment_delivery", "recovery_delivery"] as const, "bundle kind"),
    limit_profile_id: parseHc2LimitProfileId(record.limit_profile_id),
    manifest,
    object_bytes: objectBytes
  });
  assertHc2EncodedLayerByteLength("chunk_payload_core", canonicalByteLength(core));
  return core;
}

export async function verifyChunkPayloadObjectDigests(
  value: ChunkPayloadCore,
  provider?: Sha256Provider
): Promise<boolean> {
  const core = parseChunkPayloadCore(value);
  for (let index = 0; index < core.manifest.length; index += 1) {
    const digest = await sha256(core.object_bytes[index].exact_bytes, provider);
    if (!equalBytes(digest, core.manifest[index].stored_sha256)) return false;
  }
  return true;
}

export async function deriveChunkCommitment(
  value: ChunkPayloadCore,
  provider?: Sha256Provider
): Promise<Readonly<{ core: ChunkPayloadCore; commitment_id: ChunkCommitmentId; canonical_preimage_bytes: Uint8Array }>> {
  const core = parseChunkPayloadCore(value);
  if (!(await verifyChunkPayloadObjectDigests(core, provider))) throw new Error("Chunk object digest mismatch.");
  const identity = await deriveHc2Identity("chunk-commitment", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, commitment_id: identity.id, canonical_preimage_bytes: identity.canonical_preimage_bytes });
}

export type BundleRootCore = Readonly<{
  schema_version: typeof HC2_ENVELOPE_VERSION;
  record_kind: "bundle_root_core";
  chunk_commitment_ids: readonly ChunkCommitmentId[];
}>;

export async function deriveBundleRoot(
  value: BundleRootCore,
  provider?: Sha256Provider
): Promise<Readonly<{ core: BundleRootCore; bundle_root_id: BundleRootId; canonical_preimage_bytes: Uint8Array }>> {
  const core = parseBundleRootCore(value);
  const identity = await deriveHc2Identity("bundle-root", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, bundle_root_id: identity.id, canonical_preimage_bytes: identity.canonical_preimage_bytes });
}

export function parseBundleRootCore(value: unknown): BundleRootCore {
  const record = expectExactRecord(value, "bundle root core", ["schema_version", "record_kind", "chunk_commitment_ids"]);
  const commitments = assertDenseArray(record.chunk_commitment_ids, hc2ProtocolLimits.maximum_chunks_per_bundle, "bundle chunk commitments")
    .map((entry) => parseHc2DigestId("chunk-commitment", entry));
  if (commitments.length === 0 || new Set(commitments).size !== commitments.length) {
    throw new Error("Bundle root must contain a nonempty ordered list of unique chunk commitments.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_ENVELOPE_VERSION, "bundle root schema version"),
    record_kind: expectLiteral(record.record_kind, "bundle_root_core", "bundle root kind"),
    chunk_commitment_ids: Object.freeze(commitments)
  });
}

export type SignedPlaintextCore = Readonly<{
  schema_version: typeof HC2_ENVELOPE_VERSION;
  record_kind: "signed_plaintext_core";
  payload_core: ChunkPayloadCore;
  bundle_root_id: BundleRootId;
  chunk_ordinal: number;
  chunk_count: number;
}>;

export function parseSignedPlaintextCore(value: unknown): SignedPlaintextCore {
  const record = expectExactRecord(value, "signed plaintext core", [
    "schema_version", "record_kind", "payload_core", "bundle_root_id", "chunk_ordinal", "chunk_count"
  ]);
  const count = parsePositiveCount(record.chunk_count, hc2ProtocolLimits.maximum_chunks_per_bundle, "chunk count");
  const ordinal = parseSafeCount(record.chunk_ordinal, count - 1, "chunk ordinal");
  const core = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_ENVELOPE_VERSION, "signed plaintext schema version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_core", "signed plaintext kind"),
    payload_core: parseChunkPayloadCore(record.payload_core),
    bundle_root_id: parseHc2DigestId("bundle-root", record.bundle_root_id),
    chunk_ordinal: ordinal,
    chunk_count: count
  });
  assertHc2EncodedLayerByteLength("signed_plaintext_core", canonicalByteLength(core));
  return core;
}

export type PublicEnvelopeHeader = Readonly<{
  magic: typeof HC2_ENVELOPE_MAGIC;
  envelope_version: typeof HC2_ENVELOPE_VERSION;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  encapsulated_key_bytes: Uint8Array;
  envelope_id: EnvelopeId;
  recipient_routing_tag: Uint8Array;
  chunk_ordinal: number;
  chunk_count: number;
  ciphertext_length: bigint;
}>;

export function parsePublicEnvelopeHeader(value: unknown): PublicEnvelopeHeader {
  const record = expectExactRecord(value, "public envelope header", [
    "magic", "envelope_version", "suite_id", "encapsulated_key_bytes", "envelope_id",
    "recipient_routing_tag", "chunk_ordinal", "chunk_count", "ciphertext_length"
  ]);
  const count = parsePositiveCount(record.chunk_count, hc2ProtocolLimits.maximum_chunks_per_bundle, "header chunk count");
  const ordinal = parseSafeCount(record.chunk_ordinal, count - 1, "header chunk ordinal");
  const enc = expectBytes(record.encapsulated_key_bytes, "HPKE encapsulated key");
  if (enc.length === 0 || enc.length > 512) throw new Error("HPKE encapsulated key has an invalid length.");
  const tag = expectBytes(record.recipient_routing_tag, "recipient routing tag");
  if (tag.length !== 32) throw new Error("Recipient routing tag must contain exactly 32 opaque bytes.");
  const length = expectUInt64(record.ciphertext_length, "ciphertext length");
  if (length === BigInt(0)) throw new Error("Ciphertext length must be positive.");
  assertHc2EncodedLayerByteLength("aead_ciphertext", length);
  const header = freezeRecord({
    magic: expectLiteral(record.magic, HC2_ENVELOPE_MAGIC, "envelope magic"),
    envelope_version: expectLiteral(record.envelope_version, HC2_ENVELOPE_VERSION, "envelope version"),
    suite_id: parseHc2CryptoSuiteId(record.suite_id),
    encapsulated_key_bytes: Uint8Array.from(enc),
    envelope_id: parseEnvelopeId(record.envelope_id),
    recipient_routing_tag: Uint8Array.from(tag),
    chunk_ordinal: ordinal,
    chunk_count: count,
    ciphertext_length: length
  });
  assertHc2EncodedLayerByteLength("public_header", canonicalByteLength(header));
  return header;
}

export function buildEnvelopeAad(value: PublicEnvelopeHeader): EnvelopeAadBytes {
  return Uint8Array.from(
    encodeCanonicalCbor(canonicalProtocolValue(parsePublicEnvelopeHeader(value)))
  ) as EnvelopeAadBytes;
}

export function buildHpkeInfo(value: PublicEnvelopeHeader): HpkeInfoBytes {
  const header = parsePublicEnvelopeHeader(value);
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(HC2_HPKE_INFO_PROTOCOL_DOMAIN),
    canonicalProtocolValue(header.envelope_version),
    canonicalText(header.suite_id),
    canonicalText(header.envelope_id),
    canonicalBytes(header.recipient_routing_tag),
    canonicalProtocolValue(header.chunk_ordinal),
    canonicalProtocolValue(header.chunk_count)
  ]))) as HpkeInfoBytes;
}

export async function buildEnvelopeSignaturePreimage(
  headerValue: PublicEnvelopeHeader,
  coreValue: SignedPlaintextCore,
  provider?: Sha256Provider
): Promise<Readonly<{
  aad: EnvelopeAadBytes;
  aad_digest: Sha256Digest;
  signature_preimage: SenderSignaturePreimageBytes;
}>> {
  const header = parsePublicEnvelopeHeader(headerValue);
  const core = parseSignedPlaintextCore(coreValue);
  if (header.chunk_ordinal !== core.chunk_ordinal || header.chunk_count !== core.chunk_count) {
    throw new Error("Public header and signed plaintext position must match exactly.");
  }
  const aad = buildEnvelopeAad(header);
  const aadDigest = await sha256(aad, provider);
  const signaturePreimage = Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2SignatureDomains.envelopeChunk),
    canonicalBytes(aadDigest),
    canonicalProtocolValue(core)
  ]))) as SenderSignaturePreimageBytes;
  return freezeRecord({ aad, aad_digest: aadDigest, signature_preimage: signaturePreimage });
}

export type SenderDeviceSignatureRecord = Readonly<{
  algorithm: "ed25519";
  signer_device_id: DeviceId;
  signer_key_id: PublicKeyId;
  signature_bytes: Uint8Array;
}>;

export type SignedPlaintextRecord = Readonly<{
  record_version: typeof HC2_ENVELOPE_VERSION;
  record_kind: "signed_plaintext_record";
  core: SignedPlaintextCore;
  sender_device_signature: SenderDeviceSignatureRecord;
}>;

export function parseSignedPlaintextRecord(value: unknown): SignedPlaintextRecord {
  const record = expectExactRecord(value, "signed plaintext record", ["record_version", "record_kind", "core", "sender_device_signature"]);
  const core = parseSignedPlaintextCore(record.core);
  const signatureRecord = expectExactRecord(record.sender_device_signature, "sender device signature", [
    "algorithm", "signer_device_id", "signer_key_id", "signature_bytes"
  ]);
  const signature = expectBytes(signatureRecord.signature_bytes, "sender signature bytes");
  if (signature.length !== 64) throw new Error("Ed25519 sender signature must contain exactly 64 bytes.");
  const signer = parseEntityId("device", signatureRecord.signer_device_id);
  if (signer !== core.payload_core.sender_device_id) throw new Error("Sender signature device must match the payload sender.");
  const signedRecord = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_ENVELOPE_VERSION, "signed plaintext record version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_record", "signed plaintext record kind"),
    core,
    sender_device_signature: freezeRecord({
      algorithm: expectLiteral(signatureRecord.algorithm, "ed25519", "sender signature algorithm"),
      signer_device_id: signer,
      signer_key_id: parseEntityId("public-key", signatureRecord.signer_key_id),
      signature_bytes: Uint8Array.from(signature)
    })
  });
  assertHc2EncodedLayerByteLength("signed_plaintext_record", canonicalByteLength(signedRecord));
  return signedRecord;
}

export function validateSignedPlaintextRecordCiphertextLength(
  signedRecordValue: SignedPlaintextRecord,
  headerValue: PublicEnvelopeHeader
): Readonly<{ signed_plaintext_record_bytes: bigint; expected_ciphertext_bytes: bigint }> {
  const signedRecord = parseSignedPlaintextRecord(signedRecordValue);
  const header = parsePublicEnvelopeHeader(headerValue);
  if (
    header.chunk_ordinal !== signedRecord.core.chunk_ordinal
    || header.chunk_count !== signedRecord.core.chunk_count
  ) {
    throw new Error("Public header and signed plaintext position must match before ciphertext sizing.");
  }
  const signedPlaintextRecordBytes = canonicalByteLength(signedRecord);
  const expectedCiphertextBytes = assertHc2AesGcmCiphertextLength(
    signedPlaintextRecordBytes,
    header.ciphertext_length,
    header.suite_id
  );
  return freezeRecord({
    signed_plaintext_record_bytes: signedPlaintextRecordBytes,
    expected_ciphertext_bytes: expectedCiphertextBytes
  });
}

export type EncryptedContainerCore = Readonly<{
  container_version: typeof HC2_ENVELOPE_VERSION;
  record_kind: "encrypted_container_core";
  public_header: PublicEnvelopeHeader;
  ciphertext: Uint8Array;
}>;

export type EncryptedContainerRecord = Readonly<{
  core: EncryptedContainerCore;
  container_id: EncryptedContainerId;
}>;

export async function createEncryptedContainerRecord(
  value: EncryptedContainerCore,
  provider?: Sha256Provider
): Promise<EncryptedContainerRecord> {
  const core = parseEncryptedContainerCore(value);
  const identity = await deriveHc2Identity("encrypted-container", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, container_id: identity.id });
}

export function parseEncryptedContainerCore(value: unknown): EncryptedContainerCore {
  const record = expectExactRecord(value, "encrypted container core", ["container_version", "record_kind", "public_header", "ciphertext"]);
  const header = parsePublicEnvelopeHeader(record.public_header);
  const ciphertext = expectBytes(record.ciphertext, "encrypted container ciphertext");
  if (BigInt(ciphertext.length) !== header.ciphertext_length) throw new Error("Declared ciphertext length must match supplied bytes.");
  assertHc2EncodedLayerByteLength("aead_ciphertext", BigInt(ciphertext.byteLength));
  const core = freezeRecord({
    container_version: expectLiteral(record.container_version, HC2_ENVELOPE_VERSION, "container version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_core", "container kind"),
    public_header: header,
    ciphertext: Uint8Array.from(ciphertext)
  });
  assertHc2EncodedLayerByteLength("encrypted_container", canonicalByteLength(core));
  return core;
}

export async function verifyEncryptedContainerRecord(
  value: EncryptedContainerRecord,
  provider?: Sha256Provider
): Promise<boolean> {
  const core = parseEncryptedContainerCore(value.core);
  const identity = await deriveHc2Identity("encrypted-container", canonicalProtocolValue(core), provider);
  return identity.id === parseHc2DigestId("encrypted-container", value.container_id);
}

export function validateCompleteEncryptedContainerSet(values: readonly EncryptedContainerRecord[]): Readonly<{
  envelope_id: EnvelopeId;
  chunk_count: number;
  total_ciphertext_bytes: bigint;
  total_bundle_bytes: bigint;
}> {
  const records = assertDenseArray(values, hc2ProtocolLimits.maximum_chunks_per_bundle, "encrypted container set")
    .map((entry) => {
      const record = entry as EncryptedContainerRecord;
      return freezeRecord({
        core: parseEncryptedContainerCore(record.core),
        container_id: parseHc2DigestId("encrypted-container", record.container_id)
      });
    });
  if (records.length === 0) throw new Error("Encrypted container set must not be empty.");
  const first = records[0].core.public_header;
  if (records.length !== first.chunk_count) throw new Error("Encrypted container set is incomplete.");
  const ordinals = new Set<number>();
  let totalCiphertext = BigInt(0);
  const encodedRecordLengths: bigint[] = [];
  for (const record of records) {
    const header = record.core.public_header;
    if (header.envelope_id !== first.envelope_id || header.chunk_count !== first.chunk_count) {
      throw new Error("Encrypted chunks cannot move across bundles.");
    }
    if (ordinals.has(header.chunk_ordinal)) throw new Error("Encrypted container set contains a duplicate ordinal.");
    ordinals.add(header.chunk_ordinal);
    totalCiphertext += BigInt(record.core.ciphertext.length);
    encodedRecordLengths.push(canonicalByteLength(record));
  }
  for (let ordinal = 0; ordinal < first.chunk_count; ordinal += 1) {
    if (!ordinals.has(ordinal)) throw new Error("Encrypted container set is missing an ordinal.");
  }
  const totalBundleBytes = calculatePortableBundleEncodedLength(encodedRecordLengths);
  return freezeRecord({
    envelope_id: first.envelope_id,
    chunk_count: first.chunk_count,
    total_ciphertext_bytes: totalCiphertext,
    total_bundle_bytes: totalBundleBytes
  });
}

export async function verifyCompleteEncryptedContainerSet(
  values: readonly EncryptedContainerRecord[],
  provider?: Sha256Provider
): Promise<Readonly<{
  envelope_id: EnvelopeId;
  chunk_count: number;
  total_ciphertext_bytes: bigint;
  total_bundle_bytes: bigint;
}>> {
  const structure = validateCompleteEncryptedContainerSet(values);
  for (const value of values) {
    if (!(await verifyEncryptedContainerRecord(value, provider))) {
      throw new Error("Encrypted container identity verification failed.");
    }
  }
  return structure;
}

function parseManifest(value: unknown): readonly ChunkManifestEntry[] {
  const entries = assertDenseArray(value, hc2ProtocolLimits.maximum_objects_per_chunk, "chunk manifest");
  const parsed = entries.map((entry) => {
    const record = expectExactRecord(entry, "chunk manifest entry", [
      "object_kind", "object_id", "byte_length", "stored_sha256", "dependency_ids", "dependency_depth"
    ]);
    const kind = parseCollaborationObjectKind(record.object_kind);
    const length = expectUInt64(record.byte_length, "manifest byte length");
    if (length > hc2ProtocolLimits.maximum_canonical_object_bytes) throw new Error("Manifest object exceeds the HC-2 object limit.");
    return freezeRecord({
      object_kind: kind,
      object_id: parseCollaborationObjectId(kind, record.object_id),
      byte_length: length,
      stored_sha256: parseSha256Digest(expectBytes(record.stored_sha256, "manifest object SHA-256")),
      dependency_ids: parseSortedUniqueObjectIds(record.dependency_ids, "manifest dependencies"),
      dependency_depth: parseSafeCount(record.dependency_depth, hc2ProtocolLimits.maximum_dependency_depth, "dependency depth")
    });
  });
  assertStrictObjectOrder(parsed, "chunk manifest");
  return Object.freeze(parsed);
}

function parseObjectBytes(value: unknown): readonly ChunkObjectBytes[] {
  const entries = assertDenseArray(value, hc2ProtocolLimits.maximum_objects_per_chunk, "chunk object bytes");
  assertObjectByteRecordsFitBeforeCopy(entries);
  const parsed = entries.map((entry) => {
    const record = expectExactRecord(entry, "chunk object bytes", ["object_kind", "object_id", "exact_bytes"]);
    const kind = parseCollaborationObjectKind(record.object_kind);
    return freezeRecord({
      object_kind: kind,
      object_id: parseCollaborationObjectId(kind, record.object_id),
      exact_bytes: assertByteLengthWithin(expectBytes(record.exact_bytes, "exact object bytes"), hc2ProtocolLimits.maximum_canonical_object_bytes, "exact object bytes")
    });
  });
  assertStrictObjectOrder(parsed, "chunk object bytes");
  return Object.freeze(parsed);
}

function parseSortedUniqueObjectIds(value: unknown, label: string): readonly CollaborationObjectId[] {
  const entries = assertDenseArray(value, hc2ProtocolLimits.maximum_objects_per_chunk, label);
  const parsed = entries.map(parseAnyStoredObjectId);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1] >= parsed[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
  return Object.freeze(parsed);
}

function parseAnyStoredObjectId(value: unknown): CollaborationObjectId {
  if (typeof value !== "string") throw new Error("Stored object ID must be a string.");
  for (const kind of [
    "markdown-blob", "document-revision", "semantic-payload", "control-action", "semantic-event",
    "control-event", "attestation", "state-blob", "snapshot", "acknowledgement"
  ] as const) {
    if (value.startsWith(`pm:${kind}:v1:`)) return parseCollaborationObjectId(kind, value);
  }
  throw new Error("Stored object ID has an unsupported namespace.");
}

function assertStrictObjectOrder(values: readonly { object_kind: string; object_id: string }[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (objectKey(values[index - 1]) >= objectKey(values[index])) {
      throw new Error(`${label} must be strictly sorted and unique.`);
    }
  }
}

function objectKey(value: { object_kind: string; object_id: string }): string {
  return `${value.object_kind}\u0000${value.object_id}`;
}

function parsePositiveCount(value: unknown, maximum: number, label: string): number {
  const parsed = parseSafeCount(value, maximum, label);
  if (parsed === 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function canonicalByteLength(value: unknown): bigint {
  return BigInt(encodeCanonicalCbor(canonicalProtocolValue(value)).byteLength);
}

function assertObjectInputsFitBeforeCopy(values: readonly unknown[]): void {
  let total = BigInt(0);
  for (const entry of values) {
    if (typeof entry !== "object" || entry === null || !("exact_bytes" in entry)) {
      throw new Error("Chunk object input must contain exact object bytes.");
    }
    const bytes = (entry as { exact_bytes?: unknown }).exact_bytes;
    if (!(bytes instanceof Uint8Array)) throw new Error("Chunk object bytes must be a Uint8Array.");
    assertHc2EncodedLayerByteLength("canonical_object", BigInt(bytes.byteLength));
    total += BigInt(bytes.byteLength);
    assertHc2EncodedLayerByteLength("chunk_object_total", total);
  }
}

function assertObjectByteRecordsFitBeforeCopy(values: readonly unknown[]): void {
  let total = BigInt(0);
  for (const entry of values) {
    const record = expectExactRecord(entry, "chunk object bytes", ["object_kind", "object_id", "exact_bytes"]);
    const bytes = expectBytes(record.exact_bytes, "exact object bytes");
    assertHc2EncodedLayerByteLength("canonical_object", BigInt(bytes.byteLength));
    total += BigInt(bytes.byteLength);
    assertHc2EncodedLayerByteLength("chunk_object_total", total);
  }
}

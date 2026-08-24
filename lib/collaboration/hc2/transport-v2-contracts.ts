import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import {
  canonicalProtocolValue,
  protocolValueFromCanonical
} from "../canonical-protocol.ts";
import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type MembershipId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import { type Sha256Provider } from "../sha256.ts";
import {
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectUInt64,
  freezeRecord,
  type UInt64
} from "../validation.ts";
import {
  parseAdmissionPackageRecord,
  parseEpochDeliveryEnvelope,
  parseEpochReceiptRecord,
  type AdmissionPackageRecord,
  type EpochDeliveryEnvelope,
  type EpochReceiptRecord
} from "./enrollment-contracts.ts";
import {
  parseChunkPayloadCore,
  type ChunkPayloadCore
} from "./envelope.ts";
import { parseEnvelopeId, type EnvelopeId } from "./identities.ts";
import {
  assertHc2AesGcmCiphertextLength,
  assertHc2EncodedLayerByteLength,
  calculateSignedPlaintextCoreBudgetBytes,
  calculateSignedPlaintextRecordBudgetBytes,
  hc2ProtocolLimits,
  parseHc2LimitProfileId,
  parseSafeCount
} from "./limits.ts";
import {
  deriveTransportV2Identity,
  parseTransportV2Id,
  type BundleManifestIdV2,
  type EncryptedContainerIdV2,
  type TransportPayloadIdV2,
  type TransportStreamIdV2
} from "./transport-v2-identities.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_ENVELOPE_MAGIC,
  HC2_LIMIT_PROFILE_ID
} from "./versions.ts";
import {
  HC2_TRANSPORT_ENVELOPE_VERSION,
  HC2_TRANSPORT_HPKE_INFO_DOMAIN,
  HC2_TRANSPORT_PROFILE_ID,
  HC2_TRANSPORT_SCHEMA_VERSION,
  hc2TransportV2SignatureDomains
} from "./transport-v2-versions.ts";

export type TransportBundlePurposeV2 = "admission" | "replication";
export type TransportPayloadKindV2 =
  | "bundle_manifest"
  | "hc1_object_chunk"
  | "admission_attachment"
  | "epoch_delivery_attachment"
  | "receipt_attachment";
export type NonManifestTransportPayloadKindV2 = Exclude<
  TransportPayloadKindV2,
  "bundle_manifest"
>;

export type TransportBindingCommonV2 = Readonly<{
  transport_profile_id: typeof HC2_TRANSPORT_PROFILE_ID;
  project_id: ProjectId;
  purpose: TransportBundlePurposeV2;
  sender_person_id: PersonId;
  sender_membership_id: MembershipId;
  sender_device_id: DeviceId;
  sender_signing_key_id: PublicKeyId;
  recipient_authority: "accepted_member" | "candidate_transition";
  recipient_person_id: PersonId;
  recipient_membership_id: MembershipId | null;
  recipient_device_id: DeviceId;
  recipient_key_id: PublicKeyId;
  accepted_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  stream_id: TransportStreamIdV2;
  stream_generation: UInt64;
  bundle_sequence: UInt64;
  previous_bundle_manifest_id: BundleManifestIdV2 | null;
  payload_count: number;
  limit_profile_id: typeof HC2_LIMIT_PROFILE_ID;
  crypto_suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type TransportBindingCoreV2 = TransportBindingCommonV2 & Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "transport_binding_core_v2";
  bundle_manifest_id: BundleManifestIdV2;
  payload_kind: TransportPayloadKindV2;
  payload_ordinal: number;
}>;

export type BundlePayloadDescriptorV2 = Readonly<{
  payload_kind: NonManifestTransportPayloadKindV2;
  payload_ordinal: number;
  payload_id: TransportPayloadIdV2;
  canonical_length: UInt64;
}>;

export type BundleManifestCoreV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "bundle_manifest_core_v2";
  transport_profile_id: typeof HC2_TRANSPORT_PROFILE_ID;
  common_binding: TransportBindingCommonV2;
  payload_descriptors: readonly BundlePayloadDescriptorV2[];
}>;

export type BundleManifestPayloadV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  payload_kind: "bundle_manifest";
  manifest_core: BundleManifestCoreV2;
}>;
export type Hc1ObjectChunkPayloadV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  payload_kind: "hc1_object_chunk";
  chunk_payload_core: ChunkPayloadCore;
}>;
export type AdmissionAttachmentPayloadV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  payload_kind: "admission_attachment";
  admission_package: AdmissionPackageRecord;
}>;
export type EpochDeliveryAttachmentPayloadV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  payload_kind: "epoch_delivery_attachment";
  epoch_delivery: EpochDeliveryEnvelope;
}>;
export type ReceiptAttachmentPayloadV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  payload_kind: "receipt_attachment";
  epoch_receipt: EpochReceiptRecord;
}>;
export type TransportPayloadCoreV2 =
  | BundleManifestPayloadV2
  | Hc1ObjectChunkPayloadV2
  | AdmissionAttachmentPayloadV2
  | EpochDeliveryAttachmentPayloadV2
  | ReceiptAttachmentPayloadV2;

export type SignedPlaintextCoreV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "signed_plaintext_core_v2";
  binding: TransportBindingCoreV2;
  payload: TransportPayloadCoreV2;
}>;

export type SignedPlaintextRecordV2 = Readonly<{
  record_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "signed_plaintext_record_v2";
  core: SignedPlaintextCoreV2;
  signature_algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export type PublicEnvelopeHeaderV2 = Readonly<{
  magic: typeof HC2_ENVELOPE_MAGIC;
  envelope_version: typeof HC2_TRANSPORT_ENVELOPE_VERSION;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  encapsulated_key_bytes: Uint8Array;
  envelope_id: EnvelopeId;
  recipient_routing_tag: Uint8Array;
  chunk_ordinal: number;
  chunk_count: number;
  ciphertext_length: UInt64;
}>;

export type EncryptedContainerCoreV2 = Readonly<{
  schema_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "encrypted_container_core_v2";
  public_header: PublicEnvelopeHeaderV2;
  ciphertext_bytes: Uint8Array;
}>;

export type EncryptedContainerRecordV2 = Readonly<{
  record_version: typeof HC2_TRANSPORT_SCHEMA_VERSION;
  record_kind: "encrypted_container_record_v2";
  container_id: EncryptedContainerIdV2;
  core: EncryptedContainerCoreV2;
}>;

export type TransportSignaturePreimageBytesV2 = Uint8Array & {
  readonly __transportSignaturePreimageV2: true;
};
export type TransportHpkeInfoBytesV2 = Uint8Array & {
  readonly __transportHpkeInfoV2: true;
};
export type TransportBoundAadBytesV2 = Uint8Array & {
  readonly __transportBoundAadV2: true;
};

const strictlyConstructedAad = new WeakSet<Uint8Array>();

export function parseTransportBindingCommonV2(value: unknown): TransportBindingCommonV2 {
  const record = expectExactRecord(value, "transport v2 common binding", [
    "transport_profile_id", "project_id", "purpose", "sender_person_id",
    "sender_membership_id", "sender_device_id", "sender_signing_key_id",
    "recipient_authority", "recipient_person_id", "recipient_membership_id",
    "recipient_device_id", "recipient_key_id", "accepted_control_head_id",
    "key_epoch_id", "key_epoch_commitment", "stream_id", "stream_generation",
    "bundle_sequence", "previous_bundle_manifest_id", "payload_count",
    "limit_profile_id", "crypto_suite_id"
  ]);
  const purpose = expectEnum(record.purpose, ["admission", "replication"] as const, "transport purpose");
  const recipientAuthority = expectEnum(record.recipient_authority, ["accepted_member", "candidate_transition"] as const, "recipient authority");
  const recipientMembership = record.recipient_membership_id === null
    ? null
    : parseEntityId("membership", record.recipient_membership_id);
  if (purpose === "replication" && (recipientAuthority !== "accepted_member" || recipientMembership === null)) {
    throw new Error("Replication transport requires an accepted recipient membership.");
  }
  if (purpose === "admission" && recipientAuthority !== "candidate_transition") {
    throw new Error("Admission transport requires candidate-transition recipient authority.");
  }
  const sequence = expectUInt64(record.bundle_sequence, "transport bundle sequence");
  const previous = record.previous_bundle_manifest_id === null
    ? null
    : parseTransportV2Id("bundle-manifest", record.previous_bundle_manifest_id);
  if ((sequence === BigInt(0)) !== (previous === null)) {
    throw new Error("Transport genesis is sequence zero with no previous manifest; successors require both.");
  }
  return freezeRecord({
    transport_profile_id: expectLiteral(record.transport_profile_id, HC2_TRANSPORT_PROFILE_ID, "transport profile"),
    project_id: parseEntityId("project", record.project_id),
    purpose,
    sender_person_id: parseEntityId("person", record.sender_person_id),
    sender_membership_id: parseEntityId("membership", record.sender_membership_id),
    sender_device_id: parseEntityId("device", record.sender_device_id),
    sender_signing_key_id: parseEntityId("public-key", record.sender_signing_key_id),
    recipient_authority: recipientAuthority,
    recipient_person_id: parseEntityId("person", record.recipient_person_id),
    recipient_membership_id: recipientMembership,
    recipient_device_id: parseEntityId("device", record.recipient_device_id),
    recipient_key_id: parseEntityId("public-key", record.recipient_key_id),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    stream_id: parseTransportV2Id("transport-stream", record.stream_id),
    stream_generation: expectUInt64(record.stream_generation, "transport stream generation"),
    bundle_sequence: sequence,
    previous_bundle_manifest_id: previous,
    payload_count: parsePositiveCount(record.payload_count, "transport payload count"),
    limit_profile_id: parseHc2LimitProfileId(record.limit_profile_id),
    crypto_suite_id: parseSuite(record.crypto_suite_id)
  });
}

export function parseTransportBindingCoreV2(value: unknown): TransportBindingCoreV2 {
  const record = expectExactRecord(value, "transport v2 binding", [
    "schema_version", "record_kind", "transport_profile_id", "project_id",
    "purpose", "sender_person_id", "sender_membership_id", "sender_device_id",
    "sender_signing_key_id", "recipient_authority", "recipient_person_id",
    "recipient_membership_id", "recipient_device_id", "recipient_key_id",
    "accepted_control_head_id", "key_epoch_id", "key_epoch_commitment",
    "stream_id", "stream_generation", "bundle_sequence",
    "previous_bundle_manifest_id", "payload_count", "limit_profile_id",
    "crypto_suite_id", "bundle_manifest_id", "payload_kind", "payload_ordinal"
  ]);
  const common = parseTransportBindingCommonV2(pickCommonBinding(record));
  const ordinal = parseSafeCount(record.payload_ordinal, common.payload_count - 1, "transport payload ordinal");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "transport binding schema version"),
    record_kind: expectLiteral(record.record_kind, "transport_binding_core_v2", "transport binding kind"),
    ...common,
    bundle_manifest_id: parseTransportV2Id("bundle-manifest", record.bundle_manifest_id),
    payload_kind: expectEnum(record.payload_kind, ["bundle_manifest", "hc1_object_chunk", "admission_attachment", "epoch_delivery_attachment", "receipt_attachment"] as const, "transport payload kind"),
    payload_ordinal: ordinal
  });
}

export function parseBundlePayloadDescriptorV2(value: unknown): BundlePayloadDescriptorV2 {
  const record = expectExactRecord(value, "transport v2 payload descriptor", [
    "payload_kind", "payload_ordinal", "payload_id", "canonical_length"
  ]);
  const length = expectUInt64(record.canonical_length, "payload canonical length");
  if (length === BigInt(0) || length > hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes) {
    throw new Error("Transport payload canonical length is outside the frozen bound.");
  }
  return freezeRecord({
    payload_kind: expectEnum(record.payload_kind, ["hc1_object_chunk", "admission_attachment", "epoch_delivery_attachment", "receipt_attachment"] as const, "descriptor payload kind"),
    payload_ordinal: parsePositiveOrdinal(record.payload_ordinal),
    payload_id: parseTransportV2Id("transport-payload", record.payload_id),
    canonical_length: length
  });
}

export function parseBundleManifestCoreV2(value: unknown): BundleManifestCoreV2 {
  const record = expectExactRecord(value, "transport v2 manifest core", [
    "schema_version", "record_kind", "transport_profile_id", "common_binding",
    "payload_descriptors"
  ]);
  const common = parseTransportBindingCommonV2(record.common_binding);
  const values = Array.isArray(record.payload_descriptors) ? record.payload_descriptors : null;
  if (!values || values.length === 0 || values.length >= hc2ProtocolLimits.maximum_chunks_per_bundle) {
    throw new Error("Transport manifest descriptors must be a nonempty bounded dense array.");
  }
  const descriptors = values.map((entry, index) => {
    if (!Object.prototype.hasOwnProperty.call(values, index)) throw new Error("Transport manifest descriptors must be dense.");
    const descriptor = parseBundlePayloadDescriptorV2(entry);
    if (descriptor.payload_ordinal !== index + 1) throw new Error("Transport manifest descriptor ordinals must be dense after manifest ordinal zero.");
    return descriptor;
  });
  if (common.payload_count !== descriptors.length + 1) throw new Error("Transport manifest payload count is inconsistent.");
  if (new Set(descriptors.map((entry) => entry.payload_id)).size !== descriptors.length) {
    throw new Error("Transport manifest payload commitments must be unique.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "manifest schema version"),
    record_kind: expectLiteral(record.record_kind, "bundle_manifest_core_v2", "manifest record kind"),
    transport_profile_id: expectLiteral(record.transport_profile_id, HC2_TRANSPORT_PROFILE_ID, "transport profile"),
    common_binding: common,
    payload_descriptors: Object.freeze(descriptors)
  });
}

export function parseTransportPayloadCoreV2(value: unknown): TransportPayloadCoreV2 {
  const record = expectExactRecord(value, "transport v2 payload", ["schema_version", "payload_kind"], [
    "manifest_core", "chunk_payload_core", "admission_package", "epoch_delivery", "epoch_receipt"
  ]);
  const version = expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "transport payload schema version");
  const kind = expectEnum(record.payload_kind, ["bundle_manifest", "hc1_object_chunk", "admission_attachment", "epoch_delivery_attachment", "receipt_attachment"] as const, "transport payload kind");
  switch (kind) {
    case "bundle_manifest":
      requireOnlyVariant(record, "manifest_core");
      return freezeRecord({ schema_version: version, payload_kind: kind, manifest_core: parseBundleManifestCoreV2(record.manifest_core) });
    case "hc1_object_chunk":
      requireOnlyVariant(record, "chunk_payload_core");
      return freezeRecord({ schema_version: version, payload_kind: kind, chunk_payload_core: parseChunkPayloadCore(record.chunk_payload_core) });
    case "admission_attachment":
      requireOnlyVariant(record, "admission_package");
      return freezeRecord({ schema_version: version, payload_kind: kind, admission_package: parseAdmissionPackageRecord(record.admission_package) });
    case "epoch_delivery_attachment":
      requireOnlyVariant(record, "epoch_delivery");
      return freezeRecord({ schema_version: version, payload_kind: kind, epoch_delivery: parseEpochDeliveryEnvelope(record.epoch_delivery) });
    case "receipt_attachment":
      requireOnlyVariant(record, "epoch_receipt");
      return freezeRecord({ schema_version: version, payload_kind: kind, epoch_receipt: parseEpochReceiptRecord(record.epoch_receipt) });
  }
}

export async function deriveTransportPayloadIdentityV2(
  value: Exclude<TransportPayloadCoreV2, BundleManifestPayloadV2>,
  provider?: Sha256Provider
): Promise<Readonly<{ payload: Exclude<TransportPayloadCoreV2, BundleManifestPayloadV2>; payload_id: TransportPayloadIdV2; canonical_length: UInt64 }>> {
  const payload = parseTransportPayloadCoreV2(value);
  if (payload.payload_kind === "bundle_manifest") throw new Error("Manifest uses the separate v2 manifest identity domain.");
  const bytes = encodeTransportPayloadCoreV2(payload);
  const identity = await deriveTransportV2Identity("transport-payload", canonicalProtocolValue(payload), provider);
  return freezeRecord({ payload, payload_id: identity.id, canonical_length: BigInt(bytes.length) as UInt64 });
}

export async function deriveBundleManifestIdentityV2(
  value: BundleManifestCoreV2,
  provider?: Sha256Provider
): Promise<Readonly<{ manifest: BundleManifestCoreV2; manifest_id: BundleManifestIdV2; canonical_preimage_bytes: Uint8Array }>> {
  const manifest = parseBundleManifestCoreV2(value);
  const identity = await deriveTransportV2Identity("bundle-manifest", canonicalProtocolValue(manifest), provider);
  return freezeRecord({ manifest, manifest_id: identity.id, canonical_preimage_bytes: identity.canonical_preimage_bytes });
}

export function parseSignedPlaintextCoreV2(value: unknown): SignedPlaintextCoreV2 {
  const record = expectExactRecord(value, "signed transport plaintext core v2", [
    "schema_version", "record_kind", "binding", "payload"
  ]);
  const binding = parseTransportBindingCoreV2(record.binding);
  const payload = parseTransportPayloadCoreV2(record.payload);
  if (binding.payload_kind !== payload.payload_kind) throw new Error("Transport binding and payload kinds differ.");
  if (payload.payload_kind === "bundle_manifest") {
    if (binding.payload_ordinal !== 0) throw new Error("Transport manifest must occupy ordinal zero.");
    assertCommonBindingMatches(binding, payload.manifest_core.common_binding);
  } else if (binding.payload_ordinal === 0) {
    throw new Error("Only the transport manifest may occupy ordinal zero.");
  }
  const core = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "signed transport core version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_core_v2", "signed transport core kind"),
    binding,
    payload
  });
  const coreBytes = BigInt(encodeCanonicalCbor(canonicalProtocolValue(core)).length);
  if (payload.payload_kind === "hc1_object_chunk") {
    const chunkBytes = BigInt(encodeCanonicalCbor(canonicalProtocolValue(payload.chunk_payload_core)).length);
    calculateSignedPlaintextCoreBudgetBytes(chunkBytes, coreBytes - chunkBytes);
  } else {
    assertHc2EncodedLayerByteLength("signed_plaintext_core", coreBytes);
  }
  return core;
}

export function parseSignedPlaintextRecordV2(value: unknown): SignedPlaintextRecordV2 {
  const record = expectExactRecord(value, "signed transport plaintext record v2", [
    "record_version", "record_kind", "core", "signature_algorithm", "signature_bytes"
  ]);
  const signature = expectBytes(record.signature_bytes, "transport sender signature");
  if (signature.length !== 64) throw new Error("Transport Ed25519 signature must contain exactly 64 bytes.");
  const parsed = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_TRANSPORT_SCHEMA_VERSION, "signed transport record version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_record_v2", "signed transport record kind"),
    core: parseSignedPlaintextCoreV2(record.core),
    signature_algorithm: expectLiteral(record.signature_algorithm, "ed25519", "transport signature algorithm"),
    signature_bytes: Uint8Array.from(signature)
  });
  const coreBytes = BigInt(encodeCanonicalCbor(canonicalProtocolValue(parsed.core)).length);
  const recordBytes = BigInt(encodeSignedPlaintextRecordV2(parsed).length);
  calculateSignedPlaintextRecordBudgetBytes(coreBytes, recordBytes - coreBytes);
  return parsed;
}

export function buildTransportSignaturePreimageV2(value: SignedPlaintextCoreV2): TransportSignaturePreimageBytesV2 {
  const core = parseSignedPlaintextCoreV2(value);
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2TransportV2SignatureDomains.payload),
    canonicalProtocolValue(core)
  ]))) as TransportSignaturePreimageBytesV2;
}

export function parsePublicEnvelopeHeaderV2(value: unknown): PublicEnvelopeHeaderV2 {
  const record = expectExactRecord(value, "public transport envelope header v2", [
    "magic", "envelope_version", "suite_id", "encapsulated_key_bytes",
    "envelope_id", "recipient_routing_tag", "chunk_ordinal", "chunk_count",
    "ciphertext_length"
  ]);
  const count = parsePositiveCount(record.chunk_count, "header chunk count");
  const ordinal = parseSafeCount(record.chunk_ordinal, count - 1, "header chunk ordinal");
  const enc = expectBytes(record.encapsulated_key_bytes, "HPKE encapsulated key");
  if (enc.length !== 32) throw new Error("Transport v2 requires an exact 32-byte X25519 encapsulated key.");
  const tag = expectBytes(record.recipient_routing_tag, "opaque recipient routing tag");
  if (tag.length !== 32) throw new Error("Opaque recipient routing tag must contain exactly 32 bytes.");
  const length = expectUInt64(record.ciphertext_length, "ciphertext length");
  if (length === BigInt(0)) throw new Error("Ciphertext length must be positive.");
  assertHc2EncodedLayerByteLength("aead_ciphertext", length);
  const parsed = freezeRecord({
    magic: expectLiteral(record.magic, HC2_ENVELOPE_MAGIC, "envelope magic"),
    envelope_version: expectLiteral(record.envelope_version, HC2_TRANSPORT_ENVELOPE_VERSION, "transport envelope version"),
    suite_id: parseSuite(record.suite_id),
    encapsulated_key_bytes: Uint8Array.from(enc),
    envelope_id: parseEnvelopeId(record.envelope_id),
    recipient_routing_tag: Uint8Array.from(tag),
    chunk_ordinal: ordinal,
    chunk_count: count,
    ciphertext_length: length
  });
  assertHc2EncodedLayerByteLength("public_header", BigInt(encodeCanonicalCbor(canonicalProtocolValue(parsed)).length));
  return parsed;
}

export function buildTransportHpkeInfoV2(
  value: PublicEnvelopeHeaderV2 | Omit<PublicEnvelopeHeaderV2, "encapsulated_key_bytes" | "ciphertext_length">
): TransportHpkeInfoBytesV2 {
  const candidate = "encapsulated_key_bytes" in value
    ? {
        magic: value.magic,
        envelope_version: value.envelope_version,
        suite_id: value.suite_id,
        envelope_id: value.envelope_id,
        recipient_routing_tag: value.recipient_routing_tag,
        chunk_ordinal: value.chunk_ordinal,
        chunk_count: value.chunk_count
      }
    : value;
  const record = expectExactRecord(candidate, "transport HPKE info binding v2", [
    "magic", "envelope_version", "suite_id", "envelope_id",
    "recipient_routing_tag", "chunk_ordinal", "chunk_count"
  ]);
  const count = parsePositiveCount(record.chunk_count, "HPKE info chunk count");
  const ordinal = parseSafeCount(record.chunk_ordinal, count - 1, "HPKE info chunk ordinal");
  const tag = expectBytes(record.recipient_routing_tag, "HPKE info routing tag");
  if (tag.length !== 32) throw new Error("HPKE info routing tag must contain exactly 32 bytes.");
  const binding = freezeRecord({
    magic: expectLiteral(record.magic, HC2_ENVELOPE_MAGIC, "HPKE info magic"),
    envelope_version: expectLiteral(record.envelope_version, HC2_TRANSPORT_ENVELOPE_VERSION, "HPKE info envelope version"),
    suite_id: parseSuite(record.suite_id),
    envelope_id: parseEnvelopeId(record.envelope_id),
    recipient_routing_tag: Uint8Array.from(tag),
    chunk_ordinal: ordinal,
    chunk_count: count
  });
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(HC2_TRANSPORT_HPKE_INFO_DOMAIN),
    canonicalProtocolValue(binding)
  ]))) as TransportHpkeInfoBytesV2;
}

export function buildTransportBoundAadV2(value: PublicEnvelopeHeaderV2): TransportBoundAadBytesV2 {
  const header = parsePublicEnvelopeHeaderV2(value);
  const aad = Uint8Array.from(encodeCanonicalCbor(canonicalProtocolValue(header))) as TransportBoundAadBytesV2;
  strictlyConstructedAad.add(aad);
  return aad;
}

export function isStrictlyConstructedTransportAadV2(value: unknown): value is TransportBoundAadBytesV2 {
  return value instanceof Uint8Array && strictlyConstructedAad.has(value);
}

export function parseEncryptedContainerCoreV2(value: unknown): EncryptedContainerCoreV2 {
  const record = expectExactRecord(value, "encrypted transport container core v2", [
    "schema_version", "record_kind", "public_header", "ciphertext_bytes"
  ]);
  const header = parsePublicEnvelopeHeaderV2(record.public_header);
  const ciphertext = expectBytes(record.ciphertext_bytes, "transport ciphertext");
  if (header.ciphertext_length !== BigInt(ciphertext.length)) throw new Error("Transport header ciphertext length does not match exact bytes.");
  assertHc2EncodedLayerByteLength("aead_ciphertext", BigInt(ciphertext.length));
  const core = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSPORT_SCHEMA_VERSION, "encrypted container schema version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_core_v2", "encrypted container kind"),
    public_header: header,
    ciphertext_bytes: Uint8Array.from(ciphertext)
  });
  assertHc2EncodedLayerByteLength("encrypted_container", BigInt(encodeCanonicalCbor(canonicalProtocolValue(core)).length));
  return core;
}

export async function createEncryptedContainerRecordV2(
  value: EncryptedContainerCoreV2,
  provider?: Sha256Provider
): Promise<EncryptedContainerRecordV2> {
  const core = parseEncryptedContainerCoreV2(value);
  const identity = await deriveTransportV2Identity("encrypted-container", canonicalProtocolValue(core), provider);
  return freezeRecord({
    record_version: HC2_TRANSPORT_SCHEMA_VERSION,
    record_kind: "encrypted_container_record_v2",
    container_id: identity.id,
    core
  });
}

export async function parseEncryptedContainerRecordV2(
  value: unknown,
  provider?: Sha256Provider
): Promise<EncryptedContainerRecordV2> {
  const record = expectExactRecord(value, "encrypted transport container record v2", [
    "record_version", "record_kind", "container_id", "core"
  ]);
  const parsed = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_TRANSPORT_SCHEMA_VERSION, "encrypted container record version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_record_v2", "encrypted container record kind"),
    container_id: parseTransportV2Id("encrypted-container", record.container_id),
    core: parseEncryptedContainerCoreV2(record.core)
  });
  const identity = await deriveTransportV2Identity("encrypted-container", canonicalProtocolValue(parsed.core), provider);
  if (identity.id !== parsed.container_id) throw new Error("Encrypted transport container identity mismatch.");
  return parsed;
}

export function encodeTransportPayloadCoreV2(value: TransportPayloadCoreV2): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(parseTransportPayloadCoreV2(value)));
}

export function decodeTransportPayloadCoreV2(value: Uint8Array): TransportPayloadCoreV2 {
  return parseTransportPayloadCoreV2(decodeStrict(value, "transport payload"));
}

export function encodeSignedPlaintextRecordV2(value: SignedPlaintextRecordV2): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(parseSignedPlaintextRecordV2WithoutLength(value)));
}

export function decodeSignedPlaintextRecordV2(value: Uint8Array): SignedPlaintextRecordV2 {
  const bytes = copyBounded(value, hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes, "signed transport plaintext");
  return parseSignedPlaintextRecordV2(decodeStrict(bytes, "signed transport plaintext"));
}

export function encodeEncryptedContainerRecordV2(value: EncryptedContainerRecordV2): Uint8Array {
  const record = expectExactRecord(value, "encrypted transport container record v2", ["record_version", "record_kind", "container_id", "core"]);
  const parsed = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_TRANSPORT_SCHEMA_VERSION, "container record version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_record_v2", "container record kind"),
    container_id: parseTransportV2Id("encrypted-container", record.container_id),
    core: parseEncryptedContainerCoreV2(record.core)
  });
  return encodeCanonicalCbor(canonicalProtocolValue(parsed));
}

export async function decodeEncryptedContainerRecordV2(value: Uint8Array, provider?: Sha256Provider): Promise<EncryptedContainerRecordV2> {
  const bytes = copyBounded(value, hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes + BigInt(1024), "encrypted transport container record");
  return parseEncryptedContainerRecordV2(decodeStrict(bytes, "encrypted transport container record"), provider);
}

export function assertTransportCiphertextLengthV2(plaintextLength: bigint, ciphertextLength: bigint): void {
  assertHc2AesGcmCiphertextLength(plaintextLength, ciphertextLength);
}

export function commonBindingFromTransportBindingV2(value: TransportBindingCoreV2): TransportBindingCommonV2 {
  return parseTransportBindingCommonV2(pickCommonBinding(parseTransportBindingCoreV2(value)));
}

function parseSignedPlaintextRecordV2WithoutLength(value: unknown): SignedPlaintextRecordV2 {
  const record = expectExactRecord(value, "signed transport plaintext record v2", ["record_version", "record_kind", "core", "signature_algorithm", "signature_bytes"]);
  const signature = expectBytes(record.signature_bytes, "transport sender signature");
  if (signature.length !== 64) throw new Error("Transport Ed25519 signature must contain exactly 64 bytes.");
  return freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_TRANSPORT_SCHEMA_VERSION, "signed transport record version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_record_v2", "signed transport record kind"),
    core: parseSignedPlaintextCoreV2(record.core),
    signature_algorithm: expectLiteral(record.signature_algorithm, "ed25519", "transport signature algorithm"),
    signature_bytes: Uint8Array.from(signature)
  });
}

const commonBindingKeys = [
  "transport_profile_id", "project_id", "purpose", "sender_person_id",
  "sender_membership_id", "sender_device_id", "sender_signing_key_id",
  "recipient_authority", "recipient_person_id", "recipient_membership_id",
  "recipient_device_id", "recipient_key_id", "accepted_control_head_id",
  "key_epoch_id", "key_epoch_commitment", "stream_id", "stream_generation",
  "bundle_sequence", "previous_bundle_manifest_id", "payload_count",
  "limit_profile_id", "crypto_suite_id"
] as const;

function pickCommonBinding(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(commonBindingKeys.map((key) => [key, value[key]]));
}

function parseSuite(value: unknown): typeof HC2_CRYPTO_SUITE_ID {
  if (value !== HC2_CRYPTO_SUITE_ID) throw new Error("Unknown HC-2 cryptographic suite.");
  return value;
}

function parsePositiveCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > hc2ProtocolLimits.maximum_chunks_per_bundle) {
    throw new Error(`${label} must be between one and the frozen 4096-payload limit.`);
  }
  return value as number;
}

function parsePositiveOrdinal(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= hc2ProtocolLimits.maximum_chunks_per_bundle) {
    throw new Error("Transport non-manifest payload ordinal is outside the frozen limit.");
  }
  return value as number;
}

function requireOnlyVariant(record: Readonly<Record<string, unknown>>, selected: string): void {
  for (const key of ["manifest_core", "chunk_payload_core", "admission_package", "epoch_delivery", "epoch_receipt"]) {
    if ((key === selected) !== Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error("Transport payload must contain exactly the field selected by payload_kind.");
    }
  }
}

function assertCommonBindingMatches(binding: TransportBindingCoreV2, common: TransportBindingCommonV2): void {
  const left = encodeCanonicalCbor(canonicalProtocolValue(pickCommonBinding(binding)));
  const right = encodeCanonicalCbor(canonicalProtocolValue(parseTransportBindingCommonV2(common)));
  if (!sameBytes(left, right)) throw new Error("Manifest common binding differs from the signed payload binding.");
}

function copyBounded(value: Uint8Array, maximum: bigint, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || BigInt(value.length) === BigInt(0) || BigInt(value.length) > maximum) {
    throw new Error(`${label} is outside its frozen canonical byte limit.`);
  }
  return Uint8Array.from(value);
}

function decodeStrict(value: Uint8Array, label: string): unknown {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be canonical bytes.`);
  const decoded = decodeCanonicalCbor(Uint8Array.from(value));
  if (!sameBytes(value, encodeCanonicalCbor(decoded))) throw new Error(`${label} is not canonical CBOR.`);
  return normalizeDecodedIntegers(protocolValueFromCanonical(decoded));
}

const bigintFieldNames = new Set([
  "stream_generation", "bundle_sequence", "canonical_length", "ciphertext_length",
  "acknowledgement_sequence", "recipient_ordinal", "recipient_count", "byte_length"
]);

function normalizeDecodedIntegers(value: unknown, key?: string): unknown {
  if (typeof value === "number" && key !== undefined && bigintFieldNames.has(key)) return BigInt(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeDecodedIntegers(entry));
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeDecodedIntegers(child, childKey)]));
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

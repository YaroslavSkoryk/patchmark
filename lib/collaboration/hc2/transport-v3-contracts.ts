import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
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
import type { Sha256Provider } from "../sha256.ts";
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
import { parseChunkPayloadCore, type ChunkPayloadCore } from "./envelope.ts";
import { parseEnvelopeId, type EnvelopeId } from "./identities.ts";
import { assertHc2EncodedLayerByteLength, hc2ProtocolLimits, parseHc2LimitProfileId, parseSafeCount } from "./limits.ts";
import {
  parseInventoryPageCoreV3,
  parseObjectRequestCoreV3,
  parseObjectResponseCoreV3,
  parseSyncConfirmationCoreV3,
  parseSyncOfferCoreV3,
  type InventoryPageCoreV3,
  type ObjectRequestCoreV3,
  type ObjectResponseCoreV3,
  type SyncConfirmationCoreV3,
  type SyncOfferCoreV3
} from "./sync-contracts.ts";
import {
  deriveSyncV3Identity,
  parseSyncV3Id,
  type BundleManifestIdV3,
  type EncryptedContainerIdV3,
  type SyncSessionIdV3,
  type TransportPayloadIdV3,
  type TransportStreamIdV3
} from "./sync-v3-identities.ts";
import {
  HC2_SYNC_ENVELOPE_VERSION,
  HC2_SYNC_HPKE_INFO_DOMAIN,
  HC2_SYNC_SCHEMA_VERSION,
  HC2_SYNC_TRANSPORT_PROFILE_ID,
  hc2SyncV3PayloadKinds,
  hc2SyncV3SignatureDomains,
  type SyncMessageRoleV3
} from "./sync-v3-versions.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC, HC2_LIMIT_PROFILE_ID } from "./versions.ts";

export type SyncTransportMessageKindV3 = "offer" | "inventory" | "request" | "response" | "confirmation";
export type TransportPayloadKindV3 = (typeof hc2SyncV3PayloadKinds)[number];
export type NonManifestTransportPayloadKindV3 = Exclude<TransportPayloadKindV3, "bundle_manifest">;

export type TransportBindingCommonV3 = Readonly<{
  transport_profile_id: typeof HC2_SYNC_TRANSPORT_PROFILE_ID;
  project_id: ProjectId;
  purpose: "synchronization";
  sender_person_id: PersonId;
  sender_membership_id: MembershipId;
  sender_device_id: DeviceId;
  sender_signing_key_id: PublicKeyId;
  recipient_person_id: PersonId;
  recipient_membership_id: MembershipId;
  recipient_device_id: DeviceId;
  recipient_key_id: PublicKeyId;
  accepted_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  stream_id: TransportStreamIdV3;
  stream_generation: UInt64;
  bundle_sequence: UInt64;
  previous_bundle_manifest_id: BundleManifestIdV3 | null;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  message_kind: SyncTransportMessageKindV3;
  message_direction: SyncMessageRoleV3;
  payload_count: number;
  limit_profile_id: typeof HC2_LIMIT_PROFILE_ID;
  crypto_suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type TransportBindingCoreV3 = TransportBindingCommonV3 & Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "transport_binding_core_v3";
  bundle_manifest_id: BundleManifestIdV3;
  payload_kind: TransportPayloadKindV3;
  payload_ordinal: number;
}>;

export type BundlePayloadDescriptorV3 = Readonly<{
  payload_kind: NonManifestTransportPayloadKindV3;
  payload_ordinal: number;
  payload_id: TransportPayloadIdV3;
  canonical_length: UInt64;
}>;

export type BundleManifestCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "bundle_manifest_core_v3";
  transport_profile_id: typeof HC2_SYNC_TRANSPORT_PROFILE_ID;
  common_binding: TransportBindingCommonV3;
  payload_descriptors: readonly BundlePayloadDescriptorV3[];
}>;

export type BundleManifestPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "bundle_manifest"; manifest_core: BundleManifestCoreV3 }>;
export type SyncOfferPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "sync_offer"; offer_core: SyncOfferCoreV3 }>;
export type InventoryPagePayloadV3 = Readonly<{ schema_version: 3; payload_kind: "inventory_page"; page_core: InventoryPageCoreV3 }>;
export type ObjectRequestPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "object_request"; request_core: ObjectRequestCoreV3 }>;
export type ObjectResponsePayloadV3 = Readonly<{ schema_version: 3; payload_kind: "object_response"; response_core: ObjectResponseCoreV3 }>;
export type SyncConfirmationPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "sync_confirmation"; confirmation_core: SyncConfirmationCoreV3 }>;
export type Hc1ObjectChunkPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "hc1_object_chunk"; chunk_payload_core: ChunkPayloadCore }>;
export type AdmissionAttachmentPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "admission_attachment"; admission_package: AdmissionPackageRecord }>;
export type EpochDeliveryAttachmentPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "epoch_delivery_attachment"; epoch_delivery: EpochDeliveryEnvelope }>;
export type ReceiptAttachmentPayloadV3 = Readonly<{ schema_version: 3; payload_kind: "receipt_attachment"; epoch_receipt: EpochReceiptRecord }>;

export type TransportPayloadCoreV3 =
  | BundleManifestPayloadV3 | SyncOfferPayloadV3 | InventoryPagePayloadV3
  | ObjectRequestPayloadV3 | ObjectResponsePayloadV3 | SyncConfirmationPayloadV3
  | Hc1ObjectChunkPayloadV3 | AdmissionAttachmentPayloadV3
  | EpochDeliveryAttachmentPayloadV3 | ReceiptAttachmentPayloadV3;

export type SignedPlaintextCoreV3 = Readonly<{
  schema_version: 3;
  record_kind: "signed_plaintext_core_v3";
  binding: TransportBindingCoreV3;
  payload: TransportPayloadCoreV3;
}>;
export type SignedPlaintextRecordV3 = Readonly<{
  record_version: 3;
  record_kind: "signed_plaintext_record_v3";
  core: SignedPlaintextCoreV3;
  signature_algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;
export type PublicEnvelopeHeaderV3 = Readonly<{
  magic: typeof HC2_ENVELOPE_MAGIC;
  envelope_version: 3;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  encapsulated_key_bytes: Uint8Array;
  envelope_id: EnvelopeId;
  recipient_routing_tag: Uint8Array;
  chunk_ordinal: number;
  chunk_count: number;
  ciphertext_length: UInt64;
}>;
export type EncryptedContainerCoreV3 = Readonly<{
  schema_version: 3;
  record_kind: "encrypted_container_core_v3";
  public_header: PublicEnvelopeHeaderV3;
  ciphertext_bytes: Uint8Array;
}>;
export type EncryptedContainerRecordV3 = Readonly<{
  record_version: 3;
  record_kind: "encrypted_container_record_v3";
  container_id: EncryptedContainerIdV3;
  core: EncryptedContainerCoreV3;
}>;
export type TransportSignaturePreimageBytesV3 = Uint8Array & { readonly __transportSignaturePreimageV3: true };
export type TransportHpkeInfoBytesV3 = Uint8Array & { readonly __transportHpkeInfoV3: true };
export type TransportBoundAadBytesV3 = Uint8Array & { readonly __transportBoundAadV3: true };

const strictlyConstructedAad = new WeakSet<Uint8Array>();

export function parseTransportBindingCommonV3(value: unknown): TransportBindingCommonV3 {
  const record = expectExactRecord(value, "transport v3 common binding", commonBindingKeys);
  const sequence = expectUInt64(record.bundle_sequence, "transport bundle sequence");
  const previous = record.previous_bundle_manifest_id === null ? null : parseSyncV3Id("bundle-manifest", record.previous_bundle_manifest_id);
  if ((sequence === BigInt(0)) !== (previous === null)) throw new Error("V3 transport genesis and predecessor binding are inconsistent.");
  const round = expectUInt64(record.round_number, "synchronization round");
  if (round === BigInt(0)) throw new Error("Synchronization round must be positive.");
  return freezeRecord({
    transport_profile_id: expectLiteral(record.transport_profile_id, HC2_SYNC_TRANSPORT_PROFILE_ID, "synchronization transport profile"),
    project_id: parseEntityId("project", record.project_id),
    purpose: expectLiteral(record.purpose, "synchronization", "transport purpose"),
    sender_person_id: parseEntityId("person", record.sender_person_id),
    sender_membership_id: parseEntityId("membership", record.sender_membership_id),
    sender_device_id: parseEntityId("device", record.sender_device_id),
    sender_signing_key_id: parseEntityId("public-key", record.sender_signing_key_id),
    recipient_person_id: parseEntityId("person", record.recipient_person_id),
    recipient_membership_id: parseEntityId("membership", record.recipient_membership_id),
    recipient_device_id: parseEntityId("device", record.recipient_device_id),
    recipient_key_id: parseEntityId("public-key", record.recipient_key_id),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    stream_id: parseSyncV3Id("transport-stream", record.stream_id),
    stream_generation: expectUInt64(record.stream_generation, "transport stream generation"),
    bundle_sequence: sequence,
    previous_bundle_manifest_id: previous,
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: round,
    message_kind: expectEnum(record.message_kind, ["offer", "inventory", "request", "response", "confirmation"] as const, "synchronization message kind"),
    message_direction: expectEnum(record.message_direction, ["initiator_to_responder", "responder_to_initiator"] as const, "synchronization message direction"),
    payload_count: parsePositiveCount(record.payload_count, "transport payload count"),
    limit_profile_id: parseHc2LimitProfileId(record.limit_profile_id),
    crypto_suite_id: parseSuite(record.crypto_suite_id)
  });
}

export function parseTransportBindingCoreV3(value: unknown): TransportBindingCoreV3 {
  const record = expectExactRecord(value, "transport binding core v3", [
    "schema_version", "record_kind", ...commonBindingKeys, "bundle_manifest_id", "payload_kind", "payload_ordinal"
  ]);
  const common = parseTransportBindingCommonV3(pickCommonBinding(record));
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "transport binding version"),
    record_kind: expectLiteral(record.record_kind, "transport_binding_core_v3", "transport binding kind"),
    ...common,
    bundle_manifest_id: parseSyncV3Id("bundle-manifest", record.bundle_manifest_id),
    payload_kind: expectEnum(record.payload_kind, hc2SyncV3PayloadKinds, "transport payload kind"),
    payload_ordinal: parseSafeCount(record.payload_ordinal, common.payload_count - 1, "transport payload ordinal")
  });
}

export function parseBundleManifestCoreV3(value: unknown): BundleManifestCoreV3 {
  const record = expectExactRecord(value, "bundle manifest core v3", ["schema_version", "record_kind", "transport_profile_id", "common_binding", "payload_descriptors"]);
  const common = parseTransportBindingCommonV3(record.common_binding);
  const values = Array.isArray(record.payload_descriptors) ? record.payload_descriptors : null;
  if (!values || values.length === 0 || values.length >= hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("V3 manifest descriptors must be a nonempty bounded dense array.");
  const descriptors = values.map((entry, index) => {
    const value = expectExactRecord(entry, "bundle payload descriptor v3", ["payload_kind", "payload_ordinal", "payload_id", "canonical_length"]);
    const descriptor = freezeRecord({
      payload_kind: expectEnum(value.payload_kind, hc2SyncV3PayloadKinds.filter((kind) => kind !== "bundle_manifest") as readonly NonManifestTransportPayloadKindV3[], "manifest payload kind"),
      payload_ordinal: parseSafeCount(value.payload_ordinal, hc2ProtocolLimits.maximum_chunks_per_bundle - 1, "manifest payload ordinal"),
      payload_id: parseSyncV3Id("transport-payload", value.payload_id),
      canonical_length: expectUInt64(value.canonical_length, "payload canonical length")
    });
    if (descriptor.payload_ordinal !== index + 1 || descriptor.canonical_length === BigInt(0) || descriptor.canonical_length > hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes) throw new Error("Manifest payload descriptor is outside the exact ordinal or byte bound.");
    return descriptor;
  });
  if (common.payload_count !== descriptors.length + 1 || new Set(descriptors.map((entry) => entry.payload_id)).size !== descriptors.length) throw new Error("V3 manifest commitments are inconsistent or duplicated.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "manifest version"),
    record_kind: expectLiteral(record.record_kind, "bundle_manifest_core_v3", "manifest kind"),
    transport_profile_id: expectLiteral(record.transport_profile_id, HC2_SYNC_TRANSPORT_PROFILE_ID, "manifest transport profile"),
    common_binding: common,
    payload_descriptors: Object.freeze(descriptors)
  });
}

export function parseTransportPayloadCoreV3(value: unknown): TransportPayloadCoreV3 {
  const variantKeys = ["manifest_core", "offer_core", "page_core", "request_core", "response_core", "confirmation_core", "chunk_payload_core", "admission_package", "epoch_delivery", "epoch_receipt"] as const;
  const record = expectExactRecord(value, "transport payload v3", ["schema_version", "payload_kind"], variantKeys);
  const version = expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "transport payload version");
  const kind = expectEnum(record.payload_kind, hc2SyncV3PayloadKinds, "transport payload kind");
  const construct = <T extends TransportPayloadCoreV3>(selected: typeof variantKeys[number], payload: T): T => {
    for (const key of variantKeys) if ((key === selected) !== Object.prototype.hasOwnProperty.call(record, key)) throw new Error("V3 payload must contain exactly its selected variant field.");
    return freezeRecord(payload) as T;
  };
  switch (kind) {
    case "bundle_manifest": return construct("manifest_core", { schema_version: version, payload_kind: kind, manifest_core: parseBundleManifestCoreV3(record.manifest_core) });
    case "sync_offer": return construct("offer_core", { schema_version: version, payload_kind: kind, offer_core: parseSyncOfferCoreV3(record.offer_core) });
    case "inventory_page": return construct("page_core", { schema_version: version, payload_kind: kind, page_core: parseInventoryPageCoreV3(record.page_core) });
    case "object_request": return construct("request_core", { schema_version: version, payload_kind: kind, request_core: parseObjectRequestCoreV3(record.request_core) });
    case "object_response": return construct("response_core", { schema_version: version, payload_kind: kind, response_core: parseObjectResponseCoreV3(record.response_core) });
    case "sync_confirmation": return construct("confirmation_core", { schema_version: version, payload_kind: kind, confirmation_core: parseSyncConfirmationCoreV3(record.confirmation_core) });
    case "hc1_object_chunk": return construct("chunk_payload_core", { schema_version: version, payload_kind: kind, chunk_payload_core: parseChunkPayloadCore(record.chunk_payload_core) });
    case "admission_attachment": return construct("admission_package", { schema_version: version, payload_kind: kind, admission_package: parseAdmissionPackageRecord(record.admission_package) });
    case "epoch_delivery_attachment": return construct("epoch_delivery", { schema_version: version, payload_kind: kind, epoch_delivery: parseEpochDeliveryEnvelope(record.epoch_delivery) });
    case "receipt_attachment": return construct("epoch_receipt", { schema_version: version, payload_kind: kind, epoch_receipt: parseEpochReceiptRecord(record.epoch_receipt) });
  }
}

export async function deriveTransportPayloadIdentityV3(value: Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>, provider?: Sha256Provider): Promise<Readonly<{ payload: Exclude<TransportPayloadCoreV3, BundleManifestPayloadV3>; payload_id: TransportPayloadIdV3; canonical_length: UInt64 }>> {
  const payload = parseTransportPayloadCoreV3(value);
  if (payload.payload_kind === "bundle_manifest") throw new Error("Manifest uses the separate V3 identity domain.");
  const bytes = encodeTransportPayloadCoreV3(payload);
  const identity = await deriveSyncV3Identity("transport-payload", canonicalProtocolValue(payload), provider);
  return freezeRecord({ payload, payload_id: identity.id, canonical_length: BigInt(bytes.length) as UInt64 });
}

export async function deriveBundleManifestIdentityV3(value: BundleManifestCoreV3, provider?: Sha256Provider): Promise<BundleManifestIdV3> {
  const manifest = parseBundleManifestCoreV3(value);
  return (await deriveSyncV3Identity("bundle-manifest", canonicalProtocolValue(manifest), provider)).id;
}

export function parseSignedPlaintextCoreV3(value: unknown): SignedPlaintextCoreV3 {
  const record = expectExactRecord(value, "signed transport plaintext core v3", ["schema_version", "record_kind", "binding", "payload"]);
  const binding = parseTransportBindingCoreV3(record.binding);
  const payload = parseTransportPayloadCoreV3(record.payload);
  if (binding.payload_kind !== payload.payload_kind) throw new Error("V3 transport binding and payload kinds differ.");
  if (payload.payload_kind === "bundle_manifest") {
    if (binding.payload_ordinal !== 0 || !sameBytes(encodeCanonicalCbor(canonicalProtocolValue(pickCommonBinding(binding))), encodeCanonicalCbor(canonicalProtocolValue(payload.manifest_core.common_binding)))) throw new Error("V3 manifest binding mismatch.");
  } else if (binding.payload_ordinal === 0) throw new Error("Only the V3 manifest may occupy ordinal zero.");
  assertMessagePayload(binding.message_kind, payload.payload_kind);
  const parsed = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "signed transport core version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_core_v3", "signed transport core kind"),
    binding,
    payload
  });
  assertHc2EncodedLayerByteLength("signed_plaintext_core", BigInt(encodeCanonicalCbor(canonicalProtocolValue(parsed)).length));
  return parsed;
}

export function parseSignedPlaintextRecordV3(value: unknown): SignedPlaintextRecordV3 {
  const record = expectExactRecord(value, "signed transport plaintext record v3", ["record_version", "record_kind", "core", "signature_algorithm", "signature_bytes"]);
  const signature = expectBytes(record.signature_bytes, "V3 sender signature");
  if (signature.length !== 64) throw new Error("V3 Ed25519 signature must contain exactly 64 bytes.");
  return freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_SYNC_SCHEMA_VERSION, "signed transport record version"),
    record_kind: expectLiteral(record.record_kind, "signed_plaintext_record_v3", "signed transport record kind"),
    core: parseSignedPlaintextCoreV3(record.core),
    signature_algorithm: expectLiteral(record.signature_algorithm, "ed25519", "transport signature algorithm"),
    signature_bytes: signature
  });
}

export function buildTransportSignaturePreimageV3(value: SignedPlaintextCoreV3): TransportSignaturePreimageBytesV3 {
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([canonicalText(hc2SyncV3SignatureDomains.payload), canonicalProtocolValue(parseSignedPlaintextCoreV3(value))]))) as TransportSignaturePreimageBytesV3;
}

export function parsePublicEnvelopeHeaderV3(value: unknown): PublicEnvelopeHeaderV3 {
  const record = expectExactRecord(value, "public transport envelope header v3", ["magic", "envelope_version", "suite_id", "encapsulated_key_bytes", "envelope_id", "recipient_routing_tag", "chunk_ordinal", "chunk_count", "ciphertext_length"]);
  const count = parsePositiveCount(record.chunk_count, "header chunk count");
  const enc = expectBytes(record.encapsulated_key_bytes, "HPKE encapsulated key");
  const tag = expectBytes(record.recipient_routing_tag, "opaque recipient routing tag");
  if (enc.length !== 32 || tag.length !== 32) throw new Error("V3 public header cryptographic fields must contain exactly 32 bytes.");
  const length = expectUInt64(record.ciphertext_length, "ciphertext length");
  assertHc2EncodedLayerByteLength("aead_ciphertext", length);
  const parsed = freezeRecord({
    magic: expectLiteral(record.magic, HC2_ENVELOPE_MAGIC, "envelope magic"),
    envelope_version: expectLiteral(record.envelope_version, HC2_SYNC_ENVELOPE_VERSION, "transport envelope version"),
    suite_id: parseSuite(record.suite_id),
    encapsulated_key_bytes: enc,
    envelope_id: parseEnvelopeId(record.envelope_id),
    recipient_routing_tag: tag,
    chunk_ordinal: parseSafeCount(record.chunk_ordinal, count - 1, "header chunk ordinal"),
    chunk_count: count,
    ciphertext_length: length
  });
  assertHc2EncodedLayerByteLength("public_header", BigInt(encodeCanonicalCbor(canonicalProtocolValue(parsed)).length));
  return parsed;
}

export function buildTransportHpkeInfoV3(value: PublicEnvelopeHeaderV3 | Omit<PublicEnvelopeHeaderV3, "encapsulated_key_bytes" | "ciphertext_length">): TransportHpkeInfoBytesV3 {
  const candidate = "encapsulated_key_bytes" in value ? {
    magic: value.magic, envelope_version: value.envelope_version, suite_id: value.suite_id,
    envelope_id: value.envelope_id, recipient_routing_tag: value.recipient_routing_tag,
    chunk_ordinal: value.chunk_ordinal, chunk_count: value.chunk_count
  } : value;
  const record = expectExactRecord(candidate, "transport HPKE info binding v3", ["magic", "envelope_version", "suite_id", "envelope_id", "recipient_routing_tag", "chunk_ordinal", "chunk_count"]);
  const count = parsePositiveCount(record.chunk_count, "HPKE info chunk count");
  const tag = expectBytes(record.recipient_routing_tag, "HPKE info routing tag");
  if (tag.length !== 32) throw new Error("V3 HPKE info routing tag must contain exactly 32 bytes.");
  const binding = freezeRecord({
    magic: expectLiteral(record.magic, HC2_ENVELOPE_MAGIC, "HPKE info magic"),
    envelope_version: expectLiteral(record.envelope_version, HC2_SYNC_ENVELOPE_VERSION, "HPKE info envelope version"),
    suite_id: parseSuite(record.suite_id),
    envelope_id: parseEnvelopeId(record.envelope_id),
    recipient_routing_tag: tag,
    chunk_ordinal: parseSafeCount(record.chunk_ordinal, count - 1, "HPKE info chunk ordinal"),
    chunk_count: count
  });
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([canonicalText(HC2_SYNC_HPKE_INFO_DOMAIN), canonicalProtocolValue(binding)]))) as TransportHpkeInfoBytesV3;
}

export function buildTransportBoundAadV3(value: PublicEnvelopeHeaderV3): TransportBoundAadBytesV3 {
  const aad = Uint8Array.from(encodeCanonicalCbor(canonicalProtocolValue(parsePublicEnvelopeHeaderV3(value)))) as TransportBoundAadBytesV3;
  strictlyConstructedAad.add(aad);
  return aad;
}

export function isStrictlyConstructedTransportAadV3(value: unknown): value is TransportBoundAadBytesV3 { return value instanceof Uint8Array && strictlyConstructedAad.has(value); }

export function parseEncryptedContainerCoreV3(value: unknown): EncryptedContainerCoreV3 {
  const record = expectExactRecord(value, "encrypted transport container core v3", ["schema_version", "record_kind", "public_header", "ciphertext_bytes"]);
  const header = parsePublicEnvelopeHeaderV3(record.public_header);
  const ciphertext = expectBytes(record.ciphertext_bytes, "transport ciphertext");
  if (header.ciphertext_length !== BigInt(ciphertext.length)) throw new Error("V3 ciphertext length differs from the opaque header.");
  const core = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "encrypted container version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_core_v3", "encrypted container kind"),
    public_header: header,
    ciphertext_bytes: ciphertext
  });
  assertHc2EncodedLayerByteLength("encrypted_container", BigInt(encodeCanonicalCbor(canonicalProtocolValue(core)).length));
  return core;
}

export async function createEncryptedContainerRecordV3(value: EncryptedContainerCoreV3, provider?: Sha256Provider): Promise<EncryptedContainerRecordV3> {
  const core = parseEncryptedContainerCoreV3(value);
  return freezeRecord({ record_version: HC2_SYNC_SCHEMA_VERSION, record_kind: "encrypted_container_record_v3", container_id: (await deriveSyncV3Identity("encrypted-container", canonicalProtocolValue(core), provider)).id, core });
}

export async function parseEncryptedContainerRecordV3(value: unknown, provider?: Sha256Provider): Promise<EncryptedContainerRecordV3> {
  const record = expectExactRecord(value, "encrypted transport container record v3", ["record_version", "record_kind", "container_id", "core"]);
  const parsed = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_SYNC_SCHEMA_VERSION, "container record version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_record_v3", "container record kind"),
    container_id: parseSyncV3Id("encrypted-container", record.container_id),
    core: parseEncryptedContainerCoreV3(record.core)
  });
  const expected = (await deriveSyncV3Identity("encrypted-container", canonicalProtocolValue(parsed.core), provider)).id;
  if (expected !== parsed.container_id) throw new Error("V3 encrypted container identity mismatch.");
  return parsed;
}

export function encodeTransportPayloadCoreV3(value: TransportPayloadCoreV3): Uint8Array { return encodeCanonicalCbor(canonicalProtocolValue(parseTransportPayloadCoreV3(value))); }
export function decodeTransportPayloadCoreV3(value: Uint8Array): TransportPayloadCoreV3 { return parseTransportPayloadCoreV3(decodeStrict(value)); }
export function encodeSignedPlaintextRecordV3(value: SignedPlaintextRecordV3): Uint8Array { return encodeCanonicalCbor(canonicalProtocolValue(parseSignedPlaintextRecordV3(value))); }
export function decodeSignedPlaintextRecordV3(value: Uint8Array): SignedPlaintextRecordV3 { return parseSignedPlaintextRecordV3(decodeStrict(value)); }
export function encodeEncryptedContainerRecordV3(value: EncryptedContainerRecordV3): Uint8Array {
  const record = expectExactRecord(value, "encrypted transport container record v3", ["record_version", "record_kind", "container_id", "core"]);
  const parsed = freezeRecord({
    record_version: expectLiteral(record.record_version, HC2_SYNC_SCHEMA_VERSION, "container record version"),
    record_kind: expectLiteral(record.record_kind, "encrypted_container_record_v3", "container record kind"),
    container_id: parseSyncV3Id("encrypted-container", record.container_id),
    core: parseEncryptedContainerCoreV3(record.core)
  });
  return encodeCanonicalCbor(canonicalProtocolValue(parsed));
}
export async function decodeEncryptedContainerRecordV3(value: Uint8Array, provider?: Sha256Provider): Promise<EncryptedContainerRecordV3> { return parseEncryptedContainerRecordV3(decodeStrict(value), provider); }

const commonBindingKeys = [
  "transport_profile_id", "project_id", "purpose", "sender_person_id", "sender_membership_id",
  "sender_device_id", "sender_signing_key_id", "recipient_person_id", "recipient_membership_id",
  "recipient_device_id", "recipient_key_id", "accepted_control_head_id", "key_epoch_id",
  "key_epoch_commitment", "stream_id", "stream_generation", "bundle_sequence",
  "previous_bundle_manifest_id", "session_id", "session_generation", "round_number",
  "message_kind", "message_direction", "payload_count", "limit_profile_id", "crypto_suite_id"
] as const;

function pickCommonBinding(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> { return Object.fromEntries(commonBindingKeys.map((key) => [key, value[key]])); }
function parseSuite(value: unknown): typeof HC2_CRYPTO_SUITE_ID { if (value !== HC2_CRYPTO_SUITE_ID) throw new Error("Unknown HC-2 cryptographic suite."); return value; }
function parsePositiveCount(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error(`${label} exceeds the frozen bundle count bound.`); return value as number; }

function assertMessagePayload(message: SyncTransportMessageKindV3, payload: TransportPayloadKindV3): void {
  if (payload === "bundle_manifest") return;
  const allowed: Readonly<Record<SyncTransportMessageKindV3, readonly TransportPayloadKindV3[]>> = Object.freeze({
    offer: ["sync_offer"], inventory: ["inventory_page"], request: ["object_request"],
    response: ["object_response", "hc1_object_chunk", "admission_attachment", "epoch_delivery_attachment", "receipt_attachment"],
    confirmation: ["sync_confirmation"]
  });
  if (!allowed[message].includes(payload)) throw new Error("V3 message role cannot carry this payload kind.");
}

function decodeStrict(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || BigInt(bytes.length) > hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes + BigInt(1024)) throw new Error("V3 canonical bytes exceed their bound.");
  const canonical = decodeCanonicalCbor(bytes);
  if (!sameBytes(bytes, encodeCanonicalCbor(canonical))) throw new Error("V3 value is not canonical CBOR.");
  return normalizeIntegers(protocolValueFromCanonical(canonical));
}

const bigintFields = new Set(["stream_generation", "bundle_sequence", "session_generation", "round_number", "canonical_length", "ciphertext_length", "exact_byte_length", "expected_byte_length", "maximum_total_bytes", "portable_generation", "byte_length", "acknowledgement_sequence", "recipient_ordinal", "recipient_count"]);
function normalizeIntegers(value: unknown, key?: string): unknown {
  if (typeof value === "number" && key && bigintFields.has(key)) return BigInt(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeIntegers(entry));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeIntegers(child, childKey)]));
  return value;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }

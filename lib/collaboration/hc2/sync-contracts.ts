import { decodeCanonicalCbor, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type ProjectId,
  type SemanticEventId
} from "../identities.ts";
import { parseSha256Digest, type Sha256Digest } from "../sha256.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  expectArray,
  expectBoolean,
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  expectUInt64,
  freezeRecord,
  type UInt64
} from "../validation.ts";
import { hc2ProtocolLimits, parseSafeCount } from "./limits.ts";
import {
  deriveSyncV3Identity,
  parseSyncV3Id,
  type InventoryPageIdV3,
  type InventoryRootIdV3,
  type InventorySnapshotIdV3,
  type ObjectRequestIdV3,
  type ObjectResponseIdV3,
  type SyncConfirmationIdV3,
  type SyncSessionIdV3
} from "./sync-v3-identities.ts";
import {
  HC2_SYNC_SCHEMA_VERSION,
  HC2_SYNC_TRANSPORT_PROFILE_ID,
  hc2SyncInvocationLimits
} from "./sync-v3-versions.ts";
import { parseTransportV2Id, type TransportAttachmentIdV2 } from "./transport-v2-identities.ts";

export const syncStorageFamilies = ["hc1", "hc2_attachment"] as const;
export type SyncStorageFamily = (typeof syncStorageFamilies)[number];
export const syncAttachmentKinds = [
  "admission_attachment",
  "epoch_delivery_attachment",
  "receipt_attachment"
] as const;
export type SyncAttachmentKind = (typeof syncAttachmentKinds)[number];
export type SyncInventoryObjectKind = CollaborationObjectKind | SyncAttachmentKind;

export type InventoryDescriptorV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "inventory_descriptor_v3";
  authority: "none";
  storage_family: SyncStorageFamily;
  object_kind: SyncInventoryObjectKind;
  object_id: CollaborationObjectId | TransportAttachmentIdV2;
  exact_sha256: Sha256Digest;
  exact_byte_length: UInt64;
}>;

export type InventorySnapshotCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "inventory_snapshot_core_v3";
  authority: "none";
  project_id: ProjectId;
  portable_generation: UInt64;
  accepted_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  semantic_frontier: readonly SemanticEventId[];
  checkpoint_id: SemanticEventId | null;
  projection_root_id: string;
  descriptor_count: number;
  page_count: number;
  inventory_root_id: InventoryRootIdV3;
  protocol_version: string;
  reducer_version: string;
}>;

export type VerifiedInventorySnapshotV3 = Readonly<{
  snapshot_id: InventorySnapshotIdV3;
  core: InventorySnapshotCoreV3;
  descriptors: readonly InventoryDescriptorV3[];
}>;

export type InventoryPageCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "inventory_page_core_v3";
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  inventory_snapshot_id: InventorySnapshotIdV3;
  page_ordinal: number;
  page_count: number;
  first_descriptor_key: string | null;
  last_descriptor_key: string | null;
  descriptor_count: number;
  descriptors: readonly InventoryDescriptorV3[];
  page_digest: Sha256Digest;
}>;

export type InventoryPageV3 = Readonly<{
  page_id: InventoryPageIdV3;
  core: InventoryPageCoreV3;
}>;

export type SyncOfferCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "sync_offer_core_v3";
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  inventory_snapshot_id: InventorySnapshotIdV3;
  inventory_root_id: InventoryRootIdV3;
  descriptor_count: number;
  page_count: number;
  accepted_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  semantic_frontier: readonly SemanticEventId[];
  checkpoint_id: SemanticEventId | null;
  projection_root_id: string;
  supported_transport_versions: readonly [3];
  crypto_suite_id: string;
  limit_profile_id: string;
  maximum_session_rounds: number;
}>;

export type ObjectRequestItemV3 = Readonly<{
  storage_family: SyncStorageFamily;
  object_kind: SyncInventoryObjectKind;
  object_id: CollaborationObjectId | TransportAttachmentIdV2;
  expected_sha256: Sha256Digest;
  expected_byte_length: UInt64;
}>;

export type ObjectRequestCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "object_request_core_v3";
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  local_snapshot_id: InventorySnapshotIdV3;
  remote_snapshot_id: InventorySnapshotIdV3;
  request_page_ordinal: number;
  request_page_count: number;
  maximum_object_count: number;
  maximum_total_bytes: UInt64;
  dependency_policy: "required_closure";
  items: readonly ObjectRequestItemV3[];
}>;

export type ObjectRequestV3 = Readonly<{
  request_id: ObjectRequestIdV3;
  core: ObjectRequestCoreV3;
}>;

export type ObjectResponseCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "object_response_core_v3";
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  request_id: ObjectRequestIdV3;
  local_snapshot_id: InventorySnapshotIdV3;
  remote_snapshot_id: InventorySnapshotIdV3;
  included_descriptors: readonly InventoryDescriptorV3[];
  unavailable_descriptor_keys: readonly string[];
  continuation_required: boolean;
  continuation_after_key: string | null;
}>;

export type ObjectResponseV3 = Readonly<{
  response_id: ObjectResponseIdV3;
  core: ObjectResponseCoreV3;
}>;

export type ReconstructionCommitmentsV3 = Readonly<{
  accepted_object_set_commitment: string;
  semantic_frontier: readonly SemanticEventId[];
  accepted_semantic_set_commitment: string;
  accepted_control_set_commitment: string;
  accepted_control_head_id: ControlEventId;
  authority_state_commitment: string;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  canonical_projection_commitment: string;
  revision_heads_root_id: string;
  conflict_root_id: string;
  tombstone_root_id: string;
  reducer_rejection_root_id: string;
  component_roots_commitment: string;
  projection_root_id: string;
  checkpoint_id: SemanticEventId | null;
  shared_state_commitment: string | null;
  acknowledgement_receipt_commitment: string;
  protocol_version: string;
  reducer_version: string;
}>;

export type SyncConfirmationCoreV3 = Readonly<{
  schema_version: typeof HC2_SYNC_SCHEMA_VERSION;
  record_kind: "sync_confirmation_core_v3";
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  inventory_snapshot_id: InventorySnapshotIdV3;
  inventory_root_id: InventoryRootIdV3;
  inventory_descriptor_count: number;
  reconstruction: ReconstructionCommitmentsV3;
}>;

export type SyncConfirmationV3 = Readonly<{
  confirmation_id: SyncConfirmationIdV3;
  core: SyncConfirmationCoreV3;
}>;

export function inventoryDescriptorKey(value: InventoryDescriptorV3): string {
  const descriptor = parseInventoryDescriptorV3(value);
  return `${descriptor.storage_family}\u0000${descriptor.object_kind}\u0000${descriptor.object_id}`;
}

export function parseInventoryDescriptorV3(value: unknown): InventoryDescriptorV3 {
  const record = expectExactRecord(value, "inventory descriptor v3", [
    "schema_version", "record_kind", "authority", "storage_family",
    "object_kind", "object_id", "exact_sha256", "exact_byte_length"
  ]);
  const family = expectEnum(record.storage_family, syncStorageFamilies, "inventory storage family");
  const kind = family === "hc1"
    ? parseCollaborationObjectKind(record.object_kind)
    : expectEnum(record.object_kind, syncAttachmentKinds, "inventory attachment kind");
  const id = family === "hc1"
    ? parseCollaborationObjectId(kind as CollaborationObjectKind, record.object_id)
    : parseTransportV2Id("transport-attachment", record.object_id);
  const length = expectUInt64(record.exact_byte_length, "inventory exact byte length");
  if (length === BigInt(0) || length > hc2ProtocolLimits.maximum_canonical_object_bytes) {
    throw new Error("Inventory exact byte length is outside the portable object bound.");
  }
  const parsed = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "inventory descriptor version"),
    record_kind: expectLiteral(record.record_kind, "inventory_descriptor_v3", "inventory descriptor kind"),
    authority: expectLiteral(record.authority, "none", "inventory authority"),
    storage_family: family,
    object_kind: kind,
    object_id: id,
    exact_sha256: parseSha256Digest(expectBytes(record.exact_sha256, "inventory exact SHA-256")),
    exact_byte_length: length
  });
  return parsed;
}

export function parseInventorySnapshotCoreV3(value: unknown): InventorySnapshotCoreV3 {
  const record = expectExactRecord(value, "inventory snapshot core v3", [
    "schema_version", "record_kind", "authority", "project_id",
    "portable_generation", "accepted_control_head_id", "key_epoch_id",
    "key_epoch_commitment", "semantic_frontier", "checkpoint_id",
    "projection_root_id", "descriptor_count", "page_count",
    "inventory_root_id", "protocol_version", "reducer_version"
  ]);
  const parsed = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "inventory snapshot version"),
    record_kind: expectLiteral(record.record_kind, "inventory_snapshot_core_v3", "inventory snapshot kind"),
    authority: expectLiteral(record.authority, "none", "inventory snapshot authority"),
    project_id: parseEntityId("project", record.project_id),
    portable_generation: expectUInt64(record.portable_generation, "portable generation"),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    semantic_frontier: parseSemanticFrontier(record.semantic_frontier),
    checkpoint_id: record.checkpoint_id === null ? null : parseDigestId("semantic-event", record.checkpoint_id),
    projection_root_id: parseNamedDigest("projection-root", record.projection_root_id),
    descriptor_count: parseBoundedCount(record.descriptor_count, Number.MAX_SAFE_INTEGER, "snapshot descriptor count", true),
    page_count: parseBoundedCount(record.page_count, Number.MAX_SAFE_INTEGER, "snapshot page count", true),
    inventory_root_id: parseSyncV3Id("inventory-root", record.inventory_root_id),
    protocol_version: parseToken(record.protocol_version, "protocol version"),
    reducer_version: parseToken(record.reducer_version, "reducer version")
  });
  return parsed;
}

export function parseInventoryPageCoreV3(value: unknown): InventoryPageCoreV3 {
  const record = expectExactRecord(value, "inventory page core v3", [
    "schema_version", "record_kind", "authority", "session_id",
    "session_generation", "round_number", "inventory_snapshot_id",
    "page_ordinal", "page_count", "first_descriptor_key",
    "last_descriptor_key", "descriptor_count", "descriptors", "page_digest"
  ]);
  const descriptors = parseDescriptorArray(record.descriptors, hc2SyncInvocationLimits.maximum_descriptors_per_page);
  const count = parseBoundedCount(record.page_count, Number.MAX_SAFE_INTEGER, "inventory page count");
  const ordinal = parseSafeCount(record.page_ordinal, count - 1, "inventory page ordinal");
  const first = parseNullableKey(record.first_descriptor_key, "first descriptor key");
  const last = parseNullableKey(record.last_descriptor_key, "last descriptor key");
  if (descriptors.length === 0 ? first !== null || last !== null : first !== inventoryDescriptorKey(descriptors[0]) || last !== inventoryDescriptorKey(descriptors.at(-1)!)) {
    throw new Error("Inventory page descriptor boundaries do not match its contents.");
  }
  const parsed = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "inventory page version"),
    record_kind: expectLiteral(record.record_kind, "inventory_page_core_v3", "inventory page kind"),
    authority: expectLiteral(record.authority, "none", "inventory page authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: parseRound(record.round_number),
    inventory_snapshot_id: parseSyncV3Id("inventory-snapshot", record.inventory_snapshot_id),
    page_ordinal: ordinal,
    page_count: count,
    first_descriptor_key: first,
    last_descriptor_key: last,
    descriptor_count: expectExactCount(record.descriptor_count, descriptors.length, "inventory page descriptor count"),
    descriptors,
    page_digest: parseSha256Digest(expectBytes(record.page_digest, "inventory page digest"))
  });
  if (BigInt(encodeSyncProtocolValueV3(parsed).length) > hc2SyncInvocationLimits.maximum_page_canonical_bytes) throw new Error("Inventory page exceeds its exact canonical byte bound.");
  return parsed;
}

export function parseSyncOfferCoreV3(value: unknown): SyncOfferCoreV3 {
  const record = expectExactRecord(value, "synchronization offer core v3", [
    "schema_version", "record_kind", "authority", "session_id", "session_generation",
    "round_number", "inventory_snapshot_id", "inventory_root_id", "descriptor_count",
    "page_count", "accepted_control_head_id", "key_epoch_id", "key_epoch_commitment",
    "semantic_frontier", "checkpoint_id", "projection_root_id",
    "supported_transport_versions", "crypto_suite_id", "limit_profile_id",
    "maximum_session_rounds"
  ]);
  const versions = expectArray(record.supported_transport_versions, "supported transport versions");
  if (versions.length !== 1 || versions[0] !== 3) throw new Error("Synchronization v3 requires the exact [3] transport negotiation.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "sync offer version"),
    record_kind: expectLiteral(record.record_kind, "sync_offer_core_v3", "sync offer kind"),
    authority: expectLiteral(record.authority, "none", "sync offer authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: parseRound(record.round_number),
    inventory_snapshot_id: parseSyncV3Id("inventory-snapshot", record.inventory_snapshot_id),
    inventory_root_id: parseSyncV3Id("inventory-root", record.inventory_root_id),
    descriptor_count: parseBoundedCount(record.descriptor_count, Number.MAX_SAFE_INTEGER, "offer descriptor count", true),
    page_count: parseBoundedCount(record.page_count, Number.MAX_SAFE_INTEGER, "offer page count", true),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    semantic_frontier: parseSemanticFrontier(record.semantic_frontier),
    checkpoint_id: record.checkpoint_id === null ? null : parseDigestId("semantic-event", record.checkpoint_id),
    projection_root_id: parseNamedDigest("projection-root", record.projection_root_id),
    supported_transport_versions: Object.freeze([3] as const),
    crypto_suite_id: parseToken(record.crypto_suite_id, "crypto suite"),
    limit_profile_id: parseToken(record.limit_profile_id, "limit profile"),
    maximum_session_rounds: expectExactCount(record.maximum_session_rounds, hc2SyncInvocationLimits.maximum_session_rounds, "maximum session rounds")
  });
}

export function parseObjectRequestItemV3(value: unknown): ObjectRequestItemV3 {
  const record = expectExactRecord(value, "object request item v3", [
    "storage_family", "object_kind", "object_id", "expected_sha256", "expected_byte_length"
  ]);
  const descriptor = parseInventoryDescriptorV3({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "inventory_descriptor_v3",
    authority: "none",
    storage_family: record.storage_family,
    object_kind: record.object_kind,
    object_id: record.object_id,
    exact_sha256: record.expected_sha256,
    exact_byte_length: record.expected_byte_length
  });
  return freezeRecord({
    storage_family: descriptor.storage_family,
    object_kind: descriptor.object_kind,
    object_id: descriptor.object_id,
    expected_sha256: descriptor.exact_sha256,
    expected_byte_length: descriptor.exact_byte_length
  });
}

export function parseObjectRequestCoreV3(value: unknown): ObjectRequestCoreV3 {
  const record = expectExactRecord(value, "object request core v3", [
    "schema_version", "record_kind", "authority", "session_id", "session_generation",
    "round_number", "local_snapshot_id", "remote_snapshot_id", "request_page_ordinal",
    "request_page_count", "maximum_object_count", "maximum_total_bytes",
    "dependency_policy", "items"
  ]);
  const items = expectArray(record.items, "object request items").map(parseObjectRequestItemV3);
  if (items.length === 0 || items.length > hc2SyncInvocationLimits.maximum_request_items) throw new Error("Object request items exceed the explicit bound.");
  assertStrictItemOrder(items);
  const count = parseBoundedCount(record.request_page_count, hc2SyncInvocationLimits.maximum_requests_processed, "request page count");
  const maxObjects = parseBoundedCount(record.maximum_object_count, hc2SyncInvocationLimits.maximum_objects_returned, "request object budget");
  const maxBytes = expectUInt64(record.maximum_total_bytes, "request byte budget");
  if (maxBytes === BigInt(0) || maxBytes > hc2SyncInvocationLimits.maximum_response_object_bytes) throw new Error("Request byte budget exceeds the explicit invocation bound.");
  if (items.length > maxObjects) throw new Error("Request items exceed their declared object budget.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "object request version"),
    record_kind: expectLiteral(record.record_kind, "object_request_core_v3", "object request kind"),
    authority: expectLiteral(record.authority, "none", "object request authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: parseRound(record.round_number),
    local_snapshot_id: parseSyncV3Id("inventory-snapshot", record.local_snapshot_id),
    remote_snapshot_id: parseSyncV3Id("inventory-snapshot", record.remote_snapshot_id),
    request_page_ordinal: parseSafeCount(record.request_page_ordinal, count - 1, "request page ordinal"),
    request_page_count: count,
    maximum_object_count: maxObjects,
    maximum_total_bytes: maxBytes,
    dependency_policy: expectLiteral(record.dependency_policy, "required_closure", "request dependency policy"),
    items: Object.freeze(items)
  });
}

export function parseObjectResponseCoreV3(value: unknown): ObjectResponseCoreV3 {
  const record = expectExactRecord(value, "object response core v3", [
    "schema_version", "record_kind", "authority", "session_id", "session_generation",
    "round_number", "request_id", "local_snapshot_id", "remote_snapshot_id",
    "included_descriptors", "unavailable_descriptor_keys", "continuation_required",
    "continuation_after_key"
  ]);
  const descriptors = parseDescriptorArray(record.included_descriptors, hc2SyncInvocationLimits.maximum_objects_returned);
  const unavailable = parseSortedKeys(record.unavailable_descriptor_keys, "unavailable descriptor keys");
  const continuation = expectBoolean(record.continuation_required, "response continuation flag");
  const after = parseNullableKey(record.continuation_after_key, "response continuation key");
  if (continuation !== (after !== null)) throw new Error("A response continuation flag and key must appear together.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "object response version"),
    record_kind: expectLiteral(record.record_kind, "object_response_core_v3", "object response kind"),
    authority: expectLiteral(record.authority, "none", "object response authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: parseRound(record.round_number),
    request_id: parseSyncV3Id("object-request", record.request_id),
    local_snapshot_id: parseSyncV3Id("inventory-snapshot", record.local_snapshot_id),
    remote_snapshot_id: parseSyncV3Id("inventory-snapshot", record.remote_snapshot_id),
    included_descriptors: descriptors,
    unavailable_descriptor_keys: unavailable,
    continuation_required: continuation,
    continuation_after_key: after
  });
}

export function parseReconstructionCommitmentsV3(value: unknown): ReconstructionCommitmentsV3 {
  const record = expectExactRecord(value, "reconstruction commitments v3", [
    "accepted_object_set_commitment", "semantic_frontier", "accepted_semantic_set_commitment",
    "accepted_control_set_commitment", "accepted_control_head_id", "authority_state_commitment",
    "key_epoch_id", "key_epoch_commitment", "canonical_projection_commitment",
    "revision_heads_root_id", "conflict_root_id", "tombstone_root_id",
    "reducer_rejection_root_id", "component_roots_commitment", "projection_root_id",
    "checkpoint_id", "shared_state_commitment", "acknowledgement_receipt_commitment",
    "protocol_version", "reducer_version"
  ]);
  return freezeRecord({
    accepted_object_set_commitment: parseCommitment(record.accepted_object_set_commitment, "accepted object set"),
    semantic_frontier: parseSemanticFrontier(record.semantic_frontier),
    accepted_semantic_set_commitment: parseCommitment(record.accepted_semantic_set_commitment, "accepted semantic set"),
    accepted_control_set_commitment: parseCommitment(record.accepted_control_set_commitment, "accepted control set"),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    authority_state_commitment: parseCommitment(record.authority_state_commitment, "authority state"),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment),
    canonical_projection_commitment: parseCommitment(record.canonical_projection_commitment, "canonical projection"),
    revision_heads_root_id: parseNamedDigest("revision-heads-root", record.revision_heads_root_id),
    conflict_root_id: parseNamedDigest("conflict-set-root", record.conflict_root_id),
    tombstone_root_id: parseCommitment(record.tombstone_root_id, "tombstone root"),
    reducer_rejection_root_id: parseCommitment(record.reducer_rejection_root_id, "reducer rejection root"),
    component_roots_commitment: parseCommitment(record.component_roots_commitment, "component roots"),
    projection_root_id: parseNamedDigest("projection-root", record.projection_root_id),
    checkpoint_id: record.checkpoint_id === null ? null : parseDigestId("semantic-event", record.checkpoint_id),
    shared_state_commitment: record.shared_state_commitment === null ? null : parseCommitment(record.shared_state_commitment, "shared state"),
    acknowledgement_receipt_commitment: parseCommitment(record.acknowledgement_receipt_commitment, "acknowledgement and receipt"),
    protocol_version: parseToken(record.protocol_version, "protocol version"),
    reducer_version: parseToken(record.reducer_version, "reducer version")
  });
}

export function parseSyncConfirmationCoreV3(value: unknown): SyncConfirmationCoreV3 {
  const record = expectExactRecord(value, "sync confirmation core v3", [
    "schema_version", "record_kind", "authority", "session_id", "session_generation",
    "round_number", "inventory_snapshot_id", "inventory_root_id",
    "inventory_descriptor_count", "reconstruction"
  ]);
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_SYNC_SCHEMA_VERSION, "sync confirmation version"),
    record_kind: expectLiteral(record.record_kind, "sync_confirmation_core_v3", "sync confirmation kind"),
    authority: expectLiteral(record.authority, "none", "sync confirmation authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "session generation"),
    round_number: parseRound(record.round_number),
    inventory_snapshot_id: parseSyncV3Id("inventory-snapshot", record.inventory_snapshot_id),
    inventory_root_id: parseSyncV3Id("inventory-root", record.inventory_root_id),
    inventory_descriptor_count: parseBoundedCount(record.inventory_descriptor_count, Number.MAX_SAFE_INTEGER, "confirmation descriptor count", true),
    reconstruction: parseReconstructionCommitmentsV3(record.reconstruction)
  });
}

export async function identifyInventorySnapshotV3(core: InventorySnapshotCoreV3): Promise<InventorySnapshotIdV3> {
  return (await deriveSyncV3Identity("inventory-snapshot", canonicalProtocolValue(parseInventorySnapshotCoreV3(core)))).id;
}

export async function identifyInventoryPageV3(core: InventoryPageCoreV3): Promise<InventoryPageV3> {
  const parsed = parseInventoryPageCoreV3(core);
  return freezeRecord({ page_id: (await deriveSyncV3Identity("inventory-page", canonicalProtocolValue(parsed))).id, core: parsed });
}

export async function identifyObjectRequestV3(core: ObjectRequestCoreV3): Promise<ObjectRequestV3> {
  const parsed = parseObjectRequestCoreV3(core);
  return freezeRecord({ request_id: (await deriveSyncV3Identity("object-request", canonicalProtocolValue(parsed))).id, core: parsed });
}

export async function identifyObjectResponseV3(core: ObjectResponseCoreV3): Promise<ObjectResponseV3> {
  const parsed = parseObjectResponseCoreV3(core);
  return freezeRecord({ response_id: (await deriveSyncV3Identity("object-response", canonicalProtocolValue(parsed))).id, core: parsed });
}

export async function identifySyncConfirmationV3(core: SyncConfirmationCoreV3): Promise<SyncConfirmationV3> {
  const parsed = parseSyncConfirmationCoreV3(core);
  return freezeRecord({ confirmation_id: (await deriveSyncV3Identity("sync-confirmation", canonicalProtocolValue(parsed))).id, core: parsed });
}

export function encodeSyncProtocolValueV3(value: unknown): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(value));
}

export function decodeSyncProtocolValueV3(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || BigInt(bytes.length) > hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes) {
    throw new Error("Synchronization value exceeds its encoded bound.");
  }
  const canonical = decodeCanonicalCbor(bytes);
  const reencoded = encodeCanonicalCbor(canonical);
  if (!sameBytes(bytes, reencoded)) throw new Error("Synchronization value must use deterministic canonical CBOR.");
  return protocolValueFromCanonical(canonical);
}

export function assertSyncProfileV3(value: unknown): typeof HC2_SYNC_TRANSPORT_PROFILE_ID {
  return expectLiteral(value, HC2_SYNC_TRANSPORT_PROFILE_ID, "synchronization transport profile");
}

function parseDescriptorArray(value: unknown, maximum: number): readonly InventoryDescriptorV3[] {
  const values = expectArray(value, "inventory descriptors");
  if (values.length > maximum) throw new Error("Inventory descriptor array exceeds its bound.");
  const descriptors = values.map(parseInventoryDescriptorV3);
  for (let index = 1; index < descriptors.length; index += 1) {
    if (inventoryDescriptorKey(descriptors[index - 1]) >= inventoryDescriptorKey(descriptors[index])) {
      throw new Error("Inventory descriptors must be strictly canonically ordered and unique.");
    }
  }
  return Object.freeze(descriptors);
}

function parseSemanticFrontier(value: unknown): readonly SemanticEventId[] {
  const values = expectArray(value, "semantic frontier").map((entry) => parseDigestId("semantic-event", entry));
  if (values.length > hc2ProtocolLimits.maximum_objects_per_chunk) throw new Error("Semantic frontier exceeds its bound.");
  for (let index = 1; index < values.length; index += 1) if (values[index - 1] >= values[index]) throw new Error("Semantic frontier must be sorted and unique.");
  return Object.freeze(values);
}

function assertStrictItemOrder(items: readonly ObjectRequestItemV3[]): void {
  const keys = items.map((entry) => `${entry.storage_family}\u0000${entry.object_kind}\u0000${entry.object_id}`);
  for (let index = 1; index < keys.length; index += 1) if (keys[index - 1] >= keys[index]) throw new Error("Object request items must be strictly ordered and unique.");
}

function parseSortedKeys(value: unknown, label: string): readonly string[] {
  const values = expectArray(value, label).map((entry) => expectNonEmptyString(entry, label));
  for (let index = 1; index < values.length; index += 1) if (values[index - 1] >= values[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  return Object.freeze(values);
}

function parseRound(value: unknown): UInt64 {
  const round = expectUInt64(value, "synchronization round");
  if (round === BigInt(0) || round > BigInt(hc2SyncInvocationLimits.maximum_session_rounds)) throw new Error("Synchronization round exceeds its bound.");
  return round;
}

function parseBoundedCount(value: unknown, maximum: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > maximum) throw new Error(`${label} is outside its bound.`);
  return value as number;
}

function expectExactCount(value: unknown, expected: number, label: string): number {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return expected;
}

function parseNullableKey(value: unknown, label: string): string | null {
  return value === null ? null : expectNonEmptyString(value, label);
}

function parseToken(value: unknown, label: string): string {
  const token = expectNonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(token)) throw new Error(`${label} must be a bounded protocol token.`);
  return token;
}

function parseNamedDigest(kind: "projection-root" | "revision-heads-root" | "conflict-set-root", value: unknown): string {
  return parseDigestId(kind, value);
}

function parseCommitment(value: unknown, label: string): string {
  const text = expectNonEmptyString(value, `${label} commitment`);
  if (!/^pm:[a-z0-9-]+:v[1-9][0-9]*:[a-z2-7]{52}$/.test(text)) throw new Error(`${label} commitment must be a strict content identity.`);
  return text;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

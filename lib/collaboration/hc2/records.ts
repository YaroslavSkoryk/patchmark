import {
  canonicalArray,
  canonicalText,
  encodeCanonicalCbor,
} from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type DeviceId,
  type ProjectId,
  type ProjectionRootId,
  type SemanticEventId
} from "../identities.ts";
import { parseSha256Digest, sha256, type Sha256Digest, type Sha256Provider } from "../sha256.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  expectArray,
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  expectUInt64,
  freezeRecord
} from "../validation.ts";
import {
  deriveHc2Identity,
  parseHc2DigestId,
  parseOperationId,
  type ObjectCommitMarkerId,
  type OperationId,
  type PortableBatchId,
  type RecoveryEnvelopeId,
  type TransactionIntentCommitmentId,
  type WriterContinuityId
} from "./identities.ts";
import { assertDenseArray, hc2ProtocolLimits } from "./limits.ts";
import {
  HC2_BATCH_SCHEMA_VERSION,
  HC2_MATERIALIZATION_SCHEMA_VERSION,
  HC2_REPLICA_SCHEMA_VERSION,
  HC2_TRANSACTION_INTENT_SCHEMA_VERSION,
  HC2_WRITER_CONTINUITY_SCHEMA_VERSION,
  hc2HashDomains,
  hc2SignatureDomains
} from "./versions.ts";

export type ReplicaMetadataCore = Readonly<{
  schema_version: typeof HC2_REPLICA_SCHEMA_VERSION;
  record_kind: "portable_replica_metadata";
  project_id: ProjectId;
  collaboration_schema_version: 1;
  storage_schema_version: 1;
  addressing_version: 1;
  protocol_name: "patchmark.human-collaboration";
  protocol_version: 1;
  bootstrap_control_event_id: ControlEventId;
  at_rest_disclosure_version: 1;
  recovery_policy: "mandatory_before_collaboration";
}>;

export function parseReplicaMetadataCore(value: unknown): ReplicaMetadataCore {
  const record = expectExactRecord(value, "replica metadata core", [
    "schema_version", "record_kind", "project_id", "collaboration_schema_version",
    "storage_schema_version", "addressing_version", "protocol_name", "protocol_version",
    "bootstrap_control_event_id", "at_rest_disclosure_version", "recovery_policy"
  ]);
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_REPLICA_SCHEMA_VERSION, "replica schema version"),
    record_kind: expectLiteral(record.record_kind, "portable_replica_metadata", "replica record kind"),
    project_id: parseEntityId("project", record.project_id),
    collaboration_schema_version: expectLiteral(record.collaboration_schema_version, 1, "collaboration schema version"),
    storage_schema_version: expectLiteral(record.storage_schema_version, 1, "storage schema version"),
    addressing_version: expectLiteral(record.addressing_version, 1, "addressing version"),
    protocol_name: expectLiteral(record.protocol_name, "patchmark.human-collaboration", "protocol name"),
    protocol_version: expectLiteral(record.protocol_version, 1, "protocol version"),
    bootstrap_control_event_id: parseDigestId("control-event", record.bootstrap_control_event_id),
    at_rest_disclosure_version: expectLiteral(record.at_rest_disclosure_version, 1, "at-rest disclosure version"),
    recovery_policy: expectLiteral(record.recovery_policy, "mandatory_before_collaboration", "recovery policy")
  });
}

export function encodeReplicaMetadataCore(value: ReplicaMetadataCore): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(parseReplicaMetadataCore(value)));
}

export type RecoveryRecipientEpochEnvelopeCore = Readonly<{
  schema_version: 1;
  record_kind: "recovery_recipient_epoch_envelope";
  project_id: ProjectId;
  key_epoch_id: import("../identities.ts").KeyEpochId;
  recipient_kind: "person_recovery_key";
  recipient_key_id: import("../identities.ts").PublicKeyId;
  suite_id: "patchmark/hc2/crypto-suite/v1";
  encrypted_epoch_bytes: Uint8Array;
  authority: "portable_encrypted_recovery";
}>;

export async function deriveRecoveryRecipientEpochEnvelope(
  value: RecoveryRecipientEpochEnvelopeCore,
  provider?: Sha256Provider
): Promise<Readonly<{ core: RecoveryRecipientEpochEnvelopeCore; envelope_id: RecoveryEnvelopeId }>> {
  const core = parseRecoveryRecipientEpochEnvelopeCore(value);
  const identity = await deriveHc2Identity("recovery-envelope", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, envelope_id: identity.id });
}

export function parseRecoveryRecipientEpochEnvelopeCore(value: unknown): RecoveryRecipientEpochEnvelopeCore {
  const record = expectExactRecord(value, "recovery-recipient epoch envelope", [
    "schema_version", "record_kind", "project_id", "key_epoch_id", "recipient_kind",
    "recipient_key_id", "suite_id", "encrypted_epoch_bytes", "authority"
  ]);
  const encrypted = expectBytes(record.encrypted_epoch_bytes, "encrypted epoch bytes");
  if (encrypted.length === 0 || BigInt(encrypted.length) > hc2ProtocolLimits.maximum_canonical_object_bytes) {
    throw new Error("Encrypted epoch bytes are outside the HC-2 object limit.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, 1, "recovery envelope schema version"),
    record_kind: expectLiteral(record.record_kind, "recovery_recipient_epoch_envelope", "recovery envelope kind"),
    project_id: parseEntityId("project", record.project_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    recipient_kind: expectLiteral(record.recipient_kind, "person_recovery_key", "recovery recipient kind"),
    recipient_key_id: parseEntityId("public-key", record.recipient_key_id),
    suite_id: expectLiteral(record.suite_id, "patchmark/hc2/crypto-suite/v1", "recovery envelope suite"),
    encrypted_epoch_bytes: Uint8Array.from(encrypted),
    authority: expectLiteral(record.authority, "portable_encrypted_recovery", "recovery envelope authority")
  });
}

export type ObjectCommitMarkerCore = Readonly<{
  schema_version: 1;
  record_kind: "portable_object_commit_marker";
  project_id: ProjectId;
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  stored_length: bigint;
  stored_sha256: Sha256Digest;
}>;

export type ObjectCommitMarkerRecord = Readonly<{
  core: ObjectCommitMarkerCore;
  marker_id: ObjectCommitMarkerId;
}>;

export async function createObjectCommitMarker(
  value: Omit<ObjectCommitMarkerCore, "schema_version" | "record_kind" | "stored_length" | "stored_sha256"> & {
    exact_stored_bytes: Uint8Array;
  },
  provider?: Sha256Provider
): Promise<ObjectCommitMarkerRecord> {
  expectExactRecord(value, "object commit marker input", [
    "project_id", "object_kind", "object_id", "exact_stored_bytes"
  ]);
  if (!(value.exact_stored_bytes instanceof Uint8Array)) {
    throw new Error("Object commit bytes must be a Uint8Array.");
  }
  if (BigInt(value.exact_stored_bytes.byteLength) > hc2ProtocolLimits.maximum_canonical_object_bytes) {
    throw new Error("Object commit bytes exceed the HC-2 object limit.");
  }
  const core = parseObjectCommitMarkerCore({
    schema_version: 1,
    record_kind: "portable_object_commit_marker",
    project_id: value.project_id,
    object_kind: value.object_kind,
    object_id: value.object_id,
    stored_length: BigInt(value.exact_stored_bytes.byteLength),
    stored_sha256: await sha256(value.exact_stored_bytes, provider)
  });
  const identity = await deriveHc2Identity("object-commit-marker", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, marker_id: identity.id });
}

export function parseObjectCommitMarkerCore(value: unknown): ObjectCommitMarkerCore {
  const record = expectExactRecord(value, "object commit marker core", [
    "schema_version", "record_kind", "project_id", "object_kind", "object_id", "stored_length", "stored_sha256"
  ]);
  const kind = parseCollaborationObjectKind(record.object_kind);
  const length = expectUInt64(record.stored_length, "stored object length");
  if (length > hc2ProtocolLimits.maximum_canonical_object_bytes) {
    throw new Error("Stored object length exceeds the HC-2 object limit.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, 1, "object marker schema version"),
    record_kind: expectLiteral(record.record_kind, "portable_object_commit_marker", "object marker kind"),
    project_id: parseEntityId("project", record.project_id),
    object_kind: kind,
    object_id: parseCollaborationObjectId(kind, record.object_id),
    stored_length: length,
    stored_sha256: parseSha256Digest(expectBytes(record.stored_sha256, "stored object SHA-256"))
  });
}

export type PlannedObject = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  signed_bytes_commitment: Sha256Digest;
}>;

export type TransactionIntentCore = Readonly<{
  schema_version: typeof HC2_TRANSACTION_INTENT_SCHEMA_VERSION;
  record_kind: "transaction_intent";
  project_id: ProjectId;
  device_id: DeviceId;
  operation_id: OperationId;
  expected_generation: bigint;
  expected_sequence: bigint | null;
  expected_previous_object_id: CollaborationObjectId | null;
  planned_objects: readonly PlannedObject[];
  intended_batch_id: PortableBatchId;
  state: "planned" | "pending";
  authority: "local_transactional_only";
}>;

export async function deriveTransactionIntentCommitment(
  value: TransactionIntentCore,
  provider?: Sha256Provider
): Promise<Readonly<{ core: TransactionIntentCore; commitment_id: TransactionIntentCommitmentId; canonical_preimage_bytes: Uint8Array }>> {
  const core = parseTransactionIntentCore(value);
  const identity = await deriveHc2Identity("transaction-intent", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, commitment_id: identity.id, canonical_preimage_bytes: identity.canonical_preimage_bytes });
}

export function parseTransactionIntentCore(value: unknown): TransactionIntentCore {
  const record = expectExactRecord(value, "transaction intent core", [
    "schema_version", "record_kind", "project_id", "device_id", "operation_id",
    "expected_generation", "expected_sequence", "expected_previous_object_id",
    "planned_objects", "intended_batch_id", "state", "authority"
  ]);
  const planned = parseSortedObjects(record.planned_objects, "planned objects", (entry) => {
    const item = expectExactRecord(entry, "planned object", ["object_kind", "object_id", "signed_bytes_commitment"]);
    const kind = parseCollaborationObjectKind(item.object_kind);
    return freezeRecord({
      object_kind: kind,
      object_id: parseCollaborationObjectId(kind, item.object_id),
      signed_bytes_commitment: parseSha256Digest(expectBytes(item.signed_bytes_commitment, "signed bytes commitment"))
    });
  });
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_TRANSACTION_INTENT_SCHEMA_VERSION, "transaction intent schema version"),
    record_kind: expectLiteral(record.record_kind, "transaction_intent", "transaction intent kind"),
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    operation_id: parseOperationId(record.operation_id),
    expected_generation: expectUInt64(record.expected_generation, "expected stream generation"),
    expected_sequence: record.expected_sequence === null ? null : expectUInt64(record.expected_sequence, "expected device sequence"),
    expected_previous_object_id: record.expected_previous_object_id === null ? null : parseAnyStoredObjectId(record.expected_previous_object_id),
    planned_objects: planned,
    intended_batch_id: parseHc2DigestId("portable-batch", record.intended_batch_id),
    state: expectEnum(record.state, ["planned", "pending"] as const, "transaction state"),
    authority: expectLiteral(record.authority, "local_transactional_only", "transaction authority")
  });
}

export type PortableBatchObjectEntry = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  stored_length: bigint;
  stored_sha256: Sha256Digest;
  dependency_ids: readonly CollaborationObjectId[];
  object_commit_marker_id: ObjectCommitMarkerId;
}>;

export type PortableBatchMarkerCore = Readonly<{
  schema_version: typeof HC2_BATCH_SCHEMA_VERSION;
  record_kind: "portable_batch_marker";
  project_id: ProjectId;
  predecessor_batch_id: PortableBatchId | null;
  object_entries: readonly PortableBatchObjectEntry[];
  batch_root: Sha256Digest;
  writer_continuity_id: WriterContinuityId | null;
  storage_schema_version: 1;
  protocol_version: 1;
  recovery_policy: "mandatory_before_collaboration";
}>;

export type PortableBatchMarkerRecord = Readonly<{
  core: PortableBatchMarkerCore;
  batch_id: PortableBatchId;
}>;

export type PortableBatchVisibilityResult =
  | Readonly<{ status: "visible"; marker: PortableBatchMarkerRecord }>
  | Readonly<{
      status: "invisible";
      reason: "marker_invalid" | "object_missing" | "object_corrupt" | "object_marker_missing" | "object_marker_invalid" | "dependency_missing" | "dependency_corrupt";
      object_id?: CollaborationObjectId;
    }>;

/** Slice 2 implements this against exact folder bytes; no implementation exists in Slice 1. */
export interface PortableBatchVisibilityVerifier {
  verifyCompleteBatch(marker: PortableBatchMarkerRecord): Promise<PortableBatchVisibilityResult>;
}

export async function createPortableBatchMarker(
  value: Omit<PortableBatchMarkerCore, "schema_version" | "record_kind" | "batch_root">,
  provider?: Sha256Provider
): Promise<PortableBatchMarkerRecord> {
  expectExactRecord(value, "portable batch marker input", [
    "project_id", "predecessor_batch_id", "object_entries", "writer_continuity_id",
    "storage_schema_version", "protocol_version", "recovery_policy"
  ]);
  const withoutRoot = parsePortableBatchFields(value);
  const root = await deriveBatchObjectRoot(withoutRoot.object_entries, provider);
  const core = parsePortableBatchMarkerCore({
    schema_version: HC2_BATCH_SCHEMA_VERSION,
    record_kind: "portable_batch_marker",
    ...withoutRoot,
    batch_root: root
  });
  const identity = await deriveHc2Identity("portable-batch", canonicalProtocolValue(core), provider);
  return freezeRecord({ core, batch_id: identity.id });
}

export async function verifyPortableBatchMarker(
  record: PortableBatchMarkerRecord,
  provider?: Sha256Provider
): Promise<boolean> {
  const core = parsePortableBatchMarkerCore(record.core);
  const expectedRoot = await deriveBatchObjectRoot(core.object_entries, provider);
  if (!equalBytes(expectedRoot, core.batch_root)) return false;
  const identity = await deriveHc2Identity("portable-batch", canonicalProtocolValue(core), provider);
  return identity.id === parseHc2DigestId("portable-batch", record.batch_id);
}

export function parsePortableBatchMarkerCore(value: unknown): PortableBatchMarkerCore {
  const record = expectExactRecord(value, "portable batch marker core", [
    "schema_version", "record_kind", "project_id", "predecessor_batch_id", "object_entries",
    "batch_root", "writer_continuity_id", "storage_schema_version", "protocol_version", "recovery_policy"
  ]);
  const fields = parsePortableBatchFields(record);
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_BATCH_SCHEMA_VERSION, "batch schema version"),
    record_kind: expectLiteral(record.record_kind, "portable_batch_marker", "batch marker kind"),
    ...fields,
    batch_root: parseSha256Digest(expectBytes(record.batch_root, "batch root"))
  });
}

export async function deriveBatchObjectRoot(
  entries: readonly PortableBatchObjectEntry[],
  provider?: Sha256Provider
): Promise<Sha256Digest> {
  const parsed = parseBatchEntries(entries);
  const preimage = encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2HashDomains.batchObjectRoot),
    canonicalProtocolValue(parsed)
  ]));
  return sha256(preimage, provider);
}

export type WriterContinuityCore = Readonly<{
  schema_version: typeof HC2_WRITER_CONTINUITY_SCHEMA_VERSION;
  record_kind: "writer_continuity_evidence";
  project_id: ProjectId;
  device_id: DeviceId;
  evidence_sequence: bigint;
  previous_continuity_id: WriterContinuityId | null;
  transition: "same_device_continuation" | "explicit_writer_takeover" | "recovered_new_device";
  previous_device_id: DeviceId | null;
  operation_id: OperationId;
  predecessor_batch_id: PortableBatchId | null;
  authority: "operational_evidence_only";
}>;

export type WriterContinuityRecord = Readonly<{
  core: WriterContinuityCore;
  signer_device_id: DeviceId;
  signature_algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export function parseWriterContinuityCore(value: unknown): WriterContinuityCore {
  const record = expectExactRecord(value, "writer continuity core", [
    "schema_version", "record_kind", "project_id", "device_id", "evidence_sequence",
    "previous_continuity_id", "transition", "previous_device_id", "operation_id",
    "predecessor_batch_id", "authority"
  ]);
  const transition = expectEnum(record.transition, ["same_device_continuation", "explicit_writer_takeover", "recovered_new_device"] as const, "writer transition");
  const previousDeviceId = record.previous_device_id === null ? null : parseEntityId("device", record.previous_device_id);
  if (transition === "same_device_continuation" && previousDeviceId !== null) {
    throw new Error("Same-device continuity cannot name a previous device.");
  }
  if (transition !== "same_device_continuation" && previousDeviceId === null) {
    throw new Error("Writer takeover and recovery must name the previous device.");
  }
  if (previousDeviceId !== null && previousDeviceId === record.device_id) {
    throw new Error("Writer takeover and recovery must create or identify a different device.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_WRITER_CONTINUITY_SCHEMA_VERSION, "writer continuity schema version"),
    record_kind: expectLiteral(record.record_kind, "writer_continuity_evidence", "writer continuity kind"),
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    evidence_sequence: expectUInt64(record.evidence_sequence, "writer evidence sequence"),
    previous_continuity_id: record.previous_continuity_id === null ? null : parseHc2DigestId("writer-continuity", record.previous_continuity_id),
    transition,
    previous_device_id: previousDeviceId,
    operation_id: parseOperationId(record.operation_id),
    predecessor_batch_id: record.predecessor_batch_id === null ? null : parseHc2DigestId("portable-batch", record.predecessor_batch_id),
    authority: expectLiteral(record.authority, "operational_evidence_only", "writer continuity authority")
  });
}

export function buildWriterContinuitySignaturePreimage(value: WriterContinuityCore): Uint8Array {
  const core = parseWriterContinuityCore(value);
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2SignatureDomains.writerContinuity),
    canonicalProtocolValue(core)
  ]));
}

export async function deriveWriterContinuityIdentity(
  value: WriterContinuityRecord,
  provider?: Sha256Provider
): Promise<Readonly<{ record: WriterContinuityRecord; continuity_id: WriterContinuityId }>> {
  const record = parseWriterContinuityRecord(value);
  const identity = await deriveHc2Identity("writer-continuity", canonicalProtocolValue(record), provider);
  return freezeRecord({ record, continuity_id: identity.id });
}

export function parseWriterContinuityRecord(value: unknown): WriterContinuityRecord {
  const record = expectExactRecord(value, "writer continuity record", ["core", "signer_device_id", "signature_algorithm", "signature_bytes"]);
  const signature = expectBytes(record.signature_bytes, "writer continuity signature");
  if (signature.length !== 64) throw new Error("Ed25519 signatures must contain exactly 64 bytes.");
  const core = parseWriterContinuityCore(record.core);
  const signer = parseEntityId("device", record.signer_device_id);
  if (signer !== core.device_id) throw new Error("Writer continuity signer must match the evidence device.");
  return freezeRecord({
    core,
    signer_device_id: signer,
    signature_algorithm: expectLiteral(record.signature_algorithm, "ed25519", "writer signature algorithm"),
    signature_bytes: Uint8Array.from(signature)
  });
}

export type MaterializationStatus = Readonly<{
  schema_version: typeof HC2_MATERIALIZATION_SCHEMA_VERSION;
  record_kind: "materialization_status";
  project_id: ProjectId;
  projection_root_id: ProjectionRootId;
  checkpoint_id: SemanticEventId;
  expected_document_sha256: Sha256Digest;
  status: "complete" | "stale" | "failed";
  failure_code: string | null;
  authority: "materialized_projection_only";
}>;

export function parseMaterializationStatus(value: unknown): MaterializationStatus {
  const record = expectExactRecord(value, "materialization status", [
    "schema_version", "record_kind", "project_id", "projection_root_id", "checkpoint_id",
    "expected_document_sha256", "status", "failure_code", "authority"
  ]);
  const status = expectEnum(record.status, ["complete", "stale", "failed"] as const, "materialization status");
  const failure = record.failure_code === null ? null : expectNonEmptyString(record.failure_code, "materialization failure code");
  if ((status === "failed") !== (failure !== null)) {
    throw new Error("Only failed materialization status may contain a failure code.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_MATERIALIZATION_SCHEMA_VERSION, "materialization schema version"),
    record_kind: expectLiteral(record.record_kind, "materialization_status", "materialization record kind"),
    project_id: parseEntityId("project", record.project_id),
    projection_root_id: parseDigestId("projection-root", record.projection_root_id),
    checkpoint_id: parseDigestId("semantic-event", record.checkpoint_id),
    expected_document_sha256: parseSha256Digest(expectBytes(record.expected_document_sha256, "document SHA-256")),
    status,
    failure_code: failure,
    authority: expectLiteral(record.authority, "materialized_projection_only", "materialization authority")
  });
}

export function encodeMaterializationStatus(value: MaterializationStatus): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(parseMaterializationStatus(value)));
}

function parsePortableBatchFields(value: unknown): Omit<PortableBatchMarkerCore, "schema_version" | "record_kind" | "batch_root"> {
  const record = value as Record<string, unknown>;
  return freezeRecord({
    project_id: parseEntityId("project", record.project_id),
    predecessor_batch_id: record.predecessor_batch_id === null ? null : parseHc2DigestId("portable-batch", record.predecessor_batch_id),
    object_entries: parseBatchEntries(record.object_entries),
    writer_continuity_id: record.writer_continuity_id === null ? null : parseHc2DigestId("writer-continuity", record.writer_continuity_id),
    storage_schema_version: expectLiteral(record.storage_schema_version, 1, "batch storage schema version"),
    protocol_version: expectLiteral(record.protocol_version, 1, "batch protocol version"),
    recovery_policy: expectLiteral(record.recovery_policy, "mandatory_before_collaboration", "batch recovery policy")
  });
}

function parseBatchEntries(value: unknown): readonly PortableBatchObjectEntry[] {
  return parseSortedObjects(value, "batch object entries", (entry) => {
    const record = expectExactRecord(entry, "batch object entry", [
      "object_kind", "object_id", "stored_length", "stored_sha256", "dependency_ids", "object_commit_marker_id"
    ]);
    const kind = parseCollaborationObjectKind(record.object_kind);
    const length = expectUInt64(record.stored_length, "batch object length");
    if (length > hc2ProtocolLimits.maximum_canonical_object_bytes) {
      throw new Error("Batch object length exceeds the HC-2 object limit.");
    }
    const dependencyIds = parseSortedUniqueObjectIds(record.dependency_ids, "batch dependencies");
    return freezeRecord({
      object_kind: kind,
      object_id: parseCollaborationObjectId(kind, record.object_id),
      stored_length: length,
      stored_sha256: parseSha256Digest(expectBytes(record.stored_sha256, "batch stored SHA-256")),
      dependency_ids: dependencyIds,
      object_commit_marker_id: parseHc2DigestId("object-commit-marker", record.object_commit_marker_id)
    });
  });
}

function parseSortedObjects<T extends { object_kind: string; object_id: string }>(
  value: unknown,
  label: string,
  parse: (entry: unknown) => T
): readonly T[] {
  const entries = assertDenseArray(value, hc2ProtocolLimits.maximum_objects_per_chunk, label);
  if (entries.length === 0) throw new Error(`${label} must not be empty.`);
  const parsed = entries.map(parse);
  const keys = parsed.map((entry) => `${entry.object_kind}\u0000${entry.object_id}`);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] >= keys[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
  return Object.freeze(parsed);
}

function parseSortedUniqueObjectIds(value: unknown, label: string): readonly CollaborationObjectId[] {
  const entries = expectArray(value, label);
  const parsed = entries.map(parseAnyStoredObjectId);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1] >= parsed[index]) throw new Error(`${label} must be strictly sorted and unique.`);
  }
  return Object.freeze(parsed);
}

export function parseAnyStoredObjectId(value: unknown): CollaborationObjectId {
  if (typeof value !== "string") throw new Error("Stored object ID must be a string.");
  for (const kind of [
    "markdown-blob", "document-revision", "semantic-payload", "control-action", "semantic-event",
    "control-event", "attestation", "state-blob", "snapshot", "acknowledgement"
  ] as const) {
    if (value.startsWith(`pm:${kind}:v1:`)) return parseCollaborationObjectId(kind, value);
  }
  throw new Error("Stored object ID has an unsupported namespace.");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

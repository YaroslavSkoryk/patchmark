import {
  ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION,
  ACKNOWLEDGEMENT_RECORD_VERSION,
  ADMISSION_BOUNDARY_SCHEMA_VERSION,
  ATTESTATION_RECORD_SCHEMA_VERSION,
  ATTESTATION_RECORD_VERSION,
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  SNAPSHOT_CORE_SCHEMA_VERSION,
  SNAPSHOT_RECORD_VERSION,
  SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION
} from "./versions.ts";
import {
  type AcceptedHistoryRootId,
  type AcknowledgementId,
  type AttestationId,
  type CheckpointId,
  type ConflictSetRootId,
  type ControlEventId,
  type DerivedConflictId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type FrontierRootId,
  type KeyEpochId,
  type MembershipId,
  type PersonId,
  type ProjectionRootId,
  type PublicKeyId,
  type RevisionHeadsRootId,
  type SemanticEventId,
  type SemanticPayloadId,
  type SemanticStateRootId,
  type SnapshotId,
  type StateBlobId,
  checkpointIdFromConsolidationEvent,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  type NonAuthoritativeTimestamp,
  type UInt64,
  assertSameStringArray,
  expectBytes,
  expectDisplayTimestamp,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectPositiveUInt64,
  expectString,
  expectZeroUInt64,
  freezeRecord,
  parseSortedUniqueArray,
  parseUniqueArray
} from "./validation.ts";

export type CheckpointResolutionOperation =
  | Readonly<{
      operation_kind: "resolve_content_conflict";
      conflict_id: DerivedConflictId;
      observed_contender_event_ids: readonly SemanticEventId[];
      adopted_revision_id: DocumentRevisionId;
    }>
  | Readonly<{
      operation_kind: "resolve_metadata_conflict";
      conflict_id: DerivedConflictId;
      observed_contender_event_ids: readonly SemanticEventId[];
      chosen_payload_id: SemanticPayloadId;
    }>
  | Readonly<{
      operation_kind: "resolve_tombstone_conflict";
      conflict_id: DerivedConflictId;
      observed_contender_event_ids: readonly SemanticEventId[];
      resolution: "keep_deleted" | "restore_as_new_identity";
    }>;

export type ConsolidationCheckpointPayload = Readonly<{
  schema_version: typeof CHECKPOINT_PAYLOAD_SCHEMA_VERSION;
  project_id: import("./identities.ts").ProjectId;
  semantic_kind: "consolidation_checkpoint";
  data: Readonly<{
    base_frontier_event_ids: readonly SemanticEventId[];
    base_frontier_root: FrontierRootId;
    accepted_history_root: AcceptedHistoryRootId;
    resolution_operations: readonly CheckpointResolutionOperation[];
    result_semantic_state_root: SemanticStateRootId;
    result_revision_heads_root: RevisionHeadsRootId;
    result_conflict_set_root: ConflictSetRootId;
    projection_root: ProjectionRootId;
    reducer_version: string;
    authorizing_control_head_id: ControlEventId;
  }>;
}>;

export type BoundaryRevisionEntry = Readonly<{
  document_id: DocumentId;
  revision_id: DocumentRevisionId;
  traversal: "complete" | "boundary_root";
}>;

export type ProjectionSnapshotCore = Readonly<{
  schema_version: typeof SNAPSHOT_CORE_SCHEMA_VERSION;
  object_kind: "projection_snapshot_core";
  project_id: import("./identities.ts").ProjectId;
  checkpoint_id: CheckpointId;
  reducer_version: string;
  state_blob_id: StateBlobId;
  semantic_state_root: SemanticStateRootId;
  revision_heads_root: RevisionHeadsRootId;
  conflict_set_root: ConflictSetRootId;
  projection_root: ProjectionRootId;
  boundary_revisions: readonly BoundaryRevisionEntry[];
  live_conflict_dependencies: readonly DerivedConflictId[];
}>;

export type ProjectionSnapshotRecord = Readonly<{
  record_version: typeof SNAPSHOT_RECORD_VERSION;
  object_kind: "projection_snapshot";
  snapshot_id: SnapshotId;
  core: ProjectionSnapshotCore;
  producer_attestation_id: AttestationId | null;
}>;

export type AdmissionBoundary = Readonly<{
  schema_version: typeof ADMISSION_BOUNDARY_SCHEMA_VERSION;
  object_kind: "admission_boundary";
  project_id: import("./identities.ts").ProjectId;
  admitted_membership_id: MembershipId;
  admitted_person_id: PersonId;
  admitted_device_id: DeviceId;
  owner_authorized_control_event_id: ControlEventId;
  checkpoint_id: CheckpointId;
  snapshot_id: SnapshotId;
  admission_key_epoch_id: KeyEpochId;
  boundary_revisions: readonly BoundaryRevisionEntry[];
  sealed_prior_history: Readonly<{
    accepted_history_root: AcceptedHistoryRootId;
    parent_traversal: "unavailable_before_admission";
    prior_plaintext: "not_provided";
    verification_basis: "owner_authorized_current_state";
  }>;
  replica_scope: "complete_current_state";
}>;

export type FirstAcknowledgementCore = Readonly<{
  schema_version: typeof ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION;
  object_kind: "acknowledgement_core";
  chain_position: "first";
  project_id: import("./identities.ts").ProjectId;
  device_id: DeviceId;
  acknowledgement_sequence: UInt64;
  previous_acknowledgement_id: null;
  observed_control_head_id: ControlEventId;
  acknowledged_checkpoint_id: CheckpointId;
  observed_semantic_frontier: readonly SemanticEventId[];
  projection_root: ProjectionRootId;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type SubsequentAcknowledgementCore = Omit<
  FirstAcknowledgementCore,
  "chain_position" | "previous_acknowledgement_id"
> &
  Readonly<{
    chain_position: "subsequent";
    previous_acknowledgement_id: AcknowledgementId;
  }>;

export type AcknowledgementCore =
  | FirstAcknowledgementCore
  | SubsequentAcknowledgementCore
  | FirstSlice6AcknowledgementCore
  | SubsequentSlice6AcknowledgementCore;

export type AcknowledgedSemanticSequence = Readonly<{
  device_id: DeviceId;
  highest_contiguous_sequence: UInt64;
}>;

type Slice6AcknowledgementCommon = Readonly<{
  schema_version: typeof SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION;
  object_kind: "acknowledgement_core";
  project_id: import("./identities.ts").ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  acknowledgement_sequence: UInt64;
  observed_control_head_id: ControlEventId;
  acknowledged_checkpoint_id: CheckpointId;
  observed_semantic_frontier: readonly SemanticEventId[];
  highest_contiguous_semantic_sequences: readonly AcknowledgedSemanticSequence[];
  projection_root: ProjectionRootId;
  display_timestamp?: NonAuthoritativeTimestamp;
}>;

export type FirstSlice6AcknowledgementCore = Slice6AcknowledgementCommon &
  Readonly<{
    chain_position: "first";
    previous_acknowledgement_id: null;
  }>;

export type SubsequentSlice6AcknowledgementCore = Slice6AcknowledgementCommon &
  Readonly<{
    chain_position: "subsequent";
    previous_acknowledgement_id: AcknowledgementId;
  }>;

export type AcknowledgementRecord = Readonly<{
  record_version: typeof ACKNOWLEDGEMENT_RECORD_VERSION;
  object_kind: "acknowledgement";
  acknowledgement_id: AcknowledgementId;
  core: AcknowledgementCore;
  attestation_id: AttestationId;
}>;

export const attestationSubjectKinds = [
  "semantic_event",
  "control_event",
  "snapshot",
  "acknowledgement"
] as const;

export type AttestationSubjectKind =
  (typeof attestationSubjectKinds)[number];

export type AttestationCore = Readonly<{
  schema_version: typeof ATTESTATION_RECORD_SCHEMA_VERSION;
  object_kind: "attestation_core";
  project_id: import("./identities.ts").ProjectId;
  subject_kind: AttestationSubjectKind;
  subject_id: SemanticEventId | ControlEventId | SnapshotId | AcknowledgementId;
  signer_key_id: PublicKeyId;
  algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export type AttestationRecord = Readonly<{
  record_version: typeof ATTESTATION_RECORD_VERSION;
  object_kind: "attestation";
  attestation_id: AttestationId;
  core: AttestationCore;
}>;

export type CheckpointEventCoreLike = Readonly<{
  semantic_kind: string;
  project_id: import("./identities.ts").ProjectId;
  causal_parent_event_ids: readonly SemanticEventId[];
  authorizing_control_head_id: ControlEventId;
}>;

export function parseConsolidationCheckpointPayload(
  value: unknown
): ConsolidationCheckpointPayload {
  const payload = expectExactRecord(value, "checkpoint payload", [
    "schema_version",
    "project_id",
    "semantic_kind",
    "data"
  ]);
  expectLiteral(
    payload.schema_version,
    CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    "checkpoint payload schema version"
  );
  expectLiteral(
    payload.semantic_kind,
    "consolidation_checkpoint",
    "checkpoint semantic kind"
  );
  const data = expectExactRecord(payload.data, "checkpoint payload data", [
    "base_frontier_event_ids",
    "base_frontier_root",
    "accepted_history_root",
    "resolution_operations",
    "result_semantic_state_root",
    "result_revision_heads_root",
    "result_conflict_set_root",
    "projection_root",
    "reducer_version",
    "authorizing_control_head_id"
  ]);
  const operations = parseUniqueArray(
    data.resolution_operations,
    "checkpoint resolution operations",
    (candidate) => parseCheckpointResolutionOperation(candidate),
    (candidate) => candidate.conflict_id,
    { allowEmpty: true, requireSorted: true }
  );
  return freezeRecord({
    schema_version: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    project_id: parseEntityId("project", payload.project_id),
    semantic_kind: "consolidation_checkpoint" as const,
    data: freezeRecord({
      base_frontier_event_ids: parseSortedUniqueArray(
        data.base_frontier_event_ids,
        "checkpoint base frontier",
        (candidate) => parseDigestId("semantic-event", candidate)
      ),
      base_frontier_root: parseDigestId("frontier-root", data.base_frontier_root),
      accepted_history_root: parseDigestId(
        "accepted-history-root",
        data.accepted_history_root
      ),
      resolution_operations: operations,
      result_semantic_state_root: parseDigestId(
        "semantic-state-root",
        data.result_semantic_state_root
      ),
      result_revision_heads_root: parseDigestId(
        "revision-heads-root",
        data.result_revision_heads_root
      ),
      result_conflict_set_root: parseDigestId(
        "conflict-set-root",
        data.result_conflict_set_root
      ),
      projection_root: parseDigestId("projection-root", data.projection_root),
      reducer_version: parseProtocolToken(data.reducer_version, "reducer version"),
      authorizing_control_head_id: parseDigestId(
        "control-event",
        data.authorizing_control_head_id
      )
    })
  });
}

export function assertCheckpointMatchesEvent(
  payload: ConsolidationCheckpointPayload,
  eventCore: CheckpointEventCoreLike,
  eventId?: SemanticEventId
): void {
  if (eventCore.semantic_kind !== "consolidation_checkpoint") {
    throw new Error("Checkpoint payload requires a consolidation semantic event.");
  }
  if (payload.project_id !== eventCore.project_id) {
    throw new Error("Checkpoint payload and event project IDs must match.");
  }
  if (
    payload.data.authorizing_control_head_id !==
    eventCore.authorizing_control_head_id
  ) {
    throw new Error("Checkpoint payload and event control heads must match.");
  }
  assertSameStringArray(
    payload.data.base_frontier_event_ids,
    eventCore.causal_parent_event_ids,
    "checkpoint base frontier and event causal parents"
  );
  if (eventId && payload.data.base_frontier_event_ids.includes(eventId)) {
    throw new Error("A checkpoint base frontier cannot contain its own event ID.");
  }
}

export function checkpointIdForEvent(
  eventId: SemanticEventId,
  eventCore: CheckpointEventCoreLike,
  payload: ConsolidationCheckpointPayload
): CheckpointId {
  assertCheckpointMatchesEvent(payload, eventCore, eventId);
  return checkpointIdFromConsolidationEvent(eventId, eventCore.semantic_kind);
}

export function parseProjectionSnapshotCore(
  value: unknown,
  existingCheckpointId: CheckpointId
): ProjectionSnapshotCore {
  const record = expectExactRecord(value, "projection snapshot core", [
    "schema_version",
    "object_kind",
    "project_id",
    "checkpoint_id",
    "reducer_version",
    "state_blob_id",
    "semantic_state_root",
    "revision_heads_root",
    "conflict_set_root",
    "projection_root",
    "boundary_revisions",
    "live_conflict_dependencies"
  ]);
  expectLiteral(
    record.schema_version,
    SNAPSHOT_CORE_SCHEMA_VERSION,
    "snapshot core schema version"
  );
  expectLiteral(
    record.object_kind,
    "projection_snapshot_core",
    "snapshot core object kind"
  );
  const referencedCheckpointId = parseDigestId(
    "semantic-event",
    record.checkpoint_id
  );
  if (referencedCheckpointId !== existingCheckpointId) {
    throw new Error("Snapshot must reference the supplied existing checkpoint.");
  }
  return freezeRecord({
    schema_version: SNAPSHOT_CORE_SCHEMA_VERSION,
    object_kind: "projection_snapshot_core" as const,
    project_id: parseEntityId("project", record.project_id),
    checkpoint_id: existingCheckpointId,
    reducer_version: parseProtocolToken(record.reducer_version, "snapshot reducer version"),
    state_blob_id: parseDigestId("state-blob", record.state_blob_id),
    semantic_state_root: parseDigestId(
      "semantic-state-root",
      record.semantic_state_root
    ),
    revision_heads_root: parseDigestId(
      "revision-heads-root",
      record.revision_heads_root
    ),
    conflict_set_root: parseDigestId("conflict-set-root", record.conflict_set_root),
    projection_root: parseDigestId("projection-root", record.projection_root),
    boundary_revisions: parseBoundaryRevisions(record.boundary_revisions),
    live_conflict_dependencies: parseSortedUniqueArray(
      record.live_conflict_dependencies,
      "snapshot live conflict dependencies",
      (candidate) => parseDigestId("derived-conflict", candidate),
      { allowEmpty: true }
    )
  });
}

export function parseProjectionSnapshotRecord(
  value: unknown,
  existingCheckpointId: CheckpointId
): ProjectionSnapshotRecord {
  const record = expectExactRecord(value, "projection snapshot record", [
    "record_version",
    "object_kind",
    "snapshot_id",
    "core",
    "producer_attestation_id"
  ]);
  expectLiteral(
    record.record_version,
    SNAPSHOT_RECORD_VERSION,
    "snapshot record version"
  );
  expectLiteral(
    record.object_kind,
    "projection_snapshot",
    "snapshot record kind"
  );
  return freezeRecord({
    record_version: SNAPSHOT_RECORD_VERSION,
    object_kind: "projection_snapshot" as const,
    snapshot_id: parseDigestId("snapshot", record.snapshot_id),
    core: parseProjectionSnapshotCore(record.core, existingCheckpointId),
    producer_attestation_id:
      record.producer_attestation_id === null
        ? null
        : parseDigestId("attestation", record.producer_attestation_id)
  });
}

export function parseAdmissionBoundary(
  value: unknown,
  existing: Readonly<{
    checkpoint_id: CheckpointId;
    snapshot_id: SnapshotId;
  }>
): AdmissionBoundary {
  const record = expectExactRecord(value, "admission boundary", [
    "schema_version",
    "object_kind",
    "project_id",
    "admitted_membership_id",
    "admitted_person_id",
    "admitted_device_id",
    "owner_authorized_control_event_id",
    "checkpoint_id",
    "snapshot_id",
    "admission_key_epoch_id",
    "boundary_revisions",
    "sealed_prior_history",
    "replica_scope"
  ]);
  expectLiteral(
    record.schema_version,
    ADMISSION_BOUNDARY_SCHEMA_VERSION,
    "admission boundary schema version"
  );
  expectLiteral(
    record.object_kind,
    "admission_boundary",
    "admission boundary kind"
  );
  expectLiteral(
    record.replica_scope,
    "complete_current_state",
    "admission replica scope"
  );
  const sealed = expectExactRecord(
    record.sealed_prior_history,
    "sealed prior history",
    [
      "accepted_history_root",
      "parent_traversal",
      "prior_plaintext",
      "verification_basis"
    ]
  );
  expectLiteral(
    sealed.parent_traversal,
    "unavailable_before_admission",
    "sealed history parent traversal"
  );
  expectLiteral(
    sealed.prior_plaintext,
    "not_provided",
    "sealed history plaintext status"
  );
  expectLiteral(
    sealed.verification_basis,
    "owner_authorized_current_state",
    "admission verification basis"
  );
  const referencedCheckpointId = parseDigestId(
    "semantic-event",
    record.checkpoint_id
  );
  const referencedSnapshotId = parseDigestId("snapshot", record.snapshot_id);
  if (
    referencedCheckpointId !== existing.checkpoint_id ||
    referencedSnapshotId !== existing.snapshot_id
  ) {
    throw new Error(
      "Admission boundary must reference the supplied existing checkpoint and snapshot."
    );
  }
  return freezeRecord({
    schema_version: ADMISSION_BOUNDARY_SCHEMA_VERSION,
    object_kind: "admission_boundary" as const,
    project_id: parseEntityId("project", record.project_id),
    admitted_membership_id: parseEntityId(
      "membership",
      record.admitted_membership_id
    ),
    admitted_person_id: parseEntityId("person", record.admitted_person_id),
    admitted_device_id: parseEntityId("device", record.admitted_device_id),
    owner_authorized_control_event_id: parseDigestId(
      "control-event",
      record.owner_authorized_control_event_id
    ),
    checkpoint_id: existing.checkpoint_id,
    snapshot_id: existing.snapshot_id,
    admission_key_epoch_id: parseEntityId(
      "key-epoch",
      record.admission_key_epoch_id
    ),
    boundary_revisions: parseBoundaryRevisions(record.boundary_revisions),
    sealed_prior_history: freezeRecord({
      accepted_history_root: parseDigestId(
        "accepted-history-root",
        sealed.accepted_history_root
      ),
      parent_traversal: "unavailable_before_admission" as const,
      prior_plaintext: "not_provided" as const,
      verification_basis: "owner_authorized_current_state" as const
    }),
    replica_scope: "complete_current_state" as const
  });
}

export function parseAcknowledgementCore(
  value: unknown,
  existingCheckpointId: CheckpointId
): AcknowledgementCore {
  const discriminator = expectExactRecord(
    value,
    "acknowledgement core",
    [
      "schema_version",
      "object_kind",
      "chain_position",
      "project_id",
      "device_id",
      "acknowledgement_sequence",
      "previous_acknowledgement_id",
      "observed_control_head_id",
      "acknowledged_checkpoint_id",
      "observed_semantic_frontier",
      "projection_root"
    ],
    ["display_timestamp", "person_id", "highest_contiguous_semantic_sequences"]
  );
  if (
    discriminator.schema_version !== ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION &&
    discriminator.schema_version !== SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION
  ) {
    throw new Error("Acknowledgement core schema version is unsupported.");
  }
  const schemaVersion = discriminator.schema_version;
  const record = schemaVersion === ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION
    ? expectExactRecord(value, "legacy acknowledgement core", [
        "schema_version",
        "object_kind",
        "chain_position",
        "project_id",
        "device_id",
        "acknowledgement_sequence",
        "previous_acknowledgement_id",
        "observed_control_head_id",
        "acknowledged_checkpoint_id",
        "observed_semantic_frontier",
        "projection_root"
      ], ["display_timestamp"])
    : expectExactRecord(value, "Slice 6 acknowledgement core", [
        "schema_version",
        "object_kind",
        "chain_position",
        "project_id",
        "person_id",
        "device_id",
        "acknowledgement_sequence",
        "previous_acknowledgement_id",
        "observed_control_head_id",
        "acknowledged_checkpoint_id",
        "observed_semantic_frontier",
        "highest_contiguous_semantic_sequences",
        "projection_root"
      ], ["display_timestamp"]);
  expectLiteral(
    record.object_kind,
    "acknowledgement_core",
    "acknowledgement core kind"
  );
  const chainPosition = expectEnum(
    record.chain_position,
    ["first", "subsequent"] as const,
    "acknowledgement chain position"
  );
  const referencedCheckpointId = parseDigestId(
    "semantic-event",
    record.acknowledged_checkpoint_id
  );
  if (referencedCheckpointId !== existingCheckpointId) {
    throw new Error(
      "Acknowledgement must reference the supplied existing checkpoint."
    );
  }
  const common = {
    object_kind: "acknowledgement_core" as const,
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    observed_control_head_id: parseDigestId(
      "control-event",
      record.observed_control_head_id
    ),
    acknowledged_checkpoint_id: existingCheckpointId,
    observed_semantic_frontier: parseSortedUniqueArray(
      record.observed_semantic_frontier,
      "acknowledgement observed frontier",
      (candidate) => parseDigestId("semantic-event", candidate)
    ),
    projection_root: parseDigestId("projection-root", record.projection_root),
    ...(record.display_timestamp === undefined
      ? {}
      : {
          display_timestamp: expectDisplayTimestamp(
            record.display_timestamp,
            "acknowledgement display timestamp"
          )
        })
  };
  const chain = chainPosition === "first"
    ? (() => {
    expectLiteral(
      record.previous_acknowledgement_id,
      null,
      "first acknowledgement previous ID"
    );
    return {
      chain_position: "first" as const,
      acknowledgement_sequence: expectZeroUInt64(
        record.acknowledgement_sequence,
        "first acknowledgement sequence"
      ),
      previous_acknowledgement_id: null
    };
  })()
    : {
        chain_position: "subsequent" as const,
        acknowledgement_sequence: expectPositiveUInt64(
          record.acknowledgement_sequence,
          "subsequent acknowledgement sequence"
        ),
        previous_acknowledgement_id: parseDigestId(
          "acknowledgement",
          record.previous_acknowledgement_id
        )
      };
  if (schemaVersion === ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION) {
    return freezeRecord({
      schema_version: ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION,
      ...common,
      ...chain
    });
  }
  return freezeRecord({
    schema_version: SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION,
    ...common,
    person_id: parseEntityId("person", record.person_id),
    highest_contiguous_semantic_sequences: parseAcknowledgedSemanticSequences(
      record.highest_contiguous_semantic_sequences
    ),
    ...chain
  });
}

function parseAcknowledgedSemanticSequences(
  value: unknown
): readonly AcknowledgedSemanticSequence[] {
  return parseUniqueArray(
    value,
    "acknowledgement contiguous semantic sequences",
    (candidate) => {
      const record = expectExactRecord(candidate, "acknowledged semantic sequence", [
        "device_id",
        "highest_contiguous_sequence"
      ]);
      return freezeRecord({
        device_id: parseEntityId("device", record.device_id),
        highest_contiguous_sequence: expectZeroOrPositiveUInt64(
          record.highest_contiguous_sequence,
          "highest contiguous semantic sequence"
        )
      });
    },
    (candidate) => candidate.device_id,
    { allowEmpty: false, requireSorted: true }
  );
}

function expectZeroOrPositiveUInt64(value: unknown, label: string): UInt64 {
  try {
    return expectZeroUInt64(value, label);
  } catch {
    return expectPositiveUInt64(value, label);
  }
}

export function parseAcknowledgementRecord(
  value: unknown,
  existingCheckpointId: CheckpointId
): AcknowledgementRecord {
  const record = expectExactRecord(value, "acknowledgement record", [
    "record_version",
    "object_kind",
    "acknowledgement_id",
    "core",
    "attestation_id"
  ]);
  expectLiteral(
    record.record_version,
    ACKNOWLEDGEMENT_RECORD_VERSION,
    "acknowledgement record version"
  );
  expectLiteral(
    record.object_kind,
    "acknowledgement",
    "acknowledgement object kind"
  );
  const acknowledgementId = parseDigestId(
    "acknowledgement",
    record.acknowledgement_id
  );
  const core = parseAcknowledgementCore(record.core, existingCheckpointId);
  if (
    core.previous_acknowledgement_id !== null &&
    core.previous_acknowledgement_id === acknowledgementId
  ) {
    throw new Error("An acknowledgement cannot reference itself.");
  }
  return freezeRecord({
    record_version: ACKNOWLEDGEMENT_RECORD_VERSION,
    object_kind: "acknowledgement" as const,
    acknowledgement_id: acknowledgementId,
    core,
    attestation_id: parseDigestId("attestation", record.attestation_id)
  });
}

export function parseAttestationRecord(value: unknown): AttestationRecord {
  const record = expectExactRecord(value, "attestation record", [
    "record_version",
    "object_kind",
    "attestation_id",
    "core"
  ]);
  expectLiteral(
    record.record_version,
    ATTESTATION_RECORD_VERSION,
    "attestation record version"
  );
  expectLiteral(record.object_kind, "attestation", "attestation object kind");
  return freezeRecord({
    record_version: ATTESTATION_RECORD_VERSION,
    object_kind: "attestation" as const,
    attestation_id: parseDigestId("attestation", record.attestation_id),
    core: parseAttestationCore(record.core)
  });
}

export function parseAttestationCore(value: unknown): AttestationCore {
  const record = expectExactRecord(value, "attestation core", [
    "schema_version",
    "object_kind",
    "project_id",
    "subject_kind",
    "subject_id",
    "signer_key_id",
    "algorithm",
    "signature_bytes"
  ]);
  expectLiteral(
    record.schema_version,
    ATTESTATION_RECORD_SCHEMA_VERSION,
    "attestation core schema version"
  );
  expectLiteral(
    record.object_kind,
    "attestation_core",
    "attestation core object kind"
  );
  expectLiteral(record.algorithm, "ed25519", "attestation algorithm");
  const subjectKind = expectEnum(
    record.subject_kind,
    attestationSubjectKinds,
    "attestation subject kind"
  );
  return freezeRecord({
    schema_version: ATTESTATION_RECORD_SCHEMA_VERSION,
    object_kind: "attestation_core" as const,
    project_id: parseEntityId("project", record.project_id),
    subject_kind: subjectKind,
    subject_id: parseAttestationSubjectId(subjectKind, record.subject_id),
    signer_key_id: parseEntityId("public-key", record.signer_key_id),
    algorithm: "ed25519" as const,
    signature_bytes: expectBytes(record.signature_bytes, "attestation signature")
  });
}

function parseCheckpointResolutionOperation(
  value: unknown
): CheckpointResolutionOperation {
  const record = expectExactRecord(
    value,
    "checkpoint resolution operation",
    ["operation_kind", "conflict_id", "observed_contender_event_ids"],
    ["adopted_revision_id", "chosen_payload_id", "resolution"]
  );
  const operationKind = expectEnum(
    record.operation_kind,
    [
      "resolve_content_conflict",
      "resolve_metadata_conflict",
      "resolve_tombstone_conflict"
    ] as const,
    "checkpoint resolution operation kind"
  );
  const conflictId = parseDigestId("derived-conflict", record.conflict_id);
  const observedContenders = parseSortedUniqueArray(
    record.observed_contender_event_ids,
    "checkpoint resolution observed contenders",
    (candidate) => parseDigestId("semantic-event", candidate)
  );
  if (operationKind === "resolve_content_conflict") {
    requireOnlyVariantField(record, "adopted_revision_id");
    return freezeRecord({
      operation_kind: "resolve_content_conflict" as const,
      conflict_id: conflictId,
      observed_contender_event_ids: observedContenders,
      adopted_revision_id: parseDigestId(
        "document-revision",
        record.adopted_revision_id
      )
    });
  }
  if (operationKind === "resolve_metadata_conflict") {
    requireOnlyVariantField(record, "chosen_payload_id");
    return freezeRecord({
      operation_kind: "resolve_metadata_conflict" as const,
      conflict_id: conflictId,
      observed_contender_event_ids: observedContenders,
      chosen_payload_id: parseDigestId(
        "semantic-payload",
        record.chosen_payload_id
      )
    });
  }
  requireOnlyVariantField(record, "resolution");
  return freezeRecord({
    operation_kind: "resolve_tombstone_conflict" as const,
    conflict_id: conflictId,
    observed_contender_event_ids: observedContenders,
    resolution: expectEnum(
      record.resolution,
      ["keep_deleted", "restore_as_new_identity"] as const,
      "tombstone conflict resolution"
    )
  });
}

function parseBoundaryRevisions(value: unknown): readonly BoundaryRevisionEntry[] {
  return parseUniqueArray(
    value,
    "boundary revisions",
    (candidate) => {
      const record = expectExactRecord(candidate, "boundary revision", [
        "document_id",
        "revision_id",
        "traversal"
      ]);
      return freezeRecord({
        document_id: parseEntityId("document", record.document_id),
        revision_id: parseDigestId("document-revision", record.revision_id),
        traversal: expectEnum(
          record.traversal,
          ["complete", "boundary_root"] as const,
          "boundary revision traversal"
        )
      });
    },
    (candidate) => `${candidate.document_id}\u0000${candidate.revision_id}`,
    { allowEmpty: false, requireSorted: true }
  );
}

function parseAttestationSubjectId(
  kind: AttestationSubjectKind,
  value: unknown
): SemanticEventId | ControlEventId | SnapshotId | AcknowledgementId {
  switch (kind) {
    case "semantic_event":
      return parseDigestId("semantic-event", value);
    case "control_event":
      return parseDigestId("control-event", value);
    case "snapshot":
      return parseDigestId("snapshot", value);
    case "acknowledgement":
      return parseDigestId("acknowledgement", value);
  }
}

function requireOnlyVariantField(
  record: Readonly<Record<string, unknown>>,
  required: string
): void {
  if (!Object.prototype.hasOwnProperty.call(record, required)) {
    throw new Error(`Resolution operation requires ${required}.`);
  }
  for (const key of ["adopted_revision_id", "chosen_payload_id", "resolution"]) {
    if (key !== required && Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Resolution operation cannot contain ${key}.`);
    }
  }
}

function parseProtocolToken(value: unknown, label: string): string {
  const token = expectString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(token)) {
    throw new Error(`${label} must be a lowercase protocol token.`);
  }
  return token;
}

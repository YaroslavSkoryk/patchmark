import type { CollaborationCapability, CollaborationRole } from "./capabilities.ts";
import type { AttestationRecord, AttestationSubjectKind } from "./checkpoints.ts";
import type {
  ControlActionId,
  ControlEventId,
  ControlStateRootId,
  AcknowledgementId,
  DeviceId,
  KeyEpochCommitmentId,
  KeyEpochId,
  PersonId,
  ProjectId,
  PublicKeyId,
  SemanticEventId,
  SemanticPayloadId,
  SnapshotId
} from "./identities.ts";
import type { SemanticEventRecord, SemanticKind } from "./semantic.ts";
import type { UInt64 } from "./validation.ts";

export const retryableClassificationReasons = [
  "missing_payload",
  "missing_action",
  "missing_causal_parent",
  "missing_previous_device_event",
  "device_sequence_gap",
  "missing_control_head",
  "missing_attestation",
  "missing_verification_material",
  "dependency_quarantined",
  "control_state_unavailable"
] as const;

export const authorityConflictClassificationReasons = [
  "same_device_fork",
  "control_fork",
  "root_fork",
  "disputed_control_head",
  "superseded_control_branch",
  "unauthorized_device",
  "capability_denied",
  "non_designated_control_issuer",
  "revoked_device_sequence"
] as const;

export const permanentInvalidClassificationReasons = [
  "malformed_encoding",
  "noncanonical_encoding",
  "digest_id_mismatch",
  "cross_project_reference",
  "cross_namespace_reference",
  "invalid_attestation",
  "unknown_protocol_value",
  "sequence_regression",
  "invalid_previous_link",
  "forbidden_or_circular_reference",
  "corrupted_dependency"
] as const;

export type RetryableClassificationReason =
  (typeof retryableClassificationReasons)[number];
export type AuthorityConflictClassificationReason =
  (typeof authorityConflictClassificationReasons)[number];
export type PermanentInvalidClassificationReason =
  (typeof permanentInvalidClassificationReasons)[number];
export type ClassificationReason =
  | "accepted"
  | RetryableClassificationReason
  | AuthorityConflictClassificationReason
  | PermanentInvalidClassificationReason;

export type ClassificationDisposition =
  | "accepted"
  | "pending"
  | "authority_conflict"
  | "permanently_invalid";

export type ImmutableObjectClassification<
  TKind extends "semantic_event" | "control_event",
  TId extends SemanticEventId | ControlEventId
> = Readonly<{
  schema_version: 1;
  object_kind: TKind;
  project_id: ProjectId;
  object_id: TId;
  disposition: ClassificationDisposition;
  reason: ClassificationReason;
  detail: string;
}>;

export type SemanticEventClassification = ImmutableObjectClassification<
  "semantic_event",
  SemanticEventId
>;

export type ControlEventClassification = ImmutableObjectClassification<
  "control_event",
  ControlEventId
>;

export type SemanticDeviceForkRecord = Readonly<{
  schema_version: 1;
  object_kind: "semantic_device_fork";
  authority: "none";
  project_id: ProjectId;
  device_id: DeviceId;
  device_sequence: UInt64;
  previous_device_event_id: SemanticEventId | null;
  contender_event_ids: readonly SemanticEventId[];
}>;

export type RootControlForkRecord = Readonly<{
  schema_version: 1;
  object_kind: "root_control_fork";
  authority: "none";
  project_id: ProjectId;
  previous_root_control_id: ControlEventId | null;
  root_sequence: UInt64;
  contender_control_event_ids: readonly ControlEventId[];
}>;

export type DeviceAuthorityFact = Readonly<{
  device_id: DeviceId;
  person_id: PersonId;
  signing_key_id: PublicKeyId;
  role: CollaborationRole;
  capabilities: readonly CollaborationCapability[];
  status: "active" | "revoked";
  maximum_accepted_semantic_sequence: UInt64 | null;
}>;

export type ControlAuthorityState = Readonly<{
  schema_version: 1;
  project_id: ProjectId;
  control_event_id: ControlEventId;
  control_state_root: ControlStateRootId;
  active_control_device_id: DeviceId;
  offline_root_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  device_authorities: readonly DeviceAuthorityFact[];
}>;

export type AttestationVerificationRequest = Readonly<{
  schema_version: 1;
  project_id: ProjectId;
  subject_kind: AttestationSubjectKind;
  subject_id: SemanticEventId | ControlEventId | SnapshotId | AcknowledgementId;
  raw_subject_digest: Uint8Array;
  signature_preimage: Uint8Array;
  signer_key_id: PublicKeyId;
  algorithm: "ed25519";
  signature_bytes: Uint8Array;
  referenced_control_head_id: ControlEventId | null;
  root_authority_context_id: ControlEventId | null;
  expected_device_id: DeviceId | null;
  expected_person_id: PersonId | null;
}>;

export type AttestationVerificationResult =
  | Readonly<{
      outcome: "verified";
      binding: AttestationVerificationRequest;
    }>
  | Readonly<{
      outcome: "invalid";
      reason: string;
    }>
  | Readonly<{
      outcome: "unavailable";
      reason: string;
    }>;

export interface CollaborationAttestationVerifier {
  verify(
    request: AttestationVerificationRequest
  ): Promise<AttestationVerificationResult>;
}

export type ControlTransitionVerificationRequest = Readonly<{
  schema_version: 1;
  project_id: ProjectId;
  control_event_id: ControlEventId;
  control_kind: "genesis" | "ordinary" | "root_recovery";
  previous_control_id: ControlEventId | null;
  previous_root_control_id: ControlEventId | null;
  previous_control_state_root: ControlStateRootId | null;
  control_action_id: ControlActionId | null;
  issuer_device_id: DeviceId | null;
  issuer_root_key_id: PublicKeyId | null;
  expected_control_sequence: UInt64;
  expected_root_sequence: UInt64 | null;
  resulting_control_state_root: ControlStateRootId;
  previous_active_control_device_id: DeviceId | null;
  previous_device_authorities: readonly DeviceAuthorityFact[];
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  recovery_last_uncontested_control_id: ControlEventId | null;
  recovery_selected_state_root: ControlStateRootId | null;
  recovery_replacement_active_control_device_id: DeviceId | null;
  recovery_revocation_sequence_cutoffs: readonly Readonly<{
    device_id: DeviceId;
    maximum_accepted_semantic_sequence: UInt64;
  }>[];
  recovery_observed_conflicting_tip_ids: readonly ControlEventId[];
  recovery_supersession_policy:
    | "supersede_all_ordinary_descendants_outside_recovery_chain"
    | null;
}>;

export type ControlTransitionVerificationResult =
  | Readonly<{
      outcome: "verified";
      binding: ControlTransitionVerificationRequest;
      resulting_authority: ControlAuthorityState;
    }>
  | Readonly<{
      outcome: "invalid";
      reason: string;
    }>
  | Readonly<{
      outcome: "unavailable";
      reason: string;
    }>;

export interface CollaborationControlTransitionVerifier {
  verify(
    request: ControlTransitionVerificationRequest
  ): Promise<ControlTransitionVerificationResult>;
}

export type SemanticAttestationFactoryRequest = Readonly<{
  project_id: ProjectId;
  event_id: SemanticEventId;
  author_device_id: DeviceId;
  expected_person_id: PersonId;
  expected_signing_key_id: PublicKeyId;
  signature_preimage: Uint8Array;
}>;

export type SemanticAttestationFactory = (
  request: SemanticAttestationFactoryRequest
) => Promise<readonly AttestationRecord[]>;

export type LocalSemanticAppendRequest = Readonly<{
  project_id: ProjectId;
  author_device_id: DeviceId;
  semantic_kind: SemanticKind;
  semantic_payload_id: SemanticPayloadId;
  causal_parent_event_ids: readonly SemanticEventId[];
  authorizing_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  complete_known_frontier: true;
  display_timestamp?: string;
  create_attestations: SemanticAttestationFactory;
}>;

export type LocalSemanticAppendResult = Readonly<{
  status: "committed" | "already_committed" | "resumed";
  event: SemanticEventRecord;
  attestations: readonly AttestationRecord[];
}>;

export type SemanticSequenceReservation = Readonly<{
  schema_version: 1;
  object_kind: "semantic_sequence_reservation";
  reservation_state: "pending" | "committed";
  project_id: ProjectId;
  device_id: DeviceId;
  device_sequence: UInt64;
  previous_device_event_id: SemanticEventId | null;
  semantic_payload_id: SemanticPayloadId;
  causal_parent_event_ids: readonly SemanticEventId[];
  authorizing_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  resulting_event_id: SemanticEventId;
  event_record_bytes: Uint8Array;
  attestation_record_bytes: readonly Uint8Array[];
}>;

export type AttestationIndexEntry = Readonly<{
  subject_kind: "semantic_event" | "control_event";
  subject_id: SemanticEventId | ControlEventId;
  attestation_ids: readonly import("./identities.ts").AttestationId[];
}>;

export type EventControlProjectState = Readonly<{
  schema_version: 1;
  object_kind: "event_control_project_state";
  project_id: ProjectId;
  semantic_classifications: readonly SemanticEventClassification[];
  control_classifications: readonly ControlEventClassification[];
  accepted_semantic_event_ids: readonly SemanticEventId[];
  accepted_control_event_ids: readonly ControlEventId[];
  accepted_semantic_frontier: readonly SemanticEventId[];
  semantic_forks: readonly SemanticDeviceForkRecord[];
  control_forks: readonly import("./control.ts").DerivedControlForkRecord[];
  root_forks: readonly RootControlForkRecord[];
  superseded_control_event_ids: readonly ControlEventId[];
  attestation_index: readonly AttestationIndexEntry[];
  pending_reservations: readonly SemanticSequenceReservation[];
  invalid_object_ids: readonly string[];
}>;

export type Slice4FailureStage =
  | "before_reservation_write"
  | "after_reservation_before_attestation_storage"
  | "after_attestation_storage_before_event_storage"
  | "after_event_commit_before_sequence_index_update"
  | "during_reopening";

export type Slice4FailureContext = Readonly<{
  stage: Slice4FailureStage;
  project_id?: ProjectId;
  device_id?: DeviceId;
  event_id?: SemanticEventId;
}>;

export type Slice4FailureInjector = (
  context: Slice4FailureContext
) => void | Promise<void>;

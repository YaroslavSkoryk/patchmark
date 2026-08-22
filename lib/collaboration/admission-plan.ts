import type { CollaborationRole } from "./capabilities.ts";
import type {
  BoundaryRevisionEntry,
  ProjectionSnapshotRecord
} from "./checkpoints.ts";
import { parseProjectionSnapshotRecord } from "./checkpoints.ts";
import type {
  DeviceAuthorizationAction,
  KeyEpochTransitionAction,
  MembershipGrantAction
} from "./control.ts";
import { parseControlActionCore } from "./control.ts";
import type {
  AccessScopeId,
  CheckpointId,
  ControlEventId,
  DeviceId,
  KeyEpochCommitmentId,
  KeyEpochId,
  MembershipId,
  PersonId,
  ProjectId,
  PublicKeyId,
  SnapshotId,
  StateBlobId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import { deriveKeyEpochCommitment } from "./projection-roots.ts";
import {
  ADMISSION_PLAN_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION
} from "./versions.ts";
import {
  expectEnum,
  expectExactRecord,
  expectLiteral,
  freezeRecord
} from "./validation.ts";

export type CurrentStateAdmissionPlanInput = Readonly<{
  schema_version: typeof ADMISSION_PLAN_SCHEMA_VERSION;
  object_kind: "current_state_admission_plan_input";
  protocol_version: typeof COLLABORATION_PROTOCOL_VERSION;
  project_id: ProjectId;
  owner_control_head_id: ControlEventId;
  current_key_epoch_id: KeyEpochId;
  checkpoint_id: CheckpointId;
  state_blob_id: StateBlobId;
  snapshot: ProjectionSnapshotRecord;
  admitted_membership_id: MembershipId;
  admitted_person_id: PersonId;
  admitted_device_id: DeviceId;
  admitted_device_signing_key_id: PublicKeyId;
  admitted_role: CollaborationRole;
  admitted_access_scope_id: AccessScopeId;
  next_key_epoch_id: KeyEpochId;
  next_key_epoch_public_commitment_bytes: Uint8Array;
}>;

export type CurrentStateAdmissionPlan = Readonly<{
  schema_version: typeof ADMISSION_PLAN_SCHEMA_VERSION;
  object_kind: "current_state_admission_plan";
  authority: "none";
  verification_basis: "owner_authorized_current_state_draft_only";
  project_id: ProjectId;
  owner_control_head_id: ControlEventId;
  checkpoint_id: CheckpointId;
  state_blob_id: StateBlobId;
  snapshot_id: SnapshotId;
  admitted_membership_id: MembershipId;
  admitted_person_id: PersonId;
  admitted_device_id: DeviceId;
  admitted_device_signing_key_id: PublicKeyId;
  admitted_role: CollaborationRole;
  admitted_access_scope_id: AccessScopeId;
  next_key_epoch_id: KeyEpochId;
  next_key_epoch_commitment: KeyEpochCommitmentId;
  control_action_inputs: readonly [
    MembershipGrantAction,
    DeviceAuthorizationAction,
    KeyEpochTransitionAction
  ];
  boundary_package_manifest: Readonly<{
    checkpoint_id: CheckpointId;
    state_blob_id: StateBlobId;
    snapshot_id: SnapshotId;
    boundary_revisions: readonly BoundaryRevisionEntry[];
    live_conflict_dependencies: ProjectionSnapshotRecord["core"]["live_conflict_dependencies"];
  }>;
  limitations: readonly [
    "no_key_generation",
    "no_key_encryption_or_delivery",
    "no_invitation",
    "no_device_contact",
    "no_signature",
    "no_control_append",
    "no_previous_epoch_key_exposure",
    "no_full_history_claim"
  ];
}>;

const admissionLimitations = Object.freeze([
  "no_key_generation",
  "no_key_encryption_or_delivery",
  "no_invitation",
  "no_device_contact",
  "no_signature",
  "no_control_append",
  "no_previous_epoch_key_exposure",
  "no_full_history_claim"
]) as CurrentStateAdmissionPlan["limitations"];

export async function planCurrentStateAdmission(
  value: CurrentStateAdmissionPlanInput | unknown
): Promise<CurrentStateAdmissionPlan> {
  const input = parseCurrentStateAdmissionPlanInput(value);
  const nextCommitment = await deriveKeyEpochCommitment({
    schema_version: 1,
    object_kind: "key_epoch_public_commitment",
    project_id: input.project_id,
    key_epoch_id: input.next_key_epoch_id,
    commitment_algorithm: "sha256-public-commitment-v1",
    public_commitment_bytes: input.next_key_epoch_public_commitment_bytes
  });
  const membership = parseControlActionCore({
    schema_version: 1,
    project_id: input.project_id,
    action_kind: "membership_grant",
    membership_id: input.admitted_membership_id,
    person_id: input.admitted_person_id,
    role: input.admitted_role,
    access_scope_id: input.admitted_access_scope_id
  });
  const device = parseControlActionCore({
    schema_version: 1,
    project_id: input.project_id,
    action_kind: "device_authorization",
    person_id: input.admitted_person_id,
    device_id: input.admitted_device_id,
    signing_key_id: input.admitted_device_signing_key_id
  });
  const epoch = parseControlActionCore({
    schema_version: 1,
    project_id: input.project_id,
    action_kind: "key_epoch_transition",
    previous_key_epoch_id: input.current_key_epoch_id,
    replacement_key_epoch_id: input.next_key_epoch_id,
    replacement_key_epoch_commitment: nextCommitment.id,
    reason: "membership_change"
  });
  if (
    membership.action_kind !== "membership_grant" ||
    device.action_kind !== "device_authorization" ||
    epoch.action_kind !== "key_epoch_transition"
  ) {
    throw new Error("Admission planner constructed unexpected control action inputs.");
  }
  return freezeRecord({
    schema_version: ADMISSION_PLAN_SCHEMA_VERSION,
    object_kind: "current_state_admission_plan" as const,
    authority: "none" as const,
    verification_basis: "owner_authorized_current_state_draft_only" as const,
    project_id: input.project_id,
    owner_control_head_id: input.owner_control_head_id,
    checkpoint_id: input.checkpoint_id,
    state_blob_id: input.state_blob_id,
    snapshot_id: input.snapshot.snapshot_id,
    admitted_membership_id: input.admitted_membership_id,
    admitted_person_id: input.admitted_person_id,
    admitted_device_id: input.admitted_device_id,
    admitted_device_signing_key_id: input.admitted_device_signing_key_id,
    admitted_role: input.admitted_role,
    admitted_access_scope_id: input.admitted_access_scope_id,
    next_key_epoch_id: input.next_key_epoch_id,
    next_key_epoch_commitment: nextCommitment.id,
    control_action_inputs: Object.freeze([membership, device, epoch]),
    boundary_package_manifest: freezeRecord({
      checkpoint_id: input.checkpoint_id,
      state_blob_id: input.state_blob_id,
      snapshot_id: input.snapshot.snapshot_id,
      boundary_revisions: input.snapshot.core.boundary_revisions,
      live_conflict_dependencies: input.snapshot.core.live_conflict_dependencies
    }),
    limitations: admissionLimitations
  });
}

export function parseCurrentStateAdmissionPlanInput(
  value: unknown
): CurrentStateAdmissionPlanInput {
  const record = expectExactRecord(value, "current-state admission plan input", [
    "schema_version",
    "object_kind",
    "protocol_version",
    "project_id",
    "owner_control_head_id",
    "current_key_epoch_id",
    "checkpoint_id",
    "state_blob_id",
    "snapshot",
    "admitted_membership_id",
    "admitted_person_id",
    "admitted_device_id",
    "admitted_device_signing_key_id",
    "admitted_role",
    "admitted_access_scope_id",
    "next_key_epoch_id",
    "next_key_epoch_public_commitment_bytes"
  ]);
  expectLiteral(record.schema_version, ADMISSION_PLAN_SCHEMA_VERSION, "admission plan input version");
  expectLiteral(record.object_kind, "current_state_admission_plan_input", "admission plan input kind");
  expectLiteral(record.protocol_version, COLLABORATION_PROTOCOL_VERSION, "admission protocol version");
  const projectId = parseEntityId("project", record.project_id);
  const checkpointId = parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId;
  const snapshot = parseProjectionSnapshotRecord(record.snapshot, checkpointId);
  if (snapshot.core.project_id !== projectId) {
    throw new Error("Admission snapshot belongs to another project.");
  }
  const stateBlobId = parseDigestId("state-blob", record.state_blob_id);
  if (snapshot.core.state_blob_id !== stateBlobId) {
    throw new Error("Admission state blob does not match the exact snapshot.");
  }
  return freezeRecord({
    schema_version: ADMISSION_PLAN_SCHEMA_VERSION,
    object_kind: "current_state_admission_plan_input" as const,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    project_id: projectId,
    owner_control_head_id: parseDigestId("control-event", record.owner_control_head_id),
    current_key_epoch_id: parseEntityId("key-epoch", record.current_key_epoch_id),
    checkpoint_id: checkpointId,
    state_blob_id: stateBlobId,
    snapshot,
    admitted_membership_id: parseEntityId("membership", record.admitted_membership_id),
    admitted_person_id: parseEntityId("person", record.admitted_person_id),
    admitted_device_id: parseEntityId("device", record.admitted_device_id),
    admitted_device_signing_key_id: parseEntityId("public-key", record.admitted_device_signing_key_id),
    admitted_role: expectEnum(record.admitted_role, ["owner", "editor", "reviewer"] as const, "admitted role"),
    admitted_access_scope_id: parseEntityId("access-scope", record.admitted_access_scope_id),
    next_key_epoch_id: parseEntityId("key-epoch", record.next_key_epoch_id),
    next_key_epoch_public_commitment_bytes: exactBytes(
      record.next_key_epoch_public_commitment_bytes,
      "next key epoch public commitment"
    )
  });
}

function exactBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be exact bytes.`);
  if (value.length === 0) throw new Error(`${label} must not be empty.`);
  return Uint8Array.from(value);
}

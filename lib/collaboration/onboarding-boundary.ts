import {
  parseAdmissionBoundary,
  type AdmissionBoundary,
  type ProjectionSnapshotRecord,
  type ConsolidationCheckpointPayload
} from "./checkpoints.ts";
import type {
  CheckpointId,
  ControlEventId,
  KeyEpochCommitmentId,
  KeyEpochId,
  SnapshotId
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  verifyProjectionSnapshot,
  type CanonicalStateBlobRecord,
  type SnapshotVerificationInput
} from "./state-snapshots.ts";

export type OwnerAdmissionVerificationRequest = Readonly<{
  schema_version: 1;
  project_id: import("./identities.ts").ProjectId;
  owner_authorized_control_event_id: ControlEventId;
  admitted_membership_id: import("./identities.ts").MembershipId;
  admitted_person_id: import("./identities.ts").PersonId;
  admitted_device_id: import("./identities.ts").DeviceId;
  checkpoint_id: CheckpointId;
  snapshot_id: SnapshotId;
  resulting_control_head_id: ControlEventId;
  admission_key_epoch_id: KeyEpochId;
  admission_key_epoch_commitment: KeyEpochCommitmentId;
}>;

export type OwnerAdmissionVerificationResult =
  | Readonly<{
      status: "owner_authorized";
      binding: OwnerAdmissionVerificationRequest;
    }>
  | Readonly<{
      status: "invalid" | "incomplete_dependencies";
      reason: string;
    }>;

export type OnboardingBoundaryVerificationInput = Omit<
  SnapshotVerificationInput,
  "checkpoint_id" | "checkpoint_payload" | "snapshot" | "state_blob"
> & Readonly<{
  admission_boundary: AdmissionBoundary;
  checkpoint_id: CheckpointId;
  checkpoint_payload: ConsolidationCheckpointPayload;
  snapshot: ProjectionSnapshotRecord;
  state_blob: CanonicalStateBlobRecord;
  current_control_head_id: ControlEventId;
  current_key_epoch_id: KeyEpochId;
  current_key_epoch_commitment: KeyEpochCommitmentId;
  verify_owner_admission: (
    request: OwnerAdmissionVerificationRequest
  ) => Promise<OwnerAdmissionVerificationResult>;
}>;

export type OnboardingBoundaryVerificationResult =
  | Readonly<{
      status: "owner_authorized_boundary_verified";
      verification_basis: "owner_authorized_current_state";
      full_history_verified: false;
      checkpoint_id: CheckpointId;
      snapshot_id: SnapshotId;
      accepted_history_root: import("./identities.ts").AcceptedHistoryRootId;
      boundary_revisions: AdmissionBoundary["boundary_revisions"];
    }>
  | Readonly<{
      status: "invalid" | "incomplete_boundary_package";
      reason: string;
    }>;

export async function verifyCurrentStateOnboardingBoundary(
  input: OnboardingBoundaryVerificationInput
): Promise<OnboardingBoundaryVerificationResult> {
  try {
    const checkpointId = parseDigestId("semantic-event", input.checkpoint_id) as CheckpointId;
    const snapshotId = parseDigestId("snapshot", input.snapshot.snapshot_id);
    const boundary = parseAdmissionBoundary(input.admission_boundary, {
      checkpoint_id: checkpointId,
      snapshot_id: snapshotId
    });
    if (
      boundary.project_id !== input.project_id ||
      input.checkpoint_payload.project_id !== input.project_id ||
      input.state_blob.core.project_id !== input.project_id
    ) {
      throw new Error("Onboarding boundary package crosses project ownership.");
    }
    const currentControlHead = parseDigestId("control-event", input.current_control_head_id);
    const currentEpoch = parseEntityId("key-epoch", input.current_key_epoch_id);
    const currentEpochCommitment = parseDigestId(
      "key-epoch-commitment",
      input.current_key_epoch_commitment
    );
    if (boundary.admission_key_epoch_id !== currentEpoch) {
      throw new Error("Admission boundary uses the wrong current key epoch.");
    }
    if (
      boundary.sealed_prior_history.accepted_history_root !==
      input.checkpoint_payload.data.accepted_history_root
    ) {
      throw new Error("Admission boundary prior-history commitment does not match the checkpoint.");
    }
    const request: OwnerAdmissionVerificationRequest = Object.freeze({
      schema_version: 1,
      project_id: input.project_id,
      owner_authorized_control_event_id: boundary.owner_authorized_control_event_id,
      admitted_membership_id: boundary.admitted_membership_id,
      admitted_person_id: boundary.admitted_person_id,
      admitted_device_id: boundary.admitted_device_id,
      checkpoint_id: checkpointId,
      snapshot_id: snapshotId,
      resulting_control_head_id: currentControlHead,
      admission_key_epoch_id: currentEpoch,
      admission_key_epoch_commitment: currentEpochCommitment
    });
    const authorization = await input.verify_owner_admission(copyRequest(request));
    if (authorization.status !== "owner_authorized") {
      return Object.freeze({
        status: authorization.status === "incomplete_dependencies"
          ? "incomplete_boundary_package" as const
          : "invalid" as const,
        reason: authorization.reason
      });
    }
    if (!sameRequest(request, authorization.binding)) {
      throw new Error("Owner admission verification is not bound to the exact boundary package.");
    }
    const snapshot = await verifyProjectionSnapshot({
      project_id: input.project_id,
      checkpoint_id: checkpointId,
      checkpoint_payload: input.checkpoint_payload,
      snapshot: input.snapshot,
      state_blob: input.state_blob,
      read_revision: input.read_revision,
      read_blob: input.read_blob,
      ...(input.read_attestation === undefined
        ? {}
        : { read_attestation: input.read_attestation })
    });
    if (snapshot.status !== "verified") {
      return Object.freeze({
        status: snapshot.status === "incomplete_dependencies"
          ? "incomplete_boundary_package" as const
          : "invalid" as const,
        reason: snapshot.reason
      });
    }
    if (!sameBoundaryRevisions(
      boundary.boundary_revisions,
      snapshot.snapshot.core.boundary_revisions
    )) {
      throw new Error("Admission and snapshot boundary revision manifests differ.");
    }
    return Object.freeze({
      status: "owner_authorized_boundary_verified" as const,
      verification_basis: "owner_authorized_current_state" as const,
      full_history_verified: false as const,
      checkpoint_id: checkpointId,
      snapshot_id: snapshotId,
      accepted_history_root: boundary.sealed_prior_history.accepted_history_root,
      boundary_revisions: boundary.boundary_revisions
    });
  } catch (error) {
    const reason = errorMessage(error);
    return Object.freeze({
      status: /missing|incomplete|unavailable/i.test(reason)
        ? "incomplete_boundary_package" as const
        : "invalid" as const,
      reason
    });
  }
}

function copyRequest(
  request: OwnerAdmissionVerificationRequest
): OwnerAdmissionVerificationRequest {
  return Object.freeze({ ...request });
}

function sameRequest(
  left: OwnerAdmissionVerificationRequest,
  right: OwnerAdmissionVerificationRequest
): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof OwnerAdmissionVerificationRequest] ===
      right[key as keyof OwnerAdmissionVerificationRequest]
  ) && Object.keys(left).length === Object.keys(right).length;
}

function sameBoundaryRevisions(
  left: AdmissionBoundary["boundary_revisions"],
  right: AdmissionBoundary["boundary_revisions"]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.document_id === right[index].document_id &&
    entry.revision_id === right[index].revision_id &&
    entry.traversal === right[index].traversal
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

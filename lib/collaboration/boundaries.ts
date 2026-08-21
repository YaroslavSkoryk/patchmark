import type { DocumentRevisionRecord } from "./content.ts";
import type { ControlActionRecord, ControlEventRecord } from "./control.ts";
import type {
  AcknowledgementRecord,
  AdmissionBoundary,
  AttestationRecord,
  ConsolidationCheckpointPayload,
  ProjectionSnapshotRecord
} from "./checkpoints.ts";
import type { DerivedConflictRecord } from "./derived.ts";
import type { DevicePrivateState } from "./private-state.ts";
import type { SemanticEventRecord, SemanticPayloadRecord } from "./semantic.ts";

/**
 * Shared contracts may be exchanged and validated by collaboration replicas.
 * Inclusion here does not itself confer authority: revision, snapshot, and
 * derived-conflict objects require an accepted event/control reference.
 */
export type SharedCollaborationContract =
  | DocumentRevisionRecord
  | SemanticPayloadRecord
  | SemanticEventRecord
  | ControlActionRecord
  | ControlEventRecord
  | ConsolidationCheckpointPayload
  | ProjectionSnapshotRecord
  | AdmissionBoundary
  | AcknowledgementRecord
  | AttestationRecord
  | DerivedConflictRecord;

/** Device-private contracts are deliberately excluded from semantic payloads. */
export type DevicePrivateCollaborationContract = DevicePrivateState;

export type CollaborationStateBoundary =
  | Readonly<{
      state_scope: "shared";
      value: SharedCollaborationContract;
    }>
  | Readonly<{
      state_scope: "device_private";
      value: DevicePrivateCollaborationContract;
    }>;

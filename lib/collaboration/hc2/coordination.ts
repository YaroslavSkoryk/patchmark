import { parseDigestId, parseEntityId, type AcknowledgementId, type DeviceId, type ProjectId, type SemanticEventId } from "../identities.ts";
import { expectExactRecord, expectUInt64, freezeRecord } from "../validation.ts";
import { parseHc2DigestId, type PortableBatchId, type TransactionIntentCommitmentId } from "./identities.ts";
import { HC2_COORDINATION_SCHEMA_VERSION } from "./versions.ts";

export type DeviceStreamObjectId = SemanticEventId | AcknowledgementId;

export type DeviceStreamReservation = Readonly<{
  transaction_intent_id: TransactionIntentCommitmentId;
  next_sequence: bigint;
  next_object_id: DeviceStreamObjectId;
  exact_signed_bytes_commitment: Uint8Array;
  intended_batch_id: PortableBatchId;
}>;

export type DeviceStreamState = Readonly<{
  schema_version: typeof HC2_COORDINATION_SCHEMA_VERSION;
  project_id: ProjectId;
  device_id: DeviceId;
  generation: bigint;
  allocated_sequence: bigint | null;
  allocated_object_id: DeviceStreamObjectId | null;
  pending_reservation: DeviceStreamReservation | null;
  continuity: "unambiguous" | "ambiguous";
}>;

export type CompareAndAdvanceStreamInput = Readonly<{
  project_id: ProjectId;
  device_id: DeviceId;
  expected_generation: bigint;
  expected_sequence: bigint | null;
  expected_previous_object_id: DeviceStreamObjectId | null;
  reservation: DeviceStreamReservation;
  next_sequence: bigint;
  next_object_id: DeviceStreamObjectId;
}>;

export type StreamCasFailureCode =
  | "continuity_ambiguous"
  | "generation_mismatch"
  | "invalid_input"
  | "non_contiguous_successor"
  | "pending_replacement"
  | "predecessor_mismatch"
  | "reservation_mismatch"
  | "sequence_mismatch";

export type StreamCasResult =
  | Readonly<{ status: "advanced"; state: DeviceStreamState }>
  | Readonly<{ status: "idempotent_pending_retry"; state: DeviceStreamState }>
  | Readonly<{ status: "failed"; code: StreamCasFailureCode }>;

export interface DeviceStreamCoordinationStore {
  compareAndAdvanceStream(input: CompareAndAdvanceStreamInput): Promise<StreamCasResult>;
  finalizeCommittedBatch(input: Readonly<{
    project_id: ProjectId;
    device_id: DeviceId;
    expected_generation: bigint;
    reservation: DeviceStreamReservation;
    committed_batch_id: PortableBatchId;
  }>): Promise<
    | Readonly<{ status: "finalized" | "already_finalized"; state: DeviceStreamState }>
    | Readonly<{ status: "failed"; code: "generation_mismatch" | "reservation_mismatch" | "folder_batch_mismatch" | "continuity_ambiguous" }>
  >;
  repairFromPortableBatch(input: Readonly<{
    project_id: ProjectId;
    device_id: DeviceId;
    committed_batch_id: PortableBatchId;
    exact_committed_sequence: bigint;
    exact_committed_object_id: DeviceStreamObjectId;
    verified_folder_generation: bigint;
  }>): Promise<
    | Readonly<{ status: "repaired" | "already_current"; state: DeviceStreamState }>
    | Readonly<{ status: "failed"; code: "continuity_ambiguous" | "folder_evidence_invalid" | "local_state_ahead" }>
  >;
}

export function evaluateCompareAndAdvanceStream(
  currentValue: DeviceStreamState,
  inputValue: CompareAndAdvanceStreamInput
): StreamCasResult {
  try {
    const current = parseDeviceStreamState(currentValue);
    const input = parseCompareAndAdvanceStreamInput(inputValue);
    if (current.project_id !== input.project_id || current.device_id !== input.device_id) {
      return failure("invalid_input");
    }
    if (current.continuity === "ambiguous") return failure("continuity_ambiguous");
    if (current.pending_reservation !== null) {
      return equalReservation(current.pending_reservation, input.reservation) &&
          current.allocated_sequence === input.next_sequence &&
          current.allocated_object_id === input.next_object_id
        ? Object.freeze({ status: "idempotent_pending_retry", state: current })
        : failure("pending_replacement");
    }
    if (current.generation !== input.expected_generation) return failure("generation_mismatch");
    if (current.allocated_sequence !== input.expected_sequence) return failure("sequence_mismatch");
    if (current.allocated_object_id !== input.expected_previous_object_id) return failure("predecessor_mismatch");
    const requiredNext = current.allocated_sequence === null ? BigInt(0) : current.allocated_sequence + BigInt(1);
    if (input.next_sequence !== requiredNext) return failure("non_contiguous_successor");
    if (
      input.reservation.next_sequence !== input.next_sequence ||
      input.reservation.next_object_id !== input.next_object_id
    ) return failure("reservation_mismatch");
    const state = parseDeviceStreamState({
      ...current,
      generation: current.generation + BigInt(1),
      allocated_sequence: input.next_sequence,
      allocated_object_id: input.next_object_id,
      pending_reservation: input.reservation
    });
    return Object.freeze({ status: "advanced", state });
  } catch {
    return failure("invalid_input");
  }
}

export function parseDeviceStreamState(value: unknown): DeviceStreamState {
  const record = expectExactRecord(value, "device stream state", [
    "schema_version", "project_id", "device_id", "generation", "allocated_sequence",
    "allocated_object_id", "pending_reservation", "continuity"
  ]);
  const sequence = record.allocated_sequence === null ? null : expectUInt64(record.allocated_sequence, "allocated sequence");
  const objectId = record.allocated_object_id === null ? null : parseDeviceStreamObjectId(record.allocated_object_id);
  if ((sequence === null) !== (objectId === null)) {
    throw new Error("Allocated sequence and object ID must both be null or both be present.");
  }
  const pending = record.pending_reservation === null ? null : parseDeviceStreamReservation(record.pending_reservation);
  if (pending !== null && (pending.next_sequence !== sequence || pending.next_object_id !== objectId)) {
    throw new Error("Pending reservation must match the allocated stream high-water exactly.");
  }
  return freezeRecord({
    schema_version: record.schema_version === HC2_COORDINATION_SCHEMA_VERSION ? HC2_COORDINATION_SCHEMA_VERSION : failVersion(),
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    generation: expectUInt64(record.generation, "stream generation"),
    allocated_sequence: sequence,
    allocated_object_id: objectId,
    pending_reservation: pending,
    continuity: record.continuity === "unambiguous" || record.continuity === "ambiguous" ? record.continuity : failContinuity()
  });
}

export function parseCompareAndAdvanceStreamInput(value: unknown): CompareAndAdvanceStreamInput {
  const record = expectExactRecord(value, "compare-and-advance input", [
    "project_id", "device_id", "expected_generation", "expected_sequence",
    "expected_previous_object_id", "reservation", "next_sequence", "next_object_id"
  ]);
  return freezeRecord({
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    expected_generation: expectUInt64(record.expected_generation, "expected generation"),
    expected_sequence: record.expected_sequence === null ? null : expectUInt64(record.expected_sequence, "expected sequence"),
    expected_previous_object_id: record.expected_previous_object_id === null ? null : parseDeviceStreamObjectId(record.expected_previous_object_id),
    reservation: parseDeviceStreamReservation(record.reservation),
    next_sequence: expectUInt64(record.next_sequence, "next sequence"),
    next_object_id: parseDeviceStreamObjectId(record.next_object_id)
  });
}

export function parseDeviceStreamReservation(value: unknown): DeviceStreamReservation {
  const record = expectExactRecord(value, "device stream reservation", [
    "transaction_intent_id", "next_sequence", "next_object_id", "exact_signed_bytes_commitment", "intended_batch_id"
  ]);
  const commitment = record.exact_signed_bytes_commitment;
  if (!(commitment instanceof Uint8Array) || commitment.length !== 32) {
    throw new Error("Exact signed-bytes commitment must contain 32 bytes.");
  }
  return freezeRecord({
    transaction_intent_id: parseHc2DigestId("transaction-intent", record.transaction_intent_id),
    next_sequence: expectUInt64(record.next_sequence, "reserved sequence"),
    next_object_id: parseDeviceStreamObjectId(record.next_object_id),
    exact_signed_bytes_commitment: Uint8Array.from(commitment),
    intended_batch_id: parseHc2DigestId("portable-batch", record.intended_batch_id)
  });
}

function parseDeviceStreamObjectId(value: unknown): DeviceStreamObjectId {
  if (typeof value === "string" && value.startsWith("pm:semantic-event:v1:")) {
    return parseDigestId("semantic-event", value);
  }
  return parseDigestId("acknowledgement", value);
}

function equalReservation(left: DeviceStreamReservation, right: DeviceStreamReservation): boolean {
  const parsed = parseDeviceStreamReservation(right);
  return left.transaction_intent_id === parsed.transaction_intent_id &&
    left.next_sequence === parsed.next_sequence &&
    left.next_object_id === parsed.next_object_id &&
    left.intended_batch_id === parsed.intended_batch_id &&
    left.exact_signed_bytes_commitment.length === parsed.exact_signed_bytes_commitment.length &&
    left.exact_signed_bytes_commitment.every((byte, index) => byte === parsed.exact_signed_bytes_commitment[index]);
}

function failure(code: StreamCasFailureCode): StreamCasResult {
  return Object.freeze({ status: "failed", code });
}

function failVersion(): never { throw new Error("Unknown device stream schema version."); }
function failContinuity(): never { throw new Error("Unknown device stream continuity state."); }

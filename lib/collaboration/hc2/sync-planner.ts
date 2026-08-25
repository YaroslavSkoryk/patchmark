import type { UInt64 } from "../validation.ts";
import {
  encodeSyncProtocolValueV3,
  inventoryDescriptorKey,
  parseInventoryDescriptorV3,
  parseObjectRequestCoreV3,
  type InventoryDescriptorV3,
  type ObjectRequestCoreV3,
  type ObjectRequestItemV3,
  type ReconstructionCommitmentsV3,
  type SyncConfirmationCoreV3,
  type VerifiedInventorySnapshotV3
} from "./sync-contracts.ts";
import type { InventorySnapshotIdV3, ObjectRequestIdV3, SyncSessionIdV3 } from "./sync-v3-identities.ts";
import { HC2_SYNC_SCHEMA_VERSION, hc2SyncInvocationLimits } from "./sync-v3-versions.ts";

export type InventoryByteConflictV3 = Readonly<{
  descriptor_key: string;
  local: InventoryDescriptorV3;
  remote: InventoryDescriptorV3;
}>;

export type InventoryComparisonV3 = Readonly<{
  status: "compatible" | "incompatible";
  incompatibilities: readonly string[];
  common_identical: readonly InventoryDescriptorV3[];
  missing_locally: readonly InventoryDescriptorV3[];
  missing_remotely: readonly InventoryDescriptorV3[];
  byte_conflicts: readonly InventoryByteConflictV3[];
}>;

/** Pure, order-insensitive inventory comparison. It grants no mutation authority. */
export function compareVerifiedInventoriesV3(
  local: VerifiedInventorySnapshotV3,
  remote: VerifiedInventorySnapshotV3
): InventoryComparisonV3 {
  const incompatibilities: string[] = [];
  if (local.core.project_id !== remote.core.project_id) incompatibilities.push("project_mismatch");
  if (local.core.protocol_version !== remote.core.protocol_version) incompatibilities.push("protocol_mismatch");
  if (local.core.reducer_version !== remote.core.reducer_version) incompatibilities.push("reducer_mismatch");
  if (local.core.accepted_control_head_id !== remote.core.accepted_control_head_id) incompatibilities.push("control_head_mismatch");
  if (local.core.key_epoch_id !== remote.core.key_epoch_id || local.core.key_epoch_commitment !== remote.core.key_epoch_commitment) incompatibilities.push("epoch_mismatch");
  const localByKey = descriptorMap(local.descriptors);
  const remoteByKey = descriptorMap(remote.descriptors);
  const keys = [...new Set([...localByKey.keys(), ...remoteByKey.keys()])].sort(compareAscii);
  const common: InventoryDescriptorV3[] = [];
  const missingLocal: InventoryDescriptorV3[] = [];
  const missingRemote: InventoryDescriptorV3[] = [];
  const conflicts: InventoryByteConflictV3[] = [];
  for (const key of keys) {
    const localDescriptor = localByKey.get(key);
    const remoteDescriptor = remoteByKey.get(key);
    if (!localDescriptor) missingLocal.push(remoteDescriptor!);
    else if (!remoteDescriptor) missingRemote.push(localDescriptor);
    else if (localDescriptor.exact_byte_length === remoteDescriptor.exact_byte_length && sameBytes(localDescriptor.exact_sha256, remoteDescriptor.exact_sha256)) common.push(localDescriptor);
    else conflicts.push(Object.freeze({ descriptor_key: key, local: localDescriptor, remote: remoteDescriptor }));
  }
  return Object.freeze({
    status: incompatibilities.length === 0 ? "compatible" : "incompatible",
    incompatibilities: Object.freeze(incompatibilities),
    common_identical: Object.freeze(common),
    missing_locally: Object.freeze(missingLocal),
    missing_remotely: Object.freeze(missingRemote),
    byte_conflicts: Object.freeze(conflicts)
  });
}

export type ObjectRequestPlanV3 = Readonly<{
  status: "requests_ready" | "nothing_missing" | "conflict" | "incompatible";
  requests: readonly ObjectRequestCoreV3[];
  reason: string | null;
}>;

/** Creates bounded request pages; it neither reads bytes nor hashes or signs. */
export function planObjectRequestsV3(input: Readonly<{
  comparison: InventoryComparisonV3;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  round_number: UInt64;
  local_snapshot_id: InventorySnapshotIdV3;
  remote_snapshot_id: InventorySnapshotIdV3;
  maximum_items_per_request?: number;
  maximum_objects_per_response?: number;
  maximum_total_bytes?: bigint;
}>): ObjectRequestPlanV3 {
  if (input.comparison.status === "incompatible") return Object.freeze({ status: "incompatible", requests: Object.freeze([]), reason: input.comparison.incompatibilities.join(",") });
  if (input.comparison.byte_conflicts.length > 0) return Object.freeze({ status: "conflict", requests: Object.freeze([]), reason: "same_identity_different_bytes" });
  if (input.comparison.missing_locally.length === 0) return Object.freeze({ status: "nothing_missing", requests: Object.freeze([]), reason: null });
  const maximumItems = boundedInteger(input.maximum_items_per_request ?? hc2SyncInvocationLimits.maximum_request_items, 1, hc2SyncInvocationLimits.maximum_request_items, "request page item limit");
  const maximumObjects = boundedInteger(input.maximum_objects_per_response ?? hc2SyncInvocationLimits.maximum_objects_returned, 1, hc2SyncInvocationLimits.maximum_objects_returned, "response object limit");
  const maximumBytes = input.maximum_total_bytes ?? hc2SyncInvocationLimits.maximum_response_object_bytes;
  if (maximumBytes <= BigInt(0) || maximumBytes > hc2SyncInvocationLimits.maximum_response_object_bytes) throw new Error("Request byte limit exceeds the explicit invocation bound.");
  const groups: InventoryDescriptorV3[][] = [];
  let group: InventoryDescriptorV3[] = [];
  let bytes = BigInt(0);
  for (const descriptor of input.comparison.missing_locally) {
    if (descriptor.exact_byte_length > maximumBytes) throw new Error("One requested object exceeds the explicit response byte budget.");
    if (group.length > 0 && (group.length >= maximumItems || bytes + descriptor.exact_byte_length > maximumBytes)) {
      groups.push(group);
      group = [];
      bytes = BigInt(0);
    }
    group.push(descriptor);
    bytes += descriptor.exact_byte_length;
  }
  if (group.length > 0) groups.push(group);
  if (groups.length > hc2SyncInvocationLimits.maximum_requests_processed) {
    groups.length = hc2SyncInvocationLimits.maximum_requests_processed;
  }
  const total = groups.length;
  const requests = groups.map((descriptors, ordinal) => parseObjectRequestCoreV3({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "object_request_core_v3",
    authority: "none",
    session_id: input.session_id,
    session_generation: input.session_generation,
    round_number: input.round_number,
    local_snapshot_id: input.local_snapshot_id,
    remote_snapshot_id: input.remote_snapshot_id,
    request_page_ordinal: ordinal,
    request_page_count: total,
    maximum_object_count: maximumObjects,
    maximum_total_bytes: maximumBytes,
    dependency_policy: "required_closure",
    items: descriptors.map(descriptorToRequestItem)
  }));
  return Object.freeze({ status: "requests_ready", requests: Object.freeze(requests), reason: groupsCover(input.comparison.missing_locally, groups) ? null : "more_required" });
}

export type ResponseSelectionV3 = Readonly<{
  status: "ready" | "more_required" | "stale_snapshot" | "rejected";
  selected: readonly InventoryDescriptorV3[];
  unavailable_descriptor_keys: readonly string[];
  continuation_after_key: string | null;
  reason: string | null;
}>;

/**
 * Selects only objects proven to exist in the exact offered snapshot. The
 * caller must still reopen, rehash, verify project ownership, and calculate
 * the dependency-first data chunks before transport preparation.
 */
export function planObjectResponseV3(input: Readonly<{
  request: ObjectRequestCoreV3;
  offered_snapshot: VerifiedInventorySnapshotV3;
  current_portable_generation: UInt64;
  dependency_closure: Readonly<Record<string, readonly string[]>>;
}>): ResponseSelectionV3 {
  const request = parseObjectRequestCoreV3(input.request);
  if (request.remote_snapshot_id !== input.offered_snapshot.snapshot_id) return emptySelection("rejected", "request_snapshot_binding_mismatch");
  if (input.current_portable_generation !== input.offered_snapshot.core.portable_generation) return emptySelection("stale_snapshot", "offered_snapshot_generation_advanced");
  const offered = descriptorMap(input.offered_snapshot.descriptors);
  const requested = new Set(request.items.map(requestItemKey));
  const unavailable = request.items.filter((item) => {
    const descriptor = offered.get(requestItemKey(item));
    return !descriptor || descriptor.exact_byte_length !== item.expected_byte_length || !sameBytes(descriptor.exact_sha256, item.expected_sha256);
  }).map(requestItemKey).sort(compareAscii);
  if (unavailable.length > 0) return Object.freeze({ status: "stale_snapshot", selected: Object.freeze([]), unavailable_descriptor_keys: Object.freeze(unavailable), continuation_after_key: null, reason: "offered_record_unavailable_or_changed" });
  const closure = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string, depth: number): void => {
    if (depth > hc2SyncInvocationLimits.maximum_dependency_depth) throw new Error("Dependency traversal exceeds the explicit bound.");
    if (closure.has(key)) return;
    if (visiting.has(key)) throw new Error("Portable dependency cycle is invalid.");
    visiting.add(key);
    for (const dependency of [...(input.dependency_closure[key] ?? [])].sort(compareAscii)) {
      if (!offered.has(dependency)) throw new Error("Required dependency was not present in the offered snapshot.");
      visit(dependency, depth + 1);
    }
    visiting.delete(key);
    closure.add(key);
  };
  for (const key of [...requested].sort(compareAscii)) visit(key, 0);
  const ordered = [...closure].map((key) => offered.get(key)!).sort((left, right) => compareAscii(inventoryDescriptorKey(left), inventoryDescriptorKey(right)));
  const selected: InventoryDescriptorV3[] = [];
  let totalBytes = BigInt(0);
  for (const descriptor of ordered) {
    if (selected.length >= request.maximum_object_count || totalBytes + descriptor.exact_byte_length > request.maximum_total_bytes) break;
    selected.push(descriptor);
    totalBytes += descriptor.exact_byte_length;
  }
  const more = selected.length < ordered.length;
  return Object.freeze({
    status: more ? "more_required" : "ready",
    selected: Object.freeze(selected),
    unavailable_descriptor_keys: Object.freeze([]),
    continuation_after_key: more && selected.length > 0 ? inventoryDescriptorKey(selected.at(-1)!) : null,
    reason: more ? "bounded_response_continuation" : null
  });
}

export type ConvergenceClassificationV3 =
  | Readonly<{ status: "converged" }>
  | Readonly<{ status: "more_required"; differences: readonly string[] }>
  | Readonly<{ status: "session_conflict"; differences: readonly string[] }>;

/** Equal inventory is necessary but intentionally not sufficient. */
export function classifySynchronizationConvergenceV3(
  local: SyncConfirmationCoreV3,
  remote: SyncConfirmationCoreV3
): ConvergenceClassificationV3 {
  if (local.session_id !== remote.session_id || local.session_generation !== remote.session_generation || local.round_number !== remote.round_number) {
    return Object.freeze({ status: "session_conflict", differences: Object.freeze(["session_binding"]) });
  }
  const differences: string[] = [];
  if (local.inventory_root_id !== remote.inventory_root_id) differences.push("inventory_root");
  if (local.inventory_descriptor_count !== remote.inventory_descriptor_count) differences.push("inventory_count");
  differences.push(...compareReconstruction(local.reconstruction, remote.reconstruction));
  return differences.length === 0
    ? Object.freeze({ status: "converged" })
    : Object.freeze({ status: "more_required", differences: Object.freeze(differences) });
}

export const syncSessionPhasesV3 = [
  "planned", "offer_ready", "inventory_exchanging", "inventory_verified",
  "requests_ready", "transferring", "imported", "verifying", "converged",
  "more_required", "stale", "forked", "failed", "abandoned"
] as const;
export type SyncSessionPhaseV3 = (typeof syncSessionPhasesV3)[number];

export type SyncSessionMessageEvidenceV3 = Readonly<{
  round_number: UInt64;
  message_role: string;
  ordinal: number;
  commitment: string;
}>;

export type SyncSessionStateV3 = Readonly<{
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  phase: SyncSessionPhaseV3;
  round_number: UInt64;
  local_snapshot_id: InventorySnapshotIdV3 | null;
  remote_snapshot_id: InventorySnapshotIdV3 | null;
  messages: readonly SyncSessionMessageEvidenceV3[];
  outstanding_request_ids: readonly ObjectRequestIdV3[];
  pages_processed: number;
  objects_processed: number;
  bytes_read: UInt64;
  bytes_written: UInt64;
  terminal_reason: string | null;
}>;

export type SyncSessionActionV3 =
  | Readonly<{ kind: "advance"; from: SyncSessionPhaseV3; to: SyncSessionPhaseV3 }>
  | Readonly<{ kind: "bind_snapshots"; local_snapshot_id: InventorySnapshotIdV3; remote_snapshot_id: InventorySnapshotIdV3 }>
  | Readonly<{ kind: "record_message"; evidence: SyncSessionMessageEvidenceV3 }>
  | Readonly<{ kind: "set_requests"; request_ids: readonly ObjectRequestIdV3[] }>
  | Readonly<{ kind: "progress"; pages: number; objects: number; bytes_read: UInt64; bytes_written: UInt64 }>
  | Readonly<{ kind: "next_round" }>
  | Readonly<{ kind: "terminate"; phase: "converged" | "stale" | "forked" | "failed" | "abandoned"; reason: string | null }>;

/** Deterministic session transition reducer; no clocks, IO, crypto, or retries. */
export function reduceSyncSessionV3(state: SyncSessionStateV3, action: SyncSessionActionV3): SyncSessionStateV3 {
  if (isTerminal(state.phase)) return state;
  switch (action.kind) {
    case "advance":
      if (state.phase !== action.from || !allowedTransition(action.from, action.to)) throw new Error("Invalid synchronization session transition.");
      return Object.freeze({ ...state, phase: action.to });
    case "bind_snapshots":
      if (state.local_snapshot_id && state.local_snapshot_id !== action.local_snapshot_id) return Object.freeze({ ...state, phase: "forked", terminal_reason: "conflicting_local_snapshot" });
      if (state.remote_snapshot_id && state.remote_snapshot_id !== action.remote_snapshot_id) return Object.freeze({ ...state, phase: "forked", terminal_reason: "conflicting_remote_snapshot" });
      return Object.freeze({ ...state, local_snapshot_id: action.local_snapshot_id, remote_snapshot_id: action.remote_snapshot_id });
    case "record_message": {
      const key = messageSlot(action.evidence);
      const existing = state.messages.find((entry) => messageSlot(entry) === key);
      if (existing) return existing.commitment === action.evidence.commitment
        ? state
        : Object.freeze({ ...state, phase: "forked", terminal_reason: "same_session_message_slot_different_commitment" });
      return Object.freeze({ ...state, messages: Object.freeze([...state.messages, Object.freeze(action.evidence)].sort(compareMessages)) });
    }
    case "set_requests": {
      const requestIds = [...action.request_ids].sort(compareAscii);
      if (new Set(requestIds).size !== requestIds.length) throw new Error("Outstanding synchronization requests must be unique.");
      return Object.freeze({ ...state, outstanding_request_ids: Object.freeze(requestIds) });
    }
    case "progress": {
      const pages = state.pages_processed + boundedInteger(action.pages, 0, hc2SyncInvocationLimits.maximum_pages_processed, "page progress");
      const objects = state.objects_processed + boundedInteger(action.objects, 0, hc2SyncInvocationLimits.maximum_objects_returned, "object progress");
      const bytesRead = state.bytes_read + action.bytes_read;
      const bytesWritten = state.bytes_written + action.bytes_written;
      if (pages > hc2SyncInvocationLimits.maximum_pages_processed || objects > hc2SyncInvocationLimits.maximum_objects_returned || bytesRead > hc2SyncInvocationLimits.maximum_bytes_read || bytesWritten > hc2SyncInvocationLimits.maximum_bytes_written) {
        return Object.freeze({ ...state, phase: "more_required", terminal_reason: "explicit_invocation_budget_exhausted" });
      }
      return Object.freeze({ ...state, pages_processed: pages, objects_processed: objects, bytes_read: bytesRead as UInt64, bytes_written: bytesWritten as UInt64 });
    }
    case "next_round":
      if (state.round_number >= BigInt(hc2SyncInvocationLimits.maximum_session_rounds)) return Object.freeze({ ...state, phase: "failed", terminal_reason: "maximum_session_rounds_exhausted" });
      return Object.freeze({ ...state, phase: "more_required", round_number: (state.round_number + BigInt(1)) as UInt64, pages_processed: 0, objects_processed: 0, bytes_read: BigInt(0) as UInt64, bytes_written: BigInt(0) as UInt64 });
    case "terminate":
      return Object.freeze({ ...state, phase: action.phase, terminal_reason: action.reason });
  }
}

export function createSyncSessionStateV3(sessionId: SyncSessionIdV3, generation: UInt64): SyncSessionStateV3 {
  return Object.freeze({
    session_id: sessionId,
    session_generation: generation,
    phase: "planned",
    round_number: BigInt(1) as UInt64,
    local_snapshot_id: null,
    remote_snapshot_id: null,
    messages: Object.freeze([]),
    outstanding_request_ids: Object.freeze([]),
    pages_processed: 0,
    objects_processed: 0,
    bytes_read: BigInt(0) as UInt64,
    bytes_written: BigInt(0) as UInt64,
    terminal_reason: null
  });
}

function compareReconstruction(left: ReconstructionCommitmentsV3, right: ReconstructionCommitmentsV3): string[] {
  const fields = Object.keys(left) as Array<keyof ReconstructionCommitmentsV3>;
  return fields.filter((field) => !sameCanonical(left[field], right[field])).map(String);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = encodeSyncProtocolValueV3(left);
  const rightBytes = encodeSyncProtocolValueV3(right);
  return sameBytes(leftBytes, rightBytes);
}

function descriptorMap(descriptors: readonly InventoryDescriptorV3[]): Map<string, InventoryDescriptorV3> {
  const result = new Map<string, InventoryDescriptorV3>();
  for (const value of descriptors) {
    const descriptor = parseInventoryDescriptorV3(value);
    const key = inventoryDescriptorKey(descriptor);
    const existing = result.get(key);
    if (existing && (!sameBytes(existing.exact_sha256, descriptor.exact_sha256) || existing.exact_byte_length !== descriptor.exact_byte_length)) throw new Error("Duplicate inventory identity has conflicting bytes.");
    result.set(key, descriptor);
  }
  return result;
}

function descriptorToRequestItem(descriptor: InventoryDescriptorV3): ObjectRequestItemV3 {
  return Object.freeze({ storage_family: descriptor.storage_family, object_kind: descriptor.object_kind, object_id: descriptor.object_id, expected_sha256: descriptor.exact_sha256, expected_byte_length: descriptor.exact_byte_length });
}

function requestItemKey(item: ObjectRequestItemV3): string {
  return `${item.storage_family}\u0000${item.object_kind}\u0000${item.object_id}`;
}

function emptySelection(status: "stale_snapshot" | "rejected", reason: string): ResponseSelectionV3 {
  return Object.freeze({ status, selected: Object.freeze([]), unavailable_descriptor_keys: Object.freeze([]), continuation_after_key: null, reason });
}

function groupsCover(descriptors: readonly InventoryDescriptorV3[], groups: readonly (readonly InventoryDescriptorV3[])[]): boolean {
  return groups.reduce((sum, group) => sum + group.length, 0) === descriptors.length;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its bound.`);
  return value;
}

function isTerminal(phase: SyncSessionPhaseV3): boolean {
  return ["converged", "stale", "forked", "failed", "abandoned"].includes(phase);
}

function allowedTransition(from: SyncSessionPhaseV3, to: SyncSessionPhaseV3): boolean {
  const transitions: Readonly<Record<string, readonly SyncSessionPhaseV3[]>> = Object.freeze({
    planned: ["offer_ready"], offer_ready: ["inventory_exchanging"], inventory_exchanging: ["inventory_verified", "more_required"],
    inventory_verified: ["requests_ready", "verifying"], requests_ready: ["transferring"], transferring: ["imported", "more_required"],
    imported: ["verifying", "more_required"], verifying: ["converged", "more_required"], more_required: ["offer_ready", "inventory_exchanging", "requests_ready", "transferring", "verifying"]
  });
  return transitions[from]?.includes(to) ?? false;
}

function messageSlot(value: SyncSessionMessageEvidenceV3): string {
  return `${value.round_number}:${value.message_role}:${value.ordinal}`;
}

function compareMessages(left: SyncSessionMessageEvidenceV3, right: SyncSessionMessageEvidenceV3): number {
  return compareAscii(messageSlot(left), messageSlot(right));
}

function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }

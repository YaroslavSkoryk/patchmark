import { encodeCanonicalCbor } from "./canonical-cbor.ts";
import {
  assertCheckpointMatchesEvent,
  checkpointIdForEvent,
  parseConsolidationCheckpointPayload,
  type CheckpointResolutionOperation,
  type ConsolidationCheckpointPayload
} from "./checkpoints.ts";
import type {
  CheckpointId,
  ControlEventId,
  DocumentRevisionId,
  SemanticEventId
} from "./identities.ts";
import {
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  buildSemanticPayloadPreimage
} from "./preimages.ts";
import {
  loadProjectionHistory,
  type LoadedProjectionHistory
} from "./projection-causality.ts";
import {
  parseCollaborationProjection,
  type CollaborationProjection,
  type CollaborationProjectorInput,
  type ProjectedValueRegister,
  type ProjectionReplayResult
} from "./projection-types.ts";
import { projectCollaborationHistory } from "./projector.ts";
import {
  deriveAcceptedHistoryRoot,
  deriveBaseFrontierRoot,
  deriveCompositeProjectionRoot,
  deriveConflictSetRoot,
  deriveResolutionOperationsHash,
  deriveRevisionHeadsRoot,
  deriveSemanticStateRoot
} from "./projection-roots.ts";
import { parseSemanticEventRecord, parseSemanticPayloadRecord } from "./semantic.ts";
import { INITIAL_REDUCER_VERSION } from "./versions.ts";

export type LoadedCheckpointCoverage = Readonly<{
  event_ids: readonly SemanticEventId[];
  history: LoadedProjectionHistory;
  replay: ProjectionReplayResult;
}>;

export type CheckpointPreparationInput = Readonly<{
  projector_input: CollaborationProjectorInput;
  base_frontier_event_ids: readonly SemanticEventId[];
  resolution_operations: readonly CheckpointResolutionOperation[];
  authorizing_control_head_id: ControlEventId;
  reducer_version: typeof INITIAL_REDUCER_VERSION;
  future_checkpoint_event_id?: SemanticEventId;
}>;

export type PreparedConsolidationCheckpoint = Readonly<{
  preparation_version: 1;
  authority: "none";
  covered_event_ids: readonly SemanticEventId[];
  base_projection: CollaborationProjection;
  result_projection: CollaborationProjection;
  payload: ConsolidationCheckpointPayload;
  canonical_payload_preimage_bytes: Uint8Array;
  resolution_operations_hash: Uint8Array;
  all_known_work_consolidated: boolean;
}>;

export type CheckpointEventVerificationResult =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "invalid" | "incomplete_dependencies"; reason: string }>;

export type FullHistoryCheckpointVerificationInput = Readonly<{
  checkpoint_event_id: SemanticEventId;
  projector_input: CollaborationProjectorInput;
  verify_checkpoint_event: (
    eventId: SemanticEventId
  ) => Promise<CheckpointEventVerificationResult>;
}>;

export type FullHistoryCheckpointVerificationResult =
  | Readonly<{
      status: "full_history_verified";
      checkpoint_id: CheckpointId;
      prepared: PreparedConsolidationCheckpoint;
    }>
  | Readonly<{
      status: "invalid" | "incomplete_dependencies";
      reason: string;
    }>;

export async function loadCheckpointCoverage(
  input: CollaborationProjectorInput,
  baseFrontier: readonly SemanticEventId[],
  futureCheckpointEventId?: SemanticEventId
): Promise<LoadedCheckpointCoverage> {
  assertSortedUnique(baseFrontier, "checkpoint base frontier");
  if (baseFrontier.length === 0) {
    throw new Error("Checkpoint coverage requires a nonempty accepted frontier.");
  }
  if (
    futureCheckpointEventId !== undefined &&
    baseFrontier.includes(futureCheckpointEventId)
  ) {
    throw new Error("A checkpoint cannot include itself in its base frontier.");
  }
  const accepted = new Set(input.accepted_semantic_event_ids);
  const closure = new Set<SemanticEventId>();
  const pending = [...baseFrontier];
  while (pending.length > 0) {
    const eventId = pending.pop();
    if (eventId === undefined || closure.has(eventId)) continue;
    if (!accepted.has(eventId)) {
      throw new Error(`Checkpoint frontier dependency ${eventId} is not accepted.`);
    }
    if (eventId === futureCheckpointEventId) {
      throw new Error("Checkpoint coverage cannot contain its enclosing event.");
    }
    const result = await input.read_event(eventId);
    if (result.status !== "valid") {
      throw new Error(`Checkpoint event ${eventId} is ${result.status}: ${result.reason}`);
    }
    if (result.value.event_id !== eventId) {
      throw new Error("Checkpoint event reader returned a record under the wrong ID.");
    }
    closure.add(eventId);
    pending.push(...result.value.core.causal_parent_event_ids);
    if (result.value.core.previous_device_event_id !== null) {
      pending.push(result.value.core.previous_device_event_id);
    }
  }
  const eventIds = [...closure].sort();
  const subInput: CollaborationProjectorInput = Object.freeze({
    ...input,
    accepted_semantic_event_ids: Object.freeze(eventIds),
    accepted_semantic_frontier: Object.freeze([...baseFrontier]),
    onboarding_boundaries: Object.freeze([])
  });
  const history = await loadProjectionHistory(subInput);
  const replay = await projectCollaborationHistory(subInput);
  return Object.freeze({
    event_ids: Object.freeze(eventIds),
    history,
    replay
  });
}

export async function prepareConsolidationCheckpoint(
  input: CheckpointPreparationInput
): Promise<PreparedConsolidationCheckpoint> {
  if (input.reducer_version !== INITIAL_REDUCER_VERSION) {
    throw new Error("Checkpoint preparation received an unknown reducer version.");
  }
  if (!input.projector_input.accepted_control_facts.some(
    (fact) => fact.control_event_id === input.authorizing_control_head_id
  )) {
    throw new Error("Checkpoint control head is not in the accepted control facts.");
  }
  const coverage = await loadCheckpointCoverage(
    input.projector_input,
    input.base_frontier_event_ids,
    input.future_checkpoint_event_id
  );
  const baseFrontierRoot = await deriveBaseFrontierRoot(input.base_frontier_event_ids);
  const acceptedHistoryRoot = await deriveAcceptedHistoryRoot(coverage.history);
  const resultProjection = applyCheckpointResolutionOperations(
    coverage.replay.projection,
    input.resolution_operations
  );
  const semanticRoot = await deriveSemanticStateRoot(resultProjection);
  const revisionRoot = await deriveRevisionHeadsRoot(
    resultProjection,
    input.projector_input
  );
  const conflictRoot = await deriveConflictSetRoot(resultProjection);
  const resolutionHash = await deriveResolutionOperationsHash(
    input.resolution_operations
  );
  const projectionRoot = await deriveCompositeProjectionRoot({
    project_id: input.projector_input.project_id,
    reducer_id: input.reducer_version,
    control_head_id: input.authorizing_control_head_id,
    base_frontier_root: baseFrontierRoot.id,
    accepted_history_root: acceptedHistoryRoot.id,
    result_semantic_state_root: semanticRoot.id,
    result_revision_heads_root: revisionRoot.id,
    result_conflict_set_root: conflictRoot.id,
    resolution_operations_hash: resolutionHash
  });
  const payload = parseConsolidationCheckpointPayload({
    schema_version: 1,
    project_id: input.projector_input.project_id,
    semantic_kind: "consolidation_checkpoint",
    data: {
      base_frontier_event_ids: input.base_frontier_event_ids,
      base_frontier_root: baseFrontierRoot.id,
      accepted_history_root: acceptedHistoryRoot.id,
      resolution_operations: input.resolution_operations,
      result_semantic_state_root: semanticRoot.id,
      result_revision_heads_root: revisionRoot.id,
      result_conflict_set_root: conflictRoot.id,
      projection_root: projectionRoot.id,
      reducer_version: input.reducer_version,
      authorizing_control_head_id: input.authorizing_control_head_id
    }
  });
  return Object.freeze({
    preparation_version: 1,
    authority: "none" as const,
    covered_event_ids: coverage.event_ids,
    base_projection: coverage.replay.projection,
    result_projection: resultProjection,
    payload,
    canonical_payload_preimage_bytes: encodeCanonicalCbor(
      buildSemanticPayloadPreimage(payload)
    ),
    resolution_operations_hash: Uint8Array.from(resolutionHash),
    all_known_work_consolidated:
      sameStrings(
        input.base_frontier_event_ids,
        [...input.projector_input.accepted_semantic_frontier]
      ) && resultProjection.conflicts.length === 0
  });
}

export async function verifyFullHistoryCheckpoint(
  input: FullHistoryCheckpointVerificationInput
): Promise<FullHistoryCheckpointVerificationResult> {
  try {
    const gate = await input.verify_checkpoint_event(input.checkpoint_event_id);
    if (gate.status !== "accepted") return gate;
    const eventResult = await input.projector_input.read_event(
      input.checkpoint_event_id
    );
    if (eventResult.status !== "valid") {
      return Object.freeze({
        status: eventResult.status === "missing" || eventResult.status === "incomplete"
          ? "incomplete_dependencies" as const
          : "invalid" as const,
        reason: `Checkpoint event is ${eventResult.status}: ${eventResult.reason}`
      });
    }
    const payloadResult = await input.projector_input.read_payload(
      eventResult.value.core.semantic_payload_id
    );
    if (payloadResult.status !== "valid") {
      return Object.freeze({
        status: payloadResult.status === "missing" || payloadResult.status === "incomplete"
          ? "incomplete_dependencies" as const
          : "invalid" as const,
        reason: `Checkpoint payload is ${payloadResult.status}: ${payloadResult.reason}`
      });
    }
    const payloadRecord = parseSemanticPayloadRecord(payloadResult.value);
    const event = parseSemanticEventRecord(eventResult.value, payloadRecord);
    if (payloadRecord.core.semantic_kind !== "consolidation_checkpoint") {
      return Object.freeze({ status: "invalid" as const, reason: "Event is not a consolidation checkpoint." });
    }
    const payloadIdentity = await deriveSemanticPayloadIdentity(payloadRecord.core);
    const eventIdentity = await deriveSemanticEventCoreIdentity(event.core);
    if (
      payloadIdentity.id !== payloadRecord.payload_id ||
      eventIdentity.id !== input.checkpoint_event_id ||
      event.event_id !== input.checkpoint_event_id
    ) {
      return Object.freeze({ status: "invalid" as const, reason: "Checkpoint event or payload identity is invalid." });
    }
    assertCheckpointMatchesEvent(
      payloadRecord.core,
      event.core,
      input.checkpoint_event_id
    );
    const checkpointId = checkpointIdForEvent(
      input.checkpoint_event_id,
      event.core,
      payloadRecord.core
    );
    const prepared = await prepareConsolidationCheckpoint({
      projector_input: input.projector_input,
      base_frontier_event_ids: payloadRecord.core.data.base_frontier_event_ids,
      resolution_operations: payloadRecord.core.data.resolution_operations,
      authorizing_control_head_id: payloadRecord.core.data.authorizing_control_head_id,
      reducer_version: requireReducer(payloadRecord.core.data.reducer_version),
      future_checkpoint_event_id: input.checkpoint_event_id
    });
    if (!sameCheckpointCommitments(payloadRecord.core, prepared.payload)) {
      return Object.freeze({ status: "invalid" as const, reason: "Checkpoint commitment recomputation mismatch." });
    }
    return Object.freeze({
      status: "full_history_verified" as const,
      checkpoint_id: checkpointId,
      prepared
    });
  } catch (error) {
    const message = errorMessage(error);
    return Object.freeze({
      status: /missing|incomplete|unavailable/i.test(message)
        ? "incomplete_dependencies" as const
        : "invalid" as const,
      reason: message
    });
  }
}

export function applyCheckpointResolutionOperations(
  value: CollaborationProjection,
  operations: readonly CheckpointResolutionOperation[]
): CollaborationProjection {
  const projection = protocolClone(parseCollaborationProjection(value));
  assertSortedUnique(operations.map((operation) => operation.conflict_id), "resolution operations");
  for (const operation of operations) {
    const conflict = projection.conflicts.find(
      (candidate) => candidate.conflict_id === operation.conflict_id
    );
    if (!conflict) throw new Error(`Resolution names unavailable conflict ${operation.conflict_id}.`);
    const observed = contenderEvents(conflict.core);
    if (!sameStrings(observed, operation.observed_contender_event_ids)) {
      throw new Error("Resolution does not observe the conflict's exact committed contenders.");
    }
    if (operation.operation_kind === "resolve_metadata_conflict") {
      const register = findConflictRegister(projection, conflict.core);
      if (register === null) {
        throw new Error("Conflict does not support metadata resolution through the existing reducer.");
      }
      const contender = register.contenders.find(
        (candidate) => candidate.payload_ids.includes(operation.chosen_payload_id)
      );
      if (!contender) throw new Error("Chosen payload is not an exact conflict contender.");
      replaceRegister(register, contender);
    } else if (operation.operation_kind === "resolve_content_conflict") {
      resolveRevisionConflict(projection, conflict.core, operation.adopted_revision_id);
    } else {
      if (operation.resolution !== "keep_deleted") {
        throw new Error("Tombstone restoration requires a future operation carrying a new identity.");
      }
      const tombstone = findConflictTombstone(projection, conflict.core);
      if (tombstone === null) throw new Error("Conflict does not name a projected tombstone.");
      tombstone.contender_event_ids.splice(0);
    }
    projection.conflicts = projection.conflicts.filter(
      (candidate) => candidate.conflict_id !== operation.conflict_id
    );
  }
  return parseCollaborationProjection(projection);
}

type MutableProjection = ReturnType<typeof protocolClone<CollaborationProjection>>;
type MutableRegister = ReturnType<typeof protocolClone<ProjectedValueRegister>>;

function findConflictRegister(
  projection: MutableProjection,
  core: (MutableProjection["conflicts"])[number]["core"]
): MutableRegister | null {
  if (core.conflict_kind !== "reducer") return null;
  const field = core.field;
  if (core.subject_kind === "project") {
    return field === "title" ? projection.project_title : null;
  }
  if (core.subject_kind === "group") {
    const group = projection.groups.find((entry) => entry.group_id === core.subject_id);
    if (!group) return null;
    return field === "title" ? group.title : field === "position" ? group.position : null;
  }
  if (core.subject_kind === "document") {
    const document = projection.documents.find((entry) => entry.document_id === core.subject_id);
    if (!document) return null;
    const fields: Readonly<Record<string, MutableRegister>> = {
      title: document.title,
      "logical-path": document.logical_path,
      position: document.position,
      group: document.group,
      "archive-status": document.archive_status
    };
    return fields[field] ?? null;
  }
  for (const document of projection.documents) {
    if (core.subject_kind === "comment") {
      const comment = document.comments.find((entry) => entry.comment_id === core.subject_id);
      if (comment) return field === "body" ? comment.body : field === "anchor" ? comment.anchor : field === "status" ? comment.status : null;
    }
    if (core.subject_kind === "reply") {
      const reply = document.comments.flatMap((entry) => entry.replies)
        .find((entry) => entry.reply_id === core.subject_id);
      if (reply) return field === "body" ? reply.body : null;
    }
    if (core.subject_kind === "patch") {
      const patch = document.patches.find((entry) => entry.patch_id === core.subject_id);
      const suffix = field.startsWith("decision-") ? field.slice("decision-".length) : null;
      const version = suffix === null ? undefined : patch?.versions.find(
        (entry) => entry.patch_version_id.endsWith(`:${suffix}`)
      );
      if (version) return version.decision;
    }
  }
  if (core.subject_kind === "review_batch") {
    const batch = projection.review_batches.find((entry) => entry.review_batch_id === core.subject_id);
    if (!batch) return null;
    return field === "lifecycle" ? batch.lifecycle : field === "response" ? batch.responses : null;
  }
  if (core.subject_kind === "rewrite_session") {
    const session = projection.rewrite_sessions.find((entry) => entry.rewrite_session_id === core.subject_id);
    return session && field === "outcome" ? session.outcome : null;
  }
  return null;
}

function replaceRegister(
  register: MutableRegister,
  contender: MutableRegister["contenders"][number]
): void {
  register.state = "resolved";
  register.resolved_value = contender.value;
  register.last_uncontested_value = contender.value;
  register.contenders = [contender];
}

function resolveRevisionConflict(
  projection: MutableProjection,
  core: (MutableProjection["conflicts"])[number]["core"],
  adoptedRevisionId: DocumentRevisionId
): void {
  const documentId = core.conflict_kind === "content"
    ? core.document_id
    : core.conflict_kind === "reducer" && core.reducer_conflict_kind === "revision"
      ? core.subject_id
      : null;
  if (documentId === null) throw new Error("Content resolution requires a revision conflict.");
  const heads = projection.revision_heads.find((entry) => entry.document_id === documentId);
  if (!heads || !heads.head_revision_ids.includes(adoptedRevisionId)) {
    throw new Error("Adopted resolution revision is not an exact current head contender.");
  }
  heads.head_revision_ids = [adoptedRevisionId];
  for (const adoption of heads.adoptions) {
    adoption.is_head = adoption.revision_id === adoptedRevisionId;
  }
}

function findConflictTombstone(
  projection: MutableProjection,
  core: (MutableProjection["conflicts"])[number]["core"]
): ReturnType<typeof protocolClone<NonNullable<MutableProjection["documents"][number]["tombstone"]>>> | null {
  const kind = core.conflict_kind === "tombstone"
    ? core.subject_kind
    : core.conflict_kind === "reducer" && core.reducer_conflict_kind === "tombstone"
      ? core.subject_kind
      : null;
  const id = core.conflict_kind === "tombstone"
    ? core.subject_id
    : core.conflict_kind === "reducer"
      ? core.subject_id
      : null;
  if (kind === null || id === null) return null;
  for (const document of projection.documents) {
    if (kind === "document" && document.document_id === id) return document.tombstone;
    for (const comment of document.comments) {
      if (kind === "comment" && comment.comment_id === id) return comment.tombstone;
      const reply = comment.replies.find((entry) => entry.reply_id === id);
      if (kind === "reply" && reply) return reply.tombstone;
    }
  }
  return null;
}

function contenderEvents(
  core: (MutableProjection["conflicts"])[number]["core"]
): readonly SemanticEventId[] {
  if (core.conflict_kind === "reducer") return core.contender_event_ids;
  if (core.conflict_kind === "tombstone") {
    return [...new Set([core.tombstone_event_id, ...core.contender_event_ids])].sort();
  }
  return [];
}

function sameCheckpointCommitments(
  left: ConsolidationCheckpointPayload,
  right: ConsolidationCheckpointPayload
): boolean {
  return stableString(left) === stableString(right);
}

function requireReducer(value: string): typeof INITIAL_REDUCER_VERSION {
  if (value !== INITIAL_REDUCER_VERSION) throw new Error("Checkpoint uses an unknown reducer.");
  return value;
}

function protocolClone<T>(value: T): Mutable<T> {
  if (Array.isArray(value)) {
    return value.map((entry) => protocolClone(entry)) as Mutable<T>;
  }
  if (value instanceof Uint8Array) return Uint8Array.from(value) as Mutable<T>;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, protocolClone(child)])
    ) as Mutable<T>;
  }
  return value as Mutable<T>;
}

type Mutable<T> = T extends string | number | boolean | bigint | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends Uint8Array
      ? Uint8Array
      : T extends object
        ? { -readonly [K in keyof T]: Mutable<T[K]> }
        : T;

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new Error(`${label} must be sorted and unique.`);
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${stableString(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

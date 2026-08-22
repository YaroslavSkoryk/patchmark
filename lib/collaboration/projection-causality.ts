import { parseAttestationRecord } from "./checkpoints.ts";
import {
  deriveAttestationIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity
} from "./preimages.ts";
import {
  parseSemanticEventRecord,
  parseSemanticPayloadRecord,
  type SemanticEventRecord,
  type SemanticPayloadRecord
} from "./semantic.ts";
import type {
  ControlEventId,
  SemanticEventId
} from "./identities.ts";
import {
  CollaborationProjectionError,
  type AcceptedControlProjectionFacts,
  type CollaborationProjectorInput,
  type ProjectedEventProvenance,
  type ProjectionOnboardingBoundary
} from "./projection-types.ts";
import {
  verifyReviewResponseEvidenceCommitment,
  type ReviewResponseImportId
} from "./review-response-evidence.ts";

export type CausalComparison =
  | "identical"
  | "causally_before"
  | "causally_after"
  | "concurrent";

export type CausalAncestryEntry = Readonly<{
  event_id: SemanticEventId;
  ancestor_event_ids: readonly SemanticEventId[];
}>;

export type CausalAncestryIndex = Readonly<{
  schema_version: 1;
  entries: readonly CausalAncestryEntry[];
}>;

export type LoadedProjectionEvent = Readonly<{
  event: SemanticEventRecord;
  payload: SemanticPayloadRecord;
  provenance: ProjectedEventProvenance;
}>;

export type LoadedProjectionHistory = Readonly<{
  events: readonly LoadedProjectionEvent[];
  topological_event_ids: readonly SemanticEventId[];
  accepted_frontier: readonly SemanticEventId[];
  ancestry: CausalAncestryIndex;
}>;

export async function loadProjectionHistory(
  input: CollaborationProjectorInput
): Promise<LoadedProjectionHistory> {
  const acceptedIds = sortedUnique(input.accepted_semantic_event_ids);
  const acceptedSet = new Set(acceptedIds);
  const boundaries = validateBoundaries(input.onboarding_boundaries, acceptedSet);
  const controlFacts = validateControlFacts(input.accepted_control_facts);
  const loadedById = new Map<SemanticEventId, LoadedProjectionEvent>();

  for (const eventId of acceptedIds) {
    const eventResult = await input.read_event(eventId);
    if (eventResult.status !== "valid") {
      throw readError(eventId, "semantic event", eventResult.status, eventResult.reason);
    }
    const structuralEvent = eventResult.value;
    const payloadResult = await input.read_payload(
      structuralEvent.core.semantic_payload_id
    );
    if (payloadResult.status !== "valid") {
      throw readError(
        structuralEvent.core.semantic_payload_id,
        "semantic payload",
        payloadResult.status,
        payloadResult.reason
      );
    }
    const payload = parseSemanticPayloadRecord(payloadResult.value);
    const event = parseSemanticEventRecord(structuralEvent, payload);
    if (event.event_id !== eventId) {
      throw new CollaborationProjectionError(
        "inconsistent_dependency",
        "The accepted event reader returned a record under the wrong event ID.",
        eventId
      );
    }
    if (event.core.project_id !== input.project_id || payload.core.project_id !== input.project_id) {
      throw new CollaborationProjectionError(
        "cross_project_dependency",
        "An accepted event or payload belongs to another project.",
        eventId
      );
    }
    const payloadIdentity = await deriveSemanticPayloadIdentity(payload.core);
    if (payloadIdentity.id !== payload.payload_id) {
      throw new CollaborationProjectionError(
        "corrupted_dependency",
        "A semantic payload does not match its digest identity.",
        payload.payload_id
      );
    }
    const eventIdentity = await deriveSemanticEventCoreIdentity(event.core);
    if (eventIdentity.id !== event.event_id) {
      throw new CollaborationProjectionError(
        "corrupted_dependency",
        "A semantic event does not match its digest identity.",
        event.event_id
      );
    }
    const fact = controlFacts.get(event.core.authorizing_control_head_id);
    if (!fact) {
      throw new CollaborationProjectionError(
        "missing_dependency",
        "The accepted control facts do not include an event's authorizing head.",
        event.core.authorizing_control_head_id
      );
    }
    const authority = fact.device_authorities.find(
      (candidate) => candidate.device_id === event.core.author_device_id
    );
    if (!authority || authority.status !== "active") {
      throw new CollaborationProjectionError(
        "inconsistent_dependency",
        "The accepted control facts do not authorize an accepted event author.",
        event.event_id
      );
    }
    for (const attestationId of event.author_attestation_ids) {
      const result = await input.read_attestation(attestationId);
      if (result.status !== "valid") {
        throw readError(
          attestationId,
          "semantic attestation",
          result.status,
          result.reason
        );
      }
      const attestation = parseAttestationRecord(result.value);
      const identity = await deriveAttestationIdentity(attestation.core);
      if (
        identity.id !== attestationId ||
        attestation.core.project_id !== input.project_id ||
        attestation.core.subject_kind !== "semantic_event" ||
        attestation.core.subject_id !== eventId
      ) {
        throw new CollaborationProjectionError(
          "corrupted_dependency",
          "An accepted event attestation is inconsistent with its event.",
          attestationId
        );
      }
    }
    loadedById.set(
      eventId,
      Object.freeze({
        event,
        payload,
        provenance: Object.freeze({
          event_id: eventId,
          payload_id: payload.payload_id,
          author_device_id: event.core.author_device_id,
          author_role: authority.role,
          author_attestation_ids: event.author_attestation_ids,
          control_head_id: event.core.authorizing_control_head_id
        })
      })
    );
  }

  validateCausalDependencies(loadedById, acceptedSet, boundaries);
  const topologicalIds = topologicalOrder(loadedById, boundaries);
  const ancestry = buildAncestry(topologicalIds, loadedById, boundaries);
  await validateReviewResponseEvidence(input, loadedById, ancestry);
  const frontier = deriveFrontier(acceptedIds, loadedById);
  const declaredFrontier = sortedUnique(input.accepted_semantic_frontier);
  if (!sameStrings(frontier, declaredFrontier)) {
    throw new CollaborationProjectionError(
      "frontier_mismatch",
      "The declared accepted semantic frontier does not match the accepted event set."
    );
  }
  return Object.freeze({
    events: Object.freeze(
      topologicalIds.map((eventId) => required(loadedById, eventId))
    ),
    topological_event_ids: Object.freeze(topologicalIds),
    accepted_frontier: Object.freeze(frontier),
    ancestry
  });
}

async function validateReviewResponseEvidence(
  input: CollaborationProjectorInput,
  loadedById: ReadonlyMap<SemanticEventId, LoadedProjectionEvent>,
  ancestry: CausalAncestryIndex
): Promise<void> {
  for (const loaded of loadedById.values()) {
    const payload = loaded.payload;
    const responses = payload.core.semantic_kind === "review_batch_operation" &&
        payload.core.data.operation === "respond"
      ? [payload.core.data]
      : payload.core.semantic_kind === "collaboration_bootstrap_import"
        ? payload.core.data.review_batches.filter(
            (batch) => batch.response_evidence_commitment !== null
          )
        : [];
    for (const response of responses) {
      if (
        response.response_evidence_commitment === null ||
        response.response_import_id === null ||
        !await verifyReviewResponseEvidenceCommitment({
          schema_version: 1,
          project_id: input.project_id,
          review_batch_id: response.review_batch_id,
          response_import_id: response.response_import_id,
          contribution_payload_ids: response.contribution_payload_ids
        }, response.response_evidence_commitment)
      ) {
        throw new CollaborationProjectionError(
          "corrupted_dependency",
          "A review response evidence commitment does not match its canonical preimage.",
          loaded.event.event_id
        );
      }
      for (const contributionId of response.contribution_payload_ids) {
        const result = await input.read_payload(contributionId);
        if (result.status !== "valid") {
          throw readError(
            contributionId,
            "review contribution payload",
            result.status,
            result.reason
          );
        }
        const contribution = parseSemanticPayloadRecord(result.value);
        const identity = await deriveSemanticPayloadIdentity(contribution.core);
        if (
          identity.id !== contributionId ||
          contribution.core.project_id !== input.project_id ||
          !isMatchingReviewContribution(
            contribution,
            response.review_batch_id,
            response.response_import_id
          )
        ) {
          throw new CollaborationProjectionError(
            contribution.core.project_id === input.project_id
              ? "corrupted_dependency"
              : "cross_project_dependency",
            "A review contribution payload is not bound to the same project, batch, and response import.",
            contributionId
          );
        }
        if (
          payload.core.semantic_kind === "review_batch_operation" &&
          ![...loadedById.values()].some(
            (candidate) =>
              candidate.payload.payload_id === contributionId &&
              compareSemanticEventCausality(
                ancestry,
                candidate.event.event_id,
                loaded.event.event_id
              ) === "causally_before"
          )
        ) {
          throw new CollaborationProjectionError(
            "inconsistent_dependency",
            "A live review response references a contribution outside its causal past.",
            contributionId
          );
        }
      }
    }
  }
}

function isMatchingReviewContribution(
  payload: SemanticPayloadRecord,
  reviewBatchId: import("./identities.ts").ReviewBatchId,
  responseImportId: ReviewResponseImportId
): boolean {
  if (
    payload.core.semantic_kind === "reply_operation" &&
    (payload.core.data.operation === "create" || payload.core.data.operation === "edit")
  ) {
    return payload.core.data.review_batch_id === reviewBatchId &&
      payload.core.data.response_import_id === responseImportId;
  }
  if (
    payload.core.semantic_kind === "patch_operation" &&
    (payload.core.data.operation === "propose" || payload.core.data.operation === "edit")
  ) {
    return payload.core.data.review_batch_id === reviewBatchId &&
      payload.core.data.response_import_id === responseImportId;
  }
  return false;
}

export function compareSemanticEventCausality(
  ancestry: CausalAncestryIndex,
  left: SemanticEventId,
  right: SemanticEventId
): CausalComparison {
  if (left === right) return "identical";
  const leftEntry = findAncestryEntry(ancestry, left);
  const rightEntry = findAncestryEntry(ancestry, right);
  if (rightEntry.ancestor_event_ids.includes(left)) return "causally_before";
  if (leftEntry.ancestor_event_ids.includes(right)) return "causally_after";
  return "concurrent";
}

export function eventObservesAll(
  ancestry: CausalAncestryIndex,
  eventId: SemanticEventId,
  requiredEventIds: readonly SemanticEventId[]
): boolean {
  const entry = findAncestryEntry(ancestry, eventId);
  return requiredEventIds.every(
    (requiredId) => requiredId === eventId || entry.ancestor_event_ids.includes(requiredId)
  );
}

function validateCausalDependencies(
  loaded: ReadonlyMap<SemanticEventId, LoadedProjectionEvent>,
  accepted: ReadonlySet<SemanticEventId>,
  boundaries: ReadonlyMap<SemanticEventId, ReadonlySet<SemanticEventId>>
): void {
  for (const { event } of loaded.values()) {
    const unavailable = boundaries.get(event.event_id) ?? new Set<SemanticEventId>();
    for (const parentId of event.core.causal_parent_event_ids) {
      if (!accepted.has(parentId) && !unavailable.has(parentId)) {
        throw new CollaborationProjectionError(
          "missing_dependency",
          "An accepted event has a parent outside the accepted set and onboarding boundary.",
          parentId
        );
      }
    }
    if (event.core.previous_device_event_id !== null) {
      const previous = loaded.get(event.core.previous_device_event_id);
      if (!previous) {
        throw new CollaborationProjectionError(
          "missing_dependency",
          "A same-device predecessor cannot be omitted by an onboarding boundary.",
          event.core.previous_device_event_id
        );
      }
      if (
        previous.event.core.author_device_id !== event.core.author_device_id ||
        previous.event.core.device_sequence + BigInt(1) !== event.core.device_sequence
      ) {
        throw new CollaborationProjectionError(
          "inconsistent_dependency",
          "Same-device event ancestry or sequence is inconsistent.",
          event.event_id
        );
      }
    }
  }
}

function topologicalOrder(
  loaded: ReadonlyMap<SemanticEventId, LoadedProjectionEvent>,
  boundaries: ReadonlyMap<SemanticEventId, ReadonlySet<SemanticEventId>>
): SemanticEventId[] {
  const indegree = new Map<SemanticEventId, number>();
  const children = new Map<SemanticEventId, SemanticEventId[]>();
  for (const id of loaded.keys()) indegree.set(id, 0);
  for (const { event } of loaded.values()) {
    const unavailable = boundaries.get(event.event_id) ?? new Set<SemanticEventId>();
    for (const parentId of event.core.causal_parent_event_ids) {
      if (unavailable.has(parentId)) continue;
      indegree.set(event.event_id, (indegree.get(event.event_id) ?? 0) + 1);
      const values = children.get(parentId) ?? [];
      values.push(event.event_id);
      children.set(parentId, values);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const output: SemanticEventId[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    output.push(id);
    for (const child of (children.get(id) ?? []).sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) insertSorted(ready, child);
    }
  }
  if (output.length !== loaded.size) {
    throw new CollaborationProjectionError(
      "causal_cycle",
      "Accepted semantic event ancestry contains a cycle."
    );
  }
  return output;
}

function buildAncestry(
  order: readonly SemanticEventId[],
  loaded: ReadonlyMap<SemanticEventId, LoadedProjectionEvent>,
  boundaries: ReadonlyMap<SemanticEventId, ReadonlySet<SemanticEventId>>
): CausalAncestryIndex {
  const closures = new Map<SemanticEventId, Set<SemanticEventId>>();
  for (const eventId of order) {
    const event = required(loaded, eventId).event;
    const closure = new Set<SemanticEventId>();
    const unavailable = boundaries.get(eventId) ?? new Set<SemanticEventId>();
    for (const parentId of event.core.causal_parent_event_ids) {
      if (unavailable.has(parentId)) continue;
      closure.add(parentId);
      for (const ancestor of closures.get(parentId) ?? []) closure.add(ancestor);
    }
    closures.set(eventId, closure);
  }
  return Object.freeze({
    schema_version: 1,
    entries: Object.freeze(
      [...closures.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([eventId, ancestors]) =>
          Object.freeze({
            event_id: eventId,
            ancestor_event_ids: Object.freeze([...ancestors].sort())
          })
        )
    )
  });
}

function deriveFrontier(
  acceptedIds: readonly SemanticEventId[],
  loaded: ReadonlyMap<SemanticEventId, LoadedProjectionEvent>
): SemanticEventId[] {
  const frontier = new Set(acceptedIds);
  for (const { event } of loaded.values()) {
    for (const parentId of event.core.causal_parent_event_ids) {
      frontier.delete(parentId);
    }
  }
  return [...frontier].sort();
}

function validateBoundaries(
  values: readonly ProjectionOnboardingBoundary[],
  accepted: ReadonlySet<SemanticEventId>
): ReadonlyMap<SemanticEventId, ReadonlySet<SemanticEventId>> {
  const output = new Map<SemanticEventId, ReadonlySet<SemanticEventId>>();
  for (const value of values) {
    if (!accepted.has(value.boundary_event_id) || output.has(value.boundary_event_id)) {
      throw new CollaborationProjectionError(
        "invalid_input",
        "Onboarding boundaries must uniquely reference accepted events.",
        value.boundary_event_id
      );
    }
    const parents = sortedUnique(value.unavailable_parent_event_ids);
    if (parents.length === 0 || parents.some((id) => accepted.has(id))) {
      throw new CollaborationProjectionError(
        "invalid_input",
        "Onboarding boundaries must name unavailable parent events only.",
        value.boundary_event_id
      );
    }
    output.set(value.boundary_event_id, new Set(parents));
  }
  return output;
}

function validateControlFacts(
  values: readonly AcceptedControlProjectionFacts[]
): ReadonlyMap<ControlEventId, AcceptedControlProjectionFacts> {
  const output = new Map<ControlEventId, AcceptedControlProjectionFacts>();
  for (const value of values) {
    if (output.has(value.control_event_id)) {
      throw new CollaborationProjectionError(
        "invalid_input",
        "Accepted control projection facts must be unique.",
        value.control_event_id
      );
    }
    output.set(value.control_event_id, value);
  }
  return output;
}

function findAncestryEntry(
  ancestry: CausalAncestryIndex,
  eventId: SemanticEventId
): CausalAncestryEntry {
  const entry = ancestry.entries.find((candidate) => candidate.event_id === eventId);
  if (!entry) {
    throw new CollaborationProjectionError(
      "invalid_input",
      "Causal comparison requires two accepted events.",
      eventId
    );
  }
  return entry;
}

function readError(
  id: string,
  label: string,
  status: "missing" | "incomplete" | "corrupted" | "mismatched",
  reason: string
): CollaborationProjectionError {
  return new CollaborationProjectionError(
    status === "missing" || status === "incomplete"
      ? "missing_dependency"
      : "corrupted_dependency",
    `${label} ${id} is ${status}: ${reason}`,
    id
  );
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error("Required projection value is missing.");
  return value;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function insertSorted<T extends string>(values: T[], value: T): void {
  let index = 0;
  while (index < values.length && values[index] < value) index += 1;
  values.splice(index, 0, value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import { bytesEqual, bytesToHex } from "./bytes.ts";
import {
  parseDeterministicMergeCandidate,
  type DeterministicMergeCandidate
} from "./derived.ts";
import type { DeviceAuthorityFact } from "./event-control-types.ts";
import type {
  ControlEventId,
  DeviceId,
  DocumentId,
  DocumentRevisionId,
  MarkdownBlobId,
  MergeKeyId,
  SemanticEventId
} from "./identities.ts";
import {
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeKeyIdentity
} from "./preimages.ts";
import {
  findVerifiedRevision,
  isRevisionAncestor,
  loadVerifiedRevisionGraph,
  type RevisionReadBoundary,
  type VerifiedRevisionGraph
} from "./projection-revisions.ts";
import { CollaborationProjectionError } from "./projection-types.ts";
import { sha256 } from "./sha256.ts";
import {
  INITIAL_MERGE_ALGORITHM_ID,
  INITIAL_MERGE_ALGORITHM_VERSION,
  MERGE_CANDIDATE_SCHEMA_VERSION,
  MERGE_KEY_CORE_SCHEMA_VERSION,
  REVISION_CORE_SCHEMA_VERSION
} from "./versions.ts";

export type SectionMoveProvenance = Readonly<{
  provenance_version: 1;
  moving_revision_id: DocumentRevisionId;
  editing_revision_id: DocumentRevisionId;
  source_start_line: number;
  source_end_line: number;
  target_line: number;
  uniqueness: "unique_verified_section";
}>;

export type MarkdownMergeCandidateInput = RevisionReadBoundary &
  Readonly<{
    document_id: DocumentId;
    base_revision_id: DocumentRevisionId | null;
    parent_revision_ids: readonly DocumentRevisionId[];
    merge_algorithm_id: string;
    merge_algorithm_version: string;
    section_move_provenance?: readonly SectionMoveProvenance[];
  }>;

export type MergeEvidence = Readonly<{
  evidence_version: 1;
  classification:
    | "exact_identical_bytes"
    | "disjoint_line_operations"
    | "unique_section_move_and_edit";
  operation_descriptions: readonly string[];
}>;

export type ProvenMarkdownMergeCandidate = Readonly<{
  status: "candidate";
  authority: "none";
  classification: "identical" | "proven_safe";
  exact_markdown_bytes: Uint8Array;
  markdown_blob_id: MarkdownBlobId;
  revision_core: import("./content.ts").OrdinaryRevisionCore;
  revision_id: DocumentRevisionId;
  merge_key_id: MergeKeyId;
  candidate: DeterministicMergeCandidate;
  evidence: MergeEvidence;
}>;

export type MarkdownMergeCalculation =
  | Readonly<{
      status: "not_required";
      reason: "single_head" | "fast_forward";
      resulting_head_revision_id: DocumentRevisionId;
    }>
  | ProvenMarkdownMergeCandidate
  | Readonly<{
      status: "conflict";
      reason:
        | "overlapping_edits"
        | "same_position_insertions"
        | "delete_edit_overlap"
        | "ambiguous_section_move";
      conflicting_revision_ids: readonly DocumentRevisionId[];
    }>
  | Readonly<{
      status: "unsupported";
      reason:
        | "missing_base"
        | "base_not_common_ancestor"
        | "unsupported_algorithm"
        | "insufficient_provenance";
    }>
  | Readonly<{
      status: "invalid";
      reason: string;
      dependency_id: string | null;
    }>;

type LineOperation = Readonly<{
  start: number;
  end: number;
  replacement: readonly string[];
  source_revision_ids: readonly DocumentRevisionId[];
}>;

export async function calculateMarkdownMergeCandidate(
  input: MarkdownMergeCandidateInput
): Promise<MarkdownMergeCalculation> {
  try {
    if (
      input.merge_algorithm_id !== INITIAL_MERGE_ALGORITHM_ID ||
      input.merge_algorithm_version !== INITIAL_MERGE_ALGORITHM_VERSION
    ) {
      return Object.freeze({
        status: "unsupported" as const,
        reason: "unsupported_algorithm" as const
      });
    }
    const parents = sortedUnique(input.parent_revision_ids);
    if (parents.length === 0) {
      return invalid("At least one adopted parent revision is required.");
    }
    const roots = sortedUnique([
      ...parents,
      ...(input.base_revision_id === null ? [] : [input.base_revision_id])
    ]);
    const graph = await loadVerifiedRevisionGraph(
      input,
      roots,
      input.document_id
    );
    const reducedParents = parents.filter(
      (candidate) =>
        !parents.some(
          (other) =>
            candidate !== other && isRevisionAncestor(graph, candidate, other)
        )
    );
    if (reducedParents.length === 1) {
      return Object.freeze({
        status: "not_required" as const,
        reason: parents.length === 1 ? "single_head" as const : "fast_forward" as const,
        resulting_head_revision_id: reducedParents[0]
      });
    }
    const verifiedParents = reducedParents.map((revisionId) =>
      requireRevision(graph, revisionId)
    );
    if (verifiedParents.every((candidate) =>
      bytesEqual(candidate.markdown_bytes, verifiedParents[0].markdown_bytes)
    )) {
      return buildCandidate(
        input,
        reducedParents,
        input.base_revision_id,
        verifiedParents[0].markdown_bytes,
        "identical",
        Object.freeze({
          evidence_version: 1,
          classification: "exact_identical_bytes" as const,
          operation_descriptions: Object.freeze([])
        })
      );
    }
    if (input.base_revision_id === null) {
      return Object.freeze({
        status: "unsupported" as const,
        reason: "missing_base" as const
      });
    }
    if (
      reducedParents.some(
        (parentId) =>
          parentId !== input.base_revision_id &&
          !isRevisionAncestor(graph, input.base_revision_id as DocumentRevisionId, parentId)
      )
    ) {
      return Object.freeze({
        status: "unsupported" as const,
        reason: "base_not_common_ancestor" as const
      });
    }
    const base = requireRevision(graph, input.base_revision_id);
    const baseLines = decodeExactUtf8Lines(base.markdown_bytes);
    const operations = verifiedParents.flatMap((revision) =>
      deriveLineOperations(
        baseLines,
        decodeExactUtf8Lines(revision.markdown_bytes),
        revision.record.revision_id
      )
    );
    const combined = combineIdenticalOperations(operations);
    const conflict = findOperationConflict(combined);
    if (conflict !== null) {
      const moved = trySectionMoveMerge(
        input,
        graph,
        baseLines,
        reducedParents
      );
      if (moved !== null) {
        return buildCandidate(
          input,
          reducedParents,
          input.base_revision_id,
          encodeExactUtf8Lines(moved.lines),
          "proven_safe",
          Object.freeze({
            evidence_version: 1,
            classification: "unique_section_move_and_edit" as const,
            operation_descriptions: Object.freeze(moved.descriptions.sort())
          })
        );
      }
      return Object.freeze({
        status: "conflict" as const,
        reason: conflict,
        conflicting_revision_ids: Object.freeze(
          sortedUnique(
            combined.flatMap((operation) => operation.source_revision_ids)
          )
        )
      });
    }
    const mergedLines = applyLineOperations(baseLines, combined);
    return buildCandidate(
      input,
      reducedParents,
      input.base_revision_id,
      encodeExactUtf8Lines(mergedLines),
      "proven_safe",
      Object.freeze({
        evidence_version: 1,
        classification: "disjoint_line_operations" as const,
        operation_descriptions: Object.freeze(
          combined.map(describeOperation).sort()
        )
      })
    );
  } catch (error) {
    if (error instanceof CollaborationProjectionError) {
      return invalid(error.message, error.dependency_id);
    }
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

async function buildCandidate(
  input: MarkdownMergeCandidateInput,
  parents: readonly DocumentRevisionId[],
  baseRevisionId: DocumentRevisionId | null,
  resultBytes: Uint8Array,
  classification: "identical" | "proven_safe",
  evidence: MergeEvidence
): Promise<ProvenMarkdownMergeCandidate> {
  const blob = await deriveMarkdownBlobIdentity(input.project_id, resultBytes);
  const revisionCore = Object.freeze({
    schema_version: REVISION_CORE_SCHEMA_VERSION,
    object_kind: "document_revision_core" as const,
    ancestry_kind: "ordinary" as const,
    project_id: input.project_id,
    document_id: input.document_id,
    markdown_blob_id: blob.id,
    parent_revision_ids: Object.freeze([...parents].sort())
  });
  const revision = await deriveDocumentRevisionIdentity(revisionCore);
  const mergeKeyCore = Object.freeze({
    schema_version: MERGE_KEY_CORE_SCHEMA_VERSION,
    object_kind: "merge_key_core" as const,
    project_id: input.project_id,
    document_id: input.document_id,
    parent_revision_ids: revisionCore.parent_revision_ids,
    base_revision_id: baseRevisionId,
    result_revision_id: revision.id,
    merge_algorithm_id: input.merge_algorithm_id,
    merge_algorithm_version: input.merge_algorithm_version
  });
  const mergeKey = await deriveMergeKeyIdentity(mergeKeyCore);
  const candidate = parseDeterministicMergeCandidate({
    schema_version: MERGE_CANDIDATE_SCHEMA_VERSION,
    object_kind: "deterministic_merge_candidate",
    authority: "none",
    merge_key_id: mergeKey.id,
    merge_key_core: mergeKeyCore,
    outcome: classification
  });
  return Object.freeze({
    status: "candidate" as const,
    authority: "none" as const,
    classification,
    exact_markdown_bytes: Uint8Array.from(resultBytes),
    markdown_blob_id: blob.id,
    revision_core: revisionCore,
    revision_id: revision.id,
    merge_key_id: mergeKey.id,
    candidate,
    evidence
  });
}

function deriveLineOperations(
  base: readonly string[],
  changed: readonly string[],
  sourceRevisionId: DocumentRevisionId
): LineOperation[] {
  const table = Array.from({ length: base.length + 1 }, () =>
    Array<number>(changed.length + 1).fill(0)
  );
  for (let left = base.length - 1; left >= 0; left -= 1) {
    for (let right = changed.length - 1; right >= 0; right -= 1) {
      table[left][right] = base[left] === changed[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }
  const output: LineOperation[] = [];
  let baseIndex = 0;
  let changedIndex = 0;
  let operationStart: number | null = null;
  let operationEnd = 0;
  let replacement: string[] = [];
  const flush = () => {
    if (operationStart === null) return;
    output.push(Object.freeze({
      start: operationStart,
      end: operationEnd,
      replacement: Object.freeze(replacement),
      source_revision_ids: Object.freeze([sourceRevisionId])
    }));
    operationStart = null;
    replacement = [];
  };
  while (baseIndex < base.length || changedIndex < changed.length) {
    if (
      baseIndex < base.length &&
      changedIndex < changed.length &&
      base[baseIndex] === changed[changedIndex]
    ) {
      flush();
      baseIndex += 1;
      changedIndex += 1;
      continue;
    }
    if (operationStart === null) {
      operationStart = baseIndex;
      operationEnd = baseIndex;
    }
    if (
      changedIndex < changed.length &&
      (baseIndex === base.length ||
        table[baseIndex][changedIndex + 1] >= table[baseIndex + 1][changedIndex])
    ) {
      replacement.push(changed[changedIndex]);
      changedIndex += 1;
    } else {
      baseIndex += 1;
      operationEnd = baseIndex;
    }
  }
  flush();
  return output;
}

function combineIdenticalOperations(
  operations: readonly LineOperation[]
): LineOperation[] {
  const groups = new Map<string, LineOperation>();
  for (const operation of operations) {
    const key = `${operation.start}:${operation.end}:${JSON.stringify(operation.replacement)}`;
    const current = groups.get(key);
    groups.set(
      key,
      Object.freeze({
        ...operation,
        source_revision_ids: Object.freeze(
          sortedUnique([
            ...(current?.source_revision_ids ?? []),
            ...operation.source_revision_ids
          ])
        )
      })
    );
  }
  return [...groups.values()].sort(compareOperations);
}

function findOperationConflict(
  operations: readonly LineOperation[]
): "overlapping_edits" | "same_position_insertions" | "delete_edit_overlap" | null {
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const left = operations[leftIndex];
      const right = operations[rightIndex];
      if (left.source_revision_ids.some((id) => right.source_revision_ids.includes(id))) {
        continue;
      }
      if (left.start === left.end && right.start === right.end) {
        if (left.start === right.start) return "same_position_insertions";
        continue;
      }
      if (left.start === left.end || right.start === right.end) {
        const insertion = left.start === left.end ? left : right;
        const edit = insertion === left ? right : left;
        if (insertion.start >= edit.start && insertion.start <= edit.end) {
          return "delete_edit_overlap";
        }
        continue;
      }
      if (Math.max(left.start, right.start) < Math.min(left.end, right.end)) {
        if (left.replacement.length === 0 || right.replacement.length === 0) {
          return "delete_edit_overlap";
        }
        return "overlapping_edits";
      }
    }
  }
  return null;
}

function applyLineOperations(
  base: readonly string[],
  operations: readonly LineOperation[]
): string[] {
  const output = [...base];
  for (const operation of [...operations].sort((left, right) =>
    right.start - left.start || right.end - left.end
  )) {
    output.splice(
      operation.start,
      operation.end - operation.start,
      ...operation.replacement
    );
  }
  return output;
}

function trySectionMoveMerge(
  input: MarkdownMergeCandidateInput,
  graph: VerifiedRevisionGraph,
  baseLines: readonly string[],
  parents: readonly DocumentRevisionId[]
): Readonly<{ lines: string[]; descriptions: string[] }> | null {
  if (parents.length !== 2 || input.section_move_provenance?.length !== 1) {
    return null;
  }
  const provenance = input.section_move_provenance[0];
  if (
    provenance.provenance_version !== 1 ||
    provenance.uniqueness !== "unique_verified_section" ||
    !parents.includes(provenance.moving_revision_id) ||
    !parents.includes(provenance.editing_revision_id) ||
    provenance.moving_revision_id === provenance.editing_revision_id ||
    !validRange(
      provenance.source_start_line,
      provenance.source_end_line,
      baseLines.length
    ) ||
    provenance.target_line < 0 ||
    provenance.target_line > baseLines.length
  ) {
    return null;
  }
  const moving = decodeExactUtf8Lines(
    requireRevision(graph, provenance.moving_revision_id).markdown_bytes
  );
  const editing = decodeExactUtf8Lines(
    requireRevision(graph, provenance.editing_revision_id).markdown_bytes
  );
  const source = baseLines.slice(
    provenance.source_start_line,
    provenance.source_end_line
  );
  const expectedMove = moveLines(
    baseLines,
    provenance.source_start_line,
    provenance.source_end_line,
    provenance.target_line,
    source
  );
  if (!sameStrings(moving, expectedMove)) return null;
  const editOperations = deriveLineOperations(
    baseLines,
    editing,
    provenance.editing_revision_id
  );
  if (
    editOperations.length === 0 ||
    editOperations.some(
      (operation) =>
        operation.start < provenance.source_start_line ||
        operation.end > provenance.source_end_line
    )
  ) {
    return null;
  }
  const relativeOperations = editOperations.map((operation) =>
    Object.freeze({
      ...operation,
      start: operation.start - provenance.source_start_line,
      end: operation.end - provenance.source_start_line
    })
  );
  const editedSource = applyLineOperations(source, relativeOperations);
  return Object.freeze({
    lines: moveLines(
      baseLines,
      provenance.source_start_line,
      provenance.source_end_line,
      provenance.target_line,
      editedSource
    ),
    descriptions: [
      `move:${provenance.source_start_line}-${provenance.source_end_line}->${provenance.target_line}`,
      ...editOperations.map(describeOperation)
    ]
  });
}

function moveLines(
  base: readonly string[],
  start: number,
  end: number,
  target: number,
  replacement: readonly string[]
): string[] {
  const output = [...base];
  output.splice(start, end - start);
  const adjustedTarget = target > end ? target - (end - start) : target;
  output.splice(adjustedTarget, 0, ...replacement);
  return output;
}

function decodeExactUtf8Lines(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text = decoder.decode(bytes);
  const roundTrip = new TextEncoder().encode(text);
  if (!bytesEqual(bytes, roundTrip)) {
    throw new Error("Markdown must be exact, well-formed UTF-8 bytes.");
  }
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      output.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) output.push(text.slice(start));
  return output;
}

function encodeExactUtf8Lines(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join(""));
}

function requireRevision(
  graph: VerifiedRevisionGraph,
  revisionId: DocumentRevisionId
) {
  const revision = findVerifiedRevision(graph, revisionId);
  if (!revision) throw new Error(`Verified revision ${revisionId} is unavailable.`);
  return revision;
}

function describeOperation(operation: LineOperation): string {
  return `${operation.start}:${operation.end}:${operation.replacement.length}`;
}

function compareOperations(left: LineOperation, right: LineOperation): number {
  return left.start - right.start || left.end - right.end ||
    compareStrings(left.replacement.join(""), right.replacement.join(""));
}

function validRange(start: number, end: number, length: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= length;
}

function invalid(
  reason: string,
  dependencyId: string | null = null
): Extract<MarkdownMergeCalculation, { status: "invalid" }> {
  return Object.freeze({ status: "invalid", reason, dependency_id: dependencyId });
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type AcceptedMergeAuthorizationAttempt = Readonly<{
  event_id: SemanticEventId;
  merge_key_id: MergeKeyId;
  author_device_id: DeviceId;
}>;

export type MergeAuthorizationEligibilityInput = Readonly<{
  merge_key_id: MergeKeyId;
  outcome: "identical" | "proven_safe" | "requires_resolution";
  policy: "manual" | "auto_safe";
  policy_control_head_id: ControlEventId;
  device_authorities: readonly DeviceAuthorityFact[];
  online_device_ids: readonly DeviceId[];
  accepted_attempts: readonly AcceptedMergeAuthorizationAttempt[];
}>;

export type MergeAuthorizationEligibility = Readonly<{
  authority: "none";
  merge_key_id: MergeKeyId;
  manual_authorizer_device_ids: readonly DeviceId[];
  automatic_proposer_device_id: DeviceId | null;
  automatic_proposer_online: boolean;
  automatic_attempt_available: boolean;
  accepted_authorization_event_ids: readonly SemanticEventId[];
}>;

export async function deriveMergeAuthorizationEligibility(
  input: MergeAuthorizationEligibilityInput
): Promise<MergeAuthorizationEligibility> {
  const eligible = input.device_authorities
    .filter(
      (fact) =>
        fact.status === "active" &&
        (fact.role === "owner" || fact.role === "editor") &&
        fact.capabilities.includes("authorize_safe_merge")
    )
    .map((fact) => fact.device_id)
    .sort();
  const attempts = input.accepted_attempts
    .filter((attempt) => input.merge_key_id === attempt.merge_key_id)
    .sort((left, right) => compareStrings(left.event_id, right.event_id));
  let proposer: DeviceId | null = null;
  if (
    input.policy === "auto_safe" &&
    input.outcome === "proven_safe" &&
    eligible.length > 0
  ) {
    const scores = await Promise.all(
      eligible.map(async (deviceId) => ({
        deviceId,
        score: bytesToHex(
          await sha256(
            new TextEncoder().encode(
              `patchmark/merge-proposer-rendezvous/v1\u0000${input.merge_key_id}\u0000${deviceId}`
            )
          )
        )
      }))
    );
    scores.sort((left, right) =>
      compareStrings(right.score, left.score) ||
      compareStrings(left.deviceId, right.deviceId)
    );
    proposer = scores[0].deviceId;
  }
  const alreadyAttempted = proposer === null
    ? false
    : attempts.some((attempt) => attempt.author_device_id === proposer);
  return Object.freeze({
    authority: "none" as const,
    merge_key_id: input.merge_key_id,
    manual_authorizer_device_ids: Object.freeze(eligible),
    automatic_proposer_device_id: proposer,
    automatic_proposer_online:
      proposer !== null && input.online_device_ids.includes(proposer),
    automatic_attempt_available: proposer !== null && !alreadyAttempted,
    accepted_authorization_event_ids: Object.freeze(
      sortedUnique(attempts.map((attempt) => attempt.event_id))
    )
  });
}

import {
  areConciseAnchorHistoryStatesEqual,
  convertLegacyAnchorHistoryEntryToConcise,
  createConciseAnchorHistoryState,
  isConciseAnchorHistoryEntry
} from "./comment-anchor-history.ts";
import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetResolution
} from "./canonical-target-resolution.ts";
import type {
  PatchmarkComment,
  PatchmarkCommentAnchorHistoryEntry,
  PatchmarkCommentPatchImpact,
  PatchmarkConciseAnchorHistoryState,
  PatchmarkConciseCommentAnchorHistoryEntry,
  PatchmarkPatch
} from "../project/project-types.ts";

type CompactionRule =
  | "canonical_equivalence_guard"
  | "editing_session_coalescing"
  | "exact_duplicate"
  | "legacy_conversion"
  | "no_effect"
  | "patch_impact_duplicate"
  | "recovery_ping_pong"
  | "recursive_history_flattening";

type WorkingHistoryEntry = {
  entry: PatchmarkConciseCommentAnchorHistoryEntry;
  legacy: boolean;
};

export type CommentHistoryCompactionCommentReport = {
  comment_id: string;
  bytes_before: number;
  bytes_after: number;
  history_count_before: number;
  history_count_after: number;
  patch_impact_count_before: number;
  patch_impact_count_after: number;
  rules_applied: CompactionRule[];
  current_anchor_hash_before: string;
  expected_current_anchor_hash_after: string;
  canonical_resolution_before: CanonicalResolutionSignature;
  canonical_resolution_after: CanonicalResolutionSignature;
};

export type CommentHistoryCompactionReport = {
  comments_file_bytes: number;
  compact_json_bytes: number;
  estimated_output_bytes: number;
  estimated_output_compact_bytes: number;
  estimated_reduction_bytes: number;
  estimated_reduction_percentage: number;
  comment_count: number;
  comments_affected: number;
  comments_unchanged: number;
  legacy_history_count: number;
  concise_history_count: number;
  recursive_entry_count: number;
  recursive_max_depth: number;
  recursive_bytes_before: number;
  recursive_bytes_after: number;
  duplicate_entry_count: number;
  no_effect_entry_count: number;
  ping_pong_sequence_count: number;
  ping_pong_entries_suppressed: number;
  editing_session_coalescing_count: number;
  editing_session_entries_suppressed: number;
  patch_impact_duplicate_count: number;
  technical_thread_duplicate_count: number;
  technical_thread_duplicate_bytes: number;
  warnings: string[];
  blocking_validation_errors: string[];
  per_comment: CommentHistoryCompactionCommentReport[];
};

export type CommentHistoryCompactionResult = {
  comments: PatchmarkComment[];
  report: CommentHistoryCompactionReport;
};

type CanonicalResolutionSignature = {
  cardinality: CanonicalTargetResolution["cardinality"];
  range?: { start: number; end: number };
  state: CanonicalTargetResolution["state"];
  structural_context?: CanonicalTargetResolution["structuralContext"];
};

type MutableCompactionCounters = {
  recursiveEntryCount: number;
  recursiveMaxDepth: number;
  recursiveBytesBefore: number;
  recursiveBytesAfter: number;
  duplicateEntryCount: number;
  noEffectEntryCount: number;
  pingPongSequenceCount: number;
  pingPongEntriesSuppressed: number;
  editingSessionCoalescingCount: number;
  editingSessionEntriesSuppressed: number;
  patchImpactDuplicateCount: number;
};

export function compactLegacyCommentHistory({
  comments,
  commentsFileBytes,
  markdown,
  patches
}: {
  comments: PatchmarkComment[];
  commentsFileBytes?: number;
  markdown: string;
  patches: PatchmarkPatch[];
}): CommentHistoryCompactionResult {
  const counters: MutableCompactionCounters = {
    recursiveEntryCount: 0,
    recursiveMaxDepth: 0,
    recursiveBytesBefore: 0,
    recursiveBytesAfter: 0,
    duplicateEntryCount: 0,
    noEffectEntryCount: 0,
    pingPongSequenceCount: 0,
    pingPongEntriesSuppressed: 0,
    editingSessionCoalescingCount: 0,
    editingSessionEntriesSuppressed: 0,
    patchImpactDuplicateCount: 0
  };
  const warnings: string[] = [];
  const blockingValidationErrors: string[] = [];
  const perComment: CommentHistoryCompactionCommentReport[] = [];
  const compactedComments = comments.map((comment) => {
    const result = compactComment({
      comment,
      counters,
      markdown,
      patches,
      warnings
    });
    perComment.push(result.report);
    return result.comment;
  });

  validateProtectedCommentFields({
    after: compactedComments,
    before: comments,
    blockingValidationErrors
  });

  const beforePrettyBytes = serializedPrettyBytes(comments);
  const afterPrettyBytes = serializedPrettyBytes(compactedComments);
  const beforeCompactBytes = serializedBytes(comments);
  const afterCompactBytes = serializedBytes(compactedComments);
  const technicalThreadAudit = auditTechnicalThreadDuplicates(comments);
  const commentsAffected = perComment.filter(
    (row) =>
      row.history_count_before !== row.history_count_after ||
      row.patch_impact_count_before !== row.patch_impact_count_after ||
      row.bytes_before !== row.bytes_after
  ).length;

  return {
    comments: compactedComments,
    report: {
      comments_file_bytes: commentsFileBytes ?? beforePrettyBytes,
      compact_json_bytes: beforeCompactBytes,
      estimated_output_bytes: afterPrettyBytes,
      estimated_output_compact_bytes: afterCompactBytes,
      estimated_reduction_bytes: Math.max(0, beforePrettyBytes - afterPrettyBytes),
      estimated_reduction_percentage: percentage(
        Math.max(0, beforePrettyBytes - afterPrettyBytes),
        beforePrettyBytes
      ),
      comment_count: comments.length,
      comments_affected: commentsAffected,
      comments_unchanged: comments.length - commentsAffected,
      legacy_history_count: comments.reduce(
        (total, comment) =>
          total +
          (comment.anchor_history ?? []).filter(
            (entry) => !isConciseAnchorHistoryEntry(entry)
          ).length,
        0
      ),
      concise_history_count: comments.reduce(
        (total, comment) =>
          total +
          (comment.anchor_history ?? []).filter(isConciseAnchorHistoryEntry)
            .length,
        0
      ),
      recursive_entry_count: counters.recursiveEntryCount,
      recursive_max_depth: counters.recursiveMaxDepth,
      recursive_bytes_before: counters.recursiveBytesBefore,
      recursive_bytes_after: counters.recursiveBytesAfter,
      duplicate_entry_count: counters.duplicateEntryCount,
      no_effect_entry_count: counters.noEffectEntryCount,
      ping_pong_sequence_count: counters.pingPongSequenceCount,
      ping_pong_entries_suppressed: counters.pingPongEntriesSuppressed,
      editing_session_coalescing_count:
        counters.editingSessionCoalescingCount,
      editing_session_entries_suppressed:
        counters.editingSessionEntriesSuppressed,
      patch_impact_duplicate_count: counters.patchImpactDuplicateCount,
      technical_thread_duplicate_count: technicalThreadAudit.count,
      technical_thread_duplicate_bytes: technicalThreadAudit.bytes,
      warnings,
      blocking_validation_errors: blockingValidationErrors,
      per_comment: perComment.filter((row) => row.rules_applied.length > 0)
    }
  };
}

function compactComment({
  comment,
  counters,
  markdown,
  patches,
  warnings
}: {
  comment: PatchmarkComment;
  counters: MutableCompactionCounters;
  markdown: string;
  patches: PatchmarkPatch[];
  warnings: string[];
}): {
  comment: PatchmarkComment;
  report: CommentHistoryCompactionCommentReport;
} {
  const originalHistory = comment.anchor_history ?? [];
  const rules = new Set<CompactionRule>();
  const historyResult = compactHistory({
    comment,
    counters,
    rules
  });
  const impactResult = compactPatchImpacts(comment.patch_impacts ?? []);

  if (impactResult.removed > 0) {
    rules.add("patch_impact_duplicate");
    counters.patchImpactDuplicateCount += impactResult.removed;
  }

  let compactedComment: PatchmarkComment = {
    ...comment,
    anchor_history:
      historyResult.history.length > 0 ? historyResult.history : undefined,
    patch_impacts:
      impactResult.impacts.length > 0 ? impactResult.impacts : undefined
  };
  const beforeResolution = createCanonicalResolutionSignature(
    resolveCanonicalCommentTarget(comment, { markdown, patches })
  );
  let afterResolution = createCanonicalResolutionSignature(
    resolveCanonicalCommentTarget(compactedComment, { markdown, patches })
  );

  if (!areCanonicalResolutionSignaturesEqual(beforeResolution, afterResolution)) {
    compactedComment = {
      ...compactedComment,
      anchor_history: comment.anchor_history
    };
    afterResolution = createCanonicalResolutionSignature(
      resolveCanonicalCommentTarget(compactedComment, { markdown, patches })
    );
    rules.add("canonical_equivalence_guard");
    warnings.push(
      `${comment.id}: legacy anchor history was retained because concise conversion changed the canonical target.`
    );
  }

  const anchorHash = stableHashValue(comment.anchor);

  return {
    comment: compactedComment,
    report: {
      comment_id: comment.id,
      bytes_before: serializedBytes(comment),
      bytes_after: serializedBytes(compactedComment),
      history_count_before: originalHistory.length,
      history_count_after: compactedComment.anchor_history?.length ?? 0,
      patch_impact_count_before: comment.patch_impacts?.length ?? 0,
      patch_impact_count_after: compactedComment.patch_impacts?.length ?? 0,
      rules_applied: [...rules].sort(),
      current_anchor_hash_before: anchorHash,
      expected_current_anchor_hash_after: stableHashValue(
        compactedComment.anchor
      ),
      canonical_resolution_before: beforeResolution,
      canonical_resolution_after: afterResolution
    }
  };
}

function compactHistory({
  comment,
  counters,
  rules
}: {
  comment: PatchmarkComment;
  counters: MutableCompactionCounters;
  rules: Set<CompactionRule>;
}): { history: PatchmarkCommentAnchorHistoryEntry[] } {
  const history = comment.anchor_history ?? [];
  const conciseSemanticKeys = new Set(
    history
      .filter(isConciseAnchorHistoryEntry)
      .map((entry) => createHistorySemanticKey(comment.id, entry))
  );
  const seenLegacySemanticKeys = new Set<string>();
  const working: WorkingHistoryEntry[] = [];

  for (const originalEntry of history) {
    if (isConciseAnchorHistoryEntry(originalEntry)) {
      working.push({ entry: originalEntry, legacy: false });
      continue;
    }

    const recursive = auditRecursiveHistoricalPayload(originalEntry);
    const converted = convertLegacyAnchorHistoryEntryToConcise({
      commentId: comment.id,
      entry: originalEntry
    });
    counters.recursiveMaxDepth = Math.max(
      counters.recursiveMaxDepth,
      recursive.maxDepth
    );

    if (recursive.affected) {
      counters.recursiveEntryCount += 1;
      counters.recursiveBytesBefore += serializedBytes(originalEntry);
      counters.recursiveBytesAfter += serializedBytes(converted);
      rules.add("recursive_history_flattening");
    }

    rules.add("legacy_conversion");

    if (isNoEffectTransition(converted)) {
      counters.noEffectEntryCount += 1;
      rules.add("no_effect");
      continue;
    }

    const semanticKey = createHistorySemanticKey(comment.id, converted);

    if (
      conciseSemanticKeys.has(semanticKey) ||
      seenLegacySemanticKeys.has(semanticKey)
    ) {
      counters.duplicateEntryCount += 1;
      rules.add("exact_duplicate");
      continue;
    }

    seenLegacySemanticKeys.add(semanticKey);
    working.push({ entry: converted, legacy: true });
  }

  const editingCoalesced = coalesceLegacyEditingSessions({
    entries: working,
    counters,
    rules
  });
  const pingPongCollapsed = collapseRecoveryPingPong({
    currentState: createConciseAnchorHistoryState(comment.anchor, "active"),
    entries: editingCoalesced,
    counters,
    rules
  });

  return { history: pingPongCollapsed.map(({ entry }) => entry) };
}

function coalesceLegacyEditingSessions({
  entries,
  counters,
  rules
}: {
  entries: WorkingHistoryEntry[];
  counters: MutableCompactionCounters;
  rules: Set<CompactionRule>;
}): WorkingHistoryEntry[] {
  const result: WorkingHistoryEntry[] = [];
  let index = 0;

  while (index < entries.length) {
    const first = entries[index];

    if (!isRoutineLegacyEditingEntry(first)) {
      result.push(first);
      index += 1;
      continue;
    }

    const group = [first];
    let nextIndex = index + 1;

    while (
      nextIndex < entries.length &&
      isSameRoutineEditingSession(first, entries[nextIndex]) &&
      areTransitionStatesContinuous(group.at(-1)!.entry, entries[nextIndex].entry)
    ) {
      group.push(entries[nextIndex]);
      nextIndex += 1;
    }

    if (group.length < 2) {
      result.push(first);
      index += 1;
      continue;
    }

    const last = group.at(-1)!;
    const coalesced: PatchmarkConciseCommentAnchorHistoryEntry = {
      ...first.entry,
      history_id: createCoalescedHistoryId(first.entry, last.entry),
      next: last.entry.next,
      document_hash_after: last.entry.document_hash_after,
      method: first.entry.method ?? last.entry.method,
      confidence: first.entry.confidence ?? last.entry.confidence
    };
    result.push({ entry: coalesced, legacy: true });
    counters.editingSessionCoalescingCount += 1;
    counters.editingSessionEntriesSuppressed += group.length - 1;
    rules.add("editing_session_coalescing");
    index = nextIndex;
  }

  return result;
}

function collapseRecoveryPingPong({
  currentState,
  entries,
  counters,
  rules
}: {
  currentState: PatchmarkConciseAnchorHistoryState;
  entries: WorkingHistoryEntry[];
  counters: MutableCompactionCounters;
  rules: Set<CompactionRule>;
}): WorkingHistoryEntry[] {
  const result: WorkingHistoryEntry[] = [];

  for (const current of entries) {
    const previous = result.at(-1);

    if (!previous || !isSafeRecoveryReversePair(previous, current)) {
      result.push(current);
      continue;
    }

    const previousNext = previous.entry.next;
    const currentNext = current.entry.next;

    if (
      previousNext &&
      areConciseAnchorHistoryStatesEqual(previousNext, currentState)
    ) {
      counters.pingPongSequenceCount += 1;
      counters.pingPongEntriesSuppressed += 1;
      rules.add("recovery_ping_pong");
      continue;
    }

    if (
      currentNext &&
      areConciseAnchorHistoryStatesEqual(currentNext, currentState)
    ) {
      result.pop();
      result.push(current);
      counters.pingPongSequenceCount += 1;
      counters.pingPongEntriesSuppressed += 1;
      rules.add("recovery_ping_pong");
      continue;
    }

    result.push(current);
  }

  return result;
}

function compactPatchImpacts(
  impacts: PatchmarkCommentPatchImpact[]
): { impacts: PatchmarkCommentPatchImpact[]; removed: number } {
  const seen = new Set<string>();
  const compacted = impacts.filter((impact) => {
    const record = { ...(impact as Record<string, unknown>) };
    delete record.impacted_at;
    const semanticKey = stableSerialize(record);

    if (seen.has(semanticKey)) {
      return false;
    }

    seen.add(semanticKey);
    return true;
  });

  return { impacts: compacted, removed: impacts.length - compacted.length };
}

function isNoEffectTransition(
  entry: PatchmarkConciseCommentAnchorHistoryEntry
): boolean {
  return (
    !entry.next ||
    areConciseAnchorHistoryStatesEqual(entry.previous, entry.next)
  );
}

function isRoutineLegacyEditingEntry(entry: WorkingHistoryEntry): boolean {
  return Boolean(
    entry.legacy &&
      entry.entry.cause === "manual_edit" &&
      entry.entry.mutation_generation !== undefined &&
      entry.entry.next?.state === "active" &&
      entry.entry.previous.state === "active" &&
      !entry.entry.source_patch_id
  );
}

function isSameRoutineEditingSession(
  first: WorkingHistoryEntry,
  second: WorkingHistoryEntry
): boolean {
  return Boolean(
    isRoutineLegacyEditingEntry(second) &&
      first.entry.mutation_generation === second.entry.mutation_generation &&
      first.entry.source_id === second.entry.source_id
  );
}

function areTransitionStatesContinuous(
  first: PatchmarkConciseCommentAnchorHistoryEntry,
  second: PatchmarkConciseCommentAnchorHistoryEntry
): boolean {
  return Boolean(
    first.next &&
      areConciseAnchorHistoryStatesEqual(first.next, second.previous)
  );
}

function isSafeRecoveryReversePair(
  first: WorkingHistoryEntry,
  second: WorkingHistoryEntry
): boolean {
  if (
    !first.legacy ||
    !second.legacy ||
    !first.entry.next ||
    !second.entry.next ||
    !isRecoveryCause(first.entry.cause) ||
    !isRecoveryCause(second.entry.cause) ||
    first.entry.source_patch_id !== second.entry.source_patch_id ||
    first.entry.source_id !== second.entry.source_id ||
    first.entry.mutation_generation !== second.entry.mutation_generation
  ) {
    return false;
  }

  return (
    areConciseAnchorHistoryStatesEqual(
      first.entry.previous,
      second.entry.next
    ) &&
    areConciseAnchorHistoryStatesEqual(first.entry.next, second.entry.previous)
  );
}

function isRecoveryCause(
  cause: PatchmarkConciseCommentAnchorHistoryEntry["cause"]
): boolean {
  return cause === "canonical_recovery" || cause === "historical_convergence";
}

function createHistorySemanticKey(
  commentId: string,
  entry: PatchmarkConciseCommentAnchorHistoryEntry
): string {
  return stableSerialize({
    cause: entry.cause,
    commentId,
    documentHashAfter: entry.document_hash_after,
    documentHashBefore: entry.document_hash_before,
    impactKind: entry.impact_kind,
    mutationGeneration: entry.mutation_generation,
    next: entry.next,
    previous: entry.previous,
    reason: entry.reason,
    sourceId: entry.source_id,
    sourcePatchId: entry.source_patch_id
  });
}

function createCoalescedHistoryId(
  first: PatchmarkConciseCommentAnchorHistoryEntry,
  last: PatchmarkConciseCommentAnchorHistoryEntry
): string {
  return `PM-HISTORY-${stableHashText(
    stableSerialize({
      cause: first.cause,
      first: first.history_id,
      last: last.history_id,
      mutationGeneration: first.mutation_generation,
      next: last.next,
      previous: first.previous,
      sourceId: first.source_id
    })
  )}`;
}

function auditRecursiveHistoricalPayload(value: unknown): {
  affected: boolean;
  maxDepth: number;
} {
  let affected = false;
  let maxDepth = 0;

  function visit(current: unknown, depth: number, path: string[]): void {
    if (!current || typeof current !== "object") {
      return;
    }

    maxDepth = Math.max(maxDepth, depth);

    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child, depth + 1, path);
      }
      return;
    }

    const record = current as Record<string, unknown>;
    const keys = Object.keys(record);
    const isNestedHistory = keys.some((key) =>
      ["anchor_history", "recovery_history", "anchor_recovery_history"].includes(
        key
      )
    );
    const isNestedComment =
      path.length > 0 &&
      typeof record.id === "string" &&
      typeof record.comment === "string" &&
      "anchor" in record;
    const isNestedPatch =
      path.length > 0 &&
      typeof record.id === "string" &&
      typeof record.original_text === "string" &&
      typeof record.suggested_text === "string";

    if (isNestedHistory || isNestedComment || isNestedPatch) {
      affected = true;
    }

    for (const [key, child] of Object.entries(record)) {
      visit(child, depth + 1, [...path, key]);
    }
  }

  visit(value, 0, []);
  return { affected, maxDepth };
}

function auditTechnicalThreadDuplicates(comments: PatchmarkComment[]): {
  bytes: number;
  count: number;
} {
  let bytes = 0;
  let count = 0;

  for (const comment of comments) {
    const seen = new Set<string>();

    for (const entry of comment.thread) {
      if (
        entry.role !== "system" ||
        !/anchor|reanchor|recover|patch|offset|position/i.test(entry.content)
      ) {
        continue;
      }

      const key = stableSerialize({
        content: entry.content,
        sourceImportId: entry.source_import_id,
        sourcePatchId: entry.source_patch_id
      });

      if (seen.has(key)) {
        count += 1;
        bytes += serializedBytes(entry);
      } else {
        seen.add(key);
      }
    }
  }

  return { bytes, count };
}

function validateProtectedCommentFields({
  after,
  before,
  blockingValidationErrors
}: {
  after: PatchmarkComment[];
  before: PatchmarkComment[];
  blockingValidationErrors: string[];
}): void {
  if (after.length !== before.length) {
    blockingValidationErrors.push("Comment count changed during compaction.");
    return;
  }

  for (let index = 0; index < before.length; index += 1) {
    const beforeComment = before[index];
    const afterComment = after[index];
    const beforeProtected = omitCompactedFields(beforeComment);
    const afterProtected = omitCompactedFields(afterComment);

    if (stableSerialize(beforeProtected) !== stableSerialize(afterProtected)) {
      blockingValidationErrors.push(
        `${beforeComment.id}: a protected comment field changed during compaction.`
      );
    }

    if (
      stableSerialize(beforeComment.thread) !== stableSerialize(afterComment.thread)
    ) {
      blockingValidationErrors.push(
        `${beforeComment.id}: comment thread content changed during compaction.`
      );
    }
  }
}

function omitCompactedFields(
  comment: PatchmarkComment
): Omit<PatchmarkComment, "anchor_history" | "patch_impacts"> {
  const protectedFields = { ...comment };
  delete protectedFields.anchor_history;
  delete protectedFields.patch_impacts;
  return protectedFields;
}

function createCanonicalResolutionSignature(
  resolution: CanonicalTargetResolution
): CanonicalResolutionSignature {
  return {
    cardinality: resolution.cardinality,
    range: resolution.range,
    state: resolution.state,
    structural_context: resolution.structuralContext
  };
}

function areCanonicalResolutionSignaturesEqual(
  first: CanonicalResolutionSignature,
  second: CanonicalResolutionSignature
): boolean {
  return stableSerialize(first) === stableSerialize(second);
}

function percentage(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 100;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function serializedPrettyBytes(value: unknown): number {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).length;
}

function stableHashValue(value: unknown): string {
  return `fnv1a64:${stableHashText(stableSerialize(value))}`;
}

function stableHashText(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (const byte of new TextEncoder().encode(value)) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }

  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

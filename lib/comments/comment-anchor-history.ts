import type {
  PatchmarkCommentAnchor,
  PatchmarkCommentAnchorHistoryEntry,
  PatchmarkConciseAnchorHistoryState,
  PatchmarkConciseCommentAnchorHistoryEntry,
  PatchmarkLegacyCommentAnchorHistoryEntry
} from "../project/project-types.ts";

const HISTORY_EXCERPT_LIMIT = 240;

type AnchorHistoryState = NonNullable<
  PatchmarkConciseAnchorHistoryState["state"]
>;

export function appendConciseAnchorHistory({
  cause,
  commentId,
  confidence,
  documentHashAfter,
  documentHashBefore,
  history,
  impactKind,
  method,
  mutationGeneration,
  nextAnchor,
  nextState = "active",
  previousAnchor,
  previousState = "active",
  reason,
  sourceId,
  sourcePatchId,
  timestamp
}: {
  cause: PatchmarkConciseCommentAnchorHistoryEntry["cause"];
  commentId: string;
  confidence?: string;
  documentHashAfter?: string;
  documentHashBefore?: string;
  history?: PatchmarkCommentAnchorHistoryEntry[];
  impactKind?: PatchmarkConciseCommentAnchorHistoryEntry["impact_kind"];
  method?: string;
  mutationGeneration?: number;
  nextAnchor?: PatchmarkCommentAnchor;
  nextState?: AnchorHistoryState;
  previousAnchor: PatchmarkCommentAnchor;
  previousState?: AnchorHistoryState;
  reason: PatchmarkCommentAnchorHistoryEntry["reason"];
  sourceId?: string;
  sourcePatchId?: string;
  timestamp: string;
}): PatchmarkCommentAnchorHistoryEntry[] | undefined {
  const previous = createConciseAnchorHistoryState(previousAnchor, previousState);
  const next = nextAnchor
    ? createConciseAnchorHistoryState(nextAnchor, nextState)
    : nextState !== "active"
      ? createConciseAnchorHistoryState(previousAnchor, nextState)
      : undefined;

  if (next && areConciseAnchorStatesEqual(previous, next)) {
    return history;
  }

  const semanticKey = createHistorySemanticKey({
    cause,
    commentId,
    impactKind,
    mutationGeneration,
    next,
    previous,
    reason,
    sourceId,
    sourcePatchId
  });
  const historyId = `PM-HISTORY-${stableHash(semanticKey)}`;
  const nextEntry: PatchmarkConciseCommentAnchorHistoryEntry = {
    format_version: 2,
    history_id: historyId,
    changed_at: timestamp,
    reason,
    cause,
    source_id: sourceId,
    source_patch_id: sourcePatchId,
    mutation_generation: mutationGeneration,
    previous,
    next,
    impact_kind: impactKind,
    method,
    confidence,
    document_hash_before: documentHashBefore,
    document_hash_after: documentHashAfter
  };
  const existingHistory = history ?? [];

  if (
    existingHistory.some(
      (entry) =>
        isConciseAnchorHistoryEntry(entry) && entry.history_id === historyId
    )
  ) {
    return history;
  }

  const latestEntry = existingHistory.at(-1);

  if (
    latestEntry &&
    createExistingHistorySemanticKey(commentId, latestEntry) === semanticKey
  ) {
    return history;
  }

  if (
    next &&
    isRecoveryCause(cause) &&
    latestEntry &&
    isReverseTransition({
      commentId,
      entry: latestEntry,
      next,
      previous,
      sourcePatchId
    })
  ) {
    return history;
  }

  return [...existingHistory, nextEntry];
}

export function isConciseAnchorHistoryEntry(
  entry: PatchmarkCommentAnchorHistoryEntry
): entry is PatchmarkConciseCommentAnchorHistoryEntry {
  return entry.format_version === 2;
}

export function getHistoryPreviousAnchor(
  entry: PatchmarkCommentAnchorHistoryEntry
): PatchmarkCommentAnchor | null {
  return isConciseAnchorHistoryEntry(entry)
    ? restoreAnchorFromConciseState(entry.previous)
    : entry.previous_anchor;
}

export function getHistoryNextAnchor(
  entry: PatchmarkCommentAnchorHistoryEntry
): PatchmarkCommentAnchor | null {
  return isConciseAnchorHistoryEntry(entry)
    ? entry.next
      ? restoreAnchorFromConciseState(entry.next)
      : null
    : entry.new_anchor ?? null;
}

export function getHistoryAnchorState(
  entry: PatchmarkCommentAnchorHistoryEntry,
  side: "previous" | "next"
): PatchmarkConciseAnchorHistoryState | null {
  if (isConciseAnchorHistoryEntry(entry)) {
    return side === "previous" ? entry.previous : entry.next ?? null;
  }

  const anchor = side === "previous" ? entry.previous_anchor : entry.new_anchor;
  return anchor ? createConciseAnchorHistoryState(anchor, "active") : null;
}

export function createConciseAnchorHistoryState(
  anchor: PatchmarkCommentAnchor,
  state: AnchorHistoryState
): PatchmarkConciseAnchorHistoryState {
  if (anchor.kind === "document") {
    return { kind: "document", start: 0, end: 0, state };
  }

  if (anchor.kind === "section") {
    return {
      kind: "section",
      start: anchor.section_start_offset,
      end: anchor.section_end_offset,
      containing_heading: anchor.heading,
      containing_heading_path: anchor.heading_path,
      state
    };
  }

  const selectedText = anchor.selected_text;
  const excerpt = selectedText.slice(0, HISTORY_EXCERPT_LIMIT);

  return {
    kind: "selected_text",
    start:
      anchor.markdown_start_offset ??
      anchor.anchor_context?.markdown_start_offset,
    end:
      anchor.markdown_end_offset ?? anchor.anchor_context?.markdown_end_offset,
    selected_text_hash:
      anchor.selected_text_hash ?? `fnv1a64:${stableHash(selectedText)}`,
    selected_text_excerpt: excerpt,
    selected_text_length: selectedText.length,
    containing_heading: anchor.containing_heading,
    containing_heading_path: anchor.containing_heading_path,
    state
  };
}

function restoreAnchorFromConciseState(
  evidence: PatchmarkConciseAnchorHistoryState
): PatchmarkCommentAnchor | null {
  if (evidence.kind === "document") {
    return { kind: "document" };
  }

  if (evidence.kind === "section") {
    if (!evidence.containing_heading) {
      return null;
    }

    return {
      kind: "section",
      heading: evidence.containing_heading,
      heading_path: evidence.containing_heading_path,
      section_start_offset: evidence.start,
      section_end_offset: evidence.end
    };
  }

  if (
    evidence.selected_text_excerpt === undefined ||
    evidence.selected_text_length !== evidence.selected_text_excerpt.length
  ) {
    return null;
  }

  return {
    kind: "selected_text",
    selected_text: evidence.selected_text_excerpt,
    selected_text_hash: evidence.selected_text_hash,
    markdown_start_offset: evidence.start,
    markdown_end_offset: evidence.end,
    containing_heading: evidence.containing_heading,
    containing_heading_path: evidence.containing_heading_path
  };
}

function areConciseAnchorStatesEqual(
  first: PatchmarkConciseAnchorHistoryState,
  second: PatchmarkConciseAnchorHistoryState
): boolean {
  return stableSerialize(first) === stableSerialize(second);
}

function createHistorySemanticKey({
  cause,
  commentId,
  impactKind,
  mutationGeneration,
  next,
  previous,
  reason,
  sourceId,
  sourcePatchId
}: {
  cause: PatchmarkConciseCommentAnchorHistoryEntry["cause"];
  commentId: string;
  impactKind?: PatchmarkConciseCommentAnchorHistoryEntry["impact_kind"];
  mutationGeneration?: number;
  next?: PatchmarkConciseAnchorHistoryState;
  previous: PatchmarkConciseAnchorHistoryState;
  reason: PatchmarkCommentAnchorHistoryEntry["reason"];
  sourceId?: string;
  sourcePatchId?: string;
}): string {
  return stableSerialize({
    cause,
    commentId,
    impactKind,
    mutationGeneration,
    next,
    previous,
    reason,
    sourceId,
    sourcePatchId
  });
}

function createExistingHistorySemanticKey(
  commentId: string,
  entry: PatchmarkCommentAnchorHistoryEntry
): string | null {
  if (isConciseAnchorHistoryEntry(entry)) {
    return createHistorySemanticKey({
      cause: entry.cause,
      commentId,
      impactKind: entry.impact_kind,
      mutationGeneration: entry.mutation_generation,
      next: entry.next,
      previous: entry.previous,
      reason: entry.reason,
      sourceId: entry.source_id,
      sourcePatchId: entry.source_patch_id
    });
  }

  return createHistorySemanticKey({
    cause: causeForLegacyEntry(entry),
    commentId,
    impactKind: entry.impact_kind,
    next: entry.new_anchor
      ? createConciseAnchorHistoryState(entry.new_anchor, "active")
      : undefined,
    previous: createConciseAnchorHistoryState(entry.previous_anchor, "active"),
    reason: entry.reason,
    sourcePatchId: entry.source_patch_id
  });
}

function causeForLegacyEntry(
  entry: PatchmarkLegacyCommentAnchorHistoryEntry
): PatchmarkConciseCommentAnchorHistoryEntry["cause"] {
  return entry.reason === "anchor_recovered_after_patch"
    ? "canonical_recovery"
    : "patch_apply";
}

function isReverseTransition({
  commentId,
  entry,
  next,
  previous,
  sourcePatchId
}: {
  commentId: string;
  entry: PatchmarkCommentAnchorHistoryEntry;
  next: PatchmarkConciseAnchorHistoryState;
  previous: PatchmarkConciseAnchorHistoryState;
  sourcePatchId?: string;
}): boolean {
  const existingPrevious = getHistoryAnchorState(entry, "previous");
  const existingNext = getHistoryAnchorState(entry, "next");

  return Boolean(
    existingPrevious &&
      existingNext &&
      entry.source_patch_id === sourcePatchId &&
      areConciseAnchorStatesEqual(existingPrevious, next) &&
      areConciseAnchorStatesEqual(existingNext, previous) &&
      createExistingHistorySemanticKey(commentId, entry)
  );
}

function isRecoveryCause(
  cause: PatchmarkConciseCommentAnchorHistoryEntry["cause"]
): boolean {
  return cause === "canonical_recovery" || cause === "historical_convergence";
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

function stableHash(value: string): string {
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

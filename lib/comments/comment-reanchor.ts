import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetCandidate,
  type CanonicalTargetConfidence,
  type CanonicalTargetMethod,
  type CanonicalTargetResolution
} from "./canonical-target-resolution.ts";
import { appendConciseAnchorHistory } from "./comment-anchor-history.ts";
import { createVisualTableAnchorProjection } from "./comment-anchor-visual-projection.ts";
import {
  findMarkdownTableContainingRange,
  type TextRange
} from "../markdown/markdown-tables.ts";
import {
  buildMarkdownPlainTextIndex,
  findMarkdownPlainTextMatches,
  getMarkdownPlainText
} from "../markdown/markdown-text.ts";
import {
  parseMarkdownHeadings,
  type MarkdownHeading
} from "../markdown/parse-headings.ts";
import type {
  PatchmarkComment,
  PatchmarkCommentAnchor,
  PatchmarkPatch,
  PatchmarkSelectedTextAnchorContextKind
} from "../project/project-types.ts";

const CONTEXT_CHARS = 220;

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

export type HumanReanchorSource = "candidate" | "markdown" | "visual";

export type HumanReanchorCandidate = {
  confidence: CanonicalTargetConfidence;
  containingHeading?: string;
  contextExcerpt: string;
  id: string;
  range: TextRange;
  reason: string;
  selectedText: string;
  structureLabel: string;
};

export type HumanReanchorProposal = HumanReanchorCandidate & {
  anchor: SelectedTextAnchor;
  commentId: string;
  documentId: string;
  documentGeneration: number;
  documentHash: string;
  projectId: string;
  saveGeneration: number;
  source: HumanReanchorSource;
};

export type HumanReanchorResult =
  | {
      kind: "applied";
      comment: PatchmarkComment;
      historyAdded: boolean;
    }
  | { kind: "no_op" }
  | { kind: "resolved_comment" }
  | { kind: "stale"; message: string };

export function createHumanReanchorCandidates({
  markdown,
  headings = parseMarkdownHeadings(markdown),
  resolution
}: {
  headings?: MarkdownHeading[];
  markdown: string;
  resolution: CanonicalTargetResolution;
}): HumanReanchorCandidate[] {
  const byRange = new Map<string, CanonicalTargetCandidate>();

  for (const candidate of resolution.candidates) {
    if (!isCurrentRange(markdown, candidate.range)) {
      continue;
    }

    const id = createHumanReanchorCandidateId(candidate.range);
    const current = byRange.get(id);

    if (!current || getConfidenceRank(candidate.confidence) > getConfidenceRank(current.confidence)) {
      byRange.set(id, candidate);
    }
  }

  return [...byRange.values()]
    .sort(
      (first, second) =>
        first.range.start - second.range.start ||
        first.range.end - second.range.end
    )
    .map((candidate) =>
      createHumanReanchorCandidate({
        confidence: candidate.confidence,
        headings,
        markdown,
        range: candidate.range,
        reason: getCandidateReason(candidate.supportingMethods)
      })
    );
}

export function createHumanReanchorProposal({
  commentId,
  documentId,
  documentGeneration,
  projectId,
  saveGeneration,
  markdown,
  headings = parseMarkdownHeadings(markdown),
  previousAnchor,
  range,
  source
}: {
  commentId: string;
  documentId: string;
  documentGeneration: number;
  projectId: string;
  saveGeneration: number;
  headings?: MarkdownHeading[];
  markdown: string;
  previousAnchor: SelectedTextAnchor;
  range: TextRange;
  source: HumanReanchorSource;
}): HumanReanchorProposal {
  if (!isCurrentRange(markdown, range) || range.end <= range.start) {
    throw new Error("Choose a non-empty location in the current document.");
  }
  if (!documentId.trim()) {
    throw new Error("Document identity is required for human re-anchor.");
  }
  if (!projectId.trim() || !commentId.trim()) {
    throw new Error(
      "Project and comment identity are required for human re-anchor."
    );
  }

  const candidate = createHumanReanchorCandidate({
    confidence: "high",
    headings,
    markdown,
    range,
    reason: getProposalReason(source)
  });

  return {
    ...candidate,
    anchor: createNativeSelectedTextAnchorFromRange({
      headings,
      markdown,
      previousAnchor,
      range,
      source
    }),
    commentId,
    documentId,
    documentGeneration,
    documentHash: createDocumentHash(markdown),
    projectId,
    saveGeneration,
    source
  };
}

export function applyHumanReanchor({
  comment,
  currentDocumentId,
  currentDocumentGeneration,
  currentProjectId,
  currentSaveGeneration,
  markdown,
  patches = [],
  proposal,
  timestamp
}: {
  comment: PatchmarkComment;
  currentDocumentId: string;
  currentDocumentGeneration: number;
  currentProjectId: string;
  currentSaveGeneration: number;
  markdown: string;
  patches?: PatchmarkPatch[];
  proposal: HumanReanchorProposal;
  timestamp: string;
}): HumanReanchorResult {
  if (comment.status === "resolved") {
    return { kind: "resolved_comment" };
  }

  if (comment.anchor.kind !== "selected_text") {
    return {
      kind: "stale",
      message: "Only selected-text comments can be re-anchored."
    };
  }

  if (
    currentProjectId !== proposal.projectId ||
    currentDocumentId !== proposal.documentId ||
    comment.id !== proposal.commentId ||
    currentDocumentGeneration !== proposal.documentGeneration ||
    currentSaveGeneration !== proposal.saveGeneration ||
    createDocumentHash(markdown) !== proposal.documentHash ||
    !isCurrentRange(markdown, proposal.range) ||
    markdown.slice(proposal.range.start, proposal.range.end) !==
      proposal.selectedText
  ) {
    return {
      kind: "stale",
      message:
        "The document changed or switched while you were choosing an anchor. Please select the location again."
    };
  }

  const currentResolution = resolveCanonicalCommentTarget(comment, {
    markdown,
    patches
  });

  if (
    currentResolution.state === "resolved" &&
    currentResolution.range?.start === proposal.range.start &&
    currentResolution.range.end === proposal.range.end &&
    markdown.slice(proposal.range.start, proposal.range.end) ===
      comment.anchor.selected_text
  ) {
    return { kind: "no_op" };
  }

  const nextAnchor = createNativeSelectedTextAnchorFromRange({
    headings: parseMarkdownHeadings(markdown),
    markdown,
    previousAnchor: comment.anchor,
    range: proposal.range,
    source: proposal.source
  });
  const nextHistory = appendConciseAnchorHistory({
    cause: "human_reanchor",
    commentId: comment.id,
    confidence: "human_confirmed",
    documentHashAfter: proposal.documentHash,
    documentHashBefore: proposal.documentHash,
    history: comment.anchor_history,
    method: "human_reanchor",
    mutationGeneration: currentSaveGeneration + 1,
    nextAnchor,
    nextState: "active",
    previousAnchor: comment.anchor,
    previousState: getHistoryState(currentResolution),
    reason: "anchor_reanchored_by_human",
    sourceId: `${proposal.source}:${proposal.id}`,
    timestamp
  });

  return {
    kind: "applied",
    comment: {
      ...comment,
      anchor: nextAnchor,
      anchor_history: nextHistory,
      updated_at: timestamp
    },
    historyAdded:
      (nextHistory?.length ?? 0) > (comment.anchor_history?.length ?? 0)
  };
}

export function createDocumentHash(markdown: string): string {
  return `fnv1a64:${stableHash(markdown)}`;
}

export function mapVisibleSelectionToMarkdownRange({
  contextMarkdown,
  contextStart,
  selectedVisibleText,
  visibleEnd,
  visibleStart
}: {
  contextMarkdown: string;
  contextStart: number;
  selectedVisibleText: string;
  visibleEnd?: number;
  visibleStart?: number;
}): TextRange | null {
  const normalizedSelectedText = normalizeVisibleText(selectedVisibleText);
  let localRange: TextRange | null = null;

  if (
    typeof visibleStart === "number" &&
    typeof visibleEnd === "number" &&
    visibleEnd > visibleStart
  ) {
    const textIndex = buildMarkdownPlainTextIndex(contextMarkdown);
    const localStart = textIndex.positions[visibleStart];
    const localEnd = textIndex.positions[visibleEnd - 1];

    if (
      typeof localStart === "number" &&
      typeof localEnd === "number" &&
      normalizeVisibleText(textIndex.text.slice(visibleStart, visibleEnd)) ===
        normalizedSelectedText
    ) {
      localRange = { start: localStart, end: localEnd + 1 };
    }
  }

  if (!localRange) {
    const matches = findMarkdownPlainTextMatches(
      contextMarkdown,
      normalizedSelectedText
    );
    localRange = matches.length === 1 ? matches[0] : null;
  }

  if (!localRange) {
    return null;
  }

  const expandedRange = expandCompleteMarkdownLinkRange({
    contextMarkdown,
    range: localRange,
    selectedVisibleText: normalizedSelectedText
  });

  return {
    start: contextStart + expandedRange.start,
    end: contextStart + expandedRange.end
  };
}

export function expandMarkdownRangeForVisibleSelection({
  markdown,
  range,
  selectedVisibleText
}: {
  markdown: string;
  range: TextRange;
  selectedVisibleText: string;
}): TextRange {
  return expandCompleteMarkdownLinkRange({
    contextMarkdown: markdown,
    range,
    selectedVisibleText: normalizeVisibleText(selectedVisibleText)
  });
}

export function createHumanReanchorCandidateId(range: TextRange): string {
  return `${range.start}:${range.end}`;
}

function createHumanReanchorCandidate({
  confidence = "high",
  headings,
  markdown,
  range,
  reason = "Selected manually in the current document."
}: {
  confidence?: CanonicalTargetConfidence;
  headings: MarkdownHeading[];
  markdown: string;
  range: TextRange;
  reason?: string;
}): HumanReanchorCandidate {
  const heading = getHeadingContainingOffset(markdown, headings, range.start);
  const selectedText = markdown.slice(range.start, range.end);
  const tableProjection = createVisualTableAnchorProjection({ markdown, range });
  const structureLabel = tableProjection
    ? tableProjection.rows.length === 1 && tableProjection.rows[0].cells.length > 1
      ? "Table row"
      : "Table cell"
    : getRangeStructureLabel(selectedText);

  return {
    confidence,
    containingHeading: heading?.text,
    contextExcerpt: createContextExcerpt(markdown, range),
    id: createHumanReanchorCandidateId(range),
    range: { ...range },
    reason,
    selectedText,
    structureLabel
  };
}

function getCandidateReason(methods: CanonicalTargetMethod[]): string {
  if (methods.includes("exact")) {
    return "Exact text match in the current document.";
  }
  if (methods.includes("normalized") || methods.includes("markdown_plain")) {
    return "Normalized text match in the current document.";
  }
  if (
    methods.includes("context") ||
    methods.includes("linked_comment_context") ||
    methods.includes("linked_comment_structure")
  ) {
    return "Contextual match using the historical anchor surroundings.";
  }
  if (
    methods.includes("table_structural") ||
    methods.includes("accepted_patch_replacement")
  ) {
    return "Structural match derived from the current table or patch history.";
  }
  return "Deterministic candidate from the current anchor history.";
}

function getProposalReason(source: HumanReanchorSource): string {
  if (source === "candidate") {
    return "Suggested location selected for human confirmation.";
  }
  return source === "markdown"
    ? "Selected manually in Markdown Mode."
    : "Selected manually in Visual Mode.";
}

export function createNativeSelectedTextAnchorFromRange({
  headings,
  markdown,
  previousAnchor,
  range,
  source
}: {
  headings: MarkdownHeading[];
  markdown: string;
  previousAnchor: SelectedTextAnchor;
  range: TextRange;
  source: HumanReanchorSource;
}): SelectedTextAnchor {
  const selectedText = markdown.slice(range.start, range.end);
  const containingHeading = getHeadingContainingOffset(
    markdown,
    headings,
    range.start
  );
  const fallbackSectionRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : null;
  const contextRange = getAnchorContextRange(markdown, range);
  const contextText = markdown.slice(contextRange.start, contextRange.end);
  const table = findMarkdownTableContainingRange(markdown, range);
  const tableProjection = table
    ? createVisualTableAnchorProjection({ markdown, range })
    : null;
  const projectedRow = tableProjection?.rows.length === 1
    ? tableProjection.rows[0]
    : null;
  const projectedCell = projectedRow?.cells.length === 1
    ? projectedRow.cells[0]
    : null;
  const tableRow = table && projectedRow
    ? table.rows[projectedRow.markdownRowIndex]
    : null;

  return {
    kind: "selected_text",
    selected_text: selectedText,
    selected_text_hash: `fnv1a64:${stableHash(selectedText)}`,
    anchor_context: {
      kind: getAnchorContextKind({
        contextText,
        hasTable: Boolean(table),
        selectedText
      }),
      plain_text: getMarkdownPlainText(contextText),
      markdown_text: contextText,
      selected_start_in_context: range.start - contextRange.start,
      selected_end_in_context: range.end - contextRange.start,
      context_hash: `fnv1a64:${stableHash(contextText)}`,
      markdown_start_offset: contextRange.start,
      markdown_end_offset: contextRange.end,
      table_index: tableProjection?.tableIndex,
      table_row_index: projectedRow?.markdownRowIndex,
      table_cell_index: projectedCell?.cellIndex,
      table_row_start_offset: tableRow?.start,
      table_row_end_offset: tableRow?.end,
      table_cell_start_offset: projectedCell?.sourceStart,
      table_cell_end_offset: projectedCell?.sourceEnd
    },
    markdown_start_offset: range.start,
    markdown_end_offset: range.end,
    context_before: markdown.slice(Math.max(0, range.start - CONTEXT_CHARS), range.start),
    context_after: markdown.slice(range.end, Math.min(markdown.length, range.end + CONTEXT_CHARS)),
    containing_heading: containingHeading?.text,
    containing_heading_level: containingHeading?.level,
    containing_heading_line: containingHeading?.line,
    containing_heading_path: containingHeading
      ? getHeadingPath(headings, containingHeading)
      : undefined,
    anchor_source: source === "visual" ? "visual" : "markdown",
    fallback_section_start_offset: fallbackSectionRange?.start,
    fallback_section_end_offset: fallbackSectionRange?.end,
    action_context: previousAnchor.action_context
  };
}

function getAnchorContextRange(markdown: string, range: TextRange): TextRange {
  const table = findMarkdownTableContainingRange(markdown, range);

  if (table) {
    const rows = table.rows.filter(
      (row) => range.start < row.end && row.start < range.end
    );

    if (rows.length > 0) {
      return {
        start: rows[0].start,
        end: rows[rows.length - 1].end
      };
    }

    return { start: table.start, end: table.end };
  }

  let start = markdown.lastIndexOf("\n\n", Math.max(0, range.start - 1));
  start = start === -1 ? 0 : start + 2;
  let end = markdown.indexOf("\n\n", range.end);
  end = end === -1 ? markdown.length : end;

  return trimRange(markdown, { start, end });
}

function getAnchorContextKind({
  contextText,
  hasTable,
  selectedText
}: {
  contextText: string;
  hasTable: boolean;
  selectedText: string;
}): PatchmarkSelectedTextAnchorContextKind {
  if (hasTable) {
    return "table_cell";
  }

  if (selectedText.includes("\n\n") || selectedText.split("\n").filter(Boolean).length > 1) {
    return "section";
  }

  const trimmed = contextText.trimStart();

  if (/^#{1,6}\s/.test(trimmed)) {
    return "heading";
  }

  if (/^(?:[-*+]\s|\d+\.\s)/.test(trimmed)) {
    return "list_item";
  }

  if (/^>\s?/.test(trimmed)) {
    return "blockquote";
  }

  return contextText.includes("\n") ? "block" : "paragraph";
}

function getRangeStructureLabel(selectedText: string): string {
  const trimmed = selectedText.trimStart();

  if (selectedText.includes("\n\n") || selectedText.split("\n").filter(Boolean).length > 1) {
    return "Multiple blocks";
  }

  if (/^#{1,6}\s/.test(trimmed)) {
    return "Heading";
  }

  if (/^(?:[-*+]\s|\d+\.\s)/.test(trimmed)) {
    return selectedText.includes("\n") ? "List and text" : "List item";
  }

  if (/\[[^\]]+\]\([^\s)]+\)/.test(selectedText)) {
    return "Markdown link";
  }

  return "Text";
}

function createContextExcerpt(markdown: string, range: TextRange): string {
  const before = markdown.slice(Math.max(0, range.start - 90), range.start);
  const selected = markdown.slice(range.start, range.end);
  const after = markdown.slice(range.end, Math.min(markdown.length, range.end + 90));
  return `${before}${selected}${after}`.replace(/\s+/g, " ").trim();
}

function getHeadingContainingOffset(
  markdown: string,
  headings: MarkdownHeading[],
  offset: number
): MarkdownHeading | undefined {
  let result: MarkdownHeading | undefined;

  for (const heading of headings) {
    if (getLineStartOffset(markdown, heading.line) > offset) {
      break;
    }
    result = heading;
  }

  return result;
}

function getSectionRange(
  markdown: string,
  headings: MarkdownHeading[],
  heading: MarkdownHeading
): TextRange {
  const start = getLineStartOffset(markdown, heading.line);
  const headingIndex = headings.findIndex(
    (candidate) => candidate.line === heading.line
  );
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level);

  return {
    start,
    end: nextHeading ? getLineStartOffset(markdown, nextHeading.line) : markdown.length
  };
}

function getHeadingPath(
  headings: MarkdownHeading[],
  targetHeading: MarkdownHeading
): string[] {
  const path: MarkdownHeading[] = [];

  for (const heading of headings) {
    while (path.length > 0 && path[path.length - 1].level >= heading.level) {
      path.pop();
    }
    path.push(heading);

    if (heading.line === targetHeading.line) {
      return path.map((pathHeading) => pathHeading.text);
    }
  }

  return [targetHeading.text];
}

function getLineStartOffset(markdown: string, line: number): number {
  let offset = 0;
  let currentLine = 1;

  while (currentLine < line) {
    const nextBreak = markdown.indexOf("\n", offset);
    if (nextBreak === -1) {
      return markdown.length;
    }
    offset = nextBreak + 1;
    currentLine += 1;
  }

  return offset;
}

function trimRange(markdown: string, range: TextRange): TextRange {
  let { start, end } = range;

  while (start < end && /\s/.test(markdown[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(markdown[end - 1] ?? "")) {
    end -= 1;
  }

  return { start, end };
}

function isCurrentRange(markdown: string, range: TextRange): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= markdown.length
  );
}

function getHistoryState(
  resolution: CanonicalTargetResolution
): "active" | "ambiguous" | "not_found" {
  if (resolution.state === "resolved") {
    return "active";
  }

  return resolution.state;
}

function getConfidenceRank(confidence: CanonicalTargetCandidate["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function expandCompleteMarkdownLinkRange({
  contextMarkdown,
  range,
  selectedVisibleText
}: {
  contextMarkdown: string;
  range: TextRange;
  selectedVisibleText: string;
}): TextRange {
  for (let start = contextMarkdown.lastIndexOf("[", range.start); start >= 0; start = contextMarkdown.lastIndexOf("[", start - 1)) {
    if (start > 0 && contextMarkdown[start - 1] === "!") {
      continue;
    }

    const labelEnd = findUnescapedCharacter(contextMarkdown, "]", start + 1);

    if (
      labelEnd === -1 ||
      contextMarkdown[labelEnd + 1] !== "(" ||
      range.start < start + 1 ||
      range.end > labelEnd
    ) {
      continue;
    }

    const destinationEnd = findClosingParenthesis(
      contextMarkdown,
      labelEnd + 2
    );
    const label = contextMarkdown.slice(start + 1, labelEnd);

    if (
      destinationEnd !== -1 &&
      normalizeVisibleText(getMarkdownPlainText(label)) === selectedVisibleText
    ) {
      return { start, end: destinationEnd + 1 };
    }
  }

  return range;
}

function findUnescapedCharacter(
  text: string,
  character: string,
  start: number
): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }

    if (text[index] === character) {
      return index;
    }
  }

  return -1;
}

function findClosingParenthesis(text: string, start: number): number {
  let depth = 1;

  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }

    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }

  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

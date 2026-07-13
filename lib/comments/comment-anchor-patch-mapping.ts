import {
  dedupeTextMatches,
  findExactTextMatches,
  findMarkdownPlainTextMatches,
  findNormalizedTextMatches,
  getMarkdownPlainText,
  normalizeMarkdownText,
  type TextRange
} from "../markdown/markdown-text.ts";
import type { PatchmarkCommentAnchor } from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

export type RetainedSelectedTextMatch = TextRange & {
  selectedText: string;
};

export function findRetainedPatchOriginalTextInPatchReplacement({
  originalText,
  replacementStart,
  replacementText
}: {
  originalText: string;
  replacementStart: number;
  replacementText: string;
}): RetainedSelectedTextMatch | null {
  if (!isSingleMarkdownTableRow(originalText) || !replacementText.trim()) {
    return null;
  }

  const matches = dedupeTextMatches([
    ...findExactTextMatches(replacementText, originalText),
    ...findNormalizedTextMatches(replacementText, originalText),
    ...findMarkdownPlainTextMatches(replacementText, getMarkdownPlainText(originalText))
  ]);

  if (matches.length === 0) {
    return null;
  }

  const expandedMatches = dedupeTextMatches(
    matches.map((match) => expandMatchToContainingLine(replacementText, match))
  ).filter((match) =>
    normalizeMarkdownText(replacementText.slice(match.start, match.end)) ===
      normalizeMarkdownText(originalText) ||
    getMarkdownPlainText(replacementText.slice(match.start, match.end)) ===
      getMarkdownPlainText(originalText)
  );

  if (expandedMatches.length !== 1) {
    return null;
  }

  return toAbsoluteMatch(expandedMatches[0], replacementStart, replacementText);
}

export function findRetainedSelectedTextInPatchReplacement({
  anchor,
  originalStart,
  originalText,
  replacementStart,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  originalStart?: number;
  originalText: string;
  replacementStart: number;
  replacementText: string;
}): RetainedSelectedTextMatch | null {
  if (!anchor.selected_text.trim() || replacementText.length === 0) {
    return null;
  }

  const relativeOffsetMatch = getRetainedRelativeOffsetMatch({
    anchor,
    originalStart,
    replacementStart,
    replacementText
  });

  if (relativeOffsetMatch) {
    return relativeOffsetMatch;
  }

  const replacementMatches = findReplacementSelectionMatches({
    anchor,
    replacementText
  });
  const originalMatches = findOriginalSelectionMatches({
    anchor,
    originalText
  });

  if (replacementMatches.length === 1) {
    return toAbsoluteMatch(replacementMatches[0], replacementStart, replacementText);
  }

  if (originalMatches.length === 1 && replacementMatches.length > 1) {
    const originalRelativeStart = originalMatches[0].start;
    const matchingReplacement = replacementMatches.find(
      (match) => match.start === originalRelativeStart
    );

    if (matchingReplacement) {
      return toAbsoluteMatch(matchingReplacement, replacementStart, replacementText);
    }
  }

  return null;
}

export function isSelectedAnchorEquivalentToPatchOriginalText({
  anchor,
  originalText
}: {
  anchor: SelectedTextAnchor;
  originalText: string;
}): boolean {
  const normalizedSelectedText = normalizeMarkdownText(anchor.selected_text);

  return (
    normalizedSelectedText.length > 0 &&
    (normalizeMarkdownText(originalText) === normalizedSelectedText ||
      getMarkdownPlainText(originalText) === normalizedSelectedText)
  );
}

function getRetainedRelativeOffsetMatch({
  anchor,
  originalStart,
  replacementStart,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  originalStart?: number;
  replacementStart: number;
  replacementText: string;
}): RetainedSelectedTextMatch | null {
  if (
    typeof originalStart !== "number" ||
    typeof anchor.markdown_start_offset !== "number" ||
    typeof anchor.markdown_end_offset !== "number" ||
    anchor.markdown_end_offset < anchor.markdown_start_offset
  ) {
    return null;
  }

  const relativeStart = anchor.markdown_start_offset - originalStart;
  const relativeEnd = anchor.markdown_end_offset - originalStart;

  if (
    relativeStart < 0 ||
    relativeEnd < relativeStart ||
    relativeEnd > replacementText.length
  ) {
    return null;
  }

  const candidateText = replacementText.slice(relativeStart, relativeEnd);

  if (candidateText !== anchor.selected_text) {
    return null;
  }

  return {
    end: replacementStart + relativeEnd,
    selectedText: candidateText,
    start: replacementStart + relativeStart
  };
}

function findReplacementSelectionMatches({
  anchor,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  replacementText: string;
}): TextRange[] {
  return dedupeTextMatches([
    ...findExactTextMatches(replacementText, anchor.selected_text),
    ...findNormalizedTextMatches(replacementText, anchor.selected_text),
    ...findMarkdownPlainTextMatches(replacementText, anchor.selected_text)
  ]);
}

function findOriginalSelectionMatches({
  anchor,
  originalText
}: {
  anchor: SelectedTextAnchor;
  originalText: string;
}): TextRange[] {
  return dedupeTextMatches([
    ...findExactTextMatches(originalText, anchor.selected_text),
    ...findNormalizedTextMatches(originalText, anchor.selected_text),
    ...findMarkdownPlainTextMatches(originalText, anchor.selected_text)
  ]);
}

function toAbsoluteMatch(
  match: TextRange,
  replacementStart: number,
  suggestedText: string
): RetainedSelectedTextMatch {
  const start = replacementStart + match.start;
  const end = replacementStart + match.end;

  return {
    end,
    selectedText: suggestedText.slice(match.start, match.end),
    start
  };
}

function expandMatchToContainingLine(text: string, match: TextRange): TextRange {
  const lineStart = text.lastIndexOf("\n", match.start - 1) + 1;
  const nextBreak = text.indexOf("\n", match.end);

  return {
    start: lineStart,
    end: nextBreak === -1 ? text.length : nextBreak
  };
}

function isSingleMarkdownTableRow(text: string): boolean {
  const trimmedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return trimmedLines.length === 1 && /^\|.*\|$/.test(trimmedLines[0] ?? "");
}

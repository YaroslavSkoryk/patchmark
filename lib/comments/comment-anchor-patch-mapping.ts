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

export function findRetainedSelectedTextInPatchReplacement({
  anchor,
  originalStart,
  originalText,
  replacementStart,
  suggestedText
}: {
  anchor: SelectedTextAnchor;
  originalStart?: number;
  originalText: string;
  replacementStart: number;
  suggestedText: string;
}): RetainedSelectedTextMatch | null {
  if (!anchor.selected_text.trim() || suggestedText.length === 0) {
    return null;
  }

  const relativeOffsetMatch = getRetainedRelativeOffsetMatch({
    anchor,
    originalStart,
    replacementStart,
    suggestedText
  });

  if (relativeOffsetMatch) {
    return relativeOffsetMatch;
  }

  const replacementMatches = findReplacementSelectionMatches({
    anchor,
    suggestedText
  });
  const originalMatches = findOriginalSelectionMatches({
    anchor,
    originalText
  });

  if (replacementMatches.length === 1) {
    return toAbsoluteMatch(replacementMatches[0], replacementStart, suggestedText);
  }

  if (originalMatches.length === 1 && replacementMatches.length > 1) {
    const originalRelativeStart = originalMatches[0].start;
    const matchingReplacement = replacementMatches.find(
      (match) => match.start === originalRelativeStart
    );

    if (matchingReplacement) {
      return toAbsoluteMatch(matchingReplacement, replacementStart, suggestedText);
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
  suggestedText
}: {
  anchor: SelectedTextAnchor;
  originalStart?: number;
  replacementStart: number;
  suggestedText: string;
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
    relativeEnd > suggestedText.length
  ) {
    return null;
  }

  const candidateText = suggestedText.slice(relativeStart, relativeEnd);

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
  suggestedText
}: {
  anchor: SelectedTextAnchor;
  suggestedText: string;
}): TextRange[] {
  return dedupeTextMatches([
    ...findExactTextMatches(suggestedText, anchor.selected_text),
    ...findNormalizedTextMatches(suggestedText, anchor.selected_text),
    ...findMarkdownPlainTextMatches(suggestedText, anchor.selected_text)
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

import {
  findMarkdownTableContainingRange,
  type TextRange
} from "../markdown/markdown-tables.ts";
import { parseMarkdownHeadings } from "../markdown/parse-headings.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";

export type PendingPatchApplicability =
  | "exact_match"
  | "multiple_matches"
  | "not_found"
  | "table_row_rebase_available";

export type PendingPatchTargetMatchMethod =
  | "document_exact"
  | "linked_comment_anchor"
  | "linked_comment_context"
  | "linked_comment_structure"
  | "target_heading";

export type PendingPatchTargetResolution = {
  applicability: Extract<
    PendingPatchApplicability,
    "exact_match" | "multiple_matches" | "not_found"
  >;
  matches: TextRange[];
  method: PendingPatchTargetMatchMethod | "none";
};

type ResolvedLinkedCommentAnchor =
  | {
      comment: PatchmarkComment;
      range: TextRange;
      status: "active";
    }
  | {
      status: "ambiguous" | "not_found";
    };

type ScopedMatchResult = {
  matches: TextRange[];
  method: PendingPatchTargetMatchMethod;
};

export function resolvePendingPatchTarget({
  comments = [],
  markdown,
  patch
}: {
  comments?: PatchmarkComment[];
  markdown: string;
  patch: PatchmarkPatch;
}): PendingPatchTargetResolution {
  if (!patch.original_text) {
    return {
      applicability: "not_found",
      matches: [],
      method: "none"
    };
  }

  const linkedResolution = resolveLinkedCommentAnchor({
    comments,
    markdown,
    patch
  });

  if (linkedResolution.status === "ambiguous") {
    const ambiguousLinkedCommentMatches = findExactTextMatches(
      markdown,
      patch.original_text
    );

    return {
      applicability:
        ambiguousLinkedCommentMatches.length > 0 ? "multiple_matches" : "not_found",
      matches: ambiguousLinkedCommentMatches,
      method: "linked_comment_anchor"
    };
  }

  const linkedMatch = resolveFromLinkedCommentAnchor({
    linkedResolution,
    markdown,
    patch
  });

  if (linkedMatch?.matches.length === 1) {
    return {
      applicability: "exact_match",
      matches: linkedMatch.matches,
      method: linkedMatch.method
    };
  }

  const targetSectionMatches = getPatchTargetHeadingSectionRange(
    markdown,
    patch.target_heading
  )
    ? findExactTextMatchesInRange(
        markdown,
        patch.original_text,
        getPatchTargetHeadingSectionRange(markdown, patch.target_heading)
      )
    : [];

  if (targetSectionMatches.length === 1) {
    return {
      applicability: "exact_match",
      matches: targetSectionMatches,
      method: "target_heading"
    };
  }

  const documentMatches = findExactTextMatches(markdown, patch.original_text);

  if (documentMatches.length === 1) {
    return {
      applicability: "exact_match",
      matches: documentMatches,
      method: "document_exact"
    };
  }

  const ambiguousMatches = dedupeTextMatches([
    ...(linkedMatch?.matches ?? []),
    ...targetSectionMatches,
    ...documentMatches
  ]);

  if (ambiguousMatches.length > 1) {
    return {
      applicability: "multiple_matches",
      matches: ambiguousMatches,
      method: linkedMatch?.method ?? "document_exact"
    };
  }

  return {
    applicability: "not_found",
    matches: [],
    method: "none"
  };
}

function resolveFromLinkedCommentAnchor({
  linkedResolution,
  markdown,
  patch
}: {
  linkedResolution: ResolvedLinkedCommentAnchor;
  markdown: string;
  patch: PatchmarkPatch;
}): ScopedMatchResult | null {
  if (linkedResolution.status !== "active") {
    return null;
  }

  const linkedRange = linkedResolution.range;

  if (markdown.slice(linkedRange.start, linkedRange.end) === patch.original_text) {
    return {
      matches: [linkedRange],
      method: "linked_comment_anchor"
    };
  }

  const anchor = linkedResolution.comment.anchor;

  if (anchor.kind !== "selected_text") {
    return null;
  }

  const scopes = dedupeTextMatches([
    linkedRange,
    ...getLinkedCommentStructuralScopes(markdown, linkedRange),
    ...getLinkedCommentContextScopes(markdown, anchor),
    ...getLinkedCommentSectionScopes(markdown, anchor)
  ]);
  let ambiguousResult: ScopedMatchResult | null = null;

  for (const scope of scopes) {
    const matches = findExactTextMatchesInRange(
      markdown,
      patch.original_text,
      scope
    );

    if (matches.length === 1) {
      return {
        matches,
        method:
          scope.start === linkedRange.start && scope.end === linkedRange.end
            ? "linked_comment_anchor"
            : isContextScope(anchor, scope)
              ? "linked_comment_context"
              : "linked_comment_structure"
      };
    }

    if (matches.length > 1 && !ambiguousResult) {
      ambiguousResult = {
        matches,
        method:
          isContextScope(anchor, scope)
            ? "linked_comment_context"
            : "linked_comment_structure"
      };
    }
  }

  return ambiguousResult;
}

function resolveLinkedCommentAnchor({
  comments,
  markdown,
  patch
}: {
  comments: PatchmarkComment[];
  markdown: string;
  patch: PatchmarkPatch;
}): ResolvedLinkedCommentAnchor {
  const comment = patch.comment_id
    ? comments.find((candidate) => candidate.id === patch.comment_id)
    : null;

  if (!comment || comment.anchor.kind !== "selected_text") {
    return {
      status: "not_found"
    };
  }

  const anchor = comment.anchor;
  const offsetMatch = getCurrentSelectedTextOffsetMatch(anchor, markdown);

  if (offsetMatch) {
    return {
      comment,
      range: offsetMatch,
      status: "active"
    };
  }

  const contextMatch = getCurrentSelectedTextContextMatch(anchor, markdown);

  if (contextMatch) {
    return {
      comment,
      range: contextMatch,
      status: "active"
    };
  }

  const sectionMatches = getLinkedCommentSectionScopes(markdown, anchor).flatMap(
    (scope) => findExactTextMatchesInRange(markdown, anchor.selected_text, scope)
  );
  const uniqueSectionMatches = dedupeTextMatches(sectionMatches);

  if (uniqueSectionMatches.length === 1) {
    return {
      comment,
      range: uniqueSectionMatches[0],
      status: "active"
    };
  }

  if (uniqueSectionMatches.length > 1) {
    return {
      status: "ambiguous"
    };
  }

  const documentMatches = findExactTextMatches(markdown, anchor.selected_text);

  if (documentMatches.length === 1) {
    return {
      comment,
      range: documentMatches[0],
      status: "active"
    };
  }

  return {
    status: documentMatches.length > 1 ? "ambiguous" : "not_found"
  };
}

function getCurrentSelectedTextOffsetMatch(
  anchor: Extract<PatchmarkComment["anchor"], { kind: "selected_text" }>,
  markdown: string
): TextRange | null {
  const start = anchor.markdown_start_offset;
  const end = anchor.markdown_end_offset;

  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end < start ||
    end > markdown.length ||
    markdown.slice(start, end) !== anchor.selected_text
  ) {
    return null;
  }

  return { end, start };
}

function getCurrentSelectedTextContextMatch(
  anchor: Extract<PatchmarkComment["anchor"], { kind: "selected_text" }>,
  markdown: string
): TextRange | null {
  const context = anchor.anchor_context;

  if (
    !context ||
    typeof context.markdown_start_offset !== "number" ||
    typeof context.markdown_end_offset !== "number" ||
    typeof context.selected_start_in_context !== "number" ||
    typeof context.selected_end_in_context !== "number" ||
    !context.markdown_text ||
    context.markdown_start_offset < 0 ||
    context.markdown_end_offset > markdown.length ||
    context.markdown_start_offset >= context.markdown_end_offset ||
    markdown.slice(context.markdown_start_offset, context.markdown_end_offset) !==
      context.markdown_text
  ) {
    return null;
  }

  const start = context.markdown_start_offset + context.selected_start_in_context;
  const end = context.markdown_start_offset + context.selected_end_in_context;

  return markdown.slice(start, end) === anchor.selected_text
    ? { end, start }
    : null;
}

function getLinkedCommentStructuralScopes(
  markdown: string,
  range: TextRange
): TextRange[] {
  return dedupeTextMatches([
    ...getMarkdownTableCellAndRowRangesContainingRange(markdown, range),
    getMarkdownParagraphRangeContainingRange(markdown, range)
  ].filter((scope): scope is TextRange => scope !== null));
}

function getLinkedCommentContextScopes(
  markdown: string,
  anchor: Extract<PatchmarkComment["anchor"], { kind: "selected_text" }>
): TextRange[] {
  const context = anchor.anchor_context;

  if (
    !context ||
    typeof context.markdown_start_offset !== "number" ||
    typeof context.markdown_end_offset !== "number" ||
    !context.markdown_text ||
    context.markdown_start_offset < 0 ||
    context.markdown_end_offset > markdown.length ||
    markdown.slice(context.markdown_start_offset, context.markdown_end_offset) !==
      context.markdown_text
  ) {
    return [];
  }

  return [
    {
      start: context.markdown_start_offset,
      end: context.markdown_end_offset
    }
  ];
}

function getLinkedCommentSectionScopes(
  markdown: string,
  anchor: Extract<PatchmarkComment["anchor"], { kind: "selected_text" }>
): TextRange[] {
  const sectionRange = getPatchTargetHeadingSectionRange(
    markdown,
    anchor.containing_heading
  );
  const fallbackRange =
    typeof anchor.fallback_section_start_offset === "number" &&
    typeof anchor.fallback_section_end_offset === "number" &&
    anchor.fallback_section_start_offset >= 0 &&
    anchor.fallback_section_end_offset > anchor.fallback_section_start_offset &&
    anchor.fallback_section_end_offset <= markdown.length
      ? {
          start: anchor.fallback_section_start_offset,
          end: anchor.fallback_section_end_offset
        }
      : null;

  return dedupeTextMatches(
    [sectionRange, fallbackRange].filter(
      (range): range is TextRange => range !== null
    )
  );
}

function getMarkdownTableCellAndRowRangesContainingRange(
  markdown: string,
  range: TextRange
): TextRange[] {
  const table = findMarkdownTableContainingRange(markdown, range);

  if (!table) {
    return [];
  }

  const row = table.rows.find(
    (candidate) =>
      !candidate.isDelimiter &&
      range.start >= candidate.start &&
      range.end <= candidate.end
  );

  if (!row) {
    return [];
  }

  const cellRange = getMarkdownTableCellRanges(row.text, row.start).find(
    (candidate) =>
      range.start >= candidate.start &&
      range.end <= candidate.end
  );

  return dedupeTextMatches(
    [cellRange ?? null, { start: row.start, end: row.end }].filter(
      (candidate): candidate is TextRange => candidate !== null
    )
  );
}

function getMarkdownTableCellRanges(rowText: string, rowStart: number): TextRange[] {
  const rawSegments = splitMarkdownTableRowIntoSourceSegments(rowText);
  const segments =
    rawSegments[0]?.text.trim() === ""
      ? rawSegments.slice(1)
      : rawSegments.slice();

  if (segments[segments.length - 1]?.text.trim() === "") {
    segments.pop();
  }

  return segments.map((segment) => {
    const trimmed = trimSourceSegment(segment.text, segment.start, segment.end);

    return {
      end: rowStart + trimmed.end,
      start: rowStart + trimmed.start
    };
  });
}

function splitMarkdownTableRowIntoSourceSegments(
  rowText: string
): Array<{ end: number; start: number; text: string }> {
  const segments: Array<{ end: number; start: number; text: string }> = [];
  const content = rowText.replace(/\r$/, "");
  let segmentStart = 0;
  let inCode = false;
  let linkDestinationDepth = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const nextCharacter = content[index + 1] ?? "";
    const previousCharacter = content[index - 1] ?? "";

    if (character === "\\" && nextCharacter === "|") {
      index += 1;
      continue;
    }

    if (character === "`") {
      inCode = !inCode;
      continue;
    }

    if (
      !inCode &&
      linkDestinationDepth === 0 &&
      character === "(" &&
      previousCharacter === "]"
    ) {
      linkDestinationDepth = 1;
      continue;
    }

    if (!inCode && linkDestinationDepth > 0) {
      if (character === "(") {
        linkDestinationDepth += 1;
      } else if (character === ")") {
        linkDestinationDepth -= 1;
      }
      continue;
    }

    if (!inCode && linkDestinationDepth === 0 && character === "|") {
      segments.push({
        end: index,
        start: segmentStart,
        text: content.slice(segmentStart, index)
      });
      segmentStart = index + 1;
    }
  }

  segments.push({
    end: content.length,
    start: segmentStart,
    text: content.slice(segmentStart)
  });

  return segments;
}

function trimSourceSegment(
  text: string,
  start: number,
  end: number
): { end: number; start: number } {
  let trimmedStart = start;
  let trimmedEnd = end;

  while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart - start] ?? "")) {
    trimmedStart += 1;
  }

  while (
    trimmedEnd > trimmedStart &&
    /\s/.test(text[trimmedEnd - start - 1] ?? "")
  ) {
    trimmedEnd -= 1;
  }

  return {
    end: trimmedEnd,
    start: trimmedStart
  };
}

function getMarkdownParagraphRangeContainingRange(
  markdown: string,
  range: TextRange
): TextRange | null {
  const lines = markdown.split("\n");
  const lineStarts = getLineStartOffsets(markdown);
  let lineIndex = getLineIndexForOffset(lineStarts, range.start);

  while (lineIndex > 0 && lines[lineIndex - 1]?.trim()) {
    lineIndex -= 1;
  }

  let endLineIndex = getLineIndexForOffset(lineStarts, range.end);

  while (endLineIndex < lines.length - 1 && lines[endLineIndex + 1]?.trim()) {
    endLineIndex += 1;
  }

  return {
    start: lineStarts[lineIndex] ?? 0,
    end:
      (lineStarts[endLineIndex] ?? 0) +
      (lines[endLineIndex]?.replace(/\r$/, "").length ?? 0)
  };
}

function getPatchTargetHeadingSectionRange(
  markdown: string,
  targetHeading?: string
): TextRange | null {
  if (!targetHeading) {
    return null;
  }

  const normalizedTargetHeading = normalizePatchTargetHeading(targetHeading);
  if (!normalizedTargetHeading) {
    return null;
  }

  const headings = parseMarkdownHeadings(markdown);
  const target = headings.find(
    (heading) => normalizePatchTargetHeading(heading.text) === normalizedTargetHeading
  );

  if (!target) {
    return null;
  }

  const lineOffsets = getLineStartOffsets(markdown);
  const headingIndex = headings.findIndex(
    (heading) => heading.line === target.line
  );
  const nextPeerHeading = headings
    .slice(headingIndex + 1)
    .find((heading) => heading.level <= target.level);

  return {
    end: nextPeerHeading
      ? lineOffsets[nextPeerHeading.line - 1] ?? markdown.length
      : markdown.length,
    start: lineOffsets[target.line - 1] ?? 0
  };
}

function normalizePatchTargetHeading(heading: string): string {
  return heading
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ");
}

function findExactTextMatchesInRange(
  markdown: string,
  searchText: string,
  range: TextRange | null
): TextRange[] {
  if (!range) {
    return [];
  }

  return findExactTextMatches(markdown.slice(range.start, range.end), searchText).map(
    (match) => ({
      start: range.start + match.start,
      end: range.start + match.end
    })
  );
}

function findExactTextMatches(markdown: string, searchText: string): TextRange[] {
  if (!searchText) {
    return [];
  }

  const matches: TextRange[] = [];
  let nextIndex = markdown.indexOf(searchText);

  while (nextIndex !== -1) {
    matches.push({
      end: nextIndex + searchText.length,
      start: nextIndex
    });
    nextIndex = markdown.indexOf(searchText, nextIndex + searchText.length);
  }

  return matches;
}

function isContextScope(
  anchor: Extract<PatchmarkComment["anchor"], { kind: "selected_text" }>,
  scope: TextRange
): boolean {
  const context = anchor.anchor_context;

  return (
    typeof context?.markdown_start_offset === "number" &&
    typeof context.markdown_end_offset === "number" &&
    scope.start === context.markdown_start_offset &&
    scope.end === context.markdown_end_offset
  );
}

function dedupeTextMatches(matches: TextRange[]): TextRange[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets: number[] = [];
  let offset = 0;

  for (const line of markdown.split("\n")) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  return offsets;
}

function getLineIndexForOffset(lineStarts: number[], offset: number): number {
  let lineIndex = 0;

  for (let index = 0; index < lineStarts.length; index += 1) {
    if ((lineStarts[index] ?? 0) > offset) {
      break;
    }
    lineIndex = index;
  }

  return lineIndex;
}

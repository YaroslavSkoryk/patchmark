import {
  findMarkdownTableContainingRange,
  type TextRange
} from "../markdown/markdown-tables.ts";
import {
  findExactTextMatches,
  findNormalizedTextMatches
} from "../markdown/markdown-text.ts";
import { parseMarkdownHeadings } from "../markdown/parse-headings.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch,
  PatchmarkSelectedTextAnchorContext
} from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkComment["anchor"],
  { kind: "selected_text" }
>;

type SectionAnchor = Extract<PatchmarkComment["anchor"], { kind: "section" }>;

export type CanonicalTargetMethod =
  | "context"
  | "current_offset"
  | "descendant"
  | "exact"
  | "linked_comment_anchor"
  | "linked_comment_context"
  | "linked_comment_structure"
  | "normalized"
  | "section"
  | "table_structural"
  | "target_heading"
  | "transformed_anchor";

export type CanonicalTargetCardinality = "multiple" | "none" | "unique";

export type CanonicalTargetConfidence = "high" | "low" | "medium";

export type CanonicalStructuralContext = {
  containingHeading?: string;
  scope?: "cell" | "document" | "paragraph" | "row" | "section";
};

export type CanonicalTargetCandidate = {
  confidence: CanonicalTargetConfidence;
  range: TextRange;
  structuralContext?: CanonicalStructuralContext;
  supportingMethods: CanonicalTargetMethod[];
};

export type CanonicalTargetResolution = {
  candidates: CanonicalTargetCandidate[];
  cardinality: CanonicalTargetCardinality;
  confidence: CanonicalTargetConfidence;
  containingHeading?: string;
  explanationCode?: string;
  method: CanonicalTargetMethod | "none";
  range?: TextRange;
  state: "ambiguous" | "not_found" | "resolved";
  structuralContext?: CanonicalStructuralContext;
};

type CandidateInput = {
  confidence: CanonicalTargetConfidence;
  method: CanonicalTargetMethod;
  range: TextRange;
  structuralContext?: CanonicalStructuralContext;
};

type CommentTargetResolutionOptions = {
  headings?: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
};

type PatchTargetResolutionOptions = {
  comments?: PatchmarkComment[];
  headings?: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patch: PatchmarkPatch;
};

export function resolveCanonicalCommentTarget(
  comment: PatchmarkComment,
  options: CommentTargetResolutionOptions
): CanonicalTargetResolution {
  const headings = options.headings ?? parseMarkdownHeadings(options.markdown);
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return createResolvedResolution({
      candidates: [
        {
          confidence: "high",
          method: "section",
          range: { end: 0, start: 0 },
          structuralContext: { scope: "document" }
        }
      ],
      explanationCode: "document_anchor",
      preferredMethod: "section"
    });
  }

  if (anchor.kind === "section") {
    return resolveCanonicalSectionTarget(anchor, options.markdown, headings);
  }

  return resolveCanonicalSelectedTextTarget(anchor, {
    headings,
    markdown: options.markdown
  });
}

export function resolveCanonicalPatchTarget({
  comments = [],
  headings,
  markdown,
  patch
}: PatchTargetResolutionOptions): CanonicalTargetResolution {
  if (!patch.original_text) {
    return createNotFoundResolution("empty_patch_original_text");
  }

  const resolvedHeadings = headings ?? parseMarkdownHeadings(markdown);
  const linkedComment = patch.comment_id
    ? comments.find((comment) => comment.id === patch.comment_id)
    : undefined;

  if (linkedComment) {
    const linkedResolution = resolveCanonicalCommentTarget(linkedComment, {
      headings: resolvedHeadings,
      markdown
    });
    const linkedPatchResolution = resolvePatchFromLinkedComment({
      linkedComment,
      linkedResolution,
      markdown,
      patch
    });

    if (linkedPatchResolution.state === "resolved") {
      return linkedPatchResolution;
    }

    if (linkedPatchResolution.state === "ambiguous") {
      return linkedPatchResolution;
    }
  }

  const sectionRange = getPatchTargetHeadingSectionRange(
    markdown,
    resolvedHeadings,
    patch.target_heading
  );
  const sectionCandidates = sectionRange
    ? [
        ...findExactTextMatchesInRange(markdown, patch.original_text, sectionRange).map(
          (range) => ({
            confidence: "high" as const,
            method: "target_heading" as const,
            range,
            structuralContext: {
              containingHeading: patch.target_heading,
              scope: "section" as const
            }
          })
        ),
        ...findNormalizedTextMatchesInRange(
          markdown,
          patch.original_text,
          sectionRange
        ).map((range) => ({
          confidence: "medium" as const,
          method: "normalized" as const,
          range,
          structuralContext: {
            containingHeading: patch.target_heading,
            scope: "section" as const
          }
        }))
      ]
    : [];
  const sectionResolution = createResolutionFromCandidates({
    candidates: sectionCandidates,
    emptyCode: "patch_not_found_in_target_heading",
    multipleCode: "patch_ambiguous_in_target_heading"
  });

  if (sectionResolution.state !== "not_found") {
    return sectionResolution;
  }

  return createResolutionFromCandidates({
    candidates: [
      ...findExactTextMatches(markdown, patch.original_text).map((range) => ({
        confidence: "high" as const,
        method: "exact" as const,
        range,
        structuralContext: { scope: "document" as const }
      })),
      ...findNormalizedTextMatches(markdown, patch.original_text).map((range) => ({
        confidence: "medium" as const,
        method: "normalized" as const,
        range,
        structuralContext: { scope: "document" as const }
      }))
    ],
    emptyCode: "patch_not_found",
    multipleCode: "patch_ambiguous"
  });
}

export function dedupeCanonicalCandidates(
  candidates: CandidateInput[]
): CanonicalTargetCandidate[] {
  const byRange = new Map<string, CanonicalTargetCandidate>();

  for (const candidate of candidates) {
    const key = getRangeKey(candidate.range);
    const existing = byRange.get(key);

    if (!existing) {
      byRange.set(key, {
        confidence: candidate.confidence,
        range: candidate.range,
        structuralContext: candidate.structuralContext,
        supportingMethods: [candidate.method]
      });
      continue;
    }

    if (!existing.supportingMethods.includes(candidate.method)) {
      existing.supportingMethods.push(candidate.method);
    }

    existing.confidence = getHigherConfidence(
      existing.confidence,
      candidate.confidence
    );
    existing.structuralContext =
      existing.structuralContext ?? candidate.structuralContext;
  }

  return [...byRange.values()].sort(
    (first, second) =>
      first.range.start - second.range.start || first.range.end - second.range.end
  );
}

function resolveCanonicalSectionTarget(
  anchor: SectionAnchor,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CanonicalTargetResolution {
  const currentHeading = findMatchingHeading(headings, {
    level: anchor.heading_level,
    text: anchor.heading
  });

  if (!currentHeading) {
    return createNotFoundResolution("section_not_found");
  }

  return createResolvedResolution({
    candidates: [
      {
        confidence: "high",
        method: "section",
        range: getHeadingLineRange(markdown, currentHeading),
        structuralContext: {
          containingHeading: currentHeading.text,
          scope: "section"
        }
      }
    ],
    explanationCode: "section_heading_match",
    preferredMethod: "section"
  });
}

function resolveCanonicalSelectedTextTarget(
  anchor: SelectedTextAnchor,
  {
    headings,
    markdown
  }: {
    headings: ReturnType<typeof parseMarkdownHeadings>;
    markdown: string;
  }
): CanonicalTargetResolution {
  if (!anchor.selected_text) {
    return createNotFoundResolution("empty_selected_text");
  }

  const currentOffset = getCurrentSelectedTextOffsetMatch(anchor, markdown);

  if (currentOffset) {
    return createResolvedResolution({
      candidates: [
        {
          confidence: "high",
          method:
            anchor.anchor_source === "patch"
              ? "transformed_anchor"
              : "current_offset",
          range: currentOffset,
          structuralContext: getStructuralContextForRange({
            headings,
            markdown,
            range: currentOffset
          })
        }
      ],
      explanationCode: "current_offset_valid",
      preferredMethod:
        anchor.anchor_source === "patch" ? "transformed_anchor" : "current_offset"
    });
  }

  const contextCandidates = getContextCandidates(markdown, anchor, headings);
  const contextResolution = createResolutionFromCandidates({
    candidates: contextCandidates,
    emptyCode: "context_not_found",
    multipleCode: "context_ambiguous"
  });

  if (contextResolution.state === "resolved") {
    return contextResolution;
  }

  if (contextResolution.state === "ambiguous") {
    return contextResolution;
  }

  const sectionRanges = getSelectedAnchorSectionScopes(markdown, headings, anchor);
  const sectionCandidates = sectionRanges.flatMap((scope) => [
    ...findExactTextMatchesInRange(markdown, anchor.selected_text, scope).map(
      (range) => ({
        confidence: "high" as const,
        method: "section" as const,
        range,
        structuralContext: getStructuralContextForRange({
          headings,
          markdown,
          range
        })
      })
    ),
    ...findNormalizedTextMatchesInRange(markdown, anchor.selected_text, scope).map(
      (range) => ({
        confidence: "medium" as const,
        method: "normalized" as const,
        range,
        structuralContext: getStructuralContextForRange({
          headings,
          markdown,
          range
        })
      })
    )
  ]);
  const sectionResolution = createResolutionFromCandidates({
    candidates: sectionCandidates,
    emptyCode: "section_target_not_found",
    multipleCode: "section_target_ambiguous"
  });

  if (sectionResolution.state !== "not_found") {
    return sectionResolution;
  }

  return createResolutionFromCandidates({
    candidates: [
      ...findExactTextMatches(markdown, anchor.selected_text).map((range) => ({
        confidence: "medium" as const,
        method: "exact" as const,
        range,
        structuralContext: getStructuralContextForRange({
          headings,
          markdown,
          range
        })
      })),
      ...findNormalizedTextMatches(markdown, anchor.selected_text).map((range) => ({
        confidence: "low" as const,
        method: "normalized" as const,
        range,
        structuralContext: getStructuralContextForRange({
          headings,
          markdown,
          range
        })
      }))
    ],
    emptyCode: "selected_text_not_found",
    multipleCode: "selected_text_ambiguous"
  });
}

function resolvePatchFromLinkedComment({
  linkedComment,
  linkedResolution,
  markdown,
  patch
}: {
  linkedComment: PatchmarkComment;
  linkedResolution: CanonicalTargetResolution;
  markdown: string;
  patch: PatchmarkPatch;
}): CanonicalTargetResolution {
  if (linkedResolution.state !== "resolved" || !linkedResolution.range) {
    return linkedResolution.state === "ambiguous"
      ? createAmbiguousResolution({
          candidates: linkedResolution.candidates,
          explanationCode: "linked_comment_ambiguous",
          method: "linked_comment_anchor"
        })
      : createNotFoundResolution("linked_comment_not_found");
  }

  const linkedRange = linkedResolution.range;

  if (markdown.slice(linkedRange.start, linkedRange.end) === patch.original_text) {
    return createResolvedResolution({
      candidates: [
        {
          confidence: "high",
          method: "linked_comment_anchor",
          range: linkedRange,
          structuralContext: linkedResolution.structuralContext
        }
      ],
      explanationCode: "linked_comment_original_text_match",
      preferredMethod: "linked_comment_anchor"
    });
  }

  if (linkedComment.anchor.kind !== "selected_text") {
    return createNotFoundResolution("linked_comment_not_selected_text");
  }

  const scopedCandidates = getLinkedPatchScopeCandidates({
    anchor: linkedComment.anchor,
    linkedRange,
    linkedResolution,
    markdown,
    patch
  });

  return createResolutionFromCandidates({
    candidates: scopedCandidates,
    emptyCode: "linked_scope_patch_not_found",
    multipleCode: "linked_scope_patch_ambiguous"
  });
}

function getLinkedPatchScopeCandidates({
  anchor,
  linkedRange,
  linkedResolution,
  markdown,
  patch
}: {
  anchor: SelectedTextAnchor;
  linkedRange: TextRange;
  linkedResolution: CanonicalTargetResolution;
  markdown: string;
  patch: PatchmarkPatch;
}): CandidateInput[] {
  const structuralScopes = getLinkedCommentStructuralScopes(markdown, linkedRange);
  const contextScopes = getLinkedCommentContextScopes(markdown, anchor);
  const sectionScopes = getSelectedAnchorSectionScopes(
    markdown,
    parseMarkdownHeadings(markdown),
    anchor
  );
  const scopes: Array<{
    method: CanonicalTargetMethod;
    range: TextRange;
    scope?: CanonicalStructuralContext["scope"];
  }> = [
    {
      method: "linked_comment_anchor",
      range: linkedRange,
      scope: linkedResolution.structuralContext?.scope
    },
    ...structuralScopes.map((range) => ({
      method: "linked_comment_structure" as const,
      range,
      scope: getScopeForRange(markdown, range)
    })),
    ...contextScopes.map((range) => ({
      method: "linked_comment_context" as const,
      range,
      scope: "paragraph" as const
    })),
    ...sectionScopes.map((range) => ({
      method: "section" as const,
      range,
      scope: "section" as const
    }))
  ];

  for (const scope of scopes) {
    const matches = findExactTextMatchesInRange(
      markdown,
      patch.original_text,
      scope.range
    );

    if (matches.length === 1) {
      return [
        {
          confidence: "high",
          method: scope.method,
          range: matches[0],
          structuralContext: {
            containingHeading: getHeadingTextForOffset(
              markdown,
              parseMarkdownHeadings(markdown),
              matches[0].start
            ),
            scope: scope.scope
          }
        }
      ];
    }

    if (matches.length > 1) {
      return matches.map((range) => ({
        confidence: "medium" as const,
        method: scope.method,
        range,
        structuralContext: {
          containingHeading: getHeadingTextForOffset(
            markdown,
            parseMarkdownHeadings(markdown),
            range.start
          ),
          scope: scope.scope
        }
      }));
    }
  }

  return [];
}

function getContextCandidates(
  markdown: string,
  anchor: SelectedTextAnchor,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CandidateInput[] {
  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);

  return contextMatches.flatMap((contextMatch) =>
    findSelectedTextMatchesInsideContext(markdown, contextMatch, anchor).map(
      (range) => ({
        confidence: "high" as const,
        method: "context" as const,
        range,
        structuralContext: getStructuralContextForRange({
          headings,
          markdown,
          range
        })
      })
    )
  );
}

function getCurrentSelectedTextOffsetMatch(
  anchor: SelectedTextAnchor,
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

function getSelectedAnchorSectionScopes(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  anchor: SelectedTextAnchor
): TextRange[] {
  const headingRange = getPatchTargetHeadingSectionRange(
    markdown,
    headings,
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

  return dedupeRanges(
    [headingRange, fallbackRange].filter(
      (range): range is TextRange => range !== null
    )
  );
}

function findAnchorContextMatches(
  markdown: string,
  anchorContext?: PatchmarkSelectedTextAnchorContext
): TextRange[] {
  if (!anchorContext) {
    return [];
  }

  const matches: TextRange[] = [];

  if (
    typeof anchorContext.markdown_start_offset === "number" &&
    typeof anchorContext.markdown_end_offset === "number" &&
    anchorContext.markdown_text &&
    anchorContext.markdown_start_offset >= 0 &&
    anchorContext.markdown_end_offset <= markdown.length &&
    markdown.slice(
      anchorContext.markdown_start_offset,
      anchorContext.markdown_end_offset
    ) === anchorContext.markdown_text
  ) {
    matches.push({
      start: anchorContext.markdown_start_offset,
      end: anchorContext.markdown_end_offset
    });
  }

  if (anchorContext.markdown_text) {
    matches.push(...findExactTextMatches(markdown, anchorContext.markdown_text));
  }

  if (
    anchorContext.plain_text &&
    anchorContext.plain_text !== anchorContext.markdown_text
  ) {
    matches.push(...findExactTextMatches(markdown, anchorContext.plain_text));
    matches.push(
      ...findNormalizedTextMatches(markdown, anchorContext.plain_text)
    );
  }

  return dedupeRanges(matches);
}

function findSelectedTextMatchesInsideContext(
  markdown: string,
  contextMatch: TextRange,
  anchor: SelectedTextAnchor
): TextRange[] {
  if (!anchor.selected_text) {
    return [];
  }

  const contextText = markdown.slice(contextMatch.start, contextMatch.end);
  const directStart = anchor.anchor_context?.selected_start_in_context;
  const directEnd = anchor.anchor_context?.selected_end_in_context;

  if (
    typeof directStart === "number" &&
    typeof directEnd === "number" &&
    contextText.slice(directStart, directEnd) === anchor.selected_text
  ) {
    return [
      {
        end: contextMatch.start + directEnd,
        start: contextMatch.start + directStart
      }
    ];
  }

  return [
    ...findExactTextMatches(contextText, anchor.selected_text),
    ...findNormalizedTextMatches(contextText, anchor.selected_text)
  ].map((match) => ({
    end: contextMatch.start + match.end,
    start: contextMatch.start + match.start
  }));
}

function getLinkedCommentStructuralScopes(
  markdown: string,
  range: TextRange
): TextRange[] {
  return dedupeRanges([
    ...getMarkdownTableCellAndRowRangesContainingRange(markdown, range),
    getMarkdownParagraphRangeContainingRange(markdown, range)
  ].filter((scope): scope is TextRange => scope !== null));
}

function getLinkedCommentContextScopes(
  markdown: string,
  anchor: SelectedTextAnchor
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
    (candidate) => range.start >= candidate.start && range.end <= candidate.end
  );

  return dedupeRanges(
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
  headings: ReturnType<typeof parseMarkdownHeadings>,
  targetHeading?: string
): TextRange | null {
  if (!targetHeading) {
    return null;
  }

  const normalizedTargetHeading = normalizeHeading(targetHeading);
  if (!normalizedTargetHeading) {
    return null;
  }

  const target = headings.find(
    (heading) => normalizeHeading(heading.text) === normalizedTargetHeading
  );

  return target ? getSectionRange(markdown, headings, target) : null;
}

function getSectionRange(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  target: ReturnType<typeof parseMarkdownHeadings>[number]
): TextRange {
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

function getHeadingLineRange(
  markdown: string,
  heading: ReturnType<typeof parseMarkdownHeadings>[number]
): TextRange {
  const lineStarts = getLineStartOffsets(markdown);
  const start = lineStarts[heading.line - 1] ?? 0;
  const nextStart = lineStarts[heading.line] ?? markdown.length;

  return {
    end: Math.max(start, nextStart - 1),
    start
  };
}

function findMatchingHeading(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  target: {
    level?: number;
    text: string;
  }
) {
  const normalizedTarget = normalizeHeading(target.text);

  return headings.find((heading) => {
    if (target.level && heading.level !== target.level) {
      return false;
    }

    return normalizeHeading(heading.text) === normalizedTarget;
  });
}

function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ");
}

function findExactTextMatchesInRange(
  markdown: string,
  searchText: string,
  range: TextRange
): TextRange[] {
  return findExactTextMatches(markdown.slice(range.start, range.end), searchText).map(
    (match) => ({
      start: range.start + match.start,
      end: range.start + match.end
    })
  );
}

function findNormalizedTextMatchesInRange(
  markdown: string,
  searchText: string,
  range: TextRange
): TextRange[] {
  return findNormalizedTextMatches(
    markdown.slice(range.start, range.end),
    searchText
  ).map((match) => ({
    start: range.start + match.start,
    end: range.start + match.end
  }));
}

function createResolutionFromCandidates({
  candidates,
  emptyCode,
  multipleCode
}: {
  candidates: CandidateInput[];
  emptyCode: string;
  multipleCode: string;
}): CanonicalTargetResolution {
  const deduped = dedupeCanonicalCandidates(candidates);

  if (deduped.length === 0) {
    return createNotFoundResolution(emptyCode);
  }

  if (deduped.length === 1) {
    return createResolvedResolution({
      candidates: deduped,
      explanationCode: "unique_current_target",
      preferredMethod: deduped[0].supportingMethods[0] ?? "exact"
    });
  }

  return createAmbiguousResolution({
    candidates: deduped,
    explanationCode: multipleCode,
    method: deduped[0].supportingMethods[0] ?? "exact"
  });
}

function createResolvedResolution({
  candidates,
  explanationCode,
  preferredMethod
}: {
  candidates: Array<CandidateInput | CanonicalTargetCandidate>;
  explanationCode: string;
  preferredMethod: CanonicalTargetMethod;
}): CanonicalTargetResolution {
  if (candidates.length === 0) {
    return createNotFoundResolution(explanationCode);
  }

  const deduped = "method" in candidates[0]
    ? dedupeCanonicalCandidates(candidates as CandidateInput[])
    : (candidates as CanonicalTargetCandidate[]);
  const candidate = deduped[0];

  if (!candidate) {
    return createNotFoundResolution(explanationCode);
  }

  return {
    candidates: deduped,
    cardinality: "unique",
    confidence: candidate.confidence,
    containingHeading: candidate.structuralContext?.containingHeading,
    explanationCode,
    method: preferredMethod,
    range: candidate.range,
    state: "resolved",
    structuralContext: candidate.structuralContext
  };
}

function createAmbiguousResolution({
  candidates,
  explanationCode,
  method
}: {
  candidates: CanonicalTargetCandidate[];
  explanationCode: string;
  method: CanonicalTargetMethod;
}): CanonicalTargetResolution {
  return {
    candidates,
    cardinality: "multiple",
    confidence: "low",
    explanationCode,
    method,
    state: "ambiguous"
  };
}

function createNotFoundResolution(explanationCode: string): CanonicalTargetResolution {
  return {
    candidates: [],
    cardinality: "none",
    confidence: "low",
    explanationCode,
    method: "none",
    state: "not_found"
  };
}

function getStructuralContextForRange({
  headings,
  markdown,
  range
}: {
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  range: TextRange;
}): CanonicalStructuralContext {
  return {
    containingHeading: getHeadingTextForOffset(markdown, headings, range.start),
    scope: getScopeForRange(markdown, range)
  };
}

function getScopeForRange(
  markdown: string,
  range: TextRange
): CanonicalStructuralContext["scope"] {
  const table = findMarkdownTableContainingRange(markdown, range);

  if (!table) {
    return "paragraph";
  }

  const row = table.rows.find(
    (candidate) =>
      !candidate.isDelimiter &&
      range.start >= candidate.start &&
      range.end <= candidate.end
  );

  if (!row) {
    return "paragraph";
  }

  const cell = getMarkdownTableCellRanges(row.text, row.start).find(
    (candidate) => range.start >= candidate.start && range.end <= candidate.end
  );

  return cell ? "cell" : "row";
}

function getHeadingTextForOffset(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  offset: number
): string | undefined {
  const lineStarts = getLineStartOffsets(markdown);
  let containingHeading: ReturnType<typeof parseMarkdownHeadings>[number] | undefined;

  for (const heading of headings) {
    const headingOffset = lineStarts[heading.line - 1] ?? 0;

    if (headingOffset > offset) {
      break;
    }

    containingHeading = heading;
  }

  return containingHeading?.text;
}

function dedupeRanges(ranges: TextRange[]): TextRange[] {
  const seen = new Set<string>();

  return ranges.filter((range) => {
    const key = getRangeKey(range);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getRangeKey(range: TextRange): string {
  return `${range.start}:${range.end}`;
}

function getHigherConfidence(
  current: CanonicalTargetConfidence,
  next: CanonicalTargetConfidence
): CanonicalTargetConfidence {
  const rank: Record<CanonicalTargetConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1
  };

  return rank[next] > rank[current] ? next : current;
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

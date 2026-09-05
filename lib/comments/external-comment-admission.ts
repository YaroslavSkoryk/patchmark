import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetResolution
} from "./canonical-target-resolution.ts";
import {
  createDocumentHash,
  createNativeSelectedTextAnchorFromRange
} from "./comment-reanchor.ts";
import {
  createNativePatchmarkComment,
  getDefaultCommentActionContext
} from "./native-comment.ts";
import {
  dedupeTextMatches,
  findExactTextMatches,
  findMarkdownPlainTextMatches,
  getMarkdownPlainText,
  normalizeMarkdownText
} from "../markdown/markdown-text.ts";
import {
  parseMarkdownHeadings,
  type MarkdownHeading
} from "../markdown/parse-headings.ts";
import type {
  PatchmarkCommentAnchor,
  PatchmarkExternalComment,
  PatchmarkExternalCommentAnchor
} from "../project/project-types.ts";

type TextRange = { end: number; start: number };
type SelectedTextAnchor = Extract<
  PatchmarkExternalCommentAnchor,
  { kind: "selected_text" }
>;

export type AdmittedExternalCommentAnchor = Readonly<{
  currentAnchor: PatchmarkCommentAnchor;
  snapshotAnchor: PatchmarkCommentAnchor;
}>;

export type ExternalCommentAnchorAdmissionErrorCode =
  | "current_anchor_ambiguous"
  | "current_anchor_not_found"
  | "document_scope_mismatch"
  | "snapshot_anchor_ambiguous"
  | "snapshot_anchor_evidence_mismatch"
  | "snapshot_anchor_not_found"
  | "snapshot_anchor_not_persistable";

export class ExternalCommentAnchorAdmissionError extends Error {
  readonly code: ExternalCommentAnchorAdmissionErrorCode;
  readonly localRef: string;

  constructor({
    code,
    localRef,
    message
  }: {
    code: ExternalCommentAnchorAdmissionErrorCode;
    localRef: string;
    message: string;
  }) {
    super(message);
    this.name = "ExternalCommentAnchorAdmissionError";
    this.code = code;
    this.localRef = localRef;
  }
}

export function admitExternalCommentAnchor({
  currentMarkdown,
  documentId,
  externalComment,
  snapshotMarkdown
}: {
  currentMarkdown: string;
  documentId: string;
  externalComment: PatchmarkExternalComment;
  snapshotMarkdown: string;
}): AdmittedExternalCommentAnchor {
  if (externalComment.document_id !== documentId) {
    throw createAdmissionError({
      code: "document_scope_mismatch",
      externalComment,
      message: "the comment belongs to another document"
    });
  }

  validateDirectSnapshotEvidence({
    anchor: externalComment.anchor,
    externalComment,
    markdown: snapshotMarkdown
  });

  const snapshotResolution = resolveExternalAnchor({
    anchor: externalComment.anchor,
    comment: externalComment,
    markdown: snapshotMarkdown,
    stage: "snapshot"
  });
  validateResolvedSnapshotEvidence({
    anchor: externalComment.anchor,
    externalComment,
    markdown: snapshotMarkdown,
    resolution: snapshotResolution
  });
  const snapshotAnchor = createCanonicalAnchor({
    anchor: externalComment.anchor,
    comment: externalComment,
    markdown: snapshotMarkdown,
    resolution: snapshotResolution
  });

  if (!snapshotAnchor) {
    throw createAdmissionError({
      code: "snapshot_anchor_not_persistable",
      externalComment,
      message: "the uniquely resolved snapshot target could not form a native anchor"
    });
  }

  const currentResolutionAnchor =
    currentMarkdown === snapshotMarkdown
      ? snapshotAnchor
      : createRelocationAnchor(snapshotAnchor);
  const currentResolution = resolveExternalAnchor({
    anchor: currentResolutionAnchor,
    comment: externalComment,
    markdown: currentMarkdown,
    stage: "current"
  });
  const currentAnchor = createCanonicalAnchor({
    anchor: snapshotAnchor,
    comment: externalComment,
    markdown: currentMarkdown,
    resolution: currentResolution
  });

  if (!currentAnchor) {
    throw createAdmissionError({
      code: "snapshot_anchor_not_persistable",
      externalComment,
      message: "the current target could not form a native anchor"
    });
  }

  return Object.freeze({ currentAnchor, snapshotAnchor });
}

function createRelocationAnchor(
  anchor: PatchmarkCommentAnchor
): PatchmarkCommentAnchor {
  if (anchor.kind === "document") {
    return anchor;
  }
  if (anchor.kind === "section") {
    return {
      kind: "section",
      heading: anchor.heading,
      heading_level: anchor.heading_level,
      heading_path: anchor.heading_path,
      action_context: anchor.action_context
    };
  }

  return {
    kind: "selected_text",
    selected_text: anchor.selected_text,
    selected_text_hash: anchor.selected_text_hash,
    anchor_context: anchor.anchor_context
      ? {
          ...anchor.anchor_context,
          markdown_start_offset: undefined,
          markdown_end_offset: undefined,
          table_row_start_offset: undefined,
          table_row_end_offset: undefined,
          table_cell_start_offset: undefined,
          table_cell_end_offset: undefined
        }
      : undefined,
    context_before: anchor.context_before,
    context_after: anchor.context_after,
    containing_heading: anchor.containing_heading,
    containing_heading_level: anchor.containing_heading_level,
    containing_heading_path: anchor.containing_heading_path,
    anchor_source: anchor.anchor_source,
    action_context: anchor.action_context
  };
}

function resolveExternalAnchor({
  anchor,
  comment,
  markdown,
  stage
}: {
  anchor: PatchmarkCommentAnchor | PatchmarkExternalCommentAnchor;
  comment: PatchmarkExternalComment;
  markdown: string;
  stage: "current" | "snapshot";
}): CanonicalTargetResolution {
  const nativeAnchor = withNativeActionContext(anchor, comment.type);
  const probe = createNativePatchmarkComment({
    anchor: nativeAnchor,
    comment: comment.comment,
    createdAt: "1970-01-01T00:00:00.000Z",
    id: "PM-COMMENT-EXTERNAL-ADMISSION",
    type: comment.type
  });
  const resolution = resolveCanonicalCommentTarget(probe, { markdown });

  if (resolution.state !== "resolved" || !resolution.range) {
    const state = resolution.state === "ambiguous" ? "ambiguous" : "not_found";
    throw createAdmissionError({
      code: `${stage}_anchor_${state}`,
      externalComment: comment,
      message: `${stage === "snapshot" ? "the exported snapshot" : "the current document"} target is ${state === "ambiguous" ? "ambiguous" : "unresolved"} (${resolution.explanationCode ?? "no canonical explanation"})`
    });
  }

  return resolution;
}

function createCanonicalAnchor({
  anchor,
  comment,
  markdown,
  resolution
}: {
  anchor: PatchmarkCommentAnchor | PatchmarkExternalCommentAnchor;
  comment: PatchmarkExternalComment;
  markdown: string;
  resolution: CanonicalTargetResolution;
}): PatchmarkCommentAnchor | null {
  if (!resolution.range) {
    return null;
  }

  if (anchor.kind === "document") {
    return {
      kind: "document",
      action_context: getDefaultCommentActionContext(comment.type, "document")
    };
  }

  const headings = parseMarkdownHeadings(markdown);
  if (anchor.kind === "section") {
    const heading = findHeadingAtRange(markdown, headings, resolution.range);

    if (!heading) {
      return null;
    }

    const sectionRange = getSectionRange(markdown, headings, heading);
    return {
      kind: "section",
      heading: heading.text,
      heading_level: heading.level,
      heading_line: heading.line,
      heading_path: getHeadingPath(headings, heading),
      section_start_offset: sectionRange.start,
      section_end_offset: sectionRange.end,
      action_context: getDefaultCommentActionContext(comment.type, "section")
    };
  }

  return createNativeSelectedTextAnchorFromRange({
    headings,
    markdown,
    previousAnchor: {
      ...anchor,
      action_context: getDefaultCommentActionContext(
        comment.type,
        "selected_text"
      )
    },
    range: resolution.range,
    source: "markdown"
  });
}

function validateDirectSnapshotEvidence({
  anchor,
  externalComment,
  markdown
}: {
  anchor: PatchmarkExternalCommentAnchor;
  externalComment: PatchmarkExternalComment;
  markdown: string;
}): void {
  if (anchor.kind !== "selected_text") {
    return;
  }

  if (
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    assertSnapshotEvidence(
      isRangeInDocument(markdown, {
        start: anchor.markdown_start_offset,
        end: anchor.markdown_end_offset
      }) &&
        markdown.slice(
          anchor.markdown_start_offset,
          anchor.markdown_end_offset
        ) === anchor.selected_text,
      externalComment,
      "selected-text offsets do not match selected_text"
    );
  }

  const context = anchor.anchor_context;
  if (
    context &&
    typeof context.markdown_start_offset === "number" &&
    typeof context.markdown_end_offset === "number"
  ) {
    const contextRange = {
      start: context.markdown_start_offset,
      end: context.markdown_end_offset
    };
    assertSnapshotEvidence(
      isRangeInDocument(markdown, contextRange),
      externalComment,
      "anchor_context offsets exceed the exported snapshot"
    );
    const contextMarkdown = markdown.slice(contextRange.start, contextRange.end);
    if (context.markdown_text !== undefined) {
      assertSnapshotEvidence(
        contextMarkdown === context.markdown_text,
        externalComment,
        "anchor_context offsets do not match markdown_text"
      );
    }
    assertSnapshotEvidence(
      normalizeMarkdownText(getMarkdownPlainText(contextMarkdown)) ===
        normalizeMarkdownText(context.plain_text),
      externalComment,
      "anchor_context offsets do not match plain_text"
    );
  }

  validateKnownHash(
    anchor.selected_text_hash,
    anchor.selected_text,
    externalComment,
    "selected_text_hash"
  );
  if (context?.context_hash && context.markdown_text !== undefined) {
    validateKnownHash(
      context.context_hash,
      context.markdown_text,
      externalComment,
      "anchor_context.context_hash"
    );
  }
  if (anchor.anchor_text !== undefined) {
    validateKnownHash(
      anchor.anchor_text_hash,
      anchor.anchor_text,
      externalComment,
      "anchor_text_hash"
    );
    const normalizedSelected = normalizeMarkdownText(
      getMarkdownPlainText(anchor.selected_text)
    );
    const normalizedAnchorText = normalizeMarkdownText(
      getMarkdownPlainText(anchor.anchor_text)
    );
    assertSnapshotEvidence(
      anchor.anchor_text_source === "selected"
        ? normalizedAnchorText === normalizedSelected
        : normalizedAnchorText.includes(normalizedSelected),
      externalComment,
      "anchor_text does not contain the selected target"
    );
  }
}

function validateResolvedSnapshotEvidence({
  anchor,
  externalComment,
  markdown,
  resolution
}: {
  anchor: PatchmarkExternalCommentAnchor;
  externalComment: PatchmarkExternalComment;
  markdown: string;
  resolution: CanonicalTargetResolution;
}): void {
  const range = resolution.range;
  if (!range || anchor.kind === "document") {
    return;
  }

  const headings = parseMarkdownHeadings(markdown);
  if (anchor.kind === "section") {
    const heading = findHeadingAtRange(markdown, headings, range);
    assertSnapshotEvidence(
      Boolean(heading),
      externalComment,
      "section target is not a canonical Markdown heading"
    );
    if (!heading) {
      return;
    }
    validateHeadingEvidence({
      externalComment,
      heading,
      headingLevel: anchor.heading_level,
      headingLine: anchor.heading_line,
      headingPath: anchor.heading_path,
      headings
    });
    return;
  }

  const containingHeading = getHeadingContainingOffset(markdown, headings, range.start);
  validateHeadingEvidence({
    externalComment,
    heading: containingHeading,
    headingLevel: anchor.containing_heading_level,
    headingLine: anchor.containing_heading_line,
    headingPath: anchor.containing_heading_path,
    headingText: anchor.containing_heading,
    headings
  });

  if (anchor.context_before !== undefined) {
    assertSnapshotEvidence(
      markdown.slice(Math.max(0, range.start - anchor.context_before.length), range.start) ===
        anchor.context_before,
      externalComment,
      "context_before does not immediately precede the resolved target"
    );
  }
  if (anchor.context_after !== undefined) {
    assertSnapshotEvidence(
      markdown.slice(range.end, range.end + anchor.context_after.length) ===
        anchor.context_after,
      externalComment,
      "context_after does not immediately follow the resolved target"
    );
  }

  const fallbackRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : null;
  if (
    typeof anchor.fallback_section_start_offset === "number" &&
    typeof anchor.fallback_section_end_offset === "number"
  ) {
    assertSnapshotEvidence(
      Boolean(
        fallbackRange &&
          fallbackRange.start === anchor.fallback_section_start_offset &&
          fallbackRange.end === anchor.fallback_section_end_offset
      ),
      externalComment,
      "fallback section offsets contradict the resolved target"
    );
  }

  validateAnchorContextEvidence({
    anchor,
    externalComment,
    markdown,
    range
  });
}

function validateAnchorContextEvidence({
  anchor,
  externalComment,
  markdown,
  range
}: {
  anchor: SelectedTextAnchor;
  externalComment: PatchmarkExternalComment;
  markdown: string;
  range: TextRange;
}): void {
  const context = anchor.anchor_context;
  if (!context) {
    return;
  }

  const contextRanges =
    typeof context.markdown_start_offset === "number" &&
    typeof context.markdown_end_offset === "number"
      ? [
          {
            start: context.markdown_start_offset,
            end: context.markdown_end_offset
          }
        ]
      : dedupeTextMatches([
          ...(context.markdown_text
            ? findExactTextMatches(markdown, context.markdown_text)
            : []),
          ...findMarkdownPlainTextMatches(markdown, context.plain_text)
        ]);
  assertSnapshotEvidence(
    contextRanges.some(
      (contextRange) =>
        range.start >= contextRange.start && range.end <= contextRange.end
    ),
    externalComment,
    "anchor_context does not contain the resolved target"
  );

  if (
    typeof context.markdown_start_offset === "number" &&
    typeof context.markdown_end_offset === "number"
  ) {
    assertSnapshotEvidence(
      range.start >= context.markdown_start_offset &&
        range.end <= context.markdown_end_offset,
      externalComment,
      "the resolved selection is outside anchor_context"
    );
  }

  if (
    typeof context.selected_start_in_context === "number" &&
    typeof context.selected_end_in_context === "number"
  ) {
    const expectedPlainSelection = normalizeMarkdownText(
      context.plain_text.slice(
        context.selected_start_in_context,
        context.selected_end_in_context
      )
    );
    const expectedMarkdownSelection = context.markdown_text
      ? normalizeMarkdownText(
          getMarkdownPlainText(
            context.markdown_text.slice(
              context.selected_start_in_context,
              context.selected_end_in_context
            )
          )
        )
      : "";
    const resolvedPlainSelection = normalizeMarkdownText(
      getMarkdownPlainText(markdown.slice(range.start, range.end))
    );
    assertSnapshotEvidence(
      expectedPlainSelection === resolvedPlainSelection ||
        expectedMarkdownSelection === resolvedPlainSelection,
      externalComment,
      "anchor_context selected range contradicts selected_text"
    );
  }

  for (const [name, nestedRange] of [
    [
      "table row",
      toOptionalRange(
        context.table_row_start_offset,
        context.table_row_end_offset
      )
    ],
    [
      "table cell",
      toOptionalRange(
        context.table_cell_start_offset,
        context.table_cell_end_offset
      )
    ]
  ] as const) {
    if (!nestedRange) {
      continue;
    }
    assertSnapshotEvidence(
      isRangeInDocument(markdown, nestedRange) &&
        range.start >= nestedRange.start &&
        range.end <= nestedRange.end,
      externalComment,
      `${name} offsets contradict the resolved target`
    );
  }
}

function validateHeadingEvidence({
  externalComment,
  heading,
  headingLevel,
  headingLine,
  headingPath,
  headingText,
  headings
}: {
  externalComment: PatchmarkExternalComment;
  heading?: MarkdownHeading;
  headingLevel?: number;
  headingLine?: number;
  headingPath?: string[];
  headingText?: string;
  headings: MarkdownHeading[];
}): void {
  if (headingText !== undefined) {
    assertSnapshotEvidence(
      heading?.text === headingText,
      externalComment,
      "containing heading text contradicts the resolved target"
    );
  }
  if (headingLevel !== undefined) {
    assertSnapshotEvidence(
      heading?.level === headingLevel,
      externalComment,
      "heading level contradicts the resolved target"
    );
  }
  if (headingLine !== undefined) {
    assertSnapshotEvidence(
      heading?.line === headingLine,
      externalComment,
      "heading line contradicts the resolved target"
    );
  }
  if (headingPath !== undefined) {
    assertSnapshotEvidence(
      Boolean(
        heading &&
          arraysEqual(getHeadingPath(headings, heading), headingPath)
      ),
      externalComment,
      "heading path contradicts the resolved target"
    );
  }
}

function withNativeActionContext(
  anchor: PatchmarkCommentAnchor | PatchmarkExternalCommentAnchor,
  commentType: PatchmarkExternalComment["type"]
): PatchmarkCommentAnchor {
  return {
    ...anchor,
    action_context:
      ("action_context" in anchor ? anchor.action_context : undefined) ??
      getDefaultCommentActionContext(commentType, anchor.kind)
  } as PatchmarkCommentAnchor;
}

function validateKnownHash(
  hash: string | undefined,
  value: string,
  externalComment: PatchmarkExternalComment,
  field: string
): void {
  if (!hash?.startsWith("fnv1a64:")) {
    return;
  }
  assertSnapshotEvidence(
    hash === createDocumentHash(value),
    externalComment,
    `${field} contradicts its text`
  );
}

function assertSnapshotEvidence(
  condition: boolean,
  externalComment: PatchmarkExternalComment,
  detail: string
): asserts condition {
  if (!condition) {
    throw createAdmissionError({
      code: "snapshot_anchor_evidence_mismatch",
      externalComment,
      message: detail
    });
  }
}

function createAdmissionError({
  code,
  externalComment,
  message
}: {
  code: ExternalCommentAnchorAdmissionErrorCode;
  externalComment: PatchmarkExternalComment;
  message: string;
}): ExternalCommentAnchorAdmissionError {
  return new ExternalCommentAnchorAdmissionError({
    code,
    localRef: externalComment.local_ref,
    message: `Cannot import new comment ${externalComment.local_ref}: ${message}. No response data was imported.`
  });
}

function findHeadingAtRange(
  markdown: string,
  headings: MarkdownHeading[],
  range: TextRange
): MarkdownHeading | undefined {
  return headings.find((heading) => {
    const headingRange = getHeadingLineRange(markdown, heading);
    return headingRange.start === range.start && headingRange.end === range.end;
  });
}

function getHeadingContainingOffset(
  markdown: string,
  headings: MarkdownHeading[],
  offset: number
): MarkdownHeading | undefined {
  let containingHeading: MarkdownHeading | undefined;
  for (const heading of headings) {
    if (getLineStartOffset(markdown, heading.line) > offset) {
      break;
    }
    containingHeading = heading;
  }
  return containingHeading;
}

function getSectionRange(
  markdown: string,
  headings: MarkdownHeading[],
  heading: MarkdownHeading
): TextRange {
  const index = headings.findIndex((candidate) => candidate.line === heading.line);
  const nextBoundary = headings
    .slice(index + 1)
    .find((candidate) => candidate.level <= heading.level);
  return {
    start: getLineStartOffset(markdown, heading.line),
    end: nextBoundary
      ? getLineStartOffset(markdown, nextBoundary.line)
      : markdown.length
  };
}

function getHeadingLineRange(
  markdown: string,
  heading: MarkdownHeading
): TextRange {
  const start = getLineStartOffset(markdown, heading.line);
  const nextStart = getLineStartOffset(markdown, heading.line + 1);
  return {
    start,
    end: nextStart > start ? Math.max(start, nextStart - 1) : markdown.length
  };
}

function getHeadingPath(
  headings: MarkdownHeading[],
  target: MarkdownHeading
): string[] {
  const path: MarkdownHeading[] = [];
  for (const heading of headings) {
    while (path.length > 0 && path[path.length - 1].level >= heading.level) {
      path.pop();
    }
    path.push(heading);
    if (heading.line === target.line) {
      return path.map((entry) => entry.text);
    }
  }
  return [target.text];
}

function getLineStartOffset(markdown: string, line: number): number {
  if (line <= 1) {
    return 0;
  }
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

function toOptionalRange(
  start?: number,
  end?: number
): TextRange | null {
  return typeof start === "number" && typeof end === "number"
    ? { start, end }
    : null;
}

function isRangeInDocument(markdown: string, range: TextRange): boolean {
  return (
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= markdown.length
  );
}

function arraysEqual(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

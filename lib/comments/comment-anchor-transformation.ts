import type { TextRange } from "../markdown/markdown-text.ts";
import type { PatchmarkCommentAnchor } from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

export type MarkdownEdit = {
  insertedText: string;
  oldEnd: number;
  oldStart: number;
};

export type AnchorTransformResult =
  | {
      end: number;
      outcome: "active";
      selectedText: string;
      start: number;
      transformation:
        | "after_edit_shifted"
        | "before_edit_unchanged"
        | "complete_anchor_replaced"
        | "edit_inside_anchor"
        | "edit_contains_anchor"
        | "overlap_anchor_end"
        | "overlap_anchor_start";
    }
  | {
      end?: number;
      outcome: "needs_review";
      reason: string;
      start?: number;
    }
  | {
      end?: number;
      outcome: "inactive";
      reason: string;
      start?: number;
    };

export type AnchorEditRelationship =
  | "after"
  | "anchor_inside_edit"
  | "before"
  | "edit_inside_anchor"
  | "exact_replacement"
  | "overlap_anchor_end"
  | "overlap_anchor_start"
  | "unaffected";

export type ManualEditSafetyResult =
  | {
      reason: string;
      safe: true;
    }
  | {
      reason: string;
      safe: false;
    };

const MAX_SAFE_MANUAL_CHANGED_LINES = 80;
const MAX_SAFE_MANUAL_AFFECTED_ANCHORS = 5;

export function deriveContiguousMarkdownEdit(
  oldMarkdown: string,
  newMarkdown: string
): MarkdownEdit | null {
  if (oldMarkdown === newMarkdown) {
    return null;
  }

  let prefixLength = 0;
  const shortestLength = Math.min(oldMarkdown.length, newMarkdown.length);

  while (
    prefixLength < shortestLength &&
    oldMarkdown[prefixLength] === newMarkdown[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < oldMarkdown.length - prefixLength &&
    suffixLength < newMarkdown.length - prefixLength &&
    oldMarkdown[oldMarkdown.length - 1 - suffixLength] ===
      newMarkdown[newMarkdown.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldStart = prefixLength;
  const oldEnd = oldMarkdown.length - suffixLength;
  const newEnd = newMarkdown.length - suffixLength;

  return {
    insertedText: newMarkdown.slice(oldStart, newEnd),
    oldEnd,
    oldStart
  };
}

export function getMarkdownEditRange(edit: MarkdownEdit): TextRange {
  return {
    end: edit.oldEnd,
    start: edit.oldStart
  };
}

export function classifyRangeAgainstEdit(
  range: TextRange,
  edit: MarkdownEdit
): AnchorEditRelationship {
  if (edit.oldEnd <= range.start) {
    return "after";
  }

  if (edit.oldStart >= range.end) {
    return "before";
  }

  if (edit.oldStart === range.start && edit.oldEnd === range.end) {
    return "exact_replacement";
  }

  if (edit.oldStart > range.start && edit.oldEnd < range.end) {
    return "edit_inside_anchor";
  }

  if (edit.oldStart <= range.start && edit.oldEnd >= range.end) {
    return "anchor_inside_edit";
  }

  if (edit.oldStart <= range.start && edit.oldEnd < range.end) {
    return "overlap_anchor_start";
  }

  if (edit.oldStart > range.start && edit.oldStart < range.end) {
    return "overlap_anchor_end";
  }

  return "unaffected";
}

export function isSafeManualAnchorTransformEdit({
  affectedAnchorCount,
  edit,
  oldMarkdown
}: {
  affectedAnchorCount: number;
  edit: MarkdownEdit;
  oldMarkdown: string;
}): ManualEditSafetyResult {
  const removedLength = edit.oldEnd - edit.oldStart;
  const changedLineCount = countChangedLines(
    oldMarkdown.slice(edit.oldStart, edit.oldEnd),
    edit.insertedText
  );
  const hasStablePrefix = edit.oldStart > 0;
  const hasStableSuffix = edit.oldEnd < oldMarkdown.length;
  const replacesWholeDocument =
    oldMarkdown.length > 0 && !hasStablePrefix && !hasStableSuffix;
  const replacesMostDocument =
    oldMarkdown.length > 0 && removedLength / oldMarkdown.length > 0.5;

  if (replacesWholeDocument) {
    return {
      safe: false,
      reason: "manual transform skipped because the change replaced the whole document"
    };
  }

  if (replacesMostDocument && affectedAnchorCount > 1) {
    return {
      safe: false,
      reason:
        "manual transform skipped because a broad document replacement affected multiple anchors"
    };
  }

  if (changedLineCount > MAX_SAFE_MANUAL_CHANGED_LINES) {
    return {
      safe: false,
      reason:
        "manual transform skipped because the synthetic replacement spans too many lines"
    };
  }

  if (affectedAnchorCount > MAX_SAFE_MANUAL_AFFECTED_ANCHORS) {
    return {
      safe: false,
      reason:
        "manual transform skipped because one edit would remap too many selected-text anchors"
    };
  }

  return {
    safe: true,
    reason:
      "manual transform allowed for a local contiguous edit with bounded affected anchors"
  };
}

export function transformSelectedTextAnchorThroughEdit({
  anchor,
  edit,
  newMarkdown,
  oldMarkdown
}: {
  anchor: SelectedTextAnchor;
  edit: MarkdownEdit;
  newMarkdown: string;
  oldMarkdown: string;
}): AnchorTransformResult {
  const anchorStart = anchor.markdown_start_offset;
  const anchorEnd = anchor.markdown_end_offset;

  if (
    typeof anchorStart !== "number" ||
    typeof anchorEnd !== "number" ||
    anchorStart < 0 ||
    anchorEnd < anchorStart ||
    anchorEnd > oldMarkdown.length
  ) {
    return {
      outcome: "needs_review",
      reason: "selected-text anchor has invalid or missing offsets"
    };
  }

  if (oldMarkdown.slice(anchorStart, anchorEnd) !== anchor.selected_text) {
    return {
      outcome: "needs_review",
      reason: "selected-text anchor offsets do not match the previous document"
    };
  }

  const delta = edit.insertedText.length - (edit.oldEnd - edit.oldStart);

  const relationship = classifyRangeAgainstEdit(
    {
      start: anchorStart,
      end: anchorEnd
    },
    edit
  );

  if (relationship === "after") {
    return createActiveTransformResult({
      end: anchorEnd + delta,
      newMarkdown,
      start: anchorStart + delta,
      transformation: "after_edit_shifted"
    });
  }

  if (relationship === "before") {
    return createActiveTransformResult({
      end: anchorEnd,
      newMarkdown,
      start: anchorStart,
      transformation: "before_edit_unchanged"
    });
  }

  if (relationship === "exact_replacement") {
    return createReplacementResult({
      edit,
      newMarkdown,
      reason: "selected-text anchor was deleted by the edit",
      transformation: "complete_anchor_replaced"
    });
  }

  if (relationship === "edit_inside_anchor") {
    return createActiveTransformResult({
      end: anchorEnd + delta,
      newMarkdown,
      start: anchorStart,
      transformation: "edit_inside_anchor"
    });
  }

  if (relationship === "anchor_inside_edit") {
    return createReplacementResult({
      edit,
      newMarkdown,
      reason: "selected-text anchor was deleted by a containing edit",
      transformation: "edit_contains_anchor"
    });
  }

  if (relationship === "overlap_anchor_start") {
    const survivingTailLength = anchorEnd - edit.oldEnd;
    return createActiveTransformResult({
      end: edit.oldStart + edit.insertedText.length + survivingTailLength,
      newMarkdown,
      start: edit.oldStart,
      transformation: "overlap_anchor_start"
    });
  }

  if (relationship === "overlap_anchor_end") {
    return createActiveTransformResult({
      end: edit.oldStart + edit.insertedText.length,
      newMarkdown,
      start: anchorStart,
      transformation: "overlap_anchor_end"
    });
  }

  return {
    outcome: "needs_review",
    reason: "selected-text anchor relationship to edit could not be classified"
  };
}

export function doesRangeIntersectEdit(range: TextRange, edit: MarkdownEdit): boolean {
  return range.start < edit.oldEnd && range.end > edit.oldStart;
}

export function isRangeAfterEdit(range: TextRange, edit: MarkdownEdit): boolean {
  return edit.oldEnd <= range.start;
}

function createReplacementResult({
  edit,
  newMarkdown,
  reason,
  transformation
}: {
  edit: MarkdownEdit;
  newMarkdown: string;
  reason: string;
  transformation: Extract<
    AnchorTransformResult,
    { outcome: "active" }
  >["transformation"];
}): AnchorTransformResult {
  if (edit.insertedText.length === 0) {
    return {
      outcome: "inactive",
      reason,
      start: edit.oldStart,
      end: edit.oldStart
    };
  }

  return createActiveTransformResult({
    end: edit.oldStart + edit.insertedText.length,
    newMarkdown,
    start: edit.oldStart,
    transformation
  });
}

function createActiveTransformResult({
  end,
  newMarkdown,
  start,
  transformation
}: {
  end: number;
  newMarkdown: string;
  start: number;
  transformation: Extract<
    AnchorTransformResult,
    { outcome: "active" }
  >["transformation"];
}): AnchorTransformResult {
  if (start < 0 || end < start || end > newMarkdown.length) {
    return {
      outcome: "needs_review",
      reason: "transformed selected-text anchor range is outside the new document"
    };
  }

  if (start === end) {
    return {
      outcome: "inactive",
      reason: "transformed selected-text anchor is empty",
      start,
      end
    };
  }

  return {
    end,
    outcome: "active",
    selectedText: newMarkdown.slice(start, end),
    start,
    transformation
  };
}

function countChangedLines(removedText: string, insertedText: string): number {
  return Math.max(countLines(removedText), countLines(insertedText));
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return text.split("\n").length;
}

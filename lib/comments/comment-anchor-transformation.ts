import type { TextRange } from "../markdown/markdown-text.ts";
import type { PatchmarkCommentAnchor } from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

export type MarkdownEdit = {
  insertedText: string;
  kind?:
    | "delete"
    | "format"
    | "insert"
    | "move_destination"
    | "move_source"
    | "replace";
  oldEnd: number;
  oldStart: number;
  removedText?: string;
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
        | "moved_with_text"
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

export type MarkdownChangeSetSource =
  | "composition"
  | "cut"
  | "formatter"
  | "manual_source"
  | "manual_visual"
  | "move"
  | "paste"
  | "patch_apply"
  | "programmatic"
  | "redo"
  | "undo";

export type MarkdownChangeSet = {
  broad: boolean;
  confidence: "high" | "low" | "medium";
  derivation:
    | "contiguous_fallback"
    | "line_hunk_diff"
    | "native"
    | "none";
  edits: MarkdownEdit[];
  source: MarkdownChangeSetSource;
};

const MAX_SAFE_MANUAL_CHANGED_LINES = 80;
const MAX_SAFE_MANUAL_AFFECTED_ANCHORS = 5;
const MAX_SAFE_MANUAL_CHANGESET_EDITS = 24;
const MAX_LINE_DIFF_LINES = 1200;
const MIN_MOVE_TEXT_LENGTH = 12;

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
    kind: getMarkdownEditKind({
      insertedText: newMarkdown.slice(oldStart, newEnd),
      removedText: oldMarkdown.slice(oldStart, oldEnd)
    }),
    oldEnd,
    oldStart,
    removedText: oldMarkdown.slice(oldStart, oldEnd)
  };
}

export function deriveMarkdownChangeSet({
  newMarkdown,
  oldMarkdown,
  source = "manual_source"
}: {
  newMarkdown: string;
  oldMarkdown: string;
  source?: MarkdownChangeSetSource;
}): MarkdownChangeSet | null {
  if (oldMarkdown === newMarkdown) {
    return null;
  }

  const oldLines = splitLinesWithOffsets(oldMarkdown);
  const newLines = splitLinesWithOffsets(newMarkdown);
  const isLineDiffSafe =
    oldLines.length <= MAX_LINE_DIFF_LINES &&
    newLines.length <= MAX_LINE_DIFF_LINES;

  const lineEdits = isLineDiffSafe
    ? deriveLineHunkMarkdownEdits({
        newLines,
        newMarkdown,
        oldLines,
        oldMarkdown
      })
    : null;

  const validatedLineEdits =
    lineEdits &&
    validateMarkdownEdits({
      edits: lineEdits,
      newMarkdown,
      oldMarkdown
    });

  if (validatedLineEdits) {
    const moveAwareEdits = annotateUniqueMoveEdits(lineEdits);

    return {
      broad: isBroadChangeSet(moveAwareEdits, oldMarkdown),
      confidence: moveAwareEdits.length <= MAX_SAFE_MANUAL_CHANGESET_EDITS
        ? "high"
        : "medium",
      derivation: "line_hunk_diff",
      edits: moveAwareEdits,
      source: containsUniqueMove(moveAwareEdits) ? "move" : source
    };
  }

  const fallbackEdit = deriveContiguousMarkdownEdit(oldMarkdown, newMarkdown);

  if (!fallbackEdit) {
    return null;
  }

  return {
    broad: true,
    confidence: "low",
    derivation: "contiguous_fallback",
    edits: [fallbackEdit],
    source
  };
}

export function applyMarkdownEdits(
  oldMarkdown: string,
  edits: MarkdownEdit[]
): string {
  let nextMarkdown = "";
  let oldCursor = 0;

  for (const edit of edits) {
    nextMarkdown += oldMarkdown.slice(oldCursor, edit.oldStart);
    nextMarkdown += edit.insertedText;
    oldCursor = edit.oldEnd;
  }

  nextMarkdown += oldMarkdown.slice(oldCursor);

  return nextMarkdown;
}

export function validateMarkdownEdits({
  edits,
  newMarkdown,
  oldMarkdown
}: {
  edits: MarkdownEdit[];
  newMarkdown: string;
  oldMarkdown: string;
}): boolean {
  let previousEnd = 0;

  for (const edit of edits) {
    if (
      edit.oldStart < previousEnd ||
      edit.oldStart < 0 ||
      edit.oldEnd < edit.oldStart ||
      edit.oldEnd > oldMarkdown.length
    ) {
      return false;
    }

    if (
      typeof edit.removedText === "string" &&
      oldMarkdown.slice(edit.oldStart, edit.oldEnd) !== edit.removedText
    ) {
      return false;
    }

    previousEnd = edit.oldEnd;
  }

  return applyMarkdownEdits(oldMarkdown, edits) === newMarkdown;
}

export function isSafeManualAnchorTransformChangeSet({
  affectedAnchorCount,
  changeSet,
  oldMarkdown
}: {
  affectedAnchorCount: number;
  changeSet: MarkdownChangeSet;
  oldMarkdown: string;
}): ManualEditSafetyResult {
  if (changeSet.broad || changeSet.confidence === "low") {
    return {
      safe: false,
      reason:
        "manual transform skipped because the derived change set was broad or low-confidence"
    };
  }

  if (changeSet.edits.length > MAX_SAFE_MANUAL_CHANGESET_EDITS) {
    return {
      safe: false,
      reason:
        "manual transform skipped because the change set contains too many edit hunks"
    };
  }

  if (affectedAnchorCount > MAX_SAFE_MANUAL_AFFECTED_ANCHORS) {
    return {
      safe: false,
      reason:
        "manual transform skipped because the change set would remap too many selected-text anchors"
    };
  }

  const changedLineCount = changeSet.edits.reduce(
    (total, edit) =>
      total +
      countChangedLines(
        getRemovedTextForEdit(oldMarkdown, edit),
        edit.insertedText
      ),
    0
  );

  if (changedLineCount > MAX_SAFE_MANUAL_CHANGED_LINES) {
    return {
      safe: false,
      reason:
        "manual transform skipped because the change set spans too many changed lines"
    };
  }

  return {
    safe: true,
    reason:
      "manual transform allowed for a bounded ordered Markdown change set"
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
    const removedText = getRemovedTextForEdit(oldMarkdown, edit);
    const preservedBoundaryPrefixLength = getPreservedBoundaryPrefixLength({
      anchorText: anchor.selected_text,
      removedText
    });

    if (
      edit.insertedText.length === 0 &&
      preservedBoundaryPrefixLength > 0
    ) {
      const preservedStart = edit.oldStart - preservedBoundaryPrefixLength;

      if (
        preservedStart >= 0 &&
        newMarkdown.slice(
          preservedStart,
          preservedStart + anchor.selected_text.length
        ) === anchor.selected_text
      ) {
        return createActiveTransformResult({
          end: preservedStart + anchor.selected_text.length,
          newMarkdown,
          start: preservedStart,
          transformation: "after_edit_shifted"
        });
      }
    }

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

export function transformSelectedTextAnchorThroughChangeSet({
  anchor,
  changeSet,
  newMarkdown,
  oldMarkdown
}: {
  anchor: SelectedTextAnchor;
  changeSet: MarkdownChangeSet;
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

  if (changeSet.edits.length === 0) {
    return createActiveTransformResult({
      end: anchorEnd,
      newMarkdown,
      start: anchorStart,
      transformation: "before_edit_unchanged"
    });
  }

  if (changeSet.edits.length === 1) {
    return transformSelectedTextAnchorThroughSingleChangeSetEdit({
      anchor,
      edit: changeSet.edits[0],
      newMarkdown,
      oldMarkdown
    });
  }

  const moveResult = transformAnchorThroughUniqueMove({
    anchor,
    changeSet,
    newMarkdown,
    oldMarkdown
  });

  if (moveResult) {
    return moveResult;
  }

  let currentStart = anchorStart;
  let currentEnd = anchorEnd;
  let cumulativeDelta = 0;
  let changedInsideAnchor = false;

  for (const edit of changeSet.edits) {
    const editNewStart = edit.oldStart + cumulativeDelta;
    const removedLength = edit.oldEnd - edit.oldStart;
    const delta = edit.insertedText.length - removedLength;

    if (edit.oldEnd <= anchorStart) {
      currentStart += delta;
      currentEnd += delta;
      cumulativeDelta += delta;
      continue;
    }

    if (
      changedInsideAnchor &&
      edit.oldStart >= anchorEnd &&
      edit.oldStart === edit.oldEnd &&
      edit.insertedText.includes("\n") &&
      oldMarkdown.slice(anchorEnd, edit.oldStart).trim().length === 0
    ) {
      currentEnd =
        editNewStart + edit.insertedText.replace(/\n+$/, "").length;
      cumulativeDelta += delta;
      continue;
    }

    if (edit.oldStart >= anchorEnd) {
      cumulativeDelta += delta;
      continue;
    }

    if (edit.oldStart === anchorStart && edit.oldEnd === anchorEnd) {
      return createReplacementResult({
        edit: {
          ...edit,
          oldStart: editNewStart,
          oldEnd: editNewStart + removedLength
        },
        newMarkdown,
        reason: "selected-text anchor was deleted by the edit",
        transformation: "complete_anchor_replaced"
      });
    }

    if (edit.oldStart <= anchorStart && edit.oldEnd >= anchorEnd) {
      const retainedSelection = findUniqueTextInInsertedEdit(
        edit,
        anchor.selected_text
      );

      if (retainedSelection !== null) {
        return createActiveTransformResult({
          end: editNewStart + retainedSelection + anchor.selected_text.length,
          newMarkdown,
          start: editNewStart + retainedSelection,
          transformation: "edit_contains_anchor"
        });
      }

      return {
        outcome: "needs_review",
        reason:
          "selected-text anchor is inside a broad replacement and could not be mapped uniquely"
      };
    }

    if (edit.oldStart > anchorStart && edit.oldEnd < anchorEnd) {
      currentEnd += delta;
      changedInsideAnchor = true;
      cumulativeDelta += delta;
      continue;
    }

    if (edit.oldStart <= anchorStart && edit.oldEnd < anchorEnd) {
      currentStart = editNewStart + edit.insertedText.length;
      currentEnd += delta;
      changedInsideAnchor = true;
      cumulativeDelta += delta;
      continue;
    }

    if (edit.oldStart > anchorStart && edit.oldStart < anchorEnd) {
      currentEnd = editNewStart + edit.insertedText.length;
      changedInsideAnchor = true;
      cumulativeDelta += delta;
      continue;
    }

    return {
      outcome: "needs_review",
      reason:
        "selected-text anchor relationship to change set could not be classified"
    };
  }

  const transformation = changedInsideAnchor
    ? "edit_inside_anchor"
    : "after_edit_shifted";

  return createActiveTransformResult({
    end: currentEnd,
    newMarkdown,
    start: currentStart,
    transformation
  });
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

type MarkdownLineToken = {
  end: number;
  start: number;
  text: string;
};

function splitLinesWithOffsets(markdown: string): MarkdownLineToken[] {
  if (markdown.length === 0) {
    return [];
  }

  const lines: MarkdownLineToken[] = [];
  let start = 0;

  for (const match of markdown.matchAll(/[^\n]*(?:\n|$)/g)) {
    const text = match[0];

    if (text.length === 0) {
      continue;
    }

    lines.push({
      end: start + text.length,
      start,
      text
    });
    start += text.length;
  }

  return lines;
}

function deriveLineHunkMarkdownEdits({
  newLines,
  newMarkdown,
  oldLines,
  oldMarkdown
}: {
  newLines: MarkdownLineToken[];
  newMarkdown: string;
  oldLines: MarkdownLineToken[];
  oldMarkdown: string;
}): MarkdownEdit[] | null {
  const matches = getLineDiffMatches(oldLines, newLines);
  const edits: MarkdownEdit[] = [];
  let oldCursor = 0;
  let newCursor = 0;

  for (const match of matches) {
    appendRefinedEdit({
      edits,
      newEnd: newLines[match.newIndex].start,
      newMarkdown,
      newStart: newCursor,
      oldEnd: oldLines[match.oldIndex].start,
      oldMarkdown,
      oldStart: oldCursor
    });

    oldCursor = oldLines[match.oldIndex].end;
    newCursor = newLines[match.newIndex].end;
  }

  appendRefinedEdit({
    edits,
    newEnd: newMarkdown.length,
    newMarkdown,
    newStart: newCursor,
    oldEnd: oldMarkdown.length,
    oldMarkdown,
    oldStart: oldCursor
  });

  return edits;
}

function getLineDiffMatches(
  oldLines: MarkdownLineToken[],
  newLines: MarkdownLineToken[]
): Array<{ newIndex: number; oldIndex: number }> {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const table = Array.from({ length: oldLength + 1 }, () =>
    new Array<number>(newLength + 1).fill(0)
  );

  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex].text === newLines[newIndex].text
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              table[oldIndex + 1][newIndex],
              table[oldIndex][newIndex + 1]
            );
    }
  }

  const matches: Array<{ newIndex: number; oldIndex: number }> = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldLines[oldIndex].text === newLines[newIndex].text) {
      matches.push({ newIndex, oldIndex });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]
    ) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  return matches;
}

function appendRefinedEdit({
  edits,
  newEnd,
  newMarkdown,
  newStart,
  oldEnd,
  oldMarkdown,
  oldStart
}: {
  edits: MarkdownEdit[];
  newEnd: number;
  newMarkdown: string;
  newStart: number;
  oldEnd: number;
  oldMarkdown: string;
  oldStart: number;
}) {
  if (oldStart === oldEnd && newStart === newEnd) {
    return;
  }

  const oldText = oldMarkdown.slice(oldStart, oldEnd);
  const newText = newMarkdown.slice(newStart, newEnd);

  if (oldText === newText) {
    return;
  }

  let prefixLength = 0;
  const shortestLength = Math.min(oldText.length, newText.length);

  while (
    prefixLength < shortestLength &&
    oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < oldText.length - prefixLength &&
    suffixLength < newText.length - prefixLength &&
    oldText[oldText.length - 1 - suffixLength] ===
      newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const refinedOldStart = oldStart + prefixLength;
  const refinedOldEnd = oldEnd - suffixLength;
  const refinedNewStart = newStart + prefixLength;
  const refinedNewEnd = newEnd - suffixLength;
  const insertedText = newMarkdown.slice(refinedNewStart, refinedNewEnd);
  const removedText = oldMarkdown.slice(refinedOldStart, refinedOldEnd);

  edits.push({
    insertedText,
    kind: getMarkdownEditKind({ insertedText, removedText }),
    oldEnd: refinedOldEnd,
    oldStart: refinedOldStart,
    removedText
  });
}

function getMarkdownEditKind({
  insertedText,
  removedText
}: {
  insertedText: string;
  removedText: string;
}): MarkdownEdit["kind"] {
  if (removedText.length === 0 && insertedText.length > 0) {
    return "insert";
  }

  if (removedText.length > 0 && insertedText.length === 0) {
    return "delete";
  }

  if (removedText.length > 0 && insertedText.length > 0) {
    return "replace";
  }

  return undefined;
}

function annotateUniqueMoveEdits(edits: MarkdownEdit[]): MarkdownEdit[] {
  const move = getUniqueMoveCandidate(edits);

  if (!move) {
    return edits;
  }

  return edits.map((edit, index) => {
    if (index === move.sourceIndex) {
      return {
        ...edit,
        kind: "move_source"
      };
    }

    if (index === move.destinationIndex) {
      return {
        ...edit,
        kind: "move_destination"
      };
    }

    return edit;
  });
}

function containsUniqueMove(edits: MarkdownEdit[]): boolean {
  return edits.some((edit) => edit.kind === "move_source");
}

function getUniqueMoveCandidate(
  edits: MarkdownEdit[]
): {
  destinationEdit: MarkdownEdit;
  destinationTextOffset: number;
  destinationIndex: number;
  movedText: string;
  sourceEdit: MarkdownEdit;
  sourceTextOffset: number;
  sourceIndex: number;
} | null {
  const deletions = edits
    .map((edit, index) => ({ edit, index }))
    .filter(
      ({ edit }) =>
        edit.insertedText.length === 0 &&
        getRemovedTextFromEdit(edit).trim().length >= MIN_MOVE_TEXT_LENGTH
    );
  const insertions = edits
    .map((edit, index) => ({ edit, index }))
    .filter(
      ({ edit }) =>
        edit.oldStart === edit.oldEnd &&
        edit.insertedText.trim().length >= MIN_MOVE_TEXT_LENGTH
    );
  const candidates: Array<{
    destinationEdit: MarkdownEdit;
    destinationTextOffset: number;
    destinationIndex: number;
    movedText: string;
    sourceEdit: MarkdownEdit;
    sourceTextOffset: number;
    sourceIndex: number;
  }> = [];

  for (const deletion of deletions) {
    const removedText = getRemovedTextFromEdit(deletion.edit);
    const normalizedRemovedText = trimMoveBoundaryNewlines(removedText);

    for (const insertion of insertions) {
      const normalizedInsertedText = trimMoveBoundaryNewlines(
        insertion.edit.insertedText
      );

      if (
        normalizedInsertedText.length >= MIN_MOVE_TEXT_LENGTH &&
        normalizedInsertedText === normalizedRemovedText
      ) {
        candidates.push({
          destinationEdit: insertion.edit,
          destinationTextOffset:
            insertion.edit.insertedText.indexOf(normalizedInsertedText),
          destinationIndex: insertion.index,
          movedText: normalizedInsertedText,
          sourceEdit: deletion.edit,
          sourceTextOffset: removedText.indexOf(normalizedRemovedText),
          sourceIndex: deletion.index
        });
      }
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function transformAnchorThroughUniqueMove({
  anchor,
  changeSet,
  newMarkdown,
  oldMarkdown
}: {
  anchor: SelectedTextAnchor;
  changeSet: MarkdownChangeSet;
  newMarkdown: string;
  oldMarkdown: string;
}): AnchorTransformResult | null {
  const move = getUniqueMoveCandidate(changeSet.edits);

  if (!move) {
    return null;
  }

  const anchorStart = anchor.markdown_start_offset;
  const anchorEnd = anchor.markdown_end_offset;

  if (
    typeof anchorStart !== "number" ||
    typeof anchorEnd !== "number" ||
    anchorStart < move.sourceEdit.oldStart + move.sourceTextOffset ||
    anchorEnd >
      move.sourceEdit.oldStart + move.sourceTextOffset + move.movedText.length
  ) {
    return null;
  }

  const sourceOccurrencesInOld = countOccurrences(
    oldMarkdown,
    move.movedText
  );
  const destinationOccurrencesInNew = countOccurrences(
    newMarkdown,
    move.movedText
  );

  if (sourceOccurrencesInOld !== 1 || destinationOccurrencesInNew !== 1) {
    return {
      outcome: "needs_review",
      reason: "moved selected-text anchor has ambiguous source or destination"
    };
  }

  const destinationStart =
    getEditNewStart(move.destinationEdit, changeSet.edits) +
    move.destinationTextOffset;
  const relativeStart =
    anchorStart - move.sourceEdit.oldStart - move.sourceTextOffset;
  const relativeEnd =
    anchorEnd - move.sourceEdit.oldStart - move.sourceTextOffset;

  return createActiveTransformResult({
    end: destinationStart + relativeEnd,
    newMarkdown,
    start: destinationStart + relativeStart,
    transformation: "moved_with_text"
  });
}

function trimMoveBoundaryNewlines(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

function getEditNewStart(edit: MarkdownEdit, edits: MarkdownEdit[]): number {
  let delta = 0;

  for (const candidate of edits) {
    if (candidate === edit) {
      break;
    }

    delta += candidate.insertedText.length - (candidate.oldEnd - candidate.oldStart);
  }

  return edit.oldStart + delta;
}

function countOccurrences(text: string, searchText: string): number {
  if (searchText.length === 0) {
    return 0;
  }

  let count = 0;
  let index = text.indexOf(searchText);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(searchText, index + searchText.length);
  }

  return count;
}

function transformSelectedTextAnchorThroughSingleChangeSetEdit({
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
  const baseResult = transformSelectedTextAnchorThroughEdit({
    anchor,
    edit,
    newMarkdown,
    oldMarkdown
  });

  if (
    baseResult.outcome === "active" &&
    (baseResult.transformation === "edit_contains_anchor" ||
      baseResult.transformation === "complete_anchor_replaced")
  ) {
    const retainedSelection = findUniqueTextInInsertedEdit(
      edit,
      anchor.selected_text
    );

    if (retainedSelection !== null) {
      return createActiveTransformResult({
        end: edit.oldStart + retainedSelection + anchor.selected_text.length,
        newMarkdown,
        start: edit.oldStart + retainedSelection,
        transformation: baseResult.transformation
      });
    }
  }

  return baseResult;
}

function findUniqueTextInInsertedEdit(
  edit: MarkdownEdit,
  selectedText: string
): number | null {
  if (selectedText.length === 0) {
    return null;
  }

  const firstIndex = edit.insertedText.indexOf(selectedText);

  if (firstIndex === -1) {
    return null;
  }

  return edit.insertedText.indexOf(selectedText, firstIndex + selectedText.length) ===
    -1
    ? firstIndex
    : null;
}

function getPreservedBoundaryPrefixLength({
  anchorText,
  removedText
}: {
  anchorText: string;
  removedText: string;
}): number {
  const maxLength = Math.min(anchorText.length, removedText.length);

  for (let length = maxLength; length > 0; length -= 1) {
    if (removedText.endsWith(anchorText.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

function isBroadChangeSet(
  edits: MarkdownEdit[],
  oldMarkdown: string
): boolean {
  if (edits.length > MAX_SAFE_MANUAL_CHANGESET_EDITS) {
    return true;
  }

  const removedLength = edits.reduce(
    (total, edit) => total + (edit.oldEnd - edit.oldStart),
    0
  );

  return oldMarkdown.length > 0 && removedLength / oldMarkdown.length > 0.5;
}

function getRemovedTextForEdit(
  oldMarkdown: string,
  edit: MarkdownEdit
): string {
  return typeof edit.removedText === "string"
    ? edit.removedText
    : oldMarkdown.slice(edit.oldStart, edit.oldEnd);
}

function getRemovedTextFromEdit(edit: MarkdownEdit): string {
  return edit.removedText ?? "";
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

import {
  dedupeTextMatches,
  findExactTextMatches,
  findMarkdownPlainTextMatches,
  findNormalizedTextMatches,
  getMarkdownPlainText,
  normalizeMarkdownText,
  type TextRange
} from "../markdown/markdown-text.ts";
import {
  findMarkdownTables,
  isMarkdownTableDelimiterRow,
  isMarkdownTableRowLine,
  parseMarkdownTableRow
} from "../markdown/markdown-tables.ts";
import type { PatchmarkCommentAnchor } from "../project/project-types.ts";

type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;

export type RetainedSelectedTextMatch = TextRange & {
  selectedText: string;
};

type TableCellRange = {
  end: number;
  index: number;
  rawText: string;
  start: number;
  text: string;
};

type ComparableTableRow = {
  cellRanges: TableCellRange[];
  cells: string[];
  end: number;
  headerCells?: string[];
  rowIndex: number;
  start: number;
  tableIndex?: number;
  text: string;
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

export function findChangedTableCellInPatchReplacement({
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
  if (!anchor.selected_text.trim() || !replacementText.trim()) {
    return null;
  }

  const originalSelectionRange = getSelectionRangeInOriginalText({
    anchor,
    originalStart,
    originalText
  });

  if (!originalSelectionRange) {
    return null;
  }

  const originalRows = getComparableTableRows(originalText);
  const replacementRows = getComparableTableRows(replacementText);
  const originalRow = originalRows.find(
    (row) =>
      originalSelectionRange.start >= row.start &&
      originalSelectionRange.end <= row.end
  );

  if (!originalRow || replacementRows.length === 0) {
    return null;
  }

  const originalCell = originalRow.cellRanges.find(
    (cell) =>
      originalSelectionRange.start >= originalRow.start + cell.start &&
      originalSelectionRange.end <= originalRow.start + cell.end
  );

  if (!originalCell) {
    return null;
  }

  const destination = findReplacementRowForOriginalTableCell({
    originalCell,
    originalRow,
    replacementRows
  });

  if (!destination) {
    return null;
  }

  const replacementCell = destination.row.cellRanges[destination.columnIndex];

  if (!replacementCell || !replacementCell.rawText.trim()) {
    return null;
  }

  const selectedCellRange = getReplacementCellSelectionRange({
    anchor,
    originalCell,
    originalRow,
    originalSelectionRange,
    replacementCell
  });

  if (!selectedCellRange || selectedCellRange.end < selectedCellRange.start) {
    return null;
  }

  const absoluteStart =
    replacementStart +
    destination.row.start +
    replacementCell.start +
    selectedCellRange.start;
  const absoluteEnd =
    replacementStart +
    destination.row.start +
    replacementCell.start +
    selectedCellRange.end;

  return {
    end: absoluteEnd,
    selectedText: replacementCell.rawText.slice(
      selectedCellRange.start,
      selectedCellRange.end
    ),
    start: absoluteStart
  };
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

function getSelectionRangeInOriginalText({
  anchor,
  originalStart,
  originalText
}: {
  anchor: SelectedTextAnchor;
  originalStart?: number;
  originalText: string;
}): TextRange | null {
  if (
    typeof originalStart === "number" &&
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    const start = anchor.markdown_start_offset - originalStart;
    const end = anchor.markdown_end_offset - originalStart;

    if (start >= 0 && end >= start && end <= originalText.length) {
      return { end, start };
    }
  }

  const matches = findOriginalSelectionMatches({ anchor, originalText });

  return matches.length === 1 ? matches[0] : null;
}

function getComparableTableRows(markdown: string): ComparableTableRow[] {
  const rows: ComparableTableRow[] = [];
  const coveredRanges: TextRange[] = [];

  findMarkdownTables(markdown).forEach((table, tableIndex) => {
    coveredRanges.push({ end: table.end, start: table.start });

    table.bodyRows.forEach((row, rowIndex) => {
      const cellRanges = parseMarkdownTableRowCellRanges(row.text);

      if (cellRanges.length !== row.cells.length) {
        return;
      }

      rows.push({
        cellRanges,
        cells: row.cells,
        end: row.end,
        headerCells: table.headerRow.cells,
        rowIndex,
        start: row.start,
        tableIndex,
        text: row.text
      });
    });
  });

  getMarkdownLines(markdown).forEach((line) => {
    if (
      isInsideAnyRange(line, coveredRanges) ||
      !isMarkdownTableRowLine(line.text) ||
      isMarkdownTableDelimiterRow(line.text)
    ) {
      return;
    }

    const cells = parseMarkdownTableRow(line.text);
    const cellRanges = parseMarkdownTableRowCellRanges(line.text);

    if (cellRanges.length !== cells.length) {
      return;
    }

    rows.push({
      cellRanges,
      cells,
      end: line.end,
      rowIndex: rows.length,
      start: line.start,
      text: line.text
    });
  });

  return rows.sort((firstRow, secondRow) => firstRow.start - secondRow.start);
}

function findReplacementRowForOriginalTableCell({
  originalCell,
  originalRow,
  replacementRows
}: {
  originalCell: TableCellRange;
  originalRow: ComparableTableRow;
  replacementRows: ComparableTableRow[];
}): { columnIndex: number; row: ComparableTableRow } | null {
  const candidates = replacementRows.flatMap((replacementRow) => {
    const columnIndex = getMappedColumnIndex({
      originalColumnIndex: originalCell.index,
      originalRow,
      replacementRow
    });

    if (
      typeof columnIndex !== "number" ||
      columnIndex < 0 ||
      columnIndex >= replacementRow.cells.length
    ) {
      return [];
    }

    const score = getReplacementRowIdentityScore({
      originalSelectedColumnIndex: originalCell.index,
      originalRow,
      replacementRow
    });

    return score > 0 ? [{ columnIndex, row: replacementRow, score }] : [];
  });

  if (candidates.length === 0) {
    return null;
  }

  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const bestCandidates = candidates.filter(
    (candidate) => candidate.score === bestScore
  );

  return bestCandidates.length === 1
    ? {
        columnIndex: bestCandidates[0].columnIndex,
        row: bestCandidates[0].row
      }
    : null;
}

function getReplacementRowIdentityScore({
  originalSelectedColumnIndex,
  originalRow,
  replacementRow
}: {
  originalSelectedColumnIndex: number;
  originalRow: ComparableTableRow;
  replacementRow: ComparableTableRow;
}): number {
  let score = 0;

  originalRow.cells.forEach((originalCellText, originalColumnIndex) => {
    if (originalColumnIndex === originalSelectedColumnIndex) {
      return;
    }

    const replacementColumnIndex = getMappedColumnIndex({
      originalColumnIndex,
      originalRow,
      replacementRow
    });

    if (typeof replacementColumnIndex !== "number") {
      return;
    }

    const replacementCellText = replacementRow.cells[replacementColumnIndex];

    if (
      normalizeTableCellForIdentity(originalCellText) &&
      normalizeTableCellForIdentity(originalCellText) ===
        normalizeTableCellForIdentity(replacementCellText ?? "")
    ) {
      score += getColumnIdentityWeight({ originalColumnIndex, originalRow });
    }
  });

  return score;
}

function getMappedColumnIndex({
  originalColumnIndex,
  originalRow,
  replacementRow
}: {
  originalColumnIndex: number;
  originalRow: ComparableTableRow;
  replacementRow: ComparableTableRow;
}): number | null {
  const originalHeader = originalRow.headerCells?.[originalColumnIndex];

  if (originalHeader && replacementRow.headerCells) {
    const normalizedHeader = normalizeTableCellForIdentity(originalHeader);
    const matches = replacementRow.headerCells
      .map((header, index) => ({
        index,
        normalized: normalizeTableCellForIdentity(header)
      }))
      .filter((header) => header.normalized === normalizedHeader);

    return matches.length === 1 ? matches[0].index : null;
  }

  return originalColumnIndex < replacementRow.cells.length
    ? originalColumnIndex
    : null;
}

function getColumnIdentityWeight({
  originalColumnIndex,
  originalRow
}: {
  originalColumnIndex: number;
  originalRow: ComparableTableRow;
}): number {
  const headerText = normalizeTableCellForIdentity(
    originalRow.headerCells?.[originalColumnIndex] ?? ""
  );

  return originalColumnIndex === 0 || /^(product|brand|area|gate)$/.test(headerText)
    ? 4
    : 1;
}

function getReplacementCellSelectionRange({
  anchor,
  originalCell,
  originalRow,
  originalSelectionRange,
  replacementCell
}: {
  anchor: SelectedTextAnchor;
  originalCell: TableCellRange;
  originalRow: ComparableTableRow;
  originalSelectionRange: TextRange;
  replacementCell: TableCellRange;
}): TextRange | null {
  const selectionStartInCell =
    originalSelectionRange.start - originalRow.start - originalCell.start;
  const selectionEndInCell =
    originalSelectionRange.end - originalRow.start - originalCell.start;

  if (
    selectionStartInCell < 0 ||
    selectionEndInCell < selectionStartInCell ||
    selectionEndInCell > originalCell.rawText.length
  ) {
    return null;
  }

  if (isCompleteCellSelection({ anchor, originalCell })) {
    return {
      end: replacementCell.rawText.length,
      start: 0
    };
  }

  const retainedMatches = findExactTextMatches(
    replacementCell.rawText,
    anchor.selected_text
  );

  if (retainedMatches.length === 1) {
    return retainedMatches[0];
  }

  return mapPartialSelectionWithCellContext({
    originalCell,
    replacementCell,
    selectionEndInCell,
    selectionStartInCell
  });
}

function mapPartialSelectionWithCellContext({
  originalCell,
  replacementCell,
  selectionEndInCell,
  selectionStartInCell
}: {
  originalCell: TableCellRange;
  replacementCell: TableCellRange;
  selectionEndInCell: number;
  selectionStartInCell: number;
}): TextRange | null {
  const prefix = originalCell.rawText.slice(0, selectionStartInCell);
  const suffix = originalCell.rawText.slice(selectionEndInCell);
  const prefixMatch = findUniqueBoundaryMatch(replacementCell.rawText, prefix);
  const suffixMatch = findUniqueBoundaryMatch(replacementCell.rawText, suffix);

  if (prefix.trim() && !prefixMatch) {
    return null;
  }

  if (suffix.trim() && !suffixMatch) {
    return null;
  }

  const start = prefix.trim() ? prefixMatch?.end : 0;
  const end = suffix.trim() ? suffixMatch?.start : replacementCell.rawText.length;

  if (typeof start !== "number" || typeof end !== "number" || end < start) {
    return null;
  }

  if (start === 0 && end === replacementCell.rawText.length) {
    return null;
  }

  return { end, start };
}

function findUniqueBoundaryMatch(text: string, boundary: string): TextRange | null {
  if (!boundary.trim()) {
    return null;
  }

  const matches = findExactTextMatches(text, boundary);

  return matches.length === 1 ? matches[0] : null;
}

function isCompleteCellSelection({
  anchor,
  originalCell
}: {
  anchor: SelectedTextAnchor;
  originalCell: TableCellRange;
}): boolean {
  const normalizedSelectedText = normalizeMarkdownText(anchor.selected_text);
  const normalizedCellMarkdown = normalizeMarkdownText(originalCell.rawText);
  const normalizedCellPlainText = normalizeMarkdownText(
    getMarkdownPlainText(originalCell.rawText)
  );

  return (
    normalizedSelectedText.length > 0 &&
    (normalizedSelectedText === normalizedCellMarkdown ||
      normalizedSelectedText === normalizedCellPlainText)
  );
}

function normalizeTableCellForIdentity(text: string): string {
  return normalizeMarkdownText(getMarkdownPlainText(text) || text);
}

function parseMarkdownTableRowCellRanges(line: string): TableCellRange[] {
  const parsedCells = parseMarkdownTableRow(line);
  const ranges = splitMarkdownTableCellRanges(line);

  if (parsedCells.length !== ranges.length) {
    return [];
  }

  return ranges.map((range, index) => ({
    end: range.end,
    index,
    rawText: line.slice(range.start, range.end),
    start: range.start,
    text: parsedCells[index] ?? ""
  }));
}

function splitMarkdownTableCellRanges(line: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cellStart = 0;
  let inCode = false;
  let linkDestinationDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const nextCharacter = line[index + 1] ?? "";
    const previousCharacter = line[index - 1] ?? "";

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
      ranges.push(trimCellRange(line, { end: index, start: cellStart }));
      cellStart = index + 1;
    }
  }

  ranges.push(trimCellRange(line, { end: line.length, start: cellStart }));

  if (ranges[0] && line.slice(ranges[0].start, ranges[0].end).trim() === "") {
    ranges.shift();
  }

  if (
    ranges[ranges.length - 1] &&
    line.slice(ranges[ranges.length - 1].start, ranges[ranges.length - 1].end).trim() === ""
  ) {
    ranges.pop();
  }

  return ranges;
}

function trimCellRange(line: string, range: TextRange): TextRange {
  let start = range.start;
  let end = range.end;

  while (start < end && /\s/.test(line[start] ?? "")) {
    start += 1;
  }

  while (end > start && /\s/.test(line[end - 1] ?? "")) {
    end -= 1;
  }

  return { end, start };
}

function getMarkdownLines(markdown: string): Array<TextRange & { text: string }> {
  const lines = markdown.split("\n");
  const result: Array<TextRange & { text: string }> = [];
  let start = 0;

  lines.forEach((line) => {
    const end = start + line.length;

    result.push({
      end,
      start,
      text: line.replace(/\r$/, "")
    });
    start = end + 1;
  });

  return result;
}

function isInsideAnyRange(range: TextRange, ranges: TextRange[]): boolean {
  return ranges.some(
    (candidate) => range.start >= candidate.start && range.end <= candidate.end
  );
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

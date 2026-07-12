import type { PatchmarkPatch } from "../project/project-types.ts";

export type AppliedPatchReviewAnchorStatus =
  | "empty_applied_text"
  | "evolved_after_patch"
  | "exact_match"
  | "multiple_matches"
  | "normalized_match"
  | "not_found"
  | "row_match"
  | "section_match";

export type AppliedPatchReviewAnchorInput = {
  status: AppliedPatchReviewAnchorStatus;
  text: string;
};

export type AppliedPatchReviewMatchCardinality = "multiple" | "none" | "unique";

export type AppliedPatchReviewMatchMethod =
  | "descendant"
  | "exact"
  | "none"
  | "normalized"
  | "section_context"
  | "table_structural";

export type PatchReviewTextMatch = {
  end: number;
  start: number;
};

export type AppliedPatchOriginalSource =
  | "persisted_original_text"
  | "pre_apply_snapshot"
  | "unavailable";

export type AppliedPatchCurrentState =
  | "ambiguous"
  | "empty"
  | "evolved"
  | "not_found"
  | "unchanged";

export type AppliedPatchReviewContent = {
  appliedMarkdown: string;
  currentMarkdown?: string;
  currentState: AppliedPatchCurrentState;
  originalMarkdown: string;
  originalSource: AppliedPatchOriginalSource;
  statusMessage: string;
};

export type PatchReviewSnippetPreview = {
  isMalformedTableFragment: boolean;
  markdown: string;
  usesGenericTableContext: boolean;
  usesTableContext: boolean;
};

const unavailableOriginalText =
  "Original text unavailable for this historical patch.";

export function createAppliedPatchReviewContent({
  anchorStatus,
  patch,
  preApplySnapshotMarkdown
}: {
  anchorStatus: AppliedPatchReviewAnchorInput;
  patch: PatchmarkPatch;
  preApplySnapshotMarkdown?: string | null;
}): AppliedPatchReviewContent {
  const original = getAppliedPatchOriginalBeforePatch({
    patch,
    preApplySnapshotMarkdown
  });
  const appliedMarkdown = getPatchAppliedMarkdown(patch);
  const currentState = getAppliedPatchCurrentState(anchorStatus);
  const currentMarkdown =
    currentState === "evolved" &&
    anchorStatus.text.trim().length > 0 &&
    anchorStatus.text !== appliedMarkdown
      ? anchorStatus.text
      : undefined;

  return {
    appliedMarkdown,
    currentMarkdown,
    currentState,
    originalMarkdown: original.markdown,
    originalSource: original.source,
    statusMessage: getAppliedPatchStatusMessage(currentState)
  };
}

export function createPatchReviewSnippetPreview({
  contextMarkdown,
  pairedMarkdown,
  patch,
  snippetMarkdown
}: {
  contextMarkdown: string;
  pairedMarkdown?: string;
  patch: Pick<PatchmarkPatch, "target_heading">;
  snippetMarkdown: string;
}): PatchReviewSnippetPreview {
  if (isMalformedMarkdownTableFragment(snippetMarkdown)) {
    return {
      isMalformedTableFragment: true,
      markdown: snippetMarkdown,
      usesGenericTableContext: false,
      usesTableContext: false
    };
  }

  if (!isMarkdownTableDataSnippet(snippetMarkdown)) {
    return {
      isMalformedTableFragment: false,
      markdown: snippetMarkdown,
      usesGenericTableContext: false,
      usesTableContext: false
    };
  }

  const exactContext = getTableContextForSnippet(contextMarkdown, snippetMarkdown);
  const cellCount = Math.max(
    getMarkdownTableDataSnippetCellCount(snippetMarkdown),
    pairedMarkdown && isMarkdownTableDataSnippet(pairedMarkdown)
      ? getMarkdownTableDataSnippetCellCount(pairedMarkdown)
      : 0
  );
  const compatibleContext =
    exactContext ?? getCompatibleTableContext(contextMarkdown, patch, cellCount);
  const genericContext = createGenericTableContext(cellCount);
  const headerRow = compatibleContext?.headerRow ?? genericContext.headerRow;
  const separatorRow =
    compatibleContext?.separatorRow ?? genericContext.separatorRow;

  return {
    isMalformedTableFragment: false,
    markdown: [headerRow, separatorRow, snippetMarkdown.trim()].join("\n"),
    usesGenericTableContext: !compatibleContext,
    usesTableContext: true
  };
}

export function dedupePatchReviewTextMatches(
  matches: PatchReviewTextMatch[]
): PatchReviewTextMatch[] {
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

export function getPatchReviewMatchCardinality(
  matches: PatchReviewTextMatch[]
): AppliedPatchReviewMatchCardinality {
  const distinctMatches = dedupePatchReviewTextMatches(matches);

  if (distinctMatches.length === 0) {
    return "none";
  }

  return distinctMatches.length === 1 ? "unique" : "multiple";
}

export function getPatchReviewMatchMethodLabel(
  method: AppliedPatchReviewMatchMethod
): string {
  if (method === "exact") {
    return "Exact";
  }

  if (method === "normalized") {
    return "Normalized";
  }

  if (method === "table_structural") {
    return "Table structural";
  }

  if (method === "section_context") {
    return "Section context";
  }

  if (method === "descendant") {
    return "Descendant";
  }

  return "None";
}

export function getPatchReviewMatchingLocationsLabel({
  cardinality,
  count
}: {
  cardinality: AppliedPatchReviewMatchCardinality;
  count: number;
}): string {
  if (cardinality === "none") {
    return "0";
  }

  if (cardinality === "unique") {
    return "1";
  }

  return String(Math.max(2, count));
}

export function isMalformedMarkdownTableFragment(markdown: string): boolean {
  const lines = markdown
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0 || !lines.some((line) => line.includes("|"))) {
    return false;
  }

  return lines.some(hasAdjacentTableRowDelimiter);
}

export function recoverOriginalTextFromPreApplySnapshot({
  patch,
  snapshotMarkdown
}: {
  patch: PatchmarkPatch;
  snapshotMarkdown: string;
}): string | null {
  const before = patch.applied_context_before ?? "";
  const after = patch.applied_context_after ?? "";

  if (before.trim().length < 8 || after.trim().length < 8) {
    return null;
  }

  const candidates: string[] = [];
  let beforeIndex = snapshotMarkdown.indexOf(before);

  while (beforeIndex !== -1) {
    const candidateStart = beforeIndex + before.length;
    const afterIndex = snapshotMarkdown.indexOf(after, candidateStart);

    if (afterIndex !== -1 && afterIndex >= candidateStart) {
      candidates.push(snapshotMarkdown.slice(candidateStart, afterIndex));
    }

    beforeIndex = snapshotMarkdown.indexOf(before, beforeIndex + before.length);
  }

  const uniqueCandidates = [...new Set(candidates)];

  return uniqueCandidates.length === 1 ? uniqueCandidates[0] ?? null : null;
}

function getAppliedPatchOriginalBeforePatch({
  patch,
  preApplySnapshotMarkdown
}: {
  patch: PatchmarkPatch;
  preApplySnapshotMarkdown?: string | null;
}): { markdown: string; source: AppliedPatchOriginalSource } {
  if (patch.original_text.length > 0) {
    return {
      markdown: patch.original_text,
      source: "persisted_original_text"
    };
  }

  if (preApplySnapshotMarkdown) {
    const recoveredOriginal = recoverOriginalTextFromPreApplySnapshot({
      patch,
      snapshotMarkdown: preApplySnapshotMarkdown
    });

    if (recoveredOriginal !== null) {
      return {
        markdown: recoveredOriginal,
        source: "pre_apply_snapshot"
      };
    }
  }

  return {
    markdown: unavailableOriginalText,
    source: "unavailable"
  };
}

function getPatchAppliedMarkdown(patch: PatchmarkPatch): string {
  return patch.applied_text ?? patch.suggested_text;
}

function getAppliedPatchCurrentState(
  anchorStatus: AppliedPatchReviewAnchorInput
): AppliedPatchCurrentState {
  if (anchorStatus.status === "empty_applied_text") {
    return "empty";
  }

  if (
    anchorStatus.status === "exact_match" ||
    anchorStatus.status === "normalized_match"
  ) {
    return "unchanged";
  }

  if (
    anchorStatus.status === "evolved_after_patch" ||
    anchorStatus.status === "row_match" ||
    anchorStatus.status === "section_match"
  ) {
    return "evolved";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "ambiguous";
  }

  return "not_found";
}

function getAppliedPatchStatusMessage(
  currentState: AppliedPatchCurrentState
): string {
  if (currentState === "unchanged") {
    return "Patch was applied. The applied replacement is still present in the current document.";
  }

  if (currentState === "evolved") {
    return "Patch was applied. This region was changed again later.";
  }

  if (currentState === "ambiguous") {
    return "Patch was applied, but Patchmark cannot identify one unique current location for the applied text.";
  }

  if (currentState === "empty") {
    return "Patch was applied with an empty replacement, so there is no applied text to locate.";
  }

  return "Patch was applied, but Patchmark cannot currently locate the applied text.";
}

function getTableContextForSnippet(
  markdown: string,
  snippetMarkdown: string
): { headerRow: string; separatorRow: string } | null {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const normalizedSnippet = snippetMarkdown.replace(/\r\n/g, "\n");
  const snippetStart = normalizedMarkdown.indexOf(normalizedSnippet);

  if (snippetStart === -1) {
    return null;
  }

  const lines = normalizedMarkdown.split("\n");
  const lineStarts = getLineStartOffsets(normalizedMarkdown);
  const snippetLineIndex = getLineIndexForOffset(lineStarts, snippetStart);

  for (let index = snippetLineIndex - 1; index >= 1; index -= 1) {
    const candidateLine = lines[index] ?? "";

    if (isMarkdownTableSeparatorRow(candidateLine)) {
      const headerRow = lines[index - 1] ?? "";
      if (isMarkdownTableRowLine(headerRow)) {
        return {
          headerRow,
          separatorRow: candidateLine
        };
      }
    }

    if (
      !isMarkdownTableRowLine(candidateLine) &&
      !isMarkdownTableSeparatorRow(candidateLine)
    ) {
      break;
    }
  }

  return null;
}

function getCompatibleTableContext(
  markdown: string,
  patch: Pick<PatchmarkPatch, "target_heading">,
  cellCount: number
): { headerRow: string; separatorRow: string } | null {
  const tables = findMarkdownTablesInRange(
    markdown,
    getPatchTargetHeadingRange(markdown, patch.target_heading)
  );

  return (
    tables.find(
      (table) => parseMarkdownTableRow(table.headerRow).length === cellCount
    ) ?? null
  );
}

function getPatchTargetHeadingRange(
  markdown: string,
  targetHeading?: string
): { end: number; start: number } {
  if (!targetHeading) {
    return {
      end: markdown.length,
      start: 0
    };
  }

  const lines = markdown.split("\n");
  const lineStarts = getLineStartOffsets(markdown);
  const headingIndex = lines.findIndex(
    (line) => line.replace(/^#+\s+/, "").trim() === targetHeading.trim()
  );

  if (headingIndex === -1) {
    return {
      end: markdown.length,
      start: 0
    };
  }

  const headingLevel = /^#+/.exec(lines[headingIndex] ?? "")?.[0].length ?? 1;
  let endLine = lines.length;

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = /^(#+)\s+/.exec(lines[index] ?? "");
    if (match && match[1].length <= headingLevel) {
      endLine = index;
      break;
    }
  }

  return {
    end: endLine < lineStarts.length ? lineStarts[endLine] ?? markdown.length : markdown.length,
    start: lineStarts[headingIndex] ?? 0
  };
}

function findMarkdownTablesInRange(
  markdown: string,
  range: { end: number; start: number }
): Array<{ headerRow: string; separatorRow: string }> {
  const rangeMarkdown = markdown.slice(range.start, range.end);
  const lines = rangeMarkdown.split("\n");
  const tables: Array<{ headerRow: string; separatorRow: string }> = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerRow = lines[index] ?? "";
    const separatorRow = lines[index + 1] ?? "";

    if (
      isMarkdownTableRowLine(headerRow) &&
      isMarkdownTableSeparatorRow(separatorRow)
    ) {
      tables.push({
        headerRow,
        separatorRow
      });
    }
  }

  return tables;
}

function createGenericTableContext(cellCount: number): {
  headerRow: string;
  separatorRow: string;
} {
  const safeCellCount = Math.max(2, cellCount);
  const headers = Array.from(
    { length: safeCellCount },
    (_, index) => `Column ${index + 1}`
  );
  const separatorCells = headers.map(() => "---");

  return {
    headerRow: `| ${headers.join(" | ")} |`,
    separatorRow: `| ${separatorCells.join(" | ")} |`
  };
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
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

function isMarkdownTableDataSnippet(markdown: string): boolean {
  return getMarkdownTableDataRows(markdown).length > 0;
}

function getMarkdownTableDataRows(markdown: string): string[] {
  const lines = markdown
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cellCounts = lines.map((line) => parseMarkdownTableRow(line).length);
  const expectedCellCount = cellCounts[0] ?? 0;

  if (
    lines.length === 0 ||
    expectedCellCount < 2 ||
    lines.some(hasAdjacentTableRowDelimiter)
  ) {
    return [];
  }

  return lines.every(
    (line, index) =>
      isMarkdownTableRowLine(line) &&
      !isMarkdownTableSeparatorRow(line) &&
      cellCounts[index] === expectedCellCount
  )
    ? lines
    : [];
}

function getMarkdownTableDataSnippetCellCount(markdown: string): number {
  const rows = getMarkdownTableDataRows(markdown);

  return rows.reduce(
    (largestCellCount, row) =>
      Math.max(largestCellCount, parseMarkdownTableRow(row).length),
    0
  );
}

function hasAdjacentTableRowDelimiter(line: string): boolean {
  const withoutOuterDelimiters = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "");

  return /\|\s*\|/.test(withoutOuterDelimiters);
}

function isMarkdownTableRowLine(line: string): boolean {
  const cells = parseMarkdownTableRow(line);

  return cells.length >= 2 && line.includes("|");
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = parseMarkdownTableRow(line);

  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function parseMarkdownTableRow(line: string): string[] {
  let trimmedLine = line.trim();

  if (trimmedLine.startsWith("|")) {
    trimmedLine = trimmedLine.slice(1);
  }

  if (trimmedLine.endsWith("|")) {
    trimmedLine = trimmedLine.slice(0, -1);
  }

  const cells: string[] = [];
  let currentCell = "";

  for (let index = 0; index < trimmedLine.length; index += 1) {
    const character = trimmedLine[index] ?? "";
    const previousCharacter = trimmedLine[index - 1] ?? "";

    if (character === "|" && previousCharacter !== "\\") {
      cells.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    currentCell += character;
  }

  cells.push(currentCell.trim());

  return cells.map((cell) => cell.replace(/\\\|/g, "|"));
}

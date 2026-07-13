import {
  findMarkdownTables,
  parseMarkdownTableRow,
  type MarkdownTableRow
} from "../markdown/markdown-tables.ts";
import { normalizeMarkdownText, type TextRange } from "../markdown/markdown-text.ts";
import { parseMarkdownHeadings, type MarkdownHeading } from "../markdown/parse-headings.ts";
import type { PatchmarkPatch } from "../project/project-types.ts";

export type CurrentPatchOriginalTableRowMatch = TextRange & {
  text: string;
};

export function findUniqueCurrentTableRowForPatchOriginal({
  markdown,
  patch
}: {
  markdown: string;
  patch: PatchmarkPatch;
}): CurrentPatchOriginalTableRowMatch | null {
  const originalCells = getSingleTableRowCells(patch.original_text).map(
    normalizeTableCellForPatchAnchor
  );

  if (originalCells.length < 2) {
    return null;
  }

  const searchRange = getPatchSectionRange(markdown, patch) ?? {
    start: 0,
    end: markdown.length
  };
  const matches = findMarkdownTables(markdown, searchRange)
    .flatMap((table) => table.bodyRows)
    .filter((row) => rowMatchesOriginalCells(row, originalCells))
    .map((row) => ({
      start: row.start,
      end: row.end,
      text: row.text
    }));
  const uniqueMatches = dedupeTableRowMatches(matches);

  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

function rowMatchesOriginalCells(
  row: MarkdownTableRow,
  originalCells: string[]
): boolean {
  const currentCells = row.cells.map(normalizeTableCellForPatchAnchor);

  return (
    currentCells.length >= originalCells.length &&
    originalCells.every((cell, index) => currentCells[index] === cell)
  );
}

function getSingleTableRowCells(markdown: string): string[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1 || !lines[0]?.includes("|")) {
    return [];
  }

  return parseMarkdownTableRow(lines[0]);
}

function normalizeTableCellForPatchAnchor(cell: string): string {
  return normalizeMarkdownText(cell);
}

function getPatchSectionRange(
  markdown: string,
  patch: PatchmarkPatch
): TextRange | null {
  const targetHeading = patch.applied_heading ?? patch.target_heading;

  if (!targetHeading) {
    return null;
  }

  const normalizedTargetHeading = normalizePatchTargetHeading(targetHeading);

  if (!normalizedTargetHeading) {
    return null;
  }

  const headings = parseMarkdownHeadings(markdown);
  const heading = headings.find(
    (candidate) =>
      normalizePatchTargetHeading(candidate.text) === normalizedTargetHeading
  );

  return heading ? getSectionRange(markdown, headings, heading) : null;
}

function normalizePatchTargetHeading(heading: string): string {
  return heading
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ");
}

function getSectionRange(
  markdown: string,
  headings: MarkdownHeading[],
  targetHeading: MarkdownHeading
): TextRange {
  const lineOffsets = getLineStartOffsets(markdown);
  const headingIndex = headings.findIndex(
    (heading) => heading.line === targetHeading.line
  );
  const nextPeerHeading = headings
    .slice(headingIndex + 1)
    .find((heading) => heading.level <= targetHeading.level);

  return {
    start: lineOffsets[targetHeading.line - 1] ?? 0,
    end: nextPeerHeading
      ? lineOffsets[nextPeerHeading.line - 1] ?? markdown.length
      : markdown.length
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

function dedupeTableRowMatches(
  matches: CurrentPatchOriginalTableRowMatch[]
): CurrentPatchOriginalTableRowMatch[] {
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

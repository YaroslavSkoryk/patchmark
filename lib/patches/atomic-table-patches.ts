import {
  findMarkdownTableContainingRange,
  findMarkdownTables,
  findMarkdownTablesOverlappingRange,
  getMarkdownTableRowLikeLines,
  isMarkdownTableDelimiterRow,
  parseMarkdownTableRow,
  type MarkdownTable,
  type TextRange
} from "../markdown/markdown-tables.ts";
import type {
  PatchmarkCommentAnchor,
  PatchmarkCommentReplyImport
} from "../project/project-types.ts";

export const ATOMIC_TABLE_IMPORT_ERROR =
  "ChatGPT split one structural table change into multiple patches. Export the comment again to receive one complete-table patch.";

export const CHATGPT_ATOMIC_TABLE_PROMPT_RULES = `## Atomic table changes

Complete-table patch required:

Use one complete-table patch when a change adds or removes a column, reorders columns, splits one column into multiple columns, merges multiple columns, moves existing values between columns, converts the table into another structure, converts another structure into a table, sorts or substantially reorganizes the complete table, reformats or normalizes the entire table, or otherwise changes the expected number or meaning of cells across multiple rows.

For these operations:

- Copy the complete table exactly into \`original_text\`.
- Return the complete resulting table in \`suggested_text\`.
- Include the header, delimiter/alignment row, and every body row.
- Return exactly one \`patch_proposal\` for that table.
- Never split the structural change into separate header, delimiter, or body-row proposals.
- Do not omit unchanged rows from either field.
- Do not use placeholders, ellipses, abbreviated rows, or text such as "remaining rows unchanged."
- Do not reconstruct content that was not supplied in the exported context.
- If the complete table is unavailable or truncated, ask a clarification question instead of proposing a partial structural patch.

Smaller patches remain appropriate for safe non-structural edits: editing text inside one existing cell without changing the row's cell count, renaming a header without changing column count or meaning, changing alignment markers while preserving column count, adding or removing a single body row, adding a totals row, or editing several independent cells where partial application cannot make the table malformed.

Self-check before returning a structural table patch:

- The complete original table was copied exactly.
- Suggested header, delimiter, and body rows have the same column count.
- No original rows were lost.
- No rows were duplicated.
- Existing inline Markdown links were preserved.
- Escaped pipes and inline code were preserved.
- Column order matches the requested result.
- Only one proposal targets that table's structural change.

Bad:

- Patch 1 adds a header cell.
- Patch 2 adds a cell to row 1.
- Patch 3 adds a cell to row 2.

Good:

- One patch replaces the complete original table with the complete four-column table.

Canonical table context markers:

- A marker such as \`[[PATCHMARK_TABLE:PM-TABLE-0001]]\` is a context reference, not document Markdown.
- The exact document Markdown represented by the marker is stored in the matching canonical \`table_contexts\` object.
- Never copy a Patchmark table marker into \`original_text\` or \`suggested_text\`.
- For a structural change, use the canonical table's exact \`markdown\` as \`original_text\`.
- Return the complete resulting table as \`suggested_text\`.
- Preserve surrounding section content independently.
- A marker does not mean the table was removed from the document.`;

type PatchProposalInput = PatchmarkCommentReplyImport["patch_proposals"][number];

type PatchProposalAnalysis = {
  matchKey: string;
  proposalIndex: number;
  structural: boolean;
};

export type CompleteTableOccurrence = {
  end: number;
  markdown: string;
  start: number;
};

export type CanonicalTableContext = CompleteTableOccurrence & {
  containing_heading?: string;
  containing_heading_path?: string[];
  table_id: string;
};

export const PATCHMARK_TABLE_MARKER_PREFIX = "[[PATCHMARK_TABLE:";
export const PATCHMARK_COMPLETE_TABLE_MARKER_PREFIX =
  "[[PATCHMARK_COMPLETE_TABLE:";

export function createPatchmarkTableMarker(tableId: string): string {
  return `${PATCHMARK_TABLE_MARKER_PREFIX}${tableId}]]`;
}

export function getCompleteTableOccurrencesForExport({
  anchor,
  includeSectionTables = false,
  markdown,
  sectionRange
}: {
  anchor: PatchmarkCommentAnchor;
  includeSectionTables?: boolean;
  markdown: string;
  sectionRange?: TextRange | null;
}): CompleteTableOccurrence[] {
  if (anchor.kind === "document") {
    return includeSectionTables
      ? findMarkdownTables(markdown).map(toCompleteTableOccurrence)
      : [];
  }

  const tables: MarkdownTable[] = [];
  const selectedRanges = getAnchorSelectedTableSearchRanges(anchor);

  for (const range of selectedRanges) {
    const table = findMarkdownTableContainingRange(markdown, range);
    if (table) {
      tables.push(table);
    }
  }

  if (includeSectionTables && sectionRange) {
    tables.push(...findMarkdownTables(markdown, sectionRange));
  }

  return dedupeTables(tables)
    .sort((first, second) => first.start - second.start)
    .map(toCompleteTableOccurrence);
}

export function getCompleteTableMarkdownsForExport({
  anchor,
  includeSectionTables = false,
  markdown,
  sectionRange
}: {
  anchor: PatchmarkCommentAnchor;
  includeSectionTables?: boolean;
  markdown: string;
  sectionRange?: TextRange | null;
}): string[] {
  return getCompleteTableOccurrencesForExport({
    anchor,
    includeSectionTables,
    markdown,
    sectionRange
  }).map((table) => table.markdown);
}

export function createCanonicalTableContextsFromOccurrences({
  getMetadata,
  occurrences
}: {
  getMetadata?: (
    occurrence: CompleteTableOccurrence
  ) => Pick<CanonicalTableContext, "containing_heading" | "containing_heading_path">;
  occurrences: CompleteTableOccurrence[];
}): CanonicalTableContext[] {
  const contextsByRange = new Map<string, CompleteTableOccurrence>();

  occurrences.forEach((occurrence) => {
    const key = `${occurrence.start}:${occurrence.end}`;

    if (!contextsByRange.has(key)) {
      contextsByRange.set(key, occurrence);
    }
  });

  return Array.from(contextsByRange.values())
    .sort((first, second) => first.start - second.start)
    .map((occurrence, index) => ({
      ...occurrence,
      ...(getMetadata?.(occurrence) ?? {}),
      table_id: `PM-TABLE-${String(index + 1).padStart(4, "0")}`
    }));
}

export function replaceCompleteTableOccurrencesWithMarkers({
  markdown,
  rangeStart = 0,
  tableContexts
}: {
  markdown: string;
  rangeStart?: number;
  tableContexts: CanonicalTableContext[];
}): string {
  const relevantTables = tableContexts
    .filter(
      (tableContext) =>
        tableContext.start >= rangeStart &&
        tableContext.end <= rangeStart + markdown.length
    )
    .sort((first, second) => second.start - first.start);
  let nextMarkdown = markdown;

  for (const tableContext of relevantTables) {
    const localStart = tableContext.start - rangeStart;
    const localEnd = tableContext.end - rangeStart;

    if (nextMarkdown.slice(localStart, localEnd) !== tableContext.markdown) {
      continue;
    }

    nextMarkdown = `${nextMarkdown.slice(0, localStart)}${createPatchmarkTableMarker(
      tableContext.table_id
    )}${nextMarkdown.slice(localEnd)}`;
  }

  return nextMarkdown;
}

export function containsReservedPatchmarkTableMarker(text: string): boolean {
  return (
    text.includes(PATCHMARK_TABLE_MARKER_PREFIX) ||
    text.includes(PATCHMARK_COMPLETE_TABLE_MARKER_PREFIX)
  );
}

export function validateAtomicTablePatchImport({
  markdown,
  patchProposals
}: {
  markdown: string;
  patchProposals: PatchProposalInput[];
}): void {
  const structuralProposalIndexesByTable = new Map<string, Set<number>>();

  patchProposals.forEach((proposal, proposalIndex) => {
    const analyses = analyzePatchProposalAgainstCurrentTables({
      markdown,
      proposal,
      proposalIndex
    });

    for (const analysis of analyses) {
      if (!analysis.structural) {
        continue;
      }

      const proposalIndexes =
        structuralProposalIndexesByTable.get(analysis.matchKey) ?? new Set();
      proposalIndexes.add(proposalIndex);
      structuralProposalIndexesByTable.set(analysis.matchKey, proposalIndexes);
    }
  });

  for (const proposalIndexes of structuralProposalIndexesByTable.values()) {
    if (proposalIndexes.size > 1) {
      throw new Error(ATOMIC_TABLE_IMPORT_ERROR);
    }
  }
}

function analyzePatchProposalAgainstCurrentTables({
  markdown,
  proposal,
  proposalIndex
}: {
  markdown: string;
  proposal: PatchProposalInput;
  proposalIndex: number;
}): PatchProposalAnalysis[] {
  const matches = findExactTextMatches(markdown, proposal.original_text);
  const analyses: PatchProposalAnalysis[] = [];

  matches.forEach((match) => {
    const tables = findMarkdownTablesOverlappingRange(markdown, match);

    tables.forEach((table) => {
      const touchesWholeTable = match.start <= table.start && match.end >= table.end;
      const structural = touchesWholeTable
        ? validateWholeTablePatchProposal({
            match,
            proposal,
            table
          })
        : validateTableFragmentPatchProposal({
            proposal,
            table
          });

      analyses.push({
        matchKey: `${table.start}:${table.end}`,
        proposalIndex,
        structural
      });
    });
  });

  return analyses;
}

function validateWholeTablePatchProposal({
  match,
  proposal,
  table
}: {
  match: TextRange;
  proposal: PatchProposalInput;
  table: MarkdownTable;
}): boolean {
  const originalTables = findMarkdownTables(proposal.original_text);
  const relativeTableStart = table.start - match.start;
  const relativeTableEnd = table.end - match.start;
  const originalTable = originalTables.find(
    (candidate) =>
      candidate.start === relativeTableStart && candidate.end === relativeTableEnd
  );
  const suggestedTables = findMarkdownTables(proposal.suggested_text);

  if (!originalTable) {
    return false;
  }

  if (suggestedTables.length === 0) {
    return true;
  }

  if (suggestedTables.length !== 1) {
    throw new Error(ATOMIC_TABLE_IMPORT_ERROR);
  }

  const suggestedTable = suggestedTables[0];
  const structural = isStructuralTableChange(originalTable, suggestedTable);

  if (!structural) {
    return false;
  }

  if (
    !suggestedTable.isWellFormed ||
    !isSurroundingContextPreserved({
      originalTable,
      proposal,
      suggestedTable
    })
  ) {
    throw new Error(ATOMIC_TABLE_IMPORT_ERROR);
  }

  if (
    !table.isWellFormed &&
    !mentionsMalformedTableRepair(proposal.reason, proposal.risk)
  ) {
    throw new Error(
      "ChatGPT proposed a structural table repair for a malformed source table without explaining the normalization in reason and risk."
    );
  }

  return true;
}

function validateTableFragmentPatchProposal({
  proposal,
  table
}: {
  proposal: PatchProposalInput;
  table: MarkdownTable;
}): boolean {
  const structural = hasFragmentStructuralCellDistributionChange(
    proposal.original_text,
    proposal.suggested_text
  );

  if (structural) {
    throw new Error(ATOMIC_TABLE_IMPORT_ERROR);
  }

  if (
    table.isWellFormed &&
    createsMalformedTableFragment(proposal.original_text, proposal.suggested_text)
  ) {
    throw new Error(ATOMIC_TABLE_IMPORT_ERROR);
  }

  return false;
}

function hasFragmentStructuralCellDistributionChange(
  originalText: string,
  suggestedText: string
): boolean {
  const originalRows = getPatchFragmentRows(originalText);
  const suggestedRows = getPatchFragmentRows(suggestedText);

  if (originalRows.length === 0 || suggestedRows.length === 0) {
    return false;
  }

  const originalCounts = uniqueCellCounts(originalRows);
  const suggestedCounts = uniqueCellCounts(suggestedRows);

  return (
    originalCounts.length === 1 &&
    suggestedCounts.length === 1 &&
    originalCounts[0] !== suggestedCounts[0]
  );
}

function createsMalformedTableFragment(
  originalText: string,
  suggestedText: string
): boolean {
  const originalRows = getPatchFragmentRows(originalText);
  const suggestedRows = getPatchFragmentRows(suggestedText);

  if (originalRows.length === 0 || suggestedRows.length === 0) {
    return false;
  }

  const originalCounts = uniqueCellCounts(originalRows);
  const suggestedCounts = uniqueCellCounts(suggestedRows);

  return originalCounts.length === 1 && suggestedCounts.length > 1;
}

function getPatchFragmentRows(markdown: string): string[] {
  return getMarkdownTableRowLikeLines(markdown).filter(
    (line) => !isMarkdownTableDelimiterRow(line)
  );
}

function uniqueCellCounts(rows: string[]): number[] {
  return Array.from(
    new Set(rows.map((row) => parseMarkdownTableRow(row).length))
  ).sort((first, second) => first - second);
}

function isStructuralTableChange(
  originalTable: MarkdownTable,
  suggestedTable: MarkdownTable
): boolean {
  if (originalTable.columnCount !== suggestedTable.columnCount) {
    return true;
  }

  const originalHeaderCells = originalTable.headerRow.cells.map(normalizeTableCell);
  const suggestedHeaderCells = suggestedTable.headerRow.cells.map(normalizeTableCell);

  return (
    originalHeaderCells.length === suggestedHeaderCells.length &&
    originalHeaderCells.join("\u0000") !== suggestedHeaderCells.join("\u0000") &&
    [...originalHeaderCells].sort().join("\u0000") ===
      [...suggestedHeaderCells].sort().join("\u0000")
  );
}

function isSurroundingContextPreserved({
  originalTable,
  proposal,
  suggestedTable
}: {
  originalTable: MarkdownTable;
  proposal: PatchProposalInput;
  suggestedTable: MarkdownTable;
}): boolean {
  return (
    proposal.original_text.slice(0, originalTable.start) ===
      proposal.suggested_text.slice(0, suggestedTable.start) &&
    proposal.original_text.slice(originalTable.end) ===
      proposal.suggested_text.slice(suggestedTable.end)
  );
}

function mentionsMalformedTableRepair(reason: string, risk?: string): boolean {
  const text = `${reason} ${risk ?? ""}`.toLowerCase();

  return /\b(malformed|inconsistent|normaliz|repair)\b/.test(text);
}

function getAnchorSelectedTableSearchRanges(anchor: PatchmarkCommentAnchor): TextRange[] {
  if (anchor.kind !== "selected_text") {
    return [];
  }

  const ranges: TextRange[] = [];

  if (
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    ranges.push({
      end: anchor.markdown_end_offset,
      start: anchor.markdown_start_offset
    });
  }

  if (
    typeof anchor.anchor_context?.markdown_start_offset === "number" &&
    typeof anchor.anchor_context.markdown_end_offset === "number"
  ) {
    ranges.push({
      end: anchor.anchor_context.markdown_end_offset,
      start: anchor.anchor_context.markdown_start_offset
    });
  }

  return ranges;
}

function toCompleteTableOccurrence(table: MarkdownTable): CompleteTableOccurrence {
  return {
    end: table.end,
    markdown: table.markdown,
    start: table.start
  };
}

function dedupeTables(tables: MarkdownTable[]): MarkdownTable[] {
  const seen = new Set<string>();

  return tables.filter((table) => {
    const key = `${table.start}:${table.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeTableCell(cell: string): string {
  return cell.trim().replace(/\s+/g, " ").toLowerCase();
}

function findExactTextMatches(text: string, searchText: string): TextRange[] {
  if (!searchText) {
    return [];
  }

  const matches: TextRange[] = [];
  let index = text.indexOf(searchText);

  while (index !== -1) {
    matches.push({
      end: index + searchText.length,
      start: index
    });
    index = text.indexOf(searchText, index + searchText.length);
  }

  return matches;
}

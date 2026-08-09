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
  "ChatGPT split one structural change across multiple patch proposals. Request one atomic patch covering the complete affected table or structural region.";

const INCOMPLETE_STRUCTURAL_REGION_ERROR =
  "ChatGPT proposed a structural table change without owning the complete affected table or structural region.";
const MALFORMED_STRUCTURAL_MARKDOWN_ERROR =
  "ChatGPT proposed malformed Markdown in a structural table replacement.";
const INTERNAL_SINGLE_PROPOSAL_SPLIT_ERROR =
  "Patchmark could not validate this atomic structural patch. Retry the import without changing the response.";

export type AtomicTablePatchErrorCode =
  | "incomplete_structural_region"
  | "malformed_structural_markdown"
  | "single_proposal_split_invariant"
  | "split_structural_change_across_proposals";

export class AtomicTablePatchValidationError extends Error {
  readonly code: AtomicTablePatchErrorCode;
  readonly conflictingProposalCount?: number;
  readonly patchKeys: string[];
  readonly repairPromptEligible: boolean;
  readonly targetHeading?: string;

  constructor({
    code,
    conflictingProposalCount,
    message,
    patchKeys = [],
    repairPromptEligible = true,
    targetHeading
  }: {
    code: AtomicTablePatchErrorCode;
    conflictingProposalCount?: number;
    message: string;
    patchKeys?: string[];
    repairPromptEligible?: boolean;
    targetHeading?: string;
  }) {
    super(message);
    this.name = "AtomicTablePatchValidationError";
    this.code = code;
    this.conflictingProposalCount = conflictingProposalCount;
    this.patchKeys = patchKeys;
    this.repairPromptEligible = repairPromptEligible;
    this.targetHeading = targetHeading;
  }
}

export function createAtomicTableRepairPrompt(error: unknown): string {
  if (
    !(error instanceof AtomicTablePatchValidationError) ||
    !error.repairPromptEligible
  ) {
    return "";
  }

  if (error.code === "split_structural_change_across_proposals") {
    const details = [
      error.patchKeys.length > 0
        ? `Conflicting patch keys: ${error.patchKeys.join(", ")}.`
        : "",
      error.targetHeading ? `Target heading: ${error.targetHeading}.` : ""
    ].filter(Boolean);

    return `Structural patch rules:
- Return one patch proposal covering the complete affected table or structural region.
- Do not split header, row, column, reordering, or overlapping region changes across proposals.
${details.join("\n")}`.trim();
  }

  if (error.code === "incomplete_structural_region") {
    return `Structural patch rules:
- Copy the complete affected table or structural region into original_text.
- Return the complete structurally valid replacement in suggested_text.`;
  }

  return `Structural Markdown rules:
- Return well-formed Markdown tables with a header, delimiter row, and consistent cell counts.`;
}

export const CHATGPT_ATOMIC_TABLE_PROMPT_RULES = `## Atomic table changes

Complete-table patch required:

Use one complete-table patch when a change adds or removes a column, reorders columns, splits one column into multiple columns, merges multiple columns, moves existing values between columns, converts the table into another structure, converts another structure into a table, sorts or substantially reorganizes the complete table, reformats or normalizes the entire table, or otherwise changes the expected number or meaning of cells across multiple rows.

For these operations:

- Copy the complete table exactly into \`original_text\`.
- Return the complete resulting table in \`suggested_text\`.
- Include the header, delimiter/alignment row, and every body row.
- Return exactly one \`patch_proposal\` for that table.
- Never split the structural change into separate header, delimiter, or body-row proposals.
- One proposal may own a complete region containing several related tables, and the replacement may contain a different number of tables.
- Keep interdependent table reordering or restructuring inside that one complete-region proposal.
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
  complete: boolean;
  matchKey: string;
  proposalIndex: number;
  structural: boolean;
};

export type AtomicTablePatchImportDiagnostics = {
  proposalCount: number;
  proposals: Array<{
    directDependencies: string[];
    exactMatchCount: number;
    originalTableBlockCount: number;
    patchKey: string;
    proposalIndex: number;
    suggestedTableBlockCount: number;
  }>;
  structuralGroups: Array<{
    incompleteStructuralProposalIndexes: number[];
    patchKeys: string[];
    proposalIndexes: number[];
    regionId: string;
    structuralProposalIndexes: number[];
  }>;
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
  const diagnostics = inspectAtomicTablePatchImport({
    markdown,
    patchProposals
  });

  patchProposals.forEach((proposal, proposalIndex) => {
    const proposalDiagnostics = diagnostics.proposals[proposalIndex];
    const suggestedTables = findMarkdownTables(proposal.suggested_text);

    if (
      (proposalDiagnostics?.exactMatchCount ?? 0) > 0 &&
      (proposalDiagnostics?.originalTableBlockCount ?? 0) > 0 &&
      suggestedTables.some((table) => !table.isWellFormed)
    ) {
      throw createProposalValidationError({
        code: "malformed_structural_markdown",
        message: MALFORMED_STRUCTURAL_MARKDOWN_ERROR,
        patchProposals,
        proposalIndexes: [proposalIndex]
      });
    }
  });

  for (const group of diagnostics.structuralGroups) {
    if (
      group.structuralProposalIndexes.length > 0 &&
      group.proposalIndexes.length > 1
    ) {
      if (patchProposals.length === 1) {
        throw new AtomicTablePatchValidationError({
          code: "single_proposal_split_invariant",
          message: INTERNAL_SINGLE_PROPOSAL_SPLIT_ERROR,
          patchKeys: group.patchKeys,
          repairPromptEligible: false
        });
      }

      throw createProposalValidationError({
        code: "split_structural_change_across_proposals",
        conflictingProposalCount: group.proposalIndexes.length,
        message: ATOMIC_TABLE_IMPORT_ERROR,
        patchProposals,
        proposalIndexes: group.proposalIndexes
      });
    }
  }

  for (const group of diagnostics.structuralGroups) {
    if (group.incompleteStructuralProposalIndexes.length > 0) {
      throw createProposalValidationError({
        code: "incomplete_structural_region",
        message: INCOMPLETE_STRUCTURAL_REGION_ERROR,
        patchProposals,
        proposalIndexes: group.incompleteStructuralProposalIndexes
      });
    }
  }

  patchProposals.forEach((proposal, proposalIndex) => {
    if ((diagnostics.proposals[proposalIndex]?.exactMatchCount ?? 0) === 0) {
      return;
    }

    const originalTables = findMarkdownTables(proposal.original_text);
    const suggestedTables = findMarkdownTables(proposal.suggested_text);
    const structural = isStructuralRegionChange(
      originalTables,
      suggestedTables
    );

    if (
      structural &&
      originalTables.some((table) => !table.isWellFormed) &&
      !mentionsMalformedTableRepair(proposal.reason, proposal.risk)
    ) {
      throw new Error(
        "ChatGPT proposed a structural table repair for a malformed source table without explaining the normalization in reason and risk."
      );
    }
  });
}

export function inspectAtomicTablePatchImport({
  markdown,
  patchProposals
}: {
  markdown: string;
  patchProposals: PatchProposalInput[];
}): AtomicTablePatchImportDiagnostics {
  const analysesByTable = new Map<string, PatchProposalAnalysis[]>();

  patchProposals.forEach((proposal, proposalIndex) => {
    const analyses = analyzePatchProposalAgainstCurrentTables({
      markdown,
      proposal,
      proposalIndex
    });

    for (const analysis of analyses) {
      const tableAnalyses = analysesByTable.get(analysis.matchKey) ?? [];
      tableAnalyses.push(analysis);
      analysesByTable.set(analysis.matchKey, tableAnalyses);
    }
  });

  return {
    proposalCount: patchProposals.length,
    proposals: patchProposals.map((proposal, proposalIndex) => ({
      directDependencies: [...(proposal.depends_on ?? [])],
      exactMatchCount: findExactTextMatches(markdown, proposal.original_text).length,
      originalTableBlockCount: findMarkdownTables(proposal.original_text).length,
      patchKey: proposal.patch_key ?? `proposal-${proposalIndex + 1}`,
      proposalIndex,
      suggestedTableBlockCount: findMarkdownTables(proposal.suggested_text).length
    })),
    structuralGroups: Array.from(analysesByTable.entries()).map(
      ([regionId, analyses]) => {
        const proposalIndexes = uniqueSortedIndexes(
          analyses.map((analysis) => analysis.proposalIndex)
        );
        const structuralProposalIndexes = uniqueSortedIndexes(
          analyses
            .filter((analysis) => analysis.structural)
            .map((analysis) => analysis.proposalIndex)
        );
        const incompleteStructuralProposalIndexes = uniqueSortedIndexes(
          analyses
            .filter((analysis) => analysis.structural && !analysis.complete)
            .map((analysis) => analysis.proposalIndex)
        );

        return {
          incompleteStructuralProposalIndexes,
          patchKeys: proposalIndexes.map(
            (proposalIndex) =>
              patchProposals[proposalIndex]?.patch_key ??
              `proposal-${proposalIndex + 1}`
          ),
          proposalIndexes,
          regionId,
          structuralProposalIndexes
        };
      }
    )
  };
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
  const originalTables = findMarkdownTables(proposal.original_text);
  const suggestedTables = findMarkdownTables(proposal.suggested_text);
  const completeRegionStructural = isStructuralRegionChange(
    originalTables,
    suggestedTables
  );

  matches.forEach((match) => {
    const tables = findMarkdownTablesOverlappingRange(markdown, match);

    tables.forEach((table) => {
      const complete = match.start <= table.start && match.end >= table.end;
      const structural = complete
        ? completeRegionStructural
        : isStructuralTableFragmentPatchProposal(proposal);

      analyses.push({
        complete,
        matchKey: `${table.start}:${table.end}`,
        proposalIndex,
        structural
      });
    });
  });

  return analyses;
}

function isStructuralTableFragmentPatchProposal(
  proposal: PatchProposalInput
): boolean {
  return (
    hasFragmentStructuralCellDistributionChange(
      proposal.original_text,
      proposal.suggested_text
    ) ||
    createsMalformedTableFragment(
      proposal.original_text,
      proposal.suggested_text
    )
  );
}

function isStructuralRegionChange(
  originalTables: MarkdownTable[],
  suggestedTables: MarkdownTable[]
): boolean {
  if (originalTables.length === 0) {
    return false;
  }

  if (originalTables.length !== suggestedTables.length) {
    return true;
  }

  if (originalTables.length > 1) {
    return originalTables.some(
      (table, index) => table.markdown !== suggestedTables[index]?.markdown
    );
  }

  return isStructuralTableChange(originalTables[0], suggestedTables[0]);
}

function createProposalValidationError({
  code,
  conflictingProposalCount,
  message,
  patchProposals,
  proposalIndexes
}: {
  code: AtomicTablePatchErrorCode;
  conflictingProposalCount?: number;
  message: string;
  patchProposals: PatchProposalInput[];
  proposalIndexes: number[];
}): AtomicTablePatchValidationError {
  const proposals = proposalIndexes
    .map((proposalIndex) => patchProposals[proposalIndex])
    .filter((proposal): proposal is PatchProposalInput => Boolean(proposal));
  const headings = Array.from(
    new Set(
      proposals
        .map((proposal) => proposal.target_heading)
        .filter((heading): heading is string => Boolean(heading))
    )
  );

  const patchKeys = proposals.map(
    (proposal, index) => proposal.patch_key ?? `proposal-${index + 1}`
  );
  const targetHeading = headings.length === 1 ? headings[0] : undefined;
  const messageDetails =
    code === "split_structural_change_across_proposals"
      ? [
          patchKeys.length > 0
            ? `Conflicting patch keys: ${patchKeys.join(", ")}.`
            : "",
          targetHeading ? `Target heading: ${targetHeading}.` : "",
          conflictingProposalCount
            ? `Conflicting proposals: ${conflictingProposalCount}.`
            : ""
        ]
          .filter(Boolean)
          .join(" ")
      : "";

  return new AtomicTablePatchValidationError({
    code,
    conflictingProposalCount,
    message: messageDetails ? `${message} ${messageDetails}` : message,
    patchKeys,
    targetHeading
  });
}

function uniqueSortedIndexes(indexes: number[]): number[] {
  return Array.from(new Set(indexes)).sort((first, second) => first - second);
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

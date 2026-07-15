export type MarkdownTableRow = {
  cells: string[];
  end: number;
  isDelimiter: boolean;
  lineIndex: number;
  start: number;
  text: string;
};

export type MarkdownTable = {
  bodyRows: MarkdownTableRow[];
  columnCount: number;
  delimiterRow: MarkdownTableRow;
  end: number;
  endLineIndex: number;
  headerRow: MarkdownTableRow;
  isWellFormed: boolean;
  markdown: string;
  rows: MarkdownTableRow[];
  start: number;
  startLineIndex: number;
};

export type TextRange = {
  end: number;
  start: number;
};

type MarkdownLine = {
  end: number;
  index: number;
  start: number;
  text: string;
};

let cachedMarkdownTables:
  | {
      markdown: string;
      tables: MarkdownTable[];
    }
  | undefined;

export function findMarkdownTables(
  markdown: string,
  range?: TextRange
): MarkdownTable[] {
  if (!range && cachedMarkdownTables?.markdown === markdown) {
    return cachedMarkdownTables.tables;
  }

  const lines = getMarkdownLines(markdown);
  const tables: MarkdownTable[] = [];
  const startLineIndex =
    range && range.start > 0
      ? getLineIndexForOffset(lines, range.start)
      : 0;
  let lineIndex = startLineIndex;
  let activeFence: string | null = null;

  while (lineIndex < lines.length - 1) {
    const line = lines[lineIndex];
    const fence = getFenceMarker(line?.text ?? "");

    if (fence && !activeFence) {
      activeFence = fence;
      lineIndex += 1;
      continue;
    }

    if (activeFence) {
      if (fence === activeFence) {
        activeFence = null;
      }
      lineIndex += 1;
      continue;
    }

    const headerRow = createMarkdownTableRow(lines[lineIndex]);
    const delimiterRow = createMarkdownTableRow(lines[lineIndex + 1]);

    if (
      headerRow &&
      delimiterRow?.isDelimiter &&
      !headerRow.isDelimiter
    ) {
      const bodyRows: MarkdownTableRow[] = [];
      let rowIndex = lineIndex + 2;

      while (rowIndex < lines.length) {
        const bodyRow = createMarkdownTableRow(lines[rowIndex]);

        if (!bodyRow || bodyRow.isDelimiter) {
          break;
        }

        bodyRows.push(bodyRow);
        rowIndex += 1;
      }

      const rows = [headerRow, delimiterRow, ...bodyRows];
      const start = headerRow.start;
      const end = rows[rows.length - 1]?.end ?? delimiterRow.end;
      const columnCount = delimiterRow.cells.length;
      const table: MarkdownTable = {
        bodyRows,
        columnCount,
        delimiterRow,
        end,
        endLineIndex: rows[rows.length - 1]?.lineIndex ?? delimiterRow.lineIndex,
        headerRow,
        isWellFormed:
          headerRow.cells.length === columnCount &&
          bodyRows.every((row) => row.cells.length === columnCount),
        markdown: markdown.slice(start, end),
        rows,
        start,
        startLineIndex: headerRow.lineIndex
      };

      if (!range || rangesOverlap(table, range)) {
        tables.push(table);
      }

      lineIndex = rowIndex;
      continue;
    }

    lineIndex += 1;
  }

  if (!range) {
    cachedMarkdownTables = { markdown, tables };
  }

  return tables;
}

export function findMarkdownTableContainingRange(
  markdown: string,
  range: TextRange
): MarkdownTable | null {
  return (
    findMarkdownTables(markdown).find(
      (table) => range.start >= table.start && range.end <= table.end
    ) ?? null
  );
}

export function findMarkdownTablesOverlappingRange(
  markdown: string,
  range: TextRange
): MarkdownTable[] {
  return findMarkdownTables(markdown).filter((table) =>
    rangesOverlap(table, range)
  );
}

export function parseMarkdownTableRow(line: string): string[] {
  const content = stripMarkdownTableContainerPrefix(line).replace(/\r$/, "");
  const cells: string[] = [];
  let currentCell = "";
  let inCode = false;
  let linkDestinationDepth = 0;
  let sawDelimiter = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const nextCharacter = content[index + 1] ?? "";
    const previousCharacter = content[index - 1] ?? "";

    if (character === "\\" && nextCharacter === "|") {
      currentCell += `${character}${nextCharacter}`;
      index += 1;
      continue;
    }

    if (character === "`") {
      inCode = !inCode;
      currentCell += character;
      continue;
    }

    if (!inCode && linkDestinationDepth === 0 && character === "(" && previousCharacter === "]") {
      linkDestinationDepth = 1;
      currentCell += character;
      continue;
    }

    if (!inCode && linkDestinationDepth > 0) {
      if (character === "(") {
        linkDestinationDepth += 1;
      } else if (character === ")") {
        linkDestinationDepth -= 1;
      }
      currentCell += character;
      continue;
    }

    if (!inCode && linkDestinationDepth === 0 && character === "|") {
      cells.push(currentCell.trim());
      currentCell = "";
      sawDelimiter = true;
      continue;
    }

    currentCell += character;
  }

  cells.push(currentCell.trim());

  if (!sawDelimiter) {
    return [];
  }

  if (cells[0] === "") {
    cells.shift();
  }

  if (cells[cells.length - 1] === "") {
    cells.pop();
  }

  return cells.map((cell) => cell.replace(/\\\|/g, "|"));
}

export function isMarkdownTableDelimiterRow(line: string): boolean {
  const cells = parseMarkdownTableRow(line);

  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

export function isMarkdownTableRowLine(line: string): boolean {
  return parseMarkdownTableRow(line).length >= 2;
}

export function getMarkdownTableRowLikeLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isMarkdownTableRowLine(line));
}

function createMarkdownTableRow(line: MarkdownLine | undefined): MarkdownTableRow | null {
  if (!line || !isMarkdownTableRowLine(line.text)) {
    return null;
  }

  return {
    cells: parseMarkdownTableRow(line.text),
    end: line.end,
    isDelimiter: isMarkdownTableDelimiterRow(line.text),
    lineIndex: line.index,
    start: line.start,
    text: line.text.replace(/\r$/, "")
  };
}

function getMarkdownLines(markdown: string): MarkdownLine[] {
  const lines = markdown.split("\n");
  const result: MarkdownLine[] = [];
  let start = 0;

  lines.forEach((line, index) => {
    const end = start + line.length;
    result.push({
      end,
      index,
      start,
      text: line
    });
    start = end + 1;
  });

  return result;
}

function getLineIndexForOffset(lines: MarkdownLine[], offset: number): number {
  let lineIndex = 0;

  for (const line of lines) {
    if (line.start > offset) {
      break;
    }
    lineIndex = line.index;
  }

  return lineIndex;
}

function getFenceMarker(line: string): string | null {
  const content = stripMarkdownTableContainerPrefix(line).trim();
  const match = /^(```+|~~~+)/.exec(content);

  return match?.[1][0] ?? null;
}

function rangesOverlap(first: TextRange, second: TextRange): boolean {
  return first.start < second.end && second.start < first.end;
}

function stripMarkdownTableContainerPrefix(line: string): string {
  let content = line.replace(/^\s{0,4}/, "");

  while (/^>\s?/.test(content)) {
    content = content.replace(/^>\s?/, "");
  }

  return content;
}

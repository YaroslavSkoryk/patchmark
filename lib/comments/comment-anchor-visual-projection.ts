import { findMarkdownTables } from "../markdown/markdown-tables.ts";

export type VisualTableAnchorCellProjection = {
  cellIndex: number;
  sourceEnd: number;
  sourceStart: number;
  visibleText: string;
};

export type VisualTableAnchorRowProjection = {
  cells: VisualTableAnchorCellProjection[];
  markdownRowIndex: number;
};

export type VisualTableAnchorProjection = {
  rows: VisualTableAnchorRowProjection[];
  tableIndex: number;
};

type CellSourceRange = {
  cellIndex: number;
  end: number;
  start: number;
};

export function createVisualTableAnchorProjection({
  markdown,
  range
}: {
  markdown: string;
  range: { end: number; start: number };
}): VisualTableAnchorProjection | null {
  const tables = findMarkdownTables(markdown);
  const tableIndex = tables.findIndex(
    (table) => range.start >= table.start && range.end <= table.end
  );
  const table = tableIndex >= 0 ? tables[tableIndex] : null;

  if (!table) {
    return null;
  }

  const rows = table.rows
    .map((row, markdownRowIndex) => {
      if (row.isDelimiter || !rangesOverlap(row, range)) {
        return null;
      }

      const cells = getMarkdownTableCellSourceRanges(row.text, row.start)
        .filter((cellRange) => rangesOverlap(cellRange, range))
        .map((cellRange) => {
          const sourceStart = Math.max(cellRange.start, range.start);
          const sourceEnd = Math.min(cellRange.end, range.end);
          const visibleText = markdownInlineToPlainText(
            markdown.slice(sourceStart, sourceEnd)
          );

          return {
            cellIndex: cellRange.cellIndex,
            sourceEnd,
            sourceStart,
            visibleText
          };
        })
        .filter((cell) => cell.visibleText.length > 0);

      return cells.length > 0
        ? {
            cells,
            markdownRowIndex
          }
        : null;
    })
    .filter((row): row is VisualTableAnchorRowProjection => row !== null);

  return rows.length > 0
    ? {
        rows,
        tableIndex
      }
    : null;
}

export function markdownInlineToPlainText(markdown: string): string {
  const textParts: string[] = [];

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index] ?? "";
    const nextCharacter = markdown[index + 1] ?? "";

    if (character === "\\" && nextCharacter) {
      textParts.push(nextCharacter);
      index += 1;
      continue;
    }

    if (character === "!" && nextCharacter === "[") {
      const parsedLink = parseMarkdownLink(markdown, index + 1);

      if (parsedLink) {
        textParts.push(parsedLink.label);
        index = parsedLink.endIndex;
        continue;
      }
    }

    if (character === "[") {
      const parsedLink = parseMarkdownLink(markdown, index);

      if (parsedLink) {
        textParts.push(parsedLink.label);
        index = parsedLink.endIndex;
        continue;
      }
    }

    if (character === "`") {
      const closingIndex = markdown.indexOf("`", index + 1);

      if (closingIndex !== -1) {
        textParts.push(markdown.slice(index + 1, closingIndex));
        index = closingIndex;
        continue;
      }
    }

    if (/[*_~]/.test(character)) {
      continue;
    }

    textParts.push(character);
  }

  return normalizeProjectedText(textParts.join(""));
}

function getMarkdownTableCellSourceRanges(
  rowText: string,
  rowStart: number
): CellSourceRange[] {
  const rawSegments = splitMarkdownTableRowIntoSourceSegments(rowText);
  const segments =
    rawSegments[0]?.text.trim() === ""
      ? rawSegments.slice(1)
      : rawSegments.slice();

  if (segments[segments.length - 1]?.text.trim() === "") {
    segments.pop();
  }

  return segments.map((segment, cellIndex) => {
    const trimmed = trimSourceSegment(segment.text, segment.start, segment.end);

    return {
      cellIndex,
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

function parseMarkdownLink(
  markdown: string,
  startIndex: number
): { endIndex: number; label: string } | null {
  const labelEnd = findClosingBracket(markdown, startIndex + 1);

  if (labelEnd === -1 || markdown[labelEnd + 1] !== "(") {
    return null;
  }

  const destinationEnd = findClosingParenthesis(markdown, labelEnd + 2);

  if (destinationEnd === -1) {
    return null;
  }

  return {
    endIndex: destinationEnd,
    label: markdownInlineToPlainText(markdown.slice(startIndex + 1, labelEnd))
  };
}

function findClosingBracket(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === "\\" && text[index + 1]) {
      index += 1;
      continue;
    }

    if (character === "]") {
      return index;
    }
  }

  return -1;
}

function findClosingParenthesis(text: string, startIndex: number): number {
  let depth = 1;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === "\\" && text[index + 1]) {
      index += 1;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function normalizeProjectedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rangesOverlap(
  first: { end: number; start: number },
  second: { end: number; start: number }
): boolean {
  return first.start < second.end && second.start < first.end;
}

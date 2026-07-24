import { parseMarkdownHeadings } from "./parse-headings.ts";

export type MarkdownSectionRange = {
  end: number;
  start: number;
};

export function getMarkdownHeadingSectionRange(
  markdown: string,
  targetHeading?: string
): MarkdownSectionRange | null {
  const normalizedTarget = normalizeMarkdownHeading(targetHeading);

  if (!normalizedTarget) {
    return null;
  }

  const headings = parseMarkdownHeadings(markdown);
  const headingIndex = headings.findIndex(
    (heading) => normalizeMarkdownHeading(heading.text) === normalizedTarget
  );

  if (headingIndex === -1) {
    return null;
  }

  const heading = headings[headingIndex];
  const lineStarts = getLineStartOffsets(markdown);
  const start = lineStarts[heading.line - 1] ?? 0;
  const nextBoundary = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level);
  const end = nextBoundary
    ? lineStarts[nextBoundary.line - 1] ?? markdown.length
    : markdown.length;

  return { end, start };
}

export function normalizeMarkdownHeading(
  heading?: string
): string | null {
  const normalized = heading
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLocaleLowerCase();

  return normalized || null;
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

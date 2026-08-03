import { parseMarkdownHeadings, type MarkdownHeading } from "../markdown/parse-headings.ts";
import type { RewriteTarget, RewriteTargetKind } from "./rewrite-session-types.ts";

export type ResolvedRewriteTarget = {
  end: number;
  start: number;
  text: string;
};

export function captureRewriteTarget({
  end,
  headingLine,
  kind,
  markdown,
  start
}: {
  end?: number;
  headingLine: number | null;
  kind: RewriteTargetKind;
  markdown: string;
  start?: number;
}): { target: RewriteTarget; text: string } {
  const headings = parseMarkdownHeadings(markdown);
  const heading = headingLine
    ? headings.find((candidate) => candidate.line === headingLine)
    : undefined;
  const range =
    kind === "section"
      ? heading
        ? getSectionRange(markdown, headings, heading)
        : null
      : normalizeRange(markdown, start, end);

  if (!range || range.end <= range.start) {
    throw new Error(
      kind === "section"
        ? "No canonical containing section could be identified."
        : "The selected text does not map to one deterministic Markdown range."
    );
  }

  const contextRadius = 160;
  return {
    target: {
      kind,
      heading_snapshot: heading?.text ?? null,
      heading_level: heading?.level ?? null,
      heading_path: heading ? getHeadingPath(headings, heading) : [],
      base_start: range.start,
      base_end: range.end,
      context_before: markdown.slice(
        Math.max(0, range.start - contextRadius),
        range.start
      ),
      context_after: markdown.slice(
        range.end,
        Math.min(markdown.length, range.end + contextRadius)
      )
    },
    text: markdown.slice(range.start, range.end)
  };
}

export function resolveRewriteTarget({
  baseText,
  markdown,
  target
}: {
  baseText: string;
  markdown: string;
  target: RewriteTarget;
}): ResolvedRewriteTarget | null {
  if (target.kind === "section") {
    return resolveSectionTarget({ baseText, markdown, target });
  }

  const storedRange = normalizeRange(
    markdown,
    target.base_start,
    target.base_end
  );
  if (
    storedRange &&
    markdown.slice(storedRange.start, storedRange.end) === baseText
  ) {
    return { ...storedRange, text: baseText };
  }

  const matches = findExactMatches(markdown, baseText);
  const headingFiltered = target.heading_snapshot
    ? matches.filter((match) => {
        const headings = parseMarkdownHeadings(markdown);
        const containing = getHeadingContainingOffset(markdown, headings, match.start);
        return (
          containing?.text === target.heading_snapshot &&
          (target.heading_level === null || containing.level === target.heading_level)
        );
      })
    : matches;
  const contextual = headingFiltered.filter(
    (match) =>
      (!target.context_before ||
        markdown.slice(
          Math.max(0, match.start - target.context_before.length),
          match.start
        ) === target.context_before) &&
      (!target.context_after ||
        markdown.slice(match.end, match.end + target.context_after.length) ===
          target.context_after)
  );
  const candidates = contextual.length === 1 ? contextual : headingFiltered;

  return candidates.length === 1
    ? { ...candidates[0], text: markdown.slice(candidates[0].start, candidates[0].end) }
    : null;
}

export function resolveRewriteTargetForRefresh({
  baseText,
  markdown,
  target
}: {
  baseText: string;
  markdown: string;
  target: RewriteTarget;
}): ResolvedRewriteTarget | null {
  const exact = resolveRewriteTarget({ baseText, markdown, target });
  if (exact || target.kind === "section") {
    return exact;
  }
  if (!target.context_before || !target.context_after) {
    return null;
  }
  const candidates: ResolvedRewriteTarget[] = [];
  let beforeStart = markdown.indexOf(target.context_before);
  while (beforeStart !== -1) {
    const start = beforeStart + target.context_before.length;
    const end = markdown.indexOf(target.context_after, start);
    if (end !== -1) {
      candidates.push({ start, end, text: markdown.slice(start, end) });
    }
    beforeStart = markdown.indexOf(target.context_before, beforeStart + 1);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function refreshRewriteTarget({
  markdown,
  resolved,
  target
}: {
  markdown: string;
  resolved: ResolvedRewriteTarget;
  target: RewriteTarget;
}): RewriteTarget {
  const heading = getHeadingContainingOffset(
    markdown,
    parseMarkdownHeadings(markdown),
    resolved.start
  );
  return captureRewriteTarget({
    end: resolved.end,
    headingLine: heading?.line ?? null,
    kind: target.kind,
    markdown,
    start: resolved.start
  }).target;
}

function resolveSectionTarget({
  baseText,
  markdown,
  target
}: {
  baseText: string;
  markdown: string;
  target: RewriteTarget;
}): ResolvedRewriteTarget | null {
  if (!target.heading_snapshot) {
    return null;
  }
  const headings = parseMarkdownHeadings(markdown);
  const candidates = headings.filter(
    (heading) =>
      heading.text === target.heading_snapshot &&
      (target.heading_level === null || heading.level === target.heading_level) &&
      (target.heading_path.length === 0 ||
        areStringArraysEqual(getHeadingPath(headings, heading), target.heading_path))
  );
  const matches = candidates
    .map((heading) => getSectionRange(markdown, headings, heading))
    .map((range) => ({ ...range, text: markdown.slice(range.start, range.end) }));

  if (matches.length === 1) {
    return matches[0];
  }
  const exact = matches.filter((match) => match.text === baseText);
  return exact.length === 1 ? exact[0] : null;
}

function getHeadingContainingOffset(
  markdown: string,
  headings: MarkdownHeading[],
  offset: number
): MarkdownHeading | undefined {
  const lineOffsets = getLineStartOffsets(markdown);
  let containing: MarkdownHeading | undefined;
  for (const heading of headings) {
    if ((lineOffsets[heading.line - 1] ?? 0) > offset) {
      break;
    }
    containing = heading;
  }
  return containing;
}

function getSectionRange(
  markdown: string,
  headings: MarkdownHeading[],
  target: MarkdownHeading
): { end: number; start: number } {
  const lineOffsets = getLineStartOffsets(markdown);
  const headingIndex = headings.findIndex((heading) => heading.line === target.line);
  const nextBoundary = headings
    .slice(headingIndex + 1)
    .find((heading) => heading.level <= target.level);
  return {
    start: lineOffsets[target.line - 1] ?? 0,
    end: nextBoundary
      ? lineOffsets[nextBoundary.line - 1] ?? markdown.length
      : markdown.length
  };
}

function getHeadingPath(headings: MarkdownHeading[], target: MarkdownHeading): string[] {
  const path: MarkdownHeading[] = [];
  for (const heading of headings) {
    while (path.length > 0 && path[path.length - 1].level >= heading.level) {
      path.pop();
    }
    path.push(heading);
    if (heading.line === target.line) {
      return path.map((candidate) => candidate.text);
    }
  }
  return [target.text];
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

function normalizeRange(
  markdown: string,
  start: number | undefined,
  end: number | undefined
): { end: number; start: number } | null {
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > markdown.length ||
    end <= start
  ) {
    return null;
  }
  return { end, start };
}

function findExactMatches(markdown: string, text: string) {
  if (!text) {
    return [];
  }
  const matches: Array<{ end: number; start: number }> = [];
  let start = markdown.indexOf(text);
  while (start !== -1) {
    matches.push({ start, end: start + text.length });
    start = markdown.indexOf(text, start + 1);
  }
  return matches;
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

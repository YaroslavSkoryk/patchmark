import type { MarkdownHeading } from "../markdown/parse-headings.ts";
import type { ReviewQueueSectionBucket } from "./review-queue-types.ts";

export const REVIEW_QUEUE_INTRODUCTION_SECTION_KEY = "document:introduction";
export const REVIEW_QUEUE_INTRODUCTION_HEADING = "Document introduction";

export function getReviewQueueSectionBucket({
  documentOrder,
  headings,
  markdown
}: {
  documentOrder: number;
  headings: MarkdownHeading[];
  markdown: string;
}): ReviewQueueSectionBucket {
  const lineStartOffsets = getLineStartOffsets(markdown);
  let containingH2: MarkdownHeading | null = null;
  let containingH2Start = 0;

  for (const heading of headings) {
    if (heading.level !== 2) {
      continue;
    }
    const startOffset = lineStartOffsets[heading.line - 1];
    if (startOffset === undefined || startOffset > documentOrder) {
      break;
    }
    containingH2 = heading;
    containingH2Start = startOffset;
  }

  if (!containingH2) {
    return {
      headingLevel: 0,
      headingTextSnapshot: REVIEW_QUEUE_INTRODUCTION_HEADING,
      sectionKey: REVIEW_QUEUE_INTRODUCTION_SECTION_KEY,
      startOffset: 0
    };
  }

  return {
    headingLevel: 2,
    headingTextSnapshot: containingH2.text,
    sectionKey: `h2:${containingH2.line}:${slugifySectionText(
      containingH2.text
    )}`,
    startOffset: containingH2Start
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

function slugifySectionText(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

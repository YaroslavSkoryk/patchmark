export type MarkdownHeading = {
  level: number;
  text: string;
  line: number;
};

export function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = markdown.split(/\r?\n/);
  let activeFence: "```" | "~~~" | null = null;

  lines.forEach((line, index) => {
    const trimmedStart = line.trimStart();
    const indentation = line.length - trimmedStart.length;
    const fenceMarker = trimmedStart.startsWith("```")
      ? "```"
      : trimmedStart.startsWith("~~~")
        ? "~~~"
        : null;

    if (indentation <= 3 && fenceMarker) {
      activeFence = activeFence === fenceMarker ? null : fenceMarker;
      return;
    }

    if (activeFence) {
      return;
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmedStart);

    if (!match) {
      return;
    }

    const text = match[2].replace(/\s+#+\s*$/, "").trim();

    if (!text) {
      return;
    }

    headings.push({
      level: match[1].length,
      text,
      line: index + 1
    });
  });

  return headings;
}

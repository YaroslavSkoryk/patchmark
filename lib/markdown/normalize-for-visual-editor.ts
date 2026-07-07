const htmlVoidTags = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
];

const htmlVoidTagPattern = new RegExp(
  `<(${htmlVoidTags.join("|")})(\\s[^<>]*?)?>`,
  "gi"
);

export function normalizeMarkdownForVisualEditor(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);
  let activeFence: "```" | "~~~" | null = null;

  return lines
    .map((line) => {
      if (line === "\n" || line === "\r\n") {
        return line;
      }

      const trimmedStart = line.trimStart();
      const indentation = line.length - trimmedStart.length;
      const fenceMarker = trimmedStart.startsWith("```")
        ? "```"
        : trimmedStart.startsWith("~~~")
          ? "~~~"
          : null;

      if (indentation <= 3 && fenceMarker) {
        activeFence = activeFence === fenceMarker ? null : fenceMarker;
        return line;
      }

      if (activeFence) {
        return line;
      }

      return line.replace(htmlVoidTagPattern, (match, tagName, attributes = "") => {
        if (/\/\s*>$/.test(match)) {
          return match;
        }

        return `<${tagName}${attributes} />`;
      });
    })
    .join("");
}

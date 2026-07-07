export function createMarkdownDownloadName(fileName: string | null): string {
  if (!fileName) {
    return "patchmark-document.patchmark.md";
  }

  if (/\.markdown$/i.test(fileName)) {
    return fileName.replace(/\.markdown$/i, ".patchmark.md");
  }

  if (/\.md$/i.test(fileName)) {
    return fileName.replace(/\.md$/i, ".patchmark.md");
  }

  return `${fileName}.patchmark.md`;
}

export function downloadMarkdown(fileName: string | null, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = createMarkdownDownloadName(fileName);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

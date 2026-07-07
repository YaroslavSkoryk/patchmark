"use client";

type MarkdownFileLoaderProps = {
  onFileLoaded: (fileName: string, markdown: string) => void;
};

export function MarkdownFileLoader({ onFileLoaded }: MarkdownFileLoaderProps) {
  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const isMarkdownFile =
      file.name.endsWith(".md") || file.name.endsWith(".markdown");

    if (!isMarkdownFile) {
      event.target.value = "";
      return;
    }

    const markdown = await file.text();
    onFileLoaded(file.name, markdown);
    event.target.value = "";
  }

  return (
    <label className="file-loader-label">
      Load Markdown
      <input
        type="file"
        accept=".md,.markdown,text/markdown,text/x-markdown"
        onChange={handleFileChange}
      />
    </label>
  );
}

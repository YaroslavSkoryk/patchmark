"use client";

type MarkdownSourceEditorProps = {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
};

export function MarkdownSourceEditor({
  markdown,
  onMarkdownChange
}: MarkdownSourceEditorProps) {
  return (
    <textarea
      className="markdown-source-editor"
      aria-label="Markdown Mode"
      spellCheck={false}
      value={markdown}
      onChange={(event) => onMarkdownChange(event.target.value)}
    />
  );
}

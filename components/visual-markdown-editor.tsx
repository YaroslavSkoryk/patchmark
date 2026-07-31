"use client";

import dynamic from "next/dynamic";

const MdxEditorClient = dynamic(
  () =>
    import("@/components/mdx-editor-client").then(
      (module) => module.MdxEditorClient
    ),
  {
    ssr: false,
    loading: () => (
      <div className="visual-editor-loading">Loading Visual Mode...</div>
    )
  }
);

type VisualMarkdownEditorProps = {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  resetKey: number;
  selectionOnly?: boolean;
};

export function VisualMarkdownEditor({
  markdown,
  onMarkdownChange,
  readOnly = false,
  resetKey,
  selectionOnly = false
}: VisualMarkdownEditorProps) {
  return (
    <div className="visual-editor-shell">
      <MdxEditorClient
        markdown={markdown}
        onMarkdownChange={onMarkdownChange}
        readOnly={readOnly}
        resetKey={resetKey}
        selectionOnly={selectionOnly}
      />
    </div>
  );
}

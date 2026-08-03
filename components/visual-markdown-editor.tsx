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
  ariaLabel?: string;
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  resetKey: number;
  selectionOnly?: boolean;
  showToolbar?: boolean;
};

export function VisualMarkdownEditor({
  ariaLabel,
  markdown,
  onMarkdownChange,
  readOnly = false,
  resetKey,
  selectionOnly = false,
  showToolbar = true
}: VisualMarkdownEditorProps) {
  return (
    <div className="visual-editor-shell">
      <MdxEditorClient
        ariaLabel={ariaLabel}
        markdown={markdown}
        onMarkdownChange={onMarkdownChange}
        readOnly={readOnly}
        resetKey={resetKey}
        selectionOnly={selectionOnly}
        showToolbar={showToolbar}
      />
    </div>
  );
}

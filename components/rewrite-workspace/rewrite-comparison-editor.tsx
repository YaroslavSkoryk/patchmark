"use client";

import {
  MarkdownSourceEditor,
  type MarkdownSelection
} from "@/components/markdown-source-editor";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";

export type RewriteEditorMode = "markdown" | "visual";

type RewriteComparisonEditorProps = {
  ariaLabel: string;
  id?: string;
  markdown: string;
  mode: RewriteEditorMode;
  onMarkdownChange: (markdown: string) => void;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  readOnly: boolean;
  resetKey: number;
  selectionRequest?: (MarkdownSelection & { nonce: number }) | null;
};

export function RewriteComparisonEditor({
  ariaLabel,
  id,
  markdown,
  mode,
  onMarkdownChange,
  onSelectionChange,
  readOnly,
  resetKey,
  selectionRequest
}: RewriteComparisonEditorProps) {
  return (
    <div
      className="rewrite-editor-surface"
      data-editor-mode={mode}
      data-read-only={readOnly ? "true" : "false"}
    >
      {mode === "visual" ? (
        <VisualMarkdownEditor
          ariaLabel={ariaLabel}
          markdown={markdown}
          onMarkdownChange={onMarkdownChange}
          readOnly={readOnly}
          resetKey={resetKey}
          selectionOnly={readOnly}
          showToolbar={!readOnly}
        />
      ) : (
        <MarkdownSourceEditor
          ariaLabel={ariaLabel}
          id={id}
          markdown={markdown}
          onMarkdownChange={onMarkdownChange}
          onSelectionChange={onSelectionChange}
          readOnly={readOnly}
          selectionRequest={selectionRequest}
        />
      )}
    </div>
  );
}

"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect } from "react";
import type {
  DocumentEditorReadinessIdentity,
  DocumentEditorReadyDetail
} from "@/components/document-editor-readiness";
import { markDocumentSwitchPerformance } from "@/lib/performance/document-switch-performance";

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
  documentKey?: string | null;
  documentReadiness?: DocumentEditorReadinessIdentity | null;
  markdown: string;
  onDocumentPending?: (detail: DocumentEditorReadyDetail) => void;
  onDocumentReady?: (detail: DocumentEditorReadyDetail) => void;
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  resetKey: number;
  selectionOnly?: boolean;
  showToolbar?: boolean;
};

export function VisualMarkdownEditor({
  ariaLabel,
  documentKey = null,
  documentReadiness = null,
  markdown,
  onDocumentPending,
  onDocumentReady,
  onMarkdownChange,
  readOnly = false,
  resetKey,
  selectionOnly = false,
  showToolbar = true
}: VisualMarkdownEditorProps) {
  useLayoutEffect(() => {
    markDocumentSwitchPerformance(
      documentReadiness?.switchOperationId,
      "mdx_editor_module_available"
    );
  }, [documentReadiness?.switchOperationId]);

  return (
    <div className="visual-editor-shell">
      <MdxEditorClient
        ariaLabel={ariaLabel}
        documentReadiness={documentReadiness}
        editorDocumentKey={documentKey}
        markdown={markdown}
        onDocumentPending={onDocumentPending}
        onDocumentReady={onDocumentReady}
        onMarkdownChange={onMarkdownChange}
        readOnly={readOnly}
        resetKey={resetKey}
        selectionOnly={selectionOnly}
        showToolbar={showToolbar}
      />
    </div>
  );
}

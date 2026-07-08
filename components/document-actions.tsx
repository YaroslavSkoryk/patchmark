"use client";

import { useEffect, useState } from "react";
import { downloadMarkdown } from "@/lib/files/download-markdown";

type CopyState = "idle" | "copied" | "failed";

type DocumentActionsProps = {
  fileName: string;
  isSaving: boolean;
  markdown: string;
  onDownload: () => void;
  onSaveAs: () => void;
  onSaveChanges: () => void;
};

export function DocumentActions({
  fileName,
  isSaving,
  markdown,
  onDownload,
  onSaveAs,
  onSaveChanges
}: DocumentActionsProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const resetTimer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(resetTimer);
  }, [copyState]);

  async function handleCopyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function handleDownloadMarkdown() {
    downloadMarkdown(fileName, markdown);
    onDownload();
  }

  return (
    <div className="document-actions" aria-label="Document actions">
      <button
        className="document-action-primary"
        type="button"
        disabled={isSaving}
        onClick={onSaveChanges}
      >
        Save Changes
      </button>
      <button type="button" disabled={isSaving} onClick={onSaveAs}>
        Save As
      </button>
      <button type="button" onClick={handleDownloadMarkdown}>
        Download .md
      </button>
      <button type="button" onClick={handleCopyMarkdown}>
        Copy Markdown
      </button>
      <span className="copy-status" aria-live="polite">
        {copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </div>
  );
}

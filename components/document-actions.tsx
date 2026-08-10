"use client";

import { useEffect, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

type DocumentActionsProps = {
  isSaving: boolean;
  markdown: string;
  onCreateSnapshot?: () => void;
  onSaveChanges: () => void;
  showCreateSnapshot?: boolean;
};

export function DocumentActions({
  isSaving,
  markdown,
  onCreateSnapshot,
  onSaveChanges,
  showCreateSnapshot = false
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
      {showCreateSnapshot && onCreateSnapshot ? (
        <button type="button" disabled={isSaving} onClick={onCreateSnapshot}>
          Create Snapshot
        </button>
      ) : null}
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

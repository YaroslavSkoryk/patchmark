"use client";

import { useEffect, useState } from "react";
import { downloadMarkdown } from "@/lib/files/download-markdown";

type CopyState = "idle" | "copied" | "failed";

type DocumentActionsProps = {
  fileName: string;
  markdown: string;
  onDownloaded: () => void;
};

export function DocumentActions({
  fileName,
  markdown,
  onDownloaded
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
    onDownloaded();
  }

  return (
    <div className="document-actions" aria-label="Document actions">
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

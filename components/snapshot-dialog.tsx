"use client";

import { useEffect, useMemo, useState } from "react";
import { type PatchmarkVersionEntry } from "@/lib/project/project-types";

export type SnapshotDialogState =
  | {
      kind: "view";
      version: PatchmarkVersionEntry;
      snapshotMarkdown: string;
    }
  | {
      currentMarkdown: string;
      kind: "compare";
      version: PatchmarkVersionEntry;
      snapshotMarkdown: string;
    };

type CopyState = "idle" | "copied" | "failed";

type SnapshotDialogProps = {
  dialog: SnapshotDialogState;
  onClose: () => void;
};

export function SnapshotDialog({ dialog, onClose }: SnapshotDialogProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const currentMarkdown = dialog.kind === "compare" ? dialog.currentMarkdown : "";
  const comparison = useMemo(
    () =>
      dialog.kind === "compare"
        ? compareMarkdown(dialog.snapshotMarkdown, dialog.currentMarkdown)
        : null,
    [dialog]
  );

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const resetTimer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(resetTimer);
  }, [copyState]);

  async function handleCopySnapshotMarkdown() {
    try {
      await navigator.clipboard.writeText(dialog.snapshotMarkdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="snapshot-dialog-backdrop" role="presentation">
      <section
        className="snapshot-dialog"
        role="dialog"
        aria-label={
          dialog.kind === "compare" ? "Compare snapshot" : "View snapshot"
        }
        aria-modal="true"
      >
        <header className="snapshot-dialog-header">
          <div>
            <span>{dialog.kind === "compare" ? "Compare" : "Snapshot"}</span>
            <h2>{dialog.version.id}</h2>
            <p>
              {dialog.version.reason} · {formatSnapshotDate(dialog.version.created_at)}
            </p>
            <p title={dialog.version.file}>{dialog.version.file}</p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="snapshot-dialog-actions">
          <button type="button" onClick={handleCopySnapshotMarkdown}>
            Copy Snapshot Markdown
          </button>
          <span aria-live="polite">
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : ""}
          </span>
        </div>

        {comparison ? (
          <>
            <dl className="snapshot-compare-summary">
              <div>
                <dt>Snapshot length</dt>
                <dd>{comparison.snapshotLength}</dd>
              </div>
              <div>
                <dt>Current length</dt>
                <dd>{comparison.currentLength}</dd>
              </div>
              <div>
                <dt>Line difference</dt>
                <dd>{comparison.lineDifference}</dd>
              </div>
              <div>
                <dt>Identical</dt>
                <dd>{comparison.identical ? "Yes" : "No"}</dd>
              </div>
            </dl>
            <div className="snapshot-compare-grid">
              <label>
                <span>Snapshot Markdown</span>
                <textarea readOnly value={dialog.snapshotMarkdown} />
              </label>
              <label>
                <span>Current Markdown</span>
                <textarea readOnly value={currentMarkdown} />
              </label>
            </div>
          </>
        ) : (
          <label className="snapshot-raw-markdown">
            <span>Raw Markdown</span>
            <textarea readOnly value={dialog.snapshotMarkdown} />
          </label>
        )}
      </section>
    </div>
  );
}

function compareMarkdown(snapshotMarkdown: string, currentMarkdown: string) {
  const snapshotLines = snapshotMarkdown.split(/\r?\n/);
  const currentLines = currentMarkdown.split(/\r?\n/);

  return {
    currentLength: currentMarkdown.length,
    identical: snapshotMarkdown === currentMarkdown,
    lineDifference: currentLines.length - snapshotLines.length,
    snapshotLength: snapshotMarkdown.length
  };
}

function formatSnapshotDate(createdAt: string): string {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

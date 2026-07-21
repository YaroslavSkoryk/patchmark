"use client";

import { useState } from "react";
import { downloadMarkdown } from "@/lib/files/download-markdown";
import type { LegacyUnscopedDocumentDraft } from "@/lib/storage/document-draft-storage";

type LegacyRecoveryPanelProps = {
  drafts: LegacyUnscopedDocumentDraft[];
  onDelete: (storageKey: string) => void;
};

export function LegacyRecoveryPanel({
  drafts,
  onDelete
}: LegacyRecoveryPanelProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  if (drafts.length === 0) {
    return null;
  }

  return (
    <details className="legacy-recovery-panel">
      <summary>Legacy unscoped recovery data ({drafts.length})</summary>
      <p>
        These older browser records are identified only by filename. They are
        quarantined and cannot be restored into a project or file automatically.
      </p>
      <ul>
        {drafts.map((draft) => (
          <li key={draft.storageKey}>
            <div>
              <strong>{draft.fileName}</strong>
              <span>{formatTimestamp(draft.updatedAt)}</span>
            </div>
            <div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(draft.markdown)
                    .then(() => setCopyStatus(`Copied ${draft.fileName}.`))
                    .catch(() => setCopyStatus("Could not copy recovery data."));
                }}
              >
                Copy recovered Markdown
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadMarkdown(
                    `legacy-recovery-${draft.fileName}`,
                    draft.markdown
                  )
                }
              >
                Download recovered Markdown
              </button>
              <button type="button" onClick={() => onDelete(draft.storageKey)}>
                Delete legacy recovery
              </button>
            </div>
          </li>
        ))}
      </ul>
      {copyStatus ? <span role="status">{copyStatus}</span> : null}
    </details>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PatchmarkComment,
  PatchmarkPatch,
  PatchmarkVersionEntry
} from "@/lib/project/project-types";
import {
  createVersionHistoryEntries,
  getSidebarVersionHistoryEntries,
  type VersionHistoryEntryViewModel
} from "@/lib/project/version-history-display";

type VersionHistoryPanelProps = {
  comments: PatchmarkComment[];
  isProjectMode: boolean;
  patches: PatchmarkPatch[];
  versions: PatchmarkVersionEntry[];
  onCompareVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
  onViewVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
};

export function VersionHistoryPanel({
  comments,
  isProjectMode,
  patches,
  versions,
  onCompareVersion,
  onViewVersion
}: VersionHistoryPanelProps) {
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const openArchiveButtonRef = useRef<HTMLButtonElement | null>(null);
  const entries = useMemo(
    () => createVersionHistoryEntries({ comments, patches, versions }),
    [comments, patches, versions]
  );
  const sidebarEntries = getSidebarVersionHistoryEntries(entries);

  function closeArchive() {
    setIsArchiveOpen(false);
    window.requestAnimationFrame(() => openArchiveButtonRef.current?.focus());
  }

  function viewVersion(version: PatchmarkVersionEntry, displayTitle?: string) {
    setIsArchiveOpen(false);
    onViewVersion(version, displayTitle);
  }

  function compareVersion(version: PatchmarkVersionEntry, displayTitle?: string) {
    setIsArchiveOpen(false);
    onCompareVersion(version, displayTitle);
  }

  return (
    <section className="version-history-panel" aria-label="Version History">
      <h2>
        Version History
        {isProjectMode && entries.length > 0 ? <span> · {entries.length}</span> : null}
      </h2>

      {!isProjectMode ? (
        <p className="version-history-empty">
          Version History is available in Project Folder Mode.
        </p>
      ) : entries.length === 0 ? (
        <p className="version-history-empty">
          No snapshots yet.
          <span>Create Snapshot to save a checkpoint.</span>
        </p>
      ) : (
        <>
          <ol className="version-list version-list-compact">
            {sidebarEntries.map((entry) => (
              <VersionHistoryEntryCard
                entry={entry}
                key={`${entry.version.id}-${entry.version.file}`}
                variant="compact"
                onCompareVersion={compareVersion}
                onViewVersion={viewVersion}
              />
            ))}
          </ol>
          <button
            ref={openArchiveButtonRef}
            type="button"
            className="version-history-view-all"
            onClick={() => setIsArchiveOpen(true)}
          >
            View all versions
          </button>
        </>
      )}

      {isArchiveOpen ? (
        <VersionHistoryArchiveDialog
          entries={entries}
          onClose={closeArchive}
          onCompareVersion={compareVersion}
          onViewVersion={viewVersion}
        />
      ) : null}
    </section>
  );
}

function VersionHistoryArchiveDialog({
  entries,
  onClose,
  onCompareVersion,
  onViewVersion
}: {
  entries: VersionHistoryEntryViewModel[];
  onClose: () => void;
  onCompareVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
  onViewVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="snapshot-dialog-backdrop" role="presentation">
      <section
        aria-labelledby="version-history-dialog-title"
        aria-modal="true"
        className="version-history-dialog"
        role="dialog"
      >
        <header className="snapshot-dialog-header version-history-dialog-header">
          <div>
            <span>Version archive</span>
            <h2 id="version-history-dialog-title">All Versions</h2>
            <p>
              Complete snapshot history, newest first. Technical identifiers stay
              in Details.
            </p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="version-history-dialog-body">
          <ol className="version-list version-list-full">
            {entries.map((entry) => (
              <VersionHistoryEntryCard
                entry={entry}
                key={`${entry.version.id}-${entry.version.file}`}
                variant="full"
                onCompareVersion={onCompareVersion}
                onViewVersion={onViewVersion}
              />
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function VersionHistoryEntryCard({
  entry,
  onCompareVersion,
  onViewVersion,
  variant
}: {
  entry: VersionHistoryEntryViewModel;
  onCompareVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
  onViewVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
  variant: "compact" | "full";
}) {
  return (
    <li className={`version-entry version-entry-${variant}`}>
      <div className="version-entry-heading">
        <strong title={entry.title}>{entry.title}</strong>
        <span>{entry.dateLabel}</span>
      </div>
      <div className="version-entry-meta">
        {entry.targetHeading ? <span>{entry.targetHeading}</span> : null}
        <span>{entry.typeLabel}</span>
      </div>
      {variant === "full" && entry.relatedPatchTitle ? (
        <p className="version-related-patch">
          Related patch: {entry.relatedPatchTitle}
        </p>
      ) : null}
      <div className="version-entry-actions">
        <button
          type="button"
          onClick={() => onViewVersion(entry.version, entry.title)}
        >
          View
        </button>
        <button
          type="button"
          onClick={() => onCompareVersion(entry.version, entry.title)}
        >
          Compare
        </button>
      </div>
      {variant === "full" ? (
        <details className="version-entry-details">
          <summary>Details</summary>
          <dl>
            {entry.detailItems.map((detail) => (
              <div key={`${entry.version.id}-${detail.label}`}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

import { type PatchmarkVersionEntry } from "@/lib/project/project-types";

type VersionHistoryPanelProps = {
  isProjectMode: boolean;
  versions: PatchmarkVersionEntry[];
  onCompareVersion: (version: PatchmarkVersionEntry) => void;
  onViewVersion: (version: PatchmarkVersionEntry) => void;
};

export function VersionHistoryPanel({
  isProjectMode,
  versions,
  onCompareVersion,
  onViewVersion
}: VersionHistoryPanelProps) {
  return (
    <section className="version-history-panel" aria-label="Version History">
      <h2>Version History</h2>

      {!isProjectMode ? (
        <p className="version-history-empty">
          Version History is available in Project Folder Mode.
        </p>
      ) : versions.length === 0 ? (
        <p className="version-history-empty">
          No snapshots yet.
          <span>Create Snapshot to save a checkpoint.</span>
        </p>
      ) : (
        <ol className="version-list">
          {versions.map((version) => (
            <li className="version-entry" key={`${version.id}-${version.file}`}>
              <div className="version-entry-heading">
                <strong title={version.id}>{version.id}</strong>
                <span>{formatVersionDate(version.created_at)}</span>
              </div>
              <span className="version-reason">{version.reason}</span>
              <span className="version-file" title={version.file}>
                {getSnapshotFileName(version.file)}
              </span>
              <div className="version-entry-actions">
                <button type="button" onClick={() => onViewVersion(version)}>
                  View
                </button>
                <button type="button" onClick={() => onCompareVersion(version)}>
                  Compare
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatVersionDate(createdAt: string): string {
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

function getSnapshotFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

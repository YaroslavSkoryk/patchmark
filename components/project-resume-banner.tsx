import type {
  FileSystemPermissionState,
  LocalProjectInstanceRecord
} from "@/lib/storage/document-recovery-storage";
import { isUsableStoredDirectoryHandle } from "@/lib/storage/document-recovery-storage";

type ProjectResumeBannerProps = {
  busy: boolean;
  error: string | null;
  permission: FileSystemPermissionState | "unavailable";
  project: LocalProjectInstanceRecord;
  recoveryCount: number;
  onDeleteDeviceData: () => void;
  onResume: () => void;
};

export function ProjectResumeBanner({
  busy,
  error,
  permission,
  project,
  recoveryCount,
  onDeleteDeviceData,
  onResume
}: ProjectResumeBannerProps) {
  const actionLabel =
    isUsableStoredDirectoryHandle(project.directory_handle) &&
    permission !== "denied"
      ? `Resume ${project.project_title_snapshot}`
      : `Reopen ${project.project_title_snapshot} folder`;

  return (
    <section className="project-resume-banner" aria-label="Resume recent project">
      <div>
        <strong>Resume {project.project_title_snapshot}</strong>
        <span>
          Last document: {project.last_document_title_snapshot}
        </span>
        {recoveryCount > 0 ? (
          <span>
            Unsaved changes may be available in {recoveryCount}{" "}
            {recoveryCount === 1 ? "document" : "documents"}.
          </span>
        ) : null}
        <small>
          Resuming reopens the authoritative local project. Browser recovery is
          evaluated only after project and document identity are validated.
        </small>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <div className="project-resume-actions">
        <button
          type="button"
          aria-busy={busy}
          disabled={busy}
          onClick={onResume}
        >
          {busy ? "Opening…" : actionLabel}
        </button>
        <button type="button" disabled={busy} onClick={onDeleteDeviceData}>
          Delete device recovery data
        </button>
      </div>
    </section>
  );
}

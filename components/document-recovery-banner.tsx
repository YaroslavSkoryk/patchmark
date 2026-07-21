import type { DocumentRecoveryRecord } from "@/lib/storage/document-recovery-storage";

export type DocumentRecoveryPresentation = {
  kind: "conflict" | "missing" | "recovered";
  record: DocumentRecoveryRecord;
  reviewOpen: boolean;
  savedMarkdown: string;
};

type DocumentRecoveryBannerProps = {
  presentation: DocumentRecoveryPresentation;
  onDiscard: () => void;
  onKeepSaved: () => void;
  onToggleReview: () => void;
  onUseRecovered: () => void;
};

export function DocumentRecoveryBanner({
  presentation,
  onDiscard,
  onKeepSaved,
  onToggleReview,
  onUseRecovered
}: DocumentRecoveryBannerProps) {
  const { kind, record, reviewOpen, savedMarkdown } = presentation;
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(record.updated_at));
  const isProject = record.owner_type === "project_document";

  return (
    <section
      className={`document-recovery-banner document-recovery-banner-${kind}`}
      aria-label="Document unsaved recovery"
      role={kind === "conflict" ? "alert" : "status"}
    >
      <div className="document-recovery-summary">
        <strong>
          {kind === "conflict"
            ? "Unsaved changes conflict with the saved document"
            : kind === "missing"
              ? "Unsaved changes remain preserved for a missing document"
              : "Unsaved changes recovered"}
        </strong>
        {isProject ? (
          <dl>
            <div>
              <dt>Project</dt>
              <dd>{record.project_title_snapshot}</dd>
            </div>
            {record.group_title_snapshot ? (
              <div>
                <dt>Group</dt>
                <dd>{record.group_title_snapshot}</dd>
              </div>
            ) : null}
            <div>
              <dt>Document</dt>
              <dd>{record.document_title_snapshot}</dd>
            </div>
            <div>
              <dt>Last edited</dt>
              <dd>{updatedAt}</dd>
            </div>
          </dl>
        ) : (
          <dl>
            <div>
              <dt>Standalone file</dt>
              <dd>{record.file_name_snapshot}</dd>
            </div>
            <div>
              <dt>Last edited</dt>
              <dd>{updatedAt}</dd>
            </div>
          </dl>
        )}
        <p>
          {kind === "conflict"
            ? "The saved Markdown changed after this recovery buffer was created. Patchmark will not overwrite either version automatically."
            : kind === "missing"
              ? "Use the existing Locate workflow. Patchmark will not attach this recovery buffer to another file by name."
              : "Recovered Markdown is a dirty working copy. Use the normal Save Changes action to write it to disk."}
        </p>
      </div>
      {kind !== "missing" ? (
        <div className="document-recovery-actions">
          <button type="button" onClick={onToggleReview}>
            {reviewOpen ? "Hide versions" : kind === "conflict" ? "Review versions" : "Review changes"}
          </button>
          {kind === "conflict" ? (
            <>
              <button type="button" onClick={onKeepSaved}>
                Keep saved document
              </button>
              <button type="button" onClick={onUseRecovered}>
                Use recovered changes as working copy
              </button>
            </>
          ) : (
            <button type="button" onClick={onDiscard}>
              Discard recovered changes
            </button>
          )}
        </div>
      ) : null}
      {reviewOpen ? (
        <div className="document-recovery-comparison">
          <section>
            <h3>Current saved Markdown</h3>
            <pre>{savedMarkdown}</pre>
          </section>
          <section>
            <h3>Recovered Markdown</h3>
            <pre>{record.markdown}</pre>
          </section>
        </div>
      ) : null}
    </section>
  );
}

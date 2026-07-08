export type DocumentStatusKind =
  | "saved"
  | "dirty"
  | "restored"
  | "saving"
  | "saveFailed"
  | "saveUnavailable";

type DocumentStatusProps = {
  status: DocumentStatusKind;
};

const statusLabels: Record<DocumentStatusKind, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  restored: "Draft restored",
  saving: "Saving...",
  saveFailed: "Save failed",
  saveUnavailable: "Direct save unavailable"
};

export function DocumentStatus({ status }: DocumentStatusProps) {
  return (
    <span className={`document-status document-status-${status}`}>
      {statusLabels[status]}
    </span>
  );
}

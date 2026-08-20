export type DocumentStatusKind =
  | "saved"
  | "dirty"
  | "restored"
  | "opening"
  | "saving"
  | "saveFailed"
  | "saveUnavailable";

type DocumentStatusProps = {
  status: DocumentStatusKind;
};

const statusLabels: Record<DocumentStatusKind, string> = {
  saved: "Saved",
  dirty: "Unsaved",
  restored: "Restored",
  opening: "Opening…",
  saving: "Saving…",
  saveFailed: "Save failed",
  saveUnavailable: "Unavailable"
};

export function DocumentStatus({ status }: DocumentStatusProps) {
  const label = statusLabels[status];
  const live = status === "opening" || status === "saving";
  return (
    <span
      aria-label={`Document save status: ${label}`}
      aria-live={live ? "polite" : undefined}
      className={`document-status document-status-${status}`}
      role={live ? "status" : undefined}
    >
      {label}
    </span>
  );
}

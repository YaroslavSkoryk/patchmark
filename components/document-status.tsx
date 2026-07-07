export type DocumentStatusKind = "saved" | "dirty" | "restored";

type DocumentStatusProps = {
  status: DocumentStatusKind;
};

const statusLabels: Record<DocumentStatusKind, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  restored: "Draft restored"
};

export function DocumentStatus({ status }: DocumentStatusProps) {
  return (
    <span className={`document-status document-status-${status}`}>
      {statusLabels[status]}
    </span>
  );
}

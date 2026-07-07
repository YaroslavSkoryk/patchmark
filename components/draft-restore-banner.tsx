import type { DocumentDraft } from "@/lib/storage/document-draft-storage";

type DraftRestoreBannerProps = {
  draft: DocumentDraft;
  onRestore: () => void;
  onDiscard: () => void;
};

export function DraftRestoreBanner({
  draft,
  onRestore,
  onDiscard
}: DraftRestoreBannerProps) {
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(draft.updatedAt));

  return (
    <div className="draft-restore-banner" role="status">
      <div>
        <strong>A local draft was found.</strong>
        <span>
          {draft.fileName} - saved in this browser {updatedAt}
        </span>
      </div>
      <div className="draft-restore-actions">
        <button type="button" onClick={onRestore}>
          Restore draft
        </button>
        <button type="button" onClick={onDiscard}>
          Discard draft
        </button>
      </div>
    </div>
  );
}

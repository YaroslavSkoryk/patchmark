export const REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION = 1;

export type PatchmarkDeferredReviewComment = {
  comment_id: string;
  deferred_at: string;
  reason: string | null;
};

export type PatchmarkReviewQueueOverrides = {
  schema_version: typeof REVIEW_QUEUE_OVERRIDES_SCHEMA_VERSION;
  project_id: string;
  document_id: string;
  deferred_comments: PatchmarkDeferredReviewComment[];
};

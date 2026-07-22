export const REVIEW_BATCH_SCHEMA_VERSION = 1;
export const REVIEW_BATCH_PROMPT_BUILDER_VERSION = 1;

export type ReviewBatchSource = "guided_review" | "manual";

export type ReviewBatchType =
  | "follow_up"
  | "document_level"
  | "section"
  | "manual";

export type ReviewBatchStatus =
  | "exported"
  | "response_received"
  | "cancelled";

export type ReviewBatchCancelReason =
  | "user_cancelled"
  | "context_pack_unavailable";

export type ReviewBatchCommentFingerprint = {
  comment_id: string;
  fingerprint: string;
};

export type ReviewBatchContextPack = {
  relative_path: string;
  content_sha256: string;
  bytes: number;
};

export type ReviewBatchSectionSnapshot = {
  section_key_snapshot: string;
  heading_snapshot: string | null;
};

export type ReviewBatchSelectionAdjustment = {
  base_proposal_comment_ids: string[];
  final_comment_ids: string[];
  transiently_removed_comment_ids: string[];
  transiently_added_comment_ids: string[];
};

export type PatchmarkReviewBatch = {
  schema_version: typeof REVIEW_BATCH_SCHEMA_VERSION;
  batch_id: string;
  project_id: string;
  document_id: string;
  source: ReviewBatchSource;
  batch_type: ReviewBatchType;
  ordered_comment_ids: string[];
  section: ReviewBatchSectionSnapshot | null;
  selection_adjustment?: ReviewBatchSelectionAdjustment;
  algorithm_version: number | null;
  prompt_builder_version: typeof REVIEW_BATCH_PROMPT_BUILDER_VERSION;
  document_generation: number;
  batch_record_generation: number;
  document_content_sha256: string;
  comment_fingerprints: ReviewBatchCommentFingerprint[];
  estimated_prompt_tokens: number;
  over_limit_warning: boolean;
  prompt_sha256: string;
  context_pack: ReviewBatchContextPack;
  document_title_snapshot: string;
  status: ReviewBatchStatus;
  created_at: string;
  exported_at: string;
  response_received_at: string | null;
  cancelled_at: string | null;
  cancel_reason: ReviewBatchCancelReason | null;
  import_id: string | null;
};

export type ReviewBatchPromptEnvelope = {
  review_batch_id: string;
  project_id: string;
  document_id: string;
  ordered_comment_ids: string[];
};

export type ReviewBatchResponseIdentity = {
  review_batch_id?: string;
  project_id?: string;
  document_id?: string;
};

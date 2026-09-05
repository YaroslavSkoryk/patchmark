export const REVIEW_BATCH_SCHEMA_VERSION = 1;
export const REVIEW_BATCH_PROMPT_BUILDER_VERSION = 1;
export const REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION = 1;

export type ReviewBatchSource = "guided_review" | "manual";

export type ReviewBatchType =
  | "follow_up"
  | "document_level"
  | "section"
  | "manual";

export type ReviewBatchStatus =
  | "exported"
  | "responded"
  | "responded_partial"
  | "acknowledged"
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

export type ReviewBatchDocumentSnapshot = ReviewBatchContextPack;

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

export type ReviewResponseCoverageStatus = "complete" | "partial";

export type ReviewResponseCommentOutcome = {
  comment_id: string;
  addressed: boolean;
  reply_ids: string[];
  patch_ids: string[];
  clarification_ids: string[];
  explicit_no_change_ids: string[];
  reply_count: number;
  patch_count: number;
  clarification_count: number;
  explicit_no_change_count: number;
};

export type ReviewResponseAggregate = {
  expected_comments: number;
  addressed_comments: number;
  unanswered_comments: number;
  replies_added: number;
  patch_proposals_added: number;
  clarification_questions: number;
  explicit_no_change_responses: number;
};

export type PatchmarkReviewResponseAnalysis = {
  schema_version: typeof REVIEW_RESPONSE_ANALYSIS_SCHEMA_VERSION;
  review_batch_id: string;
  project_id: string;
  document_id: string;
  import_id: string;
  coverage_status: ReviewResponseCoverageStatus;
  analyzed_at: string;
  ordered_comment_outcomes: ReviewResponseCommentOutcome[];
  aggregate: ReviewResponseAggregate;
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
  response_protocol_version?: 2 | 3;
  document_generation: number;
  batch_record_generation: number;
  document_content_sha256: string;
  document_snapshot?: ReviewBatchDocumentSnapshot;
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
  acknowledged_at?: string | null;
  cancelled_at: string | null;
  cancel_reason: ReviewBatchCancelReason | null;
  import_id: string | null;
  response_analysis?: PatchmarkReviewResponseAnalysis | null;
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

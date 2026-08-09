export type RewriteTargetKind = "selection" | "section";

export type RewriteTarget = {
  kind: RewriteTargetKind;
  heading_snapshot: string | null;
  heading_level: number | null;
  heading_path: string[];
  base_start: number;
  base_end: number;
  context_before: string;
  context_after: string;
};

export type RewriteMeaningPreservedItem = {
  point: string;
  current_text_evidence: string;
  rewrite_evidence: string;
};

export type RewriteMeaningChangedItem = {
  topic: string;
  current_meaning: string;
  rewrite_meaning: string;
  assessment: "deliberate" | "possibly_unintentional" | "unclear";
  severity: "low" | "medium" | "high";
};

export type RewriteOmittedPoint = {
  point: string;
  importance: "low" | "medium" | "high";
  reason: string;
};

export type RewriteNewClaim = {
  claim: string;
  relative_support:
    | "present_in_current_text"
    | "partially_present_in_current_text"
    | "not_present_in_current_text";
  note: string;
};

export type RewriteContradiction = {
  issue: string;
  severity: "low" | "medium" | "high";
};

export type RewriteCertaintyChange = {
  topic: string;
  from: string;
  to: string;
  impact: string;
};

export type RewriteSourceImpact = {
  claim_or_source: string;
  impact:
    | "citation_added"
    | "citation_changed"
    | "citation_removed"
    | "source_support_changed"
    | "none";
  note: string;
};

export type RewriteAmbiguity = {
  issue: string;
  suggestion: string;
};

export type RewriteSuggestedDraftEdit = {
  draft_excerpt: string;
  suggested_text: string;
  reason: string;
};

export type RewriteSemanticReviewResponse = {
  protocol: "patchmark.human_rewrite_review_import";
  protocol_version: 1;
  rewrite_session_id: string;
  rewrite_review_id: string;
  project_id: string;
  document_id: string;
  base_text_sha256: string;
  human_draft_sha256: string;
  overall_assessment:
    | "meaning_preserved"
    | "review_recommended"
    | "substantial_change"
    | "unclear";
  summary: string;
  meaning_preserved: RewriteMeaningPreservedItem[];
  meaning_changed: RewriteMeaningChangedItem[];
  omitted_points: RewriteOmittedPoint[];
  new_claims: RewriteNewClaim[];
  contradictions: RewriteContradiction[];
  certainty_changes: RewriteCertaintyChange[];
  source_impacts: RewriteSourceImpact[];
  ambiguities: RewriteAmbiguity[];
  suggested_draft_edits: RewriteSuggestedDraftEdit[];
};

export type RewriteReviewSupersessionReason =
  | "prompt_regenerated"
  | "outdated_prompt_format"
  | "draft_changed"
  | "intent_changed";

export type RewriteReviewRound = {
  rewrite_review_id: string;
  request_project_id: string;
  request_document_id: string;
  base_text_sha256: string;
  human_draft_sha256: string;
  intent_note_sha256: string;
  prompt_sha256: string;
  prompt_text: string;
  prompt_byte_length?: number;
  exported_at: string;
  prompt_schema_version?: number;
  response_schema_fingerprint?: string;
  prompt_created_at?: string;
  prompt_generator_version?: string;
  status: "awaiting_response" | "cancelled" | "imported" | "superseded";
  cancelled_at?: string;
  imported_at?: string;
  superseded_at?: string;
  superseded_reason?: RewriteReviewSupersessionReason;
  superseded_by_review_request_id?: string;
  supersedes_review_request_id?: string;
  response?: RewriteSemanticReviewResponse;
};

export type RewriteReferenceHistoryEntry = {
  base_document_generation: number;
  base_document_sha256: string;
  base_text_sha256: string;
  base_text: string;
  refreshed_at: string;
};

export type RewriteSession = {
  schema_version: 1;
  rewrite_session_id: string;
  local_project_instance_id: string;
  project_id: string;
  document_id: string;
  project_title_snapshot: string;
  document_title_snapshot: string;
  target: RewriteTarget;
  base_document_generation: number;
  base_document_sha256: string;
  base_text_sha256: string;
  base_text: string;
  human_draft_sha256: string;
  human_draft: string;
  intent_note: string;
  status: "draft";
  authoritative_revision: number;
  authoritative_generation: number;
  stale_reference: boolean;
  created_at: string;
  updated_at: string;
  review_rounds: RewriteReviewRound[];
  reference_history: RewriteReferenceHistoryEntry[];
};

export type RewriteTerminalSession = {
  schema_version: 1;
  rewrite_session_id: string;
  local_project_instance_id: string;
  project_id: string;
  document_id: string;
  status: "applied" | "discarded";
  authoritative_revision: number;
  authoritative_generation: number;
  human_draft_sha256: string;
  updated_at: string;
  applied_at?: string;
  discarded_at?: string;
  version_id?: string;
};

export type RewriteProjectSessionRecord =
  | RewriteSession
  | RewriteTerminalSession;

export type RewriteProjectSessionStore = {
  schema_version: 1;
  project_id: string;
  document_id: string;
  sessions: RewriteProjectSessionRecord[];
};

export type RewriteRecoveryRecord = {
  schema_version: 1;
  record_kind: "rewrite_recovery";
  sync_state: "recovery_only" | "synchronized";
  storage_key: string;
  rewrite_session_id: string;
  local_project_instance_id: string;
  project_id: string;
  document_id: string;
  based_on_authoritative_revision: number;
  recovery_revision: number;
  session: RewriteSession;
  saved_at: string;
};

export type RewriteReviewRequest = {
  rewrite_review_id: string;
  prompt_sha256: string;
  prompt_text: string;
  session: RewriteSession;
};

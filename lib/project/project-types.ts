export type PatchmarkVersionEntry = {
  id: string;
  file: string;
  created_at: string;
  reason: string;
  content_hash?: string;
};

export type PatchmarkCommentType =
  | "note"
  | "question"
  | "risk"
  | "research_needed"
  | "decision_needed";

export type PatchmarkCommentStatus = "open" | "resolved";

export type PatchmarkCommentFocusState =
  | "idle"
  | "in_focus"
  | "exported"
  | "awaiting_reply"
  | "reply_received";

export type PatchmarkCommentActionScope =
  | "display_target"
  | "anchor_context"
  | "containing_section"
  | "full_document";

export type PatchmarkCommentActionIntent =
  | "note"
  | "review"
  | "rewrite"
  | "research"
  | "risk_review"
  | "decision";

export type PatchmarkCommentActionContext = {
  default_scope: PatchmarkCommentActionScope;
  include_document_brief: boolean;
  include_open_comments: "none" | "same_section" | "focused_only" | "all";
  intent_hint: PatchmarkCommentActionIntent;
};

export type PatchmarkCommentThreadEntry = {
  id: string;
  role: "user" | "chatgpt" | "system";
  content: string;
  created_at: string;
  source_import_id?: string;
  source_chat_url?: string;
  source_patch_id?: string;
  suggested_user_action?: PatchmarkSuggestedUserAction;
  sources?: PatchmarkSourceReference[];
};

export type PatchmarkCommentExportState = {
  focus_state: PatchmarkCommentFocusState;
  marked_for_export_at?: string;
  last_exported_at?: string;
  last_export_id?: string;
  last_imported_at?: string;
  last_import_id?: string;
};

export type PatchmarkSuggestedUserAction =
  | "review"
  | "clarify"
  | "apply_patch"
  | "keep_open"
  | "resolve_manually";

export type PatchmarkSourceReference = {
  title?: string;
  url: string;
  note?: string;
  supports?: string;
};

export type PatchmarkCommentReplyImport = {
  protocol: "patchmark.comment_reply_import";
  protocol_version: 1;
  summary?: string;
  sources?: PatchmarkSourceReference[];
  replies: Array<{
    comment_id: string;
    reply: string;
    reply_sources?: PatchmarkSourceReference[];
    suggested_user_action?: PatchmarkSuggestedUserAction;
    sources?: PatchmarkSourceReference[];
  }>;
  patch_proposals: Array<{
    comment_id: string;
    target_heading?: string;
    original_text: string;
    suggested_text: string;
    suggested_text_sources?: PatchmarkSourceReference[];
    reason: string;
    reason_sources?: PatchmarkSourceReference[];
    risk?: string;
    risk_sources?: PatchmarkSourceReference[];
    sources?: PatchmarkSourceReference[];
  }>;
  open_questions: Array<{
    comment_id: string;
    question: string;
    question_sources?: PatchmarkSourceReference[];
  }>;
};

export type PatchmarkSelectedTextAnchorContextKind =
  | "sentence"
  | "paragraph"
  | "heading"
  | "list_item"
  | "table_cell"
  | "blockquote"
  | "block"
  | "section";

export type PatchmarkSelectedTextAnchorContext = {
  kind: PatchmarkSelectedTextAnchorContextKind;
  plain_text: string;
  markdown_text?: string;
  selected_start_in_context?: number;
  selected_end_in_context?: number;
  context_hash?: string;
  markdown_start_offset?: number;
  markdown_end_offset?: number;
};

export type PatchmarkCommentAnchor =
  | {
      kind: "document";
      action_context?: PatchmarkCommentActionContext;
    }
  | {
      kind: "section";
      heading: string;
      heading_level?: number;
      heading_line?: number;
      heading_path?: string[];
      section_start_offset?: number;
      section_end_offset?: number;
      action_context?: PatchmarkCommentActionContext;
    }
  | {
      kind: "selected_text";
      selected_text: string;
      selected_text_hash?: string;
      anchor_context?: PatchmarkSelectedTextAnchorContext;
      markdown_start_offset?: number;
      markdown_end_offset?: number;
      context_before?: string;
      context_after?: string;
      containing_heading?: string;
      containing_heading_level?: number;
      containing_heading_line?: number;
      containing_heading_path?: string[];
      anchor_source?: "visual" | "markdown" | "patch";
      fallback_section_start_offset?: number;
      fallback_section_end_offset?: number;
      action_context?: PatchmarkCommentActionContext;
      anchor_text?: string;
      anchor_text_source?: "selected" | "expanded_sentence" | "expanded_block";
      anchor_text_hash?: string;
    };

export type CommentAnchorStatus =
  | "active"
  | "not_found"
  | "ambiguous"
  | "document";

export type PatchCommentImpactKind =
  | "linked_comment"
  | "anchor_inside_replaced_range"
  | "anchor_intersects_replaced_range"
  | "anchor_after_replaced_range"
  | "section_may_have_shifted"
  | "unaffected";

export type PatchmarkManifest = {
  schema_version: 1;
  project_name: string;
  document_file: "document.md";
  created_at: string;
  updated_at: string;
  current_version?: string;
  versions?: PatchmarkVersionEntry[];
};

export type PatchmarkCommentAnchorHistoryEntry = {
  changed_at: string;
  reason:
    | "patch_applied"
    | "offset_shifted_after_patch"
    | "anchor_recovered_after_patch"
    | "anchor_reanchored_after_patch"
    | "anchor_marked_needs_review_after_patch";
  source_patch_id?: string;
  previous_anchor: PatchmarkCommentAnchor;
  new_anchor?: PatchmarkCommentAnchor;
  impact_kind?: PatchCommentImpactKind;
};

export type PatchmarkCommentPatchImpact = {
  patch_id: string;
  impacted_at: string;
  impact_kind: PatchCommentImpactKind;
  result: "reanchored" | "offset_shifted" | "unchanged" | "needs_review";
  note?: string;
};

export type PatchmarkComment = {
  id: string;
  type: PatchmarkCommentType;
  status: PatchmarkCommentStatus;
  anchor: PatchmarkCommentAnchor;
  comment: string;
  thread: PatchmarkCommentThreadEntry[];
  export_state: PatchmarkCommentExportState;
  anchor_history?: PatchmarkCommentAnchorHistoryEntry[];
  patch_impacts?: PatchmarkCommentPatchImpact[];
  created_at: string;
  updated_at: string;
  resolved_at?: string;
};

export type PatchmarkPatchStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "stale";

export type PatchmarkPatch = {
  id: string;
  status: PatchmarkPatchStatus;
  patch_group_id?: string;
  patch_group_index?: number;
  patch_group_total?: number;
  comment_id?: string;
  source_import_id?: string;
  source_chat_url?: string;
  target_heading?: string;
  original_text: string;
  suggested_text: string;
  suggested_text_sources?: PatchmarkSourceReference[];
  reason: string;
  reason_sources?: PatchmarkSourceReference[];
  risk?: string;
  risk_sources?: PatchmarkSourceReference[];
  sources?: PatchmarkSourceReference[];
  created_at: string;
  resolved_at?: string;
  accepted_at?: string;
  applied_at?: string;
  rejected_at?: string;
  pre_apply_snapshot_id?: string;
  pre_apply_snapshot_file?: string;
  applied_text?: string;
  applied_start_offset?: number;
  applied_end_offset?: number;
  applied_context_before?: string;
  applied_context_after?: string;
  applied_heading?: string;
  applied_heading_id?: string;
  applied_heading_path?: string[];
  applied_table_index?: number;
  applied_table_row_index?: number;
  applied_table_row_anchor?: string;
  applied_table_row_cells?: string[];
  previous_original_text?: string;
  reanchored_at?: string;
  reanchor_reason?: "table_row_normalized_match";
};

export type PatchmarkPatchGroup = {
  id: string;
  comment_id?: string;
  source_import_id?: string;
  source_chat_url?: string;
  patches: PatchmarkPatch[];
  created_at: string;
  status_summary: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    stale: number;
  };
};

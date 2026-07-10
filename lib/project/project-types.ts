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
  include_open_comments: "none" | "same_section" | "all";
  intent_hint?: PatchmarkCommentActionIntent;
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
      anchor_source?: "visual" | "markdown";
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

export type PatchmarkManifest = {
  schema_version: 1;
  project_name: string;
  document_file: "document.md";
  created_at: string;
  updated_at: string;
  current_version?: string;
  versions?: PatchmarkVersionEntry[];
};

export type PatchmarkComment = {
  id: string;
  type: PatchmarkCommentType;
  status: PatchmarkCommentStatus;
  anchor: PatchmarkCommentAnchor;
  comment: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
};

export type PatchmarkPatch = {
  id: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  target_heading?: string;
  original_text: string;
  suggested_text: string;
  reason?: string;
  risk?: string;
  created_at: string;
  resolved_at?: string;
};

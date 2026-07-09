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
  target_heading?: string;
  target_heading_level?: number;
  target_heading_line?: number;
  target_heading_path?: string[];
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

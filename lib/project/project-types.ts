export type PatchmarkVersionEntry = {
  id: string;
  file: string;
  created_at: string;
  reason: string;
};

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
  status: "open" | "resolved";
  target_heading?: string;
  selected_text?: string;
  comment: string;
  created_at: string;
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

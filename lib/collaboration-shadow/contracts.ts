export const COLLABORATION_SHADOW_RECEIPT_VERSION = 1 as const;
export const COLLABORATION_SHADOW_NAMESPACE_VERSION = 1 as const;

export const collaborationShadowMutationKinds = [
  "document_save",
  "comment_mutation",
  "patch_import",
  "patch_edit",
  "patch_decision",
  "review_batch_mutation",
  "rewrite_terminal",
  "shared_metadata_mutation"
] as const;

export type CollaborationShadowMutationKind =
  (typeof collaborationShadowMutationKinds)[number];

export type ShadowLegacyAnchor = Readonly<{
  kind: "document" | "section" | "selected_text";
  key: string;
}>;

export type ShadowLegacyReply = Readonly<{
  source_reply_id: string;
  body: string;
  tombstone: boolean;
}>;

export type ShadowLegacyComment = Readonly<{
  source_comment_id: string;
  body: string;
  anchor: ShadowLegacyAnchor;
  status: "open" | "resolved";
  trash_status: "active" | "trashed";
  tombstone: boolean;
  replies: readonly ShadowLegacyReply[];
}>;

export type ShadowLegacyPatch = Readonly<{
  source_patch_id: string;
  source_comment_id: string | null;
  version_fingerprint: string;
  dependency_source_patch_ids: readonly string[];
  target_provenance: string | null;
  status: "pending" | "accepted" | "rejected" | "stale";
}>;

export type ShadowLegacyReviewBatch = Readonly<{
  source_review_batch_id: string;
  lifecycle: "active" | "responded" | "cancelled";
  response_hash: string | null;
}>;

export type ShadowLegacyRewrite = Readonly<{
  source_rewrite_session_id: string;
  outcome: "active" | "applied" | "discarded";
}>;

export type ShadowLegacyDocumentContent = Readonly<{
  exact_markdown_bytes: Uint8Array;
  comments: readonly ShadowLegacyComment[];
  patches: readonly ShadowLegacyPatch[];
  review_batches: readonly ShadowLegacyReviewBatch[];
  rewrite_sessions: readonly ShadowLegacyRewrite[];
}>;

export type ShadowLegacyDocument = Readonly<{
  source_document_id: string;
  title: string;
  logical_path: string;
  position: string;
  source_group_id: string | null;
  archive_status: "active" | "archived";
  tombstone: boolean;
  content: ShadowLegacyDocumentContent | null;
}>;

export type ShadowLegacyGroup = Readonly<{
  source_group_id: string;
  title: string;
  position: string;
}>;

export type ShadowLegacySharedState = Readonly<{
  project_title: string;
  group_order: readonly string[];
  groups: readonly ShadowLegacyGroup[];
  document_order: readonly string[];
  documents: readonly ShadowLegacyDocument[];
}>;

export type ShadowLegacyCommitReceipt =
  | Readonly<{
      commit_kind: "project_save";
      status: "committed";
      generation: number;
      commit_id: string;
      changed_files: readonly string[];
      source_state_commitment: string;
    }>
  | Readonly<{
      commit_kind: "project_registry";
      status: "committed";
      manifest_revision: number;
      source_state_commitment: string;
    }>;

export type CollaborationShadowMutationReceipt = Readonly<{
  schema_version: typeof COLLABORATION_SHADOW_RECEIPT_VERSION;
  object_kind: "collaboration_shadow_mutation_receipt";
  source_project_instance_commitment: string;
  source_project_id: string;
  source_document_id: string;
  mutation_kind: CollaborationShadowMutationKind;
  mutation_key: string;
  legacy_commit: ShadowLegacyCommitReceipt;
  committed_shared_state: ShadowLegacySharedState;
}>;

export const shadowEquivalenceOutcomes = [
  "equivalent",
  "source_changed_before_shadow",
  "missing_mapping",
  "shadow_dependency_missing",
  "projection_mismatch",
  "root_mismatch",
  "shadow_corrupt",
  "shadow_unavailable"
] as const;

export type ShadowEquivalenceOutcome =
  (typeof shadowEquivalenceOutcomes)[number];

export type CollaborationShadowResult = Readonly<{
  mode: "development_shadow";
  outcome: ShadowEquivalenceOutcome;
  source_project_id: string | null;
  shadow_project_id: string | null;
  requires_rebootstrap: boolean;
  diagnostic: string;
}>;

export type CollaborationShadowDisabledSentinel = Readonly<{
  mode: "disabled";
  outcome: "disabled";
}>;

export const collaborationRoles = ["owner", "editor", "reviewer"] as const;

export type CollaborationRole = (typeof collaborationRoles)[number];

export const collaborationCapabilities = [
  "read_project_content",
  "edit_markdown",
  "create_revision",
  "adopt_revision",
  "create_comment",
  "create_reply",
  "edit_comment",
  "resolve_comment",
  "propose_patch",
  "import_model_work",
  "accept_patch",
  "reject_patch",
  "authorize_safe_merge",
  "resolve_content_conflict",
  "create_document",
  "create_group",
  "invite_person",
  "remove_person",
  "authorize_device",
  "revoke_device",
  "change_role",
  "rotate_key_epoch",
  "recover_control"
] as const;

export type CollaborationCapability =
  (typeof collaborationCapabilities)[number];

const reviewerCapabilities = [
  "read_project_content",
  "create_comment",
  "create_reply",
  "edit_comment",
  "resolve_comment",
  "propose_patch",
  "import_model_work"
] as const satisfies readonly CollaborationCapability[];

const editorCapabilities = [
  ...reviewerCapabilities,
  "edit_markdown",
  "create_revision",
  "adopt_revision",
  "accept_patch",
  "reject_patch",
  "authorize_safe_merge",
  "resolve_content_conflict",
  "create_document",
  "create_group"
] as const satisfies readonly CollaborationCapability[];

const roleCapabilities = {
  owner: collaborationCapabilities,
  editor: editorCapabilities,
  reviewer: reviewerCapabilities
} as const satisfies Record<
  CollaborationRole,
  readonly CollaborationCapability[]
>;

export function capabilitiesForRole(
  role: CollaborationRole
): readonly CollaborationCapability[] {
  switch (role) {
    case "owner":
      return roleCapabilities.owner;
    case "editor":
      return roleCapabilities.editor;
    case "reviewer":
      return roleCapabilities.reviewer;
  }
}

export function roleHasCapability(
  role: CollaborationRole,
  capability: CollaborationCapability
): boolean {
  return capabilitiesForRole(role).includes(capability);
}

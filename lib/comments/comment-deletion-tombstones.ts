import type {
  PatchmarkCommentDeletionTombstone,
  PatchmarkCommentStatus,
  PatchmarkDeletedPatchTombstone,
  PatchmarkPatchStatus
} from "../project/project-types.ts";

const patchStatuses: PatchmarkPatchStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "stale"
];
const commentStatuses: PatchmarkCommentStatus[] = ["open", "resolved"];

export function normalizeCommentDeletionTombstones({
  documentId,
  projectId,
  value
}: {
  documentId: string;
  projectId: string;
  value: unknown;
}): PatchmarkCommentDeletionTombstone[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidTombstones();
  }

  const tombstones = value.map((candidate) =>
    normalizeCommentDeletionTombstone({ candidate, documentId, projectId })
  );
  if (
    new Set(tombstones.map((tombstone) => tombstone.comment_id)).size !==
    tombstones.length
  ) {
    throw new Error(
      ".patchmark/manifest.json contains duplicate comment deletion tombstones."
    );
  }
  return tombstones;
}

export function getDeletedCommentTombstone(
  tombstones: readonly PatchmarkCommentDeletionTombstone[],
  commentId: string
): PatchmarkCommentDeletionTombstone | null {
  return (
    tombstones.find((tombstone) => tombstone.comment_id === commentId) ?? null
  );
}

function normalizeCommentDeletionTombstone({
  candidate,
  documentId,
  projectId
}: {
  candidate: unknown;
  documentId: string;
  projectId: string;
}): PatchmarkCommentDeletionTombstone {
  if (
    !isRecord(candidate) ||
    candidate.schema_version !== 1 ||
    candidate.project_id !== projectId ||
    candidate.document_id !== documentId ||
    typeof candidate.comment_id !== "string" ||
    !candidate.comment_id.trim() ||
    typeof candidate.permanently_deleted_at !== "string" ||
    Number.isNaN(Date.parse(candidate.permanently_deleted_at)) ||
    typeof candidate.permanent_delete_operation_id !== "string" ||
    !candidate.permanent_delete_operation_id.trim() ||
    !commentStatuses.includes(candidate.original_status as PatchmarkCommentStatus) ||
    typeof candidate.had_accepted_patches !== "boolean" ||
    !Array.isArray(candidate.patches)
  ) {
    throw invalidTombstones();
  }

  const patches = candidate.patches.map(normalizeDeletedPatchTombstone);
  if (
    new Set(patches.map((patch) => patch.patch_id)).size !== patches.length ||
    candidate.had_accepted_patches !==
      patches.some((patch) => patch.status === "accepted")
  ) {
    throw invalidTombstones();
  }

  return {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    comment_id: candidate.comment_id,
    permanently_deleted_at: candidate.permanently_deleted_at,
    permanent_delete_operation_id:
      candidate.permanent_delete_operation_id,
    original_status: candidate.original_status as PatchmarkCommentStatus,
    had_accepted_patches: candidate.had_accepted_patches,
    patches
  };
}

function normalizeDeletedPatchTombstone(
  candidate: unknown
): PatchmarkDeletedPatchTombstone {
  if (
    !isRecord(candidate) ||
    typeof candidate.patch_id !== "string" ||
    !candidate.patch_id.trim() ||
    !patchStatuses.includes(candidate.status as PatchmarkPatchStatus)
  ) {
    throw invalidTombstones();
  }
  return {
    patch_id: candidate.patch_id,
    status: candidate.status as PatchmarkPatchStatus
  };
}

function invalidTombstones(): Error {
  return new Error(
    ".patchmark/manifest.json contains invalid comment deletion tombstones."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

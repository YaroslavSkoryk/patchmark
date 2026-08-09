import type { PatchmarkComment } from "../project/project-types.ts";

export type PatchmarkCommentTrashMetadata = Pick<
  PatchmarkComment,
  "restored_at" | "trash_operation_id" | "trashed_at"
>;

export function normalizeCommentTrashMetadata(
  value: Record<string, unknown>
): PatchmarkCommentTrashMetadata {
  const trashedAt = normalizeOptionalTimestamp(value.trashed_at, "trashed_at");
  const trashOperationId = normalizeOptionalString(
    value.trash_operation_id,
    "trash_operation_id"
  );
  const restoredAt = normalizeOptionalTimestamp(value.restored_at, "restored_at");

  if (Boolean(trashedAt) !== Boolean(trashOperationId)) {
    throw new Error(
      ".patchmark/comments.json contains inconsistent comment Trash metadata."
    );
  }

  return {
    ...(trashedAt ? { trashed_at: trashedAt } : {}),
    ...(trashOperationId ? { trash_operation_id: trashOperationId } : {}),
    ...(restoredAt ? { restored_at: restoredAt } : {})
  };
}

function normalizeOptionalString(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `.patchmark/comments.json contains invalid ${field} metadata.`
    );
  }

  return value;
}

function normalizeOptionalTimestamp(
  value: unknown,
  field: string
): string | undefined {
  const normalized = normalizeOptionalString(value, field);

  if (normalized && Number.isNaN(Date.parse(normalized))) {
    throw new Error(
      `.patchmark/comments.json contains invalid ${field} metadata.`
    );
  }

  return normalized;
}

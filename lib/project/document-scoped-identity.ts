export const legacyDocumentScopeId = "legacy-document";

export const documentScopedIdentifierKinds = [
  "comment",
  "patch",
  "patch_group",
  "version",
  "snapshot",
  "source_import",
  "save_commit",
  "persistence_generation",
  "review_batch"
] as const;

export const projectScopedIdentifierKinds = [
  "project",
  "document",
  "assembly_transaction",
  "project_manifest_revision"
] as const;

export type DocumentScopedIdentifierKind =
  (typeof documentScopedIdentifierKinds)[number];

export type ProjectScopedIdentifierKind =
  (typeof projectScopedIdentifierKinds)[number];

export type DocumentScopedId<
  TKind extends DocumentScopedIdentifierKind = DocumentScopedIdentifierKind
> = Readonly<{
  documentId: string;
  id: string;
  kind: TKind;
}>;

export type CommentRef = DocumentScopedId<"comment">;
export type PatchRef = DocumentScopedId<"patch">;
export type VersionRef = DocumentScopedId<"version">;

export type ReplyRef = Readonly<{
  documentId: string;
  commentId: string;
  replyId: string;
  kind: "reply";
}>;

export type AnchorHistoryRef = Readonly<{
  documentId: string;
  commentId: string;
  historyId: string;
  kind: "anchor_history";
}>;

export function createDocumentScopedId<
  TKind extends DocumentScopedIdentifierKind
>(
  kind: TKind,
  documentId: string,
  id: string
): DocumentScopedId<TKind> {
  return Object.freeze({
    documentId: requireIdentityPart(documentId, "document_id"),
    id: requireIdentityPart(id, `${kind}_id`),
    kind
  });
}

export function createCommentRef(
  documentId: string,
  commentId: string
): CommentRef {
  return createDocumentScopedId("comment", documentId, commentId);
}

export function createPatchRef(
  documentId: string,
  patchId: string
): PatchRef {
  return createDocumentScopedId("patch", documentId, patchId);
}

export function createVersionRef(
  documentId: string,
  versionId: string
): VersionRef {
  return createDocumentScopedId("version", documentId, versionId);
}

export function createReplyRef(
  documentId: string,
  commentId: string,
  replyId: string
): ReplyRef {
  return Object.freeze({
    documentId: requireIdentityPart(documentId, "document_id"),
    commentId: requireIdentityPart(commentId, "comment_id"),
    replyId: requireIdentityPart(replyId, "reply_id"),
    kind: "reply"
  });
}

export function createAnchorHistoryRef(
  documentId: string,
  commentId: string,
  historyId: string
): AnchorHistoryRef {
  return Object.freeze({
    documentId: requireIdentityPart(documentId, "document_id"),
    commentId: requireIdentityPart(commentId, "comment_id"),
    historyId: requireIdentityPart(historyId, "history_id"),
    kind: "anchor_history"
  });
}

export function createDocumentScopedKey(
  reference:
    | DocumentScopedId
    | ReplyRef
    | AnchorHistoryRef
): string {
  if (reference.kind === "reply") {
    return JSON.stringify([
      reference.kind,
      reference.documentId,
      reference.commentId,
      reference.replyId
    ]);
  }
  if (reference.kind === "anchor_history") {
    return JSON.stringify([
      reference.kind,
      reference.documentId,
      reference.commentId,
      reference.historyId
    ]);
  }
  return JSON.stringify([
    reference.kind,
    reference.documentId,
    reference.id
  ]);
}

export function assertDocumentScope(
  reference: { documentId: string },
  expectedDocumentId: string
): void {
  if (reference.documentId !== expectedDocumentId) {
    throw new Error(
      `Document-scoped operation belongs to ${reference.documentId}, not ${expectedDocumentId}.`
    );
  }
}

export function isDocumentScopeCurrent(
  reference: { documentId: string } | null,
  currentDocumentId: string | null
): boolean {
  return Boolean(
    reference &&
      currentDocumentId &&
      reference.documentId === currentDocumentId
  );
}

export function findDocumentScopedValue<T>({
  documentId,
  getId,
  reference,
  values
}: {
  documentId: string;
  getId: (value: T) => string;
  reference: DocumentScopedId;
  values: readonly T[];
}): T | null {
  assertDocumentScope(reference, documentId);
  return values.find((value) => getId(value) === reference.id) ?? null;
}

export function assertUniqueDocumentLocalIds({
  documentId,
  ids,
  kind
}: {
  documentId: string;
  ids: readonly string[];
  kind: string;
}): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const normalizedId = requireIdentityPart(id, `${kind}_id`);
    if (seen.has(normalizedId)) {
      throw new Error(
        `Duplicate ${kind} ID ${normalizedId} inside document ${documentId}.`
      );
    }
    seen.add(normalizedId);
  }
}

function requireIdentityPart(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required for document-scoped identity.`);
  }
  return value;
}

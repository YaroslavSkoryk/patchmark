import type {
  CommentAnchorStatus,
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";

export type CommentTrashSelectionIdentity = {
  commentId: string;
  documentId: string;
  projectId: string;
};

export type CommentTrashBlocker =
  | {
      batchId: string;
      commentIds: string[];
      kind: "active_review_batch";
    }
  | {
      commentId: string;
      kind: "active_reanchor";
    }
  | {
      commentIds: string[];
      kind: "unsaved_draft";
    };

export type CommentTrashSummary = {
  acceptedPatches: number;
  activeOrUnresolvedAnchors: number;
  blockedComments: number;
  blockers: CommentTrashBlocker[];
  documentComments: number;
  linkedReviewBatchComments: number;
  pendingPatches: number;
  rejectedPatches: number;
  replies: number;
  selectedComments: number;
  selectionFingerprint: string;
  stalePatches: number;
  unresolvedAnchors: number;
};

export class CommentTrashOperationError extends Error {
  readonly code:
    | "already_active"
    | "already_trashed"
    | "blocked"
    | "duplicate_comment_id"
    | "empty_selection"
    | "identity_mismatch"
    | "missing_comment"
    | "stale_selection";

  constructor(
    code: CommentTrashOperationError["code"],
    message: string
  ) {
    super(message);
    this.name = "CommentTrashOperationError";
    this.code = code;
  }
}

export function createCommentTrashSelectionKey({
  commentId,
  documentId,
  projectId
}: CommentTrashSelectionIdentity): string {
  return JSON.stringify([projectId, documentId, commentId]);
}

export function isCommentTrashed(comment: PatchmarkComment): boolean {
  return Boolean(comment.trashed_at && comment.trash_operation_id);
}

export function getActiveComments(
  comments: readonly PatchmarkComment[]
): PatchmarkComment[] {
  return comments.filter((comment) => !isCommentTrashed(comment));
}

export function getVisibleActiveComments({
  comments,
  searchQuery = "",
  status = "all"
}: {
  comments: readonly PatchmarkComment[];
  searchQuery?: string;
  status?: "all" | PatchmarkComment["status"];
}): PatchmarkComment[] {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  return getActiveComments(comments).filter(
    (comment) =>
      (status === "all" || comment.status === status) &&
      (!normalizedQuery ||
        comment.id.toLocaleLowerCase().includes(normalizedQuery) ||
        comment.comment.toLocaleLowerCase().includes(normalizedQuery))
  );
}

export function getTrashedComments(
  comments: readonly PatchmarkComment[]
): PatchmarkComment[] {
  const originalOrder = new Map(
    comments.map((comment, index) => [comment.id, index])
  );

  return comments
    .filter(isCommentTrashed)
    .sort(
      (first, second) =>
        (second.trashed_at ?? "").localeCompare(first.trashed_at ?? "") ||
        (originalOrder.get(first.id) ?? Number.POSITIVE_INFINITY) -
          (originalOrder.get(second.id) ?? Number.POSITIVE_INFINITY) ||
        first.id.localeCompare(second.id)
    );
}

export function buildCommentTrashSummary({
  activeReanchorCommentId = null,
  anchorStatuses = {},
  commentIds,
  comments,
  currentDocumentId,
  currentProjectId,
  documentId,
  patches,
  projectId,
  reviewBatches,
  unsavedDraftCommentIds = []
}: {
  activeReanchorCommentId?: string | null;
  anchorStatuses?: Readonly<Record<string, CommentAnchorStatus>>;
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  unsavedDraftCommentIds?: readonly string[];
}): CommentTrashSummary {
  validateIdentity({
    currentDocumentId,
    currentProjectId,
    documentId,
    projectId
  });
  const selectedComments = getSelectedComments({
    commentIds,
    comments,
    expectedTrashState: "active"
  });
  const selectedIds = new Set(commentIds);
  const selectedPatches = patches.filter(
    (patch) => patch.comment_id && selectedIds.has(patch.comment_id)
  );
  const blockers = getCommentTrashBlockers({
    activeReanchorCommentId,
    commentIds,
    reviewBatches,
    unsavedDraftCommentIds
  });
  const blockedCommentIds = new Set(
    blockers.flatMap((blocker) =>
      blocker.kind === "active_reanchor"
        ? [blocker.commentId]
        : blocker.commentIds
    )
  );
  const unresolvedAnchors = selectedComments.filter((comment) => {
    const status = anchorStatuses[comment.id];
    return status === "ambiguous" || status === "not_found";
  }).length;

  return {
    acceptedPatches: selectedPatches.filter(
      (patch) => patch.status === "accepted"
    ).length,
    activeOrUnresolvedAnchors: selectedComments.filter(
      (comment) => comment.anchor.kind !== "document"
    ).length,
    blockedComments: blockedCommentIds.size,
    blockers,
    documentComments: selectedComments.filter(
      (comment) => comment.anchor.kind === "document"
    ).length,
    linkedReviewBatchComments: selectedComments.filter((comment) =>
      reviewBatches.some((batch) =>
        batch.ordered_comment_ids.includes(comment.id)
      )
    ).length,
    pendingPatches: selectedPatches.filter((patch) => patch.status === "pending")
      .length,
    rejectedPatches: selectedPatches.filter(
      (patch) => patch.status === "rejected"
    ).length,
    replies: selectedComments.reduce(
      (total, comment) => total + comment.thread.length,
      0
    ),
    selectedComments: selectedComments.length,
    selectionFingerprint: createSelectionFingerprint({
      anchorStatuses,
      comments: selectedComments,
      patches: selectedPatches,
      reviewBatches
    }),
    stalePatches: selectedPatches.filter((patch) => patch.status === "stale")
      .length,
    unresolvedAnchors
  };
}

export function moveCommentsToTrash({
  activeReanchorCommentId = null,
  anchorStatuses = {},
  commentIds,
  comments,
  currentDocumentId,
  currentProjectId,
  documentId,
  expectedSelectionFingerprint,
  operationId,
  patches,
  projectId,
  reviewBatches,
  timestamp,
  unsavedDraftCommentIds = []
}: {
  activeReanchorCommentId?: string | null;
  anchorStatuses?: Readonly<Record<string, CommentAnchorStatus>>;
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  expectedSelectionFingerprint: string;
  operationId: string;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  timestamp: string;
  unsavedDraftCommentIds?: readonly string[];
}): {
  comments: PatchmarkComment[];
  summary: CommentTrashSummary;
} {
  if (!operationId.trim()) {
    throw new Error("A Trash operation ID is required.");
  }
  assertTimestamp(timestamp);
  const summary = buildCommentTrashSummary({
    activeReanchorCommentId,
    anchorStatuses,
    commentIds,
    comments,
    currentDocumentId,
    currentProjectId,
    documentId,
    patches,
    projectId,
    reviewBatches,
    unsavedDraftCommentIds
  });

  if (summary.selectionFingerprint !== expectedSelectionFingerprint) {
    throw new CommentTrashOperationError(
      "stale_selection",
      "The selected comments changed after the confirmation summary opened."
    );
  }
  if (summary.blockers.length > 0) {
    throw new CommentTrashOperationError(
      "blocked",
      "One or more selected comments must be unblocked before moving them to Trash."
    );
  }

  const selectedIds = new Set(commentIds);
  return {
    comments: comments.map((comment) =>
      selectedIds.has(comment.id)
        ? {
            ...comment,
            trashed_at: timestamp,
            trash_operation_id: operationId,
            restored_at: undefined
          }
        : comment
    ),
    summary
  };
}

export function restoreCommentsFromTrash({
  commentIds,
  comments,
  currentDocumentId,
  currentProjectId,
  documentId,
  projectId,
  timestamp
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  projectId: string;
  timestamp: string;
}): PatchmarkComment[] {
  validateIdentity({
    currentDocumentId,
    currentProjectId,
    documentId,
    projectId
  });
  assertTimestamp(timestamp);
  getSelectedComments({
    commentIds,
    comments,
    expectedTrashState: "trashed"
  });
  const selectedIds = new Set(commentIds);

  return comments.map((comment) =>
    selectedIds.has(comment.id)
      ? {
          ...comment,
          trashed_at: undefined,
          trash_operation_id: undefined,
          restored_at: timestamp
        }
      : comment
  );
}

function getCommentTrashBlockers({
  activeReanchorCommentId,
  commentIds,
  reviewBatches,
  unsavedDraftCommentIds
}: {
  activeReanchorCommentId: string | null;
  commentIds: readonly string[];
  reviewBatches: readonly PatchmarkReviewBatch[];
  unsavedDraftCommentIds: readonly string[];
}): CommentTrashBlocker[] {
  const selectedIds = new Set(commentIds);
  const blockers: CommentTrashBlocker[] = reviewBatches.flatMap((batch) => {
    if (batch.status !== "exported") {
      return [];
    }
    const blockedIds = batch.ordered_comment_ids.filter((commentId) =>
      selectedIds.has(commentId)
    );
    return blockedIds.length > 0
      ? [
          {
            batchId: batch.batch_id,
            commentIds: blockedIds,
            kind: "active_review_batch" as const
          }
        ]
      : [];
  });

  if (activeReanchorCommentId && selectedIds.has(activeReanchorCommentId)) {
    blockers.push({
      commentId: activeReanchorCommentId,
      kind: "active_reanchor"
    });
  }

  const blockedDraftIds = [...new Set(unsavedDraftCommentIds)].filter(
    (commentId) => selectedIds.has(commentId)
  );
  if (blockedDraftIds.length > 0) {
    blockers.push({
      commentIds: blockedDraftIds,
      kind: "unsaved_draft"
    });
  }

  return blockers;
}

function getSelectedComments({
  commentIds,
  comments,
  expectedTrashState
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  expectedTrashState: "active" | "trashed";
}): PatchmarkComment[] {
  if (commentIds.length === 0) {
    throw new CommentTrashOperationError(
      "empty_selection",
      "Select at least one comment."
    );
  }
  if (new Set(commentIds).size !== commentIds.length) {
    throw new CommentTrashOperationError(
      "duplicate_comment_id",
      "The comment selection contains duplicate IDs."
    );
  }

  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  if (commentsById.size !== comments.length) {
    throw new CommentTrashOperationError(
      "duplicate_comment_id",
      "The document contains duplicate comment IDs."
    );
  }
  return commentIds.map((commentId) => {
    const comment = commentsById.get(commentId);
    if (!comment) {
      throw new CommentTrashOperationError(
        "missing_comment",
        `Comment ${commentId} was not found in the active document.`
      );
    }
    if (expectedTrashState === "active" && isCommentTrashed(comment)) {
      throw new CommentTrashOperationError(
        "already_trashed",
        `Comment ${commentId} is already in Trash.`
      );
    }
    if (expectedTrashState === "trashed" && !isCommentTrashed(comment)) {
      throw new CommentTrashOperationError(
        "already_active",
        `Comment ${commentId} is already active.`
      );
    }
    return comment;
  });
}

function validateIdentity({
  currentDocumentId,
  currentProjectId,
  documentId,
  projectId
}: {
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  projectId: string;
}): void {
  if (projectId !== currentProjectId || documentId !== currentDocumentId) {
    throw new CommentTrashOperationError(
      "identity_mismatch",
      "The active project or document changed before the Trash operation."
    );
  }
}

function createSelectionFingerprint({
  anchorStatuses,
  comments,
  patches,
  reviewBatches
}: {
  anchorStatuses: Readonly<Record<string, CommentAnchorStatus>>;
  comments: readonly PatchmarkComment[];
  patches: readonly PatchmarkPatch[];
  reviewBatches: readonly PatchmarkReviewBatch[];
}): string {
  const selectedIds = new Set(comments.map((comment) => comment.id));
  return hashText(
    JSON.stringify({
      anchorStatuses: comments.map((comment) => [
        comment.id,
        anchorStatuses[comment.id] ?? null
      ]),
      comments,
      patches,
      reviewBatches: reviewBatches
        .filter((batch) =>
          batch.ordered_comment_ids.some((commentId) => selectedIds.has(commentId))
        )
        .map((batch) => ({
          batch_id: batch.batch_id,
          ordered_comment_ids: batch.ordered_comment_ids,
          status: batch.status
        }))
    })
  );
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function assertTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error("A valid operation timestamp is required.");
  }
}

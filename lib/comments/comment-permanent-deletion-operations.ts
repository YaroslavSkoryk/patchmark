import type {
  PatchmarkComment,
  PatchmarkCommentDeletionTombstone,
  PatchmarkManifest,
  PatchmarkPatch
} from "../project/project-types.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";
import type { PatchmarkReviewQueueOverrides } from "../review-queue/review-queue-override-types.ts";
import {
  getTrashedComments,
  isCommentTrashed
} from "./comment-trash-operations.ts";

export type CommentPermanentDeletionMode =
  | "individual"
  | "selected"
  | "empty_trash";

export type CommentPermanentDeletionBlocker =
  | {
      batchId: string;
      commentIds: string[];
      kind: "active_review_batch";
    }
  | {
      commentIds: string[];
      kind: "unsaved_draft";
    }
  | {
      kind: "in_flight_import";
    }
  | {
      kind: "in_flight_mutation";
    }
  | {
      commentId: string;
      reference: string;
      kind: "corrupt_historical_reference";
    };

export type CommentPermanentDeletionSummary = {
  acceptedPatches: number;
  blockedComments: number;
  blockers: CommentPermanentDeletionBlocker[];
  confirmationPhrase: string;
  imports: number;
  pendingPatches: number;
  rejectedPatches: number;
  replies: number;
  reviewBatchReferences: number;
  selectedComments: number;
  selectionFingerprint: string;
  stalePatches: number;
  tombstones: number;
};

export class CommentPermanentDeletionError extends Error {
  readonly code:
    | "already_deleted"
    | "blocked"
    | "confirmation_mismatch"
    | "duplicate_comment_id"
    | "empty_selection"
    | "identity_mismatch"
    | "missing_comment"
    | "not_trashed"
    | "stale_selection"
    | "stale_trash";

  constructor(
    code: CommentPermanentDeletionError["code"],
    message: string
  ) {
    super(message);
    this.name = "CommentPermanentDeletionError";
    this.code = code;
  }
}

export function getPermanentDeletionConfirmationPhrase({
  mode,
  selectedComments
}: {
  mode: CommentPermanentDeletionMode;
  selectedComments: number;
}): string {
  if (mode === "empty_trash") {
    return "EMPTY TRASH";
  }
  return selectedComments === 1
    ? "DELETE"
    : `DELETE ${selectedComments} COMMENTS`;
}

export function buildPermanentDeletionSummary({
  commentIds,
  comments,
  currentDocumentId,
  currentProjectId,
  documentId,
  inFlightImport = false,
  inFlightMutation = false,
  mode,
  patches,
  projectId,
  reviewBatches,
  reviewQueueOverrides,
  tombstones,
  unsavedDraftCommentIds = []
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  inFlightImport?: boolean;
  inFlightMutation?: boolean;
  mode: CommentPermanentDeletionMode;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  reviewQueueOverrides: PatchmarkReviewQueueOverrides;
  tombstones: readonly PatchmarkCommentDeletionTombstone[];
  unsavedDraftCommentIds?: readonly string[];
}): CommentPermanentDeletionSummary {
  validateIdentity({
    currentDocumentId,
    currentProjectId,
    documentId,
    projectId
  });
  const selectedComments = getSelectedTrashedComments({
    commentIds,
    comments,
    tombstones
  });
  const selectedIds = new Set(commentIds);
  const selectedPatches = patches.filter(
    (patch) => patch.comment_id && selectedIds.has(patch.comment_id)
  );
  const blockers = getPermanentDeletionBlockers({
    allPatches: patches,
    commentIds,
    inFlightImport,
    inFlightMutation,
    patches: selectedPatches,
    reviewBatches,
    unsavedDraftCommentIds
  });
  const blockedCommentIds = new Set(
    blockers.flatMap((blocker) =>
      "commentIds" in blocker
        ? blocker.commentIds
        : "commentId" in blocker
          ? [blocker.commentId]
          : commentIds
    )
  );
  const imports = new Set<string>();
  selectedComments.forEach((comment) => {
    comment.thread.forEach((entry) => {
      if (entry.source_import_id) {
        imports.add(entry.source_import_id);
      }
    });
  });
  selectedPatches.forEach((patch) => {
    if (patch.source_import_id) {
      imports.add(patch.source_import_id);
    }
  });
  reviewBatches.forEach((batch) => {
    if (
      batch.import_id &&
      batch.ordered_comment_ids.some((commentId) => selectedIds.has(commentId))
    ) {
      imports.add(batch.import_id);
    }
  });

  return {
    acceptedPatches: selectedPatches.filter(
      (patch) => patch.status === "accepted"
    ).length,
    blockedComments: blockedCommentIds.size,
    blockers,
    confirmationPhrase: getPermanentDeletionConfirmationPhrase({
      mode,
      selectedComments: selectedComments.length
    }),
    imports: imports.size,
    pendingPatches: selectedPatches.filter((patch) => patch.status === "pending")
      .length,
    rejectedPatches: selectedPatches.filter(
      (patch) => patch.status === "rejected"
    ).length,
    replies: selectedComments.reduce(
      (total, comment) => total + comment.thread.length,
      0
    ),
    reviewBatchReferences: reviewBatches.reduce(
      (total, batch) =>
        total +
        batch.ordered_comment_ids.filter((commentId) =>
          selectedIds.has(commentId)
        ).length,
      0
    ),
    selectedComments: selectedComments.length,
    selectionFingerprint: createPermanentDeletionFingerprint({
      comments: selectedComments,
      patches: selectedPatches,
      reviewBatches,
      reviewQueueOverrides,
      tombstones
    }),
    stalePatches: selectedPatches.filter((patch) => patch.status === "stale")
      .length,
    tombstones: selectedComments.length
  };
}

export function permanentlyDeleteComments({
  commentIds,
  comments,
  confirmationPhrase,
  currentDocumentId,
  currentProjectId,
  documentId,
  expectedSelectionFingerprint,
  inFlightImport = false,
  inFlightMutation = false,
  manifest,
  mode,
  operationId,
  patches,
  projectId,
  reviewBatches,
  reviewQueueOverrides,
  timestamp,
  unsavedDraftCommentIds = []
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  confirmationPhrase: string;
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  expectedSelectionFingerprint: string;
  inFlightImport?: boolean;
  inFlightMutation?: boolean;
  manifest: PatchmarkManifest;
  mode: Exclude<CommentPermanentDeletionMode, "empty_trash">;
  operationId: string;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  reviewQueueOverrides: PatchmarkReviewQueueOverrides;
  timestamp: string;
  unsavedDraftCommentIds?: readonly string[];
}) {
  return executePermanentDeletion({
    commentIds,
    comments,
    confirmationPhrase,
    currentDocumentId,
    currentProjectId,
    documentId,
    expectedFingerprint: expectedSelectionFingerprint,
    expectedFingerprintCode: "stale_selection",
    inFlightImport,
    inFlightMutation,
    manifest,
    mode,
    operationId,
    patches,
    projectId,
    reviewBatches,
    reviewQueueOverrides,
    timestamp,
    unsavedDraftCommentIds
  });
}

export function emptyCommentTrash({
  comments,
  confirmationPhrase,
  currentDocumentId,
  currentProjectId,
  documentId,
  expectedTrashFingerprint,
  inFlightImport = false,
  inFlightMutation = false,
  manifest,
  operationId,
  patches,
  projectId,
  reviewBatches,
  reviewQueueOverrides,
  timestamp,
  unsavedDraftCommentIds = []
}: {
  comments: readonly PatchmarkComment[];
  confirmationPhrase: string;
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  expectedTrashFingerprint: string;
  inFlightImport?: boolean;
  inFlightMutation?: boolean;
  manifest: PatchmarkManifest;
  operationId: string;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  reviewQueueOverrides: PatchmarkReviewQueueOverrides;
  timestamp: string;
  unsavedDraftCommentIds?: readonly string[];
}) {
  const commentIds = getTrashedComments(comments).map((comment) => comment.id);
  return executePermanentDeletion({
    commentIds,
    comments,
    confirmationPhrase,
    currentDocumentId,
    currentProjectId,
    documentId,
    expectedFingerprint: expectedTrashFingerprint,
    expectedFingerprintCode: "stale_trash",
    inFlightImport,
    inFlightMutation,
    manifest,
    mode: "empty_trash",
    operationId,
    patches,
    projectId,
    reviewBatches,
    reviewQueueOverrides,
    timestamp,
    unsavedDraftCommentIds
  });
}

function executePermanentDeletion({
  commentIds,
  comments,
  confirmationPhrase,
  currentDocumentId,
  currentProjectId,
  documentId,
  expectedFingerprint,
  expectedFingerprintCode,
  inFlightImport,
  inFlightMutation,
  manifest,
  mode,
  operationId,
  patches,
  projectId,
  reviewBatches,
  reviewQueueOverrides,
  timestamp,
  unsavedDraftCommentIds
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  confirmationPhrase: string;
  currentDocumentId: string;
  currentProjectId: string;
  documentId: string;
  expectedFingerprint: string;
  expectedFingerprintCode: "stale_selection" | "stale_trash";
  inFlightImport: boolean;
  inFlightMutation: boolean;
  manifest: PatchmarkManifest;
  mode: CommentPermanentDeletionMode;
  operationId: string;
  patches: readonly PatchmarkPatch[];
  projectId: string;
  reviewBatches: readonly PatchmarkReviewBatch[];
  reviewQueueOverrides: PatchmarkReviewQueueOverrides;
  timestamp: string;
  unsavedDraftCommentIds: readonly string[];
}) {
  if (!operationId.trim()) {
    throw new Error("A permanent-delete operation ID is required.");
  }
  assertTimestamp(timestamp);
  const existingTombstones = manifest.comment_deletion_tombstones ?? [];
  const summary = buildPermanentDeletionSummary({
    commentIds,
    comments,
    currentDocumentId,
    currentProjectId,
    documentId,
    inFlightImport,
    inFlightMutation,
    mode,
    patches,
    projectId,
    reviewBatches,
    reviewQueueOverrides,
    tombstones: existingTombstones,
    unsavedDraftCommentIds
  });
  if (summary.selectionFingerprint !== expectedFingerprint) {
    throw new CommentPermanentDeletionError(
      expectedFingerprintCode,
      mode === "empty_trash"
        ? "Trash changed after the Empty Trash confirmation opened."
        : "The selected comments changed after the confirmation opened."
    );
  }
  if (confirmationPhrase.trim() !== summary.confirmationPhrase) {
    throw new CommentPermanentDeletionError(
      "confirmation_mismatch",
      `Type ${summary.confirmationPhrase} exactly to confirm.`
    );
  }
  if (summary.blockers.length > 0) {
    throw new CommentPermanentDeletionError(
      "blocked",
      "One or more comments cannot be permanently deleted."
    );
  }

  const selectedIds = new Set(commentIds);
  const selectedComments = getSelectedTrashedComments({
    commentIds,
    comments,
    tombstones: existingTombstones
  });
  const selectedPatches = patches.filter(
    (patch) => patch.comment_id && selectedIds.has(patch.comment_id)
  );
  const createdTombstones = selectedComments.map((comment) => {
    const commentPatches = selectedPatches.filter(
      (patch) => patch.comment_id === comment.id
    );
    return {
      schema_version: 1 as const,
      project_id: projectId,
      document_id: documentId,
      comment_id: comment.id,
      permanently_deleted_at: timestamp,
      permanent_delete_operation_id: operationId,
      original_status: comment.status,
      had_accepted_patches: commentPatches.some(
        (patch) => patch.status === "accepted"
      ),
      patches: commentPatches.map((patch) => ({
        patch_id: patch.id,
        status: patch.status
      }))
    };
  });

  return {
    comments: comments.filter((comment) => !selectedIds.has(comment.id)),
    manifest: {
      ...manifest,
      comment_deletion_tombstones: [
        ...existingTombstones,
        ...createdTombstones
      ]
    },
    patches: patches.filter(
      (patch) => !patch.comment_id || !selectedIds.has(patch.comment_id)
    ),
    reviewQueueOverrides: {
      ...reviewQueueOverrides,
      deferred_comments: reviewQueueOverrides.deferred_comments.filter(
        (entry) => !selectedIds.has(entry.comment_id)
      )
    },
    summary,
    tombstones: createdTombstones
  };
}

function getPermanentDeletionBlockers({
  allPatches,
  commentIds,
  inFlightImport,
  inFlightMutation,
  patches,
  reviewBatches,
  unsavedDraftCommentIds
}: {
  allPatches: readonly PatchmarkPatch[];
  commentIds: readonly string[];
  inFlightImport: boolean;
  inFlightMutation: boolean;
  patches: readonly PatchmarkPatch[];
  reviewBatches: readonly PatchmarkReviewBatch[];
  unsavedDraftCommentIds: readonly string[];
}): CommentPermanentDeletionBlocker[] {
  const selectedIds = new Set(commentIds);
  const blockers: CommentPermanentDeletionBlocker[] = reviewBatches.flatMap(
    (batch) => {
      const linkedIds = batch.ordered_comment_ids.filter((commentId) =>
        selectedIds.has(commentId)
      );
      return batch.status === "exported" && linkedIds.length > 0
        ? [
            {
              batchId: batch.batch_id,
              commentIds: linkedIds,
              kind: "active_review_batch" as const
            }
          ]
        : [];
    }
  );
  const draftIds = [...new Set(unsavedDraftCommentIds)].filter((commentId) =>
    selectedIds.has(commentId)
  );
  if (draftIds.length > 0) {
    blockers.push({ commentIds: draftIds, kind: "unsaved_draft" });
  }
  if (inFlightImport) {
    blockers.push({ kind: "in_flight_import" });
  }
  if (inFlightMutation) {
    blockers.push({ kind: "in_flight_mutation" });
  }

  const selectedPatchIds = new Set(patches.map((patch) => patch.id));
  for (const batch of reviewBatches) {
    for (const commentId of batch.ordered_comment_ids) {
      if (
        selectedIds.has(commentId) &&
        !batch.comment_fingerprints.some(
          (fingerprint) => fingerprint.comment_id === commentId
        )
      ) {
        blockers.push({
          commentId,
          kind: "corrupt_historical_reference",
          reference: `${batch.batch_id}:comment_fingerprint`
        });
      }
    }
  }

  for (const batch of reviewBatches) {
    const analysis = batch.response_analysis;
    if (!analysis) {
      continue;
    }
    for (const outcome of analysis.ordered_comment_outcomes) {
      if (!selectedIds.has(outcome.comment_id)) {
        continue;
      }
      for (const patchId of outcome.patch_ids) {
        if (!patches.some((patch) => patch.id === patchId)) {
          blockers.push({
            commentId: outcome.comment_id,
            kind: "corrupt_historical_reference",
            reference: `${batch.batch_id}:${patchId}`
          });
        }
      }
    }
  }
  for (const patch of allPatches) {
    for (const dependencyId of patch.depends_on_patch_ids ?? []) {
      if (selectedPatchIds.has(dependencyId) && !selectedPatchIds.has(patch.id)) {
        blockers.push({
          commentId: patch.comment_id ?? "unknown",
          kind: "corrupt_historical_reference",
          reference: `${patch.id}:${dependencyId}`
        });
      }
    }
  }
  return blockers;
}

function getSelectedTrashedComments({
  commentIds,
  comments,
  tombstones
}: {
  commentIds: readonly string[];
  comments: readonly PatchmarkComment[];
  tombstones: readonly PatchmarkCommentDeletionTombstone[];
}): PatchmarkComment[] {
  if (commentIds.length === 0) {
    throw new CommentPermanentDeletionError(
      "empty_selection",
      "Select at least one trashed comment."
    );
  }
  if (new Set(commentIds).size !== commentIds.length) {
    throw new CommentPermanentDeletionError(
      "duplicate_comment_id",
      "The permanent-delete selection contains duplicate comment IDs."
    );
  }
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  if (commentsById.size !== comments.length) {
    throw new CommentPermanentDeletionError(
      "duplicate_comment_id",
      "The document contains duplicate comment IDs."
    );
  }
  return commentIds.map((commentId) => {
    const comment = commentsById.get(commentId);
    if (!comment) {
      if (tombstones.some((tombstone) => tombstone.comment_id === commentId)) {
        throw new CommentPermanentDeletionError(
          "already_deleted",
          `Comment ${commentId} was already permanently deleted.`
        );
      }
      throw new CommentPermanentDeletionError(
        "missing_comment",
        `Comment ${commentId} was not found in the active document.`
      );
    }
    if (!isCommentTrashed(comment)) {
      throw new CommentPermanentDeletionError(
        "not_trashed",
        `Move ${commentId} to Trash before deleting it forever.`
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
}) {
  if (projectId !== currentProjectId || documentId !== currentDocumentId) {
    throw new CommentPermanentDeletionError(
      "identity_mismatch",
      "The active project or document changed before permanent deletion."
    );
  }
}

function createPermanentDeletionFingerprint({
  comments,
  patches,
  reviewBatches,
  reviewQueueOverrides,
  tombstones
}: {
  comments: readonly PatchmarkComment[];
  patches: readonly PatchmarkPatch[];
  reviewBatches: readonly PatchmarkReviewBatch[];
  reviewQueueOverrides: PatchmarkReviewQueueOverrides;
  tombstones: readonly PatchmarkCommentDeletionTombstone[];
}): string {
  const selectedIds = new Set(comments.map((comment) => comment.id));
  return hashText(
    JSON.stringify({
      comments,
      patches,
      reviewBatches: reviewBatches
        .filter((batch) =>
          batch.ordered_comment_ids.some((commentId) => selectedIds.has(commentId))
        )
        .map((batch) => ({
          batch_id: batch.batch_id,
          comment_fingerprints: batch.comment_fingerprints,
          import_id: batch.import_id,
          ordered_comment_ids: batch.ordered_comment_ids,
          response_analysis: batch.response_analysis,
          status: batch.status
        })),
      reviewQueueOverrides: reviewQueueOverrides.deferred_comments.filter(
        (entry) => selectedIds.has(entry.comment_id)
      ),
      tombstones
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

function assertTimestamp(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error("A valid permanent-delete timestamp is required.");
  }
}

import { resolveCanonicalCommentTarget } from "../comments/canonical-target-resolution.ts";
import { resolvePendingPatchTarget } from "../patches/linked-patch-target-resolution.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch,
  PatchmarkReadingBookmark
} from "../project/project-types.ts";
import { createReadingBookmarkAnchorAdapter } from "../reading-bookmarks/reading-bookmark.ts";
import type { ResolvedRewriteTarget } from "./rewrite-target-resolution.ts";
import type { RewriteSession } from "./rewrite-session-types.ts";

export type RewriteCommentSimulation = {
  commentId: string;
  outcome:
    | "deleted"
    | "recovery_required"
    | "transformed_active"
    | "transformed_needs_review"
    | "unaffected";
  validationStatus: string;
};

export type RewriteImpactAnalysis = {
  affectedCommentIds: string[];
  affectedComments: number;
  activeReviewBatchComments: number;
  activeReviewBatchIds: string[];
  bookmarkAffected: boolean;
  bookmarkExpectedAvailable: boolean | null;
  commentsExpectedSafe: number;
  commentsExpectedUnresolved: number;
  documentComments: number;
  pendingPatchIds: string[];
  pendingPatches: number;
  unresolvedCommentsAlreadyPresent: number;
};

export function analyzeRewriteImpact({
  bookmark,
  bookmarkSimulation,
  commentSimulation,
  comments,
  markdown,
  patches,
  reviewBatches,
  target
}: {
  bookmark: PatchmarkReadingBookmark | null;
  bookmarkSimulation: RewriteCommentSimulation | null;
  commentSimulation: RewriteCommentSimulation[];
  comments: PatchmarkComment[];
  markdown: string;
  patches: PatchmarkPatch[];
  reviewBatches: PatchmarkReviewBatch[];
  target: ResolvedRewriteTarget;
}): RewriteImpactAnalysis {
  const activeComments = comments.filter((comment) => !comment.trashed_at);
  const affectedCommentIds = activeComments
    .filter((comment) => isCommentAffected({ comment, markdown, patches, target }))
    .map((comment) => comment.id);
  const affectedSet = new Set(affectedCommentIds);
  const simulations = commentSimulation.filter((item) => affectedSet.has(item.commentId));
  const safeCount = simulations.filter(
    (item) =>
      item.outcome !== "recovery_required" &&
      item.outcome !== "transformed_needs_review" &&
      item.validationStatus !== "ambiguous" &&
      item.validationStatus !== "not_found"
  ).length;
  const pendingPatchIds = patches
    .filter((patch) => patch.status === "pending")
    .filter((patch) => {
      const resolution = resolvePendingPatchTarget({ comments, markdown, patch, patches });
      return resolution.matches.some((range) => rangesOverlap(range, target));
    })
    .map((patch) => patch.id);
  const activeBatches = reviewBatches.filter(
    (batch) =>
      batch.status === "exported" &&
      batch.ordered_comment_ids.some((commentId) => affectedSet.has(commentId))
  );
  const bookmarkAffected = bookmark
    ? isCommentAffected({
        comment: createReadingBookmarkAnchorAdapter(bookmark),
        markdown,
        patches,
        target
      })
    : false;

  return {
    affectedCommentIds,
    affectedComments: affectedCommentIds.length,
    activeReviewBatchComments: new Set(
      activeBatches.flatMap((batch) =>
        batch.ordered_comment_ids.filter((commentId) => affectedSet.has(commentId))
      )
    ).size,
    activeReviewBatchIds: activeBatches.map((batch) => batch.batch_id),
    bookmarkAffected,
    bookmarkExpectedAvailable: bookmarkAffected
      ? bookmarkSimulation
        ? bookmarkSimulation.outcome !== "recovery_required" &&
          bookmarkSimulation.validationStatus !== "ambiguous" &&
          bookmarkSimulation.validationStatus !== "not_found"
        : false
      : null,
    commentsExpectedSafe: safeCount,
    commentsExpectedUnresolved: Math.max(0, affectedCommentIds.length - safeCount),
    documentComments: activeComments.filter((comment) => comment.anchor.kind === "document").length,
    pendingPatchIds,
    pendingPatches: pendingPatchIds.length,
    unresolvedCommentsAlreadyPresent: activeComments.filter((comment) => {
      const resolution = resolveCanonicalCommentTarget(comment, { markdown, patches });
      return resolution.state !== "resolved";
    }).length
  };
}

export function markPendingPatchesAfterHumanRewrite({
  analysis,
  appliedAt,
  patches,
  session
}: {
  analysis: RewriteImpactAnalysis;
  appliedAt: string;
  patches: PatchmarkPatch[];
  session: RewriteSession;
}): PatchmarkPatch[] {
  const affected = new Set(analysis.pendingPatchIds);
  return patches.map((patch) =>
    affected.has(patch.id) && patch.status === "pending"
      ? {
          ...patch,
          status: "stale" as const,
          human_rewrite_impact: {
            rewrite_session_id: session.rewrite_session_id,
            applied_at: appliedAt,
            target_kind: session.target.kind,
            heading_snapshot: session.target.heading_snapshot,
            reason: "overlapping_human_rewrite" as const
          }
        }
      : patch
  );
}

function isCommentAffected({
  comment,
  markdown,
  patches,
  target
}: {
  comment: PatchmarkComment;
  markdown: string;
  patches: PatchmarkPatch[];
  target: ResolvedRewriteTarget;
}): boolean {
  if (comment.anchor.kind === "document") {
    return false;
  }
  const resolution = resolveCanonicalCommentTarget(comment, { markdown, patches });
  return Boolean(
    resolution.state === "resolved" &&
      resolution.range &&
      rangesOverlap(resolution.range, target)
  );
}

function rangesOverlap(
  first: { end: number; start: number },
  second: { end: number; start: number }
): boolean {
  return first.start < second.end && first.end > second.start;
}

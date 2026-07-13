import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import { getPatchDisplayTitle } from "./patch-display-title.ts";

export type RelatedAcceptedPatchHistoryEntry = {
  patch_id: string;
  display_title: string;
  status: "accepted";
  applied_at: string;
  target_heading: string | null;
  applied_text: string;
  reason: string;
};

export type RelatedAcceptedPatchHistory = {
  earlier_applied_patch_count: number;
  patches: RelatedAcceptedPatchHistoryEntry[];
};

export type PatchFollowUpRelationship = {
  applied_at: string;
  display_title: string;
  patch_id: string;
};

export type CommentPatchHistorySummary = {
  accepted: number;
  latestAcceptedTitle?: string;
  patchCount: number;
  pending: number;
  rejected: number;
  stale: number;
};

const DEFAULT_HISTORY_LIMIT = 5;

export function getContinuableLinkedComment({
  comments,
  patch
}: {
  comments: PatchmarkComment[];
  patch: PatchmarkPatch;
}): PatchmarkComment | null {
  if (!patch.comment_id) {
    return null;
  }

  return (
    comments.find(
      (comment) =>
        comment.id === patch.comment_id && comment.status === "open"
    ) ?? null
  );
}

export function createRelatedAcceptedPatchHistory({
  comment,
  limit = DEFAULT_HISTORY_LIMIT,
  patches
}: {
  comment: Pick<PatchmarkComment, "comment" | "id">;
  limit?: number;
  patches: PatchmarkPatch[];
}): RelatedAcceptedPatchHistory {
  const relevantPatches = patches
    .filter(
      (patch) =>
        patch.comment_id === comment.id && patch.status === "accepted"
    )
    .sort(compareAppliedPatchChronology);
  const boundedLimit = Math.max(1, Math.floor(limit));
  const visiblePatches = relevantPatches.slice(-boundedLimit);

  return {
    earlier_applied_patch_count: Math.max(
      0,
      relevantPatches.length - visiblePatches.length
    ),
    patches: visiblePatches.map((patch) => ({
      patch_id: patch.id,
      display_title: getPatchDisplayTitle(patch, { comment }),
      status: "accepted",
      applied_at:
        patch.applied_at ?? patch.accepted_at ?? patch.created_at,
      target_heading: patch.target_heading ?? null,
      applied_text: patch.applied_text ?? patch.suggested_text,
      reason: patch.reason
    }))
  };
}

export function getPatchFollowUpRelationship({
  comment,
  patch,
  patches
}: {
  comment?: Pick<PatchmarkComment, "comment"> | null;
  patch: PatchmarkPatch;
  patches: PatchmarkPatch[];
}): PatchFollowUpRelationship | null {
  if (!patch.comment_id) {
    return null;
  }

  const currentPatchCreatedAt = patch.created_at;
  const candidates = patches
    .filter((candidate) => {
      if (
        candidate.id === patch.id ||
        candidate.comment_id !== patch.comment_id ||
        candidate.status !== "accepted"
      ) {
        return false;
      }

      if (
        patch.source_import_id &&
        candidate.source_import_id === patch.source_import_id
      ) {
        return false;
      }

      if (
        patch.patch_group_id &&
        candidate.patch_group_id === patch.patch_group_id
      ) {
        return false;
      }

      return compareTimestamps(
        getAppliedPatchTimestamp(candidate),
        currentPatchCreatedAt
      ) <= 0;
    })
    .sort(compareAppliedPatchesNewestFirst);

  const latestCandidate = candidates[0];

  if (!latestCandidate) {
    return null;
  }

  const latestAppliedAt = getAppliedPatchTimestamp(latestCandidate);
  const hasAmbiguousLatestCandidate = candidates
    .slice(1)
    .some(
      (candidate) => getAppliedPatchTimestamp(candidate) === latestAppliedAt
    );

  if (hasAmbiguousLatestCandidate) {
    return null;
  }

  return {
    applied_at: latestAppliedAt,
    display_title: getPatchDisplayTitle(latestCandidate, { comment }),
    patch_id: latestCandidate.id
  };
}

export function getLatestAcceptedPatchForComment({
  comment,
  patches
}: {
  comment: Pick<PatchmarkComment, "id">;
  patches: PatchmarkPatch[];
}): PatchmarkPatch | null {
  return (
    patches
      .filter(
        (patch) =>
          patch.comment_id === comment.id && patch.status === "accepted"
      )
      .sort(compareAppliedPatchesNewestFirst)[0] ?? null
  );
}

export function createCommentPatchHistorySummary({
  comment,
  patches
}: {
  comment: Pick<PatchmarkComment, "comment" | "id">;
  patches: PatchmarkPatch[];
}): CommentPatchHistorySummary {
  const relatedPatches = patches.filter(
    (patch) => patch.comment_id === comment.id
  );
  const latestAcceptedPatch = getLatestAcceptedPatchForComment({
    comment,
    patches: relatedPatches
  });

  return {
    accepted: relatedPatches.filter((patch) => patch.status === "accepted")
      .length,
    latestAcceptedTitle: latestAcceptedPatch
      ? getPatchDisplayTitle(latestAcceptedPatch, { comment })
      : undefined,
    patchCount: relatedPatches.length,
    pending: relatedPatches.filter((patch) => patch.status === "pending").length,
    rejected: relatedPatches.filter((patch) => patch.status === "rejected")
      .length,
    stale: relatedPatches.filter((patch) => patch.status === "stale").length
  };
}

function compareAppliedPatchChronology(
  firstPatch: PatchmarkPatch,
  secondPatch: PatchmarkPatch
): number {
  return (
    compareTimestamps(
      getAppliedPatchTimestamp(firstPatch),
      getAppliedPatchTimestamp(secondPatch)
    ) || firstPatch.id.localeCompare(secondPatch.id)
  );
}

function compareAppliedPatchesNewestFirst(
  firstPatch: PatchmarkPatch,
  secondPatch: PatchmarkPatch
): number {
  return (
    compareTimestamps(
      getAppliedPatchTimestamp(secondPatch),
      getAppliedPatchTimestamp(firstPatch)
    ) || secondPatch.id.localeCompare(firstPatch.id)
  );
}

function compareTimestamps(
  firstTimestamp: string,
  secondTimestamp: string
): number {
  const firstTime = Date.parse(firstTimestamp);
  const secondTime = Date.parse(secondTimestamp);

  if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) {
    return firstTime - secondTime;
  }

  return firstTimestamp.localeCompare(secondTimestamp);
}

function getAppliedPatchTimestamp(patch: PatchmarkPatch): string {
  return patch.applied_at ?? patch.accepted_at ?? patch.created_at;
}

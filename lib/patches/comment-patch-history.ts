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

function compareAppliedPatchChronology(
  firstPatch: PatchmarkPatch,
  secondPatch: PatchmarkPatch
): number {
  return getAppliedPatchTimestamp(firstPatch).localeCompare(
    getAppliedPatchTimestamp(secondPatch)
  );
}

function getAppliedPatchTimestamp(patch: PatchmarkPatch): string {
  return patch.applied_at ?? patch.accepted_at ?? patch.created_at;
}

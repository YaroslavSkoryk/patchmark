import type {
  CommentAnchorStatus,
  PatchmarkCommentThreadEntry,
  PatchmarkCommentPatchImpact
} from "../project/project-types.ts";

export function isCommentAnchorCurrentlyValid(
  anchorStatus: CommentAnchorStatus
): boolean {
  return anchorStatus === "active" || anchorStatus === "document";
}

export function getVisibleAnchorStatus(
  anchorStatus: CommentAnchorStatus
): Extract<CommentAnchorStatus, "ambiguous" | "not_found"> | undefined {
  if (anchorStatus === "ambiguous" || anchorStatus === "not_found") {
    return anchorStatus;
  }

  return undefined;
}

export function getPatchImpactForCurrentAnchorDisplay({
  anchorStatus,
  latestPatchImpact
}: {
  anchorStatus: CommentAnchorStatus;
  latestPatchImpact?: PatchmarkCommentPatchImpact;
}): PatchmarkCommentPatchImpact | undefined {
  if (!latestPatchImpact) {
    return undefined;
  }

  if (
    isAnchorMaintenancePatchImpact(latestPatchImpact) ||
    isCommentAnchorCurrentlyValid(anchorStatus)
  ) {
    return undefined;
  }

  return undefined;
}

export function getVisibleCommentThreadEntries(
  threadEntries: PatchmarkCommentThreadEntry[]
): PatchmarkCommentThreadEntry[] {
  return threadEntries.filter(
    (entry) => !isAnchorMaintenanceSystemThreadEntry(entry)
  );
}

export function isAnchorMaintenancePatchImpact(
  patchImpact: PatchmarkCommentPatchImpact
): boolean {
  return (
    patchImpact.result === "needs_review" ||
    patchImpact.result === "offset_shifted" ||
    patchImpact.result === "reanchored" ||
    patchImpact.result === "unchanged"
  );
}

export function isAnchorMaintenanceSystemThreadEntry(
  entry: PatchmarkCommentThreadEntry
): boolean {
  if (entry.role !== "system") {
    return false;
  }

  const normalizedContent = entry.content.toLowerCase();

  return [
    "anchor",
    "re-anchor",
    "re-anchored",
    "recovered",
    "shifted text before this comment",
    "offset",
    "may have affected this comment",
    "could not re-anchor",
    "validation refreshed"
  ].some((phrase) => normalizedContent.includes(phrase));
}

import type {
  CommentAnchorStatus,
  PatchmarkCommentPatchImpact
} from "../project/project-types.ts";

export function isCommentAnchorCurrentlyValid(
  anchorStatus: CommentAnchorStatus
): boolean {
  return anchorStatus === "active" || anchorStatus === "document";
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

  const anchorIsCurrentlyValid = isCommentAnchorCurrentlyValid(anchorStatus);

  if (
    latestPatchImpact.result === "reanchored" ||
    latestPatchImpact.result === "offset_shifted"
  ) {
    return anchorIsCurrentlyValid ? latestPatchImpact : undefined;
  }

  if (latestPatchImpact.result === "needs_review") {
    return anchorIsCurrentlyValid ? undefined : latestPatchImpact;
  }

  return latestPatchImpact;
}

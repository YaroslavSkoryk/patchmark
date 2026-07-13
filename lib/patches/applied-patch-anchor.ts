import {
  getMarkdownPlainText,
  normalizeMarkdownText,
  type TextRange
} from "../markdown/markdown-text.ts";
import type { PatchmarkPatch } from "../project/project-types.ts";
import type {
  AppliedPatchReviewAnchorStatus,
  AppliedPatchReviewMatchMethod
} from "./patch-review-content.ts";

export type DeterministicAppliedPatchOffsetMatch = TextRange & {
  matchMethod: AppliedPatchReviewMatchMethod;
  status: AppliedPatchReviewAnchorStatus;
  text: string;
};

export function getDeterministicAppliedPatchOffsetMatch({
  appliedText,
  markdown,
  patch
}: {
  appliedText: string;
  markdown: string;
  patch: Pick<PatchmarkPatch, "applied_end_offset" | "applied_start_offset">;
}): DeterministicAppliedPatchOffsetMatch | null {
  if (
    typeof patch.applied_start_offset !== "number" ||
    typeof patch.applied_end_offset !== "number" ||
    patch.applied_start_offset < 0 ||
    patch.applied_end_offset < patch.applied_start_offset ||
    patch.applied_end_offset > markdown.length
  ) {
    return null;
  }

  const candidate = markdown.slice(
    patch.applied_start_offset,
    patch.applied_end_offset
  );
  const range = {
    end: patch.applied_end_offset,
    start: patch.applied_start_offset
  };

  if (candidate === appliedText) {
    return {
      ...range,
      matchMethod: "exact",
      status: "exact_match",
      text: candidate
    };
  }

  if (
    normalizeMarkdownText(candidate) === normalizeMarkdownText(appliedText) ||
    getMarkdownPlainText(candidate) === getMarkdownPlainText(appliedText)
  ) {
    return {
      ...range,
      matchMethod: "normalized",
      status: "normalized_match",
      text: candidate
    };
  }

  return null;
}

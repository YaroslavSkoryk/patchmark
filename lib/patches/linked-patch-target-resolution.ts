import type { TextRange } from "../markdown/markdown-tables.ts";
import {
  resolveCanonicalPatchTarget,
  type CanonicalTargetMethod,
  type CanonicalTargetResolution
} from "../comments/canonical-target-resolution.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";

export type PendingPatchApplicability =
  | "exact_match"
  | "multiple_matches"
  | "not_found"
  | "table_row_rebase_available";

export type PendingPatchTargetMatchMethod =
  | "document_exact"
  | "document_normalized"
  | "linked_comment_anchor"
  | "linked_comment_context"
  | "linked_comment_structure"
  | "target_heading";

export type PendingPatchTargetResolution = {
  applicability: Extract<
    PendingPatchApplicability,
    "exact_match" | "multiple_matches" | "not_found"
  >;
  canonical: CanonicalTargetResolution;
  matches: TextRange[];
  method: PendingPatchTargetMatchMethod | "none";
};

export function resolvePendingPatchTarget({
  comments = [],
  markdown,
  patch,
  patches = []
}: {
  comments?: PatchmarkComment[];
  markdown: string;
  patch: PatchmarkPatch;
  patches?: PatchmarkPatch[];
}): PendingPatchTargetResolution {
  const canonical = resolveCanonicalPatchTarget({
    comments,
    markdown,
    patch,
    patches
  });
  const matches =
    canonical.state === "resolved" && canonical.range
      ? [canonical.range]
      : canonical.candidates.map((candidate) => candidate.range);

  return {
    applicability:
      canonical.state === "resolved"
        ? "exact_match"
        : canonical.state === "ambiguous"
          ? "multiple_matches"
          : "not_found",
    canonical,
    matches,
    method: getPendingPatchMethodFromCanonical(canonical.method)
  };
}

function getPendingPatchMethodFromCanonical(
  method: CanonicalTargetMethod | "none"
): PendingPatchTargetMatchMethod | "none" {
  if (
    method === "linked_comment_anchor" ||
    method === "linked_comment_context" ||
    method === "linked_comment_structure" ||
    method === "target_heading"
  ) {
    return method;
  }

  if (method === "normalized") {
    return "document_normalized";
  }

  if (method === "section") {
    return "target_heading";
  }

  if (method === "none") {
    return "none";
  }

  return "document_exact";
}

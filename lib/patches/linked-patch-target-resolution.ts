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
import { resolvePatchTargetFromProvenance } from "./patch-target-provenance.ts";

export type PendingPatchApplicability =
  | "exact_match"
  | "multiple_matches"
  | "not_found"
  | "table_row_rebase_available";

export type PendingPatchTargetMatchMethod =
  | "document_exact"
  | "document_normalized"
  | "base_target_provenance"
  | "heading_ancestry"
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
  documentId,
  markdown,
  patch,
  patches = []
}: {
  comments?: PatchmarkComment[];
  documentId?: string;
  markdown: string;
  patch: PatchmarkPatch;
  patches?: PatchmarkPatch[];
}): PendingPatchTargetResolution {
  const provenanceResolution = resolvePatchTargetFromProvenance({
    documentId,
    markdown,
    patch
  });

  if (provenanceResolution?.kind === "resolved") {
    return {
      applicability: "exact_match",
      canonical: {
        candidates: [
          {
            confidence: "high",
            range: provenanceResolution.match,
            structuralContext: {
              containingHeading: patch.target_heading,
              scope: "section"
            },
            supportingMethods: [provenanceResolution.method]
          }
        ],
        cardinality: "unique",
        confidence: "high",
        containingHeading: patch.target_heading,
        explanationCode: provenanceResolution.method,
        method: provenanceResolution.method,
        range: provenanceResolution.match,
        state: "resolved",
        structuralContext: {
          containingHeading: patch.target_heading,
          scope: "section"
        }
      },
      matches: [provenanceResolution.match],
      method: provenanceResolution.method
    };
  }
  if (provenanceResolution?.kind === "ambiguous") {
    return {
      applicability: "multiple_matches",
      canonical: {
        candidates: provenanceResolution.matches.map((range) => ({
          confidence: "high",
          range,
          structuralContext: { scope: "section" },
          supportingMethods: ["heading_ancestry"]
        })),
        cardinality: "multiple",
        confidence: "high",
        explanationCode: "base_target_heading_ancestry_ambiguous",
        method: "heading_ancestry",
        state: "ambiguous"
      },
      matches: provenanceResolution.matches,
      method: "heading_ancestry"
    };
  }
  if (provenanceResolution) {
    return {
      applicability: "not_found",
      canonical: {
        candidates: [],
        cardinality: "none",
        confidence: "low",
        explanationCode:
          provenanceResolution.kind === "invalid_document"
            ? "base_target_provenance_document_mismatch"
            : "base_target_provenance_not_found",
        method: "base_target_provenance",
        state: "not_found"
      },
      matches: [],
      method: "base_target_provenance"
    };
  }

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
    method === "base_target_provenance" ||
    method === "heading_ancestry" ||
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

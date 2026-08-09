import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import { resolvePendingPatchTarget } from "./linked-patch-target-resolution.ts";

export type PatchApplicationResolution =
  | {
      kind: "applied";
      end: number;
      markdown: string;
      start: number;
    }
  | {
      kind: "ambiguous" | "not_found" | "stale";
    };

export function resolveAndApplyPendingPatch({
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
}): PatchApplicationResolution {
  const resolution = resolvePendingPatchTarget({
    comments,
    documentId,
    markdown,
    patch,
    patches
  });

  if (resolution.applicability === "multiple_matches") {
    return { kind: "ambiguous" };
  }

  if (resolution.applicability === "not_found") {
    return { kind: "not_found" };
  }

  const target = resolution.matches[0];

  if (
    !target ||
    markdown.slice(target.start, target.end) !== patch.original_text
  ) {
    return { kind: "stale" };
  }

  return {
    kind: "applied",
    end: target.start + patch.suggested_text.length,
    markdown: applyPatchReplacementAt({
      markdown,
      originalText: patch.original_text,
      start: target.start,
      suggestedText: patch.suggested_text
    }),
    start: target.start
  };
}

export function applyPatchReplacementAt({
  markdown,
  originalText,
  start,
  suggestedText
}: {
  markdown: string;
  originalText: string;
  start: number;
  suggestedText: string;
}): string {
  return (
    markdown.slice(0, start) +
    suggestedText +
    markdown.slice(start + originalText.length)
  );
}

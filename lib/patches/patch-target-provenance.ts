import { findExactTextMatches } from "../markdown/markdown-text.ts";
import { parseMarkdownHeadings } from "../markdown/parse-headings.ts";
import type {
  PatchmarkPatch,
  PatchmarkPatchTargetProvenance
} from "../project/project-types.ts";
import type { MarkdownEdit } from "../comments/comment-anchor-transformation.ts";

export type PatchBaseTargetPreflight =
  | {
      kind: "ambiguous";
      matchCount: number;
    }
  | {
      kind: "not_found";
      matchCount: 0;
    }
  | {
      kind: "resolved";
      matchCount: 1;
      provenance: PatchmarkPatchTargetProvenance;
    };

export type PatchProvenanceResolution =
  | {
      kind: "invalid_document" | "not_found";
    }
  | {
      kind: "ambiguous";
      matches: Array<{ end: number; start: number }>;
    }
  | {
      kind: "resolved";
      match: { end: number; start: number };
      method: "base_target_provenance" | "heading_ancestry";
    };

export function preflightPatchBaseTarget({
  baseDocumentSha256,
  documentId,
  markdown,
  patch
}: {
  baseDocumentSha256: string;
  documentId: string;
  markdown: string;
  patch: PatchmarkPatch;
}): PatchBaseTargetPreflight {
  const matches = findExactTextMatches(markdown, patch.original_text);

  if (matches.length === 0) {
    return { kind: "not_found", matchCount: 0 };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matchCount: matches.length };
  }

  const match = matches[0];
  return {
    kind: "resolved",
    matchCount: 1,
    provenance: {
      schema_version: 1,
      document_id: documentId,
      patch_key: patch.source_patch_key ?? patch.id,
      base_document_sha256: baseDocumentSha256,
      base_start: match.start,
      base_end: match.end,
      current_start: match.start,
      current_end: match.end,
      original_text_fingerprint: createTextFingerprint(patch.original_text),
      target_heading: patch.target_heading,
      heading_ancestry: getHeadingAncestry(markdown, match.start),
      base_occurrence_count: 1,
      resolution_method: patch.target_heading
        ? "heading_scoped_full_text"
        : "exact_full_text",
      mapping_state: "mapped"
    }
  };
}

export function resolvePatchTargetFromProvenance({
  documentId,
  markdown,
  patch
}: {
  documentId?: string;
  markdown: string;
  patch: PatchmarkPatch;
}): PatchProvenanceResolution | null {
  const provenance = patch.target_provenance;

  if (!provenance) {
    return null;
  }
  if (documentId && provenance.document_id !== documentId) {
    return { kind: "invalid_document" };
  }
  if (
    provenance.patch_key !== (patch.source_patch_key ?? patch.id) ||
    provenance.original_text_fingerprint !==
      createTextFingerprint(patch.original_text)
  ) {
    return { kind: "not_found" };
  }

  if (provenance.mapping_state === "mapped") {
    const mapped = {
      start: provenance.current_start,
      end: provenance.current_end
    };
    if (
      markdown.slice(mapped.start, mapped.end) === patch.original_text &&
      hasCompatibleHeadingAncestry({
        actual: getHeadingAncestry(markdown, mapped.start),
        expected: provenance.heading_ancestry
      })
    ) {
      return {
        kind: "resolved",
        match: mapped,
        method: "base_target_provenance"
      };
    }
  }

  const ancestryMatches = findExactTextMatches(markdown, patch.original_text).filter(
    (match) =>
      hasCompatibleHeadingAncestry({
        actual: getHeadingAncestry(markdown, match.start),
        expected: provenance.heading_ancestry
      })
  );

  if (ancestryMatches.length === 1) {
    return {
      kind: "resolved",
      match: ancestryMatches[0],
      method: "heading_ancestry"
    };
  }
  if (ancestryMatches.length > 1) {
    return { kind: "ambiguous", matches: ancestryMatches };
  }

  return { kind: "not_found" };
}

export function transformPatchTargetProvenanceThroughEdit(
  provenance: PatchmarkPatchTargetProvenance,
  edit: MarkdownEdit
): PatchmarkPatchTargetProvenance {
  if (provenance.mapping_state !== "mapped") {
    return provenance;
  }

  const delta = edit.insertedText.length - (edit.oldEnd - edit.oldStart);

  if (edit.oldEnd <= provenance.current_start) {
    return {
      ...provenance,
      current_start: provenance.current_start + delta,
      current_end: provenance.current_end + delta
    };
  }
  if (edit.oldStart >= provenance.current_end) {
    return provenance;
  }

  return {
    ...provenance,
    mapping_state: "requires_revalidation"
  };
}

export function transformPendingPatchTargetProvenances({
  edits,
  patches
}: {
  edits: MarkdownEdit[];
  patches: PatchmarkPatch[];
}): PatchmarkPatch[] {
  if (edits.length === 0) {
    return patches;
  }

  let changed = false;
  const nextPatches = patches.map((patch) => {
    if (patch.status !== "pending" || !patch.target_provenance) {
      return patch;
    }

    const targetProvenance = edits.reduce(
      transformPatchTargetProvenanceThroughEdit,
      patch.target_provenance
    );
    if (targetProvenance === patch.target_provenance) {
      return patch;
    }

    changed = true;
    return { ...patch, target_provenance: targetProvenance };
  });

  return changed ? nextPatches : patches;
}

export function requirePendingPatchTargetRevalidation(
  patches: PatchmarkPatch[]
): PatchmarkPatch[] {
  let changed = false;
  const nextPatches = patches.map((patch) => {
    if (
      patch.status !== "pending" ||
      !patch.target_provenance ||
      patch.target_provenance.mapping_state === "requires_revalidation"
    ) {
      return patch;
    }

    changed = true;
    return {
      ...patch,
      target_provenance: {
        ...patch.target_provenance,
        mapping_state: "requires_revalidation" as const
      }
    };
  });

  return changed ? nextPatches : patches;
}

export function getHeadingAncestry(
  markdown: string,
  offset: number
): string[] {
  const headings = parseMarkdownHeadings(markdown);
  const lineStarts = getLineStartOffsets(markdown);
  const ancestry: Array<{ level: number; value: string }> = [];

  for (const heading of headings) {
    const headingStart = lineStarts[heading.line - 1] ?? 0;
    if (headingStart > offset) {
      break;
    }

    while (
      ancestry.length > 0 &&
      ancestry[ancestry.length - 1].level >= heading.level
    ) {
      ancestry.pop();
    }
    ancestry.push({
      level: heading.level,
      value: `${"#".repeat(heading.level)} ${heading.text}`
    });
  }

  return ancestry.map((entry) => entry.value);
}

function hasCompatibleHeadingAncestry({
  actual,
  expected
}: {
  actual: string[];
  expected: string[];
}): boolean {
  return (
    actual.length === expected.length &&
    actual.every((heading, index) => heading === expected[index])
  );
}

function createTextFingerprint(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

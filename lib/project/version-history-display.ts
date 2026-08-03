import { normalizePatchDisplayTitleCandidate } from "../patches/patch-display-title.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch,
  PatchmarkVersionEntry
} from "./project-types.ts";

export const VERSION_HISTORY_SIDEBAR_LIMIT = 3;

export type VersionHistoryEntryViewModel = {
  dateLabel: string;
  detailItems: Array<{ label: string; value: string }>;
  relatedPatchId?: string;
  sourceImportId?: string;
  targetHeading?: string;
  title: string;
  typeLabel: string;
  version: PatchmarkVersionEntry;
};

const PATCH_REASON_PATTERN =
  /\bbefore\s+(?:accepting|applying)\s+patch\s+(PM-PATCH-\d+)\b/i;

export function createVersionHistoryEntries({
  comments,
  patches,
  versions
}: {
  comments: PatchmarkComment[];
  patches: PatchmarkPatch[];
  versions: PatchmarkVersionEntry[];
}): VersionHistoryEntryViewModel[] {
  void comments;

  return [...versions]
    .sort(compareVersionsNewestFirst)
    .map((version) =>
      createVersionHistoryEntry({
        patches,
        version
      })
    );
}

export function getSidebarVersionHistoryEntries(
  entries: VersionHistoryEntryViewModel[],
  limit = VERSION_HISTORY_SIDEBAR_LIMIT
): VersionHistoryEntryViewModel[] {
  return entries.slice(0, limit);
}

export function formatVersionHistoryDate(createdAt: string): string {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return date.toLocaleString([], {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  });
}

export function formatVersionTargetHeading(heading: string): string {
  return heading.replace(/^#{1,6}\s+/, "").trim();
}

export function isWeakVersionTitle(title: string): boolean {
  const normalized = title.trim();

  if (!normalized) {
    return true;
  }

  if (normalized.endsWith("?")) {
    return true;
  }

  if (
    /^(?:what|why|how)\s+(?:is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(
      normalized
    ) ||
    /^(?:can|could|should)\s+we\b/i.test(normalized) ||
    /^(?:is|does)\s+this\b/i.test(normalized)
  ) {
    return true;
  }

  return /^(?:please review|review|update|change this|what is this|what does it mean)$/i.test(
    normalized
  );
}

function createVersionHistoryEntry({
  patches,
  version
}: {
  patches: PatchmarkPatch[];
  version: PatchmarkVersionEntry;
}): VersionHistoryEntryViewModel {
  const relatedPatch = findPatchForVersion(version, patches);
  const detailItems = createBaseDetails(version);

  if (version.mutation?.mutation_type === "human_rewrite") {
    return {
      dateLabel: formatVersionHistoryDate(version.created_at),
      detailItems: [
        ...detailItems,
        { label: "Authorship", value: "Human-authored" },
        { label: "Rewrite session ID", value: version.mutation.rewrite_session_id },
        { label: "Target", value: version.mutation.target_kind },
        ...(version.mutation.heading_snapshot
          ? [{ label: "Heading snapshot", value: version.mutation.heading_snapshot }]
          : []),
        {
          label: "Semantic review",
          value:
            version.mutation.semantic_review_status === "reviewed"
              ? "Reviewed against current reference"
              : "Not reviewed"
        }
      ],
      targetHeading: version.mutation.heading_snapshot ?? undefined,
      title: version.mutation.heading_snapshot
        ? `Before human rewrite: ${formatVersionTargetHeading(
            version.mutation.heading_snapshot
          )}`
        : "Before human rewrite",
      typeLabel: "Human rewrite safety snapshot",
      version
    };
  }

  if (relatedPatch) {
    const patchTitle = getVersionPatchTitle(relatedPatch, version);

    return {
      dateLabel: formatVersionHistoryDate(version.created_at),
      detailItems: [
        ...detailItems,
        { label: "Patch ID", value: relatedPatch.id },
        ...(relatedPatch.patch_group_id
          ? [{ label: "Patch group ID", value: relatedPatch.patch_group_id }]
          : []),
        ...(relatedPatch.source_import_id
          ? [{ label: "Source import ID", value: relatedPatch.source_import_id }]
          : []),
        ...(relatedPatch.comment_id
          ? [{ label: "Linked comment ID", value: relatedPatch.comment_id }]
          : []),
        ...(relatedPatch.target_heading
          ? [{ label: "Original target heading", value: relatedPatch.target_heading }]
          : [])
      ],
      relatedPatchId: relatedPatch.id,
      sourceImportId: relatedPatch.source_import_id,
      targetHeading: relatedPatch.target_heading
        ? formatVersionTargetHeading(relatedPatch.target_heading)
        : undefined,
      title: `Before applying: ${patchTitle}`,
      typeLabel: "Pre-apply safety snapshot",
      version
    };
  }

  return {
    dateLabel: formatVersionHistoryDate(version.created_at),
    detailItems,
    title: getGenericSnapshotTitle(version),
    typeLabel: getGenericSnapshotType(version.reason),
    version
  };
}

function getVersionPatchTitle(
  patch: PatchmarkPatch,
  version: PatchmarkVersionEntry
): string {
  const explicitTitle = normalizePatchDisplayTitleCandidate(patch.display_title);

  if (explicitTitle && !isWeakVersionTitle(explicitTitle)) {
    return explicitTitle;
  }

  const snapshotTitle = getDescriptiveSnapshotReasonTitle(version.reason);

  if (snapshotTitle) {
    return snapshotTitle;
  }

  const reasonTitle = normalizePatchDisplayTitleCandidate(patch.reason);

  if (reasonTitle && !isWeakVersionTitle(reasonTitle)) {
    return reasonTitle;
  }

  return createPatchOperationTitle(patch);
}

function getDescriptiveSnapshotReasonTitle(reason: string): string | null {
  const trimmedReason = reason.trim();

  if (
    !trimmedReason ||
    PATCH_REASON_PATTERN.test(trimmedReason) ||
    /^(?:manual snapshot|pre-apply safety snapshot)$/i.test(trimmedReason) ||
    /restor|import/i.test(trimmedReason)
  ) {
    return null;
  }

  const title = normalizePatchDisplayTitleCandidate(trimmedReason);

  return title && !isWeakVersionTitle(title) ? title : null;
}

function createPatchOperationTitle(patch: PatchmarkPatch): string {
  const target = patch.target_heading
    ? formatVersionTargetHeading(patch.target_heading)
    : "document content";
  const originalText = patch.original_text.trim();
  const suggestedText = patch.suggested_text.trim();

  if (!originalText && suggestedText) {
    return `Add content to ${target}`;
  }

  if (originalText && !suggestedText) {
    return `Remove content from ${target}`;
  }

  return target === "document content" ? "Update document content" : `Update ${target}`;
}

function createBaseDetails(
  version: PatchmarkVersionEntry
): Array<{ label: string; value: string }> {
  return [
    { label: "Snapshot ID", value: version.id },
    { label: "Snapshot file", value: version.file },
    { label: "Stored document version", value: version.id },
    { label: "Exact reason", value: version.reason },
    ...(version.content_hash
      ? [{ label: "Content hash", value: version.content_hash }]
      : []),
    ...(version.mutation
      ? [
          { label: "Base text hash", value: version.mutation.base_text_sha256 },
          { label: "Applied text hash", value: version.mutation.applied_text_sha256 }
        ]
      : [])
  ];
}

function findPatchForVersion(
  version: PatchmarkVersionEntry,
  patches: PatchmarkPatch[]
): PatchmarkPatch | null {
  const reasonPatchId = getPatchIdFromSnapshotReason(version.reason);

  return (
    patches.find(
      (patch) =>
        patch.pre_apply_snapshot_id === version.id ||
        patch.pre_apply_snapshot_file === version.file ||
        (reasonPatchId !== null && patch.id === reasonPatchId)
    ) ?? null
  );
}

function getPatchIdFromSnapshotReason(reason: string): string | null {
  return PATCH_REASON_PATTERN.exec(reason)?.[1] ?? null;
}

function getGenericSnapshotTitle(version: PatchmarkVersionEntry): string {
  const reason = version.reason.trim();
  const reasonPatchId = getPatchIdFromSnapshotReason(reason);

  if (reasonPatchId) {
    return "Pre-apply safety snapshot";
  }

  if (/^manual snapshot$/i.test(reason)) {
    return "Manual snapshot";
  }

  if (/restor/i.test(reason)) {
    return "Before restoring version";
  }

  if (/import/i.test(reason)) {
    return "Imported document version";
  }

  return (
    normalizePatchDisplayTitleCandidate(reason) ??
    `Snapshot from ${formatVersionHistoryDate(version.created_at)}`
  );
}

function getGenericSnapshotType(reason: string): string {
  if (/^manual snapshot$/i.test(reason)) {
    return "Manual snapshot";
  }

  if (/restor/i.test(reason)) {
    return "Restore safety snapshot";
  }

  if (/import/i.test(reason)) {
    return "Imported document version";
  }

  if (PATCH_REASON_PATTERN.test(reason)) {
    return "Pre-apply safety snapshot";
  }

  return "Snapshot";
}

function compareVersionsNewestFirst(
  firstVersion: PatchmarkVersionEntry,
  secondVersion: PatchmarkVersionEntry
): number {
  const firstTime = Date.parse(firstVersion.created_at);
  const secondTime = Date.parse(secondVersion.created_at);

  if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) {
    return secondTime - firstTime;
  }

  return secondVersion.created_at.localeCompare(firstVersion.created_at);
}

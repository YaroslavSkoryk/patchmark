import {
  getPatchDisplayTitleInfo,
  normalizePatchDisplayTitleCandidate
} from "../patches/patch-display-title.ts";
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
  relatedPatchTitle?: string;
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
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));

  return [...versions]
    .sort(compareVersionsNewestFirst)
    .map((version) =>
      createVersionHistoryEntry({
        commentsById,
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

function createVersionHistoryEntry({
  commentsById,
  patches,
  version
}: {
  commentsById: Map<string, PatchmarkComment>;
  patches: PatchmarkPatch[];
  version: PatchmarkVersionEntry;
}): VersionHistoryEntryViewModel {
  const relatedPatch = findPatchForVersion(version, patches);
  const detailItems = createBaseDetails(version);

  if (relatedPatch) {
    const comment = relatedPatch.comment_id
      ? commentsById.get(relatedPatch.comment_id) ?? null
      : null;
    const patchTitle = getPatchDisplayTitleInfo(relatedPatch, {
      comment,
      includeGroupPosition: true
    }).title;

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
          : [])
      ],
      relatedPatchId: relatedPatch.id,
      relatedPatchTitle: patchTitle,
      sourceImportId: relatedPatch.source_import_id,
      targetHeading: relatedPatch.target_heading,
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
    return `Before applying: Patch ${reasonPatchId}`;
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

import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetConfidence,
  type CanonicalTargetMethod
} from "../comments/canonical-target-resolution.ts";
import {
  createPatchmarkDocumentIdentityKey,
  getPatchmarkDocumentIdentity
} from "../project/project-identity.ts";
import type {
  PatchmarkComment,
  PatchmarkDocumentIdentity,
  PatchmarkManifest,
  PatchmarkPatch,
  PatchmarkReadingBookmark,
  PatchmarkReadingBookmarkAnchor
} from "../project/project-types.ts";

export type ReadingBookmarkResolution =
  | {
      confidence: CanonicalTargetConfidence;
      end: number;
      method: CanonicalTargetMethod;
      start: number;
      state: "available";
    }
  | {
      state: "ambiguous" | "not_found";
    };

export function getCurrentDocumentReadingBookmark(
  manifest: PatchmarkManifest
): PatchmarkReadingBookmark | null {
  const identity = getPatchmarkDocumentIdentity(manifest);

  return (
    manifest.reading_bookmarks?.[
      createPatchmarkDocumentIdentityKey(identity)
    ] ?? null
  );
}

export function setDocumentReadingBookmark({
  anchor,
  document,
  manifest,
  timestamp
}: {
  anchor: PatchmarkReadingBookmarkAnchor;
  document?: PatchmarkDocumentIdentity;
  manifest: PatchmarkManifest;
  timestamp: string;
}): { bookmark: PatchmarkReadingBookmark; manifest: PatchmarkManifest } {
  const identity = document ?? getPatchmarkDocumentIdentity(manifest);
  const key = createPatchmarkDocumentIdentityKey(identity);
  const previous = manifest.reading_bookmarks?.[key];
  const bookmark: PatchmarkReadingBookmark = {
    format_version: 1,
    document: identity,
    anchor,
    created_at: previous?.created_at ?? timestamp,
    updated_at: timestamp
  };

  return {
    bookmark,
    manifest: {
      ...manifest,
      project_id: identity.project_id,
      reading_bookmarks: {
        ...manifest.reading_bookmarks,
        [key]: bookmark
      }
    }
  };
}

export function removeDocumentReadingBookmark({
  document,
  manifest
}: {
  document?: PatchmarkDocumentIdentity;
  manifest: PatchmarkManifest;
}): PatchmarkManifest {
  const identity = document ?? getPatchmarkDocumentIdentity(manifest);
  const key = createPatchmarkDocumentIdentityKey(identity);

  if (!manifest.reading_bookmarks?.[key]) {
    return manifest;
  }

  const nextBookmarks = { ...manifest.reading_bookmarks };
  delete nextBookmarks[key];

  return {
    ...manifest,
    project_id: identity.project_id,
    reading_bookmarks:
      Object.keys(nextBookmarks).length > 0 ? nextBookmarks : undefined
  };
}

export function resolveReadingBookmark({
  bookmark,
  markdown,
  patches = []
}: {
  bookmark: PatchmarkReadingBookmark;
  markdown: string;
  patches?: PatchmarkPatch[];
}): ReadingBookmarkResolution {
  const resolution = resolveCanonicalCommentTarget(
    createReadingBookmarkAnchorAdapter(bookmark),
    { markdown, patches }
  );

  if (
    resolution.state === "resolved" &&
    resolution.cardinality === "unique" &&
    resolution.confidence !== "low" &&
    resolution.method !== "none" &&
    resolution.range
  ) {
    return {
      confidence: resolution.confidence,
      end: resolution.range.end,
      method: resolution.method,
      start: resolution.range.start,
      state: "available"
    };
  }

  return {
    state: resolution.state === "ambiguous" ? "ambiguous" : "not_found"
  };
}

export function createReadingBookmarkAnchorAdapter(
  bookmark: PatchmarkReadingBookmark
): PatchmarkComment {
  return {
    id: `PM-READING-BOOKMARK-${createPatchmarkDocumentIdentityKey(
      bookmark.document
    )}`,
    type: "note",
    status: "open",
    anchor: bookmark.anchor,
    comment: "Reading bookmark",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: bookmark.created_at,
    updated_at: bookmark.updated_at
  };
}

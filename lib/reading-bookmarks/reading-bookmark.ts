import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetConfidence,
  type CanonicalTargetMethod
} from "../comments/canonical-target-resolution.ts";
import {
  assertProjectDocumentScope,
  createProjectDocumentKey,
  parsePersistedProjectDocumentIdentity,
  serializeProjectDocumentIdentity,
  type ProjectDocumentIdentity
} from "../project/document-scoped-identity.ts";
import type {
  PatchmarkComment,
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

export function getDocumentReadingBookmark({
  document,
  manifest
}: {
  document: ProjectDocumentIdentity;
  manifest: PatchmarkManifest;
}): PatchmarkReadingBookmark | null {
  const bookmark = manifest.reading_bookmark;
  if (!bookmark) {
    return null;
  }
  assertProjectDocumentScope(
    parsePersistedProjectDocumentIdentity(bookmark.document),
    document
  );
  return bookmark;
}

export function setDocumentReadingBookmark({
  anchor,
  document,
  manifest,
  timestamp
}: {
  anchor: PatchmarkReadingBookmarkAnchor;
  document: ProjectDocumentIdentity;
  manifest: PatchmarkManifest;
  timestamp: string;
}): { bookmark: PatchmarkReadingBookmark; manifest: PatchmarkManifest } {
  const previous = manifest.reading_bookmark;
  if (previous) {
    assertProjectDocumentScope(
      parsePersistedProjectDocumentIdentity(previous.document),
      document
    );
  }
  const bookmark: PatchmarkReadingBookmark = {
    format_version: 1,
    document: serializeProjectDocumentIdentity(document),
    anchor,
    created_at: previous?.created_at ?? timestamp,
    updated_at: timestamp
  };

  return {
    bookmark,
    manifest: {
      ...manifest,
      project_id: document.projectId,
      document_id: document.documentId,
      reading_bookmark: bookmark
    }
  };
}

export function removeDocumentReadingBookmark({
  document,
  manifest
}: {
  document: ProjectDocumentIdentity;
  manifest: PatchmarkManifest;
}): PatchmarkManifest {
  if (!manifest.reading_bookmark) {
    return manifest;
  }
  assertProjectDocumentScope(
    parsePersistedProjectDocumentIdentity(
      manifest.reading_bookmark.document
    ),
    document
  );
  const { reading_bookmark, ...nextManifest } = manifest;
  void reading_bookmark;
  return nextManifest;
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
    id: `PM-READING-BOOKMARK-${createProjectDocumentKey(
      parsePersistedProjectDocumentIdentity(bookmark.document)
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

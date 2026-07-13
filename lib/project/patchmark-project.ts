import { type MarkdownFileHandle } from "@/lib/files/file-system-access";
import {
  type PatchmarkCommentActionContext,
  type PatchmarkCommentActionIntent,
  type PatchmarkCommentActionScope,
  type PatchmarkCommentAnchor,
  type PatchmarkComment,
  type PatchmarkCommentAnchorHistoryEntry,
  type PatchmarkCommentExportState,
  type PatchmarkCommentFocusState,
  type PatchmarkCommentPatchImpact,
  type PatchmarkCommentStatus,
  type PatchmarkCommentThreadEntry,
  type PatchmarkCommentType,
  type PatchmarkManifest,
  type PatchmarkPatch,
  type PatchmarkPatchAnchorRecoveryEntry,
  type PatchmarkPatchAnchorRecoveryMethod,
  type PatchmarkPatchStatus,
  type PatchmarkSourceReference,
  type PatchmarkVersionEntry
} from "@/lib/project/project-types";

const documentFileName = "document.md";
const metadataDirectoryName = ".patchmark";
const manifestFileName = "manifest.json";

type DirectoryPickerOptions = {
  mode?: "read" | "readwrite";
};

type FileSystemAccessWindow = Window & {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions
  ) => Promise<PatchmarkDirectoryHandle>;
};

type DirectoryHandleOptions = {
  create?: boolean;
};

export type PatchmarkDirectoryHandle = {
  name: string;
  getFileHandle: (
    name: string,
    options?: DirectoryHandleOptions
  ) => Promise<MarkdownFileHandle>;
  getDirectoryHandle: (
    name: string,
    options?: DirectoryHandleOptions
  ) => Promise<PatchmarkDirectoryHandle>;
};

export type PatchmarkProjectHandle = {
  directoryHandle: PatchmarkDirectoryHandle;
  manifest: PatchmarkManifest;
};

export type LoadedPatchmarkProject = {
  project: PatchmarkProjectHandle;
  markdown: string;
};

export type CreateProjectSnapshotResult =
  | {
      created: true;
      project: PatchmarkProjectHandle;
      version: PatchmarkVersionEntry;
    }
  | {
      created: false;
      project: PatchmarkProjectHandle;
      reason: "unchanged";
    };

const emptyMetadataFiles = {
  "comments.json": "[]\n",
  "patches.json": "[]\n",
  "tasks.json": "[]\n"
} as const;

const commentTypes: PatchmarkCommentType[] = [
  "note",
  "question",
  "risk",
  "research_needed",
  "decision_needed"
];

const commentStatuses: PatchmarkCommentStatus[] = ["open", "resolved"];
const commentAnchorHistoryReasons: PatchmarkCommentAnchorHistoryEntry["reason"][] = [
  "patch_applied",
  "offset_shifted_after_patch",
  "anchor_recovered_after_patch",
  "anchor_reanchored_after_patch",
  "anchor_marked_needs_review_after_patch"
];
const patchCommentImpactKinds: PatchmarkCommentPatchImpact["impact_kind"][] = [
  "linked_comment",
  "anchor_inside_replaced_range",
  "anchor_intersects_replaced_range",
  "anchor_after_replaced_range",
  "section_may_have_shifted",
  "unaffected"
];
const patchCommentImpactResults: PatchmarkCommentPatchImpact["result"][] = [
  "reanchored",
  "offset_shifted",
  "unchanged",
  "needs_review"
];
const patchStatuses: PatchmarkPatchStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "stale"
];

const metadataDirectories = ["versions", "context-packs", "imports"] as const;

export function canOpenProjectFolder(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof getFileSystemAccessWindow().showDirectoryPicker === "function"
  );
}

export async function openProjectFolder(): Promise<LoadedPatchmarkProject | null> {
  const directoryHandle = await pickProjectDirectory();

  if (!directoryHandle) {
    return null;
  }

  const documentFileHandle = await getRequiredFileHandle(
    directoryHandle,
    documentFileName,
    "This folder does not contain document.md."
  );

  const metadataDirectoryHandle = await getRequiredDirectoryHandle(
    directoryHandle,
    metadataDirectoryName,
    "This folder contains document.md but is not initialized as a Patchmark project."
  );

  const manifestFileHandle = await getRequiredFileHandle(
    metadataDirectoryHandle,
    manifestFileName,
    "This folder is missing .patchmark/manifest.json."
  );

  const manifest = normalizeManifest(
    JSON.parse(await readTextFile(manifestFileHandle)),
    directoryHandle.name
  );

  await ensureProjectMetadata(directoryHandle, manifest);

  return {
    markdown: await readTextFile(documentFileHandle),
    project: {
      directoryHandle,
      manifest
    }
  };
}

export async function createProjectFromMarkdown({
  markdown,
  suggestedProjectName
}: {
  markdown: string;
  suggestedProjectName: string | null;
}): Promise<LoadedPatchmarkProject | null> {
  const directoryHandle = await pickProjectDirectory();

  if (!directoryHandle) {
    return null;
  }

  if (
    (await hasFile(directoryHandle, documentFileName)) ||
    (await hasDirectory(directoryHandle, metadataDirectoryName))
  ) {
    throw new Error(
      "This folder already contains a Patchmark project or document.md. Choose an empty folder."
    );
  }

  const now = new Date().toISOString();
  const manifest: PatchmarkManifest = {
    schema_version: 1,
    project_name: createProjectName(
      suggestedProjectName ?? directoryHandle.name,
      directoryHandle.name
    ),
    document_file: documentFileName,
    created_at: now,
    updated_at: now
  };

  await writeProjectDocument(directoryHandle, markdown);
  await ensureProjectMetadata(directoryHandle, manifest);

  return {
    markdown,
    project: {
      directoryHandle,
      manifest
    }
  };
}

export async function saveProjectDocument(
  project: PatchmarkProjectHandle,
  markdown: string
): Promise<PatchmarkProjectHandle> {
  const manifest = {
    ...project.manifest,
    updated_at: new Date().toISOString()
  };

  await writeProjectDocument(project.directoryHandle, markdown);
  await writeManifest(project.directoryHandle, manifest);

  return {
    ...project,
    manifest
  };
}

export async function createProjectSnapshot({
  allowDuplicate = false,
  project,
  markdown,
  reason = "manual snapshot"
}: {
  allowDuplicate?: boolean;
  project: PatchmarkProjectHandle;
  markdown: string;
  reason?: string;
}): Promise<CreateProjectSnapshotResult> {
  const versions = project.manifest.versions ?? [];
  const latestVersion = versions.at(-1);
  const contentHash = await createMarkdownHash(markdown);

  if (
    !allowDuplicate &&
    latestVersion &&
    (await isSameAsLatestSnapshot({
      contentHash,
      markdown,
      project,
      version: latestVersion
    }))
  ) {
    return {
      created: false,
      project,
      reason: "unchanged"
    };
  }

  const createdAt = new Date().toISOString();
  const snapshotId = createSnapshotId(createdAt);
  const snapshotFile = `.patchmark/versions/${snapshotId}.md`;
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const versionsDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("versions", {
      create: true
    });
  const snapshotFileHandle = await versionsDirectoryHandle.getFileHandle(
    `${snapshotId}.md`,
    { create: true }
  );
  const versionEntry: PatchmarkVersionEntry = {
    id: snapshotId,
    file: snapshotFile,
    created_at: createdAt,
    reason,
    content_hash: contentHash
  };
  const manifest: PatchmarkManifest = {
    ...project.manifest,
    updated_at: createdAt,
    current_version: snapshotId,
    versions: [...versions, versionEntry]
  };

  await writeTextFile(snapshotFileHandle, markdown);
  await writeManifest(project.directoryHandle, manifest);

  return {
    created: true,
    version: versionEntry,
    project: {
      ...project,
      manifest
    }
  };
}

async function isSameAsLatestSnapshot({
  contentHash,
  markdown,
  project,
  version
}: {
  contentHash: string | undefined;
  markdown: string;
  project: PatchmarkProjectHandle;
  version: PatchmarkVersionEntry;
}): Promise<boolean> {
  if (
    contentHash &&
    version.content_hash &&
    contentHash === version.content_hash
  ) {
    return true;
  }

  if (
    contentHash &&
    version.content_hash &&
    contentHash !== version.content_hash
  ) {
    return false;
  }

  try {
    return (await readProjectVersionMarkdown(project, version)) === markdown;
  } catch (error) {
    if (isNotFoundError(error) || isSnapshotNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function createMarkdownHash(markdown: string): Promise<string | undefined> {
  const subtleCrypto = globalThis.crypto?.subtle;

  if (!subtleCrypto) {
    return undefined;
  }

  const hashBuffer = await subtleCrypto.digest(
    "SHA-256",
    new TextEncoder().encode(markdown)
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isSnapshotNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === "Snapshot file not found.";
}

export async function listProjectVersions(
  project: PatchmarkProjectHandle
): Promise<PatchmarkVersionEntry[]> {
  return project.manifest.versions ?? [];
}

export async function readProjectVersionMarkdown(
  project: PatchmarkProjectHandle,
  version: PatchmarkVersionEntry
): Promise<string> {
  const snapshotFileName = version.file.split("/").pop();

  if (!snapshotFileName) {
    throw new Error("Snapshot file not found.");
  }

  const metadataDirectoryHandle = await getRequiredDirectoryHandle(
    project.directoryHandle,
    metadataDirectoryName,
    "Snapshot file not found."
  );
  const versionsDirectoryHandle = await getRequiredDirectoryHandle(
    metadataDirectoryHandle,
    "versions",
    "Snapshot file not found."
  );
  const snapshotFileHandle = await getRequiredFileHandle(
    versionsDirectoryHandle,
    snapshotFileName,
    "Snapshot file not found."
  );

  return readTextFile(snapshotFileHandle);
}

export async function readProjectComments(
  project: PatchmarkProjectHandle
): Promise<PatchmarkComment[]> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );

  let commentsFileHandle: MarkdownFileHandle;

  try {
    commentsFileHandle =
      await metadataDirectoryHandle.getFileHandle("comments.json");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    commentsFileHandle = await metadataDirectoryHandle.getFileHandle(
      "comments.json",
      { create: true }
    );
    await writeTextFile(commentsFileHandle, "[]\n");
    return [];
  }

  let parsedComments: unknown;

  try {
    parsedComments = JSON.parse(await readTextFile(commentsFileHandle));
  } catch {
    throw new Error(
      ".patchmark/comments.json is invalid JSON. Fix the file before editing comments."
    );
  }

  if (!Array.isArray(parsedComments)) {
    throw new Error(
      ".patchmark/comments.json must contain an array of comments."
    );
  }

  return parsedComments.map(normalizeComment);
}

export async function writeProjectComments(
  project: PatchmarkProjectHandle,
  comments: PatchmarkComment[]
): Promise<void> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const commentsFileHandle = await metadataDirectoryHandle.getFileHandle(
    "comments.json",
    { create: true }
  );

  await writeTextFile(
    commentsFileHandle,
    `${JSON.stringify(comments.map(normalizeComment), null, 2)}\n`
  );
}

export async function writeProjectContextPack({
  contents,
  fileName,
  project
}: {
  contents: string;
  fileName: string;
  project: PatchmarkProjectHandle;
}): Promise<string> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const contextPacksDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("context-packs", {
      create: true
    });
  const contextPackFileHandle = await contextPacksDirectoryHandle.getFileHandle(
    fileName,
    { create: true }
  );

  await writeTextFile(contextPackFileHandle, contents);

  return `${metadataDirectoryName}/context-packs/${fileName}`;
}

export async function readProjectPatches(
  project: PatchmarkProjectHandle
): Promise<PatchmarkPatch[]> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );

  let patchesFileHandle: MarkdownFileHandle;

  try {
    patchesFileHandle =
      await metadataDirectoryHandle.getFileHandle("patches.json");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    patchesFileHandle = await metadataDirectoryHandle.getFileHandle(
      "patches.json",
      { create: true }
    );
    await writeTextFile(patchesFileHandle, "[]\n");
    return [];
  }

  let parsedPatches: unknown;

  try {
    parsedPatches = JSON.parse(await readTextFile(patchesFileHandle));
  } catch {
    throw new Error(
      ".patchmark/patches.json is invalid JSON. Fix the file before importing ChatGPT responses."
    );
  }

  if (!Array.isArray(parsedPatches)) {
    throw new Error(".patchmark/patches.json must contain an array of patches.");
  }

  return parsedPatches.map(normalizePatch);
}

export async function writeProjectPatches(
  project: PatchmarkProjectHandle,
  patches: PatchmarkPatch[]
): Promise<void> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const patchesFileHandle = await metadataDirectoryHandle.getFileHandle(
    "patches.json",
    { create: true }
  );

  await writeTextFile(
    patchesFileHandle,
    `${JSON.stringify(patches.map(normalizePatch), null, 2)}\n`
  );
}

export async function writeProjectImport({
  contents,
  fileName,
  project
}: {
  contents: string;
  fileName: string;
  project: PatchmarkProjectHandle;
}): Promise<string> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const importsDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("imports", {
      create: true
    });
  const importFileHandle = await importsDirectoryHandle.getFileHandle(fileName, {
    create: true
  });

  await writeTextFile(importFileHandle, contents);

  return `${metadataDirectoryName}/imports/${fileName}`;
}

async function pickProjectDirectory(): Promise<PatchmarkDirectoryHandle | null> {
  const directoryPicker = getFileSystemAccessWindow().showDirectoryPicker;

  if (!directoryPicker) {
    throw new Error(
      "Project folders require a browser with File System Access API support. You can continue using Single File Mode."
    );
  }

  try {
    return await directoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

async function ensureProjectMetadata(
  directoryHandle: PatchmarkDirectoryHandle,
  manifest: PatchmarkManifest
): Promise<void> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );

  await writeManifest(directoryHandle, manifest);

  await Promise.all(
    Object.entries(emptyMetadataFiles).map(async ([fileName, contents]) => {
      if (await hasFile(metadataDirectoryHandle, fileName)) {
        return;
      }

      const fileHandle = await metadataDirectoryHandle.getFileHandle(fileName, {
        create: true
      });
      await writeTextFile(fileHandle, contents);
    })
  );

  await Promise.all(
    metadataDirectories.map((directoryName) =>
      metadataDirectoryHandle.getDirectoryHandle(directoryName, { create: true })
    )
  );
}

async function writeProjectDocument(
  directoryHandle: PatchmarkDirectoryHandle,
  markdown: string
): Promise<void> {
  const documentFileHandle = await directoryHandle.getFileHandle(
    documentFileName,
    { create: true }
  );
  await writeTextFile(documentFileHandle, markdown);
}

async function writeManifest(
  directoryHandle: PatchmarkDirectoryHandle,
  manifest: PatchmarkManifest
): Promise<void> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const manifestFileHandle = await metadataDirectoryHandle.getFileHandle(
    manifestFileName,
    { create: true }
  );
  await writeTextFile(
    manifestFileHandle,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

async function getRequiredFileHandle(
  directoryHandle: PatchmarkDirectoryHandle,
  fileName: string,
  message: string
): Promise<MarkdownFileHandle> {
  try {
    return await directoryHandle.getFileHandle(fileName);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(message);
    }

    throw error;
  }
}

async function getRequiredDirectoryHandle(
  directoryHandle: PatchmarkDirectoryHandle,
  directoryName: string,
  message: string
): Promise<PatchmarkDirectoryHandle> {
  try {
    return await directoryHandle.getDirectoryHandle(directoryName);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(message);
    }

    throw error;
  }
}

async function hasFile(
  directoryHandle: PatchmarkDirectoryHandle,
  fileName: string
): Promise<boolean> {
  try {
    await directoryHandle.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function hasDirectory(
  directoryHandle: PatchmarkDirectoryHandle,
  directoryName: string
): Promise<boolean> {
  try {
    await directoryHandle.getDirectoryHandle(directoryName);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function readTextFile(fileHandle: MarkdownFileHandle): Promise<string> {
  return (await fileHandle.getFile()).text();
}

async function writeTextFile(
  fileHandle: MarkdownFileHandle,
  contents: string
): Promise<void> {
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

function normalizeManifest(
  manifest: unknown,
  fallbackProjectName: string
): PatchmarkManifest {
  if (!isRecord(manifest)) {
    throw new Error(".patchmark/manifest.json is not valid JSON metadata.");
  }

  if (manifest.schema_version !== 1) {
    throw new Error("Unsupported Patchmark project schema version.");
  }

  if (manifest.document_file !== documentFileName) {
    throw new Error("Patchmark projects must use document.md as the document file.");
  }

  const now = new Date().toISOString();
  return {
    schema_version: 1,
    project_name:
      typeof manifest.project_name === "string"
        ? manifest.project_name
        : createProjectName(fallbackProjectName, fallbackProjectName),
    document_file: documentFileName,
    created_at:
      typeof manifest.created_at === "string" ? manifest.created_at : now,
    updated_at:
      typeof manifest.updated_at === "string" ? manifest.updated_at : now,
    current_version:
      typeof manifest.current_version === "string"
        ? manifest.current_version
        : undefined,
    versions: Array.isArray(manifest.versions)
      ? manifest.versions.filter(isPatchmarkVersionEntry)
      : undefined
  };
}

function isPatchmarkVersionEntry(value: unknown): value is PatchmarkVersionEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.file === "string" &&
    typeof value.created_at === "string" &&
    typeof value.reason === "string" &&
    (value.content_hash === undefined || typeof value.content_hash === "string")
  );
}

function normalizeComment(comment: unknown): PatchmarkComment {
  if (!isRecord(comment)) {
    throw new Error(".patchmark/comments.json contains an invalid comment.");
  }

  if (
    typeof comment.id !== "string" ||
    !isPatchmarkCommentType(comment.type) ||
    typeof comment.comment !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof comment.updated_at !== "string"
  ) {
    throw new Error(".patchmark/comments.json contains an invalid comment.");
  }

  const status = isPatchmarkCommentStatus(comment.status)
    ? comment.status
    : "open";

  return {
    id: comment.id,
    type: comment.type,
    status,
    anchor: normalizeCommentAnchor(comment),
    comment: comment.comment,
    thread: normalizeCommentThread(comment.thread),
    export_state: normalizeCommentExportState(comment.export_state),
    anchor_history: normalizeCommentAnchorHistory(comment.anchor_history),
    patch_impacts: normalizeCommentPatchImpacts(comment.patch_impacts),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    resolved_at:
      status === "resolved" && typeof comment.resolved_at === "string"
        ? comment.resolved_at
        : undefined
  };
}

function normalizeCommentAnchorHistory(
  history: unknown
): PatchmarkCommentAnchorHistoryEntry[] | undefined {
  if (!Array.isArray(history)) {
    return undefined;
  }

  const normalizedHistory = history
    .filter(isPatchmarkCommentAnchorHistoryEntry)
    .map((entry) => ({
      changed_at: entry.changed_at,
      reason: entry.reason,
      source_patch_id: entry.source_patch_id,
      previous_anchor: normalizeKnownCommentAnchor(entry.previous_anchor, "note"),
      new_anchor: entry.new_anchor
        ? normalizeKnownCommentAnchor(entry.new_anchor, "note")
        : undefined,
      impact_kind: entry.impact_kind
    }));

  return normalizedHistory.length > 0 ? normalizedHistory : undefined;
}

function normalizeCommentPatchImpacts(
  impacts: unknown
): PatchmarkCommentPatchImpact[] | undefined {
  if (!Array.isArray(impacts)) {
    return undefined;
  }

  const normalizedImpacts = impacts
    .filter(isPatchmarkCommentPatchImpact)
    .map((impact) => ({
      patch_id: impact.patch_id,
      impacted_at: impact.impacted_at,
      impact_kind: impact.impact_kind,
      result: impact.result,
      note: impact.note
    }));

  return normalizedImpacts.length > 0 ? normalizedImpacts : undefined;
}

function normalizeCommentAnchor(
  comment: Record<string, unknown>
): PatchmarkCommentAnchor {
  if (isPatchmarkCommentAnchor(comment.anchor)) {
    return normalizeKnownCommentAnchor(comment.anchor, comment.type);
  }

  if (typeof comment.target_heading === "string") {
    return {
      kind: "section",
      heading: comment.target_heading,
      heading_level:
        typeof comment.target_heading_level === "number"
          ? comment.target_heading_level
          : undefined,
      heading_line:
        typeof comment.target_heading_line === "number"
          ? comment.target_heading_line
          : undefined,
      heading_path: Array.isArray(comment.target_heading_path)
        ? comment.target_heading_path.filter(
            (pathEntry): pathEntry is string => typeof pathEntry === "string"
          )
        : undefined,
      action_context: createDefaultActionContext("section", comment.type)
    };
  }

  return {
    kind: "document",
    action_context: createDefaultActionContext("document", comment.type)
  };
}

function normalizeKnownCommentAnchor(
  anchor: PatchmarkCommentAnchor,
  commentType: unknown
): PatchmarkCommentAnchor {
  if (anchor.kind === "document") {
    return {
      kind: "document",
      action_context:
        normalizeActionContext(
          anchor.action_context,
          getActionIntentForCommentType(commentType)
        ) ??
        createDefaultActionContext("document", commentType)
    };
  }

  if (anchor.kind === "section") {
    return {
      kind: "section",
      heading: anchor.heading,
      heading_level: anchor.heading_level,
      heading_line: anchor.heading_line,
      heading_path: anchor.heading_path,
      section_start_offset: anchor.section_start_offset,
      section_end_offset: anchor.section_end_offset,
      action_context:
        normalizeActionContext(
          anchor.action_context,
          getActionIntentForCommentType(commentType)
        ) ??
        createDefaultActionContext("section", commentType)
    };
  }

  return {
    kind: "selected_text",
    selected_text: anchor.selected_text,
    selected_text_hash: anchor.selected_text_hash,
    anchor_context:
      normalizeAnchorContext(anchor.anchor_context) ??
      createLegacyAnchorContext(anchor),
    markdown_start_offset: anchor.markdown_start_offset,
    markdown_end_offset: anchor.markdown_end_offset,
    context_before: anchor.context_before,
    context_after: anchor.context_after,
    containing_heading: anchor.containing_heading,
    containing_heading_level: anchor.containing_heading_level,
    containing_heading_line: anchor.containing_heading_line,
    containing_heading_path: anchor.containing_heading_path,
    anchor_source: anchor.anchor_source,
    fallback_section_start_offset: anchor.fallback_section_start_offset,
    fallback_section_end_offset: anchor.fallback_section_end_offset,
    action_context:
      normalizeActionContext(
        anchor.action_context,
        getActionIntentForCommentType(commentType)
      ) ??
      createDefaultActionContext("selected_text", commentType)
  };
}

function normalizeAnchorContext(
  context: unknown
): Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>["anchor_context"] {
  if (
    !isRecord(context) ||
    !isAnchorContextKind(context.kind) ||
    typeof context.plain_text !== "string"
  ) {
    return undefined;
  }

  return {
    kind: context.kind,
    plain_text: context.plain_text,
    markdown_text:
      typeof context.markdown_text === "string" ? context.markdown_text : undefined,
    selected_start_in_context:
      typeof context.selected_start_in_context === "number"
        ? context.selected_start_in_context
        : undefined,
    selected_end_in_context:
      typeof context.selected_end_in_context === "number"
        ? context.selected_end_in_context
        : undefined,
    context_hash:
      typeof context.context_hash === "string" ? context.context_hash : undefined,
    markdown_start_offset:
      typeof context.markdown_start_offset === "number"
        ? context.markdown_start_offset
        : undefined,
    markdown_end_offset:
      typeof context.markdown_end_offset === "number"
        ? context.markdown_end_offset
        : undefined
  };
}

function createLegacyAnchorContext(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>["anchor_context"] {
  if (
    typeof anchor.anchor_text !== "string" ||
    !anchor.anchor_text.trim() ||
    anchor.anchor_text === anchor.selected_text
  ) {
    return undefined;
  }

  return {
    kind:
      anchor.anchor_text_source === "expanded_sentence"
        ? "sentence"
        : anchor.anchor_text_source === "expanded_block"
          ? "block"
          : "paragraph",
    plain_text: anchor.anchor_text,
    markdown_text: anchor.anchor_text
  };
}

function normalizeActionContext(
  context: unknown,
  fallbackIntent: PatchmarkCommentActionIntent
): PatchmarkCommentActionContext | undefined {
  if (
    !isRecord(context) ||
    !isCommentActionScope(context.default_scope) ||
    typeof context.include_document_brief !== "boolean" ||
    !isCommentOpenCommentsScope(context.include_open_comments)
  ) {
    return undefined;
  }

  return {
    default_scope: context.default_scope,
    include_document_brief: context.include_document_brief,
    include_open_comments: context.include_open_comments,
    intent_hint: isCommentActionIntent(context.intent_hint)
      ? context.intent_hint
      : fallbackIntent
  };
}

function normalizeCommentThread(thread: unknown): PatchmarkCommentThreadEntry[] {
  if (!Array.isArray(thread)) {
    return [];
  }

  return thread
    .filter(isPatchmarkCommentThreadEntry)
    .map(normalizeCommentThreadEntry);
}

function normalizeCommentThreadEntry(
  entry: PatchmarkCommentThreadEntry
): PatchmarkCommentThreadEntry {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    created_at: entry.created_at,
    source_import_id: entry.source_import_id,
    source_chat_url: entry.source_chat_url,
    source_patch_id: entry.source_patch_id,
    suggested_user_action: entry.suggested_user_action,
    sources: normalizeSourceReferences(entry.sources)
  };
}

function normalizeCommentExportState(
  exportState: unknown
): PatchmarkCommentExportState {
  if (!isRecord(exportState)) {
    return {
      focus_state: "idle"
    };
  }

  return {
    focus_state: isCommentFocusState(exportState.focus_state)
      ? exportState.focus_state
      : "idle",
    marked_for_export_at:
      typeof exportState.marked_for_export_at === "string"
        ? exportState.marked_for_export_at
        : undefined,
    last_exported_at:
      typeof exportState.last_exported_at === "string"
        ? exportState.last_exported_at
        : undefined,
    last_export_id:
      typeof exportState.last_export_id === "string"
        ? exportState.last_export_id
        : undefined,
    last_imported_at:
      typeof exportState.last_imported_at === "string"
        ? exportState.last_imported_at
        : undefined,
    last_import_id:
      typeof exportState.last_import_id === "string"
        ? exportState.last_import_id
        : undefined
  };
}

function normalizePatch(patch: unknown): PatchmarkPatch {
  if (!isRecord(patch)) {
    throw new Error(".patchmark/patches.json contains an invalid patch.");
  }

  if (
    typeof patch.id !== "string" ||
    typeof patch.original_text !== "string" ||
    typeof patch.suggested_text !== "string" ||
    typeof patch.created_at !== "string"
  ) {
    throw new Error(".patchmark/patches.json contains an invalid patch.");
  }

  return {
    id: patch.id,
    status: isPatchmarkPatchStatus(patch.status) ? patch.status : "pending",
    patch_group_id:
      typeof patch.patch_group_id === "string"
        ? patch.patch_group_id
        : undefined,
    patch_group_index:
      typeof patch.patch_group_index === "number" &&
      Number.isInteger(patch.patch_group_index) &&
      patch.patch_group_index > 0
        ? patch.patch_group_index
        : undefined,
    patch_group_total:
      typeof patch.patch_group_total === "number" &&
      Number.isInteger(patch.patch_group_total) &&
      patch.patch_group_total > 0
        ? patch.patch_group_total
        : undefined,
    comment_id:
      typeof patch.comment_id === "string" ? patch.comment_id : undefined,
    source_import_id:
      typeof patch.source_import_id === "string"
        ? patch.source_import_id
        : undefined,
    source_chat_url:
      typeof patch.source_chat_url === "string"
        ? patch.source_chat_url
        : undefined,
    display_title:
      typeof patch.display_title === "string"
        ? patch.display_title
        : typeof patch.title === "string"
          ? patch.title
          : undefined,
    target_heading:
      typeof patch.target_heading === "string"
        ? patch.target_heading
        : undefined,
    original_text: patch.original_text,
    suggested_text: patch.suggested_text,
    suggested_text_sources: normalizeSourceReferences(
      patch.suggested_text_sources
    ),
    reason: typeof patch.reason === "string" ? patch.reason : "No reason provided.",
    reason_sources: normalizeSourceReferences(patch.reason_sources),
    risk: typeof patch.risk === "string" ? patch.risk : undefined,
    risk_sources: normalizeSourceReferences(patch.risk_sources),
    sources: normalizeSourceReferences(patch.sources),
    created_at: patch.created_at,
    resolved_at:
      typeof patch.resolved_at === "string" ? patch.resolved_at : undefined,
    accepted_at:
      typeof patch.accepted_at === "string" ? patch.accepted_at : undefined,
    applied_at:
      typeof patch.applied_at === "string" ? patch.applied_at : undefined,
    rejected_at:
      typeof patch.rejected_at === "string" ? patch.rejected_at : undefined,
    pre_apply_snapshot_id:
      typeof patch.pre_apply_snapshot_id === "string"
        ? patch.pre_apply_snapshot_id
        : undefined,
    pre_apply_snapshot_file:
      typeof patch.pre_apply_snapshot_file === "string"
        ? patch.pre_apply_snapshot_file
        : undefined,
    applied_text:
      typeof patch.applied_text === "string" ? patch.applied_text : undefined,
    applied_start_offset:
      typeof patch.applied_start_offset === "number" &&
      Number.isInteger(patch.applied_start_offset) &&
      patch.applied_start_offset >= 0
        ? patch.applied_start_offset
        : undefined,
    applied_end_offset:
      typeof patch.applied_end_offset === "number" &&
      Number.isInteger(patch.applied_end_offset) &&
      patch.applied_end_offset >= 0
        ? patch.applied_end_offset
        : undefined,
    applied_context_before:
      typeof patch.applied_context_before === "string"
        ? patch.applied_context_before
        : undefined,
    applied_context_after:
      typeof patch.applied_context_after === "string"
        ? patch.applied_context_after
        : undefined,
    applied_heading:
      typeof patch.applied_heading === "string"
        ? patch.applied_heading
        : undefined,
    applied_heading_id:
      typeof patch.applied_heading_id === "string"
        ? patch.applied_heading_id
        : undefined,
    applied_heading_path: Array.isArray(patch.applied_heading_path)
      ? patch.applied_heading_path.filter(
          (heading): heading is string => typeof heading === "string"
        )
      : undefined,
    applied_table_index:
      typeof patch.applied_table_index === "number" &&
      Number.isInteger(patch.applied_table_index) &&
      patch.applied_table_index >= 0
        ? patch.applied_table_index
        : undefined,
    applied_table_row_index:
      typeof patch.applied_table_row_index === "number" &&
      Number.isInteger(patch.applied_table_row_index) &&
      patch.applied_table_row_index >= 0
        ? patch.applied_table_row_index
        : undefined,
    applied_table_row_anchor:
      typeof patch.applied_table_row_anchor === "string"
        ? patch.applied_table_row_anchor
        : undefined,
    applied_table_row_cells: Array.isArray(patch.applied_table_row_cells)
      ? patch.applied_table_row_cells.filter(
          (cell): cell is string => typeof cell === "string"
        )
      : undefined,
    anchor_recovery_history: normalizePatchAnchorRecoveryHistory(
      patch.anchor_recovery_history
    ),
    previous_original_text:
      typeof patch.previous_original_text === "string"
        ? patch.previous_original_text
        : undefined,
    reanchored_at:
      typeof patch.reanchored_at === "string" ? patch.reanchored_at : undefined,
    reanchor_reason:
      patch.reanchor_reason === "table_row_normalized_match"
        ? patch.reanchor_reason
        : undefined
  };
}

function normalizePatchAnchorRecoveryHistory(
  history: unknown
): PatchmarkPatchAnchorRecoveryEntry[] | undefined {
  if (!Array.isArray(history)) {
    return undefined;
  }

  const normalizedHistory = history.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const recovery = entry as Record<string, unknown>;
    const method = recovery.method;

    if (
      typeof recovery.recovered_at !== "string" ||
      !isPatchAnchorRecoveryMethod(method)
    ) {
      return [];
    }

    const confidence =
      recovery.confidence === "ambiguous"
        ? ("ambiguous" as const)
        : ("high_confidence" as const);

    return [
      {
        recovered_at: recovery.recovered_at,
        confidence,
        method,
        previous_original_text:
          typeof recovery.previous_original_text === "string"
            ? recovery.previous_original_text
            : undefined,
        recovered_text:
          typeof recovery.recovered_text === "string"
            ? recovery.recovered_text
            : undefined,
        detail: typeof recovery.detail === "string" ? recovery.detail : undefined
      }
    ];
  });

  return normalizedHistory.length > 0 ? normalizedHistory : undefined;
}

function isPatchAnchorRecoveryMethod(
  method: unknown
): method is PatchmarkPatchAnchorRecoveryMethod {
  return (
    method === "descendant_patch_chain" ||
    method === "deterministic_offset_migration" ||
    method === "exact_match" ||
    method === "normalized_match" ||
    method === "unique_section_context_match" ||
    method === "unique_table_row_match"
  );
}

function normalizeSourceReferences(
  sources: unknown
): PatchmarkSourceReference[] | undefined {
  if (!Array.isArray(sources)) {
    return undefined;
  }

  const normalizedSources = sources
    .filter(isPatchmarkSourceReference)
    .map((source) => ({
      title: source.title,
      url: source.url,
      note: source.note,
      supports: source.supports
    }));

  return normalizedSources.length > 0 ? normalizedSources : undefined;
}

function createDefaultActionContext(
  anchorKind: PatchmarkCommentAnchor["kind"],
  commentType: unknown
): PatchmarkCommentActionContext {
  return anchorKind === "document"
    ? {
        default_scope: "full_document",
        include_document_brief: true,
        include_open_comments: "focused_only",
        intent_hint: getActionIntentForCommentType(commentType)
      }
    : {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: getActionIntentForCommentType(commentType)
      };
}

function getActionIntentForCommentType(
  commentType: unknown
): PatchmarkCommentActionIntent {
  if (commentType === "question" || commentType === "decision_needed") {
    return "decision";
  }

  if (commentType === "risk") {
    return "risk_review";
  }

  if (commentType === "research_needed") {
    return "research";
  }

  return "note";
}

function isPatchmarkCommentAnchorHistoryEntry(
  value: unknown
): value is PatchmarkCommentAnchorHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.changed_at === "string" &&
    isCommentAnchorHistoryReason(value.reason) &&
    (value.source_patch_id === undefined ||
      typeof value.source_patch_id === "string") &&
    isPatchmarkCommentAnchor(value.previous_anchor) &&
    (value.new_anchor === undefined || isPatchmarkCommentAnchor(value.new_anchor)) &&
    (value.impact_kind === undefined || isPatchCommentImpactKind(value.impact_kind))
  );
}

function isPatchmarkCommentPatchImpact(
  value: unknown
): value is PatchmarkCommentPatchImpact {
  return (
    isRecord(value) &&
    typeof value.patch_id === "string" &&
    typeof value.impacted_at === "string" &&
    isPatchCommentImpactKind(value.impact_kind) &&
    isPatchCommentImpactResult(value.result) &&
    (value.note === undefined || typeof value.note === "string")
  );
}

function isCommentAnchorHistoryReason(
  value: unknown
): value is PatchmarkCommentAnchorHistoryEntry["reason"] {
  return (
    typeof value === "string" &&
    commentAnchorHistoryReasons.includes(
      value as PatchmarkCommentAnchorHistoryEntry["reason"]
    )
  );
}

function isPatchCommentImpactKind(
  value: unknown
): value is PatchmarkCommentPatchImpact["impact_kind"] {
  return (
    typeof value === "string" &&
    patchCommentImpactKinds.includes(
      value as PatchmarkCommentPatchImpact["impact_kind"]
    )
  );
}

function isPatchCommentImpactResult(
  value: unknown
): value is PatchmarkCommentPatchImpact["result"] {
  return (
    typeof value === "string" &&
    patchCommentImpactResults.includes(
      value as PatchmarkCommentPatchImpact["result"]
    )
  );
}

function isPatchmarkCommentAnchor(
  anchor: unknown
): anchor is PatchmarkCommentAnchor {
  if (!isRecord(anchor) || typeof anchor.kind !== "string") {
    return false;
  }

  if (anchor.kind === "document") {
    return true;
  }

  if (anchor.kind === "section") {
    return typeof anchor.heading === "string";
  }

  if (anchor.kind === "selected_text") {
    return typeof anchor.selected_text === "string";
  }

  return false;
}

function isAnchorContextKind(value: unknown): value is NonNullable<
  Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>["anchor_context"]
>["kind"] {
  return (
    typeof value === "string" &&
    [
      "sentence",
      "paragraph",
      "heading",
      "list_item",
      "table_cell",
      "blockquote",
      "block",
      "section"
    ].includes(value)
  );
}

function isCommentActionScope(
  value: unknown
): value is PatchmarkCommentActionScope {
  return (
    typeof value === "string" &&
    [
      "display_target",
      "anchor_context",
      "containing_section",
      "full_document"
    ].includes(value)
  );
}

function isCommentActionIntent(
  value: unknown
): value is PatchmarkCommentActionIntent {
  return (
    typeof value === "string" &&
    ["note", "review", "rewrite", "research", "risk_review", "decision"].includes(
      value
    )
  );
}

function isPatchmarkCommentThreadEntry(
  value: unknown
): value is PatchmarkCommentThreadEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" ||
      value.role === "chatgpt" ||
      value.role === "system") &&
    typeof value.content === "string" &&
    typeof value.created_at === "string" &&
    (value.source_import_id === undefined ||
      typeof value.source_import_id === "string") &&
    (value.source_chat_url === undefined ||
      typeof value.source_chat_url === "string") &&
    (value.source_patch_id === undefined ||
      typeof value.source_patch_id === "string") &&
    (value.suggested_user_action === undefined ||
      isSuggestedUserAction(value.suggested_user_action)) &&
    (value.sources === undefined ||
      (Array.isArray(value.sources) &&
        value.sources.every(isPatchmarkSourceReference)))
  );
}

function isCommentFocusState(value: unknown): value is PatchmarkCommentFocusState {
  return (
    typeof value === "string" &&
    [
      "idle",
      "in_focus",
      "exported",
      "awaiting_reply",
      "reply_received"
    ].includes(value)
  );
}

function isCommentOpenCommentsScope(
  value: unknown
): value is PatchmarkCommentActionContext["include_open_comments"] {
  return (
    typeof value === "string" &&
    ["none", "same_section", "focused_only", "all"].includes(value)
  );
}

function isPatchmarkCommentType(
  value: unknown
): value is PatchmarkCommentType {
  return (
    typeof value === "string" &&
    (commentTypes as readonly string[]).includes(value)
  );
}

function isPatchmarkCommentStatus(
  value: unknown
): value is PatchmarkCommentStatus {
  return (
    typeof value === "string" &&
    (commentStatuses as readonly string[]).includes(value)
  );
}

function isPatchmarkPatchStatus(value: unknown): value is PatchmarkPatchStatus {
  return (
    typeof value === "string" &&
    (patchStatuses as readonly string[]).includes(value)
  );
}

function isSuggestedUserAction(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
      "review",
      "clarify",
      "apply_patch",
      "keep_open",
      "resolve_manually"
    ].includes(value)
  );
}

function isPatchmarkSourceReference(
  value: unknown
): value is PatchmarkSourceReference {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    value.url.trim().length > 0 &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.note === undefined || typeof value.note === "string") &&
    (value.supports === undefined || typeof value.supports === "string")
  );
}

function createProjectName(
  suggestedProjectName: string,
  fallbackProjectName: string
): string {
  const withoutExtension = suggestedProjectName.replace(/\.(md|markdown)$/i, "");
  const normalized = withoutExtension
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallbackProjectName || "Patchmark_Project";
}

function createSnapshotId(createdAt: string): string {
  const [datePart, timePart = ""] = createdAt.replace("Z", "").split("T");
  const timestamp = `${datePart.replace(/-/g, "")}-${timePart
    .replace(/:/g, "")
    .replace(".", "-")}`;

  return `snapshot-${timestamp}`;
}

function getFileSystemAccessWindow(): FileSystemAccessWindow {
  return window as FileSystemAccessWindow;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

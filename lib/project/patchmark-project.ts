import { type MarkdownFileHandle } from "@/lib/files/file-system-access";
import {
  type PatchmarkCommentAnchor,
  type PatchmarkComment,
  type PatchmarkCommentStatus,
  type PatchmarkCommentType,
  type PatchmarkManifest,
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
  project,
  markdown,
  reason = "manual snapshot"
}: {
  project: PatchmarkProjectHandle;
  markdown: string;
  reason?: string;
}): Promise<CreateProjectSnapshotResult> {
  const versions = project.manifest.versions ?? [];
  const latestVersion = versions.at(-1);
  const contentHash = await createMarkdownHash(markdown);

  if (
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
    `${JSON.stringify(comments, null, 2)}\n`
  );
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
    !isPatchmarkCommentStatus(comment.status) ||
    typeof comment.comment !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof comment.updated_at !== "string"
  ) {
    throw new Error(".patchmark/comments.json contains an invalid comment.");
  }

  return {
    id: comment.id,
    type: comment.type,
    status: comment.status,
    anchor: normalizeCommentAnchor(comment),
    comment: comment.comment,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    resolved_at:
      typeof comment.resolved_at === "string" ? comment.resolved_at : undefined
  };
}

function normalizeCommentAnchor(
  comment: Record<string, unknown>
): PatchmarkCommentAnchor {
  if (isPatchmarkCommentAnchor(comment.anchor)) {
    return comment.anchor;
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
        : undefined
    };
  }

  return {
    kind: "document"
  };
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
  const timestamp = createdAt
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")
    .replace("Z", "");

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

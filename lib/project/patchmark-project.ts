import { type MarkdownFileHandle } from "../files/file-system-access.ts";
import {
  addExistingProjectDocument as registerExistingProjectDocument,
  archiveRegisteredDocument,
  completePendingProjectMigration,
  convertLegacyProject,
  createDocumentScopedDirectoryHandle,
  createProjectDocument as registerCreatedProjectDocument,
  getRegisteredDocument,
  listProjectDocuments,
  locateProjectDocument as repairProjectDocumentPath,
  markLegacyConversionReopened,
  readProjectManifest,
  reorderRegisteredDocument,
  resolveProjectFilePath,
  rollbackPendingProjectMigration,
  restoreRegisteredDocument,
  updateDocumentRegistration,
  writeProjectManifestAtomic,
  type PatchmarkDocumentAvailability,
  type PatchmarkDocumentRole,
  type PatchmarkProjectDocumentView,
  type PatchmarkProjectManifestV1,
  type PatchmarkRegisteredDocument,
  type ProjectDirectoryHandle,
  type ProjectFileHandle
} from "./multi-document-project.ts";
import {
  type PatchmarkCommentActionContext,
  type PatchmarkCommentActionIntent,
  type PatchmarkCommentActionScope,
  type PatchmarkCommentAnchor,
  type PatchmarkComment,
  type PatchmarkCommentAnchorHistoryEntry,
  type PatchmarkConciseAnchorHistoryState,
  type PatchmarkConciseCommentAnchorHistoryEntry,
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
  type PatchmarkPersistedFileCommit,
  type PatchmarkSaveCommit,
  type PatchmarkSuggestedUserAction,
  type PatchmarkSourceReference,
  type PatchmarkVersionEntry
} from "./project-types.ts";

const documentFileName = "document.md";
const metadataDirectoryName = ".patchmark";
const manifestFileName = "manifest.json";
const commentsFileName = "comments.json";
const patchesFileName = "patches.json";
const saveCommitFileName = "save-commit.json";
const recoveryDirectoryName = "recovery";
const saveCommitFormatVersion = 1;

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
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  entries?: () => AsyncIterableIterator<[string, { kind?: "file" | "directory" }]>;
  resolve?: (possibleDescendant: { kind?: "file" | "directory" }) => Promise<string[] | null>;
};

export type PatchmarkProjectRecoveryState = {
  kind:
    | "incomplete_save"
    | "invalid_current_state"
    | "missing_document"
    | "migration_rolled_back";
  canRestore: boolean;
  message: string;
  technicalDetails: string[];
  temporaryFiles: string[];
};

type PatchmarkProjectPersistenceState = {
  generation: number;
  commit: PatchmarkSaveCommit | null;
  files: Partial<Record<ProjectCommitFileKey, PatchmarkPersistedFileCommit>>;
  documentText: string;
  manifestText: string;
  commentsReference?: PatchmarkComment[];
  patchesReference?: PatchmarkPatch[];
  commentsRaw?: string;
  patchesRaw?: string;
  readSource: "current" | "current_readonly" | "lkg";
  recovery?: PatchmarkProjectRecoveryState;
  debug: PatchmarkPersistenceDebugState;
};

export type PatchmarkProjectHandle = {
  directoryHandle: PatchmarkDirectoryHandle;
  manifest: PatchmarkManifest;
  persistence: PatchmarkProjectPersistenceState;
  projectMode?: "legacy" | "multi";
  projectDirectoryHandle?: PatchmarkDirectoryHandle;
  projectManifest?: PatchmarkProjectManifestV1;
  document?: PatchmarkRegisteredDocument;
  documentAvailability?: PatchmarkDocumentAvailability;
};

export type LoadedPatchmarkProject = {
  project: PatchmarkProjectHandle;
  markdown: string;
  recovery?: PatchmarkProjectRecoveryState;
};

export type PatchmarkProjectCommitResult = {
  status: "committed" | "unchanged" | "superseded";
  generation: number;
  commitId?: string;
  changedFiles: ProjectCommitFileKey[];
  serializedFiles: ProjectCommitFileKey[];
  bytesWritten: number;
};

export type PatchmarkPersistenceDebugState = {
  requestedCommits: number;
  committedGenerations: number;
  unchangedCommits: number;
  supersededCommits: number;
  serializationCount: number;
  writeCount: number;
  bytesWritten: number;
  staleRequestsSkipped: number;
  lastResult?: PatchmarkProjectCommitResult;
  lastFileResults: Partial<
    Record<ProjectCommitFileKey, "changed" | "unchanged" | "skipped">
  >;
};

export type ProjectCommitFileKey =
  | "document"
  | "comments"
  | "patches"
  | "manifest";

type PreparedProjectFile = {
  key: ProjectCommitFileKey | "commit";
  directoryHandle: PatchmarkDirectoryHandle;
  temporaryFileName: string;
  targetFileName: string;
  text: string;
  descriptor: PatchmarkPersistedFileCommit;
};

type ProjectCommitRequest = {
  markdown?: string;
  comments?: PatchmarkComment[];
  patches?: PatchmarkPatch[];
  manifest?: PatchmarkManifest;
  reason: string;
  allowSupersede?: boolean;
};

type ProjectWriteQueueState = {
  tail: Promise<void>;
  latestRequestId: number;
};

const projectWriteQueues = new WeakMap<
  PatchmarkDirectoryHandle,
  ProjectWriteQueueState
>();

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
  "anchor_reanchored_by_human",
  "anchor_marked_needs_review_after_patch"
];
const commentAnchorHistoryCauses: PatchmarkConciseCommentAnchorHistoryEntry["cause"][] = [
  "manual_edit",
  "patch_apply",
  "canonical_recovery",
  "historical_convergence",
  "human_reanchor",
  "document_restore"
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

  let multiDocumentManifestError: unknown;
  let migrationRollbackError: unknown;
  let projectManifest: PatchmarkProjectManifestV1 | null = null;
  try {
    projectManifest = await readProjectManifest(
      directoryHandle as ProjectDirectoryHandle
    );
  } catch (error) {
    multiDocumentManifestError = error;
  }
  if (projectManifest) {
    try {
      const loaded = await openRegisteredProjectFromManifest(
        directoryHandle,
        projectManifest
      );
      await completePendingProjectMigration(
        directoryHandle as ProjectDirectoryHandle,
        projectManifest
      );
      return loaded;
    } catch (error) {
      const rolledBack = await rollbackPendingProjectMigration(
        directoryHandle as ProjectDirectoryHandle,
        projectManifest,
        error
      );
      if (!rolledBack) {
        throw error;
      }
      migrationRollbackError = error;
    }
  }

  try {
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

    const manifestText = await readTextFile(manifestFileHandle);
    const markdown = await readTextFile(documentFileHandle);
    const openedProject = await createOpenedProjectHandle({
      directoryHandle,
      manifestText,
      markdown
    });
    openedProject.project.projectMode = "legacy";
    openedProject.project.projectDirectoryHandle = directoryHandle;
    if (migrationRollbackError) {
      const recovery: PatchmarkProjectRecoveryState = {
        kind: "migration_rolled_back",
        canRestore: false,
        message:
          "Patchmark rolled back an incomplete multi-document conversion and reopened the untouched legacy project.",
        technicalDetails: [
          migrationRollbackError instanceof Error
            ? migrationRollbackError.message
            : String(migrationRollbackError)
        ],
        temporaryFiles: []
      };
      openedProject.project.persistence.recovery = recovery;
      return {
        markdown: openedProject.markdown,
        project: openedProject.project,
        recovery
      };
    }

    return {
      markdown: openedProject.markdown,
      project: openedProject.project,
      recovery: openedProject.project.persistence.recovery
    };
  } catch (error) {
    if (multiDocumentManifestError) {
      throw multiDocumentManifestError;
    }
    throw error;
  }
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
  await ensureProjectMetadata(directoryHandle, manifest, true);

  const manifestText = serializeManifest(manifest);
  const project: PatchmarkProjectHandle = {
    directoryHandle,
    manifest,
    projectMode: "legacy",
    projectDirectoryHandle: directoryHandle,
    persistence: await createLegacyPersistenceState({
      directoryHandle,
      documentText: markdown,
      manifestText
    })
  };

  return {
    markdown,
    project
  };
}

export function isMultiDocumentProject(project: PatchmarkProjectHandle): boolean {
  return project.projectMode === "multi" && Boolean(project.projectManifest);
}

export function getProjectTitle(project: PatchmarkProjectHandle): string {
  return project.projectManifest?.title ?? project.manifest.project_name;
}

export function getActiveProjectDocument(
  project: PatchmarkProjectHandle
): PatchmarkRegisteredDocument | null {
  return project.document ?? null;
}

export function getProjectDocumentExportIdentity(
  project: PatchmarkProjectHandle
): {
  project_name: string;
  project_id?: string;
  document_file: string;
  document_id?: string;
  document_title?: string;
  document_role?: PatchmarkDocumentRole;
} {
  return {
    project_name: getProjectTitle(project),
    project_id: project.projectManifest?.project_id,
    document_file: project.document?.path ?? project.manifest.document_file,
    document_id: project.document?.document_id,
    document_title: project.document?.display_title,
    document_role: project.document?.role
  };
}

export async function getProjectDocumentList(
  project: PatchmarkProjectHandle
): Promise<PatchmarkProjectDocumentView[]> {
  const root = getAuthoritativeProjectDirectory(project);
  if (!project.projectManifest) {
    return [
      {
        document_id: "legacy-document",
        path: project.manifest.document_file,
        display_title: createLegacyDocumentTitle(project),
        role: null,
        status: "active",
        position: 1000,
        added_at: project.manifest.created_at,
        archived_at: null,
        availability: "available"
      }
    ];
  }
  return listProjectDocuments(
    root as ProjectDirectoryHandle,
    project.projectManifest
  );
}

export async function convertProjectToMultiDocument(
  project: PatchmarkProjectHandle
): Promise<LoadedPatchmarkProject> {
  const prepared = await prepareMultiDocumentProject(project);
  if (prepared.migrationId) {
    await markLegacyConversionReopened(
      getAuthoritativeProjectDirectory(prepared.loaded.project) as ProjectDirectoryHandle,
      prepared.migrationId,
      "complete"
    );
  }
  return prepared.loaded;
}

export async function createNewProjectDocument({
  displayTitle,
  markdown,
  path,
  project,
  role
}: {
  displayTitle: string;
  markdown?: string;
  path: string;
  project: PatchmarkProjectHandle;
  role: PatchmarkDocumentRole;
}): Promise<LoadedPatchmarkProject> {
  const prepared = await prepareMultiDocumentProject(project);
  const activeProject = prepared.loaded.project;
  const root = getAuthoritativeProjectDirectory(activeProject);
  const registry = requireProjectManifest(activeProject);
  const result = await registerCreatedProjectDocument({
    displayTitle,
    manifest: registry,
    markdown,
    path,
    role,
    root: root as ProjectDirectoryHandle
  });
  updateProjectRegistryContext(activeProject, result.manifest);
  const loaded = await openRegisteredProjectDocument(
    root,
    result.manifest,
    result.document.document_id
  );
  if (prepared.migrationId) {
    await markLegacyConversionReopened(
      root as ProjectDirectoryHandle,
      prepared.migrationId,
      "complete"
    );
  }
  return loaded;
}

export async function addExistingDocumentToProject({
  displayTitle,
  path,
  project,
  role
}: {
  displayTitle?: string;
  path: string;
  project: PatchmarkProjectHandle;
  role: PatchmarkDocumentRole;
}): Promise<LoadedPatchmarkProject> {
  const prepared = await prepareMultiDocumentProject(project);
  const activeProject = prepared.loaded.project;
  const root = getAuthoritativeProjectDirectory(activeProject);
  const registry = requireProjectManifest(activeProject);
  const result = await registerExistingProjectDocument({
    displayTitle,
    manifest: registry,
    path,
    role,
    root: root as ProjectDirectoryHandle
  });
  updateProjectRegistryContext(activeProject, result.manifest);
  const loaded = await openRegisteredProjectDocument(
    root,
    result.manifest,
    result.document.document_id
  );
  if (prepared.migrationId) {
    await markLegacyConversionReopened(
      root as ProjectDirectoryHandle,
      prepared.migrationId,
      "complete"
    );
  }
  return loaded;
}

export async function resolveDocumentPathFromFileHandle(
  project: PatchmarkProjectHandle,
  fileHandle: MarkdownFileHandle
): Promise<string> {
  return resolveProjectFilePath(
    getAuthoritativeProjectDirectory(project) as ProjectDirectoryHandle,
    fileHandle as ProjectFileHandle
  );
}

export async function openProjectDocument(
  project: PatchmarkProjectHandle,
  documentId: string
): Promise<LoadedPatchmarkProject> {
  return openRegisteredProjectDocument(
    getAuthoritativeProjectDirectory(project),
    requireProjectManifest(project),
    documentId
  );
}

export async function switchProjectDocument({
  comments,
  documentId,
  markdown,
  patches,
  project
}: {
  comments: PatchmarkComment[];
  documentId: string;
  markdown: string;
  patches: PatchmarkPatch[];
  project: PatchmarkProjectHandle;
}): Promise<LoadedPatchmarkProject> {
  if (project.documentAvailability !== "missing") {
    await saveProjectState({
      comments,
      markdown,
      patches,
      project,
      reason: "switch_document"
    });
  }
  return openProjectDocument(project, documentId);
}

export async function updateProjectDocumentMetadata({
  displayTitle,
  documentId,
  project,
  role
}: {
  displayTitle?: string;
  documentId: string;
  project: PatchmarkProjectHandle;
  role?: PatchmarkDocumentRole;
}): Promise<PatchmarkProjectManifestV1> {
  const next = updateDocumentRegistration(
    requireProjectManifest(project),
    documentId,
    {
      ...(displayTitle !== undefined ? { display_title: displayTitle } : {}),
      ...(role !== undefined ? { role } : {})
    }
  );
  if (next !== project.projectManifest) {
    await commitProjectRegistry(project, next);
  }
  return next;
}

export async function moveProjectDocument({
  direction,
  documentId,
  project
}: {
  direction: "up" | "down";
  documentId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = reorderRegisteredDocument(current, documentId, direction);
  if (next !== current) {
    await commitProjectRegistry(project, next);
  }
  return next;
}

export async function archiveProjectDocument({
  documentId,
  project
}: {
  documentId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = archiveRegisteredDocument(current, documentId);
  if (next !== current) {
    await commitProjectRegistry(project, next);
  }
  return next;
}

export async function restoreProjectDocument({
  documentId,
  project
}: {
  documentId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = restoreRegisteredDocument(current, documentId);
  if (next !== current) {
    await commitProjectRegistry(project, next);
  }
  return next;
}

export async function locateProjectDocument({
  documentId,
  path,
  project
}: {
  documentId: string;
  path: string;
  project: PatchmarkProjectHandle;
}): Promise<LoadedPatchmarkProject> {
  const root = getAuthoritativeProjectDirectory(project);
  const next = await repairProjectDocumentPath({
    documentId,
    manifest: requireProjectManifest(project),
    path,
    root: root as ProjectDirectoryHandle
  });
  updateProjectRegistryContext(project, next);
  return openRegisteredProjectDocument(root, next, documentId);
}

export async function saveProjectDocument(
  project: PatchmarkProjectHandle,
  markdown: string
): Promise<PatchmarkProjectHandle> {
  await commitProjectState({
    project,
    markdown,
    reason: "save_document"
  });

  return project;
}

export async function saveProjectState({
  comments,
  manifest,
  markdown,
  patches,
  project,
  reason,
  allowSupersede = false
}: {
  comments?: PatchmarkComment[];
  manifest?: PatchmarkManifest;
  markdown?: string;
  patches?: PatchmarkPatch[];
  project: PatchmarkProjectHandle;
  reason: string;
  allowSupersede?: boolean;
}): Promise<PatchmarkProjectCommitResult> {
  return commitProjectState({
    allowSupersede,
    comments,
    manifest,
    markdown,
    patches,
    project,
    reason
  });
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
  await commitProjectState({
    manifest,
    project,
    reason: "create_snapshot"
  });

  return {
    created: true,
    version: versionEntry,
      project
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
  const metadataDirectoryHandle = await getProjectReadMetadataDirectory(project);

  let commentsFileHandle: MarkdownFileHandle;

  try {
    commentsFileHandle =
      await metadataDirectoryHandle.getFileHandle(
        project.persistence.readSource === "lkg"
          ? "comments.json.lkg"
          : commentsFileName
      );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    if (project.persistence.readSource === "lkg") {
      throw new Error("The last complete comments recovery file is missing.");
    }

    commentsFileHandle = await metadataDirectoryHandle.getFileHandle(
      commentsFileName,
      { create: true }
    );
    await writeTextFile(commentsFileHandle, "[]\n");
    return [];
  }

  let parsedComments: unknown;
  const rawComments =
    project.persistence.commentsRaw ?? (await readTextFile(commentsFileHandle));

  try {
    parsedComments = JSON.parse(rawComments);
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

  const comments = parsedComments.map(normalizeComment);
  project.persistence.commentsReference = comments;
  project.persistence.commentsRaw = undefined;
  project.persistence.files.comments = await createPersistedFileCommit(
    ".patchmark/comments.json",
    rawComments
  );
  return comments;
}

export async function writeProjectComments(
  project: PatchmarkProjectHandle,
  comments: PatchmarkComment[],
  options: { allowSupersede?: boolean; reason?: string } = {}
): Promise<PatchmarkProjectCommitResult> {
  return commitProjectState({
    allowSupersede: options.allowSupersede,
    comments,
    project,
    reason: options.reason ?? "update_comments"
  });
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
  const metadataDirectoryHandle = await getProjectReadMetadataDirectory(project);

  let patchesFileHandle: MarkdownFileHandle;

  try {
    patchesFileHandle =
      await metadataDirectoryHandle.getFileHandle(
        project.persistence.readSource === "lkg"
          ? "patches.json.lkg"
          : patchesFileName
      );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    if (project.persistence.readSource === "lkg") {
      throw new Error("The last complete patches recovery file is missing.");
    }

    patchesFileHandle = await metadataDirectoryHandle.getFileHandle(
      patchesFileName,
      { create: true }
    );
    await writeTextFile(patchesFileHandle, "[]\n");
    return [];
  }

  let parsedPatches: unknown;
  const rawPatches =
    project.persistence.patchesRaw ?? (await readTextFile(patchesFileHandle));

  try {
    parsedPatches = JSON.parse(rawPatches);
  } catch {
    throw new Error(
      ".patchmark/patches.json is invalid JSON. Fix the file before importing ChatGPT responses."
    );
  }

  if (!Array.isArray(parsedPatches)) {
    throw new Error(".patchmark/patches.json must contain an array of patches.");
  }

  const patches = parsedPatches.map(normalizePatch);
  project.persistence.patchesReference = patches;
  project.persistence.patchesRaw = undefined;
  project.persistence.files.patches = await createPersistedFileCommit(
    ".patchmark/patches.json",
    rawPatches
  );
  return patches;
}

export async function writeProjectPatches(
  project: PatchmarkProjectHandle,
  patches: PatchmarkPatch[],
  options: { allowSupersede?: boolean; reason?: string } = {}
): Promise<PatchmarkProjectCommitResult> {
  return commitProjectState({
    allowSupersede: options.allowSupersede,
    patches,
    project,
    reason: options.reason ?? "update_patches"
  });
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

export function getProjectPersistenceDebugState(
  project: PatchmarkProjectHandle
): PatchmarkPersistenceDebugState {
  return {
    ...project.persistence.debug,
    lastFileResults: { ...project.persistence.debug.lastFileResults },
    lastResult: project.persistence.debug.lastResult
      ? { ...project.persistence.debug.lastResult }
      : undefined
  };
}

export function resetProjectPersistenceDebugState(
  project: PatchmarkProjectHandle
): void {
  project.persistence.debug = createEmptyPersistenceDebugState();
}

export async function restoreProjectLastKnownGood(
  project: PatchmarkProjectHandle
): Promise<LoadedPatchmarkProject> {
  const lkg = await readValidLastKnownGoodGeneration(project.directoryHandle);

  if (!lkg) {
    throw new Error("The last complete project save is no longer available.");
  }

  await preserveQuestionableCurrentProjectFiles(project.directoryHandle);
  const restoreId = `restore-${Date.now().toString(36)}`;
  const preparedFiles: PreparedProjectFile[] = [];

  try {
    for (const key of ["document", "comments", "patches", "manifest"] as const) {
      preparedFiles.push(
        await prepareProjectTemporaryFile({
          commitId: restoreId,
          directoryHandle: project.directoryHandle,
          key,
          text: lkg.texts[key],
          onWrite: (bytes) => recordPersistenceWrite(project, bytes)
        })
      );
    }
    preparedFiles.push(
      await prepareSaveCommitTemporaryFile({
        commitId: restoreId,
        directoryHandle: project.directoryHandle,
        text: serializeSaveCommit(lkg.commit),
        onWrite: (bytes) => recordPersistenceWrite(project, bytes)
      })
    );

    for (const prepared of preparedFiles.filter(
      (file) => file.key !== "manifest" && file.key !== "commit"
    )) {
      await installPreparedProjectFile(prepared, (bytes) =>
        recordPersistenceWrite(project, bytes)
      );
    }

    const manifestPrepared = preparedFiles.find(
      (file) => file.key === "manifest"
    );
    const commitPrepared = preparedFiles.find((file) => file.key === "commit");

    if (!manifestPrepared || !commitPrepared) {
      throw new Error("Could not prepare the last complete project save.");
    }

    await installPreparedProjectFile(manifestPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
    await installPreparedProjectFile(commitPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
  } finally {
    await cleanupPreparedFiles(preparedFiles);
  }

  const restoredProject: PatchmarkProjectHandle = {
    directoryHandle: project.directoryHandle,
    document: project.document,
    documentAvailability: project.documentAvailability,
    manifest: lkg.manifest,
    projectDirectoryHandle: project.projectDirectoryHandle,
    projectManifest: project.projectManifest,
    projectMode: project.projectMode,
    persistence: {
      generation: lkg.commit.generation,
      commit: lkg.commit,
      files: lkg.commit.files,
      documentText: lkg.texts.document,
      manifestText: lkg.texts.manifest,
      commentsRaw: lkg.texts.comments,
      patchesRaw: lkg.texts.patches,
      readSource: "current",
      debug: createEmptyPersistenceDebugState()
    }
  };
  await cleanupStaleProjectTemporaryFiles(project.directoryHandle);
  return {
    markdown: lkg.texts.document,
    project: restoredProject
  };
}

export async function cleanupStaleProjectTemporaryFiles(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<number> {
  let removed = 0;
  removed += await cleanupTemporaryFilesInDirectory(directoryHandle);
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    removed += await cleanupTemporaryFilesInDirectory(metadataDirectoryHandle);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  return removed;
}

async function commitProjectState({
  allowSupersede = false,
  comments,
  manifest,
  markdown,
  patches,
  project,
  reason
}: ProjectCommitRequest & {
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectCommitResult> {
  if (project.persistence.readSource !== "current") {
    throw new Error(
      "Restore the last complete project save before making persistent changes."
    );
  }

  const queue = getProjectWriteQueue(project.directoryHandle);
  const requestId = queue.latestRequestId + 1;
  queue.latestRequestId = requestId;
  project.persistence.debug.requestedCommits += 1;

  let resolveResult!: (result: PatchmarkProjectCommitResult) => void;
  let rejectResult!: (error: unknown) => void;
  const resultPromise = new Promise<PatchmarkProjectCommitResult>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    }
  );

  const run = async () => {
    try {
      if (allowSupersede && requestId < queue.latestRequestId) {
        resolveResult(recordSupersededCommit(project));
        return;
      }

      const result = await executeProjectCommit({
        allowSupersede,
        comments,
        manifest,
        markdown,
        patches,
        project,
        queue,
        reason,
        requestId
      });
      resolveResult(result);
    } catch (error) {
      rejectResult(error);
    }
  };

  queue.tail = queue.tail.then(run, run);
  queue.tail = queue.tail.catch(() => undefined);
  return resultPromise;
}

async function executeProjectCommit({
  allowSupersede,
  comments,
  manifest,
  markdown,
  patches,
  project,
  queue,
  reason,
  requestId
}: ProjectCommitRequest & {
  project: PatchmarkProjectHandle;
  queue: ProjectWriteQueueState;
  requestId: number;
}): Promise<PatchmarkProjectCommitResult> {
  const persistence = project.persistence;
  const debug = persistence.debug;
  const bytesWrittenBeforeCommit = debug.bytesWritten;
  const changedFiles: ProjectCommitFileKey[] = [];
  const serializedFiles: ProjectCommitFileKey[] = [];
  const desiredTexts: Partial<Record<ProjectCommitFileKey, string>> = {};

  debug.lastFileResults = {
    document: "skipped",
    comments: "skipped",
    patches: "skipped",
    manifest: "skipped"
  };

  if (markdown !== undefined) {
    if (markdown === persistence.documentText) {
      debug.lastFileResults.document = "unchanged";
    } else {
      changedFiles.push("document");
      desiredTexts.document = markdown;
      debug.lastFileResults.document = "changed";
    }
  }

  if (comments !== undefined) {
    if (comments === persistence.commentsReference) {
      debug.lastFileResults.comments = "unchanged";
    } else {
      const commentsText = serializeComments(comments);
      serializedFiles.push("comments");
      debug.serializationCount += 1;
      const commentsCommit = await createPersistedFileCommit(
        ".patchmark/comments.json",
        commentsText
      );
      const currentCommentsCommit =
        persistence.files.comments ??
        (await readCurrentFileCommit(project, "comments"));

      if (commentsCommit.sha256 === currentCommentsCommit.sha256) {
        persistence.commentsReference = comments;
        debug.lastFileResults.comments = "unchanged";
      } else {
        changedFiles.push("comments");
        desiredTexts.comments = commentsText;
        debug.lastFileResults.comments = "changed";
      }
    }
  }

  if (patches !== undefined) {
    if (patches === persistence.patchesReference) {
      debug.lastFileResults.patches = "unchanged";
    } else {
      const patchesText = serializePatches(patches);
      serializedFiles.push("patches");
      debug.serializationCount += 1;
      const patchesCommit = await createPersistedFileCommit(
        ".patchmark/patches.json",
        patchesText
      );
      const currentPatchesCommit =
        persistence.files.patches ??
        (await readCurrentFileCommit(project, "patches"));

      if (patchesCommit.sha256 === currentPatchesCommit.sha256) {
        persistence.patchesReference = patches;
        debug.lastFileResults.patches = "unchanged";
      } else {
        changedFiles.push("patches");
        desiredTexts.patches = patchesText;
        debug.lastFileResults.patches = "changed";
      }
    }
  }

  const manifestChanged =
    manifest !== undefined &&
    createManifestMeaningfulKey(manifest) !==
      createManifestMeaningfulKey(project.manifest);

  if (manifestChanged) {
    changedFiles.push("manifest");
    debug.lastFileResults.manifest = "changed";
  } else if (manifest !== undefined) {
    debug.lastFileResults.manifest = "unchanged";
  }

  if (changedFiles.length === 0) {
    const result: PatchmarkProjectCommitResult = {
      status: "unchanged",
      generation: persistence.generation,
      changedFiles: [],
      serializedFiles,
      bytesWritten: 0
    };
    debug.unchangedCommits += 1;
    debug.lastResult = result;
    return result;
  }

  if (allowSupersede && requestId < queue.latestRequestId) {
    return recordSupersededCommit(project, serializedFiles);
  }

  const currentTexts = await readCurrentProjectTexts(project.directoryHandle);
  const currentDescriptors = await createProjectFileDescriptors(currentTexts);
  const currentCommit =
    persistence.commit ??
    createLegacyBaselineCommit({
      descriptors: currentDescriptors,
      manifest: project.manifest
    });

  await writeLastKnownGoodGeneration({
    commit: currentCommit,
    directoryHandle: project.directoryHandle,
    texts: currentTexts,
    onWrite: (bytes) => recordPersistenceWrite(project, bytes)
  });

  const createdAt = new Date().toISOString();
  const generation = Math.max(persistence.generation, currentCommit.generation) + 1;
  const commitId = createSaveCommitId(generation);
  const nextManifest: PatchmarkManifest = {
    ...(manifest ?? project.manifest),
    updated_at: createdAt,
    save_generation: generation,
    save_commit_id: commitId
  };
  const manifestText = serializeManifest(nextManifest);
  desiredTexts.manifest = manifestText;
  debug.serializationCount += 1;
  serializedFiles.push("manifest");

  const nextTexts = {
    ...currentTexts,
    ...desiredTexts
  } satisfies Record<ProjectCommitFileKey, string>;
  const nextDescriptors = await createProjectFileDescriptors(nextTexts);
  const saveCommit: PatchmarkSaveCommit = {
    format_version: saveCommitFormatVersion,
    generation,
    commit_id: commitId,
    created_at: createdAt,
    files: nextDescriptors
  };
  const commitText = serializeSaveCommit(saveCommit);
  const preparedFiles: PreparedProjectFile[] = [];

  try {
    for (const key of changedFiles.filter((key) => key !== "manifest")) {
      preparedFiles.push(
        await prepareProjectTemporaryFile({
          commitId,
          directoryHandle: project.directoryHandle,
          key,
          text: nextTexts[key],
          onWrite: (bytes) => recordPersistenceWrite(project, bytes)
        })
      );
    }
    preparedFiles.push(
      await prepareProjectTemporaryFile({
        commitId,
        directoryHandle: project.directoryHandle,
        key: "manifest",
        text: manifestText,
        onWrite: (bytes) => recordPersistenceWrite(project, bytes)
      })
    );
    preparedFiles.push(
      await prepareSaveCommitTemporaryFile({
        commitId,
        directoryHandle: project.directoryHandle,
        text: commitText,
        onWrite: (bytes) => recordPersistenceWrite(project, bytes)
      })
    );

    if (allowSupersede && requestId < queue.latestRequestId) {
      await cleanupPreparedFiles(preparedFiles);
      return recordSupersededCommit(project, serializedFiles);
    }

    for (const prepared of preparedFiles.filter(
      (file) => file.key !== "manifest" && file.key !== "commit"
    )) {
      await installPreparedProjectFile(prepared, (bytes) =>
        recordPersistenceWrite(project, bytes)
      );
    }

    const manifestPrepared = preparedFiles.find(
      (file) => file.key === "manifest"
    );
    const commitPrepared = preparedFiles.find((file) => file.key === "commit");

    if (!manifestPrepared || !commitPrepared) {
      throw new Error(`Could not prepare project save ${reason}.`);
    }

    await installPreparedProjectFile(manifestPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
    await installPreparedProjectFile(commitPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
  } finally {
    await cleanupPreparedFiles(preparedFiles);
  }

  project.manifest = nextManifest;
  persistence.generation = generation;
  persistence.commit = saveCommit;
  persistence.files = nextDescriptors;
  persistence.documentText = nextTexts.document;
  persistence.manifestText = manifestText;
  persistence.readSource = "current";
  persistence.recovery = undefined;

  if (comments !== undefined) {
    persistence.commentsReference = comments;
  }

  if (patches !== undefined) {
    persistence.patchesReference = patches;
  }

  const bytesWritten = debug.bytesWritten - bytesWrittenBeforeCommit;
  const result: PatchmarkProjectCommitResult = {
    status: "committed",
    generation,
    commitId,
    changedFiles: Array.from(
      new Set<ProjectCommitFileKey>([...changedFiles, "manifest"])
    ),
    serializedFiles,
    bytesWritten
  };
  debug.committedGenerations += 1;
  debug.lastResult = result;
  return result;
}

function getProjectWriteQueue(
  directoryHandle: PatchmarkDirectoryHandle
): ProjectWriteQueueState {
  const existing = projectWriteQueues.get(directoryHandle);

  if (existing) {
    return existing;
  }

  const queue: ProjectWriteQueueState = {
    tail: Promise.resolve(),
    latestRequestId: 0
  };
  projectWriteQueues.set(directoryHandle, queue);
  return queue;
}

function recordSupersededCommit(
  project: PatchmarkProjectHandle,
  serializedFiles: ProjectCommitFileKey[] = []
): PatchmarkProjectCommitResult {
  const result: PatchmarkProjectCommitResult = {
    status: "superseded",
    generation: project.persistence.generation,
    changedFiles: [],
    serializedFiles,
    bytesWritten: 0
  };
  project.persistence.debug.supersededCommits += 1;
  project.persistence.debug.staleRequestsSkipped += 1;
  project.persistence.debug.lastResult = result;
  return result;
}

function recordPersistenceWrite(
  project: PatchmarkProjectHandle,
  bytes: number
): void {
  project.persistence.debug.writeCount += 1;
  project.persistence.debug.bytesWritten += bytes;
}

function createEmptyPersistenceDebugState(): PatchmarkPersistenceDebugState {
  return {
    requestedCommits: 0,
    committedGenerations: 0,
    unchangedCommits: 0,
    supersededCommits: 0,
    serializationCount: 0,
    writeCount: 0,
    bytesWritten: 0,
    staleRequestsSkipped: 0,
    lastFileResults: {}
  };
}

function serializeComments(comments: PatchmarkComment[]): string {
  return `${JSON.stringify(comments.map(normalizeComment), null, 2)}\n`;
}

function serializePatches(patches: PatchmarkPatch[]): string {
  return `${JSON.stringify(patches.map(normalizePatch), null, 2)}\n`;
}

function serializeManifest(manifest: PatchmarkManifest): string {
  return `${JSON.stringify(normalizeManifest(manifest, manifest.project_name), null, 2)}\n`;
}

function serializeSaveCommit(commit: PatchmarkSaveCommit): string {
  return `${JSON.stringify(commit, null, 2)}\n`;
}

function createManifestMeaningfulKey(manifest: PatchmarkManifest): string {
  const { updated_at, save_generation, save_commit_id, ...meaningful } = manifest;
  void updated_at;
  void save_generation;
  void save_commit_id;
  return JSON.stringify(meaningful);
}

function createSaveCommitId(generation: number): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `PM-SAVE-${String(generation).padStart(6, "0")}-${randomId}`;
}

async function openRegisteredProjectFromManifest(
  directoryHandle: PatchmarkDirectoryHandle,
  manifest: PatchmarkProjectManifestV1
): Promise<LoadedPatchmarkProject> {
  const documents = await listProjectDocuments(
    directoryHandle as ProjectDirectoryHandle,
    manifest
  );
  const activeDocuments = documents.filter(
    (document) => document.status === "active"
  );
  const preferredDocumentId = readPreferredDocumentId(manifest.project_id);
  const selected =
    activeDocuments.find(
      (document) =>
        document.document_id === preferredDocumentId &&
        document.availability === "available"
    ) ??
    activeDocuments.find((document) => document.availability === "available") ??
    activeDocuments[0];
  if (!selected) {
    throw new Error("This Patchmark project has no active documents.");
  }
  return openRegisteredProjectDocument(
    directoryHandle,
    manifest,
    selected.document_id
  );
}

async function openRegisteredProjectDocument(
  root: PatchmarkDirectoryHandle,
  projectManifest: PatchmarkProjectManifestV1,
  documentId: string
): Promise<LoadedPatchmarkProject> {
  const document = getRegisteredDocument(projectManifest, documentId);
  const documentView = (await listProjectDocuments(
    root as ProjectDirectoryHandle,
    projectManifest
  )).find((candidate) => candidate.document_id === documentId);
  if (!documentView) {
    throw new Error(`Document ${documentId} is not registered in this project.`);
  }
  const scopedDirectory = (await createDocumentScopedDirectoryHandle(
    root as ProjectDirectoryHandle,
    document
  )) as PatchmarkDirectoryHandle;

  if (documentView.availability === "missing") {
    const missing = await createMissingDocumentProject({
      document,
      projectManifest,
      root,
      scopedDirectory
    });
    rememberPreferredDocumentId(projectManifest.project_id, documentId);
    return missing;
  }

  const documentFile = await scopedDirectory.getFileHandle(documentFileName);
  const metadataDirectory = await scopedDirectory.getDirectoryHandle(
    metadataDirectoryName
  );
  const documentManifestFile = await getRequiredFileHandle(
    metadataDirectory,
    manifestFileName,
    `Document store ${documentId} is missing manifest.json.`
  );
  const loaded = await createOpenedProjectHandle({
    directoryHandle: scopedDirectory,
    manifestText: await readTextFile(documentManifestFile),
    markdown: await readTextFile(documentFile)
  });
  applyMultiDocumentContext({
    availability: "available",
    document,
    loaded,
    projectManifest,
    root
  });
  rememberPreferredDocumentId(projectManifest.project_id, documentId);
  return loaded;
}

async function createMissingDocumentProject({
  document,
  projectManifest,
  root,
  scopedDirectory
}: {
  document: PatchmarkRegisteredDocument;
  projectManifest: PatchmarkProjectManifestV1;
  root: PatchmarkDirectoryHandle;
  scopedDirectory: PatchmarkDirectoryHandle;
}): Promise<LoadedPatchmarkProject> {
  const metadataDirectory = await scopedDirectory.getDirectoryHandle(
    metadataDirectoryName
  );
  const manifestText = await readTextFile(
    await getRequiredFileHandle(
      metadataDirectory,
      manifestFileName,
      `Document store ${document.document_id} is missing manifest.json.`
    )
  );
  const details: string[] = [];
  const manifest = parseManifestForValidation(
    manifestText,
    projectManifest.title,
    details
  );
  if (!manifest || details.length > 0) {
    throw new Error(
      details[0] ?? `Document store ${document.document_id} has an invalid manifest.`
    );
  }
  const recovery: PatchmarkProjectRecoveryState = {
    kind: "missing_document",
    canRestore: false,
    message: `The registered Markdown file ${document.path} is missing. Locate it to restore this document.`,
    technicalDetails: [
      `Document ID: ${document.document_id}`,
      `Registered path: ${document.path}`
    ],
    temporaryFiles: []
  };
  const project: PatchmarkProjectHandle = {
    directoryHandle: scopedDirectory,
    document,
    documentAvailability: "missing",
    manifest,
    projectDirectoryHandle: root,
    projectManifest,
    projectMode: "multi",
    persistence: {
      generation: manifest.save_generation ?? 0,
      commit: null,
      files: {},
      documentText: "",
      manifestText,
      readSource: "current_readonly",
      recovery,
      debug: createEmptyPersistenceDebugState()
    }
  };
  return { markdown: "", project, recovery };
}

function applyMultiDocumentContext({
  availability,
  document,
  loaded,
  projectManifest,
  root
}: {
  availability: PatchmarkDocumentAvailability;
  document: PatchmarkRegisteredDocument;
  loaded: LoadedPatchmarkProject;
  projectManifest: PatchmarkProjectManifestV1;
  root: PatchmarkDirectoryHandle;
}): void {
  loaded.project.projectMode = "multi";
  loaded.project.projectDirectoryHandle = root;
  loaded.project.projectManifest = projectManifest;
  loaded.project.document = document;
  loaded.project.documentAvailability = availability;
}

async function prepareMultiDocumentProject(
  project: PatchmarkProjectHandle
): Promise<{ loaded: LoadedPatchmarkProject; migrationId?: string }> {
  if (project.projectManifest && project.document) {
    return {
      loaded: {
        markdown: project.persistence.documentText,
        project,
        recovery: project.persistence.recovery
      }
    };
  }
  if (project.persistence.readSource !== "current") {
    throw new Error("Repair or restore the legacy project before converting it.");
  }

  const expectedComments = await readProjectComments(project);
  const expectedPatches = await readProjectPatches(project);
  const expectedVersions = await listProjectVersions(project);
  const expectedVersionContents = await Promise.all(
    expectedVersions.map((version) => readProjectVersionMarkdown(project, version))
  );
  const root = getAuthoritativeProjectDirectory(project);
  const conversion = await convertLegacyProject({
    projectTitle: project.manifest.project_name,
    root: root as ProjectDirectoryHandle
  });
  const loaded = await openRegisteredProjectDocument(
    root,
    conversion.manifest,
    conversion.document.document_id
  );
  const reopenedComments = await readProjectComments(loaded.project);
  const reopenedPatches = await readProjectPatches(loaded.project);
  const reopenedVersions = await listProjectVersions(loaded.project);
  const reopenedVersionContents = await Promise.all(
    reopenedVersions.map((version) =>
      readProjectVersionMarkdown(loaded.project, version)
    )
  );
  if (
    createObjectIdentitySignature(reopenedComments) !==
      createObjectIdentitySignature(expectedComments) ||
    createObjectIdentitySignature(reopenedPatches) !==
      createObjectIdentitySignature(expectedPatches) ||
    createObjectIdentitySignature(reopenedVersions) !==
      createObjectIdentitySignature(expectedVersions) ||
    JSON.stringify(reopenedVersionContents) !==
      JSON.stringify(expectedVersionContents) ||
    loaded.markdown !== project.persistence.documentText
  ) {
    throw new Error("Converted project did not pass semantic reopen verification.");
  }
  const validationSave = await saveProjectState({
    comments: reopenedComments,
    markdown: loaded.markdown,
    patches: reopenedPatches,
    project: loaded.project,
    reason: "migration_reopen_validation"
  });
  if (validationSave.status !== "unchanged") {
    throw new Error("Converted project required an unexpected validation write.");
  }
  const validatedLoaded = await openRegisteredProjectDocument(
    root,
    conversion.manifest,
    conversion.document.document_id
  );
  await markLegacyConversionReopened(
    root as ProjectDirectoryHandle,
    conversion.migrationId,
    "reopened"
  );
  return { loaded: validatedLoaded, migrationId: conversion.migrationId };
}

function createObjectIdentitySignature(values: Array<{ id: string }>): string {
  return JSON.stringify(values.map((value) => value.id));
}

async function commitProjectRegistry(
  project: PatchmarkProjectHandle,
  manifest: PatchmarkProjectManifestV1
): Promise<void> {
  await writeProjectManifestAtomic(
    getAuthoritativeProjectDirectory(project) as ProjectDirectoryHandle,
    manifest
  );
  updateProjectRegistryContext(project, manifest);
}

function updateProjectRegistryContext(
  project: PatchmarkProjectHandle,
  manifest: PatchmarkProjectManifestV1
): void {
  project.projectManifest = manifest;
  if (project.document) {
    project.document = getRegisteredDocument(
      manifest,
      project.document.document_id
    );
  }
}

function requireProjectManifest(
  project: PatchmarkProjectHandle
): PatchmarkProjectManifestV1 {
  if (!project.projectManifest) {
    throw new Error("Convert this legacy project before managing documents.");
  }
  return project.projectManifest;
}

function getAuthoritativeProjectDirectory(
  project: PatchmarkProjectHandle
): PatchmarkDirectoryHandle {
  return project.projectDirectoryHandle ?? project.directoryHandle;
}

function createLegacyDocumentTitle(project: PatchmarkProjectHandle): string {
  return project.manifest.project_name.replace(/[_-]+/g, " ").trim() || "Document";
}

function readPreferredDocumentId(projectId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(
      `patchmark:active-document:${projectId}`
    ) ?? null;
  } catch {
    return null;
  }
}

function rememberPreferredDocumentId(projectId: string, documentId: string): void {
  try {
    globalThis.localStorage?.setItem(
      `patchmark:active-document:${projectId}`,
      documentId
    );
  } catch {
    return;
  }
}

async function createOpenedProjectHandle({
  directoryHandle,
  manifestText,
  markdown
}: {
  directoryHandle: PatchmarkDirectoryHandle;
  manifestText: string;
  markdown: string;
}): Promise<LoadedPatchmarkProject> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const temporaryFiles = await listProjectTemporaryFiles(directoryHandle);
  const commentsText = await readOptionalTextFile(
    metadataDirectoryHandle,
    commentsFileName
  );
  const patchesText = await readOptionalTextFile(
    metadataDirectoryHandle,
    patchesFileName
  );
  const commitText = await readOptionalTextFile(
    metadataDirectoryHandle,
    saveCommitFileName
  );
  const currentDetails: string[] = [];
  const currentManifest = parseManifestForValidation(
    manifestText,
    directoryHandle.name,
    currentDetails
  );

  if (commentsText === null) {
    currentDetails.push("Missing .patchmark/comments.json.");
  }

  if (patchesText === null) {
    currentDetails.push("Missing .patchmark/patches.json.");
  }

  const currentTexts =
    commentsText !== null && patchesText !== null
      ? {
          document: markdown,
          comments: commentsText,
          patches: patchesText,
          manifest: manifestText
        }
      : null;
  const currentCommit = commitText
    ? parseSaveCommitForValidation(commitText, currentDetails)
    : null;

  if (!commitText && currentManifest && currentTexts) {
    validatePersistedJson(currentTexts, currentDetails);
    const persistence = await createLegacyPersistenceState({
      commentsText: currentTexts.comments,
      directoryHandle,
      documentText: markdown,
      manifestText,
      patchesText: currentTexts.patches
    });

    if (currentDetails.length > 0) {
      persistence.readSource = "current_readonly";
      persistence.recovery = {
        kind: "invalid_current_state",
        canRestore: false,
        message: "Patchmark detected invalid project metadata.",
        technicalDetails: currentDetails,
        temporaryFiles
      };
    }

    const project: PatchmarkProjectHandle = {
      directoryHandle,
      manifest: currentManifest,
      persistence
    };
    return {
      markdown,
      project,
      recovery: persistence.recovery
    };
  }

  if (currentManifest && currentTexts && currentCommit) {
    await validateCommittedProjectTexts(
      currentTexts,
      currentCommit,
      currentDetails
    );
    validateManifestCommitIdentity(
      currentManifest,
      currentCommit,
      currentDetails
    );

    if (currentDetails.length === 0) {
      await cleanupStaleProjectTemporaryFiles(directoryHandle);
      const project: PatchmarkProjectHandle = {
        directoryHandle,
        manifest: currentManifest,
        persistence: {
          generation: currentCommit.generation,
          commit: currentCommit,
          files: currentCommit.files,
          documentText: markdown,
          manifestText,
          commentsRaw: currentTexts.comments,
          patchesRaw: currentTexts.patches,
          readSource: "current",
          debug: createEmptyPersistenceDebugState()
        }
      };
      return { markdown, project };
    }
  }

  const lkg = await readValidLastKnownGoodGeneration(directoryHandle);

  if (lkg) {
    const recovery: PatchmarkProjectRecoveryState = {
      kind: "incomplete_save",
      canRestore: true,
      message:
        "Patchmark detected an incomplete project save. The last complete version can be restored.",
      technicalDetails: currentDetails.length > 0
        ? currentDetails
        : ["The active save metadata is missing or invalid."],
      temporaryFiles
    };
    const project: PatchmarkProjectHandle = {
      directoryHandle,
      manifest: lkg.manifest,
      persistence: {
        generation: lkg.commit.generation,
        commit: lkg.commit,
        files: lkg.commit.files,
        documentText: lkg.texts.document,
        manifestText: lkg.texts.manifest,
        commentsRaw: lkg.texts.comments,
        patchesRaw: lkg.texts.patches,
        readSource: "lkg",
        recovery,
        debug: createEmptyPersistenceDebugState()
      }
    };
    return {
      markdown: lkg.texts.document,
      project,
      recovery
    };
  }

  if (!currentManifest || !currentTexts) {
    throw new Error(
      currentDetails[0] ?? "Patchmark could not load this project safely."
    );
  }

  const recovery: PatchmarkProjectRecoveryState = {
    kind: "invalid_current_state",
    canRestore: false,
    message:
      "Patchmark detected inconsistent project files. Open files are read-only until the issue is repaired.",
    technicalDetails: currentDetails,
    temporaryFiles
  };
  const descriptors = await createProjectFileDescriptors(currentTexts);
  const project: PatchmarkProjectHandle = {
    directoryHandle,
    manifest: currentManifest,
    persistence: {
      generation: currentCommit?.generation ?? 0,
      commit: currentCommit,
      files: descriptors,
      documentText: markdown,
      manifestText,
      commentsRaw: commentsText ?? undefined,
      patchesRaw: patchesText ?? undefined,
      readSource: "current_readonly",
      recovery,
      debug: createEmptyPersistenceDebugState()
    }
  };
  return { markdown, project, recovery };
}

async function createLegacyPersistenceState({
  commentsText,
  directoryHandle,
  documentText,
  manifestText,
  patchesText
}: {
  commentsText?: string;
  directoryHandle: PatchmarkDirectoryHandle;
  documentText: string;
  manifestText: string;
  patchesText?: string;
}): Promise<PatchmarkProjectPersistenceState> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const resolvedCommentsText =
    commentsText ??
    (await readOptionalTextFile(metadataDirectoryHandle, commentsFileName)) ??
    "[]\n";
  const resolvedPatchesText =
    patchesText ??
    (await readOptionalTextFile(metadataDirectoryHandle, patchesFileName)) ??
    "[]\n";
  const texts = {
    document: documentText,
    comments: resolvedCommentsText,
    patches: resolvedPatchesText,
    manifest: manifestText
  };

  return {
    generation: 0,
    commit: null,
    files: await createProjectFileDescriptors(texts),
    documentText,
    manifestText,
    commentsRaw: resolvedCommentsText,
    patchesRaw: resolvedPatchesText,
    readSource: "current",
    debug: createEmptyPersistenceDebugState()
  };
}

async function readCurrentProjectTexts(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<Record<ProjectCommitFileKey, string>> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const [document, comments, patches, manifest] = await Promise.all([
    readTextFile(await directoryHandle.getFileHandle(documentFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(commentsFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(patchesFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(manifestFileName))
  ]);
  return { document, comments, patches, manifest };
}

async function readCurrentFileCommit(
  project: PatchmarkProjectHandle,
  key: ProjectCommitFileKey
): Promise<PatchmarkPersistedFileCommit> {
  const texts = await readCurrentProjectTexts(project.directoryHandle);
  return createPersistedFileCommit(getProjectFilePath(key), texts[key]);
}

async function createProjectFileDescriptors(
  texts: Record<ProjectCommitFileKey, string>
): Promise<PatchmarkSaveCommit["files"]> {
  const [document, comments, patches, manifest] = await Promise.all(
    (["document", "comments", "patches", "manifest"] as const).map((key) =>
      createPersistedFileCommit(getProjectFilePath(key), texts[key])
    )
  );
  return { document, comments, patches, manifest };
}

async function createPersistedFileCommit(
  path: string,
  text: string
): Promise<PatchmarkPersistedFileCommit> {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    sha256: await createSha256(bytes),
    bytes: bytes.byteLength
  };
}

async function createSha256(bytes: Uint8Array): Promise<string> {
  const subtleCrypto = globalThis.crypto?.subtle;

  if (subtleCrypto) {
    const digestBytes = new Uint8Array(bytes.byteLength);
    digestBytes.set(bytes);
    const digest = await subtleCrypto.digest("SHA-256", digestBytes.buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

function getProjectFilePath(key: ProjectCommitFileKey): string {
  if (key === "document") {
    return documentFileName;
  }
  if (key === "comments") {
    return `${metadataDirectoryName}/${commentsFileName}`;
  }
  if (key === "patches") {
    return `${metadataDirectoryName}/${patchesFileName}`;
  }
  return `${metadataDirectoryName}/${manifestFileName}`;
}

function getProjectFileName(key: ProjectCommitFileKey): string {
  if (key === "document") {
    return documentFileName;
  }
  if (key === "comments") {
    return commentsFileName;
  }
  if (key === "patches") {
    return patchesFileName;
  }
  return manifestFileName;
}

function createLegacyBaselineCommit({
  descriptors,
  manifest
}: {
  descriptors: PatchmarkSaveCommit["files"];
  manifest: PatchmarkManifest;
}): PatchmarkSaveCommit {
  const identity = [
    descriptors.document.sha256,
    descriptors.comments.sha256,
    descriptors.patches.sha256,
    descriptors.manifest.sha256
  ]
    .map((hash) => hash.slice(0, 8))
    .join("-");
  return {
    format_version: saveCommitFormatVersion,
    generation: 0,
    commit_id: `PM-SAVE-BASELINE-${identity}`,
    created_at: manifest.updated_at,
    files: descriptors
  };
}

async function writeLastKnownGoodGeneration({
  commit,
  directoryHandle,
  onWrite,
  texts
}: {
  commit: PatchmarkSaveCommit;
  directoryHandle: PatchmarkDirectoryHandle;
  onWrite: (bytes: number) => void;
  texts: Record<ProjectCommitFileKey, string>;
}): Promise<void> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const recoveryDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle(recoveryDirectoryName, {
      create: true
    });

  for (const key of ["document", "comments", "patches", "manifest"] as const) {
    const text = texts[key];
    const fileHandle = await recoveryDirectoryHandle.getFileHandle(
      `${getProjectFileName(key)}.lkg`,
      { create: true }
    );
    await writeTextFile(fileHandle, text);
    onWrite(new TextEncoder().encode(text).byteLength);
  }

  const commitText = serializeSaveCommit(commit);
  const commitFileHandle = await recoveryDirectoryHandle.getFileHandle(
    `${saveCommitFileName}.lkg`,
    { create: true }
  );
  await writeTextFile(commitFileHandle, commitText);
  onWrite(new TextEncoder().encode(commitText).byteLength);
}

async function prepareProjectTemporaryFile({
  commitId,
  directoryHandle,
  key,
  onWrite,
  text
}: {
  commitId: string;
  directoryHandle: PatchmarkDirectoryHandle;
  key: ProjectCommitFileKey;
  onWrite: (bytes: number) => void;
  text: string;
}): Promise<PreparedProjectFile> {
  const targetDirectory =
    key === "document"
      ? directoryHandle
      : await directoryHandle.getDirectoryHandle(metadataDirectoryName, {
          create: true
        });
  return prepareTemporaryFile({
    commitId,
    directoryHandle: targetDirectory,
    key,
    onWrite,
    targetFileName: getProjectFileName(key),
    text
  });
}

async function prepareSaveCommitTemporaryFile({
  commitId,
  directoryHandle,
  onWrite,
  text
}: {
  commitId: string;
  directoryHandle: PatchmarkDirectoryHandle;
  onWrite: (bytes: number) => void;
  text: string;
}): Promise<PreparedProjectFile> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  return prepareTemporaryFile({
    commitId,
    directoryHandle: metadataDirectoryHandle,
    key: "commit",
    onWrite,
    targetFileName: saveCommitFileName,
    text
  });
}

async function prepareTemporaryFile({
  commitId,
  directoryHandle,
  key,
  onWrite,
  targetFileName,
  text
}: {
  commitId: string;
  directoryHandle: PatchmarkDirectoryHandle;
  key: ProjectCommitFileKey | "commit";
  onWrite: (bytes: number) => void;
  targetFileName: string;
  text: string;
}): Promise<PreparedProjectFile> {
  const temporaryFileName = `.patchmark-tmp-${commitId}-${targetFileName}`;
  const temporaryFileHandle = await directoryHandle.getFileHandle(
    temporaryFileName,
    { create: true }
  );
  await writeTextFile(temporaryFileHandle, text);
  const bytes = new TextEncoder().encode(text).byteLength;
  onWrite(bytes);
  const writtenText = await readTextFile(temporaryFileHandle);
  const descriptor = await createPersistedFileCommit(
    key === "commit" ? `${metadataDirectoryName}/${saveCommitFileName}` : getProjectFilePath(key),
    writtenText
  );
  const expectedDescriptor = await createPersistedFileCommit(
    descriptor.path,
    text
  );

  if (
    descriptor.bytes !== expectedDescriptor.bytes ||
    descriptor.sha256 !== expectedDescriptor.sha256
  ) {
    throw new Error(`Could not verify temporary project file ${targetFileName}.`);
  }

  return {
    key,
    directoryHandle,
    temporaryFileName,
    targetFileName,
    text,
    descriptor
  };
}

async function installPreparedProjectFile(
  prepared: PreparedProjectFile,
  onWrite: (bytes: number) => void
): Promise<void> {
  const temporaryFileHandle = await prepared.directoryHandle.getFileHandle(
    prepared.temporaryFileName
  );
  const temporaryText = await readTextFile(temporaryFileHandle);
  const temporaryDescriptor = await createPersistedFileCommit(
    prepared.descriptor.path,
    temporaryText
  );

  if (
    temporaryDescriptor.sha256 !== prepared.descriptor.sha256 ||
    temporaryDescriptor.bytes !== prepared.descriptor.bytes
  ) {
    throw new Error(
      `Temporary project file ${prepared.targetFileName} changed before install.`
    );
  }

  const targetFileHandle = await prepared.directoryHandle.getFileHandle(
    prepared.targetFileName,
    { create: true }
  );
  await writeTextFile(targetFileHandle, temporaryText);
  onWrite(temporaryDescriptor.bytes);
  const installedText = await readTextFile(targetFileHandle);
  const installedDescriptor = await createPersistedFileCommit(
    prepared.descriptor.path,
    installedText
  );

  if (
    installedDescriptor.sha256 !== prepared.descriptor.sha256 ||
    installedDescriptor.bytes !== prepared.descriptor.bytes
  ) {
    throw new Error(`Could not verify installed project file ${prepared.targetFileName}.`);
  }
}

async function cleanupPreparedFiles(
  preparedFiles: PreparedProjectFile[]
): Promise<void> {
  await Promise.all(
    preparedFiles.map(async (prepared) => {
      if (!prepared.directoryHandle.removeEntry) {
        return;
      }
      try {
        await prepared.directoryHandle.removeEntry(prepared.temporaryFileName);
      } catch (error) {
        if (!isNotFoundError(error)) {
          return;
        }
      }
    })
  );
}

async function getProjectReadMetadataDirectory(
  project: PatchmarkProjectHandle
): Promise<PatchmarkDirectoryHandle> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  return project.persistence.readSource === "lkg"
    ? metadataDirectoryHandle.getDirectoryHandle(recoveryDirectoryName)
    : metadataDirectoryHandle;
}

async function readValidLastKnownGoodGeneration(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<{
  commit: PatchmarkSaveCommit;
  manifest: PatchmarkManifest;
  texts: Record<ProjectCommitFileKey, string>;
} | null> {
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    const recoveryDirectoryHandle =
      await metadataDirectoryHandle.getDirectoryHandle(recoveryDirectoryName);
    const [document, comments, patches, manifest, commitText] = await Promise.all([
      readTextFile(
        await recoveryDirectoryHandle.getFileHandle(`${documentFileName}.lkg`)
      ),
      readTextFile(
        await recoveryDirectoryHandle.getFileHandle(`${commentsFileName}.lkg`)
      ),
      readTextFile(
        await recoveryDirectoryHandle.getFileHandle(`${patchesFileName}.lkg`)
      ),
      readTextFile(
        await recoveryDirectoryHandle.getFileHandle(`${manifestFileName}.lkg`)
      ),
      readTextFile(
        await recoveryDirectoryHandle.getFileHandle(`${saveCommitFileName}.lkg`)
      )
    ]);
    const details: string[] = [];
    const commit = parseSaveCommitForValidation(commitText, details);
    const normalizedManifest = parseManifestForValidation(
      manifest,
      directoryHandle.name,
      details
    );
    const texts = { document, comments, patches, manifest };

    if (!commit || !normalizedManifest) {
      return null;
    }

    await validateCommittedProjectTexts(texts, commit, details);
    validateManifestCommitIdentity(normalizedManifest, commit, details);
    return details.length === 0
      ? { commit, manifest: normalizedManifest, texts }
      : null;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function validateManifestCommitIdentity(
  manifest: PatchmarkManifest,
  commit: PatchmarkSaveCommit,
  details: string[]
): void {
  if (commit.generation === 0) {
    return;
  }
  if (manifest.save_generation !== commit.generation) {
    details.push("Manifest save generation does not match active save metadata.");
  }
  if (manifest.save_commit_id !== commit.commit_id) {
    details.push("Manifest save commit does not match active save metadata.");
  }
}

async function validateCommittedProjectTexts(
  texts: Record<ProjectCommitFileKey, string>,
  commit: PatchmarkSaveCommit,
  details: string[]
): Promise<void> {
  validatePersistedJson(texts, details);
  const descriptors = await createProjectFileDescriptors(texts);

  for (const key of ["document", "comments", "patches", "manifest"] as const) {
    const expected = commit.files[key];
    const actual = descriptors[key];
    if (
      expected.path !== actual.path ||
      expected.bytes !== actual.bytes ||
      expected.sha256 !== actual.sha256
    ) {
      details.push(`${actual.path} does not match save generation ${commit.generation}.`);
    }
  }
}

function validatePersistedJson(
  texts: Record<ProjectCommitFileKey, string>,
  details: string[]
): void {
  for (const key of ["comments", "patches"] as const) {
    try {
      if (!Array.isArray(JSON.parse(texts[key]))) {
        details.push(`${getProjectFilePath(key)} must contain a JSON array.`);
      }
    } catch {
      details.push(`${getProjectFilePath(key)} contains malformed JSON.`);
    }
  }

  try {
    JSON.parse(texts.manifest);
  } catch {
    details.push(`${getProjectFilePath("manifest")} contains malformed JSON.`);
  }
}

function parseManifestForValidation(
  text: string,
  fallbackProjectName: string,
  details: string[]
): PatchmarkManifest | null {
  try {
    return normalizeManifest(JSON.parse(text), fallbackProjectName);
  } catch (error) {
    details.push(
      error instanceof Error
        ? error.message
        : ".patchmark/manifest.json is invalid."
    );
    return null;
  }
}

function parseSaveCommitForValidation(
  text: string,
  details: string[]
): PatchmarkSaveCommit | null {
  try {
    const value = JSON.parse(text);
    if (!isPatchmarkSaveCommit(value)) {
      details.push(".patchmark/save-commit.json is invalid.");
      return null;
    }
    return value;
  } catch {
    details.push(".patchmark/save-commit.json contains malformed JSON.");
    return null;
  }
}

function isPatchmarkSaveCommit(value: unknown): value is PatchmarkSaveCommit {
  if (
    !isRecord(value) ||
    value.format_version !== saveCommitFormatVersion ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.commit_id !== "string" ||
    typeof value.created_at !== "string" ||
    !isRecord(value.files)
  ) {
    return false;
  }

  const files = value.files;
  return (["document", "comments", "patches", "manifest"] as const).every(
    (key) => isPersistedFileCommit(files[key], getProjectFilePath(key))
  );
}

function isPersistedFileCommit(
  value: unknown,
  expectedPath: string
): value is PatchmarkPersistedFileCommit {
  return (
    isRecord(value) &&
    value.path === expectedPath &&
    typeof value.sha256 === "string" &&
    value.sha256.length > 0 &&
    typeof value.bytes === "number" &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0
  );
}

async function readOptionalTextFile(
  directoryHandle: PatchmarkDirectoryHandle,
  fileName: string
): Promise<string | null> {
  try {
    return readTextFile(await directoryHandle.getFileHandle(fileName));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function listProjectTemporaryFiles(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<string[]> {
  const temporaryFiles: string[] = [];
  await collectTemporaryFiles(directoryHandle, "", temporaryFiles);
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    await collectTemporaryFiles(
      metadataDirectoryHandle,
      `${metadataDirectoryName}/`,
      temporaryFiles
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  return temporaryFiles;
}

async function collectTemporaryFiles(
  directoryHandle: PatchmarkDirectoryHandle,
  prefix: string,
  output: string[]
): Promise<void> {
  if (!directoryHandle.entries) {
    return;
  }
  for await (const [name, entry] of directoryHandle.entries()) {
    if (entry.kind !== "directory" && name.startsWith(".patchmark-tmp-")) {
      output.push(`${prefix}${name}`);
    }
  }
}

async function cleanupTemporaryFilesInDirectory(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<number> {
  if (!directoryHandle.entries || !directoryHandle.removeEntry) {
    return 0;
  }
  const temporaryFileNames: string[] = [];
  for await (const [name, entry] of directoryHandle.entries()) {
    if (entry.kind !== "directory" && name.startsWith(".patchmark-tmp-")) {
      temporaryFileNames.push(name);
    }
  }
  let removed = 0;
  for (const fileName of temporaryFileNames) {
    try {
      await directoryHandle.removeEntry(fileName);
      removed += 1;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  return removed;
}

async function preserveQuestionableCurrentProjectFiles(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<void> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const recoveryDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle(recoveryDirectoryName, {
      create: true
    });
  const questionableDirectoryHandle =
    await recoveryDirectoryHandle.getDirectoryHandle(
      `questionable-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      { create: true }
    );
  const files = [
    {
      sourceDirectory: directoryHandle,
      sourceName: documentFileName,
      targetName: documentFileName
    },
    ...[
      commentsFileName,
      patchesFileName,
      manifestFileName,
      saveCommitFileName
    ].map((fileName) => ({
      sourceDirectory: metadataDirectoryHandle,
      sourceName: fileName,
      targetName: fileName
    }))
  ];

  for (const file of files) {
    const text = await readOptionalTextFile(file.sourceDirectory, file.sourceName);
    if (text === null) {
      continue;
    }
    const targetFileHandle = await questionableDirectoryHandle.getFileHandle(
      file.targetName,
      { create: true }
    );
    await writeTextFile(targetFileHandle, text);
  }
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
  manifest: PatchmarkManifest,
  shouldWriteManifest = false
): Promise<void> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );

  if (shouldWriteManifest) {
    await writeManifest(directoryHandle, manifest);
  }

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
    save_generation:
      typeof manifest.save_generation === "number" &&
      Number.isInteger(manifest.save_generation) &&
      manifest.save_generation >= 0
        ? manifest.save_generation
        : undefined,
    save_commit_id:
      typeof manifest.save_commit_id === "string"
        ? manifest.save_commit_id
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
    .map((entry) =>
      entry.format_version === 2
        ? {
            format_version: 2 as const,
            history_id: entry.history_id,
            changed_at: entry.changed_at,
            reason: entry.reason,
            cause: entry.cause,
            source_id: entry.source_id,
            source_patch_id: entry.source_patch_id,
            mutation_generation: entry.mutation_generation,
            previous: normalizeConciseAnchorHistoryState(entry.previous),
            next: entry.next
              ? normalizeConciseAnchorHistoryState(entry.next)
              : undefined,
            impact_kind: entry.impact_kind,
            method: entry.method,
            confidence: entry.confidence,
            document_hash_before: entry.document_hash_before,
            document_hash_after: entry.document_hash_after
          }
        : {
            changed_at: entry.changed_at,
            reason: entry.reason,
            source_patch_id: entry.source_patch_id,
            previous_anchor: normalizeKnownCommentAnchor(
              entry.previous_anchor,
              "note"
            ),
            new_anchor: entry.new_anchor
              ? normalizeKnownCommentAnchor(entry.new_anchor, "note")
              : undefined,
            impact_kind: entry.impact_kind
          }
    );

  return normalizedHistory.length > 0 ? normalizedHistory : undefined;
}

function normalizeConciseAnchorHistoryState(
  state: PatchmarkConciseAnchorHistoryState
): PatchmarkConciseAnchorHistoryState {
  return {
    kind: state.kind,
    start: state.start,
    end: state.end,
    selected_text_hash: state.selected_text_hash,
    selected_text_excerpt: state.selected_text_excerpt,
    selected_text_length: state.selected_text_length,
    containing_heading: state.containing_heading,
    containing_heading_path: state.containing_heading_path,
    state: state.state
  };
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
        : undefined,
    table_index:
      typeof context.table_index === "number" ? context.table_index : undefined,
    table_row_index:
      typeof context.table_row_index === "number"
        ? context.table_row_index
        : undefined,
    table_cell_index:
      typeof context.table_cell_index === "number"
        ? context.table_cell_index
        : undefined,
    table_row_start_offset:
      typeof context.table_row_start_offset === "number"
        ? context.table_row_start_offset
        : undefined,
    table_row_end_offset:
      typeof context.table_row_end_offset === "number"
        ? context.table_row_end_offset
        : undefined,
    table_cell_start_offset:
      typeof context.table_cell_start_offset === "number"
        ? context.table_cell_start_offset
        : undefined,
    table_cell_end_offset:
      typeof context.table_cell_end_offset === "number"
        ? context.table_cell_end_offset
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

  const usedIds = new Set<string>();

  return thread.flatMap((entry, index) => {
    const normalizedEntry = normalizeCommentThreadEntry(entry, index, usedIds);

    return normalizedEntry ? [normalizedEntry] : [];
  });
}

function normalizeCommentThreadEntry(
  entry: unknown,
  index: number,
  usedIds: Set<string>
): PatchmarkCommentThreadEntry | null {
  if (
    !isRecord(entry) ||
    !isCommentThreadRole(entry.role) ||
    typeof entry.content !== "string" ||
    typeof entry.created_at !== "string"
  ) {
    return null;
  }

  const id =
    typeof entry.id === "string" && entry.id.trim()
      ? createUniqueThreadEntryId(entry.id, usedIds)
      : createLegacyThreadEntryId(index, usedIds);
  const suggestedUserAction = isSuggestedUserAction(entry.suggested_user_action)
    ? entry.suggested_user_action
    : undefined;

  return {
    id,
    role: entry.role,
    content: entry.content,
    created_at: entry.created_at,
    edit_history: normalizeThreadEntryEditHistory(entry.edit_history),
    source_chat_url:
      typeof entry.source_chat_url === "string"
        ? entry.source_chat_url
        : undefined,
    source_import_id:
      typeof entry.source_import_id === "string"
        ? entry.source_import_id
        : undefined,
    source_patch_id:
      typeof entry.source_patch_id === "string"
        ? entry.source_patch_id
        : undefined,
    sources: normalizeSourceReferences(entry.sources),
    suggested_user_action: suggestedUserAction,
    updated_at:
      typeof entry.updated_at === "string" ? entry.updated_at : undefined
  };
}

function isCommentThreadRole(
  role: unknown
): role is PatchmarkCommentThreadEntry["role"] {
  return role === "user" || role === "chatgpt" || role === "system";
}

function createUniqueThreadEntryId(
  candidateId: string,
  usedIds: Set<string>
): string {
  if (!usedIds.has(candidateId)) {
    usedIds.add(candidateId);
    return candidateId;
  }

  let suffix = 2;
  let nextId = `${candidateId}-${suffix}`;

  while (usedIds.has(nextId)) {
    suffix += 1;
    nextId = `${candidateId}-${suffix}`;
  }

  usedIds.add(nextId);
  return nextId;
}

function createLegacyThreadEntryId(index: number, usedIds: Set<string>): string {
  const baseId = `PM-THREAD-LEGACY-${String(index + 1).padStart(4, "0")}`;

  return createUniqueThreadEntryId(baseId, usedIds);
}

function normalizeThreadEntryEditHistory(
  editHistory: unknown
): PatchmarkCommentThreadEntry["edit_history"] {
  if (!Array.isArray(editHistory)) {
    return undefined;
  }

  const normalizedHistory = editHistory.filter(
    (
      edit
    ): edit is NonNullable<PatchmarkCommentThreadEntry["edit_history"]>[number] =>
      isRecord(edit) &&
      typeof edit.edited_at === "string" &&
      typeof edit.previous_content === "string"
  );

  return normalizedHistory.length > 0 ? normalizedHistory : undefined;
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
      published_at: source.published_at,
      updated_at: source.updated_at,
      observed_at: source.observed_at,
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
  if (
    isRecord(value) &&
    value.format_version === 2 &&
    typeof value.history_id === "string" &&
    typeof value.changed_at === "string" &&
    isCommentAnchorHistoryReason(value.reason) &&
    isCommentAnchorHistoryCause(value.cause) &&
    isConciseAnchorHistoryState(value.previous) &&
    (value.next === undefined || isConciseAnchorHistoryState(value.next))
  ) {
    return (
      (value.source_id === undefined || typeof value.source_id === "string") &&
      (value.source_patch_id === undefined ||
        typeof value.source_patch_id === "string") &&
      (value.mutation_generation === undefined ||
        typeof value.mutation_generation === "number") &&
      (value.impact_kind === undefined ||
        isPatchCommentImpactKind(value.impact_kind)) &&
      (value.method === undefined || typeof value.method === "string") &&
      (value.confidence === undefined || typeof value.confidence === "string") &&
      (value.document_hash_before === undefined ||
        typeof value.document_hash_before === "string") &&
      (value.document_hash_after === undefined ||
        typeof value.document_hash_after === "string")
    );
  }

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

function isConciseAnchorHistoryState(
  value: unknown
): value is PatchmarkConciseAnchorHistoryState {
  return (
    isRecord(value) &&
    (value.kind === "document" ||
      value.kind === "section" ||
      value.kind === "selected_text") &&
    (value.start === undefined || typeof value.start === "number") &&
    (value.end === undefined || typeof value.end === "number") &&
    (value.selected_text_hash === undefined ||
      typeof value.selected_text_hash === "string") &&
    (value.selected_text_excerpt === undefined ||
      typeof value.selected_text_excerpt === "string") &&
    (value.selected_text_length === undefined ||
      typeof value.selected_text_length === "number") &&
    (value.containing_heading === undefined ||
      typeof value.containing_heading === "string") &&
    (value.containing_heading_path === undefined ||
      (Array.isArray(value.containing_heading_path) &&
        value.containing_heading_path.every(
          (item) => typeof item === "string"
        ))) &&
    (value.state === undefined ||
      value.state === "active" ||
      value.state === "ambiguous" ||
      value.state === "not_found" ||
      value.state === "needs_review")
  );
}

function isCommentAnchorHistoryCause(
  value: unknown
): value is PatchmarkConciseCommentAnchorHistoryEntry["cause"] {
  return (
    typeof value === "string" &&
    commentAnchorHistoryCauses.includes(
      value as PatchmarkConciseCommentAnchorHistoryEntry["cause"]
    )
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

function isSuggestedUserAction(
  value: unknown
): value is PatchmarkSuggestedUserAction {
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
    (value.published_at === undefined ||
      value.published_at === null ||
      typeof value.published_at === "string") &&
    (value.updated_at === undefined ||
      value.updated_at === null ||
      typeof value.updated_at === "string") &&
    (value.observed_at === undefined || typeof value.observed_at === "string") &&
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

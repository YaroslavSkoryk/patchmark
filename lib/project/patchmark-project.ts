import { type MarkdownFileHandle } from "../files/file-system-access.ts";
import { normalizeCommentTrashMetadata } from "../comments/comment-trash-schema.ts";
import { normalizeCommentDeletionTombstones } from "../comments/comment-deletion-tombstones.ts";
import {
  assertDocumentScope,
  assertUniqueDocumentLocalIds,
  createProjectDocumentIdentity,
  serializeProjectDocumentIdentity,
  legacyDocumentScopeId,
  type ProjectDocumentIdentity,
  type VersionRef
} from "./document-scoped-identity.ts";
import {
  addExistingProjectDocument as registerExistingProjectDocument,
  assignDocumentToGroup,
  archiveRegisteredDocument,
  completePendingProjectMigration,
  convertLegacyProject,
  createProjectId,
  createDocumentGroup,
  createDocumentScopedDirectoryHandle,
  createProjectDocument as registerCreatedProjectDocument,
  getRegisteredDocument,
  listProjectDocuments,
  locateProjectDocument as repairProjectDocumentPath,
  markLegacyConversionReopened,
  readProjectManifest,
  removeDocumentGroup,
  renameDocumentGroup,
  reorderDocumentGroup,
  reorderRegisteredDocument,
  resolveProjectFilePath,
  rollbackPendingProjectMigration,
  restoreRegisteredDocument,
  updateDocumentRegistration,
  writeProjectManifestAtomic,
  type PatchmarkDocumentAvailability,
  type PatchmarkDocumentGroup,
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
  type PatchmarkReadingBookmark,
  type PatchmarkSaveCommit,
  type PatchmarkSuggestedUserAction,
  type PatchmarkSourceReference,
  type PatchmarkVersionEntry,
  type PatchmarkVersionMutationAudit
} from "./project-types.ts";
import {
  incrementDocumentSwitchPerformanceCounter,
  markDocumentSwitchPerformance,
  recordDocumentSwitchPerformanceDuration,
  updateDocumentSwitchPerformanceMetadata
} from "../performance/document-switch-performance.ts";
import {
  parseReviewBatchRecords,
  serializeReviewBatchRecords
} from "../review-batches/review-batch-schema.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";
import {
  createEmptyReviewQueueOverrides,
  parseReviewQueueOverrides,
  serializeReviewQueueOverrides
} from "../review-queue/review-queue-override-schema.ts";
import type { PatchmarkReviewQueueOverrides } from "../review-queue/review-queue-override-types.ts";
import {
  parseRewriteProjectSessionStore,
  serializeRewriteProjectSessionStore
} from "../rewrite-workspace/rewrite-project-session-schema.ts";
import type { RewriteProjectSessionRecord } from "../rewrite-workspace/rewrite-session-types.ts";
import {
  getCollaborationProductQualificationState,
  isCollaborationShadowDisabled,
  loadCollaborationProductQualification,
  runCollaborationShadowAfterLegacyCommit,
  type CollaborationShadowMutationKind,
  type CollaborationShadowMutationReceipt,
  type ShadowLegacyAnchor,
  type ShadowLegacyDocument,
  type ShadowLegacySharedState
} from "../collaboration-shadow/entrypoint.ts";

export {
  getCollaborationProductQualificationState,
  loadCollaborationProductQualification
};

const documentFileName = "document.md";
const metadataDirectoryName = ".patchmark";
const manifestFileName = "manifest.json";
const commentsFileName = "comments.json";
const patchesFileName = "patches.json";
const reviewBatchesFileName = "review-batches.json";
const reviewQueueOverridesFileName = "review-queue-overrides.json";
const rewriteSessionsFileName = "rewrite-sessions.json";
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
  kind?: "directory";
  isSameEntry?: (other: PatchmarkDirectoryHandle) => Promise<boolean>;
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<
    "denied" | "granted" | "prompt"
  >;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<
    "denied" | "granted" | "prompt"
  >;
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
  reviewBatchesReference?: PatchmarkReviewBatch[];
  reviewQueueOverridesReference?: PatchmarkReviewQueueOverrides;
  rewriteSessionsReference?: RewriteProjectSessionRecord[];
  commentsRaw?: string;
  patchesRaw?: string;
  reviewBatchesRaw?: string;
  reviewQueueOverridesRaw?: string;
  rewriteSessionsRaw?: string;
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
  | "review_batches"
  | "review_queue_overrides"
  | "rewrite_sessions"
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
  reviewBatches?: PatchmarkReviewBatch[];
  reviewBatchesUpdate?: (
    batches: PatchmarkReviewBatch[]
  ) => PatchmarkReviewBatch[];
  reviewQueueOverrides?: PatchmarkReviewQueueOverrides;
  reviewQueueOverridesUpdate?: (
    overrides: PatchmarkReviewQueueOverrides
  ) => PatchmarkReviewQueueOverrides;
  rewriteSessions?: RewriteProjectSessionRecord[];
  rewriteSessionsUpdate?: (
    sessions: RewriteProjectSessionRecord[]
  ) => RewriteProjectSessionRecord[];
  manifest?: PatchmarkManifest;
  manifestUpdate?: (manifest: PatchmarkManifest) => PatchmarkManifest;
  reason: string;
  allowSupersede?: boolean;
  rollbackOnFailure?: boolean;
  validateBeforeCommit?: () => void;
};

export type PatchmarkProjectDocumentListItem = PatchmarkProjectDocumentView & {
  hasReadingBookmark: boolean;
};

type ProjectWriteQueueState = {
  tail: Promise<void>;
  latestRequestId: number;
};

type PendingLegacyAssemblyTransaction = {
  assemblyId: string;
  directory: PatchmarkDirectoryHandle;
  stage: string;
  updatedAt: string;
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

  return openProjectFolderHandle(directoryHandle);
}

export async function openProjectFolderHandle(
  directoryHandle: PatchmarkDirectoryHandle,
  options: { deferAssemblyRecovery?: boolean; readOnly?: boolean } = {}
): Promise<LoadedPatchmarkProject> {

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
    const pendingAssembly = options.deferAssemblyRecovery
      ? null
      : await findPendingLegacyAssemblyTransaction(
          directoryHandle,
          projectManifest.project_id
        );
    try {
      const loaded = await openRegisteredProjectFromManifest(
        directoryHandle,
        projectManifest,
        options
      );
      if (!options.readOnly) {
        await completePendingProjectMigration(
          directoryHandle as ProjectDirectoryHandle,
          projectManifest
        );
        if (pendingAssembly) {
          await completePendingLegacyAssemblyTransaction(
            directoryHandle,
            projectManifest,
            loaded,
            pendingAssembly
          );
        }
      }
      return loaded;
    } catch (error) {
      if (options.readOnly) {
        throw error;
      }
      if (pendingAssembly) {
        await invalidatePendingLegacyAssemblyTransaction(
          directoryHandle,
          pendingAssembly,
          error
        );
        throw new Error(
          `An interrupted assembled project failed reopen validation and was marked incomplete: ${getErrorMessage(
            error
          )}`
        );
      }
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
      markdown,
      readOnly: options.readOnly
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
    project_id: createProjectId(),
    document_id: legacyDocumentScopeId,
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

export function getProjectDocumentScopeId(
  project: PatchmarkProjectHandle
): string {
  return project.document?.document_id ?? legacyDocumentScopeId;
}

export function getProjectDocumentIdentity(
  project: PatchmarkProjectHandle
): ProjectDocumentIdentity {
  return createProjectDocumentIdentity(
    project.projectManifest?.project_id ??
      project.manifest.project_id ??
      createLegacyProjectId(project.manifest),
    project.document?.document_id ??
      project.manifest.document_id ??
      legacyDocumentScopeId
  );
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
): Promise<PatchmarkProjectDocumentListItem[]> {
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
        availability: "available",
        hasReadingBookmark: Boolean(project.manifest.reading_bookmark)
      }
    ];
  }
  const documents = await listProjectDocuments(
    root as ProjectDirectoryHandle,
    project.projectManifest
  );
  return Promise.all(
    documents.map(async (document) => ({
      ...document,
      hasReadingBookmark: await hasStoredReadingBookmark({
        document,
        projectManifest: project.projectManifest!,
        root
      })
    }))
  );
}

async function hasStoredReadingBookmark({
  document,
  projectManifest,
  root
}: {
  document: PatchmarkRegisteredDocument;
  projectManifest: PatchmarkProjectManifestV1;
  root: PatchmarkDirectoryHandle;
}): Promise<boolean> {
  try {
    const scopedDirectory = (await createDocumentScopedDirectoryHandle(
      root as ProjectDirectoryHandle,
      document
    )) as PatchmarkDirectoryHandle;
    const metadata = await scopedDirectory.getDirectoryHandle(
      metadataDirectoryName
    );
    const manifestText = await readTextFile(
      await metadata.getFileHandle(manifestFileName)
    );
    const details: string[] = [];
    const manifest = parseManifestForValidation(
      manifestText,
      projectManifest.title,
      details,
      createProjectDocumentIdentity(
        projectManifest.project_id,
        document.document_id
      )
    );
    return details.length === 0 && Boolean(manifest?.reading_bookmark);
  } catch {
    return false;
  }
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
  groupId,
  markdown,
  path,
  project,
  role
}: {
  displayTitle: string;
  groupId?: string | null;
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
    groupId,
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
  groupId,
  path,
  project,
  role
}: {
  displayTitle?: string;
  groupId?: string | null;
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
    groupId,
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
  documentId: string,
  options: { performanceOperationId?: string | null } = {}
): Promise<LoadedPatchmarkProject> {
  return openRegisteredProjectDocument(
    getAuthoritativeProjectDirectory(project),
    requireProjectManifest(project),
    documentId,
    { performanceOperationId: options.performanceOperationId }
  );
}

export async function switchProjectDocument({
  comments,
  documentId,
  markdown,
  patches,
  persistCurrentDocument = true,
  project,
  performanceOperationId
}: {
  comments: PatchmarkComment[];
  documentId: string;
  markdown: string;
  patches: PatchmarkPatch[];
  persistCurrentDocument?: boolean;
  project: PatchmarkProjectHandle;
  performanceOperationId?: string | null;
}): Promise<LoadedPatchmarkProject> {
  if (
    project.documentAvailability !== "missing" &&
    persistCurrentDocument
  ) {
    const persistenceStartedAt = performance.now();
    const result = await saveProjectState({
      comments,
      markdown,
      patches,
      project,
      reason: "switch_document"
    });
    recordDocumentSwitchPerformanceDuration(
      performanceOperationId,
      "persist_current_authoritative_state",
      performance.now() - persistenceStartedAt
    );
    updateDocumentSwitchPerformanceMetadata(performanceOperationId, {
      changedFiles: result.changedFiles,
      saveStatus: result.status
    });
    incrementDocumentSwitchPerformanceCounter(
      performanceOperationId,
      "authoritative_bytes_written",
      result.bytesWritten
    );
    incrementDocumentSwitchPerformanceCounter(
      performanceOperationId,
      "serialized_files",
      result.serializedFiles.length
    );
  } else if (project.documentAvailability !== "missing") {
    updateDocumentSwitchPerformanceMetadata(performanceOperationId, {
      changedFiles: [],
      saveStatus: "unchanged"
    });
  }
  markDocumentSwitchPerformance(
    performanceOperationId,
    "current_authoritative_state_persisted"
  );
  markDocumentSwitchPerformance(
    performanceOperationId,
    "outgoing_document_work_complete"
  );
  return openProjectDocument(project, documentId, { performanceOperationId });
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
    await commitProjectRegistry(
      project,
      next,
      displayTitle === undefined ? null : `document_metadata:${documentId}`
    );
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
    await commitProjectRegistry(project, next, `document_position:${documentId}`);
  }
  return next;
}

export async function createProjectDocumentGroup({
  project,
  title
}: {
  project: PatchmarkProjectHandle;
  title: string;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = createDocumentGroup(current, title);
  await commitProjectRegistry(project, next, `group_create:${next.groups?.at(-1)?.group_id ?? "unknown"}`);
  return next;
}

export async function renameProjectDocumentGroup({
  groupId,
  project,
  title
}: {
  groupId: string;
  project: PatchmarkProjectHandle;
  title: string;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = renameDocumentGroup(current, groupId, title);
  if (next !== current) {
    await commitProjectRegistry(project, next, `group_rename:${groupId}`);
  }
  return next;
}

export async function moveProjectDocumentGroup({
  direction,
  groupId,
  project
}: {
  direction: "up" | "down";
  groupId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = reorderDocumentGroup(current, groupId, direction);
  if (next !== current) {
    await commitProjectRegistry(project, next, `group_position:${groupId}`);
  }
  return next;
}

export async function moveProjectDocumentToGroup({
  documentId,
  groupId,
  project
}: {
  documentId: string;
  groupId: string | null;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = assignDocumentToGroup(current, documentId, groupId);
  if (next !== current) {
    await commitProjectRegistry(
      project,
      next,
      groupId === null ? null : `document_group:${documentId}`
    );
  }
  return next;
}

export async function deleteProjectDocumentGroup({
  groupId,
  project
}: {
  groupId: string;
  project: PatchmarkProjectHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const current = requireProjectManifest(project);
  const next = removeDocumentGroup(current, groupId);
  await commitProjectRegistry(project, next, null);
  return next;
}

export function getProjectDocumentGroups(
  project: PatchmarkProjectHandle
): PatchmarkDocumentGroup[] {
  return [...(project.projectManifest?.groups ?? [])].sort(
    (left, right) =>
      left.position - right.position || left.created_at.localeCompare(right.created_at)
  );
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
    await commitProjectRegistry(project, next, `document_archive:${documentId}`);
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
    await commitProjectRegistry(project, next, `document_restore:${documentId}`);
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
  reviewBatches,
  reviewQueueOverrides,
  rewriteSessions,
  project,
  reason,
  allowSupersede = false,
  rollbackOnFailure = false,
  validateBeforeCommit
}: {
  comments?: PatchmarkComment[];
  manifest?: PatchmarkManifest;
  markdown?: string;
  patches?: PatchmarkPatch[];
  reviewBatches?: PatchmarkReviewBatch[];
  reviewQueueOverrides?: PatchmarkReviewQueueOverrides;
  rewriteSessions?: RewriteProjectSessionRecord[];
  project: PatchmarkProjectHandle;
  reason: string;
  allowSupersede?: boolean;
  rollbackOnFailure?: boolean;
  validateBeforeCommit?: () => void;
}): Promise<PatchmarkProjectCommitResult> {
  return commitProjectState({
    allowSupersede,
    comments,
    manifest,
    markdown,
    patches,
    reviewBatches,
    reviewQueueOverrides,
    rewriteSessions,
    project,
    reason,
    rollbackOnFailure,
    validateBeforeCommit
  });
}

export async function updateProjectManifestMetadata({
  project,
  reason,
  update
}: {
  project: PatchmarkProjectHandle;
  reason: string;
  update: (manifest: PatchmarkManifest) => PatchmarkManifest;
}): Promise<PatchmarkProjectCommitResult> {
  return commitProjectState({
    manifestUpdate: update,
    project,
    reason
  });
}

export async function createProjectSnapshot({
  audit,
  allowDuplicate = false,
  project,
  markdown,
  reason = "manual snapshot"
}: {
  audit?: PatchmarkVersionMutationAudit;
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

  const prepared = await prepareProjectSnapshot({
    audit,
    contentHash,
    markdown,
    project,
    reason
  });
  await commitProjectState({
    manifest: prepared.manifest,
    project,
    reason: "create_snapshot"
  });

  return {
    created: true,
    version: prepared.version,
    project
  };
}

export async function prepareProjectMutationSnapshot({
  audit,
  markdown,
  project,
  reason
}: {
  audit: PatchmarkVersionMutationAudit;
  markdown: string;
  project: PatchmarkProjectHandle;
  reason: string;
}): Promise<{
  manifest: PatchmarkManifest;
  snapshotFileName: string;
  version: PatchmarkVersionEntry;
}> {
  return prepareProjectSnapshot({
    audit,
    contentHash: await createMarkdownHash(markdown),
    markdown,
    project,
    reason
  });
}

export async function discardPreparedProjectMutationSnapshot({
  project,
  snapshotFileName
}: {
  project: PatchmarkProjectHandle;
  snapshotFileName: string;
}): Promise<void> {
  try {
    const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    const versionsDirectoryHandle =
      await metadataDirectoryHandle.getDirectoryHandle("versions");
    await versionsDirectoryHandle.removeEntry?.(snapshotFileName);
  } catch {
    return;
  }
}

async function prepareProjectSnapshot({
  audit,
  contentHash,
  markdown,
  project,
  reason
}: {
  audit?: PatchmarkVersionMutationAudit;
  contentHash: string | undefined;
  markdown: string;
  project: PatchmarkProjectHandle;
  reason: string;
}): Promise<{
  manifest: PatchmarkManifest;
  snapshotFileName: string;
  version: PatchmarkVersionEntry;
}> {
  const createdAt = new Date().toISOString();
  const snapshotId = createSnapshotId(createdAt);
  const snapshotFileName = `${snapshotId}.md`;
  const snapshotFile = `.patchmark/versions/${snapshotFileName}`;
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  const versionsDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("versions", {
      create: true
    });
  const snapshotFileHandle = await versionsDirectoryHandle.getFileHandle(
    snapshotFileName,
    { create: true }
  );
  const version: PatchmarkVersionEntry = {
    id: snapshotId,
    file: snapshotFile,
    created_at: createdAt,
    reason,
    content_hash: contentHash,
    ...(audit ? { mutation: audit } : {})
  };
  const manifest: PatchmarkManifest = {
    ...project.manifest,
    updated_at: createdAt,
    current_version: snapshotId,
    versions: [...(project.manifest.versions ?? []), version]
  };
  await writeTextFile(snapshotFileHandle, markdown);
  return { manifest, snapshotFileName, version };
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
  const versions = project.manifest.versions ?? [];
  assertUniqueDocumentLocalIds({
    documentId: getProjectDocumentScopeId(project),
    ids: versions.map((version) => version.id),
    kind: "version"
  });
  return versions;
}

export async function readProjectVersionMarkdownByRef(
  project: PatchmarkProjectHandle,
  reference: VersionRef,
  version: PatchmarkVersionEntry
): Promise<string> {
  assertDocumentScope(reference, getProjectDocumentScopeId(project));
  if (reference.id !== version.id) {
    throw new Error(
      `Version reference ${reference.id} does not match ${version.id}.`
    );
  }
  return readProjectVersionMarkdown(project, version);
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
  if (project.persistence.commentsReference) {
    return project.persistence.commentsReference;
  }
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
  assertUniqueDocumentLocalIds({
    documentId: getProjectDocumentScopeId(project),
    ids: comments.map((comment) => comment.id),
    kind: "comment"
  });
  project.persistence.commentsReference = comments;
  project.persistence.commentsRaw = undefined;
  if (!project.persistence.files.comments) {
    project.persistence.files.comments = await createPersistedFileCommit(
      ".patchmark/comments.json",
      rawComments
    );
  }
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

  try {
    await writeTextFile(contextPackFileHandle, contents);

    const writtenContents = await readTextFile(contextPackFileHandle);
    if (writtenContents !== contents) {
      throw new Error(`Could not verify context pack ${fileName}.`);
    }
  } catch (error) {
    if (contextPacksDirectoryHandle.removeEntry) {
      await contextPacksDirectoryHandle.removeEntry(fileName).catch(() => {});
    }
    throw error;
  }

  return `${metadataDirectoryName}/context-packs/${fileName}`;
}

export async function readProjectContextPack({
  project,
  relativePath
}: {
  project: PatchmarkProjectHandle;
  relativePath: string;
}): Promise<string> {
  const fileName = getContextPackFileName(relativePath);
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const contextPacksDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("context-packs");
  return readTextFile(await contextPacksDirectoryHandle.getFileHandle(fileName));
}

export async function removeProjectContextPack({
  project,
  relativePath
}: {
  project: PatchmarkProjectHandle;
  relativePath: string;
}): Promise<boolean> {
  const fileName = getContextPackFileName(relativePath);
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const contextPacksDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("context-packs");
  if (!contextPacksDirectoryHandle.removeEntry) {
    return false;
  }
  try {
    await contextPacksDirectoryHandle.removeEntry(fileName);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return true;
    }
    throw error;
  }
}

export async function readProjectReviewBatchRecords(
  project: PatchmarkProjectHandle
): Promise<PatchmarkReviewBatch[]> {
  if (project.persistence.reviewBatchesReference) {
    return project.persistence.reviewBatchesReference;
  }
  const identity = getProjectDocumentIdentity(project);
  const hasCommittedRecords = Boolean(project.persistence.files.review_batches);
  let text = project.persistence.reviewBatchesRaw;
  if (text === undefined && hasCommittedRecords) {
    const metadataDirectoryHandle = await getProjectReadMetadataDirectory(project);
    text = await readTextFile(
      await metadataDirectoryHandle.getFileHandle(
        project.persistence.readSource === "lkg"
          ? `${reviewBatchesFileName}.lkg`
          : reviewBatchesFileName
      )
    );
  }
  const records = parseReviewBatchRecords({
    identity,
    text: hasCommittedRecords ? text ?? "[]\n" : "[]\n"
  });
  project.persistence.reviewBatchesReference = records;
  project.persistence.reviewBatchesRaw = undefined;
  return records;
}

export async function commitProjectReviewBatchUpdate({
  project,
  reason,
  update
}: {
  project: PatchmarkProjectHandle;
  reason: string;
  update: (batches: PatchmarkReviewBatch[]) => PatchmarkReviewBatch[];
}): Promise<PatchmarkReviewBatch[]> {
  if (!project.persistence.reviewBatchesReference) {
    await readProjectReviewBatchRecords(project);
  }
  await commitProjectState({
    project,
    reason,
    reviewBatchesUpdate: update
  });
  return project.persistence.reviewBatchesReference ?? [];
}

export async function readProjectReviewQueueOverrides(
  project: PatchmarkProjectHandle
): Promise<PatchmarkReviewQueueOverrides> {
  if (project.persistence.reviewQueueOverridesReference) {
    return project.persistence.reviewQueueOverridesReference;
  }
  const identity = getProjectDocumentIdentity(project);
  const hasCommittedOverrides = Boolean(
    project.persistence.files.review_queue_overrides
  );
  let text = project.persistence.reviewQueueOverridesRaw;
  if (text === undefined && hasCommittedOverrides) {
    const metadataDirectoryHandle = await getProjectReadMetadataDirectory(project);
    text = await readTextFile(
      await metadataDirectoryHandle.getFileHandle(
        project.persistence.readSource === "lkg"
          ? `${reviewQueueOverridesFileName}.lkg`
          : reviewQueueOverridesFileName
      )
    );
  }
  const overrides = hasCommittedOverrides
    ? parseReviewQueueOverrides({
        identity,
        text:
          text ??
          serializeReviewQueueOverrides({
            identity,
            overrides: createEmptyReviewQueueOverrides(identity)
          })
      })
    : createEmptyReviewQueueOverrides(identity);
  project.persistence.reviewQueueOverridesReference = overrides;
  project.persistence.reviewQueueOverridesRaw = undefined;
  return overrides;
}

export async function commitProjectReviewQueueOverridesUpdate({
  project,
  reason,
  update
}: {
  project: PatchmarkProjectHandle;
  reason: string;
  update: (
    overrides: PatchmarkReviewQueueOverrides
  ) => PatchmarkReviewQueueOverrides;
}): Promise<PatchmarkReviewQueueOverrides> {
  if (!project.persistence.reviewQueueOverridesReference) {
    await readProjectReviewQueueOverrides(project);
  }
  await commitProjectState({
    project,
    reason,
    reviewQueueOverridesUpdate: update
  });
  return (
    project.persistence.reviewQueueOverridesReference ??
    createEmptyReviewQueueOverrides(getProjectDocumentIdentity(project))
  );
}

export class RewriteProjectSessionConflictError extends Error {
  constructor(message = "This rewrite draft changed in another Patchmark window.") {
    super(message);
    this.name = "RewriteProjectSessionConflictError";
  }
}

export async function readProjectRewriteSessionRecords(
  project: PatchmarkProjectHandle
): Promise<RewriteProjectSessionRecord[]> {
  if (project.persistence.rewriteSessionsReference) {
    return project.persistence.rewriteSessionsReference;
  }
  const identity = getProjectDocumentIdentity(project);
  const hasCommittedSessions = Boolean(project.persistence.files.rewrite_sessions);
  let text = project.persistence.rewriteSessionsRaw;
  if (text === undefined && hasCommittedSessions) {
    const metadataDirectoryHandle = await getProjectReadMetadataDirectory(project);
    text = await readTextFile(
      await metadataDirectoryHandle.getFileHandle(
        project.persistence.readSource === "lkg"
          ? `${rewriteSessionsFileName}.lkg`
          : rewriteSessionsFileName
      )
    );
  }
  const records = hasCommittedSessions
    ? parseRewriteProjectSessionStore({
        identity,
        text:
          text ??
          serializeRewriteProjectSessionStore({ identity, sessions: [] })
      }).sessions
    : [];
  project.persistence.rewriteSessionsReference = records;
  project.persistence.rewriteSessionsRaw = undefined;
  return records;
}

export async function saveProjectRewriteSessionRecord({
  expectedRevision,
  project,
  record,
  reason
}: {
  expectedRevision: number;
  project: PatchmarkProjectHandle;
  record: RewriteProjectSessionRecord;
  reason: string;
}): Promise<{
  commit: PatchmarkProjectCommitResult;
  record: RewriteProjectSessionRecord;
  sessions: RewriteProjectSessionRecord[];
}> {
  return saveProjectStateWithRewriteSessionRecord({
    expectedRevision,
    project,
    reason,
    rewriteSessionRecord: record
  });
}

export async function saveProjectStateWithRewriteSessionRecord({
  comments,
  expectedRevision,
  manifest,
  markdown,
  patches,
  project,
  reason,
  rewriteSessionRecord
}: {
  comments?: PatchmarkComment[];
  expectedRevision: number;
  manifest?: PatchmarkManifest;
  markdown?: string;
  patches?: PatchmarkPatch[];
  project: PatchmarkProjectHandle;
  reason: string;
  rewriteSessionRecord: RewriteProjectSessionRecord;
}): Promise<{
  commit: PatchmarkProjectCommitResult;
  record: RewriteProjectSessionRecord;
  sessions: RewriteProjectSessionRecord[];
}> {
  const identity = getProjectDocumentIdentity(project);
  if (
    rewriteSessionRecord.project_id !== identity.projectId ||
    rewriteSessionRecord.document_id !== identity.documentId
  ) {
    throw new Error("The Human Rewrite session does not belong to this project document.");
  }
  return withRewriteProjectLock(identity, async () => {
    await assertProjectCommitStillCurrent(project);
    const currentSessions = await readCurrentRewriteSessionRecordsFromDisk(project);
    const current = currentSessions.find(
      (candidate) =>
        candidate.rewrite_session_id === rewriteSessionRecord.rewrite_session_id
    );
    const currentRevision = current?.authoritative_revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new RewriteProjectSessionConflictError();
    }
    const nextRecord = {
      ...rewriteSessionRecord,
      authoritative_revision: currentRevision + 1,
      authoritative_generation: project.persistence.generation + 1
    } as RewriteProjectSessionRecord;
    const nextSessions = [
      ...currentSessions.filter(
        (candidate) =>
          candidate.rewrite_session_id !== rewriteSessionRecord.rewrite_session_id
      ),
      nextRecord
    ];
    const commit = await saveProjectState({
      comments,
      manifest,
      markdown,
      patches,
      project,
      reason,
      rewriteSessions: nextSessions,
      rollbackOnFailure: true
    });
    return { commit, record: nextRecord, sessions: nextSessions };
  });
}

export async function verifyProjectRewriteSessionRecord({
  project,
  session
}: {
  project: PatchmarkProjectHandle;
  session: RewriteProjectSessionRecord;
}): Promise<boolean> {
  const records = await readCurrentRewriteSessionRecordsFromDisk(project);
  const current = records.find(
    (candidate) => candidate.rewrite_session_id === session.rewrite_session_id
  );
  return Boolean(
    current &&
      current.status === session.status &&
      current.authoritative_revision === session.authoritative_revision &&
      current.human_draft_sha256 === session.human_draft_sha256
  );
}

async function readCurrentRewriteSessionRecordsFromDisk(
  project: PatchmarkProjectHandle
): Promise<RewriteProjectSessionRecord[]> {
  if (!project.persistence.files.rewrite_sessions) {
    return [];
  }
  const identity = getProjectDocumentIdentity(project);
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const text = await readOptionalTextFile(
    metadataDirectoryHandle,
    rewriteSessionsFileName
  );
  if (text === null) {
    return [];
  }
  return parseRewriteProjectSessionStore({ identity, text }).sessions;
}

async function assertProjectCommitStillCurrent(
  project: PatchmarkProjectHandle
): Promise<void> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const currentText = await readOptionalTextFile(
    metadataDirectoryHandle,
    saveCommitFileName
  );
  if (!project.persistence.commit && currentText === null) {
    return;
  }
  if (!project.persistence.commit || currentText === null) {
    throw new RewriteProjectSessionConflictError();
  }
  const details: string[] = [];
  const current = parseSaveCommitForValidation(currentText, details);
  if (
    !current ||
    details.length > 0 ||
    current.commit_id !== project.persistence.commit.commit_id ||
    current.generation !== project.persistence.generation
  ) {
    throw new RewriteProjectSessionConflictError();
  }
}

const rewriteProjectLocks = new Map<string, Promise<void>>();

async function withRewriteProjectLock<T>(
  identity: ProjectDocumentIdentity,
  operation: () => Promise<T>
): Promise<T> {
  const key = `patchmark-human-rewrite:${identity.projectId}:${identity.documentId}`;
  const lockManager = typeof navigator !== "undefined"
    ? (navigator as Navigator & {
        locks?: { request: <R>(name: string, callback: () => Promise<R>) => Promise<R> };
      }).locks
    : undefined;
  if (lockManager) {
    return lockManager.request(key, operation);
  }
  const previous = rewriteProjectLocks.get(key) ?? Promise.resolve();
  let resolveTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    resolveTail = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => tail);
  rewriteProjectLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    resolveTail();
    if (rewriteProjectLocks.get(key) === queued) {
      rewriteProjectLocks.delete(key);
    }
  }
}

export async function readProjectPatches(
  project: PatchmarkProjectHandle
): Promise<PatchmarkPatch[]> {
  if (project.persistence.patchesReference) {
    return project.persistence.patchesReference;
  }
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
  assertUniqueDocumentLocalIds({
    documentId: getProjectDocumentScopeId(project),
    ids: patches.map((patch) => patch.id),
    kind: "patch"
  });
  project.persistence.patchesReference = patches;
  project.persistence.patchesRaw = undefined;
  if (!project.persistence.files.patches) {
    project.persistence.files.patches = await createPersistedFileCommit(
      ".patchmark/patches.json",
      rawPatches
    );
  }
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
}): Promise<Readonly<{
  createdDirectory: boolean;
  relativePath: string;
}>> {
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName,
    { create: true }
  );
  let createdDirectory = false;
  let importsDirectoryHandle: PatchmarkDirectoryHandle;
  try {
    importsDirectoryHandle = await metadataDirectoryHandle.getDirectoryHandle(
      "imports"
    );
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    importsDirectoryHandle = await metadataDirectoryHandle.getDirectoryHandle(
      "imports",
      {
        create: true
      }
    );
    createdDirectory = true;
  }
  const importFileHandle = await importsDirectoryHandle.getFileHandle(fileName, {
    create: true
  });

  try {
    await writeTextFile(importFileHandle, contents);
  } catch (error) {
    await importsDirectoryHandle.removeEntry?.(fileName).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    createdDirectory,
    relativePath: `${metadataDirectoryName}/imports/${fileName}`
  });
}

export async function removeProjectImport({
  project,
  relativePath,
  removeEmptyDirectory = false
}: {
  project: PatchmarkProjectHandle;
  relativePath: string;
  removeEmptyDirectory?: boolean;
}): Promise<boolean> {
  const match = /^\.patchmark\/imports\/([^/]+)$/.exec(relativePath);
  if (!match || match[1].includes("..")) {
    throw new Error("The Patchmark import path is invalid.");
  }
  const metadataDirectoryHandle = await project.directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const importsDirectoryHandle =
    await metadataDirectoryHandle.getDirectoryHandle("imports");
  if (!importsDirectoryHandle.removeEntry) {
    return false;
  }
  try {
    await importsDirectoryHandle.removeEntry(match[1]);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (removeEmptyDirectory) {
    try {
      await metadataDirectoryHandle.removeEntry?.("imports");
    } catch {
      // Preserve a concurrently populated imports directory.
    }
  }
  return true;
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
  const lkg = await readValidLastKnownGoodGeneration(
    project.directoryHandle,
    getProjectDocumentIdentity(project)
  );

  if (!lkg) {
    throw new Error("The last complete project save is no longer available.");
  }

  await preserveQuestionableCurrentProjectFiles(project.directoryHandle);
  const restoreId = `restore-${Date.now().toString(36)}`;
  const preparedFiles: PreparedProjectFile[] = [];

  try {
    for (const key of getCommittedProjectFileKeys(lkg.commit)) {
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
    if (!lkg.commit.files.review_batches) {
      await removeReviewBatchFileIfPresent(project.directoryHandle);
    }
    if (!lkg.commit.files.review_queue_overrides) {
      await removeReviewQueueOverridesFileIfPresent(project.directoryHandle);
    }
    if (!lkg.commit.files.rewrite_sessions) {
      await removeRewriteSessionsFileIfPresent(project.directoryHandle);
    }
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
      reviewBatchesRaw: lkg.commit.files.review_batches
        ? lkg.texts.review_batches
        : undefined,
      reviewQueueOverridesRaw: lkg.commit.files.review_queue_overrides
        ? lkg.texts.review_queue_overrides
        : undefined,
      rewriteSessionsRaw: lkg.commit.files.rewrite_sessions
        ? lkg.texts.rewrite_sessions
        : undefined,
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
  manifestUpdate,
  markdown,
  patches,
  reviewBatches,
  reviewBatchesUpdate,
  reviewQueueOverrides,
  reviewQueueOverridesUpdate,
  rewriteSessions,
  rewriteSessionsUpdate,
  rollbackOnFailure = false,
  validateBeforeCommit,
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
        manifestUpdate,
        markdown,
        patches,
        reviewBatches,
        reviewBatchesUpdate,
        reviewQueueOverrides,
        reviewQueueOverridesUpdate,
        rewriteSessions,
        rewriteSessionsUpdate,
        rollbackOnFailure,
        validateBeforeCommit,
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
  manifestUpdate,
  markdown,
  patches,
  reviewBatches,
  reviewBatchesUpdate,
  reviewQueueOverrides,
  reviewQueueOverridesUpdate,
  rewriteSessions,
  rewriteSessionsUpdate,
  rollbackOnFailure,
  validateBeforeCommit,
  project,
  queue,
  reason,
  requestId
}: ProjectCommitRequest & {
  project: PatchmarkProjectHandle;
  queue: ProjectWriteQueueState;
  requestId: number;
}): Promise<PatchmarkProjectCommitResult> {
  validateBeforeCommit?.();
  const persistence = project.persistence;
  const debug = persistence.debug;
  const bytesWrittenBeforeCommit = debug.bytesWritten;
  const changedFiles: ProjectCommitFileKey[] = [];
  const serializedFiles: ProjectCommitFileKey[] = [];
  const desiredTexts: Partial<Record<ProjectCommitFileKey, string>> = {};
  const requestedManifest = manifestUpdate
    ? manifestUpdate(project.manifest)
    : manifest;

  debug.lastFileResults = {
    document: "skipped",
    comments: "skipped",
    patches: "skipped",
    review_batches: "skipped",
    review_queue_overrides: "skipped",
    rewrite_sessions: "skipped",
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
      const commentsText = serializeComments(
        comments,
        getProjectDocumentScopeId(project)
      );
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
      const patchesText = serializePatches(
        patches,
        getProjectDocumentScopeId(project)
      );
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

  const currentReviewBatches =
    persistence.reviewBatchesReference ??
    parseReviewBatchRecords({
      identity: getProjectDocumentIdentity(project),
      text: persistence.files.review_batches
        ? persistence.reviewBatchesRaw ?? "[]\n"
        : "[]\n"
    });
  const requestedReviewBatches = reviewBatchesUpdate
    ? reviewBatchesUpdate(currentReviewBatches)
    : reviewBatches;
  if (requestedReviewBatches !== undefined) {
    if (requestedReviewBatches === persistence.reviewBatchesReference) {
      debug.lastFileResults.review_batches = "unchanged";
    } else {
      const reviewBatchesText = serializeReviewBatchRecords({
        identity: getProjectDocumentIdentity(project),
        records: requestedReviewBatches
      });
      serializedFiles.push("review_batches");
      debug.serializationCount += 1;
      const reviewBatchesCommit = await createPersistedFileCommit(
        `${metadataDirectoryName}/${reviewBatchesFileName}`,
        reviewBatchesText
      );
      const currentReviewBatchesCommit =
        persistence.files.review_batches ??
        (await createPersistedFileCommit(
          `${metadataDirectoryName}/${reviewBatchesFileName}`,
          "[]\n"
        ));
      if (reviewBatchesCommit.sha256 === currentReviewBatchesCommit.sha256) {
        persistence.reviewBatchesReference = requestedReviewBatches;
        debug.lastFileResults.review_batches = "unchanged";
      } else {
        changedFiles.push("review_batches");
        desiredTexts.review_batches = reviewBatchesText;
        debug.lastFileResults.review_batches = "changed";
      }
    }
  }

  const reviewQueueIdentity = getProjectDocumentIdentity(project);
  const emptyReviewQueueOverrides = createEmptyReviewQueueOverrides(
    reviewQueueIdentity
  );
  const emptyReviewQueueOverridesText = serializeReviewQueueOverrides({
    identity: reviewQueueIdentity,
    overrides: emptyReviewQueueOverrides
  });
  const currentReviewQueueOverrides =
    persistence.reviewQueueOverridesReference ??
    (persistence.files.review_queue_overrides
      ? parseReviewQueueOverrides({
          identity: reviewQueueIdentity,
          text:
            persistence.reviewQueueOverridesRaw ??
            emptyReviewQueueOverridesText
        })
      : emptyReviewQueueOverrides);
  const requestedReviewQueueOverrides = reviewQueueOverridesUpdate
    ? reviewQueueOverridesUpdate(currentReviewQueueOverrides)
    : reviewQueueOverrides;
  if (requestedReviewQueueOverrides !== undefined) {
    if (
      requestedReviewQueueOverrides ===
      persistence.reviewQueueOverridesReference
    ) {
      debug.lastFileResults.review_queue_overrides = "unchanged";
    } else {
      const reviewQueueOverridesText = serializeReviewQueueOverrides({
        identity: reviewQueueIdentity,
        overrides: requestedReviewQueueOverrides
      });
      serializedFiles.push("review_queue_overrides");
      debug.serializationCount += 1;
      const reviewQueueOverridesCommit = await createPersistedFileCommit(
        `${metadataDirectoryName}/${reviewQueueOverridesFileName}`,
        reviewQueueOverridesText
      );
      const currentReviewQueueOverridesCommit =
        persistence.files.review_queue_overrides ??
        (await createPersistedFileCommit(
          `${metadataDirectoryName}/${reviewQueueOverridesFileName}`,
          emptyReviewQueueOverridesText
        ));
      if (
        reviewQueueOverridesCommit.sha256 ===
        currentReviewQueueOverridesCommit.sha256
      ) {
        persistence.reviewQueueOverridesReference =
          requestedReviewQueueOverrides;
        debug.lastFileResults.review_queue_overrides = "unchanged";
      } else {
        changedFiles.push("review_queue_overrides");
        desiredTexts.review_queue_overrides = reviewQueueOverridesText;
        debug.lastFileResults.review_queue_overrides = "changed";
      }
    }
  }

  const rewriteIdentity = getProjectDocumentIdentity(project);
  const emptyRewriteSessionsText = serializeRewriteProjectSessionStore({
    identity: rewriteIdentity,
    sessions: []
  });
  const currentRewriteSessions =
    persistence.rewriteSessionsReference ??
    (persistence.files.rewrite_sessions
      ? parseRewriteProjectSessionStore({
          identity: rewriteIdentity,
          text: persistence.rewriteSessionsRaw ?? emptyRewriteSessionsText
        }).sessions
      : []);
  const requestedRewriteSessions = rewriteSessionsUpdate
    ? rewriteSessionsUpdate(currentRewriteSessions)
    : rewriteSessions;
  if (requestedRewriteSessions !== undefined) {
    if (requestedRewriteSessions === persistence.rewriteSessionsReference) {
      debug.lastFileResults.rewrite_sessions = "unchanged";
    } else {
      const rewriteSessionsText = serializeRewriteProjectSessionStore({
        identity: rewriteIdentity,
        sessions: requestedRewriteSessions
      });
      serializedFiles.push("rewrite_sessions");
      debug.serializationCount += 1;
      const rewriteSessionsCommit = await createPersistedFileCommit(
        `${metadataDirectoryName}/${rewriteSessionsFileName}`,
        rewriteSessionsText
      );
      const currentRewriteSessionsCommit =
        persistence.files.rewrite_sessions ??
        (await createPersistedFileCommit(
          `${metadataDirectoryName}/${rewriteSessionsFileName}`,
          emptyRewriteSessionsText
        ));
      if (rewriteSessionsCommit.sha256 === currentRewriteSessionsCommit.sha256) {
        persistence.rewriteSessionsReference = requestedRewriteSessions;
        debug.lastFileResults.rewrite_sessions = "unchanged";
      } else {
        changedFiles.push("rewrite_sessions");
        desiredTexts.rewrite_sessions = rewriteSessionsText;
        debug.lastFileResults.rewrite_sessions = "changed";
      }
    }
  }

  const manifestChanged =
    requestedManifest !== undefined &&
    createManifestMeaningfulKey(requestedManifest) !==
      createManifestMeaningfulKey(project.manifest);

  if (manifestChanged) {
    changedFiles.push("manifest");
    debug.lastFileResults.manifest = "changed";
  } else if (requestedManifest !== undefined) {
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

  const includeCurrentReviewBatches = Boolean(
    persistence.files.review_batches
  );
  const includeCurrentReviewQueueOverrides = Boolean(
    persistence.files.review_queue_overrides
  );
  const includeCurrentRewriteSessions = Boolean(
    persistence.files.rewrite_sessions
  );
  const currentTexts = await readCurrentProjectTexts(
    project.directoryHandle,
    includeCurrentReviewBatches,
    includeCurrentReviewQueueOverrides,
    emptyReviewQueueOverridesText,
    includeCurrentRewriteSessions,
    emptyRewriteSessionsText
  );
  const currentDescriptors = await createProjectFileDescriptors(
    currentTexts,
    includeCurrentReviewBatches,
    includeCurrentReviewQueueOverrides
  );
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
    ...(requestedManifest ?? project.manifest),
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
  const includeNextReviewBatches =
    includeCurrentReviewBatches || changedFiles.includes("review_batches");
  const includeNextReviewQueueOverrides =
    includeCurrentReviewQueueOverrides ||
    changedFiles.includes("review_queue_overrides");
  const includeNextRewriteSessions =
    includeCurrentRewriteSessions || changedFiles.includes("rewrite_sessions");
  const nextDescriptors = await createProjectFileDescriptors(
    nextTexts,
    includeNextReviewBatches,
    includeNextReviewQueueOverrides,
    includeNextRewriteSessions
  );
  const saveCommit: PatchmarkSaveCommit = {
    format_version: saveCommitFormatVersion,
    generation,
    commit_id: commitId,
    created_at: createdAt,
    files: nextDescriptors
  };
  const commitText = serializeSaveCommit(saveCommit);
  const preparedFiles: PreparedProjectFile[] = [];
  const attemptedInstalls: PreparedProjectFile[] = [];

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
      validateBeforeCommit?.();
      attemptedInstalls.push(prepared);
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

    validateBeforeCommit?.();
    attemptedInstalls.push(manifestPrepared);
    await installPreparedProjectFile(manifestPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
    validateBeforeCommit?.();
    attemptedInstalls.push(commitPrepared);
    await installPreparedProjectFile(commitPrepared, (bytes) =>
      recordPersistenceWrite(project, bytes)
    );
    validateBeforeCommit?.();
  } catch (error) {
    if (rollbackOnFailure) {
      const rollbackSucceeded = await rollbackAttemptedProjectInstalls({
        attemptedInstalls,
        currentCommit,
        currentTexts,
        includeCurrentReviewBatches,
        includeCurrentReviewQueueOverrides,
        includeCurrentRewriteSessions,
        onWrite: (bytes) => recordPersistenceWrite(project, bytes)
      });
      if (!rollbackSucceeded) {
        persistence.readSource = "lkg";
      }
    }
    throw error;
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

  if (requestedReviewBatches !== undefined) {
    persistence.reviewBatchesReference = requestedReviewBatches;
    persistence.reviewBatchesRaw = undefined;
  }

  if (requestedReviewQueueOverrides !== undefined) {
    persistence.reviewQueueOverridesReference = requestedReviewQueueOverrides;
    persistence.reviewQueueOverridesRaw = undefined;
  }

  if (requestedRewriteSessions !== undefined) {
    persistence.rewriteSessionsReference = requestedRewriteSessions;
    persistence.rewriteSessionsRaw = undefined;
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
  await dispatchCommittedProjectShadow(project, reason, result);
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

function serializeComments(
  comments: PatchmarkComment[],
  documentId: string
): string {
  const normalized = comments.map(normalizeComment);
  assertUniqueDocumentLocalIds({
    documentId,
    ids: normalized.map((comment) => comment.id),
    kind: "comment"
  });
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function serializePatches(
  patches: PatchmarkPatch[],
  documentId: string
): string {
  const normalized = patches.map(normalizePatch);
  assertUniqueDocumentLocalIds({
    documentId,
    ids: normalized.map((patch) => patch.id),
    kind: "patch"
  });
  return `${JSON.stringify(normalized, null, 2)}\n`;
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
  manifest: PatchmarkProjectManifestV1,
  options: { readOnly?: boolean } = {}
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
    selected.document_id,
    options
  );
}

async function openRegisteredProjectDocument(
  root: PatchmarkDirectoryHandle,
  projectManifest: PatchmarkProjectManifestV1,
  documentId: string,
  options: {
    performanceOperationId?: string | null;
    readOnly?: boolean;
  } = {}
): Promise<LoadedPatchmarkProject> {
  const operationId = options.performanceOperationId;
  markDocumentSwitchPerformance(operationId, "target_open_started");
  const document = getRegisteredDocument(projectManifest, documentId);
  const ownershipStartedAt = performance.now();
  const scopedDirectory = (await createDocumentScopedDirectoryHandle(
    root as ProjectDirectoryHandle,
    document
  )) as PatchmarkDirectoryHandle;
  recordDocumentSwitchPerformanceDuration(
    operationId,
    "validate_target_ownership",
    performance.now() - ownershipStartedAt
  );
  markDocumentSwitchPerformance(operationId, "target_ownership_validated");

  let documentFile: MarkdownFileHandle;
  try {
    documentFile = await scopedDirectory.getFileHandle(documentFileName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    const missing = await createMissingDocumentProject({
      document,
      projectManifest,
      root,
      scopedDirectory
    });
    rememberPreferredDocumentId(projectManifest.project_id, documentId);
    return missing;
  }

  const metadataDirectory = await scopedDirectory.getDirectoryHandle(
    metadataDirectoryName
  );
  const documentManifestFile = await getRequiredFileHandle(
    metadataDirectory,
    manifestFileName,
    `Document store ${documentId} is missing manifest.json.`
  );
  const manifestReadStartedAt = performance.now();
  const markdownReadStartedAt = performance.now();
  const [targetManifestText, targetMarkdown] = await Promise.all([
    readTextFile(documentManifestFile).then((text) => {
      recordDocumentSwitchPerformanceDuration(
        operationId,
        "read_target_manifest",
        performance.now() - manifestReadStartedAt
      );
      return text;
    }),
    readTextFile(documentFile).then((text) => {
      recordDocumentSwitchPerformanceDuration(
        operationId,
        "read_target_markdown",
        performance.now() - markdownReadStartedAt
      );
      return text;
    })
  ]);
  incrementDocumentSwitchPerformanceCounter(
    operationId,
    "bytes_read",
    new TextEncoder().encode(targetManifestText).byteLength +
      new TextEncoder().encode(targetMarkdown).byteLength
  );
  markDocumentSwitchPerformance(operationId, "target_markdown_read");
  const loaded = await createOpenedProjectHandle({
    directoryHandle: scopedDirectory,
    documentIdentity: createProjectDocumentIdentity(
      projectManifest.project_id,
      document.document_id
    ),
    manifestText: targetManifestText,
    markdown: targetMarkdown,
    performanceOperationId: operationId,
    readOnly: options.readOnly
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
    details,
    createProjectDocumentIdentity(
      projectManifest.project_id,
      document.document_id
    )
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
  manifest: PatchmarkProjectManifestV1,
  reason: string | null
): Promise<void> {
  await writeProjectManifestAtomic(
    getAuthoritativeProjectDirectory(project) as ProjectDirectoryHandle,
    manifest
  );
  updateProjectRegistryContext(project, manifest);
  if (reason !== null) {
    await dispatchCommittedRegistryShadow(project, reason, manifest);
  }
}

async function dispatchCommittedProjectShadow(
  project: PatchmarkProjectHandle,
  reason: string,
  result: PatchmarkProjectCommitResult
): Promise<void> {
  const mutationKind = classifyShadowMutation(reason);
  if (mutationKind === null || result.status !== "committed" || !result.commitId) {
    return;
  }
  const dispatch = runCollaborationShadowAfterLegacyCommit(() =>
    createCollaborationShadowReceipt({
      project,
      mutationKind,
      mutationKey: reason,
      legacyCommit: {
        commit_kind: "project_save",
        status: "committed",
        generation: result.generation,
        commit_id: result.commitId!,
        changed_files: Object.freeze([...result.changedFiles].sort()),
        source_state_commitment: createSaveStateCommitment(project, result)
      },
      includeContent: true
    })
  );
  if (!isCollaborationShadowDisabled(dispatch)) await dispatch;
}

async function dispatchCommittedRegistryShadow(
  project: PatchmarkProjectHandle,
  reason: string,
  manifest: PatchmarkProjectManifestV1
): Promise<void> {
  const dispatch = runCollaborationShadowAfterLegacyCommit(() =>
    createCollaborationShadowReceipt({
      project,
      mutationKind: "shared_metadata_mutation",
      mutationKey: reason,
      legacyCommit: {
        commit_kind: "project_registry",
        status: "committed",
        manifest_revision: manifest.manifest_revision,
        source_state_commitment: createRegistryStateCommitment(manifest)
      },
      includeContent: false
    })
  );
  if (!isCollaborationShadowDisabled(dispatch)) await dispatch;
}

function classifyShadowMutation(reason: string): CollaborationShadowMutationKind | null {
  if (reason === "explicit_save" || reason === "save_document") return "document_save";
  if (reason === "import_chatgpt_response") return "patch_import";
  if (reason.startsWith("accept_patch:")) return "patch_decision";
  if (reason.startsWith("reject_patch:") || reason.startsWith("reject_patch_group:")) {
    return "patch_decision";
  }
  if (reason.startsWith("update_patch_anchor:")) return "patch_edit";
  if (
    reason === "update_comment_state" ||
    reason.startsWith("comment_") ||
    reason.startsWith("human_reanchor:")
  ) {
    return "comment_mutation";
  }
  if (
    reason.startsWith("create_review_batch:") ||
    reason.startsWith("cancel_review_batch:") ||
    reason.startsWith("record_review_batch_response:") ||
    reason.startsWith("acknowledge_review_batch_response:") ||
    reason.startsWith("analyze_legacy_review_batch_response:")
  ) {
    return "review_batch_mutation";
  }
  if (reason.startsWith("human_rewrite:") || reason.startsWith("discard_human_rewrite:")) {
    return "rewrite_terminal";
  }
  return null;
}

async function createCollaborationShadowReceipt(options: Readonly<{
  project: PatchmarkProjectHandle;
  mutationKind: CollaborationShadowMutationKind;
  mutationKey: string;
  legacyCommit: CollaborationShadowMutationReceipt["legacy_commit"];
  includeContent: boolean;
}>): Promise<CollaborationShadowMutationReceipt> {
  const identity = getProjectDocumentIdentity(options.project);
  return Object.freeze({
    schema_version: 1,
    object_kind: "collaboration_shadow_mutation_receipt" as const,
    source_project_instance_commitment:
      getCollaborationShadowSourceProjectInstanceCommitment(options.project),
    source_project_id: identity.projectId,
    source_document_id: identity.documentId,
    mutation_kind: options.mutationKind,
    mutation_key: options.mutationKey,
    legacy_commit: options.legacyCommit,
    committed_shared_state: await createLegacySharedStateSnapshot(
      options.project,
      options.includeContent
    )
  });
}

export function getCollaborationShadowSourceProjectInstanceCommitment(
  project: PatchmarkProjectHandle
): string {
  const identity = getProjectDocumentIdentity(project);
  const createdAt = project.projectManifest?.created_at ?? project.manifest.created_at;
  return `${identity.projectId}:${createdAt}`.replaceAll(/[^A-Za-z0-9._:-]/g, "_");
}

async function createLegacySharedStateSnapshot(
  project: PatchmarkProjectHandle,
  includeContent: boolean
): Promise<ShadowLegacySharedState> {
  const identity = getProjectDocumentIdentity(project);
  const registry = project.projectManifest;
  const groups = (registry?.groups ?? []).map((group) => Object.freeze({
    source_group_id: group.group_id,
    title: group.title,
    position: group.position.toString()
  })).sort((left, right) => left.source_group_id.localeCompare(right.source_group_id));
  const currentContent = includeContent
    ? await createLegacyDocumentContent(project)
    : null;
  const documents: ShadowLegacyDocument[] = registry
    ? registry.documents.map((document) => Object.freeze({
        source_document_id: document.document_id,
        title: document.display_title,
        logical_path: document.path,
        position: document.position.toString(),
        source_group_id: document.group_id ?? null,
        archive_status: document.status,
        tombstone: false,
        content: document.document_id === identity.documentId ? currentContent : null
      }))
    : [Object.freeze({
        source_document_id: identity.documentId,
        title: project.manifest.project_name,
        logical_path: project.manifest.document_file,
        position: "0",
        source_group_id: null,
        archive_status: "active" as const,
        tombstone: false,
        content: currentContent
      })];
  documents.sort((left, right) =>
    left.source_document_id.localeCompare(right.source_document_id)
  );
  return Object.freeze({
    project_title: getProjectTitle(project),
    group_order: Object.freeze(
      [...groups].sort(compareLegacyPosition).map((group) => group.source_group_id)
    ),
    groups: Object.freeze(groups),
    document_order: Object.freeze(
      documents
        .filter((document) => !document.tombstone)
        .sort(compareLegacyPosition)
        .map((document) => document.source_document_id)
    ),
    documents: Object.freeze(documents)
  });
}

async function createLegacyDocumentContent(
  project: PatchmarkProjectHandle
): Promise<ShadowLegacyDocument["content"]> {
  const persistence = project.persistence;
  const identity = getProjectDocumentIdentity(project);
  const sourceComments = persistence.commentsReference ??
    (persistence.commentsRaw
      ? (JSON.parse(persistence.commentsRaw) as unknown[]).map(normalizeComment)
      : []);
  const sourcePatches = persistence.patchesReference ??
    (persistence.patchesRaw
      ? (JSON.parse(persistence.patchesRaw) as unknown[]).map(normalizePatch)
      : []);
  const sourceReviewBatches = persistence.reviewBatchesReference ??
    parseReviewBatchRecords({
      identity,
      text: persistence.reviewBatchesRaw ?? "[]\n"
    });
  const sourceRewriteSessions = persistence.rewriteSessionsReference ??
    parseRewriteProjectSessionStore({
      identity,
      text: persistence.rewriteSessionsRaw ?? serializeRewriteProjectSessionStore({
        identity,
        sessions: []
      })
    }).sessions;
  const comments = sourceComments.map((comment) => Object.freeze({
    source_comment_id: comment.id,
    body: comment.comment,
    anchor: normalizeShadowAnchor(comment.anchor),
    status: comment.status,
    trash_status: comment.trashed_at ? "trashed" as const : "active" as const,
    tombstone: false,
    replies: Object.freeze(comment.thread.map((reply) => Object.freeze({
      source_reply_id: reply.id,
      body: reply.content,
      source_import_id: reply.source_import_id ?? null,
      tombstone: false
    })).sort((left, right) => left.source_reply_id.localeCompare(right.source_reply_id)))
  })).sort((left, right) => left.source_comment_id.localeCompare(right.source_comment_id));
  const patches = sourcePatches.map((patch) => {
    const dependencies = Object.freeze([...(patch.depends_on_patch_ids ?? [])].sort());
    const targetProvenance = patch.target_provenance
      ? JSON.stringify(patch.target_provenance)
      : null;
    return Object.freeze({
      source_patch_id: patch.id,
      source_comment_id: patch.comment_id ?? null,
      version_fingerprint: JSON.stringify({
        original_text: patch.original_text,
        suggested_text: patch.suggested_text,
        dependencies,
        target_provenance: targetProvenance
      }),
      dependency_source_patch_ids: dependencies,
      target_provenance: targetProvenance,
      source_import_id: patch.source_import_id ?? null,
      status: patch.status
    });
  }).sort((left, right) => left.source_patch_id.localeCompare(right.source_patch_id));
  const reviewBatches = sourceReviewBatches.map((batch) => {
    const lifecycle = normalizeReviewLifecycle(batch.status);
    const responseImportId = lifecycle === "responded" ? batch.import_id : null;
    const contributionSourceRefs = responseImportId === null
      ? []
      : [
          ...comments.flatMap((comment) => comment.replies
            .filter((reply) => reply.source_import_id === responseImportId)
            .map((reply) =>
              `reply:${comment.source_comment_id}:${reply.source_reply_id}`
            )),
          ...patches
            .filter((patch) => patch.source_import_id === responseImportId)
            .map((patch) => `patch:${patch.source_patch_id}`)
        ].sort();
    if (lifecycle === "responded" && responseImportId === null) {
      throw new Error("A responded review batch must retain its response import ID.");
    }
    return Object.freeze({
      source_review_batch_id: batch.batch_id,
      lifecycle,
      response_import_id: responseImportId,
      contribution_source_refs: Object.freeze(contributionSourceRefs)
    });
  }).sort((left, right) =>
    left.source_review_batch_id.localeCompare(right.source_review_batch_id)
  );
  const rewriteSessions = sourceRewriteSessions.map((session) => Object.freeze({
    source_rewrite_session_id: session.rewrite_session_id,
    outcome: session.status === "draft" ? "active" as const : session.status
  })).sort((left, right) =>
    left.source_rewrite_session_id.localeCompare(right.source_rewrite_session_id)
  );
  return Object.freeze({
    exact_markdown_bytes: new TextEncoder().encode(persistence.documentText),
    comments: Object.freeze(comments),
    patches: Object.freeze(patches),
    review_batches: Object.freeze(reviewBatches),
    rewrite_sessions: Object.freeze(rewriteSessions)
  });
}

function normalizeShadowAnchor(anchor: PatchmarkCommentAnchor): ShadowLegacyAnchor {
  if (anchor.kind === "document") {
    return Object.freeze({ kind: "document" as const, key: "document" });
  }
  if (anchor.kind === "section") {
    return Object.freeze({
      kind: "section" as const,
      key: JSON.stringify({ heading: anchor.heading, path: anchor.heading_path ?? [] })
    });
  }
  return Object.freeze({
    kind: "selected_text" as const,
    key: anchor.selected_text_hash ?? anchor.anchor_text_hash ?? anchor.selected_text
  });
}

function normalizeReviewLifecycle(
  status: PatchmarkReviewBatch["status"]
): "active" | "responded" | "cancelled" {
  if (status === "exported") return "active";
  if (status === "cancelled") return "cancelled";
  return "responded";
}

function createSaveStateCommitment(
  project: PatchmarkProjectHandle,
  result: PatchmarkProjectCommitResult
): string {
  const files = project.persistence.commit?.files;
  return JSON.stringify({
    generation: result.generation,
    commit_id: result.commitId,
    files: files
      ? Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(
          ([key, descriptor]) => [key, descriptor.sha256]
        )
      : []
  });
}

function createRegistryStateCommitment(manifest: PatchmarkProjectManifestV1): string {
  return JSON.stringify({
    project_id: manifest.project_id,
    manifest_revision: manifest.manifest_revision,
    groups: (manifest.groups ?? []).map((group) => [
      group.group_id,
      group.title,
      group.position
    ]),
    documents: manifest.documents.map((document) => [
      document.document_id,
      document.path,
      document.display_title,
      document.group_id ?? null,
      document.status,
      document.position
    ])
  });
}

function compareLegacyPosition(
  left: { position: string },
  right: { position: string }
): number {
  return Number(left.position) - Number(right.position) ||
    left.position.localeCompare(right.position);
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

async function findPendingLegacyAssemblyTransaction(
  root: PatchmarkDirectoryHandle,
  projectId: string
): Promise<PendingLegacyAssemblyTransaction | null> {
  try {
    const metadata = await root.getDirectoryHandle(metadataDirectoryName);
    const transactions = await metadata.getDirectoryHandle("transactions");
    if (!transactions.entries) {
      return null;
    }
    const candidates: PendingLegacyAssemblyTransaction[] = [];
    for await (const [assemblyId, entry] of transactions.entries()) {
      if (entry.kind !== "directory") {
        continue;
      }
      const directory = await transactions.getDirectoryHandle(assemblyId);
      const text = await readOptionalTextFile(directory, "assembly.json");
      if (!text) {
        continue;
      }
      try {
        const journal = JSON.parse(text) as unknown;
        if (
          isRecord(journal) &&
          journal.format === "patchmark-legacy-assembly-transaction" &&
          journal.destination_project_id === projectId &&
          ["manifest_committed", "reopened", "sources_verified"].includes(
            String(journal.stage)
          )
        ) {
          candidates.push({
            assemblyId,
            directory,
            stage: String(journal.stage),
            updatedAt:
              typeof journal.updated_at === "string" ? journal.updated_at : ""
          });
        }
      } catch {
        continue;
      }
    }
    candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0] ?? null;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function completePendingLegacyAssemblyTransaction(
  root: PatchmarkDirectoryHandle,
  manifest: PatchmarkProjectManifestV1,
  initiallyLoaded: LoadedPatchmarkProject,
  transaction: PendingLegacyAssemblyTransaction
): Promise<void> {
  for (const document of manifest.documents) {
    const loaded = await openRegisteredProjectDocument(
      root,
      manifest,
      document.document_id,
      { readOnly: true }
    );
    if (loaded.recovery || loaded.project.documentAvailability !== "available") {
      throw new Error(
        `Imported document ${document.document_id} did not reopen as authoritative.`
      );
    }
    await readProjectComments(loaded.project);
    await readProjectPatches(loaded.project);
    for (const version of await listProjectVersions(loaded.project)) {
      await readProjectVersionMarkdown(loaded.project, version);
    }
  }
  if (initiallyLoaded.project.document) {
    rememberPreferredDocumentId(
      manifest.project_id,
      initiallyLoaded.project.document.document_id
    );
  }
  await updateLegacyAssemblyJournal(transaction.directory, "complete");
  try {
    const metadata = await root.getDirectoryHandle(metadataDirectoryName);
    const transactions = await metadata.getDirectoryHandle("transactions");
    await transactions.removeEntry?.(transaction.assemblyId, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      return;
    }
  }
}

async function invalidatePendingLegacyAssemblyTransaction(
  root: PatchmarkDirectoryHandle,
  transaction: PendingLegacyAssemblyTransaction,
  error: unknown
): Promise<void> {
  try {
    await updateLegacyAssemblyJournal(
      transaction.directory,
      "invalid_destination",
      error
    );
  } finally {
    const metadata = await root.getDirectoryHandle(metadataDirectoryName);
    if (!metadata.removeEntry) {
      throw new Error(
        "This filesystem cannot remove the invalid assembled project manifest."
      );
    }
    try {
      await metadata.removeEntry("project.json");
    } catch (removeError) {
      if (!isNotFoundError(removeError)) {
        throw removeError;
      }
    }
  }
}

async function updateLegacyAssemblyJournal(
  directory: PatchmarkDirectoryHandle,
  stage: string,
  error?: unknown
): Promise<void> {
  const text = await readOptionalTextFile(directory, "assembly.json");
  let journal: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) {
        journal = parsed;
      }
    } catch {
      journal = {};
    }
  }
  await writeTextFile(
    await directory.getFileHandle("assembly.json", { create: true }),
    `${JSON.stringify({
      ...journal,
      stage,
      updated_at: new Date().toISOString(),
      ...(error ? { error: getErrorMessage(error) } : {})
    }, null, 2)}\n`
  );
}

async function createOpenedProjectHandle({
  directoryHandle,
  documentIdentity,
  manifestText,
  markdown,
  performanceOperationId,
  readOnly = false
}: {
  directoryHandle: PatchmarkDirectoryHandle;
  documentIdentity?: ProjectDocumentIdentity;
  manifestText: string;
  markdown: string;
  performanceOperationId?: string | null;
  readOnly?: boolean;
}): Promise<LoadedPatchmarkProject> {
  const currentStoreStartedAt = performance.now();
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const [
    temporaryFiles,
    commentsText,
    patchesText,
    reviewBatchesText,
    reviewQueueOverridesText,
    rewriteSessionsText,
    commitText
  ] = await Promise.all([
    listProjectTemporaryFiles(directoryHandle),
    readOptionalTextFile(metadataDirectoryHandle, commentsFileName),
    readOptionalTextFile(metadataDirectoryHandle, patchesFileName),
    readOptionalTextFile(metadataDirectoryHandle, reviewBatchesFileName),
    readOptionalTextFile(
      metadataDirectoryHandle,
      reviewQueueOverridesFileName
    ),
    readOptionalTextFile(metadataDirectoryHandle, rewriteSessionsFileName),
    readOptionalTextFile(metadataDirectoryHandle, saveCommitFileName)
  ]);
  const currentStoreReadDuration = performance.now() - currentStoreStartedAt;
  recordDocumentSwitchPerformanceDuration(
    performanceOperationId,
    "read_target_current_store",
    currentStoreReadDuration
  );
  const reviewBytes =
    new TextEncoder().encode(commentsText ?? "").byteLength +
    new TextEncoder().encode(patchesText ?? "").byteLength +
    new TextEncoder().encode(reviewBatchesText ?? "").byteLength +
    new TextEncoder().encode(reviewQueueOverridesText ?? "").byteLength +
    new TextEncoder().encode(rewriteSessionsText ?? "").byteLength +
    new TextEncoder().encode(commitText ?? "").byteLength;
  incrementDocumentSwitchPerformanceCounter(
    performanceOperationId,
    "bytes_read",
    reviewBytes
  );
  markDocumentSwitchPerformance(
    performanceOperationId,
    "target_current_store_read"
  );
  const currentDetails: string[] = [];
  const currentManifest = parseManifestForValidation(
    manifestText,
    directoryHandle.name,
    currentDetails,
    documentIdentity
  );

  if (commentsText === null) {
    currentDetails.push("Missing .patchmark/comments.json.");
  }

  if (patchesText === null) {
    currentDetails.push("Missing .patchmark/patches.json.");
  }

  const currentCommit = commitText
    ? parseSaveCommitForValidation(commitText, currentDetails)
    : null;
  const committedReviewBatches = Boolean(currentCommit?.files.review_batches);
  const committedReviewQueueOverrides = Boolean(
    currentCommit?.files.review_queue_overrides
  );
  const committedRewriteSessions = Boolean(
    currentCommit?.files.rewrite_sessions
  );
  if (committedReviewBatches && reviewBatchesText === null) {
    currentDetails.push("Missing .patchmark/review-batches.json.");
  }
  if (committedReviewQueueOverrides && reviewQueueOverridesText === null) {
    currentDetails.push("Missing .patchmark/review-queue-overrides.json.");
  }
  if (committedRewriteSessions && rewriteSessionsText === null) {
    currentDetails.push("Missing .patchmark/rewrite-sessions.json.");
  }
  const emptyReviewQueueOverridesText = currentManifest
    ? serializeReviewQueueOverrides({
        identity: getManifestDocumentIdentity(currentManifest),
        overrides: createEmptyReviewQueueOverrides(
          getManifestDocumentIdentity(currentManifest)
        )
      })
    : "{}\n";
  const emptyRewriteSessionsText = currentManifest
    ? serializeRewriteProjectSessionStore({
        identity: getManifestDocumentIdentity(currentManifest),
        sessions: []
      })
    : "{}\n";

  const currentTexts =
    commentsText !== null && patchesText !== null
      ? {
          document: markdown,
          comments: commentsText,
          patches: patchesText,
          review_batches: committedReviewBatches
            ? reviewBatchesText ?? "[]\n"
            : "[]\n",
          review_queue_overrides: committedReviewQueueOverrides
            ? reviewQueueOverridesText ?? emptyReviewQueueOverridesText
            : emptyReviewQueueOverridesText,
          rewrite_sessions: committedRewriteSessions
            ? rewriteSessionsText ?? emptyRewriteSessionsText
            : emptyRewriteSessionsText,
          manifest: manifestText
        }
      : null;

  if (!commitText && currentManifest && currentTexts) {
    validatePersistedJson(currentTexts, currentDetails);
    const persistence = await createLegacyPersistenceState({
      commentsText: currentTexts.comments,
      directoryHandle,
      documentText: markdown,
      manifestText,
      patchesText: currentTexts.patches,
      reviewQueueOverridesText: currentTexts.review_queue_overrides
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
    const validationStartedAt = performance.now();
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
    validateReviewBatchTextForIdentity({
      commit: currentCommit,
      details: currentDetails,
      identity: getManifestDocumentIdentity(currentManifest),
      text: currentTexts.review_batches
    });
    validateReviewQueueOverridesTextForIdentity({
      commit: currentCommit,
      details: currentDetails,
      identity: getManifestDocumentIdentity(currentManifest),
      text: currentTexts.review_queue_overrides
    });
    validateRewriteSessionTextForIdentity({
      commit: currentCommit,
      details: currentDetails,
      identity: getManifestDocumentIdentity(currentManifest),
      text: currentTexts.rewrite_sessions
    });
    recordDocumentSwitchPerformanceDuration(
      performanceOperationId,
      "validate_target_integrity",
      performance.now() - validationStartedAt
    );
    incrementDocumentSwitchPerformanceCounter(
      performanceOperationId,
      "content_hashes_computed",
      4 +
        (committedReviewBatches ? 1 : 0) +
        (committedReviewQueueOverrides ? 1 : 0) +
        (committedRewriteSessions ? 1 : 0)
    );
    markDocumentSwitchPerformance(
      performanceOperationId,
      "target_integrity_validated"
    );

    if (currentDetails.length === 0) {
      if (!readOnly) {
        await cleanupStaleProjectTemporaryFiles(directoryHandle);
      }
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
          reviewBatchesRaw: committedReviewBatches
            ? currentTexts.review_batches
            : undefined,
          reviewQueueOverridesRaw: committedReviewQueueOverrides
            ? currentTexts.review_queue_overrides
            : undefined,
          rewriteSessionsRaw: committedRewriteSessions
            ? currentTexts.rewrite_sessions
            : undefined,
          readSource: "current",
          debug: createEmptyPersistenceDebugState()
        }
      };
      return { markdown, project };
    }
  }

  const lkg = await readValidLastKnownGoodGeneration(
    directoryHandle,
    documentIdentity
  );

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
        reviewBatchesRaw: lkg.commit.files.review_batches
          ? lkg.texts.review_batches
          : undefined,
        reviewQueueOverridesRaw: lkg.commit.files.review_queue_overrides
          ? lkg.texts.review_queue_overrides
          : undefined,
        rewriteSessionsRaw: lkg.commit.files.rewrite_sessions
          ? lkg.texts.rewrite_sessions
          : undefined,
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
  const descriptors = await createProjectFileDescriptors(
    currentTexts,
    committedReviewBatches,
    committedReviewQueueOverrides,
    committedRewriteSessions
  );
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
      reviewBatchesRaw: committedReviewBatches
        ? reviewBatchesText ?? undefined
        : undefined,
      reviewQueueOverridesRaw: committedReviewQueueOverrides
        ? reviewQueueOverridesText ?? undefined
        : undefined,
      rewriteSessionsRaw: committedRewriteSessions
        ? rewriteSessionsText ?? undefined
        : undefined,
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
  patchesText,
  reviewQueueOverridesText
}: {
  commentsText?: string;
  directoryHandle: PatchmarkDirectoryHandle;
  documentText: string;
  manifestText: string;
  patchesText?: string;
  reviewQueueOverridesText?: string;
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
    review_batches: "[]\n",
    review_queue_overrides: reviewQueueOverridesText ?? "{}\n",
    rewrite_sessions: "{\"schema_version\":1,\"project_id\":\"\",\"document_id\":\"\",\"sessions\":[]}\n",
    manifest: manifestText
  };

  return {
    generation: 0,
    commit: null,
    files: await createProjectFileDescriptors(texts, false),
    documentText,
    manifestText,
    commentsRaw: resolvedCommentsText,
    patchesRaw: resolvedPatchesText,
    readSource: "current",
    debug: createEmptyPersistenceDebugState()
  };
}

async function readCurrentProjectTexts(
  directoryHandle: PatchmarkDirectoryHandle,
  includeReviewBatches: boolean,
  includeReviewQueueOverrides: boolean,
  emptyReviewQueueOverridesText: string,
  includeRewriteSessions: boolean,
  emptyRewriteSessionsText: string
): Promise<Record<ProjectCommitFileKey, string>> {
  const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
    metadataDirectoryName
  );
  const [
    document,
    comments,
    patches,
    manifest,
    reviewBatches,
    reviewQueueOverrides,
    rewriteSessions
  ] = await Promise.all([
    readTextFile(await directoryHandle.getFileHandle(documentFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(commentsFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(patchesFileName)),
    readTextFile(await metadataDirectoryHandle.getFileHandle(manifestFileName)),
    includeReviewBatches
      ? readTextFile(
          await metadataDirectoryHandle.getFileHandle(reviewBatchesFileName)
        )
      : Promise.resolve("[]\n"),
    includeReviewQueueOverrides
      ? readTextFile(
          await metadataDirectoryHandle.getFileHandle(
            reviewQueueOverridesFileName
          )
        )
      : Promise.resolve(emptyReviewQueueOverridesText),
    includeRewriteSessions
      ? readTextFile(
          await metadataDirectoryHandle.getFileHandle(rewriteSessionsFileName)
        )
      : Promise.resolve(emptyRewriteSessionsText)
  ]);
  return {
    document,
    comments,
    patches,
    review_batches: reviewBatches,
    review_queue_overrides: reviewQueueOverrides,
    rewrite_sessions: rewriteSessions,
    manifest
  };
}

async function readCurrentFileCommit(
  project: PatchmarkProjectHandle,
  key: ProjectCommitFileKey
): Promise<PatchmarkPersistedFileCommit> {
  const texts = await readCurrentProjectTexts(
    project.directoryHandle,
    Boolean(project.persistence.files.review_batches),
    Boolean(project.persistence.files.review_queue_overrides),
    serializeReviewQueueOverrides({
      identity: getProjectDocumentIdentity(project),
      overrides: createEmptyReviewQueueOverrides(
        getProjectDocumentIdentity(project)
      )
    }),
    Boolean(project.persistence.files.rewrite_sessions),
    serializeRewriteProjectSessionStore({
      identity: getProjectDocumentIdentity(project),
      sessions: []
    })
  );
  return createPersistedFileCommit(getProjectFilePath(key), texts[key]);
}

async function createProjectFileDescriptors(
  texts: Record<ProjectCommitFileKey, string>,
  includeReviewBatches: boolean,
  includeReviewQueueOverrides = false,
  includeRewriteSessions = false
): Promise<PatchmarkSaveCommit["files"]> {
  const [document, comments, patches, manifest] = await Promise.all(
    (["document", "comments", "patches", "manifest"] as const).map((key) =>
      createPersistedFileCommit(getProjectFilePath(key), texts[key])
    )
  );
  const reviewBatches = includeReviewBatches
    ? await createPersistedFileCommit(
        getProjectFilePath("review_batches"),
        texts.review_batches
      )
    : undefined;
  const reviewQueueOverrides = includeReviewQueueOverrides
    ? await createPersistedFileCommit(
        getProjectFilePath("review_queue_overrides"),
        texts.review_queue_overrides
      )
    : undefined;
  const rewriteSessions = includeRewriteSessions
    ? await createPersistedFileCommit(
        getProjectFilePath("rewrite_sessions"),
        texts.rewrite_sessions
      )
    : undefined;
  return {
    document,
    comments,
    patches,
    manifest,
    ...(reviewBatches ? { review_batches: reviewBatches } : {}),
    ...(reviewQueueOverrides
      ? { review_queue_overrides: reviewQueueOverrides }
      : {}),
    ...(rewriteSessions ? { rewrite_sessions: rewriteSessions } : {})
  };
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
  if (key === "review_batches") {
    return `${metadataDirectoryName}/${reviewBatchesFileName}`;
  }
  if (key === "review_queue_overrides") {
    return `${metadataDirectoryName}/${reviewQueueOverridesFileName}`;
  }
  if (key === "rewrite_sessions") {
    return `${metadataDirectoryName}/${rewriteSessionsFileName}`;
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
  if (key === "review_batches") {
    return reviewBatchesFileName;
  }
  if (key === "review_queue_overrides") {
    return reviewQueueOverridesFileName;
  }
  if (key === "rewrite_sessions") {
    return rewriteSessionsFileName;
  }
  return manifestFileName;
}

function getCommittedProjectFileKeys(
  commit: PatchmarkSaveCommit
): ProjectCommitFileKey[] {
  return [
    "document",
    "comments",
    "patches",
    ...(commit.files.review_batches
      ? (["review_batches"] as ProjectCommitFileKey[])
      : []),
    ...(commit.files.review_queue_overrides
      ? (["review_queue_overrides"] as ProjectCommitFileKey[])
      : []),
    ...(commit.files.rewrite_sessions
      ? (["rewrite_sessions"] as ProjectCommitFileKey[])
      : []),
    "manifest"
  ];
}

function getContextPackFileName(relativePath: string): string {
  const prefix = `${metadataDirectoryName}/context-packs/`;
  if (
    !relativePath.startsWith(prefix) ||
    relativePath.slice(prefix.length).length === 0 ||
    relativePath.slice(prefix.length).includes("/") ||
    relativePath.includes("..")
  ) {
    throw new Error("Invalid document-scoped context-pack path.");
  }
  return relativePath.slice(prefix.length);
}

async function removeReviewBatchFileIfPresent(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<void> {
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    if (!metadataDirectoryHandle.removeEntry) {
      return;
    }
    await metadataDirectoryHandle.removeEntry(reviewBatchesFileName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function removeReviewQueueOverridesFileIfPresent(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<void> {
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    if (!metadataDirectoryHandle.removeEntry) {
      return;
    }
    await metadataDirectoryHandle.removeEntry(reviewQueueOverridesFileName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function removeRewriteSessionsFileIfPresent(
  directoryHandle: PatchmarkDirectoryHandle
): Promise<void> {
  try {
    const metadataDirectoryHandle = await directoryHandle.getDirectoryHandle(
      metadataDirectoryName
    );
    if (!metadataDirectoryHandle.removeEntry) {
      return;
    }
    await metadataDirectoryHandle.removeEntry(rewriteSessionsFileName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
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
    descriptors.manifest.sha256,
    descriptors.review_batches?.sha256,
    descriptors.review_queue_overrides?.sha256,
    descriptors.rewrite_sessions?.sha256
  ]
    .filter((hash): hash is string => Boolean(hash))
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

  for (const key of getCommittedProjectFileKeys(commit)) {
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

async function rollbackAttemptedProjectInstalls({
  attemptedInstalls,
  currentCommit,
  currentTexts,
  includeCurrentReviewBatches,
  includeCurrentReviewQueueOverrides,
  includeCurrentRewriteSessions,
  onWrite
}: {
  attemptedInstalls: PreparedProjectFile[];
  currentCommit: PatchmarkSaveCommit;
  currentTexts: Record<ProjectCommitFileKey, string>;
  includeCurrentReviewBatches: boolean;
  includeCurrentReviewQueueOverrides: boolean;
  includeCurrentRewriteSessions: boolean;
  onWrite: (bytes: number) => void;
}): Promise<boolean> {
  let succeeded = true;
  const restoredTargets = new Set<string>();

  for (const prepared of [...attemptedInstalls].reverse()) {
    const targetKey = `${prepared.directoryHandle.name}/${prepared.targetFileName}`;
    if (restoredTargets.has(targetKey)) {
      continue;
    }
    restoredTargets.add(targetKey);
    try {
      const shouldRemove =
        (prepared.key === "review_batches" &&
          !includeCurrentReviewBatches) ||
        (prepared.key === "review_queue_overrides" &&
          !includeCurrentReviewQueueOverrides) ||
        (prepared.key === "rewrite_sessions" &&
          !includeCurrentRewriteSessions);
      if (shouldRemove) {
        await prepared.directoryHandle
          .removeEntry?.(prepared.targetFileName)
          .catch((error) => {
            if (!isNotFoundError(error)) {
              throw error;
            }
          });
        continue;
      }
      const text =
        prepared.key === "commit"
          ? serializeSaveCommit(currentCommit)
          : currentTexts[prepared.key];
      const targetFileHandle =
        await prepared.directoryHandle.getFileHandle(
          prepared.targetFileName,
          { create: true }
        );
      await writeTextFile(targetFileHandle, text);
      onWrite(new TextEncoder().encode(text).byteLength);
    } catch {
      succeeded = false;
    }
  }

  return succeeded;
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
  directoryHandle: PatchmarkDirectoryHandle,
  documentIdentity?: ProjectDocumentIdentity
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
      details,
      documentIdentity
    );
    if (!commit || !normalizedManifest) {
      return null;
    }
    const reviewBatches = commit.files.review_batches
      ? await readTextFile(
          await recoveryDirectoryHandle.getFileHandle(
            `${reviewBatchesFileName}.lkg`
          )
        )
      : "[]\n";
    const lkgIdentity = getManifestDocumentIdentity(normalizedManifest);
    const reviewQueueOverrides = commit.files.review_queue_overrides
      ? await readTextFile(
          await recoveryDirectoryHandle.getFileHandle(
            `${reviewQueueOverridesFileName}.lkg`
          )
        )
      : serializeReviewQueueOverrides({
          identity: lkgIdentity,
          overrides: createEmptyReviewQueueOverrides(lkgIdentity)
        });
    const rewriteSessions = commit.files.rewrite_sessions
      ? await readTextFile(
          await recoveryDirectoryHandle.getFileHandle(
            `${rewriteSessionsFileName}.lkg`
          )
        )
      : serializeRewriteProjectSessionStore({
          identity: lkgIdentity,
          sessions: []
        });
    const texts = {
      document,
      comments,
      patches,
      review_batches: reviewBatches,
      review_queue_overrides: reviewQueueOverrides,
      rewrite_sessions: rewriteSessions,
      manifest
    };

    await validateCommittedProjectTexts(texts, commit, details);
    validateManifestCommitIdentity(normalizedManifest, commit, details);
    validateReviewBatchTextForIdentity({
      commit,
      details,
      identity: getManifestDocumentIdentity(normalizedManifest),
      text: texts.review_batches
    });
    validateReviewQueueOverridesTextForIdentity({
      commit,
      details,
      identity: lkgIdentity,
      text: texts.review_queue_overrides
    });
    validateRewriteSessionTextForIdentity({
      commit,
      details,
      identity: lkgIdentity,
      text: texts.rewrite_sessions
    });
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

function validateReviewBatchTextForIdentity({
  commit,
  details,
  identity,
  text
}: {
  commit: PatchmarkSaveCommit;
  details: string[];
  identity: ProjectDocumentIdentity;
  text: string;
}): void {
  if (!commit.files.review_batches) {
    return;
  }
  try {
    parseReviewBatchRecords({ identity, text });
  } catch (error) {
    details.push(
      error instanceof Error
        ? error.message
        : ".patchmark/review-batches.json is invalid."
    );
  }
}

function validateReviewQueueOverridesTextForIdentity({
  commit,
  details,
  identity,
  text
}: {
  commit: PatchmarkSaveCommit;
  details: string[];
  identity: ProjectDocumentIdentity;
  text: string;
}): void {
  if (!commit.files.review_queue_overrides) {
    return;
  }
  try {
    parseReviewQueueOverrides({ identity, text });
  } catch (error) {
    details.push(
      error instanceof Error
        ? error.message
        : ".patchmark/review-queue-overrides.json is invalid."
    );
  }
}

function validateRewriteSessionTextForIdentity({
  commit,
  details,
  identity,
  text
}: {
  commit: PatchmarkSaveCommit;
  details: string[];
  identity: ProjectDocumentIdentity;
  text: string;
}): void {
  if (!commit.files.rewrite_sessions) {
    return;
  }
  try {
    parseRewriteProjectSessionStore({ identity, text });
  } catch (error) {
    details.push(
      error instanceof Error
        ? error.message
        : ".patchmark/rewrite-sessions.json is invalid."
    );
  }
}

function getManifestDocumentIdentity(
  manifest: PatchmarkManifest
): ProjectDocumentIdentity {
  if (!manifest.project_id || !manifest.document_id) {
    throw new Error("Patchmark document identity is incomplete.");
  }
  return createProjectDocumentIdentity(
    manifest.project_id,
    manifest.document_id
  );
}

async function validateCommittedProjectTexts(
  texts: Record<ProjectCommitFileKey, string>,
  commit: PatchmarkSaveCommit,
  details: string[]
): Promise<void> {
  validatePersistedJson(texts, details);
  const descriptors = await createProjectFileDescriptors(
    texts,
    Boolean(commit.files.review_batches),
    Boolean(commit.files.review_queue_overrides),
    Boolean(commit.files.rewrite_sessions)
  );

  for (const key of getCommittedProjectFileKeys(commit)) {
    const expected = commit.files[key];
    const actual = descriptors[key];
    if (!expected || !actual) {
      details.push(`${getProjectFilePath(key)} is missing from save metadata.`);
      continue;
    }
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
  for (const key of ["comments", "patches", "review_batches"] as const) {
    try {
      if (!Array.isArray(JSON.parse(texts[key]))) {
        details.push(`${getProjectFilePath(key)} must contain a JSON array.`);
      }
    } catch {
      details.push(`${getProjectFilePath(key)} contains malformed JSON.`);
    }
  }

  try {
    const value = JSON.parse(texts.rewrite_sessions);
    if (!isRecord(value)) {
      details.push(`${getProjectFilePath("rewrite_sessions")} must contain a JSON object.`);
    }
  } catch {
    details.push(`${getProjectFilePath("rewrite_sessions")} contains malformed JSON.`);
  }

  try {
    const value = JSON.parse(texts.review_queue_overrides);
    if (!isRecord(value)) {
      details.push(
        `${getProjectFilePath("review_queue_overrides")} must contain a JSON object.`
      );
    }
  } catch {
    details.push(
      `${getProjectFilePath("review_queue_overrides")} contains malformed JSON.`
    );
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
  details: string[],
  documentIdentity?: ProjectDocumentIdentity
): PatchmarkManifest | null {
  try {
    return normalizeManifest(
      JSON.parse(text),
      fallbackProjectName,
      documentIdentity
    );
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
  return (
    (["document", "comments", "patches", "manifest"] as const).every(
      (key) => isPersistedFileCommit(files[key], getProjectFilePath(key))
    ) &&
    (files.review_batches === undefined ||
      isPersistedFileCommit(
        files.review_batches,
        getProjectFilePath("review_batches")
      )) &&
    (files.review_queue_overrides === undefined ||
      isPersistedFileCommit(
        files.review_queue_overrides,
        getProjectFilePath("review_queue_overrides")
      )) &&
    (files.rewrite_sessions === undefined ||
      isPersistedFileCommit(
        files.rewrite_sessions,
        getProjectFilePath("rewrite_sessions")
      ))
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
      reviewBatchesFileName,
      reviewQueueOverridesFileName,
      rewriteSessionsFileName,
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
  fallbackProjectName: string,
  documentIdentity?: ProjectDocumentIdentity
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
  const projectName =
    typeof manifest.project_name === "string"
      ? manifest.project_name
      : createProjectName(fallbackProjectName, fallbackProjectName);
  const createdAt =
    typeof manifest.created_at === "string" ? manifest.created_at : now;
  const projectId =
    documentIdentity?.projectId ??
    (typeof manifest.project_id === "string" && manifest.project_id.trim()
      ? manifest.project_id
      : createLegacyProjectId({
          created_at: createdAt,
          document_file: documentFileName,
          project_name: projectName
        }));
  const documentId =
    documentIdentity?.documentId ??
    (typeof manifest.document_id === "string" && manifest.document_id.trim()
      ? manifest.document_id
      : legacyDocumentScopeId);
  const identity = createProjectDocumentIdentity(projectId, documentId);
  return {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: projectName,
    document_file: documentFileName,
    created_at: createdAt,
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
      : undefined,
    reading_bookmark: normalizeReadingBookmark(manifest, identity),
    comment_deletion_tombstones: normalizeCommentDeletionTombstones({
      documentId,
      projectId,
      value: manifest.comment_deletion_tombstones
    })
  };
}

function normalizeReadingBookmark(
  manifest: Record<string, unknown>,
  identity: ProjectDocumentIdentity
): PatchmarkReadingBookmark | undefined {
  const candidates = [
    manifest.reading_bookmark,
    ...(isRecord(manifest.reading_bookmarks)
      ? Object.values(manifest.reading_bookmarks)
      : [])
  ];

  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      candidate.format_version !== 1 ||
      !isRecord(candidate.document) ||
      !isPatchmarkCommentAnchor(candidate.anchor) ||
      candidate.anchor.kind === "document" ||
      typeof candidate.created_at !== "string" ||
      typeof candidate.updated_at !== "string" ||
      !hasPersistedBookmarkDocumentIdentity(candidate.document)
    ) {
      continue;
    }

    return {
      format_version: 1,
      document: serializeProjectDocumentIdentity(identity),
      anchor: normalizeKnownCommentAnchor(candidate.anchor, "note") as
        PatchmarkReadingBookmark["anchor"],
      created_at: candidate.created_at,
      updated_at: candidate.updated_at
    };
  }

  return undefined;
}

function hasPersistedBookmarkDocumentIdentity(
  value: Record<string, unknown>
): boolean {
  return (
    (typeof value.project_id === "string" &&
      typeof value.document_id === "string") ||
    (typeof value.project_id === "string" &&
      typeof value.document_file === "string")
  );
}

function createLegacyProjectId(
  manifest: Pick<
    PatchmarkManifest,
    "created_at" | "document_file" | "project_name"
  >
): string {
  const value = [
    manifest.created_at,
    manifest.project_name,
    manifest.document_file
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `prj_legacy_${hash.toString(16).padStart(8, "0")}`;
}

function isPatchmarkVersionEntry(value: unknown): value is PatchmarkVersionEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.file === "string" &&
    typeof value.created_at === "string" &&
    typeof value.reason === "string" &&
    (value.content_hash === undefined || typeof value.content_hash === "string") &&
    (value.mutation === undefined || isPatchmarkVersionMutationAudit(value.mutation))
  );
}

function isPatchmarkVersionMutationAudit(
  value: unknown
): value is PatchmarkVersionMutationAudit {
  return Boolean(
    isRecord(value) &&
      value.author_type === "human" &&
      value.mutation_type === "human_rewrite" &&
      typeof value.rewrite_session_id === "string" &&
      (value.target_kind === "selection" || value.target_kind === "section") &&
      (value.heading_snapshot === null || typeof value.heading_snapshot === "string") &&
      typeof value.base_text_sha256 === "string" &&
      typeof value.applied_text_sha256 === "string" &&
      (value.semantic_review_status === "reviewed" ||
        value.semantic_review_status === "not_reviewed")
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
        : undefined,
    ...normalizeCommentTrashMetadata(comment)
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
    source_patch_key:
      typeof patch.source_patch_key === "string"
        ? patch.source_patch_key
        : undefined,
    depends_on_patch_ids: normalizePatchDependencyIds(
      patch.depends_on_patch_ids,
      "depends_on_patch_ids"
    ),
    depends_on_patch_keys_snapshot: normalizePatchDependencyIds(
      patch.depends_on_patch_keys_snapshot,
      "depends_on_patch_keys_snapshot"
    ),
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
    target_provenance: normalizePatchTargetProvenance(
      patch.target_provenance
    ),
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
        : undefined,
    human_rewrite_impact: normalizeHumanRewritePatchImpact(
      patch.human_rewrite_impact
    )
  };
}

function normalizePatchTargetProvenance(
  value: unknown
): PatchmarkPatch["target_provenance"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    typeof value.document_id !== "string" ||
    value.document_id.length === 0 ||
    typeof value.patch_key !== "string" ||
    value.patch_key.length === 0 ||
    typeof value.base_document_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.base_document_sha256) ||
    typeof value.base_start !== "number" ||
    !Number.isInteger(value.base_start) ||
    value.base_start < 0 ||
    typeof value.base_end !== "number" ||
    !Number.isInteger(value.base_end) ||
    value.base_end < value.base_start ||
    typeof value.current_start !== "number" ||
    !Number.isInteger(value.current_start) ||
    value.current_start < 0 ||
    typeof value.current_end !== "number" ||
    !Number.isInteger(value.current_end) ||
    value.current_end < value.current_start ||
    typeof value.original_text_fingerprint !== "string" ||
    !/^fnv1a32:[a-f0-9]{8}$/.test(value.original_text_fingerprint) ||
    !Array.isArray(value.heading_ancestry) ||
    !value.heading_ancestry.every(
      (heading) => typeof heading === "string" && heading.length > 0
    ) ||
    value.base_occurrence_count !== 1 ||
    ![
      "exact_full_text",
      "heading_scoped_full_text",
      "normalized_full_text"
    ].includes(String(value.resolution_method)) ||
    !["mapped", "requires_revalidation"].includes(
      String(value.mapping_state)
    )
  ) {
    throw new Error(
      ".patchmark/patches.json contains invalid patch target provenance."
    );
  }

  return {
    schema_version: 1,
    document_id: value.document_id,
    patch_key: value.patch_key,
    base_document_sha256: value.base_document_sha256,
    base_start: value.base_start,
    base_end: value.base_end,
    current_start: value.current_start,
    current_end: value.current_end,
    original_text_fingerprint: value.original_text_fingerprint,
    target_heading:
      typeof value.target_heading === "string"
        ? value.target_heading
        : undefined,
    heading_ancestry: value.heading_ancestry,
    base_occurrence_count: 1,
    resolution_method: value.resolution_method as NonNullable<
      PatchmarkPatch["target_provenance"]
    >["resolution_method"],
    mapping_state: value.mapping_state as NonNullable<
      PatchmarkPatch["target_provenance"]
    >["mapping_state"]
  };
}

function normalizeHumanRewritePatchImpact(
  value: unknown
): PatchmarkPatch["human_rewrite_impact"] {
  if (
    !isRecord(value) ||
    typeof value.rewrite_session_id !== "string" ||
    typeof value.applied_at !== "string" ||
    (value.target_kind !== "selection" && value.target_kind !== "section") ||
    (value.heading_snapshot !== null &&
      typeof value.heading_snapshot !== "string") ||
    value.reason !== "overlapping_human_rewrite"
  ) {
    return undefined;
  }
  return {
    rewrite_session_id: value.rewrite_session_id,
    applied_at: value.applied_at,
    target_kind: value.target_kind,
    heading_snapshot: value.heading_snapshot,
    reason: value.reason
  };
}

function normalizePatchDependencyIds(
  value: unknown,
  fieldName: "depends_on_patch_ids" | "depends_on_patch_keys_snapshot"
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== "string" || item.trim().length === 0
    )
  ) {
    throw new Error(
      `.patchmark/patches.json contains invalid ${fieldName} metadata.`
    );
  }

  return [...value];
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

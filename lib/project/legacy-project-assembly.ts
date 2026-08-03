import {
  listProjectVersions,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  readProjectVersionMarkdown,
  type LoadedPatchmarkProject,
  type PatchmarkDirectoryHandle
} from "./patchmark-project.ts";
import {
  createDocumentId,
  createProjectId,
  deriveDocumentDisplayTitle,
  inspectLegacyProjectImportSource,
  parseProjectManifest,
  readProjectManifest,
  validateRegisteredDocumentPath,
  writeProjectManifestAtomic,
  type PatchmarkDocumentRole,
  type PatchmarkProjectManifestV1,
  type PatchmarkRegisteredDocument,
  type ProjectDirectoryHandle,
  type ProjectFileHandle
} from "./multi-document-project.ts";
import {
  type PatchmarkComment,
  type PatchmarkPatch,
  type PatchmarkVersionEntry
} from "./project-types.ts";

const metadataDirectoryName = ".patchmark";
const documentFileName = "document.md";
const reservedProjectMetadataEntries = new Set([
  "project.json",
  "documents",
  "migrations",
  "transactions"
]);
const ownershipFileName = "document.json";
const provenanceFileName = "import-provenance.json";
const allowedRoles: PatchmarkDocumentRole[] = [
  "decision",
  "research",
  "evidence",
  "summary",
  null
];
const identifierNamespaces = [
  "comment",
  "reply",
  "patch",
  "version",
  "anchor_history",
  "patch_group",
  "source_import"
] as const;

export type LegacyIdentifierNamespace = (typeof identifierNamespaces)[number];

export type LegacyProjectIdentifierInventory = Record<
  LegacyIdentifierNamespace,
  readonly string[]
>;

export type LegacyProjectSourceSummary = {
  sourceLabel: string;
  sourceProjectName: string;
  documentFile: "document.md";
  suggestedDisplayTitle: string;
  sourceFingerprintSha256: string;
  markdownSha256: string;
  markdownBytes: number;
  importedFileCount: number;
  importedBytes: number;
  comments: number;
  replies: number;
  patches: number;
  pendingPatches: number;
  decidedPatches: number;
  versions: number;
  saveGeneration: number;
  warnings: readonly string[];
};

type LegacyProjectTreeSnapshot = {
  directories: readonly string[];
  files: ReadonlyMap<string, Uint8Array>;
  fingerprintSha256: string;
};

export type LegacyProjectAssemblySource = {
  sourceId: string;
  directoryHandle: ProjectDirectoryHandle;
  summary: LegacyProjectSourceSummary;
  identifiers: LegacyProjectIdentifierInventory;
  comments: readonly PatchmarkComment[];
  patches: readonly PatchmarkPatch[];
  versions: readonly PatchmarkVersionEntry[];
  versionMarkdown: ReadonlyMap<string, string>;
  metadataDirectories: readonly string[];
  metadataFiles: ReadonlyMap<string, Uint8Array>;
  markdownBytes: Uint8Array;
  treeSnapshot: LegacyProjectTreeSnapshot;
};

export type LegacyProjectAssemblyDocumentRequest = {
  source: LegacyProjectAssemblySource;
  destinationPath: string;
  displayTitle: string;
  role: PatchmarkDocumentRole;
};

export type LegacyProjectAssemblyPlanEntry = {
  source: LegacyProjectAssemblySource;
  document: PatchmarkRegisteredDocument;
};

export type LegacyProjectAssemblyPlan = {
  assemblyId: string;
  createdAt: string;
  destination: ProjectDirectoryHandle;
  manifest: PatchmarkProjectManifestV1;
  entries: readonly LegacyProjectAssemblyPlanEntry[];
};

export type LegacyProjectIdentityCollision = {
  classification:
    | "unsafe_same_document_collision"
    | "project_scoped_identifier_collision";
  namespace: LegacyIdentifierNamespace;
  id: string;
  sourceLabels: readonly string[];
};

export type LegacyProjectDocumentLocalDuplicate = {
  classification: "allowed_document_local_duplicate";
  namespace: LegacyIdentifierNamespace;
  id: string;
  sourceLabels: readonly string[];
};

export type LegacyProjectIdentityAnalysis = {
  allowedDocumentLocalDuplicates: readonly LegacyProjectDocumentLocalDuplicate[];
  unsafeCollisions: readonly LegacyProjectIdentityCollision[];
};

export type LegacyProjectAssemblyStage =
  | "preflight"
  | "staging"
  | "before_source_copy"
  | "source_copied"
  | "verified"
  | "manifest_committed"
  | "reopened"
  | "sources_verified"
  | "complete";

export type LegacyProjectAssemblyStageContext = {
  assemblyId: string;
  stage: LegacyProjectAssemblyStage;
  sourceLabel?: string;
  documentId?: string;
};

export type LegacyProjectAssemblyResult = {
  assemblyId: string;
  loaded: LoadedPatchmarkProject;
  manifest: PatchmarkProjectManifestV1;
};

export type IncompleteLegacyProjectAssembly = {
  assemblyId: string;
  destinationTitle: string;
  stage: string;
  updatedAt: string;
  canCleanSafely: boolean;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<ProjectDirectoryHandle>;
};

export async function pickLegacyProjectAssemblySource(): Promise<
  LegacyProjectAssemblySource | null
> {
  const handle = await pickDirectory("read");
  return handle ? inspectLegacyProjectAssemblySource(handle) : null;
}

export async function pickLegacyProjectAssemblyDestination(): Promise<
  ProjectDirectoryHandle | null
> {
  return pickDirectory("readwrite");
}

export async function inspectIncompleteLegacyProjectAssembly(
  destination: ProjectDirectoryHandle
): Promise<IncompleteLegacyProjectAssembly | null> {
  if (await readProjectManifest(destination)) {
    return null;
  }
  try {
    const metadata = await destination.getDirectoryHandle(metadataDirectoryName);
    const transactions = await metadata.getDirectoryHandle("transactions");
    if (!transactions.entries) {
      return null;
    }
    const candidates: Array<
      IncompleteLegacyProjectAssembly & { destinationPaths: string[]; documentIds: string[] }
    > = [];
    for await (const [assemblyId, entry] of transactions.entries()) {
      if (entry.kind !== "directory") {
        continue;
      }
      const directory = await transactions.getDirectoryHandle(assemblyId);
      let journal: unknown;
      try {
        journal = parseJson(
          decodeText(
            await readFileBytes(await directory.getFileHandle("assembly.json"))
          ),
          "assembly.json"
        );
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      if (
        !isRecord(journal) ||
        journal.format !== "patchmark-legacy-assembly-transaction" ||
        !Array.isArray(journal.documents) ||
        ["complete", "aborted", "invalid_destination"].includes(
          String(journal.stage)
        )
      ) {
        continue;
      }
      const destinationPaths: string[] = [];
      const documentIds: string[] = [];
      for (const document of journal.documents) {
        if (
          !isRecord(document) ||
          typeof document.destination_path !== "string" ||
          typeof document.destination_document_id !== "string"
        ) {
          throw new Error("Incomplete assembly journal has invalid document entries.");
        }
        destinationPaths.push(
          validateRegisteredDocumentPath(document.destination_path)
        );
        documentIds.push(document.destination_document_id);
      }
      candidates.push({
        assemblyId,
        destinationTitle:
          typeof journal.destination_title === "string"
            ? journal.destination_title
            : "Untitled project",
        stage: String(journal.stage ?? "staging"),
        updatedAt:
          typeof journal.updated_at === "string" ? journal.updated_at : "",
        canCleanSafely: false,
        destinationPaths,
        documentIds
      });
    }
    candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const candidate = candidates[0];
    if (!candidate) {
      return null;
    }
    candidate.canCleanSafely = await hasOnlyAssemblyGeneratedEntries(
      destination,
      candidate.assemblyId,
      candidate.destinationPaths,
      candidate.documentIds
    );
    return {
      assemblyId: candidate.assemblyId,
      destinationTitle: candidate.destinationTitle,
      stage: candidate.stage,
      updatedAt: candidate.updatedAt,
      canCleanSafely: candidate.canCleanSafely
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function cleanupIncompleteLegacyProjectAssembly(
  destination: ProjectDirectoryHandle
): Promise<void> {
  const incomplete = await inspectIncompleteLegacyProjectAssembly(destination);
  if (!incomplete) {
    throw new Error("No incomplete Patchmark assembly was found in this folder.");
  }
  if (!incomplete.canCleanSafely) {
    throw new Error(
      "Patchmark cannot clean this incomplete destination because it contains unexpected files."
    );
  }
  await cleanupIncompleteDestination(destination);
}

export async function inspectLegacyProjectAssemblySource(
  directoryHandle: ProjectDirectoryHandle,
  sourceLabel = directoryHandle.name
): Promise<LegacyProjectAssemblySource> {
  const firstTree = await collectProjectTree(directoryHandle);
  let loaded: LoadedPatchmarkProject;
  try {
    loaded = await openProjectFolderHandle(
      directoryHandle as PatchmarkDirectoryHandle,
      { readOnly: true }
    );
  } catch (error) {
    throw new Error(
      `${sourceLabel} could not be imported because its Patchmark state is invalid: ${getErrorMessage(
        error
      )}`
    );
  }
  if (loaded.project.projectMode !== "legacy" || loaded.project.projectManifest) {
    throw new Error(`${sourceLabel} is not a supported legacy Patchmark project.`);
  }
  const importsLastKnownGood =
    loaded.project.persistence.readSource === "lkg" &&
    loaded.recovery?.canRestore === true;
  if (
    loaded.project.persistence.readSource !== "current" &&
    !importsLastKnownGood
  ) {
    throw new Error(
      `${sourceLabel} could not be imported because its latest Patchmark generation is invalid: ${
        loaded.recovery?.technicalDetails.join(" ") ?? "authoritative state unavailable"
      }`
    );
  }
  const imported = await inspectLegacyProjectImportSource(directoryHandle, {
    allowInvalidCurrentState: importsLastKnownGood
  });

  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  const versions = await listProjectVersions(loaded.project);
  const versionMarkdown = new Map<string, string>();
  for (const version of versions) {
    assertPortableVersionPath(version, sourceLabel);
    const markdown = await readProjectVersionMarkdown(loaded.project, version);
    if (
      version.content_hash &&
      version.content_hash !== (await createSha256(encodeText(markdown)))
    ) {
      throw new Error(
        `${sourceLabel} has a Version History hash mismatch for ${version.id}.`
      );
    }
    versionMarkdown.set(version.id, markdown);
  }

  const relationshipWarnings = validateLegacyRelationships({
    comments,
    currentVersion: loaded.project.manifest.current_version,
    patches,
    sourceLabel,
    versions
  });
  const identifiers = createIdentifierInventory(comments, patches, versions);
  const secondTree = await collectProjectTree(directoryHandle);
  assertMatchingFingerprint(firstTree, secondTree, sourceLabel);

  const currentMarkdownBytes = requireSnapshotFile(
    firstTree,
    documentFileName,
    sourceLabel
  );
  const markdownBytes = importsLastKnownGood
    ? requireSnapshotFile(
        firstTree,
        `${metadataDirectoryName}/recovery/document.md.lkg`,
        sourceLabel
      )
    : currentMarkdownBytes;
  if (
    decodeText(markdownBytes) !==
    (importsLastKnownGood ? loaded.markdown : imported.markdown)
  ) {
    throw new Error(`${sourceLabel} changed while its Markdown was being read.`);
  }
  const authoritativeMetadataText = new Map(imported.metadataFiles);
  if (importsLastKnownGood) {
    for (const fileName of [
      "manifest.json",
      "comments.json",
      "patches.json",
      "save-commit.json"
    ]) {
      const current = firstTree.files.get(`${metadataDirectoryName}/${fileName}`);
      if (current) {
        authoritativeMetadataText.set(
          `recovery/imported-questionable-current/${fileName}`,
          decodeText(current)
        );
      }
      authoritativeMetadataText.set(
        fileName,
        decodeText(
          requireSnapshotFile(
            firstTree,
            `${metadataDirectoryName}/recovery/${fileName}.lkg`,
            sourceLabel
          )
        )
      );
    }
    for (const fileName of ["rewrite-sessions.json"]) {
      const recovery = firstTree.files.get(
        `${metadataDirectoryName}/recovery/${fileName}.lkg`
      );
      if (!recovery) {
        continue;
      }
      const current = firstTree.files.get(`${metadataDirectoryName}/${fileName}`);
      if (current) {
        authoritativeMetadataText.set(
          `recovery/imported-questionable-current/${fileName}`,
          decodeText(current)
        );
      }
      authoritativeMetadataText.set(fileName, decodeText(recovery));
    }
    authoritativeMetadataText.set(
      "recovery/imported-questionable-current/document.md",
      decodeText(currentMarkdownBytes)
    );
  }
  const metadataFiles = new Map<string, Uint8Array>();
  for (const [relativePath, text] of authoritativeMetadataText) {
    const sourceBytes = firstTree.files.get(
      `${metadataDirectoryName}/${relativePath}`
    );
    const bytes = sourceBytes && decodeText(sourceBytes) === text
      ? sourceBytes
      : encodeText(text);
    metadataFiles.set(relativePath, bytes);
  }
  const metadataDirectories = [
    ...firstTree.directories
    .filter((path) => path.startsWith(`${metadataDirectoryName}/`))
    .map((path) => path.slice(metadataDirectoryName.length + 1))
    .filter((path) => {
      const rootName = path.split("/")[0];
      return rootName && !reservedProjectMetadataEntries.has(rootName);
    }),
    ...(importsLastKnownGood
      ? ["recovery/imported-questionable-current"]
      : [])
  ];
  const importedBytes =
    markdownBytes.byteLength +
    [...metadataFiles.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  const replies = comments.reduce(
    (total, comment) => total + comment.thread.length,
    0
  );
  const warnings = [
    ...(importsLastKnownGood
      ? [
          "Imported the verified last-known-good generation; questionable current files were preserved under recovery/imported-questionable-current."
        ]
      : []),
    ...relationshipWarnings,
    ...collectUnknownFieldWarnings(authoritativeMetadataText)
  ];
  const summary: LegacyProjectSourceSummary = Object.freeze({
    sourceLabel: validateSourceLabel(sourceLabel),
    sourceProjectName: loaded.project.manifest.project_name,
    documentFile: "document.md",
    suggestedDisplayTitle: deriveDocumentDisplayTitle(
      loaded.markdown,
      documentFileName
    ),
    sourceFingerprintSha256: firstTree.fingerprintSha256,
    markdownSha256: await createSha256(markdownBytes),
    markdownBytes: markdownBytes.byteLength,
    importedFileCount: metadataFiles.size + 1,
    importedBytes,
    comments: comments.length,
    replies,
    patches: patches.length,
    pendingPatches: patches.filter((patch) => patch.status === "pending").length,
    decidedPatches: patches.filter((patch) => patch.status !== "pending").length,
    versions: versions.length,
    saveGeneration: loaded.project.persistence.generation,
    warnings: Object.freeze(warnings)
  });

  return Object.freeze({
    sourceId: createStableId("legacy-source"),
    directoryHandle,
    summary,
    identifiers,
    comments: Object.freeze(comments),
    patches: Object.freeze(patches),
    versions: Object.freeze(versions),
    versionMarkdown,
    metadataDirectories: Object.freeze([...metadataDirectories].sort()),
    metadataFiles,
    markdownBytes,
    treeSnapshot: firstTree
  });
}

export function findLegacyProjectIdentityCollisions(
  sources: readonly LegacyProjectAssemblySource[]
): LegacyProjectIdentityCollision[] {
  return [...analyzeLegacyProjectIdentityCompatibility(sources).unsafeCollisions];
}

export function analyzeLegacyProjectIdentityCompatibility(
  sources: readonly LegacyProjectAssemblySource[]
): LegacyProjectIdentityAnalysis {
  const duplicates: LegacyProjectDocumentLocalDuplicate[] = [];
  for (const namespace of identifierNamespaces) {
    const owners = new Map<string, Set<string>>();
    for (const source of sources) {
      for (const id of source.identifiers[namespace]) {
        const labels = owners.get(id) ?? new Set<string>();
        labels.add(source.summary.sourceLabel);
        owners.set(id, labels);
      }
    }
    for (const [id, labels] of owners) {
      if (labels.size > 1) {
        duplicates.push({
          classification: "allowed_document_local_duplicate",
          namespace,
          id,
          sourceLabels: Object.freeze([...labels].sort())
        });
      }
    }
  }
  duplicates.sort(
    (left, right) =>
      identifierNamespaces.indexOf(left.namespace) -
        identifierNamespaces.indexOf(right.namespace) ||
      left.id.localeCompare(right.id)
  );
  return Object.freeze({
    allowedDocumentLocalDuplicates: Object.freeze(duplicates),
    unsafeCollisions: Object.freeze([])
  });
}

export async function createLegacyProjectAssemblyPlan({
  destination,
  documents,
  projectTitle
}: {
  destination: ProjectDirectoryHandle;
  documents: readonly LegacyProjectAssemblyDocumentRequest[];
  projectTitle: string;
}): Promise<LegacyProjectAssemblyPlan> {
  if (documents.length < 2) {
    throw new Error("Select at least two legacy Patchmark projects.");
  }
  const title = validateDisplayTitle(projectTitle, "Project title");
  const sources = documents.map((document) => document.source);
  await assertDistinctNonOverlappingDirectories(sources, destination);
  await assertDirectoryEmpty(destination);
  assertNoUnsafeIdentityCollisions(sources);

  const createdAt = new Date().toISOString();
  const registeredDocuments = documents.map((request, index) => ({
    document_id: createDocumentId(),
    path: validateRegisteredDocumentPath(request.destinationPath),
    display_title: validateDisplayTitle(request.displayTitle, "Document title"),
    role: validateRole(request.role),
    status: "active" as const,
    position: (index + 1) * 1000,
    added_at: createdAt,
    archived_at: null
  }));
  const manifest = parseProjectManifest({
    format: "patchmark-project",
    schema_version: 1,
    project_id: createProjectId(),
    title,
    created_at: createdAt,
    manifest_revision: 1,
    documents: registeredDocuments
  });
  const entries = documents.map((request, index) =>
    Object.freeze({ source: request.source, document: manifest.documents[index] })
  );

  return Object.freeze({
    assemblyId: createStableId("assembly"),
    createdAt,
    destination,
    manifest: freezeProjectManifest(manifest),
    entries: Object.freeze(entries)
  });
}

export async function executeLegacyProjectAssembly(
  plan: LegacyProjectAssemblyPlan,
  options: {
    onStage?: (
      context: LegacyProjectAssemblyStageContext
    ) => Promise<void> | void;
  } = {}
): Promise<LegacyProjectAssemblyResult> {
  const manifest = parseProjectManifest(plan.manifest);
  const sources = plan.entries.map((entry) => entry.source);
  let destinationTouched = false;
  let journalDirectory: ProjectDirectoryHandle | null = null;
  let loaded: LoadedPatchmarkProject | null = null;
  const emitStage = async (
    stage: LegacyProjectAssemblyStage,
    entry?: LegacyProjectAssemblyPlanEntry
  ) => {
    await options.onStage?.({
      assemblyId: plan.assemblyId,
      stage,
      ...(entry
        ? {
            sourceLabel: entry.source.summary.sourceLabel,
            documentId: entry.document.document_id
          }
        : {})
    });
  };

  try {
    await assertDistinctNonOverlappingDirectories(sources, plan.destination);
    await assertDirectoryEmpty(plan.destination);
    assertNoUnsafeIdentityCollisions(sources);
    for (const source of sources) {
      await assertSourceUnchanged(source);
    }
    await emitStage("preflight");

    const metadata = await plan.destination.getDirectoryHandle(
      metadataDirectoryName,
      { create: true }
    );
    destinationTouched = true;
    const transactions = await metadata.getDirectoryHandle("transactions", {
      create: true
    });
    journalDirectory = await transactions.getDirectoryHandle(plan.assemblyId, {
      create: true
    });
    await writeAssemblyJournal(journalDirectory, plan, "staging");
    await emitStage("staging");

    const documentsDirectory = await metadata.getDirectoryHandle("documents", {
      create: true
    });
    for (const entry of plan.entries) {
      await emitStage("before_source_copy", entry);
      await assertSourceUnchanged(entry.source);
      await copyImportedDocument(plan, entry, documentsDirectory);
      await writeAssemblyJournal(
        journalDirectory,
        plan,
        "source_copied",
        entry.source.summary.sourceLabel
      );
      await emitStage("source_copied", entry);
    }

    await verifyStagedAssembly(plan);
    for (const source of sources) {
      await assertSourceUnchanged(source);
    }
    await writeAssemblyJournal(journalDirectory, plan, "verified");
    await emitStage("verified");

    if (await readProjectManifest(plan.destination)) {
      throw new Error("Destination project manifest appeared before commit.");
    }
    await writeProjectManifestAtomic(plan.destination, manifest);
    await writeAssemblyJournal(journalDirectory, plan, "manifest_committed");
    await emitStage("manifest_committed");

    loaded = await openProjectFolderHandle(
      plan.destination as PatchmarkDirectoryHandle,
      { deferAssemblyRecovery: true }
    );
    await verifyReopenedAssembly(plan, loaded);
    await writeAssemblyJournal(journalDirectory, plan, "reopened");
    await emitStage("reopened");

    for (const source of sources) {
      await assertSourceUnchanged(source);
    }
    await writeAssemblyJournal(journalDirectory, plan, "sources_verified");
    await emitStage("sources_verified");
    await writeAssemblyJournal(journalDirectory, plan, "complete");
    await removeAssemblyJournal(plan.destination, plan.assemblyId);
    journalDirectory = null;
    await emitStage("complete");

    return {
      assemblyId: plan.assemblyId,
      loaded,
      manifest
    };
  } catch (error) {
    if (journalDirectory) {
      try {
        await writeAssemblyJournal(journalDirectory, plan, "aborted", undefined, error);
      } catch {
        // Destination cleanup below is authoritative.
      }
    }
    if (destinationTouched) {
      try {
        await cleanupIncompleteDestination(plan.destination);
      } catch (cleanupError) {
        throw new Error(
          `${getErrorMessage(error)} Destination cleanup also failed: ${getErrorMessage(
            cleanupError
          )}`
        );
      }
    }
    throw error;
  }
}

export function createSuggestedLegacyDocumentPath(
  source: LegacyProjectAssemblySource,
  usedPaths: readonly string[] = []
): string {
  const base =
    source.summary.suggestedDisplayTitle
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document";
  const used = new Set(usedPaths.map((path) => path.toLocaleLowerCase()));
  let candidate = `${base}.md`;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = `${base}-${suffix}.md`;
    suffix += 1;
  }
  return candidate;
}

async function copyImportedDocument(
  plan: LegacyProjectAssemblyPlan,
  entry: LegacyProjectAssemblyPlanEntry,
  documentsDirectory: ProjectDirectoryHandle
): Promise<void> {
  const destinationFile = await getFileHandleAtPath(
    plan.destination,
    entry.document.path,
    { create: true }
  );
  await writeBytes(destinationFile, entry.source.markdownBytes);
  const store = await documentsDirectory.getDirectoryHandle(
    entry.document.document_id,
    { create: true }
  );
  const assembledMetadataFiles = await createAssembledMetadataFiles(plan, entry);
  for (const path of entry.source.metadataDirectories) {
    await getDirectoryHandleAtPath(store, path, { create: true });
  }
  for (const [path, bytes] of assembledMetadataFiles) {
    await writeBytes(await getFileHandleAtInternalPath(store, path, { create: true }), bytes);
  }
  await writeJsonFile(store, ownershipFileName, {
    format: "patchmark-document-store",
    schema_version: 1,
    document_id: entry.document.document_id,
    created_at: plan.createdAt,
    source: "legacy-assembly"
  });
  await writeJsonFile(store, provenanceFileName, {
    format: "patchmark-legacy-import",
    schema_version: 1,
    assembly_id: plan.assemblyId,
    source_type: "legacy-single-document-project",
    source_label: entry.source.summary.sourceLabel,
    source_project_name: entry.source.summary.sourceProjectName,
    source_content_sha256: entry.source.summary.sourceFingerprintSha256,
    source_markdown_sha256: entry.source.summary.markdownSha256,
    imported_at: plan.createdAt
  });
}

async function verifyStagedAssembly(plan: LegacyProjectAssemblyPlan): Promise<void> {
  const metadata = await plan.destination.getDirectoryHandle(metadataDirectoryName);
  const documents = await metadata.getDirectoryHandle("documents");
  for (const entry of plan.entries) {
    const markdown = await readFileBytes(
      await getFileHandleAtPath(plan.destination, entry.document.path)
    );
    assertEqualBytes(
      markdown,
      entry.source.markdownBytes,
      `${entry.source.summary.sourceLabel} Markdown`
    );
    const store = await documents.getDirectoryHandle(entry.document.document_id);
    const assembledMetadataFiles = await createAssembledMetadataFiles(plan, entry);
    for (const [path, expected] of assembledMetadataFiles) {
      assertEqualBytes(
        await readFileBytes(await getFileHandleAtInternalPath(store, path)),
        expected,
        `${entry.source.summary.sourceLabel} metadata ${path}`
      );
    }
    const ownership = parseJson(
      decodeText(await readFileBytes(await store.getFileHandle(ownershipFileName))),
      ownershipFileName
    );
    if (
      !isRecord(ownership) ||
      ownership.document_id !== entry.document.document_id ||
      ownership.source !== "legacy-assembly"
    ) {
      throw new Error(
        `Document store ownership mismatch for ${entry.document.document_id}.`
      );
    }
    const provenanceText = decodeText(
      await readFileBytes(await store.getFileHandle(provenanceFileName))
    );
    if (provenanceText.includes("/Users/") || provenanceText.includes("file://")) {
      throw new Error("Portable import provenance contains an absolute source path.");
    }
  }
}

async function createAssembledMetadataFiles(
  plan: LegacyProjectAssemblyPlan,
  entry: LegacyProjectAssemblyPlanEntry
): Promise<Map<string, Uint8Array>> {
  const files = new Map(entry.source.metadataFiles);
  await remapRewriteSessionFile({
    commitPath: "save-commit.json",
    documentId: entry.document.document_id,
    files,
    projectId: plan.manifest.project_id,
    sessionPath: "rewrite-sessions.json"
  });
  await remapRewriteSessionFile({
    commitPath: "recovery/save-commit.json.lkg",
    documentId: entry.document.document_id,
    files,
    projectId: plan.manifest.project_id,
    sessionPath: "recovery/rewrite-sessions.json.lkg"
  });
  return files;
}

async function remapRewriteSessionFile({
  commitPath,
  documentId,
  files,
  projectId,
  sessionPath
}: {
  commitPath: string;
  documentId: string;
  files: Map<string, Uint8Array>;
  projectId: string;
  sessionPath: string;
}): Promise<void> {
  const sessionBytes = files.get(sessionPath);
  if (!sessionBytes) {
    return;
  }
  const value = parseJson(decodeText(sessionBytes), sessionPath);
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error(`Legacy project ${sessionPath} is invalid.`);
  }
  const remapped = {
    ...value,
    project_id: projectId,
    document_id: documentId,
    sessions: value.sessions.map((session) => {
      if (!isRecord(session)) {
        throw new Error(`Legacy project ${sessionPath} contains an invalid session.`);
      }
      return {
        ...session,
        project_id: projectId,
        document_id: documentId
      };
    })
  };
  const remappedBytes = encodeText(`${JSON.stringify(remapped, null, 2)}\n`);
  files.set(sessionPath, remappedBytes);

  const commitBytes = files.get(commitPath);
  if (!commitBytes) {
    return;
  }
  const commit = parseJson(decodeText(commitBytes), commitPath);
  if (!isRecord(commit) || !isRecord(commit.files)) {
    throw new Error(`Legacy project ${commitPath} is invalid.`);
  }
  const rewriteDescriptor = commit.files.rewrite_sessions;
  if (!isRecord(rewriteDescriptor)) {
    return;
  }
  files.set(
    commitPath,
    encodeText(
      `${JSON.stringify(
        {
          ...commit,
          files: {
            ...commit.files,
            rewrite_sessions: {
              ...rewriteDescriptor,
              bytes: remappedBytes.byteLength,
              sha256: await createSha256(remappedBytes)
            }
          }
        },
        null,
        2
      )}\n`
    )
  );
}

async function verifyReopenedAssembly(
  plan: LegacyProjectAssemblyPlan,
  opened: LoadedPatchmarkProject
): Promise<void> {
  if (opened.project.projectManifest?.project_id !== plan.manifest.project_id) {
    throw new Error("Reopened destination has the wrong project identity.");
  }
  for (const entry of plan.entries) {
    const loaded = await openProjectDocument(
      opened.project,
      entry.document.document_id
    );
    if (loaded.markdown !== decodeText(entry.source.markdownBytes)) {
      throw new Error(
        `${entry.source.summary.sourceLabel} Markdown changed after reopen.`
      );
    }
    const comments = await readProjectComments(loaded.project);
    const patches = await readProjectPatches(loaded.project);
    const versions = await listProjectVersions(loaded.project);
    assertSameIds(
      comments.map((comment) => comment.id),
      entry.source.identifiers.comment,
      `${entry.source.summary.sourceLabel} comments`
    );
    assertSameIds(
      patches.map((patch) => patch.id),
      entry.source.identifiers.patch,
      `${entry.source.summary.sourceLabel} patches`
    );
    assertSameIds(
      versions.map((version) => version.id),
      entry.source.identifiers.version,
      `${entry.source.summary.sourceLabel} versions`
    );
    for (const version of versions) {
      if (
        (await readProjectVersionMarkdown(loaded.project, version)) !==
        entry.source.versionMarkdown.get(version.id)
      ) {
        throw new Error(
          `${entry.source.summary.sourceLabel} Version History changed after reopen.`
        );
      }
    }
  }
}

function createIdentifierInventory(
  comments: readonly PatchmarkComment[],
  patches: readonly PatchmarkPatch[],
  versions: readonly PatchmarkVersionEntry[]
): LegacyProjectIdentifierInventory {
  const inventory = Object.fromEntries(
    identifierNamespaces.map((namespace) => [namespace, new Set<string>()])
  ) as Record<LegacyIdentifierNamespace, Set<string>>;
  const uniqueNamespaces = new Map<string, LegacyIdentifierNamespace>();
  const addUnique = (namespace: LegacyIdentifierNamespace, id: string) => {
    if (!id.trim()) {
      throw new Error(`Legacy ${namespace} object is missing an ID.`);
    }
    const existing = uniqueNamespaces.get(`${namespace}:${id}`);
    if (existing) {
      throw new Error(`Duplicate legacy ${namespace} ID: ${id}.`);
    }
    uniqueNamespaces.set(`${namespace}:${id}`, namespace);
    inventory[namespace].add(id);
  };
  for (const comment of comments) {
    addUnique("comment", comment.id);
    for (const reply of comment.thread) {
      addUnique("reply", `${comment.id}::${reply.id}`);
      if (reply.source_import_id) {
        inventory.source_import.add(reply.source_import_id);
      }
    }
    for (const history of comment.anchor_history ?? []) {
      if ("history_id" in history) {
        addUnique(
          "anchor_history",
          `${comment.id}::${history.history_id}`
        );
      }
    }
  }
  for (const patch of patches) {
    addUnique("patch", patch.id);
    if (patch.patch_group_id) {
      inventory.patch_group.add(patch.patch_group_id);
    }
    if (patch.source_import_id) {
      inventory.source_import.add(patch.source_import_id);
    }
  }
  for (const version of versions) {
    addUnique("version", version.id);
  }
  return Object.freeze(
    Object.fromEntries(
      identifierNamespaces.map((namespace) => [
        namespace,
        Object.freeze([...inventory[namespace]].sort())
      ])
    ) as LegacyProjectIdentifierInventory
  );
}

function validateLegacyRelationships({
  comments,
  currentVersion,
  patches,
  sourceLabel,
  versions
}: {
  comments: readonly PatchmarkComment[];
  currentVersion?: string;
  patches: readonly PatchmarkPatch[];
  sourceLabel: string;
  versions: readonly PatchmarkVersionEntry[];
}): string[] {
  const warnings: string[] = [];
  const commentIds = new Set(comments.map((comment) => comment.id));
  const patchIds = new Set(patches.map((patch) => patch.id));
  const versionIds = new Set(versions.map((version) => version.id));
  for (const patch of patches) {
    if (patch.comment_id && !commentIds.has(patch.comment_id)) {
      warnings.push(
        `Preserved legacy patch ${patch.id} link to unavailable comment ${patch.comment_id}.`
      );
    }
    if (patch.pre_apply_snapshot_id && !versionIds.has(patch.pre_apply_snapshot_id)) {
      warnings.push(
        `Preserved legacy patch ${patch.id} link to unavailable version ${patch.pre_apply_snapshot_id}.`
      );
    }
  }
  for (const comment of comments) {
    for (const reply of comment.thread) {
      if (reply.source_patch_id && !patchIds.has(reply.source_patch_id)) {
        warnings.push(
          `Preserved reply ${reply.id} link to unavailable patch ${reply.source_patch_id}.`
        );
      }
    }
    for (const history of comment.anchor_history ?? []) {
      if (history.source_patch_id && !patchIds.has(history.source_patch_id)) {
        warnings.push(
          `Preserved ${comment.id} anchor history link to unavailable patch ${history.source_patch_id}.`
        );
      }
    }
    for (const impact of comment.patch_impacts ?? []) {
      if (!patchIds.has(impact.patch_id)) {
        warnings.push(
          `Preserved ${comment.id} impact link to unavailable patch ${impact.patch_id}.`
        );
      }
    }
  }
  if (currentVersion && !versionIds.has(currentVersion)) {
    warnings.push(
      `Preserved current_version ${currentVersion}, which is unavailable in Version History.`
    );
  }
  void sourceLabel;
  return warnings;
}

function assertNoUnsafeIdentityCollisions(
  sources: readonly LegacyProjectAssemblySource[]
): void {
  const collision = analyzeLegacyProjectIdentityCompatibility(sources)
    .unsafeCollisions[0];
  if (!collision) {
    return;
  }
  throw new Error(
    `${formatNamespace(collision.namespace)} ID collision ${collision.id} detected between ${collision.sourceLabels.join(
      " and "
    )}.`
  );
}

async function assertDistinctNonOverlappingDirectories(
  sources: readonly LegacyProjectAssemblySource[],
  destination: ProjectDirectoryHandle
): Promise<void> {
  if (!destination.entries || !destination.removeEntry) {
    throw new Error(
      "This filesystem cannot safely enumerate and clean an assembly destination."
    );
  }
  for (let index = 0; index < sources.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < sources.length; otherIndex += 1) {
      await assertDirectoriesDoNotOverlap(
        sources[index].directoryHandle,
        sources[otherIndex].directoryHandle,
        "The same source project cannot be selected twice."
      );
    }
    await assertDirectoriesDoNotOverlap(
      sources[index].directoryHandle,
      destination,
      "The destination folder must not overlap a source project."
    );
  }
}

async function assertDirectoriesDoNotOverlap(
  left: ProjectDirectoryHandle,
  right: ProjectDirectoryHandle,
  message: string
): Promise<void> {
  if (!left.isSameEntry || !left.resolve || !right.resolve) {
    throw new Error(
      "This filesystem cannot prove that source and destination folders are separate."
    );
  }
  if (
    (await left.isSameEntry(right)) ||
    (await left.resolve(right)) !== null ||
    (await right.resolve(left)) !== null
  ) {
    throw new Error(message);
  }
}

async function assertDirectoryEmpty(directory: ProjectDirectoryHandle): Promise<void> {
  if (!directory.entries) {
    throw new Error("This filesystem cannot verify that the destination is empty.");
  }
  for await (const [name] of directory.entries()) {
    throw new Error(
      `The destination folder must be empty. Existing entry: ${name}.`
    );
  }
}

async function hasOnlyAssemblyGeneratedEntries(
  destination: ProjectDirectoryHandle,
  assemblyId: string,
  destinationPaths: readonly string[],
  documentIds: readonly string[]
): Promise<boolean> {
  const tree = await collectProjectTree(destination);
  const allowedDocumentFiles = new Set(destinationPaths);
  const allowedDocumentDirectories = new Set<string>();
  for (const destinationPath of destinationPaths) {
    const segments = destinationPath.split("/");
    segments.pop();
    while (segments.length > 0) {
      allowedDocumentDirectories.add(segments.join("/"));
      segments.pop();
    }
  }
  const transactionPath = `${metadataDirectoryName}/transactions/${assemblyId}`;
  const storePaths = documentIds.map(
    (documentId) => `${metadataDirectoryName}/documents/${documentId}`
  );
  for (const filePath of tree.files.keys()) {
    if (
      allowedDocumentFiles.has(filePath) ||
      filePath === `${transactionPath}/assembly.json` ||
      storePaths.some((storePath) => filePath.startsWith(`${storePath}/`)) ||
      /^\.patchmark\/\.patchmark-tmp-[^/]+\.json$/.test(filePath)
    ) {
      continue;
    }
    return false;
  }
  for (const directoryPath of tree.directories) {
    if (
      allowedDocumentDirectories.has(directoryPath) ||
      directoryPath === metadataDirectoryName ||
      directoryPath === `${metadataDirectoryName}/transactions` ||
      directoryPath === transactionPath ||
      directoryPath === `${metadataDirectoryName}/documents` ||
      storePaths.some(
        (storePath) =>
          directoryPath === storePath || directoryPath.startsWith(`${storePath}/`)
      )
    ) {
      continue;
    }
    return false;
  }
  return true;
}

async function assertSourceUnchanged(
  source: LegacyProjectAssemblySource
): Promise<void> {
  const current = await collectProjectTree(source.directoryHandle);
  assertMatchingFingerprint(
    source.treeSnapshot,
    current,
    source.summary.sourceLabel
  );
}

function assertMatchingFingerprint(
  expected: LegacyProjectTreeSnapshot,
  actual: LegacyProjectTreeSnapshot,
  sourceLabel: string
): void {
  if (expected.fingerprintSha256 !== actual.fingerprintSha256) {
    throw new Error(
      `${sourceLabel} changed while it was being imported. Retry after source edits finish.`
    );
  }
}

async function collectProjectTree(
  root: ProjectDirectoryHandle
): Promise<LegacyProjectTreeSnapshot> {
  if (!root.entries) {
    throw new Error("This filesystem cannot enumerate a legacy project safely.");
  }
  const files = new Map<string, Uint8Array>();
  const directories: string[] = [];
  await collectDirectoryTree(root, "", files, directories);
  const fingerprintSha256 = await createTreeFingerprint(files, directories);
  return {
    directories: Object.freeze(directories.sort()),
    files,
    fingerprintSha256
  };
}

async function collectDirectoryTree(
  directory: ProjectDirectoryHandle,
  prefix: string,
  files: Map<string, Uint8Array>,
  directories: string[]
): Promise<void> {
  if (!directory.entries) {
    throw new Error("This filesystem cannot enumerate a legacy project safely.");
  }
  const entries: Array<[string, { kind?: "file" | "directory" }]> = [];
  for await (const entry of directory.entries()) {
    entries.push(entry);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  for (const [name, entry] of entries) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "directory") {
      directories.push(path);
      await collectDirectoryTree(
        await directory.getDirectoryHandle(name),
        path,
        files,
        directories
      );
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`Unsupported filesystem entry at ${path}.`);
    }
    const file = await directory.getFileHandle(name);
    if (await (file as ProjectFileHandle).isSymbolicLink?.()) {
      throw new Error(`Symbolic links are not supported in legacy projects: ${path}.`);
    }
    files.set(path, await readFileBytes(file as ProjectFileHandle));
  }
}

async function createTreeFingerprint(
  files: ReadonlyMap<string, Uint8Array>,
  directories: readonly string[]
): Promise<string> {
  const descriptors = await Promise.all(
    [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([path, bytes]) => ({
        path,
        bytes: bytes.byteLength,
        sha256: await createSha256(bytes)
      }))
  );
  return createSha256(
    encodeText(JSON.stringify({ directories: [...directories].sort(), files: descriptors }))
  );
}

async function createSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SHA-256 support is required for safe project assembly.");
  }
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function collectUnknownFieldWarnings(
  metadataFiles: ReadonlyMap<string, string>
): string[] {
  const warnings: string[] = [];
  const manifest = parseJson(metadataFiles.get("manifest.json") ?? "{}", "manifest.json");
  collectUnknownKeys(
    manifest,
    new Set([
      "schema_version",
      "project_id",
      "document_id",
      "project_name",
      "document_file",
      "created_at",
      "updated_at",
      "current_version",
      "versions",
      "reading_bookmark",
      "reading_bookmarks",
      "save_generation",
      "save_commit_id"
    ]),
    "manifest",
    warnings
  );
  const commentKeys = new Set([
    "id", "type", "status", "anchor", "comment", "thread", "export_state",
    "anchor_history", "patch_impacts", "created_at", "updated_at", "resolved_at"
  ]);
  const patchKeys = new Set([
    "id", "status", "patch_group_id", "patch_group_index", "patch_group_total",
    "comment_id", "source_import_id", "source_chat_url", "display_title",
    "target_heading", "original_text", "suggested_text", "suggested_text_sources",
    "reason", "reason_sources", "risk", "risk_sources", "sources", "created_at",
    "resolved_at", "accepted_at", "applied_at", "rejected_at", "pre_apply_snapshot_id",
    "pre_apply_snapshot_file", "applied_text", "applied_start_offset",
    "applied_end_offset", "applied_context_before", "applied_context_after",
    "applied_heading", "applied_heading_id", "applied_heading_path",
    "applied_table_index", "applied_table_row_index", "applied_table_row_anchor",
    "applied_table_row_cells", "anchor_recovery_history", "previous_original_text",
    "reanchored_at", "reanchor_reason"
  ]);
  const rawComments = parseJson(
    metadataFiles.get("comments.json") ?? "[]",
    "comments.json"
  );
  const rawPatches = parseJson(
    metadataFiles.get("patches.json") ?? "[]",
    "patches.json"
  );
  for (const comment of Array.isArray(rawComments) ? rawComments : []) {
    collectUnknownKeys(
      comment,
      commentKeys,
      `comment ${isRecord(comment) ? String(comment.id ?? "unknown") : "unknown"}`,
      warnings
    );
  }
  for (const patch of Array.isArray(rawPatches) ? rawPatches : []) {
    collectUnknownKeys(
      patch,
      patchKeys,
      `patch ${isRecord(patch) ? String(patch.id ?? "unknown") : "unknown"}`,
      warnings
    );
  }
  return warnings.slice(0, 20);
}

function collectUnknownKeys(
  value: unknown,
  known: ReadonlySet<string>,
  label: string,
  warnings: string[]
): void {
  if (!isRecord(value)) {
    return;
  }
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    warnings.push(`Preserved unknown fields on ${label}: ${unknown.join(", ")}.`);
  }
}

async function writeAssemblyJournal(
  directory: ProjectDirectoryHandle,
  plan: LegacyProjectAssemblyPlan,
  stage: string,
  lastSourceLabel?: string,
  error?: unknown
): Promise<void> {
  await writeJsonFile(directory, "assembly.json", {
    format: "patchmark-legacy-assembly-transaction",
    schema_version: 1,
    assembly_id: plan.assemblyId,
    destination_project_id: plan.manifest.project_id,
    destination_title: plan.manifest.title,
    created_at: plan.createdAt,
    updated_at: new Date().toISOString(),
    stage,
    ...(lastSourceLabel ? { last_source_label: lastSourceLabel } : {}),
    documents: plan.entries.map((entry) => ({
      source_type: "legacy-single-document-project",
      source_label: entry.source.summary.sourceLabel,
      source_content_sha256: entry.source.summary.sourceFingerprintSha256,
      destination_document_id: entry.document.document_id,
      destination_path: entry.document.path,
      display_title: entry.document.display_title,
      role: entry.document.role,
      position: entry.document.position
    })),
    ...(error ? { error: getErrorMessage(error) } : {})
  });
}

async function removeAssemblyJournal(
  destination: ProjectDirectoryHandle,
  assemblyId: string
): Promise<void> {
  const metadata = await destination.getDirectoryHandle(metadataDirectoryName);
  const transactions = await metadata.getDirectoryHandle("transactions");
  await removeEntryIfPresent(transactions, assemblyId);
}

async function cleanupIncompleteDestination(
  destination: ProjectDirectoryHandle
): Promise<void> {
  if (!destination.removeEntry || !destination.entries) {
    throw new Error("This filesystem cannot clean the incomplete destination.");
  }
  try {
    const metadata = await destination.getDirectoryHandle(metadataDirectoryName);
    await removeEntryIfPresent(metadata, "project.json");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  const names: string[] = [];
  for await (const [name] of destination.entries()) {
    names.push(name);
  }
  for (const name of names) {
    await destination.removeEntry(name, { recursive: true });
  }
}

async function pickDirectory(
  mode: "read" | "readwrite"
): Promise<ProjectDirectoryHandle | null> {
  const picker =
    typeof window === "undefined"
      ? undefined
      : (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      "Project assembly requires a browser with File System Access API support."
    );
  }
  try {
    return await picker({ mode });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

function assertPortableVersionPath(
  version: PatchmarkVersionEntry,
  sourceLabel: string
): void {
  if (!/^\.patchmark\/versions\/[^/]+\.md$/i.test(version.file)) {
    throw new Error(
      `${sourceLabel} version ${version.id} has an unsafe snapshot path.`
    );
  }
}

function requireSnapshotFile(
  snapshot: LegacyProjectTreeSnapshot,
  path: string,
  sourceLabel: string
): Uint8Array {
  const value = snapshot.files.get(path);
  if (!value) {
    throw new Error(`${sourceLabel} is missing ${path}.`);
  }
  return value;
}

function assertEqualBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string
): void {
  if (
    actual.byteLength !== expected.byteLength ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(`${label} was not copied byte-for-byte.`);
  }
}

function assertSameIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} changed during assembly.`);
  }
}

async function readFileBytes(file: ProjectFileHandle): Promise<Uint8Array> {
  const value = await file.getFile();
  if (value.arrayBuffer) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return encodeText(await value.text());
}

async function writeBytes(
  file: ProjectFileHandle,
  bytes: Uint8Array
): Promise<void> {
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function writeJsonFile(
  directory: ProjectDirectoryHandle,
  name: string,
  value: unknown
): Promise<void> {
  const writable = await (
    await directory.getFileHandle(name, { create: true })
  ).createWritable();
  await writable.write(`${JSON.stringify(value, null, 2)}\n`);
  await writable.close();
}

async function getFileHandleAtPath(
  root: ProjectDirectoryHandle,
  path: string,
  options?: { create?: boolean }
): Promise<ProjectFileHandle> {
  const safePath = validateRegisteredDocumentPath(path);
  return getFileHandleAtInternalPath(root, safePath, options);
}

async function getFileHandleAtInternalPath(
  root: ProjectDirectoryHandle,
  path: string,
  options?: { create?: boolean }
): Promise<ProjectFileHandle> {
  const segments = validateInternalPath(path);
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error(`Invalid internal file path: ${path}.`);
  }
  let directory = root;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, {
      create: options?.create
    });
  }
  return directory.getFileHandle(fileName, options);
}

async function getDirectoryHandleAtPath(
  root: ProjectDirectoryHandle,
  path: string,
  options?: { create?: boolean }
): Promise<ProjectDirectoryHandle> {
  let directory = root;
  for (const segment of validateInternalPath(path)) {
    directory = await directory.getDirectoryHandle(segment, options);
  }
  return directory;
}

function validateInternalPath(path: string): string[] {
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.includes("\\")
    )
  ) {
    throw new Error(`Invalid internal relative path: ${path}.`);
  }
  return segments;
}

async function removeEntryIfPresent(
  directory: ProjectDirectoryHandle,
  name: string
): Promise<void> {
  if (!directory.removeEntry) {
    throw new Error("This filesystem cannot remove incomplete transaction data.");
  }
  try {
    await directory.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function freezeProjectManifest(
  manifest: PatchmarkProjectManifestV1
): PatchmarkProjectManifestV1 {
  for (const document of manifest.documents) {
    Object.freeze(document);
  }
  Object.freeze(manifest.documents);
  return Object.freeze(manifest);
}

function validateDisplayTitle(value: string, label: string): string {
  const title = value.trim();
  if (!title) {
    throw new Error(`${label} is required.`);
  }
  if (title.length > 240) {
    throw new Error(`${label} must be 240 characters or fewer.`);
  }
  return title;
}

function validateSourceLabel(value: string): string {
  return validateDisplayTitle(value, "Source label");
}

function validateRole(value: PatchmarkDocumentRole): PatchmarkDocumentRole {
  if (!allowedRoles.includes(value)) {
    throw new Error("Document role is invalid.");
  }
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is invalid JSON.`);
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Patchmark project text must be valid UTF-8.");
  }
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function formatNamespace(namespace: LegacyIdentifierNamespace): string {
  return namespace
    .split("_")
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function createStableId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

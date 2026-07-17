export type PatchmarkDocumentRole =
  | "decision"
  | "research"
  | "evidence"
  | "summary"
  | null;

export type PatchmarkDocumentStatus = "active" | "archived";

export type PatchmarkRegisteredDocument = {
  document_id: string;
  path: string;
  display_title: string;
  role: PatchmarkDocumentRole;
  status: PatchmarkDocumentStatus;
  position: number;
  added_at: string;
  archived_at: string | null;
};

export type PatchmarkProjectManifestV1 = {
  format: "patchmark-project";
  schema_version: 1;
  project_id: string;
  title: string;
  created_at: string;
  manifest_revision: number;
  documents: PatchmarkRegisteredDocument[];
};

export type PatchmarkDocumentAvailability = "available" | "missing";

export type PatchmarkProjectDocumentView = PatchmarkRegisteredDocument & {
  availability: PatchmarkDocumentAvailability;
};

export type PatchmarkDocumentStoreIdentity = {
  format: "patchmark-document-store";
  schema_version: 1;
  document_id: string;
  created_at: string;
  source: "created" | "existing" | "legacy-conversion" | "legacy-assembly";
};

export type PatchmarkProjectMigrationStage =
  | "preflight"
  | "staging"
  | "verified"
  | "document_store_committed"
  | "manifest_committed"
  | "reopened"
  | "complete";

type EntryHandle = {
  kind?: "file" | "directory";
  isSameEntry?: (other: EntryHandle) => Promise<boolean>;
  isSymbolicLink?: () => Promise<boolean>;
};

export type ProjectFileHandle = EntryHandle & {
  name: string;
  getFile: () => Promise<{
    name: string;
    size?: number;
    type?: string;
    text: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  }>;
  createWritable: () => Promise<{
    write: (data: string | ArrayBuffer | ArrayBufferView) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

export type ProjectDirectoryHandle = EntryHandle & {
  name: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<ProjectFileHandle>;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<ProjectDirectoryHandle>;
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  entries?: () => AsyncIterableIterator<[
    string,
    EntryHandle & { kind?: "file" | "directory" }
  ]>;
  resolve?: (possibleDescendant: EntryHandle) => Promise<string[] | null>;
};

export type LegacyConversionResult = {
  document: PatchmarkRegisteredDocument;
  manifest: PatchmarkProjectManifestV1;
  migrationId: string;
};

export type LegacyProjectImportSnapshot = {
  markdown: string;
  metadataFiles: ReadonlyMap<string, string>;
};

const metadataDirectoryName = ".patchmark";
const projectManifestFileName = "project.json";
const documentStoreIdentityFileName = "document.json";
const documentStoreDirectoryName = "documents";
const reservedMetadataEntries = new Set([
  projectManifestFileName,
  documentStoreDirectoryName,
  "migrations",
  "transactions"
]);
const allowedRoles: PatchmarkDocumentRole[] = [
  "decision",
  "research",
  "evidence",
  "summary",
  null
];

export function createProjectId(): string {
  return createStableId("prj");
}

export function createDocumentId(): string {
  return createStableId("doc");
}

export function validateRegisteredDocumentPath(path: string): string {
  if (typeof path !== "string") {
    throw new Error("Document path must be a string.");
  }

  const normalized = path.trim();
  if (!normalized) {
    throw new Error("Document path is required.");
  }
  if (normalized.includes("\\")) {
    throw new Error("Document paths must use forward slashes.");
  }
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("file:")
  ) {
    throw new Error("Document paths must be relative to the project folder.");
  }

  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    throw new Error("Document path contains an unsafe path segment.");
  }
  if (segments[0].toLocaleLowerCase() === metadataDirectoryName) {
    throw new Error("Documents cannot be stored inside .patchmark.");
  }
  if (!/\.(md|markdown)$/i.test(segments.at(-1) ?? "")) {
    throw new Error("Document path must end in .md or .markdown.");
  }

  return segments.join("/");
}

export function parseProjectManifest(
  value: unknown
): PatchmarkProjectManifestV1 {
  if (!isRecord(value)) {
    throw new Error(".patchmark/project.json must contain a JSON object.");
  }
  if (value.format !== "patchmark-project" || value.schema_version !== 1) {
    throw new Error("Unsupported Patchmark project manifest format.");
  }
  if (!isNonEmptyString(value.project_id)) {
    throw new Error("Project manifest is missing project_id.");
  }
  if (!isNonEmptyString(value.title)) {
    throw new Error("Project manifest is missing title.");
  }
  if (!isIsoDate(value.created_at)) {
    throw new Error("Project manifest has an invalid created_at value.");
  }
  if (
    typeof value.manifest_revision !== "number" ||
    !Number.isSafeInteger(value.manifest_revision) ||
    value.manifest_revision < 1
  ) {
    throw new Error("Project manifest has an invalid manifest_revision.");
  }
  if (!Array.isArray(value.documents) || value.documents.length === 0) {
    throw new Error("Project manifest must register at least one document.");
  }

  const documentIds = new Set<string>();
  const exactPaths = new Set<string>();
  const portablePaths = new Set<string>();
  const documents = value.documents.map((candidate, index) => {
    const document = parseRegisteredDocument(candidate, index);
    const portablePath = document.path.toLocaleLowerCase();
    if (documentIds.has(document.document_id)) {
      throw new Error(`Duplicate document_id: ${document.document_id}.`);
    }
    if (exactPaths.has(document.path) || portablePaths.has(portablePath)) {
      throw new Error(`Duplicate registered document path: ${document.path}.`);
    }
    documentIds.add(document.document_id);
    exactPaths.add(document.path);
    portablePaths.add(portablePath);
    return document;
  });
  if (!documents.some((document) => document.status === "active")) {
    throw new Error("Project manifest must keep at least one active document.");
  }

  return {
    ...value,
    format: "patchmark-project",
    schema_version: 1,
    project_id: value.project_id,
    title: value.title.trim(),
    created_at: value.created_at,
    manifest_revision: value.manifest_revision,
    documents
  } as PatchmarkProjectManifestV1;
}

export function parseProjectManifestText(text: string): PatchmarkProjectManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(".patchmark/project.json is invalid JSON.");
  }
  return parseProjectManifest(parsed);
}

export function serializeProjectManifest(
  manifest: PatchmarkProjectManifestV1
): string {
  return `${JSON.stringify(parseProjectManifest(manifest), null, 2)}\n`;
}

export function deriveDocumentDisplayTitle(markdown: string, path: string): string {
  const heading = markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .find(Boolean);
  if (heading) {
    return heading;
  }
  const fileName = validateRegisteredDocumentPath(path).split("/").at(-1) ?? path;
  return fileName.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ").trim();
}

export function updateDocumentRegistration(
  manifest: PatchmarkProjectManifestV1,
  documentId: string,
  changes: Partial<Pick<PatchmarkRegisteredDocument, "display_title" | "role">>,
  now = new Date().toISOString()
): PatchmarkProjectManifestV1 {
  void now;
  const current = getRegisteredDocument(manifest, documentId);
  const displayTitle =
    changes.display_title !== undefined
      ? validateDisplayTitle(changes.display_title)
      : current.display_title;
  const role =
    changes.role !== undefined ? validateRole(changes.role) : current.role;
  if (displayTitle === current.display_title && role === current.role) {
    return manifest;
  }
  return mutateManifestDocument(manifest, documentId, (document) => ({
    ...document,
    display_title: displayTitle,
    role
  }));
}

export function reorderRegisteredDocument(
  manifest: PatchmarkProjectManifestV1,
  documentId: string,
  direction: "up" | "down"
): PatchmarkProjectManifestV1 {
  const target = getRegisteredDocument(manifest, documentId);
  const ordered = manifest.documents
    .filter((document) => document.status === target.status)
    .sort(compareRegisteredDocuments);
  const index = ordered.findIndex((document) => document.document_id === documentId);
  const destinationIndex = direction === "up" ? index - 1 : index + 1;
  if (destinationIndex < 0 || destinationIndex >= ordered.length) {
    return manifest;
  }

  let position: number;
  if (direction === "up") {
    const destination = ordered[destinationIndex];
    const beforeDestination = ordered[destinationIndex - 1];
    position = beforeDestination
      ? midpoint(beforeDestination.position, destination.position)
      : destination.position - 1000;
  } else {
    const destination = ordered[destinationIndex];
    const afterDestination = ordered[destinationIndex + 1];
    position = afterDestination
      ? midpoint(destination.position, afterDestination.position)
      : destination.position + 1000;
  }

  return mutateManifestDocument(manifest, documentId, (document) => ({
    ...document,
    position
  }));
}

export function archiveRegisteredDocument(
  manifest: PatchmarkProjectManifestV1,
  documentId: string,
  now = new Date().toISOString()
): PatchmarkProjectManifestV1 {
  const activeCount = manifest.documents.filter(
    (document) => document.status === "active"
  ).length;
  const target = getRegisteredDocument(manifest, documentId);
  if (target.status === "archived") {
    return manifest;
  }
  if (target.status === "active" && activeCount === 1) {
    throw new Error("A project must keep at least one active document.");
  }
  return mutateManifestDocument(manifest, documentId, (document) => ({
    ...document,
    status: "archived",
    archived_at: now
  }));
}

export function restoreRegisteredDocument(
  manifest: PatchmarkProjectManifestV1,
  documentId: string
): PatchmarkProjectManifestV1 {
  if (getRegisteredDocument(manifest, documentId).status === "active") {
    return manifest;
  }
  return mutateManifestDocument(manifest, documentId, (document) => ({
    ...document,
    status: "active",
    archived_at: null
  }));
}

export async function readProjectManifest(
  root: ProjectDirectoryHandle
): Promise<PatchmarkProjectManifestV1 | null> {
  let metadata: ProjectDirectoryHandle;
  try {
    metadata = await root.getDirectoryHandle(metadataDirectoryName);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let file: ProjectFileHandle;
  try {
    file = await metadata.getFileHandle(projectManifestFileName);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  return parseProjectManifestText(await readText(file));
}

export async function writeProjectManifestAtomic(
  root: ProjectDirectoryHandle,
  manifest: PatchmarkProjectManifestV1
): Promise<void> {
  const validated = parseProjectManifest(manifest);
  const text = serializeProjectManifest(validated);
  const metadata = await root.getDirectoryHandle(metadataDirectoryName, {
    create: true
  });
  const current = await readOptionalText(metadata, projectManifestFileName);
  if (current !== null) {
    parseProjectManifestText(current);
    const recovery = await metadata.getDirectoryHandle("recovery", { create: true });
    await writeText(
      await recovery.getFileHandle("project.json.lkg", { create: true }),
      current
    );
  }

  const temporaryName = `.patchmark-tmp-${createStableId("manifest")}.json`;
  try {
    const temporary = await metadata.getFileHandle(temporaryName, { create: true });
    await writeText(temporary, text);
    parseProjectManifestText(await readText(temporary));
    const target = await metadata.getFileHandle(projectManifestFileName, {
      create: true
    });
    await writeText(target, await readText(temporary));
    const installed = parseProjectManifestText(await readText(target));
    if (
      installed.project_id !== validated.project_id ||
      installed.manifest_revision !== validated.manifest_revision
    ) {
      throw new Error("Could not verify the installed project manifest.");
    }
  } catch (error) {
    if (current === null) {
      await removeEntryIfPresent(metadata, projectManifestFileName);
    }
    throw error;
  } finally {
    await removeEntryIfPresent(metadata, temporaryName);
  }
}

export async function listProjectDocuments(
  root: ProjectDirectoryHandle,
  manifest: PatchmarkProjectManifestV1
): Promise<PatchmarkProjectDocumentView[]> {
  return Promise.all(
    [...manifest.documents]
      .sort(compareRegisteredDocuments)
      .map(async (document) => ({
        ...document,
        availability: (await isRegularProjectMarkdownFile(root, document.path))
          ? "available" as const
          : "missing" as const
      }))
  );
}

export async function assertDocumentStoreIdentity(
  root: ProjectDirectoryHandle,
  documentId: string
): Promise<void> {
  const store = await getDocumentStoreDirectory(root, documentId);
  const identityText = await readText(
    await store.getFileHandle(documentStoreIdentityFileName)
  );
  let identity: unknown;
  try {
    identity = JSON.parse(identityText);
  } catch {
    throw new Error(`Document store ${documentId} has invalid ownership metadata.`);
  }
  if (
    !isRecord(identity) ||
    identity.format !== "patchmark-document-store" ||
    identity.schema_version !== 1 ||
    identity.document_id !== documentId
  ) {
    throw new Error(`Document store ownership mismatch for ${documentId}.`);
  }
}

export async function createDocumentScopedDirectoryHandle(
  root: ProjectDirectoryHandle,
  document: PatchmarkRegisteredDocument
): Promise<ProjectDirectoryHandle> {
  const store = await getDocumentStoreDirectory(root, document.document_id);
  await assertDocumentStoreIdentity(root, document.document_id);

  return {
    name: root.name,
    getFileHandle: async (name, options) => {
      if (name === "document.md") {
        return getFileHandleAtPath(root, document.path, options);
      }
      return root.getFileHandle(name, options);
    },
    getDirectoryHandle: async (name, options) => {
      if (name === metadataDirectoryName) {
        return store;
      }
      return root.getDirectoryHandle(name, options);
    },
    removeEntry: root.removeEntry?.bind(root),
    entries: root.entries?.bind(root),
    resolve: root.resolve?.bind(root)
  };
}

export async function convertLegacyProject({
  firstDocumentTitle,
  onStage,
  projectTitle,
  root
}: {
  firstDocumentTitle?: string;
  onStage?: (stage: PatchmarkProjectMigrationStage) => Promise<void> | void;
  projectTitle: string;
  root: ProjectDirectoryHandle;
}): Promise<LegacyConversionResult> {
  const now = new Date().toISOString();
  const migrationId = createStableId("migration");
  const documentId = createDocumentId();
  const documentPath = "document.md";
  const legacyImport = await inspectLegacyProjectImportSource(root);
  const markdown = legacyImport.markdown;
  const legacySnapshot = new Map(legacyImport.metadataFiles);
  const metadata = await root.getDirectoryHandle(metadataDirectoryName);

  const document: PatchmarkRegisteredDocument = {
    document_id: documentId,
    path: documentPath,
    display_title: validateDisplayTitle(
      firstDocumentTitle ?? deriveDocumentDisplayTitle(markdown, documentPath)
    ),
    role: null,
    status: "active",
    position: 1000,
    added_at: now,
    archived_at: null
  };
  const manifest: PatchmarkProjectManifestV1 = parseProjectManifest({
    format: "patchmark-project",
    schema_version: 1,
    project_id: createProjectId(),
    title: validateDisplayTitle(projectTitle),
    created_at: now,
    manifest_revision: 1,
    documents: [document]
  });

  const migrations = await metadata.getDirectoryHandle("migrations", { create: true });
  const migration = await migrations.getDirectoryHandle(migrationId, { create: true });
  const journalFile = await migration.getFileHandle("journal.json", { create: true });
  const writeJournal = async (stage: string, error?: unknown) => {
    await writeText(
      journalFile,
      `${JSON.stringify({
        format: "patchmark-project-migration",
        schema_version: 1,
        migration_id: migrationId,
        project_id: manifest.project_id,
        document_id: documentId,
        stage,
        updated_at: new Date().toISOString(),
        source_file_count: legacySnapshot.size,
        comment_count: getJsonArrayCount(legacySnapshot, "comments.json"),
        patch_count: getJsonArrayCount(legacySnapshot, "patches.json"),
        ...(error ? { error: getErrorMessage(error) } : {})
      }, null, 2)}\n`
    );
  };

  let finalStoreStarted = false;
  let manifestCommitted = false;
  try {
    await writeJournal("preflight");
    await onStage?.("preflight");

    const stagedStore = await migration.getDirectoryHandle("document-store", {
      create: true
    });
    await writeDirectorySnapshot(stagedStore, legacySnapshot);
    await writeDocumentStoreIdentity(stagedStore, {
      documentId,
      now,
      source: "legacy-conversion"
    });
    await writeJournal("staging");
    await onStage?.("staging");

    await verifyDirectorySnapshot(stagedStore, legacySnapshot);
    await verifyDocumentStoreIdentity(stagedStore, documentId);
    await writeJournal("verified");
    await onStage?.("verified");

    const finalStore = await createDocumentStoreDirectory(root, documentId);
    finalStoreStarted = true;
    await writeDirectorySnapshot(finalStore, legacySnapshot);
    await writeDocumentStoreIdentity(finalStore, {
      documentId,
      now,
      source: "legacy-conversion"
    });
    await verifyDirectorySnapshot(finalStore, legacySnapshot);
    await verifyDocumentStoreIdentity(finalStore, documentId);
    await writeJournal("document_store_committed");
    await onStage?.("document_store_committed");

    await writeProjectManifestAtomic(root, manifest);
    manifestCommitted = true;
    await writeJournal("manifest_committed");
    await onStage?.("manifest_committed");

    return { document, manifest, migrationId };
  } catch (error) {
    await writeJournal(manifestCommitted ? "committed_recovery_required" : "aborted", error);
    if (finalStoreStarted && !manifestCommitted) {
      await removeDocumentStore(root, documentId);
    }
    throw error;
  }
}

export async function inspectLegacyProjectImportSource(
  root: ProjectDirectoryHandle,
  options: { allowInvalidCurrentState?: boolean } = {}
): Promise<LegacyProjectImportSnapshot> {
  if (await readProjectManifest(root)) {
    throw new Error("This project is already using the multi-document format.");
  }

  const documentFile = await getFileHandleAtPath(root, "document.md");
  await assertRegularNonSymlinkFile(documentFile);
  const metadata = await root.getDirectoryHandle(metadataDirectoryName);
  if (await directoryExists(metadata, documentStoreDirectoryName)) {
    throw new Error(
      "This legacy project contains multi-document stores without a valid project manifest."
    );
  }
  const metadataFiles = await collectDirectoryFiles(metadata, {
    excludedRootEntries: reservedMetadataEntries
  });
  if (!options.allowInvalidCurrentState) {
    validateLegacySnapshot(metadataFiles);
  }
  for (const reserved of [documentStoreIdentityFileName, "import-provenance.json"]) {
    if (metadataFiles.has(reserved)) {
      throw new Error(`Legacy project metadata uses reserved file ${reserved}.`);
    }
  }

  return {
    markdown: await readText(documentFile),
    metadataFiles
  };
}

export async function markLegacyConversionReopened(
  root: ProjectDirectoryHandle,
  migrationId: string,
  stage: "reopened" | "complete"
): Promise<void> {
  const metadata = await root.getDirectoryHandle(metadataDirectoryName);
  const migration = await (await metadata.getDirectoryHandle("migrations"))
    .getDirectoryHandle(migrationId);
  const journal = await migration.getFileHandle("journal.json", { create: true });
  const previous = await readOptionalText(migration, "journal.json");
  let value: Record<string, unknown> = {};
  if (previous) {
    try {
      const parsed = JSON.parse(previous);
      if (isRecord(parsed)) {
        value = parsed;
      }
    } catch {
      value = {};
    }
  }
  await writeText(
    journal,
    `${JSON.stringify({ ...value, stage, updated_at: new Date().toISOString() }, null, 2)}\n`
  );
}

export async function completePendingProjectMigration(
  root: ProjectDirectoryHandle,
  manifest: PatchmarkProjectManifestV1
): Promise<boolean> {
  const pending = await findPendingCommittedMigration(root, manifest.project_id);
  if (!pending) {
    return false;
  }
  await writeMigrationJournalStage(pending.directory, "complete");
  return true;
}

export async function rollbackPendingProjectMigration(
  root: ProjectDirectoryHandle,
  manifest: PatchmarkProjectManifestV1,
  error: unknown
): Promise<boolean> {
  const pending = await findPendingCommittedMigration(root, manifest.project_id);
  if (!pending) {
    return false;
  }
  const metadata = await root.getDirectoryHandle(metadataDirectoryName);
  const manifestText = await readOptionalText(metadata, projectManifestFileName);
  if (manifestText) {
    const recovery = await metadata.getDirectoryHandle("recovery", { create: true });
    await writeText(
      await recovery.getFileHandle(
        `invalid-project-${pending.migrationId}.json`,
        { create: true }
      ),
      manifestText
    );
  }
  await removeEntryIfPresent(metadata, projectManifestFileName);
  await writeMigrationJournalStage(
    pending.directory,
    "rolled_back_to_legacy",
    error
  );
  return true;
}

export async function createProjectDocument({
  displayTitle,
  manifest,
  markdown,
  path,
  role,
  root
}: {
  displayTitle: string;
  manifest: PatchmarkProjectManifestV1;
  markdown?: string;
  path: string;
  role: PatchmarkDocumentRole;
  root: ProjectDirectoryHandle;
}): Promise<{ document: PatchmarkRegisteredDocument; manifest: PatchmarkProjectManifestV1 }> {
  const safePath = validateRegisteredDocumentPath(path);
  assertPathIsUnregistered(manifest, safePath);
  if (await pathExists(root, safePath)) {
    throw new Error(`A file already exists at ${safePath}.`);
  }

  const now = new Date().toISOString();
  const document = createRegisteredDocument({
    displayTitle,
    manifest,
    now,
    path: safePath,
    role
  });
  const file = await getFileHandleAtPath(root, safePath, { create: true });
  await writeText(file, markdown ?? `# ${document.display_title}\n`);
  await createEmptyDocumentStore(root, manifest.title, document, "created", now);
  const nextManifest = addRegisteredDocument(manifest, document);
  await writeProjectManifestAtomic(root, nextManifest);
  return { document, manifest: nextManifest };
}

export async function addExistingProjectDocument({
  displayTitle,
  manifest,
  path,
  role,
  root
}: {
  displayTitle?: string;
  manifest: PatchmarkProjectManifestV1;
  path: string;
  role: PatchmarkDocumentRole;
  root: ProjectDirectoryHandle;
}): Promise<{ document: PatchmarkRegisteredDocument; manifest: PatchmarkProjectManifestV1 }> {
  const safePath = validateRegisteredDocumentPath(path);
  assertPathIsUnregistered(manifest, safePath);
  const file = await getFileHandleAtPath(root, safePath);
  await assertRegularNonSymlinkFile(file);
  const original = await readText(file);
  const now = new Date().toISOString();
  const document = createRegisteredDocument({
    displayTitle: displayTitle ?? deriveDocumentDisplayTitle(original, safePath),
    manifest,
    now,
    path: safePath,
    role
  });
  await createEmptyDocumentStore(root, manifest.title, document, "existing", now);
  if ((await readText(file)) !== original) {
    throw new Error("The existing Markdown file changed while it was being registered.");
  }
  const nextManifest = addRegisteredDocument(manifest, document);
  await writeProjectManifestAtomic(root, nextManifest);
  return { document, manifest: nextManifest };
}

export async function locateProjectDocument({
  documentId,
  manifest,
  path,
  root
}: {
  documentId: string;
  manifest: PatchmarkProjectManifestV1;
  path: string;
  root: ProjectDirectoryHandle;
}): Promise<PatchmarkProjectManifestV1> {
  const safePath = validateRegisteredDocumentPath(path);
  assertPathIsUnregistered(manifest, safePath, documentId);
  const file = await getFileHandleAtPath(root, safePath);
  await assertRegularNonSymlinkFile(file);
  if (getRegisteredDocument(manifest, documentId).path === safePath) {
    return manifest;
  }
  const nextManifest = mutateManifestDocument(manifest, documentId, (document) => ({
    ...document,
    path: safePath
  }));
  await writeProjectManifestAtomic(root, nextManifest);
  return nextManifest;
}

export async function resolveProjectFilePath(
  root: ProjectDirectoryHandle,
  file: ProjectFileHandle
): Promise<string> {
  if (!root.resolve) {
    throw new Error("This browser cannot verify that the selected file is inside the project.");
  }
  const segments = await root.resolve(file);
  if (!segments || segments.length === 0) {
    throw new Error("Choose a Markdown file inside the project folder.");
  }
  return validateRegisteredDocumentPath(segments.join("/"));
}

export function getRegisteredDocument(
  manifest: PatchmarkProjectManifestV1,
  documentId: string
): PatchmarkRegisteredDocument {
  const document = manifest.documents.find(
    (candidate) => candidate.document_id === documentId
  );
  if (!document) {
    throw new Error(`Document ${documentId} is not registered in this project.`);
  }
  return document;
}

export function compareRegisteredDocuments(
  left: PatchmarkRegisteredDocument,
  right: PatchmarkRegisteredDocument
): number {
  return left.position - right.position || left.added_at.localeCompare(right.added_at);
}

function parseRegisteredDocument(
  value: unknown,
  index: number
): PatchmarkRegisteredDocument {
  if (!isRecord(value)) {
    throw new Error(`Project document ${index + 1} must be an object.`);
  }
  if (!isNonEmptyString(value.document_id)) {
    throw new Error(`Project document ${index + 1} is missing document_id.`);
  }
  const path = validateRegisteredDocumentPath(String(value.path ?? ""));
  const displayTitle = validateDisplayTitle(value.display_title);
  const role = validateRole(value.role);
  if (value.status !== "active" && value.status !== "archived") {
    throw new Error(`Project document ${value.document_id} has an invalid status.`);
  }
  if (!Number.isFinite(value.position)) {
    throw new Error(`Project document ${value.document_id} has an invalid position.`);
  }
  if (!isIsoDate(value.added_at)) {
    throw new Error(`Project document ${value.document_id} has invalid added_at.`);
  }
  if (
    value.archived_at !== null &&
    value.archived_at !== undefined &&
    !isIsoDate(value.archived_at)
  ) {
    throw new Error(`Project document ${value.document_id} has invalid archived_at.`);
  }
  if (value.status === "archived" && !value.archived_at) {
    throw new Error(`Archived document ${value.document_id} needs archived_at.`);
  }

  return {
    ...value,
    document_id: value.document_id,
    path,
    display_title: displayTitle,
    role,
    status: value.status,
    position: value.position,
    added_at: value.added_at,
    archived_at: value.status === "active" ? null : value.archived_at ?? null
  } as PatchmarkRegisteredDocument;
}

function mutateManifestDocument(
  manifest: PatchmarkProjectManifestV1,
  documentId: string,
  mutate: (document: PatchmarkRegisteredDocument) => PatchmarkRegisteredDocument
): PatchmarkProjectManifestV1 {
  getRegisteredDocument(manifest, documentId);
  return parseProjectManifest({
    ...manifest,
    manifest_revision: manifest.manifest_revision + 1,
    documents: manifest.documents.map((document) =>
      document.document_id === documentId ? mutate(document) : document
    )
  });
}

function addRegisteredDocument(
  manifest: PatchmarkProjectManifestV1,
  document: PatchmarkRegisteredDocument
): PatchmarkProjectManifestV1 {
  return parseProjectManifest({
    ...manifest,
    manifest_revision: manifest.manifest_revision + 1,
    documents: [...manifest.documents, document]
  });
}

function createRegisteredDocument({
  displayTitle,
  manifest,
  now,
  path,
  role
}: {
  displayTitle: string;
  manifest: PatchmarkProjectManifestV1;
  now: string;
  path: string;
  role: PatchmarkDocumentRole;
}): PatchmarkRegisteredDocument {
  return {
    document_id: createDocumentId(),
    path,
    display_title: validateDisplayTitle(displayTitle),
    role: validateRole(role),
    status: "active",
    position:
      Math.max(0, ...manifest.documents.map((document) => document.position)) + 1000,
    added_at: now,
    archived_at: null
  };
}

async function createEmptyDocumentStore(
  root: ProjectDirectoryHandle,
  projectTitle: string,
  document: PatchmarkRegisteredDocument,
  source: PatchmarkDocumentStoreIdentity["source"],
  now: string
): Promise<void> {
  const metadata = await root.getDirectoryHandle(metadataDirectoryName, { create: true });
  const transactions = await metadata.getDirectoryHandle("transactions", {
    create: true
  });
  const transaction = await transactions.getDirectoryHandle(
    createStableId("document"),
    { create: true }
  );
  const stagedStore = await transaction.getDirectoryHandle("document-store", {
    create: true
  });
  const files = new Map<string, string>([
    [
      "manifest.json",
      `${JSON.stringify({
        schema_version: 1,
        project_name: projectTitle,
        document_file: "document.md",
        created_at: now,
        updated_at: now
      }, null, 2)}\n`
    ],
    ["comments.json", "[]\n"],
    ["patches.json", "[]\n"],
    ["tasks.json", "[]\n"]
  ]);
  await writeDirectorySnapshot(stagedStore, files);
  for (const directoryName of ["versions", "context-packs", "imports", "recovery"]) {
    await stagedStore.getDirectoryHandle(directoryName, { create: true });
  }
  await writeDocumentStoreIdentity(stagedStore, {
    documentId: document.document_id,
    now,
    source
  });
  await verifyDirectorySnapshot(stagedStore, files);
  await verifyDocumentStoreIdentity(stagedStore, document.document_id);

  const finalStore = await createDocumentStoreDirectory(root, document.document_id);
  await writeDirectorySnapshot(finalStore, files);
  for (const directoryName of ["versions", "context-packs", "imports", "recovery"]) {
    await finalStore.getDirectoryHandle(directoryName, { create: true });
  }
  await writeDocumentStoreIdentity(finalStore, {
    documentId: document.document_id,
    now,
    source
  });
  await verifyDirectorySnapshot(finalStore, files);
  await verifyDocumentStoreIdentity(finalStore, document.document_id);
}

async function findPendingCommittedMigration(
  root: ProjectDirectoryHandle,
  projectId: string
): Promise<{
  directory: ProjectDirectoryHandle;
  migrationId: string;
} | null> {
  try {
    const metadata = await root.getDirectoryHandle(metadataDirectoryName);
    const migrations = await metadata.getDirectoryHandle("migrations");
    if (!migrations.entries) {
      return null;
    }
    const candidates: Array<{
      directory: ProjectDirectoryHandle;
      migrationId: string;
      updatedAt: string;
    }> = [];
    for await (const [migrationId, entry] of migrations.entries()) {
      if (entry.kind !== "directory") {
        continue;
      }
      const directory = await migrations.getDirectoryHandle(migrationId);
      const text = await readOptionalText(directory, "journal.json");
      if (!text) {
        continue;
      }
      try {
        const journal = JSON.parse(text) as unknown;
        if (
          isRecord(journal) &&
          journal.project_id === projectId &&
          [
            "manifest_committed",
            "committed_recovery_required",
            "reopened"
          ].includes(String(journal.stage))
        ) {
          candidates.push({
            directory,
            migrationId,
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

async function writeMigrationJournalStage(
  directory: ProjectDirectoryHandle,
  stage: string,
  error?: unknown
): Promise<void> {
  const current = await readOptionalText(directory, "journal.json");
  let journal: Record<string, unknown> = {};
  if (current) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (isRecord(parsed)) {
        journal = parsed;
      }
    } catch {
      journal = {};
    }
  }
  await writeText(
    await directory.getFileHandle("journal.json", { create: true }),
    `${JSON.stringify({
      ...journal,
      stage,
      updated_at: new Date().toISOString(),
      ...(error ? { error: getErrorMessage(error) } : {})
    }, null, 2)}\n`
  );
}

async function createDocumentStoreDirectory(
  root: ProjectDirectoryHandle,
  documentId: string
): Promise<ProjectDirectoryHandle> {
  const metadata = await root.getDirectoryHandle(metadataDirectoryName, { create: true });
  const documents = await metadata.getDirectoryHandle(documentStoreDirectoryName, {
    create: true
  });
  if (await directoryExists(documents, documentId)) {
    throw new Error(`Document store ${documentId} already exists.`);
  }
  return documents.getDirectoryHandle(documentId, { create: true });
}

async function getDocumentStoreDirectory(
  root: ProjectDirectoryHandle,
  documentId: string
): Promise<ProjectDirectoryHandle> {
  const metadata = await root.getDirectoryHandle(metadataDirectoryName);
  const documents = await metadata.getDirectoryHandle(documentStoreDirectoryName);
  return documents.getDirectoryHandle(documentId);
}

async function removeDocumentStore(
  root: ProjectDirectoryHandle,
  documentId: string
): Promise<void> {
  try {
    const metadata = await root.getDirectoryHandle(metadataDirectoryName);
    const documents = await metadata.getDirectoryHandle(documentStoreDirectoryName);
    if (documents.removeEntry) {
      await documents.removeEntry(documentId, { recursive: true });
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function writeDocumentStoreIdentity(
  store: ProjectDirectoryHandle,
  {
    documentId,
    now,
    source
  }: {
    documentId: string;
    now: string;
    source: PatchmarkDocumentStoreIdentity["source"];
  }
): Promise<void> {
  const identity: PatchmarkDocumentStoreIdentity = {
    format: "patchmark-document-store",
    schema_version: 1,
    document_id: documentId,
    created_at: now,
    source
  };
  await writeText(
    await store.getFileHandle(documentStoreIdentityFileName, { create: true }),
    `${JSON.stringify(identity, null, 2)}\n`
  );
}

async function verifyDocumentStoreIdentity(
  store: ProjectDirectoryHandle,
  documentId: string
): Promise<void> {
  const text = await readText(await store.getFileHandle(documentStoreIdentityFileName));
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.document_id !== documentId) {
    throw new Error(`Document store ownership mismatch for ${documentId}.`);
  }
}

async function collectDirectoryFiles(
  directory: ProjectDirectoryHandle,
  options: { excludedRootEntries?: Set<string> } = {},
  prefix = ""
): Promise<Map<string, string>> {
  if (!directory.entries) {
    throw new Error("This filesystem cannot enumerate project metadata safely.");
  }
  const files = new Map<string, string>();
  for await (const [name, entry] of directory.entries()) {
    if (!prefix && options.excludedRootEntries?.has(name)) {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "directory") {
      const nested = await collectDirectoryFiles(
        await directory.getDirectoryHandle(name),
        options,
        relativePath
      );
      for (const [path, text] of nested) {
        files.set(path, text);
      }
    } else {
      files.set(relativePath, await readText(await directory.getFileHandle(name)));
    }
  }
  return files;
}

async function writeDirectorySnapshot(
  directory: ProjectDirectoryHandle,
  files: Map<string, string>
): Promise<void> {
  for (const [path, text] of files) {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (!fileName) {
      throw new Error(`Invalid stored path: ${path}.`);
    }
    let parent = directory;
    for (const segment of segments) {
      parent = await parent.getDirectoryHandle(segment, { create: true });
    }
    await writeText(await parent.getFileHandle(fileName, { create: true }), text);
  }
}

async function verifyDirectorySnapshot(
  directory: ProjectDirectoryHandle,
  expected: Map<string, string>
): Promise<void> {
  for (const [path, text] of expected) {
    const file = await getRelativeFileHandle(directory, path);
    if ((await readText(file)) !== text) {
      throw new Error(`Could not verify migrated metadata file ${path}.`);
    }
  }
}

async function getRelativeFileHandle(
  root: ProjectDirectoryHandle,
  path: string
): Promise<ProjectFileHandle> {
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.includes("\\")
    )
  ) {
    throw new Error(`Invalid internal relative path: ${path}.`);
  }
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error(`Invalid internal relative path: ${path}.`);
  }
  let directory = root;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment);
  }
  return directory.getFileHandle(fileName);
}

function validateLegacySnapshot(snapshot: Map<string, string>): void {
  for (const required of ["manifest.json", "comments.json", "patches.json"]) {
    if (!snapshot.has(required)) {
      throw new Error(`Legacy project is missing .patchmark/${required}.`);
    }
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(snapshot.get("manifest.json") ?? "null") as unknown;
  } catch {
    throw new Error("Legacy .patchmark/manifest.json is invalid JSON.");
  }
  if (!isRecord(manifest) || manifest.schema_version !== 1) {
    throw new Error("Legacy project manifest is invalid.");
  }
  const comments = parseJsonArray(snapshot.get("comments.json") ?? "", "comments.json");
  const patches = parseJsonArray(snapshot.get("patches.json") ?? "", "patches.json");
  assertUniqueObjectIds(comments, "comment");
  assertUniqueObjectIds(patches, "patch");
}

function getJsonArrayCount(snapshot: Map<string, string>, path: string): number {
  return parseJsonArray(snapshot.get(path) ?? "", path).length;
}

function parseJsonArray(text: string, path: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Legacy .patchmark/${path} is invalid JSON.`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`Legacy .patchmark/${path} must contain an array.`);
  }
  return value;
}

function assertUniqueObjectIds(values: unknown[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !isNonEmptyString(value.id)) {
      throw new Error(`Every legacy ${label} must have an ID.`);
    }
    if (ids.has(value.id)) {
      throw new Error(`Duplicate legacy ${label} ID: ${value.id}.`);
    }
    ids.add(value.id);
  }
}

async function isRegularProjectMarkdownFile(
  root: ProjectDirectoryHandle,
  path: string
): Promise<boolean> {
  try {
    const file = await getFileHandleAtPath(root, path);
    await assertRegularNonSymlinkFile(file);
    return true;
  } catch (error) {
    if (isNotFoundError(error) || getErrorMessage(error).includes("symbolic link")) {
      return false;
    }
    throw error;
  }
}

async function assertRegularNonSymlinkFile(file: ProjectFileHandle): Promise<void> {
  if (file.kind && file.kind !== "file") {
    throw new Error("The selected document is not a regular file.");
  }
  if (await file.isSymbolicLink?.()) {
    throw new Error("Symbolic links are not supported as project documents.");
  }
  const value = await file.getFile();
  if (!/\.(md|markdown)$/i.test(value.name)) {
    throw new Error("Choose a .md or .markdown file.");
  }
}

async function getFileHandleAtPath(
  root: ProjectDirectoryHandle,
  path: string,
  options?: { create?: boolean }
): Promise<ProjectFileHandle> {
  const safePath = validateRegisteredDocumentPath(path);
  const segments = safePath.split("/");
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error("Document path is invalid.");
  }
  let directory = root;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, {
      create: options?.create
    });
  }
  return directory.getFileHandle(fileName, options);
}

async function pathExists(root: ProjectDirectoryHandle, path: string): Promise<boolean> {
  try {
    await getFileHandleAtPath(root, path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function directoryExists(
  directory: ProjectDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function assertPathIsUnregistered(
  manifest: PatchmarkProjectManifestV1,
  path: string,
  exceptDocumentId?: string
): void {
  const portablePath = path.toLocaleLowerCase();
  const duplicate = manifest.documents.find(
    (document) =>
      document.document_id !== exceptDocumentId &&
      (document.path === path || document.path.toLocaleLowerCase() === portablePath)
  );
  if (duplicate) {
    throw new Error(`Document path ${path} is already registered.`);
  }
}

function validateDisplayTitle(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error("Document title is required.");
  }
  const title = value.trim();
  if (title.length > 240) {
    throw new Error("Document title must be 240 characters or fewer.");
  }
  return title;
}

function validateRole(value: unknown): PatchmarkDocumentRole {
  if (!(allowedRoles as unknown[]).includes(value)) {
    throw new Error("Document role must be decision, research, evidence, summary, or empty.");
  }
  return value as PatchmarkDocumentRole;
}

function midpoint(left: number, right: number): number {
  const value = left + (right - left) / 2;
  if (!Number.isFinite(value) || value === left || value === right) {
    throw new Error("Document positions need maintenance before this reorder.");
  }
  return value;
}

function createStableId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

async function readOptionalText(
  directory: ProjectDirectoryHandle,
  name: string
): Promise<string | null> {
  try {
    return await readText(await directory.getFileHandle(name));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readText(file: ProjectFileHandle): Promise<string> {
  return (await file.getFile()).text();
}

async function writeText(file: ProjectFileHandle, text: string): Promise<void> {
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function removeEntryIfPresent(
  directory: ProjectDirectoryHandle,
  name: string
): Promise<void> {
  if (!directory.removeEntry) {
    return;
  }
  try {
    await directory.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

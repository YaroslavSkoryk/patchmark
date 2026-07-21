const deviceStateDatabaseName = "patchmark-device-state";
const deviceStateDatabaseVersion = 1;
const projectInstanceStoreName = "project-instances";
const standaloneInstanceStoreName = "standalone-instances";
const recoveryStoreName = "document-recoveries";

export type FileSystemPermissionState = "denied" | "granted" | "prompt";

export type StoredDirectoryHandle = {
  kind?: "directory";
  name: string;
  getDirectoryHandle?: (...args: never[]) => Promise<unknown>;
  getFileHandle?: (...args: never[]) => Promise<unknown>;
  isSameEntry?: (other: StoredDirectoryHandle) => Promise<boolean>;
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemPermissionState>;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemPermissionState>;
};

export type StoredFileHandle = {
  kind?: "file";
  name: string;
  isSameEntry?: (other: StoredFileHandle) => Promise<boolean>;
};

export type LocalProjectInstanceRecord = {
  schema_version: 1;
  local_instance_id: string;
  project_id: string;
  project_title_snapshot: string;
  last_document_id: string;
  last_document_title_snapshot: string;
  last_group_id: string | null;
  last_opened_at: string;
  directory_handle?: StoredDirectoryHandle;
};

export type LocalStandaloneFileRecord = {
  schema_version: 1;
  local_file_id: string;
  file_name_snapshot: string;
  last_opened_at: string;
  file_handle?: StoredFileHandle;
};

export type ProjectDocumentRecoveryRecord = {
  schema_version: 1;
  owner_type: "project_document";
  recovery_id: string;
  local_instance_id: string;
  project_id: string;
  document_id: string;
  project_title_snapshot: string;
  document_title_snapshot: string;
  group_title_snapshot: string | null;
  base_content_sha256: string;
  base_document_generation: number;
  recovered_content_sha256: string;
  markdown: string;
  created_at: string;
  updated_at: string;
};

export type StandaloneDocumentRecoveryRecord = {
  schema_version: 1;
  owner_type: "standalone_file";
  recovery_id: string;
  local_file_id: string;
  file_name_snapshot: string;
  base_content_sha256: string;
  recovered_content_sha256: string;
  markdown: string;
  created_at: string;
  updated_at: string;
};

export type DocumentRecoveryRecord =
  | ProjectDocumentRecoveryRecord
  | StandaloneDocumentRecoveryRecord;

export type RecoveryContentDecision =
  | { kind: "already_saved"; saved_content_sha256: string }
  | { kind: "conflict"; saved_content_sha256: string }
  | { kind: "invalid"; saved_content_sha256: string }
  | { kind: "safe_recovery"; saved_content_sha256: string };

export type EntryIdentityResult = "different" | "same" | "unknown";

export interface DeviceRecoveryStorage {
  deleteProjectInstance(localInstanceId: string): Promise<void>;
  deleteRecovery(recoveryId: string): Promise<void>;
  deleteStandaloneInstance(localFileId: string): Promise<void>;
  listProjectInstances(): Promise<LocalProjectInstanceRecord[]>;
  listRecoveries(): Promise<DocumentRecoveryRecord[]>;
  listStandaloneInstances(): Promise<LocalStandaloneFileRecord[]>;
  putProjectInstance(record: LocalProjectInstanceRecord): Promise<void>;
  putRecovery(record: DocumentRecoveryRecord): Promise<void>;
  putStandaloneInstance(record: LocalStandaloneFileRecord): Promise<void>;
}

let deviceRecoveryStorageOverride: DeviceRecoveryStorage | null = null;
const recoveryMutationQueues = new Map<string, Promise<void>>();

export function setDeviceRecoveryStorageForTests(
  storage: DeviceRecoveryStorage | null
): void {
  deviceRecoveryStorageOverride = storage;
  recoveryMutationQueues.clear();
}

export function createMemoryDeviceRecoveryStorage(): DeviceRecoveryStorage {
  const projectInstances = new Map<string, LocalProjectInstanceRecord>();
  const standaloneInstances = new Map<string, LocalStandaloneFileRecord>();
  const recoveries = new Map<string, DocumentRecoveryRecord>();

  return {
    async deleteProjectInstance(localInstanceId) {
      projectInstances.delete(localInstanceId);
    },
    async deleteRecovery(recoveryId) {
      recoveries.delete(recoveryId);
    },
    async deleteStandaloneInstance(localFileId) {
      standaloneInstances.delete(localFileId);
    },
    async listProjectInstances() {
      return [...projectInstances.values()];
    },
    async listRecoveries() {
      return [...recoveries.values()];
    },
    async listStandaloneInstances() {
      return [...standaloneInstances.values()];
    },
    async putProjectInstance(record) {
      projectInstances.set(record.local_instance_id, record);
    },
    async putRecovery(record) {
      recoveries.set(record.recovery_id, record);
    },
    async putStandaloneInstance(record) {
      standaloneInstances.set(record.local_file_id, record);
    }
  };
}

export function createLocalProjectInstanceId(): string {
  return createDeviceLocalId("local_project");
}

export function createLocalStandaloneFileId(): string {
  return createDeviceLocalId("local_file");
}

export function getProjectDocumentRecoveryId({
  documentId,
  localInstanceId,
  projectId
}: {
  documentId: string;
  localInstanceId: string;
  projectId: string;
}): string {
  return `project:${encodeURIComponent(localInstanceId)}:${encodeURIComponent(
    projectId
  )}:${encodeURIComponent(documentId)}`;
}

export function getStandaloneDocumentRecoveryId(localFileId: string): string {
  return `standalone:${encodeURIComponent(localFileId)}`;
}

export async function createContentSha256(content: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("SHA-256 is unavailable in this browser.");
  }
  const digest = await cryptoApi.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function evaluateRecoveryContent(
  recovery: DocumentRecoveryRecord,
  savedMarkdown: string
): Promise<RecoveryContentDecision> {
  const savedContentSha256 = await createContentSha256(savedMarkdown);
  const actualRecoveredSha256 = await createContentSha256(recovery.markdown);

  if (actualRecoveredSha256 !== recovery.recovered_content_sha256) {
    return { kind: "invalid", saved_content_sha256: savedContentSha256 };
  }
  if (savedContentSha256 === recovery.recovered_content_sha256) {
    return { kind: "already_saved", saved_content_sha256: savedContentSha256 };
  }
  if (savedContentSha256 === recovery.base_content_sha256) {
    return { kind: "safe_recovery", saved_content_sha256: savedContentSha256 };
  }
  return { kind: "conflict", saved_content_sha256: savedContentSha256 };
}

export async function rememberProjectInstance({
  directoryHandle,
  documentId,
  documentTitle,
  groupId,
  localInstanceId,
  projectId,
  projectTitle
}: {
  directoryHandle?: StoredDirectoryHandle;
  documentId: string;
  documentTitle: string;
  groupId: string | null;
  localInstanceId: string;
  projectId: string;
  projectTitle: string;
}): Promise<LocalProjectInstanceRecord> {
  const storage = getDeviceRecoveryStorage();
  const existing = (await storage.listProjectInstances()).find(
    (candidate) => candidate.local_instance_id === localInstanceId
  );
  const record: LocalProjectInstanceRecord = {
    schema_version: 1,
    local_instance_id: localInstanceId,
    project_id: projectId,
    project_title_snapshot: projectTitle,
    last_document_id: documentId,
    last_document_title_snapshot: documentTitle,
    last_group_id: groupId,
    last_opened_at: new Date().toISOString(),
    directory_handle: directoryHandle ?? existing?.directory_handle
  };

  try {
    await storage.putProjectInstance(record);
    return record;
  } catch (error) {
    if (!record.directory_handle || !isHandleCloneError(error)) {
      throw error;
    }
    const recordWithoutHandle = { ...record };
    delete recordWithoutHandle.directory_handle;
    await storage.putProjectInstance(recordWithoutHandle);
    return recordWithoutHandle;
  }
}

export async function readMostRecentProjectInstance(): Promise<LocalProjectInstanceRecord | null> {
  return (await getDeviceRecoveryStorage().listProjectInstances())
    .filter(isValidProjectInstance)
    .sort(
      (left, right) =>
        Date.parse(right.last_opened_at) - Date.parse(left.last_opened_at)
    )[0] ?? null;
}

export async function readProjectInstance(
  localInstanceId: string
): Promise<LocalProjectInstanceRecord | null> {
  return (await getDeviceRecoveryStorage().listProjectInstances()).find(
    (candidate) =>
      candidate.local_instance_id === localInstanceId &&
      isValidProjectInstance(candidate)
  ) ?? null;
}

export async function findProjectInstanceForDirectory({
  directoryHandle,
  projectId
}: {
  directoryHandle: StoredDirectoryHandle;
  projectId: string;
}): Promise<LocalProjectInstanceRecord | null> {
  const candidates = (await getDeviceRecoveryStorage().listProjectInstances())
    .filter(
      (candidate) =>
        candidate.project_id === projectId && candidate.directory_handle
    )
    .sort(
      (left, right) =>
        Date.parse(right.last_opened_at) - Date.parse(left.last_opened_at)
    );

  for (const candidate of candidates) {
    if (
      candidate.directory_handle &&
      (await compareEntryIdentity(candidate.directory_handle, directoryHandle)) ===
        "same"
    ) {
      return candidate;
    }
  }
  return null;
}

export async function rememberStandaloneFileInstance({
  fileHandle,
  fileName,
  localFileId
}: {
  fileHandle?: StoredFileHandle;
  fileName: string;
  localFileId: string;
}): Promise<LocalStandaloneFileRecord> {
  const storage = getDeviceRecoveryStorage();
  const existing = (await storage.listStandaloneInstances()).find(
    (candidate) => candidate.local_file_id === localFileId
  );
  const record: LocalStandaloneFileRecord = {
    schema_version: 1,
    local_file_id: localFileId,
    file_name_snapshot: fileName,
    last_opened_at: new Date().toISOString(),
    file_handle: fileHandle ?? existing?.file_handle
  };
  try {
    await storage.putStandaloneInstance(record);
    return record;
  } catch (error) {
    if (!record.file_handle || !isHandleCloneError(error)) {
      throw error;
    }
    const recordWithoutHandle = { ...record };
    delete recordWithoutHandle.file_handle;
    await storage.putStandaloneInstance(recordWithoutHandle);
    return recordWithoutHandle;
  }
}

export async function findStandaloneInstanceForFile(
  fileHandle: StoredFileHandle
): Promise<LocalStandaloneFileRecord | null> {
  const candidates = (await getDeviceRecoveryStorage().listStandaloneInstances())
    .filter((candidate) => candidate.file_handle)
    .sort(
      (left, right) =>
        Date.parse(right.last_opened_at) - Date.parse(left.last_opened_at)
    );
  for (const candidate of candidates) {
    if (
      candidate.file_handle &&
      (await compareEntryIdentity(candidate.file_handle, fileHandle)) === "same"
    ) {
      return candidate;
    }
  }
  return null;
}

export async function saveProjectDocumentRecovery({
  baseDocumentGeneration,
  baseMarkdown,
  documentId,
  documentTitle,
  groupTitle,
  localInstanceId,
  markdown,
  projectId,
  projectTitle
}: {
  baseDocumentGeneration: number;
  baseMarkdown: string;
  documentId: string;
  documentTitle: string;
  groupTitle: string | null;
  localInstanceId: string;
  markdown: string;
  projectId: string;
  projectTitle: string;
}): Promise<ProjectDocumentRecoveryRecord> {
  const recoveryId = getProjectDocumentRecoveryId({
    documentId,
    localInstanceId,
    projectId
  });
  const [baseContentSha256, recoveredContentSha256, existing] = await Promise.all([
    createContentSha256(baseMarkdown),
    createContentSha256(markdown),
    readRecovery(recoveryId)
  ]);
  const now = new Date().toISOString();
  const record: ProjectDocumentRecoveryRecord = {
    schema_version: 1,
    owner_type: "project_document",
    recovery_id: recoveryId,
    local_instance_id: localInstanceId,
    project_id: projectId,
    document_id: documentId,
    project_title_snapshot: projectTitle,
    document_title_snapshot: documentTitle,
    group_title_snapshot: groupTitle,
    base_content_sha256: baseContentSha256,
    base_document_generation: baseDocumentGeneration,
    recovered_content_sha256: recoveredContentSha256,
    markdown,
    created_at:
      existing?.owner_type === "project_document" ? existing.created_at : now,
    updated_at: now
  };
  await enqueueRecoveryMutation(recoveryId, () =>
    getDeviceRecoveryStorage().putRecovery(record)
  );
  return record;
}

export async function saveStandaloneDocumentRecovery({
  baseMarkdown,
  fileName,
  localFileId,
  markdown
}: {
  baseMarkdown: string;
  fileName: string;
  localFileId: string;
  markdown: string;
}): Promise<StandaloneDocumentRecoveryRecord> {
  const recoveryId = getStandaloneDocumentRecoveryId(localFileId);
  const [baseContentSha256, recoveredContentSha256, existing] = await Promise.all([
    createContentSha256(baseMarkdown),
    createContentSha256(markdown),
    readRecovery(recoveryId)
  ]);
  const now = new Date().toISOString();
  const record: StandaloneDocumentRecoveryRecord = {
    schema_version: 1,
    owner_type: "standalone_file",
    recovery_id: recoveryId,
    local_file_id: localFileId,
    file_name_snapshot: fileName,
    base_content_sha256: baseContentSha256,
    recovered_content_sha256: recoveredContentSha256,
    markdown,
    created_at:
      existing?.owner_type === "standalone_file" ? existing.created_at : now,
    updated_at: now
  };
  await enqueueRecoveryMutation(recoveryId, () =>
    getDeviceRecoveryStorage().putRecovery(record)
  );
  return record;
}

export async function readRecovery(
  recoveryId: string
): Promise<DocumentRecoveryRecord | null> {
  return (await getDeviceRecoveryStorage().listRecoveries()).find(
    (candidate) =>
      candidate.recovery_id === recoveryId && isValidRecovery(candidate)
  ) ?? null;
}

export async function listProjectDocumentRecoveries({
  localInstanceId,
  projectId
}: {
  localInstanceId: string;
  projectId: string;
}): Promise<ProjectDocumentRecoveryRecord[]> {
  return (await getDeviceRecoveryStorage().listRecoveries())
    .filter(
      (candidate): candidate is ProjectDocumentRecoveryRecord =>
        candidate.owner_type === "project_document" &&
        candidate.local_instance_id === localInstanceId &&
        candidate.project_id === projectId &&
        isValidRecovery(candidate)
    )
    .sort(
      (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
    );
}

export async function deleteDocumentRecovery(recoveryId: string): Promise<void> {
  await enqueueRecoveryMutation(recoveryId, () =>
    getDeviceRecoveryStorage().deleteRecovery(recoveryId)
  );
}

export async function deleteProjectInstanceRecoveryData(
  localInstanceId: string
): Promise<void> {
  const storage = getDeviceRecoveryStorage();
  const recoveries = (await storage.listRecoveries()).filter(
    (recovery) =>
      recovery.owner_type === "project_document" &&
      recovery.local_instance_id === localInstanceId
  );
  await Promise.all(
    recoveries.map((recovery) => deleteDocumentRecovery(recovery.recovery_id))
  );
  await storage.deleteProjectInstance(localInstanceId);
}

export async function getDirectoryPermission(
  directoryHandle: StoredDirectoryHandle | undefined
): Promise<FileSystemPermissionState | "unavailable"> {
  if (!directoryHandle?.queryPermission) {
    return directoryHandle ? "unavailable" : "unavailable";
  }
  try {
    return await directoryHandle.queryPermission({ mode: "readwrite" });
  } catch {
    return "unavailable";
  }
}

export function isUsableStoredDirectoryHandle(
  directoryHandle: StoredDirectoryHandle | undefined
): directoryHandle is StoredDirectoryHandle & {
  getDirectoryHandle: (...args: never[]) => Promise<unknown>;
  getFileHandle: (...args: never[]) => Promise<unknown>;
} {
  return (
    typeof directoryHandle?.getDirectoryHandle === "function" &&
    typeof directoryHandle.getFileHandle === "function"
  );
}

export async function requestDirectoryPermission(
  directoryHandle: StoredDirectoryHandle
): Promise<FileSystemPermissionState | "unavailable"> {
  if (!directoryHandle.requestPermission) {
    return "unavailable";
  }
  try {
    return await directoryHandle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function compareEntryIdentity(
  left: StoredDirectoryHandle | StoredFileHandle,
  right: StoredDirectoryHandle | StoredFileHandle
): Promise<EntryIdentityResult> {
  try {
    if (left.isSameEntry) {
      return (await left.isSameEntry(right as never)) ? "same" : "different";
    }
    if (right.isSameEntry) {
      return (await right.isSameEntry(left as never)) ? "same" : "different";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function getDeviceRecoveryStorage(): DeviceRecoveryStorage {
  if (deviceRecoveryStorageOverride) {
    return deviceRecoveryStorageOverride;
  }
  return new IndexedDbDeviceRecoveryStorage();
}

class IndexedDbDeviceRecoveryStorage implements DeviceRecoveryStorage {
  async deleteProjectInstance(localInstanceId: string): Promise<void> {
    await deleteIndexedDbValue(projectInstanceStoreName, localInstanceId);
  }

  async deleteRecovery(recoveryId: string): Promise<void> {
    await deleteIndexedDbValue(recoveryStoreName, recoveryId);
  }

  async deleteStandaloneInstance(localFileId: string): Promise<void> {
    await deleteIndexedDbValue(standaloneInstanceStoreName, localFileId);
  }

  async listProjectInstances(): Promise<LocalProjectInstanceRecord[]> {
    return getAllIndexedDbValues<LocalProjectInstanceRecord>(
      projectInstanceStoreName
    );
  }

  async listRecoveries(): Promise<DocumentRecoveryRecord[]> {
    return getAllIndexedDbValues<DocumentRecoveryRecord>(recoveryStoreName);
  }

  async listStandaloneInstances(): Promise<LocalStandaloneFileRecord[]> {
    return getAllIndexedDbValues<LocalStandaloneFileRecord>(
      standaloneInstanceStoreName
    );
  }

  async putProjectInstance(record: LocalProjectInstanceRecord): Promise<void> {
    await putIndexedDbValue(projectInstanceStoreName, record);
  }

  async putRecovery(record: DocumentRecoveryRecord): Promise<void> {
    await putIndexedDbValue(recoveryStoreName, record);
  }

  async putStandaloneInstance(record: LocalStandaloneFileRecord): Promise<void> {
    await putIndexedDbValue(standaloneInstanceStoreName, record);
  }
}

async function openDeviceStateDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Device-local recovery storage is unavailable.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      deviceStateDatabaseName,
      deviceStateDatabaseVersion
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(projectInstanceStoreName)) {
        database.createObjectStore(projectInstanceStoreName, {
          keyPath: "local_instance_id"
        });
      }
      if (!database.objectStoreNames.contains(standaloneInstanceStoreName)) {
        database.createObjectStore(standaloneInstanceStoreName, {
          keyPath: "local_file_id"
        });
      }
      if (!database.objectStoreNames.contains(recoveryStoreName)) {
        database.createObjectStore(recoveryStoreName, {
          keyPath: "recovery_id"
        });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function getAllIndexedDbValues<T>(storeName: string): Promise<T[]> {
  const database = await openDeviceStateDatabase();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    return await readIndexedDbRequest<T[]>(request);
  } finally {
    database.close();
  }
}

async function putIndexedDbValue(storeName: string, value: unknown): Promise<void> {
  const database = await openDeviceStateDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await waitForIndexedDbTransaction(transaction);
  } finally {
    database.close();
  }
}

async function deleteIndexedDbValue(
  storeName: string,
  key: string
): Promise<void> {
  const database = await openDeviceStateDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await waitForIndexedDbTransaction(transaction);
  } finally {
    database.close();
  }
}

function readIndexedDbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

function enqueueRecoveryMutation(
  recoveryId: string,
  mutation: () => Promise<void>
): Promise<void> {
  const previous = recoveryMutationQueues.get(recoveryId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  recoveryMutationQueues.set(recoveryId, next);
  return next.finally(() => {
    if (recoveryMutationQueues.get(recoveryId) === next) {
      recoveryMutationQueues.delete(recoveryId);
    }
  });
}

function createDeviceLocalId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function isHandleCloneError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "DataCloneError" || error.name === "NotSupportedError")
  );
}

function isValidProjectInstance(
  value: LocalProjectInstanceRecord
): value is LocalProjectInstanceRecord {
  return (
    value?.schema_version === 1 &&
    typeof value.local_instance_id === "string" &&
    typeof value.project_id === "string" &&
    typeof value.project_title_snapshot === "string" &&
    typeof value.last_document_id === "string" &&
    typeof value.last_document_title_snapshot === "string" &&
    (value.last_group_id === null || typeof value.last_group_id === "string") &&
    typeof value.last_opened_at === "string" &&
    !Number.isNaN(Date.parse(value.last_opened_at))
  );
}

function isValidRecovery(
  value: DocumentRecoveryRecord
): value is DocumentRecoveryRecord {
  if (
    !value ||
    value.schema_version !== 1 ||
    typeof value.recovery_id !== "string" ||
    typeof value.base_content_sha256 !== "string" ||
    typeof value.recovered_content_sha256 !== "string" ||
    typeof value.markdown !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    return false;
  }
  if (value.owner_type === "project_document") {
    return (
      typeof value.local_instance_id === "string" &&
      typeof value.project_id === "string" &&
      typeof value.document_id === "string" &&
      typeof value.project_title_snapshot === "string" &&
      typeof value.document_title_snapshot === "string" &&
      (value.group_title_snapshot === null ||
        typeof value.group_title_snapshot === "string") &&
      Number.isInteger(value.base_document_generation) &&
      value.base_document_generation >= 0
    );
  }
  return (
    value.owner_type === "standalone_file" &&
    typeof value.local_file_id === "string" &&
    typeof value.file_name_snapshot === "string"
  );
}

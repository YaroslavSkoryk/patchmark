import type {
  RewriteRecoveryRecord,
  RewriteSession
} from "./rewrite-session-types.ts";

const databaseName = "patchmark-rewrite-state";
const databaseVersion = 1;
const storeName = "rewrite-sessions";

type PersistedRewriteValue =
  | RewriteRecoveryRecord
  | (Record<string, unknown> & { storage_key: string });

export interface RewriteSessionStorage {
  delete(storageKey: string): Promise<void>;
  list(): Promise<PersistedRewriteValue[]>;
  put(value: PersistedRewriteValue): Promise<void>;
}

let storageOverride: RewriteSessionStorage | null = null;
const mutationQueues = new Map<string, Promise<void>>();

export function setRewriteSessionStorageForTests(
  storage: RewriteSessionStorage | null
): void {
  storageOverride = storage;
  mutationQueues.clear();
}

export function createMemoryRewriteSessionStorage(): RewriteSessionStorage {
  const values = new Map<string, PersistedRewriteValue>();
  return {
    async delete(storageKey) {
      values.delete(storageKey);
    },
    async list() {
      return [...values.values()].map((value) => structuredClone(value));
    },
    async put(value) {
      values.set(value.storage_key, structuredClone(value));
    }
  };
}

export function createRewriteSessionStorageKey(session: Pick<
  RewriteSession,
  "document_id" | "local_project_instance_id" | "project_id" | "rewrite_session_id"
>): string {
  return JSON.stringify([
    "rewrite_session",
    session.local_project_instance_id,
    session.project_id,
    session.document_id,
    session.rewrite_session_id
  ]);
}

export function createRewriteRecoveryStorageKey(session: Pick<
  RewriteSession,
  "document_id" | "local_project_instance_id" | "project_id" | "rewrite_session_id"
>): string {
  return JSON.stringify([
    "rewrite_recovery",
    session.local_project_instance_id,
    session.project_id,
    session.document_id,
    session.rewrite_session_id
  ]);
}

export async function saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision,
  recoveryRevision,
  session,
  syncState = "recovery_only"
}: {
  basedOnAuthoritativeRevision: number;
  recoveryRevision: number;
  session: RewriteSession;
  syncState?: RewriteRecoveryRecord["sync_state"];
}): Promise<RewriteRecoveryRecord> {
  assertValidCurrentSession(session);
  const storageKey = createRewriteRecoveryStorageKey(session);
  const record: RewriteRecoveryRecord = {
    schema_version: 1,
    record_kind: "rewrite_recovery",
    sync_state: syncState,
    storage_key: storageKey,
    rewrite_session_id: session.rewrite_session_id,
    local_project_instance_id: session.local_project_instance_id,
    project_id: session.project_id,
    document_id: session.document_id,
    based_on_authoritative_revision: basedOnAuthoritativeRevision,
    recovery_revision: recoveryRevision,
    session,
    saved_at: new Date().toISOString()
  };
  await enqueue(createRewriteSessionOwnerKey(session), () =>
    getStorage().put(record)
  );
  return record;
}

export async function readRewriteRecoveryCopies({
  documentId,
  localProjectInstanceId,
  projectId
}: {
  documentId: string;
  localProjectInstanceId: string;
  projectId: string;
}): Promise<RewriteRecoveryRecord[]> {
  return (await getStorage().list())
    .filter(isRewriteRecoveryRecord)
    .filter(
      (record) =>
        record.local_project_instance_id === localProjectInstanceId &&
        record.project_id === projectId &&
        record.document_id === documentId
    )
    .sort((left, right) => right.recovery_revision - left.recovery_revision);
}

export async function discardRewriteRecoveryCopy(
  session: Pick<
    RewriteSession,
    "document_id" | "local_project_instance_id" | "project_id" | "rewrite_session_id"
  >
): Promise<void> {
  const storageKey = createRewriteRecoveryStorageKey(session);
  await enqueue(createRewriteSessionOwnerKey(session), () =>
    getStorage().delete(storageKey)
  );
}

export async function discardRewriteRecoveryCopyIfRevision({
  recoveryRevision,
  session
}: {
  recoveryRevision: number;
  session: Pick<
    RewriteSession,
    "document_id" | "local_project_instance_id" | "project_id" | "rewrite_session_id"
  >;
}): Promise<boolean> {
  const storageKey = createRewriteRecoveryStorageKey(session);
  return enqueueResult(createRewriteSessionOwnerKey(session), async () => {
    const current = (await getStorage().list())
      .filter(isRewriteRecoveryRecord)
      .find((record) => record.storage_key === storageKey);
    if (!current || current.recovery_revision !== recoveryRevision) {
      return false;
    }
    await getStorage().delete(storageKey);
    return true;
  });
}

export async function readLegacyRewriteSessions({
  documentId,
  localProjectInstanceId,
  projectId
}: {
  documentId: string;
  localProjectInstanceId: string;
  projectId: string;
}): Promise<RewriteSession[]> {
  return (await getStorage().list())
    .filter((value) => !isRewriteRecoveryRecord(value))
    .map(normalizeLegacyRewriteSession)
    .filter((session): session is RewriteSession => Boolean(session))
    .filter(
      (session) =>
        session.local_project_instance_id === localProjectInstanceId &&
        session.project_id === projectId &&
        session.document_id === documentId
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function discardLegacyRewriteSession(
  session: Pick<
    RewriteSession,
    "document_id" | "local_project_instance_id" | "project_id" | "rewrite_session_id"
  >
): Promise<void> {
  const storageKey = createRewriteSessionStorageKey(session);
  await enqueue(createRewriteSessionOwnerKey(session), () =>
    getStorage().delete(storageKey)
  );
}

export async function saveLegacyRewriteSessionForTests(
  session: RewriteSession
): Promise<void> {
  assertValidCurrentSession(session);
  const storageKey = createRewriteSessionStorageKey(session);
  const legacy = {
    ...session,
    storage_key: storageKey
  } as Record<string, unknown> & { storage_key: string };
  delete legacy.authoritative_revision;
  delete legacy.authoritative_generation;
  delete legacy.stale_reference;
  await enqueue(createRewriteSessionOwnerKey(session), () =>
    getStorage().put(legacy)
  );
}

function getStorage(): RewriteSessionStorage {
  return storageOverride ?? new IndexedDbRewriteSessionStorage();
}

class IndexedDbRewriteSessionStorage implements RewriteSessionStorage {
  async delete(storageKey: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(storageKey);
      await waitForTransaction(transaction);
    } finally {
      database.close();
    }
  }

  async list(): Promise<PersistedRewriteValue[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      return await readRequest(request);
    } finally {
      database.close();
    }
  }

  async put(value: PersistedRewriteValue): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      await waitForTransaction(transaction);
    } finally {
      database.close();
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Browser recovery storage is unavailable.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "storage_key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

function enqueue(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutationQueues.set(key, next);
  return next.finally(() => {
    if (mutationQueues.get(key) === next) {
      mutationQueues.delete(key);
    }
  });
}

function enqueueResult<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let resultPromise!: Promise<T>;
  const next = previous.catch(() => undefined).then(() => {
    resultPromise = operation();
    return resultPromise.then(() => undefined);
  });
  mutationQueues.set(key, next);
  return next
    .then(() => resultPromise)
    .finally(() => {
      if (mutationQueues.get(key) === next) {
        mutationQueues.delete(key);
      }
    });
}

function createRewriteSessionOwnerKey(session: Pick<
  RewriteSession,
  "document_id" | "local_project_instance_id" | "project_id"
>): string {
  return JSON.stringify([
    "rewrite_session_owner",
    session.local_project_instance_id,
    session.project_id,
    session.document_id
  ]);
}

function normalizeLegacyRewriteSession(value: PersistedRewriteValue): RewriteSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const record: Record<string, unknown> = value;
  const candidate = {
    ...record,
    status: "draft" as const,
    authoritative_revision: 0,
    authoritative_generation: isNonNegativeInteger(record.base_document_generation)
      ? record.base_document_generation
      : 0,
    stale_reference: false
  };
  return isValidCurrentSession(candidate) ? candidate : null;
}

function isRewriteRecoveryRecord(value: PersistedRewriteValue): value is RewriteRecoveryRecord {
  return Boolean(
    isRecord(value) &&
      value.schema_version === 1 &&
      value.record_kind === "rewrite_recovery" &&
      (value.sync_state === "recovery_only" || value.sync_state === "synchronized") &&
      typeof value.storage_key === "string" &&
      isNonNegativeInteger(value.based_on_authoritative_revision) &&
      isNonNegativeInteger(value.recovery_revision) &&
      typeof value.saved_at === "string" &&
      isValidCurrentSession(value.session)
  );
}

function assertValidCurrentSession(session: RewriteSession): void {
  if (!isValidCurrentSession(session)) {
    throw new Error("The Human Rewrite session is invalid and was not saved.");
  }
}

function isValidCurrentSession(value: unknown): value is RewriteSession {
  if (!isRecord(value)) {
    return false;
  }
  return Boolean(
    value.schema_version === 1 &&
      value.status === "draft" &&
      typeof value.rewrite_session_id === "string" &&
      typeof value.local_project_instance_id === "string" &&
      typeof value.project_id === "string" &&
      typeof value.document_id === "string" &&
      typeof value.base_text_sha256 === "string" &&
      typeof value.human_draft_sha256 === "string" &&
      typeof value.base_text === "string" &&
      typeof value.human_draft === "string" &&
      isNonNegativeInteger(value.authoritative_revision) &&
      isNonNegativeInteger(value.authoritative_generation) &&
      typeof value.stale_reference === "boolean" &&
      Array.isArray(value.review_rounds) &&
      Array.isArray(value.reference_history) &&
      typeof value.updated_at === "string" &&
      !Number.isNaN(Date.parse(value.updated_at))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

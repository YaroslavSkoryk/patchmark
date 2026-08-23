import { parseEntityId, type DeviceId, type ProjectId } from "../identities.ts";
import {
  evaluateCompareAndAdvanceStream,
  parseDeviceStreamReservation,
  parseDeviceStreamState,
  type CompareAndAdvanceStreamInput,
  type DeviceStreamCoordinationStore,
  type DeviceStreamReservation,
  type DeviceStreamState,
  type StreamCasResult
} from "./coordination.ts";
import { parseHc2DigestId, type PortableBatchId } from "./identities.ts";
import { HC2_COORDINATION_SCHEMA_VERSION } from "./versions.ts";

const databaseVersion = 1;
const stores = Object.freeze({
  streams: "device_streams",
  reservations: "pending_reservations",
  keyContinuity: "key_continuity",
  batchCatalog: "portable_batch_catalog",
  folderBindings: "folder_bindings",
  recovery: "recovery_status",
  diagnostics: "diagnostics"
});

export const hc2CoordinationDatabaseSchema = Object.freeze({
  version: databaseVersion,
  stores: Object.freeze(Object.values(stores).sort())
});

export type Hc2CoordinationOpenResult =
  | Readonly<{ status: "opened" }>
  | Readonly<{ status: "blocked_by_stale_connection" | "failed"; reason: string }>;

export type Hc2KeyContinuityRecord = Readonly<{
  project_id: ProjectId;
  device_id: DeviceId;
  signing_key_handle: CryptoKey;
  recipient_key_handle: CryptoKey;
  local_kek_handle: CryptoKey;
  status: "active" | "retired";
}>;

export type Hc2FolderBindingRecord = Readonly<{
  project_id: ProjectId;
  directory_handle: unknown;
  observed_permission: "denied" | "granted" | "prompt" | "unknown";
}>;

export type Hc2RecoveryStatusRecord = Readonly<{
  project_id: ProjectId;
  status: "ambiguous" | "recovery_required" | "verified";
  detail_code: string;
}>;

export type Hc2DiagnosticRecord = Readonly<{
  project_id: ProjectId;
  diagnostic_id: string;
  code: string;
  safe_detail: string;
}>;

export interface Hc2CoordinationAdminStore extends DeviceStreamCoordinationStore {
  initializeDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState>;
  readDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState | null>;
  markContinuityAmbiguous(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState>;
  retireDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState>;
  putKeyContinuity(record: Hc2KeyContinuityRecord): Promise<void>;
  readKeyContinuity(projectId: ProjectId, deviceId: DeviceId): Promise<Hc2KeyContinuityRecord | null>;
  putFolderBinding(record: Hc2FolderBindingRecord): Promise<void>;
  putRecoveryStatus(record: Hc2RecoveryStatusRecord): Promise<void>;
  putDiagnostic(record: Hc2DiagnosticRecord): Promise<void>;
  replaceVerifiedBatchCatalog(projectId: ProjectId, batchIds: readonly PortableBatchId[]): Promise<void>;
  readVerifiedBatchCatalog(projectId: ProjectId): Promise<readonly PortableBatchId[]>;
}

export class Hc2InMemoryCoordinationStore implements Hc2CoordinationAdminStore {
  readonly #streams = new Map<string, DeviceStreamState>();
  readonly #keys = new Map<string, Hc2KeyContinuityRecord>();
  readonly #folders = new Map<string, Hc2FolderBindingRecord>();
  readonly #recovery = new Map<string, Hc2RecoveryStatusRecord>();
  readonly #diagnostics = new Map<string, Hc2DiagnosticRecord>();
  readonly #catalog = new Map<string, readonly PortableBatchId[]>();

  async initializeDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    const key = streamKey(projectId, deviceId);
    const existing = this.#streams.get(key);
    if (existing) return copyState(existing);
    const state = initialState(projectId, deviceId);
    this.#streams.set(key, state);
    return copyState(state);
  }

  async readDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState | null> {
    const value = this.#streams.get(streamKey(projectId, deviceId));
    return value ? copyState(value) : null;
  }

  async compareAndAdvanceStream(input: CompareAndAdvanceStreamInput): Promise<StreamCasResult> {
    const key = streamKey(input.project_id, input.device_id);
    const current = this.#streams.get(key);
    if (!current) return Object.freeze({ status: "failed", code: "invalid_input" });
    const result = evaluateCompareAndAdvanceStream(current, input);
    if (result.status === "advanced") this.#streams.set(key, copyState(result.state));
    return copyCasResult(result);
  }

  async finalizeCommittedBatch(input: Parameters<DeviceStreamCoordinationStore["finalizeCommittedBatch"]>[0]): ReturnType<DeviceStreamCoordinationStore["finalizeCommittedBatch"]> {
    const key = streamKey(input.project_id, input.device_id);
    const current = this.#streams.get(key);
    if (!current) return Object.freeze({ status: "failed", code: "reservation_mismatch" });
    const outcome = finalizeState(current, input);
    if (outcome.status === "finalized") this.#streams.set(key, copyState(outcome.state));
    return outcome;
  }

  async repairFromPortableBatch(input: Parameters<DeviceStreamCoordinationStore["repairFromPortableBatch"]>[0]): ReturnType<DeviceStreamCoordinationStore["repairFromPortableBatch"]> {
    const key = streamKey(input.project_id, input.device_id);
    const current = this.#streams.get(key) ?? initialState(input.project_id, input.device_id);
    const outcome = repairState(current, input);
    if (outcome.status === "repaired") this.#streams.set(key, copyState(outcome.state));
    return outcome;
  }

  async markContinuityAmbiguous(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    const key = streamKey(projectId, deviceId);
    const current = this.#streams.get(key) ?? initialState(projectId, deviceId);
    const state = parseDeviceStreamState({ ...current, generation: current.generation + BigInt(1), continuity: "ambiguous" });
    this.#streams.set(key, state);
    return copyState(state);
  }

  async retireDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    const key = streamKey(projectId, deviceId);
    const current = this.#streams.get(key) ?? initialState(projectId, deviceId);
    const state = parseDeviceStreamState({ ...current, generation: current.generation + BigInt(1), pending_reservation: null, continuity: "ambiguous" });
    this.#streams.set(key, state);
    return copyState(state);
  }

  async putKeyContinuity(record: Hc2KeyContinuityRecord): Promise<void> { this.#keys.set(streamKey(record.project_id, record.device_id), copyKeyRecord(record)); }
  async readKeyContinuity(projectId: ProjectId, deviceId: DeviceId): Promise<Hc2KeyContinuityRecord | null> { return this.#keys.get(streamKey(projectId, deviceId)) ?? null; }
  async putFolderBinding(record: Hc2FolderBindingRecord): Promise<void> { const parsed = copyFolderBinding(record); this.#folders.set(parsed.project_id, parsed); }
  async putRecoveryStatus(record: Hc2RecoveryStatusRecord): Promise<void> { const parsed = copyRecoveryStatus(record); this.#recovery.set(parsed.project_id, parsed); }
  async putDiagnostic(record: Hc2DiagnosticRecord): Promise<void> { const parsed = copyDiagnostic(record); this.#diagnostics.set(`${parsed.project_id}\u0000${parsed.diagnostic_id}`, parsed); }
  async replaceVerifiedBatchCatalog(projectId: ProjectId, batchIds: readonly PortableBatchId[]): Promise<void> { this.#catalog.set(parseEntityId("project", projectId), parseBatchIds(batchIds)); }
  async readVerifiedBatchCatalog(projectId: ProjectId): Promise<readonly PortableBatchId[]> { return this.#catalog.get(parseEntityId("project", projectId)) ?? Object.freeze([]); }
}

/**
 * IndexedDB implementation. Every mutation is a single, short, strict
 * transaction containing only deterministic validation and IDB requests.
 */
export class Hc2IndexedDbCoordinationStore implements Hc2CoordinationAdminStore {
  readonly #factory: IDBFactory;
  readonly #databaseName: string;
  #database: IDBDatabase | null = null;

  constructor(options: Readonly<{ indexed_db: IDBFactory; database_name: string }>) {
    if (!options?.indexed_db || typeof options.database_name !== "string" || !options.database_name) {
      throw new Error("IndexedDB coordination requires an injected factory and explicit database name.");
    }
    this.#factory = options.indexed_db;
    this.#databaseName = safeKey(options.database_name);
  }

  async open(): Promise<Hc2CoordinationOpenResult> {
    if (this.#database) return Object.freeze({ status: "opened" });
    return new Promise((resolve) => {
      const request = this.#factory.open(this.#databaseName, databaseVersion);
      let blocked = false;
      request.onblocked = () => { blocked = true; };
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of Object.values(stores)) if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
      };
      request.onerror = () => resolve(Object.freeze({ status: "failed", reason: request.error?.name ?? "indexeddb_open_failed" }));
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          resolve(Object.freeze({ status: "blocked_by_stale_connection", reason: "stale_schema_connection" }));
          return;
        }
        this.#database = request.result;
        this.#database.onversionchange = () => {
          this.#database?.close();
          this.#database = null;
        };
        resolve(Object.freeze({ status: "opened" }));
      };
    });
  }

  close(): void { this.#database?.close(); this.#database = null; }

  async initializeDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    const database = this.#requireOpen();
    const key = streamKey(projectId, deviceId);
    const transaction = strictTransaction(database, [stores.streams], "readwrite");
    const objectStore = transaction.objectStore(stores.streams);
    const existing = await requestValue<DeviceStreamState | undefined>(objectStore.get(key));
    const state = existing ? parseDeviceStreamState(existing) : initialState(projectId, deviceId);
    if (!existing) objectStore.add(copyState(state), key);
    await transactionDone(transaction);
    return copyState(state);
  }

  async readDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState | null> {
    const transaction = strictTransaction(this.#requireOpen(), [stores.streams], "readonly");
    const value = await requestValue<DeviceStreamState | undefined>(transaction.objectStore(stores.streams).get(streamKey(projectId, deviceId)));
    await transactionDone(transaction);
    return value ? copyState(value) : null;
  }

  async compareAndAdvanceStream(input: CompareAndAdvanceStreamInput): Promise<StreamCasResult> {
    const transaction = strictTransaction(this.#requireOpen(), [stores.streams, stores.reservations], "readwrite");
    const key = streamKey(input.project_id, input.device_id);
    const streamStore = transaction.objectStore(stores.streams);
    const current = await requestValue<DeviceStreamState | undefined>(streamStore.get(key));
    if (!current) {
      await transactionDone(transaction);
      return Object.freeze({ status: "failed", code: "invalid_input" });
    }
    const outcome = evaluateCompareAndAdvanceStream(current, input);
    if (outcome.status === "advanced") {
      streamStore.put(copyState(outcome.state), key);
      transaction.objectStore(stores.reservations).put(copyReservation(outcome.state.pending_reservation!), key);
    }
    await transactionDone(transaction);
    return copyCasResult(outcome);
  }

  async finalizeCommittedBatch(input: Parameters<DeviceStreamCoordinationStore["finalizeCommittedBatch"]>[0]): ReturnType<DeviceStreamCoordinationStore["finalizeCommittedBatch"]> {
    const transaction = strictTransaction(this.#requireOpen(), [stores.streams, stores.reservations, stores.batchCatalog], "readwrite");
    const key = streamKey(input.project_id, input.device_id);
    const streamStore = transaction.objectStore(stores.streams);
    const current = await requestValue<DeviceStreamState | undefined>(streamStore.get(key));
    if (!current) {
      await transactionDone(transaction);
      return Object.freeze({ status: "failed", code: "reservation_mismatch" });
    }
    const outcome = finalizeState(current, input);
    if (outcome.status === "finalized") {
      streamStore.put(copyState(outcome.state), key);
      transaction.objectStore(stores.reservations).delete(key);
      transaction.objectStore(stores.batchCatalog).put(true, batchCatalogKey(input.project_id, input.committed_batch_id));
    }
    await transactionDone(transaction);
    return outcome;
  }

  async repairFromPortableBatch(input: Parameters<DeviceStreamCoordinationStore["repairFromPortableBatch"]>[0]): ReturnType<DeviceStreamCoordinationStore["repairFromPortableBatch"]> {
    const transaction = strictTransaction(this.#requireOpen(), [stores.streams, stores.reservations, stores.batchCatalog], "readwrite");
    const key = streamKey(input.project_id, input.device_id);
    const streamStore = transaction.objectStore(stores.streams);
    const stored = await requestValue<DeviceStreamState | undefined>(streamStore.get(key));
    const outcome = repairState(stored ?? initialState(input.project_id, input.device_id), input);
    if (outcome.status === "repaired") {
      streamStore.put(copyState(outcome.state), key);
      transaction.objectStore(stores.reservations).delete(key);
      transaction.objectStore(stores.batchCatalog).put(true, batchCatalogKey(input.project_id, input.committed_batch_id));
    }
    await transactionDone(transaction);
    return outcome;
  }

  async markContinuityAmbiguous(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    return this.#mutateStream(projectId, deviceId, (current) => parseDeviceStreamState({ ...current, generation: current.generation + BigInt(1), continuity: "ambiguous" }));
  }

  async retireDeviceStream(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceStreamState> {
    return this.#mutateStream(projectId, deviceId, (current) => parseDeviceStreamState({ ...current, generation: current.generation + BigInt(1), pending_reservation: null, continuity: "ambiguous" }), true);
  }

  async putKeyContinuity(record: Hc2KeyContinuityRecord): Promise<void> { await this.#put(stores.keyContinuity, streamKey(record.project_id, record.device_id), copyKeyRecord(record)); }
  async readKeyContinuity(projectId: ProjectId, deviceId: DeviceId): Promise<Hc2KeyContinuityRecord | null> {
    const record = await this.#get<Hc2KeyContinuityRecord>(stores.keyContinuity, streamKey(projectId, deviceId));
    return record === null ? null : copyKeyRecord(record);
  }
  async putFolderBinding(record: Hc2FolderBindingRecord): Promise<void> { const parsed = copyFolderBinding(record); await this.#put(stores.folderBindings, parsed.project_id, parsed); }
  async putRecoveryStatus(record: Hc2RecoveryStatusRecord): Promise<void> { const parsed = copyRecoveryStatus(record); await this.#put(stores.recovery, parsed.project_id, parsed); }
  async putDiagnostic(record: Hc2DiagnosticRecord): Promise<void> { const parsed = copyDiagnostic(record); await this.#put(stores.diagnostics, `${parsed.project_id}\u0000${parsed.diagnostic_id}`, parsed); }

  async replaceVerifiedBatchCatalog(projectId: ProjectId, batchIds: readonly PortableBatchId[]): Promise<void> {
    const project = parseEntityId("project", projectId);
    const parsed = parseBatchIds(batchIds);
    const transaction = strictTransaction(this.#requireOpen(), [stores.batchCatalog], "readwrite");
    const objectStore = transaction.objectStore(stores.batchCatalog);
    const range = IDBKeyRange.bound(`${project}\u0000`, `${project}\u0000\uffff`);
    await deleteCursorRange(objectStore, range);
    for (const id of parsed) objectStore.put(true, batchCatalogKey(project, id));
    await transactionDone(transaction);
  }

  async readVerifiedBatchCatalog(projectId: ProjectId): Promise<readonly PortableBatchId[]> {
    const project = parseEntityId("project", projectId);
    const transaction = strictTransaction(this.#requireOpen(), [stores.batchCatalog], "readonly");
    const keys = await requestValue<IDBValidKey[]>(transaction.objectStore(stores.batchCatalog).getAllKeys(IDBKeyRange.bound(`${project}\u0000`, `${project}\u0000\uffff`)));
    await transactionDone(transaction);
    return Object.freeze(keys.map((key) => parseHc2DigestId("portable-batch", String(key).slice(project.length + 1))).sort());
  }

  async #mutateStream(projectId: ProjectId, deviceId: DeviceId, mutation: (state: DeviceStreamState) => DeviceStreamState, clearReservation = false): Promise<DeviceStreamState> {
    const transaction = strictTransaction(this.#requireOpen(), [stores.streams, stores.reservations], "readwrite");
    const key = streamKey(projectId, deviceId);
    const objectStore = transaction.objectStore(stores.streams);
    const stored = await requestValue<DeviceStreamState | undefined>(objectStore.get(key));
    const state = mutation(stored ? parseDeviceStreamState(stored) : initialState(projectId, deviceId));
    objectStore.put(copyState(state), key);
    if (clearReservation) transaction.objectStore(stores.reservations).delete(key);
    await transactionDone(transaction);
    return copyState(state);
  }

  async #put(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
    const transaction = strictTransaction(this.#requireOpen(), [storeName], "readwrite");
    transaction.objectStore(storeName).put(value, key);
    await transactionDone(transaction);
  }

  async #get<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const transaction = strictTransaction(this.#requireOpen(), [storeName], "readonly");
    const value = await requestValue<T | undefined>(transaction.objectStore(storeName).get(key));
    await transactionDone(transaction);
    return value ?? null;
  }

  #requireOpen(): IDBDatabase {
    if (!this.#database) throw new Error("IndexedDB coordination store must be opened explicitly.");
    return this.#database;
  }
}

function initialState(projectId: ProjectId, deviceId: DeviceId): DeviceStreamState {
  return parseDeviceStreamState({
    schema_version: HC2_COORDINATION_SCHEMA_VERSION,
    project_id: parseEntityId("project", projectId),
    device_id: parseEntityId("device", deviceId),
    generation: BigInt(0),
    allocated_sequence: null,
    allocated_object_id: null,
    pending_reservation: null,
    continuity: "unambiguous"
  });
}

function finalizeState(
  currentValue: DeviceStreamState,
  input: Parameters<DeviceStreamCoordinationStore["finalizeCommittedBatch"]>[0]
): Awaited<ReturnType<DeviceStreamCoordinationStore["finalizeCommittedBatch"]>> {
  const current = parseDeviceStreamState(currentValue);
  const reservation = parseDeviceStreamReservation(input.reservation);
  if (current.project_id !== parseEntityId("project", input.project_id) || current.device_id !== parseEntityId("device", input.device_id)) return Object.freeze({ status: "failed", code: "reservation_mismatch" });
  if (current.continuity === "ambiguous") return Object.freeze({ status: "failed", code: "continuity_ambiguous" });
  if (current.generation !== input.expected_generation) return Object.freeze({ status: "failed", code: "generation_mismatch" });
  if (reservation.intended_batch_id !== parseHc2DigestId("portable-batch", input.committed_batch_id)) return Object.freeze({ status: "failed", code: "folder_batch_mismatch" });
  if (current.pending_reservation === null) {
    return current.allocated_sequence === reservation.next_sequence && current.allocated_object_id === reservation.next_object_id
      ? Object.freeze({ status: "already_finalized", state: copyState(current) })
      : Object.freeze({ status: "failed", code: "reservation_mismatch" });
  }
  if (!equalReservation(current.pending_reservation, reservation)) return Object.freeze({ status: "failed", code: "reservation_mismatch" });
  const state = parseDeviceStreamState({ ...current, pending_reservation: null });
  return Object.freeze({ status: "finalized", state });
}

function repairState(
  currentValue: DeviceStreamState,
  input: Parameters<DeviceStreamCoordinationStore["repairFromPortableBatch"]>[0]
): Awaited<ReturnType<DeviceStreamCoordinationStore["repairFromPortableBatch"]>> {
  let current: DeviceStreamState;
  try {
    current = parseDeviceStreamState(currentValue);
    parseEntityId("project", input.project_id);
    parseEntityId("device", input.device_id);
    parseHc2DigestId("portable-batch", input.committed_batch_id);
    if (input.exact_committed_sequence < BigInt(0) || input.verified_folder_generation < BigInt(0)) throw new Error("invalid folder evidence");
  } catch {
    return Object.freeze({ status: "failed", code: "folder_evidence_invalid" });
  }
  if (current.continuity === "ambiguous") return Object.freeze({ status: "failed", code: "continuity_ambiguous" });
  if (current.allocated_sequence !== null && current.allocated_sequence > input.exact_committed_sequence) return Object.freeze({ status: "failed", code: "local_state_ahead" });
  if (current.generation > input.verified_folder_generation) return Object.freeze({ status: "failed", code: "local_state_ahead" });
  if (current.allocated_sequence === input.exact_committed_sequence && current.allocated_object_id !== input.exact_committed_object_id) {
    return Object.freeze({ status: "failed", code: "folder_evidence_invalid" });
  }
  if (current.allocated_sequence === input.exact_committed_sequence && current.allocated_object_id === input.exact_committed_object_id && current.pending_reservation === null) {
    return Object.freeze({ status: "already_current", state: copyState(current) });
  }
  const state = parseDeviceStreamState({
    ...current,
    generation: input.verified_folder_generation,
    allocated_sequence: input.exact_committed_sequence,
    allocated_object_id: input.exact_committed_object_id,
    pending_reservation: null
  });
  return Object.freeze({ status: "repaired", state });
}

function strictTransaction(database: IDBDatabase, storeNames: readonly string[], mode: IDBTransactionMode): IDBTransaction {
  return database.transaction([...storeNames], mode, { durability: "strict" });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function deleteCursorRange(store: IDBObjectStore, range: IDBKeyRange): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.openKeyCursor(range);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB catalog scan failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

function streamKey(projectId: ProjectId, deviceId: DeviceId): string {
  return `${parseEntityId("project", projectId)}\u0000${parseEntityId("device", deviceId)}`;
}

function batchCatalogKey(projectId: ProjectId, batchId: PortableBatchId): string {
  return `${parseEntityId("project", projectId)}\u0000${parseHc2DigestId("portable-batch", batchId)}`;
}

function safeKey(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\u0000")) throw new Error("Local coordination keys must be nonempty and contain no NUL.");
  return value;
}

function parseBatchIds(values: readonly PortableBatchId[]): readonly PortableBatchId[] {
  const parsed = values.map((value) => parseHc2DigestId("portable-batch", value)).sort();
  for (let index = 1; index < parsed.length; index += 1) if (parsed[index - 1] === parsed[index]) throw new Error("Verified batch catalog IDs must be unique.");
  return Object.freeze(parsed);
}

function copyState(value: DeviceStreamState): DeviceStreamState {
  return parseDeviceStreamState(value);
}

function copyReservation(value: DeviceStreamReservation): DeviceStreamReservation {
  return parseDeviceStreamReservation(value);
}

function copyCasResult(value: StreamCasResult): StreamCasResult {
  return value.status === "failed" ? Object.freeze({ ...value }) : Object.freeze({ status: value.status, state: copyState(value.state) });
}

function copyKeyRecord(value: Hc2KeyContinuityRecord): Hc2KeyContinuityRecord {
  return Object.freeze({
    project_id: parseEntityId("project", value.project_id),
    device_id: parseEntityId("device", value.device_id),
    signing_key_handle: requireCryptoKey(value.signing_key_handle),
    recipient_key_handle: requireCryptoKey(value.recipient_key_handle),
    local_kek_handle: requireCryptoKey(value.local_kek_handle),
    status: value.status === "active" || value.status === "retired" ? value.status : fail("Invalid key continuity status.")
  });
}

function copyFolderBinding(value: Hc2FolderBindingRecord): Hc2FolderBindingRecord {
  if (!value.directory_handle || typeof value.directory_handle !== "object" || (value.directory_handle as { kind?: unknown }).kind !== "directory") {
    throw new Error("Folder bindings accept opaque directory handles only.");
  }
  if (!["denied", "granted", "prompt", "unknown"].includes(value.observed_permission)) throw new Error("Folder binding permission is invalid.");
  return Object.freeze({ project_id: parseEntityId("project", value.project_id), directory_handle: value.directory_handle, observed_permission: value.observed_permission });
}

function copyRecoveryStatus(value: Hc2RecoveryStatusRecord): Hc2RecoveryStatusRecord {
  if (!["ambiguous", "recovery_required", "verified"].includes(value.status)) throw new Error("Recovery status is invalid.");
  return Object.freeze({ project_id: parseEntityId("project", value.project_id), status: value.status, detail_code: diagnosticToken(value.detail_code) });
}

function copyDiagnostic(value: Hc2DiagnosticRecord): Hc2DiagnosticRecord {
  return Object.freeze({
    project_id: parseEntityId("project", value.project_id),
    diagnostic_id: safeKey(value.diagnostic_id),
    code: diagnosticToken(value.code),
    safe_detail: diagnosticToken(value.safe_detail)
  });
}

function diagnosticToken(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,128}$/.test(value)) throw new Error("Diagnostics must use bounded non-sensitive tokens.");
  return value;
}

function requireCryptoKey(value: CryptoKey): CryptoKey {
  if (!value || typeof value !== "object" || typeof value.type !== "string" || typeof value.extractable !== "boolean") throw new Error("Key continuity accepts opaque CryptoKey handles only.");
  return value;
}

function equalReservation(left: DeviceStreamReservation, right: DeviceStreamReservation): boolean {
  return left.transaction_intent_id === right.transaction_intent_id && left.next_sequence === right.next_sequence &&
    left.next_object_id === right.next_object_id && left.intended_batch_id === right.intended_batch_id &&
    left.exact_signed_bytes_commitment.length === right.exact_signed_bytes_commitment.length &&
    left.exact_signed_bytes_commitment.every((byte, index) => byte === right.exact_signed_bytes_commitment[index]);
}

function fail(message: string): never { throw new Error(message); }

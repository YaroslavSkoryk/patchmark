import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type ProjectId
} from "../identities.ts";
import { expectUInt64, type UInt64 } from "../validation.ts";
import {
  parseSyncV3Id,
  type BundleManifestIdV3,
  type SyncSessionIdV3,
  type TransportStreamIdV3
} from "./sync-v3-identities.ts";
import { syncSessionPhasesV3, type SyncSessionPhaseV3, type SyncSessionStateV3 } from "./sync-planner.ts";

export type DurableSyncBundleV3 = Readonly<{
  direction: "sent" | "received";
  round_number: UInt64;
  message_role: string;
  bundle_commitment: string;
  exact_bundle_bytes: Uint8Array | null;
  durable_reference: string | null;
}>;

export type DurableSyncTransportHighWaterV3 = Readonly<{
  direction: "sent" | "received";
  stream_id: TransportStreamIdV3;
  stream_generation: UInt64;
  bundle_sequence: UInt64;
  manifest_id: BundleManifestIdV3;
}>;

export type DurableSyncSessionRecordV3 = Readonly<{
  revision: UInt64;
  session_id: SyncSessionIdV3;
  project_id: ProjectId;
  peer_device_id: DeviceId;
  accepted_control_head_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  state: SyncSessionStateV3;
  bundles: readonly DurableSyncBundleV3[];
  transport_high_water: readonly DurableSyncTransportHighWaterV3[];
}>;

export type SyncSessionCasResultV3 =
  | Readonly<{ status: "committed"; record: DurableSyncSessionRecordV3 }>
  | Readonly<{ status: "conflict"; current: DurableSyncSessionRecordV3 | null }>;

export interface SyncSessionJournalV3 {
  read(sessionId: SyncSessionIdV3): Promise<DurableSyncSessionRecordV3 | null>;
  compareAndSwap(input: Readonly<{
    expected_revision: UInt64 | null;
    record: DurableSyncSessionRecordV3;
  }>): Promise<SyncSessionCasResultV3>;
}

export class InMemorySyncSessionJournalV3 implements SyncSessionJournalV3 {
  readonly #records = new Map<SyncSessionIdV3, DurableSyncSessionRecordV3>();

  async read(sessionId: SyncSessionIdV3): Promise<DurableSyncSessionRecordV3 | null> {
    const value = this.#records.get(parseSyncV3Id("sync-session", sessionId));
    return value ? copyRecord(value) : null;
  }

  async compareAndSwap(input: Readonly<{ expected_revision: UInt64 | null; record: DurableSyncSessionRecordV3 }>): Promise<SyncSessionCasResultV3> {
    const record = parseDurableSyncSessionRecordV3(input.record);
    const current = this.#records.get(record.session_id) ?? null;
    const expectedNext = input.expected_revision === null ? BigInt(0) : input.expected_revision + BigInt(1);
    if ((current?.revision ?? null) !== input.expected_revision || record.revision !== expectedNext) {
      return Object.freeze({ status: "conflict", current: current ? copyRecord(current) : null });
    }
    this.#records.set(record.session_id, copyRecord(record));
    return Object.freeze({ status: "committed", record: copyRecord(record) });
  }
}

/** Injected IndexedDB only; construction and import cause no browser activity. */
export class IndexedDbSyncSessionJournalV3 implements SyncSessionJournalV3 {
  readonly #indexedDb: IDBFactory;
  readonly #databaseName: string;
  #database: IDBDatabase | null = null;

  constructor(input: Readonly<{ indexed_db: IDBFactory; database_name: string }>) {
    if (!input?.indexed_db || typeof input.database_name !== "string" || input.database_name.length === 0) throw new Error("IndexedDB synchronization journal requires an injected factory and database name.");
    this.#indexedDb = input.indexed_db;
    this.#databaseName = input.database_name;
  }

  async open(): Promise<void> {
    if (this.#database) return;
    const request = this.#indexedDb.open(this.#databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("sessions")) request.result.createObjectStore("sessions");
    };
    this.#database = await idbRequest(request);
  }

  close(): void { this.#database?.close(); this.#database = null; }

  async deleteDatabase(): Promise<void> {
    this.close();
    await idbRequest(this.#indexedDb.deleteDatabase(this.#databaseName));
  }

  async read(sessionId: SyncSessionIdV3): Promise<DurableSyncSessionRecordV3 | null> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(["sessions"], "readonly");
    const value = await idbRequest<DurableSyncSessionRecordV3 | undefined>(transaction.objectStore("sessions").get(parseSyncV3Id("sync-session", sessionId)));
    await idbDone(transaction);
    return value ? copyRecord(parseDurableSyncSessionRecordV3(value)) : null;
  }

  async compareAndSwap(input: Readonly<{ expected_revision: UInt64 | null; record: DurableSyncSessionRecordV3 }>): Promise<SyncSessionCasResultV3> {
    const record = parseDurableSyncSessionRecordV3(input.record);
    const transaction = this.#requireDatabase().transaction(["sessions"], "readwrite");
    const store = transaction.objectStore("sessions");
    const currentValue = await idbRequest<DurableSyncSessionRecordV3 | undefined>(store.get(record.session_id));
    const current = currentValue ? parseDurableSyncSessionRecordV3(currentValue) : null;
    const expectedNext = input.expected_revision === null ? BigInt(0) : input.expected_revision + BigInt(1);
    if ((current?.revision ?? null) !== input.expected_revision || record.revision !== expectedNext) {
      transaction.abort();
      await ignoreAbort(transaction);
      return Object.freeze({ status: "conflict", current: current ? copyRecord(current) : null });
    }
    store.put(copyRecord(record), record.session_id);
    await idbDone(transaction);
    return Object.freeze({ status: "committed", record: copyRecord(record) });
  }

  #requireDatabase(): IDBDatabase {
    if (!this.#database) throw new Error("IndexedDB synchronization journal is not open.");
    return this.#database;
  }
}

export function parseDurableSyncSessionRecordV3(value: DurableSyncSessionRecordV3): DurableSyncSessionRecordV3 {
  if (!value || typeof value !== "object") throw new Error("Synchronization session journal record is malformed.");
  assertExactKeys(value, ["revision", "session_id", "project_id", "peer_device_id", "accepted_control_head_id", "key_epoch_id", "key_epoch_commitment", "state", "bundles", "transport_high_water"], "synchronization session journal record");
  const revision = expectUInt64(value.revision, "synchronization journal revision");
  const sessionId = parseSyncV3Id("sync-session", value.session_id);
  const projectId = parseEntityId("project", value.project_id);
  const peerDeviceId = parseEntityId("device", value.peer_device_id);
  const acceptedControlHeadId = parseDigestId("control-event", value.accepted_control_head_id);
  const keyEpochId = parseEntityId("key-epoch", value.key_epoch_id);
  const keyEpochCommitment = parseDigestId("key-epoch-commitment", value.key_epoch_commitment);
  const state = parseSessionState(value.state);
  if (state.session_id !== sessionId) throw new Error("Synchronization journal state is bound to another session.");
  if (!Array.isArray(value.bundles)) throw new Error("Synchronization journal bundles must be a dense array.");
  const bundles = value.bundles.map(parseBundle);
  const slots = new Map<string, DurableSyncBundleV3>();
  for (const bundle of bundles) {
    const key = bundleSlot(bundle);
    const existing = slots.get(key);
    if (existing && existing.bundle_commitment !== bundle.bundle_commitment) throw new Error("Synchronization journal contains a conflicting bundle slot.");
    if (!existing) slots.set(key, bundle);
  }
  if (!Array.isArray(value.transport_high_water)) throw new Error("Synchronization journal transport high-water state must be a dense array.");
  const highWater = value.transport_high_water.map(parseTransportHighWater);
  const streams = new Set<string>();
  for (const entry of highWater) {
    const key = `${entry.direction}:${entry.stream_id}`;
    if (streams.has(key)) throw new Error("Synchronization journal contains duplicate transport high-water state.");
    streams.add(key);
  }
  return Object.freeze({
    revision,
    session_id: sessionId,
    project_id: projectId,
    peer_device_id: peerDeviceId,
    accepted_control_head_id: acceptedControlHeadId,
    key_epoch_id: keyEpochId,
    key_epoch_commitment: keyEpochCommitment,
    state,
    bundles: Object.freeze([...slots.values()].sort(compareBundles)),
    transport_high_water: Object.freeze(highWater.sort(compareTransportHighWater))
  });
}

function parseSessionState(value: SyncSessionStateV3): SyncSessionStateV3 {
  if (!value || typeof value !== "object" || !syncSessionPhasesV3.includes(value.phase)) throw new Error("Synchronization journal state is malformed.");
  assertExactKeys(value, ["session_id", "session_generation", "phase", "round_number", "local_snapshot_id", "remote_snapshot_id", "messages", "outstanding_request_ids", "pages_processed", "objects_processed", "bytes_read", "bytes_written", "terminal_reason"], "synchronization journal state");
  if (!Array.isArray(value.messages) || !Array.isArray(value.outstanding_request_ids)) throw new Error("Synchronization journal collections must be dense arrays.");
  return Object.freeze({
    ...value,
    session_id: parseSyncV3Id("sync-session", value.session_id),
    session_generation: expectUInt64(value.session_generation, "session generation"),
    phase: value.phase as SyncSessionPhaseV3,
    round_number: expectUInt64(value.round_number, "synchronization round"),
    messages: Object.freeze(value.messages.map((entry) => Object.freeze({ ...entry }))),
    outstanding_request_ids: Object.freeze(value.outstanding_request_ids.map((entry) => parseSyncV3Id("object-request", entry))),
    bytes_read: expectUInt64(value.bytes_read, "session bytes read"),
    bytes_written: expectUInt64(value.bytes_written, "session bytes written")
  });
}

function parseBundle(value: DurableSyncBundleV3): DurableSyncBundleV3 {
  if (!value || (value.direction !== "sent" && value.direction !== "received")) throw new Error("Synchronization journal bundle is malformed.");
  assertExactKeys(value, ["direction", "round_number", "message_role", "bundle_commitment", "exact_bundle_bytes", "durable_reference"], "synchronization journal bundle");
  if ((value.exact_bundle_bytes === null) === (value.durable_reference === null)) throw new Error("Synchronization journal bundle requires exactly one byte source.");
  if (typeof value.message_role !== "string" || typeof value.bundle_commitment !== "string") throw new Error("Synchronization journal bundle binding is malformed.");
  return Object.freeze({
    direction: value.direction,
    round_number: expectUInt64(value.round_number, "bundle round"),
    message_role: value.message_role,
    bundle_commitment: value.bundle_commitment,
    exact_bundle_bytes: value.exact_bundle_bytes === null ? null : Uint8Array.from(value.exact_bundle_bytes),
    durable_reference: value.durable_reference
  });
}

function parseTransportHighWater(value: DurableSyncTransportHighWaterV3): DurableSyncTransportHighWaterV3 {
  if (!value || (value.direction !== "sent" && value.direction !== "received")) throw new Error("Synchronization journal transport high-water state is malformed.");
  assertExactKeys(value, ["direction", "stream_id", "stream_generation", "bundle_sequence", "manifest_id"], "synchronization journal transport high-water state");
  return Object.freeze({
    direction: value.direction,
    stream_id: parseSyncV3Id("transport-stream", value.stream_id),
    stream_generation: expectUInt64(value.stream_generation, "transport stream generation"),
    bundle_sequence: expectUInt64(value.bundle_sequence, "transport bundle sequence"),
    manifest_id: parseSyncV3Id("bundle-manifest", value.manifest_id)
  });
}

function copyRecord(value: DurableSyncSessionRecordV3): DurableSyncSessionRecordV3 {
  return Object.freeze({
    ...value,
    state: parseSessionState(value.state),
    bundles: Object.freeze(value.bundles.map(parseBundle)),
    transport_high_water: Object.freeze(value.transport_high_water.map(parseTransportHighWater))
  });
}

function bundleSlot(value: DurableSyncBundleV3): string { return `${value.direction}:${value.round_number}:${value.message_role}`; }
function compareBundles(left: DurableSyncBundleV3, right: DurableSyncBundleV3): number { return bundleSlot(left).localeCompare(bundleSlot(right)); }
function compareTransportHighWater(left: DurableSyncTransportHighWaterV3, right: DurableSyncTransportHighWaterV3): number { return `${left.direction}:${left.stream_id}`.localeCompare(`${right.direction}:${right.stream_id}`); }

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB synchronization request failed."));
  });
}

function idbDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB synchronization transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB synchronization transaction aborted."));
  });
}

function ignoreAbort(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.onabort = () => resolve();
    transaction.onerror = () => resolve();
  });
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} contains unexpected or missing fields.`);
}

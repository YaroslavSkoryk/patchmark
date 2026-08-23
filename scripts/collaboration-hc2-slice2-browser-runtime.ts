import {
  Hc2IndexedDbCoordinationStore,
  deriveHc2MutationLockName,
  runHc2CapabilityProbes,
  type CompareAndAdvanceStreamInput,
  type DeviceStreamReservation
} from "../lib/collaboration/hc2/index.ts";
import type { DeviceId, ProjectId } from "../lib/collaboration/identities.ts";

let heldRelease: (() => void) | null = null;
let heldPromise: Promise<void> | null = null;
let lockState: "idle" | "waiting" | "held" | "released" = "idle";

export async function runBrowserCapabilityProbe(databaseName: string) {
  const storage = navigator.storage;
  return runHc2CapabilityProbes({
    secure_context: globalThis.isSecureContext,
    top_level_context: globalThis.top === globalThis.window,
    crypto: globalThis.crypto,
    indexed_db: globalThis.indexedDB,
    web_locks_present: typeof navigator.locks?.request === "function",
    file_system_access_present: typeof (globalThis as typeof globalThis & { showDirectoryPicker?: unknown }).showDirectoryPicker === "function",
    storage,
    probe_database_name: databaseName,
    required_origin_bytes: BigInt(1024 * 1024)
  });
}

export async function initializeStream(databaseName: string, projectId: ProjectId, deviceId: DeviceId) {
  const store = await openStore(databaseName);
  try { return await store.initializeDeviceStream(projectId, deviceId); }
  finally { store.close(); }
}

export async function reserveStream(databaseName: string, input: CompareAndAdvanceStreamInput) {
  const store = await openStore(databaseName);
  try { return await store.compareAndAdvanceStream(input); }
  finally { store.close(); }
}

export async function finalizeStream(databaseName: string, input: Readonly<{
  project_id: ProjectId;
  device_id: DeviceId;
  expected_generation: bigint;
  reservation: DeviceStreamReservation;
  committed_batch_id: import("../lib/collaboration/hc2/identities.ts").PortableBatchId;
}>) {
  const store = await openStore(databaseName);
  try { return await store.finalizeCommittedBatch(input); }
  finally { store.close(); }
}

export function beginHeldLock(projectId: ProjectId, deviceId: DeviceId): void {
  if (heldPromise) throw new Error("This context already has a lock operation.");
  lockState = "waiting";
  const requested = navigator.locks.request(deriveHc2MutationLockName(projectId, deviceId), { mode: "exclusive" }, () => {
    lockState = "held";
    return new Promise<void>((resolve) => { heldRelease = () => { lockState = "released"; resolve(); }; });
  });
  heldPromise = requested.then((value) => value);
}

export function releaseHeldLock(): void { heldRelease?.(); heldRelease = null; }
export function currentLockState(): string { return lockState; }
export async function waitHeldLockCompletion(): Promise<void> { await heldPromise; heldPromise = null; }

export async function openStaleConnection(databaseName: string): Promise<void> {
  const store = await openStore(databaseName);
  (globalThis as typeof globalThis & { __hc2StaleStore?: Hc2IndexedDbCoordinationStore }).__hc2StaleStore = store;
}

export async function upgradeDatabase(databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("upgrade blocked"));
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
}

export async function staleConnectionCanWrite(projectId: ProjectId, deviceId: DeviceId): Promise<boolean> {
  const store = (globalThis as typeof globalThis & { __hc2StaleStore?: Hc2IndexedDbCoordinationStore }).__hc2StaleStore;
  if (!store) throw new Error("No stale store was opened.");
  try { await store.initializeDeviceStream(projectId, deviceId); return true; }
  catch { return false; }
  finally { store.close(); }
}

export async function deleteDatabase(databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });
}

async function openStore(databaseName: string): Promise<Hc2IndexedDbCoordinationStore> {
  const store = new Hc2IndexedDbCoordinationStore({ indexed_db: indexedDB, database_name: databaseName });
  const opened = await store.open();
  if (opened.status !== "opened") throw new Error(opened.reason);
  return store;
}

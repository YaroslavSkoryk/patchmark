export type Hc2CapabilityState = "available" | "unavailable" | "unknown";

export interface Hc2ProbeStorageManager {
  estimate?(): Promise<Readonly<{ quota?: number; usage?: number }>>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
  getDirectory?(): Promise<unknown>;
}

export type Hc2CapabilityProbeContext = Readonly<{
  secure_context: boolean;
  top_level_context: boolean;
  crypto: Crypto | null;
  indexed_db: IDBFactory | null;
  web_locks_present: boolean;
  file_system_access_present: boolean;
  storage: Hc2ProbeStorageManager | null;
  probe_database_name: string;
  required_origin_bytes: bigint;
}>;

export type Hc2CapabilityProbeResult = Readonly<{
  secure_context: boolean;
  top_level_context: boolean;
  ed25519: Hc2CapabilityState;
  x25519: Hc2CapabilityState;
  crypto_key_indexeddb_round_trip: Hc2CapabilityState;
  indexeddb: Hc2CapabilityState;
  indexeddb_strict_durability: Hc2CapabilityState;
  web_locks: Hc2CapabilityState;
  file_system_access: Hc2CapabilityState;
  storage_estimate: "sufficient" | "insufficient" | "unavailable";
  storage_quota_bytes: number | null;
  storage_usage_bytes: number | null;
  persistent_storage: "granted" | "denied" | "unknown";
  ephemeral_context: "unknown";
  opfs: Hc2CapabilityState;
  disposable_probe_keys_deleted: boolean;
  failures: readonly string[];
}>;

/** Explicit probe runner. Generated keys are disposable, unlabelled, and non-extractable. */
export async function runHc2CapabilityProbes(context: Hc2CapabilityProbeContext): Promise<Hc2CapabilityProbeResult> {
  validateContext(context);
  const failures: string[] = [];
  let ed25519: Hc2CapabilityState = "unavailable";
  let x25519: Hc2CapabilityState = "unavailable";
  let keyRoundTrip: Hc2CapabilityState = "unavailable";
  let strictDurability: Hc2CapabilityState = "unavailable";
  let indexedDb: Hc2CapabilityState = "unavailable";
  let probeKeysDeleted = true;
  let edPair: CryptoKeyPair | null = null;
  if (context.crypto?.subtle) {
    try {
      edPair = asKeyPair(await context.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]));
      assertNonExtractable(edPair);
      const message = new Uint8Array([112, 97, 116, 99, 104, 109, 97, 114, 107]);
      const signature = await context.crypto.subtle.sign({ name: "Ed25519" }, edPair.privateKey, message);
      if (!(await context.crypto.subtle.verify({ name: "Ed25519" }, edPair.publicKey, signature, message))) throw new Error("Ed25519 verification failed.");
      ed25519 = "available";
    } catch (error) { failures.push(`ed25519:${safeErrorName(error)}`); }
    try {
      const pair = asKeyPair(await context.crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]));
      assertNonExtractable(pair);
      const bits = await context.crypto.subtle.deriveBits({ name: "X25519", public: pair.publicKey }, pair.privateKey, 256);
      if (bits.byteLength !== 32) throw new Error("X25519 probe produced the wrong length.");
      x25519 = "available";
    } catch (error) { failures.push(`x25519:${safeErrorName(error)}`); }
  } else {
    failures.push("webcrypto:unavailable");
  }
  if (context.indexed_db) {
    let database: IDBDatabase | null = null;
    try {
      database = await openProbeDatabase(context.indexed_db, context.probe_database_name);
      indexedDb = "available";
      strictDurability = await probeStrictTransaction(database);
      if (edPair && context.crypto?.subtle) {
        const transaction = database.transaction(["keys"], "readwrite", { durability: "strict" });
        transaction.objectStore("keys").put(Object.freeze({ publicKey: edPair.publicKey, privateKey: edPair.privateKey }), "disposable-ed25519-pair");
        await transactionDone(transaction);
        const read = database.transaction(["keys"], "readonly");
        const cloned = await requestValue<CryptoKeyPair>(read.objectStore("keys").get("disposable-ed25519-pair"));
        await transactionDone(read);
        assertNonExtractable(cloned);
        const message = new Uint8Array([1, 3, 3, 7]);
        const signature = await context.crypto.subtle.sign("Ed25519", cloned.privateKey, message);
        if (!(await context.crypto.subtle.verify("Ed25519", cloned.publicKey, signature, message))) throw new Error("Cloned keypair operation failed.");
        const cleanup = database.transaction(["keys"], "readwrite", { durability: "strict" });
        cleanup.objectStore("keys").delete("disposable-ed25519-pair");
        await transactionDone(cleanup);
        keyRoundTrip = "available";
      }
    } catch (error) {
      failures.push(`indexeddb:${safeErrorName(error)}`);
    } finally {
      database?.close();
      try { await deleteProbeDatabase(context.indexed_db, context.probe_database_name); }
      catch (error) { probeKeysDeleted = false; failures.push(`probe_cleanup:${safeErrorName(error)}`); }
    }
  }
  const estimate = await observeEstimate(context.storage, context.required_origin_bytes, failures);
  const persistence = await observePersistence(context.storage, failures);
  const opfs = await observeOpfs(context.storage, failures);
  return Object.freeze({
    secure_context: context.secure_context,
    top_level_context: context.top_level_context,
    ed25519,
    x25519,
    crypto_key_indexeddb_round_trip: keyRoundTrip,
    indexeddb: indexedDb,
    indexeddb_strict_durability: strictDurability,
    web_locks: context.web_locks_present ? "available" : "unavailable",
    file_system_access: context.file_system_access_present ? "available" : "unavailable",
    storage_estimate: estimate.state,
    storage_quota_bytes: estimate.quota,
    storage_usage_bytes: estimate.usage,
    persistent_storage: persistence,
    ephemeral_context: "unknown",
    opfs,
    disposable_probe_keys_deleted: probeKeysDeleted,
    failures: Object.freeze(failures.sort())
  });
}

/** Persistence mutation is separate so the probe runner can never call persist(). */
export async function requestHc2PersistentStorageExplicitly(storage: Hc2ProbeStorageManager): Promise<Readonly<{ status: "granted" | "denied" | "unsupported" | "failed"; reason?: string }>> {
  if (!storage?.persist) return Object.freeze({ status: "unsupported" });
  try { return Object.freeze({ status: await storage.persist() ? "granted" : "denied" }); }
  catch (error) { return Object.freeze({ status: "failed", reason: safeErrorName(error) }); }
}

async function openProbeDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("keys")) request.result.createObjectStore("keys");
      if (!request.result.objectStoreNames.contains("strict")) request.result.createObjectStore("strict");
    };
    request.onerror = () => reject(request.error ?? new Error("Probe database open failed."));
    request.onblocked = () => reject(new Error("Probe database was blocked."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function probeStrictTransaction(database: IDBDatabase): Promise<Hc2CapabilityState> {
  try {
    const transaction = database.transaction(["strict"], "readwrite", { durability: "strict" });
    transaction.objectStore("strict").put("ok", "probe");
    await transactionDone(transaction);
    return "available";
  } catch { return "unavailable"; }
}

async function observeEstimate(storage: Hc2ProbeStorageManager | null, required: bigint, failures: string[]): Promise<Readonly<{ state: "sufficient" | "insufficient" | "unavailable"; quota: number | null; usage: number | null }>> {
  if (!storage?.estimate) return Object.freeze({ state: "unavailable", quota: null, usage: null });
  try {
    const estimate = await storage.estimate();
    const quota = finiteBytes(estimate.quota);
    const usage = finiteBytes(estimate.usage);
    if (quota === null || usage === null) return Object.freeze({ state: "unavailable", quota, usage });
    return Object.freeze({ state: BigInt(Math.floor(quota - usage)) >= required ? "sufficient" : "insufficient", quota, usage });
  } catch (error) {
    failures.push(`storage_estimate:${safeErrorName(error)}`);
    return Object.freeze({ state: "unavailable", quota: null, usage: null });
  }
}

async function observePersistence(storage: Hc2ProbeStorageManager | null, failures: string[]): Promise<"granted" | "denied" | "unknown"> {
  if (!storage?.persisted) return "unknown";
  try { return await storage.persisted() ? "granted" : "denied"; }
  catch (error) { failures.push(`storage_persisted:${safeErrorName(error)}`); return "unknown"; }
}

async function observeOpfs(storage: Hc2ProbeStorageManager | null, failures: string[]): Promise<Hc2CapabilityState> {
  if (!storage?.getDirectory) return "unavailable";
  try { await storage.getDirectory(); return "available"; }
  catch (error) { failures.push(`opfs:${safeErrorName(error)}`); return "unavailable"; }
}

function deleteProbeDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Probe database deletion failed."));
    request.onblocked = () => reject(new Error("Probe database deletion was blocked."));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB probe request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB probe transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB probe transaction failed."));
  });
}

function asKeyPair(value: CryptoKeyPair | CryptoKey): CryptoKeyPair {
  if (!("publicKey" in value) || !("privateKey" in value)) throw new Error("Capability probe expected a keypair.");
  return value;
}

function assertNonExtractable(pair: CryptoKeyPair): void {
  if (pair.privateKey.extractable) throw new Error("Capability probe private keys must be non-extractable.");
}

function finiteBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateContext(context: Hc2CapabilityProbeContext): void {
  if (!context || typeof context.secure_context !== "boolean" || typeof context.top_level_context !== "boolean") throw new Error("Capability probes require explicit context observations.");
  if (typeof context.probe_database_name !== "string" || !/^patchmark-hc2-capability-probe-[a-z0-9-]+$/.test(context.probe_database_name)) throw new Error("Probe database name must use the dedicated HC-2 namespace.");
  if (typeof context.required_origin_bytes !== "bigint" || context.required_origin_bytes < BigInt(0)) throw new Error("Required origin bytes must be nonnegative bigint.");
}

function safeErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "probe_failed";
}

export const hc3ProductCapabilityNames = Object.freeze([
  "clipboard_write",
  "web_share_text",
  "web_share_files",
  "save_file_picker",
  "open_file_picker",
  "download_upload_fallback",
  "qr_rendering",
  "native_qr_scanning",
  "image_qr_scanning",
  "camera_access",
  "webrtc_data_channels",
  "indexeddb",
  "non_extractable_key_persistence",
  "web_locks",
  "opfs",
  "file_system_access",
  "required_webcrypto"
] as const);

export const hc3ProductCapabilityStates = Object.freeze([
  "supported",
  "unsupported",
  "permission_required",
  "permission_denied",
  "temporarily_unavailable",
  "lost_during_operation",
  "incompatible_result",
  "not_exercised"
] as const);

export type Hc3ProductCapabilityName = (typeof hc3ProductCapabilityNames)[number];
export type Hc3ProductCapabilityState = (typeof hc3ProductCapabilityStates)[number];

export type Hc3ProductCapability = Readonly<{
  name: Hc3ProductCapabilityName;
  state: Hc3ProductCapabilityState;
  probe_trigger: "explicit_entry" | "explicit_user_action";
  fallback: string | null;
  blocks_operation: boolean;
  diagnostic_code: string;
}>;

export type Hc3ProductCapabilityMatrix = Readonly<{
  authority: "none";
  probed_after_explicit_entry: true;
  permission_bearing_operations_invoked: false;
  user_agent_inspected: false;
  capabilities: readonly Hc3ProductCapability[];
}>;

type BarcodeDetectorConstructor = new (input?: Readonly<{ formats?: readonly string[] }>) => Readonly<{
  detect(source: ImageBitmapSource): Promise<readonly Readonly<{ rawValue?: string }>[]>
}>;

type CapabilityNavigator = Navigator & Readonly<{
  canShare?: (data?: ShareData) => boolean;
  storage?: StorageManager & Readonly<{ getDirectory?: () => Promise<unknown> }>;
}>;

export type Hc3ProductCapabilityEnvironment = Readonly<{
  isSecureContext?: boolean;
  navigator?: CapabilityNavigator;
  document?: Document;
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  CryptoKey?: typeof CryptoKey;
  RTCPeerConnection?: typeof RTCPeerConnection;
  BarcodeDetector?: BarcodeDetectorConstructor & Readonly<{ getSupportedFormats?: () => Promise<readonly string[]> }>;
  createImageBitmap?: typeof createImageBitmap;
  showOpenFilePicker?: unknown;
  showSaveFilePicker?: unknown;
}>;

type Probe = Readonly<{ state: Hc3ProductCapabilityState; diagnostic_code: string }>;

/**
 * Runs only after the user enters the development qualification workspace.
 * Permission-bearing APIs are described, but never invoked, by this probe.
 */
export async function detectHc3ProductCapabilities(
  environment: Hc3ProductCapabilityEnvironment
): Promise<Hc3ProductCapabilityMatrix> {
  const navigatorValue = environment.navigator;
  const nativeQr = await supportsNativeQr(environment.BarcodeDetector);
  const cryptoProbe = await supportsRequiredWebCrypto(environment.crypto);
  const storageProbe = await probeIndexedDbAndKeyPersistence(environment, cryptoProbe.state === "supported");
  const dataChannels = supportsDataChannels(environment.RTCPeerConnection);
  const fileShare = supportsFileShare(navigatorValue);
  const webLocks = await supportsWebLocks(navigatorValue?.locks);
  const opfs = await supportsOpfs(navigatorValue?.storage);
  const clipboard = Boolean(environment.isSecureContext && navigatorValue?.clipboard?.writeText);
  const camera = Boolean(environment.isSecureContext && navigatorValue?.mediaDevices?.getUserMedia);
  const openPicker = typeof environment.showOpenFilePicker === "function";
  const savePicker = typeof environment.showSaveFilePicker === "function";
  const capabilities: Hc3ProductCapability[] = [
    capability("clipboard_write", clipboard ? "permission_required" : "unsupported", "explicit_user_action", "Select and copy the artifact manually"),
    capability("web_share_text", typeof navigatorValue?.share === "function" ? "supported" : "unsupported", "explicit_user_action", "Copy the exact text"),
    capability("web_share_files", fileShare, "explicit_user_action", "Save the encrypted file"),
    capability("save_file_picker", savePicker ? "permission_required" : "unsupported", "explicit_user_action", "Browser download"),
    capability("open_file_picker", openPicker ? "permission_required" : "unsupported", "explicit_user_action", "File upload control"),
    capability("download_upload_fallback", environment.document?.createElement ? "supported" : "unsupported", "explicit_entry", null),
    capability("qr_rendering", "supported", "explicit_entry", null),
    capability("native_qr_scanning", nativeQr, "explicit_entry", "Choose a QR image or paste text"),
    capability("image_qr_scanning", typeof environment.createImageBitmap === "function" && Boolean(environment.document?.createElement) ? "supported" : "unsupported", "explicit_user_action", "Paste exact text"),
    capability("camera_access", camera ? "permission_required" : "unsupported", "explicit_user_action", "Choose a QR image or paste text"),
    capability("webrtc_data_channels", dataChannels, "explicit_entry", "Send an encrypted update"),
    capability("indexeddb", storageProbe.indexeddb, "explicit_entry", "Collaboration is blocked on this device"),
    capability("non_extractable_key_persistence", storageProbe.non_extractable_key_persistence, "explicit_entry", "Collaboration setup is blocked on this device"),
    capability("web_locks", webLocks, "explicit_entry", "Use the existing transactional fallback"),
    capability("opfs", opfs, "explicit_entry", "Use the selected portable folder"),
    capability("file_system_access", openPicker || savePicker ? "permission_required" : "unsupported", "explicit_user_action", "Use download and upload controls"),
    capability("required_webcrypto", cryptoProbe, "explicit_entry", "Collaboration is blocked on this device")
  ];
  return Object.freeze({
    authority: "none",
    probed_after_explicit_entry: true,
    permission_bearing_operations_invoked: false,
    user_agent_inspected: false,
    capabilities: Object.freeze(capabilities)
  });
}

function capability(
  name: Hc3ProductCapabilityName,
  stateOrProbe: Hc3ProductCapabilityState | Probe,
  trigger: Hc3ProductCapability["probe_trigger"],
  fallback: string | null
): Hc3ProductCapability {
  const state = typeof stateOrProbe === "string" ? stateOrProbe : stateOrProbe.state;
  const diagnosticCode = typeof stateOrProbe === "string" ? `${name}_${state}` : stateOrProbe.diagnostic_code;
  const unavailable = state !== "supported" && state !== "permission_required";
  return Object.freeze({
    name,
    state,
    probe_trigger: trigger,
    fallback: state === "supported" ? null : fallback,
    blocks_operation: unavailable && (fallback === null || /blocked/i.test(fallback)),
    diagnostic_code: diagnosticCode
  });
}

async function supportsNativeQr(detector: Hc3ProductCapabilityEnvironment["BarcodeDetector"]): Promise<Probe> {
  if (!detector) return probe("unsupported", "native_qr_scanning_unsupported");
  try {
    const formats = await detector.getSupportedFormats?.();
    return formats === undefined || formats.includes("qr_code")
      ? probe("supported", "native_qr_scanning_supported")
      : probe("incompatible_result", "native_qr_scanning_qr_format_absent");
  } catch (error) {
    return probe(errorState(error), "native_qr_scanning_probe_failed");
  }
}

function supportsFileShare(navigatorValue: Hc3ProductCapabilityEnvironment["navigator"]): Probe {
  if (!navigatorValue?.share) return probe("unsupported", "web_share_files_unsupported");
  if (!navigatorValue.canShare || typeof File !== "function") return probe("unsupported", "web_share_files_can_share_unavailable");
  try {
    return navigatorValue.canShare({ files: [new File([new Uint8Array()], "update.pmcb", { type: "application/vnd.patchmark.collaboration-bundle" })] })
      ? probe("supported", "web_share_files_supported")
      : probe("incompatible_result", "web_share_files_rejected_probe_file");
  } catch (error) {
    return probe(errorState(error), "web_share_files_probe_failed");
  }
}

function supportsDataChannels(Peer: Hc3ProductCapabilityEnvironment["RTCPeerConnection"]): Probe {
  if (!Peer) return probe("unsupported", "webrtc_data_channels_unsupported");
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  try {
    peer = new Peer({ iceServers: [] });
    channel = peer.createDataChannel("patchmark-capability-probe", { ordered: true });
    return channel.ordered
      ? probe("supported", "webrtc_data_channels_supported")
      : probe("incompatible_result", "webrtc_data_channels_unordered_result");
  } catch (error) {
    return probe(errorState(error), "webrtc_data_channels_probe_failed");
  } finally {
    try { channel?.close(); } finally { peer?.close(); }
  }
}

async function supportsRequiredWebCrypto(cryptoValue: Crypto | undefined): Promise<Probe> {
  if (!cryptoValue?.subtle) return probe("unsupported", "required_webcrypto_unsupported");
  try {
    const bytes = new TextEncoder().encode("patchmark-hc3-slice5-capability-probe");
    const digest = await cryptoValue.subtle.digest("SHA-256", bytes);
    const aes = await cryptoValue.subtle.importKey("raw", new Uint8Array(32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const encrypted = await cryptoValue.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, aes, bytes);
    return digest.byteLength === 32 && encrypted.byteLength > bytes.byteLength && aes.extractable === false
      ? probe("supported", "required_webcrypto_supported")
      : probe("incompatible_result", "required_webcrypto_incompatible_result");
  } catch (error) {
    return probe(errorState(error), "required_webcrypto_probe_failed");
  }
}

async function probeIndexedDbAndKeyPersistence(
  environment: Hc3ProductCapabilityEnvironment,
  cryptoAvailable: boolean
): Promise<Readonly<{ indexeddb: Probe; non_extractable_key_persistence: Probe }>> {
  if (!environment.indexedDB) return Object.freeze({
    indexeddb: probe("unsupported", "indexeddb_unsupported"),
    non_extractable_key_persistence: probe("unsupported", "non_extractable_key_persistence_requires_indexeddb")
  });
  if (!cryptoAvailable || !environment.crypto?.subtle) return Object.freeze({
    indexeddb: probe("not_exercised", "indexeddb_not_exercised_without_crypto"),
    non_extractable_key_persistence: probe("unsupported", "non_extractable_key_persistence_requires_webcrypto")
  });
  const databaseName = "patchmark-hc3-slice5-capability-probe";
  let database: IDBDatabase | null = null;
  try {
    const key = await environment.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    database = await openDatabase(environment.indexedDB, databaseName);
    await transaction(database, "readwrite", (store) => store.put(key, "key"));
    const reopened = await transaction(database, "readonly", (store) => store.get("key"));
    const Key = environment.CryptoKey ?? globalThis.CryptoKey;
    const isCryptoKey = typeof Key === "function" ? reopened instanceof Key : Boolean(reopened && typeof reopened === "object" && "extractable" in reopened);
    const compatible = isCryptoKey && (reopened as CryptoKey).extractable === false;
    return Object.freeze({
      indexeddb: probe("supported", "indexeddb_transaction_supported"),
      non_extractable_key_persistence: compatible
        ? probe("supported", "non_extractable_key_persistence_supported")
        : probe("incompatible_result", "non_extractable_key_persistence_incompatible_result")
    });
  } catch (error) {
    const state = errorState(error);
    return Object.freeze({
      indexeddb: probe(state, "indexeddb_transaction_probe_failed"),
      non_extractable_key_persistence: probe(state, "non_extractable_key_persistence_probe_failed")
    });
  } finally {
    database?.close();
    await deleteDatabase(environment.indexedDB, databaseName);
  }
}

async function supportsWebLocks(locks: LockManager | undefined): Promise<Probe> {
  if (!locks?.request) return probe("unsupported", "web_locks_unsupported");
  try {
    let acquired = false;
    await locks.request("patchmark-hc3-slice5-capability-probe", { ifAvailable: true, mode: "exclusive" }, (lock) => { acquired = lock !== null; });
    return acquired
      ? probe("supported", "web_locks_supported")
      : probe("temporarily_unavailable", "web_locks_contended");
  } catch (error) {
    return probe(errorState(error), "web_locks_probe_failed");
  }
}

async function supportsOpfs(storage: (StorageManager & Readonly<{ getDirectory?: () => Promise<unknown> }>) | undefined): Promise<Probe> {
  if (!storage?.getDirectory) return probe("unsupported", "opfs_unsupported");
  try {
    const root = await storage.getDirectory();
    return root ? probe("supported", "opfs_supported") : probe("incompatible_result", "opfs_missing_root");
  } catch (error) {
    return probe(errorState(error), "opfs_probe_failed");
  }
}

function probe(state: Hc3ProductCapabilityState, diagnosticCode: string): Probe {
  return Object.freeze({ state, diagnostic_code: diagnosticCode });
}

function errorState(error: unknown): Hc3ProductCapabilityState {
  const name = error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "Error";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "QuotaExceededError" || name === "AbortError" || name === "InvalidStateError" || name === "NotReadableError") return "temporarily_unavailable";
  return "incompatible_result";
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("probe");
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new DOMException("IndexedDB probe was blocked.", "InvalidStateError"));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB capability probe failed."));
  });
}

function transaction(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transactionValue = database.transaction("probe", mode, { durability: "strict" });
    const request = operation(transactionValue.objectStore("probe"));
    transactionValue.oncomplete = () => resolve(request.result);
    transactionValue.onabort = () => reject(transactionValue.error ?? new DOMException("IndexedDB probe transaction aborted.", "AbortError"));
    transactionValue.onerror = () => reject(transactionValue.error ?? request.error ?? new Error("IndexedDB capability transaction failed."));
  });
}

function deleteDatabase(factory: IDBFactory | undefined, name: string): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

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

export type Hc3ProductCapabilityName = (typeof hc3ProductCapabilityNames)[number];
export type Hc3ProductCapabilityState = "available" | "fallback" | "blocked";

export type Hc3ProductCapability = Readonly<{
  name: Hc3ProductCapabilityName;
  state: Hc3ProductCapabilityState;
  fallback: string | null;
}>;

export type Hc3ProductCapabilityMatrix = Readonly<{
  authority: "none";
  probed_after_explicit_entry: true;
  user_agent_inspected: false;
  capabilities: readonly Hc3ProductCapability[];
}>;

type BarcodeDetectorConstructor = new (input?: Readonly<{ formats?: readonly string[] }>) => Readonly<{
  detect(source: ImageBitmapSource): Promise<readonly Readonly<{ rawValue?: string }>[]>
}>;

type CapabilityEnvironment = Readonly<{
  isSecureContext?: boolean;
  navigator?: Navigator & Readonly<{
    canShare?: (data?: ShareData) => boolean;
    storage?: StorageManager & Readonly<{ getDirectory?: () => Promise<unknown> }>;
  }>;
  document?: Document;
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  RTCPeerConnection?: typeof RTCPeerConnection;
  BarcodeDetector?: BarcodeDetectorConstructor & Readonly<{ getSupportedFormats?: () => Promise<readonly string[]> }>;
  showOpenFilePicker?: unknown;
  showSaveFilePicker?: unknown;
}>;

export async function detectHc3ProductCapabilities(
  environment: CapabilityEnvironment
): Promise<Hc3ProductCapabilityMatrix> {
  const navigatorValue = environment.navigator;
  const nativeQr = await supportsNativeQr(environment.BarcodeDetector);
  const indexedDb = Boolean(environment.indexedDB);
  const cryptoAvailable = await supportsRequiredWebCrypto(environment.crypto);
  const persistedKey = indexedDb && cryptoAvailable
    ? await supportsNonExtractableKeyPersistence(environment)
    : false;
  const dataChannels = supportsDataChannels(environment.RTCPeerConnection);
  const fileShare = supportsFileShare(navigatorValue);
  const capabilities: Hc3ProductCapability[] = [
    capability("clipboard_write", Boolean(environment.isSecureContext && navigatorValue?.clipboard?.writeText), "Select and copy the artifact manually"),
    capability("web_share_text", typeof navigatorValue?.share === "function", "Copy the exact text"),
    capability("web_share_files", fileShare, "Save the encrypted file"),
    capability("save_file_picker", typeof environment.showSaveFilePicker === "function", "Browser download"),
    capability("open_file_picker", typeof environment.showOpenFilePicker === "function", "File upload control"),
    capability("download_upload_fallback", Boolean(environment.document?.createElement), null),
    capability("qr_rendering", true, null),
    capability("native_qr_scanning", nativeQr, "Choose a QR image or paste text"),
    capability("image_qr_scanning", Boolean(environment.document?.createElement && globalThis.createImageBitmap), "Paste exact text"),
    capability("camera_access", Boolean(environment.isSecureContext && navigatorValue?.mediaDevices?.getUserMedia), "Choose a QR image or paste text"),
    capability("webrtc_data_channels", dataChannels, "Send an encrypted update"),
    capability("indexeddb", indexedDb, "Collaboration is blocked on this device"),
    capability("non_extractable_key_persistence", persistedKey, "Collaboration setup is blocked on this device"),
    capability("web_locks", Boolean(navigatorValue?.locks?.request), "Use the existing transactional fallback"),
    capability("opfs", Boolean(navigatorValue?.storage && "getDirectory" in navigatorValue.storage), "Use the selected portable folder"),
    capability("file_system_access", typeof environment.showOpenFilePicker === "function" || typeof environment.showSaveFilePicker === "function", "Use download and upload controls"),
    capability("required_webcrypto", cryptoAvailable, "Collaboration is blocked on this device")
  ];
  return Object.freeze({
    authority: "none",
    probed_after_explicit_entry: true,
    user_agent_inspected: false,
    capabilities: Object.freeze(capabilities)
  });
}

function capability(name: Hc3ProductCapabilityName, available: boolean, fallback: string | null): Hc3ProductCapability {
  return Object.freeze({
    name,
    state: available ? "available" : fallback ? "fallback" : "blocked",
    fallback: available ? null : fallback
  });
}

async function supportsNativeQr(detector: CapabilityEnvironment["BarcodeDetector"]): Promise<boolean> {
  if (!detector) return false;
  try {
    const formats = await detector.getSupportedFormats?.();
    return formats === undefined || formats.includes("qr_code");
  } catch {
    return false;
  }
}

function supportsFileShare(navigatorValue: CapabilityEnvironment["navigator"]): boolean {
  if (!navigatorValue?.share || !navigatorValue.canShare || typeof File !== "function") return false;
  try {
    return navigatorValue.canShare({ files: [new File([new Uint8Array()], "update.pmcb", { type: "application/vnd.patchmark.collaboration-bundle" })] });
  } catch {
    return false;
  }
}

function supportsDataChannels(Peer: CapabilityEnvironment["RTCPeerConnection"]): boolean {
  if (!Peer) return false;
  let peer: RTCPeerConnection | null = null;
  try {
    peer = new Peer({ iceServers: [] });
    const channel = peer.createDataChannel("patchmark-capability-probe", { ordered: true });
    channel.close();
    return true;
  } catch {
    return false;
  } finally {
    peer?.close();
  }
}

async function supportsRequiredWebCrypto(cryptoValue: Crypto | undefined): Promise<boolean> {
  if (!cryptoValue?.subtle) return false;
  try {
    const bytes = new TextEncoder().encode("patchmark-hc3-slice4-capability-probe");
    const digest = await cryptoValue.subtle.digest("SHA-256", bytes);
    const aes = await cryptoValue.subtle.importKey("raw", new Uint8Array(32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const encrypted = await cryptoValue.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, aes, bytes);
    return digest.byteLength === 32 && encrypted.byteLength > bytes.byteLength && aes.extractable === false;
  } catch {
    return false;
  }
}

async function supportsNonExtractableKeyPersistence(environment: CapabilityEnvironment): Promise<boolean> {
  const databaseName = "patchmark-hc3-slice4-capability-probe";
  try {
    const key = await environment.crypto!.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const database = await openDatabase(environment.indexedDB!, databaseName);
    await transaction(database, "readwrite", (store) => store.put(key, "key"));
    const reopened = await transaction(database, "readonly", (store) => store.get("key"));
    database.close();
    return reopened instanceof CryptoKey && reopened.extractable === false;
  } catch {
    return false;
  } finally {
    try { environment.indexedDB?.deleteDatabase(databaseName); } catch { /* best-effort probe cleanup */ }
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("probe");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB capability probe failed."));
  });
}

function transaction(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = operation(database.transaction("probe", mode).objectStore("probe"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB capability transaction failed."));
  });
}

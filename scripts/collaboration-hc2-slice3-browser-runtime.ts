import {
  buildBoundHpkeAad,
  buildHpkeInfo,
  type PublicEnvelopeHeader
} from "../lib/collaboration/hc2/envelope.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "../lib/collaboration/hc2/versions.ts";
import { NativeEd25519SignatureProvider } from "../lib/collaboration/hc2/providers/ed25519-provider.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { WorkerRecoveryProtector } from "../lib/collaboration/hc2/providers/recovery-provider.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import type { SenderSignaturePreimageBytes } from "../lib/collaboration/hc2/crypto-contracts.ts";
import type { AcceptedSignerPublicKey } from "../lib/collaboration/hc2/crypto-contracts.ts";

const ED25519_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const ED25519_SIGNATURE = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

export async function runBrowserEvidence(databaseName: string) {
  const edPair = asKeyPair(await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]));
  const xPair = asKeyPair(await crypto.subtle.generateKey("X25519", false, ["deriveBits"]));
  const before = {
    ed_private_extractable: edPair.privateKey.extractable,
    x_private_extractable: xPair.privateKey.extractable,
    ed_public_extractable: edPair.publicKey.extractable,
    x_public_extractable: xPair.publicKey.extractable
  };
  await storePairs(databaseName, edPair, xPair);
  const restored = await loadPairs(databaseName);
  const registry = new Hc2NativeKeyRegistry(crypto.subtle);
  const signing = await registry.adoptDeviceSigningKeyPair(entity("public-key", "a"), restored.ed);
  const recipient = await registry.adoptRecipientKeyPair(entity("public-key", "b"), restored.x);
  const signatures = new NativeEd25519SignatureProvider(registry);
  const preimage = new TextEncoder().encode("browser persisted Ed25519 key") as SenderSignaturePreimageBytes;
  const persistedSignature = await signatures.sign({ key: signing.handle, preimage });
  const signer = {
    resolution: "accepted_control_state",
    project_id: entity("project", "c"),
    device_id: entity("device", "d"),
    key_id: entity("public-key", "a"),
    control_head_id: digest("control-event", "e"),
    algorithm: "ed25519",
    public_key_bytes: signing.public_key
  } as unknown as AcceptedSignerPublicKey;
  const persistedVerification = await signatures.verify({ signer, preimage, signature_bytes: persistedSignature.signature_bytes });

  const plaintext = new TextEncoder().encode("browser persisted X25519 key");
  const infoBinding = {
    envelope_version: 1 as const,
    suite_id: HC2_CRYPTO_SUITE_ID,
    envelope_id: "a".repeat(26) as import("../lib/collaboration/hc2/identities.ts").EnvelopeId,
    recipient_routing_tag: new Uint8Array(32),
    chunk_ordinal: 0,
    chunk_count: 1
  };
  const info = buildHpkeInfo(infoBinding);
  const hpke = new SingleShotHpkeProvider({ keys: registry });
  let capturedHeader: PublicEnvelopeHeader | null = null;
  const sealed = await hpke.sealBound({
    recipient_public_key: recipient.public_key,
    info,
    plaintext,
    finalize_aad(encapsulatedKeyBytes) {
      capturedHeader = {
        magic: HC2_ENVELOPE_MAGIC,
        ...infoBinding,
        encapsulated_key_bytes: Uint8Array.from(encapsulatedKeyBytes),
        ciphertext_length: BigInt(plaintext.length + 16)
      };
      return buildBoundHpkeAad(capturedHeader);
    }
  });
  const finalHeader = requireFinalHeader(capturedHeader);
  const opened = await hpke.openBound({
    recipient_key_pair: recipient,
    info,
    public_header: finalHeader,
    ciphertext_bytes: sealed.ciphertext_bytes
  });

  let edPrivateExportRejected = false;
  let xPrivateExportRejected = false;
  try { await crypto.subtle.exportKey("pkcs8", restored.ed.privateKey); } catch { edPrivateExportRejected = true; }
  try { await crypto.subtle.exportKey("pkcs8", restored.x.privateKey); } catch { xPrivateExportRejected = true; }
  const edPublic = new Uint8Array(await crypto.subtle.exportKey("raw", restored.ed.publicKey));
  const xPublic = new Uint8Array(await crypto.subtle.exportKey("raw", restored.x.publicKey));

  const vectorPrivate = await crypto.subtle.importKey("pkcs8", Uint8Array.from(concatHex("302e020100300506032b657004220420", ED25519_SEED)).buffer, "Ed25519", false, ["sign"]);
  const deterministic = new Uint8Array(await crypto.subtle.sign("Ed25519", vectorPrivate, new Uint8Array()));
  await deleteDatabase(databaseName);
  return {
    ...before,
    restored_ed_private_extractable: restored.ed.privateKey.extractable,
    restored_x_private_extractable: restored.x.privateKey.extractable,
    ed_private_export_rejected: edPrivateExportRejected,
    x_private_export_rejected: xPrivateExportRejected,
    ed_public_bytes: edPublic.length,
    x_public_bytes: xPublic.length,
    persisted_signature_status: persistedVerification.status,
    persisted_hpke_status: opened.status,
    persisted_hpke_plaintext: opened.status === "opened" ? new TextDecoder().decode(opened.plaintext) : null,
    final_header_enc_matches_returned: sameBytes(finalHeader.encapsulated_key_bytes, sealed.encapsulated_key_bytes),
    hpke_evidence: hpke.evidence(),
    deterministic_ed25519_signature_hex: toHex(deterministic),
    deterministic_ed25519_matches_rfc: toHex(deterministic) === ED25519_SIGNATURE,
    database_deleted: true
  };
}

export async function runRecoveryBenchmark() {
  const protector = new WorkerRecoveryProtector({ random: new WebCryptoRandomSource(crypto) });
  const personId = entity("person", "f");
  const protectCapability = { scope: "root_ceremony_only", person_id: personId } as unknown as import("../lib/collaboration/hc2/crypto-contracts.ts").RootCeremonyCapability;
  const unlockCapability = { scope: "recovery_ceremony_only", person_id: personId } as unknown as import("../lib/collaboration/hc2/crypto-contracts.ts").RecoveryCeremonyCapability;
  const password = new TextEncoder().encode("browser benchmark password");
  const payload = new TextEncoder().encode("browser recovery payload");
  const samples: number[] = [];
  let protectedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (let index = 0; index < 3; index += 1) {
    const result = await protector.protect({ capability: protectCapability, recovery_payload: payload, password_material: password });
    protectedBytes = result.protected_bytes;
    samples.push(protector.evidence()?.worker_runtime_ms ?? 0);
  }
  const opened = await protector.unlock({ capability: unlockCapability, protected_bytes: protectedBytes, password_material: password });
  samples.sort((left, right) => left - right);
  return {
    samples_ms: samples,
    median_ms: samples[1],
    worst_ms: samples[2],
    unlock_status: opened.status,
    unlock_plaintext: opened.status === "unlocked" ? new TextDecoder().decode(opened.ceremony_payload) : null,
    worker_terminated: protector.evidence()?.worker_terminated === true,
    parameter_memory_bytes: 64 * 1024 * 1024,
    parameter_opslimit: 3,
    parallelism: "provider_managed_not_configurable"
  };
}

async function storePairs(databaseName: string, ed: CryptoKeyPair, x: CryptoKeyPair): Promise<void> {
  const database = await openDatabase(databaseName);
  try {
    const transaction = database.transaction("pairs", "readwrite", { durability: "strict" });
    transaction.objectStore("pairs").put({ ed, x }, "native-pairs");
    await transactionDone(transaction);
  } finally { database.close(); }
}

async function loadPairs(databaseName: string): Promise<{ ed: CryptoKeyPair; x: CryptoKeyPair }> {
  const database = await openDatabase(databaseName);
  try {
    const transaction = database.transaction("pairs", "readonly");
    const request = transaction.objectStore("pairs").get("native-pairs");
    const value = await requestResult<{ ed: CryptoKeyPair; x: CryptoKeyPair }>(request);
    await transactionDone(transaction);
    if (!value?.ed || !value?.x) throw new Error("Persisted native keys were not restored.");
    return value;
  } finally { database.close(); }
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pairs");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB deletion was blocked."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function asKeyPair(value: CryptoKeyPair | CryptoKey): CryptoKeyPair {
  if (!("privateKey" in value)) throw new Error("Expected CryptoKeyPair.");
  return value;
}

function requireFinalHeader(value: PublicEnvelopeHeader | null): PublicEnvelopeHeader {
  if (!value) throw new Error("HPKE final header was not constructed.");
  return value;
}

function entity(kind: string, fill: string): never { return `pm:${kind}:v1:${fill.repeat(25)}a` as never; }
function digest(kind: string, fill: string): never { return `pm:${kind}:v1:${fill.repeat(51)}a` as never; }
function hex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function concatHex(prefix: string, body: string): Uint8Array { return hex(prefix + body); }
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }

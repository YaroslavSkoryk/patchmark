import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import { expectBytes, expectExactRecord, expectLiteral, expectUInt64, freezeRecord } from "../validation.ts";
import type { AlgorithmTaggedPublicKeyBytes, RandomSource, SenderSignaturePreimageBytes } from "./crypto-contracts.ts";
import type { AcceptedCustodyAuthority, LoadedDeviceCustody } from "./custody-types.ts";
import {
  parseCustodyCeremonyJournal,
  parseStoredDeviceVaultRecord,
  type CustodyCeremonyJournal,
  type CustodyCompletionMarker,
  type Hc2CustodyStore,
  type StoredDeviceVaultRecord
} from "./custody-store.ts";
import { Hc2DeviceVaultService } from "./device-vault.ts";
import {
  deriveEpochCommitment,
  wrapEpochSecret,
  type EpochCommitment
} from "./epoch-custody.ts";
import { HC2_CEREMONY_JOURNAL_VERSION, HC2_CRYPTO_SUITE_ID, HC2_CUSTODY_SCHEMA_VERSION, HC2_ENVELOPE_MAGIC } from "./versions.ts";
import { buildBoundHpkeAad, buildHpkeInfo } from "./envelope.ts";
import { NativeEd25519SignatureProvider } from "./providers/ed25519-provider.ts";
import { SingleShotHpkeProvider } from "./providers/hpke-provider.ts";
import { Hc2NativeKeyRegistry, validateEd25519Pair, validateX25519Pair } from "./providers/native-key-handles.ts";
import { exportAndEncodePublicKey } from "./providers/public-key-codec.ts";
import { validateWrappingKey } from "./epoch-custody.ts";

export type PendingEnrollmentVaultRecord = Readonly<{
  schema_version: 1;
  record_kind: "pending_enrollment_device_vault";
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  access_scope_id: AccessScopeId;
  generation: bigint;
  signing_key_id: PublicKeyId;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  signing_key_pair: CryptoKeyPair;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recipient_key_pair: CryptoKeyPair;
  local_kek: CryptoKey;
  offline_root_key_id: PublicKeyId;
  bound_control_head_id: ControlEventId;
  status: "pending_owner_approval";
}>;

export type PendingEnrollmentPublicBinding = Readonly<{
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  access_scope_id: AccessScopeId;
  generation: bigint;
  signing_key_id: PublicKeyId;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  offline_root_key_id: PublicKeyId;
  bound_control_head_id: ControlEventId;
}>;

export type EnrollmentAdmissionCompletionMarker = Readonly<{
  schema_version: 1;
  record_kind: "enrollment_admission_completion_marker";
  project_id: ProjectId;
  device_id: DeviceId;
  accepted_control_event_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  admission_package_id: string;
  receipt_id: string;
  completion: "epoch_installed_and_acknowledged";
}>;

export interface Hc2EnrollmentCandidateStore {
  putPendingVault(record: PendingEnrollmentVaultRecord): Promise<"stored" | "exact_retry">;
  readPendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<PendingEnrollmentVaultRecord | null>;
  deletePendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<void>;
  writeCompletionMarker(marker: EnrollmentAdmissionCompletionMarker): Promise<void>;
  readCompletionMarker(projectId: ProjectId, deviceId: DeviceId): Promise<EnrollmentAdmissionCompletionMarker | null>;
}

export class Hc2InMemoryEnrollmentCandidateStore implements Hc2EnrollmentCandidateStore {
  readonly #pending = new Map<string, PendingEnrollmentVaultRecord>();
  readonly #completion = new Map<string, EnrollmentAdmissionCompletionMarker>();
  async putPendingVault(value: PendingEnrollmentVaultRecord): Promise<"stored" | "exact_retry"> {
    const record = parsePendingEnrollmentVaultRecord(value); const key = vaultKey(record.project_id, record.device_id); const existing = this.#pending.get(key);
    if (existing) { if (!samePending(existing, record)) throw new Error("A different pending candidate vault already exists."); return "exact_retry"; }
    this.#pending.set(key, record); return "stored";
  }
  async readPendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<PendingEnrollmentVaultRecord | null> { const record = this.#pending.get(vaultKey(projectId, deviceId)); return record ? parsePendingEnrollmentVaultRecord(record) : null; }
  async deletePendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<void> { this.#pending.delete(vaultKey(projectId, deviceId)); }
  async writeCompletionMarker(value: EnrollmentAdmissionCompletionMarker): Promise<void> { const marker = parseEnrollmentAdmissionCompletionMarker(value); const key = vaultKey(marker.project_id, marker.device_id); const existing = this.#completion.get(key); if (existing && !sameCompletion(existing, marker)) throw new Error("Conflicting admission completion marker."); this.#completion.set(key, marker); }
  async readCompletionMarker(projectId: ProjectId, deviceId: DeviceId): Promise<EnrollmentAdmissionCompletionMarker | null> { const marker = this.#completion.get(vaultKey(projectId, deviceId)); return marker ? parseEnrollmentAdmissionCompletionMarker(marker) : null; }
}

const enrollmentDatabaseVersion = 1;
const enrollmentStores = Object.freeze({ pending: "pending_enrollment_vaults", completion: "enrollment_completion_markers" });
export const hc2EnrollmentCustodyDatabaseSchema = Object.freeze({ version: enrollmentDatabaseVersion, stores: Object.freeze(Object.values(enrollmentStores).sort()) });

export class Hc2IndexedDbEnrollmentCandidateStore implements Hc2EnrollmentCandidateStore {
  readonly #factory: IDBFactory; readonly #name: string; #database: IDBDatabase | null = null;
  constructor(input: Readonly<{ indexed_db: IDBFactory; database_name: string }>) { if (!input?.indexed_db || typeof input.database_name !== "string" || !input.database_name || input.database_name.includes("\u0000")) throw new Error("Enrollment custody IndexedDB requires an injected factory and explicit name."); this.#factory = input.indexed_db; this.#name = input.database_name; }
  async open(): Promise<void> { if (this.#database) return; this.#database = await new Promise<IDBDatabase>((resolve, reject) => { const request = this.#factory.open(this.#name, enrollmentDatabaseVersion); request.onupgradeneeded = () => { for (const name of Object.values(enrollmentStores)) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); }; request.onerror = () => reject(request.error ?? new Error("Enrollment custody IndexedDB open failed.")); request.onsuccess = () => resolve(request.result); }); this.#database.onversionchange = () => this.close(); }
  close(): void { this.#database?.close(); this.#database = null; }
  async putPendingVault(value: PendingEnrollmentVaultRecord): Promise<"stored" | "exact_retry"> { const record = parsePendingEnrollmentVaultRecord(value); const transaction = strictTransaction(this.#require(), [enrollmentStores.pending], "readwrite"); const store = transaction.objectStore(enrollmentStores.pending); const key = vaultKey(record.project_id, record.device_id); const raw = await requestValue<unknown>(store.get(key)); if (raw !== undefined) { const existing = parsePendingEnrollmentVaultRecord(raw); if (!samePending(existing, record)) { transaction.abort(); throw new Error("A different pending candidate vault already exists."); } await transactionDone(transaction); return "exact_retry"; } store.add(record, key); await transactionDone(transaction); return "stored"; }
  async readPendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<PendingEnrollmentVaultRecord | null> { return this.#read(enrollmentStores.pending, vaultKey(projectId, deviceId), parsePendingEnrollmentVaultRecord); }
  async deletePendingVault(projectId: ProjectId, deviceId: DeviceId): Promise<void> { const transaction = strictTransaction(this.#require(), [enrollmentStores.pending], "readwrite"); transaction.objectStore(enrollmentStores.pending).delete(vaultKey(projectId, deviceId)); await transactionDone(transaction); }
  async writeCompletionMarker(value: EnrollmentAdmissionCompletionMarker): Promise<void> { const marker = parseEnrollmentAdmissionCompletionMarker(value); const transaction = strictTransaction(this.#require(), [enrollmentStores.completion], "readwrite"); const store = transaction.objectStore(enrollmentStores.completion); const key = vaultKey(marker.project_id, marker.device_id); const raw = await requestValue<unknown>(store.get(key)); if (raw !== undefined && !sameCompletion(parseEnrollmentAdmissionCompletionMarker(raw), marker)) { transaction.abort(); throw new Error("Conflicting admission completion marker."); } store.put(marker, key); await transactionDone(transaction); }
  async readCompletionMarker(projectId: ProjectId, deviceId: DeviceId): Promise<EnrollmentAdmissionCompletionMarker | null> { return this.#read(enrollmentStores.completion, vaultKey(projectId, deviceId), parseEnrollmentAdmissionCompletionMarker); }
  async #read<T>(storeName: string, key: IDBValidKey, parse: (value: unknown) => T): Promise<T | null> { const transaction = strictTransaction(this.#require(), [storeName], "readonly"); const raw = await requestValue<unknown>(transaction.objectStore(storeName).get(key)); await transactionDone(transaction); return raw === undefined ? null : parse(raw); }
  #require(): IDBDatabase { if (!this.#database) throw new Error("Enrollment custody IndexedDB must be opened explicitly."); return this.#database; }
}

export class Hc2EnrollmentCustodyService {
  readonly #pending: Hc2EnrollmentCandidateStore; readonly #custody: Hc2CustodyStore; readonly #random: RandomSource; readonly #subtle: SubtleCrypto;
  constructor(input: Readonly<{ pending_store: Hc2EnrollmentCandidateStore; custody_store: Hc2CustodyStore; random: RandomSource; subtle?: SubtleCrypto }>) { if (!input?.pending_store || !input.custody_store || !input.random) throw new Error("Enrollment custody requires pending storage, final custody, and secure randomness."); this.#pending = input.pending_store; this.#custody = input.custody_store; this.#random = input.random; this.#subtle = input.subtle ?? requireSubtle(); }

  async createCandidate(input: Readonly<{ project_id: ProjectId; person_id: PersonId; device_id: DeviceId; access_scope_id: AccessScopeId; generation: bigint; signing_key_id: PublicKeyId; recipient_key_id: PublicKeyId; offline_root_key_id: PublicKeyId; bound_control_head_id: ControlEventId }>): Promise<Readonly<{ status: "stored" | "exact_retry"; public_binding: PendingEnrollmentPublicBinding }>> {
    const projectId = parseEntityId("project", input.project_id); const personId = parseEntityId("person", input.person_id); const deviceId = parseEntityId("device", input.device_id); const accessScopeId = parseEntityId("access-scope", input.access_scope_id); const signingKeyId = parseEntityId("public-key", input.signing_key_id); const recipientKeyId = parseEntityId("public-key", input.recipient_key_id); const rootKeyId = parseEntityId("public-key", input.offline_root_key_id); const controlHead = parseDigestId("control-event", input.bound_control_head_id); const generation = expectUInt64(input.generation, "pending vault generation");
    const existing = await this.#pending.readPendingVault(projectId, deviceId); if (existing) { const parsed = parsePendingEnrollmentVaultRecord(existing); if (parsed.person_id !== personId || parsed.access_scope_id !== accessScopeId || parsed.generation !== generation || parsed.signing_key_id !== signingKeyId || parsed.recipient_key_id !== recipientKeyId || parsed.offline_root_key_id !== rootKeyId || parsed.bound_control_head_id !== controlHead) throw new Error("Pending candidate exact retry differs from the installed keys."); await selfTest(this.#subtle, parsed); return Object.freeze({ status: "exact_retry", public_binding: publicBinding(parsed) }); }
    const signingPair = asPair(await this.#subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])); const recipientPair = asPair(await this.#subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])); const localKek = await this.#subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); validateEd25519Pair(signingPair); validateX25519Pair(recipientPair); validateWrappingKey(localKek);
    const signingPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "ed25519", key_id: signingKeyId, public_key: signingPair.publicKey }); const recipientPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "x25519", key_id: recipientKeyId, public_key: recipientPair.publicKey });
    const record = parsePendingEnrollmentVaultRecord({ schema_version: 1, record_kind: "pending_enrollment_device_vault", suite_id: HC2_CRYPTO_SUITE_ID, project_id: projectId, person_id: personId, device_id: deviceId, access_scope_id: accessScopeId, generation, signing_key_id: signingKeyId, signing_public_key_bytes: signingPublic, signing_key_pair: signingPair, recipient_key_id: recipientKeyId, recipient_public_key_bytes: recipientPublic, recipient_key_pair: recipientPair, local_kek: localKek, offline_root_key_id: rootKeyId, bound_control_head_id: controlHead, status: "pending_owner_approval" });
    await selfTest(this.#subtle, record); const status = await this.#pending.putPendingVault(record); return Object.freeze({ status, public_binding: publicBinding(record) });
  }

  async reopenCandidate(projectId: ProjectId, deviceId: DeviceId): Promise<PendingEnrollmentPublicBinding> { const record = await this.#pending.readPendingVault(parseEntityId("project", projectId), parseEntityId("device", deviceId)); if (!record) throw new Error("Pending candidate custody is absent."); const parsed = parsePendingEnrollmentVaultRecord(record); await selfTest(this.#subtle, parsed); return publicBinding(parsed); }

  async signPending(input: Readonly<{ project_id: ProjectId; device_id: DeviceId; preimage: SenderSignaturePreimageBytes }>): Promise<Uint8Array> { const record = await this.#pending.readPendingVault(input.project_id, input.device_id); if (!record) throw new Error("Pending candidate custody is absent."); const registry = new Hc2NativeKeyRegistry(this.#subtle); const adopted = await registry.adoptDeviceSigningKeyPair(record.signing_key_id, record.signing_key_pair); const result = await new NativeEd25519SignatureProvider(registry).sign({ key: adopted.handle, preimage: input.preimage }); return Uint8Array.from(result.signature_bytes); }

  async openPendingEnvelope(input: Readonly<{ project_id: ProjectId; device_id: DeviceId; info: Parameters<SingleShotHpkeProvider["openBound"]>[0]["info"]; public_header: Parameters<SingleShotHpkeProvider["openBound"]>[0]["public_header"]; ciphertext_bytes: Parameters<SingleShotHpkeProvider["openBound"]>[0]["ciphertext_bytes"] }>): Promise<Awaited<ReturnType<SingleShotHpkeProvider["openBound"]>>> { const record = await this.#pending.readPendingVault(input.project_id, input.device_id); if (!record) throw new Error("Pending candidate custody is absent."); const registry = new Hc2NativeKeyRegistry(this.#subtle); const pair = await registry.adoptRecipientKeyPair(record.recipient_key_id, record.recipient_key_pair); return new SingleShotHpkeProvider({ keys: registry }).openBound({ recipient_key_pair: pair, info: input.info, public_header: input.public_header, ciphertext_bytes: input.ciphertext_bytes }); }

  async installDeliveredEpoch(input: Readonly<{ project_id: ProjectId; device_id: DeviceId; accepted_control_event_id: ControlEventId; key_epoch_id: KeyEpochId; key_epoch_commitment: KeyEpochCommitmentId; public_commitment_bytes: Uint8Array; epoch_secret: Uint8Array; admission_plan_sha256: Uint8Array; ceremony_id: string }>): Promise<Readonly<{ commitment: EpochCommitment; vault: StoredDeviceVaultRecord }>> {
    const pending = await this.#pending.readPendingVault(input.project_id, input.device_id); if (!pending) throw new Error("Pending candidate custody is absent."); const secret = exactDigest(input.epoch_secret, "delivered epoch secret"); const planDigest = exactDigest(input.admission_plan_sha256, "admission plan digest"); const priorJournal = await this.#custody.readCeremony(pending.project_id, input.ceremony_id);
    if (priorJournal && (priorJournal.phase === "keys_installed" || priorJournal.phase === "portable_visible" || priorJournal.phase === "complete")) {
      try {
        const commitment = await deriveEpochCommitment({ project_id: pending.project_id, key_epoch_id: input.key_epoch_id, epoch_secret: Uint8Array.from(secret) });
        const vault = await this.#custody.readVault(pending.project_id, pending.device_id); const wrapped = await this.#custody.readWrappedEpoch(pending.project_id, pending.device_id, commitment.key_epoch_id);
        if (!vault || !wrapped || vault.accepted_control_head_id !== input.accepted_control_event_id || vault.current_epoch_id !== commitment.key_epoch_id || vault.current_epoch_commitment !== commitment.key_epoch_commitment || !sameBytes(vault.current_epoch_public_commitment_bytes, commitment.public_commitment_bytes)) throw new Error("Installed enrollment custody conflicts with the exact retry.");
        return Object.freeze({ commitment, vault });
      } finally { secret.fill(0); planDigest.fill(0); }
    }
    const nonce = Uint8Array.from(await this.#random.randomBytes(12));
    try {
      if (await this.#custody.hasWrappingNonce(pending.project_id, pending.device_id, pending.generation, nonce)) throw new Error("AES-GCM wrapping nonce collision detected; enrollment will not retry randomness.");
      const expected = await deriveEpochCommitment({ project_id: pending.project_id, key_epoch_id: input.key_epoch_id, epoch_secret: Uint8Array.from(secret) });
      if (expected.key_epoch_commitment !== parseDigestId("key-epoch-commitment", input.key_epoch_commitment) || !sameBytes(expected.public_commitment_bytes, exactDigest(input.public_commitment_bytes, "epoch public commitment"))) throw new Error("Delivered epoch does not match the accepted public commitment.");
      const wrapped = await wrapEpochSecret({ key: pending.local_kek, project_id: pending.project_id, device_id: pending.device_id, key_epoch_id: expected.key_epoch_id, wrapping_key_generation: pending.generation, epoch_secret: Uint8Array.from(secret), nonce, subtle: this.#subtle });
      const planned = parseCustodyCeremonyJournal({ schema_version: HC2_CEREMONY_JOURNAL_VERSION, record_kind: "custody_ceremony_journal", ceremony_kind: "device_enrollment", ceremony_id: input.ceremony_id, plan_sha256: planDigest, project_id: pending.project_id, person_id: pending.person_id, device_id: pending.device_id, lost_device_id: null, root_key_id: pending.offline_root_key_id, key_epoch_id: expected.key_epoch_id, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned" });
      const begun = await this.#custody.beginCeremony(planned); let current = begun.journal;
      if (current.phase === "planned") current = await this.#custody.advanceCeremony("planned", parseCustodyCeremonyJournal({ ...current, phase: "admission_verified" }));
      if (current.phase !== "admission_verified" && current.phase !== "keys_installed") throw new Error("Enrollment custody ceremony is not resumable at its current phase.");
      const acceptedControl = parseDigestId("control-event", input.accepted_control_event_id);
      const verifiedJournal = parseCustodyCeremonyJournal({ ...current, phase: "admission_verified", accepted_control_head_id: acceptedControl });
      const vault = parseStoredDeviceVaultRecord({ schema_version: HC2_CUSTODY_SCHEMA_VERSION, record_kind: "device_key_vault", suite_id: HC2_CRYPTO_SUITE_ID, project_id: pending.project_id, person_id: pending.person_id, device_id: pending.device_id, access_scope_id: pending.access_scope_id, generation: pending.generation, signing_key_id: pending.signing_key_id, signing_public_key_bytes: pending.signing_public_key_bytes, signing_key_pair: pending.signing_key_pair, recipient_key_id: pending.recipient_key_id, recipient_public_key_bytes: pending.recipient_public_key_bytes, recipient_key_pair: pending.recipient_key_pair, local_kek: pending.local_kek, local_kek_algorithm: "AES-GCM-256", local_kek_usages: ["encrypt", "decrypt"], accepted_control_head_id: acceptedControl, offline_root_key_id: pending.offline_root_key_id, current_epoch_id: expected.key_epoch_id, current_epoch_commitment: expected.key_epoch_commitment, current_epoch_public_commitment_bytes: expected.public_commitment_bytes, recovery_kit_sha256: null, status: "active" });
      if (current.phase !== "keys_installed") await this.#custody.installCustody({ journal: verifiedJournal, vault, wrapped_epoch: wrapped });
      return Object.freeze({ commitment: expected, vault });
    } finally { secret.fill(0); nonce.fill(0); planDigest.fill(0); }
  }

  async loadInstalled(authority: AcceptedCustodyAuthority): Promise<LoadedDeviceCustody> { return new Hc2DeviceVaultService({ store: this.#custody, random: this.#random, subtle: this.#subtle }).loadAndVerify(authority); }

  async finalizeAdmission(input: Readonly<{ project_id: ProjectId; device_id: DeviceId; accepted_control_event_id: ControlEventId; key_epoch_id: KeyEpochId; key_epoch_commitment: KeyEpochCommitmentId; ceremony_id: string; admission_package_id: string; receipt_id: string }>): Promise<void> {
    const journal = await this.#custody.readCeremony(input.project_id, input.ceremony_id); if (!journal) throw new Error("Enrollment custody journal is missing."); let current: CustodyCeremonyJournal = journal;
    if (current.phase === "keys_installed") current = await this.#custody.advanceCeremony("keys_installed", parseCustodyCeremonyJournal({ ...current, phase: "portable_visible" }));
    if (current.phase !== "portable_visible" && current.phase !== "complete") throw new Error("Enrollment custody cannot be completed from its current phase.");
    if (current.phase !== "complete") { const marker: CustodyCompletionMarker = Object.freeze({ schema_version: HC2_CEREMONY_JOURNAL_VERSION, record_kind: "custody_completion_marker", ceremony_id: input.ceremony_id, ceremony_kind: "device_enrollment", project_id: parseEntityId("project", input.project_id), device_id: parseEntityId("device", input.device_id), root_key_id: current.root_key_id, key_epoch_id: parseEntityId("key-epoch", input.key_epoch_id), recovery_kit_sha256: null, accepted_control_head_id: parseDigestId("control-event", input.accepted_control_event_id), completion: "verified_local_ceremony" }); await this.#custody.writeCompletionMarker(marker); }
    await this.#pending.writeCompletionMarker(parseEnrollmentAdmissionCompletionMarker({ schema_version: 1, record_kind: "enrollment_admission_completion_marker", project_id: input.project_id, device_id: input.device_id, accepted_control_event_id: input.accepted_control_event_id, key_epoch_id: input.key_epoch_id, key_epoch_commitment: input.key_epoch_commitment, admission_package_id: input.admission_package_id, receipt_id: input.receipt_id, completion: "epoch_installed_and_acknowledged" }));
    await this.#pending.deletePendingVault(input.project_id, input.device_id);
  }
}

export function parsePendingEnrollmentVaultRecord(value: unknown): PendingEnrollmentVaultRecord { const record = expectExactRecord(value, "pending enrollment vault", ["schema_version", "record_kind", "suite_id", "project_id", "person_id", "device_id", "access_scope_id", "generation", "signing_key_id", "signing_public_key_bytes", "signing_key_pair", "recipient_key_id", "recipient_public_key_bytes", "recipient_key_pair", "local_kek", "offline_root_key_id", "bound_control_head_id", "status"]); const signingKeyId = parseEntityId("public-key", record.signing_key_id); const recipientKeyId = parseEntityId("public-key", record.recipient_key_id); const signingPublic = exactPublic(record.signing_public_key_bytes, "signing public key"); const recipientPublic = exactPublic(record.recipient_public_key_bytes, "recipient public key"); const signingPair = requirePair(record.signing_key_pair); const recipientPair = requirePair(record.recipient_key_pair); const kek = requireKey(record.local_kek); validateEd25519Pair(signingPair); validateX25519Pair(recipientPair); validateWrappingKey(kek); return freezeRecord({ schema_version: expectLiteral(record.schema_version, 1, "pending vault version"), record_kind: expectLiteral(record.record_kind, "pending_enrollment_device_vault", "pending vault kind"), suite_id: expectLiteral(record.suite_id, HC2_CRYPTO_SUITE_ID, "pending vault suite"), project_id: parseEntityId("project", record.project_id), person_id: parseEntityId("person", record.person_id), device_id: parseEntityId("device", record.device_id), access_scope_id: parseEntityId("access-scope", record.access_scope_id), generation: expectUInt64(record.generation, "pending vault generation"), signing_key_id: signingKeyId, signing_public_key_bytes: signingPublic, signing_key_pair: signingPair, recipient_key_id: recipientKeyId, recipient_public_key_bytes: recipientPublic, recipient_key_pair: recipientPair, local_kek: kek, offline_root_key_id: parseEntityId("public-key", record.offline_root_key_id), bound_control_head_id: parseDigestId("control-event", record.bound_control_head_id), status: expectLiteral(record.status, "pending_owner_approval", "pending vault status") }); }

export function parseEnrollmentAdmissionCompletionMarker(value: unknown): EnrollmentAdmissionCompletionMarker { const record = expectExactRecord(value, "enrollment completion marker", ["schema_version", "record_kind", "project_id", "device_id", "accepted_control_event_id", "key_epoch_id", "key_epoch_commitment", "admission_package_id", "receipt_id", "completion"]); return freezeRecord({ schema_version: expectLiteral(record.schema_version, 1, "completion marker version"), record_kind: expectLiteral(record.record_kind, "enrollment_admission_completion_marker", "completion marker kind"), project_id: parseEntityId("project", record.project_id), device_id: parseEntityId("device", record.device_id), accepted_control_event_id: parseDigestId("control-event", record.accepted_control_event_id), key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id), key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment), admission_package_id: safeDigestReference("admission-package", record.admission_package_id), receipt_id: safeDigestReference("epoch-receipt", record.receipt_id), completion: expectLiteral(record.completion, "epoch_installed_and_acknowledged", "completion state") }); }

async function selfTest(subtle: SubtleCrypto, record: PendingEnrollmentVaultRecord): Promise<void> { const signingPublic = await exportAndEncodePublicKey({ subtle, algorithm: "ed25519", key_id: record.signing_key_id, public_key: record.signing_key_pair.publicKey }); const recipientPublic = await exportAndEncodePublicKey({ subtle, algorithm: "x25519", key_id: record.recipient_key_id, public_key: record.recipient_key_pair.publicKey }); if (!sameBytes(signingPublic, record.signing_public_key_bytes) || !sameBytes(recipientPublic, record.recipient_public_key_bytes)) throw new Error("Reopened pending keys do not match their canonical public bindings."); const challenge = new TextEncoder().encode("patchmark/hc2/enrollment-custody-self-test/v1"); const signature = new Uint8Array(await subtle.sign("Ed25519", record.signing_key_pair.privateKey, challenge)); if (!(await subtle.verify("Ed25519", record.signing_key_pair.publicKey, signature, challenge))) throw new Error("Pending Ed25519 self-test failed."); const encrypted = await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12).fill(0xfe) }, record.local_kek, challenge); const opened = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12).fill(0xfe) }, record.local_kek, encrypted)); if (!sameBytes(opened, challenge)) throw new Error("Pending KEK self-test failed."); const registry = new Hc2NativeKeyRegistry(subtle); const pair = await registry.adoptRecipientKeyPair(record.recipient_key_id, record.recipient_key_pair); const provider = new SingleShotHpkeProvider({ keys: registry }); const binding = { envelope_version: 1 as const, suite_id: HC2_CRYPTO_SUITE_ID, envelope_id: "z".repeat(26) as import("./identities.ts").EnvelopeId, recipient_routing_tag: new Uint8Array(32), chunk_ordinal: 0, chunk_count: 1 }; const info = buildHpkeInfo(binding); let header: import("./envelope.ts").PublicEnvelopeHeader | null = null; const sealed = await provider.sealBound({ recipient_public_key: record.recipient_public_key_bytes, info, plaintext: challenge, finalize_aad(enc) { header = { magic: HC2_ENVELOPE_MAGIC, ...binding, encapsulated_key_bytes: Uint8Array.from(enc), ciphertext_length: BigInt(challenge.length + 16) }; return buildBoundHpkeAad(header); } }); if (!header) throw new Error("Pending X25519 self-test header is absent."); const result = await provider.openBound({ recipient_key_pair: pair, info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes }); if (result.status !== "opened" || !sameBytes(result.plaintext, challenge)) throw new Error("Pending X25519 self-test failed."); }
function publicBinding(record: PendingEnrollmentVaultRecord): PendingEnrollmentPublicBinding { return Object.freeze({ project_id: record.project_id, person_id: record.person_id, device_id: record.device_id, access_scope_id: record.access_scope_id, generation: record.generation, signing_key_id: record.signing_key_id, signing_public_key_bytes: Uint8Array.from(record.signing_public_key_bytes) as AlgorithmTaggedPublicKeyBytes, recipient_key_id: record.recipient_key_id, recipient_public_key_bytes: Uint8Array.from(record.recipient_public_key_bytes) as AlgorithmTaggedPublicKeyBytes, offline_root_key_id: record.offline_root_key_id, bound_control_head_id: record.bound_control_head_id }); }
function samePending(left: PendingEnrollmentVaultRecord, right: PendingEnrollmentVaultRecord): boolean { return left.project_id === right.project_id && left.person_id === right.person_id && left.device_id === right.device_id && left.access_scope_id === right.access_scope_id && left.generation === right.generation && left.signing_key_id === right.signing_key_id && left.recipient_key_id === right.recipient_key_id && left.offline_root_key_id === right.offline_root_key_id && left.bound_control_head_id === right.bound_control_head_id && sameBytes(left.signing_public_key_bytes, right.signing_public_key_bytes) && sameBytes(left.recipient_public_key_bytes, right.recipient_public_key_bytes); }
function sameCompletion(left: EnrollmentAdmissionCompletionMarker, right: EnrollmentAdmissionCompletionMarker): boolean { return left.project_id === right.project_id && left.device_id === right.device_id && left.accepted_control_event_id === right.accepted_control_event_id && left.key_epoch_id === right.key_epoch_id && left.key_epoch_commitment === right.key_epoch_commitment && left.admission_package_id === right.admission_package_id && left.receipt_id === right.receipt_id; }
function exactPublic(value: unknown, label: string): AlgorithmTaggedPublicKeyBytes { const bytes = expectBytes(value, label); if (bytes.length === 0 || bytes.length > 512) throw new Error(`${label} has an invalid length.`); return Uint8Array.from(bytes) as AlgorithmTaggedPublicKeyBytes; }
function exactDigest(value: unknown, label: string): Uint8Array { const bytes = expectBytes(value, label); if (bytes.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`); return Uint8Array.from(bytes); }
function safeDigestReference(kind: string, value: unknown): string { if (typeof value !== "string" || !new RegExp(`^pm:${kind}:v1:[a-z2-7]{52}$`).test(value)) throw new Error(`${kind} reference is invalid.`); return value; }
function requirePair(value: unknown): CryptoKeyPair { if (!value || typeof value !== "object" || !("privateKey" in value) || !("publicKey" in value)) throw new Error("Pending vault key pair is invalid."); return value as CryptoKeyPair; }
function requireKey(value: unknown): CryptoKey { if (!(value instanceof CryptoKey)) throw new Error("Pending vault key is invalid."); return value; }
function asPair(value: CryptoKey | CryptoKeyPair): CryptoKeyPair { if (!value || !("privateKey" in value) || !("publicKey" in value)) throw new Error("WebCrypto did not return a key pair."); return value; }
function requireSubtle(): SubtleCrypto { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable."); return globalThis.crypto.subtle; }
function vaultKey(projectId: ProjectId, deviceId: DeviceId): string { return `${parseEntityId("project", projectId)}\u0000${parseEntityId("device", deviceId)}`; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function strictTransaction(database: IDBDatabase, names: readonly string[], mode: IDBTransactionMode): IDBTransaction { return database.transaction([...names], mode, { durability: "strict" }); }
function requestValue<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed.")); }); }
function transactionDone(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")); }); }

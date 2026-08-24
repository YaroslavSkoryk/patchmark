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
import type { AlgorithmTaggedPublicKeyBytes } from "./crypto-contracts.ts";
import { parseWrappedLocalEpochRecord, type WrappedLocalEpochRecord } from "./epoch-custody.ts";
import { decodeAlgorithmTaggedPublicKey } from "./providers/public-key-codec.ts";
import {
  HC2_CEREMONY_JOURNAL_VERSION,
  HC2_CRYPTO_SUITE_ID,
  HC2_CUSTODY_SCHEMA_VERSION
} from "./versions.ts";

export type CustodyCeremonyPhase = "planned" | "kit_verified" | "keys_installed" | "portable_visible" | "complete" | "abandoned";

export type CustodyCeremonyJournal = Readonly<{
  schema_version: typeof HC2_CEREMONY_JOURNAL_VERSION;
  record_kind: "custody_ceremony_journal";
  ceremony_kind: "initial_foundation" | "profile_loss_recovery";
  ceremony_id: string;
  plan_sha256: Uint8Array;
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  lost_device_id: DeviceId | null;
  root_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  recovery_kit_sha256: Uint8Array | null;
  accepted_control_head_id: ControlEventId | null;
  phase: CustodyCeremonyPhase;
}>;

export type StoredDeviceVaultRecord = Readonly<{
  schema_version: typeof HC2_CUSTODY_SCHEMA_VERSION;
  record_kind: "device_key_vault";
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
  local_kek_algorithm: "AES-GCM-256";
  local_kek_usages: readonly ["encrypt", "decrypt"];
  accepted_control_head_id: ControlEventId;
  offline_root_key_id: PublicKeyId;
  current_epoch_id: KeyEpochId;
  current_epoch_commitment: KeyEpochCommitmentId;
  current_epoch_public_commitment_bytes: Uint8Array;
  recovery_kit_sha256: Uint8Array;
  status: "active" | "retired";
}>;

export type CustodyCompletionMarker = Readonly<{
  schema_version: typeof HC2_CEREMONY_JOURNAL_VERSION;
  record_kind: "custody_completion_marker";
  ceremony_id: string;
  ceremony_kind: CustodyCeremonyJournal["ceremony_kind"];
  project_id: ProjectId;
  device_id: DeviceId;
  root_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  recovery_kit_sha256: Uint8Array;
  accepted_control_head_id: ControlEventId;
  completion: "verified_local_ceremony";
}>;

export interface Hc2CustodyStore {
  beginCeremony(journal: CustodyCeremonyJournal): Promise<Readonly<{ status: "created" | "exact_retry"; journal: CustodyCeremonyJournal }>>;
  readCeremony(projectId: ProjectId, ceremonyId: string): Promise<CustodyCeremonyJournal | null>;
  advanceCeremony(expectedPhase: CustodyCeremonyPhase, next: CustodyCeremonyJournal): Promise<CustodyCeremonyJournal>;
  installCustody(input: Readonly<{
    journal: CustodyCeremonyJournal;
    vault: StoredDeviceVaultRecord;
    wrapped_epoch: WrappedLocalEpochRecord;
  }>): Promise<Readonly<{ status: "installed" | "exact_retry" }>>;
  readVault(projectId: ProjectId, deviceId: DeviceId): Promise<StoredDeviceVaultRecord | null>;
  readWrappedEpoch(projectId: ProjectId, deviceId: DeviceId, epochId: KeyEpochId): Promise<WrappedLocalEpochRecord | null>;
  hasWrappingNonce(projectId: ProjectId, deviceId: DeviceId, generation: bigint, nonce: Uint8Array): Promise<boolean>;
  writeCompletionMarker(marker: CustodyCompletionMarker): Promise<void>;
  readCompletionMarker(projectId: ProjectId, ceremonyId: string): Promise<CustodyCompletionMarker | null>;
}

export class Hc2InMemoryCustodyStore implements Hc2CustodyStore {
  readonly #journals = new Map<string, CustodyCeremonyJournal>();
  readonly #vaults = new Map<string, StoredDeviceVaultRecord>();
  readonly #epochs = new Map<string, WrappedLocalEpochRecord>();
  readonly #nonces = new Set<string>();
  readonly #completion = new Map<string, CustodyCompletionMarker>();

  async beginCeremony(value: CustodyCeremonyJournal): Promise<Readonly<{ status: "created" | "exact_retry"; journal: CustodyCeremonyJournal }>> {
    const journal = parseCustodyCeremonyJournal(value);
    const key = ceremonyKey(journal.project_id, journal.ceremony_id);
    const existing = this.#journals.get(key);
    if (existing) {
      if (!sameJournalPlan(existing, journal)) throw new Error("A different custody ceremony already occupies this plan.");
      return Object.freeze({ status: "exact_retry", journal: copyJournal(existing) });
    }
    this.#journals.set(key, journal);
    return Object.freeze({ status: "created", journal: copyJournal(journal) });
  }

  async readCeremony(projectId: ProjectId, ceremonyId: string): Promise<CustodyCeremonyJournal | null> {
    const value = this.#journals.get(ceremonyKey(projectId, ceremonyId));
    return value ? copyJournal(value) : null;
  }

  async advanceCeremony(expectedPhase: CustodyCeremonyPhase, nextValue: CustodyCeremonyJournal): Promise<CustodyCeremonyJournal> {
    const next = parseCustodyCeremonyJournal(nextValue);
    const key = ceremonyKey(next.project_id, next.ceremony_id);
    const current = this.#journals.get(key);
    if (!current || current.phase !== expectedPhase || !sameJournalPlan(current, next) || !validPhaseAdvance(expectedPhase, next.phase)) {
      throw new Error("Custody ceremony journal CAS failed.");
    }
    this.#journals.set(key, next);
    return copyJournal(next);
  }

  async installCustody(input: Readonly<{ journal: CustodyCeremonyJournal; vault: StoredDeviceVaultRecord; wrapped_epoch: WrappedLocalEpochRecord }>): Promise<Readonly<{ status: "installed" | "exact_retry" }>> {
    const journal = parseCustodyCeremonyJournal(input.journal);
    const vault = parseStoredDeviceVaultRecord(input.vault);
    const epoch = parseWrappedLocalEpochRecord(input.wrapped_epoch);
    assertInstallBinding(journal, vault, epoch);
    const journalKey = ceremonyKey(journal.project_id, journal.ceremony_id);
    const current = this.#journals.get(journalKey);
    const key = vaultKey(vault.project_id, vault.device_id);
    const existing = this.#vaults.get(key);
    if (current?.phase === "keys_installed" && existing && sameJournalPlan(current, journal) &&
        current.recovery_kit_sha256 !== null && journal.recovery_kit_sha256 !== null &&
        sameBytes(current.recovery_kit_sha256, journal.recovery_kit_sha256) &&
        current.accepted_control_head_id === journal.accepted_control_head_id && sameVaultPublicBinding(existing, vault)) {
      const installedEpoch = this.#epochs.get(epochKey(epoch.project_id, epoch.device_id, epoch.key_epoch_id));
      if (!installedEpoch || !sameWrappedEpoch(installedEpoch, epoch)) throw new Error("Installed epoch differs from the exact custody retry.");
      return Object.freeze({ status: "exact_retry" });
    }
    if (!current || !plannedJournalCanInstall(current, journal)) throw new Error("Custody installation requires the exact verified journal.");
    if (existing) {
      if (!sameVaultPublicBinding(existing, vault)) throw new Error("A different device vault is already installed.");
      return Object.freeze({ status: "exact_retry" });
    }
    const nonceKey = wrappingNonceKey(vault.project_id, vault.device_id, vault.generation, epoch.nonce);
    if (this.#nonces.has(nonceKey)) throw new Error("AES-GCM wrapping nonce collision detected.");
    this.#vaults.set(key, vault);
    this.#epochs.set(epochKey(epoch.project_id, epoch.device_id, epoch.key_epoch_id), epoch);
    this.#nonces.add(nonceKey);
    this.#journals.set(journalKey, parseCustodyCeremonyJournal({ ...journal, phase: "keys_installed" }));
    return Object.freeze({ status: "installed" });
  }

  async readVault(projectId: ProjectId, deviceId: DeviceId): Promise<StoredDeviceVaultRecord | null> {
    const value = this.#vaults.get(vaultKey(projectId, deviceId));
    return value ? copyVault(value) : null;
  }

  async readWrappedEpoch(projectId: ProjectId, deviceId: DeviceId, epochId: KeyEpochId): Promise<WrappedLocalEpochRecord | null> {
    const value = this.#epochs.get(epochKey(projectId, deviceId, epochId));
    return value ? parseWrappedLocalEpochRecord(value) : null;
  }

  async hasWrappingNonce(projectId: ProjectId, deviceId: DeviceId, generation: bigint, nonce: Uint8Array): Promise<boolean> {
    return this.#nonces.has(wrappingNonceKey(projectId, deviceId, generation, nonce));
  }

  async writeCompletionMarker(value: CustodyCompletionMarker): Promise<void> {
    const marker = parseCustodyCompletionMarker(value);
    const key = ceremonyKey(marker.project_id, marker.ceremony_id);
    const journal = this.#journals.get(key);
    if (!journal || journal.phase !== "portable_visible" || !markerMatchesJournal(marker, journal)) throw new Error("Completion marker requires the exact portable-visible journal.");
    const existing = this.#completion.get(key);
    if (existing && !sameCompletion(existing, marker)) throw new Error("A different completion marker already exists.");
    this.#completion.set(key, marker);
    this.#journals.set(key, parseCustodyCeremonyJournal({ ...journal, phase: "complete" }));
  }

  async readCompletionMarker(projectId: ProjectId, ceremonyId: string): Promise<CustodyCompletionMarker | null> {
    const marker = this.#completion.get(ceremonyKey(projectId, ceremonyId));
    return marker ? copyCompletion(marker) : null;
  }
}

const databaseVersion = 1;
const storeNames = Object.freeze({
  journals: "custody_ceremony_journals",
  vaults: "device_key_vaults",
  epochs: "wrapped_local_epochs",
  nonces: "epoch_wrapping_nonces",
  completion: "custody_completion_markers"
});

export const hc2CustodyDatabaseSchema = Object.freeze({ version: databaseVersion, stores: Object.freeze(Object.values(storeNames).sort()) });

export const hc2CustodyInstallFailureCuts = Object.freeze([
  "before_vault_write",
  "after_vault_write",
  "after_epoch_write",
  "after_nonce_write",
  "after_journal_write"
] as const);

export type Hc2CustodyInstallFailureCut = (typeof hc2CustodyInstallFailureCuts)[number];

/** Synchronous and test-oriented so an injected failure can abort the active IDB transaction immediately. */
export interface Hc2CustodyInstallFailureInjector {
  inject(context: Readonly<{ cut: Hc2CustodyInstallFailureCut }>): void;
}

export class Hc2IndexedDbCustodyStore implements Hc2CustodyStore {
  readonly #factory: IDBFactory;
  readonly #databaseName: string;
  readonly #failureInjector?: Hc2CustodyInstallFailureInjector;
  #database: IDBDatabase | null = null;

  constructor(input: Readonly<{ indexed_db: IDBFactory; database_name: string; failure_injector?: Hc2CustodyInstallFailureInjector }>) {
    if (!input?.indexed_db || typeof input.database_name !== "string" || !input.database_name || input.database_name.includes("\u0000")) throw new Error("Custody IndexedDB requires an injected factory and explicit name.");
    this.#factory = input.indexed_db;
    this.#databaseName = input.database_name;
    this.#failureInjector = input.failure_injector;
  }

  async open(): Promise<Readonly<{ status: "opened" | "failed"; reason?: string }>> {
    if (this.#database) return Object.freeze({ status: "opened" });
    return new Promise((resolve) => {
      const request = this.#factory.open(this.#databaseName, databaseVersion);
      request.onupgradeneeded = () => {
        for (const name of Object.values(storeNames)) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onerror = () => resolve(Object.freeze({ status: "failed", reason: request.error?.name ?? "indexeddb_open_failed" }));
      request.onsuccess = () => {
        this.#database = request.result;
        this.#database.onversionchange = () => { this.close(); };
        resolve(Object.freeze({ status: "opened" }));
      };
    });
  }

  close(): void { this.#database?.close(); this.#database = null; }

  async beginCeremony(value: CustodyCeremonyJournal): Promise<Readonly<{ status: "created" | "exact_retry"; journal: CustodyCeremonyJournal }>> {
    const journal = parseCustodyCeremonyJournal(value);
    const transaction = strictTransaction(this.#requireOpen(), [storeNames.journals], "readwrite");
    const store = transaction.objectStore(storeNames.journals);
    const key = ceremonyKey(journal.project_id, journal.ceremony_id);
    const stored = await requestValue<CustodyCeremonyJournal | undefined>(store.get(key));
    if (stored) {
      const existing = parseCustodyCeremonyJournal(stored);
      if (!sameJournalPlan(existing, journal)) { transaction.abort(); throw new Error("A different custody ceremony already occupies this plan."); }
      await transactionDone(transaction);
      return Object.freeze({ status: "exact_retry", journal: existing });
    }
    store.add(journal, key);
    await transactionDone(transaction);
    return Object.freeze({ status: "created", journal });
  }

  async readCeremony(projectId: ProjectId, ceremonyId: string): Promise<CustodyCeremonyJournal | null> {
    return this.#read(storeNames.journals, ceremonyKey(projectId, ceremonyId), parseCustodyCeremonyJournal);
  }

  async advanceCeremony(expectedPhase: CustodyCeremonyPhase, nextValue: CustodyCeremonyJournal): Promise<CustodyCeremonyJournal> {
    const next = parseCustodyCeremonyJournal(nextValue);
    const transaction = strictTransaction(this.#requireOpen(), [storeNames.journals], "readwrite");
    const store = transaction.objectStore(storeNames.journals);
    const key = ceremonyKey(next.project_id, next.ceremony_id);
    const stored = await requestValue<CustodyCeremonyJournal | undefined>(store.get(key));
    if (!stored) { transaction.abort(); throw new Error("Custody ceremony journal is missing."); }
    const current = parseCustodyCeremonyJournal(stored);
    if (current.phase !== expectedPhase || !sameJournalPlan(current, next) || !validPhaseAdvance(expectedPhase, next.phase)) {
      transaction.abort(); throw new Error("Custody ceremony journal CAS failed.");
    }
    store.put(next, key);
    await transactionDone(transaction);
    return next;
  }

  async installCustody(input: Readonly<{ journal: CustodyCeremonyJournal; vault: StoredDeviceVaultRecord; wrapped_epoch: WrappedLocalEpochRecord }>): Promise<Readonly<{ status: "installed" | "exact_retry" }>> {
    const journal = parseCustodyCeremonyJournal(input.journal);
    const vault = parseStoredDeviceVaultRecord(input.vault);
    const epoch = parseWrappedLocalEpochRecord(input.wrapped_epoch);
    assertInstallBinding(journal, vault, epoch);
    const transaction = strictTransaction(this.#requireOpen(), Object.values(storeNames).filter((name) => name !== storeNames.completion), "readwrite");
    const journalStore = transaction.objectStore(storeNames.journals);
    const journalKey = ceremonyKey(journal.project_id, journal.ceremony_id);
    const storedJournal = await requestValue<CustodyCeremonyJournal | undefined>(journalStore.get(journalKey));
    const current = storedJournal ? parseCustodyCeremonyJournal(storedJournal) : null;
    const key = vaultKey(vault.project_id, vault.device_id);
    const vaultStore = transaction.objectStore(storeNames.vaults);
    const existing = await requestValue<StoredDeviceVaultRecord | undefined>(vaultStore.get(key));
    if (current?.phase === "keys_installed" && existing && sameJournalPlan(current, journal) &&
        current.recovery_kit_sha256 !== null && journal.recovery_kit_sha256 !== null &&
        sameBytes(current.recovery_kit_sha256, journal.recovery_kit_sha256) &&
        current.accepted_control_head_id === journal.accepted_control_head_id &&
        sameVaultPublicBinding(parseStoredDeviceVaultRecord(existing), vault)) {
      const installedEpoch = await requestValue<WrappedLocalEpochRecord | undefined>(transaction.objectStore(storeNames.epochs).get(epochKey(epoch.project_id, epoch.device_id, epoch.key_epoch_id)));
      if (!installedEpoch || !sameWrappedEpoch(parseWrappedLocalEpochRecord(installedEpoch), epoch)) {
        transaction.abort(); throw new Error("Installed epoch differs from the exact custody retry.");
      }
      await transactionDone(transaction);
      return Object.freeze({ status: "exact_retry" });
    }
    if (!current || !plannedJournalCanInstall(current, journal)) {
      transaction.abort(); throw new Error("Custody installation requires the exact verified journal.");
    }
    if (existing) {
      if (!sameVaultPublicBinding(parseStoredDeviceVaultRecord(existing), vault)) { transaction.abort(); throw new Error("A different device vault is already installed."); }
      await transactionDone(transaction);
      return Object.freeze({ status: "exact_retry" });
    }
    const nonceKey = wrappingNonceKey(vault.project_id, vault.device_id, vault.generation, epoch.nonce);
    const nonceStore = transaction.objectStore(storeNames.nonces);
    if (await requestValue<unknown>(nonceStore.get(nonceKey)) !== undefined) { transaction.abort(); throw new Error("AES-GCM wrapping nonce collision detected."); }
    try {
      this.#failureInjector?.inject(Object.freeze({ cut: "before_vault_write" }));
      vaultStore.add(vault, key);
      this.#failureInjector?.inject(Object.freeze({ cut: "after_vault_write" }));
      transaction.objectStore(storeNames.epochs).add(epoch, epochKey(epoch.project_id, epoch.device_id, epoch.key_epoch_id));
      this.#failureInjector?.inject(Object.freeze({ cut: "after_epoch_write" }));
      nonceStore.add(true, nonceKey);
      this.#failureInjector?.inject(Object.freeze({ cut: "after_nonce_write" }));
      journalStore.put(parseCustodyCeremonyJournal({ ...journal, phase: "keys_installed" }), journalKey);
      this.#failureInjector?.inject(Object.freeze({ cut: "after_journal_write" }));
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction already failed closed */ }
      try { await transactionDone(transaction); } catch { /* the injected error remains authoritative */ }
      throw error;
    }
    await transactionDone(transaction);
    return Object.freeze({ status: "installed" });
  }

  async readVault(projectId: ProjectId, deviceId: DeviceId): Promise<StoredDeviceVaultRecord | null> {
    return this.#read(storeNames.vaults, vaultKey(projectId, deviceId), parseStoredDeviceVaultRecord);
  }

  async readWrappedEpoch(projectId: ProjectId, deviceId: DeviceId, epochId: KeyEpochId): Promise<WrappedLocalEpochRecord | null> {
    return this.#read(storeNames.epochs, epochKey(projectId, deviceId, epochId), parseWrappedLocalEpochRecord);
  }

  async hasWrappingNonce(projectId: ProjectId, deviceId: DeviceId, generation: bigint, nonce: Uint8Array): Promise<boolean> {
    const transaction = strictTransaction(this.#requireOpen(), [storeNames.nonces], "readonly");
    const value = await requestValue<unknown>(transaction.objectStore(storeNames.nonces).get(wrappingNonceKey(projectId, deviceId, generation, nonce)));
    await transactionDone(transaction);
    return value !== undefined;
  }

  async writeCompletionMarker(value: CustodyCompletionMarker): Promise<void> {
    const marker = parseCustodyCompletionMarker(value);
    const transaction = strictTransaction(this.#requireOpen(), [storeNames.journals, storeNames.completion], "readwrite");
    const key = ceremonyKey(marker.project_id, marker.ceremony_id);
    const journalStore = transaction.objectStore(storeNames.journals);
    const stored = await requestValue<CustodyCeremonyJournal | undefined>(journalStore.get(key));
    if (!stored) { transaction.abort(); throw new Error("Completion journal is missing."); }
    const journal = parseCustodyCeremonyJournal(stored);
    if (journal.phase !== "portable_visible" || !markerMatchesJournal(marker, journal)) { transaction.abort(); throw new Error("Completion marker binding is invalid."); }
    const markerStore = transaction.objectStore(storeNames.completion);
    const existing = await requestValue<CustodyCompletionMarker | undefined>(markerStore.get(key));
    if (existing && !sameCompletion(parseCustodyCompletionMarker(existing), marker)) { transaction.abort(); throw new Error("A different completion marker already exists."); }
    markerStore.put(marker, key);
    journalStore.put(parseCustodyCeremonyJournal({ ...journal, phase: "complete" }), key);
    await transactionDone(transaction);
  }

  async readCompletionMarker(projectId: ProjectId, ceremonyId: string): Promise<CustodyCompletionMarker | null> {
    return this.#read(storeNames.completion, ceremonyKey(projectId, ceremonyId), parseCustodyCompletionMarker);
  }

  async #read<T>(storeName: string, key: IDBValidKey, parse: (value: unknown) => T): Promise<T | null> {
    const transaction = strictTransaction(this.#requireOpen(), [storeName], "readonly");
    const stored = await requestValue<unknown>(transaction.objectStore(storeName).get(key));
    await transactionDone(transaction);
    return stored === undefined ? null : parse(stored);
  }

  #requireOpen(): IDBDatabase { if (!this.#database) throw new Error("Custody IndexedDB must be opened explicitly."); return this.#database; }
}

export function parseCustodyCeremonyJournal(value: unknown): CustodyCeremonyJournal {
  const record = expectExactRecord(value, "custody ceremony journal", [
    "schema_version", "record_kind", "ceremony_kind", "ceremony_id", "plan_sha256", "project_id", "person_id",
    "device_id", "lost_device_id", "root_key_id", "key_epoch_id", "recovery_kit_sha256", "accepted_control_head_id", "phase"
  ]);
  const ceremonyKind = record.ceremony_kind;
  if (ceremonyKind !== "initial_foundation" && ceremonyKind !== "profile_loss_recovery") throw new Error("Custody ceremony kind is invalid.");
  const phase = record.phase;
  if (!isPhase(phase)) throw new Error("Custody ceremony phase is invalid.");
  const planDigest = exactDigest(record.plan_sha256, "ceremony plan digest");
  const kitDigest = record.recovery_kit_sha256 === null ? null : exactDigest(record.recovery_kit_sha256, "recovery-kit digest");
  const lost = record.lost_device_id === null ? null : parseEntityId("device", record.lost_device_id);
  if ((ceremonyKind === "initial_foundation") !== (lost === null)) throw new Error("Only profile-loss recovery may name a lost device.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_CEREMONY_JOURNAL_VERSION, "ceremony journal version"),
    record_kind: expectLiteral(record.record_kind, "custody_ceremony_journal", "ceremony journal kind"),
    ceremony_kind: ceremonyKind,
    ceremony_id: safeToken(record.ceremony_id, "ceremony ID"),
    plan_sha256: planDigest,
    project_id: parseEntityId("project", record.project_id),
    person_id: parseEntityId("person", record.person_id),
    device_id: parseEntityId("device", record.device_id),
    lost_device_id: lost,
    root_key_id: parseEntityId("public-key", record.root_key_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    recovery_kit_sha256: kitDigest,
    accepted_control_head_id: record.accepted_control_head_id === null ? null : parseDigestId("control-event", record.accepted_control_head_id),
    phase
  });
}

export function parseStoredDeviceVaultRecord(value: unknown): StoredDeviceVaultRecord {
  const record = expectExactRecord(value, "device key vault", [
    "schema_version", "record_kind", "suite_id", "project_id", "person_id", "device_id", "access_scope_id", "generation",
    "signing_key_id", "signing_public_key_bytes", "signing_key_pair", "recipient_key_id", "recipient_public_key_bytes",
    "recipient_key_pair", "local_kek", "local_kek_algorithm", "local_kek_usages", "accepted_control_head_id", "offline_root_key_id",
    "current_epoch_id", "current_epoch_commitment", "current_epoch_public_commitment_bytes", "recovery_kit_sha256", "status"
  ]);
  const signingKey = parseEntityId("public-key", record.signing_key_id);
  const recipientKey = parseEntityId("public-key", record.recipient_key_id);
  const signingPublic = exactBytes(record.signing_public_key_bytes, "signing public key");
  const recipientPublic = exactBytes(record.recipient_public_key_bytes, "recipient public key");
  if (decodeAlgorithmTaggedPublicKey(signingPublic, "ed25519").key_id !== signingKey || decodeAlgorithmTaggedPublicKey(recipientPublic, "x25519").key_id !== recipientKey) {
    throw new Error("Vault public key identity is inconsistent.");
  }
  const usages = record.local_kek_usages;
  if (!Array.isArray(usages) || usages.length !== 2 || usages[0] !== "encrypt" || usages[1] !== "decrypt") throw new Error("Vault KEK usages are invalid.");
  const status = record.status;
  if (status !== "active" && status !== "retired") throw new Error("Vault status is invalid.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_CUSTODY_SCHEMA_VERSION, "vault version"),
    record_kind: expectLiteral(record.record_kind, "device_key_vault", "vault kind"),
    suite_id: expectLiteral(record.suite_id, HC2_CRYPTO_SUITE_ID, "vault suite"),
    project_id: parseEntityId("project", record.project_id),
    person_id: parseEntityId("person", record.person_id),
    device_id: parseEntityId("device", record.device_id),
    access_scope_id: parseEntityId("access-scope", record.access_scope_id),
    generation: expectUInt64(record.generation, "vault generation"),
    signing_key_id: signingKey,
    signing_public_key_bytes: Uint8Array.from(signingPublic) as AlgorithmTaggedPublicKeyBytes,
    signing_key_pair: requirePair(record.signing_key_pair),
    recipient_key_id: recipientKey,
    recipient_public_key_bytes: Uint8Array.from(recipientPublic) as AlgorithmTaggedPublicKeyBytes,
    recipient_key_pair: requirePair(record.recipient_key_pair),
    local_kek: requireCryptoKey(record.local_kek),
    local_kek_algorithm: expectLiteral(record.local_kek_algorithm, "AES-GCM-256", "vault KEK algorithm"),
    local_kek_usages: Object.freeze(["encrypt", "decrypt"]),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    offline_root_key_id: parseEntityId("public-key", record.offline_root_key_id),
    current_epoch_id: parseEntityId("key-epoch", record.current_epoch_id),
    current_epoch_commitment: parseDigestId("key-epoch-commitment", record.current_epoch_commitment),
    current_epoch_public_commitment_bytes: exactDigest(record.current_epoch_public_commitment_bytes, "epoch public commitment"),
    recovery_kit_sha256: exactDigest(record.recovery_kit_sha256, "vault recovery-kit digest"),
    status
  });
}

export function parseCustodyCompletionMarker(value: unknown): CustodyCompletionMarker {
  const record = expectExactRecord(value, "custody completion marker", [
    "schema_version", "record_kind", "ceremony_id", "ceremony_kind", "project_id", "device_id", "root_key_id",
    "key_epoch_id", "recovery_kit_sha256", "accepted_control_head_id", "completion"
  ]);
  const kind = record.ceremony_kind;
  if (kind !== "initial_foundation" && kind !== "profile_loss_recovery") throw new Error("Completion ceremony kind is invalid.");
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC2_CEREMONY_JOURNAL_VERSION, "completion version"),
    record_kind: expectLiteral(record.record_kind, "custody_completion_marker", "completion kind"),
    ceremony_id: safeToken(record.ceremony_id, "ceremony ID"),
    ceremony_kind: kind,
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    root_key_id: parseEntityId("public-key", record.root_key_id),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    recovery_kit_sha256: exactDigest(record.recovery_kit_sha256, "completion kit digest"),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    completion: expectLiteral(record.completion, "verified_local_ceremony", "completion state")
  });
}

function assertInstallBinding(journal: CustodyCeremonyJournal, vault: StoredDeviceVaultRecord, epoch: WrappedLocalEpochRecord): void {
  if (journal.phase !== "kit_verified" || !journal.recovery_kit_sha256 || !journal.accepted_control_head_id ||
      journal.project_id !== vault.project_id || journal.person_id !== vault.person_id || journal.device_id !== vault.device_id ||
      journal.root_key_id !== vault.offline_root_key_id || journal.key_epoch_id !== vault.current_epoch_id ||
      journal.accepted_control_head_id !== vault.accepted_control_head_id || !sameBytes(journal.recovery_kit_sha256, vault.recovery_kit_sha256) ||
      epoch.project_id !== vault.project_id || epoch.device_id !== vault.device_id || epoch.key_epoch_id !== vault.current_epoch_id ||
      epoch.key_epoch_commitment !== vault.current_epoch_commitment || !sameBytes(epoch.public_commitment_bytes, vault.current_epoch_public_commitment_bytes) ||
      epoch.wrapping_key_generation !== vault.generation) {
    throw new Error("Vault, wrapped epoch, and verified ceremony journal are not exactly bound.");
  }
}

function markerMatchesJournal(marker: CustodyCompletionMarker, journal: CustodyCeremonyJournal): boolean {
  return marker.ceremony_kind === journal.ceremony_kind && marker.project_id === journal.project_id && marker.device_id === journal.device_id &&
    marker.root_key_id === journal.root_key_id && marker.key_epoch_id === journal.key_epoch_id && marker.accepted_control_head_id === journal.accepted_control_head_id &&
    journal.recovery_kit_sha256 !== null && sameBytes(marker.recovery_kit_sha256, journal.recovery_kit_sha256);
}

function validPhaseAdvance(from: CustodyCeremonyPhase, to: CustodyCeremonyPhase): boolean {
  return (from === "planned" && (to === "kit_verified" || to === "abandoned")) ||
    (from === "kit_verified" && to === "abandoned") ||
    (from === "keys_installed" && to === "portable_visible") ||
    from === to;
}

function isPhase(value: unknown): value is CustodyCeremonyPhase {
  return value === "planned" || value === "kit_verified" || value === "keys_installed" || value === "portable_visible" || value === "complete" || value === "abandoned";
}

function sameJournalPlan(left: CustodyCeremonyJournal, right: CustodyCeremonyJournal): boolean {
  return left.ceremony_kind === right.ceremony_kind && left.ceremony_id === right.ceremony_id && sameBytes(left.plan_sha256, right.plan_sha256) &&
    left.project_id === right.project_id && left.person_id === right.person_id && left.device_id === right.device_id && left.lost_device_id === right.lost_device_id &&
    left.root_key_id === right.root_key_id && left.key_epoch_id === right.key_epoch_id;
}

function plannedJournalCanInstall(current: CustodyCeremonyJournal, verified: CustodyCeremonyJournal): boolean {
  if (verified.phase !== "kit_verified" || !sameJournalPlan(current, verified) || verified.recovery_kit_sha256 === null || verified.accepted_control_head_id === null) return false;
  if (current.phase === "planned") return current.recovery_kit_sha256 === null && current.accepted_control_head_id === null;
  return current.phase === "kit_verified" && current.recovery_kit_sha256 !== null && current.accepted_control_head_id === null &&
    sameBytes(current.recovery_kit_sha256, verified.recovery_kit_sha256);
}

function sameVaultPublicBinding(left: StoredDeviceVaultRecord, right: StoredDeviceVaultRecord): boolean {
  return left.project_id === right.project_id && left.person_id === right.person_id && left.device_id === right.device_id && left.access_scope_id === right.access_scope_id &&
    left.generation === right.generation && left.signing_key_id === right.signing_key_id && sameBytes(left.signing_public_key_bytes, right.signing_public_key_bytes) &&
    left.recipient_key_id === right.recipient_key_id && sameBytes(left.recipient_public_key_bytes, right.recipient_public_key_bytes) &&
    left.accepted_control_head_id === right.accepted_control_head_id && left.offline_root_key_id === right.offline_root_key_id &&
    left.current_epoch_id === right.current_epoch_id && left.current_epoch_commitment === right.current_epoch_commitment &&
    sameBytes(left.current_epoch_public_commitment_bytes, right.current_epoch_public_commitment_bytes) &&
    sameBytes(left.recovery_kit_sha256, right.recovery_kit_sha256);
}

function sameWrappedEpoch(left: WrappedLocalEpochRecord, right: WrappedLocalEpochRecord): boolean {
  return left.project_id === right.project_id && left.device_id === right.device_id && left.key_epoch_id === right.key_epoch_id &&
    left.key_epoch_commitment === right.key_epoch_commitment && left.wrapping_key_generation === right.wrapping_key_generation &&
    sameBytes(left.public_commitment_bytes, right.public_commitment_bytes) && sameBytes(left.nonce, right.nonce) &&
    sameBytes(left.ciphertext, right.ciphertext);
}

function sameCompletion(left: CustodyCompletionMarker, right: CustodyCompletionMarker): boolean {
  return left.ceremony_id === right.ceremony_id && left.ceremony_kind === right.ceremony_kind && left.project_id === right.project_id && left.device_id === right.device_id &&
    left.root_key_id === right.root_key_id && left.key_epoch_id === right.key_epoch_id && left.accepted_control_head_id === right.accepted_control_head_id &&
    sameBytes(left.recovery_kit_sha256, right.recovery_kit_sha256);
}

function copyJournal(value: CustodyCeremonyJournal): CustodyCeremonyJournal { return parseCustodyCeremonyJournal(value); }
function copyVault(value: StoredDeviceVaultRecord): StoredDeviceVaultRecord { return parseStoredDeviceVaultRecord(value); }
function copyCompletion(value: CustodyCompletionMarker): CustodyCompletionMarker { return parseCustodyCompletionMarker(value); }

function ceremonyKey(projectId: ProjectId, ceremonyId: string): string { return `${parseEntityId("project", projectId)}\u0000${safeToken(ceremonyId, "ceremony ID")}`; }
function vaultKey(projectId: ProjectId, deviceId: DeviceId): string { return `${parseEntityId("project", projectId)}\u0000${parseEntityId("device", deviceId)}`; }
function epochKey(projectId: ProjectId, deviceId: DeviceId, epochId: KeyEpochId): string { return `${vaultKey(projectId, deviceId)}\u0000${parseEntityId("key-epoch", epochId)}`; }
function wrappingNonceKey(projectId: ProjectId, deviceId: DeviceId, generation: bigint, nonce: Uint8Array): string {
  if (typeof generation !== "bigint" || generation < BigInt(0)) throw new Error("Wrapping generation is invalid.");
  const bytes = expectBytes(nonce, "wrapping nonce");
  if (bytes.length !== 12) throw new Error("Wrapping nonce length is invalid.");
  return `${vaultKey(projectId, deviceId)}\u0000${generation}\u0000${hex(bytes)}`;
}

function exactDigest(value: unknown, label: string): Uint8Array { const bytes = expectBytes(value, label); if (bytes.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`); return Uint8Array.from(bytes); }
function exactBytes(value: unknown, label: string): Uint8Array { return Uint8Array.from(expectBytes(value, label)); }
function safeToken(value: unknown, label: string): string { if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,128}$/.test(value)) throw new Error(`${label} is invalid.`); return value; }
function requirePair(value: unknown): CryptoKeyPair { if (!value || typeof value !== "object" || !("privateKey" in value) || !("publicKey" in value)) throw new Error("Vault key pair is invalid."); return value as CryptoKeyPair; }
function requireCryptoKey(value: unknown): CryptoKey { if (!(value instanceof CryptoKey)) throw new Error("Vault key handle is invalid."); return value; }
function hex(bytes: Uint8Array): string { let result = ""; for (const byte of bytes) result += byte.toString(16).padStart(2, "0"); return result; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function strictTransaction(database: IDBDatabase, names: readonly string[], mode: IDBTransactionMode): IDBTransaction { return database.transaction([...names], mode, { durability: "strict" }); }
function requestValue<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed.")); }); }
function transactionDone(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")); }); }

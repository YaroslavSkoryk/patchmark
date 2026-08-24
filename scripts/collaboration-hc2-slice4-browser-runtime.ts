import sodium from "libsodium-wrappers-sumo";

import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { parseControlActionCore, parseControlEventCoreStructure, type ControlGenesisCore, type RootRecoveryAction, type RootRecoveryControlEventCore } from "../lib/collaboration/control.ts";
import { buildSignaturePreimage, deriveControlActionIdentity, deriveControlEventCoreIdentity } from "../lib/collaboration/preimages.ts";
import { Hc2CustodyCeremonyCoordinator, type RecoveryKitSink } from "../lib/collaboration/hc2/custody-ceremony.ts";
import { Hc2IndexedDbCustodyStore } from "../lib/collaboration/hc2/custody-store.ts";
import type { AcceptedCustodyAuthority } from "../lib/collaboration/hc2/custody-types.ts";
import { buildInitialFoundationRootPreimage } from "../lib/collaboration/hc2/custody-types.ts";
import { Hc2DeviceVaultService } from "../lib/collaboration/hc2/device-vault.ts";
import { buildEpochWrapAad, wrapEpochSecret } from "../lib/collaboration/hc2/epoch-custody.ts";
import { OfflineProjectRootProvider } from "../lib/collaboration/hc2/providers/root-recovery-provider.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import { decodeRecoveryKitContainer } from "../lib/collaboration/hc2/recovery-kit-format.ts";
import type { AlgorithmTaggedPublicKeyBytes, RecoveryCeremonyCapability, RootCeremonyCapability, SenderSignaturePreimageBytes } from "../lib/collaboration/hc2/crypto-contracts.ts";
import { Hc2WebLocksAdapter, deriveHc2CustodyCeremonyLockName } from "../lib/collaboration/hc2/web-locks.ts";

const ids = Object.freeze({
  project: entity("project", "a"), person: entity("person", "b"), membership: entity("membership", "c"), scope: entity("access-scope", "d"),
  oldDevice: entity("device", "e"), newDevice: entity("device", "f"), rootKey: entity("public-key", "g"),
  oldSigning: entity("public-key", "h"), oldRecipient: entity("public-key", "j"), newSigning: entity("public-key", "k"), newRecipient: entity("public-key", "m"),
  epoch1: entity("key-epoch", "n"), epoch2: entity("key-epoch", "p"), state1: digest("control-state-root", "q"), state2: digest("control-state-root", "r")
});

type FrozenSlice4Vector = Readonly<{
  identities: Readonly<Record<string, string>>;
  root_ed25519: Readonly<{ raw_public_key_hex: string }>;
  recovery_kit: Readonly<Record<"container_canonical_hex" | "container_sha256" | "ciphertext_and_tag_hex" | "public_header_aad_hex" | "nonce_hex" | "derived_key_hex" | "payload_sha256", string> & { payload_bytes: number }>;
  epoch_wrap: Readonly<Record<"aes_key_hex" | "epoch_secret_hex" | "nonce_hex" | "key_epoch_commitment_id" | "aad_hex" | "ciphertext_and_tag_hex", string>>;
  initial_foundation: Readonly<{ root_signature_hex: string; root_signature_preimage_hex: string }>;
  root_recovery: Readonly<{ root_signature_hex: string; root_signature_preimage_hex: string }>;
}>;

export async function verifyFrozenVector(fixture: FrozenSlice4Vector) {
  const recovery = fixture.recovery_kit;
  const containerBytes = fromHex(recovery.container_canonical_hex);
  const container = decodeRecoveryKitContainer(containerBytes);
  const containerSha = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(containerBytes))));
  await sodium.ready;
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromHex(recovery.ciphertext_and_tag_hex),
    fromHex(recovery.public_header_aad_hex),
    fromHex(recovery.nonce_hex),
    fromHex(recovery.derived_key_hex)
  );
  const payloadSha = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(plaintext))));
  sodium.memzero(plaintext);
  const rootPublic = await crypto.subtle.importKey("raw", exactBuffer(fromHex(fixture.root_ed25519.raw_public_key_hex)), "Ed25519", true, ["verify"]);
  let rootSignatures = 0;
  for (const vector of [fixture.initial_foundation, fixture.root_recovery]) {
    if (await crypto.subtle.verify("Ed25519", rootPublic, exactBuffer(fromHex(vector.root_signature_hex)), exactBuffer(fromHex(vector.root_signature_preimage_hex)))) rootSignatures += 1;
  }
  const epoch = fixture.epoch_wrap;
  const key = await crypto.subtle.importKey("raw", exactBuffer(fromHex(epoch.aes_key_hex)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const wrapped = await wrapEpochSecret({
    key,
    project_id: fixture.identities.project_id as never,
    device_id: fixture.identities.old_device_id as never,
    key_epoch_id: fixture.identities.initial_epoch_id as never,
    wrapping_key_generation: BigInt(0),
    epoch_secret: fromHex(epoch.epoch_secret_hex),
    nonce: fromHex(epoch.nonce_hex)
  });
  return {
    container_bytes: containerBytes.length,
    container_sha256: containerSha,
    header_project_id: container.public_header.project_id,
    payload_bytes: recovery.payload_bytes,
    payload_sha256: payloadSha,
    root_signatures: rootSignatures,
    epoch_commitment_id: wrapped.key_epoch_commitment,
    epoch_aad_hex: toHex(buildEpochWrapAad(wrapped)),
    epoch_ciphertext_hex: toHex(wrapped.ciphertext)
  };
}

export async function runProfileA(databaseName: string) {
  setStage("open_store");
  const store = new Hc2IndexedDbCustodyStore({ indexed_db: indexedDB, database_name: databaseName });
  if ((await store.open()).status !== "opened") throw new Error("Profile A custody database failed to open.");
  const random = new WebCryptoRandomSource();
  const root = new OfflineProjectRootProvider({ random });
  const password = new TextEncoder().encode("browser profile-loss recovery password");
  setStage("create_root");
  const created = await root.create({ capability: rootCapability(), project_id: ids.project, root_key_id: ids.rootKey, root_generation: BigInt(0), password_material: password });
  setStage("verify_root_kit");
  const verified = await root.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: created.recovery_kit_bytes, password_material: password });
  if (verified.status !== "verified") throw new Error("Profile A kit verification failed.");
  setStage("begin_journal");
  const begun = await store.beginCeremony({
    schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation", ceremony_id: "browser-a",
    plan_sha256: new Uint8Array(32).fill(1), project_id: ids.project, person_id: ids.person, device_id: ids.oldDevice, lost_device_id: null,
    root_key_id: ids.rootKey, key_epoch_id: ids.epoch1, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned"
  });
  setStage("prepare_vault");
  const vault = new Hc2DeviceVaultService({ store, random });
  const prepared = await vault.prepare({
    project_id: ids.project, person_id: ids.person, device_id: ids.oldDevice, access_scope_id: ids.scope, generation: BigInt(0),
    signing_key_id: ids.oldSigning, recipient_key_id: ids.oldRecipient, offline_root_key_id: ids.rootKey, key_epoch_id: ids.epoch1,
    recovery_kit_sha256: verified.binding.kit_sha256
  });
  setStage("derive_genesis");
  const genesis = genesisCore(prepared.public_binding.signing_key_id, prepared.public_binding.current_epoch_commitment);
  const genesisIdentity = await deriveControlEventCoreIdentity(genesis);
  setStage("advance_journal");
  const journal = {
    ...begun.journal, recovery_kit_sha256: verified.binding.kit_sha256, accepted_control_head_id: genesisIdentity.id, phase: "kit_verified"
  } as const;
  setStage("install_vault");
  const installed = await vault.install({ handle: prepared.handle, accepted_control_head_id: genesisIdentity.id, journal });
  const authority = authorityFor(installed.public_binding);
  setStage("load_vault");
  const loaded = await vault.loadAndVerify(authority);
  setStage("sign_device");
  const deviceSignature = await vault.signDevice({
    custody: loaded,
    preimage: encodeCanonicalCbor(buildSignaturePreimage("control_event", ids.project, genesisIdentity.id)) as SenderSignaturePreimageBytes
  });
  setStage("sign_root");
  const rootPreimage = await buildInitialFoundationRootPreimage(genesis);
  const rootSignature = await root.signAuthority({ capability: recoveryCapability(), recovery_kit_bytes: created.recovery_kit_bytes, password_material: password, preimage: rootPreimage });
  setStage("read_vault");
  const stored = await store.readVault(ids.project, ids.oldDevice);
  if (!stored) throw new Error("Profile A vault was not persisted.");
  setStage("open_epoch");
  let epochCallbackReference: Uint8Array<ArrayBufferLike> = new Uint8Array();
  await vault.withCurrentEpoch({ custody: loaded, use(secret) { epochCallbackReference = secret; } });
  setStage("abort_partial_install");
  const failedDevice = entity("device", "v");
  const failedSigning = entity("public-key", "w");
  const failedRecipient = entity("public-key", "x");
  const failedEpoch = entity("key-epoch", "y");
  let installCutObserved = false;
  const failureStore = new Hc2IndexedDbCustodyStore({
    indexed_db: indexedDB,
    database_name: databaseName,
    failure_injector: {
      inject({ cut }) {
        if (cut === "after_vault_write") {
          installCutObserved = true;
          throw new Error("injected_partial_vault_install");
        }
      }
    }
  });
  if ((await failureStore.open()).status !== "opened") throw new Error("Failure-cut custody database failed to open.");
  const failedBegun = await failureStore.beginCeremony({
    schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation", ceremony_id: "browser-partial-install",
    plan_sha256: new Uint8Array(32).fill(7), project_id: ids.project, person_id: ids.person, device_id: failedDevice, lost_device_id: null,
    root_key_id: ids.rootKey, key_epoch_id: failedEpoch, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned"
  });
  const failureVault = new Hc2DeviceVaultService({ store: failureStore, random });
  const failedPrepared = await failureVault.prepare({
    project_id: ids.project, person_id: ids.person, device_id: failedDevice, access_scope_id: ids.scope, generation: BigInt(0),
    signing_key_id: failedSigning, recipient_key_id: failedRecipient, offline_root_key_id: ids.rootKey, key_epoch_id: failedEpoch,
    recovery_kit_sha256: verified.binding.kit_sha256
  });
  const failedHead = digest("control-event", "z");
  const failedJournal = {
    ...failedBegun.journal, recovery_kit_sha256: verified.binding.kit_sha256, accepted_control_head_id: failedHead, phase: "kit_verified"
  } as const;
  let partialInstallRejected = false;
  try { await failureVault.install({ handle: failedPrepared.handle, accepted_control_head_id: failedHead, journal: failedJournal }); }
  catch { partialInstallRejected = true; }
  const partialVaultAbsent = (await failureStore.readVault(ids.project, failedDevice)) === null;
  const partialEpochAbsent = (await failureStore.readWrappedEpoch(ids.project, failedDevice, failedEpoch)) === null;
  const partialJournalPreserved = (await failureStore.readCeremony(ids.project, "browser-partial-install"))?.phase === "planned";
  failureStore.close();
  store.close();
  setStage("complete");
  return {
    project_id: ids.project,
    kit_hex: toHex(created.recovery_kit_bytes),
    root_public_hex: toHex(created.root_public_key_bytes),
    foundation_control_id: genesisIdentity.id,
    old_device_id: ids.oldDevice,
    old_signing_key_id: ids.oldSigning,
    old_signing_public_hex: toHex(installed.public_binding.signing_public_key_bytes),
    old_epoch_id: ids.epoch1,
    ed_private_extractable: stored.signing_key_pair.privateKey.extractable,
    x_private_extractable: stored.recipient_key_pair.privateKey.extractable,
    kek_extractable: stored.local_kek.extractable,
    device_signature_bytes: deviceSignature.length,
    root_signature_status: rootSignature.status,
    root_worker_terminated: root.evidence()?.worker_terminated === true,
    epoch_callback_wiped: epochCallbackReference.length === 32 && epochCallbackReference.every((byte: number) => byte === 0),
    indexeddb_partial_install_rejected: partialInstallRejected && installCutObserved,
    indexeddb_partial_vault_absent: partialVaultAbsent,
    indexeddb_partial_epoch_absent: partialEpochAbsent,
    indexeddb_partial_journal_preserved: partialJournalPreserved
  };
}

export async function runProfileB(databaseName: string, profileA: Awaited<ReturnType<typeof runProfileA>>) {
  const existing = await indexedDB.databases();
  const absentBeforeOpen = !existing.some((entry) => entry.name === databaseName);
  const store = new Hc2IndexedDbCustodyStore({ indexed_db: indexedDB, database_name: databaseName });
  if ((await store.open()).status !== "opened") throw new Error("Profile B custody database failed to open.");
  const sink = new MemorySink();
  await sink.write("browser-recovery", fromHex(profileA.kit_hex));
  const random = new WebCryptoRandomSource();
  const root = new OfflineProjectRootProvider({ random });
  const vault = new Hc2DeviceVaultService({ store, random });
  const coordinator = new Hc2CustodyCeremonyCoordinator({
    store, vault, root, recovery_kit_sink: sink,
    locks: new Hc2WebLocksAdapter(navigator.locks)
  });
  const acceptedBefore = digest("control-event", "s");
  const plan = {
    schema_version: 1 as const, object_kind: "custody_ceremony_plan" as const, ceremony_kind: "profile_loss_recovery" as const,
    ceremony_id: "browser-recovery", project_id: ids.project, person_id: ids.person, device_id: ids.newDevice, lost_device_id: ids.oldDevice,
    access_scope_id: ids.scope, vault_generation: BigInt(0), signing_key_id: ids.newSigning, recipient_key_id: ids.newRecipient,
    root_key_id: ids.rootKey, root_generation: BigInt(0), key_epoch_id: ids.epoch2, expected_previous_control_head_id: acceptedBefore
  };
  let recoveryAuthority: AcceptedCustodyAuthority | null = null;
  let commitObserved = false;
  let replacementSignatureBytes = 0;
  const result = await coordinator.recoverAfterProfileLoss({
    plan, recovery_capability: recoveryCapability(), password_material: new TextEncoder().encode("browser profile-loss recovery password"),
    async verify_portable_replica() {
      return {
        verification: "verified_complete_batches" as const, control_resolution: "single_accepted_root_state" as const,
        project_id: ids.project, accepted_control_head_id: acceptedBefore, last_uncontested_control_id: profileA.foundation_control_id as never,
        previous_root_control_id: profileA.foundation_control_id as never, root_sequence: BigInt(0), offline_root_key_id: ids.rootKey,
        offline_root_public_key_bytes: fromHex(profileA.root_public_hex) as AlgorithmTaggedPublicKeyBytes, root_generation: BigInt(0),
        active_control_device_id: ids.oldDevice, selected_membership_device_state_root: ids.state1,
        observed_conflicting_tip_ids: [acceptedBefore], revocation_sequence_cutoffs: [{ device_id: ids.oldDevice, maximum_accepted_semantic_sequence: BigInt(0) as never }]
      };
    },
    async prepare_recovery({ device }) {
      const action = parseControlActionCore({
        schema_version: 1, project_id: ids.project, action_kind: "root_recovery", last_uncontested_control_id: profileA.foundation_control_id,
        selected_membership_device_state_root: ids.state1, revocation_sequence_cutoffs: [{ device_id: ids.oldDevice, maximum_accepted_semantic_sequence: BigInt(0) }],
        replacement_active_control_device_id: ids.newDevice, replacement_key_epoch_id: ids.epoch2,
        replacement_key_epoch_commitment: device.current_epoch_commitment, observed_conflicting_tip_ids: [acceptedBefore],
        supersession_policy: "supersede_all_ordinary_descendants_outside_recovery_chain"
      }) as RootRecoveryAction;
      const actionId = (await deriveControlActionIdentity(action)).id;
      const core = parseControlEventCoreStructure({
        schema_version: 1, object_kind: "control_event_core", control_kind: "root_recovery", project_id: ids.project,
        control_sequence: BigInt(1), previous_control_id: profileA.foundation_control_id, root_sequence: BigInt(1),
        previous_root_control_id: profileA.foundation_control_id, issuer_root_key_id: ids.rootKey, action_id: actionId,
        resulting_control_state_root: ids.state2, key_epoch_id: ids.epoch2, key_epoch_commitment: device.current_epoch_commitment
      }, { action: { record_version: 1, object_kind: "control_action", action_id: actionId, core: action } }) as RootRecoveryControlEventCore;
      const identity = await deriveControlEventCoreIdentity(core);
      recoveryAuthority = authorityFor({ ...device, accepted_control_head_id: identity.id });
      return {
        action, control_event_core: core, accepted_authority: recoveryAuthority,
        async commit_portable({ root_signature, sign_device }: { root_signature: Uint8Array; sign_device: (value: SenderSignaturePreimageBytes) => Promise<Uint8Array> }) {
          if (root_signature.length !== 64) throw new Error("Browser recovery root signature was invalid.");
          replacementSignatureBytes = (await sign_device(encodeCanonicalCbor(buildSignaturePreimage("control_event", ids.project, identity.id)) as SenderSignaturePreimageBytes)).length;
          commitObserved = true;
        },
        async reopen_and_verify() {
          if (!recoveryAuthority || !commitObserved) throw new Error("Browser recovery was not committed.");
          return {
            accepted_authority: recoveryAuthority, replacement_device_authoritative: true as const, lost_device_superseded: true as const,
            late_lost_device_evidence: "superseded_control_branch" as const, old_private_keys_restored: false as const,
            old_sequence_continuity_restored: false as const, old_reservations_restored: false as const
          };
        }
      };
    }
  });
  if (result.status !== "complete") throw new Error(`Browser profile recovery failed: ${result.reason}`);
  const stored = await store.readVault(ids.project, ids.newDevice);
  if (!stored) throw new Error("Profile B replacement vault is missing.");
  const output = {
    absent_before_open: absentBeforeOpen,
    new_device_id: result.custody.public_binding.device_id,
    new_signing_key_id: result.custody.public_binding.signing_key_id,
    new_signing_public_hex: toHex(result.custody.public_binding.signing_public_key_bytes),
    new_epoch_id: result.custody.public_binding.current_epoch_id,
    ed_private_extractable: stored.signing_key_pair.privateKey.extractable,
    x_private_extractable: stored.recipient_key_pair.privateKey.extractable,
    kek_extractable: stored.local_kek.extractable,
    replacement_signature_bytes: replacementSignatureBytes,
    recovery_complete: result.marker.completion,
    root_worker_terminated: root.evidence()?.worker_terminated === true,
    late_old_device_result: "superseded_control_branch"
  };
  store.close();
  await deleteDatabase(databaseName);
  return output;
}

export async function holdCustodyCeremonyLock(milliseconds: number): Promise<string> {
  const name = deriveHc2CustodyCeremonyLockName(ids.project);
  return navigator.locks.request(name, { mode: "exclusive" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return name;
  });
}

export async function custodyCeremonyLockUnavailable(): Promise<boolean> {
  const name = deriveHc2CustodyCeremonyLockName(ids.project);
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => lock === null);
}

function genesisCore(signingKeyId: string, commitment: string): ControlGenesisCore {
  return parseControlEventCoreStructure({
    schema_version: 1, object_kind: "control_event_core", control_kind: "genesis", project_id: ids.project,
    control_sequence: BigInt(0), previous_control_id: null, root_sequence: BigInt(0), previous_root_control_id: null,
    owner_person_id: ids.person, offline_root_key_id: ids.rootKey, initial_active_control_device_id: ids.oldDevice,
    initial_memberships: [{ membership_id: ids.membership, person_id: ids.person, role: "owner", access_scope_id: ids.scope, status: "active" }],
    initial_authorized_devices: [{ device_id: ids.oldDevice, person_id: ids.person, signing_key_id: signingKeyId, status: "active" }],
    initial_key_epoch_id: ids.epoch1, initial_key_epoch_commitment: commitment, resulting_control_state_root: ids.state1
  }) as ControlGenesisCore;
}

function authorityFor(binding: Readonly<Record<string, unknown>>): AcceptedCustodyAuthority {
  return Object.freeze({
    project_id: binding.project_id, person_id: binding.person_id, device_id: binding.device_id, access_scope_id: binding.access_scope_id,
    signing_key_id: binding.signing_key_id, recipient_key_id: binding.recipient_key_id, accepted_control_head_id: binding.accepted_control_head_id,
    offline_root_key_id: binding.offline_root_key_id, key_epoch_id: binding.current_epoch_id, key_epoch_commitment: binding.current_epoch_commitment,
    device_status: "active"
  }) as AcceptedCustodyAuthority;
}

class MemorySink implements RecoveryKitSink {
  readonly #values = new Map<string, Uint8Array>();
  async write(id: string, bytes: Uint8Array): Promise<void> { this.#values.set(id, Uint8Array.from(bytes)); }
  async read(id: string): Promise<Uint8Array | null> { const value = this.#values.get(id); return value ? Uint8Array.from(value) : null; }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Custody database deletion blocked."));
  });
}

function rootCapability(): RootCeremonyCapability { return { scope: "root_ceremony_only", person_id: ids.person } as unknown as RootCeremonyCapability; }
function recoveryCapability(): RecoveryCeremonyCapability { return { scope: "recovery_ceremony_only", person_id: ids.person } as unknown as RecoveryCeremonyCapability; }
function entity(kind: string, fill: string): never { return `pm:${kind}:v1:${fill.repeat(25)}a` as never; }
function digest(kind: string, fill: string): never { return `pm:${kind}:v1:${fill.repeat(51)}a` as never; }
function fromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exactBuffer(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
function setStage(value: string): void {
  (globalThis as typeof globalThis & { __hc2s4Stage?: string }).__hc2s4Stage = value;
  localStorage.setItem("patchmark-hc2-slice4-stage", value);
}

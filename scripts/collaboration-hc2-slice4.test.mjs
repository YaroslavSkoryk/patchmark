import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sodium from "libsodium-wrappers-sumo";

import { executeCollaborationBootstrap } from "../lib/collaboration/bootstrap-executor.ts";
import { planNativeCollaborationBootstrap } from "../lib/collaboration/bootstrap-planner.ts";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { parseAttestationRecord } from "../lib/collaboration/checkpoints.ts";
import {
  parseControlActionCore,
  parseControlEventRecordStructure,
  parseControlEventCoreStructure
} from "../lib/collaboration/control.ts";
import { EventControlStore } from "../lib/collaboration/event-control-store.ts";
import {
  buildSignaturePreimage,
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventCoreIdentity
} from "../lib/collaboration/preimages.ts";
import {
  Hc2CustodyCeremonyCoordinator,
  Hc2SingleCustodyCeremonyFailureInjector,
  deriveCustodyCeremonyPlanDigest,
  hc2CustodyCeremonyFailureCuts,
  parseCustodyCeremonyPlan
} from "../lib/collaboration/hc2/custody-ceremony.ts";
import {
  Hc2InMemoryCustodyStore,
  parseStoredDeviceVaultRecord
} from "../lib/collaboration/hc2/custody-store.ts";
import { buildInitialFoundationRootPreimage } from "../lib/collaboration/hc2/custody-types.ts";
import { Hc2DeviceVaultService } from "../lib/collaboration/hc2/device-vault.ts";
import {
  buildEpochWrapAad,
  deriveEpochCommitment,
  withUnwrappedEpoch,
  wrapEpochSecret
} from "../lib/collaboration/hc2/epoch-custody.ts";
import { OfflineProjectRootProvider } from "../lib/collaboration/hc2/providers/root-recovery-provider.ts";
import { performRootRecoveryWorkerOperation } from "../lib/collaboration/hc2/providers/root-recovery-worker.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import { decodeRecoveryKitContainer } from "../lib/collaboration/hc2/recovery-kit-format.ts";
import { Hc2WebLocksAdapter } from "../lib/collaboration/hc2/web-locks.ts";

let assertions = 0;
const fixture = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc2-slice4-v1.json", import.meta.url), "utf8"));
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const rejects = async (operation, matcher) => { assertions += 1; await assert.rejects(operation, matcher); };

const ids = Object.freeze({
  project: entity("project", "a"),
  person: entity("person", "b"),
  membership: entity("membership", "c"),
  scope: entity("access-scope", "d"),
  oldDevice: entity("device", "e"),
  newDevice: entity("device", "f"),
  rootKey: entity("public-key", "g"),
  oldSigning: entity("public-key", "h"),
  oldRecipient: entity("public-key", "j"),
  newSigning: entity("public-key", "k"),
  newRecipient: entity("public-key", "m"),
  epoch1: entity("key-epoch", "k"),
  epoch2: entity("key-epoch", "m"),
  state1: digest("control-state-root", "q"),
  state2: digest("control-state-root", "r"),
  document: entity("document", "v")
});

async function testEpochWrapping() {
  const rawKey = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const secret = hex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
  const originalSecret = Uint8Array.from(secret);
  const nonce = hex("000102030405060708090a0b");
  const commitment = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch1, epoch_secret: secret });
  equal(secret, originalSecret, "commitment derivation copies and does not mutate caller epoch bytes");
  const wrapped = await wrapEpochSecret({
    key,
    project_id: ids.project,
    device_id: ids.oldDevice,
    key_epoch_id: ids.epoch1,
    wrapping_key_generation: 0n,
    epoch_secret: secret,
    nonce
  });
  equal(secret, originalSecret, "epoch wrapping does not mutate caller bytes");
  equal(wrapped.key_epoch_commitment, commitment.key_epoch_commitment, "wrapped epoch binds the independently derived public commitment");
  equal(wrapped.ciphertext.length, 48, "32-byte epoch produces exact ciphertext plus tag");
  equal(toHex(wrapped.public_commitment_bytes), fixture.epoch_wrap.public_commitment_bytes_hex, "epoch public commitment matches frozen vector");
  equal(wrapped.key_epoch_commitment, fixture.epoch_wrap.key_epoch_commitment_id, "epoch commitment identity matches frozen vector");
  equal(toHex(buildEpochWrapAad(wrapped)), fixture.epoch_wrap.aad_hex, "epoch AAD matches frozen vector");
  equal(toHex(wrapped.ciphertext), fixture.epoch_wrap.ciphertext_and_tag_hex, "AES-256-GCM wrapping matches frozen vector");
  equal(buildEpochWrapAad(wrapped).length > 100, true, "epoch AAD is a complete canonical binding");
  let callbackReference;
  await withUnwrappedEpoch({
    key,
    record: wrapped,
    expected_project_id: ids.project,
    expected_device_id: ids.oldDevice,
    use(epoch) { callbackReference = epoch; equal(epoch, originalSecret, "bounded callback receives exact epoch bytes"); epoch.fill(7); }
  });
  check(callbackReference.every((byte) => byte === 0), "bounded callback copy is wiped after use");
  const changed = { ...wrapped, ciphertext: Uint8Array.from(wrapped.ciphertext) }; changed.ciphertext[0] ^= 1;
  await rejects(() => withUnwrappedEpoch({ key, record: changed, expected_project_id: ids.project, expected_device_id: ids.oldDevice, use() {} }), /operation|decrypt|cipher/i);
}

async function testFrozenFixture() {
  const kitBytes = hex(fixture.recovery_kit.container_canonical_hex);
  equal(kitBytes.length, fixture.recovery_kit.container_bytes, "frozen recovery container length is exact");
  equal(createHash("sha256").update(kitBytes).digest("hex"), fixture.recovery_kit.container_sha256, "frozen recovery container digest is exact");
  const parsed = decodeRecoveryKitContainer(kitBytes);
  equal(toHex(parsed.public_header.root_public_key_bytes), fixture.root_ed25519.tagged_public_key_hex, "frozen recovery header binds tagged root public key");
  equal(toHex(parsed.encrypted_payload), fixture.recovery_kit.ciphertext_and_tag_hex, "frozen recovery ciphertext is exact");
  await sodium.ready;
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    hex(fixture.recovery_kit.ciphertext_and_tag_hex),
    hex(fixture.recovery_kit.public_header_aad_hex),
    hex(fixture.recovery_kit.nonce_hex),
    hex(fixture.recovery_kit.derived_key_hex)
  );
  equal(plaintext.length, fixture.recovery_kit.payload_bytes, "frozen XChaCha recovery binding opens to the exact payload length");
  equal(createHash("sha256").update(plaintext).digest("hex"), fixture.recovery_kit.payload_sha256, "decrypted recovery payload matches only its frozen digest commitment");
  plaintext.fill(0);
  const rootPublic = await crypto.subtle.importKey("raw", hex(fixture.root_ed25519.raw_public_key_hex), "Ed25519", true, ["verify"]);
  for (const vector of [fixture.initial_foundation, fixture.root_recovery]) {
    check(await crypto.subtle.verify("Ed25519", rootPublic, hex(vector.root_signature_hex), hex(vector.root_signature_preimage_hex)), "frozen root authority signature verifies independently through WebCrypto");
  }
  equal(fixture.root_recovery.late_old_device_result, "superseded_control_branch", "frozen recovery evidence records deterministic late-old-device supersession");
  equal(fixture.rejections.length, 14, "frozen rejection matrix remains complete");
}

async function testVaultAndCollision() {
  const store = new Hc2InMemoryCustodyStore();
  const random = new ScriptedRandom([new Uint8Array(32).fill(0xa5), new Uint8Array(12).fill(0x5a)]);
  const vault = new Hc2DeviceVaultService({ store, random });
  const recoveryDigest = new Uint8Array(32).fill(3);
  const controlHead = digest("control-event", "s");
  let journal = await beginVerifiedJournal(store, {
    ceremonyId: "vault-test",
    deviceId: ids.oldDevice,
    signingKeyId: ids.oldSigning,
    recipientKeyId: ids.oldRecipient,
    epochId: ids.epoch1,
    recoveryDigest,
    controlHead
  });
  const prepared = await vault.prepare({
    project_id: ids.project, person_id: ids.person, device_id: ids.oldDevice, access_scope_id: ids.scope,
    generation: 0n, signing_key_id: ids.oldSigning, recipient_key_id: ids.oldRecipient,
    offline_root_key_id: ids.rootKey, key_epoch_id: ids.epoch1, recovery_kit_sha256: recoveryDigest
  });
  const installed = await vault.install({ handle: prepared.handle, accepted_control_head_id: controlHead, journal });
  equal(installed.status, "installed", "vault installs atomically from exact verified journal");
  journal = await store.readCeremony(ids.project, "vault-test");
  equal(journal.phase, "keys_installed", "vault install advances the journal in the same authoritative operation");
  const stored = parseStoredDeviceVaultRecord(await store.readVault(ids.project, ids.oldDevice));
  equal(stored.signing_key_pair.privateKey.extractable, false, "stored Ed25519 private key is non-extractable");
  equal(stored.recipient_key_pair.privateKey.extractable, false, "stored X25519 private key is non-extractable");
  equal(stored.local_kek.extractable, false, "stored local wrapping key is non-extractable");
  check(!("root_seed" in stored) && !("epoch_secret" in stored), "vault record contains neither root seed nor plaintext epoch");
  const authority = authorityFor(installed.public_binding);
  const loaded = await vault.loadAndVerify(authority);
  let callback;
  await vault.withCurrentEpoch({ custody: loaded, use(secret) { callback = secret; equal(secret, new Uint8Array(32).fill(0xa5), "reopened wrapped epoch revalidates its commitment"); } });
  check(callback.every((byte) => byte === 0), "vault epoch callback bytes are wiped");
  await vault.withCurrentEpoch({ custody: loaded, use(secret) { equal(secret, new Uint8Array(32).fill(0xa5), "callback mutation cannot change the stored wrapped epoch"); } });

  await rejects(() => vault.loadAndVerify({ ...authority, project_id: entity("project", "z") }), /absent|custody/i);
  await rejects(() => vault.loadAndVerify({ ...authority, person_id: entity("person", "z") }), /authority/i);
  await rejects(() => vault.loadAndVerify({ ...authority, device_id: ids.newDevice }), /absent|custody/i);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, unexpected_path: "/private/project" })).loadAndVerify(authority), /field/i);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, signing_key_id: ids.newSigning })).loadAndVerify(authority), /identity/i);
  const wrongAlgorithmKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, signing_key_pair: { ...record.signing_key_pair, privateKey: wrongAlgorithmKey } })).loadAndVerify(authority), /Ed25519|key/i);
  const wrongUsageKek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, local_kek: wrongUsageKek })).loadAndVerify(authority), /wrapping|usage|key/i);
  const extractableKek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, local_kek: extractableKek })).loadAndVerify(authority), /extract|wrapping|key/i);
  await rejects(() => tamperedVault(store, (record) => ({ ...record, accepted_control_head_id: digest("control-event", "z") })).loadAndVerify(authority), /authority/i);

  const collisionVault = new Hc2DeviceVaultService({ store, random: new ScriptedRandom([new Uint8Array(32).fill(9), new Uint8Array(12).fill(0x5a)]) });
  await rejects(() => collisionVault.prepare({
    project_id: ids.project, person_id: ids.person, device_id: ids.oldDevice, access_scope_id: ids.scope,
    generation: 0n, signing_key_id: ids.newSigning, recipient_key_id: ids.newRecipient,
    offline_root_key_id: ids.rootKey, key_epoch_id: ids.epoch2, recovery_kit_sha256: recoveryDigest
  }), /nonce collision/i);
  equal(random.remaining, 0, "nonce collision path performs no hidden random retry");
}

async function testOfflineRootBoundary() {
  const provider = rootProvider();
  const password = new TextEncoder().encode("correct horse battery staple");
  const created = await provider.create({ capability: rootCapability(), project_id: ids.project, root_key_id: ids.rootKey, root_generation: 0n, password_material: password });
  const container = decodeRecoveryKitContainer(created.recovery_kit_bytes);
  equal(container.public_header.project_id, ids.project, "recovery header binds project");
  equal(container.public_header.root_key_id, ids.rootKey, "recovery header binds root identity");
  check(!toHex(created.recovery_kit_bytes).includes(toHex(password)), "recovery kit does not contain plaintext password bytes");
  const verified = await provider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: created.recovery_kit_bytes, password_material: password });
  equal(verified.status, "verified", "worker decrypts, re-derives, challenges, and verifies recovery root");
  const wrong = await provider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: created.recovery_kit_bytes, password_material: new TextEncoder().encode("wrong") });
  equal(wrong, { status: "rejected", reason: "recovery_failed" }, "wrong password returns uniform recovery failure");
  const uniformFailure = Object.freeze({ status: "rejected", reason: "recovery_failed" });
  const mutations = [
    ["modified header", mutateScalarAfterText(created.recovery_kit_bytes, "argon2_opslimit", 2)],
    ["modified ciphertext", mutateLastByte(created.recovery_kit_bytes)],
    ["truncated container", created.recovery_kit_bytes.slice(0, -1)],
    ["appended container", Uint8Array.from([...created.recovery_kit_bytes, 0])],
    ["unknown version", mutateScalarAfterText(created.recovery_kit_bytes, "schema_version", 2)],
    ["excessive size", new Uint8Array(64 * 1024 + 1)]
  ];
  for (const [label, bytes] of mutations) {
    equal(await provider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: bytes, password_material: password }), uniformFailure, `${label} returns the same uniform recovery failure`);
  }
  equal(await provider.verify({ capability: recoveryCapability(), project_id: entity("project", "z"), root_key_id: ids.rootKey, recovery_kit_bytes: created.recovery_kit_bytes, password_material: password }), uniformFailure, "cross-project substitution returns the uniform recovery failure");
  equal(await provider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: entity("public-key", "z"), recovery_kit_bytes: created.recovery_kit_bytes, password_material: password }), uniformFailure, "wrong root identity returns the uniform recovery failure");
  const wrongPublic = replaceFirstBytes(created.recovery_kit_bytes, container.public_header.root_public_key_bytes, (value) => { value[value.length - 1] ^= 1; });
  equal(await provider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: wrongPublic, password_material: password }), uniformFailure, "wrong root public bytes return the uniform recovery failure");
  const genesis = genesisCore({ deviceId: ids.oldDevice, signingKeyId: ids.oldSigning, epochId: ids.epoch1, epochCommitment: digest("key-epoch-commitment", "t") });
  const preimage = await buildInitialFoundationRootPreimage(genesis);
  const signed = await provider.signAuthority({ capability: recoveryCapability(), recovery_kit_bytes: created.recovery_kit_bytes, password_material: password, preimage });
  equal(signed.status, "signed", "offline root signs one constructed foundation authority preimage");
  const direct = await performRootRecoveryWorkerOperation({
    request_id: "a".repeat(32), operation: "sign_root_authority", password: Uint8Array.from(password), project_id: ids.project,
    root_key_id: ids.rootKey, kit_bytes: Uint8Array.from(created.recovery_kit_bytes), authority_purpose: "initial_foundation",
    authority_control_event_id: preimage.control_event_id, authority_preimage: new TextEncoder().encode("arbitrary message")
  });
  equal(direct.status, "rejected", "worker independently rejects arbitrary-message root signing");
  const controller = new AbortController();
  const abortProvider = new OfflineProjectRootProvider({ random: new WebCryptoRandomSource(), worker_factory: () => new HangingWorker() });
  const pendingAbort = abortProvider.verify({ capability: recoveryCapability(), project_id: ids.project, root_key_id: ids.rootKey, recovery_kit_bytes: created.recovery_kit_bytes, password_material: password, signal: controller.signal });
  for (let attempt = 0; attempt < 100 && HangingWorker.posts === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  check(HangingWorker.posts > 0, "abort test reaches the isolated worker before cancellation");
  controller.abort();
  await rejects(() => pendingAbort, (error) => error?.code === "operation_aborted");
  check(HangingWorker.terminations > 0 && abortProvider.evidence()?.worker_terminated === true, "an aborted root operation terminates its fresh worker");
  check(provider.evidence()?.worker_terminated === true, "fresh root worker terminates after every operation");
  return { kit: created.recovery_kit_bytes, rootPublic: created.root_public_key_bytes, password };
}

async function testInitialAndProfileLossCeremonies() {
  const sink = new MemoryRecoveryKitSink();
  const locks = new Hc2WebLocksAdapter(new SerialLockManager());
  const store = new Hc2InMemoryCustodyStore();
  const vault = new Hc2DeviceVaultService({ store, random: new WebCryptoRandomSource() });
  const coordinator = new Hc2CustodyCeremonyCoordinator({ store, vault, root: rootProvider(), recovery_kit_sink: sink, locks });
  const plan = ceremonyPlan({ kind: "initial_foundation", ceremonyId: "initial", deviceId: ids.oldDevice, lostDeviceId: null, signingKeyId: ids.oldSigning, recipientKeyId: ids.oldRecipient, epochId: ids.epoch1, previous: null });
  let portableCommitObserved = false;
  let portableCommitCount = 0;
  let sourceValidationCount = 0;
  let foundationPreparationCount = 0;
  let foundationAuthority;
  let foundationRootPublic;
  let foundationBootstrapPlan;
  let foundationFacilities;
  const foundationBackend = new DeterministicMemoryBackend();
  const initialInput = {
    plan, root_capability: rootCapability(), recovery_capability: recoveryCapability(), password_material: new TextEncoder().encode("initial recovery password"),
    async validate_source_and_plan() { sourceValidationCount += 1; },
    async prepare_foundation({ root, device }) {
      foundationPreparationCount += 1;
      check(sourceValidationCount >= foundationPreparationCount, "source and plan validation precedes every foundation preparation attempt");
      foundationRootPublic = root.root_public_key_bytes;
      const planned = await planNativeCollaborationBootstrap({
        schema_version: 1, object_kind: "native_collaboration_bootstrap_input", protocol_version: 1,
        reducer_version: "patchmark-hc-reducer-v1", project_id: ids.project, project_title: "Custody-backed foundation", project_metadata: [],
        owner_person_id: ids.person, owner_membership_id: ids.membership, owner_access_scope_id: ids.scope,
        owner_device_id: device.device_id, owner_device_signing_key_id: device.signing_key_id, offline_root_public_key_id: root.root_key_id,
        initial_key_epoch_number: 0n, initial_key_epoch_id: device.current_epoch_id,
        initial_key_epoch_public_commitment_bytes: device.current_epoch_public_commitment_bytes, initial_merge_policy: "manual",
        group_order: [], groups: [], document_order: [ids.document], documents: [{
          document_id: ids.document, markdown_bytes: new Uint8Array(), title: "", logical_path: "untitled.md", position: "0001",
          group_id: null, archive_status: "active", tombstone: false, shared_roles: [], comments: [], patches: [], reference_document_ids: []
        }], initial_review_batches: [], initial_rewrite_sessions: []
      });
      if (foundationBootstrapPlan) equal(planned.plan_commitment, foundationBootstrapPlan.plan_commitment, "foundation replay reconstructs the exact HC-1 bootstrap plan");
      foundationBootstrapPlan = planned;
      const core = planned.control_genesis_core;
      const identity = await deriveControlEventCoreIdentity(core);
      equal(identity.id, planned.expected_control_event_id, "custody-backed foundation uses the real planned HC-1 control genesis");
      equal(core.initial_key_epoch_commitment, device.current_epoch_commitment, "HC-1 genesis binds the generated epoch commitment");
      foundationAuthority = authorityFor({ ...device, accepted_control_head_id: identity.id });
      return {
        control_genesis_core: core,
        accepted_authority: foundationAuthority,
        async commit_portable({ root_signature, sign_device }) {
          equal((await store.readCeremony(ids.project, "initial")).phase, "keys_installed", "portable write begins only after local key installation");
          check((await sink.read("initial")) instanceof Uint8Array, "portable write begins only after kit readback");
          equal(root_signature.length, 64, "portable foundation receives verified root signature");
          foundationFacilities = await custodyBootstrapFacilities({ plan: planned, root_public: root.root_public_key_bytes, device_public: device.signing_public_key_bytes, root_signature, sign_device });
          const execution = await executeCollaborationBootstrap({ plan: planned, backend: foundationBackend, facilities: foundationFacilities });
          equal(execution.status, "complete_local_foundation", "portable commit runs the real HC-1 bootstrap executor through checkpoint and snapshot verification");
          portableCommitCount += 1;
          portableCommitObserved = true;
        },
        async reopen_and_verify() {
          check(portableCommitObserved && foundationFacilities, "portable foundation is reopened only after commit");
          const reopened = await executeCollaborationBootstrap({ plan: planned, backend: foundationBackend, facilities: foundationFacilities });
          equal(reopened.status, "complete_local_foundation", "reopen reconstructs and verifies the accepted HC-1 foundation");
          check(reopened.status === "complete_local_foundation" && reopened.resumed, "HC-1 foundation reopen uses exact durable objects");
          return foundationAuthority;
        }
      };
    }
  };
  const beforeInstall = new Hc2SingleCustodyCeremonyFailureInjector("after_recovery_kit_verified");
  const beforeInstallResult = await coordinator.establishInitialFoundation({ ...initialInput, failure_injector: beforeInstall });
  equal(beforeInstallResult.status, "failed", "injected cut after kit verification stops the ceremony");
  check(beforeInstall.fired, "pre-install custody failure cut fires exactly once");
  equal(await store.readVault(ids.project, ids.oldDevice), null, "pre-install failure leaves no device vault");
  equal(portableCommitObserved, false, "pre-install failure leaves portable authority invisible");
  check((await sink.read("initial")) instanceof Uint8Array, "verified recovery kit remains available for an exact retry");

  const afterPortable = new Hc2SingleCustodyCeremonyFailureInjector("after_portable_commit");
  const afterPortableResult = await coordinator.establishInitialFoundation({ ...initialInput, failure_injector: afterPortable });
  equal(afterPortableResult.status, "failed", "injected cut after portable commit stops before the completion marker");
  check(afterPortable.fired, "post-portable custody failure cut fires exactly once");
  equal((await store.readCeremony(ids.project, "initial")).phase, "keys_installed", "post-portable failure retains installed custody for exact replay");
  equal(await store.readCompletionMarker(ids.project, "initial"), null, "post-portable failure cannot publish completion early");
  equal(portableCommitCount, 1, "first portable commit occurred exactly once before the injected crash");
  equal((await coordinator.abandonBeforeCustodyInstall({ plan })).status, "failed", "installed custody cannot be abandoned because portable authority may already exist");
  const exactInitialKit = await sink.read("initial");
  const substitutedKit = Uint8Array.from(exactInitialKit); substitutedKit[substitutedKit.length - 1] ^= 1;
  await sink.write("initial", substitutedKit);
  equal((await coordinator.establishInitialFoundation(initialInput)).status, "failed", "resume rejects recovery-kit replacement after custody installation");
  equal(portableCommitCount, 1, "wrong-kit resume cannot replay portable authority");
  await sink.write("initial", exactInitialKit);
  equal((await coordinator.establishInitialFoundation({ ...initialInput, plan: { ...plan, root_key_id: entity("public-key", "z") } })).status, "failed", "resume rejects a replacement offline-root plan");

  const result = await coordinator.establishInitialFoundation(initialInput);
  equal(result.status, "complete", "initial custody-backed foundation completes");
  check(result.status === "complete" && result.resumed, "exact retry reports a resumed ceremony");
  equal(portableCommitCount, 2, "idempotent portable commit is replayed before final completion");
  equal((await store.readCeremony(ids.project, "initial")).phase, "complete", "completion marker is written last");

  const abandonStore = new Hc2InMemoryCustodyStore();
  const abandonCoordinator = new Hc2CustodyCeremonyCoordinator({
    store: abandonStore,
    vault: new Hc2DeviceVaultService({ store: abandonStore, random: new WebCryptoRandomSource() }),
    root: rootProvider(), recovery_kit_sink: new MemoryRecoveryKitSink(), locks
  });
  const abandonPlan = ceremonyPlan({ kind: "initial_foundation", ceremonyId: "abandon-before-install", deviceId: ids.oldDevice, lostDeviceId: null, signingKeyId: ids.oldSigning, recipientKeyId: ids.oldRecipient, epochId: ids.epoch1, previous: null });
  await abandonStore.beginCeremony({
    schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation", ceremony_id: abandonPlan.ceremony_id,
    plan_sha256: await deriveCustodyCeremonyPlanDigest(abandonPlan), project_id: ids.project, person_id: ids.person, device_id: ids.oldDevice,
    lost_device_id: null, root_key_id: ids.rootKey, key_epoch_id: ids.epoch1, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned"
  });
  const abandoned = await abandonCoordinator.abandonBeforeCustodyInstall({ plan: abandonPlan });
  equal(abandoned.status, "abandoned", "an exact pre-install ceremony plan may be explicitly abandoned");
  equal((await abandonStore.readCeremony(ids.project, abandonPlan.ceremony_id)).phase, "abandoned", "abandonment is durable and authoritative");
  equal((await abandonCoordinator.abandonBeforeCustodyInstall({ plan: abandonPlan })).status, "abandoned", "exact abandonment retry is idempotent");

  const recoveryStore = new Hc2InMemoryCustodyStore();
  const recoveryVault = new Hc2DeviceVaultService({ store: recoveryStore, random: new WebCryptoRandomSource() });
  const recoveryCoordinator = new Hc2CustodyCeremonyCoordinator({ store: recoveryStore, vault: recoveryVault, root: rootProvider(), recovery_kit_sink: sink, locks });
  const initialKit = await sink.read("initial");
  await sink.write("profile-loss", initialKit);
  const acceptedBeforeRecovery = foundationAuthority.accepted_control_head_id;
  const recoveryPlan = ceremonyPlan({ kind: "profile_loss_recovery", ceremonyId: "profile-loss", deviceId: ids.newDevice, lostDeviceId: ids.oldDevice, signingKeyId: ids.newSigning, recipientKeyId: ids.newRecipient, epochId: ids.epoch2, previous: acceptedBeforeRecovery });
  const portableRecoveryState = Object.freeze({
    verification: "verified_complete_batches", control_resolution: "single_accepted_root_state", project_id: ids.project,
    accepted_control_head_id: acceptedBeforeRecovery, last_uncontested_control_id: foundationAuthority.accepted_control_head_id,
    previous_root_control_id: foundationAuthority.accepted_control_head_id, root_sequence: 0n, offline_root_key_id: ids.rootKey,
    offline_root_public_key_bytes: foundationRootPublic, root_generation: 0n, active_control_device_id: ids.oldDevice,
    selected_membership_device_state_root: foundationBootstrapPlan.control_state_root, observed_conflicting_tip_ids: [acceptedBeforeRecovery],
    revocation_sequence_cutoffs: [{ device_id: ids.oldDevice, maximum_accepted_semantic_sequence: 0n }]
  });
  let recoveryCommitted = false;
  let recoveryAuthority;
  let recoveryEvents;
  let recoveryIdentity;
  let lateOldIdentity;
  const recoveryResult = await recoveryCoordinator.recoverAfterProfileLoss({
    plan: recoveryPlan,
    recovery_capability: recoveryCapability(),
    password_material: new TextEncoder().encode("initial recovery password"),
    async verify_portable_replica() { return portableRecoveryState; },
    async prepare_recovery({ device }) {
      const action = parseControlActionCore({
        schema_version: 1, project_id: ids.project, action_kind: "root_recovery",
        last_uncontested_control_id: foundationAuthority.accepted_control_head_id,
        selected_membership_device_state_root: foundationBootstrapPlan.control_state_root,
        revocation_sequence_cutoffs: [{ device_id: ids.oldDevice, maximum_accepted_semantic_sequence: 0n }],
        replacement_active_control_device_id: ids.newDevice,
        replacement_key_epoch_id: ids.epoch2,
        replacement_key_epoch_commitment: device.current_epoch_commitment,
        observed_conflicting_tip_ids: [acceptedBeforeRecovery],
        supersession_policy: "supersede_all_ordinary_descendants_outside_recovery_chain"
      });
      const actionId = (await deriveControlActionIdentity(action)).id;
      const core = parseControlEventCoreStructure({
        schema_version: 1, object_kind: "control_event_core", control_kind: "root_recovery", project_id: ids.project,
        control_sequence: 1n, previous_control_id: foundationAuthority.accepted_control_head_id,
        root_sequence: 1n, previous_root_control_id: foundationAuthority.accepted_control_head_id,
        issuer_root_key_id: ids.rootKey, action_id: actionId, resulting_control_state_root: ids.state2,
        key_epoch_id: ids.epoch2, key_epoch_commitment: device.current_epoch_commitment
      }, { action: { record_version: 1, object_kind: "control_action", action_id: actionId, core: action } });
      const identity = await deriveControlEventCoreIdentity(core);
      recoveryIdentity = identity;
      recoveryAuthority = authorityFor({ ...device, accepted_control_head_id: identity.id });
      return {
        action, control_event_core: core, accepted_authority: recoveryAuthority,
        async commit_portable({ root_signature, sign_device }) {
          equal((await recoveryStore.readCeremony(ids.project, "profile-loss")).phase, "keys_installed", "recovery portable write follows new custody install");
          equal(root_signature.length, 64, "root recovery is authorized by offline root signature");
          const recoveryPreimage = encodeCanonicalCbor(buildSignaturePreimage("control_event", ids.project, identity.id));
          const replacementSignature = await sign_device(recoveryPreimage);
          equal(replacementSignature.length, 64, "replacement device creates its own attestation");
          const newPublic = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: device.signing_public_key_bytes, expected_algorithm: "ed25519" });
          check(await crypto.subtle.verify("Ed25519", newPublic.public_key, replacementSignature, recoveryPreimage), "replacement-device attestation verifies against its fresh public key");
          const foundationTransition = foundationFacilities.control_transition_verifier;
          recoveryEvents = new EventControlStore({
            backend: foundationBackend,
            attestation_verifier: {
              async verify(request) {
                if (request.signer_key_id !== newPublic.key_id) return foundationFacilities.attestation_verifier.verify(request);
                return await crypto.subtle.verify("Ed25519", newPublic.public_key, request.signature_bytes, request.signature_preimage)
                  ? { outcome: "verified", binding: request }
                  : { outcome: "invalid", reason: "replacement device signature is invalid" };
              }
            },
            control_transition_verifier: {
              async verify(request) {
                if (request.control_kind === "genesis") return foundationTransition.verify(request);
                if (request.control_event_id === identity.id && request.control_kind === "root_recovery") {
                  return {
                    outcome: "verified", binding: request,
                    resulting_authority: {
                      schema_version: 1, project_id: ids.project, control_event_id: identity.id, control_state_root: ids.state2,
                      active_control_device_id: ids.newDevice, offline_root_key_id: ids.rootKey, key_epoch_id: ids.epoch2,
                      key_epoch_commitment: device.current_epoch_commitment,
                      device_authorities: [
                        { ...foundationBootstrapPlan.control_state.device_authorities[0], status: "revoked", maximum_accepted_semantic_sequence: 0n },
                        { ...foundationBootstrapPlan.control_state.device_authorities[0], device_id: ids.newDevice, signing_key_id: ids.newSigning, status: "active", maximum_accepted_semantic_sequence: null }
                      ]
                    }
                  };
                }
                return {
                  outcome: "verified", binding: request,
                  resulting_authority: {
                    schema_version: 1, project_id: ids.project, control_event_id: request.control_event_id,
                    control_state_root: request.resulting_control_state_root, active_control_device_id: ids.oldDevice,
                    offline_root_key_id: ids.rootKey, key_epoch_id: ids.epoch1,
                    key_epoch_commitment: foundationAuthority.key_epoch_commitment,
                    device_authorities: foundationBootstrapPlan.control_state.device_authorities
                  }
                };
              }
            }
          });
          const storedAction = await recoveryEvents.putControlAction(action);
          equal(storedAction.id, actionId, "existing HC-1 store persists the exact root-recovery action");
          const rootAttestation = await makeAttestation(ids.project, "control_event", identity.id, ids.rootKey, root_signature);
          const replacementAttestation = await makeAttestation(ids.project, "control_event", identity.id, ids.newSigning, replacementSignature);
          await recoveryEvents.putAttestationRecord(rootAttestation);
          await recoveryEvents.putAttestationRecord(replacementAttestation);
          const recoveryRecord = parseControlEventRecordStructure({
            record_version: 1, object_kind: "control_event", control_event_id: identity.id, core,
            authority_attestation_id: rootAttestation.attestation_id
          }, { action: { record_version: 1, object_kind: "control_action", action_id: actionId, core: action } });
          const ingestedRecovery = await recoveryEvents.putControlEvent(recoveryRecord);
          equal(controlClassification(ingestedRecovery.state, identity.id), "accepted", "existing HC-1 reconstruction accepts the root-authorized recovery");

          const lateAction = parseControlActionCore({
            schema_version: 1, project_id: ids.project, action_kind: "membership_role_change",
            membership_id: ids.membership, person_id: ids.person, next_role: "owner"
          });
          const lateActionId = (await recoveryEvents.putControlAction(lateAction)).id;
          const lateCore = parseControlEventCoreStructure({
            schema_version: 1, object_kind: "control_event_core", control_kind: "ordinary", project_id: ids.project,
            control_sequence: 1n, previous_control_id: foundationAuthority.accepted_control_head_id, issuer_device_id: ids.oldDevice,
            action_id: lateActionId, resulting_control_state_root: digest("control-state-root", "z"), key_epoch_id: ids.epoch1,
            key_epoch_commitment: foundationAuthority.key_epoch_commitment
          }, { action: { record_version: 1, object_kind: "control_action", action_id: lateActionId, core: lateAction }, ordinary_context: {
            expected_previous_control_id: foundationAuthority.accepted_control_head_id, expected_control_sequence: 1n,
            designated_active_control_device_id: ids.oldDevice, expected_project_id: ids.project
          } });
          lateOldIdentity = await deriveControlEventCoreIdentity(lateCore);
          const lateSignature = await vault.signDevice({ custody: result.custody, preimage: encodeCanonicalCbor(buildSignaturePreimage("control_event", ids.project, lateOldIdentity.id)) });
          const lateAttestation = await makeAttestation(ids.project, "control_event", lateOldIdentity.id, ids.oldSigning, lateSignature);
          await recoveryEvents.putAttestationRecord(lateAttestation);
          const lateRecord = parseControlEventRecordStructure({
            record_version: 1, object_kind: "control_event", control_event_id: lateOldIdentity.id, core: lateCore,
            authority_attestation_id: lateAttestation.attestation_id
          }, { action: { record_version: 1, object_kind: "control_action", action_id: lateActionId, core: lateAction }, ordinary_context: {
            expected_previous_control_id: foundationAuthority.accepted_control_head_id, expected_control_sequence: 1n,
            designated_active_control_device_id: ids.oldDevice, expected_project_id: ids.project
          } });
          const late = await recoveryEvents.putControlEvent(lateRecord);
          equal(controlClassification(late.state, lateOldIdentity.id), "superseded_control_branch", "existing HC-1 rules supersede late lost-device control deterministically");
          recoveryCommitted = true;
        },
        async reopen_and_verify() {
          check(recoveryCommitted && recoveryEvents && recoveryIdentity && lateOldIdentity, "recovery reopens after portable commit");
          const reopened = await recoveryEvents.reopenProject(ids.project);
          equal(controlClassification(reopened, recoveryIdentity.id), "accepted", "reopen preserves accepted root-recovery authority");
          equal(controlClassification(reopened, lateOldIdentity.id), "superseded_control_branch", "reopen preserves late old-device supersession");
          return {
            accepted_authority: recoveryAuthority, replacement_device_authoritative: true, lost_device_superseded: true,
            late_lost_device_evidence: "superseded_control_branch", old_private_keys_restored: false,
            old_sequence_continuity_restored: false, old_reservations_restored: false
          };
        }
      };
    }
  });
  equal(recoveryResult.status, "complete", "fresh-profile root recovery completes");
  if (recoveryResult.status === "complete") {
    equal(recoveryResult.custody.public_binding.device_id, ids.newDevice, "recovery installs a brand-new device identity");
    check(recoveryResult.custody.public_binding.signing_key_id !== ids.oldSigning, "recovery does not clone the lost signing key identity");
    check(recoveryResult.custody.public_binding.current_epoch_id !== ids.epoch1, "recovery installs a fresh replacement epoch");
  }

  const invalidRecovery = (verify) => recoveryCoordinator.recoverAfterProfileLoss({
    plan: recoveryPlan, recovery_capability: recoveryCapability(), password_material: new TextEncoder().encode("initial recovery password"),
    verify_portable_replica: verify,
    async prepare_recovery() { throw new Error("invalid portable state reached recovery preparation"); }
  });
  equal((await invalidRecovery(async () => ({ ...portableRecoveryState, control_resolution: "ambiguous_control_fork" }))).status, "failed", "ambiguous accepted control state blocks recovery");
  equal((await invalidRecovery(async () => ({ ...portableRecoveryState, verification: "incomplete_batches" }))).status, "failed", "incomplete portable batches block recovery");
  equal((await invalidRecovery(async () => { throw new Error("corrupt_portable_replica"); })).status, "failed", "corrupt replica verification blocks recovery");
  equal((await invalidRecovery(async () => ({ ...portableRecoveryState, root_generation: 1n }))).status, "failed", "stale or substituted portable root generation blocks recovery");
  equal((await invalidRecovery(async () => ({ ...portableRecoveryState, folder_path: "/private/project" }))).status, "failed", "operational folder state cannot enter verified recovery authority");
}

async function testEveryCeremonyFailureCut() {
  const kit = hex(fixture.recovery_kit.container_canonical_hex);
  const rootPublic = hex(fixture.root_ed25519.tagged_public_key_hex);
  const kitDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", kit));
  for (const [index, cut] of hc2CustodyCeremonyFailureCuts.entries()) {
    const store = new Hc2InMemoryCustodyStore();
    const sink = new MemoryRecoveryKitSink();
    const coordinator = new Hc2CustodyCeremonyCoordinator({
      store,
      vault: new Hc2DeviceVaultService({ store, random: new WebCryptoRandomSource() }),
      root: new DeterministicCeremonyRoot({ kit, rootPublic, kitDigest }),
      recovery_kit_sink: sink,
      locks: new Hc2WebLocksAdapter(new SerialLockManager())
    });
    const ceremonyId = `cut-${index}-${cut}`;
    const plan = ceremonyPlan({ kind: "initial_foundation", ceremonyId, deviceId: ids.oldDevice, lostDeviceId: null, signingKeyId: ids.oldSigning, recipientKeyId: ids.oldRecipient, epochId: ids.epoch1, previous: null });
    let portableVisible = false;
    let authority;
    const input = {
      plan, root_capability: rootCapability(), recovery_capability: recoveryCapability(), password_material: new TextEncoder().encode("failure-cut-password"),
      async validate_source_and_plan() {},
      async prepare_foundation({ device }) {
        const core = genesisCore({ deviceId: device.device_id, signingKeyId: device.signing_key_id, epochId: device.current_epoch_id, epochCommitment: device.current_epoch_commitment });
        const identity = await deriveControlEventCoreIdentity(core);
        authority = authorityFor({ ...device, accepted_control_head_id: identity.id });
        return {
          control_genesis_core: core,
          accepted_authority: authority,
          async commit_portable() { portableVisible = true; },
          async reopen_and_verify() { if (!portableVisible) throw new Error("portable_not_visible"); return authority; }
        };
      }
    };
    const injector = new Hc2SingleCustodyCeremonyFailureInjector(cut);
    const interrupted = await coordinator.establishInitialFoundation({ ...input, failure_injector: injector });
    equal(interrupted.status, "failed", `failure cut ${cut} interrupts before completion`);
    check(injector.fired, `failure cut ${cut} is reachable`);
    equal(await store.readCompletionMarker(ids.project, ceremonyId), null, `failure cut ${cut} cannot write completion early`);
    const resumed = await coordinator.establishInitialFoundation(input);
    equal(resumed.status, "complete", `failure cut ${cut} resumes the exact ceremony`);
    check(resumed.status === "complete" && resumed.resumed, `failure cut ${cut} records exact retry evidence`);
  }
  for (const mode of ["write", "reopen"]) {
    const store = new Hc2InMemoryCustodyStore();
    const sink = new PermissionFailingRecoveryKitSink(mode);
    const coordinator = new Hc2CustodyCeremonyCoordinator({
      store,
      vault: new Hc2DeviceVaultService({ store, random: new WebCryptoRandomSource() }),
      root: new DeterministicCeremonyRoot({ kit, rootPublic, kitDigest }), recovery_kit_sink: sink,
      locks: new Hc2WebLocksAdapter(new SerialLockManager())
    });
    const ceremonyId = `permission-${mode}`;
    const plan = ceremonyPlan({ kind: "initial_foundation", ceremonyId, deviceId: ids.oldDevice, lostDeviceId: null, signingKeyId: ids.oldSigning, recipientKeyId: ids.oldRecipient, epochId: ids.epoch1, previous: null });
    const outcome = await coordinator.establishInitialFoundation({
      plan, root_capability: rootCapability(), recovery_capability: recoveryCapability(), password_material: new TextEncoder().encode("permission-cut-password"),
      async validate_source_and_plan() {},
      async prepare_foundation() { throw new Error("permission failure reached key preparation"); }
    });
    equal(outcome.status, "failed", `recovery-kit ${mode} permission loss fails closed`);
    equal(await store.readVault(ids.project, ids.oldDevice), null, `recovery-kit ${mode} permission loss leaves no vault`);
    equal(await store.readCompletionMarker(ids.project, ceremonyId), null, `recovery-kit ${mode} permission loss leaves no completion marker`);
  }
}

function testStrictPlans() {
  assert.throws(() => parseCustodyCeremonyPlan(ceremonyPlan({ kind: "profile_loss_recovery", ceremonyId: "bad", deviceId: ids.oldDevice, lostDeviceId: ids.oldDevice, signingKeyId: ids.newSigning, recipientKeyId: ids.newRecipient, epochId: ids.epoch2, previous: digest("control-event", "u") })), /brand-new device/i); assertions += 1;
  const extra = { ...ceremonyPlan({ kind: "initial_foundation", ceremonyId: "extra", deviceId: ids.oldDevice, lostDeviceId: null, signingKeyId: ids.oldSigning, recipientKeyId: ids.oldRecipient, epochId: ids.epoch1, previous: null }), path: "/private/project" };
  assert.throws(() => parseCustodyCeremonyPlan(extra), /fields/i); assertions += 1;
}

async function beginVerifiedJournal(store, input) {
  const planSha = new Uint8Array(32).fill(1);
  const begun = await store.beginCeremony({
    schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation", ceremony_id: input.ceremonyId,
    plan_sha256: planSha, project_id: ids.project, person_id: ids.person, device_id: input.deviceId, lost_device_id: null,
    root_key_id: ids.rootKey, key_epoch_id: input.epochId, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned"
  });
  return { ...begun.journal, recovery_kit_sha256: input.recoveryDigest, accepted_control_head_id: input.controlHead, phase: "kit_verified" };
}

function genesisCore(input) {
  return parseControlEventCoreStructure({
    schema_version: 1, object_kind: "control_event_core", control_kind: "genesis", project_id: ids.project,
    control_sequence: 0n, previous_control_id: null, root_sequence: 0n, previous_root_control_id: null,
    owner_person_id: ids.person, offline_root_key_id: ids.rootKey, initial_active_control_device_id: input.deviceId,
    initial_memberships: [{ membership_id: ids.membership, person_id: ids.person, role: "owner", access_scope_id: ids.scope, status: "active" }],
    initial_authorized_devices: [{ device_id: input.deviceId, person_id: ids.person, signing_key_id: input.signingKeyId, status: "active" }],
    initial_key_epoch_id: input.epochId, initial_key_epoch_commitment: input.epochCommitment,
    resulting_control_state_root: ids.state1
  });
}

function authorityFor(binding) {
  return Object.freeze({
    project_id: binding.project_id, person_id: binding.person_id, device_id: binding.device_id, access_scope_id: binding.access_scope_id,
    signing_key_id: binding.signing_key_id, recipient_key_id: binding.recipient_key_id,
    accepted_control_head_id: binding.accepted_control_head_id, offline_root_key_id: binding.offline_root_key_id,
    key_epoch_id: binding.current_epoch_id, key_epoch_commitment: binding.current_epoch_commitment, device_status: "active"
  });
}

async function custodyBootstrapFacilities(input) {
  const root = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: input.root_public, expected_algorithm: "ed25519" });
  const device = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: input.device_public, expected_algorithm: "ed25519" });
  const verify = async (request) => {
    const key = request.signer_key_id === root.key_id ? root.public_key : request.signer_key_id === device.key_id ? device.public_key : null;
    if (!key || !(await crypto.subtle.verify("Ed25519", key, request.signature_bytes, request.signature_preimage))) {
      return { outcome: "invalid", reason: "custody attestation signature is invalid" };
    }
    return { outcome: "verified", binding: request };
  };
  return Object.freeze({
    attestation_verifier: { verify },
    control_transition_verifier: {
      async verify(request) {
        if (request.control_kind !== "genesis" || request.control_event_id !== input.plan.expected_control_event_id ||
            request.resulting_control_state_root !== input.plan.control_state_root || request.issuer_root_key_id !== input.plan.control_genesis_core.offline_root_key_id) {
          return { outcome: "invalid", reason: "custody foundation accepts only its exact HC-1 genesis" };
        }
        return {
          outcome: "verified", binding: request,
          resulting_authority: {
            schema_version: 1, project_id: input.plan.destination_project_id, control_event_id: input.plan.expected_control_event_id,
            control_state_root: input.plan.control_state_root, active_control_device_id: input.plan.owner_device_id,
            offline_root_key_id: input.plan.control_genesis_core.offline_root_key_id, key_epoch_id: input.plan.initial_key_epoch_id,
            key_epoch_commitment: input.plan.initial_key_epoch_commitment, device_authorities: input.plan.control_state.device_authorities
          }
        };
      }
    },
    async create_control_genesis_attestation(request) {
      if (request.control_event_id !== input.plan.expected_control_event_id || request.signer_key_id !== root.key_id ||
          !(await crypto.subtle.verify("Ed25519", root.public_key, input.root_signature, request.signature_preimage))) {
        throw new Error("Root custody signature is not bound to the exact planned genesis.");
      }
      return makeAttestation(request.project_id, "control_event", request.control_event_id, request.signer_key_id, input.root_signature);
    },
    async create_semantic_attestations(request) {
      if (request.author_device_id !== input.plan.owner_device_id || request.expected_signing_key_id !== device.key_id) {
        throw new Error("Semantic bootstrap attestation requested the wrong device custody.");
      }
      const signature = await input.sign_device(request.signature_preimage);
      return [await makeAttestation(request.project_id, "semantic_event", request.event_id, request.expected_signing_key_id, signature)];
    }
  });
}

async function makeAttestation(projectId, subjectKind, subjectId, signerKeyId, signature) {
  const core = {
    schema_version: 1, object_kind: "attestation_core", project_id: projectId, subject_kind: subjectKind,
    subject_id: subjectId, signer_key_id: signerKeyId, algorithm: "ed25519", signature_bytes: Uint8Array.from(signature)
  };
  const identity = await deriveAttestationIdentity(core);
  return parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: identity.id, core });
}

function ceremonyPlan(input) {
  return Object.freeze({
    schema_version: 1, object_kind: "custody_ceremony_plan", ceremony_kind: input.kind, ceremony_id: input.ceremonyId,
    project_id: ids.project, person_id: ids.person, device_id: input.deviceId, lost_device_id: input.lostDeviceId,
    access_scope_id: ids.scope, vault_generation: 0n, signing_key_id: input.signingKeyId, recipient_key_id: input.recipientKeyId,
    root_key_id: ids.rootKey, root_generation: 0n, key_epoch_id: input.epochId, expected_previous_control_head_id: input.previous
  });
}

function rootProvider() { return new OfflineProjectRootProvider({ random: new WebCryptoRandomSource(), worker_factory: () => new InlineWorker() }); }
function rootCapability() { return { scope: "root_ceremony_only", person_id: ids.person }; }
function recoveryCapability() { return { scope: "recovery_ceremony_only", person_id: ids.person }; }

class InlineWorker {
  static terminations = 0;
  #listeners = { message: new Set(), error: new Set() };
  addEventListener(type, listener) { this.#listeners[type].add(listener); }
  removeEventListener(type, listener) { this.#listeners[type].delete(listener); }
  postMessage(request) {
    void performRootRecoveryWorkerOperation(request).then(
      (data) => { for (const listener of this.#listeners.message) listener({ data }); },
      (error) => { for (const listener of this.#listeners.error) listener({ error }); }
    );
  }
  terminate() { InlineWorker.terminations += 1; }
}

class HangingWorker {
  static terminations = 0;
  static posts = 0;
  #listeners = { message: new Set(), error: new Set() };
  addEventListener(type, listener) { this.#listeners[type].add(listener); }
  removeEventListener(type, listener) { this.#listeners[type].delete(listener); }
  postMessage() { HangingWorker.posts += 1; }
  terminate() { HangingWorker.terminations += 1; }
}

class DeterministicCeremonyRoot {
  #kit;
  #rootPublic;
  #kitDigest;
  constructor({ kit, rootPublic, kitDigest }) { this.#kit = Uint8Array.from(kit); this.#rootPublic = Uint8Array.from(rootPublic); this.#kitDigest = Uint8Array.from(kitDigest); }
  async create(input) { return { project_id: input.project_id, root_key_id: input.root_key_id, root_generation: input.root_generation, root_public_key_bytes: Uint8Array.from(this.#rootPublic), recovery_kit_bytes: Uint8Array.from(this.#kit) }; }
  async verify(input) { return { status: "verified", binding: { project_id: input.project_id, root_key_id: input.root_key_id, root_generation: 0n, root_public_key_bytes: Uint8Array.from(this.#rootPublic), kit_sha256: Uint8Array.from(this.#kitDigest), verification_signature: new Uint8Array(64) } }; }
  async signAuthority(input) { return { status: "signed", project_id: input.preimage.project_id, root_key_id: input.preimage.root_key_id, purpose: input.preimage.purpose, signature_bytes: new Uint8Array(64) }; }
}

class ScriptedRandom {
  #values;
  constructor(values) { this.#values = values.map((value) => Uint8Array.from(value)); }
  get remaining() { return this.#values.length; }
  async randomBytes(length) { const value = this.#values.shift(); if (!value || value.length !== length) throw new Error("Unexpected random request"); return Uint8Array.from(value); }
}

class MemoryRecoveryKitSink {
  #values = new Map();
  async write(id, bytes) { this.#values.set(id, Uint8Array.from(bytes)); }
  async read(id) { const value = this.#values.get(id); return value ? Uint8Array.from(value) : null; }
}

class PermissionFailingRecoveryKitSink {
  #mode;
  #value = null;
  #reads = 0;
  constructor(mode) { this.#mode = mode; }
  async write(_id, bytes) {
    if (this.#mode === "write") throw Object.assign(new Error("recovery kit permission denied"), { name: "NotAllowedError" });
    this.#value = Uint8Array.from(bytes);
  }
  async read() {
    this.#reads += 1;
    if (this.#mode === "reopen" && this.#reads > 1) throw Object.assign(new Error("recovery kit reopen permission denied"), { name: "NotAllowedError" });
    return this.#value ? Uint8Array.from(this.#value) : null;
  }
}

class DeterministicMemoryBackend {
  records = new Map();
  async read(address) { const value = this.records.get(address); return value === undefined ? null : Uint8Array.from(value); }
  async write(address, bytes) { this.records.set(address, Uint8Array.from(bytes)); }
  async delete(address) { this.records.delete(address); }
  async list(prefix) { return [...this.records.keys()].filter((address) => address.startsWith(prefix)).sort(); }
}

function tamperedVault(store, mutate) {
  const reads = {
    async readVault(projectId, deviceId) {
      const record = await store.readVault(projectId, deviceId);
      return record ? mutate(record) : null;
    },
    readWrappedEpoch: (...args) => store.readWrappedEpoch(...args)
  };
  return new Hc2DeviceVaultService({ store: reads, random: new WebCryptoRandomSource() });
}

class SerialLockManager {
  #tail = Promise.resolve();
  async request(_name, _options, callback) {
    const prior = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await callback({ mode: "exclusive" }); } finally { release(); }
  }
}

function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hex(value) { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function toHex(value) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

function mutateLastByte(value) { const result = Uint8Array.from(value); result[result.length - 1] ^= 1; return result; }
function mutateScalarAfterText(value, label, replacement) {
  const result = Uint8Array.from(value);
  const index = Buffer.from(result).indexOf(Buffer.from(label));
  if (index < 0 || index + label.length >= result.length) throw new Error(`Frozen CBOR label ${label} is absent.`);
  result[index + label.length] = replacement;
  return result;
}
function replaceFirstBytes(value, target, mutate) {
  const result = Uint8Array.from(value);
  const index = Buffer.from(result).indexOf(Buffer.from(target));
  if (index < 0) throw new Error("Frozen CBOR byte sequence is absent.");
  const changed = result.subarray(index, index + target.length);
  mutate(changed);
  return result;
}
function controlClassification(state, id) { return state.control_classifications.find((entry) => entry.object_id === id)?.reason ?? null; }

await testEpochWrapping();
await testFrozenFixture();
await testVaultAndCollision();
await testOfflineRootBoundary();
await testInitialAndProfileLossCeremonies();
await testEveryCeremonyFailureCut();
testStrictPlans();

process.stdout.write(`${JSON.stringify({ assertions, root_workers_terminated: InlineWorker.terminations, status: "ok" })}\n`);

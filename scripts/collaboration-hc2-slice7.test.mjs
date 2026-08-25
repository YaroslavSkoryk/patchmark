import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeSha256Base32 } from "../lib/collaboration/base32.ts";

import {
  assembleInventoryPagesV3,
  classifySyncTransportContinuityV3,
  classifySynchronizationConvergenceV3,
  compareVerifiedInventoriesV3,
  createInventoryPagesV3,
  createSyncSessionStateV3,
  createVerifiedInventorySnapshotV3,
  deriveSyncSessionIdV3,
  deriveTransportStreamIdV3,
  deriveInventoryRootV3,
  encryptedBundlePrivacyScanV3,
  encodeEncryptedContainerRecordV3,
  identifyInventorySnapshotV3,
  inventoryDescriptorKey,
  parseInventoryDescriptorV3,
  parseInventorySnapshotCoreV3,
  planObjectRequestsV3,
  planObjectResponseV3,
  prepareEncryptedTransportBundleV3,
  openEncryptedTransportContainerV3,
  readCanonicalTransportBundleV3,
  reduceSyncSessionV3,
  writeCanonicalTransportBundleV3,
  InMemorySyncSessionJournalV3,
  HC2_SYNC_SCHEMA_VERSION,
  HC2_SYNC_TRANSPORT_PROFILE_ID,
  hc2SyncInvocationLimits
} from "../lib/collaboration/hc2/index.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { SingleShotHpkeV3Provider } from "../lib/collaboration/hc2/providers/hpke-v3-provider.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { parseTransportPayloadCoreV2 } from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import { parseTransportPayloadCoreV3 } from "../lib/collaboration/hc2/transport-v3-contracts.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";

const suffix = "a".repeat(52);
const entity = "a".repeat(26);
const validSuffix = (seed) => encodeSha256Base32(Uint8Array.from(createHash("sha256").update(seed).digest()));
const ids = Object.freeze({
  project: `pm:project:v1:${entity}`,
  control: `pm:control-event:v1:${suffix}`,
  epoch: `pm:key-epoch:v1:${entity}`,
  epochCommitment: `pm:key-epoch-commitment:v1:${suffix}`,
  projection: `pm:projection-root:v1:${suffix}`,
  checkpoint: `pm:semantic-event:v1:${suffix}`,
  semantic: `pm:semantic-event:v1:${validSuffix("semantic")}`,
  session: `pm:sync-session:v3:${suffix}`,
  stream: `pm:transport-stream:v3:${suffix}`,
  manifest: `pm:bundle-manifest:v3:${suffix}`,
  request: `pm:object-request:v3:${suffix}`,
  device: `pm:device:v1:${entity}`
});

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };

function digest(bytes) { return Uint8Array.from(createHash("sha256").update(bytes).digest()); }
function descriptor(kind, letter, family = "hc1") {
  const bytes = new TextEncoder().encode(`${family}:${kind}:${letter}`);
  const objectId = family === "hc1"
    ? `pm:${kind}:v1:${validSuffix(`${family}:${kind}:${letter}`)}`
    : `pm:transport-attachment:v2:${validSuffix(`${family}:${kind}:${letter}`)}`;
  return parseInventoryDescriptorV3({ schema_version: 3, record_kind: "inventory_descriptor_v3", authority: "none", storage_family: family, object_kind: kind, object_id: objectId, exact_sha256: digest(bytes), exact_byte_length: BigInt(bytes.length) });
}

async function snapshot(descriptors, overrides = {}) {
  const sorted = [...descriptors].sort((left, right) => inventoryDescriptorKey(left).localeCompare(inventoryDescriptorKey(right)));
  const root = await deriveInventoryRootV3(ids.project, sorted);
  const core = parseInventorySnapshotCoreV3({
    schema_version: HC2_SYNC_SCHEMA_VERSION,
    record_kind: "inventory_snapshot_core_v3",
    authority: "none",
    project_id: ids.project,
    portable_generation: 1n,
    accepted_control_head_id: ids.control,
    key_epoch_id: ids.epoch,
    key_epoch_commitment: ids.epochCommitment,
    semantic_frontier: [],
    checkpoint_id: ids.checkpoint,
    projection_root_id: ids.projection,
    descriptor_count: sorted.length,
    page_count: Math.ceil(sorted.length / hc2SyncInvocationLimits.maximum_descriptors_per_page),
    inventory_root_id: root,
    protocol_version: "hc1-v1",
    reducer_version: "reducer-v1",
    ...overrides
  });
  return Object.freeze({ snapshot_id: await identifyInventorySnapshotV3(core), core, descriptors: Object.freeze(sorted) });
}

const emptyA = await snapshot([]);
const emptyB = await snapshot([]);
equal(compareVerifiedInventoriesV3(emptyA, emptyB).common_identical.length, 0, "empty replicas compare deterministically");
equal(compareVerifiedInventoriesV3(emptyA, emptyB).status, "compatible", "empty replicas are compatible");

const blob = descriptor("markdown-blob", "b");
const revision = descriptor("document-revision", "c");
const event = descriptor("semantic-event", "d");
const attachment = descriptor("receipt_attachment", "e", "hc2_attachment");
const left = await snapshot([blob, revision]);
const right = await snapshot([revision, event, attachment]);
const comparison = compareVerifiedInventoriesV3(left, right);
equal(comparison.common_identical.map(inventoryDescriptorKey), [inventoryDescriptorKey(revision)], "common exact bytes are detected");
equal(comparison.missing_locally.map(inventoryDescriptorKey), [inventoryDescriptorKey(event), inventoryDescriptorKey(attachment)].sort(), "HC-1 and HC-2 missing records are detected");
equal(comparison.missing_remotely.map(inventoryDescriptorKey), [inventoryDescriptorKey(blob)], "two-sided missing records are detected");
equal(compareVerifiedInventoriesV3(right, left).missing_remotely.map(inventoryDescriptorKey), comparison.missing_locally.map(inventoryDescriptorKey), "comparison is symmetric");

const requestPlan = planObjectRequestsV3({ comparison, session_id: ids.session, session_generation: 0n, round_number: 1n, local_snapshot_id: left.snapshot_id, remote_snapshot_id: right.snapshot_id, maximum_items_per_request: 1, maximum_objects_per_response: 1, maximum_total_bytes: 1024n });
equal(requestPlan.status, "requests_ready", "missing records produce requests");
equal(requestPlan.requests.length, 2, "small request limits produce multiple request pages");
check(requestPlan.requests.every((request) => request.authority === "none"), "requests cannot carry authority");

const dependencyKey = inventoryDescriptorKey(revision);
const eventKey = inventoryDescriptorKey(event);
const response = planObjectResponseV3({
  request: requestPlan.requests.find((entry) => entry.items[0].object_id === event.object_id),
  offered_snapshot: right,
  current_portable_generation: right.core.portable_generation,
  dependency_closure: { [eventKey]: [dependencyKey] }
});
equal(response.status, "more_required", "dependency closure obeys a one-object request budget");
equal(response.selected.map(inventoryDescriptorKey), [dependencyKey], "dependency is selected before the requested event");
equal(planObjectResponseV3({ request: requestPlan.requests[0], offered_snapshot: right, current_portable_generation: 2n, dependency_closure: {} }).status, "stale_snapshot", "new writes after snapshot make response preparation stale");

const many = [];
for (let index = 0; index < 260; index += 1) {
  const objectId = `pm:markdown-blob:v1:${encodeSha256Base32(digest(new TextEncoder().encode(`id:${index}`)))}`;
  many.push(parseInventoryDescriptorV3({ schema_version: 3, record_kind: "inventory_descriptor_v3", authority: "none", storage_family: "hc1", object_kind: "markdown-blob", object_id: objectId, exact_sha256: digest(new TextEncoder().encode(String(index))), exact_byte_length: BigInt(index + 1) }));
}
const manySnapshot = await snapshot(many);
const pages = await createInventoryPagesV3({ snapshot: manySnapshot, session_id: ids.session, session_generation: 0n, round_number: 1n });
equal(pages.length, 3, "260 descriptors partition into deterministic bounded pages");
check(pages.every((page) => page.core.descriptor_count <= 128), "inventory page descriptor bounds hold");
const partial = await assembleInventoryPagesV3({ project_id: ids.project, snapshot_id: manySnapshot.snapshot_id, expected_root_id: manySnapshot.core.inventory_root_id, expected_descriptor_count: manySnapshot.core.descriptor_count, expected_page_count: manySnapshot.core.page_count, pages: [pages[2], pages[0]] });
equal(partial.status, "more_required", "missing reordered inventory page is retryable");
const complete = await assembleInventoryPagesV3({ project_id: ids.project, snapshot_id: manySnapshot.snapshot_id, expected_root_id: manySnapshot.core.inventory_root_id, expected_descriptor_count: manySnapshot.core.descriptor_count, expected_page_count: manySnapshot.core.page_count, pages: [pages[2], pages[0], pages[1], pages[0]] });
equal(complete.status, "complete", "reordered pages and exact replay assemble deterministically");
equal(complete.inventory_root_id, manySnapshot.core.inventory_root_id, "complete pages reproduce the frozen inventory root");

const conflictingBlob = parseInventoryDescriptorV3({ ...blob, exact_sha256: digest(new TextEncoder().encode("other")) });
const conflict = compareVerifiedInventoriesV3(await snapshot([blob]), await snapshot([conflictingBlob]));
equal(conflict.byte_conflicts.length, 1, "same identity with different bytes remains an explicit conflict");
equal(planObjectRequestsV3({ comparison: conflict, session_id: ids.session, session_generation: 0n, round_number: 1n, local_snapshot_id: left.snapshot_id, remote_snapshot_id: right.snapshot_id }).status, "conflict", "byte conflict is never converted into a transfer request");
equal(compareVerifiedInventoriesV3(left, await snapshot(left.descriptors, { accepted_control_head_id: `pm:control-event:v1:${validSuffix("other-control")}` })).status, "incompatible", "stale or forked control state is incompatible");
equal(compareVerifiedInventoriesV3(left, await snapshot(left.descriptors, { key_epoch_commitment: `pm:key-epoch-commitment:v1:${validSuffix("other-epoch")}` })).incompatibilities, ["epoch_mismatch"], "stale epoch is explicit");

let generation = 1n;
const source = {
  source_kind: "committed_portable_records",
  async readPortableGeneration() { const current = generation; generation += 1n; return current; },
  async listCommittedCandidates() { return []; },
  async readCommittedExact() { return null; },
  async verifyCommittedExact() { throw new Error("unused"); }
};
equal((await createVerifiedInventorySnapshotV3({ source, binding: emptyA.core })).status, "stale_source", "moving portable state discards a snapshot attempt");

let state = createSyncSessionStateV3(ids.session, 0n);
state = reduceSyncSessionV3(state, { kind: "record_message", evidence: { round_number: 1n, message_role: "offer", ordinal: 0, commitment: "commitment-a" } });
const replayed = reduceSyncSessionV3(state, { kind: "record_message", evidence: { round_number: 1n, message_role: "offer", ordinal: 0, commitment: "commitment-a" } });
check(replayed === state, "exact session message replay is idempotent");
equal(reduceSyncSessionV3(state, { kind: "record_message", evidence: { round_number: 1n, message_role: "offer", ordinal: 0, commitment: "commitment-b" } }).phase, "forked", "same session slot with different bytes is a fork");
state = reduceSyncSessionV3(state, { kind: "progress", pages: 4, objects: 64, bytes_read: 1n, bytes_written: 1n });
equal(reduceSyncSessionV3(state, { kind: "progress", pages: 1, objects: 0, bytes_read: 0n, bytes_written: 0n }).phase, "more_required", "explicit progress exhaustion returns more_required");

equal(classifySyncTransportContinuityV3({ head: null, session_id: ids.session, session_generation: 0n, stream_id: ids.stream, stream_generation: 0n, bundle_sequence: 2n, previous_manifest_id: ids.manifest, manifest_id: ids.manifest, session_status: "active" }).status, "retryable_gap", "future genesis sequence is a retryable gap");
const head = { stream_id: ids.stream, stream_generation: 0n, session_id: ids.session, session_generation: 0n, bundle_sequence: 0n, manifest_id: ids.manifest };
equal(classifySyncTransportContinuityV3({ head, session_id: ids.session, session_generation: 0n, stream_id: ids.stream, stream_generation: 0n, bundle_sequence: 0n, previous_manifest_id: null, manifest_id: ids.manifest, session_status: "active" }).status, "duplicate", "exact stream replay is idempotent");
equal(classifySyncTransportContinuityV3({ head, session_id: ids.session, session_generation: 0n, stream_id: ids.stream, stream_generation: 0n, bundle_sequence: 0n, previous_manifest_id: null, manifest_id: `pm:bundle-manifest:v3:${validSuffix("other-manifest")}`, session_status: "active" }).status, "stream_fork", "same stream position with another commitment is a fork");
equal(classifySyncTransportContinuityV3({ head, session_id: ids.session, session_generation: 0n, stream_id: ids.stream, stream_generation: 0n, bundle_sequence: 1n, previous_manifest_id: ids.manifest, manifest_id: `pm:bundle-manifest:v3:${validSuffix("other-manifest")}`, session_status: "abandoned" }).status, "abandoned_session", "abandoned session messages are rejected");

const commitments = Object.freeze({
  accepted_object_set_commitment: `pm:accepted-object-set:v3:${suffix}`,
  semantic_frontier: [], accepted_semantic_set_commitment: `pm:semantic-set:v3:${suffix}`,
  accepted_control_set_commitment: `pm:control-set:v3:${suffix}`, accepted_control_head_id: ids.control,
  authority_state_commitment: `pm:authority-state:v3:${suffix}`, key_epoch_id: ids.epoch,
  key_epoch_commitment: ids.epochCommitment, canonical_projection_commitment: `pm:canonical-projection:v3:${suffix}`,
  revision_heads_root_id: `pm:revision-heads-root:v1:${suffix}`, conflict_root_id: `pm:conflict-set-root:v1:${suffix}`,
  tombstone_root_id: `pm:tombstone-root:v3:${suffix}`, reducer_rejection_root_id: `pm:reducer-rejection-root:v3:${suffix}`,
  component_roots_commitment: `pm:component-roots:v3:${suffix}`, projection_root_id: ids.projection,
  checkpoint_id: ids.checkpoint, shared_state_commitment: `pm:shared-state:v3:${suffix}`,
  acknowledgement_receipt_commitment: `pm:ack-receipt:v3:${suffix}`, protocol_version: "hc1-v1", reducer_version: "reducer-v1"
});
const confirmation = { schema_version: 3, record_kind: "sync_confirmation_core_v3", authority: "none", session_id: ids.session, session_generation: 0n, round_number: 3n, inventory_snapshot_id: left.snapshot_id, inventory_root_id: left.core.inventory_root_id, inventory_descriptor_count: left.core.descriptor_count, reconstruction: commitments };
equal(classifySynchronizationConvergenceV3(confirmation, structuredClone(confirmation)).status, "converged", "identical inventory and reconstruction converge");
equal(classifySynchronizationConvergenceV3(confirmation, { ...confirmation, reconstruction: { ...commitments, acknowledgement_receipt_commitment: `pm:ack-receipt:v3:${validSuffix("other-ack")}` } }).status, "more_required", "equal inventory with divergent reconstruction does not converge");

const journal = new InMemorySyncSessionJournalV3();
const durable = { revision: 0n, session_id: ids.session, project_id: ids.project, peer_device_id: ids.device, accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, state, bundles: [{ direction: "sent", round_number: 1n, message_role: "offer", bundle_commitment: "commitment-a", exact_bundle_bytes: Uint8Array.of(1, 2, 3), durable_reference: null }], transport_high_water: [{ direction: "sent", stream_id: ids.stream, stream_generation: 0n, bundle_sequence: 0n, manifest_id: ids.manifest }] };
equal((await journal.compareAndSwap({ expected_revision: null, record: durable })).status, "committed", "device-private session journal commits with CAS");
const reopened = await journal.read(ids.session);
reopened.bundles[0].exact_bundle_bytes[0] = 9;
equal((await journal.read(ids.session)).bundles[0].exact_bundle_bytes[0], 1, "journal resume bytes are immutable copies");
equal((await journal.read(ids.session)).transport_high_water[0].manifest_id, ids.manifest, "journal persists exact transport high-water evidence");
equal((await journal.compareAndSwap({ expected_revision: null, record: durable })).status, "conflict", "stale session CAS cannot overwrite durable progress");

const entityId = (kind, fill) => `pm:${kind}:v1:${fill.repeat(25)}a`;
const cryptoIds = Object.freeze({
  senderPerson: entityId("person", "b"), senderMembership: entityId("membership", "c"),
  senderDevice: entityId("device", "d"), senderSigning: entityId("public-key", "e"),
  recipientPerson: entityId("person", "f"), recipientMembership: entityId("membership", "g"),
  recipientDevice: entityId("device", "h"), recipientKey: entityId("public-key", "j")
});
const registry = new Hc2NativeKeyRegistry(crypto.subtle);
const signing = await registry.generateDeviceSigningKey(cryptoIds.senderSigning);
const recipient = await registry.generateRecipientKeyPair(cryptoIds.recipientKey);
const sessionId = await deriveSyncSessionIdV3({ project_id: ids.project, initiator_device_id: cryptoIds.senderDevice, responder_device_id: cryptoIds.recipientDevice, session_generation: 0n });
const streamId = await deriveTransportStreamIdV3({ project_id: ids.project, sender_device_id: cryptoIds.senderDevice, recipient_device_id: cryptoIds.recipientDevice, session_id: sessionId, stream_generation: 0n });
const offerCore = Object.freeze({
  schema_version: 3, record_kind: "sync_offer_core_v3", authority: "none", session_id: sessionId,
  session_generation: 0n, round_number: 1n, inventory_snapshot_id: left.snapshot_id,
  inventory_root_id: left.core.inventory_root_id, descriptor_count: left.core.descriptor_count,
  page_count: left.core.page_count, accepted_control_head_id: ids.control, key_epoch_id: ids.epoch,
  key_epoch_commitment: ids.epochCommitment, semantic_frontier: [], checkpoint_id: ids.checkpoint,
  projection_root_id: ids.projection, supported_transport_versions: [3],
  crypto_suite_id: HC2_CRYPTO_SUITE_ID, limit_profile_id: HC2_LIMIT_PROFILE_ID,
  maximum_session_rounds: hc2SyncInvocationLimits.maximum_session_rounds
});
const commonBinding = Object.freeze({
  transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID, project_id: ids.project, purpose: "synchronization",
  sender_person_id: cryptoIds.senderPerson, sender_membership_id: cryptoIds.senderMembership,
  sender_device_id: cryptoIds.senderDevice, sender_signing_key_id: cryptoIds.senderSigning,
  recipient_person_id: cryptoIds.recipientPerson, recipient_membership_id: cryptoIds.recipientMembership,
  recipient_device_id: cryptoIds.recipientDevice, recipient_key_id: cryptoIds.recipientKey,
  accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment,
  stream_id: streamId, stream_generation: 0n, bundle_sequence: 0n, previous_bundle_manifest_id: null,
  session_id: sessionId, session_generation: 0n, round_number: 1n, message_kind: "offer",
  message_direction: "initiator_to_responder", payload_count: 2,
  limit_profile_id: HC2_LIMIT_PROFILE_ID, crypto_suite_id: HC2_CRYPTO_SUITE_ID
});
const signatures = {
  async sign(preimage) { return new Uint8Array(await crypto.subtle.sign("Ed25519", registry.resolveSigningKey(signing.handle), preimage)); },
  async verify({ preimage, signature_bytes }) {
    const decoded = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: signing.public_key, expected_algorithm: "ed25519" });
    return crypto.subtle.verify("Ed25519", decoded.public_key, signature_bytes, preimage);
  }
};
let randomCalls = 0;
const hpke = new SingleShotHpkeV3Provider({ keys: registry });
const preparedResult = await prepareEncryptedTransportBundleV3({
  common_binding: commonBinding,
  non_manifest_payloads: [{ schema_version: 3, payload_kind: "sync_offer", offer_core: offerCore }],
  recipient_public_key: recipient.public_key,
  authority: { async verify() { return { status: "accepted", epoch_key_available: true }; } },
  random: { async randomBytes(length) { randomCalls += 1; return crypto.getRandomValues(new Uint8Array(length)); } },
  signatures, hpke
});
equal(preparedResult.status, "prepared", "accepted authority prepares a V3 encrypted offer");
const prepared = preparedResult.bundle;
equal(randomCalls, 1, "one explicit V3 bundle consumes one envelope identity random value");
equal(hpke.evidence().sender_contexts_created, 2, "each V3 container consumes a fresh HPKE sender context");
for (const container of prepared.containers) {
  const opened = await openEncryptedTransportContainerV3({ container, recipient_key_pair: recipient, signatures, hpke });
  equal(opened.status, "opened", "real HPKE and Ed25519 open each V3 container");
}
equal(hpke.evidence().recipient_contexts_created, 2, "each V3 container consumes a fresh HPKE recipient context");
encryptedBundlePrivacyScanV3(prepared.containers, [ids.project, cryptoIds.senderDevice, cryptoIds.recipientDevice, sessionId, left.snapshot_id, inventoryDescriptorKey(blob)]);
assertions += 1;

const chunks = [];
const shaFactory = () => {
  const hash = createHash("sha256");
  return { update(bytes) { hash.update(bytes); }, digest() { return Uint8Array.from(hash.digest()); } };
};
const writtenV3 = await writeCanonicalTransportBundleV3({ containers: prepared.containers, sha256: shaFactory(), sink: { async write(bytes) { chunks.push(Uint8Array.from(bytes)); }, async close() {}, async abort(reason) { throw reason; } } });
const fileBytes = Uint8Array.from(Buffer.concat(chunks.map((entry) => Buffer.from(entry))));
let readContainers = 0;
const readV3 = await readCanonicalTransportBundleV3({
  source: { async *chunks() { for (let offset = 0; offset < fileBytes.length; offset += 7) yield fileBytes.slice(offset, offset + 7); } },
  sha256: shaFactory(),
  async on_container(container, exact) { equal(container.container_id, prepared.containers[readContainers].container_id, "incremental reader preserves V3 container order"); equal(Buffer.from(exact).toString("hex"), Buffer.from(encodeEncryptedContainerRecordV3(container)).toString("hex"), "incremental reader preserves exact V3 bytes"); readContainers += 1; }
});
equal(readV3.byte_length, writtenV3.byte_length, "incremental V3 read/write byte evidence agrees");
equal(Buffer.from(readV3.sha256).toString("hex"), Buffer.from(writtenV3.sha256).toString("hex"), "incremental V3 read/write digest evidence agrees");

const zeroEvidence = { random: 0, sign: 0, hpke: 0 };
const rejected = await prepareEncryptedTransportBundleV3({
  common_binding: commonBinding,
  non_manifest_payloads: [{ schema_version: 3, payload_kind: "sync_offer", offer_core: offerCore }],
  recipient_public_key: recipient.public_key,
  authority: { async verify() { return { status: "revoked", reason: "peer_revoked_at_current_control_head" }; } },
  random: { async randomBytes() { zeroEvidence.random += 1; throw new Error("must not run"); } },
  signatures: { async sign() { zeroEvidence.sign += 1; throw new Error("must not run"); }, async verify() { return false; } },
  hpke: { async sealBound() { zeroEvidence.hpke += 1; throw new Error("must not run"); }, async openBound() { throw new Error("unused"); } }
});
equal(rejected.status, "revoked", "mid-session revocation stops export with a typed result");
equal(zeroEvidence, { random: 0, sign: 0, hpke: 0 }, "revocation is rejected before random, signing, or HPKE calls");

assert.throws(() => parseTransportPayloadCoreV2({ schema_version: 2, payload_kind: "sync_offer", offer_core: offerCore }), /unsupported|unexpected/i);
assertions += 1;
assert.throws(() => parseTransportPayloadCoreV3({ schema_version: 2, payload_kind: "sync_offer", offer_core: offerCore }), /must be 3/i);
assertions += 1;

console.log(`HC-2 Slice 7 planner/runtime: ${assertions} assertions passed.`);

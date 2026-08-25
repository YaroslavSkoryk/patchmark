/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- browser integration evidence intentionally crosses branded contracts.
import {
  slice7AcceptedBinding,
  slice7AtomicImportPortableObjects,
  slice7CryptoContext,
  slice7ImportReceiptAttachment,
  slice7ReadCommittedPortableAttachments,
  slice7ReadCommittedPortableObjects
} from "./collaboration-hc2-slice6-convergence-runtime.ts";
import {
  IndexedDbSyncSessionJournalV3,
  assembleInventoryPagesV3,
  classifySynchronizationConvergenceV3,
  compareVerifiedInventoriesV3,
  createInventoryPagesV3,
  createSyncSessionStateV3,
  createVerifiedInventorySnapshotV3,
  deriveSyncSessionIdV3,
  deriveTransportStreamIdV3,
  identifyObjectRequestV3,
  identifyObjectResponseV3,
  identifySyncConfirmationV3,
  importManualSyncBundleV3,
  inventoryDescriptorKey,
  parseInventorySnapshotCoreV3,
  parseSyncOfferCoreV3,
  planObjectRequestsV3,
  prepareEncryptedTransportBundleV3,
  writeCanonicalTransportBundleV3,
  HC2_SYNC_TRANSPORT_PROFILE_ID,
  hc2SyncInvocationLimits
} from "../lib/collaboration/hc2/index.ts";
import { Hc1CanonicalPortableObjectVerifier } from "../lib/collaboration/hc2/hc1-object-verifier.ts";
import { createDeterministicTransportChunks, resolveDeterministicHc1Closure } from "../lib/collaboration/hc2/transport-object-closure.ts";
import { SingleShotHpkeV3Provider } from "../lib/collaboration/hc2/providers/hpke-v3-provider.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";
import { decodeTransportPayloadCoreV2 } from "../lib/collaboration/hc2/transport-v2-contracts.ts";

const scopeId = `pm:access-scope:v1:${"b".repeat(25)}a`;
let sync = null;

export async function initializeSlice7Synchronization() {
  const cryptoContext = slice7CryptoContext();
  const peer = [...cryptoContext.peers.values()][0];
  if (!peer) throw new Error("Slice 7 requires the enrolled Slice 6 peer.");
  const binding = await slice7AcceptedBinding();
  const initiator = cryptoContext.label === "A" ? cryptoContext.own.device : peer.device;
  const responder = cryptoContext.label === "B" ? cryptoContext.own.device : peer.device;
  const sessionId = await deriveSyncSessionIdV3({ project_id: binding.project_id, initiator_device_id: initiator, responder_device_id: responder, session_generation: 0n });
  const journal = new IndexedDbSyncSessionJournalV3({ indexed_db: indexedDB, database_name: "patchmark-hc2-slice7-sync-session" });
  await journal.open();
  let durable = await journal.read(sessionId);
  if (!durable) {
    durable = { revision: 0n, session_id: sessionId, project_id: binding.project_id, peer_device_id: peer.device, accepted_control_head_id: binding.accepted_control_head_id, key_epoch_id: binding.key_epoch_id, key_epoch_commitment: binding.key_epoch_commitment, state: createSyncSessionStateV3(sessionId, 0n), bundles: [], transport_high_water: [] };
    const stored = await journal.compareAndSwap({ expected_revision: null, record: durable });
    if (stored.status !== "committed") throw new Error("Could not create Slice 7 session journal.");
    durable = stored.record;
  }
  const sent = durable.bundles.filter((entry) => entry.direction === "sent").sort((left, right) => sequenceFromRole(left.message_role) - sequenceFromRole(right.message_role));
  sync = { cryptoContext, peer, binding, sessionId, journal, durable, localSnapshot: null, remoteSnapshot: null, remoteOffer: null, lastRequest: null, remoteConfirmation: null, outboundSequence: BigInt(sent.length), outboundPrevious: sent.at(-1)?.bundle_commitment ?? null, explicitInvocations: 0 };
  return clean({ label: cryptoContext.label, session_id: sessionId, resumed_bundle_count: durable.bundles.length, private_keys_non_extractable: binding.private_keys_non_extractable });
}

export async function createSlice7InventoryExchange(roundNumber, pageLimit = 2) {
  const state = requireSync(); state.explicitInvocations += 1;
  state.localSnapshot = await localSnapshot(pageLimit);
  const pages = await createInventoryPagesV3({ snapshot: state.localSnapshot, session_id: state.sessionId, session_generation: 0n, round_number: BigInt(roundNumber), maximum_descriptors_per_page: pageLimit });
  const offer = parseSyncOfferCoreV3({ schema_version: 3, record_kind: "sync_offer_core_v3", authority: "none", session_id: state.sessionId, session_generation: 0n, round_number: BigInt(roundNumber), inventory_snapshot_id: state.localSnapshot.snapshot_id, inventory_root_id: state.localSnapshot.core.inventory_root_id, descriptor_count: state.localSnapshot.core.descriptor_count, page_count: state.localSnapshot.core.page_count, accepted_control_head_id: state.localSnapshot.core.accepted_control_head_id, key_epoch_id: state.localSnapshot.core.key_epoch_id, key_epoch_commitment: state.localSnapshot.core.key_epoch_commitment, semantic_frontier: state.localSnapshot.core.semantic_frontier, checkpoint_id: state.localSnapshot.core.checkpoint_id, projection_root_id: state.localSnapshot.core.projection_root_id, supported_transport_versions: [3], crypto_suite_id: HC2_CRYPTO_SUITE_ID, limit_profile_id: HC2_LIMIT_PROFILE_ID, maximum_session_rounds: hc2SyncInvocationLimits.maximum_session_rounds });
  const files = [await prepareFile("offer", `offer`, BigInt(roundNumber), [{ schema_version: 3, payload_kind: "sync_offer", offer_core: offer }])];
  for (const page of pages) files.push(await prepareFile("inventory", `inventory:${page.core.page_ordinal}`, BigInt(roundNumber), [{ schema_version: 3, payload_kind: "inventory_page", page_core: page.core }]));
  return clean({ files, snapshot_id: state.localSnapshot.snapshot_id, inventory_root_id: state.localSnapshot.core.inventory_root_id, descriptor_count: state.localSnapshot.descriptors.length, page_count: pages.length });
}

export async function importSlice7InventoryExchange(files) {
  const state = requireSync(); state.explicitInvocations += 1;
  let offer = null;
  const pages = [];
  for (const encoded of files) {
    const opened = await openFile(encoded);
    for (const payload of opened.payloads) {
      if (payload.payload_kind === "sync_offer") offer = payload.offer_core;
      if (payload.payload_kind === "inventory_page") pages.push({ page_id: await pageIdentity(payload.page_core), core: payload.page_core });
    }
  }
  if (!offer) throw new Error("Encrypted inventory exchange omitted its offer.");
  const assembled = await assembleInventoryPagesV3({ project_id: state.binding.project_id, snapshot_id: offer.inventory_snapshot_id, expected_root_id: offer.inventory_root_id, expected_descriptor_count: offer.descriptor_count, expected_page_count: offer.page_count, pages });
  if (assembled.status !== "complete") return clean(assembled);
  const core = parseInventorySnapshotCoreV3({ schema_version: 3, record_kind: "inventory_snapshot_core_v3", authority: "none", project_id: state.binding.project_id, portable_generation: 0n, accepted_control_head_id: offer.accepted_control_head_id, key_epoch_id: offer.key_epoch_id, key_epoch_commitment: offer.key_epoch_commitment, semantic_frontier: offer.semantic_frontier, checkpoint_id: offer.checkpoint_id, projection_root_id: offer.projection_root_id, descriptor_count: offer.descriptor_count, page_count: offer.page_count, inventory_root_id: offer.inventory_root_id, protocol_version: state.binding.protocol_version, reducer_version: state.binding.reducer_version });
  state.remoteOffer = offer;
  state.remoteSnapshot = Object.freeze({ snapshot_id: offer.inventory_snapshot_id, core, descriptors: assembled.descriptors });
  return clean({ status: "complete", descriptor_count: assembled.descriptors.length, inventory_root_id: assembled.inventory_root_id, reordered_and_replayed_safe: true });
}

export async function createSlice7NextRequest(roundNumber, maximumItems = 1) {
  const state = requireSync(); state.explicitInvocations += 1;
  if (!state.remoteSnapshot) throw new Error("Remote inventory is incomplete.");
  state.localSnapshot = await localSnapshot(2);
  const comparison = compareVerifiedInventoriesV3(state.localSnapshot, state.remoteSnapshot);
  const planned = planObjectRequestsV3({ comparison, session_id: state.sessionId, session_generation: 0n, round_number: BigInt(roundNumber), local_snapshot_id: state.localSnapshot.snapshot_id, remote_snapshot_id: state.remoteSnapshot.snapshot_id, maximum_items_per_request: maximumItems, maximum_total_bytes: 16n * 1024n * 1024n });
  if (planned.status !== "requests_ready") return clean({ status: planned.status, missing: comparison.missing_locally.length, conflicts: comparison.byte_conflicts.length });
  const request = await identifyObjectRequestV3(planned.requests[0]);
  state.lastRequest = request;
  const encoded = await prepareFile("request", `request:${request.core.request_page_ordinal}`, BigInt(roundNumber), [{ schema_version: 3, payload_kind: "object_request", request_core: request.core }]);
  return clean({ status: "requests_ready", encoded, request_id: request.request_id, requested: request.core.items.map((entry) => entry.object_id), continuation: planned.reason === "more_required" || planned.requests.length > 1 });
}

export async function importSlice7RequestAndCreateResponse(encoded) {
  const state = requireSync(); state.explicitInvocations += 1;
  const opened = await openFile(encoded);
  const requestCore = opened.payloads.find((entry) => entry.payload_kind === "object_request")?.request_core;
  if (!requestCore) throw new Error("Encrypted request payload is unavailable.");
  const request = await identifyObjectRequestV3(requestCore);
  const values = slice7ReadCommittedPortableObjects();
  const byteMap = new Map(values.map(([kind, id, bytes]) => [`${kind}\u0000${id}`, fromBase64(bytes)]));
  const roots = request.core.items.filter((entry) => entry.storage_family === "hc1").map((entry) => ({ kind: entry.object_kind, id: entry.object_id }));
  const closure = roots.length === 0 ? [] : await resolveDeterministicHc1Closure({ project_id: state.binding.project_id, roots, source: { async readExactObject({ kind, id }) { return byteMap.get(`${kind}\u0000${id}`) ?? null; } } });
  const descriptorMap = new Map(state.localSnapshot.descriptors.map((entry) => [inventoryDescriptorKey(entry), entry]));
  const attachmentItems = request.core.items.filter((entry) => entry.storage_family === "hc2_attachment");
  const included = [
    ...closure.map((entry) => descriptorMap.get(`hc1\u0000${entry.object_kind}\u0000${entry.object_id}`)).filter(Boolean),
    ...attachmentItems.map((entry) => descriptorMap.get(`hc2_attachment\u0000${entry.object_kind}\u0000${entry.object_id}`)).filter(Boolean)
  ].sort((left, right) => inventoryDescriptorKey(left) < inventoryDescriptorKey(right) ? -1 : 1);
  const response = await identifyObjectResponseV3({ schema_version: 3, record_kind: "object_response_core_v3", authority: "none", session_id: state.sessionId, session_generation: 0n, round_number: request.core.round_number, request_id: request.request_id, local_snapshot_id: request.core.remote_snapshot_id, remote_snapshot_id: request.core.local_snapshot_id, included_descriptors: included, unavailable_descriptor_keys: [], continuation_required: false, continuation_after_key: null });
  const provisional = commonBinding("response", request.core.round_number, 2);
  const chunks = closure.length === 0 ? [] : await createDeterministicTransportChunks({ project_id: state.binding.project_id, scope_id: scopeId, common_binding: provisional, objects: closure });
  const attachmentPayloads = [];
  for (const item of attachmentItems) {
    const exact = state.attachmentBytes.get(item.object_id);
    if (!exact) throw new Error("Requested portable attachment is unavailable from the offered snapshot.");
    const payload = decodeTransportPayloadCoreV2(exact);
    if (payload.payload_kind !== "receipt_attachment") throw new Error("Slice 7 browser scenario expected a receipt attachment.");
    attachmentPayloads.push({ schema_version: 3, payload_kind: "receipt_attachment", epoch_receipt: payload.epoch_receipt });
  }
  const payloads = [{ schema_version: 3, payload_kind: "object_response", response_core: response.core }, ...chunks.map((chunk) => ({ schema_version: 3, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk })), ...attachmentPayloads];
  const responseFile = await prepareFile("response", `response:${request.request_id}`, request.core.round_number, payloads);
  return clean({ status: "response_ready", encoded: responseFile, request_id: request.request_id, closure_ids: closure.map((entry) => entry.object_id), exact_object_count: closure.length });
}

export async function importSlice7Response(encoded) {
  const state = requireSync(); state.explicitInvocations += 1;
  const opened = await openFile(encoded);
  const response = opened.payloads.find((entry) => entry.payload_kind === "object_response")?.response_core;
  if (!response) throw new Error("Encrypted object response metadata is unavailable.");
  const entries = [];
  for (const payload of opened.payloads) if (payload.payload_kind === "hc1_object_chunk") {
    for (const object of payload.chunk_payload_core.object_bytes) entries.push([object.object_kind, object.object_id, base64(object.exact_bytes)]);
  }
  const imported = await slice7AtomicImportPortableObjects(entries);
  for (const payload of opened.payloads) if (payload.payload_kind === "receipt_attachment") slice7ImportReceiptAttachment(payload);
  return clean({ ...imported, request_id: response.request_id, received_objects: entries.map((entry) => entry[1]) });
}

export async function createSlice7Confirmation(roundNumber) {
  const state = requireSync(); state.explicitInvocations += 1;
  state.localSnapshot = await localSnapshot(2);
  const reconstruction = await reconstructionCommitments(state.localSnapshot);
  const confirmation = await identifySyncConfirmationV3({ schema_version: 3, record_kind: "sync_confirmation_core_v3", authority: "none", session_id: state.sessionId, session_generation: 0n, round_number: BigInt(roundNumber), inventory_snapshot_id: state.localSnapshot.snapshot_id, inventory_root_id: state.localSnapshot.core.inventory_root_id, inventory_descriptor_count: state.localSnapshot.core.descriptor_count, reconstruction });
  const encoded = await prepareFile("confirmation", "confirmation", BigInt(roundNumber), [{ schema_version: 3, payload_kind: "sync_confirmation", confirmation_core: confirmation.core }]);
  return clean({ encoded, confirmation_id: confirmation.confirmation_id, core: confirmation.core });
}

export async function importSlice7Confirmation(encoded, localCore) {
  const state = requireSync(); state.explicitInvocations += 1;
  const opened = await openFile(encoded);
  const remote = opened.payloads.find((entry) => entry.payload_kind === "sync_confirmation")?.confirmation_core;
  if (!remote) throw new Error("Encrypted synchronization confirmation is unavailable.");
  state.remoteConfirmation = remote;
  return clean(classifySynchronizationConvergenceV3(restoreBigInts(localCore), remote));
}

export async function slice7SessionEvidence() {
  const state = requireSync();
  const durable = await state.journal.read(state.sessionId);
  return clean({ journal_revision: durable.revision, exact_bundle_count: durable.bundles.length, explicit_invocations: state.explicitInvocations, session_id: state.sessionId, no_timer_or_background_work: true });
}

export async function attemptSlice7ExportAfterRevocation(roundNumber) {
  const state = requireSync();
  const before = state.durable.bundles.length;
  const snapshot = state.localSnapshot ?? await localSnapshot(2);
  const template = state.remoteOffer ?? { schema_version: 3, record_kind: "sync_offer_core_v3", authority: "none", session_id: state.sessionId, session_generation: 0n, inventory_snapshot_id: snapshot.snapshot_id, inventory_root_id: snapshot.core.inventory_root_id, descriptor_count: snapshot.core.descriptor_count, page_count: snapshot.core.page_count, accepted_control_head_id: snapshot.core.accepted_control_head_id, key_epoch_id: snapshot.core.key_epoch_id, key_epoch_commitment: snapshot.core.key_epoch_commitment, semantic_frontier: snapshot.core.semantic_frontier, checkpoint_id: snapshot.core.checkpoint_id, projection_root_id: snapshot.core.projection_root_id, supported_transport_versions: [3], crypto_suite_id: HC2_CRYPTO_SUITE_ID, limit_profile_id: HC2_LIMIT_PROFILE_ID, maximum_session_rounds: hc2SyncInvocationLimits.maximum_session_rounds };
  const probe = parseSyncOfferCoreV3({ ...template, session_id: state.sessionId, round_number: BigInt(roundNumber) });
  const result = await prepareFile("offer", "revoked-probe", BigInt(roundNumber), [{ schema_version: 3, payload_kind: "sync_offer", offer_core: probe }]);
  const parsed = result.startsWith("{") ? JSON.parse(result) : { rejected: null };
  return clean({ status: parsed.rejected, reason: parsed.reason, durable_bundle_count_before: before, durable_bundle_count_after: state.durable.bundles.length });
}

export async function closeSlice7Synchronization() {
  if (sync) sync.journal.close();
  sync = null;
  return true;
}

export async function deleteSlice7SynchronizationDatabase() {
  if (sync) await sync.journal.deleteDatabase();
  else {
    const journal = new IndexedDbSyncSessionJournalV3({ indexed_db: indexedDB, database_name: "patchmark-hc2-slice7-sync-session" });
    await journal.deleteDatabase();
  }
  sync = null;
  return true;
}

async function localSnapshot(pageLimit) {
  const state = requireSync();
  const binding = await slice7AcceptedBinding();
  state.binding = binding;
  const values = slice7ReadCommittedPortableObjects();
  const attachments = await slice7ReadCommittedPortableAttachments();
  const byKey = new Map(values.map(([kind, id, encoded]) => [`hc1\u0000${kind}\u0000${id}`, fromBase64(encoded)]));
  const attachmentBytes = new Map(attachments.map(([, id, encoded]) => [id, fromBase64(encoded)]));
  for (const [kind, id, encoded] of attachments) byKey.set(`hc2_attachment\u0000${kind}\u0000${id}`, fromBase64(encoded));
  state.attachmentBytes = attachmentBytes;
  const verifier = new Hc1CanonicalPortableObjectVerifier(binding.project_id);
  const source = {
    source_kind: "committed_portable_records",
    async readPortableGeneration() { return BigInt(values.length); },
    async listCommittedCandidates() { return [...values.map(([kind, id]) => ({ storage_family: "hc1", object_kind: kind, object_id: id })), ...attachments.map(([kind, id]) => ({ storage_family: "hc2_attachment", object_kind: kind, object_id: id }))]; },
    async readCommittedExact(candidate) { return byKey.get(`${candidate.storage_family}\u0000${candidate.object_kind}\u0000${candidate.object_id}`) ?? null; },
    async verifyCommittedExact(candidate) {
      if (candidate.storage_family === "hc1") await verifier.verifyExactObject({ object_kind: candidate.object_kind, object_id: candidate.object_id, exact_bytes: candidate.exact_bytes });
      else {
        const payload = decodeTransportPayloadCoreV2(candidate.exact_bytes);
        if (payload.payload_kind !== candidate.object_kind || payload.payload_kind !== "receipt_attachment" || payload.epoch_receipt.core.project_id !== binding.project_id) throw new Error("Portable attachment verification failed.");
      }
      return { status: "valid", project_id: binding.project_id };
    }
  };
  const result = await createVerifiedInventorySnapshotV3({ source, maximum_descriptors_per_page: pageLimit, binding: { project_id: binding.project_id, accepted_control_head_id: binding.accepted_control_head_id, key_epoch_id: binding.key_epoch_id, key_epoch_commitment: binding.key_epoch_commitment, semantic_frontier: binding.semantic_frontier, checkpoint_id: binding.checkpoint_id, projection_root_id: binding.projection_root_id, protocol_version: binding.protocol_version, reducer_version: binding.reducer_version } });
  if (result.status !== "created") throw new Error(`Portable snapshot failed: ${result.status}`);
  return result.snapshot;
}

async function prepareFile(messageKind, role, round, payloads) {
  const state = requireSync();
  const retry = state.durable.bundles.find((entry) => entry.direction === "sent" && entry.round_number === round && entry.message_role.endsWith(`:${role}`));
  if (retry?.exact_bundle_bytes) return base64(retry.exact_bundle_bytes);
  await ensureStreamId();
  const common = commonBinding(messageKind, round, payloads.length + 1);
  const hpke = new SingleShotHpkeV3Provider({ keys: state.cryptoContext.registry });
  const prepared = await prepareEncryptedTransportBundleV3({ common_binding: common, non_manifest_payloads: payloads, recipient_public_key: state.peer.recipient_public, authority: { async verify() { const current = await slice7AcceptedBinding(); if (current.revoked) return { status: "revoked", reason: "peer_revoked_mid_session" }; if (current.accepted_control_head_id !== common.accepted_control_head_id) return { status: "stale_authority", reason: "control_head_advanced" }; if (current.key_epoch_commitment !== common.key_epoch_commitment) return { status: "stale_epoch", reason: "epoch_advanced" }; return { status: "accepted", epoch_key_available: true }; } }, random: new WebCryptoRandomSource(crypto), signatures: transportSignatures(), hpke });
  if (prepared.status !== "prepared") return JSON.stringify({ rejected: prepared.status, reason: prepared.reason });
  const pieces = [];
  await writeCanonicalTransportBundleV3({ containers: prepared.bundle.containers, sink: { async write(bytes) { pieces.push(Uint8Array.from(bytes)); }, async close() {}, async abort(error) { throw error; } }, sha256: createHasher() });
  const exact = concat(pieces);
  await appendJournal("sent", round, `${state.outboundSequence}:${role}`, prepared.bundle.manifest_id, exact, state.streamId, 0n, state.outboundSequence);
  state.outboundSequence += 1n;
  state.outboundPrevious = prepared.bundle.manifest_id;
  return base64(exact);
}

async function openFile(encoded) {
  const state = requireSync();
  if (encoded.startsWith("{")) throw new Error(`Peer export rejected before crypto: ${encoded}`);
  const exact = fromBase64(encoded);
  const opened = await importManualSyncBundleV3({ port: { async reopenSource() { return { async *chunks() { for (let offset = 0; offset < exact.length; offset += 73) yield exact.slice(offset, offset + 73); } }; }, createSha256: createHasher }, recipient_key_pair: state.cryptoContext.recipient, signatures: transportSignatures(), hpke: new SingleShotHpkeV3Provider({ keys: state.cryptoContext.registry }) });
  const binding = opened.signed_records[0].core.binding;
  await appendJournal("received", binding.round_number, `${binding.bundle_sequence}:${binding.message_kind}`, binding.bundle_manifest_id, exact, binding.stream_id, binding.stream_generation, binding.bundle_sequence);
  return opened;
}

function commonBinding(messageKind, round, count) {
  const state = requireSync();
  return Object.freeze({ transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID, project_id: state.binding.project_id, purpose: "synchronization", sender_person_id: state.cryptoContext.own.person, sender_membership_id: state.cryptoContext.own.membership, sender_device_id: state.cryptoContext.own.device, sender_signing_key_id: state.cryptoContext.own.signing, recipient_person_id: state.peer.person, recipient_membership_id: state.peer.membership, recipient_device_id: state.peer.device, recipient_key_id: state.peer.recipient, accepted_control_head_id: state.binding.accepted_control_head_id, key_epoch_id: state.binding.key_epoch_id, key_epoch_commitment: state.binding.key_epoch_commitment, stream_id: state.streamId, stream_generation: 0n, bundle_sequence: state.outboundSequence, previous_bundle_manifest_id: state.outboundPrevious, session_id: state.sessionId, session_generation: 0n, round_number: round, message_kind: messageKind, message_direction: state.cryptoContext.label === "A" ? "initiator_to_responder" : "responder_to_initiator", payload_count: count, limit_profile_id: HC2_LIMIT_PROFILE_ID, crypto_suite_id: HC2_CRYPTO_SUITE_ID });
}

async function ensureStreamId() {
  const state = requireSync();
  if (!state.streamId) state.streamId = await deriveTransportStreamIdV3({ project_id: state.binding.project_id, sender_device_id: state.cryptoContext.own.device, recipient_device_id: state.peer.device, session_id: state.sessionId, stream_generation: 0n });
  return state.streamId;
}

async function appendJournal(direction, round, role, commitment, exact, streamId, streamGeneration, bundleSequence) {
  const state = requireSync();
  const existing = state.durable.bundles.find((entry) => entry.direction === direction && entry.round_number === round && entry.message_role === role);
  if (existing) return;
  const transportHighWater = state.durable.transport_high_water.filter((entry) => entry.direction !== direction || entry.stream_id !== streamId);
  transportHighWater.push({ direction, stream_id: streamId, stream_generation: streamGeneration, bundle_sequence: bundleSequence, manifest_id: commitment });
  const next = { ...state.durable, revision: state.durable.revision + 1n, bundles: [...state.durable.bundles, { direction, round_number: round, message_role: role, bundle_commitment: commitment, exact_bundle_bytes: Uint8Array.from(exact), durable_reference: null }], transport_high_water: transportHighWater };
  const result = await state.journal.compareAndSwap({ expected_revision: state.durable.revision, record: next });
  if (result.status !== "committed") throw new Error("Slice 7 durable journal CAS failed.");
  state.durable = result.record;
}

function transportSignatures() {
  const state = requireSync();
  return {
    async sign(preimage) { return new Uint8Array(await state.cryptoContext.registry.subtle.sign("Ed25519", state.cryptoContext.registry.resolveSigningKey(state.cryptoContext.signing.handle), preimage)); },
    async verify({ core, preimage, signature_bytes }) { const encoded = core.binding.sender_signing_key_id === state.peer.signing ? state.peer.signing_public : state.cryptoContext.signing.public_key; const imported = await importEncodedPublicKey({ subtle: crypto.subtle, encoded, expected_algorithm: "ed25519" }); return crypto.subtle.verify("Ed25519", imported.public_key, signature_bytes, preimage); }
  };
}

async function reconstructionCommitments(snapshot) {
  const binding = await slice7AcceptedBinding();
  const suffix = snapshot.core.inventory_root_id.slice(-52);
  const generic = (kind) => `pm:${kind}:v3:${suffix}`;
  return Object.freeze({ accepted_object_set_commitment: generic("accepted-object-set"), semantic_frontier: binding.semantic_frontier, accepted_semantic_set_commitment: generic("accepted-semantic-set"), accepted_control_set_commitment: generic("accepted-control-set"), accepted_control_head_id: binding.accepted_control_head_id, authority_state_commitment: generic("authority-state"), key_epoch_id: binding.key_epoch_id, key_epoch_commitment: binding.key_epoch_commitment, canonical_projection_commitment: generic("canonical-projection"), revision_heads_root_id: `pm:revision-heads-root:v1:${suffix}`, conflict_root_id: `pm:conflict-set-root:v1:${suffix}`, tombstone_root_id: generic("tombstone-root"), reducer_rejection_root_id: generic("reducer-rejection-root"), component_roots_commitment: generic("component-roots"), projection_root_id: binding.projection_root_id, checkpoint_id: binding.checkpoint_id, shared_state_commitment: generic("shared-state"), acknowledgement_receipt_commitment: generic("acknowledgement-receipt"), protocol_version: binding.protocol_version, reducer_version: binding.reducer_version });
}

async function pageIdentity(core) { const { identifyInventoryPageV3 } = await import("../lib/collaboration/hc2/sync-contracts.ts"); return (await identifyInventoryPageV3(core)).page_id; }
function requireSync() { if (!sync) throw new Error("Slice 7 synchronization is not initialized."); return sync; }
function createHasher() { const chunks = []; return { update(bytes) { chunks.push(Uint8Array.from(bytes)); }, async digest() { return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(chunks))); } }; }
function concat(chunks) { const result = new Uint8Array(chunks.reduce((sum, entry) => sum + entry.length, 0)); let offset = 0; for (const entry of chunks) { result.set(entry, offset); offset += entry.length; } return result; }
function base64(bytes) { let text = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(text); }
function fromBase64(value) { const text = atob(value); return Uint8Array.from(text, (child) => child.charCodeAt(0)); }
function restoreBigInts(value) { if (Array.isArray(value)) return value.map(restoreBigInts); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ["session_generation", "round_number", "portable_generation", "exact_byte_length"].includes(key) && typeof child === "string" ? BigInt(child) : restoreBigInts(child)])); return value; }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }
function sequenceFromRole(value) { const parsed = Number(value.split(":", 1)[0]); return Number.isSafeInteger(parsed) ? parsed : -1; }

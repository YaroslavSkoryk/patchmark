/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- frozen test material intentionally crosses branded contracts.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { encodeSha256Base32 } from "../lib/collaboration/base32.ts";
import { deriveMarkdownBlobIdentity } from "../lib/collaboration/preimages.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";
import {
  buildTransportBoundAadV3,
  buildTransportHpkeInfoV3,
  encodeEncryptedContainerRecordV3
} from "../lib/collaboration/hc2/transport-v3-contracts.ts";
import {
  classifySyncTransportContinuityV3,
  classifySynchronizationConvergenceV3,
  createInventoryPagesV3,
  deriveInventoryRootV3,
  deriveSyncSessionIdV3,
  deriveTransportStreamIdV3,
  identifyInventorySnapshotV3,
  identifyObjectRequestV3,
  identifyObjectResponseV3,
  identifySyncConfirmationV3,
  parseInventoryDescriptorV3,
  parseInventorySnapshotCoreV3,
  prepareEncryptedTransportBundleV3,
  HC2_SYNC_TRANSPORT_PROFILE_ID,
  hc2SyncInvocationLimits
} from "../lib/collaboration/hc2/index.ts";
import { encodeAlgorithmTaggedPublicKey, importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";

export async function createSlice7VectorActual(input) {
  const markdown = new TextEncoder().encode(input.markdown_text);
  const blob = await deriveMarkdownBlobIdentity(ids.project, markdown);
  const descriptors = [
    parseInventoryDescriptorV3({ schema_version: 3, record_kind: "inventory_descriptor_v3", authority: "none", storage_family: "hc1", object_kind: "markdown-blob", object_id: blob.id, exact_sha256: await sha256(markdown), exact_byte_length: BigInt(markdown.length) }),
    parseInventoryDescriptorV3({ schema_version: 3, record_kind: "inventory_descriptor_v3", authority: "none", storage_family: "hc1", object_kind: "semantic-event", object_id: ids.semantic, exact_sha256: await sha256(new TextEncoder().encode("concurrent-event-a")), exact_byte_length: 18n }),
    parseInventoryDescriptorV3({ schema_version: 3, record_kind: "inventory_descriptor_v3", authority: "none", storage_family: "hc2_attachment", object_kind: "receipt_attachment", object_id: `pm:transport-attachment:v2:${encodeSha256Base32(await sha256(new TextEncoder().encode("receipt-a")))}`, exact_sha256: await sha256(new TextEncoder().encode("receipt-a")), exact_byte_length: 9n })
  ].sort((left, right) => descriptorKey(left).localeCompare(descriptorKey(right)));
  const inventoryRoot = await deriveInventoryRootV3(ids.project, descriptors);
  const snapshotCore = parseInventorySnapshotCoreV3({ schema_version: 3, record_kind: "inventory_snapshot_core_v3", authority: "none", project_id: ids.project, portable_generation: 7n, accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, semantic_frontier: [ids.semantic], checkpoint_id: ids.semantic, projection_root_id: ids.projection, descriptor_count: descriptors.length, page_count: 1, inventory_root_id: inventoryRoot, protocol_version: "hc1-v1", reducer_version: "hc1-reducer-v1" });
  const snapshot = Object.freeze({ snapshot_id: await identifyInventorySnapshotV3(snapshotCore), core: snapshotCore, descriptors: Object.freeze(descriptors) });
  const sessionId = await deriveSyncSessionIdV3({ project_id: ids.project, initiator_device_id: ids.senderDevice, responder_device_id: ids.recipientDevice, session_generation: 0n });
  const pages = await createInventoryPagesV3({ snapshot, session_id: sessionId, session_generation: 0n, round_number: 1n });
  const request = await identifyObjectRequestV3({ schema_version: 3, record_kind: "object_request_core_v3", authority: "none", session_id: sessionId, session_generation: 0n, round_number: 2n, local_snapshot_id: snapshot.snapshot_id, remote_snapshot_id: snapshot.snapshot_id, request_page_ordinal: 0, request_page_count: 1, maximum_object_count: 1, maximum_total_bytes: 1024n, dependency_policy: "required_closure", items: [{ storage_family: descriptors[0].storage_family, object_kind: descriptors[0].object_kind, object_id: descriptors[0].object_id, expected_sha256: descriptors[0].exact_sha256, expected_byte_length: descriptors[0].exact_byte_length }] });
  const response = await identifyObjectResponseV3({ schema_version: 3, record_kind: "object_response_core_v3", authority: "none", session_id: sessionId, session_generation: 0n, round_number: 2n, request_id: request.request_id, local_snapshot_id: snapshot.snapshot_id, remote_snapshot_id: snapshot.snapshot_id, included_descriptors: [descriptors[0]], unavailable_descriptor_keys: [], continuation_required: false, continuation_after_key: null });
  const reconstruction = makeReconstruction();
  const confirmation = await identifySyncConfirmationV3({ schema_version: 3, record_kind: "sync_confirmation_core_v3", authority: "none", session_id: sessionId, session_generation: 0n, round_number: 3n, inventory_snapshot_id: snapshot.snapshot_id, inventory_root_id: inventoryRoot, inventory_descriptor_count: descriptors.length, reconstruction });
  const streamId = await deriveTransportStreamIdV3({ project_id: ids.project, sender_device_id: ids.senderDevice, recipient_device_id: ids.recipientDevice, session_id: sessionId, stream_generation: 0n });

  const suite = hpkeSuite();
  const recipientPair = await suite.kem.deriveKeyPair(hex(input.recipient_x25519_ikm_hex));
  const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(recipientPair.publicKey));
  const recipientPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.recipientKey, raw_public_key: recipientRaw });
  const signerPrivate = await crypto.subtle.importKey("pkcs8", concatHex("302e020100300506032b657004220420", input.sender_ed25519_seed_hex), "Ed25519", false, ["sign"]);
  const signerPublic = encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.senderSigning, raw_public_key: hex(input.sender_ed25519_public_hex) });
  const signaturePreimages = [];
  const signatures = {
    async sign(preimage) { signaturePreimages.push(Uint8Array.from(preimage)); return new Uint8Array(await crypto.subtle.sign("Ed25519", signerPrivate, preimage)); },
    async verify({ preimage, signature_bytes }) { const imported = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: signerPublic, expected_algorithm: "ed25519" }); return crypto.subtle.verify("Ed25519", imported.public_key, signature_bytes, preimage); }
  };
  const offer = Object.freeze({ schema_version: 3, record_kind: "sync_offer_core_v3", authority: "none", session_id: sessionId, session_generation: 0n, round_number: 1n, inventory_snapshot_id: snapshot.snapshot_id, inventory_root_id: inventoryRoot, descriptor_count: descriptors.length, page_count: pages.length, accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, semantic_frontier: [ids.semantic], checkpoint_id: ids.semantic, projection_root_id: ids.projection, supported_transport_versions: [3], crypto_suite_id: HC2_CRYPTO_SUITE_ID, limit_profile_id: HC2_LIMIT_PROFILE_ID, maximum_session_rounds: hc2SyncInvocationLimits.maximum_session_rounds });
  const common = Object.freeze({ transport_profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID, project_id: ids.project, purpose: "synchronization", sender_person_id: ids.senderPerson, sender_membership_id: ids.senderMembership, sender_device_id: ids.senderDevice, sender_signing_key_id: ids.senderSigning, recipient_person_id: ids.recipientPerson, recipient_membership_id: ids.recipientMembership, recipient_device_id: ids.recipientDevice, recipient_key_id: ids.recipientKey, accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, stream_id: streamId, stream_generation: 0n, bundle_sequence: 0n, previous_bundle_manifest_id: null, session_id: sessionId, session_generation: 0n, round_number: 1n, message_kind: "offer", message_direction: "initiator_to_responder", payload_count: 2, limit_profile_id: HC2_LIMIT_PROFILE_ID, crypto_suite_id: HC2_CRYPTO_SUITE_ID });
  const deterministicHpke = new DeterministicTransportHpkeV3(input.ephemeral_x25519_ikm_hexes);
  const prepared = await prepareEncryptedTransportBundleV3({ common_binding: common, non_manifest_payloads: [{ schema_version: 3, payload_kind: "sync_offer", offer_core: offer }], recipient_public_key: recipientPublic, authority: { async verify() { return { status: "accepted", epoch_key_available: true }; } }, random: fixedRandom(hex(input.envelope_id_random_hex)), signatures, hpke: deterministicHpke });
  if (prepared.status !== "prepared") throw new Error("Vector preparation failed.");
  const bundle = prepared.bundle;
  const recordBytes = bundle.containers.map(encodeEncryptedContainerRecordV3);
  const bundleBytes = concat([Uint8Array.of(0x80 | recordBytes.length), ...recordBytes]);
  const confirmationCore = confirmation.core;
  const forkConfirmation = { ...confirmationCore, reconstruction: { ...reconstruction, conflict_root_id: digestId("conflict-set-root", "z") } };
  const head = { stream_id: streamId, stream_generation: 0n, session_id: sessionId, session_generation: 0n, bundle_sequence: 0n, manifest_id: bundle.manifest_id };
  return clean({
    profile_id: HC2_SYNC_TRANSPORT_PROFILE_ID,
    descriptor_keys: descriptors.map(descriptorKey),
    descriptor_sha256: descriptors.map((entry) => toHex(entry.exact_sha256)),
    inventory_root_id: inventoryRoot,
    inventory_snapshot_id: snapshot.snapshot_id,
    inventory_page_ids: pages.map((entry) => entry.page_id),
    inventory_page_digests: pages.map((entry) => toHex(entry.core.page_digest)),
    session_id: sessionId,
    stream_id: streamId,
    request_id: request.request_id,
    response_id: response.response_id,
    confirmation_id: confirmation.confirmation_id,
    convergence_status: classifySynchronizationConvergenceV3(confirmationCore, structuredClone(confirmationCore)).status,
    reconstruction_divergence_status: classifySynchronizationConvergenceV3(confirmationCore, forkConfirmation).status,
    replay_status: classifySyncTransportContinuityV3({ head, session_id: sessionId, session_generation: 0n, stream_id: streamId, stream_generation: 0n, bundle_sequence: 0n, previous_manifest_id: null, manifest_id: bundle.manifest_id, session_status: "active" }).status,
    gap_status: classifySyncTransportContinuityV3({ head, session_id: sessionId, session_generation: 0n, stream_id: streamId, stream_generation: 0n, bundle_sequence: 2n, previous_manifest_id: bundle.manifest_id, manifest_id: bundle.manifest_id, session_status: "active" }).status,
    stream_fork_status: classifySyncTransportContinuityV3({ head, session_id: sessionId, session_generation: 0n, stream_id: streamId, stream_generation: 0n, bundle_sequence: 0n, previous_manifest_id: null, manifest_id: digestId("bundle-manifest", "y", 3), session_status: "active" }).status,
    manifest_id: bundle.manifest_id,
    payload_kinds: bundle.payloads.map((entry) => entry.payload_kind),
    payload_canonical_lengths: bundle.payloads.map((entry) => encodeCanonicalCbor(canonicalProtocolValue(entry)).length),
    signature_preimage_lengths: signaturePreimages.map((entry) => entry.length),
    signature_preimage_sha256: await Promise.all(signaturePreimages.map(hashHex)),
    hpke_info_hex: deterministicHpke.evidence.map((entry) => toHex(entry.info)),
    aad_hex: deterministicHpke.evidence.map((entry) => toHex(entry.aad)),
    ciphertext_sha256: await Promise.all(deterministicHpke.evidence.map((entry) => hashHex(entry.ciphertext))),
    ciphertext_lengths: deterministicHpke.evidence.map((entry) => entry.ciphertext.length),
    encapsulated_key_hex: deterministicHpke.evidence.map((entry) => toHex(entry.enc)),
    container_ids: bundle.containers.map((entry) => entry.container_id),
    container_canonical_lengths: recordBytes.map((entry) => entry.length),
    container_sha256: await Promise.all(recordBytes.map(hashHex)),
    bundle_canonical_length: bundleBytes.length,
    bundle_sha256: await hashHex(bundleBytes),
    public_header_keys: Object.keys(bundle.containers[0].core.public_header).sort(),
    authority_values: [offer.authority, pages[0].core.authority, request.core.authority, response.core.authority, confirmation.core.authority]
  });
}

class DeterministicTransportHpkeV3 {
  constructor(ikms) { this.ikms = ikms.map(hex); this.evidence = []; }
  async sealBound(input) {
    const suite = hpkeSuite();
    const decoded = await importEncodedPublicKey({ subtle: crypto.subtle, encoded: input.recipient_public_key, expected_algorithm: "x25519" });
    const ephemeral = await suite.kem.deriveKeyPair(this.ikms[this.evidence.length]);
    const info = buildTransportHpkeInfoV3(input.info_binding);
    const sender = await suite.createSenderContext({ recipientPublicKey: decoded.public_key, info, ekm: ephemeral });
    const enc = new Uint8Array(sender.enc);
    const header = input.finalize_header(enc, BigInt(input.plaintext.length + 16));
    const aad = buildTransportBoundAadV3(header);
    const ciphertext = new Uint8Array(await sender.seal(input.plaintext, aad));
    this.evidence.push({ info: Uint8Array.from(info), aad: Uint8Array.from(aad), ciphertext: Uint8Array.from(ciphertext), enc: Uint8Array.from(enc) });
    return { public_header: header, ciphertext_bytes: ciphertext };
  }
  async openBound() { throw new Error("Frozen sender vector does not open."); }
}

function makeReconstruction() {
  return Object.freeze({ accepted_object_set_commitment: digestId("accepted-object-set", "q", 3), semantic_frontier: [ids.semantic], accepted_semantic_set_commitment: digestId("semantic-set", "r", 3), accepted_control_set_commitment: digestId("control-set", "s", 3), accepted_control_head_id: ids.control, authority_state_commitment: digestId("authority-state", "t", 3), key_epoch_id: ids.epoch, key_epoch_commitment: ids.epochCommitment, canonical_projection_commitment: digestId("canonical-projection", "u", 3), revision_heads_root_id: ids.revisionHeads, conflict_root_id: ids.conflicts, tombstone_root_id: digestId("tombstone-root", "v", 3), reducer_rejection_root_id: digestId("reducer-rejection-root", "w", 3), component_roots_commitment: digestId("component-roots", "x", 3), projection_root_id: ids.projection, checkpoint_id: ids.semantic, shared_state_commitment: digestId("shared-state", "y", 3), acknowledgement_receipt_commitment: digestId("ack-receipt", "z", 3), protocol_version: "hc1-v1", reducer_version: "hc1-reducer-v1" });
}

function hpkeSuite() { return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }); }
function fixedRandom(value) { let used = false; return { async randomBytes(length) { if (used || value.length !== length) throw new Error("Fixed V3 envelope random was reused or mis-sized."); used = true; return Uint8Array.from(value); } }; }
async function hashHex(value) { return toHex(await sha256(value)); }
function hex(value) { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function concatHex(prefix, suffix) { return concat([hex(prefix), hex(suffix)]); }
function concat(chunks) { const bytes = new Uint8Array(chunks.reduce((sum, entry) => sum + entry.length, 0)); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes; }
function toHex(value) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }
function descriptorKey(value) { return `${value.storage_family}\u0000${value.object_kind}\u0000${value.object_id}`; }
function entityId(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digestId(kind, fill, version = 1) { return `pm:${kind}:v${version}:${fill.repeat(51)}a`; }

const ids = Object.freeze({
  project: entityId("project", "a"), senderPerson: entityId("person", "c"), senderMembership: entityId("membership", "d"),
  senderDevice: entityId("device", "e"), senderSigning: entityId("public-key", "f"), recipientPerson: entityId("person", "g"),
  recipientMembership: entityId("membership", "h"), recipientDevice: entityId("device", "j"), recipientKey: entityId("public-key", "k"),
  epoch: entityId("key-epoch", "m"), control: digestId("control-event", "n"), epochCommitment: digestId("key-epoch-commitment", "p"),
  semantic: digestId("semantic-event", "q"), projection: digestId("projection-root", "r"), revisionHeads: digestId("revision-heads-root", "s"),
  conflicts: digestId("conflict-set-root", "t")
});

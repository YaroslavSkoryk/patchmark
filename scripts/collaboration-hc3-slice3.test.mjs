import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  Hc3DirectTransferAssembler,
  Hc3ReliableDirectByteChannel,
  Hc3DirectSyncCoordinator,
  assertHc3ConnectionAnswerBinding,
  assessHc3DirectPresentation,
  authenticatedOfferDigest,
  buildHc3ConnectionOfferCommitmentPreimage,
  classifyHc3SimultaneousOffers,
  createHc3AuthenticatedConnectionAnswer,
  createHc3AuthenticatedConnectionOffer,
  createHc3ConnectionAnswer,
  createHc3ConnectionOffer,
  createHc3DirectConnectionLink,
  decodeHc3AuthenticatedConnectionRecord,
  decodeHc3DirectDescription,
  decodeHc3DirectFrame,
  encodeHc3AuthenticatedConnectionRecord,
  encodeHc3DirectDescription,
  encodeHc3DirectFrame,
  exchangeHc3DirectRound,
  formatHc3DirectAuthText,
  hc3DirectLimits,
  hc3DirectTransportAdapterTag,
  hc3DirectWorkflowCommands,
  hc3DirectWorkflowStateKinds,
  parseHc3DirectAuthText,
  parseHc3DirectConnectionLink,
  prepareHc3DirectTransfer,
  verifyHc3AuthenticatedConnectionAtBoundary
} from "../lib/collaboration/hc3/index.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const rejects = async (operation, pattern, message) => { assertions += 1; await assert.rejects(operation, pattern, message); };
const throws = (operation, pattern, message) => { assertions += 1; assert.throws(operation, pattern, message); };
const digest = async (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = (bytes) => Buffer.from(bytes).toString("hex");

const fixture = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc3-slice3-v1.json", import.meta.url), "utf8"));
const payload = Uint8Array.from({ length: fixture.inputs.payload_descriptor.length }, (_, index) => index % fixture.inputs.payload_descriptor.modulo);
const attempt = Buffer.from(fixture.inputs.connection_attempt_id_hex, "hex");
const transferId = Buffer.from(fixture.inputs.transfer_id_hex, "hex");

const prepared = await prepareHc3DirectTransfer({ connection_attempt_id: attempt, transfer_id: transferId, exact_bytes: payload, sha256_provider: digest });
equal(prepared.frame_count, fixture.expected.frame_count, "compact descriptor expands to frozen frame count");
equal(hex(prepared.transfer_sha256), fixture.expected.payload_sha256, "frozen payload digest is independent and literal");
equal(prepared.frames.map((frame) => frame.length), fixture.expected.frame_lengths, "frozen canonical frame lengths match");
equal(prepared.frames.map((frame) => createHash("sha256").update(frame).digest("hex")), fixture.expected.frame_sha256, "frozen frame digests match");
equal(prepared.frames.map((frame) => hex(frame.slice(0, 24))), fixture.expected.frame_prefix_hex, "frozen canonical prefixes match");
check(prepared.frames.every((frame) => decodeHc3DirectFrame(frame).payload_bytes.length <= 4096), "every frame is within the conservative payload profile");

const assembler = new Hc3DirectTransferAssembler({ connection_attempt_id: attempt, sha256_provider: digest });
equal(assembler.accept(prepared.frames[2]).complete, false, "out-of-order final frame is journaled without completion");
equal(assembler.accept(prepared.frames[0]).status, "accepted", "out-of-order first frame is accepted");
equal(assembler.accept(prepared.frames[0]).status, "duplicate", "byte-identical duplicate frame is idempotent");
equal(assembler.accept(prepared.frames[1]).complete, true, "dense frame set completes regardless of arrival order");
equal((await assembler.finish()).exact_bytes, payload, "exact bytes reassemble only after digest verification");
throws(() => assembler.accept(prepared.frames[0]), /closed/i, "completed assembler rejects replay into consumed state");

const conflictAssembler = new Hc3DirectTransferAssembler({ connection_attempt_id: attempt, sha256_provider: digest });
conflictAssembler.accept(prepared.frames[0]);
const conflicting = decodeHc3DirectFrame(prepared.frames[0]);
const conflictingPayload = Uint8Array.from(conflicting.payload_bytes); conflictingPayload[0] ^= 1;
const conflictingBytes = encodeHc3DirectFrame({ ...conflicting, payload_bytes: conflictingPayload });
throws(() => conflictAssembler.accept(conflictingBytes), /conflicts byte-for-byte/i, "conflicting duplicate frame fails closed");

const exactLimitFrame = {
  schema_version: 1, record_kind: "hc3_direct_frame", connection_attempt_id: attempt, transfer_id: transferId,
  transfer_length: hc3DirectLimits.maximum_transfer_bytes, transfer_sha256: new Uint8Array(32), frame_ordinal: 0,
  frame_count: hc3DirectLimits.maximum_frame_count, byte_offset: 0, payload_bytes: new Uint8Array(4096)
};
check(encodeHc3DirectFrame(exactLimitFrame).length > 4096, "exact maximum transfer metadata is accepted without allocating the transfer");
throws(() => encodeHc3DirectFrame({ ...exactLimitFrame, transfer_length: hc3DirectLimits.maximum_transfer_bytes + 1 }), /bounded|range|limit/i, "+1 maximum transfer metadata is rejected");
throws(() => decodeHc3DirectFrame(Uint8Array.from([...prepared.frames[0], 0])), /noncanonical|trailing/i, "trailing frame data is rejected");

for (const [index, input] of fixture.inputs.descriptions.entries()) {
  const encoded = encodeHc3DirectDescription({ description_kind: input.kind, sdp: input.sdp });
  equal(encoded.length, fixture.expected.descriptions[index].canonical_bytes, `${input.kind} description length is frozen`);
  equal(createHash("sha256").update(encoded).digest("hex"), fixture.expected.descriptions[index].sha256, `${input.kind} description hash is frozen`);
  equal(decodeHc3DirectDescription(encoded, input.kind).sdp, input.sdp, `${input.kind} description exact UTF-8 round trips`);
  throws(() => decodeHc3DirectDescription(Uint8Array.from([...encoded, 0]), input.kind), /trailing|noncanonical|decode/i, `${input.kind} trailing data is rejected`);
}
throws(() => encodeHc3DirectDescription({ description_kind: "offer", sdp: "x".repeat(hc3DirectLimits.maximum_sdp_utf8_bytes + 1) }), /limit/i, "oversized SDP rejects before carrier creation");

const linked = linkedChannels();
const sender = new Hc3ReliableDirectByteChannel({ channel: linked.left, connection_attempt_id: attempt, sha256_provider: digest });
const receiver = new Hc3ReliableDirectByteChannel({ channel: linked.right, connection_attempt_id: attempt, sha256_provider: digest });
const largeBytes = Uint8Array.from({ length: 180_000 }, (_, index) => (index * 17) & 255);
const largePrepared = await prepareHc3DirectTransfer({ connection_attempt_id: attempt, transfer_id: new Uint8Array(16).fill(77), exact_bytes: largeBytes, sha256_provider: digest });
const receiving = receiver.receiveTransfer();
const sent = await sender.sendPreparedTransfer(largePrepared);
const received = await receiving;
equal(received.exact_bytes, largeBytes, "linked binary channels preserve exact multi-frame bytes");
check(sent.backpressure_wait_count > 0, "send loop pauses on actual bufferedAmount threshold crossings");
equal(linked.left.sentTypes, new Set(["ArrayBuffer"]), "sender emits binary ArrayBuffer messages only");
sender.close(); receiver.close();
equal(linked.left.listenerCount() + linked.right.listenerCount(), 0, "explicit close removes message, close, and backpressure listeners");

const ids = fixtureIds();
const offerDescription = encodeHc3DirectDescription({ description_kind: "offer", sdp: fixture.inputs.descriptions[0].sdp });
const carrierOffer = createHc3ConnectionOffer({ session_id: ids.session, session_generation: 1n, transport_adapter_tag: hc3DirectTransportAdapterTag(), transport_description_bytes: offerDescription });
const signatures = fakeSignatures();
const authorityA = currentAuthority("A", ids);
const authorityB = currentAuthority("B", ids);
const authenticatedOffer = await createHc3AuthenticatedConnectionOffer({ carrier: carrierOffer, project_id: ids.project, connection_attempt_id: attempt, authority: authorityA, signatures });
const offerText = formatHc3DirectAuthText(authenticatedOffer);
equal(parseHc3DirectAuthText(offerText).record, authenticatedOffer, "authenticated offer canonical text round trips");
equal(decodeHc3AuthenticatedConnectionRecord(encodeHc3AuthenticatedConnectionRecord(authenticatedOffer)), authenticatedOffer, "authenticated offer canonical bytes round trip");
check(assessHc3DirectPresentation(offerText).copy_available, "exact copy is always retained for authenticated connection text");
const link = createHc3DirectConnectionLink({ base_url: "https://patchmark.example/collaborate", text: offerText });
equal(parseHc3DirectConnectionLink(link).text, offerText, "authenticated connection link preserves exact text");

const authorityPortB = recordingAuthorityPort(authorityB);
equal((await verifyHc3AuthenticatedConnectionAtBoundary({ value: authenticatedOffer, expected_kind: "connection_offer", local_device_id: ids.deviceB, authority: authorityPortB, signatures, sha256_provider: digest, boundary: "before_peer_connection" })).status, "verified", "offer signature resolves against current accepted peer key");
equal(authorityPortB.boundaries, ["before_peer_connection"], "authority is revalidated before peer construction");

const carrierOfferCommitment = await sha256(buildHc3ConnectionOfferCommitmentPreimage(carrierOffer), digest);
const answerDescription = encodeHc3DirectDescription({ description_kind: "answer", sdp: fixture.inputs.descriptions[1].sdp });
const carrierAnswer = createHc3ConnectionAnswer({ session_id: ids.session, session_generation: 1n, transport_adapter_tag: hc3DirectTransportAdapterTag(), transport_description_bytes: answerDescription, offer_commitment_sha256: carrierOfferCommitment });
assertHc3ConnectionAnswerBinding({ offer: carrierOffer, answer: carrierAnswer, expected_offer_commitment_sha256: carrierOfferCommitment });
const authenticatedAnswer = await createHc3AuthenticatedConnectionAnswer({ carrier: carrierAnswer, authenticated_offer: authenticatedOffer, authority: authorityB, signatures, sha256_provider: digest });
equal(authenticatedAnswer.offer_record_sha256, await authenticatedOfferDigest(authenticatedOffer, digest), "answer commits to the exact signed offer record");
equal((await verifyHc3AuthenticatedConnectionAtBoundary({ value: authenticatedAnswer, expected_kind: "connection_answer", local_device_id: ids.deviceA, authority: recordingAuthorityPort(authorityA), signatures, sha256_provider: digest, authenticated_offer: authenticatedOffer, boundary: "before_peer_connection" })).status, "verified", "answer signature and both offer commitments verify");

const syncChannels = linkedChannels();
const syncAuthorityA = recordingAuthorityPort(authorityA);
const syncAuthorityB = recordingAuthorityPort(authorityB);
const bundleA = Uint8Array.from({ length: 9001 }, (_, index) => (index * 3) & 255);
const bundleB = Uint8Array.from({ length: 8201 }, (_, index) => (index * 5) & 255);
const v3A = fakeV3Port(bundleA, 31);
const v3B = fakeV3Port(bundleB, 47);
const coordinatorA = new Hc3DirectSyncCoordinator({ authenticated_connection: authenticatedAnswer, local_device_id: ids.deviceA, channel: syncChannels.left, authority: syncAuthorityA, v3: v3A, sha256_provider: digest });
const coordinatorB = new Hc3DirectSyncCoordinator({ authenticated_connection: authenticatedAnswer, local_device_id: ids.deviceB, channel: syncChannels.right, authority: syncAuthorityB, v3: v3B, sha256_provider: digest });
const directRound = await exchangeHc3DirectRound({ round_number: 1, left: coordinatorA, right: coordinatorB, sha256_provider: digest });
equal([directRound.left_sent, directRound.right_sent], [bundleA.length, bundleB.length], "explicit coordinator sends exact unchanged V3 bundle lengths in both directions");
equal(v3A.imported[0], bundleB, "A delegates received exact bytes to the injected V3 importer");
equal(v3B.imported[0], bundleA, "B delegates received exact bytes to the injected V3 importer");
equal(syncAuthorityA.boundaries, ["before_v3_prepare", "before_v3_send", "before_v3_import"], "A revalidates authority at every V3 crypto boundary");
equal(syncAuthorityB.boundaries, ["before_v3_prepare", "before_v3_send", "before_v3_import"], "B revalidates authority at every V3 crypto boundary");
coordinatorA.close(); coordinatorB.close();

const changedAuthority = recordingAuthorityPort({ ...authorityA, current_epoch_commitment_id: ids.control });
const changedChannels = linkedChannels();
const changedCoordinator = new Hc3DirectSyncCoordinator({ authenticated_connection: authenticatedAnswer, local_device_id: ids.deviceA, channel: changedChannels.left, authority: changedAuthority, v3: fakeV3Port(bundleA, 61), sha256_provider: digest });
await rejects(() => changedCoordinator.prepareRound(1, digest), /authority changed/i, "epoch/control movement after connection authentication stops V3 preparation");
changedCoordinator.close(); changedChannels.right.close();

const tamperedSignature = Uint8Array.from(authenticatedOffer.signature_bytes); tamperedSignature[0] ^= 1;
const tamperedOffer = { ...authenticatedOffer, signature_bytes: tamperedSignature };
await rejects(() => verifyHc3AuthenticatedConnectionAtBoundary({ value: tamperedOffer, expected_kind: "connection_offer", local_device_id: ids.deviceB, authority: recordingAuthorityPort(authorityB), signatures, sha256_provider: digest, boundary: "before_peer_connection" }), /mismatch/i, "tampered authenticated offer signature rejects");
const revokedPort = recordingAuthorityPort(authorityB, "revoked_device");
await rejects(() => verifyHc3AuthenticatedConnectionAtBoundary({ value: authenticatedOffer, expected_kind: "connection_offer", local_device_id: ids.deviceB, authority: revokedPort, signatures, sha256_provider: digest, boundary: "before_peer_connection" }), /revoked_device/i, "revocation stops before peer construction");
const stalePort = recordingAuthorityPort(authorityB, "stale_epoch");
await rejects(() => verifyHc3AuthenticatedConnectionAtBoundary({ value: authenticatedOffer, expected_kind: "connection_offer", local_device_id: ids.deviceB, authority: stalePort, signatures, sha256_provider: digest, boundary: "before_v3_import" }), /stale_epoch/i, "epoch rotation stops a later V3 crypto boundary");

const otherOffer = { ...authenticatedOffer, connection_attempt_id: new Uint8Array(16).fill(9) };
equal(classifyHc3SimultaneousOffers(authenticatedOffer, otherOffer).automatic_winner, null, "simultaneous offers have no hidden arrival-order winner");
equal(new Set(hc3DirectWorkflowCommands).size, hc3DirectWorkflowCommands.length, "direct workflow commands are explicit and unique");
check(hc3DirectWorkflowStateKinds.includes("simultaneous_offer_conflict") && hc3DirectWorkflowStateKinds.includes("direct_interrupted"), "ordinary-language workflow exposes conflict and interruption states");

process.stdout.write(`${JSON.stringify({
  assertions,
  fixture_domain: fixture.fixture_domain,
  frame_profile: { payload_bytes: hc3DirectLimits.maximum_frame_payload_bytes, frozen_frames: prepared.frame_count },
  exact_limit_and_plus_one: true,
  authenticated_offer_answer: true,
  answer_exact_offer_commitment: true,
  authority_boundaries_tested: ["before_peer_connection", "before_v3_prepare", "before_v3_send", "before_v3_import"],
  backpressure_waits: sent.backpressure_wait_count,
  binary_only: true,
  simultaneous_offer_automatic_winner: null,
  encrypted_file_fallback_states: true,
  status: "ok"
}, null, 2)}\n`);

function fixtureIds() {
  const entity = (kind, seed) => `pm:${kind}:v1:${seed.repeat(25)}a`;
  const digestId = (kind, seed) => `pm:${kind}:v1:${seed.repeat(51)}a`;
  return {
    project: entity("project", "a"), deviceA: entity("device", "b"), deviceB: entity("device", "c"),
    keyA: entity("public-key", "d"), keyB: entity("public-key", "e"), epoch: entity("key-epoch", "f"),
    control: digestId("control-event", "g"), epochCommitment: digestId("key-epoch-commitment", "h"),
    session: `pm:sync-session:v3:${"s".repeat(51)}a`
  };
}

function currentAuthority(side, ids) {
  const localA = side === "A";
  const local = localA ? ids.deviceA : ids.deviceB;
  const peer = localA ? ids.deviceB : ids.deviceA;
  const localKey = localA ? ids.keyA : ids.keyB;
  const peerKey = localA ? ids.keyB : ids.keyA;
  return Object.freeze({
    status: "current", project_id: ids.project, local_device_id: local, peer_device_id: peer,
    accepted_control_head_id: ids.control, current_epoch_id: ids.epoch, current_epoch_commitment_id: ids.epochCommitment,
    local_signing_key: Object.freeze({ handle_kind: "device_signing_private_key", algorithm: "ed25519", extractability: "non_extractable", custody: "native_webcrypto", key_id: localKey }),
    local_signer_key_id: localKey,
    peer_signer: Object.freeze({ resolution: "accepted_control_state", project_id: ids.project, device_id: peer, key_id: peerKey, control_head_id: ids.control, algorithm: "ed25519", public_key_bytes: new Uint8Array([1, 2, 3]) })
  });
}

function fakeSignatures() {
  return Object.freeze({
    async sign({ preimage }) { const one = createHash("sha256").update(preimage).digest(); return Object.freeze({ algorithm: "ed25519", signature_bytes: Uint8Array.from([...one, ...one]) }); },
    async verify({ preimage, signature_bytes, signer }) { const one = createHash("sha256").update(preimage).digest(); const expected = Uint8Array.from([...one, ...one]); return Buffer.from(expected).equals(Buffer.from(signature_bytes)) ? Object.freeze({ status: "valid_signature", signer }) : Object.freeze({ status: "invalid_signature", reason: "mismatch" }); }
  });
}

function recordingAuthorityPort(current, rejection = null) {
  return {
    boundaries: [],
    async revalidate({ boundary }) { this.boundaries.push(boundary); return rejection ? Object.freeze({ status: "rejected", reason: rejection }) : current; }
  };
}

function fakeV3Port(bundle, transferByte) {
  let prepared = false;
  return {
    imported: [],
    async prepareNextBundle() {
      if (prepared) return { status: "nothing_missing", journal_commitment: "journal-stable" };
      prepared = true;
      return { status: "prepared", exact_v3_bundle_bytes: Uint8Array.from(bundle), transfer_id: new Uint8Array(16).fill(transferByte), journal_commitment: `journal-${transferByte}` };
    },
    async importExactBundle({ exact_v3_bundle_bytes }) { this.imported.push(Uint8Array.from(exact_v3_bundle_bytes)); return { status: "imported", journal_commitment: `import-${transferByte}` }; },
    async inspectConvergence() { return { status: "converged", local_inventory_root: `root-${transferByte}`, peer_inventory_root: `root-${transferByte}` }; }
  };
}

function linkedChannels() {
  const create = () => {
    const listeners = new Map();
    const port = {
      label: "patchmark-hc3-v3", protocol: "patchmark/hc3/direct-v3/v1", ordered: true,
      maxRetransmits: null, maxPacketLifeTime: null, readyState: "open", binaryType: "arraybuffer",
      bufferedAmount: 0, bufferedAmountLowThreshold: 0, peer: null, sentTypes: new Set(),
      addEventListener(type, listener) { const values = listeners.get(type) ?? new Set(); values.add(listener); listeners.set(type, values); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
      send(data) {
        this.sentTypes.add(data?.constructor?.name ?? typeof data);
        const copy = data.slice(0); this.bufferedAmount += copy.byteLength;
        setImmediate(() => {
          for (const listener of this.peer._listeners("message")) listener({ type: "message", data: copy.slice(0) });
          this.bufferedAmount = 0;
          for (const listener of this._listeners("bufferedamountlow")) listener({ type: "bufferedamountlow" });
        });
      },
      close() { if (this.readyState === "closed") return; this.readyState = "closed"; for (const listener of this._listeners("close")) listener({ type: "close" }); },
      _listeners(type) { return [...(listeners.get(type) ?? [])]; }
    };
    return port;
  };
  const left = create(); const right = create(); left.peer = right; right.peer = left;
  return { left, right };
}

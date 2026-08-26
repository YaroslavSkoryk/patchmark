/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- real-browser qualification intentionally crosses branded injected ports.
import {
  slice7AcceptedBinding,
  slice7CryptoContext
} from "./collaboration-hc2-slice6-convergence-runtime.ts";
import { NativeEd25519SignatureProvider } from "../lib/collaboration/hc2/providers/ed25519-provider.ts";
import {
  Hc3ManualDirectConnectionAdapter,
  Hc3ReliableDirectByteChannel,
  assessHc3DirectPresentation,
  encodeHc3DirectDescription,
  hc3DirectLimits,
  prepareHc3DirectTransfer
} from "../lib/collaboration/hc3/index.ts";
import { mountHc3Slice3QualificationSurface } from "./collaboration-hc3-slice3-surface.ts";

let direct = null;
let qualificationSurface = null;

export function initializeDirectQualificationSurface() {
  let current = surfaceStatus("ready", "Direct connection ready", "Create a connection link or use an encrypted file.", ["create_connection_link", "use_encrypted_file"]);
  const facade = {
    get currentStatus() { return current; },
    async invoke(action, pastedText) {
      const transitions = {
        create_connection_link: ["connection_link_ready", "Connection link ready", "Copy the request and wait for a response.", ["copy_connection_request", "open_connection_response", "use_encrypted_file"]],
        open_connection_request: ["request_opened", "Open request", "Create a response explicitly.", ["create_connection_response", "use_encrypted_file"]],
        create_connection_response: ["response_ready", "Create response", "Return the exact response manually.", ["copy_connection_response", "use_encrypted_file"]],
        open_connection_response: ["response_opened", "Open response", "Connect explicitly when ready.", ["connect_directly", "use_encrypted_file"]],
        connect_directly: ["connected", "Connected", "Synchronize explicitly.", ["synchronize_directly", "cancel_direct_connection", "use_encrypted_file"]],
        synchronize_directly: ["synchronizing", "Synchronizing", "Exact encrypted V3 bytes are moving.", ["cancel_direct_connection", "use_encrypted_file"]],
        cancel_direct_connection: ["cancelled", "Cancelled", "No retry or connection remains active.", ["restart_direct_connection", "use_encrypted_file"]],
        restart_direct_connection: ["ready", "Direct connection ready", "Create a fresh connection link.", ["create_connection_link", "use_encrypted_file"]],
        use_encrypted_file: ["direct_unavailable", "Direct unavailable", "Use the existing encrypted-file workflow.", ["use_encrypted_file"]]
      };
      const next = transitions[action];
      if (next) current = surfaceStatus(next[0], next[1], `${next[2]}${pastedText ? " Pasted text remains unaccepted until verification." : ""}`, next[3]);
      return current;
    }
  };
  qualificationSurface = mountHc3Slice3QualificationSurface(document.querySelector("main"), facade);
  return qualificationSurface.snapshot();
}

export function invokeDirectQualificationSurface(action, pastedText = "") {
  const textarea = document.querySelector("#hc3-direct-artifact");
  if (textarea) textarea.value = pastedText;
  return qualificationSurface.invoke(action).then(() => qualificationSurface.snapshot());
}

function surfaceStatus(state, title, explanation, availableActions) {
  return Object.freeze({ authority: "none", state, title, explanation, available_actions: Object.freeze(availableActions), direct_artifact: null, encrypted_file_fallback_available: true, technical_diagnostic_code: null });
}

export async function createSlice3VectorActual(inputs) {
  const provider = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  const descriptor = inputs.payload_descriptor;
  if (descriptor.encoding !== "counter_modulo") throw new Error("Unknown test-only payload descriptor.");
  const payload = Uint8Array.from({ length: descriptor.length }, (_, index) => index % descriptor.modulo);
  const prepared = await prepareHc3DirectTransfer({
    connection_attempt_id: fromHex(inputs.connection_attempt_id_hex), transfer_id: fromHex(inputs.transfer_id_hex),
    exact_bytes: payload, sha256_provider: provider
  });
  return clean({
    frame_payload_limit: hc3DirectLimits.maximum_frame_payload_bytes,
    payload_sha256: toHex(prepared.transfer_sha256), frame_count: prepared.frame_count,
    frame_lengths: prepared.frames.map((frame) => frame.length),
    frame_sha256: await Promise.all(prepared.frames.map(async (frame) => toHex(await provider(frame)))),
    frame_prefix_hex: prepared.frames.map((frame) => toHex(frame.slice(0, 24))),
    descriptions: await Promise.all(inputs.descriptions.map(async (item) => {
      const encoded = encodeHc3DirectDescription({ description_kind: item.kind, sdp: item.sdp });
      return { kind: item.kind, canonical_bytes: encoded.length, sha256: toHex(await provider(encoded)) };
    }))
  });
}

export async function initializeDirectTransport(sessionId) {
  const cryptoContext = slice7CryptoContext();
  const peer = [...cryptoContext.peers.values()][0];
  if (!peer) throw new Error("Direct qualification requires an accepted peer.");
  const binding = await slice7AcceptedBinding();
  const signatures = new NativeEd25519SignatureProvider(cryptoContext.registry);
  const evidence = { configurations: [], authority_boundaries: [], offers: [], answers: [], attempts: [], sent: [], received: [], interrupted: 0 };
  const authority = {
    async revalidate(input) {
      evidence.authority_boundaries.push(input.boundary);
      const current = await slice7AcceptedBinding();
      if (current.revoked) return { status: "rejected", reason: "revoked_device" };
      if (input.project_id !== current.project_id) return { status: "rejected", reason: "project_mismatch" };
      if (input.local_device_id !== cryptoContext.own.device || input.peer_device_id !== peer.device) return { status: "rejected", reason: "unknown_device" };
      const acceptedSigner = {
        resolution: "accepted_control_state", project_id: current.project_id, device_id: peer.device,
        key_id: peer.signing, control_head_id: current.accepted_control_head_id, algorithm: "ed25519",
        public_key_bytes: peer.signing_public
      };
      return {
        status: "current", project_id: current.project_id, local_device_id: cryptoContext.own.device, peer_device_id: peer.device,
        accepted_control_head_id: current.accepted_control_head_id, current_epoch_id: current.key_epoch_id,
        current_epoch_commitment_id: current.key_epoch_commitment,
        local_signing_key: cryptoContext.signing.handle, local_signer_key_id: cryptoContext.own.signing,
        peer_signer: acceptedSigner
      };
    }
  };
  const factory = {
    create(configuration) {
      if (!configuration || !Array.isArray(configuration.iceServers) || configuration.iceServers.length !== 0 || Object.keys(configuration).length !== 1) {
        throw new Error("Direct qualification requires the exact no-server peer configuration.");
      }
      evidence.configurations.push({ iceServers: [] });
      return new RTCPeerConnection({ iceServers: [] });
    }
  };
  const sha256Provider = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  const deadlines = {
    async run({ operation, task, on_deadline }) {
      let timeout = 0;
      const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => { on_deadline(); reject(new Error(`HC-3 direct ${operation} deadline expired.`)); }, 15_000);
      });
      try { return await Promise.race([task, expired]); }
      finally { clearTimeout(timeout); }
    }
  };
  direct = {
    cryptoContext, peer, binding, sessionId, signatures, authority, factory, sha256Provider, evidence,
    adapter: new Hc3ManualDirectConnectionAdapter({ factory, authority, signatures, sha256_provider: sha256Provider, deadlines }),
    offer: null, answer: null, connection: null, bytes: null
  };
  return clean({
    label: cryptoContext.label, project_id: binding.project_id, local_device_id: cryptoContext.own.device,
    peer_device_id: peer.device, session_id: sessionId,
    private_signing_key_non_extractable: cryptoContext.registry.resolveSigningKey(cryptoContext.signing.handle).extractable === false,
    direct_state_persisted: false
  });
}

export async function createDirectOffer(attemptHex) {
  const state = requireDirect();
  resetAttempt(state);
  const attempt = fromHex(attemptHex);
  state.offer = await state.adapter.createOffer({
    project_id: state.binding.project_id, local_device_id: state.cryptoContext.own.device, peer_device_id: state.peer.device,
    session_id: state.sessionId, session_generation: 0n, connection_attempt_id: attempt
  });
  state.evidence.attempts.push(attemptHex);
  state.evidence.offers.push({ description_bytes: state.offer.offer_description_bytes, sdp_utf8_bytes: state.offer.offer_sdp_utf8_bytes, candidate_utf8_bytes: state.offer.offer_candidate_utf8_bytes, text_characters: state.offer.offer_text.length });
  return clean({
    text: state.offer.offer_text,
    description_bytes: state.offer.offer_description_bytes,
    sdp_utf8_bytes: state.offer.offer_sdp_utf8_bytes,
    presentation: assessHc3DirectPresentation(state.offer.offer_text)
  });
}

export async function acceptDirectOffer(text) {
  const state = requireDirect();
  resetAttempt(state);
  state.answer = await state.adapter.acceptOffer({ offer_text: text, local_device_id: state.cryptoContext.own.device });
  state.evidence.attempts.push(toHex(state.answer.attempt_id));
  state.evidence.answers.push({ description_bytes: state.answer.answer_description_bytes, sdp_utf8_bytes: state.answer.answer_sdp_utf8_bytes, candidate_utf8_bytes: state.answer.answer_candidate_utf8_bytes, text_characters: state.answer.answer_text.length });
  return clean({
    text: state.answer.answer_text,
    description_bytes: state.answer.answer_description_bytes,
    sdp_utf8_bytes: state.answer.answer_sdp_utf8_bytes,
    presentation: assessHc3DirectPresentation(state.answer.answer_text)
  });
}

export async function completeAcceptedDirectOffer() {
  const state = requireDirect();
  if (!state.answer) throw new Error("No accepted direct offer is waiting for channel establishment.");
  state.connection = await state.adapter.completeAcceptedOffer({ answer: state.answer });
  state.bytes = new Hc3ReliableDirectByteChannel({ channel: state.connection.channel, connection_attempt_id: state.connection.attempt_id, sha256_provider: state.sha256Provider });
  return directConnectionEvidence();
}

export async function acceptDirectAnswer(text) {
  const state = requireDirect();
  if (!state.offer) throw new Error("No local direct offer is pending.");
  state.connection = await state.adapter.acceptAnswer({ offer: state.offer, answer_text: text, local_device_id: state.cryptoContext.own.device });
  state.bytes = new Hc3ReliableDirectByteChannel({ channel: state.connection.channel, connection_attempt_id: state.connection.attempt_id, sha256_provider: state.sha256Provider });
  return directConnectionEvidence();
}

export async function sendDirectV3(encoded) {
  const state = requireConnected();
  const exact = fromBase64(encoded);
  const digest = await state.sha256Provider(exact);
  const transfer = await prepareHc3DirectTransfer({ connection_attempt_id: state.connection.attempt_id, transfer_id: digest.slice(0, 16), exact_bytes: exact, sha256_provider: state.sha256Provider });
  const sent = await state.bytes.sendPreparedTransfer(transfer);
  state.evidence.sent.push({
    exact_bytes: exact.length, frame_count: sent.frame_count, sha256: toHex(digest), backpressure_wait_count: sent.backpressure_wait_count,
    minimum_encoded_frame_bytes: Math.min(...transfer.frames.map((frame) => frame.length)),
    maximum_encoded_frame_bytes: Math.max(...transfer.frames.map((frame) => frame.length))
  });
  return clean({ ...sent, sha256: toHex(digest) });
}

export async function receiveDirectV3() {
  const state = requireConnected();
  const received = await state.bytes.receiveTransfer();
  state.evidence.received.push({ exact_bytes: received.exact_bytes.length, sha256: toHex(received.sha256) });
  return clean({ encoded: base64(received.exact_bytes), exact_bytes: received.exact_bytes.length, sha256: toHex(received.sha256) });
}

export async function interruptDirectV3(encoded) {
  const state = requireConnected();
  const exact = fromBase64(encoded);
  const digest = await state.sha256Provider(exact);
  const transfer = await prepareHc3DirectTransfer({ connection_attempt_id: state.connection.attempt_id, transfer_id: digest.slice(0, 16), exact_bytes: exact, sha256_provider: state.sha256Provider });
  if (transfer.frame_count < 2) throw new Error("Interruption evidence requires a multi-frame V3 bundle.");
  const first = Uint8Array.from(transfer.frames[0]);
  state.connection.channel.send(first.buffer);
  state.evidence.interrupted += 1;
  state.connection.peer.close();
  return clean({ exact_bytes: exact.length, sent_frames: 1, total_frames: transfer.frame_count, sha256: toHex(digest) });
}

export async function expectInterruptedReceive() {
  const state = requireDirect();
  try {
    await state.bytes.receiveTransfer();
    return { status: "unexpected_complete" };
  } catch (error) {
    return { status: "interrupted", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

export function closeDirectTransport() {
  const state = requireDirect();
  const evidence = directConnectionEvidence();
  resetAttempt(state);
  return clean({ ...evidence, closed: true, direct_state_persisted: false });
}

export function directConnectionEvidence() {
  const state = requireDirect();
  const channel = state.connection?.channel ?? null;
  return clean({
    connected: channel?.readyState === "open",
    label: channel?.label ?? null,
    protocol: channel?.protocol ?? null,
    ordered: channel?.ordered ?? null,
    max_retransmits: channel?.maxRetransmits ?? null,
    max_packet_lifetime: channel?.maxPacketLifeTime ?? null,
    binary_type: channel?.binaryType ?? null,
    configurations: state.evidence.configurations,
    authority_boundaries: state.evidence.authority_boundaries,
    offers: state.evidence.offers,
    answers: state.evidence.answers,
    attempts: state.evidence.attempts,
    sent: state.evidence.sent,
    received: state.evidence.received,
    interrupted: state.evidence.interrupted,
    backpressure_wait_count: state.bytes?.backpressureWaitCount ?? 0,
    frame_payload_limit: hc3DirectLimits.maximum_frame_payload_bytes
  });
}

function resetAttempt(state) {
  try { state.bytes?.close(); } catch { /* explicit qualification cleanup */ }
  try { state.connection?.peer?.close(); } catch { /* explicit qualification cleanup */ }
  try { state.offer?.peer?.close(); } catch { /* explicit qualification cleanup */ }
  try { state.answer?.peer?.close(); } catch { /* explicit qualification cleanup */ }
  state.offer = null; state.answer = null; state.connection = null; state.bytes = null;
}
function requireDirect() { if (!direct) throw new Error("Direct transport is not initialized."); return direct; }
function requireConnected() { const state = requireDirect(); if (!state.connection || !state.bytes) throw new Error("Direct transport is not connected."); return state; }
function fromHex(value) { if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Attempt identity must be 16 lowercase-hex bytes."); return Uint8Array.from(value.match(/../g), (child) => Number.parseInt(child, 16)); }
function toHex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64(bytes) { let text = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(text); }
function fromBase64(value) { const text = atob(value); return Uint8Array.from(text, (child) => child.charCodeAt(0)); }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }

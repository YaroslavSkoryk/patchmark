import type { DeviceId, ProjectId } from "../identities.ts";
import { sha256, type Sha256Provider } from "../sha256.ts";
import type { UInt64 } from "../validation.ts";
import type { SignatureProvider } from "../hc2/crypto-contracts.ts";
import type { SyncSessionIdV3 } from "../hc2/sync-v3-identities.ts";
import {
  buildHc3ConnectionOfferCommitmentPreimage,
  createHc3ConnectionAnswer,
  createHc3ConnectionOffer,
  type Hc3ConnectionAnswerCarrier,
  type Hc3ConnectionOfferCarrier
} from "./contracts.ts";
import { decodeHc3DirectDescription, encodeHc3DirectDescription } from "./direct-description.ts";
import {
  createHc3AuthenticatedConnectionAnswer,
  createHc3AuthenticatedConnectionOffer,
  formatHc3DirectAuthText,
  parseHc3DirectAuthText,
  verifyHc3AuthenticatedConnectionAtBoundary,
  type Hc3AuthenticatedConnectionAnswer,
  type Hc3AuthenticatedConnectionOffer,
  type Hc3DirectAuthorityPort,
  type Hc3DirectAuthText,
  type Hc3DirectCurrentAuthority
} from "./direct-auth.ts";
import type { Hc3DirectDataChannelPort, Hc3DirectEvent } from "./direct-byte-channel.ts";
import {
  HC3_DIRECT_CHANNEL_LABEL,
  HC3_DIRECT_CHANNEL_PROTOCOL,
  hc3DirectTransportAdapterTag
} from "./direct-versions.ts";

export type Hc3SessionDescription = Readonly<{ type: "offer" | "answer"; sdp: string }>;
export type Hc3DataChannelEvent = Hc3DirectEvent & Readonly<{ channel: Hc3DirectDataChannelPort }>;

export interface Hc3PeerConnectionPort {
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly connectionState: "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
  readonly localDescription: Hc3SessionDescription | null;
  createDataChannel(label: string, options: Readonly<{ ordered: true; protocol: string }>): Hc3DirectDataChannelPort;
  createOffer(): Promise<Hc3SessionDescription>;
  createAnswer(): Promise<Hc3SessionDescription>;
  setLocalDescription(description: Hc3SessionDescription): Promise<void>;
  setRemoteDescription(description: Hc3SessionDescription): Promise<void>;
  close(): void;
  addEventListener(type: string, listener: (event: Hc3DirectEvent | Hc3DataChannelEvent) => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: string, listener: (event: Hc3DirectEvent | Hc3DataChannelEvent) => void): void;
}

export interface Hc3PeerConnectionFactory {
  create(configuration: Readonly<{ iceServers: readonly never[] }>): Hc3PeerConnectionPort;
}

export interface Hc3DirectDeadlinePort {
  run<T>(input: Readonly<{
    operation: "create_offer" | "set_remote_offer" | "create_answer" | "accept_answer" | "wait_for_channel";
    task: Promise<T>;
    on_deadline(): void;
  }>): Promise<T>;
}

export type Hc3DirectConnectionHandle = Readonly<{
  attempt_id: Uint8Array;
  peer: Hc3PeerConnectionPort;
  channel: Hc3DirectDataChannelPort;
}>;

export type Hc3DirectOfferResult = Hc3DirectConnectionHandle & Readonly<{
  authenticated_offer: Hc3AuthenticatedConnectionOffer;
  offer_text: Hc3DirectAuthText;
  offer_description_bytes: number;
  offer_sdp_utf8_bytes: number;
  offer_candidate_utf8_bytes: readonly number[];
}>;

export type Hc3DirectAnswerResult = Readonly<{
  attempt_id: Uint8Array;
  peer: Hc3PeerConnectionPort;
  channel_ready: Promise<Hc3DirectDataChannelPort>;
  authenticated_offer: Hc3AuthenticatedConnectionOffer;
  authenticated_answer: Hc3AuthenticatedConnectionAnswer;
  answer_text: Hc3DirectAuthText;
  answer_description_bytes: number;
  answer_sdp_utf8_bytes: number;
  answer_candidate_utf8_bytes: readonly number[];
}>;

export class Hc3ManualDirectConnectionAdapter {
  readonly #factory: Hc3PeerConnectionFactory;
  readonly #authority: Hc3DirectAuthorityPort;
  readonly #signatures: SignatureProvider;
  readonly #sha256Provider: Sha256Provider;
  readonly #deadlines: Hc3DirectDeadlinePort;

  constructor(input: Readonly<{
    factory: Hc3PeerConnectionFactory;
    authority: Hc3DirectAuthorityPort;
    signatures: SignatureProvider;
    sha256_provider: Sha256Provider;
    deadlines: Hc3DirectDeadlinePort;
  }>) {
    this.#factory = input.factory;
    this.#authority = input.authority;
    this.#signatures = input.signatures;
    this.#sha256Provider = input.sha256_provider;
    if (!input.deadlines?.run) throw new Error("HC-3 direct adapter requires an injected explicit deadline port.");
    this.#deadlines = input.deadlines;
  }

  async createOffer(input: Readonly<{
    project_id: ProjectId;
    local_device_id: DeviceId;
    peer_device_id: DeviceId;
    session_id: SyncSessionIdV3;
    session_generation: UInt64;
    connection_attempt_id: Uint8Array;
  }>): Promise<Hc3DirectOfferResult> {
    const authority = await this.#requireCurrent({ ...input, boundary: "before_peer_connection" });
    const peer = this.#factory.create(Object.freeze({ iceServers: Object.freeze([]) }));
    try {
      const channel = peer.createDataChannel(HC3_DIRECT_CHANNEL_LABEL, Object.freeze({ ordered: true, protocol: HC3_DIRECT_CHANNEL_PROTOCOL }));
      const offer = await this.#bounded("create_offer", peer.createOffer(), peer);
      await this.#bounded("create_offer", peer.setLocalDescription(offer), peer);
      await this.#bounded("create_offer", waitForIceCompletion(peer), peer);
      const description = exactLocalDescription(peer, "offer");
      const descriptionBytes = encodeHc3DirectDescription({ description_kind: "offer", sdp: description.sdp });
      const carrier = createHc3ConnectionOffer({
        session_id: input.session_id,
        session_generation: input.session_generation,
        transport_adapter_tag: hc3DirectTransportAdapterTag(),
        transport_description_bytes: descriptionBytes
      });
      const authenticated = await createHc3AuthenticatedConnectionOffer({
        carrier,
        project_id: input.project_id,
        connection_attempt_id: input.connection_attempt_id,
        authority,
        signatures: this.#signatures
      });
      return Object.freeze({
        attempt_id: Uint8Array.from(input.connection_attempt_id), peer, channel,
        authenticated_offer: authenticated, offer_text: formatHc3DirectAuthText(authenticated),
        offer_description_bytes: descriptionBytes.length,
        offer_sdp_utf8_bytes: new TextEncoder().encode(description.sdp).length,
        offer_candidate_utf8_bytes: candidateUtf8Sizes(description.sdp)
      });
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  async acceptOffer(input: Readonly<{
    offer_text: string;
    local_device_id: DeviceId;
  }>): Promise<Hc3DirectAnswerResult> {
    const parsedText = parseHc3DirectAuthText(input.offer_text);
    const verified = await verifyHc3AuthenticatedConnectionAtBoundary({
      value: parsedText.record, expected_kind: "connection_offer", local_device_id: input.local_device_id,
      authority: this.#authority, signatures: this.#signatures, sha256_provider: this.#sha256Provider,
      boundary: "before_peer_connection"
    });
    const authenticatedOffer = verified.record as Hc3AuthenticatedConnectionOffer;
    const offerCarrier = verified.carrier as Hc3ConnectionOfferCarrier;
    const offerDescription = decodeHc3DirectDescription(offerCarrier.transport_description_bytes, "offer");
    const peer = this.#factory.create(Object.freeze({ iceServers: Object.freeze([]) }));
    try {
      const channelPromise = waitForDataChannel(peer);
      await this.#bounded("set_remote_offer", peer.setRemoteDescription(Object.freeze({ type: "offer", sdp: offerDescription.sdp })), peer);
      const answer = await this.#bounded("create_answer", peer.createAnswer(), peer);
      await this.#bounded("create_answer", peer.setLocalDescription(answer), peer);
      await this.#bounded("create_answer", waitForIceCompletion(peer), peer);
      const description = exactLocalDescription(peer, "answer");
      const descriptionBytes = encodeHc3DirectDescription({ description_kind: "answer", sdp: description.sdp });
      const offerCommitment = await sha256(buildHc3ConnectionOfferCommitmentPreimage(offerCarrier), this.#sha256Provider);
      const carrier = createHc3ConnectionAnswer({
        session_id: offerCarrier.session_id,
        session_generation: offerCarrier.session_generation,
        transport_adapter_tag: hc3DirectTransportAdapterTag(),
        transport_description_bytes: descriptionBytes,
        offer_commitment_sha256: offerCommitment
      });
      const authenticatedAnswer = await createHc3AuthenticatedConnectionAnswer({
        carrier, authenticated_offer: authenticatedOffer, authority: verified.authority,
        signatures: this.#signatures, sha256_provider: this.#sha256Provider
      });
      return Object.freeze({
        attempt_id: Uint8Array.from(authenticatedOffer.connection_attempt_id), peer, channel_ready: channelPromise,
        authenticated_offer: authenticatedOffer, authenticated_answer: authenticatedAnswer,
        answer_text: formatHc3DirectAuthText(authenticatedAnswer),
        answer_description_bytes: descriptionBytes.length,
        answer_sdp_utf8_bytes: new TextEncoder().encode(description.sdp).length,
        answer_candidate_utf8_bytes: candidateUtf8Sizes(description.sdp)
      });
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  async completeAcceptedOffer(input: Readonly<{ answer: Hc3DirectAnswerResult }>): Promise<Hc3DirectConnectionHandle> {
    const channel = await this.#bounded("wait_for_channel", input.answer.channel_ready, input.answer.peer);
    await this.#bounded("wait_for_channel", waitForChannelOpen(channel), input.answer.peer);
    return Object.freeze({ attempt_id: Uint8Array.from(input.answer.attempt_id), peer: input.answer.peer, channel });
  }

  async acceptAnswer(input: Readonly<{
    offer: Hc3DirectOfferResult;
    answer_text: string;
    local_device_id: DeviceId;
  }>): Promise<Hc3DirectConnectionHandle> {
    const parsedText = parseHc3DirectAuthText(input.answer_text);
    const verified = await verifyHc3AuthenticatedConnectionAtBoundary({
      value: parsedText.record, expected_kind: "connection_answer", local_device_id: input.local_device_id,
      authority: this.#authority, signatures: this.#signatures, sha256_provider: this.#sha256Provider,
      authenticated_offer: input.offer.authenticated_offer, boundary: "before_peer_connection"
    });
    if (!sameBytes(verified.record.connection_attempt_id, input.offer.attempt_id)) throw new Error("HC-3 direct answer belongs to a different connection attempt.");
    const carrier = verified.carrier as Hc3ConnectionAnswerCarrier;
    const description = decodeHc3DirectDescription(carrier.transport_description_bytes, "answer");
    await this.#bounded("accept_answer", input.offer.peer.setRemoteDescription(Object.freeze({ type: "answer", sdp: description.sdp })), input.offer.peer);
    await this.#bounded("wait_for_channel", waitForChannelOpen(input.offer.channel), input.offer.peer);
    return Object.freeze({ attempt_id: Uint8Array.from(input.offer.attempt_id), peer: input.offer.peer, channel: input.offer.channel });
  }

  async #requireCurrent(input: Readonly<{
    project_id: ProjectId;
    local_device_id: DeviceId;
    peer_device_id: DeviceId;
    boundary: "before_peer_connection";
  }>): Promise<Hc3DirectCurrentAuthority> {
    const current = await this.#authority.revalidate(input);
    if (current.status !== "current") throw new Error(`HC-3 direct authority revalidation failed: ${current.reason}.`);
    if (current.project_id !== input.project_id || current.local_device_id !== input.local_device_id || current.peer_device_id !== input.peer_device_id) {
      throw new Error("HC-3 direct current authority evidence does not match requested endpoints.");
    }
    return current;
  }

  #bounded<T>(operation: Parameters<Hc3DirectDeadlinePort["run"]>[0]["operation"], task: Promise<T>, peer: Hc3PeerConnectionPort): Promise<T> {
    return this.#deadlines.run({ operation, task, on_deadline() { peer.close(); } });
  }
}

export function classifyHc3SimultaneousOffers(
  localOffer: Hc3AuthenticatedConnectionOffer,
  remoteOffer: Hc3AuthenticatedConnectionOffer
): Readonly<{
  state: "simultaneous_offer_conflict";
  automatic_winner: null;
  required_action: "cancel_one_attempt_and_create_fresh_offer";
}> {
  if (sameBytes(localOffer.connection_attempt_id, remoteOffer.connection_attempt_id)) throw new Error("Identical offer attempts are a replay, not simultaneous offers.");
  return Object.freeze({ state: "simultaneous_offer_conflict", automatic_winner: null, required_action: "cancel_one_attempt_and_create_fresh_offer" });
}

function waitForIceCompletion(peer: Hc3PeerConnectionPort): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener("icegatheringstatechange", listener);
      peer.removeEventListener("connectionstatechange", listener);
    };
    const listener = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        cleanup();
        reject(new Error("HC-3 direct local ICE gathering failed or closed."));
      }
    };
    peer.addEventListener("icegatheringstatechange", listener);
    peer.addEventListener("connectionstatechange", listener);
    listener();
  });
}

function waitForDataChannel(peer: Hc3PeerConnectionPort): Promise<Hc3DirectDataChannelPort> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener("datachannel", listener);
      peer.removeEventListener("connectionstatechange", onState);
    };
    const listener = (event: Hc3DirectEvent | Hc3DataChannelEvent) => {
      cleanup();
      if (!("channel" in event) || event.channel.label !== HC3_DIRECT_CHANNEL_LABEL || event.channel.protocol !== HC3_DIRECT_CHANNEL_PROTOCOL) {
        reject(new Error("HC-3 direct answer received an unexpected channel profile."));
      } else resolve(event.channel);
    };
    const onState = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        cleanup();
        reject(new Error("HC-3 direct peer closed before receiving its fixed data channel."));
      }
    };
    peer.addEventListener("datachannel", listener);
    peer.addEventListener("connectionstatechange", onState);
  });
}

function waitForChannelOpen(channel: Hc3DirectDataChannelPort): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("HC-3 direct data channel closed before opening.")); };
    const cleanup = () => { channel.removeEventListener("open", onOpen); channel.removeEventListener("close", onClose); };
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
}

function exactLocalDescription(peer: Hc3PeerConnectionPort, expected: "offer" | "answer"): Hc3SessionDescription {
  const description = peer.localDescription;
  if (!description || description.type !== expected || typeof description.sdp !== "string" || !description.sdp) throw new Error("HC-3 direct local description is absent or has the wrong type.");
  return Object.freeze({ type: expected, sdp: description.sdp });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function candidateUtf8Sizes(sdp: string): readonly number[] {
  return Object.freeze(sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:")).map((line) => new TextEncoder().encode(line).length));
}

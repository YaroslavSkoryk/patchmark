import {
  canonicalArray,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import {
  canonicalProtocolValue,
  protocolValueFromCanonical
} from "../canonical-protocol.ts";
import {
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectUInt64,
  freezeRecord,
  type UInt64
} from "../validation.ts";
import {
  parseEnrollmentRequestRecord,
  parseInvitationHandoffCore,
  parsePossessionProofRecord,
  type EnrollmentRequestRecord,
  type InvitationHandoffCore,
  type PossessionProofRecord
} from "../hc2/enrollment-contracts.ts";
import { hc2ProtocolLimits } from "../hc2/limits.ts";
import {
  parseSyncV3Id,
  type SyncSessionIdV3
} from "../hc2/sync-v3-identities.ts";
import {
  HC3_CARRIER_VERSION,
  HC3_CONNECTION_OFFER_COMMITMENT_DOMAIN,
  hc3CarrierLimits,
  hc3ConnectionArtifactKinds,
  hc3HandoffArtifactKinds,
  type Hc3ArtifactKind,
  type Hc3ConnectionArtifactKind,
  type Hc3HandoffArtifactKind
} from "./versions.ts";

declare const hc3CarrierBrand: unique symbol;
declare const hc3OfferPreimageBrand: unique symbol;

type HandoffPayloadByKind = Readonly<{
  invitation_handoff: InvitationHandoffCore;
  enrollment_request: EnrollmentRequestRecord;
  possession_proof: PossessionProofRecord;
}>;

export type Hc3HandoffCarrier<TKind extends Hc3HandoffArtifactKind = Hc3HandoffArtifactKind> = Readonly<{
  artifact_version: typeof HC3_CARRIER_VERSION;
  record_kind: "hc3_handoff_carrier";
  artifact_kind: TKind;
  authority: "none";
  payload_protocol: "hc2";
  payload_encoding: "canonical_cbor";
  payload_bytes: Uint8Array;
  readonly [hc3CarrierBrand]: TKind;
}>;

type ConnectionCarrierFields<TKind extends Hc3ConnectionArtifactKind> = Readonly<{
  artifact_version: typeof HC3_CARRIER_VERSION;
  record_kind: "hc3_connection_carrier";
  artifact_kind: TKind;
  authority: "none";
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  transport_adapter_tag: Uint8Array;
  transport_description_bytes: Uint8Array;
  offer_commitment_sha256: TKind extends "connection_offer" ? null : Uint8Array;
  readonly [hc3CarrierBrand]: TKind;
}>;

export type Hc3ConnectionOfferCarrier = ConnectionCarrierFields<"connection_offer">;
export type Hc3ConnectionAnswerCarrier = ConnectionCarrierFields<"connection_answer">;
export type Hc3ConnectionCarrier = Hc3ConnectionOfferCarrier | Hc3ConnectionAnswerCarrier;
export type Hc3Carrier = Hc3HandoffCarrier | Hc3ConnectionCarrier;

export type Hc3ConnectionOfferCommitmentPreimage = Uint8Array & {
  readonly [hc3OfferPreimageBrand]: "connection-offer-commitment";
};

export function createHc3HandoffCarrier<TKind extends Hc3HandoffArtifactKind>(input: Readonly<{
  artifact_kind: TKind;
  payload: HandoffPayloadByKind[TKind];
}>): Hc3HandoffCarrier<TKind> {
  const payload = parseHandoffPayload(input.artifact_kind, input.payload);
  return parseHc3HandoffCarrier({
    artifact_version: HC3_CARRIER_VERSION,
    record_kind: "hc3_handoff_carrier",
    artifact_kind: input.artifact_kind,
    authority: "none",
    payload_protocol: "hc2",
    payload_encoding: "canonical_cbor",
    payload_bytes: encodeCanonicalCbor(canonicalProtocolValue(payload))
  }) as Hc3HandoffCarrier<TKind>;
}

export function parseHc3HandoffCarrier(value: unknown): Hc3HandoffCarrier {
  const record = expectExactRecord(value, "HC-3 handoff carrier", [
    "artifact_version", "record_kind", "artifact_kind", "authority",
    "payload_protocol", "payload_encoding", "payload_bytes"
  ]);
  const artifactKind = expectEnum(record.artifact_kind, hc3HandoffArtifactKinds, "HC-3 handoff artifact kind");
  const payloadBytes = boundedBytes(record.payload_bytes, payloadMaximum(artifactKind), "HC-3 handoff payload");
  const payload = parseHandoffPayload(
    artifactKind,
    protocolValueFromCanonical(decodeCanonicalCbor(payloadBytes))
  );
  if (!sameBytes(payloadBytes, encodeCanonicalCbor(canonicalProtocolValue(payload)))) {
    throw new Error("HC-3 handoff payload differs from the exact canonical HC-2 record.");
  }
  return freezeRecord({
    artifact_version: expectLiteral(record.artifact_version, HC3_CARRIER_VERSION, "HC-3 carrier version"),
    record_kind: expectLiteral(record.record_kind, "hc3_handoff_carrier", "HC-3 handoff carrier kind"),
    artifact_kind: artifactKind,
    authority: expectLiteral(record.authority, "none", "HC-3 carrier authority"),
    payload_protocol: expectLiteral(record.payload_protocol, "hc2", "HC-3 payload protocol"),
    payload_encoding: expectLiteral(record.payload_encoding, "canonical_cbor", "HC-3 payload encoding"),
    payload_bytes: Uint8Array.from(payloadBytes)
  }) as Hc3HandoffCarrier;
}

export function extractHc2HandoffPayload<TKind extends Hc3HandoffArtifactKind>(
  carrier: Hc3HandoffCarrier<TKind>
): HandoffPayloadByKind[TKind] {
  const parsed = parseHc3HandoffCarrier(carrier);
  const value = protocolValueFromCanonical(decodeCanonicalCbor(parsed.payload_bytes));
  return parseHandoffPayload(parsed.artifact_kind, value) as HandoffPayloadByKind[TKind];
}

export function createHc3ConnectionOffer(input: Readonly<{
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  transport_adapter_tag: Uint8Array;
  transport_description_bytes: Uint8Array;
}>): Hc3ConnectionOfferCarrier {
  return parseHc3ConnectionCarrier({
    artifact_version: HC3_CARRIER_VERSION,
    record_kind: "hc3_connection_carrier",
    artifact_kind: "connection_offer",
    authority: "none",
    session_id: input.session_id,
    session_generation: input.session_generation,
    transport_adapter_tag: input.transport_adapter_tag,
    transport_description_bytes: input.transport_description_bytes,
    offer_commitment_sha256: null
  }) as Hc3ConnectionOfferCarrier;
}

export function createHc3ConnectionAnswer(input: Readonly<{
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  transport_adapter_tag: Uint8Array;
  transport_description_bytes: Uint8Array;
  offer_commitment_sha256: Uint8Array;
}>): Hc3ConnectionAnswerCarrier {
  return parseHc3ConnectionCarrier({
    artifact_version: HC3_CARRIER_VERSION,
    record_kind: "hc3_connection_carrier",
    artifact_kind: "connection_answer",
    authority: "none",
    session_id: input.session_id,
    session_generation: input.session_generation,
    transport_adapter_tag: input.transport_adapter_tag,
    transport_description_bytes: input.transport_description_bytes,
    offer_commitment_sha256: input.offer_commitment_sha256
  }) as Hc3ConnectionAnswerCarrier;
}

export function parseHc3ConnectionCarrier(value: unknown): Hc3ConnectionCarrier {
  const record = expectExactRecord(value, "HC-3 connection carrier", [
    "artifact_version", "record_kind", "artifact_kind", "authority",
    "session_id", "session_generation", "transport_adapter_tag",
    "transport_description_bytes", "offer_commitment_sha256"
  ]);
  const artifactKind = expectEnum(record.artifact_kind, hc3ConnectionArtifactKinds, "HC-3 connection artifact kind");
  const adapterTag = boundedNonemptyBytes(
    record.transport_adapter_tag,
    hc3CarrierLimits.maximum_transport_adapter_tag_bytes,
    "HC-3 transport adapter tag"
  );
  const description = boundedNonemptyBytes(
    record.transport_description_bytes,
    hc3CarrierLimits.maximum_connection_description_bytes,
    "HC-3 opaque transport description"
  );
  const commitment = artifactKind === "connection_offer"
    ? expectLiteral(record.offer_commitment_sha256, null, "connection-offer commitment")
    : exactDigest(record.offer_commitment_sha256, "connection-answer offer commitment");
  return freezeRecord({
    artifact_version: expectLiteral(record.artifact_version, HC3_CARRIER_VERSION, "HC-3 carrier version"),
    record_kind: expectLiteral(record.record_kind, "hc3_connection_carrier", "HC-3 connection carrier kind"),
    artifact_kind: artifactKind,
    authority: expectLiteral(record.authority, "none", "HC-3 carrier authority"),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "HC-3 connection session generation"),
    transport_adapter_tag: adapterTag,
    transport_description_bytes: description,
    offer_commitment_sha256: commitment
  }) as Hc3ConnectionCarrier;
}

export function buildHc3ConnectionOfferCommitmentPreimage(
  value: Hc3ConnectionOfferCarrier
): Hc3ConnectionOfferCommitmentPreimage {
  const offer = parseHc3ConnectionCarrier(value);
  if (offer.artifact_kind !== "connection_offer") throw new Error("Only a connection offer has an offer-commitment preimage.");
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(HC3_CONNECTION_OFFER_COMMITMENT_DOMAIN),
    canonicalProtocolValue(offer)
  ]))) as Hc3ConnectionOfferCommitmentPreimage;
}

export function assertHc3ConnectionAnswerBinding(input: Readonly<{
  offer: Hc3ConnectionOfferCarrier;
  answer: Hc3ConnectionAnswerCarrier;
  expected_offer_commitment_sha256: Uint8Array;
}>): void {
  const offer = parseHc3ConnectionCarrier(input.offer);
  const answer = parseHc3ConnectionCarrier(input.answer);
  const expected = exactDigest(input.expected_offer_commitment_sha256, "expected connection-offer commitment");
  if (offer.artifact_kind !== "connection_offer" || answer.artifact_kind !== "connection_answer" ||
      offer.session_id !== answer.session_id || offer.session_generation !== answer.session_generation ||
      !sameBytes(offer.transport_adapter_tag, answer.transport_adapter_tag) ||
      !sameBytes(answer.offer_commitment_sha256, expected)) {
    throw new Error("Connection answer does not bind the exact offer, session, generation, and adapter.");
  }
}

export function parseHc3Carrier(value: unknown): Hc3Carrier {
  const kind = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>).record_kind
    : undefined;
  if (kind === "hc3_handoff_carrier") return parseHc3HandoffCarrier(value);
  if (kind === "hc3_connection_carrier") return parseHc3ConnectionCarrier(value);
  throw new Error("Unknown HC-3 carrier record kind.");
}

export function encodeHc3Carrier(value: Hc3Carrier): Uint8Array {
  const encoded = encodeCanonicalCbor(canonicalProtocolValue(parseHc3Carrier(value)));
  if (encoded.length > hc3CarrierLimits.maximum_carrier_canonical_bytes) {
    throw new Error("HC-3 carrier exceeds its canonical byte limit.");
  }
  return Uint8Array.from(encoded);
}

export function decodeHc3Carrier(value: Uint8Array): Hc3Carrier {
  const bytes = boundedNonemptyBytes(value, hc3CarrierLimits.maximum_carrier_canonical_bytes, "HC-3 carrier bytes");
  const parsed = parseHc3Carrier(normalizeDecodedIntegers(protocolValueFromCanonical(decodeCanonicalCbor(bytes))));
  if (!sameBytes(bytes, encodeHc3Carrier(parsed))) throw new Error("HC-3 carrier is not its exact canonical encoding.");
  return parsed;
}

export function hc3ArtifactKind(value: Hc3Carrier): Hc3ArtifactKind {
  return parseHc3Carrier(value).artifact_kind;
}

export function assertHc3CarrierExcludesUtf8Sentinels(
  value: Hc3Carrier,
  forbiddenUtf8: readonly string[]
): void {
  if (!Array.isArray(forbiddenUtf8)) throw new Error("HC-3 privacy sentinels must be an array.");
  const encoded = encodeHc3Carrier(value);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(encoded);
  for (const forbidden of forbiddenUtf8) {
    if (typeof forbidden !== "string") throw new Error("HC-3 privacy sentinels must be strings.");
    if (forbidden && text.includes(forbidden)) throw new Error("HC-3 carrier exposes a forbidden privacy sentinel.");
  }
}

function parseHandoffPayload<TKind extends Hc3HandoffArtifactKind>(kind: TKind, value: unknown): HandoffPayloadByKind[TKind] {
  switch (kind) {
    case "invitation_handoff":
      return parseInvitationHandoffCore(value) as HandoffPayloadByKind[TKind];
    case "enrollment_request":
      return parseEnrollmentRequestRecord(value) as HandoffPayloadByKind[TKind];
    case "possession_proof":
      return parsePossessionProofRecord(value) as HandoffPayloadByKind[TKind];
  }
}

function payloadMaximum(kind: Hc3HandoffArtifactKind): number {
  return kind === "invitation_handoff"
    ? Number(hc2ProtocolLimits.maximum_invitation_handoff_canonical_bytes)
    : Number(hc2ProtocolLimits.maximum_enrollment_record_canonical_bytes);
}

function boundedBytes(value: unknown, maximum: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array.`);
  if (value.byteLength > maximum) throw new Error(`${label} exceeds its byte limit.`);
  return Uint8Array.from(value);
}

function boundedNonemptyBytes(value: unknown, maximum: number, label: string): Uint8Array {
  const bytes = boundedBytes(value, maximum, label);
  if (bytes.length === 0) throw new Error(`${label} must not be empty.`);
  return bytes;
}

function exactDigest(value: unknown, label: string): Uint8Array {
  const bytes = expectBytes(value, label);
  if (bytes.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`);
  return Uint8Array.from(bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function normalizeDecodedIntegers(value: unknown, key?: string): unknown {
  if (typeof value === "number" && key === "session_generation") return BigInt(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeDecodedIntegers(entry));
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeDecodedIntegers(child, childKey)]));
  }
  return value;
}

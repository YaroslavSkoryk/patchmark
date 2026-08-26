import { canonicalArray, canonicalText, decodeCanonicalCbor, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import { parseDigestId, parseEntityId, type ControlEventId, type DeviceId, type KeyEpochCommitmentId, type KeyEpochId, type ProjectId, type PublicKeyId } from "../identities.ts";
import { sha256, type Sha256Provider } from "../sha256.ts";
import { expectBytes, expectEnum, expectExactRecord, expectLiteral, expectUInt64, freezeRecord, type UInt64 } from "../validation.ts";
import type {
  AcceptedSignerPublicKey,
  DeviceSigningPrivateKeyHandle,
  SenderSignaturePreimageBytes,
  SignatureProvider
} from "../hc2/crypto-contracts.ts";
import { parseSyncV3Id, type SyncSessionIdV3 } from "../hc2/sync-v3-identities.ts";
import {
  assertHc3ConnectionAnswerBinding,
  buildHc3ConnectionOfferCommitmentPreimage,
  decodeHc3Carrier,
  encodeHc3Carrier,
  type Hc3ConnectionAnswerCarrier,
  type Hc3ConnectionCarrier,
  type Hc3ConnectionOfferCarrier
} from "./contracts.ts";
import {
  HC3_DIRECT_ADAPTER_ID,
  HC3_DIRECT_ADAPTER_VERSION,
  HC3_DIRECT_ANSWER_SIGNATURE_DOMAIN,
  HC3_DIRECT_AUTH_VERSION,
  HC3_DIRECT_OFFER_RECORD_COMMITMENT_DOMAIN,
  HC3_DIRECT_OFFER_SIGNATURE_DOMAIN,
  hc3DirectLimits,
  hc3DirectTransportAdapterTag
} from "./direct-versions.ts";

declare const directAuthBrand: unique symbol;
declare const directAuthTextBrand: unique symbol;

export type Hc3DirectAuthKind = "connection_offer" | "connection_answer";

export type Hc3AuthenticatedConnectionRecord<TKind extends Hc3DirectAuthKind = Hc3DirectAuthKind> = Readonly<{
  schema_version: typeof HC3_DIRECT_AUTH_VERSION;
  record_kind: "hc3_authenticated_connection";
  artifact_kind: TKind;
  authority: "none";
  project_id: ProjectId;
  session_id: SyncSessionIdV3;
  session_generation: UInt64;
  connection_attempt_id: Uint8Array;
  initiating_device_id: DeviceId;
  responding_device_id: DeviceId;
  accepted_control_head_id: ControlEventId;
  current_epoch_id: KeyEpochId;
  current_epoch_commitment_id: KeyEpochCommitmentId;
  transport_adapter_id: typeof HC3_DIRECT_ADAPTER_ID;
  transport_adapter_version: typeof HC3_DIRECT_ADAPTER_VERSION;
  carrier_bytes: Uint8Array;
  offer_record_sha256: TKind extends "connection_offer" ? null : Uint8Array;
  signer_key_id: PublicKeyId;
  signature_algorithm: "ed25519";
  signature_bytes: Uint8Array;
  readonly [directAuthBrand]: TKind;
}>;

export type Hc3AuthenticatedConnectionOffer = Hc3AuthenticatedConnectionRecord<"connection_offer">;
export type Hc3AuthenticatedConnectionAnswer = Hc3AuthenticatedConnectionRecord<"connection_answer">;
export type Hc3DirectAuthText = string & { readonly [directAuthTextBrand]: "hc3-direct-auth-text" };

export type Hc3DirectCurrentAuthority = Readonly<{
  status: "current";
  project_id: ProjectId;
  local_device_id: DeviceId;
  peer_device_id: DeviceId;
  accepted_control_head_id: ControlEventId;
  current_epoch_id: KeyEpochId;
  current_epoch_commitment_id: KeyEpochCommitmentId;
  local_signing_key: DeviceSigningPrivateKeyHandle;
  local_signer_key_id: PublicKeyId;
  peer_signer: AcceptedSignerPublicKey;
}>;

export interface Hc3DirectAuthorityPort {
  revalidate(input: Readonly<{
    project_id: ProjectId;
    local_device_id: DeviceId;
    peer_device_id: DeviceId;
    boundary: "before_peer_connection" | "before_v3_prepare" | "before_v3_send" | "before_v3_import";
  }>): Promise<Hc3DirectCurrentAuthority | Readonly<{
    status: "rejected";
    reason: "revoked_device" | "stale_control_head" | "stale_epoch" | "key_mismatch" | "unknown_device" | "project_mismatch";
  }>>;
}

export async function createHc3AuthenticatedConnectionOffer(input: Readonly<{
  carrier: Hc3ConnectionOfferCarrier;
  project_id: ProjectId;
  connection_attempt_id: Uint8Array;
  authority: Hc3DirectCurrentAuthority;
  signatures: SignatureProvider;
}>): Promise<Hc3AuthenticatedConnectionOffer> {
  const carrier = decodeExpectedCarrier(encodeHc3Carrier(input.carrier), "connection_offer") as Hc3ConnectionOfferCarrier;
  const core = createCore({
    artifact_kind: "connection_offer",
    carrier,
    carrier_bytes: encodeHc3Carrier(carrier),
    project_id: input.project_id,
    connection_attempt_id: input.connection_attempt_id,
    authority: input.authority,
    offer_record_sha256: null
  });
  return signCore(core, input.authority, input.signatures) as Promise<Hc3AuthenticatedConnectionOffer>;
}

export async function createHc3AuthenticatedConnectionAnswer(input: Readonly<{
  carrier: Hc3ConnectionAnswerCarrier;
  authenticated_offer: Hc3AuthenticatedConnectionOffer;
  authority: Hc3DirectCurrentAuthority;
  signatures: SignatureProvider;
  sha256_provider: Sha256Provider;
}>): Promise<Hc3AuthenticatedConnectionAnswer> {
  const offer = parseHc3AuthenticatedConnectionRecord(input.authenticated_offer);
  if (offer.artifact_kind !== "connection_offer") throw new Error("HC-3 direct answer requires an authenticated offer.");
  const carrier = decodeExpectedCarrier(encodeHc3Carrier(input.carrier), "connection_answer") as Hc3ConnectionAnswerCarrier;
  const offerCarrier = decodeExpectedCarrier(offer.carrier_bytes, "connection_offer") as Hc3ConnectionOfferCarrier;
  const expectedCarrierCommitment = await sha256(buildHc3ConnectionOfferCommitmentPreimage(offerCarrier), input.sha256_provider);
  assertHc3ConnectionAnswerBinding({
    offer: offerCarrier,
    answer: carrier,
    expected_offer_commitment_sha256: expectedCarrierCommitment
  });
  const offerDigest = await authenticatedOfferDigest(offer as Hc3AuthenticatedConnectionOffer, input.sha256_provider);
  const core = createCore({
    artifact_kind: "connection_answer",
    carrier,
    carrier_bytes: encodeHc3Carrier(carrier),
    project_id: offer.project_id,
    connection_attempt_id: offer.connection_attempt_id,
    authority: input.authority,
    offer_record_sha256: offerDigest
  });
  return signCore(core, input.authority, input.signatures) as Promise<Hc3AuthenticatedConnectionAnswer>;
}

export async function verifyHc3AuthenticatedConnectionAtBoundary(input: Readonly<{
  value: unknown;
  expected_kind: Hc3DirectAuthKind;
  local_device_id: DeviceId;
  authority: Hc3DirectAuthorityPort;
  signatures: SignatureProvider;
  sha256_provider: Sha256Provider;
  authenticated_offer?: Hc3AuthenticatedConnectionOffer;
  boundary: Parameters<Hc3DirectAuthorityPort["revalidate"]>[0]["boundary"];
}>): Promise<Readonly<{
  status: "verified";
  record: Hc3AuthenticatedConnectionRecord;
  carrier: Hc3ConnectionCarrier;
  authority: Hc3DirectCurrentAuthority;
}>> {
  const record = parseHc3AuthenticatedConnectionRecord(input.value);
  if (record.artifact_kind !== input.expected_kind) throw new Error("HC-3 direct authenticated artifact kind is unexpected.");
  const expectedLocal = record.artifact_kind === "connection_offer" ? record.responding_device_id : record.initiating_device_id;
  const expectedPeer = record.artifact_kind === "connection_offer" ? record.initiating_device_id : record.responding_device_id;
  if (input.local_device_id !== expectedLocal) throw new Error("HC-3 direct authenticated artifact is not addressed to this device.");
  const current = await input.authority.revalidate({
    project_id: record.project_id,
    local_device_id: expectedLocal,
    peer_device_id: expectedPeer,
    boundary: input.boundary
  });
  if (current.status !== "current") throw new Error(`HC-3 direct authority revalidation failed: ${current.reason}.`);
  assertCurrentBinding(record, current);
  const verification = await input.signatures.verify({
    signer: current.peer_signer,
    preimage: signaturePreimage(record),
    signature_bytes: record.signature_bytes
  });
  if (verification.status !== "valid_signature") throw new Error(`HC-3 direct connection signature is ${verification.reason}.`);
  if (record.artifact_kind === "connection_answer") {
    if (!input.authenticated_offer) throw new Error("HC-3 direct answer verification requires the exact authenticated offer.");
    const offer = parseHc3AuthenticatedConnectionRecord(input.authenticated_offer);
    if (offer.artifact_kind !== "connection_offer") throw new Error("HC-3 direct answer has no authenticated offer.");
    const digest = await authenticatedOfferDigest(offer as Hc3AuthenticatedConnectionOffer, input.sha256_provider);
    if (!sameBytes(record.offer_record_sha256, digest)) throw new Error("HC-3 direct answer does not commit to the exact authenticated offer record.");
    const offerCarrier = decodeExpectedCarrier(offer.carrier_bytes, "connection_offer") as Hc3ConnectionOfferCarrier;
    const answerCarrier = decodeExpectedCarrier(record.carrier_bytes, "connection_answer") as Hc3ConnectionAnswerCarrier;
    const expectedCarrierCommitment = await sha256(buildHc3ConnectionOfferCommitmentPreimage(offerCarrier), input.sha256_provider);
    assertHc3ConnectionAnswerBinding({ offer: offerCarrier, answer: answerCarrier, expected_offer_commitment_sha256: expectedCarrierCommitment });
  }
  return freezeRecord({ status: "verified", record, carrier: decodeExpectedCarrier(record.carrier_bytes, record.artifact_kind), authority: current });
}

export function parseHc3AuthenticatedConnectionRecord(value: unknown): Hc3AuthenticatedConnectionRecord {
  const record = expectExactRecord(value, "HC-3 authenticated connection", [
    "schema_version", "record_kind", "artifact_kind", "authority", "project_id", "session_id", "session_generation",
    "connection_attempt_id", "initiating_device_id", "responding_device_id", "accepted_control_head_id", "current_epoch_id",
    "current_epoch_commitment_id", "transport_adapter_id", "transport_adapter_version", "carrier_bytes", "offer_record_sha256",
    "signer_key_id", "signature_algorithm", "signature_bytes"
  ]);
  const artifactKind = expectEnum(record.artifact_kind, ["connection_offer", "connection_answer"] as const, "HC-3 authenticated connection kind");
  const carrierBytes = boundedBytes(record.carrier_bytes, 1, 69_632, "HC-3 authenticated carrier bytes");
  const carrier = decodeExpectedCarrier(carrierBytes, artifactKind);
  if (!sameBytes(carrier.transport_adapter_tag, hc3DirectTransportAdapterTag())) {
    throw new Error("HC-3 authenticated connection carrier uses an unexpected adapter tag.");
  }
  const attempt = boundedBytes(record.connection_attempt_id, hc3DirectLimits.connection_attempt_id_bytes, hc3DirectLimits.connection_attempt_id_bytes, "HC-3 connection-attempt identity");
  const signature = boundedBytes(record.signature_bytes, hc3DirectLimits.signature_bytes, hc3DirectLimits.signature_bytes, "HC-3 direct signature");
  const offerDigest = artifactKind === "connection_offer"
    ? expectLiteral(record.offer_record_sha256, null, "HC-3 offer-record commitment")
    : boundedBytes(record.offer_record_sha256, 32, 32, "HC-3 offer-record commitment");
  if (carrier.session_id !== record.session_id || carrier.session_generation !== record.session_generation) {
    throw new Error("HC-3 authenticated record and enclosed carrier session differ.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC3_DIRECT_AUTH_VERSION, "HC-3 direct auth version"),
    record_kind: expectLiteral(record.record_kind, "hc3_authenticated_connection", "HC-3 direct auth kind"),
    artifact_kind: artifactKind,
    authority: expectLiteral(record.authority, "none", "HC-3 direct auth authority"),
    project_id: parseEntityId("project", record.project_id),
    session_id: parseSyncV3Id("sync-session", record.session_id),
    session_generation: expectUInt64(record.session_generation, "HC-3 direct session generation"),
    connection_attempt_id: attempt,
    initiating_device_id: parseEntityId("device", record.initiating_device_id),
    responding_device_id: parseEntityId("device", record.responding_device_id),
    accepted_control_head_id: parseDigestId("control-event", record.accepted_control_head_id),
    current_epoch_id: parseEntityId("key-epoch", record.current_epoch_id),
    current_epoch_commitment_id: parseDigestId("key-epoch-commitment", record.current_epoch_commitment_id),
    transport_adapter_id: expectLiteral(record.transport_adapter_id, HC3_DIRECT_ADAPTER_ID, "HC-3 direct adapter ID"),
    transport_adapter_version: expectLiteral(record.transport_adapter_version, HC3_DIRECT_ADAPTER_VERSION, "HC-3 direct adapter version"),
    carrier_bytes: carrierBytes,
    offer_record_sha256: offerDigest,
    signer_key_id: parseEntityId("public-key", record.signer_key_id),
    signature_algorithm: expectLiteral(record.signature_algorithm, "ed25519", "HC-3 direct signature algorithm"),
    signature_bytes: signature
  }) as Hc3AuthenticatedConnectionRecord;
}

export function encodeHc3AuthenticatedConnectionRecord(value: Hc3AuthenticatedConnectionRecord): Uint8Array {
  const encoded = encodeCanonicalCbor(canonicalProtocolValue(parseHc3AuthenticatedConnectionRecord(value)));
  if (encoded.length > hc3DirectLimits.maximum_authenticated_record_bytes) throw new Error("HC-3 authenticated connection record is oversized.");
  return Uint8Array.from(encoded);
}

export function decodeHc3AuthenticatedConnectionRecord(value: Uint8Array): Hc3AuthenticatedConnectionRecord {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > hc3DirectLimits.maximum_authenticated_record_bytes) {
    throw new Error("HC-3 authenticated connection bytes are empty or oversized.");
  }
  const parsed = parseHc3AuthenticatedConnectionRecord(normalizeDecodedIntegers(protocolValueFromCanonical(decodeCanonicalCbor(value))));
  if (!sameBytes(value, encodeHc3AuthenticatedConnectionRecord(parsed))) throw new Error("HC-3 authenticated connection bytes are noncanonical.");
  return parsed;
}

export function formatHc3DirectAuthText(value: Hc3AuthenticatedConnectionRecord): Hc3DirectAuthText {
  const record = parseHc3AuthenticatedConnectionRecord(value);
  const tag = record.artifact_kind === "connection_offer" ? "do" : "da";
  const protectedText = `pmhc3d.v1.${tag}.${base64UrlEncode(encodeHc3AuthenticatedConnectionRecord(record))}`;
  const output = `${protectedText}.${crc32cHex(protectedText)}`;
  if (output.length > hc3DirectLimits.maximum_authenticated_text_characters) throw new Error("HC-3 direct authenticated text is oversized.");
  return output as Hc3DirectAuthText;
}

export function parseHc3DirectAuthText(value: unknown): Readonly<{ text: Hc3DirectAuthText; record: Hc3AuthenticatedConnectionRecord }> {
  if (typeof value !== "string" || value.length === 0 || value.length > hc3DirectLimits.maximum_authenticated_text_characters || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("HC-3 direct authenticated text is malformed or oversized.");
  }
  const fields = value.split(".");
  if (fields.length !== 5 || fields[0] !== "pmhc3d" || fields[1] !== "v1" || !["do", "da"].includes(fields[2])) throw new Error("HC-3 direct authenticated text prefix is invalid.");
  const protectedText = fields.slice(0, 4).join(".");
  if (!/^[0-9a-f]{8}$/.test(fields[4]) || crc32cHex(protectedText) !== fields[4]) throw new Error("HC-3 direct authenticated text checksum does not match.");
  const record = decodeHc3AuthenticatedConnectionRecord(base64UrlDecode(fields[3], hc3DirectLimits.maximum_authenticated_record_bytes));
  if ((fields[2] === "do") !== (record.artifact_kind === "connection_offer") || formatHc3DirectAuthText(record) !== value) {
    throw new Error("HC-3 direct authenticated text tag or canonical form differs.");
  }
  return freezeRecord({ text: value as Hc3DirectAuthText, record });
}

export async function authenticatedOfferDigest(value: Hc3AuthenticatedConnectionOffer, provider: Sha256Provider): Promise<Uint8Array> {
  const offer = parseHc3AuthenticatedConnectionRecord(value);
  if (offer.artifact_kind !== "connection_offer") throw new Error("Only an authenticated offer has an offer-record commitment.");
  return sha256(encodeCanonicalCbor(canonicalArray([
    canonicalText(HC3_DIRECT_OFFER_RECORD_COMMITMENT_DOMAIN),
    canonicalProtocolValue(offer)
  ])), provider);
}

function createCore<TKind extends Hc3DirectAuthKind>(input: Readonly<{
  artifact_kind: TKind;
  carrier: Hc3ConnectionCarrier;
  carrier_bytes: Uint8Array;
  project_id: ProjectId;
  connection_attempt_id: Uint8Array;
  authority: Hc3DirectCurrentAuthority;
  offer_record_sha256: TKind extends "connection_offer" ? null : Uint8Array;
}>): Omit<Hc3AuthenticatedConnectionRecord<TKind>, "signature_bytes" | typeof directAuthBrand> {
  if (input.authority.status !== "current" || input.authority.project_id !== input.project_id) throw new Error("HC-3 direct creation requires current project authority evidence.");
  if (input.authority.local_signing_key.key_id !== input.authority.local_signer_key_id) throw new Error("HC-3 direct local signing key does not match accepted authority evidence.");
  const initiator = input.artifact_kind === "connection_offer" ? input.authority.local_device_id : input.authority.peer_device_id;
  const responder = input.artifact_kind === "connection_offer" ? input.authority.peer_device_id : input.authority.local_device_id;
  return freezeRecord({
    schema_version: HC3_DIRECT_AUTH_VERSION,
    record_kind: "hc3_authenticated_connection",
    artifact_kind: input.artifact_kind,
    authority: "none",
    project_id: input.project_id,
    session_id: input.carrier.session_id,
    session_generation: input.carrier.session_generation,
    connection_attempt_id: boundedBytes(input.connection_attempt_id, 16, 16, "HC-3 connection-attempt identity"),
    initiating_device_id: initiator,
    responding_device_id: responder,
    accepted_control_head_id: input.authority.accepted_control_head_id,
    current_epoch_id: input.authority.current_epoch_id,
    current_epoch_commitment_id: input.authority.current_epoch_commitment_id,
    transport_adapter_id: HC3_DIRECT_ADAPTER_ID,
    transport_adapter_version: HC3_DIRECT_ADAPTER_VERSION,
    carrier_bytes: Uint8Array.from(input.carrier_bytes),
    offer_record_sha256: input.offer_record_sha256,
    signer_key_id: input.authority.local_signer_key_id,
    signature_algorithm: "ed25519"
  }) as Omit<Hc3AuthenticatedConnectionRecord<TKind>, "signature_bytes" | typeof directAuthBrand>;
}

async function signCore(
  core: Omit<Hc3AuthenticatedConnectionRecord, "signature_bytes" | typeof directAuthBrand>,
  authority: Hc3DirectCurrentAuthority,
  signatures: SignatureProvider
): Promise<Hc3AuthenticatedConnectionRecord> {
  const unsigned = { ...core, signature_bytes: new Uint8Array(hc3DirectLimits.signature_bytes) } as Hc3AuthenticatedConnectionRecord;
  const signed = await signatures.sign({ key: authority.local_signing_key, preimage: signaturePreimage(unsigned) });
  if (signed.algorithm !== "ed25519" || signed.signature_bytes.length !== hc3DirectLimits.signature_bytes) throw new Error("HC-3 direct signature provider returned an invalid signature.");
  return parseHc3AuthenticatedConnectionRecord({ ...core, signature_bytes: signed.signature_bytes });
}

function signaturePreimage(value: Hc3AuthenticatedConnectionRecord): SenderSignaturePreimageBytes {
  const parsed = parseHc3AuthenticatedConnectionRecord(value);
  const core: Record<string, unknown> = { ...parsed };
  delete core.signature_bytes;
  const domain = parsed.artifact_kind === "connection_offer" ? HC3_DIRECT_OFFER_SIGNATURE_DOMAIN : HC3_DIRECT_ANSWER_SIGNATURE_DOMAIN;
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([canonicalText(domain), canonicalProtocolValue(core)]))) as SenderSignaturePreimageBytes;
}

function assertCurrentBinding(record: Hc3AuthenticatedConnectionRecord, current: Hc3DirectCurrentAuthority): void {
  const peer = record.artifact_kind === "connection_offer" ? record.initiating_device_id : record.responding_device_id;
  if (current.project_id !== record.project_id || current.peer_device_id !== peer ||
      current.accepted_control_head_id !== record.accepted_control_head_id || current.current_epoch_id !== record.current_epoch_id ||
      current.current_epoch_commitment_id !== record.current_epoch_commitment_id || current.peer_signer.device_id !== peer ||
      current.peer_signer.key_id !== record.signer_key_id || current.peer_signer.control_head_id !== record.accepted_control_head_id) {
    throw new Error("HC-3 direct authenticated record is stale or inconsistent with accepted authority state.");
  }
}

function decodeExpectedCarrier(value: Uint8Array, kind: Hc3DirectAuthKind): Hc3ConnectionCarrier {
  const carrier = decodeHc3Carrier(value);
  if (carrier.record_kind !== "hc3_connection_carrier" || carrier.artifact_kind !== kind) throw new Error("HC-3 authenticated record encloses the wrong carrier kind.");
  return carrier;
}

function boundedBytes(value: unknown, minimum: number, maximum: number, label: string): Uint8Array {
  const bytes = expectBytes(value, label);
  if (bytes.length < minimum || bytes.length > maximum) throw new Error(`${label} has an invalid byte length.`);
  return Uint8Array.from(bytes);
}

function normalizeDecodedIntegers(value: unknown, key?: string): unknown {
  if (typeof value === "number" && key === "session_generation") return BigInt(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeDecodedIntegers(entry));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeDecodedIntegers(child, childKey)]));
  return value;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null || left.length !== right.length) return left === right;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const left = bytes.length - index;
    const value = (bytes[index] << 16) | ((left > 1 ? bytes[index + 1] : 0) << 8) | (left > 2 ? bytes[index + 2] : 0);
    output += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    if (left > 1) output += alphabet[(value >>> 6) & 63];
    if (left > 2) output += alphabet[value & 63];
  }
  return output;
}

function base64UrlDecode(value: string, maximum: number): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("HC-3 direct text payload is malformed Base64url.");
  const length = Math.floor(value.length / 4) * 3 + (value.length % 4 === 2 ? 1 : value.length % 4 === 3 ? 2 : 0);
  if (length > maximum) throw new Error("HC-3 direct text payload exceeds its byte limit.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const count = Math.min(4, value.length - index);
    const digits = [0, 0, 0, 0];
    for (let child = 0; child < count; child += 1) {
      digits[child] = alphabet.indexOf(value[index + child]);
      if (digits[child] < 0) throw new Error("HC-3 direct text payload is malformed Base64url.");
    }
    const combined = (digits[0] << 18) | (digits[1] << 12) | (digits[2] << 6) | digits[3];
    output[offset++] = (combined >>> 16) & 255;
    if (count > 2) output[offset++] = (combined >>> 8) & 255;
    if (count > 3) output[offset++] = combined & 255;
  }
  if (base64UrlEncode(output) !== value) throw new Error("HC-3 direct text payload is noncanonical Base64url.");
  return output;
}

function crc32cHex(value: string): string {
  let crc = 0xffffffff;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 127) throw new Error("HC-3 direct checksum input must be ASCII.");
    crc ^= code;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

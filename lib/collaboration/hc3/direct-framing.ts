import { decodeCanonicalCbor, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import { sha256, type Sha256Provider } from "../sha256.ts";
import { expectBytes, expectExactRecord, expectLiteral, freezeRecord } from "../validation.ts";
import { HC3_DIRECT_FRAME_VERSION, hc3DirectLimits } from "./direct-versions.ts";

export type Hc3DirectFrame = Readonly<{
  schema_version: typeof HC3_DIRECT_FRAME_VERSION;
  record_kind: "hc3_direct_frame";
  connection_attempt_id: Uint8Array;
  transfer_id: Uint8Array;
  transfer_length: number;
  transfer_sha256: Uint8Array;
  frame_ordinal: number;
  frame_count: number;
  byte_offset: number;
  payload_bytes: Uint8Array;
}>;

export type Hc3DirectPreparedTransfer = Readonly<{
  transfer_id: Uint8Array;
  transfer_length: number;
  transfer_sha256: Uint8Array;
  frame_count: number;
  frames: readonly Uint8Array[];
}>;

export async function prepareHc3DirectTransfer(input: Readonly<{
  connection_attempt_id: Uint8Array;
  transfer_id: Uint8Array;
  exact_bytes: Uint8Array;
  sha256_provider: Sha256Provider;
}>): Promise<Hc3DirectPreparedTransfer> {
  const attemptId = exactBytes(input.connection_attempt_id, hc3DirectLimits.connection_attempt_id_bytes, "HC-3 connection-attempt identity");
  const transferId = exactBytes(input.transfer_id, hc3DirectLimits.transfer_id_bytes, "HC-3 transfer identity");
  if (!(input.exact_bytes instanceof Uint8Array) || input.exact_bytes.length === 0 || input.exact_bytes.length > hc3DirectLimits.maximum_transfer_bytes) {
    throw new Error("HC-3 direct transfer is empty or exceeds its exact byte limit.");
  }
  const exact = Uint8Array.from(input.exact_bytes);
  const digest = await sha256(exact, input.sha256_provider);
  const frameCount = Math.ceil(exact.length / hc3DirectLimits.maximum_frame_payload_bytes);
  if (frameCount < 1 || frameCount > hc3DirectLimits.maximum_frame_count) throw new Error("HC-3 direct transfer exceeds its frame-count limit.");
  const frames: Uint8Array[] = [];
  for (let ordinal = 0; ordinal < frameCount; ordinal += 1) {
    const offset = ordinal * hc3DirectLimits.maximum_frame_payload_bytes;
    frames.push(encodeHc3DirectFrame({
      schema_version: HC3_DIRECT_FRAME_VERSION,
      record_kind: "hc3_direct_frame",
      connection_attempt_id: attemptId,
      transfer_id: transferId,
      transfer_length: exact.length,
      transfer_sha256: digest,
      frame_ordinal: ordinal,
      frame_count: frameCount,
      byte_offset: offset,
      payload_bytes: exact.slice(offset, Math.min(offset + hc3DirectLimits.maximum_frame_payload_bytes, exact.length))
    }));
  }
  return freezeRecord({
    transfer_id: transferId,
    transfer_length: exact.length,
    transfer_sha256: Uint8Array.from(digest),
    frame_count: frameCount,
    frames: Object.freeze(frames.map((frame) => Uint8Array.from(frame)))
  });
}

export function parseHc3DirectFrame(value: unknown): Hc3DirectFrame {
  const record = expectExactRecord(value, "HC-3 direct frame", [
    "schema_version", "record_kind", "connection_attempt_id", "transfer_id", "transfer_length", "transfer_sha256",
    "frame_ordinal", "frame_count", "byte_offset", "payload_bytes"
  ]);
  const transferLength = safeInteger(record.transfer_length, 1, hc3DirectLimits.maximum_transfer_bytes, "HC-3 direct transfer length");
  const frameCount = safeInteger(record.frame_count, 1, hc3DirectLimits.maximum_frame_count, "HC-3 direct frame count");
  const ordinal = safeInteger(record.frame_ordinal, 0, frameCount - 1, "HC-3 direct frame ordinal");
  const offset = safeInteger(record.byte_offset, 0, transferLength - 1, "HC-3 direct frame offset");
  const payload = boundedPayload(record.payload_bytes);
  const expectedOffset = ordinal * hc3DirectLimits.maximum_frame_payload_bytes;
  const expectedLength = Math.min(hc3DirectLimits.maximum_frame_payload_bytes, transferLength - expectedOffset);
  if (offset !== expectedOffset || payload.length !== expectedLength || offset + payload.length > transferLength ||
      frameCount !== Math.ceil(transferLength / hc3DirectLimits.maximum_frame_payload_bytes)) {
    throw new Error("HC-3 direct frame has a gap, overlap, impossible count, offset, or payload length.");
  }
  return freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC3_DIRECT_FRAME_VERSION, "HC-3 direct frame version"),
    record_kind: expectLiteral(record.record_kind, "hc3_direct_frame", "HC-3 direct frame kind"),
    connection_attempt_id: exactBytes(record.connection_attempt_id, hc3DirectLimits.connection_attempt_id_bytes, "HC-3 connection-attempt identity"),
    transfer_id: exactBytes(record.transfer_id, hc3DirectLimits.transfer_id_bytes, "HC-3 transfer identity"),
    transfer_length: transferLength,
    transfer_sha256: exactBytes(record.transfer_sha256, hc3DirectLimits.digest_bytes, "HC-3 transfer digest"),
    frame_ordinal: ordinal,
    frame_count: frameCount,
    byte_offset: offset,
    payload_bytes: payload
  });
}

export function encodeHc3DirectFrame(value: Hc3DirectFrame): Uint8Array {
  return Uint8Array.from(encodeCanonicalCbor(canonicalProtocolValue(parseHc3DirectFrame(value))));
}

export function decodeHc3DirectFrame(value: Uint8Array): Hc3DirectFrame {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > hc3DirectLimits.maximum_frame_payload_bytes + 512) {
    throw new Error("HC-3 direct encoded frame is empty or oversized.");
  }
  const frame = parseHc3DirectFrame(protocolValueFromCanonical(decodeCanonicalCbor(Uint8Array.from(value))));
  if (!sameBytes(value, encodeHc3DirectFrame(frame))) throw new Error("HC-3 direct frame bytes are noncanonical or contain trailing data.");
  return frame;
}

export class Hc3DirectTransferAssembler {
  readonly #attemptId: Uint8Array;
  readonly #sha256Provider: Sha256Provider;
  #identity: Readonly<{ transfer_id: Uint8Array; transfer_length: number; transfer_sha256: Uint8Array; frame_count: number }> | null = null;
  #frames = new Map<number, Uint8Array>();
  #terminal = false;

  constructor(input: Readonly<{ connection_attempt_id: Uint8Array; sha256_provider: Sha256Provider }>) {
    this.#attemptId = exactBytes(input.connection_attempt_id, hc3DirectLimits.connection_attempt_id_bytes, "HC-3 connection-attempt identity");
    if (typeof input.sha256_provider !== "function") throw new Error("HC-3 transfer assembler requires an injected SHA-256 provider.");
    this.#sha256Provider = input.sha256_provider;
  }

  get receivedFrameCount(): number { return this.#frames.size; }
  get expectedFrameCount(): number | null { return this.#identity?.frame_count ?? null; }

  accept(encodedFrame: Uint8Array): Readonly<{ status: "accepted" | "duplicate"; complete: boolean }> {
    if (this.#terminal) throw new Error("HC-3 direct transfer assembler is closed after completion or failure.");
    const frame = decodeHc3DirectFrame(encodedFrame);
    if (!sameBytes(frame.connection_attempt_id, this.#attemptId)) return this.#fail("HC-3 direct frame belongs to a stale connection attempt.");
    if (this.#identity === null) {
      this.#identity = freezeRecord({
        transfer_id: Uint8Array.from(frame.transfer_id), transfer_length: frame.transfer_length,
        transfer_sha256: Uint8Array.from(frame.transfer_sha256), frame_count: frame.frame_count
      });
    } else if (!sameBytes(this.#identity.transfer_id, frame.transfer_id) || this.#identity.transfer_length !== frame.transfer_length ||
      !sameBytes(this.#identity.transfer_sha256, frame.transfer_sha256) || this.#identity.frame_count !== frame.frame_count) {
      return this.#fail("HC-3 direct frame metadata conflicts within one transfer.");
    }
    const existing = this.#frames.get(frame.frame_ordinal);
    if (existing) {
      if (!sameBytes(existing, frame.payload_bytes)) return this.#fail("HC-3 direct duplicate frame conflicts byte-for-byte.");
      return freezeRecord({ status: "duplicate", complete: this.#frames.size === frame.frame_count });
    }
    this.#frames.set(frame.frame_ordinal, Uint8Array.from(frame.payload_bytes));
    return freezeRecord({ status: "accepted", complete: this.#frames.size === frame.frame_count });
  }

  async finish(): Promise<Readonly<{ status: "complete"; transfer_id: Uint8Array; exact_bytes: Uint8Array; sha256: Uint8Array }>> {
    if (this.#terminal || this.#identity === null || this.#frames.size !== this.#identity.frame_count) {
      throw new Error("HC-3 direct transfer is incomplete, failed, or already consumed.");
    }
    const exact = new Uint8Array(this.#identity.transfer_length);
    for (let ordinal = 0; ordinal < this.#identity.frame_count; ordinal += 1) {
      const frame = this.#frames.get(ordinal);
      if (!frame) return this.#fail("HC-3 direct transfer frame set is not dense.");
      exact.set(frame, ordinal * hc3DirectLimits.maximum_frame_payload_bytes);
    }
    const digest = await sha256(exact, this.#sha256Provider);
    if (!sameBytes(digest, this.#identity.transfer_sha256)) return this.#fail("HC-3 direct transfer digest does not match exact reassembled bytes.");
    this.#terminal = true;
    this.#frames.clear();
    return freezeRecord({ status: "complete", transfer_id: Uint8Array.from(this.#identity.transfer_id), exact_bytes: exact, sha256: Uint8Array.from(digest) });
  }

  cancel(): void {
    this.#terminal = true;
    this.#frames.clear();
    this.#identity = null;
  }

  #fail(message: string): never {
    this.cancel();
    throw new Error(message);
  }
}

function exactBytes(value: unknown, length: number, label: string): Uint8Array {
  const bytes = expectBytes(value, label);
  if (bytes.length !== length) throw new Error(`${label} must contain exactly ${length} bytes.`);
  return Uint8Array.from(bytes);
}

function boundedPayload(value: unknown): Uint8Array {
  const bytes = expectBytes(value, "HC-3 direct frame payload");
  if (bytes.length < 1 || bytes.length > hc3DirectLimits.maximum_frame_payload_bytes) throw new Error("HC-3 direct frame payload is empty or oversized.");
  return Uint8Array.from(bytes);
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is outside its bounded safe-integer range.`);
  return Number(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

import { decodeCanonicalCbor, encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue, protocolValueFromCanonical } from "../canonical-protocol.ts";
import { expectEnum, expectExactRecord, expectLiteral, freezeRecord } from "../validation.ts";
import { hc3CarrierLimits } from "./versions.ts";
import {
  HC3_DIRECT_DESCRIPTION_VERSION,
  hc3DirectDescriptionKinds,
  hc3DirectLimits,
  type Hc3DirectDescriptionKind
} from "./direct-versions.ts";

export type Hc3DirectDescription = Readonly<{
  schema_version: typeof HC3_DIRECT_DESCRIPTION_VERSION;
  description_kind: Hc3DirectDescriptionKind;
  sdp_utf8: Uint8Array;
}>;

export function encodeHc3DirectDescription(input: Readonly<{
  description_kind: Hc3DirectDescriptionKind;
  sdp: string;
}>): Uint8Array {
  const kind = expectEnum(input.description_kind, hc3DirectDescriptionKinds, "HC-3 direct description kind");
  if (typeof input.sdp !== "string" || input.sdp.length === 0 || input.sdp.includes("\0")) {
    throw new Error("HC-3 direct SDP must be nonempty text without NUL bytes.");
  }
  const sdpUtf8 = new TextEncoder().encode(input.sdp);
  if (sdpUtf8.length > hc3DirectLimits.maximum_sdp_utf8_bytes) {
    throw new Error("HC-3 direct SDP exceeds its UTF-8 byte limit.");
  }
  const encoded = encodeCanonicalCbor(canonicalProtocolValue({
    schema_version: HC3_DIRECT_DESCRIPTION_VERSION,
    description_kind: kind,
    sdp_utf8: sdpUtf8
  }));
  if (encoded.length > hc3CarrierLimits.maximum_connection_description_bytes) {
    throw new Error("HC-3 direct description exceeds the frozen Slice 1 carrier limit.");
  }
  return Uint8Array.from(encoded);
}

export function decodeHc3DirectDescription(
  value: Uint8Array,
  expectedKind?: Hc3DirectDescriptionKind
): Hc3DirectDescription & Readonly<{ sdp: string }> {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > hc3CarrierLimits.maximum_connection_description_bytes) {
    throw new Error("HC-3 direct description bytes are empty or oversized.");
  }
  const record = expectExactRecord(
    protocolValueFromCanonical(decodeCanonicalCbor(Uint8Array.from(value))),
    "HC-3 direct description",
    ["schema_version", "description_kind", "sdp_utf8"]
  );
  const kind = expectEnum(record.description_kind, hc3DirectDescriptionKinds, "HC-3 direct description kind");
  if (expectedKind !== undefined && kind !== expectedKind) throw new Error("HC-3 direct description kind does not match its carrier.");
  if (!(record.sdp_utf8 instanceof Uint8Array) || record.sdp_utf8.length === 0 || record.sdp_utf8.length > hc3DirectLimits.maximum_sdp_utf8_bytes) {
    throw new Error("HC-3 direct SDP bytes are empty or oversized.");
  }
  const sdp = new TextDecoder("utf-8", { fatal: true }).decode(record.sdp_utf8);
  if (sdp.includes("\0") || !sameBytes(new TextEncoder().encode(sdp), record.sdp_utf8)) {
    throw new Error("HC-3 direct SDP is not exact canonical UTF-8.");
  }
  const parsed = freezeRecord({
    schema_version: expectLiteral(record.schema_version, HC3_DIRECT_DESCRIPTION_VERSION, "HC-3 direct description version"),
    description_kind: kind,
    sdp_utf8: Uint8Array.from(record.sdp_utf8),
    sdp
  });
  if (!sameBytes(value, encodeHc3DirectDescription({ description_kind: parsed.description_kind, sdp: parsed.sdp }))) {
    throw new Error("HC-3 direct description has trailing, unknown, or noncanonical bytes.");
  }
  return parsed;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

import { decodeHc3Carrier, encodeHc3Carrier, type Hc3Carrier } from "./contracts.ts";
import {
  HC3_TEXT_PREFIX,
  HC3_TEXT_VERSION,
  hc3ArtifactTextTags,
  hc3CarrierLimits,
  type Hc3ArtifactKind
} from "./versions.ts";

declare const hc3ArtifactTextBrand: unique symbol;

export type Hc3ArtifactText = string & {
  readonly [hc3ArtifactTextBrand]: "hc3-artifact-text";
};

const kindByTag = Object.freeze(Object.fromEntries(
  Object.entries(hc3ArtifactTextTags).map(([kind, tag]) => [tag, kind])
) as Readonly<Record<string, Hc3ArtifactKind>>);

export function formatHc3ArtifactText(value: Hc3Carrier): Hc3ArtifactText {
  const bytes = encodeHc3Carrier(value);
  const tag = hc3ArtifactTextTags[value.artifact_kind];
  const body = encodeBase64Url(bytes);
  const protectedText = `${HC3_TEXT_PREFIX}.v${HC3_TEXT_VERSION}.${tag}.${body}`;
  const result = `${protectedText}.${crc32cHex(protectedText)}`;
  if (result.length > hc3CarrierLimits.maximum_canonical_text_characters) {
    throw new Error("HC-3 canonical text exceeds its character limit.");
  }
  return result as Hc3ArtifactText;
}

export function parseHc3ArtifactText(value: unknown): Readonly<{
  text: Hc3ArtifactText;
  carrier: Hc3Carrier;
}> {
  if (typeof value !== "string" || value.length === 0 || value.length > hc3CarrierLimits.maximum_canonical_text_characters) {
    throw new Error("HC-3 artifact text is empty or exceeds its character limit.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("HC-3 artifact text contains whitespace, escapes, padding, or non-ASCII/confusable characters.");
  }
  const fields = value.split(".");
  if (fields.length !== 5 || fields[0] !== HC3_TEXT_PREFIX || fields[1] !== `v${HC3_TEXT_VERSION}`) {
    throw new Error("HC-3 artifact text has an unknown, duplicated, or malformed prefix.");
  }
  const artifactKind = kindByTag[fields[2]];
  if (!artifactKind) throw new Error("HC-3 artifact text has an unknown artifact kind.");
  if (!/^[0-9a-f]{8}$/.test(fields[4])) throw new Error("HC-3 artifact checksum is not canonical lowercase CRC-32C.");
  const protectedText = fields.slice(0, 4).join(".");
  if (crc32cHex(protectedText) !== fields[4]) throw new Error("HC-3 artifact checksum does not match.");
  const bytes = decodeBase64Url(fields[3], hc3CarrierLimits.maximum_carrier_canonical_bytes);
  const carrier = decodeHc3Carrier(bytes);
  if (carrier.artifact_kind !== artifactKind) throw new Error("HC-3 text tag and enclosed carrier kind differ.");
  if (formatHc3ArtifactText(carrier) !== value) throw new Error("HC-3 artifact text is not its canonical re-encoding.");
  return Object.freeze({ text: value as Hc3ArtifactText, carrier });
}

export function hc3ArtifactChecksumNotice(): string {
  return "CRC-32C detects accidental corruption only; enclosed HC-2 verification supplies authentication and authority.";
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const value = (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0);
    output += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    if (remaining > 1) output += alphabet[(value >>> 6) & 63];
    if (remaining > 2) output += alphabet[value & 63];
  }
  return output;
}

function decodeBase64Url(value: string, maximumDecodedBytes: number): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("HC-3 artifact payload is malformed unpadded Base64url.");
  }
  const remainder = value.length % 4;
  const decodedLength = Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  if (decodedLength > maximumDecodedBytes) throw new Error("HC-3 artifact payload exceeds its decoded byte limit.");
  const output = new Uint8Array(decodedLength);
  let outputOffset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const available = Math.min(4, value.length - index);
    const a = base64Value(value.charCodeAt(index));
    const b = base64Value(value.charCodeAt(index + 1));
    const c = available > 2 ? base64Value(value.charCodeAt(index + 2)) : 0;
    const d = available > 3 ? base64Value(value.charCodeAt(index + 3)) : 0;
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    output[outputOffset++] = (combined >>> 16) & 0xff;
    if (available > 2) output[outputOffset++] = (combined >>> 8) & 0xff;
    if (available > 3) output[outputOffset++] = combined & 0xff;
  }
  if (encodeBase64Url(output) !== value) throw new Error("HC-3 artifact payload is noncanonical Base64url.");
  return output;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 45) return 62;
  if (code === 95) return 63;
  throw new Error("HC-3 artifact payload contains a non-Base64url character.");
}

function crc32cHex(value: string): string {
  let crc = 0xffffffff;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) throw new Error("HC-3 checksum input must be ASCII.");
    crc ^= code;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const canonicalKind = Symbol("patchmark canonical CBOR value");
const maximumUint64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const maximumDecodeDepth = 128;

type CanonicalKind =
  | "array"
  | "boolean"
  | "bytes"
  | "map"
  | "null"
  | "text"
  | "uint";

type CanonicalValueBase<TKind extends CanonicalKind> = Readonly<{
  [canonicalKind]: TKind;
}>;

export type CanonicalByteString = CanonicalValueBase<"bytes">;
export type CanonicalText = CanonicalValueBase<"text">;
export type CanonicalUint = CanonicalValueBase<"uint">;
export type CanonicalBoolean = CanonicalValueBase<"boolean">;
export type CanonicalNull = CanonicalValueBase<"null">;
export type CanonicalArray = CanonicalValueBase<"array">;
export type CanonicalMap = CanonicalValueBase<"map">;

export type CanonicalValue =
  | CanonicalByteString
  | CanonicalText
  | CanonicalUint
  | CanonicalBoolean
  | CanonicalNull
  | CanonicalArray
  | CanonicalMap;

type CanonicalPayload =
  | Readonly<{ bytes: readonly number[] }>
  | Readonly<{ text: string }>
  | Readonly<{ uint: bigint }>
  | Readonly<{ boolean: boolean }>
  | Readonly<{ values: readonly CanonicalValue[] }>
  | Readonly<{
      entries: readonly (readonly [CanonicalText, CanonicalValue])[];
    }>
  | null;

const payloads = new WeakMap<CanonicalValue, CanonicalPayload>();

export function canonicalBytes(value: Uint8Array): CanonicalByteString {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Canonical byte strings require a Uint8Array.");
  }
  return createCanonicalValue("bytes", {
    bytes: Object.freeze(Array.from(value))
  });
}

export function canonicalText(value: string): CanonicalText {
  if (typeof value !== "string") {
    throw new Error("Canonical text requires a string.");
  }
  assertWellFormedUnicode(value);
  if (value.normalize("NFC") !== value) {
    throw new Error("Canonical protocol text must already be NFC-normalized.");
  }
  return createCanonicalValue("text", Object.freeze({ text: value }));
}

export function canonicalUint(value: bigint): CanonicalUint {
  if (typeof value !== "bigint" || value < BigInt(0) || value > maximumUint64) {
    throw new Error("Canonical unsigned integers must be bigint values from 0 through 2^64-1.");
  }
  return createCanonicalValue("uint", Object.freeze({ uint: value }));
}

export function canonicalBoolean(value: boolean): CanonicalBoolean {
  if (typeof value !== "boolean") {
    throw new Error("Canonical booleans require a boolean value.");
  }
  return createCanonicalValue("boolean", Object.freeze({ boolean: value }));
}

export const canonicalNull: CanonicalNull = createCanonicalValue("null", null);

export function canonicalArray(
  values: readonly CanonicalValue[]
): CanonicalArray {
  if (!Array.isArray(values)) {
    throw new Error("Canonical arrays require an array.");
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new Error("Canonical arrays must be dense and cannot contain holes.");
    }
    assertCanonicalValue(values[index]);
  }
  return createCanonicalValue(
    "array",
    Object.freeze({ values: Object.freeze([...values]) })
  );
}

export function canonicalMap(
  entries: readonly (readonly [string | CanonicalText, CanonicalValue])[]
): CanonicalMap {
  if (!Array.isArray(entries)) {
    throw new Error("Canonical maps require an entry array.");
  }
  const parsedEntries: Array<readonly [CanonicalText, CanonicalValue]> = [];
  const keys = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(entries, index)) {
      throw new Error("Canonical map entry arrays must be dense.");
    }
    const entry = entries[index];
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("Canonical map entries must be key/value pairs.");
    }
    const key = typeof entry[0] === "string" ? canonicalText(entry[0]) : entry[0];
    if (!isCanonicalKind(key, "text")) {
      throw new Error("Patchmark v1 canonical map keys must be text strings.");
    }
    assertCanonicalValue(entry[1]);
    const keyText = readText(key);
    if (keys.has(keyText)) {
      throw new Error(`Canonical map contains duplicate key ${keyText}.`);
    }
    keys.add(keyText);
    parsedEntries.push(Object.freeze([key, entry[1]]));
  }
  return createCanonicalValue(
    "map",
    Object.freeze({ entries: Object.freeze(parsedEntries) })
  );
}

export function encodeCanonicalCbor(value: CanonicalValue): Uint8Array {
  assertCanonicalValue(value);
  const output: number[] = [];
  encodeValue(value, output);
  return Uint8Array.from(output);
}

export function decodeCanonicalCbor(bytes: Uint8Array): CanonicalValue {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Canonical CBOR input must be a Uint8Array.");
  }
  const input = Uint8Array.from(bytes);
  const cursor = { offset: 0 };
  const value = decodeValue(input, cursor, 0);
  if (cursor.offset !== input.length) {
    throw new Error("Canonical CBOR must contain exactly one item with no trailing bytes.");
  }
  const reencoded = encodeCanonicalCbor(value);
  if (!equalBytes(input, reencoded)) {
    throw new Error("CBOR input is not Patchmark canonical encoding.");
  }
  return value;
}

export function assertCanonicalCbor(
  bytes: Uint8Array,
  expected: CanonicalValue
): void {
  const decoded = decodeCanonicalCbor(bytes);
  if (!equalBytes(encodeCanonicalCbor(decoded), encodeCanonicalCbor(expected))) {
    throw new Error("Canonical CBOR value does not match the expected schema value.");
  }
}

function encodeValue(value: CanonicalValue, output: number[]): void {
  const kind = value[canonicalKind];
  const payload = payloads.get(value);
  switch (kind) {
    case "uint":
      encodeHead(0, readPayload(payload, "uint"), output);
      return;
    case "bytes": {
      const bytes = readPayload(payload, "bytes");
      encodeHead(2, BigInt(bytes.length), output);
      output.push(...bytes);
      return;
    }
    case "text": {
      const bytes = new TextEncoder().encode(readPayload(payload, "text"));
      encodeHead(3, BigInt(bytes.length), output);
      output.push(...bytes);
      return;
    }
    case "array": {
      const values = readPayload(payload, "values");
      encodeHead(4, BigInt(values.length), output);
      for (const child of values) {
        encodeValue(child, output);
      }
      return;
    }
    case "map": {
      const entries = readPayload(payload, "entries")
        .map(([key, child]) => ({
          child,
          key,
          keyBytes: encodeCanonicalCbor(key)
        }))
        .sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
      encodeHead(5, BigInt(entries.length), output);
      for (const entry of entries) {
        output.push(...entry.keyBytes);
        encodeValue(entry.child, output);
      }
      return;
    }
    case "boolean":
      output.push(readPayload(payload, "boolean") ? 0xf5 : 0xf4);
      return;
    case "null":
      output.push(0xf6);
      return;
  }
}

function encodeHead(major: number, value: bigint, output: number[]): void {
  if (value < BigInt(24)) {
    output.push((major << 5) | Number(value));
    return;
  }
  if (value <= BigInt(0xff)) {
    output.push((major << 5) | 24, Number(value));
    return;
  }
  if (value <= BigInt(0xffff)) {
    output.push((major << 5) | 25, Number(value >> BigInt(8)), Number(value & BigInt(0xff)));
    return;
  }
  if (value <= BigInt(0xffffffff)) {
    output.push((major << 5) | 26);
    appendBigEndian(value, 4, output);
    return;
  }
  if (value <= maximumUint64) {
    output.push((major << 5) | 27);
    appendBigEndian(value, 8, output);
    return;
  }
  throw new Error("Canonical CBOR length or integer exceeds uint64.");
}

function appendBigEndian(value: bigint, width: number, output: number[]): void {
  for (let shift = width - 1; shift >= 0; shift -= 1) {
    output.push(Number((value >> BigInt(shift * 8)) & BigInt(0xff)));
  }
}

function decodeValue(
  input: Uint8Array,
  cursor: { offset: number },
  depth: number
): CanonicalValue {
  if (depth > maximumDecodeDepth) {
    throw new Error("Canonical CBOR nesting exceeds the Patchmark limit.");
  }
  const initial = readByte(input, cursor);
  const major = initial >> 5;
  const additional = initial & 0x1f;

  if (major === 7) {
    if (additional === 20) return canonicalBoolean(false);
    if (additional === 21) return canonicalBoolean(true);
    if (additional === 22) return canonicalNull;
    if (additional === 25 || additional === 26 || additional === 27) {
      throw new Error("Floating-point CBOR values are not supported.");
    }
    if (additional === 31) {
      throw new Error("Indefinite-length or break CBOR values are not supported.");
    }
    throw new Error("Unsupported CBOR simple value.");
  }
  if (additional === 31) {
    throw new Error("Indefinite-length CBOR values are not supported.");
  }
  if (major === 1) {
    throw new Error("Negative integers are not supported by Patchmark v1.");
  }
  if (major === 6) {
    throw new Error("CBOR tags are not supported by Patchmark v1.");
  }
  if (major > 7) {
    throw new Error("Unsupported CBOR major type.");
  }

  const argument = decodeArgument(input, cursor, additional);
  if (major === 0) {
    return canonicalUint(argument);
  }
  const length = toSafeLength(argument, input.length - cursor.offset);
  if (major === 2) {
    const end = cursor.offset + length;
    const value = canonicalBytes(input.slice(cursor.offset, end));
    cursor.offset = end;
    return value;
  }
  if (major === 3) {
    const end = cursor.offset + length;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        input.slice(cursor.offset, end)
      );
    } catch {
      throw new Error("Canonical CBOR text must contain well-formed UTF-8.");
    }
    cursor.offset = end;
    return canonicalText(text);
  }
  if (major === 4) {
    const values: CanonicalValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(decodeValue(input, cursor, depth + 1));
    }
    return canonicalArray(values);
  }
  if (major === 5) {
    const entries: Array<readonly [CanonicalText, CanonicalValue]> = [];
    const keys = new Set<string>();
    let previousKeyBytes: Uint8Array | null = null;
    for (let index = 0; index < length; index += 1) {
      const keyStart = cursor.offset;
      const key = decodeValue(input, cursor, depth + 1);
      if (!isCanonicalKind(key, "text")) {
        throw new Error("Patchmark v1 canonical map keys must be text strings.");
      }
      const keyBytes = input.slice(keyStart, cursor.offset);
      if (previousKeyBytes && compareBytes(previousKeyBytes, keyBytes) >= 0) {
        throw new Error("Canonical CBOR map keys must be strictly bytewise ordered.");
      }
      previousKeyBytes = keyBytes;
      const keyText = readText(key);
      if (keys.has(keyText)) {
        throw new Error(`Canonical CBOR map contains duplicate key ${keyText}.`);
      }
      keys.add(keyText);
      entries.push(Object.freeze([key, decodeValue(input, cursor, depth + 1)]));
    }
    return canonicalMap(entries);
  }
  throw new Error("Unsupported CBOR major type.");
}

function decodeArgument(
  input: Uint8Array,
  cursor: { offset: number },
  additional: number
): bigint {
  if (additional < 24) return BigInt(additional);
  if (additional === 24) {
    const value = BigInt(readByte(input, cursor));
    if (value < BigInt(24)) throw new Error("CBOR integer or length is not minimally encoded.");
    return value;
  }
  if (additional === 25) {
    const value = readBigEndian(input, cursor, 2);
    if (value <= BigInt(0xff)) throw new Error("CBOR integer or length is not minimally encoded.");
    return value;
  }
  if (additional === 26) {
    const value = readBigEndian(input, cursor, 4);
    if (value <= BigInt(0xffff)) throw new Error("CBOR integer or length is not minimally encoded.");
    return value;
  }
  if (additional === 27) {
    const value = readBigEndian(input, cursor, 8);
    if (value <= BigInt(0xffffffff)) throw new Error("CBOR integer or length is not minimally encoded.");
    return value;
  }
  throw new Error("Reserved CBOR additional-information value.");
}

function readBigEndian(
  input: Uint8Array,
  cursor: { offset: number },
  width: number
): bigint {
  let value = BigInt(0);
  for (let index = 0; index < width; index += 1) {
    value = (value << BigInt(8)) | BigInt(readByte(input, cursor));
  }
  return value;
}

function readByte(input: Uint8Array, cursor: { offset: number }): number {
  if (cursor.offset >= input.length) {
    throw new Error("Malformed CBOR ended unexpectedly.");
  }
  const value = input[cursor.offset];
  cursor.offset += 1;
  return value;
}

function toSafeLength(value: bigint, remaining: number): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("CBOR collection length exceeds the supported runtime range.");
  }
  const length = Number(value);
  if (length > remaining) {
    throw new Error("Malformed CBOR length exceeds the remaining input.");
  }
  return length;
}

function createCanonicalValue<TKind extends CanonicalKind>(
  kind: TKind,
  payload: CanonicalPayload
): CanonicalValueBase<TKind> {
  const value = Object.freeze({ [canonicalKind]: kind });
  payloads.set(value as CanonicalValue, payload);
  return value as CanonicalValueBase<TKind>;
}

function assertCanonicalValue(value: unknown): asserts value is CanonicalValue {
  if (
    typeof value !== "object" ||
    value === null ||
    !payloads.has(value as CanonicalValue)
  ) {
    throw new Error("Value was not constructed through the Patchmark canonical-value boundary.");
  }
}

function isCanonicalKind<TKind extends CanonicalKind>(
  value: unknown,
  kind: TKind
): value is CanonicalValueBase<TKind> {
  return (
    typeof value === "object" &&
    value !== null &&
    payloads.has(value as CanonicalValue) &&
    (value as CanonicalValue)[canonicalKind] === kind
  );
}

function readPayload(payload: CanonicalPayload | undefined, key: "bytes"): readonly number[];
function readPayload(payload: CanonicalPayload | undefined, key: "text"): string;
function readPayload(payload: CanonicalPayload | undefined, key: "uint"): bigint;
function readPayload(payload: CanonicalPayload | undefined, key: "boolean"): boolean;
function readPayload(payload: CanonicalPayload | undefined, key: "values"): readonly CanonicalValue[];
function readPayload(
  payload: CanonicalPayload | undefined,
  key: "entries"
): readonly (readonly [CanonicalText, CanonicalValue])[];
function readPayload(
  payload: CanonicalPayload | undefined,
  key: "boolean" | "bytes" | "entries" | "text" | "uint" | "values"
): boolean | readonly number[] | readonly (readonly [CanonicalText, CanonicalValue])[] | string | bigint | readonly CanonicalValue[] {
  if (!payload || !(key in payload)) {
    throw new Error("Invalid internal canonical value.");
  }
  return (payload as unknown as Record<string, never>)[key];
}

function readText(value: CanonicalText): string {
  return readPayload(payloads.get(value), "text");
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error("Protocol text contains an unpaired UTF-16 surrogate.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Protocol text contains an unpaired UTF-16 surrogate.");
    }
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

const hasOwn = Object.prototype.hasOwnProperty;

export type UInt64 = bigint & { readonly __uint64Brand: unique symbol };
export type NonAuthoritativeTimestamp = string & {
  readonly __nonAuthoritativeTimestampBrand: unique symbol;
};

export function expectExactRecord(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unexpected field ${key}.`);
    }
  }
  for (const key of requiredKeys) {
    if (!hasOwn.call(value, key)) {
      throw new Error(`${label} is missing required field ${key}.`);
    }
  }
  return value;
}

export function expectLiteral<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}.`);
  }
  return expected;
}

export function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value.`);
  }
  return value as T;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

export function expectNonEmptyString(value: unknown, label: string): string {
  const text = expectString(value, label);
  if (!text || !text.trim()) {
    throw new Error(`${label} must not be empty.`);
  }
  return text;
}

export function expectNullableString(
  value: unknown,
  label: string
): string | null {
  return value === null ? null : expectString(value, label);
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

export function expectUInt64(value: unknown, label: string): UInt64 {
  if (
    typeof value !== "bigint" ||
    value < BigInt(0) ||
    value > BigInt("18446744073709551615")
  ) {
    throw new Error(`${label} must be an unsigned 64-bit bigint.`);
  }
  return value as UInt64;
}

export function expectZeroUInt64(value: unknown, label: string): UInt64 {
  const integer = expectUInt64(value, label);
  if (integer !== BigInt(0)) {
    throw new Error(`${label} must be zero.`);
  }
  return integer;
}

export function expectPositiveUInt64(value: unknown, label: string): UInt64 {
  const integer = expectUInt64(value, label);
  if (integer === BigInt(0)) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return integer;
}

export function expectDisplayTimestamp(
  value: unknown,
  label: string
): NonAuthoritativeTimestamp {
  const timestamp = expectString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)
  ) {
    throw new Error(`${label} must be a UTC display timestamp.`);
  }
  return timestamp as NonAuthoritativeTimestamp;
}

export function expectBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a Uint8Array.`);
  }
  return Uint8Array.from(value);
}

export function expectArray(
  value: unknown,
  label: string
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

export function parseSortedUniqueArray<T extends string>(
  value: unknown,
  label: string,
  parse: (candidate: unknown) => T,
  options: { allowEmpty?: boolean } = {}
): readonly T[] {
  const candidates = expectArray(value, label);
  if (!options.allowEmpty && candidates.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  const parsed = candidates.map(parse);
  for (let index = 1; index < parsed.length; index += 1) {
    if (compareAscii(parsed[index - 1], parsed[index]) >= 0) {
      throw new Error(`${label} must be strictly sorted and unique.`);
    }
  }
  return Object.freeze(parsed);
}

export function parseUniqueArray<T>(
  value: unknown,
  label: string,
  parse: (candidate: unknown, index: number) => T,
  key: (candidate: T) => string,
  options: { allowEmpty?: boolean; requireSorted?: boolean } = {}
): readonly T[] {
  const candidates = expectArray(value, label);
  if (!options.allowEmpty && candidates.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  const parsed = candidates.map(parse);
  const keys = parsed.map(key);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} must contain unique values.`);
  }
  if (options.requireSorted) {
    for (let index = 1; index < keys.length; index += 1) {
      if (compareAscii(keys[index - 1], keys[index]) >= 0) {
        throw new Error(`${label} must be strictly sorted and unique.`);
      }
    }
  }
  return Object.freeze(parsed);
}

export function assertSameStringArray(
  left: readonly string[],
  right: readonly string[],
  label: string
): void {
  if (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  ) {
    throw new Error(`${label} must match exactly.`);
  }
}

export function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

import {
  canonicalArray,
  canonicalBoolean,
  canonicalBytes,
  canonicalMap,
  canonicalNull,
  canonicalText,
  canonicalUint,
  inspectCanonicalValue,
  type CanonicalValue
} from "./canonical-cbor.ts";

/** Closed conversion used only after a schema-specific parser accepted input. */
export function canonicalProtocolValue(value: unknown): CanonicalValue {
  if (value === null) return canonicalNull;
  if (typeof value === "string") return canonicalText(value);
  if (typeof value === "boolean") return canonicalBoolean(value);
  if (typeof value === "bigint") return canonicalUint(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Canonical protocol numbers must be nonnegative safe integers.");
    }
    return canonicalUint(BigInt(value));
  }
  if (value instanceof Uint8Array) return canonicalBytes(Uint8Array.from(value));
  if (Array.isArray(value)) {
    return canonicalArray(value.map((entry) => canonicalProtocolValue(entry)));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, canonicalProtocolValue(child)] as const);
    return canonicalMap(entries);
  }
  throw new Error("Value is outside the closed canonical protocol model.");
}

/** Converts strictly decoded canonical CBOR into copied protocol data. */
export function protocolValueFromCanonical(
  value: CanonicalValue,
  integerMode: "number_when_safe" | "bigint" = "number_when_safe"
): unknown {
  const view = inspectCanonicalValue(value);
  switch (view.kind) {
    case "null":
      return null;
    case "boolean":
    case "text":
      return view.value;
    case "bytes":
      return Uint8Array.from(view.value);
    case "uint":
      return integerMode === "number_when_safe" && view.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(view.value)
        : view.value;
    case "array":
      return view.values.map((entry) => protocolValueFromCanonical(entry, integerMode));
    case "map":
      return Object.fromEntries(
        view.entries.map(([key, child]) => [key, protocolValueFromCanonical(child, integerMode)])
      );
  }
}

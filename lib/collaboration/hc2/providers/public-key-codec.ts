import {
  canonicalArray,
  canonicalBytes,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue
} from "../../canonical-cbor.ts";
import { parseEntityId, type PublicKeyId } from "../../identities.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  PublicKeyCodec
} from "../crypto-contracts.ts";
import { cryptoFailure } from "./provider-errors.ts";

export const HC2_PUBLIC_KEY_CODEC_DOMAIN = "patchmark/hc2/public-key/v1" as const;
export const HC2_RAW_PUBLIC_KEY_BYTES = 32 as const;

export type Hc2PublicKeyAlgorithm = "ed25519" | "x25519";

export type DecodedHc2PublicKey = Readonly<{
  algorithm: Hc2PublicKeyAlgorithm;
  key_id: PublicKeyId;
  raw_public_key: Uint8Array;
}>;

type PreparedPublicKey = Readonly<{
  algorithm: Hc2PublicKeyAlgorithm;
  key_id: PublicKeyId;
  public_key: CryptoKey;
  encoded: readonly number[];
}>;

/**
 * Adapts WebCrypto's asynchronous import/export to the frozen synchronous
 * PublicKeyCodec accessors. A key must be explicitly prepared first; the
 * synchronous methods never perform I/O, import a new key, or weaken parsing.
 */
export class NativePublicKeyCodec implements PublicKeyCodec {
  readonly #subtle: SubtleCrypto;
  readonly #byKey = new WeakMap<CryptoKey, PreparedPublicKey>();
  readonly #byEncoding = new Map<string, PreparedPublicKey>();

  constructor(subtle: SubtleCrypto) {
    this.#subtle = subtle;
  }

  async preparePublicKey(input: Readonly<{
    algorithm: Hc2PublicKeyAlgorithm;
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }>): Promise<AlgorithmTaggedPublicKeyBytes> {
    const encoded = await exportAndEncodePublicKey({ subtle: this.#subtle, ...input });
    this.#remember(input.algorithm, input.key_id, input.public_key, encoded);
    return Uint8Array.from(encoded) as AlgorithmTaggedPublicKeyBytes;
  }

  async prepareEncodedPublicKey(input: AlgorithmTaggedPublicKeyBytes): Promise<Readonly<{
    algorithm: Hc2PublicKeyAlgorithm;
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }>> {
    const parsed = decodeAlgorithmTaggedPublicKey(input);
    const imported = await importEncodedPublicKey({
      subtle: this.#subtle,
      encoded: Uint8Array.from(input),
      expected_algorithm: parsed.algorithm
    });
    this.#remember(imported.algorithm, imported.key_id, imported.public_key, input);
    return Object.freeze({
      algorithm: imported.algorithm,
      key_id: imported.key_id,
      public_key: imported.public_key
    });
  }

  encode(input: Readonly<{
    algorithm: Hc2PublicKeyAlgorithm;
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }>): AlgorithmTaggedPublicKeyBytes {
    const binding = this.#byKey.get(input.public_key);
    if (!binding || binding.algorithm !== input.algorithm || binding.key_id !== input.key_id) {
      throw cryptoFailure("invalid_key");
    }
    assertPublicKey(input.public_key, input.algorithm);
    return Uint8Array.from(binding.encoded) as AlgorithmTaggedPublicKeyBytes;
  }

  decode(input: AlgorithmTaggedPublicKeyBytes): Readonly<{
    algorithm: Hc2PublicKeyAlgorithm;
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }> {
    const parsed = decodeAlgorithmTaggedPublicKey(input);
    const binding = this.#byEncoding.get(bytesKey(input));
    if (!binding || binding.algorithm !== parsed.algorithm || binding.key_id !== parsed.key_id) {
      throw cryptoFailure("invalid_key");
    }
    assertPublicKey(binding.public_key, binding.algorithm);
    return Object.freeze({
      algorithm: binding.algorithm,
      key_id: binding.key_id,
      public_key: binding.public_key
    });
  }

  #remember(
    algorithm: Hc2PublicKeyAlgorithm,
    keyId: PublicKeyId,
    publicKey: CryptoKey,
    encoded: Uint8Array
  ): void {
    assertPublicKey(publicKey, algorithm);
    const parsed = decodeAlgorithmTaggedPublicKey(encoded, algorithm);
    if (parsed.key_id !== keyId) throw cryptoFailure("invalid_key");
    const binding = Object.freeze({
      algorithm,
      key_id: keyId,
      public_key: publicKey,
      encoded: Object.freeze(Array.from(encoded))
    });
    this.#byKey.set(publicKey, binding);
    this.#byEncoding.set(bytesKey(encoded), binding);
  }
}

export function encodeAlgorithmTaggedPublicKey(input: Readonly<{
  algorithm: Hc2PublicKeyAlgorithm;
  key_id: PublicKeyId;
  raw_public_key: Uint8Array;
}>): AlgorithmTaggedPublicKeyBytes {
  const algorithm = parseAlgorithm(input.algorithm);
  const keyId = parseEntityId("public-key", input.key_id);
  if (!(input.raw_public_key instanceof Uint8Array) || input.raw_public_key.length !== HC2_RAW_PUBLIC_KEY_BYTES) {
    throw cryptoFailure("invalid_key");
  }
  return Uint8Array.from(encodeCanonicalCbor(canonicalArray([
    canonicalText(HC2_PUBLIC_KEY_CODEC_DOMAIN),
    canonicalText(algorithm),
    canonicalText(keyId),
    canonicalBytes(Uint8Array.from(input.raw_public_key))
  ]))) as AlgorithmTaggedPublicKeyBytes;
}

export function decodeAlgorithmTaggedPublicKey(
  value: Uint8Array,
  expectedAlgorithm?: Hc2PublicKeyAlgorithm
): DecodedHc2PublicKey {
  if (!(value instanceof Uint8Array)) throw cryptoFailure("invalid_key");
  try {
    const root = inspectCanonicalValue(decodeCanonicalCbor(Uint8Array.from(value)));
    if (root.kind !== "array" || root.values.length !== 4) throw cryptoFailure("invalid_key");
    const domain = inspectCanonicalValue(root.values[0]);
    const algorithmValue = inspectCanonicalValue(root.values[1]);
    const keyIdValue = inspectCanonicalValue(root.values[2]);
    const rawValue = inspectCanonicalValue(root.values[3]);
    if (domain.kind !== "text" || domain.value !== HC2_PUBLIC_KEY_CODEC_DOMAIN ||
        algorithmValue.kind !== "text" || keyIdValue.kind !== "text" || rawValue.kind !== "bytes") {
      throw cryptoFailure("invalid_key");
    }
    const algorithm = parseAlgorithm(algorithmValue.value);
    if (expectedAlgorithm && algorithm !== expectedAlgorithm) throw cryptoFailure("invalid_key");
    const keyId = parseEntityId("public-key", keyIdValue.value);
    if (rawValue.value.length !== HC2_RAW_PUBLIC_KEY_BYTES) throw cryptoFailure("invalid_key");
    const parsed = Object.freeze({
      algorithm,
      key_id: keyId,
      raw_public_key: Uint8Array.from(rawValue.value)
    });
    const canonical = encodeAlgorithmTaggedPublicKey(parsed);
    if (!equalBytes(canonical, value)) throw cryptoFailure("invalid_key");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "Hc2CryptoProviderError") throw error;
    throw cryptoFailure("invalid_key");
  }
}

export async function exportAndEncodePublicKey(input: Readonly<{
  subtle: SubtleCrypto;
  algorithm: Hc2PublicKeyAlgorithm;
  key_id: PublicKeyId;
  public_key: CryptoKey;
}>): Promise<AlgorithmTaggedPublicKeyBytes> {
  assertPublicKey(input.public_key, input.algorithm);
  try {
    const raw = new Uint8Array(await input.subtle.exportKey("raw", input.public_key));
    return encodeAlgorithmTaggedPublicKey({
      algorithm: input.algorithm,
      key_id: input.key_id,
      raw_public_key: raw
    });
  } catch {
    throw cryptoFailure("public_key_not_extractable");
  }
}

export async function importEncodedPublicKey(input: Readonly<{
  subtle: SubtleCrypto;
  encoded: Uint8Array;
  expected_algorithm: Hc2PublicKeyAlgorithm;
}>): Promise<Readonly<{ algorithm: Hc2PublicKeyAlgorithm; key_id: PublicKeyId; public_key: CryptoKey }>> {
  const parsed = decodeAlgorithmTaggedPublicKey(input.encoded, input.expected_algorithm);
  try {
    const usage: KeyUsage[] = parsed.algorithm === "ed25519" ? ["verify" as KeyUsage] : [];
    const key = await input.subtle.importKey(
      "raw",
      Uint8Array.from(parsed.raw_public_key),
      { name: webCryptoAlgorithmName(parsed.algorithm) },
      true,
      usage
    );
    assertPublicKey(key, parsed.algorithm);
    return Object.freeze({ algorithm: parsed.algorithm, key_id: parsed.key_id, public_key: key });
  } catch {
    throw cryptoFailure("invalid_key");
  }
}

export function assertPublicKey(key: CryptoKey, algorithm: Hc2PublicKeyAlgorithm): void {
  if (!(key instanceof CryptoKey) || key.type !== "public" || key.algorithm.name !== webCryptoAlgorithmName(algorithm) || !key.extractable) {
    throw cryptoFailure("invalid_key");
  }
  const expected: KeyUsage[] = algorithm === "ed25519" ? ["verify" as KeyUsage] : [];
  if (!sameUsages(key.usages, expected)) throw cryptoFailure("invalid_key_usage");
}

function webCryptoAlgorithmName(algorithm: Hc2PublicKeyAlgorithm): "Ed25519" | "X25519" {
  return algorithm === "ed25519" ? "Ed25519" : "X25519";
}

function parseAlgorithm(value: unknown): Hc2PublicKeyAlgorithm {
  if (value !== "ed25519" && value !== "x25519") throw cryptoFailure("invalid_key");
  return value;
}

function sameUsages(actual: readonly KeyUsage[], expected: readonly KeyUsage[]): boolean {
  return actual.length === expected.length && expected.every((usage) => actual.includes(usage));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function bytesKey(value: Uint8Array): string {
  let output = "";
  for (const byte of value) output += byte.toString(16).padStart(2, "0");
  return output;
}

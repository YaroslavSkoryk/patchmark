import {
  parseEntityId,
  type PublicKeyId
} from "../../identities.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  DeviceSigningPrivateKeyHandle,
  X25519RecipientKeyPairHandle,
  X25519RecipientPrivateKeyHandle
} from "../crypto-contracts.ts";
import {
  assertPublicKey,
  exportAndEncodePublicKey
} from "./public-key-codec.ts";
import { cryptoFailure } from "./provider-errors.ts";

type X25519Binding = Readonly<{
  key_pair: CryptoKeyPair;
  encoded_public_key: readonly number[];
}>;

export class Hc2NativeKeyRegistry {
  readonly #subtle: SubtleCrypto;
  readonly #ed25519 = new WeakMap<object, CryptoKeyPair>();
  readonly #x25519 = new WeakMap<object, X25519Binding>();

  constructor(subtle: SubtleCrypto = requireSubtleCrypto()) {
    this.#subtle = subtle;
  }

  get subtle(): SubtleCrypto {
    return this.#subtle;
  }

  async generateDeviceSigningKey(keyId: PublicKeyId): Promise<Readonly<{
    handle: DeviceSigningPrivateKeyHandle;
    public_key: AlgorithmTaggedPublicKeyBytes;
  }>> {
    const pair = asCryptoKeyPair(await this.#subtle.generateKey(
      { name: "Ed25519" },
      false,
      ["sign", "verify"]
    ));
    return this.adoptDeviceSigningKeyPair(keyId, pair);
  }

  async adoptDeviceSigningKeyPair(keyId: PublicKeyId, pair: CryptoKeyPair): Promise<Readonly<{
    handle: DeviceSigningPrivateKeyHandle;
    public_key: AlgorithmTaggedPublicKeyBytes;
  }>> {
    const parsedKeyId = parseEntityId("public-key", keyId);
    validateEd25519Pair(pair);
    const publicKey = await exportAndEncodePublicKey({
      subtle: this.#subtle,
      algorithm: "ed25519",
      key_id: parsedKeyId,
      public_key: pair.publicKey
    });
    const handle = Object.freeze({
      handle_kind: "device_signing_private_key",
      algorithm: "ed25519",
      extractability: "non_extractable",
      custody: "native_webcrypto",
      key_id: parsedKeyId
    }) as DeviceSigningPrivateKeyHandle;
    this.#ed25519.set(handle, pair);
    return Object.freeze({ handle, public_key: Uint8Array.from(publicKey) as AlgorithmTaggedPublicKeyBytes });
  }

  resolveSigningKey(handle: DeviceSigningPrivateKeyHandle): CryptoKey {
    const pair = this.#ed25519.get(handle);
    if (!pair) throw cryptoFailure("invalid_key");
    validateEd25519Pair(pair);
    return pair.privateKey;
  }

  async generateRecipientKeyPair(keyId: PublicKeyId): Promise<X25519RecipientKeyPairHandle> {
    const pair = asCryptoKeyPair(await this.#subtle.generateKey(
      { name: "X25519" },
      false,
      ["deriveBits"]
    ));
    return this.adoptRecipientKeyPair(keyId, pair);
  }

  async adoptRecipientKeyPair(keyId: PublicKeyId, pair: CryptoKeyPair): Promise<X25519RecipientKeyPairHandle> {
    const parsedKeyId = parseEntityId("public-key", keyId);
    validateX25519Pair(pair);
    const publicKey = await exportAndEncodePublicKey({
      subtle: this.#subtle,
      algorithm: "x25519",
      key_id: parsedKeyId,
      public_key: pair.publicKey
    });
    const privateHandle = Object.freeze({
      handle_kind: "recipient_private_key",
      algorithm: "x25519",
      extractability: "non_extractable",
      custody: "native_webcrypto",
      key_id: parsedKeyId
    }) as X25519RecipientPrivateKeyHandle;
    const handle = Object.freeze({
      handle_kind: "recipient_key_pair",
      algorithm: "x25519",
      custody: "native_webcrypto_non_extractable_private",
      key_id: parsedKeyId,
      private_key: privateHandle,
      public_key: Uint8Array.from(publicKey) as AlgorithmTaggedPublicKeyBytes
    }) as X25519RecipientKeyPairHandle;
    this.#x25519.set(handle, Object.freeze({
      key_pair: pair,
      encoded_public_key: Object.freeze(Array.from(publicKey))
    }));
    return handle;
  }

  resolveRecipientKeyPair(handle: X25519RecipientKeyPairHandle): CryptoKeyPair {
    const binding = this.#x25519.get(handle);
    if (!binding || !sameBytes(handle.public_key, binding.encoded_public_key)) {
      throw cryptoFailure("invalid_key");
    }
    validateX25519Pair(binding.key_pair);
    return binding.key_pair;
  }
}

export function requireSubtleCrypto(cryptoApi: Crypto | null = globalThis.crypto ?? null): SubtleCrypto {
  if (!cryptoApi?.subtle) throw cryptoFailure("unsupported_platform");
  return cryptoApi.subtle;
}

export function validateEd25519Pair(pair: CryptoKeyPair): void {
  assertPairShape(pair, "Ed25519", ["sign"], ["verify"]);
  assertPublicKey(pair.publicKey, "ed25519");
}

export function validateX25519Pair(pair: CryptoKeyPair): void {
  assertPairShape(pair, "X25519", ["deriveBits"], []);
  assertPublicKey(pair.publicKey, "x25519");
}

function assertPairShape(
  pair: CryptoKeyPair,
  algorithm: "Ed25519" | "X25519",
  privateUsages: readonly KeyUsage[],
  publicUsages: readonly KeyUsage[]
): void {
  if (!pair || !(pair.privateKey instanceof CryptoKey) || !(pair.publicKey instanceof CryptoKey)) {
    throw cryptoFailure("invalid_key");
  }
  if (pair.privateKey.type !== "private" || pair.privateKey.algorithm.name !== algorithm ||
      pair.publicKey.type !== "public" || pair.publicKey.algorithm.name !== algorithm) {
    throw cryptoFailure("invalid_key");
  }
  if (pair.privateKey.extractable) throw cryptoFailure("private_key_unexpectedly_extractable");
  if (!pair.publicKey.extractable) throw cryptoFailure("public_key_not_extractable");
  if (!sameUsages(pair.privateKey.usages, privateUsages) || !sameUsages(pair.publicKey.usages, publicUsages)) {
    throw cryptoFailure("invalid_key_usage");
  }
}

function asCryptoKeyPair(value: CryptoKeyPair | CryptoKey): CryptoKeyPair {
  if (!value || !("privateKey" in value) || !("publicKey" in value)) throw cryptoFailure("invalid_key");
  return value;
}

function sameUsages(actual: readonly KeyUsage[], expected: readonly KeyUsage[]): boolean {
  return actual.length === expected.length && expected.every((usage) => actual.includes(usage));
}

function sameBytes(actual: Uint8Array, expected: readonly number[]): boolean {
  if (!(actual instanceof Uint8Array) || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

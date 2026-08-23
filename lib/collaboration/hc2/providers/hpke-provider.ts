import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256
} from "@hpke/core";

import {
  decodeCanonicalCbor,
  encodeCanonicalCbor
} from "../../canonical-cbor.ts";
import { protocolValueFromCanonical } from "../../canonical-protocol.ts";
import {
  buildEnvelopeAad,
  buildHpkeInfo,
  isStrictlyConstructedBoundHpkeAad,
  parseHpkeInfoBytes,
  parsePublicEnvelopeHeader,
  type PublicEnvelopeHeader
} from "../envelope.ts";
import { hc2ProtocolLimits } from "../limits.ts";
import type {
  BoundHpkeAadBytes,
  EnvelopeAadBytes,
  HpkeCiphertextBytes,
  HpkeEncapsulatedKeyBytes,
  HpkeInfoBytes,
  RecipientEnvelopeProvider
} from "../crypto-contracts.ts";
import { HC2_CRYPTO_SUITE_ID } from "../versions.ts";
import { Hc2NativeKeyRegistry } from "./native-key-handles.ts";
import { importEncodedPublicKey } from "./public-key-codec.ts";
import { cryptoFailure, Hc2CryptoProviderError } from "./provider-errors.ts";

export const HC2_HPKE_ENCAPSULATED_KEY_BYTES = 32 as const;
export const HC2_HPKE_AUTHENTICATION_TAG_BYTES = 16 as const;

export type Hc2HpkeOperationEvidence = Readonly<{
  sender_contexts_created: number;
  recipient_contexts_created: number;
  sender_seal_calls: number;
  recipient_open_calls: number;
}>;

type Direction = "sender" | "recipient";

export class SingleShotHpkeProvider implements RecipientEnvelopeProvider {
  readonly suite_id = HC2_CRYPTO_SUITE_ID;
  readonly #keys: Hc2NativeKeyRegistry;
  readonly #onContextCreated?: (direction: Direction) => void;
  #senderContexts = 0;
  #recipientContexts = 0;
  #senderCalls = 0;
  #recipientCalls = 0;

  constructor(input: Readonly<{
    keys: Hc2NativeKeyRegistry;
    on_context_created?: (direction: Direction) => void;
  }>) {
    this.#keys = input.keys;
    this.#onContextCreated = input.on_context_created;
  }

  evidence(): Hc2HpkeOperationEvidence {
    return Object.freeze({
      sender_contexts_created: this.#senderContexts,
      recipient_contexts_created: this.#recipientContexts,
      sender_seal_calls: this.#senderCalls,
      recipient_open_calls: this.#recipientCalls
    });
  }

  async sealBound(input: Parameters<RecipientEnvelopeProvider["sealBound"]>[0]): ReturnType<RecipientEnvelopeProvider["sealBound"]> {
    const plaintext = copyBoundedPlaintext(input.plaintext);
    try {
      const info = validateInfo(input.info);
      const recipient = await importEncodedPublicKey({
        subtle: this.#keys.subtle,
        encoded: Uint8Array.from(input.recipient_public_key),
        expected_algorithm: "x25519"
      });
      const suite = createSuite();
      const context = await suite.createSenderContext({
        recipientPublicKey: recipient.public_key,
        info: info.bytes
      });
      this.#senderContexts += 1;
      this.#onContextCreated?.("sender");
      const singleUse = new SingleUseContext(context, "sender");
      try {
        const enc = new Uint8Array(context.enc);
        if (enc.length !== HC2_HPKE_ENCAPSULATED_KEY_BYTES) {
          throw cryptoFailure("internal_provider_invariant");
        }
        const aadValue = finalizeAadExactlyOnce(input.finalize_aad, enc);
        const aad = validateAad(aadValue, BigInt(plaintext.length + HC2_HPKE_AUTHENTICATION_TAG_BYTES));
        if (!sameBytes(aad.header.encapsulated_key_bytes, enc)) throw cryptoFailure("invalid_binding");
        validateInfoForHeader(info, aad.header);
        this.#senderCalls += 1;
        const ciphertext = new Uint8Array(await singleUse.seal(plaintext, aad.bytes));
        if (ciphertext.length !== plaintext.length + HC2_HPKE_AUTHENTICATION_TAG_BYTES) {
          throw cryptoFailure("internal_provider_invariant");
        }
        return Object.freeze({
          encapsulated_key_bytes: Uint8Array.from(enc) as HpkeEncapsulatedKeyBytes,
          ciphertext_bytes: Uint8Array.from(ciphertext) as HpkeCiphertextBytes
        });
      } finally {
        singleUse.discard();
      }
    } catch (error) {
      if (error instanceof Hc2CryptoProviderError) throw error;
      throw cryptoFailure("provider_unavailable");
    } finally {
      plaintext.fill(0);
    }
  }

  async openBound(input: Parameters<RecipientEnvelopeProvider["openBound"]>[0]): ReturnType<RecipientEnvelopeProvider["openBound"]> {
    let ciphertext: Uint8Array;
    let enc: Uint8Array;
    let aad: EnvelopeAadBytes;
    let header: PublicEnvelopeHeader;
    let info: ReturnType<typeof validateInfo>;
    try {
      ciphertext = copyCiphertext(input.ciphertext_bytes);
      header = parsePublicEnvelopeHeader(input.public_header);
      enc = copyEncapsulatedKey(header.encapsulated_key_bytes);
      if (header.ciphertext_length !== BigInt(ciphertext.length)) throw cryptoFailure("invalid_ciphertext");
      aad = buildEnvelopeAad(header);
      info = validateInfo(input.info);
    } catch {
      return Object.freeze({ status: "rejected", reason: "malformed" });
    }
    try {
      validateInfoForHeader(info, header);
    } catch {
      return Object.freeze({ status: "rejected", reason: "authentication_failed" });
    }
    let pair: CryptoKeyPair;
    try {
      pair = this.#keys.resolveRecipientKeyPair(input.recipient_key_pair);
    } catch {
      return Object.freeze({ status: "rejected", reason: "malformed" });
    }
    try {
      const suite = createSuite();
      const context = await suite.createRecipientContext({
        recipientKey: pair,
        enc,
        info: info.bytes
      });
      this.#recipientContexts += 1;
      this.#onContextCreated?.("recipient");
      const singleUse = new SingleUseContext(context, "recipient");
      try {
        this.#recipientCalls += 1;
        const plaintext = new Uint8Array(await singleUse.open(ciphertext, aad));
        if (plaintext.length + HC2_HPKE_AUTHENTICATION_TAG_BYTES !== ciphertext.length) {
          throw cryptoFailure("internal_provider_invariant");
        }
        return Object.freeze({ status: "opened", plaintext: Uint8Array.from(plaintext) });
      } finally {
        singleUse.discard();
      }
    } catch {
      return Object.freeze({ status: "rejected", reason: "authentication_failed" });
    }
  }
}

class SingleUseContext {
  #context: Awaited<ReturnType<CipherSuite["createSenderContext"]>> |
    Awaited<ReturnType<CipherSuite["createRecipientContext"]>> | null;
  readonly #direction: Direction;
  #used = false;

  constructor(
    context: Awaited<ReturnType<CipherSuite["createSenderContext"]>> |
      Awaited<ReturnType<CipherSuite["createRecipientContext"]>>,
    direction: Direction
  ) {
    this.#context = context;
    this.#direction = direction;
  }

  async seal(plaintext: Uint8Array, aad: Uint8Array): Promise<ArrayBuffer> {
    const context = this.#context;
    if (this.#direction !== "sender" || this.#used || !context || !("seal" in context)) {
      throw cryptoFailure("internal_provider_invariant");
    }
    this.#used = true;
    this.#context = null;
    return context.seal(plaintext, aad);
  }

  async open(ciphertext: Uint8Array, aad: Uint8Array): Promise<ArrayBuffer> {
    const context = this.#context;
    if (this.#direction !== "recipient" || this.#used || !context || !("open" in context)) {
      throw cryptoFailure("internal_provider_invariant");
    }
    this.#used = true;
    this.#context = null;
    return context.open(ciphertext, aad);
  }

  discard(): void {
    this.#used = true;
    this.#context = null;
  }
}

function createSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm()
  });
}

function validateAad(value: EnvelopeAadBytes, expectedCiphertextLength: bigint): Readonly<{
  bytes: Uint8Array;
  header: PublicEnvelopeHeader;
}> {
  if (!(value instanceof Uint8Array) || BigInt(value.length) > hc2ProtocolLimits.maximum_public_header_canonical_bytes) {
    throw cryptoFailure("invalid_binding");
  }
  try {
    const bytes = Uint8Array.from(value);
    const decoded = decodeCanonicalCbor(bytes);
    if (!sameBytes(bytes, encodeCanonicalCbor(decoded))) throw cryptoFailure("invalid_binding");
    const protocolValue = protocolValueFromCanonical(decoded);
    if (typeof protocolValue !== "object" || protocolValue === null || Array.isArray(protocolValue)) {
      throw cryptoFailure("invalid_binding");
    }
    const record = protocolValue as Record<string, unknown>;
    if (typeof record.ciphertext_length === "number") {
      record.ciphertext_length = BigInt(record.ciphertext_length);
    }
    const header = parsePublicEnvelopeHeader(record);
    if (header.ciphertext_length !== expectedCiphertextLength) throw cryptoFailure("invalid_binding");
    return Object.freeze({ bytes, header });
  } catch (error) {
    if (error instanceof Hc2CryptoProviderError) throw error;
    throw cryptoFailure("invalid_binding");
  }
}

function validateInfo(value: HpkeInfoBytes): Readonly<{ bytes: Uint8Array }> {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 4096) {
    throw cryptoFailure("invalid_binding");
  }
  const bytes = Uint8Array.from(value);
  try {
    parseHpkeInfoBytes(bytes as HpkeInfoBytes);
  } catch {
    throw cryptoFailure("invalid_binding");
  }
  return Object.freeze({ bytes });
}

function validateInfoForHeader(value: Readonly<{ bytes: Uint8Array }>, header: PublicEnvelopeHeader): void {
  const expected = buildHpkeInfo(header);
  if (!sameBytes(value.bytes, expected)) throw cryptoFailure("invalid_binding");
}

function finalizeAadExactlyOnce(
  finalizer: (encapsulatedKeyBytes: HpkeEncapsulatedKeyBytes) => BoundHpkeAadBytes,
  enc: Uint8Array
): BoundHpkeAadBytes {
  if (typeof finalizer !== "function") throw cryptoFailure("invalid_binding");
  let value: unknown;
  try {
    value = finalizer(Uint8Array.from(enc) as HpkeEncapsulatedKeyBytes);
  } catch {
    throw cryptoFailure("invalid_binding");
  }
  try {
    if (isThenable(value) || !isStrictlyConstructedBoundHpkeAad(value)) {
      throw cryptoFailure("invalid_binding");
    }
  } catch (error) {
    if (error instanceof Hc2CryptoProviderError) throw error;
    throw cryptoFailure("invalid_binding");
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    "then" in value && typeof (value as { then?: unknown }).then === "function";
}

function copyBoundedPlaintext(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || BigInt(value.length) > hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes) {
    throw cryptoFailure("parameter_mismatch");
  }
  return Uint8Array.from(value);
}

function copyCiphertext(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < HC2_HPKE_AUTHENTICATION_TAG_BYTES ||
      BigInt(value.length) > hc2ProtocolLimits.maximum_aead_ciphertext_bytes) {
    throw cryptoFailure("invalid_ciphertext");
  }
  return Uint8Array.from(value);
}

function copyEncapsulatedKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HC2_HPKE_ENCAPSULATED_KEY_BYTES) {
    throw cryptoFailure("invalid_encapsulated_key");
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

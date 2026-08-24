import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256
} from "@hpke/core";

import type {
  AlgorithmTaggedPublicKeyBytes,
  X25519RecipientKeyPairHandle
} from "../crypto-contracts.ts";
import { hc2ProtocolLimits } from "../limits.ts";
import {
  buildTransportBoundAadV2,
  buildTransportHpkeInfoV2,
  isStrictlyConstructedTransportAadV2,
  parsePublicEnvelopeHeaderV2,
  type PublicEnvelopeHeaderV2
} from "../transport-v2-contracts.ts";
import { Hc2NativeKeyRegistry } from "./native-key-handles.ts";
import { importEncodedPublicKey } from "./public-key-codec.ts";

export type TransportHpkeV2Evidence = Readonly<{
  sender_contexts_created: number;
  recipient_contexts_created: number;
  sender_seal_calls: number;
  recipient_open_calls: number;
}>;

export interface RecipientTransportEnvelopeProviderV2 {
  sealBound(input: Readonly<{
    recipient_public_key: AlgorithmTaggedPublicKeyBytes;
    info_binding: Omit<PublicEnvelopeHeaderV2, "encapsulated_key_bytes" | "ciphertext_length">;
    plaintext: Uint8Array;
    finalize_header: (encapsulatedKeyBytes: Uint8Array, ciphertextLength: bigint) => PublicEnvelopeHeaderV2;
  }>): Promise<Readonly<{
    public_header: PublicEnvelopeHeaderV2;
    ciphertext_bytes: Uint8Array;
  }>>;
  openBound(input: Readonly<{
    recipient_key_pair: X25519RecipientKeyPairHandle;
    public_header: PublicEnvelopeHeaderV2;
    ciphertext_bytes: Uint8Array;
  }>): Promise<
    | Readonly<{ status: "opened"; plaintext: Uint8Array }>
    | Readonly<{ status: "rejected"; reason: "authentication_failed" | "malformed" | "unsupported_suite" }>
  >;
}

/** One HPKE sender or recipient context is created and consumed per container. */
export class SingleShotHpkeV2Provider implements RecipientTransportEnvelopeProviderV2 {
  readonly #keys: Hc2NativeKeyRegistry;
  #senderContexts = 0;
  #recipientContexts = 0;
  #senderCalls = 0;
  #recipientCalls = 0;

  constructor(input: Readonly<{ keys: Hc2NativeKeyRegistry }>) {
    this.#keys = input.keys;
  }

  evidence(): TransportHpkeV2Evidence {
    return Object.freeze({
      sender_contexts_created: this.#senderContexts,
      recipient_contexts_created: this.#recipientContexts,
      sender_seal_calls: this.#senderCalls,
      recipient_open_calls: this.#recipientCalls
    });
  }

  async sealBound(input: Parameters<RecipientTransportEnvelopeProviderV2["sealBound"]>[0]): ReturnType<RecipientTransportEnvelopeProviderV2["sealBound"]> {
    const plaintext = copyPlaintext(input.plaintext);
    try {
      const recipient = await importEncodedPublicKey({
        subtle: this.#keys.subtle,
        encoded: Uint8Array.from(input.recipient_public_key),
        expected_algorithm: "x25519"
      });
      const suite = createSuite();
      const info = buildTransportHpkeInfoV2(input.info_binding);
      const context = await suite.createSenderContext({ recipientPublicKey: recipient.public_key, info });
      this.#senderContexts += 1;
      const enc = new Uint8Array(context.enc);
      if (enc.length !== 32) throw new Error("invalid_encapsulated_key");
      const header = parsePublicEnvelopeHeaderV2(input.finalize_header(Uint8Array.from(enc), BigInt(plaintext.length + 16)));
      if (!sameBytes(header.encapsulated_key_bytes, enc)) throw new Error("invalid_binding");
      if (!sameBytes(buildTransportHpkeInfoV2(header), info)) throw new Error("invalid_binding");
      const aad = buildTransportBoundAadV2(header);
      if (!isStrictlyConstructedTransportAadV2(aad)) throw new Error("invalid_binding");
      this.#senderCalls += 1;
      const ciphertext = new Uint8Array(await context.seal(plaintext, aad));
      if (ciphertext.length !== plaintext.length + 16 || BigInt(ciphertext.length) !== header.ciphertext_length) {
        throw new Error("invalid_ciphertext_length");
      }
      return Object.freeze({ public_header: header, ciphertext_bytes: Uint8Array.from(ciphertext) });
    } finally {
      plaintext.fill(0);
    }
  }

  async openBound(input: Parameters<RecipientTransportEnvelopeProviderV2["openBound"]>[0]): ReturnType<RecipientTransportEnvelopeProviderV2["openBound"]> {
    let header: PublicEnvelopeHeaderV2;
    let ciphertext: Uint8Array;
    try {
      header = parsePublicEnvelopeHeaderV2(input.public_header);
      ciphertext = copyCiphertext(input.ciphertext_bytes);
      if (header.ciphertext_length !== BigInt(ciphertext.length)) throw new Error("length");
    } catch {
      return Object.freeze({ status: "rejected", reason: "malformed" });
    }
    try {
      const pair = this.#keys.resolveRecipientKeyPair(input.recipient_key_pair);
      const suite = createSuite();
      const context = await suite.createRecipientContext({
        recipientKey: pair,
        enc: Uint8Array.from(header.encapsulated_key_bytes),
        info: buildTransportHpkeInfoV2(header)
      });
      this.#recipientContexts += 1;
      this.#recipientCalls += 1;
      const plaintext = new Uint8Array(await context.open(ciphertext, buildTransportBoundAadV2(header)));
      if (plaintext.length + 16 !== ciphertext.length) throw new Error("length");
      return Object.freeze({ status: "opened", plaintext: Uint8Array.from(plaintext) });
    } catch {
      return Object.freeze({ status: "rejected", reason: "authentication_failed" });
    }
  }
}

function createSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm()
  });
}

function copyPlaintext(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || BigInt(value.length) > hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes) {
    throw new Error("Transport plaintext is outside the frozen bound.");
  }
  return Uint8Array.from(value);
}

function copyCiphertext(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 16 || BigInt(value.length) > hc2ProtocolLimits.maximum_aead_ciphertext_bytes) {
    throw new Error("Transport ciphertext is outside the frozen bound.");
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

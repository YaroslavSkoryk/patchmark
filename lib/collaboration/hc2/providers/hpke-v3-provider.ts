import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import type { AlgorithmTaggedPublicKeyBytes, X25519RecipientKeyPairHandle } from "../crypto-contracts.ts";
import { hc2ProtocolLimits } from "../limits.ts";
import {
  buildTransportBoundAadV3,
  buildTransportHpkeInfoV3,
  isStrictlyConstructedTransportAadV3,
  parsePublicEnvelopeHeaderV3,
  type PublicEnvelopeHeaderV3
} from "../transport-v3-contracts.ts";
import { Hc2NativeKeyRegistry } from "./native-key-handles.ts";
import { importEncodedPublicKey } from "./public-key-codec.ts";

export type TransportHpkeV3Evidence = Readonly<{
  sender_contexts_created: number;
  recipient_contexts_created: number;
  sender_seal_calls: number;
  recipient_open_calls: number;
}>;

export interface RecipientTransportEnvelopeProviderV3 {
  sealBound(input: Readonly<{
    recipient_public_key: AlgorithmTaggedPublicKeyBytes;
    info_binding: Omit<PublicEnvelopeHeaderV3, "encapsulated_key_bytes" | "ciphertext_length">;
    plaintext: Uint8Array;
    finalize_header: (enc: Uint8Array, ciphertextLength: bigint) => PublicEnvelopeHeaderV3;
  }>): Promise<Readonly<{ public_header: PublicEnvelopeHeaderV3; ciphertext_bytes: Uint8Array }>>;
  openBound(input: Readonly<{
    recipient_key_pair: X25519RecipientKeyPairHandle;
    public_header: PublicEnvelopeHeaderV3;
    ciphertext_bytes: Uint8Array;
  }>): Promise<Readonly<{ status: "opened"; plaintext: Uint8Array }> | Readonly<{ status: "rejected"; reason: "authentication_failed" | "malformed" }>>;
}

/** Separate V3 single-use HPKE contexts and AAD construction. */
export class SingleShotHpkeV3Provider implements RecipientTransportEnvelopeProviderV3 {
  readonly #keys: Hc2NativeKeyRegistry;
  #senderContexts = 0;
  #recipientContexts = 0;
  #senderCalls = 0;
  #recipientCalls = 0;

  constructor(input: Readonly<{ keys: Hc2NativeKeyRegistry }>) { this.#keys = input.keys; }

  evidence(): TransportHpkeV3Evidence {
    return Object.freeze({ sender_contexts_created: this.#senderContexts, recipient_contexts_created: this.#recipientContexts, sender_seal_calls: this.#senderCalls, recipient_open_calls: this.#recipientCalls });
  }

  async sealBound(input: Parameters<RecipientTransportEnvelopeProviderV3["sealBound"]>[0]): ReturnType<RecipientTransportEnvelopeProviderV3["sealBound"]> {
    const plaintext = copyPlaintext(input.plaintext);
    try {
      const recipient = await importEncodedPublicKey({ subtle: this.#keys.subtle, encoded: Uint8Array.from(input.recipient_public_key), expected_algorithm: "x25519" });
      const context = await createSuite().createSenderContext({ recipientPublicKey: recipient.public_key, info: buildTransportHpkeInfoV3(input.info_binding) });
      this.#senderContexts += 1;
      const enc = new Uint8Array(context.enc);
      const header = parsePublicEnvelopeHeaderV3(input.finalize_header(enc, BigInt(plaintext.length + 16)));
      if (!sameBytes(header.encapsulated_key_bytes, enc)) throw new Error("V3 HPKE encapsulated key binding mismatch.");
      const aad = buildTransportBoundAadV3(header);
      if (!isStrictlyConstructedTransportAadV3(aad)) throw new Error("V3 HPKE AAD was not constructed from the complete header.");
      this.#senderCalls += 1;
      const ciphertext = new Uint8Array(await context.seal(plaintext, aad));
      if (BigInt(ciphertext.length) !== header.ciphertext_length) throw new Error("V3 HPKE ciphertext length mismatch.");
      return Object.freeze({ public_header: header, ciphertext_bytes: Uint8Array.from(ciphertext) });
    } finally { plaintext.fill(0); }
  }

  async openBound(input: Parameters<RecipientTransportEnvelopeProviderV3["openBound"]>[0]): ReturnType<RecipientTransportEnvelopeProviderV3["openBound"]> {
    let header: PublicEnvelopeHeaderV3;
    let ciphertext: Uint8Array;
    try {
      header = parsePublicEnvelopeHeaderV3(input.public_header);
      ciphertext = copyCiphertext(input.ciphertext_bytes);
      if (header.ciphertext_length !== BigInt(ciphertext.length)) throw new Error("length");
    } catch { return Object.freeze({ status: "rejected", reason: "malformed" }); }
    try {
      const context = await createSuite().createRecipientContext({
        recipientKey: this.#keys.resolveRecipientKeyPair(input.recipient_key_pair),
        enc: Uint8Array.from(header.encapsulated_key_bytes),
        info: buildTransportHpkeInfoV3(header)
      });
      this.#recipientContexts += 1;
      this.#recipientCalls += 1;
      const plaintext = new Uint8Array(await context.open(ciphertext, buildTransportBoundAadV3(header)));
      return Object.freeze({ status: "opened", plaintext: Uint8Array.from(plaintext) });
    } catch { return Object.freeze({ status: "rejected", reason: "authentication_failed" }); }
  }
}

function createSuite(): CipherSuite { return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }); }
function copyPlaintext(value: Uint8Array): Uint8Array { if (!(value instanceof Uint8Array) || value.length === 0 || BigInt(value.length) > hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes) throw new Error("V3 transport plaintext is outside the frozen bound."); return Uint8Array.from(value); }
function copyCiphertext(value: Uint8Array): Uint8Array { if (!(value instanceof Uint8Array) || value.length < 16 || BigInt(value.length) > hc2ProtocolLimits.maximum_aead_ciphertext_bytes) throw new Error("V3 transport ciphertext is outside the frozen bound."); return Uint8Array.from(value); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }

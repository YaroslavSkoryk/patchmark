import {
  parseDigestId,
  parseEntityId
} from "../../identities.ts";
import { hc2ProtocolLimits } from "../limits.ts";
import type {
  AcceptedSignerPublicKey,
  SenderSignaturePreimageBytes,
  SignatureProvider
} from "../crypto-contracts.ts";
import { Hc2NativeKeyRegistry } from "./native-key-handles.ts";
import { importEncodedPublicKey } from "./public-key-codec.ts";
import { cryptoFailure } from "./provider-errors.ts";

export const HC2_ED25519_SIGNATURE_BYTES = 64 as const;

export type Hc2ValidSignatureResult = Readonly<{
  status: "valid_signature";
  signer: AcceptedSignerPublicKey;
  binding: Readonly<{
    project_id: AcceptedSignerPublicKey["project_id"];
    device_id: AcceptedSignerPublicKey["device_id"];
    key_id: AcceptedSignerPublicKey["key_id"];
    control_head_id: AcceptedSignerPublicKey["control_head_id"];
    preimage_sha256_hex: string;
  }>;
}>;

export class NativeEd25519SignatureProvider implements SignatureProvider {
  readonly #keys: Hc2NativeKeyRegistry;

  constructor(keys: Hc2NativeKeyRegistry) {
    this.#keys = keys;
  }

  async sign(input: Parameters<SignatureProvider["sign"]>[0]): Promise<Readonly<{
    algorithm: "ed25519";
    signature_bytes: Uint8Array;
  }>> {
    const preimage = copyPreimage(input.preimage);
    const privateKey = this.#keys.resolveSigningKey(input.key);
    try {
      const signature = new Uint8Array(await this.#keys.subtle.sign("Ed25519", privateKey, asArrayBuffer(preimage)));
      if (signature.length !== HC2_ED25519_SIGNATURE_BYTES) throw cryptoFailure("internal_provider_invariant");
      return Object.freeze({ algorithm: "ed25519", signature_bytes: Uint8Array.from(signature) });
    } catch (error) {
      if (error instanceof Error && error.name === "Hc2CryptoProviderError") throw error;
      throw cryptoFailure("provider_unavailable");
    }
  }

  async verify(input: Parameters<SignatureProvider["verify"]>[0]): Promise<
    Hc2ValidSignatureResult |
    Readonly<{ status: "invalid_signature"; reason: "malformed" | "mismatch" }>
  > {
    const preimage = copyPreimage(input.preimage);
    if (!(input.signature_bytes instanceof Uint8Array) || input.signature_bytes.length !== HC2_ED25519_SIGNATURE_BYTES) {
      return Object.freeze({ status: "invalid_signature", reason: "malformed" });
    }
    let signer: AcceptedSignerPublicKey;
    try {
      signer = validateAcceptedSigner(input.signer);
      const decoded = await importEncodedPublicKey({
        subtle: this.#keys.subtle,
        encoded: signer.public_key_bytes,
        expected_algorithm: "ed25519"
      });
      if (decoded.key_id !== signer.key_id) return Object.freeze({ status: "invalid_signature", reason: "malformed" });
      const valid = await this.#keys.subtle.verify(
        "Ed25519",
        decoded.public_key,
        asArrayBuffer(Uint8Array.from(input.signature_bytes)),
        asArrayBuffer(preimage)
      );
      if (!valid) return Object.freeze({ status: "invalid_signature", reason: "mismatch" });
      const digest = new Uint8Array(await this.#keys.subtle.digest("SHA-256", asArrayBuffer(preimage)));
      return Object.freeze({
        status: "valid_signature",
        signer,
        binding: Object.freeze({
          project_id: signer.project_id,
          device_id: signer.device_id,
          key_id: signer.key_id,
          control_head_id: signer.control_head_id,
          preimage_sha256_hex: toHex(digest)
        })
      });
    } catch {
      return Object.freeze({ status: "invalid_signature", reason: "malformed" });
    }
  }
}

function validateAcceptedSigner(value: AcceptedSignerPublicKey): AcceptedSignerPublicKey {
  if (!value || value.resolution !== "accepted_control_state" || value.algorithm !== "ed25519" ||
      !(value.public_key_bytes instanceof Uint8Array)) {
    throw cryptoFailure("invalid_key");
  }
  parseEntityId("project", value.project_id);
  parseEntityId("device", value.device_id);
  parseEntityId("public-key", value.key_id);
  parseDigestId("control-event", value.control_head_id);
  return value;
}

function copyPreimage(value: SenderSignaturePreimageBytes): Uint8Array {
  if (!(value instanceof Uint8Array) || BigInt(value.length) > hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes) {
    throw cryptoFailure("parameter_mismatch");
  }
  return Uint8Array.from(value);
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

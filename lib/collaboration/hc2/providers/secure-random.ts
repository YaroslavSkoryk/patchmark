import type { RandomBytes, RandomSource } from "../crypto-contracts.ts";
import { cryptoFailure } from "./provider-errors.ts";

export const HC2_RANDOM_VALUES_CHUNK_BYTES = 65_536 as const;
export const HC2_MAXIMUM_RANDOM_REQUEST_BYTES = 16 * 1024 * 1024;

export class WebCryptoRandomSource implements RandomSource {
  readonly #crypto: Crypto | null;

  constructor(cryptoApi: Crypto | null = globalThis.crypto ?? null) {
    this.#crypto = cryptoApi;
  }

  async randomBytes(length: number): Promise<RandomBytes> {
    if (!Number.isSafeInteger(length) || length < 0 || length > HC2_MAXIMUM_RANDOM_REQUEST_BYTES) {
      throw cryptoFailure("parameter_mismatch");
    }
    if (!this.#crypto || typeof this.#crypto.getRandomValues !== "function") {
      throw cryptoFailure("provider_unavailable");
    }
    const output = new Uint8Array(length);
    try {
      for (let offset = 0; offset < output.length; offset += HC2_RANDOM_VALUES_CHUNK_BYTES) {
        this.#crypto.getRandomValues(
          output.subarray(offset, Math.min(offset + HC2_RANDOM_VALUES_CHUNK_BYTES, output.length))
        );
      }
    } catch {
      output.fill(0);
      throw cryptoFailure("provider_unavailable");
    }
    return Uint8Array.from(output) as RandomBytes;
  }
}

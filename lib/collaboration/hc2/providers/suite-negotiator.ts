import type { Hc2CryptoSuite, SuiteNegotiator } from "../crypto-contracts.ts";
import { hc2CryptoSuite } from "../crypto-contracts.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_ENVELOPE_VERSION,
  HC2_HPKE_INFO_PROTOCOL_DOMAIN
} from "../versions.ts";
import { cryptoFailure } from "./provider-errors.ts";

export type Hc2SuiteCapabilities = Readonly<{
  secure_random: boolean;
  ed25519: boolean;
  x25519: boolean;
  hpke_base_x25519_hkdf_sha256_aes256gcm: boolean;
  argon2id: boolean;
  xchacha20_poly1305: boolean;
}>;

export type Hc2StrictSuiteSelection = Readonly<{
  status: "selected";
  suite: Hc2CryptoSuite;
  bindings: Readonly<{
    envelope_version: typeof HC2_ENVELOPE_VERSION;
    hpke_info_domain: typeof HC2_HPKE_INFO_PROTOCOL_DOMAIN;
    public_key_codec: "patchmark/hc2/public-key/v1";
    recovery_parameter_version: 1;
  }>;
}>;

const requiredComponents = Object.freeze([
  "secure_random",
  "ed25519",
  "x25519",
  "hpke_base_x25519_hkdf_sha256_aes256gcm",
  "argon2id",
  "xchacha20_poly1305"
] as const);

export class ExactHc2SuiteNegotiator implements SuiteNegotiator {
  readonly #capabilities: Hc2SuiteCapabilities;

  constructor(capabilities: Hc2SuiteCapabilities) {
    this.#capabilities = Object.freeze({ ...capabilities });
  }

  negotiate(offeredSuiteIds: readonly string[]): Hc2StrictSuiteSelection |
    Readonly<{ status: "rejected"; reason: "no_exact_supported_suite" }> {
    if (!Array.isArray(offeredSuiteIds) || offeredSuiteIds.length !== 1 ||
        offeredSuiteIds[0] !== HC2_CRYPTO_SUITE_ID) {
      return Object.freeze({ status: "rejected", reason: "no_exact_supported_suite" });
    }
    if (requiredComponents.some((component) => this.#capabilities[component] !== true)) {
      throw cryptoFailure("unsupported_platform");
    }
    return Object.freeze({
      status: "selected",
      suite: hc2CryptoSuite,
      bindings: Object.freeze({
        envelope_version: HC2_ENVELOPE_VERSION,
        hpke_info_domain: HC2_HPKE_INFO_PROTOCOL_DOMAIN,
        public_key_codec: "patchmark/hc2/public-key/v1",
        recovery_parameter_version: 1
      })
    });
  }
}

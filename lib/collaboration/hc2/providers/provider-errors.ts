export const hc2CryptoErrorCodes = [
  "unsupported_platform",
  "provider_unavailable",
  "unsupported_suite",
  "invalid_key",
  "invalid_key_usage",
  "public_key_not_extractable",
  "private_key_unexpectedly_extractable",
  "invalid_signature",
  "authentication_failure",
  "invalid_ciphertext",
  "invalid_encapsulated_key",
  "invalid_binding",
  "parameter_mismatch",
  "recovery_authentication_failure",
  "operation_aborted",
  "internal_provider_invariant"
] as const;

export type Hc2CryptoErrorCode = (typeof hc2CryptoErrorCodes)[number];

const safeMessages: Readonly<Record<Hc2CryptoErrorCode, string>> = Object.freeze({
  unsupported_platform: "The required cryptographic platform capability is unavailable.",
  provider_unavailable: "The cryptographic provider is unavailable.",
  unsupported_suite: "The cryptographic suite is unsupported.",
  invalid_key: "The cryptographic key is invalid.",
  invalid_key_usage: "The cryptographic key has an invalid usage.",
  public_key_not_extractable: "The public key cannot be exported in the required format.",
  private_key_unexpectedly_extractable: "The private key violates the non-extractability requirement.",
  invalid_signature: "The signature is invalid.",
  authentication_failure: "The authenticated operation was rejected.",
  invalid_ciphertext: "The ciphertext is invalid.",
  invalid_encapsulated_key: "The encapsulated key is invalid.",
  invalid_binding: "The authenticated protocol binding is invalid.",
  parameter_mismatch: "The cryptographic parameters do not match the required version.",
  recovery_authentication_failure: "The recovery material could not be authenticated.",
  operation_aborted: "The cryptographic operation was aborted.",
  internal_provider_invariant: "A cryptographic provider invariant failed."
});

/** A deliberately secret-free error for future UI and diagnostic classification. */
export class Hc2CryptoProviderError extends Error {
  readonly code: Hc2CryptoErrorCode;

  constructor(code: Hc2CryptoErrorCode) {
    super(safeMessages[code]);
    this.name = "Hc2CryptoProviderError";
    this.code = code;
    Object.freeze(this);
  }
}

export function cryptoFailure(code: Hc2CryptoErrorCode): Hc2CryptoProviderError {
  return new Hc2CryptoProviderError(code);
}

export function failClosedCryptoError(error: unknown): Hc2CryptoProviderError {
  if (error instanceof Hc2CryptoProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return cryptoFailure("operation_aborted");
  }
  return cryptoFailure("internal_provider_invariant");
}

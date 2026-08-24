import type {
  ControlEventId,
  DeviceId,
  PersonId,
  ProjectId,
  PublicKeyId
} from "../identities.ts";
import type { PublicEnvelopeHeader } from "./envelope.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_CRYPTO_SUITE_VERSION } from "./versions.ts";

export const hc2CryptoSuite = Object.freeze({
  suite_version: HC2_CRYPTO_SUITE_VERSION,
  suite_id: HC2_CRYPTO_SUITE_ID,
  identity_hash: "sha-256" as const,
  signature: "ed25519" as const,
  recipient_key: "x25519" as const,
  hpke_mode: "base" as const,
  hpke_mode_id: 0x00 as const,
  hpke_kem: "dhkem-x25519-hkdf-sha256" as const,
  hpke_kem_id: 0x0020 as const,
  hpke_kdf: "hkdf-sha256" as const,
  hpke_kdf_id: 0x0001 as const,
  hpke_aead: "aes-256-gcm" as const,
  hpke_aead_id: 0x0002 as const,
  recovery_kdf: "argon2id" as const,
  recovery_aead: "xchacha20-poly1305" as const
});

export type Hc2CryptoSuite = typeof hc2CryptoSuite;

declare const randomBytesBrand: unique symbol;
declare const signaturePreimageBrand: unique symbol;
declare const envelopeAadBrand: unique symbol;
declare const boundEnvelopeAadBrand: unique symbol;
declare const hpkeInfoBrand: unique symbol;
declare const hpkeEncapsulatedKeyBrand: unique symbol;
declare const hpkeCiphertextBrand: unique symbol;
declare const publicKeyEncodingBrand: unique symbol;
declare const privateKeyHandleBrand: unique symbol;
declare const keyPairHandleBrand: unique symbol;
declare const acceptedSignerBrand: unique symbol;
declare const rootCeremonyBrand: unique symbol;
declare const recoveryCeremonyBrand: unique symbol;

export type RandomBytes = Uint8Array & { readonly [randomBytesBrand]: "random" };
export type SenderSignaturePreimageBytes = Uint8Array & { readonly [signaturePreimageBrand]: "hc2-envelope-signature-preimage" };
export type EnvelopeAadBytes = Uint8Array & { readonly [envelopeAadBrand]: "hc2-envelope-aad" };
export type BoundHpkeAadBytes = EnvelopeAadBytes & { readonly [boundEnvelopeAadBrand]: "hc2-bound-hpke-aad" };
export type HpkeInfoBytes = Uint8Array & { readonly [hpkeInfoBrand]: "hc2-hpke-info" };
export type HpkeEncapsulatedKeyBytes = Uint8Array & { readonly [hpkeEncapsulatedKeyBrand]: "hc2-hpke-enc" };
export type HpkeCiphertextBytes = Uint8Array & { readonly [hpkeCiphertextBrand]: "hc2-hpke-ciphertext" };
export type AlgorithmTaggedPublicKeyBytes = Uint8Array & { readonly [publicKeyEncodingBrand]: "algorithm-tagged-public-key" };

export type DeviceSigningPrivateKeyHandle = Readonly<{
  handle_kind: "device_signing_private_key";
  algorithm: "ed25519";
  extractability: "non_extractable";
  custody: "native_webcrypto";
  key_id: PublicKeyId;
  readonly [privateKeyHandleBrand]: "device-signing";
}>;

export type X25519RecipientPrivateKeyHandle = Readonly<{
  handle_kind: "recipient_private_key";
  algorithm: "x25519";
  extractability: "non_extractable";
  custody: "native_webcrypto";
  key_id: PublicKeyId;
  readonly [privateKeyHandleBrand]: "x25519-recipient";
}>;

export type X25519RecipientKeyPairHandle = Readonly<{
  handle_kind: "recipient_key_pair";
  algorithm: "x25519";
  custody: "native_webcrypto_non_extractable_private";
  key_id: PublicKeyId;
  private_key: X25519RecipientPrivateKeyHandle;
  public_key: AlgorithmTaggedPublicKeyBytes;
  readonly [keyPairHandleBrand]: "x25519-recipient-pair";
}>;

export type DeviceKekHandle = Readonly<{
  handle_kind: "device_key_encryption_key";
  extractability: "non_extractable";
  custody: "native_webcrypto";
  readonly [privateKeyHandleBrand]: "device-kek";
}>;

export type RootCeremonyCapability = Readonly<{
  scope: "root_ceremony_only";
  person_id: PersonId;
  readonly [rootCeremonyBrand]: "root-ceremony";
}>;

export type RecoveryCeremonyCapability = Readonly<{
  scope: "recovery_ceremony_only";
  person_id: PersonId;
  readonly [recoveryCeremonyBrand]: "recovery-ceremony";
}>;

export type AcceptedSignerPublicKey = Readonly<{
  resolution: "accepted_control_state";
  project_id: ProjectId;
  device_id: DeviceId;
  key_id: PublicKeyId;
  control_head_id: ControlEventId;
  algorithm: "ed25519";
  public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  readonly [acceptedSignerBrand]: "accepted-signer";
}>;

export interface RandomSource {
  randomBytes(length: number): Promise<RandomBytes>;
}

export interface SignatureProvider {
  sign(input: Readonly<{
    key: DeviceSigningPrivateKeyHandle;
    preimage: SenderSignaturePreimageBytes;
  }>): Promise<Readonly<{ algorithm: "ed25519"; signature_bytes: Uint8Array }>>;
  verify(input: Readonly<{
    signer: AcceptedSignerPublicKey;
    preimage: SenderSignaturePreimageBytes;
    signature_bytes: Uint8Array;
  }>): Promise<
    | Readonly<{ status: "valid_signature"; signer: AcceptedSignerPublicKey }>
    | Readonly<{ status: "invalid_signature"; reason: "malformed" | "mismatch" }>
  >;
}

export interface RecipientEnvelopeProvider {
  readonly suite_id: typeof HC2_CRYPTO_SUITE_ID;
  sealBound(input: Readonly<{
    recipient_public_key: AlgorithmTaggedPublicKeyBytes;
    info: HpkeInfoBytes;
    plaintext: Uint8Array;
    finalize_aad: (encapsulatedKeyBytes: HpkeEncapsulatedKeyBytes) => BoundHpkeAadBytes;
  }>): Promise<Readonly<{
    encapsulated_key_bytes: HpkeEncapsulatedKeyBytes;
    ciphertext_bytes: HpkeCiphertextBytes;
  }>>;
  openBound(input: Readonly<{
    recipient_key_pair: X25519RecipientKeyPairHandle;
    info: HpkeInfoBytes;
    public_header: PublicEnvelopeHeader;
    ciphertext_bytes: HpkeCiphertextBytes;
  }>): Promise<
    | Readonly<{ status: "opened"; plaintext: Uint8Array }>
    | Readonly<{ status: "rejected"; reason: "authentication_failed" | "malformed" | "unsupported_suite" }>
  >;
}

export interface RecoveryProtector {
  protect(input: Readonly<{
    capability: RootCeremonyCapability;
    recovery_payload: Uint8Array;
    password_material: Uint8Array;
  }>): Promise<Readonly<{ suite_id: typeof HC2_CRYPTO_SUITE_ID; protected_bytes: Uint8Array }>>;
  unlock(input: Readonly<{
    capability: RecoveryCeremonyCapability;
    protected_bytes: Uint8Array;
    password_material: Uint8Array;
  }>): Promise<
    | Readonly<{ status: "unlocked"; ceremony_payload: Uint8Array }>
    | Readonly<{ status: "rejected"; reason: "wrong_password" | "malformed" | "unsupported_suite" }>
  >;
}

export interface KeyVault {
  loadDeviceSigningKey(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceSigningPrivateKeyHandle | null>;
  loadRecipientKeyPair(projectId: ProjectId, deviceId: DeviceId): Promise<X25519RecipientKeyPairHandle | null>;
  loadDeviceKek(projectId: ProjectId, deviceId: DeviceId): Promise<DeviceKekHandle | null>;
}

export interface PublicKeyCodec {
  encode(input: Readonly<{
    algorithm: "ed25519" | "x25519";
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }>): AlgorithmTaggedPublicKeyBytes;
  decode(input: AlgorithmTaggedPublicKeyBytes): Readonly<{
    algorithm: "ed25519" | "x25519";
    key_id: PublicKeyId;
    public_key: CryptoKey;
  }>;
}

export interface SuiteNegotiator {
  negotiate(offeredSuiteIds: readonly string[]):
    | Readonly<{ status: "selected"; suite: Hc2CryptoSuite }>
    | Readonly<{ status: "rejected"; reason: "no_exact_supported_suite" }>;
}

export interface AcceptedControlStateSignerKeyResolver {
  resolve(input: Readonly<{
    project_id: ProjectId;
    sender_device_id: DeviceId;
    asserted_key_id: PublicKeyId;
    accepted_control_head_id: ControlEventId;
  }>): Promise<
    | Readonly<{ status: "resolved"; signer: AcceptedSignerPublicKey }>
    | Readonly<{ status: "rejected"; reason: "unknown_device" | "revoked_device" | "key_mismatch" | "control_head_mismatch" }>
  >;
}

export function parseHc2CryptoSuiteId(value: unknown): typeof HC2_CRYPTO_SUITE_ID {
  if (value !== HC2_CRYPTO_SUITE_ID) {
    throw new Error("Unknown or partially supported HC-2 cryptographic suite.");
  }
  return value;
}

import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type ControlEventId,
  type DeviceId,
  type KeyEpochId,
  type PersonId,
  type ProjectId,
  type PublicKeyId
} from "../identities.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  DeviceKekHandle,
  RandomSource,
  SenderSignaturePreimageBytes
} from "./crypto-contracts.ts";
import {
  parseAcceptedCustodyAuthority,
  type AcceptedCustodyAuthority,
  type DeviceCustodyPublicBinding,
  type LoadedDeviceCustody,
  type PreparedDeviceCustodyHandle
} from "./custody-types.ts";
import {
  parseStoredDeviceVaultRecord,
  type CustodyCeremonyJournal,
  type Hc2CustodyStore,
  type StoredDeviceVaultRecord
} from "./custody-store.ts";
import {
  HC2_EPOCH_SECRET_BYTES,
  HC2_EPOCH_WRAP_NONCE_BYTES,
  validateWrappingKey,
  withUnwrappedEpoch,
  wrapEpochSecret,
  type WrappedLocalEpochRecord
} from "./epoch-custody.ts";
import { buildBoundHpkeAad, buildHpkeInfo } from "./envelope.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_CUSTODY_SCHEMA_VERSION, HC2_ENVELOPE_MAGIC } from "./versions.ts";
import { NativeEd25519SignatureProvider } from "./providers/ed25519-provider.ts";
import { SingleShotHpkeProvider } from "./providers/hpke-provider.ts";
import {
  Hc2NativeKeyRegistry,
  validateEd25519Pair,
  validateX25519Pair
} from "./providers/native-key-handles.ts";
import { exportAndEncodePublicKey } from "./providers/public-key-codec.ts";

type PreparedSecretState = Readonly<{
  record_without_control: Omit<StoredDeviceVaultRecord, "accepted_control_head_id" | "current_epoch_commitment" | "current_epoch_public_commitment_bytes">;
  wrapped_epoch: WrappedLocalEpochRecord;
  public_without_control: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">;
}>;

type LoadedSecretState = Readonly<{
  vault: StoredDeviceVaultRecord;
  wrapped_epoch: WrappedLocalEpochRecord;
  registry: Hc2NativeKeyRegistry;
}>;

const selfTestKekNonce = new Uint8Array(HC2_EPOCH_WRAP_NONCE_BYTES).fill(0xff);

export class Hc2DeviceVaultService {
  readonly #store: Hc2CustodyStore;
  readonly #random: RandomSource;
  readonly #subtle: SubtleCrypto;
  readonly #prepared = new WeakMap<object, PreparedSecretState>();
  readonly #loaded = new WeakMap<object, LoadedSecretState>();
  readonly #keks = new WeakMap<object, CryptoKey>();

  constructor(input: Readonly<{ store: Hc2CustodyStore; random: RandomSource; subtle?: SubtleCrypto }>) {
    if (!input?.store || !input.random) throw new Error("Device vault service requires custody storage and secure randomness.");
    this.#store = input.store;
    this.#random = input.random;
    this.#subtle = input.subtle ?? requireSubtle();
  }

  async prepare(input: Readonly<{
    project_id: ProjectId;
    person_id: PersonId;
    device_id: DeviceId;
    access_scope_id: AccessScopeId;
    generation: bigint;
    signing_key_id: PublicKeyId;
    recipient_key_id: PublicKeyId;
    offline_root_key_id: PublicKeyId;
    key_epoch_id: KeyEpochId;
    recovery_kit_sha256: Uint8Array;
  }>): Promise<Readonly<{
    handle: PreparedDeviceCustodyHandle;
    public_binding: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">;
  }>> {
    const project = parseEntityId("project", input.project_id);
    const person = parseEntityId("person", input.person_id);
    const device = parseEntityId("device", input.device_id);
    const scope = parseEntityId("access-scope", input.access_scope_id);
    const signingKeyId = parseEntityId("public-key", input.signing_key_id);
    const recipientKeyId = parseEntityId("public-key", input.recipient_key_id);
    const rootKeyId = parseEntityId("public-key", input.offline_root_key_id);
    const epochId = parseEntityId("key-epoch", input.key_epoch_id);
    if (typeof input.generation !== "bigint" || input.generation < BigInt(0)) throw new Error("Vault generation is invalid.");
    const kitDigest = exactDigest(input.recovery_kit_sha256, "recovery-kit digest");

    const signingPair = asPair(await this.#subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]));
    const recipientPair = asPair(await this.#subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]));
    const localKek = await this.#subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    validateEd25519Pair(signingPair);
    validateX25519Pair(recipientPair);
    validateWrappingKey(localKek);
    const signingPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "ed25519", key_id: signingKeyId, public_key: signingPair.publicKey });
    const recipientPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "x25519", key_id: recipientKeyId, public_key: recipientPair.publicKey });
    await selfTestKeys(this.#subtle, signingPair, recipientPair, recipientKeyId, localKek, recipientPublic);

    const secret = Uint8Array.from(await this.#random.randomBytes(HC2_EPOCH_SECRET_BYTES));
    const nonce = Uint8Array.from(await this.#random.randomBytes(HC2_EPOCH_WRAP_NONCE_BYTES));
    try {
      if (sameBytes(nonce, selfTestKekNonce) || await this.#store.hasWrappingNonce(project, device, input.generation, nonce)) {
        throw new Error("AES-GCM wrapping nonce collision detected; the operation will not retry.");
      }
      const wrappedEpoch = await wrapEpochSecret({
        key: localKek,
        project_id: project,
        device_id: device,
        key_epoch_id: epochId,
        wrapping_key_generation: input.generation,
        epoch_secret: secret,
        nonce,
        subtle: this.#subtle
      });
      const publicWithoutControl = Object.freeze({
        project_id: project,
        person_id: person,
        device_id: device,
        access_scope_id: scope,
        generation: input.generation,
        signing_key_id: signingKeyId,
        signing_public_key_bytes: Uint8Array.from(signingPublic) as AlgorithmTaggedPublicKeyBytes,
        recipient_key_id: recipientKeyId,
        recipient_public_key_bytes: Uint8Array.from(recipientPublic) as AlgorithmTaggedPublicKeyBytes,
        offline_root_key_id: rootKeyId,
        current_epoch_id: epochId,
        current_epoch_commitment: wrappedEpoch.key_epoch_commitment,
        current_epoch_public_commitment_bytes: Uint8Array.from(wrappedEpoch.public_commitment_bytes)
      });
      const recordWithoutControl = Object.freeze({
        schema_version: HC2_CUSTODY_SCHEMA_VERSION,
        record_kind: "device_key_vault" as const,
        suite_id: HC2_CRYPTO_SUITE_ID,
        project_id: project,
        person_id: person,
        device_id: device,
        access_scope_id: scope,
        generation: input.generation,
        signing_key_id: signingKeyId,
        signing_public_key_bytes: Uint8Array.from(signingPublic) as AlgorithmTaggedPublicKeyBytes,
        signing_key_pair: signingPair,
        recipient_key_id: recipientKeyId,
        recipient_public_key_bytes: Uint8Array.from(recipientPublic) as AlgorithmTaggedPublicKeyBytes,
        recipient_key_pair: recipientPair,
        local_kek: localKek,
        local_kek_algorithm: "AES-GCM-256" as const,
        local_kek_usages: Object.freeze(["encrypt", "decrypt"] as const),
        offline_root_key_id: rootKeyId,
        current_epoch_id: epochId,
        recovery_kit_sha256: kitDigest,
        status: "active" as const
      });
      const handle = Object.freeze({ handle_kind: "prepared_device_custody", project_id: project, device_id: device }) as PreparedDeviceCustodyHandle;
      this.#prepared.set(handle, Object.freeze({ record_without_control: recordWithoutControl, wrapped_epoch: wrappedEpoch, public_without_control: publicWithoutControl }));
      return Object.freeze({ handle, public_binding: copyPublicWithoutControl(publicWithoutControl) });
    } finally {
      secret.fill(0);
      nonce.fill(0);
    }
  }

  async install(input: Readonly<{
    handle: PreparedDeviceCustodyHandle;
    accepted_control_head_id: ControlEventId;
    journal: CustodyCeremonyJournal;
  }>): Promise<Readonly<{ status: "installed" | "exact_retry"; public_binding: DeviceCustodyPublicBinding }>> {
    const prepared = this.#prepared.get(input.handle);
    if (!prepared) throw new Error("Prepared custody handle is unknown or already discarded.");
    const controlHead = parseDigestId("control-event", input.accepted_control_head_id);
    const vault = parseStoredDeviceVaultRecord({
      ...prepared.record_without_control,
      accepted_control_head_id: controlHead,
      current_epoch_commitment: prepared.wrapped_epoch.key_epoch_commitment,
      current_epoch_public_commitment_bytes: Uint8Array.from(prepared.wrapped_epoch.public_commitment_bytes)
    });
    const outcome = await this.#store.installCustody({ journal: input.journal, vault, wrapped_epoch: prepared.wrapped_epoch });
    this.#prepared.delete(input.handle);
    return Object.freeze({ status: outcome.status, public_binding: publicBinding(vault) });
  }

  discardPrepared(handle: PreparedDeviceCustodyHandle): void { this.#prepared.delete(handle); }

  async loadAndVerify(authorityValue: AcceptedCustodyAuthority): Promise<LoadedDeviceCustody> {
    const authority = parseAcceptedCustodyAuthority(authorityValue);
    const stored = await this.#store.readVault(authority.project_id, authority.device_id);
    if (!stored) throw new Error("Device custody is absent.");
    const vault = parseStoredDeviceVaultRecord(stored);
    assertAuthorityBinding(vault, authority);
    validateEd25519Pair(vault.signing_key_pair);
    validateX25519Pair(vault.recipient_key_pair);
    validateWrappingKey(vault.local_kek);
    const signingPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "ed25519", key_id: vault.signing_key_id, public_key: vault.signing_key_pair.publicKey });
    const recipientPublic = await exportAndEncodePublicKey({ subtle: this.#subtle, algorithm: "x25519", key_id: vault.recipient_key_id, public_key: vault.recipient_key_pair.publicKey });
    if (!sameBytes(signingPublic, vault.signing_public_key_bytes) || !sameBytes(recipientPublic, vault.recipient_public_key_bytes)) {
      throw new Error("Reopened native public keys do not match their stored canonical identities.");
    }
    await selfTestKeys(this.#subtle, vault.signing_key_pair, vault.recipient_key_pair, vault.recipient_key_id, vault.local_kek, vault.recipient_public_key_bytes);
    const wrappedEpoch = await this.#store.readWrappedEpoch(vault.project_id, vault.device_id, vault.current_epoch_id);
    if (!wrappedEpoch) throw new Error("Current wrapped epoch is absent.");
    await withUnwrappedEpoch({
      key: vault.local_kek,
      record: wrappedEpoch,
      expected_project_id: vault.project_id,
      expected_device_id: vault.device_id,
      subtle: this.#subtle,
      use: () => undefined
    });
    const registry = new Hc2NativeKeyRegistry(this.#subtle);
    const signing = await registry.adoptDeviceSigningKeyPair(vault.signing_key_id, vault.signing_key_pair);
    const recipient = await registry.adoptRecipientKeyPair(vault.recipient_key_id, vault.recipient_key_pair);
    const kekHandle = Object.freeze({
      handle_kind: "device_key_encryption_key",
      extractability: "non_extractable",
      custody: "native_webcrypto"
    }) as DeviceKekHandle;
    this.#keks.set(kekHandle, vault.local_kek);
    const loaded = Object.freeze({
      public_binding: publicBinding(vault),
      signing_key: signing.handle,
      recipient_key_pair: recipient,
      local_kek: kekHandle
    });
    this.#loaded.set(loaded, Object.freeze({ vault, wrapped_epoch: wrappedEpoch, registry }));
    return loaded;
  }

  async signDevice(input: Readonly<{ custody: LoadedDeviceCustody; preimage: SenderSignaturePreimageBytes }>): Promise<Uint8Array> {
    const loaded = this.#loaded.get(input.custody);
    if (!loaded) throw new Error("Loaded custody handle is unknown.");
    const result = await new NativeEd25519SignatureProvider(loaded.registry).sign({ key: input.custody.signing_key, preimage: input.preimage });
    return Uint8Array.from(result.signature_bytes);
  }

  async withCurrentEpoch<T>(input: Readonly<{ custody: LoadedDeviceCustody; use: (epochSecret: Uint8Array) => T | Promise<T> }>): Promise<T> {
    const loaded = this.#loaded.get(input.custody);
    if (!loaded || this.#keks.get(input.custody.local_kek) !== loaded.vault.local_kek) throw new Error("Loaded custody handle is unknown.");
    return withUnwrappedEpoch({
      key: loaded.vault.local_kek,
      record: loaded.wrapped_epoch,
      expected_project_id: loaded.vault.project_id,
      expected_device_id: loaded.vault.device_id,
      subtle: this.#subtle,
      use: input.use
    });
  }
}

async function selfTestKeys(
  subtle: SubtleCrypto,
  signingPair: CryptoKeyPair,
  recipientPair: CryptoKeyPair,
  recipientKeyId: PublicKeyId,
  localKek: CryptoKey,
  recipientPublic: AlgorithmTaggedPublicKeyBytes
): Promise<void> {
  const challenge = new TextEncoder().encode("patchmark/hc2/device-vault-self-test/v1");
  const signature = new Uint8Array(await subtle.sign("Ed25519", signingPair.privateKey, challenge));
  if (signature.length !== 64 || !(await subtle.verify("Ed25519", signingPair.publicKey, signature, challenge))) throw new Error("Device signing-key self-test failed.");

  const registry = new Hc2NativeKeyRegistry(subtle);
  const recipient = await registry.adoptRecipientKeyPair(recipientKeyId, recipientPair);
  const hpke = new SingleShotHpkeProvider({ keys: registry });
  const binding = {
    envelope_version: 1 as const,
    suite_id: HC2_CRYPTO_SUITE_ID,
    envelope_id: "a".repeat(26) as import("./identities.ts").EnvelopeId,
    recipient_routing_tag: new Uint8Array(32),
    chunk_ordinal: 0,
    chunk_count: 1
  };
  const info = buildHpkeInfo(binding);
  let header: import("./envelope.ts").PublicEnvelopeHeader | null = null;
  const sealed = await hpke.sealBound({
    recipient_public_key: recipientPublic,
    info,
    plaintext: challenge,
    finalize_aad(enc) {
      header = {
        magic: HC2_ENVELOPE_MAGIC,
        ...binding,
        encapsulated_key_bytes: Uint8Array.from(enc),
        ciphertext_length: BigInt(challenge.length + 16)
      };
      return buildBoundHpkeAad(header);
    }
  });
  if (!header) throw new Error("HPKE self-test did not finalize its header.");
  const opened = await hpke.openBound({ recipient_key_pair: recipient, info, public_header: header, ciphertext_bytes: sealed.ciphertext_bytes });
  if (opened.status !== "opened" || !sameBytes(opened.plaintext, challenge)) throw new Error("Recipient-key HPKE self-test failed.");

  const encrypted = await subtle.encrypt({ name: "AES-GCM", iv: selfTestKekNonce }, localKek, challenge);
  const decrypted = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: selfTestKekNonce }, localKek, encrypted));
  if (!sameBytes(decrypted, challenge)) throw new Error("Local wrapping-key self-test failed.");
}

function assertAuthorityBinding(vault: StoredDeviceVaultRecord, authority: AcceptedCustodyAuthority): void {
  if (vault.status !== "active" || vault.project_id !== authority.project_id || vault.person_id !== authority.person_id ||
      vault.device_id !== authority.device_id || vault.access_scope_id !== authority.access_scope_id ||
      vault.signing_key_id !== authority.signing_key_id || vault.recipient_key_id !== authority.recipient_key_id ||
      vault.accepted_control_head_id !== authority.accepted_control_head_id || vault.offline_root_key_id !== authority.offline_root_key_id ||
      vault.current_epoch_id !== authority.key_epoch_id || vault.current_epoch_commitment !== authority.key_epoch_commitment) {
    throw new Error("Device custody does not match current accepted control authority.");
  }
}

function publicBinding(vault: StoredDeviceVaultRecord): DeviceCustodyPublicBinding {
  return Object.freeze({
    project_id: vault.project_id,
    person_id: vault.person_id,
    device_id: vault.device_id,
    access_scope_id: vault.access_scope_id,
    generation: vault.generation,
    signing_key_id: vault.signing_key_id,
    signing_public_key_bytes: Uint8Array.from(vault.signing_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    recipient_key_id: vault.recipient_key_id,
    recipient_public_key_bytes: Uint8Array.from(vault.recipient_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    accepted_control_head_id: vault.accepted_control_head_id,
    offline_root_key_id: vault.offline_root_key_id,
    current_epoch_id: vault.current_epoch_id,
    current_epoch_commitment: vault.current_epoch_commitment,
    current_epoch_public_commitment_bytes: Uint8Array.from(vault.current_epoch_public_commitment_bytes)
  });
}

function copyPublicWithoutControl(value: Omit<DeviceCustodyPublicBinding, "accepted_control_head_id">): Omit<DeviceCustodyPublicBinding, "accepted_control_head_id"> {
  return Object.freeze({
    ...value,
    signing_public_key_bytes: Uint8Array.from(value.signing_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    recipient_public_key_bytes: Uint8Array.from(value.recipient_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
    current_epoch_public_commitment_bytes: Uint8Array.from(value.current_epoch_public_commitment_bytes)
  });
}

function exactDigest(value: Uint8Array, label: string): Uint8Array { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`); return Uint8Array.from(value); }
function asPair(value: CryptoKey | CryptoKeyPair): CryptoKeyPair { if (!value || !("privateKey" in value) || !("publicKey" in value)) throw new Error("WebCrypto did not return a key pair."); return value; }
function requireSubtle(): SubtleCrypto { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable."); return globalThis.crypto.subtle; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }

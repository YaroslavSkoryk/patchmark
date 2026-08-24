import sodium from "libsodium-wrappers-sumo";

import { encodeCanonicalCbor } from "../../canonical-cbor.ts";
import { parseDigestId } from "../../identities.ts";
import { buildSignaturePreimage } from "../../preimages.ts";
import { encodeAlgorithmTaggedPublicKey } from "./public-key-codec.ts";
import {
  buildRecoveryKitAad,
  decodeRecoveryKitContainer,
  encodeRecoveryKitContainer,
} from "../recovery-kit-format.ts";
import {
  decodeRecoveryKitPayload,
  encodeRecoveryKitPayload,
  HC2_ROOT_SEED_BYTES,
  type RecoveryKitPayload
} from "./root-recovery-payload.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_RECOVERY_KIT_PROFILE_ID,
  HC2_RECOVERY_KIT_VERSION
} from "../versions.ts";
import {
  HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
  HC2_RECOVERY_ARGON2_OPSLIMIT,
  HC2_RECOVERY_DERIVED_KEY_BYTES,
  HC2_RECOVERY_NONCE_BYTES,
  HC2_RECOVERY_SALT_BYTES,
  HC2_RECOVERY_TAG_BYTES,
  HC2_RECOVERY_ARGON2_VERSION,
  HC2_RECOVERY_PARALLELISM
} from "./recovery-format.ts";
import type {
  Hc2RootRecoveryWorkerRequest,
  Hc2RootRecoveryWorkerResponse
} from "./root-recovery-worker-protocol.ts";

type WorkerScope = Readonly<{
  postMessage(message: Hc2RootRecoveryWorkerResponse, transfer?: Transferable[]): void;
}> & { onmessage: ((event: MessageEvent<Hc2RootRecoveryWorkerRequest>) => void) | null };

export async function performRootRecoveryWorkerOperation(
  input: Hc2RootRecoveryWorkerRequest
): Promise<Hc2RootRecoveryWorkerResponse> {
  const started = performance.now();
  const password = input?.password instanceof Uint8Array ? Uint8Array.from(input.password) : new Uint8Array();
  try {
    validateCommon(input, password);
    await sodium.ready;
    if (input.operation === "create_root_kit") return await createRootKit(input, password, started);
    return await openAndOperate(input, password, started);
  } catch {
    return Object.freeze({
      request_id: typeof input?.request_id === "string" ? input.request_id : "invalid",
      status: "rejected",
      runtime_ms: performance.now() - started
    });
  } finally {
    if (password.length) sodium.memzero(password);
  }
}

async function createRootKit(
  input: Extract<Hc2RootRecoveryWorkerRequest, { operation: "create_root_kit" }>,
  password: Uint8Array,
  started: number
): Promise<Hc2RootRecoveryWorkerResponse> {
  requireExactKeys(input, ["request_id", "operation", "password", "project_id", "root_key_id", "root_generation", "salt", "nonce"]);
  requireRandomParameters(input.salt, input.nonce);
  if (typeof input.root_generation !== "bigint" || input.root_generation < BigInt(0)) throw new Error("Invalid root generation.");
  const seed = new Uint8Array(HC2_ROOT_SEED_BYTES);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("Secure random generation is unavailable.");
  cryptoApi.getRandomValues(seed);
  let privateKey: Uint8Array | null = null;
  let payloadSeed: Uint8Array | null = null;
  let payloadBytes: Uint8Array | null = null;
  let derivedKey: Uint8Array | null = null;
  try {
    const pair = sodium.crypto_sign_seed_keypair(seed);
    privateKey = Uint8Array.from(pair.privateKey);
    const publicKey = encodeAlgorithmTaggedPublicKey({
      algorithm: "ed25519",
      key_id: input.root_key_id,
      raw_public_key: Uint8Array.from(pair.publicKey)
    });
    payloadSeed = Uint8Array.from(seed);
    const payload: RecoveryKitPayload = Object.freeze({
      schema_version: HC2_RECOVERY_KIT_VERSION,
      record_kind: "project_root_recovery_payload",
      profile_id: HC2_RECOVERY_KIT_PROFILE_ID,
      suite_id: HC2_CRYPTO_SUITE_ID,
      project_id: input.project_id,
      root_key_id: input.root_key_id,
      root_public_key_bytes: publicKey,
      root_generation: input.root_generation,
      root_seed: payloadSeed
    });
    payloadBytes = encodeRecoveryKitPayload(payload);
    const header = Object.freeze({
      schema_version: HC2_RECOVERY_KIT_VERSION,
      record_kind: "recovery_kit_header" as const,
      profile_id: HC2_RECOVERY_KIT_PROFILE_ID,
      suite_id: HC2_CRYPTO_SUITE_ID,
      kdf: "argon2id" as const,
      argon2_version: HC2_RECOVERY_ARGON2_VERSION,
      argon2_opslimit: HC2_RECOVERY_ARGON2_OPSLIMIT,
      argon2_memlimit_bytes: HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
      argon2_parallelism: HC2_RECOVERY_PARALLELISM,
      aead: "xchacha20-poly1305" as const,
      salt: Uint8Array.from(input.salt),
      nonce: Uint8Array.from(input.nonce),
      encrypted_payload_length: BigInt(payloadBytes.length + HC2_RECOVERY_TAG_BYTES),
      project_id: input.project_id,
      root_key_id: input.root_key_id,
      root_public_key_bytes: publicKey,
      root_generation: input.root_generation
    });
    const aad = buildRecoveryKitAad(header);
    derivedKey = derivePasswordKey(password, input.salt);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      payloadBytes,
      aad,
      null,
      Uint8Array.from(input.nonce),
      derivedKey
    );
    const kit = encodeRecoveryKitContainer({
      schema_version: HC2_RECOVERY_KIT_VERSION,
      record_kind: "project_root_recovery_kit",
      public_header: header,
      encrypted_payload: Uint8Array.from(ciphertext)
    });
    return Object.freeze({
      request_id: input.request_id,
      status: "created",
      kit_bytes: kit,
      root_public_key_bytes: Uint8Array.from(publicKey),
      runtime_ms: performance.now() - started
    });
  } finally {
    sodium.memzero(seed);
    if (privateKey) sodium.memzero(privateKey);
    if (payloadSeed) sodium.memzero(payloadSeed);
    if (payloadBytes) sodium.memzero(payloadBytes);
    if (derivedKey) sodium.memzero(derivedKey);
  }
}

async function openAndOperate(
  input: Exclude<Hc2RootRecoveryWorkerRequest, { operation: "create_root_kit" }>,
  password: Uint8Array,
  started: number
): Promise<Hc2RootRecoveryWorkerResponse> {
  const expectedKeys = input.operation === "verify_root_kit"
    ? ["request_id", "operation", "password", "project_id", "root_key_id", "kit_bytes", "verification_challenge"]
    : ["request_id", "operation", "password", "project_id", "root_key_id", "kit_bytes", "authority_purpose", "authority_control_event_id", "authority_preimage"];
  requireExactKeys(input, expectedKeys);
  const kit = decodeRecoveryKitContainer(input.kit_bytes);
  if (kit.public_header.project_id !== input.project_id || kit.public_header.root_key_id !== input.root_key_id) throw new Error("Recovery kit selection mismatch.");
  let derivedKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  let seed: Uint8Array | null = null;
  let privateKey: Uint8Array | null = null;
  let decodedPayload: RecoveryKitPayload | null = null;
  try {
    derivedKey = derivePasswordKey(password, kit.public_header.salt);
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      kit.encrypted_payload,
      buildRecoveryKitAad(kit.public_header),
      kit.public_header.nonce,
      derivedKey
    );
    decodedPayload = decodeRecoveryKitPayload(plaintext);
    assertPayloadMatchesHeader(decodedPayload, kit.public_header);
    seed = Uint8Array.from(decodedPayload.root_seed);
    const pair = sodium.crypto_sign_seed_keypair(seed);
    privateKey = Uint8Array.from(pair.privateKey);
    const expectedPublic = encodeAlgorithmTaggedPublicKey({
      algorithm: "ed25519",
      key_id: input.root_key_id,
      raw_public_key: Uint8Array.from(pair.publicKey)
    });
    if (!sameBytes(expectedPublic, kit.public_header.root_public_key_bytes)) throw new Error("Recovery root public derivation mismatch.");
    if (input.operation === "verify_root_kit") {
      if (!(input.verification_challenge instanceof Uint8Array) || input.verification_challenge.length === 0 || input.verification_challenge.length > 4096) throw new Error("Invalid recovery verification challenge.");
      const signature = sodium.crypto_sign_detached(Uint8Array.from(input.verification_challenge), privateKey);
      if (!sodium.crypto_sign_verify_detached(signature, input.verification_challenge, pair.publicKey)) throw new Error("Recovery verification signature failed.");
      return Object.freeze({
        request_id: input.request_id,
        status: "verified",
        root_public_key_bytes: Uint8Array.from(expectedPublic),
        verification_signature: Uint8Array.from(signature),
        runtime_ms: performance.now() - started
      });
    }
    if ((input.authority_purpose !== "initial_foundation" && input.authority_purpose !== "root_recovery") ||
        !(input.authority_preimage instanceof Uint8Array) || input.authority_preimage.length === 0 || input.authority_preimage.length > 4096) {
      throw new Error("Invalid root-authority request.");
    }
    const controlEventId = parseDigestId("control-event", input.authority_control_event_id);
    const exactPreimage = encodeCanonicalCbor(buildSignaturePreimage("control_event", input.project_id, controlEventId));
    if (!sameBytes(exactPreimage, input.authority_preimage)) throw new Error("Root worker accepts only the exact control-event authority preimage.");
    const signature = sodium.crypto_sign_detached(Uint8Array.from(input.authority_preimage), privateKey);
    if (!sodium.crypto_sign_verify_detached(signature, input.authority_preimage, pair.publicKey)) throw new Error("Root authority signature failed verification.");
    return Object.freeze({
      request_id: input.request_id,
      status: "signed",
      root_public_key_bytes: Uint8Array.from(expectedPublic),
      signature_bytes: Uint8Array.from(signature),
      authority_purpose: input.authority_purpose,
      runtime_ms: performance.now() - started
    });
  } finally {
    if (derivedKey) sodium.memzero(derivedKey);
    if (plaintext) sodium.memzero(plaintext);
    if (seed) sodium.memzero(seed);
    if (privateKey) sodium.memzero(privateKey);
    if (decodedPayload) sodium.memzero(decodedPayload.root_seed);
  }
}

function derivePasswordKey(password: Uint8Array, salt: Uint8Array): Uint8Array {
  return sodium.crypto_pwhash(
    HC2_RECOVERY_DERIVED_KEY_BYTES,
    password,
    Uint8Array.from(salt),
    HC2_RECOVERY_ARGON2_OPSLIMIT,
    HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

function assertPayloadMatchesHeader(payload: RecoveryKitPayload, header: ReturnType<typeof decodeRecoveryKitContainer>["public_header"]): void {
  if (payload.project_id !== header.project_id || payload.root_key_id !== header.root_key_id ||
      payload.root_generation !== header.root_generation || !sameBytes(payload.root_public_key_bytes, header.root_public_key_bytes)) {
    throw new Error("Recovery payload/header binding mismatch.");
  }
}

function validateCommon(input: Hc2RootRecoveryWorkerRequest, password: Uint8Array): void {
  if (!input || typeof input.request_id !== "string" || !/^[a-f0-9]{32}$/.test(input.request_id) ||
      password.length === 0 || password.length > 1024 * 1024 ||
      (input.operation !== "create_root_kit" && input.operation !== "verify_root_kit" && input.operation !== "sign_root_authority")) {
    throw new Error("Invalid root recovery worker request.");
  }
}

function requireRandomParameters(salt: Uint8Array, nonce: Uint8Array): void {
  if (!(salt instanceof Uint8Array) || salt.length !== HC2_RECOVERY_SALT_BYTES ||
      !(nonce instanceof Uint8Array) || nonce.length !== HC2_RECOVERY_NONCE_BYTES) throw new Error("Invalid recovery random parameters.");
}

function requireExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new Error("Root worker request contains unexpected fields.");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

const workerScope = globalThis as unknown as Partial<WorkerScope>;
const isWorkerRuntime = typeof workerScope.postMessage === "function" &&
  typeof (globalThis as typeof globalThis & { document?: unknown }).document === "undefined" &&
  typeof (globalThis as typeof globalThis & { close?: unknown }).close === "function";
if (isWorkerRuntime) {
  workerScope.onmessage = (event: MessageEvent<Hc2RootRecoveryWorkerRequest>) => {
    void performRootRecoveryWorkerOperation(event.data).then((response) => {
      const transfers: Transferable[] = [];
      let output = response;
      if (response.status === "created") {
        const kit = Uint8Array.from(response.kit_bytes);
        const publicKey = Uint8Array.from(response.root_public_key_bytes);
        output = { ...response, kit_bytes: kit, root_public_key_bytes: publicKey };
        transfers.push(kit.buffer, publicKey.buffer);
      } else if (response.status === "verified") {
        const publicKey = Uint8Array.from(response.root_public_key_bytes);
        const signature = Uint8Array.from(response.verification_signature);
        output = { ...response, root_public_key_bytes: publicKey, verification_signature: signature };
        transfers.push(publicKey.buffer, signature.buffer);
      } else if (response.status === "signed") {
        const publicKey = Uint8Array.from(response.root_public_key_bytes);
        const signature = Uint8Array.from(response.signature_bytes);
        output = { ...response, root_public_key_bytes: publicKey, signature_bytes: signature };
        transfers.push(publicKey.buffer, signature.buffer);
      }
      workerScope.postMessage?.(output, transfers);
    });
  };
}

import sodium from "libsodium-wrappers-sumo";

import {
  HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
  HC2_RECOVERY_ARGON2_OPSLIMIT,
  HC2_RECOVERY_DERIVED_KEY_BYTES,
  HC2_RECOVERY_NONCE_BYTES,
  HC2_RECOVERY_SALT_BYTES
} from "./recovery-format.ts";
import type {
  Hc2RecoveryWorkerRequest,
  Hc2RecoveryWorkerResponse
} from "./recovery-worker-protocol.ts";

type WorkerScope = Readonly<{
  postMessage(message: Hc2RecoveryWorkerResponse, transfer?: Transferable[]): void;
}> & {
  onmessage: ((event: MessageEvent<Hc2RecoveryWorkerRequest>) => void) | null;
};

export async function performRecoveryWorkerOperation(
  input: Hc2RecoveryWorkerRequest
): Promise<Hc2RecoveryWorkerResponse> {
  const started = performance.now();
  const password = Uint8Array.from(input.password);
  const material = Uint8Array.from(input.material);
  let key: Uint8Array | null = null;
  try {
    validateInput(input, password, material);
    await sodium.ready;
    key = sodium.crypto_pwhash(
      HC2_RECOVERY_DERIVED_KEY_BYTES,
      password,
      Uint8Array.from(input.salt),
      HC2_RECOVERY_ARGON2_OPSLIMIT,
      HC2_RECOVERY_ARGON2_MEMLIMIT_BYTES,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
    const output = input.operation === "protect"
      ? sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          material,
          Uint8Array.from(input.aad),
          null,
          Uint8Array.from(input.nonce),
          key
        )
      : sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          material,
          Uint8Array.from(input.aad),
          Uint8Array.from(input.nonce),
          key
        );
    return Object.freeze({
      request_id: input.request_id,
      status: "ok",
      material: Uint8Array.from(output),
      runtime_ms: performance.now() - started
    });
  } catch {
    return Object.freeze({
      request_id: typeof input?.request_id === "string" ? input.request_id : "invalid",
      status: "rejected",
      runtime_ms: performance.now() - started
    });
  } finally {
    sodium.memzero(password);
    sodium.memzero(material);
    if (key) sodium.memzero(key);
  }
}

const workerScope = globalThis as unknown as Partial<WorkerScope>;
const isWorkerRuntime = typeof workerScope.postMessage === "function" &&
  typeof (globalThis as typeof globalThis & { document?: unknown }).document === "undefined" &&
  typeof (globalThis as typeof globalThis & { close?: unknown }).close === "function";
if (isWorkerRuntime) {
  workerScope.onmessage = (event: MessageEvent<Hc2RecoveryWorkerRequest>) => {
    void performRecoveryWorkerOperation(event.data).then((response) => {
      if (response.status === "ok") {
        const material = Uint8Array.from(response.material);
        workerScope.postMessage?.({ ...response, material }, [material.buffer]);
      } else {
        workerScope.postMessage?.(response);
      }
    });
  };
}

function validateInput(
  input: Hc2RecoveryWorkerRequest,
  password: Uint8Array,
  material: Uint8Array
): void {
  if (!input || (input.operation !== "protect" && input.operation !== "unlock") ||
      typeof input.request_id !== "string" || input.request_id.length === 0 ||
      password.length === 0 || material.length === 0 ||
      !(input.salt instanceof Uint8Array) || input.salt.length !== HC2_RECOVERY_SALT_BYTES ||
      !(input.nonce instanceof Uint8Array) || input.nonce.length !== HC2_RECOVERY_NONCE_BYTES ||
      !(input.aad instanceof Uint8Array) || input.aad.length === 0) {
    throw new Error("Invalid recovery worker request.");
  }
}

import { parseEntityId } from "../../identities.ts";
import type { RecoveryProtector } from "../crypto-contracts.ts";
import { hc2ProtocolLimits } from "../limits.ts";
import { HC2_CRYPTO_SUITE_ID } from "../versions.ts";
import type { RandomSource } from "../crypto-contracts.ts";
import {
  buildRecoveryAad,
  decodeRecoveryProtectedRecord,
  encodeRecoveryProtectedRecord,
  HC2_RECOVERY_NONCE_BYTES,
  HC2_RECOVERY_SALT_BYTES,
  HC2_RECOVERY_TAG_BYTES
} from "./recovery-format.ts";
import type {
  Hc2RecoveryWorkerRequest,
  Hc2RecoveryWorkerResponse
} from "./recovery-worker-protocol.ts";
import { cryptoFailure, Hc2CryptoProviderError } from "./provider-errors.ts";

type RecoveryWorker = Pick<Worker, "addEventListener" | "removeEventListener" | "postMessage" | "terminate">;

export type Hc2RecoveryOperationEvidence = Readonly<{
  worker_runtime_ms: number;
  worker_terminated: true;
}>;

export class WorkerRecoveryProtector implements RecoveryProtector {
  readonly #random: RandomSource;
  readonly #workerFactory: () => RecoveryWorker;
  #lastEvidence: Hc2RecoveryOperationEvidence | null = null;

  constructor(input: Readonly<{
    random: RandomSource;
    worker_factory?: () => RecoveryWorker;
  }>) {
    this.#random = input.random;
    this.#workerFactory = input.worker_factory ?? defaultWorkerFactory;
  }

  evidence(): Hc2RecoveryOperationEvidence | null {
    return this.#lastEvidence;
  }

  protect(input: Parameters<RecoveryProtector["protect"]>[0]): ReturnType<RecoveryProtector["protect"]> {
    return this.protectWithSignal(input);
  }

  async protectWithSignal(
    input: Parameters<RecoveryProtector["protect"]>[0],
    signal?: AbortSignal
  ): ReturnType<RecoveryProtector["protect"]> {
    validateCapability(input.capability, "root_ceremony_only");
    const payload = copyRecoveryMaterial(input.recovery_payload);
    const password = copyPassword(input.password_material);
    try {
      const [salt, nonce] = await Promise.all([
        this.#random.randomBytes(HC2_RECOVERY_SALT_BYTES),
        this.#random.randomBytes(HC2_RECOVERY_NONCE_BYTES)
      ]);
      const aad = buildRecoveryAad({ person_id: input.capability.person_id, salt, nonce });
      const response = await this.#runWorker({
        request_id: operationId(),
        operation: "protect",
        password,
        material: payload,
        salt,
        nonce,
        aad
      }, signal);
      if (response.status !== "ok" || response.material.length !== payload.length + HC2_RECOVERY_TAG_BYTES) {
        throw cryptoFailure("internal_provider_invariant");
      }
      const protectedBytes = encodeRecoveryProtectedRecord({
        person_id: input.capability.person_id,
        salt,
        nonce,
        ciphertext: response.material
      });
      return Object.freeze({ suite_id: HC2_CRYPTO_SUITE_ID, protected_bytes: Uint8Array.from(protectedBytes) });
    } finally {
      password.fill(0);
      payload.fill(0);
    }
  }

  unlock(input: Parameters<RecoveryProtector["unlock"]>[0]): ReturnType<RecoveryProtector["unlock"]> {
    return this.unlockWithSignal(input);
  }

  async unlockWithSignal(
    input: Parameters<RecoveryProtector["unlock"]>[0],
    signal?: AbortSignal
  ): ReturnType<RecoveryProtector["unlock"]> {
    try {
      validateCapability(input.capability, "recovery_ceremony_only");
      const record = decodeRecoveryProtectedRecord(Uint8Array.from(input.protected_bytes));
      if (record.person_id !== input.capability.person_id) {
        return Object.freeze({ status: "rejected", reason: "wrong_password" });
      }
      const password = copyPassword(input.password_material);
      try {
        const aad = buildRecoveryAad(record);
        const response = await this.#runWorker({
          request_id: operationId(),
          operation: "unlock",
          password,
          material: record.ciphertext,
          salt: record.salt,
          nonce: record.nonce,
          aad
        }, signal);
        if (response.status !== "ok") return Object.freeze({ status: "rejected", reason: "wrong_password" });
        return Object.freeze({ status: "unlocked", ceremony_payload: Uint8Array.from(response.material) });
      } finally {
        password.fill(0);
      }
    } catch (error) {
      if (error instanceof Hc2CryptoProviderError && error.code === "operation_aborted") throw error;
      return Object.freeze({ status: "rejected", reason: "wrong_password" });
    }
  }

  async #runWorker(request: Hc2RecoveryWorkerRequest, signal?: AbortSignal): Promise<Hc2RecoveryWorkerResponse> {
    if (signal?.aborted) throw cryptoFailure("operation_aborted");
    let worker: RecoveryWorker;
    try {
      worker = this.#workerFactory();
    } catch {
      throw cryptoFailure("provider_unavailable");
    }
    let runtimeMs = 0;
    try {
      const response = await new Promise<Hc2RecoveryWorkerResponse>((resolve, reject) => {
        const onMessage = (event: MessageEvent<Hc2RecoveryWorkerResponse>) => {
          if (event.data?.request_id !== request.request_id) return;
          cleanup();
          resolve(event.data);
        };
        const onError = () => {
          cleanup();
          reject(cryptoFailure("provider_unavailable"));
        };
        const onAbort = () => {
          cleanup();
          reject(cryptoFailure("operation_aborted"));
        };
        const cleanup = () => {
          worker.removeEventListener("message", onMessage as EventListener);
          worker.removeEventListener("error", onError as EventListener);
          signal?.removeEventListener("abort", onAbort);
        };
        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError as EventListener);
        signal?.addEventListener("abort", onAbort, { once: true });
        const transferable = cloneForTransfer(request);
        worker.postMessage(transferable.request, transferable.buffers);
      });
      runtimeMs = Number.isFinite(response.runtime_ms) && response.runtime_ms >= 0 ? response.runtime_ms : 0;
      if (response.status === "ok") {
        return Object.freeze({ ...response, material: Uint8Array.from(response.material) });
      }
      return response;
    } finally {
      worker.terminate();
      this.#lastEvidence = Object.freeze({ worker_runtime_ms: runtimeMs, worker_terminated: true });
    }
  }
}

function defaultWorkerFactory(): RecoveryWorker {
  if (typeof Worker !== "function") throw cryptoFailure("unsupported_platform");
  return new Worker(new URL("./recovery-worker.ts", import.meta.url), {
    type: "module",
    name: "patchmark-hc2-recovery-operation"
  });
}

function validateCapability(
  value: Readonly<{ scope: string; person_id: unknown }>,
  scope: "root_ceremony_only" | "recovery_ceremony_only"
): void {
  if (!value || value.scope !== scope) throw cryptoFailure("invalid_key_usage");
  parseEntityId("person", value.person_id);
}

function copyRecoveryMaterial(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 ||
      BigInt(value.length) > hc2ProtocolLimits.maximum_canonical_object_bytes) {
    throw cryptoFailure("parameter_mismatch");
  }
  return Uint8Array.from(value);
}

function copyPassword(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 1024 * 1024) {
    throw cryptoFailure("parameter_mismatch");
  }
  return Uint8Array.from(value);
}

function cloneForTransfer(request: Hc2RecoveryWorkerRequest): Readonly<{
  request: Hc2RecoveryWorkerRequest;
  buffers: ArrayBuffer[];
}> {
  const password = Uint8Array.from(request.password);
  const material = Uint8Array.from(request.material);
  const salt = Uint8Array.from(request.salt);
  const nonce = Uint8Array.from(request.nonce);
  const aad = Uint8Array.from(request.aad);
  return Object.freeze({
    request: Object.freeze({ ...request, password, material, salt, nonce, aad }),
    buffers: [password.buffer, material.buffer, salt.buffer, nonce.buffer, aad.buffer] as ArrayBuffer[]
  });
}

function operationId(): string {
  const random = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw cryptoFailure("provider_unavailable");
  cryptoApi.getRandomValues(random);
  let output = "";
  for (const byte of random) output += byte.toString(16).padStart(2, "0");
  random.fill(0);
  return output;
}

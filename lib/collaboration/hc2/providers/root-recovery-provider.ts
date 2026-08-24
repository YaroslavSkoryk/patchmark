import {
  canonicalArray,
  canonicalBytes,
  canonicalText,
  encodeCanonicalCbor
} from "../../canonical-cbor.ts";
import {
  parseEntityId,
  type ProjectId,
  type PublicKeyId
} from "../../identities.ts";
import { sha256 } from "../../sha256.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  RandomSource,
  RecoveryCeremonyCapability,
  RootCeremonyCapability
} from "../crypto-contracts.ts";
import {
  isConstructedRootAuthorityPreimage,
  type RootAuthorityPreimage
} from "../custody-types.ts";
import {
  decodeRecoveryKitContainer,
  type RecoveryKitPublicHeader
} from "../recovery-kit-format.ts";
import { hc2HashDomains } from "../versions.ts";
import { importEncodedPublicKey } from "./public-key-codec.ts";
import {
  HC2_RECOVERY_NONCE_BYTES,
  HC2_RECOVERY_SALT_BYTES
} from "./recovery-format.ts";
import type {
  Hc2RootRecoveryWorkerRequest,
  Hc2RootRecoveryWorkerResponse
} from "./root-recovery-worker-protocol.ts";
import { cryptoFailure } from "./provider-errors.ts";

type RootWorker = Pick<Worker, "addEventListener" | "removeEventListener" | "postMessage" | "terminate">;

export type RootRecoveryWorkerEvidence = Readonly<{
  worker_runtime_ms: number;
  worker_terminated: true;
  operation: Hc2RootRecoveryWorkerRequest["operation"];
}>;

export type CreatedProjectRoot = Readonly<{
  project_id: ProjectId;
  root_key_id: PublicKeyId;
  root_generation: bigint;
  root_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recovery_kit_bytes: Uint8Array;
}>;

export type VerifiedRecoveryKit = Readonly<{
  project_id: ProjectId;
  root_key_id: PublicKeyId;
  root_generation: bigint;
  root_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  kit_sha256: Uint8Array;
  verification_signature: Uint8Array;
}>;

export class OfflineProjectRootProvider {
  readonly #random: RandomSource;
  readonly #subtle: SubtleCrypto;
  readonly #workerFactory: () => RootWorker;
  #lastEvidence: RootRecoveryWorkerEvidence | null = null;

  constructor(input: Readonly<{
    random: RandomSource;
    subtle?: SubtleCrypto;
    worker_factory?: () => RootWorker;
  }>) {
    if (!input?.random) throw new Error("Offline root provider requires an injected secure random source.");
    this.#random = input.random;
    this.#subtle = input.subtle ?? requireSubtle();
    this.#workerFactory = input.worker_factory ?? defaultWorkerFactory;
  }

  evidence(): RootRecoveryWorkerEvidence | null { return this.#lastEvidence; }

  async create(input: Readonly<{
    capability: RootCeremonyCapability;
    project_id: ProjectId;
    root_key_id: PublicKeyId;
    root_generation: bigint;
    password_material: Uint8Array;
    signal?: AbortSignal;
  }>): Promise<CreatedProjectRoot> {
    validateCapability(input.capability, "root_ceremony_only");
    const project = parseEntityId("project", input.project_id);
    const rootKey = parseEntityId("public-key", input.root_key_id);
    if (typeof input.root_generation !== "bigint" || input.root_generation < BigInt(0)) throw cryptoFailure("parameter_mismatch");
    const password = copyPassword(input.password_material);
    try {
      const [salt, nonce] = await Promise.all([
        this.#random.randomBytes(HC2_RECOVERY_SALT_BYTES),
        this.#random.randomBytes(HC2_RECOVERY_NONCE_BYTES)
      ]);
      const response = await this.#runWorker({
        request_id: operationId(),
        operation: "create_root_kit",
        password,
        project_id: project,
        root_key_id: rootKey,
        root_generation: input.root_generation,
        salt: Uint8Array.from(salt),
        nonce: Uint8Array.from(nonce)
      }, input.signal);
      if (response.status !== "created") throw cryptoFailure("recovery_authentication_failure");
      const container = decodeRecoveryKitContainer(response.kit_bytes);
      assertHeaderBinding(container.public_header, project, rootKey);
      if (!sameBytes(container.public_header.root_public_key_bytes, response.root_public_key_bytes)) throw cryptoFailure("internal_provider_invariant");
      return Object.freeze({
        project_id: project,
        root_key_id: rootKey,
        root_generation: container.public_header.root_generation,
        root_public_key_bytes: Uint8Array.from(response.root_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
        recovery_kit_bytes: Uint8Array.from(response.kit_bytes)
      });
    } finally {
      password.fill(0);
    }
  }

  async verify(input: Readonly<{
    capability: RecoveryCeremonyCapability;
    project_id: ProjectId;
    root_key_id: PublicKeyId;
    recovery_kit_bytes: Uint8Array;
    password_material: Uint8Array;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ status: "verified"; binding: VerifiedRecoveryKit } | { status: "rejected"; reason: "recovery_failed" }>> {
    try {
      validateCapability(input.capability, "recovery_ceremony_only");
      const project = parseEntityId("project", input.project_id);
      const rootKey = parseEntityId("public-key", input.root_key_id);
      const kit = copyKit(input.recovery_kit_bytes);
      const password = copyPassword(input.password_material);
      try {
        const container = decodeRecoveryKitContainer(kit);
        assertHeaderBinding(container.public_header, project, rootKey);
        const digest = await sha256(kit);
        const challenge = buildVerificationChallenge(project, rootKey, digest);
        const response = await this.#runWorker({
          request_id: operationId(),
          operation: "verify_root_kit",
          password,
          project_id: project,
          root_key_id: rootKey,
          kit_bytes: kit,
          verification_challenge: challenge
        }, input.signal);
        if (response.status !== "verified" ||
            !sameBytes(response.root_public_key_bytes, container.public_header.root_public_key_bytes) ||
            !(await verifyEd25519(this.#subtle, response.root_public_key_bytes, challenge, response.verification_signature))) {
          return Object.freeze({ status: "rejected", reason: "recovery_failed" });
        }
        return Object.freeze({
          status: "verified",
          binding: Object.freeze({
            project_id: project,
            root_key_id: rootKey,
            root_generation: container.public_header.root_generation,
            root_public_key_bytes: Uint8Array.from(response.root_public_key_bytes) as AlgorithmTaggedPublicKeyBytes,
            kit_sha256: Uint8Array.from(digest),
            verification_signature: Uint8Array.from(response.verification_signature)
          })
        });
      } finally {
        password.fill(0);
      }
    } catch (error) {
      if (isAbort(error)) throw cryptoFailure("operation_aborted");
      return Object.freeze({ status: "rejected", reason: "recovery_failed" });
    }
  }

  async signAuthority(input: Readonly<{
    capability: RecoveryCeremonyCapability;
    recovery_kit_bytes: Uint8Array;
    password_material: Uint8Array;
    preimage: RootAuthorityPreimage;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    status: "signed";
    project_id: ProjectId;
    root_key_id: PublicKeyId;
    purpose: RootAuthorityPreimage["purpose"];
    signature_bytes: Uint8Array;
  } | { status: "rejected"; reason: "recovery_failed" }>> {
    try {
      validateCapability(input.capability, "recovery_ceremony_only");
      if (!isConstructedRootAuthorityPreimage(input.preimage)) throw cryptoFailure("invalid_binding");
      const preimage = input.preimage;
      const kit = copyKit(input.recovery_kit_bytes);
      const container = decodeRecoveryKitContainer(kit);
      assertHeaderBinding(container.public_header, preimage.project_id, preimage.root_key_id);
      const password = copyPassword(input.password_material);
      try {
        const response = await this.#runWorker({
          request_id: operationId(),
          operation: "sign_root_authority",
          password,
          project_id: preimage.project_id,
          root_key_id: preimage.root_key_id,
          kit_bytes: kit,
          authority_purpose: preimage.purpose,
          authority_control_event_id: preimage.control_event_id,
          authority_preimage: Uint8Array.from(preimage.exact_bytes)
        }, input.signal);
        if (response.status !== "signed" || response.authority_purpose !== preimage.purpose ||
            !sameBytes(response.root_public_key_bytes, container.public_header.root_public_key_bytes) ||
            !(await verifyEd25519(this.#subtle, response.root_public_key_bytes, preimage.exact_bytes, response.signature_bytes))) {
          return Object.freeze({ status: "rejected", reason: "recovery_failed" });
        }
        return Object.freeze({
          status: "signed",
          project_id: preimage.project_id,
          root_key_id: preimage.root_key_id,
          purpose: preimage.purpose,
          signature_bytes: Uint8Array.from(response.signature_bytes)
        });
      } finally {
        password.fill(0);
      }
    } catch (error) {
      if (isAbort(error)) throw cryptoFailure("operation_aborted");
      return Object.freeze({ status: "rejected", reason: "recovery_failed" });
    }
  }

  async #runWorker(request: Hc2RootRecoveryWorkerRequest, signal?: AbortSignal): Promise<Hc2RootRecoveryWorkerResponse> {
    if (signal?.aborted) throw cryptoFailure("operation_aborted");
    let worker: RootWorker;
    try { worker = this.#workerFactory(); }
    catch { throw cryptoFailure("provider_unavailable"); }
    let runtimeMs = 0;
    try {
      const response = await new Promise<Hc2RootRecoveryWorkerResponse>((resolve, reject) => {
        const cleanup = () => {
          worker.removeEventListener("message", onMessage as EventListener);
          worker.removeEventListener("error", onError as EventListener);
          signal?.removeEventListener("abort", onAbort);
        };
        const onMessage = (event: MessageEvent<Hc2RootRecoveryWorkerResponse>) => {
          if (event.data?.request_id !== request.request_id) return;
          cleanup();
          resolve(event.data);
        };
        const onError = () => { cleanup(); reject(cryptoFailure("provider_unavailable")); };
        const onAbort = () => { cleanup(); reject(cryptoFailure("operation_aborted")); };
        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError as EventListener);
        signal?.addEventListener("abort", onAbort, { once: true });
        const transferable = cloneForTransfer(request);
        worker.postMessage(transferable.request, transferable.buffers);
      });
      runtimeMs = Number.isFinite(response.runtime_ms) && response.runtime_ms >= 0 ? response.runtime_ms : 0;
      return copyResponse(response);
    } finally {
      worker.terminate();
      this.#lastEvidence = Object.freeze({ worker_runtime_ms: runtimeMs, worker_terminated: true, operation: request.operation });
    }
  }
}

function buildVerificationChallenge(project: ProjectId, rootKey: PublicKeyId, kitDigest: Uint8Array): Uint8Array {
  return encodeCanonicalCbor(canonicalArray([
    canonicalText(hc2HashDomains.recoveryConfirmation),
    canonicalText(project),
    canonicalText(rootKey),
    canonicalBytes(Uint8Array.from(kitDigest))
  ]));
}

async function verifyEd25519(subtle: SubtleCrypto, encoded: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    const imported = await importEncodedPublicKey({ subtle, encoded, expected_algorithm: "ed25519" });
    return await subtle.verify("Ed25519", imported.public_key, Uint8Array.from(signature), Uint8Array.from(message));
  } catch { return false; }
}

function assertHeaderBinding(header: RecoveryKitPublicHeader, project: ProjectId, rootKey: PublicKeyId): void {
  if (header.project_id !== project || header.root_key_id !== rootKey) throw cryptoFailure("recovery_authentication_failure");
}

function cloneForTransfer(request: Hc2RootRecoveryWorkerRequest): Readonly<{ request: Hc2RootRecoveryWorkerRequest; buffers: ArrayBuffer[] }> {
  const password = Uint8Array.from(request.password);
  const buffers: ArrayBuffer[] = [password.buffer as ArrayBuffer];
  if (request.operation === "create_root_kit") {
    const salt = Uint8Array.from(request.salt);
    const nonce = Uint8Array.from(request.nonce);
    buffers.push(salt.buffer as ArrayBuffer, nonce.buffer as ArrayBuffer);
    return Object.freeze({ request: Object.freeze({ ...request, password, salt, nonce }), buffers });
  }
  const kit = Uint8Array.from(request.kit_bytes);
  buffers.push(kit.buffer as ArrayBuffer);
  if (request.operation === "verify_root_kit") {
    const challenge = Uint8Array.from(request.verification_challenge);
    buffers.push(challenge.buffer as ArrayBuffer);
    return Object.freeze({ request: Object.freeze({ ...request, password, kit_bytes: kit, verification_challenge: challenge }), buffers });
  }
  const preimage = Uint8Array.from(request.authority_preimage);
  buffers.push(preimage.buffer as ArrayBuffer);
  return Object.freeze({ request: Object.freeze({ ...request, password, kit_bytes: kit, authority_preimage: preimage }), buffers });
}

function copyResponse(response: Hc2RootRecoveryWorkerResponse): Hc2RootRecoveryWorkerResponse {
  if (response.status === "created") return Object.freeze({ ...response, kit_bytes: Uint8Array.from(response.kit_bytes), root_public_key_bytes: Uint8Array.from(response.root_public_key_bytes) });
  if (response.status === "verified") return Object.freeze({ ...response, root_public_key_bytes: Uint8Array.from(response.root_public_key_bytes), verification_signature: Uint8Array.from(response.verification_signature) });
  if (response.status === "signed") return Object.freeze({ ...response, root_public_key_bytes: Uint8Array.from(response.root_public_key_bytes), signature_bytes: Uint8Array.from(response.signature_bytes) });
  return Object.freeze({ ...response });
}

function copyPassword(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 1024 * 1024) throw cryptoFailure("parameter_mismatch");
  return Uint8Array.from(value);
}

function copyKit(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw cryptoFailure("parameter_mismatch");
  return Uint8Array.from(value);
}

function validateCapability(value: RootCeremonyCapability | RecoveryCeremonyCapability, scope: "root_ceremony_only" | "recovery_ceremony_only"): void {
  if (!value || value.scope !== scope) throw cryptoFailure("invalid_key_usage");
  parseEntityId("person", value.person_id);
}

function defaultWorkerFactory(): RootWorker {
  if (typeof Worker !== "function") throw cryptoFailure("unsupported_platform");
  return new Worker(new URL("./root-recovery-worker.ts", import.meta.url), { type: "module", name: "patchmark-hc2-root-recovery-operation" });
}

function operationId(): string {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw cryptoFailure("provider_unavailable");
  globalThis.crypto.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  bytes.fill(0);
  return result;
}

function requireSubtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw cryptoFailure("unsupported_platform");
  return globalThis.crypto.subtle;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "operation_aborted";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

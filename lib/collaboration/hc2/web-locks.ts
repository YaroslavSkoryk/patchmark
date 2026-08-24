import { parseEntityId, type DeviceId, type ProjectId } from "../identities.ts";

const lockDomain = "patchmark/hc2/project-device-mutation/v1";

export interface Hc2LockManager {
  request<T>(
    name: string,
    options: Readonly<{ mode: "exclusive"; signal?: AbortSignal }>,
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

export type Hc2LockResult<T> =
  | Readonly<{ status: "completed"; value: T }>
  | Readonly<{ status: "aborted" | "lock_failed" | "operation_failed"; reason: string }>;

export function deriveHc2MutationLockName(projectId: ProjectId, deviceId: DeviceId): string {
  const project = parseEntityId("project", projectId);
  const device = parseEntityId("device", deviceId);
  return `${lockDomain}:${suffix(project)}:${suffix(device)}`;
}

/** All custody plans for one project contend even when they propose different new devices. */
export function deriveHc2CustodyCeremonyLockName(projectId: ProjectId): string {
  const project = parseEntityId("project", projectId);
  return `${lockDomain}:${suffix(project)}:custody-ceremony`;
}

/** Web Locks is advisory; callers must still perform the IndexedDB CAS. */
export class Hc2WebLocksAdapter {
  readonly #locks: Hc2LockManager;

  constructor(lockManager: Hc2LockManager) {
    if (!lockManager || typeof lockManager.request !== "function") {
      throw new Error("Web Locks coordination requires an injected LockManager.");
    }
    this.#locks = lockManager;
  }

  async runExclusive<T>(input: Readonly<{
    project_id: ProjectId;
    device_id: DeviceId;
    signal?: AbortSignal;
    operation: () => Promise<T>;
  }>): Promise<Hc2LockResult<T>> {
    const name = deriveHc2MutationLockName(input.project_id, input.device_id);
    return this.#runNamed(name, input);
  }

  async runCustodyCeremonyExclusive<T>(input: Readonly<{
    project_id: ProjectId;
    signal?: AbortSignal;
    operation: () => Promise<T>;
  }>): Promise<Hc2LockResult<T>> {
    const name = deriveHc2CustodyCeremonyLockName(input.project_id);
    return this.#runNamed(name, input);
  }

  async #runNamed<T>(name: string, input: Readonly<{
    signal?: AbortSignal;
    operation: () => Promise<T>;
  }>): Promise<Hc2LockResult<T>> {
    if (typeof input.operation !== "function") throw new Error("Lock operations must be callable.");
    if (input.signal?.aborted) return Object.freeze({ status: "aborted", reason: "caller_aborted" });
    try {
      return await this.#locks.request(name, { mode: "exclusive", signal: input.signal }, async () => {
        if (input.signal?.aborted) return Object.freeze({ status: "aborted", reason: "caller_aborted" });
        try {
          return Object.freeze({ status: "completed", value: await input.operation() });
        } catch (error) {
          return Object.freeze({ status: "operation_failed", reason: safeErrorName(error) });
        }
      });
    } catch (error) {
      return isAbort(error) || input.signal?.aborted
        ? Object.freeze({ status: "aborted", reason: "caller_aborted" })
        : Object.freeze({ status: "lock_failed", reason: safeErrorName(error) });
    }
  }
}

function suffix(value: string): string { return value.slice(value.lastIndexOf(":") + 1); }

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function safeErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "operational_failure";
}

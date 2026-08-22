import type {
  CollaborationByteStorageBackend,
  CollaborationStorageAddress,
  CollaborationStoragePrefix
} from "../collaboration/storage.ts";
import { COLLABORATION_SHADOW_NAMESPACE_VERSION } from "./contracts.ts";

export const COLLABORATION_SHADOW_NAMESPACE =
  `patchmark-collaboration-shadow/v${COLLABORATION_SHADOW_NAMESPACE_VERSION}/` as const;

export class ExperimentalShadowBackend implements CollaborationByteStorageBackend {
  readonly #backend: CollaborationByteStorageBackend;
  readonly #instancePrefix: string;

  constructor(options: Readonly<{
    backend: CollaborationByteStorageBackend;
    source_project_instance_commitment: string;
  }>) {
    if (!options?.backend) throw new Error("An injected development backend is required.");
    const commitment = validateNamespaceSegment(
      options.source_project_instance_commitment,
      "source project instance commitment"
    );
    this.#backend = options.backend;
    this.#instancePrefix = `${COLLABORATION_SHADOW_NAMESPACE}instances/${commitment}/`;
  }

  get instance_prefix(): string {
    return this.#instancePrefix;
  }

  read(address: CollaborationStorageAddress): Promise<Uint8Array | null> {
    return this.#backend.read(this.#address(address));
  }

  write(
    address: CollaborationStorageAddress,
    bytes: Uint8Array,
    context: Parameters<CollaborationByteStorageBackend["write"]>[2]
  ): Promise<void> {
    return this.#backend.write(this.#address(address), bytes, context);
  }

  delete(address: CollaborationStorageAddress): Promise<void> {
    return this.#backend.delete(this.#address(address));
  }

  async list(prefix: CollaborationStoragePrefix): Promise<readonly CollaborationStorageAddress[]> {
    const namespaced = this.#prefix(prefix);
    const values = await this.#backend.list(namespaced);
    return Object.freeze(values.map((value) => {
      if (!value.startsWith(this.#instancePrefix)) {
        throw new Error("Injected shadow backend returned an address outside its instance namespace.");
      }
      return value.slice(this.#instancePrefix.length) as CollaborationStorageAddress;
    }));
  }

  metadata_address(name = "metadata.json"): CollaborationStorageAddress {
    return `shadow-container/${validateNamespaceSegment(name, "metadata name")}` as CollaborationStorageAddress;
  }

  #address(address: CollaborationStorageAddress): CollaborationStorageAddress {
    validateRelativeAddress(address);
    return `${this.#instancePrefix}${address}` as CollaborationStorageAddress;
  }

  #prefix(prefix: CollaborationStoragePrefix): CollaborationStoragePrefix {
    validateRelativeAddress(prefix);
    return `${this.#instancePrefix}${prefix}` as CollaborationStoragePrefix;
  }
}

export function assertProductionCollaborationAddress(
  value: string
): CollaborationStorageAddress {
  if (value.startsWith(COLLABORATION_SHADOW_NAMESPACE)) {
    throw new Error("Experimental collaboration shadow storage is not production-openable.");
  }
  validateRelativeAddress(value);
  return value as CollaborationStorageAddress;
}

function validateRelativeAddress(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("..") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith(COLLABORATION_SHADOW_NAMESPACE)
  ) {
    throw new Error("Collaboration storage address must be a safe relative non-shadow address.");
  }
}

function validateNamespaceSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value.includes("..")) {
    throw new Error(`${label} is not safe for the experimental namespace.`);
  }
  return value;
}

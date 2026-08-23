import { bytesEqual } from "../bytes.ts";
import { sha256 } from "../sha256.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import type { Hc2DirectoryHandle, Hc2FileHandle, Hc2PortableObjectVerifier } from "./portable-folder.ts";
import type { Hc2StorageFailureInjector } from "./failure-injection.ts";

export type Hc2CacheReadResult =
  | Readonly<{ status: "hit"; bytes: Uint8Array }>
  | Readonly<{ status: "cache_corrupt" | "cache_failed" | "cache_miss" | "folder_missing"; reason: string }>;

/** Optional disposable OPFS cache. No result is authoritative without folder bytes. */
export class Hc2OpfsCacheAdapter {
  readonly #root: Hc2DirectoryHandle;
  readonly #verifier: Hc2PortableObjectVerifier;

  constructor(options: Readonly<{ cache_root: Hc2DirectoryHandle; object_verifier: Hc2PortableObjectVerifier }>) {
    if (!options?.cache_root || options.cache_root.kind !== "directory" || !options.object_verifier) {
      throw new Error("OPFS cache requires an injected cache directory and object verifier.");
    }
    this.#root = options.cache_root;
    this.#verifier = options.object_verifier;
  }

  async readAgainstFolder<TKind extends CollaborationObjectKind>(input: Readonly<{
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_folder_bytes: Uint8Array | null;
    failure_injector?: Hc2StorageFailureInjector;
  }>): Promise<Hc2CacheReadResult> {
    const identity = parseIdentity(input.object_kind, input.object_id);
    if (input.exact_folder_bytes === null) return Object.freeze({ status: "folder_missing", reason: "portable_folder_object_required" });
    const folderBytes = Uint8Array.from(input.exact_folder_bytes);
    let handle: Hc2FileHandle;
    try {
      const directory = await this.#root.getDirectoryHandle(identity.kind, { create: false });
      handle = await directory.getFileHandle(identity.suffix, { create: false });
    } catch (error) {
      return isNotFound(error)
        ? Object.freeze({ status: "cache_miss", reason: "entry_absent" })
        : Object.freeze({ status: "cache_failed", reason: safeErrorName(error) });
    }
    try {
      await input.failure_injector?.inject(Object.freeze({ cut: "opfs_failure_or_eviction", object_id: identity.id }));
      const file = await handle.getFile();
      const cached = new Uint8Array(await file.arrayBuffer());
      const sameDigest = bytesEqual(await sha256(cached), await sha256(folderBytes));
      if (file.size !== cached.byteLength || !sameDigest || !bytesEqual(cached, folderBytes)) {
        await this.#delete(identity.kind, identity.suffix);
        return Object.freeze({ status: "cache_corrupt", reason: "folder_mismatch" });
      }
      await this.#verifier.verifyExactObject({ object_kind: identity.kind, object_id: identity.id, exact_bytes: cached });
      return Object.freeze({ status: "hit", bytes: Uint8Array.from(cached) });
    } catch (error) {
      await this.#delete(identity.kind, identity.suffix);
      return Object.freeze({ status: "cache_corrupt", reason: safeErrorName(error) });
    }
  }

  async writeAfterPortableCommit<TKind extends CollaborationObjectKind>(input: Readonly<{
    portable_commit_verified: true;
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_folder_bytes: Uint8Array;
    failure_injector?: Hc2StorageFailureInjector;
  }>): Promise<Readonly<{ status: "cached" | "cache_failed"; reason?: string }>> {
    if (input.portable_commit_verified !== true) throw new Error("Cache writes require an already verified portable commit.");
    const identity = parseIdentity(input.object_kind, input.object_id);
    const bytes = Uint8Array.from(input.exact_folder_bytes);
    try {
      await input.failure_injector?.inject(Object.freeze({ cut: "opfs_failure_or_eviction", object_id: identity.id }));
      await this.#verifier.verifyExactObject({ object_kind: identity.kind, object_id: identity.id, exact_bytes: bytes });
      const directory = await this.#root.getDirectoryHandle(identity.kind, { create: true });
      const handle = await directory.getFileHandle(identity.suffix, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(Uint8Array.from(bytes));
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(error); } catch { /* best effort */ }
        throw error;
      }
      return Object.freeze({ status: "cached" });
    } catch (error) {
      return Object.freeze({ status: "cache_failed", reason: safeErrorName(error) });
    }
  }

  async evict<TKind extends CollaborationObjectKind>(kindValue: TKind, idValue: CollaborationObjectIdByKind[TKind]): Promise<void> {
    const identity = parseIdentity(kindValue, idValue);
    await this.#delete(identity.kind, identity.suffix);
  }

  async #delete(kind: CollaborationObjectKind, suffix: string): Promise<void> {
    if (!this.#root.removeEntry) return;
    try {
      const directory = await this.#root.getDirectoryHandle(kind, { create: false });
      await directory.removeEntry?.(suffix, { recursive: false });
    } catch { /* disposable cache deletion is always best effort */ }
  }
}

function parseIdentity<TKind extends CollaborationObjectKind>(kindValue: TKind, idValue: CollaborationObjectIdByKind[TKind]): Readonly<{
  kind: TKind;
  id: CollaborationObjectIdByKind[TKind];
  suffix: string;
}> {
  const kind = parseCollaborationObjectKind(kindValue) as TKind;
  const id = parseCollaborationObjectId(kind, idValue);
  return Object.freeze({ kind, id, suffix: id.slice(id.lastIndexOf(":") + 1) });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "NotFoundError";
}

function safeErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "cache_operation_failed";
}

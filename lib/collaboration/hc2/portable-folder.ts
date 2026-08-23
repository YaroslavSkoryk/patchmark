import { bytesEqual } from "../bytes.ts";
import { decodeCanonicalCbor, encodeCanonicalCbor, inspectCanonicalValue, type CanonicalValue } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import { parseEntityId, type ProjectId } from "../identities.ts";
import { sha256 } from "../sha256.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  hc2BatchAddress,
  hc2ObjectAddresses,
  hc2ReplicaMetadataAddress,
  hc2WriterContinuityAddress,
  parseHc2PortableAddress,
  parseHc2PortableAddressDetails,
  type Hc2PortableAddress
} from "./addresses.ts";
import { deriveHc2Identity, parseHc2DigestId, parseOperationId, type OperationId, type PortableBatchId } from "./identities.ts";
import type { Hc2StorageFailureCut, Hc2StorageFailureInjector } from "./failure-injection.ts";
import {
  encodeReplicaMetadataCore,
  parseObjectCommitMarkerCore,
  parsePortableBatchMarkerCore,
  parseReplicaMetadataCore,
  parseWriterContinuityRecord,
  verifyPortableBatchMarker,
  type ObjectCommitMarkerCore,
  type PortableBatchMarkerRecord,
  type PortableBatchVisibilityResult,
  type PortableBatchVisibilityVerifier,
  type ReplicaMetadataCore,
  type WriterContinuityRecord
} from "./records.ts";
import { deriveWriterContinuityIdentity } from "./records.ts";

export type Hc2PermissionState = "denied" | "granted" | "prompt" | "unsupported";
export type Hc2PermissionMode = "read" | "readwrite";

export interface Hc2File {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Hc2WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface Hc2FileHandle {
  readonly kind: "file";
  getFile(): Promise<Hc2File>;
  createWritable(options?: Readonly<{ keepExistingData?: boolean }>): Promise<Hc2WritableFile>;
}

export interface Hc2DirectoryHandle {
  readonly kind: "directory";
  getDirectoryHandle(name: string, options?: Readonly<{ create?: boolean }>): Promise<Hc2DirectoryHandle>;
  getFileHandle(name: string, options?: Readonly<{ create?: boolean }>): Promise<Hc2FileHandle>;
  removeEntry?(name: string, options?: Readonly<{ recursive?: boolean }>): Promise<void>;
  entries?(): AsyncIterableIterator<readonly [string, Hc2DirectoryHandle | Hc2FileHandle]>;
  queryPermission?(descriptor: Readonly<{ mode: Hc2PermissionMode }>): Promise<PermissionState>;
  requestPermission?(descriptor: Readonly<{ mode: Hc2PermissionMode }>): Promise<PermissionState>;
}

export type Hc2FolderFailureCode =
  | "address_invalid"
  | "already_exists_different"
  | "backend_failed"
  | "delete_not_owned"
  | "permission_denied"
  | "readback_mismatch"
  | "scan_unsupported";

export class Hc2FolderError extends Error {
  readonly code: Hc2FolderFailureCode;
  readonly cause?: unknown;

  constructor(code: Hc2FolderFailureCode, message: string, cause?: unknown) {
    super(message);
    this.name = "Hc2FolderError";
    this.code = code;
    this.cause = cause;
  }
}

export type Hc2FolderWriteMode = "immutable" | "replace_operational" | "staging";

/**
 * Narrow File System Access adapter. It is inert until a caller supplies a
 * selected directory handle and invokes a method. All paths pass the frozen
 * HC-2 address parser before any handle traversal.
 */
export class Hc2PortableFolderAdapter {
  readonly #selectedRoot: Hc2DirectoryHandle;

  constructor(selectedRoot: Hc2DirectoryHandle) {
    if (!selectedRoot || selectedRoot.kind !== "directory") {
      throw new Error("HC-2 portable storage requires an injected directory handle.");
    }
    this.#selectedRoot = selectedRoot;
  }

  async queryPermission(mode: Hc2PermissionMode): Promise<Hc2PermissionState> {
    if (!this.#selectedRoot.queryPermission) return "unsupported";
    try {
      return await this.#selectedRoot.queryPermission({ mode });
    } catch (error) {
      if (isPermissionFailure(error)) return "denied";
      throw new Hc2FolderError("backend_failed", "Directory permission query failed.", error);
    }
  }

  /** Must only be called directly from a user-gesture flow. */
  async requestPermissionFromUserGesture(mode: Hc2PermissionMode): Promise<Hc2PermissionState> {
    if (!this.#selectedRoot.requestPermission) return "unsupported";
    try {
      return await this.#selectedRoot.requestPermission({ mode });
    } catch (error) {
      if (isPermissionFailure(error)) return "denied";
      throw new Hc2FolderError("backend_failed", "Directory permission request failed.", error);
    }
  }

  async read(addressValue: Hc2PortableAddress): Promise<Uint8Array | null> {
    const address = strictAddress(addressValue);
    try {
      const resolved = await resolveFile(this.#selectedRoot, address, false);
      if (!resolved) return null;
      return bytesFromFile(await resolved.getFile());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw mapFolderError("read", error);
    }
  }

  async write(
    addressValue: Hc2PortableAddress,
    inputBytes: Uint8Array,
    mode: Hc2FolderWriteMode
  ): Promise<"written" | "already_present"> {
    const address = strictAddress(addressValue);
    if (!(inputBytes instanceof Uint8Array)) throw new Error("Folder writes require exact Uint8Array bytes.");
    const bytes = Uint8Array.from(inputBytes);
    const existing = await this.read(address);
    if (existing !== null && mode === "immutable") {
      if (!bytesEqual(existing, bytes)) {
        throw new Hc2FolderError("already_exists_different", "Immutable portable bytes already exist with different content.");
      }
      return "already_present";
    }
    try {
      const fileHandle = await resolveFile(this.#selectedRoot, address, true);
      if (!fileHandle) throw new Error("Created file handle was unavailable.");
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      try {
        await writable.write(Uint8Array.from(bytes));
        await writable.close();
      } catch (error) {
        await abortQuietly(writable, error);
        throw error;
      }
      const reopened = await bytesFromFile(await fileHandle.getFile());
      if (!bytesEqual(reopened, bytes)) {
        throw new Hc2FolderError("readback_mismatch", "Portable write did not survive close-and-reopen byte verification.");
      }
      return "written";
    } catch (error) {
      if (error instanceof Hc2FolderError) throw error;
      throw mapFolderError("write", error);
    }
  }

  async deleteOwned(addressValue: Hc2PortableAddress, ownership?: Readonly<{
    object_id?: CollaborationObjectId;
    operation_id?: OperationId;
  }>): Promise<"deleted" | "missing"> {
    const address = strictAddress(addressValue);
    const details = parseHc2PortableAddressDetails(address);
    if (!(details.namespace === "object" && details.stage === "staging") && details.namespace !== "transaction") {
      throw new Hc2FolderError("delete_not_owned", "Only exact HC-2 staging and transaction artifacts may be deleted.");
    }
    if (
      details.namespace === "object"
        ? ownership?.object_id !== details.id
        : ownership?.operation_id === undefined || parseOperationId(ownership.operation_id) !== details.operation_id
    ) throw new Hc2FolderError("delete_not_owned", "HC-2 deletion requires exact current-operation ownership evidence.");
    const segments = address.split("/");
    const name = segments.pop();
    if (!name) throw new Hc2FolderError("address_invalid", "Portable address has no file name.");
    try {
      const parent = await resolveDirectory(this.#selectedRoot, segments, false);
      if (!parent?.removeEntry) return "missing";
      await parent.removeEntry(name, { recursive: false });
      return "deleted";
    } catch (error) {
      if (isNotFound(error)) return "missing";
      throw mapFolderError("delete", error);
    }
  }

  async list(): Promise<readonly Hc2PortableAddress[]> {
    if (!this.#selectedRoot.entries) throw new Hc2FolderError("scan_unsupported", "Directory enumeration is unavailable.");
    const found = new Set<Hc2PortableAddress>();
    await scanDirectory(this.#selectedRoot, [], found);
    return Object.freeze([...found].sort());
  }
}

export type Hc2VerifiedPortableObject<TKind extends CollaborationObjectKind = CollaborationObjectKind> = Readonly<{
  object_kind: TKind;
  object_id: CollaborationObjectIdByKind[TKind];
  project_id: ProjectId;
  dependency_ids: readonly CollaborationObjectId[];
}>;

/** The injected implementation must use the real HC-1 canonical codecs. */
export interface Hc2PortableObjectVerifier {
  verifyExactObject<TKind extends CollaborationObjectKind>(input: Readonly<{
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_bytes: Uint8Array;
  }>): Promise<Hc2VerifiedPortableObject<TKind>>;
}

export interface Hc2WriterContinuityVerifier {
  verifyExactContinuity(record: WriterContinuityRecord): Promise<Readonly<{ status: "verified" | "invalid" }>>;
}

export class Hc2PortableReplicaStore implements PortableBatchVisibilityVerifier {
  readonly #folder: Hc2PortableFolderAdapter;
  readonly #objects: Hc2PortableObjectVerifier;
  readonly #continuity?: Hc2WriterContinuityVerifier;

  constructor(options: Readonly<{ folder: Hc2PortableFolderAdapter; object_verifier: Hc2PortableObjectVerifier; continuity_verifier?: Hc2WriterContinuityVerifier }>) {
    if (!options?.folder || !options.object_verifier) throw new Error("Portable replica storage requires folder and object-verifier adapters.");
    this.#folder = options.folder;
    this.#objects = options.object_verifier;
    this.#continuity = options.continuity_verifier;
  }

  async installReplicaMetadata(value: ReplicaMetadataCore): Promise<"written" | "already_present"> {
    return this.#folder.write(hc2ReplicaMetadataAddress, encodeReplicaMetadataCore(parseReplicaMetadataCore(value)), "immutable");
  }

  async readReplicaMetadata(): Promise<ReplicaMetadataCore | null> {
    const bytes = await this.#folder.read(hc2ReplicaMetadataAddress);
    return bytes === null ? null : parseReplicaMetadataCore(decodeProtocolRecord(bytes));
  }

  async stageAndCommitObject<TKind extends CollaborationObjectKind>(input: Readonly<{
    project_id: ProjectId;
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_bytes: Uint8Array;
    failure_injector?: Hc2StorageFailureInjector;
    allow_partial_repair_from_exact_reservation?: true;
  }>): Promise<Readonly<{ marker_core: ObjectCommitMarkerCore; marker_id: import("./identities.ts").ObjectCommitMarkerId }>> {
    const project = parseEntityId("project", input.project_id);
    const kind = parseCollaborationObjectKind(input.object_kind) as TKind;
    const id = parseCollaborationObjectId(kind, input.object_id);
    const exactBytes = Uint8Array.from(input.exact_bytes);
    const verified = await this.#objects.verifyExactObject({ object_kind: kind, object_id: id, exact_bytes: exactBytes });
    if (verified.project_id !== project || verified.object_kind !== kind || verified.object_id !== id) {
      throw new Error("HC-1 object verifier returned mismatched ownership or identity.");
    }
    const addresses = hc2ObjectAddresses(kind, id);
    await inject(input.failure_injector, "partial_staging_write", id);
    await inject(input.failure_injector, "permission_loss_staging", id);
    await this.#folder.write(addresses.staging, exactBytes, "staging");
    await inject(input.failure_injector, "complete_staging_write", id);
    await inject(input.failure_injector, "after_staging_verification", id);
    await inject(input.failure_injector, "partial_final_object_write", id);
    await inject(input.failure_injector, "permission_loss_final_object", id);
    const existingFinal = await this.#folder.read(addresses.data);
    if (existingFinal !== null && !bytesEqual(existingFinal, exactBytes)) {
      const existingMarker = await this.#folder.read(addresses.commit);
      if (input.allow_partial_repair_from_exact_reservation !== true || existingMarker !== null || existingFinal.byteLength >= exactBytes.byteLength) {
        throw new Error("Existing final object bytes are corrupt or already committed and cannot be replaced.");
      }
      await this.#folder.write(addresses.data, exactBytes, "replace_operational");
    } else {
      await this.#folder.write(addresses.data, exactBytes, "immutable");
    }
    await inject(input.failure_injector, "complete_final_object_write", id);
    const markerCore = parseObjectCommitMarkerCore({
      schema_version: 1,
      record_kind: "portable_object_commit_marker",
      project_id: project,
      object_kind: kind,
      object_id: id,
      stored_length: BigInt(exactBytes.byteLength),
      stored_sha256: await sha256(exactBytes)
    });
    const markerIdentity = await deriveHc2Identity("object-commit-marker", canonicalProtocolValue(markerCore));
    await inject(input.failure_injector, "partial_object_commit_marker", id);
    await inject(input.failure_injector, "permission_loss_object_commit_marker", id);
    const markerBytes = encodeProtocolRecord(markerCore);
    const existingMarkerBytes = await this.#folder.read(addresses.commit);
    if (existingMarkerBytes !== null && !bytesEqual(existingMarkerBytes, markerBytes)) {
      if (input.allow_partial_repair_from_exact_reservation !== true || existingMarkerBytes.byteLength >= markerBytes.byteLength || await this.#isMarkerReferenced(markerIdentity.id)) {
        throw new Error("Existing object commit marker is corrupt or referenced and cannot be replaced.");
      }
      await this.#folder.write(addresses.commit, markerBytes, "replace_operational");
    } else {
      await this.#folder.write(addresses.commit, markerBytes, "immutable");
    }
    await inject(input.failure_injector, "complete_object_commit_marker", id);
    await this.#folder.deleteOwned(addresses.staging, { object_id: id });
    return Object.freeze({ marker_core: markerCore, marker_id: markerIdentity.id });
  }

  /** Batch marker installation is deliberately the last portable visibility step. */
  async commitBatch(markerValue: PortableBatchMarkerRecord, failureInjector?: Hc2StorageFailureInjector, allowPartialRepairFromExactReservation = false): Promise<"written" | "already_present"> {
    const core = parsePortableBatchMarkerCore(markerValue.core);
    const id = parseHc2DigestId("portable-batch", markerValue.batch_id);
    if (!(await verifyPortableBatchMarker({ core, batch_id: id }))) throw new Error("Portable batch marker identity or root is invalid.");
    await inject(failureInjector, "before_batch_marker_write");
    await inject(failureInjector, "partial_batch_marker_write");
    await inject(failureInjector, "permission_loss_batch_marker");
    const address = hc2BatchAddress(id);
    const bytes = encodeProtocolRecord(core);
    const existing = await this.#folder.read(address);
    const result = existing !== null && !bytesEqual(existing, bytes)
      ? allowPartialRepairFromExactReservation && existing.byteLength < bytes.byteLength
        ? await this.#folder.write(address, bytes, "replace_operational")
        : failBatchCollision()
      : await this.#folder.write(address, bytes, "immutable");
    await inject(failureInjector, "complete_verified_batch_marker");
    return result;
  }

  async commitWriterContinuity(recordValue: WriterContinuityRecord): Promise<Readonly<{ status: "written" | "already_present"; continuity_id: import("./identities.ts").WriterContinuityId }>> {
    const record = parseWriterContinuityRecord(recordValue);
    const identity = await deriveWriterContinuityIdentity(record);
    if (!this.#continuity || (await this.#continuity.verifyExactContinuity(record)).status !== "verified") {
      throw new Error("Writer continuity requires injected HC-1 signature-verification evidence.");
    }
    const status = await this.#folder.write(hc2WriterContinuityAddress(identity.continuity_id), encodeProtocolRecord(record), "immutable");
    return Object.freeze({ status, continuity_id: identity.continuity_id });
  }

  async readBatch(batchIdValue: PortableBatchId): Promise<PortableBatchMarkerRecord | null> {
    const batchId = parseHc2DigestId("portable-batch", batchIdValue);
    const bytes = await this.#folder.read(hc2BatchAddress(batchId));
    if (bytes === null) return null;
    const core = parsePortableBatchMarkerCore(decodeProtocolRecord(bytes));
    const record = Object.freeze({ core, batch_id: batchId });
    if (!(await verifyPortableBatchMarker(record))) throw new Error("Portable batch file does not match its address.");
    return record;
  }

  async verifyCompleteBatch(markerValue: PortableBatchMarkerRecord): Promise<PortableBatchVisibilityResult> {
    let marker: PortableBatchMarkerRecord;
    try {
      marker = Object.freeze({
        core: parsePortableBatchMarkerCore(markerValue.core),
        batch_id: parseHc2DigestId("portable-batch", markerValue.batch_id)
      });
      if (!(await verifyPortableBatchMarker(marker))) return invisible("marker_invalid");
    } catch {
      return invisible("marker_invalid");
    }
    const available = new Map<CollaborationObjectId, Hc2VerifiedPortableObject>();
    for (const entry of marker.core.object_entries) {
      const addresses = hc2ObjectAddresses(entry.object_kind, entry.object_id);
      const bytes = await this.#folder.read(addresses.data);
      if (bytes === null) return invisible("object_missing", entry.object_id);
      if (BigInt(bytes.byteLength) !== entry.stored_length || !bytesEqual(await sha256(bytes), entry.stored_sha256)) {
        return invisible("object_corrupt", entry.object_id);
      }
      let verified: Hc2VerifiedPortableObject;
      try {
        verified = await this.#objects.verifyExactObject({ object_kind: entry.object_kind, object_id: entry.object_id, exact_bytes: bytes });
      } catch {
        return invisible("object_corrupt", entry.object_id);
      }
      if (verified.project_id !== marker.core.project_id || verified.object_kind !== entry.object_kind || verified.object_id !== entry.object_id) {
        return invisible("object_corrupt", entry.object_id);
      }
      if (!sameStrings(verified.dependency_ids, entry.dependency_ids)) return invisible("object_corrupt", entry.object_id);
      available.set(entry.object_id, verified);
      const markerBytes = await this.#folder.read(addresses.commit);
      if (markerBytes === null) return invisible("object_marker_missing", entry.object_id);
      try {
        const objectMarker = parseObjectCommitMarkerCore(decodeProtocolRecord(markerBytes));
        const markerIdentity = await deriveHc2Identity("object-commit-marker", canonicalProtocolValue(objectMarker));
        if (
          markerIdentity.id !== entry.object_commit_marker_id ||
          objectMarker.project_id !== marker.core.project_id ||
          objectMarker.object_kind !== entry.object_kind ||
          objectMarker.object_id !== entry.object_id ||
          objectMarker.stored_length !== entry.stored_length ||
          !bytesEqual(objectMarker.stored_sha256, entry.stored_sha256)
        ) return invisible("object_marker_invalid", entry.object_id);
      } catch {
        return invisible("object_marker_invalid", entry.object_id);
      }
    }
    if (marker.core.writer_continuity_id !== null) {
      const continuityBytes = await this.#folder.read(hc2WriterContinuityAddress(marker.core.writer_continuity_id));
      if (continuityBytes === null || !this.#continuity) return invisible("marker_invalid");
      try {
        const continuity = parseWriterContinuityRecord(decodeProtocolRecord(continuityBytes));
        const identity = await deriveWriterContinuityIdentity(continuity);
        const verification = await this.#continuity.verifyExactContinuity(continuity);
        if (
          identity.continuity_id !== marker.core.writer_continuity_id ||
          continuity.core.project_id !== marker.core.project_id ||
          continuity.core.predecessor_batch_id !== marker.core.predecessor_batch_id ||
          verification.status !== "verified"
        ) return invisible("marker_invalid");
      } catch {
        return invisible("marker_invalid");
      }
    }
    for (const entry of marker.core.object_entries) {
      for (const dependencyId of entry.dependency_ids) {
        if (available.has(dependencyId)) continue;
        const dependency = objectKindAndId(dependencyId);
        const addresses = hc2ObjectAddresses(dependency.kind, dependency.id);
        const dependencyBytes = await this.#folder.read(addresses.data);
        const dependencyMarkerBytes = await this.#folder.read(addresses.commit);
        if (dependencyBytes === null || dependencyMarkerBytes === null) return invisible("dependency_missing", entry.object_id);
        try {
          const dependencyVerified = await this.#objects.verifyExactObject({ object_kind: dependency.kind, object_id: dependency.id, exact_bytes: dependencyBytes });
          const dependencyMarker = parseObjectCommitMarkerCore(decodeProtocolRecord(dependencyMarkerBytes));
          if (
            dependencyVerified.project_id !== marker.core.project_id ||
            dependencyMarker.project_id !== marker.core.project_id ||
            dependencyMarker.object_kind !== dependency.kind ||
            dependencyMarker.object_id !== dependency.id ||
            dependencyMarker.stored_length !== BigInt(dependencyBytes.byteLength) ||
            !bytesEqual(dependencyMarker.stored_sha256, await sha256(dependencyBytes))
          ) throw new Error("Dependency marker mismatch.");
        } catch {
          return invisible("dependency_corrupt", entry.object_id);
        }
      }
    }
    return Object.freeze({ status: "visible", marker });
  }

  async verifyBatchById(batchId: PortableBatchId): Promise<PortableBatchVisibilityResult> {
    try {
      const marker = await this.readBatch(batchId);
      return marker === null ? invisible("marker_invalid") : this.verifyCompleteBatch(marker);
    } catch {
      return invisible("marker_invalid");
    }
  }

  async listBatchIds(): Promise<readonly PortableBatchId[]> {
    const addresses = await this.#folder.list();
    const ids: PortableBatchId[] = [];
    for (const address of addresses) {
      const details = parseHc2PortableAddressDetails(address);
      if (details.namespace === "batch") ids.push(details.id);
    }
    return Object.freeze(ids.sort());
  }

  async #isMarkerReferenced(markerId: import("./identities.ts").ObjectCommitMarkerId): Promise<boolean> {
    for (const batchId of await this.listBatchIds()) {
      try {
        const batch = await this.readBatch(batchId);
        if (batch?.core.object_entries.some((entry) => entry.object_commit_marker_id === markerId)) return true;
      } catch {
        // Invalid batch files confer no visibility or ownership.
      }
    }
    return false;
  }
}

export type Hc2ReconstructionDiagnostic = Readonly<{
  code: "fork" | "incomplete_batch" | "invalid_batch" | "missing_predecessor" | "replica_missing";
  batch_id?: PortableBatchId;
}>;

export type Hc2FolderReconstruction = Readonly<{
  status: "ambiguous" | "corrupt" | "verified" | "verified_empty";
  frontier_batch_id: PortableBatchId | null;
  visible_batch_ids: readonly PortableBatchId[];
  object_ids: readonly CollaborationObjectId[];
  can_resume_existing_device_authoring: false;
  recovery_requirement: "new_device_or_recovery_required";
  diagnostics: readonly Hc2ReconstructionDiagnostic[];
}>;

/** Rebuilds only from verified portable evidence; directory enumeration order is irrelevant. */
export async function reconstructHc2Folder(store: Hc2PortableReplicaStore): Promise<Hc2FolderReconstruction> {
  const diagnostics: Hc2ReconstructionDiagnostic[] = [];
  try {
    if ((await store.readReplicaMetadata()) === null) diagnostics.push(Object.freeze({ code: "replica_missing" }));
  } catch {
    diagnostics.push(Object.freeze({ code: "replica_missing" }));
  }
  const ids = await store.listBatchIds();
  const valid = new Map<PortableBatchId, PortableBatchMarkerRecord>();
  const objects = new Set<CollaborationObjectId>();
  for (const id of ids) {
    const result = await store.verifyBatchById(id);
    if (result.status !== "visible") {
      diagnostics.push(Object.freeze({ code: result.reason === "marker_invalid" ? "invalid_batch" : "incomplete_batch", batch_id: id }));
      continue;
    }
    valid.set(id, result.marker);
    for (const entry of result.marker.core.object_entries) objects.add(entry.object_id);
  }
  const successors = new Map<PortableBatchId | null, PortableBatchId[]>();
  let eligibleCount = 0;
  for (const [id, marker] of valid) {
    const predecessor = marker.core.predecessor_batch_id;
    if (predecessor !== null && !valid.has(predecessor)) {
      diagnostics.push(Object.freeze({ code: "missing_predecessor", batch_id: id }));
      continue;
    }
    const list = successors.get(predecessor) ?? [];
    list.push(id);
    successors.set(predecessor, list);
    eligibleCount += 1;
  }
  let forked = [...successors.values()].some((list) => list.length > 1);
  if (forked) diagnostics.push(Object.freeze({ code: "fork" }));
  let frontier: PortableBatchId | null = null;
  if (!forked) {
    let cursor: PortableBatchId | null = null;
    const visited = new Set<PortableBatchId>();
    while ((successors.get(cursor)?.length ?? 0) === 1) {
      const next: PortableBatchId = successors.get(cursor)![0];
      if (visited.has(next)) {
        diagnostics.push(Object.freeze({ code: "fork", batch_id: next }));
        break;
      }
      visited.add(next);
      frontier = next;
      cursor = next;
    }
    if (visited.size !== eligibleCount) {
      forked = true;
      frontier = null;
      diagnostics.push(Object.freeze({ code: "fork" }));
    }
  }
  const hardCorruption = diagnostics.some((entry) => entry.code === "replica_missing" || entry.code === "missing_predecessor");
  const status = hardCorruption ? "corrupt" : forked ? "ambiguous" : valid.size === 0 ? "verified_empty" : "verified";
  return Object.freeze({
    status,
    frontier_batch_id: forked ? null : frontier,
    visible_batch_ids: Object.freeze([...valid.keys()].sort()),
    object_ids: Object.freeze([...objects].sort()),
    can_resume_existing_device_authoring: false,
    recovery_requirement: "new_device_or_recovery_required",
    diagnostics: Object.freeze(diagnostics.sort((left, right) => `${left.code}:${left.batch_id ?? ""}`.localeCompare(`${right.code}:${right.batch_id ?? ""}`)))
  });
}

export function encodeProtocolRecord(value: unknown): Uint8Array {
  return encodeCanonicalCbor(canonicalProtocolValue(value));
}

export function decodeProtocolRecord(bytes: Uint8Array): unknown {
  return canonicalToProtocol(decodeCanonicalCbor(Uint8Array.from(bytes)));
}

function canonicalToProtocol(value: CanonicalValue, key?: string): unknown {
  const view = inspectCanonicalValue(value);
  switch (view.kind) {
    case "null": return null;
    case "boolean":
    case "text": return view.value;
    case "bytes": return Uint8Array.from(view.value);
    case "uint": return key?.endsWith("_version") ? Number(view.value) : view.value;
    case "array": return view.values.map((child) => canonicalToProtocol(child));
    case "map": return Object.fromEntries(view.entries.map(([entryKey, child]) => [entryKey, canonicalToProtocol(child, entryKey)]));
  }
}

function strictAddress(value: Hc2PortableAddress): Hc2PortableAddress {
  try {
    return parseHc2PortableAddress(value);
  } catch (error) {
    throw new Hc2FolderError("address_invalid", "Portable address was rejected before handle traversal.", error);
  }
}

async function resolveDirectory(root: Hc2DirectoryHandle, segments: readonly string[], create: boolean): Promise<Hc2DirectoryHandle | null> {
  let current = root;
  try {
    for (const segment of segments) current = await current.getDirectoryHandle(segment, { create });
    return current;
  } catch (error) {
    if (!create && isNotFound(error)) return null;
    throw error;
  }
}

async function resolveFile(root: Hc2DirectoryHandle, address: Hc2PortableAddress, create: boolean): Promise<Hc2FileHandle | null> {
  const segments = address.split("/");
  const name = segments.pop();
  if (!name) throw new Hc2FolderError("address_invalid", "Portable address has no file name.");
  const directory = await resolveDirectory(root, segments, create);
  if (!directory) return null;
  try {
    return await directory.getFileHandle(name, { create });
  } catch (error) {
    if (!create && isNotFound(error)) return null;
    throw error;
  }
}

async function bytesFromFile(file: Hc2File): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Portable file reported an invalid size.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error("Portable file changed while it was being read.");
  return Uint8Array.from(bytes);
}

async function scanDirectory(
  directory: Hc2DirectoryHandle,
  prefix: readonly string[],
  found: Set<Hc2PortableAddress>
): Promise<void> {
  if (!directory.entries) return;
  for await (const [name, handle] of directory.entries()) {
    if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
    const path = [...prefix, name];
    if (handle.kind === "directory") {
      await scanDirectory(handle, path, found);
      continue;
    }
    try {
      found.add(parseHc2PortableAddress(path.join("/")));
    } catch {
      // Preserve and ignore unrelated or malformed entries.
    }
  }
}

function objectKindAndId(id: CollaborationObjectId): { kind: CollaborationObjectKind; id: CollaborationObjectId } {
  const match = /^pm:([^:]+):v1:/.exec(id);
  const kind = parseCollaborationObjectKind(match?.[1]);
  return { kind, id: parseCollaborationObjectId(kind, id) };
}

function invisible(reason: Exclude<PortableBatchVisibilityResult, { status: "visible" }>["reason"], objectId?: CollaborationObjectId): PortableBatchVisibilityResult {
  return objectId === undefined ? Object.freeze({ status: "invisible", reason }) : Object.freeze({ status: "invisible", reason, object_id: objectId });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError" ||
    typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "NotFoundError";
}

function isPermissionFailure(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError") ||
    typeof error === "object" && error !== null && "name" in error && ["NotAllowedError", "SecurityError"].includes(String((error as { name?: unknown }).name));
}

function mapFolderError(operation: string, error: unknown): Hc2FolderError {
  return isPermissionFailure(error)
    ? new Hc2FolderError("permission_denied", `Portable folder ${operation} lost permission.`, error)
    : new Hc2FolderError("backend_failed", `Portable folder ${operation} failed.`, error);
}

async function abortQuietly(writable: Hc2WritableFile, reason: unknown): Promise<void> {
  try { await writable.abort?.(reason); } catch { /* original failure wins */ }
}

function failBatchCollision(): never {
  throw new Error("Existing batch marker bytes are corrupt or collide with the expected identity.");
}

async function inject(injector: Hc2StorageFailureInjector | undefined, cut: Hc2StorageFailureCut, objectId?: string): Promise<void> {
  await injector?.inject(Object.freeze({ cut, object_id: objectId }));
}

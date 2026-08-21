import { bytesEqual, bytesToHex } from "./bytes.ts";
import {
  parseDocumentRevisionCore,
  parseMarkdownBlobDescription,
  type DocumentRevisionCore,
  type DocumentRevisionRecord,
  type MarkdownBlobDescription
} from "./content.ts";
import {
  parseMergeKeyCore,
  type MergeKeyCore
} from "./derived.ts";
import {
  parseDigestId,
  parseEntityId,
  type DocumentRevisionId,
  type MarkdownBlobId,
  type MergeKeyId,
  type ProjectId
} from "./identities.ts";
import {
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeKeyIdentity
} from "./preimages.ts";
import {
  buildRevisionReferenceIndex,
  decodeRevisionReferenceIndex,
  encodeRevisionReferenceIndex,
  parseRevisionReference,
  revisionReferenceSortKey,
  type RevisionReference,
  type RevisionReferenceIndex
} from "./revision-indexes.ts";
import { decodeStoredRevisionCore } from "./revision-storage-codec.ts";
import { sha256 } from "./sha256.ts";
import {
  CollaborationStoreError,
  collaborationObjectAddresses,
  collaborationRevisionReferenceIndexAddress,
  collaborationStoragePrefixes,
  objectIdFromStorageAddress,
  parseCollaborationStorageAddress,
  type CollaborationByteStorageBackend,
  type CollaborationPutResult,
  type CollaborationReadResult,
  type CollaborationStorageAddress,
  type CollaborationStoragePrefix,
  type CollaborationStoreFailureInjector,
  type CollaborationStoredObjectKind
} from "./storage.ts";

export type RevisionReferenceIndexReadResult =
  | Readonly<{ status: "valid"; value: RevisionReferenceIndex }>
  | Readonly<{ status: "missing" | "corrupted" | "mismatched"; reason: string }>;

export type RevisionReferenceIndexPutResult = Readonly<{
  status: "updated" | "already_present" | "rebuilt";
  value: RevisionReferenceIndex;
}>;

export type MergeRevisionPutResult = Readonly<{
  revision: CollaborationPutResult<DocumentRevisionId, DocumentRevisionRecord>;
  merge_key_id: MergeKeyId;
  merge_key_core: MergeKeyCore;
}>;

export type CollaborationRecoveryReport = Readonly<{
  valid_blob_ids: readonly MarkdownBlobId[];
  valid_revision_ids: readonly DocumentRevisionId[];
  incomplete_addresses: readonly CollaborationStorageAddress[];
  corrupted_object_ids: readonly (MarkdownBlobId | DocumentRevisionId)[];
  mismatched_object_ids: readonly (MarkdownBlobId | DocumentRevisionId)[];
  cleaned_staging_addresses: readonly CollaborationStorageAddress[];
  valid_index_revision_ids: readonly DocumentRevisionId[];
  corrupted_index_revision_ids: readonly DocumentRevisionId[];
  stale_index_revision_ids: readonly DocumentRevisionId[];
  invalid_addresses: readonly string[];
}>;

type StoredObjectMetadata = Readonly<{
  kind: CollaborationStoredObjectKind;
  id: MarkdownBlobId | DocumentRevisionId;
  project_id: ProjectId;
  document_id: string | null;
}>;

type ParsedCommitMarker = StoredObjectMetadata & Readonly<{
  stored_byte_length: number;
  stored_sha256: string;
}>;

type RawStoredRead =
  | Readonly<{
      status: "valid";
      bytes: Uint8Array;
      marker: ParsedCommitMarker;
    }>
  | Readonly<{ status: "missing" | "incomplete" | "corrupted" | "mismatched"; reason: string }>;

const commitHeader = "patchmark/collaboration-object-commit/v1";

export class ImmutableCollaborationStore {
  readonly #backend: CollaborationByteStorageBackend;
  readonly #failureInjector?: CollaborationStoreFailureInjector;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: Readonly<{
    backend: CollaborationByteStorageBackend;
    failure_injector?: CollaborationStoreFailureInjector;
  }>) {
    if (!options || typeof options.backend !== "object" || options.backend === null) {
      throw new Error("Immutable collaboration storage requires an injected byte backend.");
    }
    this.#backend = options.backend;
    this.#failureInjector = options.failure_injector;
  }

  async putMarkdownBlob(
    projectId: ProjectId,
    exactBytes: Uint8Array
  ): Promise<CollaborationPutResult<MarkdownBlobId, MarkdownBlobDescription>> {
    const project = parseEntityId("project", projectId);
    if (!(exactBytes instanceof Uint8Array)) {
      throw new Error("Markdown blob storage accepts exact Uint8Array bytes only.");
    }
    const copiedBytes = Uint8Array.from(exactBytes);
    const identity = await deriveMarkdownBlobIdentity(project, copiedBytes);
    const metadata: StoredObjectMetadata = Object.freeze({
      kind: "markdown-blob",
      id: identity.id,
      project_id: project,
      document_id: null
    });
    const status = await this.#putImmutableObject(
      metadata,
      copiedBytes,
      async (candidate) => {
        const derived = await deriveMarkdownBlobIdentity(project, candidate);
        if (derived.id !== identity.id) {
          throw new CollaborationStoreError(
            "mismatched",
            "Markdown bytes do not match their content address."
          );
        }
      }
    );
    const description = parseMarkdownBlobDescription({
      schema_version: 1,
      object_kind: "markdown_blob",
      project_id: project,
      blob_id: identity.id,
      encoding: "utf-8-exact",
      bytes: copiedBytes
    });
    return Object.freeze({
      status,
      id: identity.id,
      value: copyMarkdownDescription(description)
    });
  }

  async getMarkdownBlob(
    projectId: ProjectId,
    blobId: MarkdownBlobId
  ): Promise<CollaborationReadResult<MarkdownBlobDescription>> {
    const project = parseEntityId("project", projectId);
    const id = parseDigestId("markdown-blob", blobId);
    const stored = await this.#readStoredObject("markdown-blob", id);
    if (stored.status !== "valid") return stored;
    if (stored.marker.project_id !== project || stored.marker.document_id !== null) {
      return failure("mismatched", "Markdown commit metadata has incorrect ownership.");
    }
    let derived;
    try {
      derived = await deriveMarkdownBlobIdentity(project, stored.bytes);
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
    if (derived.id !== id) {
      return failure("mismatched", "Persisted Markdown bytes do not match their blob ID.");
    }
    return Object.freeze({
      status: "valid" as const,
      value: copyMarkdownDescription(
        parseMarkdownBlobDescription({
          schema_version: 1,
          object_kind: "markdown_blob",
          project_id: project,
          blob_id: id,
          encoding: "utf-8-exact",
          bytes: stored.bytes
        })
      )
    });
  }

  async materializeMarkdownBlob(
    projectId: ProjectId,
    blobId: MarkdownBlobId
  ): Promise<Uint8Array> {
    const result = await this.getMarkdownBlob(projectId, blobId);
    if (result.status !== "valid") throw readFailureError(result);
    return Uint8Array.from(result.value.bytes);
  }

  async putRevision(
    value: DocumentRevisionCore,
    references: readonly RevisionReference[] = []
  ): Promise<CollaborationPutResult<DocumentRevisionId, DocumentRevisionRecord>> {
    const core = parseDocumentRevisionCore(value);
    const identity = await deriveDocumentRevisionIdentity(core);
    assertRevisionDoesNotReferenceItself(identity.id, core);
    await this.#requireRevisionDependencies(core, identity.id);
    const metadata: StoredObjectMetadata = Object.freeze({
      kind: "document-revision",
      id: identity.id,
      project_id: core.project_id,
      document_id: core.document_id
    });
    const status = await this.#putImmutableObject(
      metadata,
      identity.canonical_bytes,
      async (candidate) => {
        const decoded = decodeStoredRevisionCore(candidate);
        const derived = await deriveDocumentRevisionIdentity(decoded);
        if (derived.id !== identity.id || !bytesEqual(derived.canonical_bytes, candidate)) {
          throw new CollaborationStoreError(
            "mismatched",
            "Stored revision canonical bytes do not match their revision ID."
          );
        }
      },
      async () => this.#requireRevisionDependencies(core, identity.id)
    );

    await this.#injectFailure({
      stage: "after_object_commit_before_index_update",
      object_kind: "document-revision",
      object_id: identity.id
    });
    for (const reference of references) {
      await this.recordRevisionReference(reference);
    }
    return Object.freeze({
      status,
      id: identity.id,
      value: Object.freeze({
        record_version: 1 as const,
        object_kind: "document_revision" as const,
        revision_id: identity.id,
        core
      })
    });
  }

  async putMergeRevision(
    revisionValue: DocumentRevisionCore,
    mergeValue: MergeKeyCore,
    references: readonly RevisionReference[] = []
  ): Promise<MergeRevisionPutResult> {
    const revision = parseDocumentRevisionCore(revisionValue);
    if (revision.ancestry_kind !== "ordinary" || revision.parent_revision_ids.length < 2) {
      throw new Error("A merge revision must be an ordinary multi-parent revision.");
    }
    const revisionIdentity = await deriveDocumentRevisionIdentity(revision);
    const mergeCore = parseMergeKeyCore(mergeValue);
    if (
      mergeCore.project_id !== revision.project_id ||
      mergeCore.document_id !== revision.document_id ||
      mergeCore.result_revision_id !== revisionIdentity.id ||
      !sameStrings(mergeCore.parent_revision_ids, revision.parent_revision_ids)
    ) {
      throw new Error("Merge-key core must exactly describe the stored merge revision.");
    }
    const mergeIdentity = await deriveMergeKeyIdentity(mergeCore);
    const storedRevision = await this.putRevision(revision, references);
    return Object.freeze({
      revision: storedRevision,
      merge_key_id: mergeIdentity.id,
      merge_key_core: mergeCore
    });
  }

  async getRevision(
    revisionId: DocumentRevisionId
  ): Promise<CollaborationReadResult<DocumentRevisionRecord>> {
    return this.#getRevisionInternal(
      parseDigestId("document-revision", revisionId),
      new Set<DocumentRevisionId>()
    );
  }

  async materializeRevisionMarkdown(
    revisionId: DocumentRevisionId
  ): Promise<Uint8Array> {
    const revision = await this.getRevision(revisionId);
    if (revision.status !== "valid") throw readFailureError(revision);
    return this.materializeMarkdownBlob(
      revision.value.core.project_id,
      revision.value.core.markdown_blob_id
    );
  }

  async getRevisionReferenceIndex(
    revisionId: DocumentRevisionId
  ): Promise<RevisionReferenceIndexReadResult> {
    const id = parseDigestId("document-revision", revisionId);
    const address = collaborationRevisionReferenceIndexAddress(id);
    const bytes = await this.#read(address);
    if (bytes === null) {
      return failure("missing", "Revision reference index was not found.");
    }
    try {
      const value = decodeRevisionReferenceIndex(bytes);
      if (value.revision_id !== id) {
        return failure("mismatched", "Revision index is stored under the wrong revision ID.");
      }
      if (!bytesEqual(encodeRevisionReferenceIndex(value), bytes)) {
        return failure("corrupted", "Revision index is not in exact canonical form.");
      }
      return Object.freeze({ status: "valid" as const, value });
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
  }

  async recordRevisionReference(
    value: RevisionReference
  ): Promise<RevisionReferenceIndexPutResult> {
    const reference = parseRevisionReference(value);
    const revision = await this.getRevision(reference.revision_id);
    requireValidRevisionForIndex(revision, reference);
    return this.#withLock(`index:${reference.revision_id}`, async () => {
      const existing = await this.getRevisionReferenceIndex(reference.revision_id);
      if (existing.status === "corrupted" || existing.status === "mismatched") {
        throw new CollaborationStoreError(existing.status, existing.reason);
      }
      const references = existing.status === "valid"
        ? [...existing.value.references]
        : [];
      const key = revisionReferenceSortKey(reference);
      if (references.some((candidate) => revisionReferenceSortKey(candidate) === key)) {
        return Object.freeze({
          status: "already_present" as const,
          value: existing.status === "valid"
            ? existing.value
            : buildRevisionReferenceIndex(
                reference.project_id,
                reference.document_id,
                reference.revision_id,
                [reference]
              )
        });
      }
      references.push(reference);
      const index = buildRevisionReferenceIndex(
        reference.project_id,
        reference.document_id,
        reference.revision_id,
        references
      );
      await this.#writeAndVerifyIndex(index);
      return Object.freeze({ status: "updated" as const, value: index });
    });
  }

  async rebuildRevisionReferenceIndex(
    revisionId: DocumentRevisionId,
    references: readonly RevisionReference[]
  ): Promise<RevisionReferenceIndexPutResult> {
    const id = parseDigestId("document-revision", revisionId);
    const revision = await this.getRevision(id);
    if (revision.status !== "valid") throw readFailureError(revision);
    const index = buildRevisionReferenceIndex(
      revision.value.core.project_id,
      revision.value.core.document_id,
      id,
      references
    );
    return this.#withLock(`index:${id}`, async () => {
      await this.#writeAndVerifyIndex(index);
      return Object.freeze({ status: "rebuilt" as const, value: index });
    });
  }

  async recover(): Promise<CollaborationRecoveryReport> {
    await this.#injectFailure({ stage: "during_recovery" });
    const validBlobs: MarkdownBlobId[] = [];
    const validRevisions: DocumentRevisionId[] = [];
    const incomplete: CollaborationStorageAddress[] = [];
    const corrupted: Array<MarkdownBlobId | DocumentRevisionId> = [];
    const mismatched: Array<MarkdownBlobId | DocumentRevisionId> = [];
    const cleaned: CollaborationStorageAddress[] = [];
    const invalidAddresses: string[] = [];

    const commitAddresses = await this.#list(collaborationStoragePrefixes.commits);
    const commitAddressSet = new Set(commitAddresses);
    for (const address of commitAddresses) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        invalidAddresses.push(address);
        continue;
      }
      if (!addressed) {
        invalidAddresses.push(address);
        continue;
      }
      if (
        addressed.kind !== "markdown-blob" &&
        addressed.kind !== "document-revision"
      ) {
        continue;
      }
      const stored = await this.#readStoredObject(addressed.kind, addressed.id as never);
      if (stored.status !== "valid") {
        if (stored.status === "incomplete" || stored.status === "missing") {
          incomplete.push(address);
        } else if (stored.status === "corrupted") {
          corrupted.push(addressed.id);
        } else {
          mismatched.push(addressed.id);
        }
        continue;
      }
      if (addressed.kind === "markdown-blob") {
        const result = await this.getMarkdownBlob(
          stored.marker.project_id,
          addressed.id as MarkdownBlobId
        );
        classifyObjectResult(result, addressed.id, validBlobs, incomplete, corrupted, mismatched, address);
      } else {
        const result = await this.getRevision(addressed.id as DocumentRevisionId);
        classifyObjectResult(result, addressed.id, validRevisions, incomplete, corrupted, mismatched, address);
      }
    }

    const dataAddresses = await this.#list(collaborationStoragePrefixes.data);
    for (const address of dataAddresses) {
      let addressed;
      try {
        addressed = objectIdFromStorageAddress(address);
      } catch {
        invalidAddresses.push(address);
        continue;
      }
      if (!addressed) {
        invalidAddresses.push(address);
        continue;
      }
      if (
        addressed.kind !== "markdown-blob" &&
        addressed.kind !== "document-revision"
      ) {
        continue;
      }
      const expectedCommit = addressed.kind === "markdown-blob"
        ? collaborationObjectAddresses("markdown-blob", addressed.id as MarkdownBlobId).commit
        : collaborationObjectAddresses(
            "document-revision",
            addressed.id as DocumentRevisionId
          ).commit;
      if (!commitAddressSet.has(expectedCommit)) incomplete.push(address);
    }

    const stagingAddresses = await this.#list(collaborationStoragePrefixes.staging);
    for (const address of stagingAddresses) {
      let parsed: CollaborationStorageAddress;
      try {
        parsed = parseCollaborationStorageAddress(address);
        if (!parsed.startsWith(collaborationStoragePrefixes.staging)) {
          throw new Error("Address is not a staging address.");
        }
      } catch {
        invalidAddresses.push(address);
        continue;
      }
      const addressed = objectIdFromStorageAddress(parsed);
      if (
        !addressed ||
        (addressed.kind !== "markdown-blob" &&
          addressed.kind !== "document-revision")
      ) {
        continue;
      }
      incomplete.push(parsed);
      await this.#delete(parsed);
      cleaned.push(parsed);
    }

    const validIndexes: DocumentRevisionId[] = [];
    const corruptIndexes: DocumentRevisionId[] = [];
    const staleIndexes: DocumentRevisionId[] = [];
    const indexAddresses = await this.#list(
      collaborationStoragePrefixes.revisionReferenceIndexes
    );
    for (const address of indexAddresses) {
      let parsed: CollaborationStorageAddress;
      try {
        parsed = parseCollaborationStorageAddress(address);
      } catch {
        invalidAddresses.push(address);
        continue;
      }
      const digest = parsed.slice(parsed.lastIndexOf("/") + 1);
      const id = parseDigestId(
        "document-revision",
        `pm:document-revision:v1:${digest}`
      );
      const index = await this.getRevisionReferenceIndex(id);
      if (index.status !== "valid") {
        corruptIndexes.push(id);
        continue;
      }
      const revision = await this.getRevision(id);
      if (revision.status !== "valid") staleIndexes.push(id);
      else validIndexes.push(id);
    }

    return Object.freeze({
      valid_blob_ids: frozenSorted(validBlobs),
      valid_revision_ids: frozenSorted(validRevisions),
      incomplete_addresses: frozenSorted(unique(incomplete)),
      corrupted_object_ids: frozenSorted(unique(corrupted)),
      mismatched_object_ids: frozenSorted(unique(mismatched)),
      cleaned_staging_addresses: frozenSorted(unique(cleaned)),
      valid_index_revision_ids: frozenSorted(unique(validIndexes)),
      corrupted_index_revision_ids: frozenSorted(unique(corruptIndexes)),
      stale_index_revision_ids: frozenSorted(unique(staleIndexes)),
      invalid_addresses: frozenSorted(unique(invalidAddresses))
    });
  }

  async #getRevisionInternal(
    id: DocumentRevisionId,
    ancestors: Set<DocumentRevisionId>
  ): Promise<CollaborationReadResult<DocumentRevisionRecord>> {
    if (ancestors.has(id)) {
      return failure("corrupted", "Stored revision ancestry contains a cycle.");
    }
    const stored = await this.#readStoredObject("document-revision", id);
    if (stored.status !== "valid") return stored;
    let core: DocumentRevisionCore;
    let identity;
    try {
      core = decodeStoredRevisionCore(stored.bytes);
      identity = await deriveDocumentRevisionIdentity(core);
      assertRevisionDoesNotReferenceItself(id, core);
    } catch (error) {
      return failure("corrupted", errorMessage(error));
    }
    if (identity.id !== id || !bytesEqual(identity.canonical_bytes, stored.bytes)) {
      return failure("mismatched", "Stored revision bytes do not match their address.");
    }
    if (
      stored.marker.project_id !== core.project_id ||
      stored.marker.document_id !== core.document_id
    ) {
      return failure("mismatched", "Revision commit metadata has incorrect ownership.");
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    const dependencyFailure = await this.#revisionDependencyFailure(core, nextAncestors);
    if (dependencyFailure) return dependencyFailure;
    return Object.freeze({
      status: "valid" as const,
      value: Object.freeze({
        record_version: 1 as const,
        object_kind: "document_revision" as const,
        revision_id: id,
        core
      })
    });
  }

  async #revisionDependencyFailure(
    core: DocumentRevisionCore,
    ancestors: Set<DocumentRevisionId>
  ): Promise<Exclude<CollaborationReadResult<DocumentRevisionRecord>, { status: "valid" }> | null> {
    const blob = await this.getMarkdownBlob(core.project_id, core.markdown_blob_id);
    if (blob.status !== "valid") {
      return failure(
        blob.status === "missing" ? "incomplete" : blob.status,
        `Revision Markdown dependency is ${blob.status}: ${blob.reason}`
      );
    }
    for (const parentId of core.parent_revision_ids) {
      const parent = await this.#getRevisionInternal(parentId, ancestors);
      if (parent.status === "missing" && core.ancestry_kind === "admission_boundary") {
        continue;
      }
      if (parent.status !== "valid") {
        return failure(
          parent.status === "missing" ? "incomplete" : parent.status,
          `Revision parent ${parentId} is ${parent.status}: ${parent.reason}`
        );
      }
      if (
        parent.value.core.project_id !== core.project_id ||
        parent.value.core.document_id !== core.document_id
      ) {
        return failure("mismatched", "Revision parent ownership does not match its child.");
      }
    }
    return null;
  }

  async #requireRevisionDependencies(
    core: DocumentRevisionCore,
    revisionId: DocumentRevisionId
  ): Promise<void> {
    const failureResult = await this.#revisionDependencyFailure(
      core,
      new Set([revisionId])
    );
    if (!failureResult) return;
    const missing = failureResult.status === "missing" || failureResult.status === "incomplete";
    throw new CollaborationStoreError(
      missing ? "dependency_missing" : "dependency_invalid",
      failureResult.reason
    );
  }

  async #putImmutableObject(
    metadata: StoredObjectMetadata,
    bytes: Uint8Array,
    verify: (bytes: Uint8Array) => Promise<void>,
    beforeCommit?: () => Promise<void>
  ): Promise<"stored" | "already_present"> {
    return this.#withLock(`object:${metadata.kind}:${metadata.id}`, async () => {
      const existing = await this.#readStoredObject(metadata.kind, metadata.id as never);
      if (existing.status === "valid") {
        if (
          existing.marker.project_id !== metadata.project_id ||
          existing.marker.document_id !== metadata.document_id ||
          !bytesEqual(existing.bytes, bytes)
        ) {
          throw new CollaborationStoreError(
            "mismatched",
            "An immutable object address already contains different content."
          );
        }
        await verify(existing.bytes);
        return "already_present";
      }
      if (existing.status === "corrupted" || existing.status === "mismatched") {
        throw new CollaborationStoreError(existing.status, existing.reason);
      }

      const addresses = metadata.kind === "markdown-blob"
        ? collaborationObjectAddresses("markdown-blob", metadata.id as MarkdownBlobId)
        : collaborationObjectAddresses("document-revision", metadata.id as DocumentRevisionId);
      await this.#injectFailure({
        stage: "before_first_write",
        object_kind: metadata.kind,
        object_id: metadata.id
      });
      await this.#write(addresses.staging, bytes, "staging");
      await this.#injectFailure({
        stage: "after_write_before_verification",
        object_kind: metadata.kind,
        object_id: metadata.id
      });
      const staged = await this.#read(addresses.staging);
      if (!staged || !bytesEqual(staged, bytes)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Staged immutable object bytes were incomplete after writing."
        );
      }
      await verify(staged);
      await this.#injectFailure({
        stage: "after_verification_before_committed_visibility",
        object_kind: metadata.kind,
        object_id: metadata.id
      });
      await this.#write(addresses.data, bytes, "object_data");
      const installed = await this.#read(addresses.data);
      if (!installed || !bytesEqual(installed, bytes)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Installed immutable object bytes were incomplete."
        );
      }
      await verify(installed);
      await beforeCommit?.();
      const marker = await encodeCommitMarker(metadata, installed);
      await this.#write(addresses.commit, marker, "commit_marker");
      const committedMarker = await this.#read(addresses.commit);
      if (!committedMarker || !bytesEqual(committedMarker, marker)) {
        throw new CollaborationStoreError(
          "incomplete",
          "Immutable object commit marker was incomplete."
        );
      }
      await this.#delete(addresses.staging);
      const committed = await this.#readStoredObject(metadata.kind, metadata.id as never);
      if (committed.status !== "valid") throw readFailureError(committed);
      return "stored";
    });
  }

  async #readStoredObject(
    kind: CollaborationStoredObjectKind,
    id: MarkdownBlobId | DocumentRevisionId
  ): Promise<RawStoredRead> {
    const addresses = kind === "markdown-blob"
      ? collaborationObjectAddresses(kind, id as MarkdownBlobId)
      : collaborationObjectAddresses(kind, id as DocumentRevisionId);
    const markerBytes = await this.#read(addresses.commit);
    const data = await this.#read(addresses.data);
    const staged = await this.#read(addresses.staging);
    if (markerBytes === null) {
      if (data !== null || staged !== null) {
        return failure("incomplete", "Object data exists without committed visibility.");
      }
      return failure("missing", "Object was not found.");
    }
    let marker: ParsedCommitMarker;
    try {
      marker = parseCommitMarker(markerBytes);
    } catch (error) {
      if (isTruncatedCommitMarker(markerBytes)) {
        return failure("incomplete", "Object commit marker is truncated.");
      }
      return failure("corrupted", errorMessage(error));
    }
    if (marker.kind !== kind || marker.id !== id) {
      return failure("mismatched", "Object commit marker does not match its address.");
    }
    if (data === null) {
      return failure("incomplete", "Committed object data is missing.");
    }
    if (data.length !== marker.stored_byte_length) {
      return failure("corrupted", "Committed object byte length does not match its marker.");
    }
    const digest = bytesToHex(await sha256(data));
    if (digest !== marker.stored_sha256) {
      return failure("corrupted", "Committed object bytes fail their storage digest.");
    }
    return Object.freeze({
      status: "valid" as const,
      bytes: Uint8Array.from(data),
      marker
    });
  }

  async #writeAndVerifyIndex(index: RevisionReferenceIndex): Promise<void> {
    const address = collaborationRevisionReferenceIndexAddress(index.revision_id);
    const bytes = encodeRevisionReferenceIndex(index);
    await this.#write(address, bytes, "derived_index");
    const installed = await this.#read(address);
    if (!installed || !bytesEqual(installed, bytes)) {
      throw new CollaborationStoreError(
        "incomplete",
        "Revision reference index write was incomplete."
      );
    }
    const decoded = decodeRevisionReferenceIndex(installed);
    if (decoded.revision_id !== index.revision_id) {
      throw new CollaborationStoreError(
        "mismatched",
        "Revision reference index was installed under the wrong address."
      );
    }
  }

  async #read(address: CollaborationStorageAddress): Promise<Uint8Array | null> {
    try {
      const result = await this.#backend.read(address);
      if (result !== null && !(result instanceof Uint8Array)) {
        throw new Error("Byte backend returned a non-byte value.");
      }
      return result === null ? null : Uint8Array.from(result);
    } catch (error) {
      throw backendError("read", address, error);
    }
  }

  async #write(
    address: CollaborationStorageAddress,
    bytes: Uint8Array,
    stage: "staging" | "object_data" | "commit_marker" | "derived_index"
  ): Promise<void> {
    try {
      await this.#backend.write(address, Uint8Array.from(bytes), { stage });
    } catch (error) {
      throw backendError("write", address, error);
    }
  }

  async #delete(address: CollaborationStorageAddress): Promise<void> {
    try {
      await this.#backend.delete(address);
    } catch (error) {
      throw backendError("delete", address, error);
    }
  }

  async #list(prefix: CollaborationStoragePrefix): Promise<readonly CollaborationStorageAddress[]> {
    try {
      const result = await this.#backend.list(prefix);
      if (!Array.isArray(result)) throw new Error("Byte backend list must return an array.");
      return Object.freeze([...result]);
    } catch (error) {
      throw backendError("list", prefix, error);
    }
  }

  async #injectFailure(context: Parameters<CollaborationStoreFailureInjector>[0]) {
    await this.#failureInjector?.(Object.freeze({ ...context }));
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#locks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

export function assertRevisionDoesNotReferenceItself(
  revisionId: DocumentRevisionId,
  core: DocumentRevisionCore
): void {
  const id = parseDigestId("document-revision", revisionId);
  const parsed = parseDocumentRevisionCore(core);
  if (parsed.parent_revision_ids.some((parentId) => parentId === id)) {
    throw new CollaborationStoreError(
      "self_reference",
      "A document revision cannot reference itself as a parent."
    );
  }
}

async function encodeCommitMarker(
  metadata: StoredObjectMetadata,
  data: Uint8Array
): Promise<Uint8Array> {
  const sha = bytesToHex(await sha256(data));
  return new TextEncoder().encode(
    `${commitHeader}\n` +
      `kind=${metadata.kind}\n` +
      `id=${metadata.id}\n` +
      `project_id=${metadata.project_id}\n` +
      `document_id=${metadata.document_id ?? "-"}\n` +
      `stored_byte_length=${data.length}\n` +
      `stored_sha256=${sha}\n`
  );
}

function parseCommitMarker(bytes: Uint8Array): ParsedCommitMarker {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Object commit marker is not well-formed UTF-8.");
  }
  const lines = text.split("\n");
  if (lines.length !== 8 || lines[0] !== commitHeader || lines[7] !== "") {
    throw new Error("Object commit marker has an invalid envelope.");
  }
  const kind = exactMarkerValue(lines[1], "kind");
  if (kind !== "markdown-blob" && kind !== "document-revision") {
    throw new Error("Object commit marker has an unsupported object kind.");
  }
  const idText = exactMarkerValue(lines[2], "id");
  const id = kind === "markdown-blob"
    ? parseDigestId("markdown-blob", idText)
    : parseDigestId("document-revision", idText);
  const projectId = parseEntityId(
    "project",
    exactMarkerValue(lines[3], "project_id")
  );
  const documentText = exactMarkerValue(lines[4], "document_id");
  const documentId = documentText === "-"
    ? null
    : parseEntityId("document", documentText);
  if (
    (kind === "markdown-blob" && documentId !== null) ||
    (kind === "document-revision" && documentId === null)
  ) {
    throw new Error("Object commit marker has invalid ownership fields.");
  }
  const lengthText = exactMarkerValue(lines[5], "stored_byte_length");
  if (!/^(?:0|[1-9][0-9]*)$/.test(lengthText)) {
    throw new Error("Object commit marker has an invalid byte length.");
  }
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length)) {
    throw new Error("Object commit marker byte length exceeds the runtime range.");
  }
  const digest = exactMarkerValue(lines[6], "stored_sha256");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Object commit marker has an invalid storage digest.");
  }
  return Object.freeze({
    kind,
    id,
    project_id: projectId,
    document_id: documentId,
    stored_byte_length: length,
    stored_sha256: digest
  });
}

function isTruncatedCommitMarker(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return `${commitHeader}\n`.startsWith(text) ||
      (text.startsWith(`${commitHeader}\n`) && text.split("\n").length < 8);
  } catch {
    return false;
  }
}

function exactMarkerValue(line: string, key: string): string {
  const prefix = `${key}=`;
  if (!line.startsWith(prefix) || line.length === prefix.length) {
    throw new Error(`Object commit marker is missing ${key}.`);
  }
  return line.slice(prefix.length);
}

function copyMarkdownDescription(
  value: MarkdownBlobDescription
): MarkdownBlobDescription {
  return Object.freeze({ ...value, bytes: Uint8Array.from(value.bytes) });
}

function failure<TStatus extends string>(status: TStatus, reason: string) {
  return Object.freeze({ status, reason });
}

function readFailureError(
  result: Readonly<{ status: string; reason: string }>
): CollaborationStoreError {
  const code = result.status === "missing"
    ? "not_found"
    : result.status === "incomplete"
      ? "incomplete"
      : result.status === "mismatched"
        ? "mismatched"
        : "corrupted";
  return new CollaborationStoreError(code, result.reason);
}

function backendError(operation: string, address: string, cause: unknown) {
  return new CollaborationStoreError(
    "backend_failed",
    `Collaboration byte backend failed to ${operation} ${address}.`,
    cause
  );
}

function requireValidRevisionForIndex(
  result: CollaborationReadResult<DocumentRevisionRecord>,
  reference: RevisionReference
): asserts result is Readonly<{ status: "valid"; value: DocumentRevisionRecord }> {
  if (result.status !== "valid") throw readFailureError(result);
  if (
    result.value.core.project_id !== reference.project_id ||
    result.value.core.document_id !== reference.document_id
  ) {
    throw new CollaborationStoreError(
      "ownership_mismatch",
      "Revision reference ownership does not match the immutable revision."
    );
  }
}

function classifyObjectResult<TId extends MarkdownBlobId | DocumentRevisionId>(
  result: CollaborationReadResult<unknown>,
  id: TId,
  valid: TId[],
  incomplete: CollaborationStorageAddress[],
  corrupted: Array<MarkdownBlobId | DocumentRevisionId>,
  mismatched: Array<MarkdownBlobId | DocumentRevisionId>,
  address: CollaborationStorageAddress
) {
  if (result.status === "valid") valid.push(id);
  else if (result.status === "missing" || result.status === "incomplete") incomplete.push(address);
  else if (result.status === "corrupted") corrupted.push(id);
  else mismatched.push(id);
}

function frozenSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values].sort());
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

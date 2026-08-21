import assert from "node:assert/strict";

import {
  CollaborationStoreError,
  ImmutableCollaborationStore,
  assertRevisionDoesNotReferenceItself,
  bytesToHex,
  collaborationObjectAddresses,
  collaborationRevisionReferenceIndexAddress,
  decodeStoredRevisionCore,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeKeyIdentity,
  parseCollaborationStorageAddress,
  parseRevisionReferenceIndex,
  sha256
} from "../lib/collaboration/index.ts";

const project = entity("project");
const otherProject = entity("project", "b");
const document = entity("document");
const otherDocument = entity("document", "b");
const historyRoot = digest("accepted-history-root");
let assertions = 0;

function checked(operation) {
  operation();
  assertions += 1;
}

async function checkedAsync(operation) {
  await operation();
  assertions += 1;
}

class MemoryByteBackend {
  constructor() {
    this.bytes = new Map();
    this.writeLog = [];
    this.writeFaults = [];
    this.failRead = false;
    this.failList = false;
    this.failDelete = false;
  }

  async read(address) {
    if (this.failRead) {
      this.failRead = false;
      throw new Error("Injected backend read failure.");
    }
    const value = this.bytes.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }

  async write(address, bytes, context) {
    this.writeLog.push({ address, stage: context.stage, length: bytes.length });
    const index = this.writeFaults.findIndex((fault) => fault.stage === context.stage);
    if (index >= 0) {
      const [fault] = this.writeFaults.splice(index, 1);
      if (fault.mode === "partial") {
        const length = Math.max(1, Math.min(bytes.length - 1, fault.length ?? 3));
        this.bytes.set(address, Uint8Array.from(bytes.slice(0, length)));
      }
      throw new Error(`Injected ${fault.mode} ${context.stage} write failure.`);
    }
    this.bytes.set(address, Uint8Array.from(bytes));
  }

  async delete(address) {
    if (this.failDelete) {
      this.failDelete = false;
      throw new Error("Injected backend delete failure.");
    }
    this.bytes.delete(address);
  }

  async list(prefix) {
    if (this.failList) {
      this.failList = false;
      throw new Error("Injected backend list failure.");
    }
    return [...this.bytes.keys()].filter((address) => address.startsWith(prefix)).sort();
  }

  faultWrite(stage, mode = "before", length) {
    this.writeFaults.push({ stage, mode, length });
  }

  rawGet(address) {
    const value = this.bytes.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }

  rawSet(address, bytes) {
    this.bytes.set(address, Uint8Array.from(bytes));
  }

  rawDelete(address) {
    this.bytes.delete(address);
  }

  writesFor(addresses) {
    const accepted = new Set(Object.values(addresses));
    return this.writeLog.filter((entry) => accepted.has(entry.address)).length;
  }
}

const blobBackend = new MemoryByteBackend();
const blobStore = new ImmutableCollaborationStore({ backend: blobBackend });
const markdownCases = [
  new Uint8Array(),
  utf8("# Привет 🌏\n"),
  utf8("line\n"),
  utf8("line\r\n"),
  utf8("no trailing newline"),
  utf8("with trailing newline\n"),
  utf8("\ufeffBOM\n"),
  utf8("BOM\n"),
  utf8("é\n"),
  utf8("e\u0301\n")
];
const blobResults = [];
for (const bytes of markdownCases) {
  blobResults.push(await blobStore.putMarkdownBlob(project, bytes));
}

checked(() => {
  assert.equal(new Set(blobResults.map((result) => result.id)).size, markdownCases.length);
  assert.equal(blobResults.every((result) => result.status === "stored"), true);
});

await checkedAsync(async () => {
  for (let index = 0; index < markdownCases.length; index += 1) {
    assert.deepEqual(
      await blobStore.materializeMarkdownBlob(project, blobResults[index].id),
      markdownCases[index]
    );
  }
});

await checkedAsync(async () => {
  const bytes = utf8("project scoped\n");
  const [left, right] = await Promise.all([
    blobStore.putMarkdownBlob(project, bytes),
    blobStore.putMarkdownBlob(otherProject, bytes)
  ]);
  assert.notEqual(left.id, right.id);
  assert.deepEqual(await blobStore.materializeMarkdownBlob(project, left.id), bytes);
  assert.deepEqual(await blobStore.materializeMarkdownBlob(otherProject, right.id), bytes);
});

await checkedAsync(async () => {
  const input = Uint8Array.from([65, 66, 67]);
  const expected = Uint8Array.from(input);
  const stored = await blobStore.putMarkdownBlob(project, input);
  input.fill(90);
  const first = await blobStore.materializeMarkdownBlob(project, stored.id);
  assert.deepEqual(first, expected);
  first.fill(1);
  assert.deepEqual(await blobStore.materializeMarkdownBlob(project, stored.id), expected);
});

await checkedAsync(async () => {
  const original = blobResults[1];
  const addresses = collaborationObjectAddresses("markdown-blob", original.id);
  const writesBefore = blobBackend.writesFor(addresses);
  const duplicate = await blobStore.putMarkdownBlob(project, markdownCases[1]);
  assert.equal(duplicate.status, "already_present");
  assert.equal(blobBackend.writesFor(addresses), writesBefore);
});

await checkedAsync(async () => {
  const backend = new MemoryByteBackend();
  const store = new ImmutableCollaborationStore({ backend });
  const bytes = utf8("concurrent\n");
  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.putMarkdownBlob(project, bytes))
  );
  assert.equal(results.filter((result) => result.status === "stored").length, 1);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.deepEqual(await store.materializeMarkdownBlob(project, results[0].id), bytes);
});

await checkedAsync(async () => {
  const backend = new MemoryByteBackend();
  const firstStore = new ImmutableCollaborationStore({ backend });
  const secondStore = new ImmutableCollaborationStore({ backend });
  const bytes = utf8("cross-instance convergence\n");
  const results = await Promise.all([
    firstStore.putMarkdownBlob(project, bytes),
    secondStore.putMarkdownBlob(project, bytes)
  ]);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.deepEqual(await firstStore.materializeMarkdownBlob(project, results[0].id), bytes);
});

checked(() => {
  assert.throws(() =>
    collaborationObjectAddresses("markdown-blob", digest("document-revision"))
  );
  assert.throws(() => parseCollaborationStorageAddress("../../document.md"));
  assert.throws(() => parseCollaborationStorageAddress(
    "patchmark-collaboration/v1/data/markdown-blob/../../document.md"
  ));
  assert.throws(() =>
    collaborationObjectAddresses("document-revision", "legacy-revision-alias")
  );
});

await checkedAsync(async () => {
  await assert.rejects(
    blobStore.getMarkdownBlob(project, digest("document-revision")),
    /markdown-blob/
  );
});

await checkedAsync(async () => {
  const backend = new MemoryByteBackend();
  const store = new ImmutableCollaborationStore({ backend });
  const sourceBytes = utf8("source\n");
  const targetBytes = utf8("target\n");
  const source = await store.putMarkdownBlob(project, sourceBytes);
  const target = await deriveMarkdownBlobIdentity(project, targetBytes);
  const targetAddresses = collaborationObjectAddresses("markdown-blob", target.id);
  backend.rawSet(targetAddresses.data, sourceBytes);
  backend.rawSet(
    targetAddresses.commit,
    await forgedCommitMarker("markdown-blob", target.id, project, null, sourceBytes)
  );
  const mismatch = await store.getMarkdownBlob(project, target.id);
  assert.equal(mismatch.status, "mismatched");
  assert.equal((await store.getMarkdownBlob(project, source.id)).status, "valid");
});

for (const corruptionKind of ["truncated", "corrupted"]) {
  await checkedAsync(async () => {
    const backend = new MemoryByteBackend();
    const store = new ImmutableCollaborationStore({ backend });
    const result = await store.putMarkdownBlob(project, utf8("integrity\n"));
    const addresses = collaborationObjectAddresses("markdown-blob", result.id);
    const data = backend.rawGet(addresses.data);
    assert.ok(data);
    backend.rawSet(
      addresses.data,
      corruptionKind === "truncated"
        ? data.slice(0, Math.max(0, data.length - 1))
        : Uint8Array.from(data, (byte, index) => index === 0 ? byte ^ 0xff : byte)
    );
    const read = await store.getMarkdownBlob(project, result.id);
    assert.equal(read.status, "corrupted");
    await assert.rejects(store.materializeMarkdownBlob(project, result.id),
      (error) => error instanceof CollaborationStoreError && error.code === "corrupted");
  });
}

await checkedAsync(async () => {
  const backend = new MemoryByteBackend();
  backend.faultWrite("staging", "partial", 2);
  const store = new ImmutableCollaborationStore({ backend });
  const bytes = utf8("retry exact\n");
  const identity = await deriveMarkdownBlobIdentity(project, bytes);
  await assert.rejects(store.putMarkdownBlob(project, bytes), backendFailure);
  assert.equal((await store.getMarkdownBlob(project, identity.id)).status, "incomplete");
  const retry = await store.putMarkdownBlob(project, bytes);
  assert.equal(retry.status, "stored");
  assert.deepEqual(await store.materializeMarkdownBlob(project, retry.id), bytes);
});

for (const stage of [
  "before_first_write",
  "after_write_before_verification",
  "after_verification_before_committed_visibility"
]) {
  await checkedAsync(async () => {
    const backend = new MemoryByteBackend();
    let injected = false;
    const store = new ImmutableCollaborationStore({
      backend,
      failure_injector: (context) => {
        if (!injected && context.stage === stage) {
          injected = true;
          throw new Error(`Injected ${stage}.`);
        }
      }
    });
    const bytes = utf8(`failure ${stage}\n`);
    const identity = await deriveMarkdownBlobIdentity(project, bytes);
    await assert.rejects(store.putMarkdownBlob(project, bytes), /Injected/);
    const interrupted = await store.getMarkdownBlob(project, identity.id);
    assert.equal(
      interrupted.status,
      stage === "before_first_write" ? "missing" : "incomplete"
    );
    assert.equal((await store.putMarkdownBlob(project, bytes)).status, "stored");
  });
}

for (const writeStage of ["object_data", "commit_marker"]) {
  await checkedAsync(async () => {
    const backend = new MemoryByteBackend();
    backend.faultWrite(writeStage, "partial", 4);
    const store = new ImmutableCollaborationStore({ backend });
    const bytes = utf8(`partial ${writeStage}\n`);
    const identity = await deriveMarkdownBlobIdentity(project, bytes);
    await assert.rejects(store.putMarkdownBlob(project, bytes), backendFailure);
    assert.equal((await store.getMarkdownBlob(project, identity.id)).status, "incomplete");
    assert.equal((await store.putMarkdownBlob(project, bytes)).status, "stored");
  });
}

await checkedAsync(async () => {
  const backend = new MemoryByteBackend();
  const store = new ImmutableCollaborationStore({ backend });
  const absent = await deriveMarkdownBlobIdentity(project, utf8("absent"));
  assert.equal((await store.getMarkdownBlob(project, absent.id)).status, "missing");
  backend.failRead = true;
  await assert.rejects(store.getMarkdownBlob(project, absent.id), backendFailure);
});

const backend = new MemoryByteBackend();
const store = new ImmutableCollaborationStore({ backend });
const genesisBlob = await store.putMarkdownBlob(project, utf8("genesis\n"));
const genesisCore = revisionCore("genesis", project, document, genesisBlob.id, []);
const genesis = await store.putRevision(genesisCore);

checked(() => {
  assert.equal(genesis.status, "stored");
  assert.equal(genesis.value.core.ancestry_kind, "genesis");
});

await checkedAsync(async () => {
  const concurrentBackend = new MemoryByteBackend();
  const concurrentStore = new ImmutableCollaborationStore({ backend: concurrentBackend });
  const blob = await concurrentStore.putMarkdownBlob(project, utf8("revision race\n"));
  const core = revisionCore("genesis", project, document, blob.id, []);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => concurrentStore.putRevision(core))
  );
  assert.equal(results.filter((result) => result.status === "stored").length, 1);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal((await concurrentStore.getRevision(results[0].id)).status, "valid");
});

const branchBlobA = await store.putMarkdownBlob(project, utf8("branch A\n"));
const branchA = await store.putRevision(
  revisionCore("ordinary", project, document, branchBlobA.id, [genesis.id])
);
const branchBlobB = await store.putMarkdownBlob(project, utf8("branch B\n"));
const branchB = await store.putRevision(
  revisionCore("ordinary", project, document, branchBlobB.id, [genesis.id])
);
const mergeBlob = await store.putMarkdownBlob(project, utf8("merged\n"));
const mergeParents = [branchA.id, branchB.id].sort();
const mergeRevisionCore = revisionCore(
  "ordinary",
  project,
  document,
  mergeBlob.id,
  mergeParents
);
const mergeRevisionIdentity = await deriveDocumentRevisionIdentity(mergeRevisionCore);
const mergeKeyCore = {
  schema_version: 1,
  object_kind: "merge_key_core",
  project_id: project,
  document_id: document,
  parent_revision_ids: mergeParents,
  base_revision_id: genesis.id,
  result_revision_id: mergeRevisionIdentity.id,
  merge_algorithm_id: "patchmark-merge",
  merge_algorithm_version: "v1"
};
const merge = await store.putMergeRevision(mergeRevisionCore, mergeKeyCore);

await checkedAsync(async () => {
  assert.equal(merge.revision.id, mergeRevisionIdentity.id);
  assert.deepEqual(
    await store.materializeRevisionMarkdown(merge.revision.id),
    utf8("merged\n")
  );
  const decoded = decodeStoredRevisionCore(
    backend.rawGet(collaborationObjectAddresses("document-revision", merge.revision.id).data)
  );
  assert.deepEqual(decoded, mergeRevisionCore);
});

await checkedAsync(async () => {
  const independentlyConstructed = {
    parent_revision_ids: [...mergeParents],
    markdown_blob_id: mergeBlob.id,
    document_id: document,
    ancestry_kind: "ordinary",
    object_kind: "document_revision_core",
    project_id: project,
    schema_version: 1
  };
  const duplicate = await store.putMergeRevision(
    independentlyConstructed,
    { ...mergeKeyCore }
  );
  assert.equal(duplicate.revision.status, "already_present");
  assert.equal(duplicate.revision.id, merge.revision.id);
  assert.equal(duplicate.merge_key_id, merge.merge_key_id);
});

await checkedAsync(async () => {
  const changedBase = await deriveMergeKeyIdentity({
    ...mergeKeyCore,
    base_revision_id: branchA.id
  });
  const changedAlgorithm = await deriveMergeKeyIdentity({
    ...mergeKeyCore,
    merge_algorithm_id: "patchmark-tree-merge"
  });
  const changedVersion = await deriveMergeKeyIdentity({
    ...mergeKeyCore,
    merge_algorithm_version: "v2"
  });
  assert.equal(new Set([
    merge.merge_key_id,
    changedBase.id,
    changedAlgorithm.id,
    changedVersion.id
  ]).size, 4);
  assert.equal(merge.revision.id, mergeRevisionIdentity.id);
});

await checkedAsync(async () => {
  const alternateBlob = await store.putMarkdownBlob(project, utf8("different result\n"));
  const alternate = await deriveDocumentRevisionIdentity(
    revisionCore("ordinary", project, document, alternateBlob.id, mergeParents)
  );
  const parentSetChanged = await deriveDocumentRevisionIdentity(
    revisionCore(
      "ordinary",
      project,
      document,
      mergeBlob.id,
      [genesis.id, branchA.id].sort()
    )
  );
  assert.notEqual(alternate.id, merge.revision.id);
  assert.notEqual(parentSetChanged.id, merge.revision.id);
});

await checkedAsync(async () => {
  const missingParent = digest("document-revision", "y");
  const boundaryBlob = await store.putMarkdownBlob(project, utf8("boundary\n"));
  const boundaryCore = {
    ...revisionCore(
      "admission_boundary",
      project,
      document,
      boundaryBlob.id,
      [missingParent]
    ),
    sealed_parent_history_root: historyRoot,
    parent_traversal: "unavailable_before_admission",
    prior_plaintext: "not_provided"
  };
  const boundary = await store.putRevision(boundaryCore);
  assert.equal((await store.getRevision(boundary.id)).status, "valid");
  await assert.rejects(
    store.putRevision(
      revisionCore("ordinary", project, document, boundaryBlob.id, [missingParent])
    ),
    dependencyMissing
  );
});

await checkedAsync(async () => {
  await assert.rejects(
    store.putRevision(
      revisionCore(
        "ordinary",
        project,
        document,
        digest("markdown-blob", "y"),
        [genesis.id]
      )
    ),
    dependencyMissing
  );
});

await checkedAsync(async () => {
  const corruptBackend = new MemoryByteBackend();
  const corruptStore = new ImmutableCollaborationStore({ backend: corruptBackend });
  const blob = await corruptStore.putMarkdownBlob(project, utf8("corrupt dependency\n"));
  const addresses = collaborationObjectAddresses("markdown-blob", blob.id);
  const bytes = corruptBackend.rawGet(addresses.data);
  bytes[0] ^= 0xff;
  corruptBackend.rawSet(addresses.data, bytes);
  await assert.rejects(
    corruptStore.putRevision(revisionCore("genesis", project, document, blob.id, [])),
    dependencyInvalid
  );
});

await checkedAsync(async () => {
  const corruptBackend = new MemoryByteBackend();
  const corruptStore = new ImmutableCollaborationStore({ backend: corruptBackend });
  const blob1 = await corruptStore.putMarkdownBlob(project, utf8("parent\n"));
  const parent = await corruptStore.putRevision(
    revisionCore("genesis", project, document, blob1.id, [])
  );
  const parentAddresses = collaborationObjectAddresses("document-revision", parent.id);
  const bytes = corruptBackend.rawGet(parentAddresses.data);
  bytes[bytes.length - 1] ^= 1;
  corruptBackend.rawSet(parentAddresses.data, bytes);
  const blob2 = await corruptStore.putMarkdownBlob(project, utf8("child\n"));
  await assert.rejects(
    corruptStore.putRevision(
      revisionCore("ordinary", project, document, blob2.id, [parent.id])
    ),
    dependencyInvalid
  );
});

await checkedAsync(async () => {
  const corruptBackend = new MemoryByteBackend();
  const corruptStore = new ImmutableCollaborationStore({ backend: corruptBackend });
  const parentBlob = await corruptStore.putMarkdownBlob(project, utf8("stable parent\n"));
  const parent = await corruptStore.putRevision(
    revisionCore("genesis", project, document, parentBlob.id, [])
  );
  const childBlob = await corruptStore.putMarkdownBlob(project, utf8("stable child\n"));
  const child = await corruptStore.putRevision(
    revisionCore("ordinary", project, document, childBlob.id, [parent.id])
  );
  const parentAddresses = collaborationObjectAddresses("document-revision", parent.id);
  const parentBytes = corruptBackend.rawGet(parentAddresses.data);
  parentBytes[0] ^= 1;
  corruptBackend.rawSet(parentAddresses.data, parentBytes);
  assert.equal((await corruptStore.getRevision(child.id)).status, "corrupted");
  await assert.rejects(
    corruptStore.materializeRevisionMarkdown(child.id),
    (error) => error instanceof CollaborationStoreError && error.code === "corrupted"
  );
});

await checkedAsync(async () => {
  const foreignBlob = await store.putMarkdownBlob(otherProject, utf8("foreign project\n"));
  const foreignParent = await store.putRevision(
    revisionCore("genesis", otherProject, document, foreignBlob.id, [])
  );
  await assert.rejects(
    store.putRevision(
      revisionCore("ordinary", project, document, mergeBlob.id, [foreignParent.id])
    ),
    dependencyInvalid
  );
  const otherDocumentParent = await store.putRevision(
    revisionCore("genesis", project, otherDocument, genesisBlob.id, [])
  );
  await assert.rejects(
    store.putRevision(
      revisionCore("ordinary", project, document, mergeBlob.id, [otherDocumentParent.id])
    ),
    dependencyInvalid
  );
});

checked(() => {
  assert.throws(() =>
    assertRevisionDoesNotReferenceItself(
      genesis.id,
      revisionCore("ordinary", project, document, genesisBlob.id, [genesis.id])
    ),
    (error) => error instanceof CollaborationStoreError && error.code === "self_reference"
  );
});

await checkedAsync(async () => {
  await assert.rejects(
    store.putRevision(
      revisionCore("ordinary", project, document, mergeBlob.id, [...mergeParents].reverse())
    ),
    /sorted and unique/
  );
  await assert.rejects(
    store.putRevision(
      revisionCore("ordinary", project, document, mergeBlob.id, [branchA.id, branchA.id])
    ),
    /sorted and unique/
  );
  for (const invalid of [
    { ...genesisCore, schema_version: 2 },
    { ...genesisCore, ancestry_kind: "future_revision_kind" },
    { ...genesisCore, creating_event_id: digest("semantic-event") },
    { ...genesisCore, author_id: entity("person") },
    { ...genesisCore, author_device_id: entity("device") },
    { ...genesisCore, signature: "forbidden" },
    { ...genesisCore, timestamp: "2026-01-01T00:00:00Z" },
    { ...genesisCore, proposer_device_id: entity("device") },
    { ...genesisCore, authorization_mode: "automatic" }
  ]) {
    await assert.rejects(store.putRevision(invalid));
  }
});

await checkedAsync(async () => {
  const addresses = collaborationObjectAddresses("document-revision", branchA.id);
  const writesBefore = backend.writesFor(addresses);
  const duplicate = await store.putRevision(branchA.value.core);
  assert.equal(duplicate.status, "already_present");
  assert.equal(backend.writesFor(addresses), writesBefore);
});

await checkedAsync(async () => {
  const sourceIdentity = await deriveDocumentRevisionIdentity(branchA.value.core);
  const targetCore = revisionCore("ordinary", project, document, branchBlobA.id, [branchB.id]);
  const targetIdentity = await deriveDocumentRevisionIdentity(targetCore);
  const targetAddresses = collaborationObjectAddresses(
    "document-revision",
    targetIdentity.id
  );
  backend.rawSet(targetAddresses.data, sourceIdentity.canonical_bytes);
  backend.rawSet(
    targetAddresses.commit,
    await forgedCommitMarker(
      "document-revision",
      targetIdentity.id,
      project,
      document,
      sourceIdentity.canonical_bytes
    )
  );
  assert.equal((await store.getRevision(targetIdentity.id)).status, "mismatched");
});

await checkedAsync(async () => {
  const truncationBackend = new MemoryByteBackend();
  const truncationStore = new ImmutableCollaborationStore({ backend: truncationBackend });
  const blob = await truncationStore.putMarkdownBlob(project, utf8("truncate revision\n"));
  const revision = await truncationStore.putRevision(
    revisionCore("genesis", project, document, blob.id, [])
  );
  const addresses = collaborationObjectAddresses("document-revision", revision.id);
  const bytes = truncationBackend.rawGet(addresses.data);
  truncationBackend.rawSet(addresses.data, bytes.slice(0, bytes.length - 1));
  assert.equal((await truncationStore.getRevision(revision.id)).status, "corrupted");
});

const authoredReference = reference("authored", merge.revision.id, digest("semantic-event", "b"));
const adoptedReference = reference("adopted", merge.revision.id, digest("semantic-event", "c"));
const secondAdoption = reference("adopted", merge.revision.id, digest("semantic-event", "d"));
const mergeAuthorization = reference(
  "authorized_merge",
  merge.revision.id,
  digest("semantic-event", "e")
);

await checkedAsync(async () => {
  const revisionBeforeIndexes = await store.getRevision(merge.revision.id);
  assert.equal((await store.getRevisionReferenceIndex(merge.revision.id)).status, "missing");
  await store.recordRevisionReference(authoredReference);
  await store.recordRevisionReference(secondAdoption);
  await store.recordRevisionReference(adoptedReference);
  await store.recordRevisionReference(mergeAuthorization);
  const duplicate = await store.recordRevisionReference(adoptedReference);
  assert.equal(duplicate.status, "already_present");
  const index = await store.getRevisionReferenceIndex(merge.revision.id);
  assert.equal(index.status, "valid");
  assert.equal(index.value.references.length, 4);
  assert.deepEqual(
    index.value.references.map((item) => `${item.reference_kind}:${item.event_id}`),
    [...index.value.references]
      .sort((left, right) => {
        const a = `${left.reference_kind}:${left.event_id}`;
        const b = `${right.reference_kind}:${right.event_id}`;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map((item) => `${item.reference_kind}:${item.event_id}`)
  );
  const revisionAfterIndexes = await store.getRevision(merge.revision.id);
  assert.equal(revisionAfterIndexes.status, "valid");
  assert.equal(revisionAfterIndexes.value.revision_id, revisionBeforeIndexes.value.revision_id);
  assert.deepEqual(revisionAfterIndexes.value.core, revisionBeforeIndexes.value.core);
});

checked(() => {
  assert.throws(() => parseRevisionReferenceIndex({
    schema_version: 1,
    object_kind: "revision_reference_index",
    project_id: project,
    document_id: document,
    revision_id: merge.revision.id,
    references: [authoredReference, adoptedReference]
  }), /sorted and unique/);
});

await checkedAsync(async () => {
  const address = collaborationRevisionReferenceIndexAddress(merge.revision.id);
  backend.rawDelete(address);
  assert.equal((await store.getRevisionReferenceIndex(merge.revision.id)).status, "missing");
  assert.equal((await store.getRevision(merge.revision.id)).status, "valid");
  const rebuilt = await store.rebuildRevisionReferenceIndex(
    merge.revision.id,
    [mergeAuthorization, adoptedReference, authoredReference, secondAdoption]
  );
  assert.equal(rebuilt.status, "rebuilt");
  assert.equal(rebuilt.value.references.length, 4);
});

await checkedAsync(async () => {
  const address = collaborationRevisionReferenceIndexAddress(merge.revision.id);
  backend.rawSet(address, Uint8Array.from([0xff]));
  assert.equal((await store.getRevisionReferenceIndex(merge.revision.id)).status, "corrupted");
  assert.equal((await store.getRevision(merge.revision.id)).status, "valid");
  await store.rebuildRevisionReferenceIndex(
    merge.revision.id,
    [authoredReference, adoptedReference]
  );
  assert.equal((await store.getRevisionReferenceIndex(merge.revision.id)).status, "valid");
});

await checkedAsync(async () => {
  const indexBackend = new MemoryByteBackend();
  const indexStore = new ImmutableCollaborationStore({ backend: indexBackend });
  const blob = await indexStore.putMarkdownBlob(project, utf8("index write failure\n"));
  const revision = await indexStore.putRevision(
    revisionCore("genesis", project, document, blob.id, [])
  );
  const ref = reference("authored", revision.id, digest("semantic-event", "i"));
  indexBackend.faultWrite("derived_index", "partial", 5);
  await assert.rejects(indexStore.recordRevisionReference(ref), backendFailure);
  assert.equal((await indexStore.getRevision(revision.id)).status, "valid");
  assert.equal((await indexStore.getRevisionReferenceIndex(revision.id)).status, "corrupted");
  await indexStore.rebuildRevisionReferenceIndex(revision.id, [ref]);
  assert.equal((await indexStore.getRevisionReferenceIndex(revision.id)).status, "valid");
});

await checkedAsync(async () => {
  const crashBackend = new MemoryByteBackend();
  let injected = false;
  const crashStore = new ImmutableCollaborationStore({
    backend: crashBackend,
    failure_injector: (context) => {
      if (!injected && context.stage === "after_object_commit_before_index_update") {
        injected = true;
        throw new Error("Injected post-commit index interruption.");
      }
    }
  });
  const blob = await crashStore.putMarkdownBlob(project, utf8("post commit\n"));
  const core = revisionCore("genesis", project, document, blob.id, []);
  const identity = await deriveDocumentRevisionIdentity(core);
  const ref = reference("authored", identity.id, digest("semantic-event", "f"));
  await assert.rejects(crashStore.putRevision(core, [ref]), /post-commit/);
  assert.equal((await crashStore.getRevision(identity.id)).status, "valid");
  assert.equal((await crashStore.getRevisionReferenceIndex(identity.id)).status, "missing");
  const retry = await crashStore.putRevision(core, [ref]);
  assert.equal(retry.status, "already_present");
  assert.equal((await crashStore.getRevisionReferenceIndex(identity.id)).status, "valid");
});

await checkedAsync(async () => {
  const crashBackend = new MemoryByteBackend();
  let injected = false;
  const crashStore = new ImmutableCollaborationStore({
    backend: crashBackend,
    failure_injector: (context) => {
      if (
        !injected &&
        context.stage === "before_first_write" &&
        context.object_kind === "document-revision"
      ) {
        injected = true;
        throw new Error("Injected revision start interruption.");
      }
    }
  });
  const blob = await crashStore.putMarkdownBlob(project, utf8("blob survives\n"));
  const core = revisionCore("genesis", project, document, blob.id, []);
  const identity = await deriveDocumentRevisionIdentity(core);
  await assert.rejects(crashStore.putRevision(core), /revision start/);
  assert.equal((await crashStore.getMarkdownBlob(project, blob.id)).status, "valid");
  assert.equal((await crashStore.getRevision(identity.id)).status, "missing");
});

await checkedAsync(async () => {
  const corruptBackend = new MemoryByteBackend();
  const corruptStore = new ImmutableCollaborationStore({ backend: corruptBackend });
  const blob = await corruptStore.putMarkdownBlob(project, utf8("indexed revision\n"));
  const core = revisionCore("genesis", project, document, blob.id, []);
  const revision = await corruptStore.putRevision(core);
  const ref = reference("authored", revision.id, digest("semantic-event", "g"));
  await corruptStore.recordRevisionReference(ref);
  const addresses = collaborationObjectAddresses("document-revision", revision.id);
  const bytes = corruptBackend.rawGet(addresses.data);
  bytes[0] ^= 1;
  corruptBackend.rawSet(addresses.data, bytes);
  assert.equal((await corruptStore.getRevisionReferenceIndex(revision.id)).status, "valid");
  assert.equal((await corruptStore.getRevision(revision.id)).status, "corrupted");
  await assert.rejects(
    corruptStore.recordRevisionReference(
      reference("adopted", revision.id, digest("semantic-event", "h"))
    )
  );
  const report = await corruptStore.recover();
  assert.ok(report.corrupted_object_ids.includes(revision.id));
  assert.ok(report.stale_index_revision_ids.includes(revision.id));
});

await checkedAsync(async () => {
  const recoveryBackend = new MemoryByteBackend();
  const recoveryStore = new ImmutableCollaborationStore({ backend: recoveryBackend });
  const valid = await recoveryStore.putMarkdownBlob(project, utf8("reopen valid\n"));
  recoveryBackend.faultWrite("staging", "partial", 1);
  const interruptedBytes = utf8("reopen interrupted\n");
  const interruptedId = (await deriveMarkdownBlobIdentity(project, interruptedBytes)).id;
  await assert.rejects(recoveryStore.putMarkdownBlob(project, interruptedBytes), backendFailure);
  const reopened = new ImmutableCollaborationStore({ backend: recoveryBackend });
  const report = await reopened.recover();
  assert.ok(report.valid_blob_ids.includes(valid.id));
  assert.ok(report.cleaned_staging_addresses.length > 0);
  assert.equal((await reopened.getMarkdownBlob(project, interruptedId)).status, "missing");
  assert.equal((await reopened.putMarkdownBlob(project, interruptedBytes)).status, "stored");
});

await checkedAsync(async () => {
  const recoveryBackend = new MemoryByteBackend();
  let injected = false;
  const recoveryStore = new ImmutableCollaborationStore({
    backend: recoveryBackend,
    failure_injector: (context) => {
      if (!injected && context.stage === "during_recovery") {
        injected = true;
        throw new Error("Injected recovery interruption.");
      }
    }
  });
  await assert.rejects(recoveryStore.recover(), /recovery interruption/);
  assert.deepEqual((await recoveryStore.recover()).valid_blob_ids, []);
  recoveryBackend.failList = true;
  await assert.rejects(recoveryStore.recover(), backendFailure);
});

process.stdout.write(
  `${JSON.stringify(
    {
      assertions,
      exactMarkdownCases: markdownCases.length,
      failureStages: [
        "before_first_write",
        "partial_staging_write",
        "after_write_before_verification",
        "after_verification_before_committed_visibility",
        "partial_object_data_write",
        "partial_commit_marker_write",
        "after_object_commit_before_index_update",
        "during_recovery"
      ],
      immutableRevisionKinds: ["genesis", "ordinary", "admission_boundary"],
      mergeIdentitySeparated: true,
      indexesNonAuthoritative: true,
      temporaryDirectoriesCreated: 0
    },
    null,
    2
  )}\n`
);

function revisionCore(kind, projectId, documentId, blobId, parents) {
  return {
    schema_version: 1,
    object_kind: "document_revision_core",
    ancestry_kind: kind,
    project_id: projectId,
    document_id: documentId,
    markdown_blob_id: blobId,
    parent_revision_ids: parents
  };
}

function reference(kind, revisionId, eventId) {
  return {
    schema_version: 1,
    reference_kind: kind,
    project_id: project,
    document_id: document,
    revision_id: revisionId,
    event_id: eventId
  };
}

async function forgedCommitMarker(kind, id, projectId, documentId, bytes) {
  return utf8(
    "patchmark/collaboration-object-commit/v1\n" +
      `kind=${kind}\n` +
      `id=${id}\n` +
      `project_id=${projectId}\n` +
      `document_id=${documentId ?? "-"}\n` +
      `stored_byte_length=${bytes.length}\n` +
      `stored_sha256=${bytesToHex(await sha256(bytes))}\n`
  );
}

function backendFailure(error) {
  return error instanceof CollaborationStoreError && error.code === "backend_failed";
}

function dependencyMissing(error) {
  return error instanceof CollaborationStoreError && error.code === "dependency_missing";
}

function dependencyInvalid(error) {
  return error instanceof CollaborationStoreError && error.code === "dependency_invalid";
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function entity(kind, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a`;
}

function digest(kind, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(50)}${marker}a`;
}

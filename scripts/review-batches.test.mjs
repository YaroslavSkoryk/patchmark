import assert from "node:assert/strict";
import {
  createProjectFromMarkdown,
  openProjectFolder,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import { createReviewBatchActiveExportEvidence } from "../lib/review-batches/review-batch-active-evidence.ts";
import {
  createTrackedReviewBatchExport,
  readExactReviewBatchPrompt
} from "../lib/review-batches/review-batch-export.ts";
import {
  cancelReviewBatch,
  getActiveReviewBatch,
  listReviewBatches,
  recordReviewBatchResponseReceipt
} from "../lib/review-batches/review-batch-repository.ts";
import { classifyReviewBatchResponseAssociation } from "../lib/review-batches/review-batch-response-receipt.ts";
import {
  parseReviewBatchRecords,
  serializeReviewBatchRecords
} from "../lib/review-batches/review-batch-schema.ts";
import { deriveReviewQueue } from "../lib/review-queue/review-queue-engine.ts";

const picker = { root: null };
globalThis.window = {
  showDirectoryPicker: async () => picker.root
};

async function run() {
const fixture = await createFixture("review-batches");
const firstExport = await exportManualBatch(fixture, {
  batchId: "review_batch_first",
  promptSuffix: "first"
});
assert.equal(firstExport.batch.status, "exported");
assert.equal(firstExport.batch.source, "manual");
assert.equal(firstExport.batch.batch_type, "manual");
assert.deepEqual(firstExport.batch.ordered_comment_ids, [fixture.comment.id]);
assert.equal(firstExport.batch.document_generation, 1);
assert.equal(firstExport.batch.batch_record_generation, 2);
assert.equal(firstExport.batch.prompt_sha256.length, 64);
assert.equal(firstExport.batch.context_pack.content_sha256.length, 64);
assert.equal(firstExport.batch.prompt_sha256, firstExport.batch.context_pack.content_sha256);
const writePaths = fixture.root.controller.completedWrites.map((entry) => entry.path);
const contextWriteIndex = writePaths.findIndex((path) => path.includes("context-packs/"));
const batchInstallIndex = writePaths.findIndex(
  (path) => path === ".patchmark/review-batches.json"
);
const commitInstallIndex = writePaths.findIndex(
  (path) => path === ".patchmark/save-commit.json"
);
assert.ok(contextWriteIndex >= 0 && batchInstallIndex > contextWriteIndex);
assert.ok(commitInstallIndex > batchInstallIndex);
const commit = JSON.parse(fixture.root.read(".patchmark/save-commit.json"));
assert.ok(commit.files.review_batches);

const activeEvidence = createReviewBatchActiveExportEvidence(firstExport.batch);
const queueWithActive = deriveReviewQueue({
  activeExportEvidence: activeEvidence,
  buildPromptPreview: () => "preview",
  comments: fixture.comments,
  documentGeneration: fixture.project.persistence.generation,
  documentId: firstExport.batch.document_id,
  markdown: fixture.markdown,
  patches: fixture.patches,
  projectId: firstExport.batch.project_id
});
assert.equal(queueWithActive.comments[0].state, "awaiting_chatgpt_response");
assert.equal(queueWithActive.proposal, null);

picker.root = fixture.root;
const reopened = await openProjectFolder();
assert.ok(reopened);
const reopenedBatches = await listReviewBatches(reopened.project);
const reopenedActive = getActiveReviewBatch(reopenedBatches);
assert.equal(reopenedActive?.batch_id, firstExport.batch.batch_id);
assert.equal(
  await readExactReviewBatchPrompt({
    batch: reopenedActive,
    project: reopened.project
  }),
  firstExport.promptText
);

const recoveredFixture = await createFixture("review-batch-lkg-recovery");
const recoveredExport = await exportManualBatch(recoveredFixture, {
  batchId: "review_batch_recovery",
  promptSuffix: "recovery"
});
await saveProjectState({
  markdown: `${recoveredFixture.markdown}\nCreate an LKG generation.\n`,
  project: recoveredFixture.project,
  reason: "review_batch_recovery_generation"
});
recoveredFixture.root.resolveFile(
  ".patchmark/review-batches.json"
).contents = "{malformed\n";
picker.root = recoveredFixture.root;
const recoveredOpen = await openProjectFolder();
assert.ok(recoveredOpen);
assert.equal(recoveredOpen.project.persistence.readSource, "lkg");
const recoveredActive = getActiveReviewBatch(
  await listReviewBatches(recoveredOpen.project)
);
assert.equal(recoveredActive?.batch_id, recoveredExport.batch.batch_id);
assert.equal(
  await readExactReviewBatchPrompt({
    batch: recoveredActive,
    project: recoveredOpen.project
  }),
  recoveredExport.promptText
);

await saveProjectState({
  markdown: `${fixture.markdown}\nChanged after export.\n`,
  project: reopened.project,
  reason: "change_after_review_batch_export"
});
assert.equal(
  await readExactReviewBatchPrompt({
    batch: reopenedActive,
    project: reopened.project
  }),
  firstExport.promptText
);

const cancelled = await cancelReviewBatch({
  batchId: reopenedActive.batch_id,
  cancelledAt: "2026-07-21T03:00:00.000Z",
  project: reopened.project
});
assert.equal(cancelled.at(-1).status, "cancelled");
assert.equal(getActiveReviewBatch(cancelled), null);
assert.equal(
  await readExactReviewBatchPrompt({
    batch: cancelled.at(-1),
    project: reopened.project
  }),
  firstExport.promptText
);

const secondExport = await exportManualBatch(
  {
    ...fixture,
    project: reopened.project,
    comments: await readProjectComments(reopened.project),
    patches: await readProjectPatches(reopened.project),
    markdown: `${fixture.markdown}\nChanged after export.\n`
  },
  { batchId: "review_batch_second", promptSuffix: "second" }
);
const exactAssociation = classifyReviewBatchResponseAssociation({
  activeBatch: secondExport.batch,
  response: {
    review_batch_id: secondExport.batch.batch_id,
    project_id: secondExport.batch.project_id,
    document_id: secondExport.batch.document_id
  },
  target: {
    projectId: secondExport.batch.project_id,
    documentId: secondExport.batch.document_id
  }
});
assert.equal(exactAssociation.kind, "exact");
const parsedTrackedResponse = parsePatchmarkCommentReplyImport(
  JSON.stringify({
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    review_batch_id: secondExport.batch.batch_id,
    project_id: secondExport.batch.project_id,
    document_id: secondExport.batch.document_id,
    summary: "Tracked response.",
    replies: [],
    patch_proposals: [],
    open_questions: []
  })
);
assert.equal(parsedTrackedResponse.review_batch_id, secondExport.batch.batch_id);
assert.equal(parsedTrackedResponse.project_id, secondExport.batch.project_id);
assert.equal(parsedTrackedResponse.document_id, secondExport.batch.document_id);
assert.equal(
  classifyReviewBatchResponseAssociation({
    activeBatch: secondExport.batch,
    response: {},
    target: {
      projectId: secondExport.batch.project_id,
      documentId: secondExport.batch.document_id
    }
  }).kind,
  "legacy_missing_identity"
);
assert.equal(
  classifyReviewBatchResponseAssociation({
    activeBatch: secondExport.batch,
    response: {
      review_batch_id: secondExport.batch.batch_id,
      project_id: secondExport.batch.project_id,
      document_id: "another-document"
    },
    target: {
      projectId: secondExport.batch.project_id,
      documentId: secondExport.batch.document_id
    }
  }).kind,
  "identity_mismatch"
);
const received = await recordReviewBatchResponseReceipt({
  batchId: secondExport.batch.batch_id,
  importId: "comment-import-exact",
  project: reopened.project,
  responseReceivedAt: "2026-07-21T04:00:00.000Z"
});
assert.equal(received.at(-1).status, "response_received");
assert.equal(getActiveReviewBatch(received), null);

const uniquenessFixture = await createFixture("uniqueness");
const concurrent = await Promise.allSettled([
  exportManualBatch(uniquenessFixture, {
    batchId: "review_batch_concurrent_a",
    promptSuffix: "a"
  }),
  exportManualBatch(uniquenessFixture, {
    batchId: "review_batch_concurrent_b",
    promptSuffix: "b"
  })
]);
assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
assert.equal(
  (await listReviewBatches(uniquenessFixture.project)).filter(
    (batch) => batch.status === "exported"
  ).length,
  1
);
assert.equal(
  uniquenessFixture.root.findPaths((path) => path.includes("context-packs/")).length,
  1
);

const contextFailureFixture = await createFixture("context-failure");
contextFailureFixture.root.controller.failNext((path) => path.includes("context-packs/"));
await assert.rejects(() =>
  exportManualBatch(contextFailureFixture, {
    batchId: "review_batch_context_failure",
    promptSuffix: "context-failure"
  })
);
assert.equal(await listReviewBatches(contextFailureFixture.project).then(getActiveReviewBatch), null);
assert.equal(contextFailureFixture.root.has(".patchmark/review-batches.json"), false);
await exportManualBatch(contextFailureFixture, {
  batchId: "review_batch_context_retry",
  promptSuffix: "context-retry"
});

const staleFixture = await createFixture("stale-proposal");
await assert.rejects(
  () =>
    createTrackedReviewBatchExport({
      algorithmVersion: 1,
      batchId: "review_batch_stale_proposal",
      batchType: "document_level",
      buildPrompt: (envelope) => ({
        promptText: `Stale prompt\n${JSON.stringify(envelope)}\n`
      }),
      comments: staleFixture.comments,
      documentGeneration: staleFixture.project.persistence.generation,
      documentTitle: staleFixture.project.manifest.project_name,
      markdown: staleFixture.markdown,
      overLimitWarning: false,
      patches: staleFixture.patches,
      project: staleFixture.project,
      section: null,
      source: "guided_review",
      validateBeforeCommit: () => {
        throw new Error("The proposal changed.");
      }
    }),
  /proposal changed/
);
assert.equal(await listReviewBatches(staleFixture.project).then(getActiveReviewBatch), null);
assert.equal(staleFixture.root.findPaths((path) => path.includes("context-packs/")).length, 0);

const unresolvedFixture = await createFixture("unresolved-anchor");
const unresolvedComment = {
  ...unresolvedFixture.comment,
  anchor: {
    kind: "selected_text",
    selected_text: "Missing anchor text",
    markdown_start_offset: 900,
    markdown_end_offset: 919,
    context_before: "",
    context_after: "",
    anchor_source: "markdown"
  }
};
await assert.rejects(() =>
  createTrackedReviewBatchExport({
    algorithmVersion: 1,
    batchId: "review_batch_unresolved_anchor",
    batchType: "section",
    buildPrompt: (envelope) => ({
      promptText: `Unresolved prompt\n${JSON.stringify(envelope)}\n`
    }),
    comments: [unresolvedComment],
    documentGeneration: unresolvedFixture.project.persistence.generation,
    documentTitle: unresolvedFixture.project.manifest.project_name,
    markdown: unresolvedFixture.markdown,
    overLimitWarning: false,
    patches: unresolvedFixture.patches,
    project: unresolvedFixture.project,
    section: {
      section_key_snapshot: "document:introduction",
      heading_snapshot: null
    },
    source: "guided_review"
  })
);
assert.equal(await listReviewBatches(unresolvedFixture.project).then(getActiveReviewBatch), null);

const oversizedFixture = await createFixture("oversized-warning");
const oversized = await createTrackedReviewBatchExport({
  algorithmVersion: 1,
  batchId: "review_batch_oversized_warning",
  batchType: "document_level",
  buildPrompt: (envelope) => ({
    promptText: `Oversized prompt\n${JSON.stringify(envelope)}\n`
  }),
  comments: oversizedFixture.comments,
  documentGeneration: oversizedFixture.project.persistence.generation,
  documentTitle: oversizedFixture.project.manifest.project_name,
  markdown: oversizedFixture.markdown,
  overLimitWarning: true,
  patches: oversizedFixture.patches,
  project: oversizedFixture.project,
  section: null,
  selectionAdjustment: {
    base_proposal_comment_ids: [oversizedFixture.comment.id],
    final_comment_ids: [oversizedFixture.comment.id],
    transiently_removed_comment_ids: [],
    transiently_added_comment_ids: []
  },
  source: "guided_review"
});
assert.equal(oversized.batch.over_limit_warning, true);
assert.deepEqual(oversized.batch.selection_adjustment, {
  base_proposal_comment_ids: [oversizedFixture.comment.id],
  final_comment_ids: [oversizedFixture.comment.id],
  transiently_removed_comment_ids: [],
  transiently_added_comment_ids: []
});

const persistenceFailureFixture = await createFixture("persistence-failure");
persistenceFailureFixture.root.controller.failNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("review-batches.json")
);
await assert.rejects(() =>
  exportManualBatch(persistenceFailureFixture, {
    batchId: "review_batch_persistence_failure",
    promptSuffix: "persistence-failure"
  })
);
assert.equal(await listReviewBatches(persistenceFailureFixture.project).then(getActiveReviewBatch), null);
assert.equal(
  persistenceFailureFixture.root.findPaths((path) => path.includes("context-packs/")).length,
  0
);
await exportManualBatch(persistenceFailureFixture, {
  batchId: "review_batch_persistence_retry",
  promptSuffix: "persistence-retry"
});

const markerFailureFixture = await createFixture("marker-failure");
markerFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/save-commit.json"
);
await assert.rejects(() =>
  exportManualBatch(markerFailureFixture, {
    batchId: "review_batch_marker_failure",
    promptSuffix: "marker-failure"
  })
);
assert.equal(await listReviewBatches(markerFailureFixture.project).then(getActiveReviewBatch), null);
assert.equal(markerFailureFixture.root.findPaths((path) => path.includes("context-packs/")).length, 0);
await exportManualBatch(markerFailureFixture, {
  batchId: "review_batch_marker_retry",
  promptSuffix: "marker-retry"
});

const cancellationFailureFixture = await createFixture("cancel-failure");
const cancellationExport = await exportManualBatch(cancellationFailureFixture, {
  batchId: "review_batch_cancel_failure",
  promptSuffix: "cancel-failure"
});
cancellationFailureFixture.root.controller.failNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("review-batches.json")
);
await assert.rejects(() =>
  cancelReviewBatch({
    batchId: cancellationExport.batch.batch_id,
    cancelledAt: "2026-07-21T05:00:00.000Z",
    project: cancellationFailureFixture.project
  })
);
assert.equal(
  getActiveReviewBatch(await listReviewBatches(cancellationFailureFixture.project))?.batch_id,
  cancellationExport.batch.batch_id
);

const responseFailureFixture = await createFixture("response-failure");
const responseFailureExport = await exportManualBatch(responseFailureFixture, {
  batchId: "review_batch_response_failure",
  promptSuffix: "response-failure"
});
responseFailureFixture.root.controller.failNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("review-batches.json")
);
await assert.rejects(() =>
  recordReviewBatchResponseReceipt({
    batchId: responseFailureExport.batch.batch_id,
    importId: "comment-import-failure",
    project: responseFailureFixture.project,
    responseReceivedAt: "2026-07-21T06:00:00.000Z"
  })
);
assert.equal(
  getActiveReviewBatch(await listReviewBatches(responseFailureFixture.project))?.batch_id,
  responseFailureExport.batch.batch_id
);

const independentA = await createFixture("independent-a");
const independentB = await createFixture("independent-b");
const [batchA, batchB] = await Promise.all([
  exportManualBatch(independentA, {
    batchId: "review_batch_independent_a",
    promptSuffix: "independent-a"
  }),
  exportManualBatch(independentB, {
    batchId: "review_batch_independent_b",
    promptSuffix: "independent-b"
  })
]);
assert.equal(batchA.batch.ordered_comment_ids[0], batchB.batch.ordered_comment_ids[0]);
assert.notEqual(batchA.batch.project_id, batchB.batch.project_id);

const validSerialized = serializeReviewBatchRecords({
  identity: {
    projectId: batchA.batch.project_id,
    documentId: batchA.batch.document_id
  },
  records: [batchA.batch]
});
assert.equal(
  parseReviewBatchRecords({
    identity: {
      projectId: batchA.batch.project_id,
      documentId: batchA.batch.document_id
    },
    text: validSerialized
  })[0].batch_id,
  batchA.batch.batch_id
);
assert.throws(() =>
  parseReviewBatchRecords({
    identity: {
      projectId: "wrong-project",
      documentId: batchA.batch.document_id
    },
    text: validSerialized
  })
);
assert.throws(() =>
  serializeReviewBatchRecords({
    identity: {
      projectId: batchA.batch.project_id,
      documentId: batchA.batch.document_id
    },
    records: [batchA.batch, { ...batchA.batch, batch_id: "review_batch_duplicate_active" }]
  })
);

console.log(
  JSON.stringify(
    {
      activeEvidence: queueWithActive.comments[0].state,
      batchLastOrdering: true,
      cancellationFailurePreservedActive: true,
      concurrentActiveCount: 1,
      contextPackFirstOrdering: true,
      duplicateLocalIdsIsolated: true,
      exactPromptReopened: true,
      markerFailureRetry: true,
      lkgRecoveryReloadedActive: true,
      oversizedWarningRetained: true,
      responseFailurePreservedActive: true,
      schemaOwnershipValidated: true,
      staleAndUnresolvedExportsRejected: true
    },
    null,
    2
  )
);
}

async function createFixture(name) {
  const root = new MemoryDirectoryHandle(name);
  picker.root = root;
  const markdown = `# ${name}\n\nDocument body for ${name}.\n`;
  const loaded = await createProjectFromMarkdown({
    markdown,
    suggestedProjectName: name
  });
  assert.ok(loaded);
  const comment = createComment();
  await saveProjectState({
    comments: [comment],
    project: loaded.project,
    reason: "review_batch_fixture_comment"
  });
  root.controller.resetLog();
  return {
    comment,
    comments: await readProjectComments(loaded.project),
    markdown,
    patches: await readProjectPatches(loaded.project),
    project: loaded.project,
    root
  };
}

async function exportManualBatch(fixture, { batchId, promptSuffix }) {
  const generation = fixture.project.persistence.generation;
  return createTrackedReviewBatchExport({
    algorithmVersion: null,
    batchId,
    batchType: "manual",
    buildPrompt: (envelope) => ({
      jsonText: `${JSON.stringify({ envelope })}\n`,
      promptText: `Tracked prompt ${promptSuffix}\n${JSON.stringify(envelope)}\n`
    }),
    comments: fixture.comments,
    documentGeneration: generation,
    documentTitle: fixture.project.manifest.project_name,
    markdown: fixture.markdown,
    now: "2026-07-21T02:00:00.000Z",
    overLimitWarning: false,
    patches: fixture.patches,
    project: fixture.project,
    section: null,
    source: "manual"
  });
}

function createComment() {
  return {
    id: "PM-COMMENT-DUPLICATE",
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: "Review this document.",
    thread: [],
    export_state: { focus_state: "in_focus" },
    created_at: "2026-07-21T01:00:00.000Z",
    updated_at: "2026-07-21T01:00:00.000Z"
  };
}

class MemoryWriteController {
  constructor() {
    this.completedWrites = [];
    this.failures = [];
  }

  failNext(matcher) {
    this.failures.push({ matcher, used: false });
  }

  consumeFailure(path) {
    const failure = this.failures.find((entry) => !entry.used && entry.matcher(path));
    if (!failure) return false;
    failure.used = true;
    return true;
  }

  resetLog() {
    this.completedWrites = [];
  }
}

class MemoryFileHandle {
  constructor(name, path, controller) {
    this.name = name;
    this.path = path;
    this.controller = controller;
    this.contents = "";
  }

  async getFile() {
    const contents = this.contents;
    return {
      name: this.name,
      size: Buffer.byteLength(contents),
      text: async () => contents
    };
  }

  async createWritable() {
    const chunks = [];
    const path = this.path;
    return {
      write: async (value) => chunks.push(String(value)),
      close: async () => {
        if (this.controller.consumeFailure(path)) {
          throw new Error(`Injected write failure: ${path}`);
        }
        this.contents = chunks.join("");
        this.controller.completedWrites.push({
          bytes: Buffer.byteLength(this.contents),
          path
        });
      }
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name, parent = null, controller = null) {
    this.name = name;
    this.parent = parent;
    this.controller = controller ?? new MemoryWriteController();
    this.files = new Map();
    this.directories = new Map();
  }

  get path() {
    if (!this.parent) return "";
    const parentPath = this.parent.path;
    return parentPath ? `${parentPath}/${this.name}` : this.name;
  }

  async getFileHandle(name, options = {}) {
    let file = this.files.get(name);
    if (!file && options.create) {
      const path = this.path ? `${this.path}/${name}` : name;
      file = new MemoryFileHandle(name, path, this.controller);
      this.files.set(name, file);
    }
    if (!file) throw new DOMException(`Missing ${name}`, "NotFoundError");
    return file;
  }

  async getDirectoryHandle(name, options = {}) {
    let directory = this.directories.get(name);
    if (!directory && options.create) {
      directory = new MemoryDirectoryHandle(name, this, this.controller);
      this.directories.set(name, directory);
    }
    if (!directory) throw new DOMException(`Missing ${name}`, "NotFoundError");
    return directory;
  }

  async removeEntry(name, options = {}) {
    if (this.files.delete(name)) return;
    if (this.directories.has(name) && options.recursive) {
      this.directories.delete(name);
      return;
    }
    throw new DOMException(`Missing ${name}`, "NotFoundError");
  }

  async *entries() {
    for (const [name] of this.files) yield [name, { kind: "file" }];
    for (const [name] of this.directories) yield [name, { kind: "directory" }];
  }

  has(path) {
    try {
      this.resolveFile(path);
      return true;
    } catch {
      return false;
    }
  }

  read(path) {
    return this.resolveFile(path).contents;
  }

  findPaths(predicate) {
    const paths = [];
    this.walkFiles((path) => {
      if (predicate(path)) paths.push(path);
    });
    return paths;
  }

  walkFiles(visitor) {
    for (const file of this.files.values()) visitor(file.path);
    for (const directory of this.directories.values()) directory.walkFiles(visitor);
  }

  resolveFile(path) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const directory = this.resolveDirectory(parts, false);
    const file = directory.files.get(fileName);
    if (!file) throw new Error(`Missing file ${path}`);
    return file;
  }

  resolveDirectory(parts, create) {
    return parts.reduce((directory, part) => {
      let child = directory.directories.get(part);
      if (!child && create) {
        child = new MemoryDirectoryHandle(part, directory, this.controller);
        directory.directories.set(part, child);
      }
      if (!child) throw new Error(`Missing directory ${part}`);
      return child;
    }, this);
  }
}

await run();

import assert from "node:assert/strict";
import {
  createProjectFromMarkdown,
  openProjectFolder,
  readProjectComments,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { deriveReviewQueue } from "../lib/review-queue/review-queue-engine.ts";
import {
  deferReviewComment,
  getDeferredReviewCommentIds,
  getReviewQueueOverrides,
  restoreDeferredReviewComment
} from "../lib/review-queue/review-queue-overrides.ts";
import {
  parseReviewQueueOverrides,
  serializeReviewQueueOverrides
} from "../lib/review-queue/review-queue-override-schema.ts";

const picker = { root: null };
globalThis.window = {
  showDirectoryPicker: async () => picker.root
};

async function run() {
const fixture = await createFixture("review-queue-overrides");
const originalCommentsText = fixture.root.read(".patchmark/comments.json");
const originalPatchesText = fixture.root.read(".patchmark/patches.json");
const empty = await getReviewQueueOverrides(fixture.project);
assert.deepEqual(empty.deferred_comments, []);

fixture.root.controller.resetLog();
const deferred = await deferReviewComment({
  commentId: fixture.comment.id,
  comments: fixture.comments,
  deferredAt: "2026-07-22T02:00:00.000Z",
  expectedDocumentGeneration: fixture.project.persistence.generation,
  project: fixture.project
});
assert.deepEqual([...getDeferredReviewCommentIds(deferred)], [fixture.comment.id]);
const installedWritePaths = fixture.root.controller.completedWrites
  .map((entry) => entry.path)
  .filter((path) => !path.includes(".patchmark-tmp-"));
assert.ok(installedWritePaths.includes(".patchmark/review-queue-overrides.json"));
assert.ok(installedWritePaths.includes(".patchmark/manifest.json"));
assert.ok(installedWritePaths.includes(".patchmark/save-commit.json"));
assert.equal(installedWritePaths.includes(".patchmark/comments.json"), false);
assert.equal(installedWritePaths.includes(".patchmark/patches.json"), false);
assert.equal(fixture.root.read(".patchmark/comments.json"), originalCommentsText);
assert.equal(fixture.root.read(".patchmark/patches.json"), originalPatchesText);
const committedOverride = JSON.parse(
  fixture.root.read(".patchmark/review-queue-overrides.json")
);
assert.equal(committedOverride.project_id, fixture.identity.projectId);
assert.equal(committedOverride.document_id, fixture.identity.documentId);
assert.equal(
  JSON.parse(fixture.root.read(".patchmark/save-commit.json")).files
    .review_queue_overrides.path,
  ".patchmark/review-queue-overrides.json"
);
assert.equal(classify(fixture, deferred), "deferred");

fixture.root.controller.resetLog();
await deferReviewComment({
  commentId: fixture.comment.id,
  comments: fixture.comments,
  deferredAt: "2026-07-22T02:01:00.000Z",
  expectedDocumentGeneration: fixture.project.persistence.generation,
  project: fixture.project
});
assert.equal(fixture.root.controller.completedWrites.length, 0);

const resolvedComment = {
  ...fixture.comment,
  status: "resolved",
  resolved_at: "2026-07-22T02:02:00.000Z",
  updated_at: "2026-07-22T02:02:00.000Z"
};
await saveProjectState({
  comments: [resolvedComment],
  project: fixture.project,
  reason: "resolve_deferred_comment"
});
assert.equal(
  classify({ ...fixture, comments: [resolvedComment] }, deferred),
  "resolved"
);
const reopenedComment = {
  ...resolvedComment,
  status: "open",
  resolved_at: undefined,
  updated_at: "2026-07-22T02:03:00.000Z"
};
await saveProjectState({
  comments: [reopenedComment],
  project: fixture.project,
  reason: "reopen_deferred_comment"
});
assert.equal(
  classify({ ...fixture, comments: [reopenedComment] }, deferred),
  "deferred"
);

const restored = await restoreDeferredReviewComment({
  commentId: fixture.comment.id,
  expectedDocumentGeneration: fixture.project.persistence.generation,
  project: fixture.project
});
assert.deepEqual(restored.deferred_comments, []);
assert.equal(
  classify({ ...fixture, comments: [reopenedComment] }, restored),
  "ready_for_chatgpt"
);

const deferFailure = await createFixture("defer-failure");
deferFailure.root.controller.failNext(
  (path) =>
    path.includes(".patchmark-tmp-") &&
    path.endsWith("review-queue-overrides.json")
);
await assert.rejects(() =>
  deferReviewComment({
    commentId: deferFailure.comment.id,
    comments: deferFailure.comments,
    deferredAt: "2026-07-22T03:00:00.000Z",
    expectedDocumentGeneration: deferFailure.project.persistence.generation,
    project: deferFailure.project
  })
);
assert.deepEqual(
  (await getReviewQueueOverrides(deferFailure.project)).deferred_comments,
  []
);
assert.equal(deferFailure.root.has(".patchmark/review-queue-overrides.json"), false);

const restoreFailure = await createFixture("restore-failure");
await deferReviewComment({
  commentId: restoreFailure.comment.id,
  comments: restoreFailure.comments,
  deferredAt: "2026-07-22T03:10:00.000Z",
  expectedDocumentGeneration: restoreFailure.project.persistence.generation,
  project: restoreFailure.project
});
restoreFailure.root.controller.failNext(
  (path) =>
    path.includes(".patchmark-tmp-") &&
    path.endsWith("review-queue-overrides.json")
);
await assert.rejects(() =>
  restoreDeferredReviewComment({
    commentId: restoreFailure.comment.id,
    expectedDocumentGeneration: restoreFailure.project.persistence.generation,
    project: restoreFailure.project
  })
);
assert.deepEqual(
  [...getDeferredReviewCommentIds(await getReviewQueueOverrides(restoreFailure.project))],
  [restoreFailure.comment.id]
);

const recovery = await createFixture("override-lkg-recovery");
await deferReviewComment({
  commentId: recovery.comment.id,
  comments: recovery.comments,
  deferredAt: "2026-07-22T04:00:00.000Z",
  expectedDocumentGeneration: recovery.project.persistence.generation,
  project: recovery.project
});
await saveProjectState({
  markdown: `${recovery.markdown}\nNew committed line.\n`,
  project: recovery.project,
  reason: "create_override_lkg"
});
recovery.root.resolveFile(
  ".patchmark/review-queue-overrides.json"
).contents = "{malformed\n";
picker.root = recovery.root;
const recoveredOpen = await openProjectFolder();
assert.ok(recoveredOpen);
assert.equal(recoveredOpen.project.persistence.readSource, "lkg");
assert.deepEqual(
  [
    ...getDeferredReviewCommentIds(
      await getReviewQueueOverrides(recoveredOpen.project)
    )
  ],
  [recovery.comment.id]
);

const duplicateA = await createFixture("duplicate-a", "COMMENT-SHARED");
const duplicateB = await createFixture("duplicate-b", "COMMENT-SHARED");
await deferReviewComment({
  commentId: "COMMENT-SHARED",
  comments: duplicateA.comments,
  deferredAt: "2026-07-22T05:00:00.000Z",
  expectedDocumentGeneration: duplicateA.project.persistence.generation,
  project: duplicateA.project
});
assert.deepEqual(
  [...getDeferredReviewCommentIds(await getReviewQueueOverrides(duplicateA.project))],
  ["COMMENT-SHARED"]
);
assert.deepEqual(
  (await getReviewQueueOverrides(duplicateB.project)).deferred_comments,
  []
);

const serialized = serializeReviewQueueOverrides({
  identity: duplicateA.identity,
  overrides: await getReviewQueueOverrides(duplicateA.project)
});
assert.equal(
  parseReviewQueueOverrides({ identity: duplicateA.identity, text: serialized })
    .document_id,
  duplicateA.identity.documentId
);
assert.throws(() =>
  parseReviewQueueOverrides({
    identity: { ...duplicateA.identity, documentId: "wrong-document" },
    text: serialized
  })
);

console.log(
  JSON.stringify(
    {
      atomicDeferAndRestore: true,
      commentsAndPatchesUnchanged: true,
      duplicateLocalIdsIsolated: true,
      lkgRecovery: true,
      noOpSuppression: true,
      persistenceFailuresPreserveState: true,
      resolvedPrecedenceAndReopen: true,
      schemaOwnership: true
    },
    null,
    2
  )
);
}

function classify(fixture, overrides) {
  return deriveReviewQueue({
    buildPromptPreview: () => "prompt",
    comments: fixture.comments,
    deferredCommentIds: getDeferredReviewCommentIds(overrides),
    documentGeneration: fixture.project.persistence.generation,
    documentId: fixture.identity.documentId,
    markdown: fixture.markdown,
    patches: [],
    projectId: fixture.identity.projectId
  }).comments[0].state;
}

async function createFixture(name, commentId = "COMMENT-1") {
  const root = new MemoryDirectoryHandle(name);
  picker.root = root;
  const markdown = `# ${name}\n\nDocument body.\n`;
  const loaded = await createProjectFromMarkdown({
    markdown,
    suggestedProjectName: name
  });
  assert.ok(loaded);
  const comment = {
    id: commentId,
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: "Review this document.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-22T01:00:00.000Z",
    updated_at: "2026-07-22T01:00:00.000Z"
  };
  await saveProjectState({
    comments: [comment],
    project: loaded.project,
    reason: "review_queue_override_fixture"
  });
  return {
    comment,
    comments: await readProjectComments(loaded.project),
    identity: {
      projectId: loaded.project.manifest.project_id,
      documentId: loaded.project.document?.document_id ?? "legacy-document"
    },
    markdown,
    project: loaded.project,
    root
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
    const failure = this.failures.find(
      (entry) => !entry.used && entry.matcher(path)
    );
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
    return this.parent.path ? `${this.parent.path}/${this.name}` : this.name;
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
    if (!directory) {
      throw new DOMException(`Missing ${name}`, "NotFoundError");
    }
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
    for (const [name] of this.directories) {
      yield [name, { kind: "directory" }];
    }
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

  resolveFile(path) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const directory = parts.reduce((current, part) => {
      const child = current.directories.get(part);
      if (!child) throw new Error(`Missing directory ${part}`);
      return child;
    }, this);
    const file = directory.files.get(fileName);
    if (!file) throw new Error(`Missing file ${path}`);
    return file;
  }
}

await run();

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createProjectFromMarkdown,
  getProjectPersistenceDebugState,
  openProjectFolder,
  readProjectComments,
  readProjectPatches,
  resetProjectPersistenceDebugState,
  restoreProjectLastKnownGood,
  saveProjectState
} from "../lib/project/patchmark-project.ts";

const picker = { root: null };
globalThis.window = {
  showDirectoryPicker: async () => picker.root
};

async function run() {
const noOpFixture = await createInitializedFixture("no-op");
resetProjectPersistenceDebugState(noOpFixture.project);
const noOpResult = await saveProjectState({
  comments: noOpFixture.comments,
  markdown: noOpFixture.markdown,
  patches: noOpFixture.patches,
  project: noOpFixture.project,
  reason: "test_no_op"
});
const noOpDebug = getProjectPersistenceDebugState(noOpFixture.project);
assert.equal(noOpResult.status, "unchanged");
assert.equal(noOpResult.generation, 0);
assert.equal(noOpDebug.serializationCount, 0);
assert.equal(noOpDebug.writeCount, 0);
assert.equal(noOpDebug.bytesWritten, 0);

const rapidFixture = await createInitializedFixture("rapid");
resetProjectPersistenceDebugState(rapidFixture.project);
const rapidRequests = [];
for (let index = 1; index <= 100; index += 1) {
  rapidRequests.push(
    saveProjectState({
      comments: [createComment(`rapid-${index}`)],
      project: rapidFixture.project,
      reason: "rapid_background_edit",
      allowSupersede: true
    })
  );
}
const rapidResults = await Promise.all(rapidRequests);
const rapidDebug = getProjectPersistenceDebugState(rapidFixture.project);
assert.equal(rapidResults.filter((result) => result.status === "committed").length, 1);
assert.equal(rapidResults.filter((result) => result.status === "superseded").length, 99);
assert.equal(rapidFixture.project.persistence?.generation ?? rapidResults.at(-1).generation, 1);
assert.equal(rapidDebug.committedGenerations, 1);
assert.equal(rapidDebug.staleRequestsSkipped, 99);
assert.equal(
  JSON.parse(rapidFixture.root.read(".patchmark/comments.json"))[0].comment,
  "rapid-100"
);

const delayedFixture = await createInitializedFixture("delayed");
delayedFixture.root.controller.delayNext(
  (path) => path.includes(".patchmark-tmp-") && path.endsWith("comments.json"),
  50
);
const older = saveProjectState({
  comments: [createComment("older")],
  project: delayedFixture.project,
  reason: "delayed_older",
  allowSupersede: true
});
await wait(5);
const newer = saveProjectState({
  comments: [createComment("newer")],
  project: delayedFixture.project,
  reason: "newer",
  allowSupersede: true
});
const [olderResult, newerResult] = await Promise.all([older, newer]);
assert.equal(olderResult.status, "superseded");
assert.equal(newerResult.status, "committed");
assert.equal(
  JSON.parse(delayedFixture.root.read(".patchmark/comments.json"))[0].comment,
  "newer"
);

const patchAcceptanceFixture = await createCommittedFixture("patch-acceptance");
const patchAcceptanceResult = await saveProjectState({
  ...createPatchAcceptanceRequest(patchAcceptanceFixture),
  project: patchAcceptanceFixture.project,
  reason: "accept_patch:PM-PATCH-TEST"
});
assert.equal(patchAcceptanceResult.status, "committed");
assert.equal(patchAcceptanceResult.generation, 2);
assert.equal(
  patchAcceptanceFixture.root.read("document.md"),
  `${patchAcceptanceFixture.markdown}\nAccepted patch content.\n`
);
assert.equal(
  JSON.parse(
    patchAcceptanceFixture.root.read(".patchmark/comments.json")
  )[0].comment,
  "accepted patch comment state"
);
assert.equal(
  JSON.parse(patchAcceptanceFixture.root.read(".patchmark/patches.json"))[0]
    .status,
  "accepted"
);

const dependencyFixture = await createCommittedFixture("patch-dependencies");
const dependencyPatches = [
  {
    ...createPatch("dependency prerequisite"),
    id: "PM-PATCH-DEPENDENCY-1",
    source_import_id: "PM-IMPORT-DEPENDENCY",
    source_patch_key: "base-change",
    depends_on_patch_ids: [],
    depends_on_patch_keys_snapshot: []
  },
  {
    ...createPatch("dependent change"),
    id: "PM-PATCH-DEPENDENCY-2",
    source_import_id: "PM-IMPORT-DEPENDENCY",
    source_patch_key: "dependent-change",
    depends_on_patch_ids: ["PM-PATCH-DEPENDENCY-1"],
    depends_on_patch_keys_snapshot: ["base-change"]
  }
];
await saveProjectState({
  patches: dependencyPatches,
  project: dependencyFixture.project,
  reason: "persist_patch_dependencies"
});
picker.root = dependencyFixture.root;
const reopenedDependencyFixture = await openProjectFolder();
assert.ok(reopenedDependencyFixture);
const reopenedDependencyPatches = await readProjectPatches(
  reopenedDependencyFixture.project
);
assert.deepEqual(
  reopenedDependencyPatches.map((patch) => ({
    dependsOnIds: patch.depends_on_patch_ids,
    dependsOnKeys: patch.depends_on_patch_keys_snapshot,
    id: patch.id,
    sourcePatchKey: patch.source_patch_key
  })),
  [
    {
      dependsOnIds: [],
      dependsOnKeys: [],
      id: "PM-PATCH-DEPENDENCY-1",
      sourcePatchKey: "base-change"
    },
    {
      dependsOnIds: ["PM-PATCH-DEPENDENCY-1"],
      dependsOnKeys: ["base-change"],
      id: "PM-PATCH-DEPENDENCY-2",
      sourcePatchKey: "dependent-change"
    }
  ]
);

const dependencyFailureFixture = await createCommittedFixture(
  "patch-dependency-failure"
);
const dependencyFailurePatchesBefore = dependencyFailureFixture.root.read(
  ".patchmark/patches.json"
);
const dependencyFailureCommitBefore = dependencyFailureFixture.root.read(
  ".patchmark/save-commit.json"
);
dependencyFailureFixture.root.controller.failNext(
  (path) => path === ".patchmark/patches.json"
);
await assert.rejects(() =>
  saveProjectState({
    patches: dependencyPatches,
    project: dependencyFailureFixture.project,
    reason: "persist_patch_dependencies_failure"
  })
);
assert.equal(
  dependencyFailureFixture.root.read(".patchmark/patches.json"),
  dependencyFailurePatchesBefore
);
assert.equal(
  dependencyFailureFixture.root.read(".patchmark/save-commit.json"),
  dependencyFailureCommitBefore
);

const interruptionStages = [
  {
    name: "lkg",
    matcher: (path) => path === ".patchmark/recovery/comments.json.lkg",
    expectsRecovery: false
  },
  {
    name: "temporary",
    matcher: (path) => path.includes(".patchmark-tmp-") && path.endsWith("document.md"),
    expectsRecovery: false
  },
  {
    name: "document_install",
    matcher: (path) => path === "document.md",
    expectsRecovery: false
  },
  {
    name: "comments_install",
    matcher: (path) => path === ".patchmark/comments.json",
    expectsRecovery: true
  },
  {
    name: "patches_install",
    matcher: (path) => path === ".patchmark/patches.json",
    expectsRecovery: true
  },
  {
    name: "manifest_install",
    matcher: (path) => path === ".patchmark/manifest.json",
    expectsRecovery: true
  },
  {
    name: "commit_install",
    matcher: (path) => path === ".patchmark/save-commit.json",
    expectsRecovery: true
  }
];
const interruptionResults = [];

for (const stage of interruptionStages) {
  const fixture = await createCommittedFixture(`failure-${stage.name}`);
  const previousCommit = fixture.root.read(".patchmark/save-commit.json");
  fixture.root.controller.failNext(stage.matcher);
  await assert.rejects(() =>
    saveProjectState({
      ...createPatchAcceptanceRequest(fixture),
      project: fixture.project,
      reason: `failure_${stage.name}`
    })
  );
  assert.equal(
    fixture.root.read(".patchmark/save-commit.json"),
    previousCommit,
    `${stage.name} must not advance commit metadata.`
  );
  picker.root = fixture.root;
  const reopened = await openProjectFolder();
  assert.ok(reopened);
  assert.equal(Boolean(reopened.recovery), stage.expectsRecovery);
  interruptionResults.push({
    stage: stage.name,
    recoveryOffered: Boolean(reopened.recovery)
  });
}

const malformedFixture = await createCommittedFixture("malformed");
const malformedSource = '{"truncated":';
malformedFixture.root.writeDirect(".patchmark/comments.json", malformedSource);
picker.root = malformedFixture.root;
const malformedOpen = await openProjectFolder();
assert.ok(malformedOpen?.recovery?.canRestore);
assert.equal(
  malformedFixture.root.read(".patchmark/comments.json"),
  malformedSource,
  "Startup validation must preserve malformed source bytes."
);
const restored = await restoreProjectLastKnownGood(malformedOpen.project);
assert.equal(restored.recovery, undefined);
assert.doesNotThrow(() => JSON.parse(malformedFixture.root.read(".patchmark/comments.json")));
assert.ok(
  malformedFixture.root.findPaths((path) =>
    path.includes(".patchmark/recovery/questionable-") &&
    path.endsWith("comments.json")
  ).some((path) => malformedFixture.root.read(path) === malformedSource),
  "Restore must retain the questionable malformed file."
);

const staleTemporaryFixture = await createCommittedFixture("stale-temporary");
staleTemporaryFixture.root.writeDirect(
  ".patchmark/.patchmark-tmp-stale-comments.json",
  "stale"
);
picker.root = staleTemporaryFixture.root;
const staleTemporaryOpen = await openProjectFolder();
assert.ok(staleTemporaryOpen);
assert.equal(
  staleTemporaryFixture.root.has(
    ".patchmark/.patchmark-tmp-stale-comments.json"
  ),
  false
);

const legacyRoot = createLegacyFixture("legacy");
picker.root = legacyRoot;
legacyRoot.controller.resetLog();
const legacyOpen = await openProjectFolder();
assert.ok(legacyOpen);
assert.equal(legacyOpen.recovery, undefined);
assert.equal(legacyRoot.controller.completedWrites.length, 0);
const legacyComments = await readProjectComments(legacyOpen.project);
const legacyPatches = await readProjectPatches(legacyOpen.project);
const legacyCommit = await saveProjectState({
  comments: [...legacyComments, createComment("legacy first change")],
  patches: legacyPatches,
  project: legacyOpen.project,
  reason: "legacy_first_change"
});
assert.equal(legacyCommit.generation, 1);
assert.ok(legacyRoot.has(".patchmark/save-commit.json"));

const verifiedCommit = JSON.parse(legacyRoot.read(".patchmark/save-commit.json"));
for (const [key, path] of Object.entries({
  document: "document.md",
  comments: ".patchmark/comments.json",
  patches: ".patchmark/patches.json",
  manifest: ".patchmark/manifest.json"
})) {
  const text = legacyRoot.read(path);
  assert.equal(verifiedCommit.files[key].bytes, Buffer.byteLength(text));
  assert.equal(
    verifiedCommit.files[key].sha256,
    crypto.createHash("sha256").update(text).digest("hex")
  );
}

process.stdout.write(
  `${JSON.stringify({
    noOp: noOpDebug,
    rapidEdits: rapidDebug,
    delayedWrite: { older: olderResult.status, newer: newerResult.status },
    patchAcceptanceGeneration: patchAcceptanceResult.generation,
    dependencyPersistenceRestart: true,
    dependencyFailurePreservedCommit: true,
    interruptionResults,
    malformedRecovery: true,
    staleTemporaryCleanup: true,
    legacyBaselineGeneration: legacyCommit.generation,
    commitHashesVerified: true
  }, null, 2)}\n`
);
}

async function createInitializedFixture(name) {
  const root = new MemoryDirectoryHandle(name);
  picker.root = root;
  const markdown = `# ${name}\n\nInitial document.\n`;
  const loaded = await createProjectFromMarkdown({
    markdown,
    suggestedProjectName: name
  });
  assert.ok(loaded);
  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  return { root, markdown, project: loaded.project, comments, patches };
}

async function createCommittedFixture(name) {
  const fixture = await createInitializedFixture(name);
  await saveProjectState({
    comments: [createComment("committed baseline")],
    project: fixture.project,
    reason: "establish_generation"
  });
  fixture.comments = await readProjectComments(fixture.project);
  fixture.patches = await readProjectPatches(fixture.project);
  fixture.root.controller.resetLog();
  return fixture;
}

function createLegacyFixture(name) {
  const root = new MemoryDirectoryHandle(name);
  root.writeDirect("document.md", `# ${name}\n\nLegacy project.\n`);
  root.writeDirect(
    ".patchmark/manifest.json",
    `${JSON.stringify({
      schema_version: 1,
      project_name: name,
      document_file: "document.md",
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z"
    }, null, 2)}\n`
  );
  root.writeDirect(".patchmark/comments.json", "[]\n");
  root.writeDirect(".patchmark/patches.json", "[]\n");
  return root;
}

function createComment(comment) {
  return {
    id: "PM-COMMENT-TEST",
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

function createPatch(reason) {
  return {
    id: "PM-PATCH-TEST",
    status: "pending",
    original_text: "Initial document.",
    suggested_text: "Changed document.",
    reason,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function createPatchAcceptanceRequest(fixture) {
  const acceptedAt = "2026-07-15T01:00:00.000Z";
  return {
    comments: [createComment("accepted patch comment state")],
    markdown: `${fixture.markdown}\nAccepted patch content.\n`,
    patches: [
      {
        ...createPatch("accepted patch"),
        status: "accepted",
        resolved_at: acceptedAt,
        accepted_at: acceptedAt,
        applied_at: acceptedAt
      }
    ]
  };
}

class MemoryWriteController {
  constructor() {
    this.completedWrites = [];
    this.failures = [];
    this.delays = [];
  }

  failNext(matcher) {
    this.failures.push({ matcher, used: false });
  }

  delayNext(matcher, milliseconds) {
    this.delays.push({ matcher, milliseconds, used: false });
  }

  consumeFailure(path) {
    const failure = this.failures.find((entry) => !entry.used && entry.matcher(path));
    if (!failure) return false;
    failure.used = true;
    return true;
  }

  consumeDelay(path) {
    const delay = this.delays.find((entry) => !entry.used && entry.matcher(path));
    if (!delay) return 0;
    delay.used = true;
    return delay.milliseconds;
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
    const controller = this.controller;
    return {
      write: async (value) => chunks.push(String(value)),
      close: async () => {
        const delay = controller.consumeDelay(path);
        if (delay > 0) await wait(delay);
        if (controller.consumeFailure(path)) {
          throw new Error(`Injected write failure: ${path}`);
        }
        this.contents = chunks.join("");
        controller.completedWrites.push({
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

  writeDirect(path, contents) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const directory = this.resolveDirectory(parts, true);
    let file = directory.files.get(fileName);
    if (!file) {
      const filePath = directory.path ? `${directory.path}/${fileName}` : fileName;
      file = new MemoryFileHandle(fileName, filePath, this.controller);
      directory.files.set(fileName, file);
    }
    file.contents = contents;
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await run();

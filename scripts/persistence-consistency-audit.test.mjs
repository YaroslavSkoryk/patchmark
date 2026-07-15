import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = process.env.PATCHMARK_REAL_PROJECT_DIR;

class MockFileHandle {
  constructor(name, contents) {
    this.name = name;
    this.contents = contents;
    this.completionSequence = 0;
    this.events = [];
    this.nextDelay = 0;
    this.failNextClose = false;
  }

  async createWritable() {
    const chunks = [];
    const delay = this.nextDelay;
    const shouldFail = this.failNextClose;
    this.nextDelay = 0;
    this.failNextClose = false;

    return {
      write: async (value) => chunks.push(String(value)),
      close: async () => {
        const event = {
          name: this.name,
          status: "started",
          value: chunks.join("")
        };
        this.events.push(event);
        if (delay > 0) await wait(delay);
        if (shouldFail) {
          event.status = "failed";
          throw new Error(`Injected close failure: ${this.name}`);
        }
        this.contents = event.value;
        event.status = "completed";
        this.completionSequence += 1;
        event.completedOrder = this.completionSequence;
      }
    };
  }
}

async function writeTextFile(file, contents) {
  const writable = await file.createWritable();
  await writable.write(contents);
  await writable.close();
}

const orderingFile = new MockFileHandle("comments.json", "generation-9");
orderingFile.nextDelay = 60;
const generation10 = writeTextFile(orderingFile, "generation-10");
await wait(2);
const generation11 = writeTextFile(orderingFile, "generation-11");
await Promise.all([generation10, generation11]);
assert.equal(
  orderingFile.contents,
  "generation-10",
  "An older delayed close can overwrite a newer completed close."
);

const documentFile = new MockFileHandle("document.md", "document-generation-1");
const commentsFile = new MockFileHandle(
  "comments.json",
  "comments-generation-1"
);
await writeTextFile(documentFile, "document-generation-2");
commentsFile.failNextClose = true;
await assert.rejects(() =>
  writeTextFile(commentsFile, "comments-generation-2")
);
assert.equal(documentFile.contents, "document-generation-2");
assert.equal(commentsFile.contents, "comments-generation-1");

const reverseDocument = new MockFileHandle("document.md", "document-generation-1");
const reverseComments = new MockFileHandle(
  "comments.json",
  "comments-generation-1"
);
await writeTextFile(reverseComments, "comments-generation-2");
reverseDocument.failNextClose = true;
await assert.rejects(() =>
  writeTextFile(reverseDocument, "document-generation-2")
);
assert.equal(reverseDocument.contents, "document-generation-1");
assert.equal(reverseComments.contents, "comments-generation-2");

const patchesFile = new MockFileHandle("patches.json", "patches-generation-1");
const linkedComments = new MockFileHandle(
  "comments.json",
  "comments-generation-1"
);
await writeTextFile(patchesFile, "patches-generation-2");
linkedComments.failNextClose = true;
await assert.rejects(() =>
  writeTextFile(linkedComments, "comments-generation-2")
);
assert.equal(patchesFile.contents, "patches-generation-2");
assert.equal(linkedComments.contents, "comments-generation-1");

const malformed = "{ invalid json";
assert.throws(() => JSON.parse(malformed));
assert.equal(malformed, "{ invalid json");

const persistedGenerationMetadata = fixtureDir
  ? inspectGenerationMetadata(fixtureDir)
  : { inspected: false };

const report = {
  outOfOrder: {
    completionOrder: orderingFile.events
      .filter((event) => event.status === "completed")
      .sort((first, second) => first.completedOrder - second.completedOrder)
      .map((event) => event.value),
    finalContents: orderingFile.contents,
    staleOverwriteObserved: orderingFile.contents === "generation-10"
  },
  partialWrites: {
    documentSucceededCommentsFailed: {
      document: documentFile.contents,
      comments: commentsFile.contents
    },
    commentsSucceededDocumentFailed: {
      document: reverseDocument.contents,
      comments: reverseComments.contents
    },
    patchesSucceededCommentsFailed: {
      patches: patchesFile.contents,
      comments: linkedComments.contents
    },
    temporaryFilesCreated: 0
  },
  invalidJson: {
    parseRejected: true,
    sourceUnchanged: malformed === "{ invalid json"
  },
  persistedGenerationMetadata
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function inspectGenerationMetadata(projectDir) {
  const paths = [
    "document.md",
    ".patchmark/comments.json",
    ".patchmark/patches.json",
    ".patchmark/manifest.json"
  ];
  const fields = [
    "document_hash",
    "document_sha256",
    "mutation_generation",
    "save_generation",
    "save_id"
  ];
  const matches = [];

  for (const path of paths) {
    const contents = readFileSync(join(projectDir, path), "utf8");
    for (const field of fields) {
      if (contents.includes(`\"${field}\"`)) matches.push({ field, path });
    }
  }

  return { inspected: true, matches };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

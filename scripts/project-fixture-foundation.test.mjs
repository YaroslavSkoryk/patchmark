import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getProjectDocumentIdentity,
  listProjectVersions,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";
import { createEditPerformanceProject } from "./lib/fixtures/create-edit-performance-project.mjs";
import { createDocumentSwitchProject } from "./lib/fixtures/create-document-switch-project.mjs";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";

const expectedLegacyMarkdown = [
  "# Synthetic Atlas",
  "",
  "This invented field note describes a clockwork observatory on a fictional moon.",
  ""
].join("\n");
const expectedMultiDocuments = [
  {
    documentId: "doc_operations",
    markdown: [
      "# Orbital Garden Operations",
      "",
      "Synthetic operators calibrate imaginary lantern arrays before each rehearsal.",
      ""
    ].join("\n"),
    path: "operations.md",
    projectId: "prj_fixture_constellation"
  },
  {
    documentId: "doc_evidence",
    markdown: [
      "# Constellation Evidence",
      "",
      "Invented observations record the color of model comets in a sealed studio.",
      ""
    ].join("\n"),
    path: "evidence.md",
    projectId: "prj_fixture_constellation"
  },
  {
    documentId: "doc_summary",
    markdown: [
      "# Quiet Orbit Summary",
      "",
      "A fictional steward summarizes the rehearsal without external references.",
      ""
    ].join("\n"),
    path: "summary.md",
    projectId: "prj_fixture_constellation"
  }
];
const cleanupCallbacks = [];
const generatedRoot = mkdtempSync(join(tmpdir(), "patchmark-foundation-generated-"));
const sourceRoots = {
  legacy: getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore),
  multi: getProjectFixtureRoot(PROJECT_FIXTURE_IDS.multiDocumentCore)
};
const sourceDigestsBefore = {
  legacy: digestProjectTree(sourceRoots.legacy),
  multi: digestProjectTree(sourceRoots.multi)
};
const results = {
  builders: {},
  copies: {},
  readers: {},
  sources: {
    legacy: sourceDigestsBefore.legacy.digest,
    multi: sourceDigestsBefore.multi.digest
  }
};

try {
  const legacyFirst = await openProject(sourceRoots.legacy);
  const legacySecond = await openProject(sourceRoots.legacy);
  const legacySummary = summarizeLoadedProject(legacyFirst);
  assert.deepEqual(legacySummary, summarizeLoadedProject(legacySecond));
  assert.deepEqual(legacySummary, {
    documentId: "doc_fixture_atlas",
    documentPath: "document.md",
    markdown: expectedLegacyMarkdown,
    mode: "legacy",
    projectId: "prj_fixture_atlas",
    projectSchemaVersion: null,
    recovery: null,
    storeSchemaVersion: 1
  });
  results.readers.legacy = legacySummary;

  const multiFirst = await openProject(sourceRoots.multi);
  const multiSecond = await openProject(sourceRoots.multi);
  assert.deepEqual(
    summarizeLoadedProject(multiFirst),
    summarizeLoadedProject(multiSecond)
  );
  assert.equal(multiFirst.project.projectManifest?.schema_version, 2);
  assert.deepEqual(
    multiFirst.project.projectManifest?.groups?.map((group) => group.group_id),
    ["group_plan", "group_research"]
  );
  const multiDocumentSummaries = [];
  for (const expected of expectedMultiDocuments) {
    const loaded = await openProjectDocument(
      multiFirst.project,
      expected.documentId
    );
    const summary = summarizeLoadedProject(loaded);
    assert.equal(summary.projectId, expected.projectId);
    assert.equal(summary.documentId, expected.documentId);
    assert.equal(summary.documentPath, expected.path);
    assert.equal(summary.markdown, expected.markdown);
    assert.equal(summary.mode, "multi");
    assert.equal(summary.projectSchemaVersion, 2);
    assert.equal(summary.storeSchemaVersion, 1);
    assert.equal(summary.recovery, null);
    multiDocumentSummaries.push(summary);
  }
  results.readers.multi = multiDocumentSummaries;

  const firstCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const secondCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  cleanupCallbacks.push(firstCopy.cleanup, secondCopy.cleanup);
  assert.notEqual(firstCopy.projectRoot, secondCopy.projectRoot);
  assert.deepEqual(digestProjectTree(firstCopy.projectRoot), sourceDigestsBefore.legacy);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigestsBefore.legacy);
  const writable = await openProjectFolderHandle(
    new NodeDirectoryHandle(firstCopy.projectRoot)
  );
  const mutationMarker = "\nFresh-copy mutation marker.\n";
  const saveResult = await saveProjectState({
    comments: await readProjectComments(writable.project),
    markdown: `${writable.markdown}${mutationMarker}`,
    patches: await readProjectPatches(writable.project),
    project: writable.project,
    reason: "fixture_foundation_isolation"
  });
  assert.equal(saveResult.status, "committed");
  assert.notEqual(
    digestProjectTree(firstCopy.projectRoot).digest,
    sourceDigestsBefore.legacy.digest
  );
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigestsBefore.legacy);
  assert.deepEqual(digestProjectTree(sourceRoots.legacy), sourceDigestsBefore.legacy);
  assert.equal(firstCopy.cleanup(), true);
  assert.equal(firstCopy.cleanup(), false);
  assert.equal(existsSync(firstCopy.temporaryRoot), false);
  assert.equal(existsSync(secondCopy.projectRoot), true);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigestsBefore.legacy);
  results.copies.sequential = {
    copiedDigest: sourceDigestsBefore.legacy.digest,
    firstChanged: true,
    saveStatus: saveResult.status,
    secondUnchanged: true
  };

  const concurrentCopies = await Promise.all(
    Array.from({ length: 4 }, async () =>
      createProjectFixtureCopy(PROJECT_FIXTURE_IDS.multiDocumentCore)
    )
  );
  cleanupCallbacks.push(...concurrentCopies.map((copy) => copy.cleanup));
  assert.equal(
    new Set(concurrentCopies.map((copy) => copy.projectRoot)).size,
    concurrentCopies.length
  );
  for (const copy of concurrentCopies) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), sourceDigestsBefore.multi);
  }
  appendFileSync(
    join(concurrentCopies[0].projectRoot, "operations.md"),
    "\nConcurrent isolation marker.\n"
  );
  assert.notEqual(
    digestProjectTree(concurrentCopies[0].projectRoot).digest,
    sourceDigestsBefore.multi.digest
  );
  for (const copy of concurrentCopies.slice(1)) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), sourceDigestsBefore.multi);
  }
  concurrentCopies[1].cleanup();
  assert.equal(existsSync(concurrentCopies[1].temporaryRoot), false);
  assert.equal(existsSync(concurrentCopies[2].projectRoot), true);
  results.copies.concurrent = {
    copies: concurrentCopies.length,
    distinctRoots: concurrentCopies.length,
    isolatedMutation: true
  };

  let failedTemporaryRoot = null;
  assert.throws(
    () =>
      createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore, {
        copyTree: (_sourceRoot, projectRoot) => {
          failedTemporaryRoot = dirname(projectRoot);
          mkdirSync(projectRoot);
          writeFileSync(join(projectRoot, "partial.txt"), "partial\n");
          throw new Error("Injected copy failure");
        }
      }),
    /Injected copy failure/
  );
  assert.ok(failedTemporaryRoot);
  assert.equal(existsSync(failedTemporaryRoot), false);
  assert.throws(() => getProjectFixtureRoot("../core-legacy"), /Unknown project fixture/);
  assert.throws(() => getProjectFixtureRoot("/tmp"), /Unknown project fixture/);
  assert.throws(
    () => createProjectFixtureCopy("../../private-project"),
    /Unknown project fixture/
  );
  const helperSource = readFileSync(
    new URL("./lib/project-fixture-foundation.mjs", import.meta.url),
    "utf8"
  );
  const gatedDirectoryVariable = ["PATCHMARK", "REAL", "PROJECT", "DIR"].join("_");
  assert.equal(helperSource.includes(gatedDirectoryVariable), false);
  results.copies.failureCleanup = true;
  results.copies.pathValidation = true;

  const editOptions = {
    commentCount: 12,
    paragraphCount: 48,
    seed: "foundation-edit-seed",
    tableRowCount: 8
  };
  const editA = createDestination("edit-a");
  const editB = createDestination("edit-b");
  const editDifferent = createDestination("edit-different");
  const editStartedAt = performance.now();
  const editAResult = createEditPerformanceProject(editA, editOptions);
  const editBResult = createEditPerformanceProject(editB, editOptions);
  const editDifferentResult = createEditPerformanceProject(editDifferent, {
    ...editOptions,
    paragraphCount: editOptions.paragraphCount + 1
  });
  const editGenerationMs = performance.now() - editStartedAt;
  const editDigest = digestProjectTree(editA);
  assert.deepEqual(editDigest, digestProjectTree(editB));
  assert.notEqual(editDigest.digest, digestProjectTree(editDifferent).digest);
  assert.equal(editAResult.projectId, editBResult.projectId);
  assert.equal(editDifferentResult.paragraphCount, editOptions.paragraphCount + 1);
  const editLoaded = await openProject(editA);
  assert.deepEqual(getProjectDocumentIdentity(editLoaded.project), {
    projectId: editAResult.projectId,
    documentId: editAResult.documentId
  });
  assert.equal((await readProjectComments(editLoaded.project)).length, 12);
  assert.equal((await readProjectPatches(editLoaded.project)).length, 0);
  assert.equal(editLoaded.recovery, undefined);
  assert.ok(editGenerationMs < 5_000, `Edit fixtures took ${editGenerationMs}ms.`);
  assert.throws(
    () =>
      createEditPerformanceProject(createDestination("edit-invalid-zero"), {
        ...editOptions,
        paragraphCount: 0
      }),
    /paragraphCount/
  );
  assert.throws(
    () =>
      createEditPerformanceProject(createDestination("edit-invalid-comments"), {
        ...editOptions,
        commentCount: 49
      }),
    /commentCount/
  );
  assert.throws(
    () =>
      createEditPerformanceProject(createDestination("edit-invalid-excessive"), {
        ...editOptions,
        paragraphCount: 2_001
      }),
    /paragraphCount/
  );
  results.builders.edit = {
    digest: editDigest.digest,
    generationMs: round(editGenerationMs),
    result: editAResult
  };

  const switchOptions = {
    commentCountPerDocument: 8,
    documentCount: 3,
    historyCountPerDocument: 4,
    paragraphCountPerDocument: 36,
    patchCountPerDocument: 10,
    seed: "foundation-switch-seed"
  };
  const switchA = createDestination("switch-a");
  const switchB = createDestination("switch-b");
  const switchDifferent = createDestination("switch-different");
  const switchStartedAt = performance.now();
  const switchAResult = createDocumentSwitchProject(switchA, switchOptions);
  const switchBResult = createDocumentSwitchProject(switchB, switchOptions);
  createDocumentSwitchProject(switchDifferent, {
    ...switchOptions,
    documentCount: switchOptions.documentCount + 1
  });
  const switchGenerationMs = performance.now() - switchStartedAt;
  const switchDigest = digestProjectTree(switchA);
  assert.deepEqual(switchDigest, digestProjectTree(switchB));
  assert.notEqual(switchDigest.digest, digestProjectTree(switchDifferent).digest);
  assert.deepEqual(switchAResult, switchBResult);
  const switchLoaded = await openProject(switchA);
  assert.equal(switchLoaded.project.projectManifest?.schema_version, 2);
  assert.equal(switchLoaded.project.projectManifest?.documents.length, 3);
  for (const document of switchAResult.documents) {
    const loaded = await openProjectDocument(
      switchLoaded.project,
      document.documentId
    );
    assert.equal((await readProjectComments(loaded.project)).length, 8);
    assert.equal((await readProjectPatches(loaded.project)).length, 10);
    assert.equal((await listProjectVersions(loaded.project)).length, 4);
    assert.equal(loaded.recovery, undefined);
  }
  assert.ok(
    switchGenerationMs < 5_000,
    `Switch fixtures took ${switchGenerationMs}ms.`
  );
  assert.throws(
    () =>
      createDocumentSwitchProject(createDestination("switch-invalid-docs"), {
        ...switchOptions,
        documentCount: 1
      }),
    /documentCount/
  );
  assert.throws(
    () =>
      createDocumentSwitchProject(createDestination("switch-invalid-patches"), {
        ...switchOptions,
        patchCountPerDocument: 1_001
      }),
    /patchCountPerDocument/
  );
  assert.throws(
    () =>
      createDocumentSwitchProject(createDestination("switch-invalid-seed"), {
        ...switchOptions,
        seed: ""
      }),
    /seed/
  );
  results.builders.switch = {
    digest: switchDigest.digest,
    generationMs: round(switchGenerationMs),
    result: switchAResult
  };

  const sourceDigestsAfter = {
    legacy: digestProjectTree(sourceRoots.legacy),
    multi: digestProjectTree(sourceRoots.multi)
  };
  assert.deepEqual(sourceDigestsAfter, sourceDigestsBefore);
  results.sources.unchanged = true;
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  for (const cleanup of cleanupCallbacks.reverse()) {
    cleanup();
  }
  rmSync(generatedRoot, { force: true, recursive: true });
  if (existsSync(sourceRoots.legacy) && existsSync(sourceRoots.multi)) {
    assert.deepEqual(digestProjectTree(sourceRoots.legacy), sourceDigestsBefore.legacy);
    assert.deepEqual(digestProjectTree(sourceRoots.multi), sourceDigestsBefore.multi);
  }
}

async function openProject(projectRoot) {
  return openProjectFolderHandle(new NodeDirectoryHandle(projectRoot), {
    readOnly: true
  });
}

function summarizeLoadedProject(loaded) {
  const identity = getProjectDocumentIdentity(loaded.project);
  return {
    documentId: identity.documentId,
    documentPath: loaded.project.document?.path ?? "document.md",
    markdown: loaded.markdown,
    mode: loaded.project.projectMode,
    projectId: identity.projectId,
    projectSchemaVersion: loaded.project.projectManifest?.schema_version ?? null,
    recovery: loaded.recovery?.kind ?? null,
    storeSchemaVersion: loaded.project.manifest.schema_version
  };
}

function createDestination(name) {
  const destination = join(generatedRoot, name);
  mkdirSync(destination);
  return destination;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

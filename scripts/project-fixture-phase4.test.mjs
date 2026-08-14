import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVersionRef } from "../lib/project/document-scoped-identity.ts";
import {
  getProjectDocumentIdentity,
  getProjectDocumentScopeId,
  listProjectVersions,
  openProjectFolderHandle,
  readProjectComments,
  readProjectVersionMarkdownByRef
} from "../lib/project/patchmark-project.ts";
import {
  PDF_EXPORT_FIXTURE,
  applyPdfExportProject
} from "./lib/fixtures/apply-pdf-export-project.mjs";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const copies = [];
const outputRoots = [];
const results = {};

try {
  assert.throws(
    () => applyPdfExportProject(sourceRoot),
    /fresh fixture copy/
  );

  const first = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const second = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(first, second);
  assert.deepEqual(digestProjectTree(first.projectRoot), sourceDigest);
  assert.deepEqual(digestProjectTree(second.projectRoot), sourceDigest);
  const firstContract = applyPdfExportProject(first.projectRoot);
  const secondContract = applyPdfExportProject(second.projectRoot);
  const variantDigest = digestProjectTree(first.projectRoot);
  assert.deepEqual(firstContract, secondContract);
  assert.deepEqual(digestProjectTree(second.projectRoot), variantDigest);
  assert.notEqual(variantDigest.digest, sourceDigest.digest);

  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(first.projectRoot),
    { readOnly: true }
  );
  assert.deepEqual(getProjectDocumentIdentity(loaded.project), {
    projectId: PDF_EXPORT_FIXTURE.projectId,
    documentId: PDF_EXPORT_FIXTURE.documentId
  });
  assert.equal(
    getProjectDocumentScopeId(loaded.project),
    "legacy-document"
  );
  assert.equal(loaded.markdown, firstContract.currentMarkdown);
  assert.match(loaded.markdown, new RegExp(PDF_EXPORT_FIXTURE.activeDocumentSentinel));
  assert.doesNotMatch(loaded.markdown, new RegExp(PDF_EXPORT_FIXTURE.staleHistorySentinel));

  const comments = await readProjectComments(loaded.project);
  assert.equal(comments.length, firstContract.commentCount);
  assert.equal(comments[0].id, PDF_EXPORT_FIXTURE.activeCommentId);
  assert.equal(comments[0].comment, PDF_EXPORT_FIXTURE.commentOnlySentinel);
  const versions = await listProjectVersions(loaded.project);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, PDF_EXPORT_FIXTURE.versionId);
  const staleMarkdown = await readProjectVersionMarkdownByRef(
    loaded.project,
    createVersionRef("legacy-document", versions[0].id),
    versions[0]
  );
  assert.equal(staleMarkdown, firstContract.staleMarkdown);

  const concurrent = await Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
      copies.push(copy);
      const outputRoot = mkdtempSync(join(tmpdir(), "patchmark-pdf-output-"));
      outputRoots.push(outputRoot);
      const contract = applyPdfExportProject(copy.projectRoot);
      writeFileSync(
        join(outputRoot, "allocation.json"),
        `${JSON.stringify({ index, projectRoot: copy.projectRoot })}\n`
      );
      return { contract, copy, outputRoot };
    })
  );
  assert.equal(
    new Set(concurrent.map(({ copy }) => copy.projectRoot)).size,
    concurrent.length
  );
  assert.equal(
    new Set(concurrent.map(({ outputRoot }) => outputRoot)).size,
    concurrent.length
  );
  const concurrentDigest = digestProjectTree(concurrent[0].copy.projectRoot);
  for (const { contract, copy, outputRoot } of concurrent.slice(1)) {
    assert.deepEqual(contract, concurrent[0].contract);
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
    assert.equal(existsSync(join(outputRoot, "allocation.json")), true);
  }
  appendFileSync(
    join(concurrent[0].copy.projectRoot, PDF_EXPORT_FIXTURE.fileName),
    "\nOwned-copy mutation.\n"
  );
  writeFileSync(join(concurrent[0].outputRoot, "owned-only.pdf"), "%PDF-owned\n");
  for (const { copy, outputRoot } of concurrent.slice(1)) {
    assert.deepEqual(digestProjectTree(copy.projectRoot), concurrentDigest);
    assert.equal(existsSync(join(outputRoot, "owned-only.pdf")), false);
  }

  const targetSource = readFileSync(
    new URL("pdf-export-browser.test.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(
    targetSource.includes(["PATCHMARK", "REAL", "PROJECT", "DIR"].join("_")),
    false,
    "Required PDF export coverage must not read the real-project gate."
  );
  assert.match(targetSource, /Page\.printToPDF/);
  assert.match(targetSource, /pdfinfo/);
  assert.match(targetSource, /pdftoppm/);
  assert.match(targetSource, /Print \/ Save PDF/);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);

  results.pdfExport = {
    digest: variantDigest.digest,
    identity: getProjectDocumentIdentity(loaded.project),
    suggestedName: firstContract.suggestedName,
    title: firstContract.title,
    versionId: firstContract.versionId
  };
  results.concurrent = {
    copies: concurrent.length,
    digest: concurrentDigest.digest,
    isolated: true,
    outputRoots: concurrent.length
  };
  results.source = {
    digest: sourceDigest.digest,
    unchanged: true
  };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  for (const outputRoot of outputRoots.reverse()) {
    rmSync(outputRoot, { force: true, recursive: true });
    assert.equal(existsSync(outputRoot), false);
  }
  for (const copy of copies.reverse()) {
    copy.cleanup();
    assert.equal(existsSync(copy.temporaryRoot), false);
  }
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
}

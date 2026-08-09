import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProjectDocumentIdentity,
  createProjectDocumentKey,
  parsePersistedProjectDocumentIdentity
} from "../lib/project/document-scoped-identity.ts";
import {
  getProjectDocumentIdentity,
  getProjectDocumentList,
  openProjectDocument,
  openProjectFolderHandle,
  updateProjectManifestMetadata
} from "../lib/project/patchmark-project.ts";
import {
  getDocumentReadingBookmark,
  removeDocumentReadingBookmark,
  resolveReadingBookmark,
  setDocumentReadingBookmark
} from "../lib/reading-bookmarks/reading-bookmark.ts";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";

const projectId = "prj_reading_bookmark_test";
const firstDocument = createProjectDocumentIdentity(projectId, "doc_first");
const secondDocument = createProjectDocumentIdentity(projectId, "doc_second");
const baseManifest = {
  schema_version: 1,
  project_id: projectId,
  document_id: firstDocument.documentId,
  project_name: "Reading bookmark fixture",
  document_file: "document.md",
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z"
};
const markdown = [
  "# Reading fixture",
  "",
  "Opening paragraph.",
  "",
  "## Durable location",
  "",
  "This is the exact sentence where reading stopped.",
  "",
  "Closing paragraph."
].join("\n");

await runModelTests();
await runPersistenceTests();

process.stdout.write(
  `${JSON.stringify({
    setRestoreReplaceRemove: true,
    fullProjectDocumentIdentity: true,
    equivalentTextIsolation: true,
    canonicalRecovery: true,
    missingAndAmbiguousUnavailable: true,
    documentTransactionPersistence: true,
    concurrentManifestMetadataPreserved: true,
    projectManifestRevisionUnaffected: true,
    legacyBookmarkOwnershipRebound: true,
    malformedBookmarkIgnored: true
  }, null, 2)}\n`
);

function runModelTests() {
  const firstSet = setDocumentReadingBookmark({
    anchor: createSelectedTextAnchor(),
    document: firstDocument,
    manifest: baseManifest,
    timestamp: "2026-07-20T01:00:00.000Z"
  });
  assert.equal(baseManifest.reading_bookmark, undefined);
  assert.deepEqual(
    getDocumentReadingBookmark({
      document: firstDocument,
      manifest: firstSet.manifest
    }),
    firstSet.bookmark
  );

  const reopenedManifest = JSON.parse(JSON.stringify(firstSet.manifest));
  assert.deepEqual(
    getDocumentReadingBookmark({
      document: firstDocument,
      manifest: reopenedManifest
    }),
    firstSet.bookmark
  );
  assert.throws(() =>
    getDocumentReadingBookmark({
      document: secondDocument,
      manifest: reopenedManifest
    })
  );

  const replaced = setDocumentReadingBookmark({
    anchor: {
      kind: "section",
      heading: "Durable location",
      heading_level: 2
    },
    document: firstDocument,
    manifest: firstSet.manifest,
    timestamp: "2026-07-20T02:00:00.000Z"
  });
  assert.equal(replaced.bookmark.created_at, firstSet.bookmark.created_at);
  assert.equal(replaced.bookmark.updated_at, "2026-07-20T02:00:00.000Z");

  const secondSet = setDocumentReadingBookmark({
    anchor: createSelectedTextAnchor(),
    document: secondDocument,
    manifest: {
      ...baseManifest,
      document_id: secondDocument.documentId
    },
    timestamp: "2026-07-20T03:00:00.000Z"
  });
  assert.notEqual(
    createProjectDocumentKey(
      parsePersistedProjectDocumentIdentity(firstSet.bookmark.document)
    ),
    createProjectDocumentKey(
      parsePersistedProjectDocumentIdentity(secondSet.bookmark.document)
    )
  );

  const initialResolution = resolveReadingBookmark({
    bookmark: firstSet.bookmark,
    markdown
  });
  assert.equal(initialResolution.state, "available");
  assert.equal(
    markdown.slice(initialResolution.start, initialResolution.end),
    firstSet.bookmark.anchor.selected_text
  );

  const movedMarkdown = [
    "# New introduction",
    "",
    "Inserted material before the existing document.",
    "",
    markdown
  ].join("\n");
  const movedResolution = resolveReadingBookmark({
    bookmark: firstSet.bookmark,
    markdown: movedMarkdown
  });
  assert.equal(movedResolution.state, "available");
  assert.equal(
    movedMarkdown.slice(movedResolution.start, movedResolution.end),
    firstSet.bookmark.anchor.selected_text
  );

  const ambiguousText = "Repeated reading target";
  const ambiguousBookmark = setDocumentReadingBookmark({
    anchor: {
      kind: "selected_text",
      selected_text: ambiguousText,
      markdown_start_offset: 999,
      markdown_end_offset: 999 + ambiguousText.length,
      anchor_source: "markdown"
    },
    document: firstDocument,
    manifest: baseManifest,
    timestamp: "2026-07-20T04:00:00.000Z"
  }).bookmark;
  assert.deepEqual(
    resolveReadingBookmark({
      bookmark: ambiguousBookmark,
      markdown: `${ambiguousText}\n\n${ambiguousText}`
    }),
    { state: "ambiguous" }
  );

  const missingBookmark = setDocumentReadingBookmark({
    anchor: {
      kind: "selected_text",
      selected_text: "A location that no longer exists",
      markdown_start_offset: 200,
      markdown_end_offset: 232,
      anchor_source: "markdown"
    },
    document: firstDocument,
    manifest: baseManifest,
    timestamp: "2026-07-20T05:00:00.000Z"
  }).bookmark;
  assert.deepEqual(resolveReadingBookmark({ bookmark: missingBookmark, markdown }), {
    state: "not_found"
  });

  const equivalentText = "Equivalent text in both documents";
  const equivalentAnchor = {
    kind: "selected_text",
    selected_text: equivalentText,
    markdown_start_offset: 0,
    markdown_end_offset: equivalentText.length,
    anchor_source: "markdown"
  };
  const firstEquivalent = setDocumentReadingBookmark({
    anchor: equivalentAnchor,
    document: firstDocument,
    manifest: baseManifest,
    timestamp: "2026-07-20T06:00:00.000Z"
  }).bookmark;
  const secondEquivalent = setDocumentReadingBookmark({
    anchor: equivalentAnchor,
    document: secondDocument,
    manifest: { ...baseManifest, document_id: secondDocument.documentId },
    timestamp: "2026-07-20T06:00:00.000Z"
  }).bookmark;
  assert.notEqual(
    createProjectDocumentKey(
      parsePersistedProjectDocumentIdentity(firstEquivalent.document)
    ),
    createProjectDocumentKey(
      parsePersistedProjectDocumentIdentity(secondEquivalent.document)
    )
  );

  const removed = removeDocumentReadingBookmark({
    document: firstDocument,
    manifest: replaced.manifest
  });
  assert.equal(removed.reading_bookmark, undefined);
}

async function runPersistenceTests() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "patchmark-reading-bookmark-")
  );
  try {
    createMultiDocumentFixture(temporaryRoot);
    const root = new NodeDirectoryHandle(temporaryRoot);
    const opened = await openProjectFolderHandle(root);
    const firstIdentity = getProjectDocumentIdentity(opened.project);
    const originalMarkdown = fs.readFileSync(
      path.join(temporaryRoot, "first.md"),
      "utf8"
    );
    const originalComments = fs.readFileSync(
      documentStorePath(temporaryRoot, "doc_first", "comments.json"),
      "utf8"
    );
    const originalPatches = fs.readFileSync(
      documentStorePath(temporaryRoot, "doc_first", "patches.json"),
      "utf8"
    );
    const originalProjectManifest = JSON.parse(
      fs.readFileSync(path.join(temporaryRoot, ".patchmark", "project.json"), "utf8")
    );

    const unrelatedUpdate = updateProjectManifestMetadata({
      project: opened.project,
      reason: "concurrent_unrelated_metadata",
      update: (manifest) => ({ ...manifest, current_version: "snapshot-0001" })
    });
    const bookmarkUpdate = updateProjectManifestMetadata({
      project: opened.project,
      reason: "set_reading_bookmark",
      update: (manifest) =>
        setDocumentReadingBookmark({
          anchor: createSelectedTextAnchor(opened.markdown),
          document: firstIdentity,
          manifest,
          timestamp: "2026-07-20T07:00:00.000Z"
        }).manifest
    });
    await Promise.all([unrelatedUpdate, bookmarkUpdate]);

    assert.equal(opened.project.manifest.current_version, "snapshot-0001");
    assert.equal(opened.project.manifest.save_generation, 2);
    assert.ok(opened.project.manifest.reading_bookmark);
    assert.equal(
      fs.readFileSync(path.join(temporaryRoot, "first.md"), "utf8"),
      originalMarkdown
    );
    assert.equal(
      fs.readFileSync(
        documentStorePath(temporaryRoot, "doc_first", "comments.json"),
        "utf8"
      ),
      originalComments
    );
    assert.equal(
      fs.readFileSync(
        documentStorePath(temporaryRoot, "doc_first", "patches.json"),
        "utf8"
      ),
      originalPatches
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(temporaryRoot, ".patchmark", "project.json"),
          "utf8"
        )
      ).manifest_revision,
      originalProjectManifest.manifest_revision
    );

    const second = await openProjectDocument(opened.project, "doc_second");
    assert.equal(second.project.manifest.reading_bookmark, undefined);
    const secondIdentity = getProjectDocumentIdentity(second.project);
    await updateProjectManifestMetadata({
      project: second.project,
      reason: "set_second_reading_bookmark",
      update: (manifest) =>
        setDocumentReadingBookmark({
          anchor: createSelectedTextAnchor(second.markdown),
          document: secondIdentity,
          manifest,
          timestamp: "2026-07-20T08:00:00.000Z"
        }).manifest
    });
    assert.equal(opened.project.manifest.save_generation, 2);

    const reopenedFirst = await openProjectDocument(second.project, "doc_first");
    assert.equal(
      getDocumentReadingBookmark({
        document: getProjectDocumentIdentity(reopenedFirst.project),
        manifest: reopenedFirst.project.manifest
      })?.updated_at,
      "2026-07-20T07:00:00.000Z"
    );
    const documents = await getProjectDocumentList(reopenedFirst.project);
    assert.deepEqual(
      documents
        .filter((document) => document.hasReadingBookmark)
        .map((document) => document.document_id)
        .sort(),
      ["doc_first", "doc_second"]
    );

    const firstManifestPath = documentStorePath(
      temporaryRoot,
      "doc_first",
      "manifest.json"
    );
    const sourceFormatManifest = JSON.parse(fs.readFileSync(firstManifestPath, "utf8"));
    const sourceBookmark = sourceFormatManifest.reading_bookmark;
    delete sourceFormatManifest.reading_bookmark;
    sourceFormatManifest.reading_bookmarks = {
      "legacy-source::document.md": {
        format_version: 1,
        document: {
          project_id: "PM-PROJECT-SOURCE",
          document_file: "document.md"
        },
        anchor: sourceBookmark.anchor,
        created_at: sourceBookmark.created_at,
        updated_at: sourceBookmark.updated_at
      }
    };
    fs.writeFileSync(firstManifestPath, `${JSON.stringify(sourceFormatManifest, null, 2)}\n`);
    fs.rmSync(documentStorePath(temporaryRoot, "doc_first", "save-commit.json"), {
      force: true
    });
    const legacyReopened = await openProjectDocument(second.project, "doc_first");
    assert.deepEqual(
      getProjectDocumentIdentity(legacyReopened.project),
      parsePersistedProjectDocumentIdentity(
        getDocumentReadingBookmark({
          document: getProjectDocumentIdentity(legacyReopened.project),
          manifest: legacyReopened.project.manifest
        }).document
      )
    );

    const secondManifestPath = documentStorePath(
      temporaryRoot,
      "doc_second",
      "manifest.json"
    );
    const malformedManifest = JSON.parse(fs.readFileSync(secondManifestPath, "utf8"));
    malformedManifest.reading_bookmark = {
      format_version: 1,
      document: null,
      anchor: { kind: "selected_text" },
      created_at: 42
    };
    delete malformedManifest.save_generation;
    delete malformedManifest.save_commit_id;
    fs.writeFileSync(secondManifestPath, `${JSON.stringify(malformedManifest, null, 2)}\n`);
    fs.rmSync(documentStorePath(temporaryRoot, "doc_second", "save-commit.json"), {
      force: true
    });
    const malformedReopened = await openProjectDocument(
      legacyReopened.project,
      "doc_second"
    );
    assert.equal(malformedReopened.project.manifest.reading_bookmark, undefined);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function createSelectedTextAnchor(source = markdown) {
  const selectedText = "exact sentence where reading stopped";
  const start = source.indexOf(selectedText);
  const paragraph = "This is the exact sentence where reading stopped.";
  const paragraphStart = source.indexOf(paragraph);
  assert.notEqual(start, -1);
  assert.notEqual(paragraphStart, -1);
  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: {
      kind: "paragraph",
      plain_text: paragraph,
      markdown_text: paragraph,
      selected_start_in_context: start - paragraphStart,
      selected_end_in_context: start - paragraphStart + selectedText.length,
      markdown_start_offset: paragraphStart,
      markdown_end_offset: paragraphStart + paragraph.length
    },
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    context_before: source.slice(Math.max(0, start - 32), start),
    context_after: source.slice(
      start + selectedText.length,
      start + selectedText.length + 32
    ),
    containing_heading: "Durable location",
    containing_heading_level: 2,
    anchor_source: "markdown"
  };
}

function createMultiDocumentFixture(root) {
  const now = "2026-07-20T00:00:00.000Z";
  fs.mkdirSync(path.join(root, ".patchmark", "documents"), { recursive: true });
  const documents = [
    createDocumentFixture(root, "doc_first", "first.md", "First", now),
    createDocumentFixture(root, "doc_second", "second.md", "Second", now, true)
  ];
  fs.writeFileSync(
    path.join(root, ".patchmark", "project.json"),
    `${JSON.stringify({
      format: "patchmark-project",
      schema_version: 1,
      project_id: projectId,
      title: "Reading bookmark project",
      created_at: now,
      manifest_revision: 1,
      documents
    }, null, 2)}\n`
  );
}

function createDocumentFixture(root, documentId, documentPath, title, now, malformed = false) {
  fs.writeFileSync(path.join(root, documentPath), markdown);
  const store = path.join(root, ".patchmark", "documents", documentId);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      project_name: "Reading bookmark project",
      document_file: "document.md",
      created_at: now,
      updated_at: now,
      ...(malformed
        ? {
            reading_bookmark: {
              format_version: 1,
              document: null,
              anchor: null
            }
          }
        : {})
    }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(store, "comments.json"), "[]\n");
  fs.writeFileSync(path.join(store, "patches.json"), "[]\n");
  fs.writeFileSync(
    path.join(store, "document.json"),
    `${JSON.stringify({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: documentId,
      created_at: now,
      source: "created"
    }, null, 2)}\n`
  );
  return {
    document_id: documentId,
    path: documentPath,
    display_title: title,
    role: null,
    status: "active",
    position: documentId === "doc_first" ? 1000 : 2000,
    added_at: now,
    archived_at: null
  };
}

function documentStorePath(root, documentId, fileName) {
  return path.join(root, ".patchmark", "documents", documentId, fileName);
}

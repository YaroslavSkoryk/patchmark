import assert from "node:assert/strict";
import {
  createPatchmarkDocumentIdentityKey
} from "../lib/project/project-identity.ts";
import {
  getCurrentDocumentReadingBookmark,
  removeDocumentReadingBookmark,
  resolveReadingBookmark,
  setDocumentReadingBookmark
} from "../lib/reading-bookmarks/reading-bookmark.ts";

const projectId = "PM-PROJECT-READING-TEST";
const firstDocument = {
  document_file: "document.md",
  project_id: projectId
};
const secondDocument = {
  document_file: "chapter-two.md",
  project_id: projectId
};
const baseManifest = {
  schema_version: 1,
  project_id: projectId,
  project_name: "Reading bookmark fixture",
  document_file: firstDocument.document_file,
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

const firstSet = setDocumentReadingBookmark({
  anchor: createSelectedTextAnchor(),
  manifest: baseManifest,
  timestamp: "2026-07-20T01:00:00.000Z"
});

assert.equal(baseManifest.reading_bookmarks, undefined);
assert.deepEqual(
  getCurrentDocumentReadingBookmark(firstSet.manifest),
  firstSet.bookmark
);
assert.equal(firstSet.bookmark.document.project_id, projectId);
assert.equal(firstSet.bookmark.document.document_file, "document.md");

const reopenedManifest = JSON.parse(JSON.stringify(firstSet.manifest));
assert.deepEqual(
  getCurrentDocumentReadingBookmark(reopenedManifest),
  firstSet.bookmark
);

const replacementAnchor = {
  kind: "section",
  heading: "Durable location",
  heading_level: 2
};
const replaced = setDocumentReadingBookmark({
  anchor: replacementAnchor,
  manifest: firstSet.manifest,
  timestamp: "2026-07-20T02:00:00.000Z"
});

assert.equal(replaced.bookmark.created_at, firstSet.bookmark.created_at);
assert.equal(replaced.bookmark.updated_at, "2026-07-20T02:00:00.000Z");
assert.deepEqual(replaced.bookmark.anchor, replacementAnchor);
assert.equal(Object.keys(replaced.manifest.reading_bookmarks).length, 1);

const secondSet = setDocumentReadingBookmark({
  anchor: createSelectedTextAnchor(),
  document: secondDocument,
  manifest: replaced.manifest,
  timestamp: "2026-07-20T03:00:00.000Z"
});
const firstKey = createPatchmarkDocumentIdentityKey(firstDocument);
const secondKey = createPatchmarkDocumentIdentityKey(secondDocument);

assert.notEqual(firstKey, secondKey);
assert.equal(Object.keys(secondSet.manifest.reading_bookmarks).length, 2);
assert.deepEqual(
  secondSet.manifest.reading_bookmarks[firstKey],
  replaced.bookmark
);
assert.deepEqual(
  secondSet.manifest.reading_bookmarks[secondKey],
  secondSet.bookmark
);
assert.deepEqual(
  getCurrentDocumentReadingBookmark({
    ...secondSet.manifest,
    document_file: secondDocument.document_file
  }),
  secondSet.bookmark
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
  manifest: baseManifest,
  timestamp: "2026-07-20T05:00:00.000Z"
}).bookmark;
assert.deepEqual(resolveReadingBookmark({ bookmark: missingBookmark, markdown }), {
  state: "not_found"
});

const equivalentText = "Equivalent text in both documents";
const crossDocumentManifest = setDocumentReadingBookmark({
  anchor: {
    kind: "selected_text",
    selected_text: equivalentText,
    markdown_start_offset: 0,
    markdown_end_offset: equivalentText.length,
    anchor_source: "markdown"
  },
  document: secondDocument,
  manifest: setDocumentReadingBookmark({
    anchor: {
      kind: "selected_text",
      selected_text: equivalentText,
      markdown_start_offset: 0,
      markdown_end_offset: equivalentText.length,
      anchor_source: "markdown"
    },
    document: firstDocument,
    manifest: baseManifest,
    timestamp: "2026-07-20T06:00:00.000Z"
  }).manifest,
  timestamp: "2026-07-20T06:00:00.000Z"
}).manifest;

assert.equal(Object.keys(crossDocumentManifest.reading_bookmarks).length, 2);
assert.equal(
  crossDocumentManifest.reading_bookmarks[firstKey].document.document_file,
  firstDocument.document_file
);
assert.equal(
  crossDocumentManifest.reading_bookmarks[secondKey].document.document_file,
  secondDocument.document_file
);

const removedFirst = removeDocumentReadingBookmark({
  document: firstDocument,
  manifest: secondSet.manifest
});
assert.equal(removedFirst.reading_bookmarks[firstKey], undefined);
assert.deepEqual(removedFirst.reading_bookmarks[secondKey], secondSet.bookmark);
assert.equal(getCurrentDocumentReadingBookmark(removedFirst), null);

console.log("Reading bookmark tests passed.");

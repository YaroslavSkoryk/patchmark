import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRelatedAcceptedPatchHistory,
  getContinuableLinkedComment
} from "../lib/patches/comment-patch-history.ts";

function createComment(overrides = {}) {
  return {
    id: "PM-COMMENT-0001",
    type: "question",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: "Current applied guidance.",
      markdown_start_offset: 24,
      markdown_end_offset: 49,
      anchor_source: "patch"
    },
    comment: "Should we use pilot data?",
    thread: [
      {
        id: "PM-THREAD-0001",
        role: "user",
        content: "Restore acceptable-margin validation.",
        created_at: "2026-07-13T10:00:00.000Z"
      }
    ],
    export_state: { focus_state: "in_focus" },
    created_at: "2026-07-12T09:00:00.000Z",
    updated_at: "2026-07-13T10:00:00.000Z",
    ...overrides
  };
}

function createPatch(overrides = {}) {
  return {
    id: "PM-PATCH-0001",
    status: "accepted",
    comment_id: "PM-COMMENT-0001",
    display_title: "Add pilot-data validation guidance",
    target_heading: "## Current Position",
    original_text: "Original guidance.",
    suggested_text: "Current applied guidance.",
    reason: "Clarifies pilot validation.",
    created_at: "2026-07-12T10:00:00.000Z",
    accepted_at: "2026-07-12T10:05:00.000Z",
    applied_at: "2026-07-12T10:05:00.000Z",
    applied_text: "Current applied guidance.",
    ...overrides
  };
}

const openComment = createComment();
const resolvedComment = createComment({
  status: "resolved",
  resolved_at: "2026-07-13T11:00:00.000Z"
});
const linkedPatch = createPatch();

assert.equal(
  getContinuableLinkedComment({ comments: [openComment], patch: linkedPatch }),
  openComment
);
assert.equal(
  getContinuableLinkedComment({ comments: [resolvedComment], patch: linkedPatch }),
  null
);
assert.equal(
  getContinuableLinkedComment({ comments: [], patch: linkedPatch }),
  null
);
assert.equal(
  getContinuableLinkedComment({
    comments: [openComment],
    patch: createPatch({ comment_id: undefined })
  }),
  null
);

const patches = [
  createPatch(),
  createPatch({
    id: "PM-PATCH-0002",
    status: "rejected",
    rejected_at: "2026-07-12T11:00:00.000Z"
  }),
  createPatch({
    id: "PM-PATCH-0003",
    status: "pending",
    created_at: "2026-07-12T12:00:00.000Z"
  }),
  createPatch({
    id: "PM-PATCH-0004",
    comment_id: "PM-COMMENT-9999",
    applied_at: "2026-07-12T13:00:00.000Z"
  }),
  createPatch({
    id: "PM-PATCH-0005",
    display_title: "Restore margin validation",
    applied_at: "2026-07-13T09:00:00.000Z",
    accepted_at: "2026-07-13T09:00:00.000Z",
    applied_text: "Validate margins and production complexity.",
    reason: "Restores an existing requirement."
  })
];
const history = createRelatedAcceptedPatchHistory({
  comment: openComment,
  patches
});

assert.equal(history.earlier_applied_patch_count, 0);
assert.deepEqual(
  history.patches.map((patch) => patch.patch_id),
  ["PM-PATCH-0001", "PM-PATCH-0005"]
);
assert.equal(
  history.patches[0].display_title,
  "Add pilot-data validation guidance"
);
assert.equal(
  history.patches[1].applied_text,
  "Validate margins and production complexity."
);
assert.equal(history.patches.every((patch) => patch.status === "accepted"), true);

const longHistory = createRelatedAcceptedPatchHistory({
  comment: openComment,
  limit: 2,
  patches: [
    createPatch({ id: "PM-PATCH-0001", applied_at: "2026-07-10T00:00:00.000Z" }),
    createPatch({ id: "PM-PATCH-0002", applied_at: "2026-07-11T00:00:00.000Z" }),
    createPatch({ id: "PM-PATCH-0003", applied_at: "2026-07-12T00:00:00.000Z" }),
    createPatch({ id: "PM-PATCH-0004", applied_at: "2026-07-13T00:00:00.000Z" })
  ]
});
assert.equal(longHistory.earlier_applied_patch_count, 2);
assert.deepEqual(
  longHistory.patches.map((patch) => patch.patch_id),
  ["PM-PATCH-0003", "PM-PATCH-0004"]
);

const documentEditorSource = readFileSync(
  new URL("../components/document-editor.tsx", import.meta.url),
  "utf8"
);
const commentsPanelSource = readFileSync(
  new URL("../components/comments-panel.tsx", import.meta.url),
  "utf8"
);

assert.match(documentEditorSource, /Continue discussion/);
assert.match(documentEditorSource, /The linked comment remains open/);
assert.match(documentEditorSource, /handleContinuePatchDiscussion/);
assert.match(documentEditorSource, /setSelectedPatchId\(null\)/);
assert.match(documentEditorSource, /setCommentReplyRequest/);
assert.match(documentEditorSource, /void handleFindComment\(linkedComment\)/);
assert.match(commentsPanelSource, /data-comment-reply-input/);
assert.match(commentsPanelSource, /scrollIntoView/);
assert.match(commentsPanelSource, /\.focus\(\)/);
assert.match(documentEditorSource, /related_patch_history/);
assert.match(documentEditorSource, /current Markdown as the source of truth/);
assert.match(documentEditorSource, /not a revision of an accepted patch/);
assert.match(documentEditorSource, /createNextPatchId\(existingPatches, index\)/);
assert.match(documentEditorSource, /status: "pending" as const/);
assert.match(documentEditorSource, /\.\.\.existingPatches/);
assert.match(documentEditorSource, /createLinkedPatchTransformedAnchor/);
assert.match(documentEditorSource, /selectedText: transform\.selectedText/);
assert.match(
  documentEditorSource,
  /transform\.outcome !== "active"[\s\S]*createAppliedReplacementAnchorForLinkedPatchRepair/
);
assert.match(
  documentEditorSource,
  /findMarkdownPlainTextMatches\(originalText, anchor\.selected_text\)/
);
assert.match(documentEditorSource, /projectionMethod: "source_blocks"/);
assert.match(documentEditorSource, /findVisualSourceBlockRangesForResolvedSourceRange/);
assert.doesNotMatch(documentEditorSource, /patchmark\.patch_question_export/);
assert.doesNotMatch(documentEditorSource, /patch_revision_number/);
assert.doesNotMatch(documentEditorSource, /patch discussion/i);

console.log("Patch continuation tests passed.");

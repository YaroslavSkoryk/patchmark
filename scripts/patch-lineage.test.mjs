import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  createCommentPatchHistorySummary,
  getPatchFollowUpRelationship
} from "../lib/patches/comment-patch-history.ts";
import {
  getPatchDisplayTitle,
  getPatchGroupDisplayTitle
} from "../lib/patches/patch-display-title.ts";

function createComment(overrides = {}) {
  return {
    id: "PM-COMMENT-0001",
    type: "question",
    status: "open",
    anchor: { kind: "document" },
    comment: "Restore validation requirements for launch readiness",
    thread: [],
    export_state: { focus_state: "idle" },
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

const comment = createComment();
const acceptedPatch = createPatch();
const pendingFollowUp = createPatch({
  id: "PM-PATCH-0002",
  status: "pending",
  display_title: "Restore margin-validation requirement",
  created_at: "2026-07-13T10:30:00.000Z",
  accepted_at: undefined,
  applied_at: undefined,
  applied_text: undefined
});
const independentRecords = [acceptedPatch, pendingFollowUp];
const beforeInference = structuredClone(independentRecords);

assert.deepEqual(
  getPatchFollowUpRelationship({
    comment,
    patch: pendingFollowUp,
    patches: independentRecords
  }),
  {
    applied_at: acceptedPatch.applied_at,
    display_title: acceptedPatch.display_title,
    patch_id: acceptedPatch.id
  }
);
assert.deepEqual(independentRecords, beforeInference);
assert.equal(independentRecords.length, 2);
assert.equal(independentRecords[0].status, "accepted");
assert.equal(independentRecords[1].status, "pending");

const rejectedPatch = createPatch({
  id: "PM-PATCH-0002",
  status: "rejected",
  display_title: "Try alternate margin wording",
  created_at: "2026-07-13T09:00:00.000Z",
  accepted_at: undefined,
  applied_at: undefined,
  applied_text: undefined,
  rejected_at: "2026-07-13T09:05:00.000Z"
});
const laterPendingPatch = createPatch({
  id: "PM-PATCH-0003",
  status: "pending",
  display_title: "Shorten pilot-data wording",
  created_at: "2026-07-13T11:00:00.000Z",
  accepted_at: undefined,
  applied_at: undefined,
  applied_text: undefined
});

assert.equal(
  getPatchFollowUpRelationship({
    comment,
    patch: laterPendingPatch,
    patches: [acceptedPatch, rejectedPatch, laterPendingPatch]
  })?.patch_id,
  acceptedPatch.id
);

assert.equal(
  getPatchFollowUpRelationship({
    comment: createComment({ id: "PM-COMMENT-0002" }),
    patch: createPatch({
      id: "PM-PATCH-0004",
      comment_id: "PM-COMMENT-0002",
      status: "pending",
      created_at: "2026-07-13T12:00:00.000Z"
    }),
    patches: [acceptedPatch]
  }),
  null
);
assert.equal(
  getPatchFollowUpRelationship({
    comment: null,
    patch: createPatch({ comment_id: undefined, status: "pending" }),
    patches: [acceptedPatch]
  }),
  null
);

const sharedImportAccepted = createPatch({ source_import_id: "PM-IMPORT-0001" });
const sharedImportPending = createPatch({
  id: "PM-PATCH-0002",
  status: "pending",
  source_import_id: "PM-IMPORT-0001",
  created_at: "2026-07-13T12:00:00.000Z"
});
assert.equal(
  getPatchFollowUpRelationship({
    comment,
    patch: sharedImportPending,
    patches: [sharedImportAccepted, sharedImportPending]
  }),
  null
);

const sharedGroupAccepted = createPatch({ patch_group_id: "PM-PATCH-GROUP-0001" });
const sharedGroupPending = createPatch({
  id: "PM-PATCH-0002",
  status: "pending",
  patch_group_id: "PM-PATCH-GROUP-0001",
  created_at: "2026-07-13T12:00:00.000Z"
});
assert.equal(
  getPatchFollowUpRelationship({
    comment,
    patch: sharedGroupPending,
    patches: [sharedGroupAccepted, sharedGroupPending]
  }),
  null
);

const tiedAcceptedPatches = [
  createPatch({ id: "PM-PATCH-0001" }),
  createPatch({ id: "PM-PATCH-0002", display_title: "Clarify launch scope" })
];
assert.equal(
  getPatchFollowUpRelationship({
    comment,
    patch: laterPendingPatch,
    patches: [...tiedAcceptedPatches, laterPendingPatch]
  }),
  null
);

const acceptedFollowUp = {
  ...pendingFollowUp,
  status: "accepted",
  accepted_at: "2026-07-13T10:35:00.000Z",
  applied_at: "2026-07-13T10:35:00.000Z"
};
assert.equal(
  getPatchFollowUpRelationship({
    comment,
    patch: acceptedFollowUp,
    patches: [acceptedPatch, acceptedFollowUp]
  })?.display_title,
  "Add pilot-data validation guidance"
);

const summary = createCommentPatchHistorySummary({
  comment,
  patches: [
    acceptedPatch,
    acceptedFollowUp,
    rejectedPatch,
    laterPendingPatch,
    createPatch({ id: "PM-PATCH-9999", comment_id: "PM-COMMENT-9999" })
  ]
});
assert.deepEqual(summary, {
  accepted: 2,
  latestAcceptedTitle: "Restore margin-validation requirement",
  patchCount: 4,
  pending: 1,
  rejected: 1,
  stale: 0
});

const parsed = parsePatchmarkCommentReplyImport(
  JSON.stringify({
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Imported follow-up.",
    replies: [],
    patch_proposals: [
      {
        comment_id: comment.id,
        title: "Restore margin-validation requirement",
        original_text: "Current applied guidance.",
        suggested_text: "Current applied guidance with margins.",
        reason: "Restores the validation requirement."
      }
    ],
    open_questions: []
  })
);
assert.equal(
  parsed.patch_proposals[0].display_title,
  "Restore margin-validation requirement"
);

const legacyPatch = createPatch({
  display_title: undefined,
  reason: "",
  target_heading: "## Current Position"
});
const firstLegacyTitle = getPatchDisplayTitle(legacyPatch);
const reloadedLegacyTitle = getPatchDisplayTitle(
  JSON.parse(JSON.stringify(legacyPatch))
);
assert.equal(firstLegacyTitle, "Update Current Position");
assert.equal(reloadedLegacyTitle, firstLegacyTitle);
assert.equal(
  getPatchGroupDisplayTitle([pendingFollowUp], comment),
  "Restore margin-validation requirement"
);

const documentEditorSource = readFileSync(
  new URL("../components/document-editor.tsx", import.meta.url),
  "utf8"
);
const commentsPanelSource = readFileSync(
  new URL("../components/comments-panel.tsx", import.meta.url),
  "utf8"
);

assert.match(documentEditorSource, /display_title: displayTitle/);
assert.match(documentEditorSource, /Refines/);
assert.match(documentEditorSource, /Follow-up to/);
assert.match(documentEditorSource, /Earlier patch ID/);
assert.match(documentEditorSource, /<summary>Details<\/summary>/);
assert.match(documentEditorSource, /Title the new change itself/);
assert.match(documentEditorSource, /Update previous patch/);
assert.match(commentsPanelSource, /Latest change applied/);
assert.match(commentsPanelSource, /Review related patches/);
assert.match(commentsPanelSource, /View related patches/);
assert.doesNotMatch(documentEditorSource, /follows_patch_id/);

console.log("Patch lineage tests passed.");

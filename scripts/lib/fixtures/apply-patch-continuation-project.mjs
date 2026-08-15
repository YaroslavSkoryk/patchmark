import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  COMMENT_RAIL_FIXTURE,
  applyCommentRailProject
} from "./apply-comment-rail-project.mjs";
import {
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2020-05-01T10:00:00.000Z";

export const PATCH_CONTINUATION_FIXTURE = Object.freeze({
  basePatchId: "PM-PATCH-RAIL-LINKED",
  differentCommentId: "PM-COMMENT-CONTINUATION-OTHER",
  differentCommentPatchId: "PM-PATCH-8103",
  differentCommentPatchTitle: "Browser different-comment test patch",
  documentId: "doc_fixture_atlas",
  followUpDisplayTitle: "Restore validation requirements",
  followUpPatchId: "PM-PATCH-8105",
  followUpReply:
    "Keep this guidance, but restore acceptable-margin and production-complexity validation.",
  followUpRefinement:
    "Validate acceptable margins and production complexity.",
  linkedCommentId: COMMENT_RAIL_FIXTURE.linkedCommentId,
  linkedImportId: "PM-IMPORT-CONTINUATION-SEED",
  linkedPatchId: "PM-PATCH-8101",
  linkedPatchTitle: "Browser continuation test patch",
  noLinkedPatchId: "PM-PATCH-8102",
  noLinkedPatchTitle: "Add browser legacy guidance",
  projectId: "prj_fixture_atlas",
  unrelatedDocumentFileName: "unrelated-continuation.md",
  unrelatedDocumentSentinel: "UNRELATED CONTINUATION DOCUMENT SENTINEL",
  unrelatedPatchId: "PM-PATCH-8104",
  unrelatedPatchSentinel: "UNRELATED CONTINUATION PATCH SENTINEL"
});

export function applyPatchContinuationProject(projectRoot) {
  const baseContract = applyCommentRailProject(projectRoot);
  const root = realpathSync(projectRoot);
  const commentsPath = join(root, ".patchmark", "comments.json");
  const patchesPath = join(root, ".patchmark", "patches.json");
  const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
  const patches = JSON.parse(readFileSync(patchesPath, "utf8"));
  const linkedComment = comments.find(
    (comment) => comment.id === PATCH_CONTINUATION_FIXTURE.linkedCommentId
  );
  const basePatch = patches.find(
    (patch) => patch.id === PATCH_CONTINUATION_FIXTURE.basePatchId
  );

  if (
    !linkedComment ||
    linkedComment.status !== "open" ||
    linkedComment.anchor.kind !== "selected_text" ||
    !basePatch ||
    basePatch.status !== "accepted"
  ) {
    throw new Error("Patch continuation requires the deterministic Comment rail base state.");
  }

  const linkedOriginalText = linkedComment.anchor.selected_text;
  const noLinkedOriginalText =
    "Synthetic observation 01 records an imaginary lantern, a clockwork seed, and a quiet orbital marker for deterministic layout review.";
  const differentCommentOriginalText =
    "Synthetic observation 03 records an imaginary lantern, a clockwork seed, and a quiet orbital marker for deterministic layout review.";
  assertUniqueText(baseContract.markdown, linkedOriginalText);
  assertUniqueText(baseContract.markdown, noLinkedOriginalText);
  assertUniqueText(baseContract.markdown, differentCommentOriginalText);

  const linkedSuggestedText = appendRefinement(
    linkedOriginalText,
    "Browser continuation refinement."
  );
  const followUpSuggestedText = appendRefinement(
    linkedSuggestedText,
    PATCH_CONTINUATION_FIXTURE.followUpRefinement
  );
  const noLinkedSuggestedText = appendRefinement(
    noLinkedOriginalText,
    "Browser no-link refinement."
  );
  const differentCommentSuggestedText = appendRefinement(
    differentCommentOriginalText,
    "Browser different-comment refinement."
  );
  const linkedPatch = {
    id: PATCH_CONTINUATION_FIXTURE.linkedPatchId,
    status: "pending",
    comment_id: linkedComment.id,
    display_title: PATCH_CONTINUATION_FIXTURE.linkedPatchTitle,
    target_heading: "## Synthetic Relay 02",
    original_text: linkedOriginalText,
    suggested_text: linkedSuggestedText,
    reason: "Validates continued refinement through the linked comment.",
    depends_on_patch_ids: [basePatch.id],
    depends_on_patch_keys_snapshot: ["accepted-base"],
    source_import_id: PATCH_CONTINUATION_FIXTURE.linkedImportId,
    source_patch_key: "linked-continuation",
    created_at: "2020-05-01T10:01:00.000Z"
  };
  const noLinkedPatch = {
    id: PATCH_CONTINUATION_FIXTURE.noLinkedPatchId,
    status: "pending",
    display_title: PATCH_CONTINUATION_FIXTURE.noLinkedPatchTitle,
    original_text: noLinkedOriginalText,
    suggested_text: noLinkedSuggestedText,
    reason: "Add browser legacy guidance.",
    created_at: "2020-05-01T10:02:00.000Z"
  };
  const differentComment = {
    id: PATCH_CONTINUATION_FIXTURE.differentCommentId,
    type: "note",
    status: "resolved",
    anchor: { kind: "document" },
    comment: "Check unrelated browser validation guidance.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2020-05-01T10:03:00.000Z",
    updated_at: "2020-05-01T10:03:00.000Z",
    resolved_at: "2020-05-01T10:03:00.000Z"
  };
  const differentCommentPatch = {
    id: PATCH_CONTINUATION_FIXTURE.differentCommentPatchId,
    status: "pending",
    comment_id: differentComment.id,
    display_title: PATCH_CONTINUATION_FIXTURE.differentCommentPatchTitle,
    original_text: differentCommentOriginalText,
    suggested_text: differentCommentSuggestedText,
    reason: "Validates that unrelated comments do not create false lineage.",
    created_at: "2020-05-01T10:04:00.000Z"
  };
  const unrelatedPatch = {
    id: PATCH_CONTINUATION_FIXTURE.unrelatedPatchId,
    status: "rejected",
    comment_id: COMMENT_RAIL_FIXTURE.lineCommentId,
    display_title: "Keep the unrelated amber note rejected",
    original_text: "An unrelated amber note remains outside continuation state.",
    suggested_text: PATCH_CONTINUATION_FIXTURE.unrelatedPatchSentinel,
    reason: "Proves unrelated patch records remain byte-for-byte logical equals.",
    created_at: "2020-05-01T10:05:00.000Z",
    rejected_at: "2020-05-01T10:06:00.000Z"
  };
  const normalizedComments = comments.map((comment) => ({
    ...comment,
    export_state: {
      ...comment.export_state,
      focus_state: "idle",
      marked_for_export_at: undefined
    }
  }));
  const normalizedPatches = patches.map((patch) =>
    patch.id === basePatch.id
      ? {
          ...patch,
          display_title: "Establish the stable violet ledger",
          source_import_id: PATCH_CONTINUATION_FIXTURE.linkedImportId,
          source_patch_key: "accepted-base",
          created_at: fixedTimestamp,
          accepted_at: "2020-05-01T10:00:30.000Z",
          applied_at: "2020-05-01T10:00:30.000Z"
        }
      : patch
  );
  const unrelatedMarkdown = [
    "# Synthetic Unrelated Continuation Document",
    "",
    PATCH_CONTINUATION_FIXTURE.unrelatedDocumentSentinel,
    "",
    "This unregistered document must remain isolated from the active continuation."
  ].join("\n");
  const afterLinkedMarkdown = replaceOnce(
    baseContract.markdown,
    linkedOriginalText,
    linkedSuggestedText
  );
  const afterFollowUpMarkdown = replaceOnce(
    afterLinkedMarkdown,
    linkedSuggestedText,
    followUpSuggestedText
  );
  const finalMarkdown = replaceOnce(
    replaceOnce(
      afterFollowUpMarkdown,
      noLinkedOriginalText,
      noLinkedSuggestedText
    ),
    differentCommentOriginalText,
    differentCommentSuggestedText
  );

  writeProjectFixtureText(
    root,
    PATCH_CONTINUATION_FIXTURE.unrelatedDocumentFileName,
    unrelatedMarkdown
  );
  writeProjectFixtureJson(root, ".patchmark/comments.json", [
    ...normalizedComments,
    differentComment
  ]);
  writeProjectFixtureJson(root, ".patchmark/patches.json", [
    ...normalizedPatches,
    linkedPatch,
    noLinkedPatch,
    differentCommentPatch,
    unrelatedPatch
  ]);

  return {
    ...PATCH_CONTINUATION_FIXTURE,
    afterFollowUpMarkdown,
    afterLinkedMarkdown,
    basePatch: normalizedPatches.find((patch) => patch.id === basePatch.id),
    comment: linkedComment,
    differentComment,
    differentCommentPatch,
    finalMarkdown,
    followUpSuggestedText,
    initialMarkdown: baseContract.markdown,
    linkedComment,
    linkedPatch,
    noLinkedPatch,
    unrelatedDocumentMarkdown: unrelatedMarkdown,
    unrelatedPatch
  };
}

function assertUniqueText(markdown, text) {
  if (countOccurrences(markdown, text) !== 1) {
    throw new Error("Patch continuation fixture text must occur exactly once.");
  }
}

function countOccurrences(text, search) {
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

function replaceOnce(markdown, originalText, suggestedText) {
  assertUniqueText(markdown, originalText);
  return markdown.replace(originalText, suggestedText);
}

function appendRefinement(text, refinement) {
  return `${text.trimEnd()} ${refinement}`;
}

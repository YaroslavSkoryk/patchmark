import assert from "node:assert/strict";
import {
  createAppliedPatchReviewContent,
  createPatchReviewSnippetPreview,
  recoverOriginalTextFromPreApplySnapshot
} from "../lib/patches/patch-review-content.ts";

function createPatch(overrides = {}) {
  return {
    id: "PM-PATCH-0001",
    status: "accepted",
    comment_id: "PM-COMMENT-0001",
    original_text: "Original paragraph.",
    suggested_text: "Applied paragraph.",
    reason: "Improve clarity.",
    created_at: "2026-07-12T00:00:00.000Z",
    accepted_at: "2026-07-12T00:01:00.000Z",
    applied_at: "2026-07-12T00:01:00.000Z",
    applied_text: "Applied paragraph.",
    ...overrides
  };
}

{
  const patch = createPatch();
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: "Applied paragraph."
    },
    patch,
    preApplySnapshotMarkdown: null
  });

  assert.equal(content.originalMarkdown, "Original paragraph.");
  assert.equal(content.appliedMarkdown, "Applied paragraph.");
  assert.equal(content.currentMarkdown, undefined);
  assert.equal(content.currentState, "unchanged");
  assert.match(content.statusMessage, /still present/);
}

{
  const originalRow = "| Product | Original catalogue | Validate repeat demand |";
  const appliedRow =
    "| Product | Original, Baguette, and Campaillou | Validate repeat demand |";
  const tableMarkdown = [
    "| Area | Current direction | Main gap to close |",
    "| --- | --- | --- |",
    appliedRow
  ].join("\n");
  const snapshotMarkdown = tableMarkdown.replace(appliedRow, originalRow);
  const patch = createPatch({
    original_text: originalRow,
    suggested_text: appliedRow,
    applied_text: appliedRow,
    target_heading: "Products"
  });
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: appliedRow
    },
    patch,
    preApplySnapshotMarkdown: snapshotMarkdown
  });
  const originalPreview = createPatchReviewSnippetPreview({
    contextMarkdown: snapshotMarkdown,
    pairedMarkdown: content.appliedMarkdown,
    patch,
    snippetMarkdown: content.originalMarkdown
  });
  const appliedPreview = createPatchReviewSnippetPreview({
    contextMarkdown: tableMarkdown,
    pairedMarkdown: content.originalMarkdown,
    patch,
    snippetMarkdown: content.appliedMarkdown
  });

  assert.equal(
    originalPreview.markdown,
    [
      "| Area | Current direction | Main gap to close |",
      "| --- | --- | --- |",
      originalRow
    ].join("\n")
  );
  assert.equal(
    appliedPreview.markdown,
    [
      "| Area | Current direction | Main gap to close |",
      "| --- | --- | --- |",
      appliedRow
    ].join("\n")
  );
  assert.equal(content.originalMarkdown, originalRow);
  assert.equal(content.appliedMarkdown, appliedRow);
}

{
  const patch = createPatch();
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "evolved_after_patch",
      text: "Current evolved paragraph."
    },
    patch,
    preApplySnapshotMarkdown: null
  });

  assert.equal(content.originalMarkdown, "Original paragraph.");
  assert.equal(content.appliedMarkdown, "Applied paragraph.");
  assert.equal(content.currentMarkdown, "Current evolved paragraph.");
  assert.equal(content.currentState, "evolved");
  assert.match(content.statusMessage, /changed again later/);
}

{
  const patch = createPatch();
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "not_found",
      text: "Applied paragraph."
    },
    patch,
    preApplySnapshotMarkdown: null
  });

  assert.equal(content.originalMarkdown, "Original paragraph.");
  assert.equal(content.appliedMarkdown, "Applied paragraph.");
  assert.equal(content.currentMarkdown, undefined);
  assert.equal(content.currentState, "not_found");
  assert.match(content.statusMessage, /cannot currently locate/);
}

{
  const reloadedPatch = JSON.parse(JSON.stringify(createPatch()));
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: reloadedPatch.applied_text
    },
    patch: reloadedPatch,
    preApplySnapshotMarkdown: null
  });

  assert.equal(content.originalMarkdown, "Original paragraph.");
  assert.equal(content.appliedMarkdown, "Applied paragraph.");
}

{
  const beforeContext = "Before stable context. ";
  const afterContext = " After stable context.";
  const originalText = "Legacy original paragraph.";
  const patch = createPatch({
    applied_context_after: afterContext,
    applied_context_before: beforeContext,
    applied_text: "Legacy applied paragraph.",
    original_text: "",
    suggested_text: "Legacy applied paragraph."
  });
  const snapshotMarkdown = `${beforeContext}${originalText}${afterContext}`;
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: "Legacy applied paragraph."
    },
    patch,
    preApplySnapshotMarkdown: snapshotMarkdown
  });

  assert.equal(
    recoverOriginalTextFromPreApplySnapshot({
      patch,
      snapshotMarkdown
    }),
    originalText
  );
  assert.equal(content.originalMarkdown, originalText);
  assert.equal(content.originalSource, "pre_apply_snapshot");
}

{
  const patch = createPatch({
    applied_text: "Legacy applied paragraph.",
    original_text: "",
    suggested_text: "Legacy applied paragraph."
  });
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "not_found",
      text: "Legacy applied paragraph."
    },
    patch,
    preApplySnapshotMarkdown: null
  });

  assert.equal(
    content.originalMarkdown,
    "Original text unavailable for this historical patch."
  );
  assert.equal(content.originalSource, "unavailable");
  assert.notEqual(content.originalMarkdown, content.appliedMarkdown);
}

console.log("Patch review content tests passed.");

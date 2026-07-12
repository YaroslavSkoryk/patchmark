import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAppliedPatchReviewContent,
  createPatchReviewSnippetPreview,
  dedupePatchReviewTextMatches,
  getPatchReviewMatchCardinality,
  getPatchReviewMatchingLocationsLabel,
  getPatchReviewMatchMethodLabel,
  isMalformedMarkdownTableFragment,
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
  const exactMatches = [{ start: 10, end: 25 }];

  assert.equal(getPatchReviewMatchMethodLabel("exact"), "Exact");
  assert.equal(getPatchReviewMatchCardinality(exactMatches), "unique");
  assert.equal(
    getPatchReviewMatchingLocationsLabel({
      cardinality: "unique",
      count: exactMatches.length
    }),
    "1"
  );
}

{
  const exactMatches = [
    { start: 10, end: 25 },
    { start: 80, end: 95 }
  ];

  assert.equal(getPatchReviewMatchMethodLabel("exact"), "Exact");
  assert.equal(getPatchReviewMatchCardinality(exactMatches), "multiple");
  assert.equal(
    getPatchReviewMatchingLocationsLabel({
      cardinality: "multiple",
      count: exactMatches.length
    }),
    "2"
  );
}

{
  const exactMatch = { start: 12, end: 54 };
  const tableStructuralMatch = { start: 12, end: 54 };
  const distinctMatches = dedupePatchReviewTextMatches([
    exactMatch,
    tableStructuralMatch
  ]);

  assert.deepEqual(distinctMatches, [exactMatch]);
  assert.equal(getPatchReviewMatchCardinality(distinctMatches), "unique");
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
  const originalRow = "| Existing signal | Existing implication | Existing validation |";
  const appliedRows = [
    "| Existing signal | Existing implication | Existing validation |",
    "| [Sourdough demand signal](https://example.com/sourdough) | Supports category focus | Validate local repeat purchase |",
    "| Bakery growth signal | Supports launch test | Validate price acceptance |"
  ].join("\n");
  const contextMarkdown = [
    "## 3. Market View",
    "",
    "| Market signal | What it suggests | What still must be validated |",
    "| --- | --- | --- |",
    appliedRows
  ].join("\n");
  const patch = createPatch({
    original_text: originalRow,
    suggested_text: appliedRows,
    applied_text: appliedRows,
    target_heading: "3. Market View"
  });
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: appliedRows
    },
    patch,
    preApplySnapshotMarkdown: null
  });
  const appliedPreview = createPatchReviewSnippetPreview({
    contextMarkdown,
    pairedMarkdown: originalRow,
    patch,
    snippetMarkdown: content.appliedMarkdown
  });

  assert.equal(content.appliedMarkdown, appliedRows);
  assert.equal(appliedPreview.isMalformedTableFragment, false);
  assert.equal(appliedPreview.usesTableContext, true);
  assert.equal(appliedPreview.usesGenericTableContext, false);
  assert.equal(
    appliedPreview.markdown,
    [
      "| Market signal | What it suggests | What still must be validated |",
      "| --- | --- | --- |",
      appliedRows
    ].join("\n")
  );
  assert.match(appliedPreview.markdown, /\[Sourdough demand signal\]\(https:\/\/example\.com\/sourdough\)/);
}

{
  const malformedRows = "| First | Row || Second | Row |";
  const patch = createPatch({
    original_text: "| First | Row |",
    suggested_text: malformedRows,
    applied_text: malformedRows,
    target_heading: "3. Market View"
  });
  const preview = createPatchReviewSnippetPreview({
    contextMarkdown: [
      "| Column 1 | Column 2 |",
      "| --- | --- |",
      "| First | Row |"
    ].join("\n"),
    pairedMarkdown: patch.original_text,
    patch,
    snippetMarkdown: patch.applied_text
  });

  assert.equal(isMalformedMarkdownTableFragment(malformedRows), true);
  assert.equal(preview.isMalformedTableFragment, true);
  assert.equal(preview.usesTableContext, false);
  assert.equal(preview.markdown, malformedRows);
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
  const appliedRows = [
    "| Existing signal | Existing implication | Existing validation |",
    "| Sourdough demand signal | Supports category focus | Validate local repeat purchase |",
    "| Bakery growth signal | Supports launch test | Validate price acceptance |"
  ].join("\n");
  const reloadedPatch = JSON.parse(
    JSON.stringify(
      createPatch({
        original_text:
          "| Existing signal | Existing implication | Existing validation |",
        suggested_text: appliedRows,
        applied_text: appliedRows,
        target_heading: "3. Market View"
      })
    )
  );
  const contextMarkdown = [
    "| Market signal | What it suggests | What still must be validated |",
    "| --- | --- | --- |",
    appliedRows
  ].join("\n");
  const content = createAppliedPatchReviewContent({
    anchorStatus: {
      status: "exact_match",
      text: reloadedPatch.applied_text
    },
    patch: reloadedPatch,
    preApplySnapshotMarkdown: null
  });
  const preview = createPatchReviewSnippetPreview({
    contextMarkdown,
    pairedMarkdown: reloadedPatch.original_text,
    patch: reloadedPatch,
    snippetMarkdown: content.appliedMarkdown
  });

  assert.equal(content.appliedMarkdown, appliedRows);
  assert.equal(preview.usesTableContext, true);
  assert.equal(preview.isMalformedTableFragment, false);
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

{
  const css = readFileSync("app/globals.css", "utf8");

  assert.match(
    css,
    /\.patch-review-preview-grid > \.patch-review-card,\s*\.markdown-snippet-preview\s*{\s*align-content: start;/s
  );
}

console.log("Patch review content tests passed.");

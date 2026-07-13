import assert from "node:assert/strict";
import { resolvePendingPatchTarget } from "../lib/patches/linked-patch-target-resolution.ts";

const createdAt = "2026-07-13T00:00:00.000Z";

function createPatch(overrides = {}) {
  return {
    id: "PM-PATCH-TEST",
    status: "pending",
    comment_id: "PM-COMMENT-TEST",
    original_text: "LINE add",
    suggested_text: "new LINE Official Account friend",
    reason: "Clarify the metric.",
    created_at: createdAt,
    ...overrides
  };
}

function createComment({ markdown, selectedText = "LINE add", start, end, ...overrides }) {
  return {
    id: "PM-COMMENT-TEST",
    type: "question",
    status: "open",
    comment: "What is this?",
    export_state: "unmarked",
    thread: [],
    created_at: createdAt,
    updated_at: createdAt,
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: end,
      anchor_context: {
        kind: "paragraph",
        plain_text: markdown.slice(start, end),
        markdown_text: markdown.slice(start, end),
        selected_start_in_context: 0,
        selected_end_in_context: end - start,
        markdown_start_offset: start,
        markdown_end_offset: end
      },
      containing_heading: "7. Demand Generation Plan",
      containing_heading_level: 2,
      anchor_source: "visual",
      ...overrides.anchor
    },
    ...overrides.comment
  };
}

function lineAddDocument() {
  return [
    "# Plan",
    "",
    "## 7. Demand Generation Plan",
    "",
    "| **Channel** | **Next step to measure** |",
    "| --- | --- |",
    "| Product content | LINE add, website visit, paid order. |",
    "| Social | profile visit, paid order. |",
    "",
    "## 8. Demand Validation Approach",
    "",
    "| **Signal** | **Metric** |",
    "| --- | --- |",
    "| Intent | LINE add, price questions, delivery questions. |"
  ].join("\n");
}

{
  const markdown = lineAddDocument();
  const start = markdown.indexOf("LINE add");
  const end = start + "LINE add".length;
  const comment = createComment({ markdown, start, end });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch({ target_heading: "## 7. Demand Generation Plan" })
  });

  assert.equal(resolution.applicability, "exact_match");
  assert.equal(resolution.method, "linked_comment_anchor");
  assert.deepEqual(resolution.matches, [{ start, end }]);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "LINE add now. LINE add later."
  ].join("\n");
  const start = markdown.lastIndexOf("LINE add");
  const end = start + "LINE add".length;
  const comment = createComment({ markdown, start, end });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch({ target_heading: "## 7. Demand Generation Plan" })
  });

  assert.equal(resolution.applicability, "exact_match");
  assert.equal(resolution.method, "linked_comment_anchor");
  assert.deepEqual(resolution.matches, [{ start, end }]);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "| **Channel** | **Next step** |",
    "| --- | --- |",
    "| Product | LINE add, paid order. |",
    "| Social | LINE add, paid order. |"
  ].join("\n");
  const start = markdown.lastIndexOf("LINE add");
  const end = start + "LINE add".length;
  const comment = createComment({ markdown, start, end });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch({ target_heading: "## 7. Demand Generation Plan" })
  });

  assert.equal(resolution.applicability, "exact_match");
  assert.equal(resolution.method, "linked_comment_anchor");
  assert.deepEqual(resolution.matches, [{ start, end }]);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "| **Channel** | **Next step** |",
    "| --- | --- |",
    "| Product | LINE add, website visit, paid order. |",
    "",
    "## 8. Demand Validation Approach",
    "",
    "LINE add appears elsewhere."
  ].join("\n");
  const selectedStart = markdown.indexOf("LINE add");
  const selectedEnd = selectedStart + "LINE add".length;
  const originalText = "LINE add, website visit, paid order.";
  const expectedStart = markdown.indexOf(originalText);
  const comment = createComment({
    markdown,
    start: selectedStart,
    end: selectedEnd
  });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch({
      original_text: originalText,
      suggested_text: "new LINE Official Account friend, website visit, paid order.",
      target_heading: "## 7. Demand Generation Plan"
    })
  });

  assert.equal(resolution.applicability, "exact_match");
  assert.equal(resolution.method, "linked_comment_structure");
  assert.deepEqual(resolution.matches, [
    { start: expectedStart, end: expectedStart + originalText.length }
  ]);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "LINE add now. LINE add later.",
    "",
    "## 8. Demand Validation Approach",
    "",
    "LINE add elsewhere."
  ].join("\n");
  const comment = createComment({
    markdown,
    start: 0,
    end: "LINE add".length,
    anchor: {
      markdown_start_offset: 0,
      markdown_end_offset: "LINE add".length,
      anchor_context: undefined
    }
  });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch()
  });

  assert.equal(resolution.applicability, "multiple_matches");
  assert.ok(resolution.matches.length > 1);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "LINE add now. LINE add later."
  ].join("\n");
  const resolution = resolvePendingPatchTarget({
    comments: [],
    markdown,
    patch: createPatch({ comment_id: undefined })
  });

  assert.equal(resolution.applicability, "multiple_matches");
  assert.equal(resolution.matches.length, 2);
}

{
  const markdown = [
    "## 7. Demand Generation Plan",
    "",
    "LINE add now."
  ].join("\n");
  const start = markdown.indexOf("LINE add");
  const end = start + "LINE add".length;
  const comment = createComment({
    markdown,
    start,
    end,
    anchor: {
      anchor_context: {
        kind: "paragraph",
        plain_text: "LINE add",
        markdown_text: "LINE add",
        selected_start_in_context: 0,
        selected_end_in_context: "LINE add".length,
        markdown_start_offset: start,
        markdown_end_offset: end
      }
    }
  });
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    markdown,
    patch: createPatch({ target_heading: "## 7. Demand Generation Plan" })
  });

  assert.equal(resolution.applicability, "exact_match");
  assert.equal(resolution.matches.length, 1);
  assert.deepEqual(resolution.matches[0], { start, end });
}

console.log("Linked patch target resolution tests passed.");

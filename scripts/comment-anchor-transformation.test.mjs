import assert from "node:assert/strict";
import {
  deriveContiguousMarkdownEdit,
  isSafeManualAnchorTransformEdit,
  transformSelectedTextAnchorThroughEdit
} from "../lib/comments/comment-anchor-transformation.ts";

function createAnchor(markdown, selectedText, occurrence = 0) {
  let start = -1;
  let searchFrom = 0;

  for (let index = 0; index <= occurrence; index += 1) {
    start = markdown.indexOf(selectedText, searchFrom);

    if (start === -1) {
      throw new Error(`Could not find ${selectedText}`);
    }

    searchFrom = start + selectedText.length;
  }

  return {
    kind: "selected_text",
    selected_text: selectedText,
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    anchor_context: {
      kind: "paragraph",
      plain_text: selectedText,
      markdown_text: selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: selectedText.length,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length
    }
  };
}

function transform(oldMarkdown, newMarkdown, selectedText, occurrence = 0) {
  const edit = deriveContiguousMarkdownEdit(oldMarkdown, newMarkdown);
  assert.ok(edit);

  return transformSelectedTextAnchorThroughEdit({
    anchor: createAnchor(oldMarkdown, selectedText, occurrence),
    edit,
    newMarkdown,
    oldMarkdown
  });
}

{
  const oldMarkdown = "A LINE add item.\nLater LINE add duplicate.";
  const newMarkdown = oldMarkdown.replace("LINE add item", "LINE account add item");
  const result = transform(oldMarkdown, newMarkdown, "LINE add");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "LINE account add");
  assert.equal(newMarkdown.slice(result.start, result.end), "LINE account add");
  assert.notEqual(result.start, newMarkdown.lastIndexOf("LINE add"));
}

{
  const oldMarkdown = "The regular customer buys weekly.";
  const newMarkdown = oldMarkdown.replace(
    "regular customer",
    "regular household customer"
  );
  const result = transform(oldMarkdown, newMarkdown, "regular customer");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "regular household customer");
  assert.equal(result.transformation, "edit_inside_anchor");
}

{
  const oldMarkdown = "We need acceptable margins soon.";
  const newMarkdown = oldMarkdown.replace("acceptable margins", "margins");
  const result = transform(oldMarkdown, newMarkdown, "acceptable margins");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "margins");
  assert.equal(result.transformation, "overlap_anchor_start");
}

{
  const oldMarkdown = "Before target text after.";
  const newMarkdown = "Inserted. Before target text after.";
  const result = transform(oldMarkdown, newMarkdown, "target text");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "target text");
  assert.equal(result.start, newMarkdown.indexOf("target text"));
  assert.equal(result.transformation, "after_edit_shifted");
}

{
  const oldMarkdown = "Before target text after.";
  const newMarkdown = "Before target text after. Inserted.";
  const result = transform(oldMarkdown, newMarkdown, "target text");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "target text");
  assert.equal(result.start, oldMarkdown.indexOf("target text"));
  assert.equal(result.transformation, "before_edit_unchanged");
}

{
  const oldMarkdown = "Alpha target Omega.";
  const anchorStart = oldMarkdown.indexOf("target");
  const newMarkdown = `${oldMarkdown.slice(0, anchorStart)}NEW ${oldMarkdown.slice(anchorStart)}`;
  const result = transform(oldMarkdown, newMarkdown, "target");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "target");
  assert.equal(result.start, newMarkdown.indexOf("target"));
}

{
  const oldMarkdown = "Alpha target Omega.";
  const anchorEnd = oldMarkdown.indexOf("target") + "target".length;
  const newMarkdown = `${oldMarkdown.slice(0, anchorEnd)} NEW${oldMarkdown.slice(anchorEnd)}`;
  const result = transform(oldMarkdown, newMarkdown, "target");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "target");
  assert.equal(result.end, newMarkdown.indexOf("target") + "target".length);
}

{
  const oldMarkdown = "First duplicate. Remove me. Second duplicate.";
  const newMarkdown = oldMarkdown.replace("Remove me", "");
  const result = transform(oldMarkdown, newMarkdown, "Remove me");

  assert.equal(result.outcome, "inactive");
}

{
  const oldMarkdown = "abc target def";
  const newMarkdown = "abc TAR def";
  const result = transform(oldMarkdown, newMarkdown, "target");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "TAR");
}

{
  const oldMarkdown = "abc target def";
  const newMarkdown = "abc target-ish def";
  const result = transform(oldMarkdown, newMarkdown, "target");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "target");
}

{
  const oldMarkdown = "Metric: LINE add";
  const newMarkdown = "Metric: **LINE add**";
  const result = transform(oldMarkdown, newMarkdown, "LINE add");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "**LINE add**");
}

{
  const oldMarkdown = "Market: PAUL Thailand";
  const newMarkdown = "Market: [PAUL Thailand](https://example.com)";
  const result = transform(oldMarkdown, newMarkdown, "PAUL Thailand");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "[PAUL Thailand](https://example.com)");
}

{
  const oldMarkdown = [
    "| Product | Metric |",
    "| --- | --- |",
    "| Core | LINE add |"
  ].join("\n");
  const newMarkdown = [
    "| Product | Metric |",
    "| --- | --- |",
    "| New | preorder |",
    "| Core | LINE add |"
  ].join("\n");
  const result = transform(oldMarkdown, newMarkdown, "LINE add");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "LINE add");
  assert.equal(result.start, newMarkdown.indexOf("LINE add"));
}

{
  const oldMarkdown = "Cash metric: runway until next order window.";
  const patchOriginalText = "runway until next order window";
  const patchSuggestedText = "remaining operating cash before the next order window";
  const oldStart = oldMarkdown.indexOf(patchOriginalText);
  const newMarkdown = oldMarkdown.replace(patchOriginalText, patchSuggestedText);
  const anchor = createAnchor(oldMarkdown, "runway");
  const result = transformSelectedTextAnchorThroughEdit({
    anchor,
    edit: {
      oldStart,
      oldEnd: oldStart + patchOriginalText.length,
      insertedText: patchSuggestedText
    },
    newMarkdown,
    oldMarkdown
  });

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, patchSuggestedText);
  assert.equal(result.transformation, "edit_contains_anchor");
}

{
  const oldMarkdown = Array.from({ length: 120 }, (_, index) => `Line ${index}`).join(
    "\n"
  );
  const newMarkdown = "Small replacement";
  const edit = deriveContiguousMarkdownEdit(oldMarkdown, newMarkdown);
  assert.ok(edit);

  const safety = isSafeManualAnchorTransformEdit({
    affectedAnchorCount: 2,
    edit,
    oldMarkdown
  });

  assert.equal(safety.safe, false);
}

console.log("Comment anchor transformation tests passed.");

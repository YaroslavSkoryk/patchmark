import assert from "node:assert/strict";
import {
  applyMarkdownEdits,
  classifyRangeAgainstEdit,
  deriveContiguousMarkdownEdit,
  deriveMarkdownChangeSet,
  isSafeManualAnchorTransformChangeSet,
  isSafeManualAnchorTransformEdit,
  transformSelectedTextAnchorThroughChangeSet,
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

function transformWithEdit(oldMarkdown, edit, selectedText, occurrence = 0) {
  const newMarkdown = `${oldMarkdown.slice(0, edit.oldStart)}${edit.insertedText}${oldMarkdown.slice(edit.oldEnd)}`;

  return transformSelectedTextAnchorThroughEdit({
    anchor: createAnchor(oldMarkdown, selectedText, occurrence),
    edit,
    newMarkdown,
    oldMarkdown
  });
}

function transformWithChangeSet(oldMarkdown, newMarkdown, selectedText, occurrence = 0) {
  const changeSet = deriveMarkdownChangeSet({
    newMarkdown,
    oldMarkdown,
    source: "manual_source"
  });
  assert.ok(changeSet);
  assert.equal(applyMarkdownEdits(oldMarkdown, changeSet.edits), newMarkdown);

  return transformSelectedTextAnchorThroughChangeSet({
    anchor: createAnchor(oldMarkdown, selectedText, occurrence),
    changeSet,
    newMarkdown,
    oldMarkdown
  });
}

function getAnchorResultComparable(result) {
  return result.outcome === "active"
    ? {
        end: result.end,
        outcome: result.outcome,
        selectedText: result.selectedText,
        start: result.start
      }
    : {
        end: result.end,
        outcome: result.outcome,
        start: result.start
      };
}

{
  const edit = {
    oldStart: 10,
    oldEnd: 20,
    insertedText: "replacement"
  };

  assert.equal(
    classifyRangeAgainstEdit({ start: 25, end: 35 }, edit),
    "after"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 0, end: 5 }, edit),
    "before"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 10, end: 20 }, edit),
    "exact_replacement"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 5, end: 25 }, edit),
    "edit_inside_anchor"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 12, end: 18 }, edit),
    "anchor_inside_edit"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 12, end: 25 }, edit),
    "overlap_anchor_start"
  );
  assert.equal(
    classifyRangeAgainstEdit({ start: 5, end: 12 }, edit),
    "overlap_anchor_end"
  );
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
  const oldMarkdown = [
    "Alpha target one.",
    "Middle untouched.",
    "Beta target two."
  ].join("\n");
  const newMarkdown = [
    "Alpha target 1.",
    "Middle untouched.",
    "Beta target 2."
  ].join("\n");
  const changeSet = deriveMarkdownChangeSet({
    newMarkdown,
    oldMarkdown,
    source: "manual_source"
  });

  assert.ok(changeSet);
  assert.equal(changeSet.edits.length, 2);
  assert.equal(applyMarkdownEdits(oldMarkdown, changeSet.edits), newMarkdown);
}

{
  const oldMarkdown = "Metric: LINE add";
  const newMarkdown = "Metric: **LINE add**";
  const result = transformWithChangeSet(oldMarkdown, newMarkdown, "LINE add");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "LINE add");
  assert.equal(newMarkdown.slice(result.start, result.end), "LINE add");
}

{
  const oldMarkdown = "Market: PAUL Thailand";
  const newMarkdown = "Market: [PAUL Thailand](https://example.com)";
  const result = transformWithChangeSet(
    oldMarkdown,
    newMarkdown,
    "PAUL Thailand"
  );

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "PAUL Thailand");
  assert.equal(newMarkdown.slice(result.start, result.end), "PAUL Thailand");
}

{
  const oldMarkdown = "regular customers need clear payment rules";
  const newMarkdown = "regular household customers need clearer payment terms";
  const result = transformWithChangeSet(
    oldMarkdown,
    newMarkdown,
    "regular customers need clear payment rules"
  );

  assert.equal(result.outcome, "active");
  assert.equal(
    result.selectedText,
    "regular household customers need clearer payment terms"
  );
}

{
  const oldMarkdown = [
    "Intro.",
    "Move this anchored paragraph to another section.",
    "Middle.",
    "Outro."
  ].join("\n");
  const movedText = "Move this anchored paragraph to another section.\n";
  const newMarkdown = [
    "Intro.",
    "Middle.",
    "Outro.",
    "Move this anchored paragraph to another section."
  ].join("\n");
  const result = transformWithChangeSet(
    oldMarkdown,
    newMarkdown,
    "anchored paragraph"
  );

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "anchored paragraph");
  assert.equal(result.transformation, "moved_with_text");
  assert.equal(
    newMarkdown.slice(result.start, result.end),
    "anchored paragraph"
  );
  assert.ok(movedText.length >= 12);
}

{
  const oldMarkdown = [
    "Intro.",
    "Duplicate anchored paragraph.",
    "Middle.",
    "Duplicate anchored paragraph.",
    "Outro."
  ].join("\n");
  const newMarkdown = [
    "Intro.",
    "Middle.",
    "Duplicate anchored paragraph.",
    "Duplicate anchored paragraph.",
    "Outro."
  ].join("\n");
  const result = transformWithChangeSet(
    oldMarkdown,
    newMarkdown,
    "anchored paragraph"
  );

  assert.equal(result.outcome, "needs_review");
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
  const result = transformWithChangeSet(oldMarkdown, newMarkdown, "LINE add");

  assert.equal(result.outcome, "active");
  assert.equal(result.selectedText, "LINE add");
  assert.equal(result.start, newMarkdown.indexOf("LINE add"));
}

{
  const oldMarkdown = "A\nB target\nC";
  const newMarkdown = "A changed\nB target\nC changed";
  const changeSet = deriveMarkdownChangeSet({
    newMarkdown,
    oldMarkdown,
    source: "manual_source"
  });
  assert.ok(changeSet);

  const safety = isSafeManualAnchorTransformChangeSet({
    affectedAnchorCount: 1,
    changeSet,
    oldMarkdown
  });

  assert.equal(safety.safe, true);
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
  const oldMarkdown = "A LINE add item.\nLater LINE add duplicate.";
  const manualMarkdown = oldMarkdown.replace(
    "LINE add item",
    "LINE account add item"
  );
  const manualEdit = deriveContiguousMarkdownEdit(oldMarkdown, manualMarkdown);
  assert.ok(manualEdit);
  const patchStart = oldMarkdown.indexOf("LINE add");
  const patchEdit = {
    oldStart: patchStart,
    oldEnd: patchStart + "LINE add".length,
    insertedText: "LINE account add"
  };

  const manualResult = transformWithEdit(oldMarkdown, manualEdit, "LINE add");
  const patchResult = transformWithEdit(oldMarkdown, patchEdit, "LINE add");

  assert.deepEqual(
    getAnchorResultComparable(patchResult),
    getAnchorResultComparable(manualResult)
  );
  assert.equal(patchResult.outcome, "active");
  assert.equal(patchResult.selectedText, "LINE account add");
}

{
  const oldMarkdown = "The regular customer buys weekly.";
  const manualMarkdown = oldMarkdown.replace(
    "regular customer",
    "regular household customer"
  );
  const manualEdit = deriveContiguousMarkdownEdit(oldMarkdown, manualMarkdown);
  assert.ok(manualEdit);
  const patchEdit = {
    oldStart: oldMarkdown.indexOf("regular"),
    oldEnd: oldMarkdown.indexOf("customer") + "customer".length,
    insertedText: "regular household customer"
  };

  assert.deepEqual(
    getAnchorResultComparable(
      transformWithEdit(oldMarkdown, patchEdit, "regular customer")
    ),
    getAnchorResultComparable(
      transformWithEdit(oldMarkdown, manualEdit, "regular customer")
    )
  );
}

{
  const oldMarkdown = "We need acceptable margins soon.";
  const manualMarkdown = oldMarkdown.replace("acceptable margins", "margins");
  const manualEdit = deriveContiguousMarkdownEdit(oldMarkdown, manualMarkdown);
  assert.ok(manualEdit);
  const patchEdit = {
    oldStart: oldMarkdown.indexOf("acceptable margins"),
    oldEnd: oldMarkdown.indexOf("acceptable margins") + "acceptable margins".length,
    insertedText: "margins"
  };

  assert.deepEqual(
    getAnchorResultComparable(
      transformWithEdit(oldMarkdown, patchEdit, "acceptable margins")
    ),
    getAnchorResultComparable(
      transformWithEdit(oldMarkdown, manualEdit, "acceptable margins")
    )
  );
}

{
  const oldMarkdown = "First duplicate. Remove me. Second duplicate.";
  const manualMarkdown = oldMarkdown.replace("Remove me", "");
  const manualEdit = deriveContiguousMarkdownEdit(oldMarkdown, manualMarkdown);
  assert.ok(manualEdit);
  const patchEdit = {
    oldStart: oldMarkdown.indexOf("Remove me"),
    oldEnd: oldMarkdown.indexOf("Remove me") + "Remove me".length,
    insertedText: ""
  };
  const patchResult = transformWithEdit(oldMarkdown, patchEdit, "Remove me");

  assert.deepEqual(
    getAnchorResultComparable(patchResult),
    getAnchorResultComparable(transformWithEdit(oldMarkdown, manualEdit, "Remove me"))
  );
  assert.equal(patchResult.outcome, "inactive");
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

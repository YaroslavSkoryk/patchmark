import assert from "node:assert/strict";
import { findChangedTableCellInPatchReplacement } from "../lib/comments/comment-anchor-patch-mapping.ts";

const header = [
  "| Product | Price | Business role | Validation question |",
  "| --- | --- | --- | --- |"
].join("\n");
const originalCranberryRow =
  "| Cranberries & Walnut | Around 240 THB | Premium flavor, higher ticket, gift/occasion and variety product. | Does inclusion cost and production complexity justify demand? |";
const suggestedCranberryRow =
  "| Cranberries & Walnut | Around 240 THB | One of the most popular products in the current neighbor pilot; premium inclusion bread with repeat-product potential. | Does its popularity continue beyond the founder's existing relationships, and does its margin justify the inclusion cost and production complexity? |";
const originalSelection =
  "Premium flavor, higher ticket, gift/occasion and variety product.";
const suggestedSelection =
  "One of the most popular products in the current neighbor pilot; premium inclusion bread with repeat-product potential.";

function anchorFor({
  originalStart = 0,
  originalText,
  selectedText = originalSelection
}) {
  const selectionStart = originalText.indexOf(selectedText);
  assert.notEqual(selectionStart, -1);

  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: {
      kind: "table_cell",
      markdown_text: selectedText,
      plain_text: selectedText
    },
    markdown_start_offset: originalStart + selectionStart,
    markdown_end_offset: originalStart + selectionStart + selectedText.length
  };
}

function changedCellMatch({
  originalStart = 0,
  originalText = originalCranberryRow,
  replacementStart = 0,
  replacementText = suggestedCranberryRow,
  selectedText = originalSelection
} = {}) {
  return findChangedTableCellInPatchReplacement({
    anchor: anchorFor({ originalStart, originalText, selectedText }),
    originalStart,
    originalText,
    replacementStart,
    replacementText
  });
}

{
  const match = changedCellMatch();

  assert.equal(match?.selectedText, suggestedSelection);
  assert.equal(match?.start, suggestedCranberryRow.indexOf(suggestedSelection));
  assert.equal(match?.end, match.start + suggestedSelection.length);
}

{
  const replacementRow =
    "| Cranberries & Walnut | Around 245 THB | One of the most popular products in the current neighbor pilot; premium inclusion bread with repeat-product potential. | Validate repeat demand. |";
  const match = changedCellMatch({ replacementText: replacementRow });

  assert.equal(match?.selectedText, suggestedSelection);
}

{
  const originalTable = [header, originalCranberryRow].join("\n");
  const replacementTable = [
    header,
    "| Original 650g | Around 200 THB | Core repeat bread. | Reorder? |",
    suggestedCranberryRow
  ].join("\n");
  const match = changedCellMatch({
    originalText: originalTable,
    replacementText: replacementTable
  });

  assert.equal(match?.selectedText, suggestedSelection);
}

{
  const originalTable = [header, originalCranberryRow].join("\n");
  const replacementTable = [
    header,
    "| Original 650g | Around 200 THB | Core repeat bread. | Reorder? |",
    suggestedCranberryRow,
    "| Baguette | Around 145 THB | Foodservice. | Timing? |"
  ].join("\n");
  const match = changedCellMatch({
    originalText: originalTable,
    replacementText: replacementTable
  });

  assert.equal(match?.selectedText, suggestedSelection);
}

{
  const originalTable = [
    header,
    "| Original 650g | Around 200 THB | Core repeat bread. | Reorder? |",
    originalCranberryRow
  ].join("\n");
  const replacementTable = [
    header,
    suggestedCranberryRow,
    "| Original 650g | Around 200 THB | Core repeat bread. | Reorder? |"
  ].join("\n");
  const match = changedCellMatch({
    originalText: originalTable,
    replacementText: replacementTable
  });

  assert.equal(match?.selectedText, suggestedSelection);
}

{
  const replacementText = [
    suggestedCranberryRow,
    "",
    "Elsewhere:",
    suggestedSelection
  ].join("\n");
  const match = changedCellMatch({ replacementText });

  assert.equal(match?.selectedText, suggestedSelection);
  assert.equal(match?.start, suggestedCranberryRow.indexOf(suggestedSelection));
}

{
  const comments = [
    changedCellMatch({ selectedText: "Around 240 THB" }),
    changedCellMatch({ selectedText: originalSelection }),
    changedCellMatch({
      selectedText: "Does inclusion cost and production complexity justify demand?"
    })
  ];

  assert.deepEqual(
    comments.map((match) => match?.selectedText),
    [
      "Around 240 THB",
      suggestedSelection,
      "Does its popularity continue beyond the founder's existing relationships, and does its margin justify the inclusion cost and production complexity?"
    ]
  );
}

{
  const originalText =
    "| Product | Note |\n| --- | --- |\n| Cranberries & Walnut | Keep before old phrase after launch. |";
  const replacementText =
    "| Product | Note |\n| --- | --- |\n| Cranberries & Walnut | Keep before new phrase after launch. |";
  const match = changedCellMatch({
    originalText,
    replacementText,
    selectedText: "old phrase"
  });

  assert.equal(match?.selectedText, "new phrase");
}

{
  const originalText =
    "| Product | Note |\n| --- | --- |\n| Cranberries & Walnut | Rewrite this fully. |";
  const replacementText =
    "| Product | Note |\n| --- | --- |\n| Cranberries & Walnut | Completely different wording. |";
  const match = changedCellMatch({
    originalText,
    replacementText,
    selectedText: "this"
  });

  assert.equal(match, null);
}

{
  assert.equal(changedCellMatch({ replacementText: "" }), null);
}

{
  const originalTable = [header, originalCranberryRow].join("\n");
  const replacementTable = [
    "| Product | Price | Validation question |",
    "| --- | --- | --- |",
    "| Cranberries & Walnut | Around 240 THB | Validate repeat demand. |"
  ].join("\n");

  assert.equal(
    changedCellMatch({
      originalText: originalTable,
      replacementText: replacementTable
    }),
    null
  );
}

{
  const originalTable = [header, originalCranberryRow].join("\n");
  const replacementTable = [
    "| Product | Business role | Price | Validation question |",
    "| --- | --- | --- | --- |",
    "| Cranberries & Walnut | One of the most popular products in the current neighbor pilot; premium inclusion bread with repeat-product potential. | Around 240 THB | Validate repeat demand. |"
  ].join("\n");
  const match = changedCellMatch({
    originalText: originalTable,
    replacementText: replacementTable
  });

  assert.equal(match?.selectedText, suggestedSelection);
}

{
  const replacementTable = [
    header,
    suggestedCranberryRow,
    suggestedCranberryRow.replace("One of the most popular products", "One repeated candidate")
  ].join("\n");

  assert.equal(changedCellMatch({ replacementText: replacementTable }), null);
}

{
  const originalText =
    "| Product | Business role |\n| --- | --- |\n| Cranberries \\| Walnut | Premium `gift | occasion` role with [menu](https://example.com/a?x=1|2). |";
  const replacementText =
    "| Product | Business role |\n| --- | --- |\n| Cranberries \\| Walnut | Updated `gift | occasion` role with [menu](https://example.com/a?x=1|2) and neighbor-pilot evidence. |";
  const match = changedCellMatch({
    originalText,
    replacementText,
    selectedText: "Premium `gift | occasion` role with [menu](https://example.com/a?x=1|2)."
  });

  assert.equal(
    match?.selectedText,
    "Updated `gift | occasion` role with [menu](https://example.com/a?x=1|2) and neighbor-pilot evidence."
  );
}

{
  const once = changedCellMatch();
  const twice = changedCellMatch();

  assert.deepEqual(twice, once);
}

console.log("Changed table-cell anchor mapping tests passed.");

import assert from "node:assert/strict";
import {
  createVisualTableAnchorProjection,
  markdownInlineToPlainText
} from "../lib/comments/comment-anchor-visual-projection.ts";

const paulRow =
  "| [PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery) | Express delivery starts around 250-300 THB; online bread examples include country bread, baguettes, and grain baguette at visible prices. | Delivery can become a major economic factor; Crust Chant should use zones, batching, minimum orders, or subscriptions rather than uncontrolled one-off delivery. |";
const markdown = [
  "### 5.1 Early Pricing Reference Points",
  "",
  "| **Public reference** | **Observed item / price** | **Implication** |",
  "| --- | --- | --- |",
  paulRow
].join("\n");
const rowStart = markdown.indexOf(paulRow);
const projection = createVisualTableAnchorProjection({
  markdown,
  range: {
    end: rowStart + paulRow.length,
    start: rowStart
  }
});

assert.ok(projection);
assert.equal(projection.tableIndex, 0);
assert.equal(projection.rows.length, 1);
assert.equal(projection.rows[0].markdownRowIndex, 2);
assert.deepEqual(
  projection.rows[0].cells.map((cell) => cell.visibleText),
  [
    "PAUL Thailand online delivery",
    "Express delivery starts around 250-300 THB; online bread examples include country bread, baguettes, and grain baguette at visible prices.",
    "Delivery can become a major economic factor; Crust Chant should use zones, batching, minimum orders, or subscriptions rather than uncontrolled one-off delivery."
  ]
);

const linkCellStart = markdown.indexOf("[PAUL");
const linkCellEnd = markdown.indexOf(" | Express", linkCellStart);
const linkProjection = createVisualTableAnchorProjection({
  markdown,
  range: {
    end: linkCellEnd,
    start: linkCellStart
  }
});

assert.ok(linkProjection);
assert.deepEqual(
  linkProjection.rows[0].cells.map((cell) => cell.visibleText),
  ["PAUL Thailand online delivery"]
);

assert.equal(
  markdownInlineToPlainText("Use **bold**, *emphasis*, `code`, and [a link](https://example.com)."),
  "Use bold, emphasis, code, and a link."
);
assert.equal(markdownInlineToPlainText("Escaped \\| pipe"), "Escaped | pipe");

console.log("Comment anchor visual projection tests passed.");

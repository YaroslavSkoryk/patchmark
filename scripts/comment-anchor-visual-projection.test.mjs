import assert from "node:assert/strict";
import {
  createVisualAnchorSearchTextCandidates,
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

const duplicateLinkRows = [
  "### Competitive delivery references",
  "",
  "| **Provider** | **Signal** |",
  "| --- | --- |",
  "| [PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery) | Premium delivery reference. |",
  "| [PAUL Thailand online delivery](https://example.com/wholesale) | Wholesale duplicate label. |"
].join("\n");
const secondDuplicateLinkStart = duplicateLinkRows.lastIndexOf("[PAUL");
const secondDuplicateLinkEnd = duplicateLinkRows.indexOf(
  " | Wholesale",
  secondDuplicateLinkStart
);
const duplicateLinkProjection = createVisualTableAnchorProjection({
  markdown: duplicateLinkRows,
  range: {
    end: secondDuplicateLinkEnd,
    start: secondDuplicateLinkStart
  }
});

assert.ok(duplicateLinkProjection);
assert.equal(duplicateLinkProjection.tableIndex, 0);
assert.equal(duplicateLinkProjection.rows.length, 1);
assert.equal(duplicateLinkProjection.rows[0].markdownRowIndex, 3);
assert.deepEqual(
  duplicateLinkProjection.rows[0].cells.map((cell) => cell.cellIndex),
  [0]
);
assert.deepEqual(
  duplicateLinkProjection.rows[0].cells.map((cell) => cell.visibleText),
  ["PAUL Thailand online delivery"]
);

assert.equal(
  markdownInlineToPlainText("Use **bold**, *emphasis*, `code`, and [a link](https://example.com)."),
  "Use bold, emphasis, code, and a link."
);
assert.equal(markdownInlineToPlainText("Escaped \\| pipe"), "Escaped | pipe");
assert.equal(
  markdownInlineToPlainText("Use `LINE add` and **paid order** before [website visit](https://example.com)."),
  "Use LINE add and paid order before website visit."
);

assert.deepEqual(
  createVisualAnchorSearchTextCandidates({
    selectedMarkdown:
      "[PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery)",
    sourceMarkdown:
      "[PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery)"
  }),
  ["PAUL Thailand online delivery"]
);

const rowSearchCandidates = createVisualAnchorSearchTextCandidates({
  selectedMarkdown: paulRow,
  sourceMarkdown: paulRow
});

assert.ok(rowSearchCandidates[0].startsWith("PAUL Thailand online delivery"));
assert.equal(rowSearchCandidates[0].includes("https://"), false);
assert.equal(rowSearchCandidates[0].includes("["), false);
assert.equal(rowSearchCandidates[0].includes("|"), false);

assert.deepEqual(
  createVisualAnchorSearchTextCandidates({
    selectedMarkdown:
      "**PAUL** Thailand [online delivery](https://www.paulthailand.com/next-day-delivery)",
    sourceMarkdown:
      "**PAUL** Thailand [online delivery](https://www.paulthailand.com/next-day-delivery)"
  }),
  ["PAUL Thailand online delivery"]
);

const demandSection = [
  "## 7. Demand Generation Plan",
  "",
  "| **Channel** | **Next step to measure** |",
  "| --- | --- |",
  "| Product content and bread photos | LINE add, website visit, paid order. |",
  "",
  "## 8. Demand Validation Approach",
  "",
  "| **Signal** | **Metric** |",
  "| --- | --- |",
  "| Intent | LINE adds, price questions, delivery questions. |"
].join("\n");
const lineAddStart = demandSection.indexOf("LINE add");

assert.deepEqual(
  createVisualAnchorSearchTextCandidates({
    selectedMarkdown: "LINE add",
    sourceMarkdown: demandSection.slice(lineAddStart, lineAddStart + "LINE add".length)
  }),
  ["LINE add"]
);

console.log("Comment anchor visual projection tests passed.");

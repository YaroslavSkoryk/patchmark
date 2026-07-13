import assert from "node:assert/strict";
import { findUniqueCurrentTableRowForPatchOriginal } from "../lib/comments/comment-anchor-table-row-recovery.ts";

{
  const markdown = [
    "# Plan",
    "",
    "## 3. Market View",
    "",
    "| **Market signal** | **What it suggests** | **What still must be validated** | **Validation signal** |",
    "| --- | --- | --- | --- |",
    "| Thailand foodservice remains resilient. | Large foodservice ecosystem. | Repeat demand. | Paid orders. |",
    "| [Bank of Thailand reported household debt at 86.8% of GDP in Q2 2025](https://example.com/bot.pdf). | Pricing must be premium but practical. | Actual price acceptance and repeat purchase behavior. | Order conversion at listed price. |",
    "| Sourdough trend. | Category signal. | Local repeat demand. | Sourdough orders. |",
    "",
    "## 4. Other"
  ].join("\n");
  const patch = {
    original_text:
      "| [Bank of Thailand reported household debt at 86.8% of GDP in Q2 2025](https://example.com/bot.pdf). | Pricing must be premium but practical. | Actual price acceptance and repeat purchase behavior. |",
    target_heading: "## 3. Market View"
  };
  const match = findUniqueCurrentTableRowForPatchOriginal({ markdown, patch });

  assert.equal(match?.text.includes("Bank of Thailand"), true);
  assert.equal(match?.text.includes("Order conversion at listed price"), true);
}

{
  const markdown = [
    "### 5.1 Early Pricing Reference Points",
    "",
    "| **Public reference** | **Observed item / price** | **Implication** |",
    "| --- | --- | --- |",
    "| [PAUL Thailand online delivery](https://example.com/paul) | Express delivery starts around 250-300 THB. | Delivery can become a major economic factor. |"
  ].join("\n");
  const patch = {
    original_text:
      "| [PAUL Thailand online delivery](https://example.com/paul) | Express delivery starts around 250-300 THB. | Delivery can become a major economic factor. |",
    target_heading: "### 5.1 Early Pricing Reference Points"
  };
  const match = findUniqueCurrentTableRowForPatchOriginal({ markdown, patch });

  assert.equal(match?.text.includes("PAUL Thailand online delivery"), true);
}

{
  const markdown = [
    "## Market View",
    "",
    "| A | B | C |",
    "| --- | --- | --- |",
    "| Repeated | Same | Row |",
    "| Repeated | Same | Row |"
  ].join("\n");
  const patch = {
    original_text: "| Repeated | Same | Row |",
    target_heading: "## Market View"
  };

  assert.equal(
    findUniqueCurrentTableRowForPatchOriginal({ markdown, patch }),
    null
  );
}

console.log("Comment anchor table-row recovery tests passed.");

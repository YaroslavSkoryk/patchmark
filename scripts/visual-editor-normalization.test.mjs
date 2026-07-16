import assert from "node:assert/strict";
import { normalizeMarkdownForVisualEditor } from "../lib/markdown/normalize-for-visual-editor.ts";

const comparisonTable = [
  "| Metric | Stop |",
  "|---|---|",
  "| Capacity | <40% after two tests |",
  "| Complaints | <5% of orders |"
].join("\n");

assert.equal(
  normalizeMarkdownForVisualEditor(comparisonTable),
  comparisonTable.replaceAll("<", "\\<")
);

assert.equal(
  normalizeMarkdownForVisualEditor("Already escaped: \\<40%"),
  "Already escaped: \\<40%"
);

assert.equal(
  normalizeMarkdownForVisualEditor("Line one<br>Line two"),
  "Line one<br />Line two"
);

const fencedComparison = [
  "```text",
  "<40% remains exact inside code",
  "```"
].join("\n");

assert.equal(
  normalizeMarkdownForVisualEditor(fencedComparison),
  fencedComparison
);

console.log("Visual editor normalization tests passed.");

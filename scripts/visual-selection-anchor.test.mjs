import assert from "node:assert/strict";
import { findUniqueScopedVisualSelectionMatch } from "../lib/comments/visual-selection-anchor.ts";

const matches = [
  { start: 32, end: 53 },
  { start: 89, end: 110 }
];

assert.deepEqual(
  findUniqueScopedVisualSelectionMatch(matches, { start: 0, end: 70 }),
  matches[0]
);
assert.deepEqual(
  findUniqueScopedVisualSelectionMatch(matches, { start: 70, end: 130 }),
  matches[1]
);
assert.equal(
  findUniqueScopedVisualSelectionMatch(matches, { start: 0, end: 130 }),
  null
);
assert.equal(
  findUniqueScopedVisualSelectionMatch(matches, { start: 111, end: 130 }),
  null
);

console.log("visual selection anchor tests passed");

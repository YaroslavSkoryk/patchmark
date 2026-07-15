import assert from "node:assert/strict";
import {
  appendConciseAnchorHistory,
  getHistoryNextAnchor,
  getHistoryPreviousAnchor,
  isConciseAnchorHistoryEntry
} from "../lib/comments/comment-anchor-history.ts";

const baseAnchor = createAnchor(10, 24, "selected phrase");
const movedAnchor = createAnchor(18, 32, "selected phrase");
const timestamp = "2026-07-15T00:00:00.000Z";

const first = appendConciseAnchorHistory({
  cause: "canonical_recovery",
  commentId: "PM-COMMENT-0001",
  nextAnchor: movedAnchor,
  previousAnchor: baseAnchor,
  reason: "anchor_recovered_after_patch",
  sourcePatchId: "PM-PATCH-0001",
  timestamp
});

assert.equal(first.length, 1);
assert.equal(isConciseAnchorHistoryEntry(first[0]), true);
assert.equal(first[0].format_version, 2);
assert.equal(first[0].previous.selected_text_excerpt, "selected phrase");
assert.equal("anchor_context" in first[0].previous, false);
assert.equal(JSON.stringify(first).includes("surrounding context"), false);

const duplicate = appendConciseAnchorHistory({
  cause: "canonical_recovery",
  commentId: "PM-COMMENT-0001",
  history: first,
  nextAnchor: movedAnchor,
  previousAnchor: baseAnchor,
  reason: "anchor_recovered_after_patch",
  sourcePatchId: "PM-PATCH-0001",
  timestamp: "2026-07-15T00:00:01.000Z"
});
assert.equal(duplicate, first, "Equivalent recovery must be idempotent.");

const noOp = appendConciseAnchorHistory({
  cause: "canonical_recovery",
  commentId: "PM-COMMENT-0001",
  history: first,
  nextAnchor: movedAnchor,
  previousAnchor: movedAnchor,
  reason: "anchor_recovered_after_patch",
  timestamp
});
assert.equal(noOp, first, "An unchanged current anchor must not create history.");

const reverse = appendConciseAnchorHistory({
  cause: "historical_convergence",
  commentId: "PM-COMMENT-0001",
  history: first,
  nextAnchor: baseAnchor,
  previousAnchor: movedAnchor,
  reason: "anchor_recovered_after_patch",
  sourcePatchId: "PM-PATCH-0001",
  timestamp: "2026-07-15T00:00:02.000Z"
});
assert.equal(reverse, first, "Immediate recovery ping-pong must be suppressed.");

const needsReview = appendConciseAnchorHistory({
  cause: "patch_apply",
  commentId: "PM-COMMENT-0001",
  history: first,
  nextState: "needs_review",
  previousAnchor: movedAnchor,
  reason: "anchor_marked_needs_review_after_patch",
  sourcePatchId: "PM-PATCH-0002",
  timestamp: "2026-07-15T00:00:03.000Z"
});
assert.equal(needsReview.at(-1).next.state, "needs_review");

const legacyEntry = {
  changed_at: timestamp,
  reason: "anchor_recovered_after_patch",
  source_patch_id: "PM-PATCH-LEGACY",
  previous_anchor: baseAnchor,
  new_anchor: movedAnchor
};
assert.deepEqual(getHistoryPreviousAnchor(legacyEntry), baseAnchor);
assert.deepEqual(getHistoryNextAnchor(legacyEntry), movedAnchor);
assert.equal(getHistoryPreviousAnchor(first[0]).selected_text, "selected phrase");

let growthHistory = [];
let previous = createAnchor(0, 12, "short target");
for (let index = 1; index <= 100; index += 1) {
  const next = createAnchor(index, index + 12, "short target");
  growthHistory = appendConciseAnchorHistory({
    cause: "manual_edit",
    commentId: "PM-COMMENT-GROWTH",
    history: growthHistory,
    mutationGeneration: index,
    nextAnchor: next,
    previousAnchor: previous,
    reason: "offset_shifted_after_patch",
    sourceId: `edit-${index}`,
    timestamp: `2026-07-15T00:01:${String(index % 60).padStart(2, "0")}.000Z`
  });
  previous = next;
}
assert.equal(growthHistory.length, 100);
const serializedGrowth = JSON.stringify(growthHistory);
assert.ok(serializedGrowth.length < 100_000);
assert.equal(serializedGrowth.includes("anchor_context"), false);

process.stdout.write(
  `${JSON.stringify({
    entries: growthHistory.length,
    serializedBytes: Buffer.byteLength(serializedGrowth),
    averageBytes: Math.round(Buffer.byteLength(serializedGrowth) / growthHistory.length),
    pingPongPrevented: reverse === first,
    duplicatePrevented: duplicate === first
  }, null, 2)}\n`
);

function createAnchor(start, end, selectedText) {
  return {
    kind: "selected_text",
    selected_text: selectedText,
    markdown_start_offset: start,
    markdown_end_offset: end,
    containing_heading: "Target Section",
    containing_heading_path: ["Target Section"],
    anchor_context: {
      kind: "paragraph",
      plain_text: `surrounding context ${"x".repeat(2_000)}`,
      markdown_text: `surrounding context ${"x".repeat(2_000)}`,
      markdown_start_offset: start,
      markdown_end_offset: end
    }
  };
}

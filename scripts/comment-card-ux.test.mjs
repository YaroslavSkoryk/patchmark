import assert from "node:assert/strict";
import {
  getPatchImpactForCurrentAnchorDisplay,
  getVisibleAnchorStatus,
  getVisibleCommentThreadEntries
} from "../lib/comments/comment-anchor-state.ts";

const recoveryImpact = {
  impact_kind: "linked_comment",
  patch_id: "PM-PATCH-0020",
  result: "reanchored"
};

const needsReviewImpact = {
  impact_kind: "anchor_intersects_replaced_range",
  patch_id: "PM-PATCH-0020",
  result: "needs_review"
};

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(getVisibleAnchorStatus("document"), undefined);
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: needsReviewImpact
    }),
    undefined
  );
}

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  const visibleThread = getVisibleCommentThreadEntries([
    {
      id: "PM-THREAD-0001",
      role: "system",
      content:
        "Patch PM-PATCH-0020 shifted text before this comment and Patchmark recovered the anchor from the selected text.",
      created_at: "2026-07-12T00:00:00.000Z"
    },
    {
      id: "PM-THREAD-0002",
      role: "system",
      content:
        "Patch PM-PATCH-0021 was applied to the document and this comment was re-anchored to the applied replacement.",
      created_at: "2026-07-12T00:01:00.000Z"
    }
  ]);

  assert.deepEqual(visibleThread, []);
}

{
  assert.equal(getVisibleAnchorStatus("ambiguous"), "ambiguous");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "ambiguous",
      latestPatchImpact: needsReviewImpact
    }),
    undefined
  );
}

{
  assert.equal(getVisibleAnchorStatus("not_found"), "not_found");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "not_found",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
}

{
  const visibleThread = getVisibleCommentThreadEntries([
    {
      id: "PM-THREAD-0001",
      role: "system",
      content:
        "Patch PM-PATCH-0020 may have affected this comment anchor. Please review it.",
      created_at: "2026-07-12T00:00:00.000Z"
    },
    {
      id: "PM-THREAD-0002",
      role: "user",
      content: "Can you clarify this wording?",
      created_at: "2026-07-12T00:01:00.000Z"
    },
    {
      id: "PM-THREAD-0003",
      role: "chatgpt",
      content: "This wording means the software should support the launch.",
      created_at: "2026-07-12T00:02:00.000Z"
    },
    {
      id: "PM-THREAD-0004",
      role: "system",
      content: "Patch PM-PATCH-0022 was applied to the document.",
      created_at: "2026-07-12T00:03:00.000Z"
    }
  ]);

  assert.deepEqual(
    visibleThread.map((entry) => entry.id),
    ["PM-THREAD-0002", "PM-THREAD-0003", "PM-THREAD-0004"]
  );
}

{
  const unrelatedReviewState = {
    focus_state: "awaiting_reply"
  };

  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(unrelatedReviewState.focus_state, "awaiting_reply");
}

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(getVisibleAnchorStatus("not_found"), "not_found");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "not_found",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
}

console.log("Comment card UX tests passed.");

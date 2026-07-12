import assert from "node:assert/strict";
import {
  getLastKnownCommentAnchorPositionRange,
  sortCommentsByLastKnownAnchorPosition
} from "../lib/comments/comment-anchor-position.ts";

function selectedAnchor(start, end = start + 12) {
  return {
    kind: "selected_text",
    selected_text: `anchor-${start}`,
    markdown_start_offset: start,
    markdown_end_offset: end,
    anchor_context: {
      kind: "sentence",
      plain_text: `anchor-${start}`,
      markdown_text: `anchor-${start}`,
      selected_start_in_context: 0,
      selected_end_in_context: 12,
      markdown_start_offset: start,
      markdown_end_offset: end
    }
  };
}

function unpositionedSelectedAnchor(label) {
  return {
    kind: "selected_text",
    selected_text: label
  };
}

function comment({
  anchor,
  anchorHistory,
  createdAt,
  id,
  patchImpacts = [],
  status = "open",
  updatedAt = createdAt
}) {
  return {
    id,
    type: "note",
    status,
    anchor,
    comment: id,
    thread: [],
    export_state: {
      focus_state: "idle"
    },
    anchor_history: anchorHistory,
    patch_impacts: patchImpacts,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function needsReviewImpact(patchId, impactKind = "anchor_intersects_replaced_range") {
  return {
    patch_id: patchId,
    impacted_at: "2026-07-12T00:00:00.000Z",
    impact_kind: impactKind,
    result: "needs_review"
  };
}

function orderedIds(comments) {
  return sortCommentsByLastKnownAnchorPosition(comments).map(
    (currentComment) => currentComment.id
  );
}

{
  const comments = [
    comment({
      anchor: selectedAnchor(20),
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "first"
    }),
    comment({
      anchor: selectedAnchor(60),
      createdAt: "2026-07-12T00:01:00.000Z",
      id: "middle",
      patchImpacts: [needsReviewImpact("PM-PATCH-0020")]
    }),
    comment({
      anchor: selectedAnchor(100),
      createdAt: "2026-07-12T00:02:00.000Z",
      id: "third"
    })
  ];

  assert.deepEqual(orderedIds(comments), ["first", "middle", "third"]);
  assert.deepEqual(getLastKnownCommentAnchorPositionRange(comments[1]), {
    end: 72,
    start: 60
  });
}

{
  const comments = [
    comment({
      anchor: selectedAnchor(90),
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "needs-review-late",
      patchImpacts: [needsReviewImpact("PM-PATCH-0021")]
    }),
    comment({
      anchor: selectedAnchor(10),
      createdAt: "2026-07-12T00:01:00.000Z",
      id: "normal-early"
    }),
    comment({
      anchor: selectedAnchor(50),
      createdAt: "2026-07-12T00:02:00.000Z",
      id: "needs-review-middle",
      patchImpacts: [needsReviewImpact("PM-PATCH-0022")]
    })
  ];

  assert.deepEqual(orderedIds(comments), [
    "normal-early",
    "needs-review-middle",
    "needs-review-late"
  ]);
}

{
  const ambiguousComment = comment({
    anchor: selectedAnchor(44),
    createdAt: "2026-07-12T00:00:00.000Z",
    id: "ambiguous",
    patchImpacts: [needsReviewImpact("PM-PATCH-0023")]
  });

  assert.deepEqual(getLastKnownCommentAnchorPositionRange(ambiguousComment), {
    end: 56,
    start: 44
  });
}

{
  const shiftedComment = comment({
    anchor: unpositionedSelectedAnchor("old anchor"),
    anchorHistory: [
      {
        changed_at: "2026-07-12T00:00:00.000Z",
        reason: "offset_shifted_after_patch",
        source_patch_id: "PM-PATCH-0024",
        impact_kind: "anchor_after_replaced_range",
        previous_anchor: selectedAnchor(40),
        new_anchor: selectedAnchor(76)
      }
    ],
    createdAt: "2026-07-12T00:00:00.000Z",
    id: "shifted-ambiguous",
    patchImpacts: [
      needsReviewImpact("PM-PATCH-0025", "anchor_after_replaced_range")
    ]
  });

  assert.deepEqual(getLastKnownCommentAnchorPositionRange(shiftedComment), {
    end: 88,
    start: 76
  });
}

{
  const stableComments = [
    comment({
      anchor: selectedAnchor(20),
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "first"
    }),
    comment({
      anchor: selectedAnchor(60),
      createdAt: "2026-07-12T00:01:00.000Z",
      id: "middle"
    }),
    comment({
      anchor: selectedAnchor(100),
      createdAt: "2026-07-12T00:02:00.000Z",
      id: "third"
    })
  ];
  const needsReviewComments = stableComments.map((currentComment) =>
    currentComment.id === "middle"
      ? {
          ...currentComment,
          patch_impacts: [needsReviewImpact("PM-PATCH-0026")]
        }
      : currentComment
  );
  const activeAgainComments = needsReviewComments.map((currentComment) =>
    currentComment.id === "middle"
      ? {
          ...currentComment,
          patch_impacts: [
            ...currentComment.patch_impacts,
            {
              patch_id: "PM-PATCH-0027",
              impacted_at: "2026-07-12T00:01:00.000Z",
              impact_kind: "anchor_after_replaced_range",
              result: "reanchored"
            }
          ]
        }
      : currentComment
  );

  assert.deepEqual(orderedIds(stableComments), ["first", "middle", "third"]);
  assert.deepEqual(orderedIds(needsReviewComments), ["first", "middle", "third"]);
  assert.deepEqual(orderedIds(activeAgainComments), ["first", "middle", "third"]);
}

{
  const comments = [
    comment({
      anchor: selectedAnchor(20),
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "first"
    }),
    comment({
      anchor: selectedAnchor(60),
      createdAt: "2026-07-12T00:01:00.000Z",
      id: "resolved-middle",
      status: "resolved"
    }),
    comment({
      anchor: selectedAnchor(100),
      createdAt: "2026-07-12T00:02:00.000Z",
      id: "third"
    })
  ];

  assert.deepEqual(orderedIds(comments), ["first", "resolved-middle", "third"]);
}

{
  const persistedComment = comment({
    anchor: selectedAnchor(60),
    createdAt: "2026-07-12T00:00:00.000Z",
    id: "persisted-needs-review",
    patchImpacts: [needsReviewImpact("PM-PATCH-0028")]
  });
  const reloadedComment = JSON.parse(JSON.stringify(persistedComment));

  assert.deepEqual(getLastKnownCommentAnchorPositionRange(reloadedComment), {
    end: 72,
    start: 60
  });
}

{
  const comments = [
    comment({
      anchor: unpositionedSelectedAnchor("missing"),
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "no-position"
    }),
    comment({
      anchor: selectedAnchor(20),
      createdAt: "2026-07-12T00:01:00.000Z",
      id: "positioned"
    })
  ];

  assert.deepEqual(orderedIds(comments), ["positioned", "no-position"]);
}

console.log("Comment rail ordering tests passed.");

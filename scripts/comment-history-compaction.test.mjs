import assert from "node:assert/strict";
import { compactLegacyCommentHistory } from "../lib/comments/comment-history-compaction.ts";

const createdAt = "2026-07-15T00:00:00.000Z";
const markdown = [
  "## Target Section",
  "",
  "Alpha target.",
  "",
  "Beta target.",
  "",
  "Long historical target that remains uniquely recoverable."
].join("\n");

const alphaStart = markdown.indexOf("Alpha target.");
const betaStart = markdown.indexOf("Beta target.");
const alpha = createAnchor("Alpha target.", alphaStart);
const beta = createAnchor("Beta target.", betaStart);
const recursiveAlpha = {
  ...alpha,
  anchor_history: [
    {
      previous_anchor: alpha,
      new_anchor: beta
    }
  ],
  recovery_history: [{ anchor: alpha }]
};
const conciseEntry = {
  format_version: 2,
  history_id: "PM-HISTORY-CONCISE",
  changed_at: createdAt,
  reason: "anchor_reanchored_after_patch",
  cause: "human_reanchor",
  previous: {
    kind: "selected_text",
    start: betaStart,
    end: betaStart + "Beta target.".length,
    selected_text_hash: "fixture-beta",
    selected_text_excerpt: "Beta target.",
    selected_text_length: "Beta target.".length,
    containing_heading: "Target Section",
    state: "active"
  },
  next: {
    kind: "selected_text",
    start: alphaStart,
    end: alphaStart + "Alpha target.".length,
    selected_text_hash: "fixture-alpha",
    selected_text_excerpt: "Alpha target.",
    selected_text_length: "Alpha target.".length,
    containing_heading: "Target Section",
    state: "active"
  }
};

const comments = [
  createComment({
    id: "PM-COMMENT-COMPACT",
    anchor: alpha,
    history: [
      legacyTransition(recursiveAlpha, beta, "PM-PATCH-1"),
      legacyTransition(alpha, beta, "PM-PATCH-1"),
      legacyTransition(alpha, beta, "PM-PATCH-1"),
      legacyTransition(beta, alpha, "PM-PATCH-1"),
      legacyTransition(alpha, alpha, "PM-PATCH-1"),
      conciseEntry
    ],
    patchImpacts: [
      createImpact("PM-PATCH-1", createdAt),
      createImpact("PM-PATCH-1", "2026-07-15T00:00:01.000Z")
    ],
    thread: [
      createThread("PM-THREAD-USER", "user", "Keep this exact reply."),
      createThread("PM-THREAD-AI", "chatgpt", "Keep this exact answer."),
      createThread("PM-THREAD-SYSTEM-1", "system", "Anchor recovered."),
      createThread("PM-THREAD-SYSTEM-2", "system", "Anchor recovered.")
    ]
  }),
  createComment({
    id: "PM-COMMENT-MIXED",
    anchor: beta,
    history: [legacyTransition(alpha, beta, "PM-PATCH-2"), conciseEntry]
  }),
  createComment({
    id: "PM-COMMENT-NONE",
    anchor: alpha
  }),
  createComment({
    id: "PM-COMMENT-EDIT-SESSION",
    anchor: createAnchor("Alpha target.", alphaStart + 2),
    history: [
      legacyEditingTransition(alpha, createAnchor("Alpha target.", alphaStart + 1)),
      legacyEditingTransition(
        createAnchor("Alpha target.", alphaStart + 1),
        createAnchor("Alpha target.", alphaStart + 2)
      )
    ]
  }),
  createComment({
    id: "PM-COMMENT-NEEDS-REVIEW",
    anchor: alpha,
    history: [
      {
        changed_at: createdAt,
        reason: "anchor_marked_needs_review_after_patch",
        source_patch_id: "PM-PATCH-3",
        previous_anchor: alpha
      }
    ]
  })
];

const inputSnapshot = structuredClone(comments);
const first = compactLegacyCommentHistory({
  comments,
  markdown,
  patches: []
});
const second = compactLegacyCommentHistory({
  comments,
  markdown,
  patches: []
});

assert.deepEqual(comments, inputSnapshot, "Dry-run engine must not mutate input.");
assert.deepEqual(first.comments, second.comments, "Output must be deterministic.");
assert.equal(first.report.blocking_validation_errors.length, 0);
assert.ok(first.report.recursive_entry_count >= 1);
assert.ok(first.report.duplicate_entry_count >= 2);
assert.ok(first.report.no_effect_entry_count >= 1);
assert.ok(first.report.ping_pong_sequence_count >= 1);
assert.equal(first.report.patch_impact_duplicate_count, 1);
assert.equal(first.report.technical_thread_duplicate_count, 1);
assert.equal(first.report.editing_session_coalescing_count, 1);
assert.equal(first.report.editing_session_entries_suppressed, 1);

const compacted = first.comments[0];
assert.deepEqual(compacted.anchor, comments[0].anchor);
assert.deepEqual(compacted.thread, comments[0].thread);
assert.equal(compacted.patch_impacts.length, 1);
assert.ok(compacted.anchor_history.every((entry) => entry.format_version === 2));
assert.equal(
  compacted.anchor_history.some((entry) => entry.history_id === conciseEntry.history_id),
  true,
  "Existing concise entries must be kept unchanged."
);
assert.equal(JSON.stringify(compacted.anchor_history).includes("anchor_context"), false);
assert.equal(JSON.stringify(compacted.anchor_history).includes("recovery_history"), false);

const needsReview = first.comments.find(
  (comment) => comment.id === "PM-COMMENT-NEEDS-REVIEW"
);
assert.equal(needsReview.anchor_history[0].next.state, "needs_review");

const idempotent = compactLegacyCommentHistory({
  comments: first.comments,
  markdown,
  patches: []
});
assert.deepEqual(idempotent.comments, first.comments);
assert.equal(idempotent.report.legacy_history_count, 0);
assert.equal(idempotent.report.estimated_reduction_bytes, 0);

const historicalText = "Long historical target that remains uniquely recoverable.";
const historicalStart = markdown.indexOf(historicalText);
const longText = `${historicalText} ${"x".repeat(300)}`;
const guardedComment = createComment({
  id: "PM-COMMENT-GUARDED",
  anchor: createAnchor("stale current target", 0),
  history: [
    legacyTransition(
      createAnchor("older target", 0),
      createAnchor(historicalText, historicalStart),
      "PM-PATCH-GUARD"
    ),
    legacyTransition(
      createAnchor(longText, 0),
      createAnchor(longText, 1),
      "PM-PATCH-LONG"
    )
  ]
});
const guarded = compactLegacyCommentHistory({
  comments: [guardedComment],
  markdown,
  patches: []
});
assert.equal(
  guarded.report.per_comment[0].canonical_resolution_before.state,
  guarded.report.per_comment[0].canonical_resolution_after.state
);
assert.deepEqual(
  guarded.report.per_comment[0].canonical_resolution_before.range,
  guarded.report.per_comment[0].canonical_resolution_after.range
);

process.stdout.write(
  `${JSON.stringify(
    {
      comments: first.report.comment_count,
      legacyEntries: first.report.legacy_history_count,
      estimatedReductionBytes: first.report.estimated_reduction_bytes,
      duplicatesRemoved: first.report.duplicate_entry_count,
      noEffectRemoved: first.report.no_effect_entry_count,
      pingPongSequences: first.report.ping_pong_sequence_count,
      editingSessions: first.report.editing_session_coalescing_count,
      patchImpactDuplicates: first.report.patch_impact_duplicate_count,
      threadEntriesPreserved: compacted.thread.length
    },
    null,
    2
  )}\n`
);

function createComment({
  id,
  anchor,
  history,
  patchImpacts,
  thread = []
}) {
  return {
    id,
    type: "note",
    status: "open",
    anchor,
    comment: `Comment ${id}`,
    thread,
    export_state: { focus_state: "idle" },
    anchor_history: history,
    patch_impacts: patchImpacts,
    created_at: createdAt,
    updated_at: createdAt
  };
}

function createAnchor(selectedText, start) {
  return {
    kind: "selected_text",
    selected_text: selectedText,
    selected_text_hash: `fixture:${selectedText}`,
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    containing_heading: "Target Section",
    containing_heading_path: ["Target Section"],
    anchor_context: {
      kind: "paragraph",
      plain_text: selectedText,
      markdown_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length
    }
  };
}

function legacyTransition(previousAnchor, newAnchor, sourcePatchId) {
  return {
    changed_at: createdAt,
    reason: "anchor_recovered_after_patch",
    source_patch_id: sourcePatchId,
    previous_anchor: previousAnchor,
    new_anchor: newAnchor,
    impact_kind: "linked_comment"
  };
}

function legacyEditingTransition(previousAnchor, newAnchor) {
  return {
    ...legacyTransition(previousAnchor, newAnchor),
    cause: "manual_edit",
    source_patch_id: undefined,
    source_id: "edit-session-1",
    mutation_generation: 7
  };
}

function createImpact(patchId, impactedAt) {
  return {
    patch_id: patchId,
    impacted_at: impactedAt,
    impact_kind: "linked_comment",
    result: "reanchored",
    note: "Same semantic impact"
  };
}

function createThread(id, role, content) {
  return { id, role, content, created_at: createdAt };
}

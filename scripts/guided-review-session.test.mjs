import assert from "node:assert/strict";
import {
  addCommentToGuidedReviewSession,
  createGuidedReviewProposalSession,
  getGuidedReviewAdditionOptions,
  isGuidedReviewSessionCurrent,
  removeCommentFromGuidedReviewSession,
  restoreRemovedCommentToGuidedReviewSession,
  validateGuidedReviewSessionSelection
} from "../lib/review-queue/guided-review-session.ts";

const compactPreview = ({ selectedCommentIds }) =>
  `Prompt for ${selectedCommentIds.join(",")}`;
const queue = createQueue({
  baseIds: ["COMMENT-2", "COMMENT-4"],
  commentIds: [
    "COMMENT-1",
    "COMMENT-2",
    "COMMENT-3",
    "COMMENT-4",
    "COMMENT-5",
    "COMMENT-6"
  ]
});
const initial = createGuidedReviewProposalSession({
  buildPromptPreview: compactPreview,
  queue
});
assert.ok(initial);
assert.deepEqual(initial.selectedCommentIds, ["COMMENT-2", "COMMENT-4"]);

const queueBefore = JSON.stringify(queue);
const removed = removeCommentFromGuidedReviewSession({
  buildPromptPreview: compactPreview,
  commentId: "COMMENT-2",
  queue,
  session: initial
});
assert.deepEqual(removed.selectedCommentIds, ["COMMENT-4"]);
assert.deepEqual(removed.transientlyRemovedCommentIds, ["COMMENT-2"]);
assert.equal(JSON.stringify(queue), queueBefore);
assert.throws(() =>
  addCommentToGuidedReviewSession({
    buildPromptPreview: compactPreview,
    commentId: "COMMENT-2",
    queue,
    session: removed
  })
);
const restored = restoreRemovedCommentToGuidedReviewSession({
  buildPromptPreview: compactPreview,
  commentId: "COMMENT-2",
  queue,
  session: removed
});
assert.deepEqual(restored.selectedCommentIds, initial.selectedCommentIds);

const added = addCommentToGuidedReviewSession({
  buildPromptPreview: compactPreview,
  commentId: "COMMENT-1",
  queue,
  session: initial
});
assert.deepEqual(added.selectedCommentIds, [
  "COMMENT-1",
  "COMMENT-2",
  "COMMENT-4"
]);
assert.deepEqual(added.transientlyAddedCommentIds, ["COMMENT-1"]);
assert.ok(added.estimatedPromptTokens > initial.estimatedPromptTokens);

const reset = createGuidedReviewProposalSession({
  buildPromptPreview: compactPreview,
  queue
});
assert.deepEqual(reset?.selectedCommentIds, initial.selectedCommentIds);
assert.deepEqual(reset?.transientlyAddedCommentIds, []);
assert.deepEqual(reset?.transientlyRemovedCommentIds, []);

const crossSectionQueue = {
  ...queue,
  comments: [
    ...queue.comments,
    reviewComment("COMMENT-OTHER-SECTION", 99, "section:other")
  ]
};
assert.equal(
  getGuidedReviewAdditionOptions({
    buildPromptPreview: compactPreview,
    queue: crossSectionQueue,
    session: initial
  }).some((option) => option.commentId === "COMMENT-OTHER-SECTION"),
  false
);

for (const batchType of ["follow_up", "document_level"]) {
  const isolatedQueue = createQueue({
    baseIds: ["COMMENT-1"],
    batchType,
    commentIds: ["COMMENT-1", "COMMENT-2"]
  });
  const isolatedSession = createGuidedReviewProposalSession({
    buildPromptPreview: compactPreview,
    queue: isolatedQueue
  });
  assert.ok(isolatedSession);
  assert.deepEqual(
    getGuidedReviewAdditionOptions({
      buildPromptPreview: compactPreview,
      queue: isolatedQueue,
      session: isolatedSession
    }),
    []
  );
}

const maximumQueue = createQueue({
  baseIds: ["COMMENT-1", "COMMENT-2", "COMMENT-3", "COMMENT-4", "COMMENT-5"],
  commentIds: [
    "COMMENT-1",
    "COMMENT-2",
    "COMMENT-3",
    "COMMENT-4",
    "COMMENT-5",
    "COMMENT-6"
  ]
});
const maximumSession = createGuidedReviewProposalSession({
  buildPromptPreview: compactPreview,
  queue: maximumQueue
});
assert.ok(maximumSession);
const sixthOption = getGuidedReviewAdditionOptions({
  buildPromptPreview: compactPreview,
  queue: maximumQueue,
  session: maximumSession
}).find((option) => option.commentId === "COMMENT-6");
assert.equal(sixthOption?.available, false);
assert.match(sixthOption?.unavailableReason ?? "", /five-comment limit/);

const sizeQueue = createQueue({
  baseIds: ["COMMENT-1"],
  commentIds: ["COMMENT-1", "COMMENT-LARGE"]
});
const sizePreview = ({ selectedCommentIds }) =>
  selectedCommentIds.includes("COMMENT-LARGE")
    ? "x".repeat(100_000)
    : "Small prompt";
const sizeSession = createGuidedReviewProposalSession({
  buildPromptPreview: sizePreview,
  queue: sizeQueue
});
assert.ok(sizeSession);
const largeOption = getGuidedReviewAdditionOptions({
  buildPromptPreview: sizePreview,
  queue: sizeQueue,
  session: sizeSession
}).find((option) => option.commentId === "COMMENT-LARGE");
assert.equal(largeOption?.available, false);
assert.match(largeOption?.unavailableReason ?? "", /prompt-size limit/);

const oversizedBaseQueue = createQueue({
  baseIds: ["COMMENT-LARGE"],
  commentIds: ["COMMENT-LARGE"]
});
const oversizedBaseSession = createGuidedReviewProposalSession({
  buildPromptPreview: sizePreview,
  queue: oversizedBaseQueue
});
assert.ok(oversizedBaseSession?.overLimitWarning);
const removedOversizedBase = removeCommentFromGuidedReviewSession({
  buildPromptPreview: sizePreview,
  commentId: "COMMENT-LARGE",
  queue: oversizedBaseQueue,
  session: oversizedBaseSession
});
assert.deepEqual(
  restoreRemovedCommentToGuidedReviewSession({
    buildPromptPreview: sizePreview,
    commentId: "COMMENT-LARGE",
    queue: oversizedBaseQueue,
    session: removedOversizedBase
  }).selectedCommentIds,
  ["COMMENT-LARGE"]
);

const empty = initial.selectedCommentIds.reduce(
  (session, commentId) =>
    removeCommentFromGuidedReviewSession({
      buildPromptPreview: compactPreview,
      commentId,
      queue,
      session
    }),
  initial
);
assert.equal(empty.selectedCommentIds.length, 0);
assert.throws(() =>
  validateGuidedReviewSessionSelection({
    buildPromptPreview: compactPreview,
    queue,
    session: empty
  })
);

const staleQueue = { ...queue, documentGeneration: queue.documentGeneration + 1 };
assert.equal(
  isGuidedReviewSessionCurrent({ queue: staleQueue, session: initial }),
  false
);
assert.throws(() =>
  validateGuidedReviewSessionSelection({
    buildPromptPreview: compactPreview,
    queue: staleQueue,
    session: initial
  })
);
assert.deepEqual(
  validateGuidedReviewSessionSelection({
    buildPromptPreview: compactPreview,
    queue,
    session: added
  }).selectedCommentIds,
  added.selectedCommentIds
);

console.log(
  JSON.stringify(
    {
      deterministicOrder: added.selectedCommentIds,
      emptySelectionRejected: true,
      followUpAndDocumentIsolation: true,
      maximumCommentLimit: true,
      promptSizeLimit: true,
      reset: true,
      staleDetection: true,
      transientNoMutation: true
    },
    null,
    2
  )
);

function createQueue({
  baseIds,
  batchType = "section",
  commentIds
}) {
  const sectionKey = batchType === "section" ? "section:market" : null;
  return {
    algorithmVersion: 1,
    comments: commentIds.map((commentId, index) =>
      reviewComment(commentId, index, sectionKey)
    ),
    documentGeneration: 8,
    documentId: "doc_session",
    exclusionSummary: {
      awaitingChatgptResponse: 0,
      awaitingHumanReview: 0,
      blocked: 0,
      blockedAnchor: 0,
      blockedLifecycle: 0,
      deferred: 0,
      laterSections: 0,
      readyNotSelected: commentIds.length - baseIds.length,
      resolved: 0
    },
    projectId: "project_session",
    proposal: {
      batchType,
      commentIds: baseIds,
      estimatedPromptTokens: 10,
      overLimitWarning: false,
      sectionHeadingSnapshot:
        batchType === "section" ? "Market Evidence" : null,
      sectionKey,
      selectionReasons: [{ code: "earliest_eligible_comment" }],
      stopReason:
        batchType === "follow_up"
          ? "follow_up_only"
          : batchType === "document_level"
            ? "document_level_only"
            : "section_exhausted"
    },
    queueCounts: {
      awaiting_chatgpt_response: 0,
      awaiting_human_review: 0,
      blocked: 0,
      deferred: 0,
      ready_for_chatgpt: commentIds.length,
      resolved: 0
    }
  };
}

function reviewComment(commentId, documentOrder, sectionKey) {
  return {
    anchorAvailability: sectionKey === null ? "not_required" : "resolved",
    batchPriority: "ordinary",
    commentId,
    createdAt: `2026-07-22T00:00:${String(documentOrder).padStart(2, "0")}.000Z`,
    documentOrder,
    explicitFollowUp: false,
    latestMeaningfulTurn: {
      actor: "human",
      kind: "new_comment",
      sourceId: commentId
    },
    reasonCode: "new_comment",
    sectionHeadingSnapshot: sectionKey ? "Market Evidence" : null,
    sectionKey,
    state: "ready_for_chatgpt"
  };
}

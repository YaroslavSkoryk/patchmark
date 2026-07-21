import assert from "node:assert/strict";
import { deriveLatestMeaningfulTurn } from "../lib/review-queue/meaningful-turn.ts";
import { deriveReviewQueue } from "../lib/review-queue/review-queue-engine.ts";
import {
  REVIEW_QUEUE_INTRODUCTION_SECTION_KEY
} from "../lib/review-queue/document-section-buckets.ts";

const markdown = `# Strategy Review

Intro signal A.
Intro signal B.

## Market Evidence

### Retail

Market signal A.
Market signal B.
Market signal C.

### Wholesale

Market signal D.
Market signal E.
Market signal F.
Market signal G.

## Operations

Operations signal A.
Operations signal B.
Repeated signal.
Repeated signal.
`;
const baseInput = {
  buildPromptPreview: ({ batchType, selectedCommentIds }) =>
    `Complete ${batchType} prompt for ${selectedCommentIds.join(",")}`,
  documentGeneration: 72,
  documentId: "doc_strategy",
  markdown,
  patches: [],
  projectId: "prj_strategy"
};

const newComments = [
  selectedComment("PM-COMMENT-0001", "Market signal A."),
  selectedComment("PM-COMMENT-0002", "Market signal D."),
  selectedComment("PM-COMMENT-0003", "Operations signal A.")
];
const newQueue = queue(newComments);
assert.equal(newQueue.queueCounts.ready_for_chatgpt, 3);
assert.deepEqual(newQueue.proposal?.commentIds, [
  "PM-COMMENT-0001",
  "PM-COMMENT-0002"
]);
assert.equal(newQueue.proposal?.batchType, "section");
assert.equal(newQueue.proposal?.sectionHeadingSnapshot, "Market Evidence");
assert.equal(newQueue.proposal?.stopReason, "h2_boundary");
assert.equal(newQueue.exclusionSummary.laterSections, 1);

const assistantReply = threadEntry({
  createdAt: "2026-07-21T02:00:00.000Z",
  id: "PM-THREAD-0001",
  role: "chatgpt"
});
const awaitingHuman = queue([
  selectedComment("PM-COMMENT-0010", "Market signal A.", {
    thread: [assistantReply]
  })
]);
assertComment(awaitingHuman, "PM-COMMENT-0010", {
  reasonCode: "assistant_reply",
  state: "awaiting_human_review"
});
assert.equal(awaitingHuman.proposal, null);

for (const status of ["pending", "accepted", "rejected"]) {
  const patchOnly = queue(
    [selectedComment("PM-COMMENT-0011", "Market signal A.")],
    {
      patches: [patch("PM-PATCH-0001", "PM-COMMENT-0011", status)]
    }
  );
  assertComment(patchOnly, "PM-COMMENT-0011", {
    reasonCode: "patch_proposal",
    state: "awaiting_human_review"
  });
}

const clarification = queue([
  selectedComment("PM-COMMENT-0012", "Market signal A.", {
    thread: [
      threadEntry({
        createdAt: "2026-07-21T02:00:00.000Z",
        id: "PM-THREAD-0001",
        role: "chatgpt",
        suggestedUserAction: "clarify"
      })
    ]
  })
]);
assertComment(clarification, "PM-COMMENT-0012", {
  reasonCode: "clarification_question",
  state: "awaiting_human_review"
});

const explicitNoChange = queue([
  selectedComment("PM-COMMENT-0013", "Market signal A.", {
    exportState: {
      focus_state: "reply_received",
      last_import_id: "import-no-change",
      last_imported_at: "2026-07-21T02:00:00.000Z"
    }
  })
]);
assertComment(explicitNoChange, "PM-COMMENT-0013", {
  reasonCode: "explicit_no_change",
  state: "awaiting_human_review"
});

const humanReplyComment = selectedComment(
  "PM-COMMENT-0020",
  "Market signal A.",
  {
    thread: [
      assistantReply,
      threadEntry({
        createdAt: "2026-07-21T03:00:00.000Z",
        id: "PM-THREAD-0002",
        role: "user"
      })
    ]
  }
);
const humanReplyQueue = queue([humanReplyComment]);
assertComment(humanReplyQueue, humanReplyComment.id, {
  batchPriority: "follow_up",
  reasonCode: "human_reply",
  state: "ready_for_chatgpt"
});
assert.equal(humanReplyQueue.proposal?.batchType, "follow_up");
assert.deepEqual(humanReplyQueue.proposal?.commentIds, [humanReplyComment.id]);

const focusedAssistantComment = selectedComment(
  "PM-COMMENT-0021",
  "Market signal A.",
  {
    exportState: {
      focus_state: "in_focus",
      marked_for_export_at: "2026-07-21T03:00:00.000Z"
    },
    thread: [assistantReply]
  }
);
assertComment(queue([focusedAssistantComment]), focusedAssistantComment.id, {
  reasonCode: "assistant_reply",
  state: "awaiting_human_review"
});

const continueComment = selectedComment(
  "PM-COMMENT-0030",
  "Market signal B.",
  { thread: [assistantReply] }
);
const continueQueue = queue([newComments[0], continueComment], {
  explicitFollowUps: [
    followUp(continueComment.id, "continue_discussion", "2026-07-21T04:00:00.000Z")
  ]
});
assertComment(continueQueue, continueComment.id, {
  batchPriority: "follow_up",
  reasonCode: "continue_discussion",
  state: "ready_for_chatgpt"
});
assert.deepEqual(continueQueue.proposal?.commentIds, [continueComment.id]);

const firstFollowUp = selectedComment(
  "PM-COMMENT-0031",
  "Market signal C.",
  { thread: [assistantReply] }
);
const secondFollowUp = selectedComment(
  "PM-COMMENT-0032",
  "Market signal D.",
  { thread: [assistantReply] }
);
const multipleFollowUps = queue([firstFollowUp, secondFollowUp], {
  explicitFollowUps: [
    followUp(firstFollowUp.id, "explicit_assistant_request", "2026-07-21T06:00:00.000Z"),
    followUp(secondFollowUp.id, "continue_discussion", "2026-07-21T05:00:00.000Z")
  ]
});
assert.deepEqual(multipleFollowUps.proposal?.commentIds, [secondFollowUp.id]);

const documentQueue = queue([
  documentComment("PM-COMMENT-DOCUMENT"),
  selectedComment("PM-COMMENT-0040", "Market signal A.")
]);
assert.equal(documentQueue.proposal?.batchType, "document_level");
assert.deepEqual(documentQueue.proposal?.commentIds, ["PM-COMMENT-DOCUMENT"]);
assert.equal(
  commentById(documentQueue, "PM-COMMENT-DOCUMENT").anchorAvailability,
  "not_required"
);

const h3Comments = ["A", "B", "C", "D", "E", "F"].map((suffix, index) =>
  selectedComment(
    `PM-COMMENT-01${String(index).padStart(2, "0")}`,
    `Market signal ${suffix}.`
  )
);
const maximumQueue = queue(h3Comments);
assert.equal(maximumQueue.proposal?.sectionHeadingSnapshot, "Market Evidence");
assert.equal(maximumQueue.proposal?.commentIds.length, 5);
assert.equal(maximumQueue.proposal?.stopReason, "comment_limit");

const introductionQueue = queue([
  selectedComment("PM-COMMENT-INTRO-1", "Intro signal A."),
  selectedComment("PM-COMMENT-INTRO-2", "Intro signal B."),
  selectedComment("PM-COMMENT-H2", "Market signal A.")
]);
assert.equal(introductionQueue.proposal?.sectionKey, REVIEW_QUEUE_INTRODUCTION_SECTION_KEY);
assert.equal(
  introductionQueue.proposal?.sectionHeadingSnapshot,
  "Document introduction"
);
assert.deepEqual(introductionQueue.proposal?.commentIds, [
  "PM-COMMENT-INTRO-1",
  "PM-COMMENT-INTRO-2"
]);

const sizeLimitedQueue = queue(h3Comments.slice(0, 4), {
  buildPromptPreview: ({ selectedCommentIds }) =>
    "x".repeat(selectedCommentIds.length * 150),
  maximumEstimatedPromptTokens: 120
});
assert.deepEqual(sizeLimitedQueue.proposal?.commentIds, [
  h3Comments[0].id,
  h3Comments[1].id
]);
assert.equal(sizeLimitedQueue.proposal?.stopReason, "prompt_size_limit");
assert.equal(sizeLimitedQueue.proposal?.overLimitWarning, false);

const oversizedFirstQueue = queue(h3Comments.slice(0, 2), {
  buildPromptPreview: ({ selectedCommentIds }) =>
    "x".repeat(selectedCommentIds.length * 400),
  maximumEstimatedPromptTokens: 120
});
assert.deepEqual(oversizedFirstQueue.proposal?.commentIds, [h3Comments[0].id]);
assert.equal(oversizedFirstQueue.proposal?.overLimitWarning, true);
assert.ok(
  oversizedFirstQueue.proposal?.selectionReasons.some(
    (reason) => reason.code === "first_comment_exceeds_prompt_size"
  )
);

const unresolved = selectedComment(
  "PM-COMMENT-UNRESOLVED",
  "Text that does not exist.",
  { omitOffsets: true }
);
assertComment(queue([unresolved]), unresolved.id, {
  reasonCode: "anchor_unresolved",
  state: "blocked"
});
const ambiguous = selectedComment(
  "PM-COMMENT-AMBIGUOUS",
  "Repeated signal.",
  { omitOffsets: true }
);
assertComment(queue([ambiguous]), ambiguous.id, {
  reasonCode: "anchor_ambiguous",
  state: "blocked"
});

const resolved = {
  ...unresolved,
  status: "resolved",
  resolved_at: "2026-07-21T08:00:00.000Z",
  thread: [
    threadEntry({
      createdAt: "2026-07-21T09:00:00.000Z",
      id: "PM-THREAD-RESOLVED",
      role: "user"
    })
  ]
};
const resolvedQueue = queue([resolved], {
  activeExportEvidence: [activeExport(resolved.id)],
  deferredCommentIds: new Set([resolved.id])
});
assertComment(resolvedQueue, resolved.id, {
  reasonCode: "resolved",
  state: "resolved"
});

const deferred = selectedComment("PM-COMMENT-DEFERRED", "Market signal A.");
assertComment(
  queue([deferred], { deferredCommentIds: new Set([deferred.id]) }),
  deferred.id,
  { reasonCode: "deferred", state: "deferred" }
);
const blockedDeferred = queue([unresolved], {
  deferredCommentIds: new Set([unresolved.id])
});
assertComment(blockedDeferred, unresolved.id, {
  reasonCode: "anchor_unresolved",
  state: "blocked"
});

const activeExportComment = selectedComment(
  "PM-COMMENT-ACTIVE-EXPORT",
  "Text that does not exist.",
  { omitOffsets: true }
);
assertComment(
  queue([activeExportComment], {
    activeExportEvidence: [activeExport(activeExportComment.id)]
  }),
  activeExportComment.id,
  {
    reasonCode: "active_exported_request",
    state: "awaiting_chatgpt_response"
  }
);

const persistedExport = selectedComment(
  "PM-COMMENT-PERSISTED-EXPORT",
  "Market signal A.",
  {
    exportState: {
      focus_state: "exported",
      last_export_id: "comment-export-1",
      last_exported_at: "2026-07-21T02:00:00.000Z"
    }
  }
);
assertComment(queue([persistedExport]), persistedExport.id, {
  reasonCode: "active_exported_request",
  state: "awaiting_chatgpt_response"
});

const ambiguousLifecycle = selectedComment(
  "PM-COMMENT-LEGACY-EXPORT",
  "Market signal A.",
  { exportState: { focus_state: "exported" } }
);
assertComment(queue([ambiguousLifecycle]), ambiguousLifecycle.id, {
  reasonCode: "lifecycle_ambiguous",
  state: "blocked"
});

const unsupported = {
  ...selectedComment("PM-COMMENT-UNSUPPORTED", "Market signal A."),
  status: "archived"
};
assertComment(queue([unsupported]), unsupported.id, {
  reasonCode: "unsupported_comment_state",
  state: "blocked"
});

const sameAnchorLater = selectedComment(
  "PM-COMMENT-Z",
  "Market signal A.",
  { createdAt: "2026-07-21T02:00:00.000Z" }
);
const sameAnchorEarlierB = selectedComment(
  "PM-COMMENT-B",
  "Market signal A.",
  { createdAt: "2026-07-21T01:00:00.000Z" }
);
const sameAnchorEarlierA = selectedComment(
  "PM-COMMENT-A",
  "Market signal A.",
  { createdAt: "2026-07-21T01:00:00.000Z" }
);
assert.deepEqual(
  queue([sameAnchorLater, sameAnchorEarlierB, sameAnchorEarlierA]).comments.map(
    (comment) => comment.commentId
  ),
  [sameAnchorEarlierA.id, sameAnchorEarlierB.id, sameAnchorLater.id]
);

const firstDocumentQueue = deriveReviewQueue({
  ...baseInput,
  comments: [selectedComment("PM-COMMENT-SHARED", "Market signal A.")],
  documentId: "doc_first"
});
const secondDocumentQueue = deriveReviewQueue({
  ...baseInput,
  comments: [selectedComment("PM-COMMENT-SHARED", "Operations signal A.")],
  documentId: "doc_second"
});
assert.equal(firstDocumentQueue.documentId, "doc_first");
assert.equal(secondDocumentQueue.documentId, "doc_second");
assert.equal(firstDocumentQueue.proposal?.sectionHeadingSnapshot, "Market Evidence");
assert.equal(secondDocumentQueue.proposal?.sectionHeadingSnapshot, "Operations");

const savedMarkdown = markdown;
const recoveredMarkdown = markdown
  .replace("Market signal A.\n", "")
  .replace("Operations signal A.\n", "Operations signal A.\nMarket signal A.\n");
const recoveryComment = selectedComment(
  "PM-COMMENT-RECOVERY",
  "Market signal A."
);
const recoveryQueue = deriveReviewQueue({
  ...baseInput,
  comments: [recoveryComment],
  markdown: recoveredMarkdown
});
assert.equal(recoveryQueue.proposal?.sectionHeadingSnapshot, "Operations");
assert.equal(savedMarkdown.includes("Market signal A."), true);

const immutableComments = [newComments[0], humanReplyComment, unresolved];
const immutablePatches = [patch("PM-PATCH-IMMUTABLE", humanReplyComment.id, "accepted")];
const before = JSON.stringify({
  comments: immutableComments,
  markdown,
  patches: immutablePatches
});
const deterministicFirst = deriveReviewQueue({
  ...baseInput,
  comments: immutableComments,
  patches: immutablePatches
});
const deterministicSecond = deriveReviewQueue({
  ...baseInput,
  comments: immutableComments,
  patches: immutablePatches
});
assert.deepEqual(deterministicFirst, deterministicSecond);
assert.equal(
  JSON.stringify({ comments: immutableComments, markdown, patches: immutablePatches }),
  before
);
assert.equal(JSON.stringify(deterministicFirst).includes("runtime"), false);

const directTurn = deriveLatestMeaningfulTurn({
  comment: humanReplyComment,
  patches: []
});
assert.equal(directTurn.latestTurn.actor, "human");
assert.equal(directTurn.latestTurn.kind, "human_reply");
assert.equal(directTurn.explicitFollowUp, true);

console.log(
  JSON.stringify(
    {
      deterministic: true,
      duplicateLocalIdsIsolated: true,
      introductionBucket: introductionQueue.proposal?.sectionKey,
      maximumBatchSize: maximumQueue.proposal?.commentIds.length,
      noMutation: true,
      proposal: newQueue.proposal,
      queueCounts: newQueue.queueCounts,
      statesCovered: [
        "ready_for_chatgpt",
        "awaiting_chatgpt_response",
        "awaiting_human_review",
        "blocked",
        "deferred",
        "resolved"
      ]
    },
    null,
    2
  )
);

function queue(comments, overrides = {}) {
  return deriveReviewQueue({
    ...baseInput,
    comments,
    ...overrides
  });
}

function selectedComment(id, selectedText, options = {}) {
  const start = markdown.indexOf(selectedText);
  const createdAt = options.createdAt ?? "2026-07-21T01:00:00.000Z";
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      ...(!options.omitOffsets && start >= 0
        ? {
            markdown_start_offset: start,
            markdown_end_offset: start + selectedText.length
          }
        : {})
    },
    comment: `Review ${selectedText}`,
    thread: options.thread ?? [],
    export_state: options.exportState ?? { focus_state: "idle" },
    created_at: createdAt,
    updated_at: createdAt
  };
}

function documentComment(id) {
  return {
    id,
    type: "decision_needed",
    status: "open",
    anchor: { kind: "document" },
    comment: "Review the whole document.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z"
  };
}

function threadEntry({
  createdAt,
  id,
  role,
  suggestedUserAction
}) {
  return {
    id,
    role,
    content: `${role} contribution`,
    created_at: createdAt,
    ...(suggestedUserAction
      ? { suggested_user_action: suggestedUserAction }
      : {})
  };
}

function patch(id, commentId, status) {
  return {
    id,
    status,
    comment_id: commentId,
    original_text: "Market signal A.",
    suggested_text: "Updated market signal A.",
    reason: "Review proposal",
    created_at: "2026-07-21T02:00:00.000Z"
  };
}

function followUp(commentId, kind, requestedAt) {
  return {
    commentId,
    documentId: baseInput.documentId,
    kind,
    projectId: baseInput.projectId,
    requestedAt,
    sourceId: `follow-up:${commentId}`
  };
}

function activeExport(commentId) {
  return {
    commentId,
    documentId: baseInput.documentId,
    exportId: `export:${commentId}`,
    projectId: baseInput.projectId,
    responseImported: false
  };
}

function commentById(reviewQueue, commentId) {
  const comment = reviewQueue.comments.find(
    (candidate) => candidate.commentId === commentId
  );
  assert.ok(comment, `Missing queue comment ${commentId}.`);
  return comment;
}

function assertComment(reviewQueue, commentId, expected) {
  const comment = commentById(reviewQueue, commentId);
  Object.entries(expected).forEach(([key, value]) => {
    assert.equal(comment[key], value, `${commentId} ${key}`);
  });
}

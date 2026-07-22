import { estimateCompletePromptTokens } from "./prompt-preview-estimator.ts";
import {
  REVIEW_QUEUE_MAXIMUM_COMMENTS,
  REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS,
  type ReviewQueue,
  type ReviewQueuePromptPreviewBuilder,
  type ReviewQueueProposal
} from "./review-queue-types.ts";

export type GuidedReviewProposalSession = {
  projectId: string;
  documentId: string;
  documentGeneration: number;
  algorithmVersion: number;
  baseProposalSignature: string;
  batchType: ReviewQueueProposal["batchType"];
  sectionKey: string | null;
  sectionHeadingSnapshot: string | null;
  baseProposalCommentIds: string[];
  selectedCommentIds: string[];
  transientlyRemovedCommentIds: string[];
  transientlyAddedCommentIds: string[];
  estimatedPromptTokens: number;
  overLimitWarning: boolean;
};

export type GuidedReviewAdditionOption = {
  commentId: string;
  estimatedPromptTokens: number;
  available: boolean;
  unavailableReason: string | null;
};

export function createGuidedReviewProposalSession({
  buildPromptPreview,
  queue
}: {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  queue: ReviewQueue;
}): GuidedReviewProposalSession | null {
  if (!queue.proposal) {
    return null;
  }
  return createSession({
    baseCommentIds: queue.proposal.commentIds,
    buildPromptPreview,
    queue,
    selectedCommentIds: queue.proposal.commentIds
  });
}

export function removeCommentFromGuidedReviewSession({
  buildPromptPreview,
  commentId,
  queue,
  session
}: SessionMutationInput): GuidedReviewProposalSession {
  if (!session.selectedCommentIds.includes(commentId)) {
    return session;
  }
  return createSession({
    baseCommentIds: session.baseProposalCommentIds,
    buildPromptPreview,
    queue,
    selectedCommentIds: session.selectedCommentIds.filter(
      (candidate) => candidate !== commentId
    )
  });
}

export function addCommentToGuidedReviewSession({
  buildPromptPreview,
  commentId,
  queue,
  session
}: SessionMutationInput): GuidedReviewProposalSession {
  const option = getGuidedReviewAdditionOptions({
    buildPromptPreview,
    queue,
    session
  }).find((candidate) => candidate.commentId === commentId);
  if (!option?.available) {
    throw new Error(
      option?.unavailableReason ??
        "This comment is not eligible for the current batch."
    );
  }
  return createSession({
    baseCommentIds: session.baseProposalCommentIds,
    buildPromptPreview,
    queue,
    selectedCommentIds: [...session.selectedCommentIds, commentId]
  });
}

export function restoreRemovedCommentToGuidedReviewSession(
  input: SessionMutationInput
): GuidedReviewProposalSession {
  const { buildPromptPreview, commentId, queue, session } = input;
  if (!session.transientlyRemovedCommentIds.includes(commentId)) {
    return session;
  }
  const comment = queue.comments.find(
    (candidate) => candidate.commentId === commentId
  );
  if (
    !comment ||
    comment.state !== "ready_for_chatgpt" ||
    session.batchType !== "section" ||
    comment.sectionKey !== session.sectionKey
  ) {
    throw new Error("This removed comment is no longer eligible for the batch.");
  }
  const next = createSession({
    baseCommentIds: session.baseProposalCommentIds,
    buildPromptPreview,
    queue,
    selectedCommentIds: [...session.selectedCommentIds, commentId]
  });
  if (next.selectedCommentIds.length > REVIEW_QUEUE_MAXIMUM_COMMENTS) {
    throw new Error("The batch already reaches the five-comment limit.");
  }
  if (
    next.estimatedPromptTokens >
      REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS &&
    next.selectedCommentIds.length > 1
  ) {
    throw new Error(
      "Returning this comment would exceed the current prompt-size limit."
    );
  }
  return next;
}

export function getGuidedReviewAdditionOptions({
  buildPromptPreview,
  queue,
  session
}: {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  queue: ReviewQueue;
  session: GuidedReviewProposalSession;
}): GuidedReviewAdditionOption[] {
  if (session.batchType !== "section") {
    return [];
  }
  return queue.comments
    .filter(
      (comment) =>
        comment.state === "ready_for_chatgpt" &&
        comment.sectionKey === session.sectionKey &&
        !session.selectedCommentIds.includes(comment.commentId)
    )
    .map((comment) => {
      const selectedCommentIds = sortByDocumentOrder(
        [...session.selectedCommentIds, comment.commentId],
        queue
      );
      const estimatedPromptTokens = estimateCompletePromptTokens(
        buildPromptPreview({
          batchType: session.batchType,
          selectedCommentIds
        })
      );
      const removed = session.transientlyRemovedCommentIds.includes(
        comment.commentId
      );
      const commentLimitReached =
        selectedCommentIds.length > REVIEW_QUEUE_MAXIMUM_COMMENTS;
      const promptLimitReached =
        estimatedPromptTokens >
        REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS;
      const unavailableReason = removed
        ? "Return this removed comment to the batch explicitly."
        : commentLimitReached
          ? "The batch already reaches the five-comment limit."
          : promptLimitReached
            ? "Adding this comment would exceed the current prompt-size limit."
            : null;
      return {
        commentId: comment.commentId,
        estimatedPromptTokens,
        available: unavailableReason === null,
        unavailableReason
      };
    });
}

export function isGuidedReviewSessionCurrent({
  queue,
  session
}: {
  queue: ReviewQueue;
  session: GuidedReviewProposalSession;
}): boolean {
  return (
    session.projectId === queue.projectId &&
    session.documentId === queue.documentId &&
    session.documentGeneration === queue.documentGeneration &&
    session.algorithmVersion === queue.algorithmVersion &&
    session.baseProposalSignature === createProposalSignature(queue.proposal) &&
    JSON.stringify(session.baseProposalCommentIds) ===
      JSON.stringify(queue.proposal?.commentIds ?? [])
  );
}

export function validateGuidedReviewSessionSelection({
  buildPromptPreview,
  queue,
  session
}: {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  queue: ReviewQueue;
  session: GuidedReviewProposalSession;
}): GuidedReviewProposalSession {
  if (!isGuidedReviewSessionCurrent({ queue, session })) {
    throw new Error(
      "This review suggestion is out of date because the document or comments changed."
    );
  }
  if (session.selectedCommentIds.length === 0) {
    throw new Error("At least one comment is required to generate a prompt.");
  }
  const queueComments = new Map(
    queue.comments.map((comment) => [comment.commentId, comment])
  );
  session.selectedCommentIds.forEach((commentId) => {
    const comment = queueComments.get(commentId);
    if (!comment || comment.state !== "ready_for_chatgpt") {
      throw new Error(`Comment ${commentId} is no longer ready for ChatGPT.`);
    }
    if (
      session.batchType === "section" &&
      comment.sectionKey !== session.sectionKey
    ) {
      throw new Error(`Comment ${commentId} no longer belongs to this section.`);
    }
  });
  if (
    session.batchType !== "section" &&
    session.selectedCommentIds.length !== 1
  ) {
    throw new Error("Follow-up and document-level batches must contain one comment.");
  }
  if (session.selectedCommentIds.length > REVIEW_QUEUE_MAXIMUM_COMMENTS) {
    throw new Error("A Guided Review batch cannot contain more than five comments.");
  }
  const refreshed = createSession({
    baseCommentIds: session.baseProposalCommentIds,
    buildPromptPreview,
    queue,
    selectedCommentIds: session.selectedCommentIds
  });
  if (
    JSON.stringify(refreshed.selectedCommentIds) !==
    JSON.stringify(session.selectedCommentIds)
  ) {
    throw new Error("The adjusted batch is no longer in document order.");
  }
  if (
    refreshed.estimatedPromptTokens >
      REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS &&
    refreshed.selectedCommentIds.length > 1
  ) {
    throw new Error("The adjusted batch exceeds the current prompt-size limit.");
  }
  return refreshed;
}

type SessionMutationInput = {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  commentId: string;
  queue: ReviewQueue;
  session: GuidedReviewProposalSession;
};

function createSession({
  baseCommentIds,
  buildPromptPreview,
  queue,
  selectedCommentIds
}: {
  baseCommentIds: string[];
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  queue: ReviewQueue;
  selectedCommentIds: string[];
}): GuidedReviewProposalSession {
  if (!queue.proposal) {
    throw new Error("No Guided Review proposal is available.");
  }
  const orderedSelectedIds = sortByDocumentOrder(selectedCommentIds, queue);
  const baseSet = new Set(baseCommentIds);
  const selectedSet = new Set(orderedSelectedIds);
  const estimatedPromptTokens =
    orderedSelectedIds.length === 0
      ? 0
      : estimateCompletePromptTokens(
          buildPromptPreview({
            batchType: queue.proposal.batchType,
            selectedCommentIds: orderedSelectedIds
          })
        );
  return {
    projectId: queue.projectId,
    documentId: queue.documentId,
    documentGeneration: queue.documentGeneration,
    algorithmVersion: queue.algorithmVersion,
    baseProposalSignature: createProposalSignature(queue.proposal),
    batchType: queue.proposal.batchType,
    sectionKey: queue.proposal.sectionKey,
    sectionHeadingSnapshot: queue.proposal.sectionHeadingSnapshot,
    baseProposalCommentIds: [...baseCommentIds],
    selectedCommentIds: orderedSelectedIds,
    transientlyRemovedCommentIds: baseCommentIds.filter(
      (commentId) => !selectedSet.has(commentId)
    ),
    transientlyAddedCommentIds: orderedSelectedIds.filter(
      (commentId) => !baseSet.has(commentId)
    ),
    estimatedPromptTokens,
    overLimitWarning:
      estimatedPromptTokens >
      REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS
  };
}

function sortByDocumentOrder(commentIds: string[], queue: ReviewQueue): string[] {
  const selected = new Set(commentIds);
  return queue.comments
    .filter((comment) => selected.has(comment.commentId))
    .map((comment) => comment.commentId);
}

function createProposalSignature(proposal: ReviewQueueProposal | null): string {
  return JSON.stringify(proposal);
}

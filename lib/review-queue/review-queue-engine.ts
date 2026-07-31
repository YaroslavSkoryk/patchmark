import { resolveCanonicalCommentTarget } from "../comments/canonical-target-resolution.ts";
import { getLastKnownCommentAnchorPositionRange } from "../comments/comment-anchor-position.ts";
import { getActiveComments } from "../comments/comment-trash-operations.ts";
import { parseMarkdownHeadings } from "../markdown/parse-headings.ts";
import type {
  PatchmarkComment,
  PatchmarkPatch
} from "../project/project-types.ts";
import { deriveCommentReviewState } from "./comment-review-state.ts";
import { getReviewQueueSectionBucket } from "./document-section-buckets.ts";
import { deriveLatestMeaningfulTurn } from "./meaningful-turn.ts";
import { estimateCompletePromptTokens } from "./prompt-preview-estimator.ts";
import {
  REVIEW_QUEUE_ALGORITHM_VERSION,
  REVIEW_QUEUE_MAXIMUM_COMMENTS,
  REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS,
  type CommentReviewState,
  type ReviewQueue,
  type ReviewQueueActiveExportEvidence,
  type ReviewQueueComment,
  type ReviewQueueExclusionSummary,
  type ReviewQueueFollowUpEvidence,
  type ReviewQueuePromptPreviewBuilder,
  type ReviewQueueProposal,
  type ReviewQueueSelectionReason
} from "./review-queue-types.ts";

export function deriveReviewQueue({
  activeExportEvidence = [],
  buildPromptPreview,
  comments,
  deferredCommentIds = new Set<string>(),
  documentGeneration,
  documentId,
  explicitFollowUps = [],
  markdown,
  maximumComments = REVIEW_QUEUE_MAXIMUM_COMMENTS,
  maximumEstimatedPromptTokens =
    REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS,
  patches,
  projectId
}: {
  activeExportEvidence?: ReviewQueueActiveExportEvidence[];
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  comments: PatchmarkComment[];
  deferredCommentIds?: ReadonlySet<string>;
  documentGeneration: number;
  documentId: string;
  explicitFollowUps?: ReviewQueueFollowUpEvidence[];
  markdown: string;
  maximumComments?: number;
  maximumEstimatedPromptTokens?: number;
  patches: PatchmarkPatch[];
  projectId: string;
}): ReviewQueue {
  assertPositiveLimit(maximumComments, "maximumComments");
  assertPositiveLimit(
    maximumEstimatedPromptTokens,
    "maximumEstimatedPromptTokens"
  );
  const headings = parseMarkdownHeadings(markdown);
  const scopedActiveExportEvidence = activeExportEvidence.filter(
    (evidence) =>
      evidence.projectId === projectId && evidence.documentId === documentId
  );
  const scopedFollowUps = explicitFollowUps.filter(
    (evidence) =>
      evidence.projectId === projectId && evidence.documentId === documentId
  );
  const queueComments = getActiveComments(comments)
    .map((comment) => {
      const resolution = resolveCanonicalCommentTarget(comment, {
        headings,
        markdown,
        patches
      });
      const anchorAvailability =
        comment.anchor.kind === "document"
          ? "not_required"
          : resolution.state === "resolved"
            ? "resolved"
            : resolution.state === "ambiguous"
              ? "ambiguous"
              : "unresolved";
      const documentOrder =
        comment.anchor.kind === "document"
          ? 0
          : resolution.range?.start ??
            getLastKnownCommentAnchorPositionRange(comment)?.start ??
            null;
      const section =
        comment.anchor.kind !== "document" && documentOrder !== null
          ? getReviewQueueSectionBucket({
              documentOrder,
              headings,
              markdown
            })
          : null;
      const meaningfulTurn = deriveLatestMeaningfulTurn({
        comment,
        explicitFollowUps: scopedFollowUps,
        patches
      });
      const classification = deriveCommentReviewState({
        activeExportEvidence: scopedActiveExportEvidence.find(
          (evidence) => evidence.commentId === comment.id
        ),
        anchorAvailability,
        comment,
        deferred: deferredCommentIds.has(comment.id),
        latestMeaningfulTurn: meaningfulTurn.latestTurn
      });
      return {
        anchorAvailability,
        batchPriority:
          classification.state === "ready_for_chatgpt"
            ? meaningfulTurn.explicitFollowUp
              ? "follow_up"
              : "ordinary"
            : "not_eligible",
        commentId: comment.id,
        createdAt: comment.created_at,
        documentOrder,
        explicitFollowUp: meaningfulTurn.explicitFollowUp,
        latestMeaningfulTurn: meaningfulTurn.latestTurn,
        reasonCode: classification.reasonCode,
        sectionHeadingSnapshot: section?.headingTextSnapshot ?? null,
        sectionKey: section?.sectionKey ?? null,
        state: classification.state
      } satisfies ReviewQueueComment;
    })
    .sort(compareQueueComments);
  const queueCounts = createQueueCounts(queueComments);
  const proposal = createProposal({
    buildPromptPreview,
    maximumComments,
    maximumEstimatedPromptTokens,
    queueComments
  });

  return {
    algorithmVersion: REVIEW_QUEUE_ALGORITHM_VERSION,
    comments: queueComments,
    documentGeneration,
    documentId,
    exclusionSummary: createExclusionSummary(queueComments, proposal),
    projectId,
    proposal,
    queueCounts
  };
}

function createProposal({
  buildPromptPreview,
  maximumComments,
  maximumEstimatedPromptTokens,
  queueComments
}: {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  maximumComments: number;
  maximumEstimatedPromptTokens: number;
  queueComments: ReviewQueueComment[];
}): ReviewQueueProposal | null {
  const followUps = queueComments.filter(
    (comment) =>
      comment.state === "ready_for_chatgpt" &&
      comment.batchPriority === "follow_up"
  );
  if (followUps.length > 0) {
    const selected = [...followUps].sort(compareFollowUps)[0];
    return createSingleCommentProposal({
      batchType: "follow_up",
      buildPromptPreview,
      comment: selected,
      maximumEstimatedPromptTokens,
      selectionReasons: [{ code: "explicit_follow_up_priority" }],
      stopReason: "follow_up_only"
    });
  }

  const readyComments = queueComments.filter(
    (comment) => comment.state === "ready_for_chatgpt"
  );
  const first = readyComments[0];
  if (!first) {
    return null;
  }

  if (first.sectionKey === null) {
    return createSingleCommentProposal({
      batchType: "document_level",
      buildPromptPreview,
      comment: first,
      maximumEstimatedPromptTokens,
      selectionReasons: [
        { code: "earliest_eligible_comment" },
        { code: "document_level_isolated" }
      ],
      stopReason: "document_level_only"
    });
  }

  const selectedCommentIds = [first.commentId];
  let stopReason: ReviewQueueProposal["stopReason"] = "section_exhausted";
  for (const candidate of readyComments.slice(1)) {
    if (candidate.sectionKey !== first.sectionKey) {
      stopReason = "h2_boundary";
      break;
    }
    if (selectedCommentIds.length >= maximumComments) {
      stopReason = "comment_limit";
      break;
    }
    const candidateIds = [...selectedCommentIds, candidate.commentId];
    const estimatedTokens = estimateCompletePromptTokens(
      buildPromptPreview({
        batchType: "section",
        selectedCommentIds: candidateIds
      })
    );
    if (estimatedTokens > maximumEstimatedPromptTokens) {
      stopReason = "prompt_size_limit";
      break;
    }
    selectedCommentIds.push(candidate.commentId);
  }

  const estimatedPromptTokens = estimateCompletePromptTokens(
    buildPromptPreview({
      batchType: "section",
      selectedCommentIds
    })
  );
  const overLimitWarning =
    estimatedPromptTokens > maximumEstimatedPromptTokens;
  const selectionReasons: ReviewQueueSelectionReason[] = [
    { code: "earliest_eligible_comment" },
    { code: "same_h2_section" },
    { code: "within_comment_limit", maximum: maximumComments },
    ...(overLimitWarning
      ? [
          {
            code: "first_comment_exceeds_prompt_size" as const,
            maximumEstimatedTokens: maximumEstimatedPromptTokens
          }
        ]
      : [
          {
            code: "within_prompt_size_limit" as const,
            maximumEstimatedTokens: maximumEstimatedPromptTokens
          }
        ])
  ];
  return {
    batchType: "section",
    commentIds: selectedCommentIds,
    estimatedPromptTokens,
    overLimitWarning,
    sectionHeadingSnapshot: first.sectionHeadingSnapshot,
    sectionKey: first.sectionKey,
    selectionReasons,
    stopReason,
  };
}

function createSingleCommentProposal({
  batchType,
  buildPromptPreview,
  comment,
  maximumEstimatedPromptTokens,
  selectionReasons,
  stopReason
}: {
  batchType: "follow_up" | "document_level";
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  comment: ReviewQueueComment;
  maximumEstimatedPromptTokens: number;
  selectionReasons: ReviewQueueSelectionReason[];
  stopReason: "follow_up_only" | "document_level_only";
}): ReviewQueueProposal {
  const estimatedPromptTokens = estimateCompletePromptTokens(
    buildPromptPreview({
      batchType,
      selectedCommentIds: [comment.commentId]
    })
  );
  const overLimitWarning =
    estimatedPromptTokens > maximumEstimatedPromptTokens;
  return {
    batchType,
    commentIds: [comment.commentId],
    estimatedPromptTokens,
    overLimitWarning,
    sectionHeadingSnapshot: comment.sectionHeadingSnapshot,
    sectionKey: comment.sectionKey,
    selectionReasons: [
      ...selectionReasons,
      ...(overLimitWarning
        ? [
            {
              code: "first_comment_exceeds_prompt_size" as const,
              maximumEstimatedTokens: maximumEstimatedPromptTokens
            }
          ]
        : [
            {
              code: "within_prompt_size_limit" as const,
              maximumEstimatedTokens: maximumEstimatedPromptTokens
            }
          ])
    ],
    stopReason
  };
}

function compareQueueComments(
  first: ReviewQueueComment,
  second: ReviewQueueComment
): number {
  return (
    (first.documentOrder ?? Number.POSITIVE_INFINITY) -
      (second.documentOrder ?? Number.POSITIVE_INFINITY) ||
    first.createdAt.localeCompare(second.createdAt) ||
    first.commentId.localeCompare(second.commentId)
  );
}

function compareFollowUps(
  first: ReviewQueueComment,
  second: ReviewQueueComment
): number {
  return (
    getOccurredAt(first).localeCompare(getOccurredAt(second)) ||
    compareQueueComments(first, second)
  );
}

function getOccurredAt(comment: ReviewQueueComment): string {
  return comment.latestMeaningfulTurn.actor === "none"
    ? ""
    : comment.latestMeaningfulTurn.occurredAt ?? "";
}

function createQueueCounts(
  comments: ReviewQueueComment[]
): Record<CommentReviewState, number> {
  const counts: Record<CommentReviewState, number> = {
    awaiting_chatgpt_response: 0,
    awaiting_human_review: 0,
    blocked: 0,
    deferred: 0,
    ready_for_chatgpt: 0,
    resolved: 0
  };
  comments.forEach((comment) => {
    counts[comment.state] += 1;
  });
  return counts;
}

function createExclusionSummary(
  comments: ReviewQueueComment[],
  proposal: ReviewQueueProposal | null
): ReviewQueueExclusionSummary {
  const selectedIds = new Set(proposal?.commentIds ?? []);
  return {
    awaitingChatgptResponse: comments.filter(
      (comment) => comment.state === "awaiting_chatgpt_response"
    ).length,
    awaitingHumanReview: comments.filter(
      (comment) => comment.state === "awaiting_human_review"
    ).length,
    blocked: comments.filter((comment) => comment.state === "blocked").length,
    blockedAnchor: comments.filter(
      (comment) =>
        comment.reasonCode === "anchor_unresolved" ||
        comment.reasonCode === "anchor_ambiguous"
    ).length,
    blockedLifecycle: comments.filter(
      (comment) => comment.reasonCode === "lifecycle_ambiguous"
    ).length,
    deferred: comments.filter((comment) => comment.state === "deferred").length,
    laterSections: proposal
      ? comments.filter(
          (comment) =>
            comment.state === "ready_for_chatgpt" &&
            !selectedIds.has(comment.commentId) &&
            comment.sectionKey !== proposal.sectionKey
        ).length
      : 0,
    readyNotSelected: comments.filter(
      (comment) =>
        comment.state === "ready_for_chatgpt" &&
        !selectedIds.has(comment.commentId)
    ).length,
    resolved: comments.filter((comment) => comment.state === "resolved").length
  };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive number.`);
  }
}

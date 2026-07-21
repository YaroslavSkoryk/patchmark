export const REVIEW_QUEUE_ALGORITHM_VERSION = 1;
export const REVIEW_QUEUE_MAXIMUM_COMMENTS = 5;
export const REVIEW_QUEUE_MAXIMUM_ESTIMATED_PROMPT_TOKENS = 20_000;

export type CommentReviewState =
  | "ready_for_chatgpt"
  | "awaiting_chatgpt_response"
  | "awaiting_human_review"
  | "blocked"
  | "deferred"
  | "resolved";

export type CommentReviewReasonCode =
  | "resolved"
  | "active_exported_request"
  | "anchor_unresolved"
  | "anchor_ambiguous"
  | "lifecycle_ambiguous"
  | "unsupported_comment_state"
  | "deferred"
  | "new_comment"
  | "human_reply"
  | "continue_discussion"
  | "explicit_assistant_request"
  | "assistant_reply"
  | "clarification_question"
  | "patch_proposal"
  | "explicit_no_change"
  | "no_meaningful_turn";

export type LatestMeaningfulTurn =
  | {
      actor: "human";
      kind:
        | "new_comment"
        | "human_reply"
        | "continue_discussion"
        | "explicit_assistant_request";
      occurredAt?: string;
      sourceId: string;
    }
  | {
      actor: "assistant";
      kind:
        | "assistant_reply"
        | "clarification_question"
        | "patch_proposal"
        | "explicit_no_change";
      occurredAt?: string;
      sourceId: string;
    }
  | {
      actor: "none";
      kind: "no_meaningful_turn";
    };

export type ReviewQueueAnchorAvailability =
  | "not_required"
  | "resolved"
  | "ambiguous"
  | "unresolved";

export type ReviewQueueSectionBucket = {
  headingLevel: 0 | 2;
  headingTextSnapshot: string;
  sectionKey: string;
  startOffset: number;
};

export type ReviewQueueComment = {
  anchorAvailability: ReviewQueueAnchorAvailability;
  batchPriority: "follow_up" | "ordinary" | "not_eligible";
  commentId: string;
  createdAt: string;
  documentOrder: number | null;
  explicitFollowUp: boolean;
  latestMeaningfulTurn: LatestMeaningfulTurn;
  reasonCode: CommentReviewReasonCode;
  sectionHeadingSnapshot: string | null;
  sectionKey: string | null;
  state: CommentReviewState;
};

export type ReviewQueueCounts = Record<CommentReviewState, number>;

export type ReviewQueueSelectionReason =
  | { code: "explicit_follow_up_priority" }
  | { code: "earliest_eligible_comment" }
  | { code: "document_level_isolated" }
  | { code: "same_h2_section" }
  | { code: "within_comment_limit"; maximum: number }
  | {
      code: "within_prompt_size_limit";
      maximumEstimatedTokens: number;
    }
  | {
      code: "first_comment_exceeds_prompt_size";
      maximumEstimatedTokens: number;
    };

export type ReviewQueueProposal = {
  batchType: "follow_up" | "document_level" | "section";
  commentIds: string[];
  estimatedPromptTokens: number;
  overLimitWarning: boolean;
  sectionHeadingSnapshot: string | null;
  sectionKey: string | null;
  selectionReasons: ReviewQueueSelectionReason[];
  stopReason:
    | "follow_up_only"
    | "document_level_only"
    | "section_exhausted"
    | "h2_boundary"
    | "comment_limit"
    | "prompt_size_limit";
};

export type ReviewQueueExclusionSummary = {
  awaitingChatgptResponse: number;
  awaitingHumanReview: number;
  blocked: number;
  blockedAnchor: number;
  blockedLifecycle: number;
  deferred: number;
  laterSections: number;
  readyNotSelected: number;
  resolved: number;
};

export type ReviewQueue = {
  algorithmVersion: typeof REVIEW_QUEUE_ALGORITHM_VERSION;
  comments: ReviewQueueComment[];
  documentGeneration: number;
  documentId: string;
  exclusionSummary: ReviewQueueExclusionSummary;
  projectId: string;
  proposal: ReviewQueueProposal | null;
  queueCounts: ReviewQueueCounts;
};

export type ReviewQueueActiveExportEvidence = {
  commentId: string;
  documentId: string;
  exportId: string;
  projectId: string;
  responseImported: boolean;
};

export type ReviewQueueFollowUpEvidence = {
  commentId: string;
  documentId: string;
  kind: "continue_discussion" | "explicit_assistant_request";
  projectId: string;
  requestedAt?: string;
  sourceId: string;
};

export type ReviewQueuePromptPreviewBuilder = (input: {
  batchType: ReviewQueueProposal["batchType"];
  selectedCommentIds: string[];
}) => string;

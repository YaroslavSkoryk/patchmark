import type { PatchmarkComment } from "@/lib/project/project-types";
import type {
  CommentReviewReasonCode,
  CommentReviewState,
  ReviewQueue,
  ReviewQueueComment,
  ReviewQueueProposal,
  ReviewQueueSelectionReason
} from "@/lib/review-queue/review-queue-types";

const stateLabels: Record<CommentReviewState, string> = {
  awaiting_chatgpt_response: "Awaiting ChatGPT",
  awaiting_human_review: "Awaiting your review",
  blocked: "Blocked",
  deferred: "Deferred",
  ready_for_chatgpt: "Ready for ChatGPT",
  resolved: "Resolved"
};

const reasonLabels: Record<CommentReviewReasonCode, string> = {
  active_exported_request: "An exported request is still awaiting a response.",
  anchor_ambiguous: "The current document contains more than one possible anchor.",
  anchor_unresolved: "The comment anchor cannot be resolved in the current document.",
  assistant_reply: "The latest meaningful turn is an assistant reply.",
  clarification_question: "The assistant asked a clarification question.",
  continue_discussion: "A structured Continue discussion follow-up requests another turn.",
  deferred: "The comment is in the supplied deferred set.",
  explicit_assistant_request: "A structured follow-up requests another assistant pass.",
  explicit_no_change: "The latest import recorded an explicit no-change response.",
  human_reply: "A human reply follows the latest assistant contribution.",
  lifecycle_ambiguous: "Legacy export history is incomplete or ambiguous.",
  new_comment: "The new comment has no assistant contribution yet.",
  no_meaningful_turn: "No supported meaningful conversational turn was found.",
  patch_proposal: "The latest assistant contribution is a patch proposal.",
  resolved: "The comment is resolved by the human.",
  unsupported_comment_state: "The stored comment status is not supported."
};

const stopReasonLabels: Record<ReviewQueueProposal["stopReason"], string> = {
  comment_limit: "Stopped at the five-comment limit.",
  document_level_only: "Document-level comments are reviewed individually.",
  follow_up_only: "Follow-ups are reviewed individually in Phase 1.",
  h2_boundary: "Stopped before crossing into another H2 section.",
  prompt_size_limit: "Stopped before the complete prompt would exceed the size limit.",
  section_exhausted: "Included every eligible comment in this section."
};

export function GuidedReviewPreview({
  comments,
  documentTitle,
  onClose,
  queue
}: {
  comments: PatchmarkComment[];
  documentTitle: string;
  onClose: () => void;
  queue: ReviewQueue;
}) {
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  const selectedIds = new Set(queue.proposal?.commentIds ?? []);

  return (
    <div className="snapshot-dialog-backdrop">
      <section
        aria-label="Guided Review Preview"
        className="comment-export-dialog guided-review-preview-dialog"
      >
        <header className="snapshot-dialog-header">
          <div>
            <span>Dry run only</span>
            <h2>Guided Review Preview</h2>
            <p>
              Proposes the next batch without marking, exporting, saving, or
              changing any project data.
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="guided-review-preview-body">
          <div className="guided-review-document">
            <span>Active document</span>
            <strong>{documentTitle}</strong>
            <small>
              Queue algorithm v{queue.algorithmVersion} · generation{" "}
              {queue.documentGeneration}
            </small>
          </div>

          <dl className="guided-review-counts" aria-label="Review queue counts">
            {(Object.keys(stateLabels) as CommentReviewState[]).map((state) => (
              <div key={state} data-state={state}>
                <dt>{stateLabels[state]}</dt>
                <dd>{queue.queueCounts[state]}</dd>
              </div>
            ))}
          </dl>

          <section
            className="guided-review-proposal"
            aria-label="Suggested next batch"
          >
            <header>
              <div>
                <span>Suggested next batch</span>
                <h3>{getProposalTitle(queue.proposal)}</h3>
              </div>
              {queue.proposal ? (
                <strong>
                  {queue.proposal.commentIds.length} comment
                  {queue.proposal.commentIds.length === 1 ? "" : "s"}
                </strong>
              ) : null}
            </header>

            {queue.proposal ? (
              <>
                <p>
                  Estimated complete prompt: approximately{" "}
                  {queue.proposal.estimatedPromptTokens.toLocaleString()} tokens
                </p>
                {queue.proposal.overLimitWarning ? (
                  <p className="guided-review-warning">
                    The first eligible comment exceeds the configured prompt-size
                    limit, so it is proposed alone with a warning.
                  </p>
                ) : null}
                <div className="guided-review-why">
                  <strong>Why</strong>
                  <ul>
                    {queue.proposal.selectionReasons.map((reason, index) => (
                      <li key={`${reason.code}:${index}`}>
                        {getSelectionReasonLabel(reason)}
                      </li>
                    ))}
                    <li>{stopReasonLabels[queue.proposal.stopReason]}</li>
                  </ul>
                </div>
                <ol className="guided-review-comment-list">
                  {queue.proposal.commentIds.map((commentId) => {
                    const queueComment = queue.comments.find(
                      (comment) => comment.commentId === commentId
                    );
                    const comment = commentsById.get(commentId);
                    return queueComment && comment ? (
                      <GuidedReviewCommentCard
                        comment={comment}
                        key={commentId}
                        queueComment={queueComment}
                      />
                    ) : null;
                  })}
                </ol>
              </>
            ) : (
              <p>No comment currently requests another ChatGPT turn.</p>
            )}
          </section>

          <details className="guided-review-classifications">
            <summary>All comment classifications</summary>
            <ol className="guided-review-comment-list">
              {queue.comments.map((queueComment) => {
                const comment = commentsById.get(queueComment.commentId);
                return comment ? (
                  <GuidedReviewCommentCard
                    comment={comment}
                    isSelected={selectedIds.has(queueComment.commentId)}
                    key={queueComment.commentId}
                    queueComment={queueComment}
                  />
                ) : null;
              })}
            </ol>
          </details>
        </div>
      </section>
    </div>
  );
}

function GuidedReviewCommentCard({
  comment,
  isSelected = true,
  queueComment
}: {
  comment: PatchmarkComment;
  isSelected?: boolean;
  queueComment: ReviewQueueComment;
}) {
  return (
    <li className="guided-review-comment-card" data-selected={isSelected}>
      <header>
        <strong>{comment.id}</strong>
        <span data-state={queueComment.state}>{stateLabels[queueComment.state]}</span>
      </header>
      <p>{comment.comment}</p>
      <dl>
        <div>
          <dt>Anchor</dt>
          <dd>{getAnchorExcerpt(comment)}</dd>
        </div>
        <div>
          <dt>Section</dt>
          <dd>
            {queueComment.sectionHeadingSnapshot ??
              (comment.anchor.kind === "document"
                ? "Whole document"
                : "Document introduction")}
          </dd>
        </div>
        <div>
          <dt>Classification</dt>
          <dd>{reasonLabels[queueComment.reasonCode]}</dd>
        </div>
      </dl>
    </li>
  );
}

function getProposalTitle(proposal: ReviewQueueProposal | null): string {
  if (!proposal) {
    return "No batch proposed";
  }
  if (proposal.batchType === "follow_up") {
    return "Earliest explicit follow-up";
  }
  if (proposal.batchType === "document_level") {
    return "Whole-document review";
  }
  return proposal.sectionHeadingSnapshot ?? "Document introduction";
}

function getSelectionReasonLabel(reason: ReviewQueueSelectionReason): string {
  switch (reason.code) {
    case "explicit_follow_up_priority":
      return "Selected the earliest eligible explicit follow-up.";
    case "earliest_eligible_comment":
      return "Started with the earliest eligible comment in document order.";
    case "document_level_isolated":
      return "Kept the document-level comment in its own batch.";
    case "same_h2_section":
      return "Grouped only eligible comments from the same H2 section.";
    case "within_comment_limit":
      return `Kept the batch within the ${reason.maximum}-comment limit.`;
    case "within_prompt_size_limit":
      return `Kept the complete prompt within approximately ${reason.maximumEstimatedTokens.toLocaleString()} tokens.`;
    case "first_comment_exceeds_prompt_size":
      return `Proposed the oversized first comment despite the approximately ${reason.maximumEstimatedTokens.toLocaleString()}-token limit.`;
  }
}

function getAnchorExcerpt(comment: PatchmarkComment): string {
  if (comment.anchor.kind === "document") {
    return "Whole document";
  }
  if (comment.anchor.kind === "section") {
    return comment.anchor.heading;
  }
  return comment.anchor.selected_text;
}

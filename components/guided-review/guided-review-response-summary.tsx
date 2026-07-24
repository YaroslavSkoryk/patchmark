import { useEffect, useRef } from "react";
import type { PatchmarkComment } from "@/lib/project/project-types";
import type {
  PatchmarkReviewBatch,
  ReviewResponseCommentOutcome
} from "@/lib/review-batches/review-batch-types";

export function GuidedReviewResponseSummary({
  batch,
  comments,
  isBusy,
  onAcknowledge,
  onClose,
  onReviewComment
}: {
  batch: PatchmarkReviewBatch;
  comments: PatchmarkComment[];
  isBusy: boolean;
  onAcknowledge: () => void;
  onClose: () => void;
  onReviewComment: (commentId: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const analysis = batch.response_analysis;
  const commentsById = new Map(
    comments.map((comment) => [comment.id, comment])
  );
  const firstAddressedCommentId =
    analysis?.ordered_comment_outcomes.find((outcome) => outcome.addressed)
      ?.comment_id ?? null;

  useEffect(() => {
    headingRef.current?.focus();
  }, [batch.batch_id]);

  return (
    <section
      aria-label="Review Batch response summary"
      className="guided-review-step"
    >
      <header>
        <span>Response imported</span>
        <h3 ref={headingRef} tabIndex={-1}>
          Review response summary
        </h3>
        <p>
          {batch.source === "manual" ? "Manual selection" : "Guided Review"} ·{" "}
          {getBatchContext(batch)}
        </p>
      </header>

      {analysis ? (
        <>
          <p
            className={
              analysis.coverage_status === "complete"
                ? "guided-review-response-complete"
                : "guided-review-warning"
            }
            role="status"
          >
            {analysis.coverage_status === "complete"
              ? "ChatGPT addressed every comment in this batch."
              : `ChatGPT did not address ${
                  analysis.aggregate.unanswered_comments
                } comment${
                  analysis.aggregate.unanswered_comments === 1 ? "" : "s"
                } in this batch. ${
                  analysis.aggregate.unanswered_comments === 1
                    ? "That comment"
                    : "Those comments"
                } can return to the Guided Review queue after you continue.`}
          </p>
          <dl
            aria-label="Imported response counts"
            className="guided-review-response-counts"
          >
            <SummaryCount
              label="Comments addressed"
              value={`${analysis.aggregate.addressed_comments} of ${analysis.aggregate.expected_comments}`}
            />
            <SummaryCount
              label="Replies added"
              value={analysis.aggregate.replies_added}
            />
            <SummaryCount
              label="Patch proposals"
              value={analysis.aggregate.patch_proposals_added}
            />
            <SummaryCount
              label="Clarification questions"
              value={analysis.aggregate.clarification_questions}
            />
            <SummaryCount
              label="Unanswered comments"
              value={analysis.aggregate.unanswered_comments}
            />
          </dl>
          <ol
            aria-label="Per-comment response outcomes"
            className="guided-review-response-outcomes"
          >
            {analysis.ordered_comment_outcomes.map((outcome) => (
              <ResponseOutcome
                comment={commentsById.get(outcome.comment_id)}
                isBusy={isBusy}
                key={outcome.comment_id}
                onReview={() => onReviewComment(outcome.comment_id)}
                outcome={outcome}
              />
            ))}
          </ol>
        </>
      ) : (
        <div className="guided-review-warning" role="status">
          <strong>Detailed response coverage is unavailable.</strong>
          <p>
            This historical response receipt does not have enough exact import
            provenance to reconstruct per-comment counts safely. Patchmark has
            not guessed from the comments&apos; full history.
          </p>
        </div>
      )}

      <p className="guided-review-response-acknowledgment-note">
        Continuing only acknowledges this workflow step. Replies and patches
        remain available for your review.
      </p>
      <div className="guided-review-wizard-actions">
        <button
          disabled={isBusy || !firstAddressedCommentId}
          onClick={() =>
            firstAddressedCommentId &&
            onReviewComment(firstAddressedCommentId)
          }
          type="button"
        >
          Review responses
        </button>
        <button disabled={isBusy} onClick={onAcknowledge} type="button">
          Continue to next batch
        </button>
        <button disabled={isBusy} onClick={onClose} type="button">
          Close Guided Review
        </button>
      </div>
    </section>
  );
}

function ResponseOutcome({
  comment,
  isBusy,
  onReview,
  outcome
}: {
  comment: PatchmarkComment | undefined;
  isBusy: boolean;
  onReview: () => void;
  outcome: ReviewResponseCommentOutcome;
}) {
  const contributionLabels = [
    formatContribution(outcome.reply_count, "reply", "replies"),
    formatContribution(
      outcome.patch_count,
      "patch proposal",
      "patch proposals"
    ),
    formatContribution(
      outcome.clarification_count,
      "clarification question",
      "clarification questions"
    ),
    formatContribution(
      outcome.explicit_no_change_count,
      "explicit no-change response",
      "explicit no-change responses"
    )
  ].filter((label): label is string => Boolean(label));

  return (
    <li className="guided-review-comment-card">
      <header>
        <strong>{outcome.comment_id}</strong>
        <span data-state={outcome.addressed ? "addressed" : "unanswered"}>
          {outcome.addressed ? "Addressed" : "Unanswered"}
        </span>
      </header>
      {comment ? <p>{comment.comment}</p> : null}
      <p>
        {outcome.addressed
          ? contributionLabels.join(" · ")
          : "This comment received no reply, patch, or clarification in the imported response."}
      </p>
      {outcome.clarification_count > 0 ? (
        <small>Clarification requested</small>
      ) : null}
      <div className="guided-review-card-actions">
        <button
          aria-label={`Review comment ${outcome.comment_id}`}
          disabled={isBusy || !comment}
          onClick={onReview}
          type="button"
        >
          Review comment
        </button>
      </div>
    </li>
  );
}

function SummaryCount({
  label,
  value
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatContribution(
  count: number,
  singular: string,
  plural: string
): string | null {
  if (count === 0) {
    return null;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

function getBatchContext(batch: PatchmarkReviewBatch): string {
  if (batch.section?.heading_snapshot) {
    return batch.section.heading_snapshot;
  }
  if (batch.batch_type === "document_level") {
    return "Whole document";
  }
  if (batch.source === "manual") {
    return "Original manual order";
  }
  return "Document introduction";
}

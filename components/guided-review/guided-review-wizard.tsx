import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { PatchmarkComment } from "@/lib/project/project-types";
import type { PatchmarkReviewBatch } from "@/lib/review-batches/review-batch-types";
import {
  addCommentToGuidedReviewSession,
  createGuidedReviewProposalSession,
  getGuidedReviewAdditionOptions,
  isGuidedReviewSessionCurrent,
  removeCommentFromGuidedReviewSession,
  restoreRemovedCommentToGuidedReviewSession,
  type GuidedReviewProposalSession
} from "@/lib/review-queue/guided-review-session";
import { estimateCompletePromptTokens } from "@/lib/review-queue/prompt-preview-estimator";
import type {
  CommentReviewReasonCode,
  CommentReviewState,
  ReviewQueue,
  ReviewQueueComment,
  ReviewQueuePromptPreviewBuilder,
  ReviewQueueProposal,
  ReviewQueueSelectionReason
} from "@/lib/review-queue/review-queue-types";

type WizardStep =
  | "queue_overview"
  | "proposal"
  | "active_exported_batch"
  | "response_received";

const stateLabels: Record<CommentReviewState, string> = {
  awaiting_chatgpt_response: "Awaiting ChatGPT",
  awaiting_human_review: "Awaiting your review",
  blocked: "Blocked",
  deferred: "Deferred",
  ready_for_chatgpt: "Ready for ChatGPT",
  resolved: "Resolved"
};

const reasonLabels: Record<CommentReviewReasonCode, string> = {
  active_exported_request: "Included in the active exported batch.",
  anchor_ambiguous: "More than one current anchor is possible.",
  anchor_unresolved: "The comment needs re-anchoring before export.",
  assistant_reply: "The latest meaningful turn is a ChatGPT reply.",
  clarification_question: "ChatGPT asked a clarification question.",
  continue_discussion: "A structured follow-up requests another ChatGPT turn.",
  deferred: "Deferred until you explicitly return it to the queue.",
  explicit_assistant_request: "A structured follow-up requests another ChatGPT pass.",
  explicit_no_change: "The latest import recorded an explicit no-change response.",
  human_reply: "A human reply is ready for another ChatGPT turn.",
  lifecycle_ambiguous: "Legacy export history is incomplete or ambiguous.",
  new_comment: "This open comment has not received a ChatGPT response.",
  no_meaningful_turn: "No supported meaningful conversation turn was found.",
  patch_proposal: "A ChatGPT patch proposal is awaiting human review.",
  resolved: "The comment is resolved.",
  unsupported_comment_state: "This stored comment state is not supported."
};

const stopReasonLabels: Record<ReviewQueueProposal["stopReason"], string> = {
  comment_limit: "Stopped at the five-comment limit.",
  document_level_only: "Whole-document comments are reviewed individually.",
  follow_up_only: "Explicit follow-ups are reviewed individually.",
  h2_boundary: "Stopped before crossing into another H2 section.",
  prompt_size_limit: "Stopped before exceeding the prompt-size limit.",
  section_exhausted: "Included every eligible comment in this section."
};

export function GuidedReviewWizard({
  activeBatch,
  buildPromptPreview,
  comments,
  deferredCommentIds,
  documentChangedSinceExport,
  documentTitle,
  generationBlockedReason,
  isBusy,
  onCancelBatch,
  onClose,
  onCopyPrompt,
  onDeferComment,
  onGenerateTrackedPrompt,
  onImportResponse,
  onOpenContextPack,
  onReanchorComment,
  onRestoreDeferredComment,
  onReviewComments,
  queue,
  responseReceivedBatch,
  workingStateKey
}: {
  activeBatch: PatchmarkReviewBatch | null;
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  comments: PatchmarkComment[];
  deferredCommentIds: ReadonlySet<string>;
  documentChangedSinceExport: boolean;
  documentTitle: string;
  generationBlockedReason: string | null;
  isBusy: boolean;
  onCancelBatch: () => void;
  onClose: () => void;
  onCopyPrompt: () => void;
  onDeferComment: (commentId: string) => Promise<void>;
  onGenerateTrackedPrompt: (
    session: GuidedReviewProposalSession
  ) => Promise<void>;
  onImportResponse: () => void;
  onOpenContextPack: () => void;
  onReanchorComment: (commentId: string) => void;
  onRestoreDeferredComment: (commentId: string) => Promise<void>;
  onReviewComments: () => void;
  queue: ReviewQueue;
  responseReceivedBatch: PatchmarkReviewBatch | null;
  workingStateKey: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<WizardStep>(
    activeBatch ? "active_exported_batch" : "queue_overview"
  );
  const [session, setSession] = useState<GuidedReviewProposalSession | null>(
    null
  );
  const [sessionWorkingStateKey, setSessionWorkingStateKey] = useState<
    string | null
  >(null);
  const [observedBatchId, setObservedBatchId] = useState<string | null>(
    activeBatch?.batch_id ?? null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const commentsById = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments]
  );
  const isSessionStale = Boolean(
    session &&
      (sessionWorkingStateKey !== workingStateKey ||
        !isGuidedReviewSessionCurrent({ queue, session }))
  );
  const additionOptions = useMemo(
    () =>
      session
        ? getGuidedReviewAdditionOptions({
            buildPromptPreview,
            queue,
            session
          })
        : [],
    [buildPromptPreview, queue, session]
  );

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    setSession(null);
    setSessionWorkingStateKey(null);
    setActionError(null);
    setObservedBatchId(null);
    setStep("queue_overview");
  }, [queue.documentId, queue.projectId]);

  useEffect(() => {
    if (activeBatch) {
      setObservedBatchId(activeBatch.batch_id);
      setStep("active_exported_batch");
      setSession(null);
    }
  }, [activeBatch]);

  useEffect(() => {
    if (!observedBatchId || activeBatch) {
      return;
    }
    if (
      responseReceivedBatch?.batch_id === observedBatchId &&
      responseReceivedBatch.status === "response_received"
    ) {
      setStep("response_received");
    } else {
      setObservedBatchId(null);
      setStep("queue_overview");
    }
    setSession(null);
  }, [activeBatch, observedBatchId, responseReceivedBatch]);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !isBusy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function prepareProposal() {
    const nextSession = createGuidedReviewProposalSession({
      buildPromptPreview,
      queue
    });
    if (!nextSession) {
      setActionError("No comment is currently ready for a new ChatGPT batch.");
      return;
    }
    setSession(nextSession);
    setSessionWorkingStateKey(workingStateKey);
    setActionError(null);
    setAnnouncement(
      `Prepared ${nextSession.selectedCommentIds.length} comments for review.`
    );
    setStep("proposal");
  }

  function resetSuggestion() {
    const nextSession = createGuidedReviewProposalSession({
      buildPromptPreview,
      queue
    });
    setSession(nextSession);
    setSessionWorkingStateKey(workingStateKey);
    setActionError(null);
    setAnnouncement("Restored Patchmark's deterministic suggestion.");
  }

  function removeFromProposal(commentId: string) {
    if (!session) {
      return;
    }
    setSession(
      removeCommentFromGuidedReviewSession({
        buildPromptPreview,
        commentId,
        queue,
        session
      })
    );
    setActionError(null);
    setAnnouncement(
      `${commentId} was removed from this batch and remains in the review queue.`
    );
  }

  function addToProposal(commentId: string, restoreRemoved = false) {
    if (!session) {
      return;
    }
    try {
      setSession(
        restoreRemoved
          ? restoreRemovedCommentToGuidedReviewSession({
              buildPromptPreview,
              commentId,
              queue,
              session
            })
          : addCommentToGuidedReviewSession({
              buildPromptPreview,
              commentId,
              queue,
              session
            })
      );
      setActionError(null);
      setAnnouncement(`${commentId} was added in document order.`);
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  }

  async function deferComment(commentId: string) {
    setActionError(null);
    try {
      await onDeferComment(commentId);
      setSession(null);
      setSessionWorkingStateKey(null);
      setStep("queue_overview");
      setAnnouncement(
        `${commentId} is deferred. It remains open and no review data was deleted.`
      );
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  }

  async function restoreDeferred(commentId: string) {
    setActionError(null);
    try {
      await onRestoreDeferredComment(commentId);
      setAnnouncement(
        `${commentId} was returned to lifecycle-based queue classification.`
      );
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  }

  async function generatePrompt() {
    if (!session) {
      return;
    }
    if (isSessionStale) {
      setActionError(
        "This review suggestion is out of date because the document or comments changed."
      );
      return;
    }
    try {
      setActionError(null);
      await onGenerateTrackedPrompt(session);
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  }

  return (
    <div className="snapshot-dialog-backdrop guided-review-wizard-backdrop">
      <section
        aria-describedby="guided-review-wizard-description"
        aria-label="Guided Review Wizard"
        aria-modal="true"
        className="comment-export-dialog guided-review-wizard-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="snapshot-dialog-header">
          <div>
            <span>Document review</span>
            <h2>Guided Review</h2>
            <p id="guided-review-wizard-description">
              Understand the queue, adjust one deterministic proposal, and
              generate an exact tracked prompt for this document.
            </p>
          </div>
          <button
            disabled={isBusy}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Close Guided Review
          </button>
        </header>

        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
        <div className="guided-review-wizard-body">
          <DocumentIdentity
            documentTitle={documentTitle}
            queue={queue}
            step={step}
          />
          {actionError ? (
            <p className="guided-review-error" role="alert">
              {actionError}
            </p>
          ) : null}

          {step === "queue_overview" ? (
            <QueueOverview
              commentsById={commentsById}
              deferredCommentIds={deferredCommentIds}
              isBusy={isBusy}
              onPrepare={prepareProposal}
              onReanchor={onReanchorComment}
              onRestore={(commentId) => void restoreDeferred(commentId)}
              onReviewComments={onReviewComments}
              queue={queue}
            />
          ) : null}

          {step === "proposal" && session ? (
            <ProposalStep
              additionOptions={additionOptions}
              buildPromptPreview={buildPromptPreview}
              commentsById={commentsById}
              generationBlockedReason={generationBlockedReason}
              isBusy={isBusy}
              isStale={isSessionStale}
              onAdd={addToProposal}
              onBack={() => {
                setSession(null);
                setStep("queue_overview");
              }}
              onDefer={(commentId) => void deferComment(commentId)}
              onGenerate={() => void generatePrompt()}
              onRefresh={resetSuggestion}
              onRemove={removeFromProposal}
              onReset={resetSuggestion}
              queue={queue}
              session={session}
            />
          ) : null}

          {step === "active_exported_batch" && activeBatch ? (
            <ActiveBatchStep
              batch={activeBatch}
              documentChangedSinceExport={documentChangedSinceExport}
              isBusy={isBusy}
              onCancel={onCancelBatch}
              onCopy={onCopyPrompt}
              onImport={onImportResponse}
              onOpen={onOpenContextPack}
            />
          ) : null}

          {step === "response_received" ? (
            <ResponseReceivedStep
              onClose={onClose}
              onReviewComments={onReviewComments}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DocumentIdentity({
  documentTitle,
  queue,
  step
}: {
  documentTitle: string;
  queue: ReviewQueue;
  step: WizardStep;
}) {
  return (
    <div className="guided-review-document">
      <span>Document</span>
      <strong>{documentTitle}</strong>
      <small>
        {getStepLabel(step)} · Queue algorithm v{queue.algorithmVersion} ·
        generation {queue.documentGeneration}
      </small>
    </div>
  );
}

function QueueOverview({
  commentsById,
  deferredCommentIds,
  isBusy,
  onPrepare,
  onReanchor,
  onRestore,
  onReviewComments,
  queue
}: {
  commentsById: Map<string, PatchmarkComment>;
  deferredCommentIds: ReadonlySet<string>;
  isBusy: boolean;
  onPrepare: () => void;
  onReanchor: (commentId: string) => void;
  onRestore: (commentId: string) => void;
  onReviewComments: () => void;
  queue: ReviewQueue;
}) {
  const blockedComments = queue.comments.filter(
    (comment) => comment.state === "blocked"
  );
  const deferredComments = queue.comments.filter((comment) =>
    deferredCommentIds.has(comment.commentId)
  );
  const noReady = queue.queueCounts.ready_for_chatgpt === 0;
  const blockedOnly =
    noReady &&
    queue.queueCounts.blocked > 0 &&
    queue.queueCounts.awaiting_human_review === 0 &&
    queue.queueCounts.deferred === 0;

  return (
    <section aria-label="Review queue overview" className="guided-review-step">
      <header>
        <span>Step 1</span>
        <h3>Review queue overview</h3>
        <p>These counts come directly from the Phase 1 lifecycle engine.</p>
      </header>
      <dl className="guided-review-counts" aria-label="Review queue counts">
        {(Object.keys(stateLabels) as CommentReviewState[]).map((state) => (
          <div key={state} data-state={state}>
            <dt>{stateLabels[state]}</dt>
            <dd>{queue.queueCounts[state]}</dd>
          </div>
        ))}
      </dl>
      <div className="guided-review-category-explanations">
        <p>
          <strong>Awaiting your review:</strong>{" "}
          {queue.queueCounts.awaiting_human_review} comments already have a
          ChatGPT reply, question, or patch proposal.
        </p>
        <p>
          <strong>Awaiting ChatGPT:</strong>{" "}
          {queue.queueCounts.awaiting_chatgpt_response} comments belong to the
          active exported batch.
        </p>
        <p>
          <strong>Blocked:</strong> {queue.queueCounts.blocked} comments need a
          safe anchor or lifecycle correction.
        </p>
      </div>

      {blockedOnly ? (
        <div className="guided-review-empty-state">
          <h4>No comments can be exported safely</h4>
          <p>{blockedComments.length} comments require attention first.</p>
        </div>
      ) : noReady ? (
        <div className="guided-review-empty-state">
          <h4>No comments are ready for ChatGPT</h4>
          <p>
            {queue.queueCounts.awaiting_human_review} await your review and{" "}
            {queue.queueCounts.deferred} are deferred.
          </p>
        </div>
      ) : null}

      {blockedComments.length > 0 ? (
        <details className="guided-review-detail-list">
          <summary>Blocked comments — {blockedComments.length}</summary>
          <ul>
            {blockedComments.map((queueComment) => (
              <li key={queueComment.commentId}>
                <div>
                  <strong>{queueComment.commentId}</strong>
                  <p>{commentsById.get(queueComment.commentId)?.comment}</p>
                  <small>{reasonLabels[queueComment.reasonCode]}</small>
                </div>
                {queueComment.anchorAvailability !== "not_required" ? (
                  <button
                    disabled={isBusy}
                    onClick={() => onReanchor(queueComment.commentId)}
                    type="button"
                  >
                    Re-anchor comment
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {deferredComments.length > 0 ? (
        <details className="guided-review-detail-list">
          <summary>Deferred comments — {deferredComments.length}</summary>
          <ul>
            {deferredComments.map((queueComment) => (
              <li key={queueComment.commentId}>
                <div>
                  <strong>{queueComment.commentId}</strong>
                  <p>{commentsById.get(queueComment.commentId)?.comment}</p>
                  <small>
                    Deferred comments stay open until you return them to queue
                    classification.
                  </small>
                </div>
                <button
                  disabled={isBusy}
                  onClick={() => onRestore(queueComment.commentId)}
                  type="button"
                >
                  Return to queue
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="guided-review-wizard-actions">
        {queue.proposal ? (
          <button disabled={isBusy} onClick={onPrepare} type="button">
            Prepare next batch
          </button>
        ) : null}
        {queue.queueCounts.awaiting_human_review > 0 ? (
          <button disabled={isBusy} onClick={onReviewComments} type="button">
            Review comments awaiting you
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ProposalStep({
  additionOptions,
  buildPromptPreview,
  commentsById,
  generationBlockedReason,
  isBusy,
  isStale,
  onAdd,
  onBack,
  onDefer,
  onGenerate,
  onRefresh,
  onRemove,
  onReset,
  queue,
  session
}: {
  additionOptions: ReturnType<typeof getGuidedReviewAdditionOptions>;
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  commentsById: Map<string, PatchmarkComment>;
  generationBlockedReason: string | null;
  isBusy: boolean;
  isStale: boolean;
  onAdd: (commentId: string, restoreRemoved?: boolean) => void;
  onBack: () => void;
  onDefer: (commentId: string) => void;
  onGenerate: () => void;
  onRefresh: () => void;
  onRemove: (commentId: string) => void;
  onReset: () => void;
  queue: ReviewQueue;
  session: GuidedReviewProposalSession;
}) {
  const queueById = new Map(
    queue.comments.map((comment) => [comment.commentId, comment])
  );
  const removedIds = new Set(session.transientlyRemovedCommentIds);
  const visibleAdditionOptions = additionOptions.filter(
    (option) => !removedIds.has(option.commentId)
  );

  return (
    <section aria-label="Proposed review batch" className="guided-review-step">
      <header>
        <span>Step 2</span>
        <h3>Next review batch</h3>
        <p>
          {getBatchTypeLabel(session.batchType)} ·{" "}
          {session.sectionHeadingSnapshot ??
            (session.batchType === "document_level"
              ? "Whole document"
              : "Document introduction")}
        </p>
      </header>

      {isStale ? (
        <div className="guided-review-stale" role="status">
          <strong>This review suggestion is out of date.</strong>
          <p>The document, comments, or queue state changed.</p>
          <button disabled={isBusy} onClick={onRefresh} type="button">
            Refresh suggestion
          </button>
        </div>
      ) : null}

      <div className="guided-review-proposal-summary">
        <dl>
          <div>
            <dt>Selected</dt>
            <dd>{session.selectedCommentIds.length} comments</dd>
          </div>
          <div>
            <dt>Estimated prompt</dt>
            <dd>
              Approximately {session.estimatedPromptTokens.toLocaleString()} tokens
            </dd>
          </div>
        </dl>
        {session.overLimitWarning ? (
          <p className="guided-review-warning">
            The first eligible comment exceeds the prompt-size limit and remains
            available alone under the established Phase 1 rule.
          </p>
        ) : null}
      </div>

      <div className="guided-review-why">
        <strong>Why these comments</strong>
        <ul>
          {queue.proposal?.selectionReasons.map((reason, index) => (
            <li key={`${reason.code}:${index}`}>
              {getSelectionReasonLabel(reason)}
            </li>
          ))}
          {queue.proposal ? (
            <li>{stopReasonLabels[queue.proposal.stopReason]}</li>
          ) : null}
        </ul>
      </div>

      <div className="guided-review-why">
        <strong>Not included</strong>
        <ul>
          <li>{queue.exclusionSummary.laterSections} ready comments are in later sections.</li>
          <li>{queue.exclusionSummary.awaitingHumanReview} comments await your review.</li>
          <li>{queue.exclusionSummary.blockedAnchor} comments require re-anchoring.</li>
          <li>{queue.exclusionSummary.deferred} comments are deferred.</li>
        </ul>
      </div>

      <ol className="guided-review-comment-list">
        {session.selectedCommentIds.map((commentId) => {
          const comment = commentsById.get(commentId);
          const queueComment = queueById.get(commentId);
          return comment && queueComment ? (
            <WizardCommentCard
              buildPromptPreview={buildPromptPreview}
              comment={comment}
              disabled={isBusy || isStale}
              key={commentId}
              onDefer={() => onDefer(commentId)}
              onRemove={() => onRemove(commentId)}
              queueComment={queueComment}
              session={session}
            />
          ) : null;
        })}
      </ol>

      {session.selectedCommentIds.length === 0 ? (
        <p className="guided-review-warning">
          At least one comment is required. Reset the suggestion or return a
          removed comment before generating.
        </p>
      ) : null}

      {session.transientlyRemovedCommentIds.length > 0 ? (
        <section className="guided-review-adjustment-section">
          <h4>Removed from this batch</h4>
          <p>These comments remain Ready for ChatGPT in the review queue.</p>
          <ul>
            {session.transientlyRemovedCommentIds.map((commentId) => (
              <li key={commentId}>
                <span>{commentId}</span>
                <button
                  disabled={isBusy || isStale}
                  onClick={() => onAdd(commentId, true)}
                  type="button"
                >
                  Return to this batch
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {session.batchType === "section" && visibleAdditionOptions.length > 0 ? (
        <section className="guided-review-adjustment-section">
          <h4>
            Other ready comments in{" "}
            {session.sectionHeadingSnapshot ?? "Document introduction"}
          </h4>
          <ul>
            {visibleAdditionOptions.map((option) => (
              <li key={option.commentId}>
                <div>
                  <strong>{option.commentId}</strong>
                  <p>{commentsById.get(option.commentId)?.comment}</p>
                  <small>
                    With this comment: approximately{" "}
                    {option.estimatedPromptTokens.toLocaleString()} tokens
                    {option.unavailableReason
                      ? ` · ${option.unavailableReason}`
                      : ""}
                  </small>
                </div>
                <button
                  aria-label={`Add ${option.commentId} to this batch`}
                  disabled={isBusy || isStale || !option.available}
                  onClick={() => onAdd(option.commentId)}
                  type="button"
                >
                  Add to batch
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {generationBlockedReason ? (
        <p className="guided-review-warning">{generationBlockedReason}</p>
      ) : null}
      <div className="guided-review-wizard-actions">
        <button
          disabled={
            isBusy ||
            isStale ||
            session.selectedCommentIds.length === 0 ||
            Boolean(generationBlockedReason)
          }
          onClick={onGenerate}
          type="button"
        >
          Generate prompt for this batch
        </button>
        <button disabled={isBusy} onClick={onReset} type="button">
          Reset suggestion
        </button>
        <button disabled={isBusy} onClick={onBack} type="button">
          Back to queue overview
        </button>
      </div>
    </section>
  );
}

function WizardCommentCard({
  buildPromptPreview,
  comment,
  disabled,
  onDefer,
  onRemove,
  queueComment,
  session
}: {
  buildPromptPreview: ReviewQueuePromptPreviewBuilder;
  comment: PatchmarkComment;
  disabled: boolean;
  onDefer: () => void;
  onRemove: () => void;
  queueComment: ReviewQueueComment;
  session: GuidedReviewProposalSession;
}) {
  const standaloneTokens = estimateCompletePromptTokens(
    buildPromptPreview({
      batchType: session.batchType,
      selectedCommentIds: [comment.id]
    })
  );
  return (
    <li className="guided-review-comment-card" data-selected="true">
      <header>
        <strong>{comment.id}</strong>
        <span data-state={queueComment.state}>
          {getCommentKindLabel(queueComment, comment)}
        </span>
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
          <dt>Why ready</dt>
          <dd>{reasonLabels[queueComment.reasonCode]}</dd>
        </div>
        <div>
          <dt>Approximate contribution</dt>
          <dd>{standaloneTokens.toLocaleString()} standalone prompt tokens</dd>
        </div>
      </dl>
      <div className="guided-review-card-actions">
        <button disabled={disabled} onClick={onRemove} type="button">
          Remove from this batch
        </button>
        <button disabled={disabled} onClick={onDefer} type="button">
          Defer comment
        </button>
      </div>
      <small>Removing keeps this comment in the queue. Deferring persists.</small>
    </li>
  );
}

function ActiveBatchStep({
  batch,
  documentChangedSinceExport,
  isBusy,
  onCancel,
  onCopy,
  onImport,
  onOpen
}: {
  batch: PatchmarkReviewBatch;
  documentChangedSinceExport: boolean;
  isBusy: boolean;
  onCancel: () => void;
  onCopy: () => void;
  onImport: () => void;
  onOpen: () => void;
}) {
  return (
    <section aria-label="Active Review Batch" className="guided-review-step">
      <header>
        <span>Step 3</span>
        <h3>Batch awaiting ChatGPT response</h3>
        <p>
          Source: {batch.source === "manual" ? "Manual selection" : "Guided Review"}
        </p>
      </header>
      <dl className="guided-review-batch-details">
        <div>
          <dt>Document</dt>
          <dd>{batch.document_title_snapshot}</dd>
        </div>
        <div>
          <dt>Section</dt>
          <dd>
            {batch.section?.heading_snapshot ??
              (batch.batch_type === "document_level"
                ? "Whole document"
                : "Manual selection")}
          </dd>
        </div>
        <div>
          <dt>Comments</dt>
          <dd>{batch.ordered_comment_ids.length}</dd>
        </div>
        <div>
          <dt>Exported</dt>
          <dd>{new Date(batch.exported_at).toLocaleString()}</dd>
        </div>
      </dl>
      <p className="guided-review-warning">
        This prompt is an exported snapshot. Copy and open actions use the exact
        committed context pack and never regenerate it.
      </p>
      {documentChangedSinceExport ? (
        <p className="guided-review-stale">
          The document has changed since this prompt was generated.
        </p>
      ) : null}
      <ol className="guided-review-comment-list">
        {batch.ordered_comment_ids.map((commentId) => (
          <li className="guided-review-comment-card" key={commentId}>
            <header>
              <strong>{commentId}</strong>
              <span data-state="awaiting_chatgpt_response">Awaiting ChatGPT</span>
            </header>
          </li>
        ))}
      </ol>
      <div className="guided-review-wizard-actions">
        <button disabled={isBusy} onClick={onCopy} type="button">
          Copy prompt again
        </button>
        <button disabled={isBusy} onClick={onOpen} type="button">
          Open saved context pack
        </button>
        <button disabled={isBusy} onClick={onImport} type="button">
          Import response
        </button>
        <button disabled={isBusy} onClick={onCancel} type="button">
          Cancel batch
        </button>
      </div>
    </section>
  );
}

function ResponseReceivedStep({
  onClose,
  onReviewComments
}: {
  onClose: () => void;
  onReviewComments: () => void;
}) {
  return (
    <section aria-label="Review Batch response received" className="guided-review-step">
      <header>
        <span>Response received</span>
        <h3>Response imported</h3>
        <p>The response was attached to this Review Batch.</p>
      </header>
      <p>
        Review the imported replies and patch proposals in the comment panel.
        Detailed response completeness and progression belong to Phase 4.
      </p>
      <div className="guided-review-wizard-actions">
        <button onClick={onReviewComments} type="button">
          Review comments
        </button>
        <button onClick={onClose} type="button">
          Close Guided Review
        </button>
      </div>
    </section>
  );
}

function getSelectionReasonLabel(reason: ReviewQueueSelectionReason): string {
  switch (reason.code) {
    case "explicit_follow_up_priority":
      return "Selected the earliest eligible explicit follow-up.";
    case "earliest_eligible_comment":
      return "Started with the earliest eligible comment in document order.";
    case "document_level_isolated":
      return "Kept the whole-document comment in its own batch.";
    case "same_h2_section":
      return "Grouped only eligible comments from the same H2 section.";
    case "within_comment_limit":
      return `Kept the batch within the ${reason.maximum}-comment limit.`;
    case "within_prompt_size_limit":
      return `Kept the complete prompt within approximately ${reason.maximumEstimatedTokens.toLocaleString()} tokens.`;
    case "first_comment_exceeds_prompt_size":
      return `Kept the oversized first comment under the established approximately ${reason.maximumEstimatedTokens.toLocaleString()}-token exception.`;
  }
}

function getCommentKindLabel(
  queueComment: ReviewQueueComment,
  comment: PatchmarkComment
): string {
  if (queueComment.explicitFollowUp) {
    return "Follow-up";
  }
  if (comment.anchor.kind === "document") {
    return "Whole document";
  }
  return "Section comment";
}

function getBatchTypeLabel(
  batchType: GuidedReviewProposalSession["batchType"]
): string {
  if (batchType === "follow_up") {
    return "Follow-up batch";
  }
  if (batchType === "document_level") {
    return "Whole-document batch";
  }
  return "Section batch";
}

function getStepLabel(step: WizardStep): string {
  if (step === "queue_overview") {
    return "Queue overview";
  }
  if (step === "proposal") {
    return "Proposed batch";
  }
  if (step === "active_exported_batch") {
    return "Active exported batch";
  }
  return "Response received";
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Guided Review could not complete this action.";
}

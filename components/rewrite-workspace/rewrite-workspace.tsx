"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { MarkdownSelection } from "@/components/markdown-source-editor";
import {
  RewriteComparisonEditor,
  type RewriteEditorMode
} from "@/components/rewrite-workspace/rewrite-comparison-editor";
import { RewriteModeControl } from "@/components/rewrite-workspace/rewrite-mode-control";
import {
  buildRewriteReviewRequest,
  cancelAwaitingRewriteReview,
  getCurrentRewriteReview,
  importRewriteReview,
  updateRewriteDraft
} from "@/lib/rewrite-workspace/rewrite-review-protocol";
import type { RewriteImpactAnalysis } from "@/lib/rewrite-workspace/rewrite-impact-analysis";
import {
  RewriteSessionPersistenceError,
  type RewriteRecoveryConflict,
  type RewriteProjectSaveResult
} from "@/lib/rewrite-workspace/rewrite-session-persistence";
import type {
  RewriteReviewRound,
  RewriteSession,
  RewriteSuggestedDraftEdit
} from "@/lib/rewrite-workspace/rewrite-session-types";

export type RewriteWorkspaceImpactResult =
  | { status: "ready"; analysis: RewriteImpactAnalysis }
  | { status: "stale"; message: string };

type RewriteWorkspaceProps = {
  isApplying: boolean;
  onAnalyzeImpact: (
    session: RewriteSession
  ) => Promise<RewriteWorkspaceImpactResult>;
  onApply: (
    session: RewriteSession,
    analysis: RewriteImpactAnalysis
  ) => Promise<void>;
  onClose: () => void;
  onDiscard: (session: RewriteSession) => Promise<void>;
  onRefreshReference: (session: RewriteSession) => Promise<RewriteSession>;
  onPersistSession: (
    session: RewriteSession,
    reason: string
  ) => Promise<RewriteProjectSaveResult>;
  onSessionChange: (session: RewriteSession) => void;
  session: RewriteSession;
  initialPersistenceSource?: "project" | "recovery_only";
};

type SaveState =
  | "idle"
  | "saving"
  | "saved"
  | "saved_recovery_unavailable"
  | "recovery_only"
  | "failed";
type WorkspaceTab = "current" | "draft" | "review";

export function RewriteWorkspace({
  isApplying,
  onAnalyzeImpact,
  onApply,
  onClose,
  onDiscard,
  onPersistSession,
  onRefreshReference,
  onSessionChange,
  session,
  initialPersistenceSource = "project"
}: RewriteWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const draftPaneRef = useRef<HTMLElement | null>(null);
  const saveRequestRef = useRef(0);
  const persistOnUnmountRef = useRef(true);
  const latestDraftRef = useRef(session.human_draft);
  const latestIntentRef = useRef(session.intent_note);
  const latestSessionRef = useRef(session);
  const onPersistSessionRef = useRef(onPersistSession);
  const [workingSession, setWorkingSession] = useState(session);
  const [humanDraft, setHumanDraft] = useState(session.human_draft);
  const [intentNote, setIntentNote] = useState(session.intent_note);
  const [saveState, setSaveState] = useState<SaveState>(
    initialPersistenceSource === "project" ? "saved" : "recovery_only"
  );
  const [editorMode, setEditorMode] = useState<RewriteEditorMode>("visual");
  const [draftSelection, setDraftSelection] = useState<MarkdownSelection>({
    end: 0,
    start: 0
  });
  const [draftSelectionRequest, setDraftSelectionRequest] = useState<
    (MarkdownSelection & { nonce: number }) | null
  >(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("draft");
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [promptRound, setPromptRound] = useState<RewriteReviewRound | null>(
    () =>
      [...session.review_rounds]
        .reverse()
        .find((round) => round.status === "awaiting_response") ?? null
  );
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [impact, setImpact] = useState<RewriteImpactAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentReview = useMemo(
    () => getCurrentRewriteReview(workingSession),
    [workingSession]
  );
  const importedRounds = useMemo(
    () => workingSession.review_rounds.filter((round) => round.response),
    [workingSession.review_rounds]
  );
  latestDraftRef.current = humanDraft;
  latestIntentRef.current = intentNote;
  latestSessionRef.current = workingSession;
  onPersistSessionRef.current = onPersistSession;

  const commitLocalDraft = useCallback(async () => {
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    setSaveState("saving");
    try {
      const nextSession = await updateRewriteDraft({
        humanDraft,
        intentNote,
        session: workingSession
      });
      const persisted = await onPersistSessionRef.current(
        nextSession,
        "autosave_human_rewrite_draft"
      );
      if (requestId !== saveRequestRef.current) {
        return persisted.session;
      }
      setWorkingSession(persisted.session);
      onSessionChange(persisted.session);
      setSaveState(
        persisted.recoveryAvailable ? "saved" : "saved_recovery_unavailable"
      );
      return persisted.session;
    } catch (saveError) {
      if (requestId === saveRequestRef.current) {
        const recoverySaved =
          saveError instanceof RewriteSessionPersistenceError &&
          saveError.recoverySaved;
        setSaveState(recoverySaved ? "recovery_only" : "failed");
        setError(getErrorMessage(saveError));
      }
      throw saveError;
    }
  }, [humanDraft, intentNote, onSessionChange, workingSession]);

  useEffect(() => {
    if (
      humanDraft === workingSession.human_draft &&
      intentNote === workingSession.intent_note
    ) {
      return;
    }
    setSaveState("idle");
    const timeoutId = window.setTimeout(() => {
      void commitLocalDraft().catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timeoutId);
  }, [commitLocalDraft, humanDraft, intentNote, workingSession]);

  useEffect(() => {
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const backgroundElements = Array.from(body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        !element.contains(workspaceRef.current) &&
        element !== workspaceRef.current
    );
    const inertStates = backgroundElements.map((element) => ({
      element,
      inert: element.inert
    }));
    body.style.overflow = "hidden";
    backgroundElements.forEach((element) => {
      element.inert = true;
    });
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (document.querySelector(".rewrite-dialog")) {
        return;
      }
      if (event.key !== "Tab" || !workspaceRef.current) {
        return;
      }
      const controls = Array.from(
        workspaceRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      const latestSession = latestSessionRef.current;
      if (
        persistOnUnmountRef.current &&
        (latestDraftRef.current !== latestSession.human_draft ||
          latestIntentRef.current !== latestSession.intent_note)
      ) {
        void updateRewriteDraft({
          humanDraft: latestDraftRef.current,
          intentNote: latestIntentRef.current,
          session: latestSession
        })
          .then((nextSession) =>
            onPersistSessionRef.current(nextSession, "flush_human_rewrite_on_close")
          )
          .catch(() => undefined);
      }
      body.style.overflow = previousOverflow;
      inertStates.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    function flushPendingDraft() {
      const latestSession = latestSessionRef.current;
      if (
        latestDraftRef.current === latestSession.human_draft &&
        latestIntentRef.current === latestSession.intent_note
      ) {
        return;
      }
      void updateRewriteDraft({
        humanDraft: latestDraftRef.current,
        intentNote: latestIntentRef.current,
        session: latestSession
      })
        .then((nextSession) =>
          onPersistSessionRef.current(nextSession, "flush_human_rewrite_page_hidden")
        )
        .catch(() => undefined);
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        flushPendingDraft();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushPendingDraft);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushPendingDraft);
    };
  }, []);

  async function handleExportReview() {
    setError(null);
    try {
      const savedSession = await commitLocalDraft();
      const awaitingRound = savedSession.review_rounds.find(
        (round) => round.status === "awaiting_response"
      );
      if (awaitingRound) {
        setPromptRound(awaitingRound);
        setActiveTab("review");
        return;
      }
      const request = await buildRewriteReviewRequest(savedSession);
      const persisted = await onPersistSessionRef.current(
        request.session,
        "export_human_rewrite_review_prompt"
      );
      setWorkingSession(persisted.session);
      onSessionChange(persisted.session);
      setSaveState(
        persisted.recoveryAvailable ? "saved" : "saved_recovery_unavailable"
      );
      setPromptRound(
        persisted.session.review_rounds.find(
          (round) => round.rewrite_review_id === request.rewrite_review_id
        ) ?? null
      );
      setActiveTab("review");
    } catch (reviewError) {
      setError(getErrorMessage(reviewError));
    }
  }

  async function handleCancelAwaitingReview() {
    const nextSession = cancelAwaitingRewriteReview(workingSession);
    const persisted = await onPersistSessionRef.current(
      nextSession,
      "cancel_human_rewrite_review_request"
    );
    setWorkingSession(persisted.session);
    onSessionChange(persisted.session);
    setSaveState(
      persisted.recoveryAvailable ? "saved" : "saved_recovery_unavailable"
    );
    setPromptRound(null);
  }

  async function handleImportReview() {
    setError(null);
    try {
      const savedSession = await commitLocalDraft();
      const imported = importRewriteReview({
        responseText: importText,
        session: savedSession
      });
      const persisted = await onPersistSessionRef.current(
        imported.session,
        "import_human_rewrite_semantic_review"
      );
      setWorkingSession(persisted.session);
      onSessionChange(persisted.session);
      setSaveState(
        persisted.recoveryAvailable ? "saved" : "saved_recovery_unavailable"
      );
      setPromptRound(null);
      setImportText("");
      setIsImportOpen(false);
      setActiveTab("review");
    } catch (importError) {
      setError(getErrorMessage(importError));
    }
  }

  async function handleAnalyzeImpact() {
    setIsAnalyzing(true);
    setError(null);
    try {
      const savedSession = await commitLocalDraft();
      if (!savedSession.human_draft.trim()) {
        throw new Error("My rewrite cannot be empty in this version of Patchmark.");
      }
      const result = await onAnalyzeImpact(savedSession);
      if (result.status === "stale") {
        const staleSession = {
          ...savedSession,
          stale_reference: true,
          updated_at: new Date().toISOString()
        };
        const persisted = await onPersistSessionRef.current(
          staleSession,
          "mark_human_rewrite_reference_stale"
        );
        setWorkingSession(persisted.session);
        onSessionChange(persisted.session);
        setImpact(null);
        setError(result.message);
        return;
      }
      setImpact(result.analysis);
    } catch (impactError) {
      setError(getErrorMessage(impactError));
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleRefreshReference() {
    setError(null);
    try {
      const savedSession = await commitLocalDraft();
      const refreshed = await onRefreshReference(savedSession);
      setWorkingSession(refreshed);
      setHumanDraft(refreshed.human_draft);
      setIntentNote(refreshed.intent_note);
      onSessionChange(refreshed);
      setImpact(null);
      setSaveState("saved");
    } catch (refreshError) {
      setError(getErrorMessage(refreshError));
    }
  }

  async function handleApply() {
    if (!impact) {
      return;
    }
    setError(null);
    persistOnUnmountRef.current = false;
    try {
      await onApply(workingSession, impact);
    } catch (applyError) {
      persistOnUnmountRef.current = true;
      setError(getErrorMessage(applyError));
    }
  }

  async function handleDiscardDraft() {
    setError(null);
    try {
      const savedSession = await commitLocalDraft();
      persistOnUnmountRef.current = false;
      await onDiscard(savedSession);
    } catch (discardError) {
      persistOnUnmountRef.current = true;
      setError(getErrorMessage(discardError));
    }
  }

  async function handleKeepDraftAndClose() {
    try {
      await commitLocalDraft();
      persistOnUnmountRef.current = false;
      onClose();
    } catch {
      return;
    }
  }

  function handleEditorModeChange(nextMode: RewriteEditorMode) {
    if (nextMode === editorMode) {
      return;
    }
    if (nextMode === "markdown") {
      setDraftSelectionRequest({
        ...draftSelection,
        nonce: Date.now()
      });
    }
    setEditorMode(nextMode);
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        const editor = draftPaneRef.current?.querySelector<HTMLElement>(
          '.patchmark-prose, textarea:not([readonly])'
        );
        editor?.focus({ preventScroll: true });
      }, 0);
    });
  }

  function handleHumanDraftChange(nextDraft: string) {
    setHumanDraft(nextDraft);
    setImpact(null);
  }

  function locateDraftExcerpt(item: RewriteSuggestedDraftEdit) {
    const start = humanDraft.indexOf(item.draft_excerpt);
    if (start === -1) {
      setError("That reviewed excerpt is not present in the current human draft.");
      return;
    }
    setActiveTab("draft");
    setDraftSelection({
      end: start + item.draft_excerpt.length,
      start
    });
    setDraftSelectionRequest({
      end: start + item.draft_excerpt.length,
      nonce: Date.now(),
      start
    });
    setEditorMode("markdown");
  }

  return createPortal(
    <div className="rewrite-workspace-backdrop" data-testid="rewrite-workspace">
      <section
        ref={workspaceRef}
        aria-describedby="rewrite-workspace-description"
        aria-label="Human Rewrite Review Workspace"
        aria-modal="true"
        className="rewrite-workspace"
        role="dialog"
      >
        <header className="rewrite-workspace-header">
          <div>
            <span>Human-authored document change</span>
            <h2>Rewrite Workspace</h2>
            <p id="rewrite-workspace-description">
              You write the replacement. ChatGPT can compare meaning, but it never
              edits or applies your draft automatically.
            </p>
          </div>
          <div className="rewrite-workspace-header-actions">
            <span aria-live="polite" className={`rewrite-save-state rewrite-save-${saveState}`}>
              {getSaveLabel(saveState)}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setIsCloseDialogOpen(true)}
            >
              Close
            </button>
          </div>
        </header>

        <div className="rewrite-workspace-identity">
          <span>{workingSession.document_title_snapshot}</span>
          <strong>
            {workingSession.target.heading_snapshot ?? "Selected document text"}
          </strong>
          <span>
            {workingSession.target.kind === "section" ? "Complete section" : "Selected text"}
          </span>
        </div>

        <RewriteModeControl
          mode={editorMode}
          onChange={handleEditorModeChange}
        />

        <div aria-label="Rewrite workspace views" className="rewrite-workspace-tabs" role="tablist">
          {(["current", "draft", "review"] as WorkspaceTab[]).map((tab) => (
            <button
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "active" : undefined}
              key={tab}
              onClick={() => setActiveTab(tab)}
              role="tab"
              type="button"
            >
              {tab === "current" ? "Current text" : tab === "draft" ? "My rewrite" : "Review"}
            </button>
          ))}
        </div>

        <div className="rewrite-workspace-body" data-active-tab={activeTab}>
          <section aria-label="Current document text" className="rewrite-text-pane rewrite-current-pane">
            <header>
              <div>
                <span>Read-only reference</span>
                <h3>Current document text</h3>
              </div>
              <span>{workingSession.base_text.length.toLocaleString()} characters</span>
            </header>
            <RewriteComparisonEditor
              ariaLabel={
                editorMode === "visual"
                  ? "Current document text Visual reference"
                  : "Current document text Markdown reference"
              }
              markdown={workingSession.base_text}
              mode={editorMode}
              onMarkdownChange={() => undefined}
              readOnly
              resetKey={0}
            />
          </section>

          <section
            ref={draftPaneRef}
            aria-label="My rewrite"
            className="rewrite-text-pane rewrite-draft-pane"
          >
            <header>
              <div>
                <span>Human-authored draft</span>
                <h3>My rewrite</h3>
              </div>
              <div className="rewrite-pane-header-actions">
                <span>{humanDraft.length.toLocaleString()} characters</span>
                <button
                  className="rewrite-clear-draft"
                  type="button"
                  onClick={() => {
                    if (window.confirm("Clear your rewrite draft? The current document text will remain unchanged.")) {
                      handleHumanDraftChange("");
                    }
                  }}
                >
                  Clear my rewrite
                </button>
              </div>
            </header>
            <RewriteComparisonEditor
              ariaLabel={
                editorMode === "visual"
                  ? "My rewrite Visual editor"
                  : "My rewrite Markdown editor"
              }
              id="rewrite-human-draft"
              markdown={humanDraft}
              mode={editorMode}
              onMarkdownChange={handleHumanDraftChange}
              onSelectionChange={setDraftSelection}
              readOnly={false}
              resetKey={0}
              selectionRequest={draftSelectionRequest}
            />
          </section>

          <section aria-label="Rewrite review" className="rewrite-review-pane">
            <header>
              <div>
                <span>Relative to the supplied current text</span>
                <h3>ChatGPT review</h3>
              </div>
              <span>{importedRounds.length} round{importedRounds.length === 1 ? "" : "s"}</span>
            </header>
            <ReviewPanel
              currentReview={currentReview}
              humanDraftHash={workingSession.human_draft_sha256}
              importedRounds={importedRounds}
              onLocate={locateDraftExcerpt}
            />
          </section>
        </div>

        <section className="rewrite-intent-panel">
          <label htmlFor="rewrite-intent-note">
            What are you trying to improve or change? <span>Optional</span>
          </label>
          <textarea
            id="rewrite-intent-note"
            placeholder="For example: preserve the conclusions but simplify the explanation."
            value={intentNote}
            onChange={(event) => setIntentNote(event.target.value)}
          />
        </section>

        {error ? (
          <div className="rewrite-workspace-error" role="alert">
            <strong>{error}</strong>
            {error.includes("changed after the rewrite session began") ? (
              <button type="button" onClick={() => void handleRefreshReference()}>
                Refresh current text
              </button>
            ) : null}
          </div>
        ) : null}

        {saveState === "recovery_only" ? (
          <div className="rewrite-workspace-warning" role="status">
            <strong>This draft is stored only as a browser recovery copy.</strong>
            <span>
              It may be lost if browser data is cleared or the project is opened elsewhere.
            </span>
          </div>
        ) : null}
        {saveState === "failed" ? (
          <div className="rewrite-workspace-warning" role="status">
            <strong>Unsaved changes</strong>
            <span>Project save failed and the browser recovery copy is unavailable.</span>
          </div>
        ) : null}

        <footer className="rewrite-workspace-footer">
          <div>
            <button
              disabled={isApplying || isAnalyzing}
              type="button"
              onClick={() => void handleExportReview()}
            >
              Review meaning with ChatGPT
            </button>
            <button type="button" onClick={() => setIsImportOpen(true)}>
              Import semantic review
            </button>
          </div>
          <div>
            <button
              disabled={isApplying || isAnalyzing || !humanDraft.trim()}
              type="button"
              onClick={() => void handleAnalyzeImpact()}
            >
              {isAnalyzing ? "Analyzing impact…" : "Apply rewrite"}
            </button>
          </div>
        </footer>

        {promptRound ? (
          <WorkspaceDialog title="Manual ChatGPT review prompt" onClose={() => setPromptRound(null)}>
            <p>
              Copy this exact prompt to ChatGPT. Patchmark does not send it automatically.
            </p>
            <textarea aria-label="Semantic review prompt" readOnly value={promptRound.prompt_text} />
            <div className="rewrite-dialog-actions">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(promptRound.prompt_text)}
              >
                Copy prompt
              </button>
              <button type="button" onClick={() => void handleCancelAwaitingReview()}>
                Cancel request
              </button>
              <button type="button" onClick={() => setPromptRound(null)}>Done</button>
            </div>
          </WorkspaceDialog>
        ) : null}

        {isImportOpen ? (
          <WorkspaceDialog title="Import ChatGPT semantic review" onClose={() => setIsImportOpen(false)}>
            <p>Paste the structured review JSON for an exported rewrite review request.</p>
            <textarea
              aria-label="Semantic review response JSON"
              placeholder="Paste one fenced JSON response or a JSON object."
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <div className="rewrite-dialog-actions">
              <button type="button" onClick={() => setIsImportOpen(false)}>Cancel</button>
              <button disabled={!importText.trim()} type="button" onClick={() => void handleImportReview()}>
                Import review
              </button>
            </div>
          </WorkspaceDialog>
        ) : null}

        {impact ? (
          <WorkspaceDialog title="Apply human rewrite?" onClose={() => setImpact(null)}>
            <RewriteImpactSummary analysis={impact} session={workingSession} />
            {!currentReview ? (
              <p className="rewrite-review-warning">
                This draft has not been reviewed against its current reference text.
              </p>
            ) : null}
            <p>
              This creates one human-authored document version. It will not resolve comments or accept patches.
            </p>
            <div className="rewrite-dialog-actions">
              <button disabled={isApplying} type="button" onClick={() => setImpact(null)}>Cancel</button>
              <button disabled={isApplying} type="button" onClick={() => void handleApply()}>
                {isApplying ? "Applying rewrite…" : "Apply rewrite"}
              </button>
            </div>
          </WorkspaceDialog>
        ) : null}

        {isCloseDialogOpen ? (
          <WorkspaceDialog title="Close Rewrite Workspace?" onClose={() => setIsCloseDialogOpen(false)}>
            <p>Your saved human draft remains project review data until you apply or discard it.</p>
            <div className="rewrite-dialog-actions">
              <button type="button" onClick={() => setIsCloseDialogOpen(false)}>Cancel</button>
              <button
                type="button"
                onClick={() => void handleDiscardDraft()}
              >
                Discard draft
              </button>
              <button
                type="button"
                onClick={() => void handleKeepDraftAndClose()}
              >
                Keep draft and close
              </button>
            </div>
          </WorkspaceDialog>
        ) : null}
      </section>
    </div>,
    document.body
  );
}

export function RewriteResumeBanner({
  onDiscard,
  onResume,
  session
}: {
  onDiscard: () => void;
  onResume: () => void;
  session: RewriteSession;
}) {
  return (
    <section aria-label="Rewrite draft available" className="rewrite-resume-banner">
      <div>
        <span>Rewrite draft available</span>
        <strong>{session.document_title_snapshot}</strong>
        <p>{session.target.heading_snapshot ?? "Selected document text"}</p>
      </div>
      <div>
        <button type="button" onClick={onResume}>Resume rewrite</button>
        <button type="button" onClick={onDiscard}>Discard rewrite draft</button>
      </div>
    </section>
  );
}

export function RewriteRecoveryConflictBanner({
  conflict,
  onCancel,
  onRecover,
  onUseProject
}: {
  conflict: RewriteRecoveryConflict;
  onCancel: () => void;
  onRecover: () => void;
  onUseProject: () => void;
}) {
  return (
    <section aria-label="Newer rewrite recovery found" className="rewrite-recovery-conflict">
      <div>
        <span>Newer recovery found</span>
        <strong>A browser recovery draft differs from the project draft.</strong>
        <p>No version was selected or merged automatically.</p>
        <dl>
          <div>
            <dt>Project draft saved</dt>
            <dd>{formatRecoveryTime(conflict.projectSavedAt)}</dd>
          </div>
          <div>
            <dt>Browser recovery saved</dt>
            <dd>{formatRecoveryTime(conflict.recoverySavedAt)}</dd>
          </div>
          <div>
            <dt>Project hash</dt>
            <dd>{conflict.projectSession?.human_draft_sha256 ?? "No project draft"}</dd>
          </div>
          <div>
            <dt>Recovery hash</dt>
            <dd>{conflict.recoverySession.human_draft_sha256}</dd>
          </div>
        </dl>
        <details>
          <summary>Review differences</summary>
          <div className="rewrite-recovery-comparison">
            <section>
              <h4>Project draft</h4>
              <pre>{conflict.projectSession?.human_draft ?? "No project draft"}</pre>
            </section>
            <section>
              <h4>Browser recovery draft</h4>
              <pre>{conflict.recoverySession.human_draft}</pre>
            </section>
          </div>
        </details>
      </div>
      <div>
        <button type="button" onClick={onUseProject}>Use project draft</button>
        <button type="button" onClick={onRecover}>Recover browser draft</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function ReviewPanel({
  currentReview,
  humanDraftHash,
  importedRounds,
  onLocate
}: {
  currentReview: RewriteReviewRound | null;
  humanDraftHash: string;
  importedRounds: RewriteReviewRound[];
  onLocate: (item: RewriteSuggestedDraftEdit) => void;
}) {
  const round = currentReview ?? importedRounds.at(-1) ?? null;
  const response = round?.response;
  if (!response) {
    return (
      <div className="rewrite-review-empty">
        <p>No semantic review imported for this draft.</p>
        <span>Review is optional. The human remains the author and final decision-maker.</span>
      </div>
    );
  }
  const isCurrent = round.human_draft_sha256 === humanDraftHash && Boolean(currentReview);
  return (
    <div className="rewrite-review-content">
      <div className={isCurrent ? "rewrite-review-current" : "rewrite-review-historical"}>
        <strong>{isCurrent ? "Current draft review" : "Review of an earlier draft"}</strong>
        <span>ChatGPT assessment, not independent truth verification.</span>
      </div>
      <ReviewSection title="Overall assessment">
        <strong>{formatEnum(response.overall_assessment)}</strong>
        <p>{response.summary || "No summary reported."}</p>
      </ReviewSection>
      <ReviewList title="Meaning preserved" items={response.meaning_preserved} render={(item) => item.point} />
      <ReviewList title="Meaning changed" items={response.meaning_changed} render={(item) => `${item.topic}: ${item.current_meaning} → ${item.rewrite_meaning} (${formatEnum(item.assessment)}, ${item.severity})`} />
      <ReviewList title="Important omissions" items={response.omitted_points} render={(item) => `${item.point} (${item.importance}) — ${item.reason}`} />
      <ReviewList title="New claims" items={response.new_claims} render={(item) => `${item.claim} — ${formatEnum(item.relative_support)}. ${item.note}`} />
      <ReviewList title="Contradictions" items={response.contradictions} render={(item) => `${item.issue} (${item.severity})`} />
      <ReviewList title="Certainty changes" items={response.certainty_changes} render={(item) => `${item.topic}: ${item.from} → ${item.to}. ${item.impact}`} />
      <ReviewList title="Source and citation impact" items={response.source_impacts} render={(item) => `${item.claim_or_source}: ${formatEnum(item.impact)}. ${item.note}`} />
      <ReviewList title="Ambiguities" items={response.ambiguities} render={(item) => `${item.issue} ${item.suggestion}`} />
      <ReviewSection title="Suggested edits">
        {response.suggested_draft_edits.length === 0 ? <p>None reported.</p> : (
          <ol>
            {response.suggested_draft_edits.map((item, index) => (
              <li key={`${item.draft_excerpt}-${index}`}>
                <blockquote>{item.draft_excerpt}</blockquote>
                <p>{item.suggested_text}</p>
                <span>{item.reason}</span>
                <div>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(item.suggested_text)}>Copy suggestion</button>
                  <button type="button" onClick={() => onLocate(item)}>Locate draft excerpt</button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </ReviewSection>
      {importedRounds.length > 1 ? (
        <details>
          <summary>Earlier review rounds · {importedRounds.length - 1}</summary>
          <ol>
            {importedRounds.slice(0, -1).map((item) => (
              <li key={item.rewrite_review_id}>
                {new Date(item.imported_at ?? item.exported_at).toLocaleString()} · {item.response?.summary || "No summary"}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function ReviewSection({ children, title }: { children: ReactNode; title: string }) {
  return <section className="rewrite-review-section"><h4>{title}</h4>{children}</section>;
}

function ReviewList<T>({ items, render, title }: { items: T[]; render: (item: T) => string; title: string }) {
  return (
    <ReviewSection title={title}>
      {items.length === 0 ? <p>None reported.</p> : <ul>{items.map((item, index) => <li key={index}>{render(item)}</li>)}</ul>}
    </ReviewSection>
  );
}

function RewriteImpactSummary({ analysis, session }: { analysis: RewriteImpactAnalysis; session: RewriteSession }) {
  return (
    <div className="rewrite-impact-summary">
      <dl>
        <div><dt>Target</dt><dd>{session.target.heading_snapshot ?? "Selected text"}</dd></div>
        <div><dt>Current text</dt><dd>{session.base_text.length.toLocaleString()} characters</dd></div>
        <div><dt>Human rewrite</dt><dd>{session.human_draft.length.toLocaleString()} characters</dd></div>
      </dl>
      <h4>Applying this rewrite affects</h4>
      <ul>
        <li>
          {analysis.affectedComments} comment
          {analysis.affectedComments === 1 ? "" : "s"} in this range
        </li>
        <li>{analysis.commentsExpectedSafe} likely to keep or safely transform their anchors</li>
        <li>{analysis.commentsExpectedUnresolved} likely to require re-anchoring</li>
        <li>{analysis.bookmarkAffected ? "1 reading bookmark" : "No reading bookmark in this range"}</li>
        <li>{analysis.pendingPatches} pending patch proposals will be marked Needs review</li>
        <li>{analysis.activeReviewBatchComments} comments in active exported Review Batches</li>
      </ul>
      {analysis.activeReviewBatchComments > 0 ? (
        <p>ChatGPT is currently answering comments in this range. The exported response can still import, but new patches must pass current-document review.</p>
      ) : null}
    </div>
  );
}

function WorkspaceDialog({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const controls = Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    controls[0]?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || controls.length === 0) {
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <div className="rewrite-dialog-backdrop">
      <section ref={dialogRef} aria-label={title} aria-modal="true" className="rewrite-dialog" role="dialog">
        <header><h3>{title}</h3><button aria-label={`Close ${title}`} type="button" onClick={onClose}>×</button></header>
        <div className="rewrite-dialog-body">{children}</div>
      </section>
    </div>
  );
}

function getSaveLabel(state: SaveState): string {
  if (state === "saving" || state === "idle") return "Saving to project…";
  if (state === "saved_recovery_unavailable") {
    return "Saved to project · Browser recovery unavailable";
  }
  if (state === "recovery_only") {
    return "Project save failed — recovery copy saved in this browser";
  }
  if (state === "failed") return "Unsaved changes · Recovery copy unavailable";
  return "Saved to project";
}

function formatEnum(value: string): string {
  return value.replaceAll("_", " ");
}

function formatRecoveryTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not saved in project";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

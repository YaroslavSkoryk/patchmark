"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
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
  createRewriteReviewPersistenceError,
  createRewriteReviewRepairPrompt,
  getAwaitingRewriteReview,
  getCurrentRewriteReview,
  getRewriteReviewPromptFormat,
  importRewriteReview,
  regenerateRewriteReviewRequest,
  updateRewriteDraft
} from "@/lib/rewrite-workspace/rewrite-review-protocol";
import {
  RewriteReviewValidationError,
  type RewriteReviewValidationIssue
} from "@/lib/rewrite-workspace/rewrite-review-schema";
import type { RewriteImpactAnalysis } from "@/lib/rewrite-workspace/rewrite-impact-analysis";
import {
  RewriteSessionPersistenceError,
  type RewriteRecoveryConflict,
  type RewriteProjectSaveResult
} from "@/lib/rewrite-workspace/rewrite-session-persistence";
import type {
  RewriteReviewRound,
  RewriteReviewSupersessionReason,
  RewriteSession,
  RewriteSuggestedDraftEdit
} from "@/lib/rewrite-workspace/rewrite-session-types";
import { createContentSha256 } from "@/lib/storage/document-recovery-storage";

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
    reason: string,
    recoveryFallbackSession?: RewriteSession
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
type RewritePaneTab = "current" | "draft";
type WorkspaceScreen = "rewrite" | "review";
type RewriteReviewImportFailure = {
  error: RewriteReviewValidationError;
  repairPrompt: string | null;
};
type RewriteReviewRegenerationConfirmation = {
  expectedReviewRequestId: string;
  reason: RewriteReviewSupersessionReason;
};
type RewriteHistoricalImportConfirmation = {
  responseText: string;
  reviewRequestId: string;
};

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
  const importErrorSummaryRef = useRef<HTMLDivElement | null>(null);
  const reviewGenerationRef = useRef(false);
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
  const [activePaneTab, setActivePaneTab] = useState<RewritePaneTab>("draft");
  const [activeScreen, setActiveScreen] = useState<WorkspaceScreen>("rewrite");
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [promptRound, setPromptRound] = useState<RewriteReviewRound | null>(null);
  const [isGeneratingReview, setIsGeneratingReview] = useState(false);
  const [regenerationConfirmation, setRegenerationConfirmation] =
    useState<RewriteReviewRegenerationConfirmation | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [historicalImportConfirmation, setHistoricalImportConfirmation] =
    useState<RewriteHistoricalImportConfirmation | null>(null);
  const [importFailure, setImportFailure] =
    useState<RewriteReviewImportFailure | null>(null);
  const [importAnnouncement, setImportAnnouncement] = useState("");
  const [repairCopyStatus, setRepairCopyStatus] = useState("");
  const [impact, setImpact] = useState<RewriteImpactAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intentNoteSha256, setIntentNoteSha256] = useState<string | null>(null);
  const currentReview = useMemo(
    () => getCurrentRewriteReview(workingSession),
    [workingSession]
  );
  const importedRounds = useMemo(
    () => workingSession.review_rounds.filter((round) => round.response),
    [workingSession.review_rounds]
  );
  const awaitingReview = useMemo(
    () => getAwaitingRewriteReview(workingSession),
    [workingSession]
  );
  const awaitingPromptFormat = awaitingReview
    ? getRewriteReviewPromptFormat(awaitingReview)
    : null;
  const supersededReviews = useMemo(
    () =>
      [...workingSession.review_rounds]
        .filter((round) => round.status === "superseded")
        .reverse(),
    [workingSession.review_rounds]
  );
  const latestSupersededReview = supersededReviews[0] ?? null;
  const draftChangedSinceExport = Boolean(
    awaitingReview &&
      (humanDraft !== workingSession.human_draft ||
        workingSession.human_draft_sha256 !== awaitingReview.human_draft_sha256)
  );
  const intentChangedSinceExport = Boolean(
    awaitingReview &&
      (intentNote !== workingSession.intent_note ||
        (intentNoteSha256 !== null &&
          intentNoteSha256 !== awaitingReview.intent_note_sha256))
  );
  const reviewRequestStatus = getReviewRequestStatus({
    awaitingReview,
    currentReview,
    draftChangedSinceExport,
    importedRounds,
    intentChangedSinceExport,
    latestSupersededReview
  });
  const activeRegenerationReason = awaitingReview
    ? getReviewRegenerationReason({
        draftChangedSinceExport,
        intentChangedSinceExport,
        promptFormat: awaitingPromptFormat
      })
    : null;
  const failedReviewRound = importFailure?.error.reviewRequestId
    ? workingSession.review_rounds.find(
        (round) => round.rewrite_review_id === importFailure.error.reviewRequestId
      ) ?? null
    : null;
  const canRegenerateFailedReviewRequest = Boolean(
    awaitingReview &&
      failedReviewRound?.status === "awaiting_response" &&
      failedReviewRound.rewrite_review_id === awaitingReview.rewrite_review_id
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
    if (!importFailure) {
      return;
    }
    importErrorSummaryRef.current?.focus();
  }, [importFailure]);

  useEffect(() => {
    let isCurrent = true;
    setIntentNoteSha256(null);
    void createContentSha256(intentNote).then((hash) => {
      if (isCurrent) {
        setIntentNoteSha256(hash);
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [intentNote]);

  useEffect(() => {
    if (
      humanDraft === workingSession.human_draft &&
      intentNote === workingSession.intent_note
    ) {
      return;
    }
    setSaveState("idle");
    const timeoutId = window.setTimeout(() => {
      if (reviewGenerationRef.current) {
        return;
      }
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

  function handleViewPrompt(round: RewriteReviewRound) {
    setPromptRound(round);
    setActiveScreen("review");
  }

  function requestReviewRegeneration(reason: RewriteReviewSupersessionReason) {
    const activeRequest = getAwaitingRewriteReview(workingSession);
    if (!activeRequest) {
      setError("There is no awaiting semantic-review request to regenerate.");
      return;
    }
    setRegenerationConfirmation({
      expectedReviewRequestId: activeRequest.rewrite_review_id,
      reason
    });
  }

  async function handleGenerateReviewPrompt() {
    if (reviewGenerationRef.current) {
      return;
    }
    reviewGenerationRef.current = true;
    setIsGeneratingReview(true);
    setError(null);
    try {
      const draftSession = await updateRewriteDraft({
        humanDraft,
        intentNote,
        session: workingSession
      });
      if (getAwaitingRewriteReview(draftSession)) {
        throw new Error(
          "A semantic-review request is already awaiting a response. View it or deliberately regenerate it."
        );
      }
      const request = await buildRewriteReviewRequest(draftSession);
      const persisted = await onPersistSessionRef.current(
        request.session,
        "export_human_rewrite_review_prompt",
        draftSession
      );
      publishPersistedReviewRequest(persisted, request.rewrite_review_id);
    } catch (reviewError) {
      setError(getErrorMessage(reviewError));
    } finally {
      reviewGenerationRef.current = false;
      setIsGeneratingReview(false);
    }
  }

  async function handleRegenerateReviewPrompt() {
    if (!regenerationConfirmation || reviewGenerationRef.current) {
      return;
    }
    reviewGenerationRef.current = true;
    setIsGeneratingReview(true);
    setError(null);
    try {
      const draftSession = await updateRewriteDraft({
        humanDraft,
        intentNote,
        session: workingSession
      });
      const request = await regenerateRewriteReviewRequest({
        expectedReviewRequestId:
          regenerationConfirmation.expectedReviewRequestId,
        reason: regenerationConfirmation.reason,
        session: draftSession
      });
      const persisted = await onPersistSessionRef.current(
        request.session,
        `regenerate_human_rewrite_review_prompt:${regenerationConfirmation.reason}`,
        draftSession
      );
      publishPersistedReviewRequest(persisted, request.rewrite_review_id);
      setRegenerationConfirmation(null);
    } catch (reviewError) {
      setError(
        reviewError instanceof RewriteSessionPersistenceError
          ? "The updated review prompt could not be saved to the project. The previous request remains active."
          : getErrorMessage(reviewError)
      );
    } finally {
      reviewGenerationRef.current = false;
      setIsGeneratingReview(false);
    }
  }

  function publishPersistedReviewRequest(
    persisted: RewriteProjectSaveResult,
    rewriteReviewId: string
  ) {
    setWorkingSession(persisted.session);
    onSessionChange(persisted.session);
    setSaveState(
      persisted.recoveryAvailable ? "saved" : "saved_recovery_unavailable"
    );
    setPromptRound(
      persisted.session.review_rounds.find(
        (round) => round.rewrite_review_id === rewriteReviewId
      ) ?? null
    );
    setActiveScreen("review");
    setIsImportOpen(false);
    setImportFailure(null);
    setHistoricalImportConfirmation(null);
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

  async function handleImportReview(confirmHistorical = false) {
    setError(null);
    setImportFailure(null);
    setRepairCopyStatus("");
    setImportAnnouncement("");
    const responseText = confirmHistorical && historicalImportConfirmation
      ? historicalImportConfirmation.responseText
      : importText;
    let preflight: ReturnType<typeof importRewriteReview>;
    try {
      preflight = importRewriteReview({
        responseText,
        session: workingSession
      });
    } catch (importError) {
      await showImportFailure(importError, workingSession);
      return;
    }
    if (preflight.historical && !confirmHistorical) {
      setHistoricalImportConfirmation({
        responseText,
        reviewRequestId: preflight.response.rewrite_review_id
      });
      return;
    }

    let savedSession: RewriteSession;
    try {
      savedSession = await commitLocalDraft();
    } catch (saveError) {
      setError(null);
      await showImportFailure(
        createRewriteReviewPersistenceError(saveError),
        workingSession
      );
      return;
    }

    try {
      const imported = importRewriteReview({
        responseText,
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
      setImportFailure(null);
      setHistoricalImportConfirmation(null);
      setIsImportOpen(false);
      setActiveScreen("review");
      const storedRound = persisted.session.review_rounds.find(
        (round) => round.rewrite_review_id === imported.response.rewrite_review_id
      );
      setImportAnnouncement(
        imported.current
          ? "Semantic review imported for the current Human Draft."
          : storedRound?.status === "superseded"
            ? "Semantic review imported historically for its superseded request. The active request remains unchanged."
          : "Semantic review imported as a review of an earlier Human Draft."
      );
    } catch (importError) {
      const displayedError =
        importError instanceof RewriteReviewValidationError
          ? importError
          : createRewriteReviewPersistenceError(importError);
      await showImportFailure(displayedError, savedSession);
    }
  }

  async function showImportFailure(
    importError: unknown,
    sessionForRepair: RewriteSession
  ) {
    const displayedError =
      importError instanceof RewriteReviewValidationError
        ? importError
        : createRewriteReviewPersistenceError(importError);
    const repairPrompt = await createRewriteReviewRepairPrompt({
      error: displayedError,
      responseText: historicalImportConfirmation?.responseText ?? importText,
      session: sessionForRepair
    });
    setImportFailure({ error: displayedError, repairPrompt });
    setHistoricalImportConfirmation(null);
  }

  async function handleCopyRepairPrompt() {
    if (!importFailure?.repairPrompt) {
      return;
    }
    try {
      await navigator.clipboard.writeText(importFailure.repairPrompt);
      setRepairCopyStatus("Complete repair prompt copied.");
    } catch {
      setRepairCopyStatus(
        "Clipboard access failed. Open the complete repair prompt and copy it manually."
      );
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
    setActiveScreen("rewrite");
    setActivePaneTab("draft");
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
    <div
      className="rewrite-workspace-backdrop workspace-dialog-backdrop"
      data-testid="rewrite-workspace"
    >
      <section
        ref={workspaceRef}
        aria-describedby="rewrite-workspace-description"
        aria-label="Human Rewrite Review Workspace"
        aria-modal="true"
        className="rewrite-workspace workspace-dialog-surface"
        role="dialog"
      >
        <header className="rewrite-workspace-header">
          <div className="rewrite-workspace-title">
            <span>Human-authored document change</span>
            <h2>Rewrite Workspace</h2>
            <p id="rewrite-workspace-description">
              You write the replacement. ChatGPT can compare meaning, but it never
              edits or applies your draft automatically.
            </p>
          </div>
          <div
            aria-label="Rewrite workspace screens"
            className="rewrite-workspace-navigation"
            role="tablist"
          >
            <button
              aria-controls="rewrite-workspace-rewrite-screen"
              aria-selected={activeScreen === "rewrite"}
              id="rewrite-workspace-rewrite-tab"
              role="tab"
              type="button"
              onClick={() => setActiveScreen("rewrite")}
            >
              Rewrite
            </button>
            <button
              aria-controls="rewrite-workspace-review-screen"
              aria-selected={activeScreen === "review"}
              id="rewrite-workspace-review-tab"
              role="tab"
              type="button"
              onClick={() => setActiveScreen("review")}
            >
              ChatGPT Review
            </button>
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
          <div className="rewrite-workspace-breadcrumb">
            <span>{workingSession.document_title_snapshot}</span>
            <strong>
              {workingSession.target.heading_snapshot ?? "Selected document text"}
            </strong>
            <span>
              {workingSession.target.kind === "section" ? "Complete section" : "Selected text"}
            </span>
          </div>
          {activeScreen === "rewrite" ? (
            <RewriteModeControl
              mode={editorMode}
              onChange={handleEditorModeChange}
            />
          ) : (
            <span className="rewrite-review-screen-status">
              {reviewRequestStatus}
            </span>
          )}
        </div>

        <div className="rewrite-workspace-screens">
          <section
            aria-labelledby="rewrite-workspace-rewrite-tab"
            className="rewrite-workspace-screen rewrite-workspace-rewrite-screen"
            hidden={activeScreen !== "rewrite"}
            id="rewrite-workspace-rewrite-screen"
            role="tabpanel"
          >
            <div
              aria-label="Rewrite comparison panes"
              className="rewrite-workspace-tabs"
              role="tablist"
            >
              {(["current", "draft"] as RewritePaneTab[]).map((tab) => (
                <button
                  aria-controls={`rewrite-${tab}-pane`}
                  aria-selected={activePaneTab === tab}
                  className={activePaneTab === tab ? "active" : undefined}
                  key={tab}
                  onClick={() => setActivePaneTab(tab)}
                  role="tab"
                  type="button"
                >
                  {tab === "current" ? "Current text" : "My rewrite"}
                </button>
              ))}
            </div>

            <div className="rewrite-workspace-body" data-active-tab={activePaneTab}>
              <section
                aria-label="Current document text"
                className="rewrite-text-pane rewrite-current-pane"
                id="rewrite-current-pane"
              >
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
                id="rewrite-draft-pane"
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
            </div>

            <footer className="rewrite-workspace-footer rewrite-workspace-rewrite-footer">
              <div>
                <button type="button" onClick={() => setActiveScreen("review")}>
                  ChatGPT Review
                </button>
                <span className="rewrite-compact-review-status">
                  {getCompactReviewStatus(currentReview, importedRounds.length)}
                </span>
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
          </section>

          <section
            aria-labelledby="rewrite-workspace-review-tab"
            className="rewrite-workspace-screen rewrite-workspace-review-screen"
            hidden={activeScreen !== "review"}
            id="rewrite-workspace-review-screen"
            role="tabpanel"
          >
            <div className="rewrite-review-screen-content">
              <header className="rewrite-review-screen-header">
                <div>
                  <span>Relative to the supplied current text</span>
                  <h3>ChatGPT Review</h3>
                </div>
                <div>
                  <span>{reviewRequestStatus}</span>
                  <span>{getSaveLabel(saveState)}</span>
                </div>
              </header>

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

              <section
                className={`rewrite-review-request-status rewrite-review-request-${reviewRequestStatus.toLowerCase().replaceAll(" ", "-")}`}
                data-review-request-status={reviewRequestStatus}
              >
                <div>
                  <strong>{reviewRequestStatus}</strong>
                  {reviewRequestStatus === "Prompt format outdated" ? (
                    <p>
                      This review request was created with an older response format.
                      Generate an updated prompt to use the latest structured-review schema.
                    </p>
                  ) : reviewRequestStatus === "Draft changed since export" ? (
                    <p>
                      The active request still refers to an earlier Human Draft. Its exact
                      prompt remains unchanged while you decide whether to await that response.
                    </p>
                  ) : reviewRequestStatus === "Intent changed since export" ? (
                    <p>
                      The active request contains the earlier intent note. Regenerate only
                      when you want the current intent included in a new request.
                    </p>
                  ) : reviewRequestStatus === "Awaiting response" ? (
                    <p>This exact exported request is waiting for a matching ChatGPT response.</p>
                  ) : currentReview ? (
                    <p>The current Human Draft has an imported semantic review.</p>
                  ) : importedRounds.length > 0 ? (
                    <p>Imported review history exists, but it does not validate the current Human Draft.</p>
                  ) : (
                    <p>No semantic-review prompt has been exported for this Human Draft.</p>
                  )}
                </div>
              </section>

              <section
                aria-label="Current semantic review request"
                className="rewrite-review-request-card"
              >
                <header>
                  <div>
                    <span>Current request</span>
                    <h4>{awaitingReview ? awaitingReview.rewrite_review_id : "No active request"}</h4>
                  </div>
                  {awaitingReview ? (
                    <span>{formatPromptCreatedAt(awaitingReview)}</span>
                  ) : null}
                </header>
                <div className="rewrite-review-screen-actions">
                  {awaitingReview && activeRegenerationReason ? (
                    awaitingPromptFormat === "outdated" ? (
                      <>
                        <button
                          className="rewrite-review-primary-action"
                          disabled={isApplying || isAnalyzing || isGeneratingReview}
                          type="button"
                          onClick={() => requestReviewRegeneration(activeRegenerationReason)}
                        >
                          {isGeneratingReview
                            ? "Saving review prompt…"
                            : getRegenerationActionLabel(activeRegenerationReason)}
                        </button>
                        <button type="button" onClick={() => handleViewPrompt(awaitingReview)}>
                          View old exported prompt
                        </button>
                        <button type="button" onClick={() => setIsImportOpen(true)}>
                          Import old response
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => handleViewPrompt(awaitingReview)}>
                          View current prompt
                        </button>
                        <button
                          disabled={isApplying || isAnalyzing || isGeneratingReview}
                          type="button"
                          onClick={() => requestReviewRegeneration(activeRegenerationReason)}
                        >
                          {isGeneratingReview
                            ? "Saving review prompt…"
                            : getRegenerationActionLabel(activeRegenerationReason)}
                        </button>
                        <button type="button" onClick={() => setIsImportOpen(true)}>
                          Import semantic review
                        </button>
                      </>
                    )
                  ) : (
                    <>
                      <button
                        className="rewrite-review-primary-action"
                        disabled={isApplying || isAnalyzing || isGeneratingReview}
                        type="button"
                        onClick={() => void handleGenerateReviewPrompt()}
                      >
                        {isGeneratingReview ? "Saving review prompt…" : "Generate review prompt"}
                      </button>
                      <button type="button" onClick={() => setIsImportOpen(true)}>
                        Import semantic review
                      </button>
                    </>
                  )}
                </div>
              </section>

              {supersededReviews.length > 0 ? (
                <details className="rewrite-review-request-history" open>
                  <summary>Previous requests · {supersededReviews.length}</summary>
                  <ol>
                    {supersededReviews.map((round) => (
                      <li key={round.rewrite_review_id}>
                        <div>
                          <strong>Superseded</strong>
                          <span>{formatPromptCreatedAt(round)}</span>
                          <code>{abbreviateValue(round.rewrite_review_id, 20)}</code>
                        </div>
                        <button type="button" onClick={() => handleViewPrompt(round)}>
                          View superseded prompt
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}

              {importAnnouncement ? (
                <div className="rewrite-review-import-status" role="status" aria-live="polite">
                  {importAnnouncement}
                </div>
              ) : null}

              <section aria-label="Rewrite review" className="rewrite-review-pane">
                <header>
                  <div>
                    <span>Semantic findings</span>
                    <h3>Current and previous reviews</h3>
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
          </section>
        </div>

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

        {promptRound ? (
          <WorkspaceDialog
            title={promptRound.status === "superseded" ? "Superseded review prompt" : "Current review prompt"}
            onClose={() => setPromptRound(null)}
          >
            {promptRound.status === "superseded" ? (
              <div className="rewrite-review-old-prompt-warning" role="status">
                <strong>Superseded review request</strong>
                <p>
                  This exact historical prompt remains unchanged and is not the active request.
                </p>
              </div>
            ) : getRewriteReviewPromptFormat(promptRound) === "outdated" ? (
              <div className="rewrite-review-old-prompt-warning" role="status">
                <strong>Prompt format may be outdated</strong>
                <p>This exact active prompt is preserved, but its response format is not current.</p>
              </div>
            ) : null}
            <p>
              Copy this exact prompt to ChatGPT. Patchmark does not send it automatically.
            </p>
            <dl className="rewrite-review-prompt-metadata">
              <div><dt>Review request</dt><dd>{promptRound.rewrite_review_id}</dd></div>
              <div><dt>Request state</dt><dd>{promptRound.status === "superseded" ? "Superseded" : "Current"}</dd></div>
              <div><dt>Created</dt><dd>{formatPromptCreatedAt(promptRound)}</dd></div>
              <div><dt>Prompt format</dt><dd>{promptRound.prompt_schema_version ?? "Legacy / unverified"}</dd></div>
              <div><dt>Response schema</dt><dd>{abbreviateValue(promptRound.response_schema_fingerprint ?? "Unverified")}</dd></div>
              <div><dt>Draft hash</dt><dd>{abbreviateValue(promptRound.human_draft_sha256)}</dd></div>
              <div><dt>Prompt SHA-256</dt><dd>{abbreviateValue(promptRound.prompt_sha256)}</dd></div>
              {promptRound.prompt_byte_length !== undefined ? (
                <div><dt>Exact bytes</dt><dd>{promptRound.prompt_byte_length.toLocaleString()}</dd></div>
              ) : null}
              {promptRound.superseded_reason ? (
                <div><dt>Superseded because</dt><dd>{formatSupersessionReason(promptRound.superseded_reason)}</dd></div>
              ) : null}
            </dl>
            <textarea aria-label="Semantic review prompt" readOnly value={promptRound.prompt_text} />
            <div className="rewrite-dialog-actions">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(promptRound.prompt_text)}
              >
                Copy complete prompt
              </button>
              {promptRound.status === "awaiting_response" &&
              getRewriteReviewPromptFormat(promptRound) === "current" ? (
                <button type="button" onClick={() => void handleCancelAwaitingReview()}>
                  Cancel request
                </button>
              ) : null}
              <button type="button" onClick={() => setPromptRound(null)}>Done</button>
            </div>
          </WorkspaceDialog>
        ) : null}

        {regenerationConfirmation ? (
          <WorkspaceDialog
            title={regenerationConfirmation.reason === "outdated_prompt_format"
              ? "Update review prompt?"
              : "Generate a new review prompt?"}
            onClose={() => {
              if (!isGeneratingReview) {
                setRegenerationConfirmation(null);
              }
            }}
          >
            {regenerationConfirmation.reason === "outdated_prompt_format" ? (
              <p>
                This request uses an older response format. Generate a new request using
                the latest structured-review schema.
              </p>
            ) : (
              <>
                <p>The current exported request is still awaiting a ChatGPT response.</p>
                <p>A new review request will be created using:</p>
                <ul className="rewrite-review-regeneration-list">
                  <li>the current Human Draft</li>
                  <li>the current intent note</li>
                  <li>the latest response format</li>
                </ul>
                <p>
                  The old exact prompt will remain available in review history. A response
                  for the old request will not be attached to the new request.
                </p>
              </>
            )}
            <div className="rewrite-dialog-actions">
              <button
                disabled={isGeneratingReview}
                type="button"
                onClick={() => setRegenerationConfirmation(null)}
              >
                Cancel
              </button>
              <button
                disabled={isGeneratingReview}
                type="button"
                onClick={() => void handleRegenerateReviewPrompt()}
              >
                {isGeneratingReview
                  ? "Saving review prompt…"
                  : regenerationConfirmation.reason === "outdated_prompt_format"
                    ? "Generate updated prompt"
                    : "Generate new prompt"}
              </button>
            </div>
          </WorkspaceDialog>
        ) : null}

        {isImportOpen ? (
          <WorkspaceDialog
            title="Import ChatGPT semantic review"
            onClose={() => {
              setIsImportOpen(false);
              setHistoricalImportConfirmation(null);
            }}
          >
            {historicalImportConfirmation ? (
              <div className="rewrite-review-historical-import-confirmation">
                <strong>This response belongs to a superseded review request.</strong>
                <p>
                  It can be imported as a historical review of the earlier request. It will
                  not be attached to the current active request.
                </p>
                <code>{historicalImportConfirmation.reviewRequestId}</code>
                <div className="rewrite-dialog-actions">
                  <button
                    type="button"
                    onClick={() => setHistoricalImportConfirmation(null)}
                  >
                    Cancel
                  </button>
                  <button type="button" onClick={() => void handleImportReview(true)}>
                    Import as historical review
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p>Paste the structured review JSON for an exported rewrite review request.</p>
                {importFailure ? (
                  <RewriteReviewImportErrorPanel
                    failure={importFailure}
                    onCopyRepairPrompt={() => void handleCopyRepairPrompt()}
                    onRegeneratePrompt={canRegenerateFailedReviewRequest && activeRegenerationReason
                      ? () => {
                          setIsImportOpen(false);
                          requestReviewRegeneration(activeRegenerationReason);
                        }
                      : null}
                    regenerationActionLabel={canRegenerateFailedReviewRequest && activeRegenerationReason
                      ? getRegenerationActionLabel(activeRegenerationReason)
                      : null}
                    repairCopyStatus={repairCopyStatus}
                    summaryRef={importErrorSummaryRef}
                  />
                ) : null}
                <textarea
                  aria-label="Semantic review response JSON"
                  placeholder="Paste one fenced JSON response or a JSON object."
                  value={importText}
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportFailure(null);
                    setHistoricalImportConfirmation(null);
                    setRepairCopyStatus("");
                  }}
                />
                <div className="rewrite-dialog-actions">
                  <button type="button" onClick={() => setIsImportOpen(false)}>Cancel</button>
                  <button disabled={!importText.trim()} type="button" onClick={() => void handleImportReview()}>
                    Import review
                  </button>
                </div>
              </>
            )}
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
              <button
                aria-busy={isApplying}
                disabled={isApplying}
                type="button"
                onClick={() => void handleApply()}
              >
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

function RewriteReviewImportErrorPanel({
  failure,
  onCopyRepairPrompt,
  onRegeneratePrompt,
  regenerationActionLabel,
  repairCopyStatus,
  summaryRef
}: {
  failure: RewriteReviewImportFailure;
  onCopyRepairPrompt: () => void;
  onRegeneratePrompt: (() => void) | null;
  regenerationActionLabel: string | null;
  repairCopyStatus: string;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  const firstIssue = failure.error.issues[0];
  const remainingIssues = failure.error.issues.slice(1);
  const problemCount = failure.error.issues.length;
  return (
    <div
      ref={summaryRef}
      aria-labelledby="rewrite-review-import-error-title"
      className="rewrite-review-import-error"
      data-error-code={firstIssue?.code}
      role="alert"
      tabIndex={-1}
    >
      <div className="rewrite-review-import-error-heading">
        <div>
          <h4 id="rewrite-review-import-error-title">
            Review response could not be imported
          </h4>
          <p>
            {problemCount} validation problem{problemCount === 1 ? "" : "s"}
          </p>
        </div>
        <strong>{failure.error.category.replaceAll("_", " ")}</strong>
      </div>
      {firstIssue ? <RewriteReviewIssueDetails issue={firstIssue} /> : null}
      {remainingIssues.length > 0 ? (
        <details>
          <summary>
            Show {remainingIssues.length} more validation problem
            {remainingIssues.length === 1 ? "" : "s"}
          </summary>
          <ol className="rewrite-review-import-issue-list">
            {remainingIssues.map((issue, index) => (
              <li key={`${issue.path}-${issue.code}-${index}`}>
                <RewriteReviewIssueDetails issue={issue} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <p className="rewrite-review-import-guidance">{failure.error.guidance}</p>
      {failure.repairPrompt || onRegeneratePrompt ? (
        <div className="rewrite-review-import-recovery-actions">
          {failure.repairPrompt ? (
            <p>
              Repair keeps this review request identity and asks ChatGPT to fix only
              the response structure.
            </p>
          ) : null}
          {onRegeneratePrompt ? (
            <p>
              Regeneration supersedes this request and creates a new request using the
              current draft, intent, and response format.
            </p>
          ) : null}
          <div>
            {failure.repairPrompt ? (
              <button type="button" onClick={onCopyRepairPrompt}>
                Copy repair prompt
              </button>
            ) : null}
            {onRegeneratePrompt && regenerationActionLabel ? (
              <button type="button" onClick={onRegeneratePrompt}>
                {regenerationActionLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {failure.repairPrompt ? (
        <div className="rewrite-review-repair-prompt">
          <details>
            <summary>View complete repair prompt</summary>
            <textarea
              aria-label="Complete semantic review repair prompt"
              readOnly
              value={failure.repairPrompt}
            />
          </details>
          <span aria-live="polite" role="status">{repairCopyStatus}</span>
        </div>
      ) : null}
    </div>
  );
}

function RewriteReviewIssueDetails({
  issue
}: {
  issue: RewriteReviewValidationIssue;
}) {
  return (
    <div className="rewrite-review-import-issue" data-issue-code={issue.code}>
      <code>{issue.path}</code>
      <p>{issue.message}</p>
      <dl>
        <div>
          <dt>Expected</dt>
          <dd>{issue.expected}</dd>
        </div>
        {issue.actualType ? (
          <div>
            <dt>Received</dt>
            <dd>{issue.actualType}</dd>
          </div>
        ) : null}
      </dl>
      {issue.example !== undefined ? (
        <div>
          <strong>Required shape</strong>
          <pre>{JSON.stringify(issue.example, null, 2)}</pre>
        </div>
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

function getCompactReviewStatus(
  currentReview: RewriteReviewRound | null,
  importedRoundCount: number
): string {
  if (currentReview) {
    const previousRoundCount = Math.max(0, importedRoundCount - 1);
    return previousRoundCount === 0
      ? "1 current review"
      : `1 current review · ${previousRoundCount} previous`;
  }
  if (importedRoundCount > 0) {
    return `${importedRoundCount} previous review${importedRoundCount === 1 ? "" : "s"}`;
  }
  return "No review";
}

function getReviewRequestStatus({
  awaitingReview,
  currentReview,
  draftChangedSinceExport,
  importedRounds,
  intentChangedSinceExport,
  latestSupersededReview
}: {
  awaitingReview: RewriteReviewRound | null;
  currentReview: RewriteReviewRound | null;
  draftChangedSinceExport: boolean;
  importedRounds: RewriteReviewRound[];
  intentChangedSinceExport: boolean;
  latestSupersededReview: RewriteReviewRound | null;
}):
  | "No review request"
  | "Awaiting response"
  | "Prompt format outdated"
  | "Draft changed since export"
  | "Intent changed since export"
  | "Superseded"
  | "Response imported"
  | "Earlier-draft review" {
  if (awaitingReview) {
    if (draftChangedSinceExport) {
      return "Draft changed since export";
    }
    if (intentChangedSinceExport) {
      return "Intent changed since export";
    }
    return getRewriteReviewPromptFormat(awaitingReview) === "outdated"
      ? "Prompt format outdated"
      : "Awaiting response";
  }
  if (currentReview) {
    return "Response imported";
  }
  if (importedRounds.length > 0) {
    return "Earlier-draft review";
  }
  if (latestSupersededReview) {
    return "Superseded";
  }
  return "No review request";
}

function getReviewRegenerationReason({
  draftChangedSinceExport,
  intentChangedSinceExport,
  promptFormat
}: {
  draftChangedSinceExport: boolean;
  intentChangedSinceExport: boolean;
  promptFormat: "current" | "outdated" | null;
}): RewriteReviewSupersessionReason {
  if (draftChangedSinceExport) {
    return "draft_changed";
  }
  if (intentChangedSinceExport) {
    return "intent_changed";
  }
  return promptFormat === "outdated"
    ? "outdated_prompt_format"
    : "prompt_regenerated";
}

function getRegenerationActionLabel(
  reason: RewriteReviewSupersessionReason
): string {
  if (reason === "outdated_prompt_format") {
    return "Generate updated review prompt";
  }
  if (reason === "draft_changed") {
    return "Generate prompt for current draft";
  }
  if (reason === "intent_changed") {
    return "Regenerate prompt with current intent";
  }
  return "Regenerate review prompt";
}

function formatPromptCreatedAt(round: RewriteReviewRound): string {
  return new Date(round.prompt_created_at ?? round.exported_at).toLocaleString();
}

function abbreviateValue(value: string, visibleCharacters = 8): string {
  if (value.length <= visibleCharacters + 1) {
    return value;
  }
  if (value.startsWith("sha256:")) {
    return `sha256:${value.slice(7, 7 + visibleCharacters)}…`;
  }
  return `${value.slice(0, visibleCharacters)}…`;
}

function formatSupersessionReason(
  reason: RewriteReviewSupersessionReason
): string {
  if (reason === "outdated_prompt_format") {
    return "Updated prompt format";
  }
  if (reason === "draft_changed") {
    return "Generated for the current draft";
  }
  if (reason === "intent_changed") {
    return "Generated with the current intent";
  }
  return "Prompt regenerated";
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

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  CommentsPanel,
  type ActiveCommentState,
  type CommentAddRequest,
  type CommentAnchorSummary,
  type CommentAnchorScope,
  type CommentPatchGroupSummary,
  type CommentFormValues
} from "@/components/comments-panel";
import { DocumentActions } from "@/components/document-actions";
import { MarkdownFileLoader } from "@/components/markdown-file-loader";
import {
  MarkdownSourceEditor,
  type MarkdownSelection
} from "@/components/markdown-source-editor";
import { DocumentOutline } from "@/components/document-outline";
import { DocumentStatus, type DocumentStatusKind } from "@/components/document-status";
import { DraftRestoreBanner } from "@/components/draft-restore-banner";
import {
  SnapshotDialog,
  type SnapshotDialogState
} from "@/components/snapshot-dialog";
import { VersionHistoryPanel } from "@/components/version-history-panel";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";
import { downloadMarkdown } from "@/lib/files/download-markdown";
import {
  canSaveMarkdownFilePicker,
  saveMarkdownAsFile,
  saveMarkdownToFileHandle,
  type LoadedMarkdownFile,
  type MarkdownFileHandle
} from "@/lib/files/file-system-access";
import { parseMarkdownHeadings } from "@/lib/markdown/parse-headings";
import {
  canOpenProjectFolder,
  createProjectFromMarkdown,
  createProjectSnapshot,
  listProjectVersions,
  openProjectFolder,
  readProjectVersionMarkdown,
  readProjectComments,
  readProjectPatches,
  saveProjectDocument,
  writeProjectContextPack,
  writeProjectComments,
  writeProjectImport,
  writeProjectPatches,
  type LoadedPatchmarkProject,
  type PatchmarkProjectHandle
} from "@/lib/project/patchmark-project";
import {
  type PatchmarkComment,
  type PatchmarkCommentAnchor,
  type PatchmarkCommentActionContext,
  type PatchmarkCommentActionIntent,
  type PatchCommentImpactKind,
  type PatchmarkCommentPatchImpact,
  type PatchmarkCommentType,
  type PatchmarkCommentReplyImport,
  type PatchmarkCommentThreadEntry,
  type PatchmarkPatch,
  type PatchmarkPatchAnchorRecoveryMethod,
  type PatchmarkPatchGroup,
  type PatchmarkSelectedTextAnchorContext,
  type PatchmarkSelectedTextAnchorContextKind,
  type PatchmarkSourceReference,
  type PatchmarkSuggestedUserAction,
  type PatchmarkVersionEntry
} from "@/lib/project/project-types";
import {
  deleteDocumentDraft,
  readMostRecentDocumentDraft,
  saveDocumentDraft,
  type DocumentDraft
} from "@/lib/storage/document-draft-storage";

type EditorMode = "visual" | "markdown";
type PatchReviewMode = "visual" | "markdown-source";
type SaveStatus = "idle" | "saving" | "failed" | "unavailable";
type SaveFeedback = {
  kind: "success" | "error" | "info";
  message: string;
};
type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;
type SelectedCommentAnchorDraft = {
  anchorSource: "visual" | "markdown";
  anchorContext: PatchmarkSelectedTextAnchorContext;
  markdownEndOffset?: number;
  markdownStartOffset?: number;
  selectedText: string;
};
type SelectedCommentAnchorDraftResult = {
  draft: SelectedCommentAnchorDraft | null;
  help: string | null;
};
type CommentContextMenuState = {
  defaultHeadingLine: number | null;
  selectedDraft: SelectedCommentAnchorDraft | null;
  selectionHelp: string | null;
  x: number;
  y: number;
};
type ChatGptPromptDialogState = {
  commentIds: string[];
  dedicatedDocumentReview: boolean;
  exportId: string;
  exportedAt: string;
  payloadFileName: string;
  promptFileName: string;
  jsonText: string;
  promptText: string;
};
type DocumentLevelExportGuardDialogState =
  | {
      documentCommentIds: string[];
      kind: "multiple_document_comments";
      nonDocumentCommentIds: string[];
    }
  | {
      documentCommentId: string;
      kind: "mixed_document_comment";
      nonDocumentCommentIds: string[];
    };
type MarkCommentFocusGuardDialogState =
  | {
      documentCommentIds: string[];
      kind: "mark_non_document_with_document_focus";
      targetCommentId: string;
    }
  | {
      kind: "mark_document_with_non_document_focus";
      nonDocumentCommentIds: string[];
      targetCommentId: string;
    }
  | {
      documentCommentIds: string[];
      kind: "mark_document_with_document_focus";
      nonDocumentCommentIds: string[];
      targetCommentId: string;
    };
type ChatGptImportDialogState = {
  error: string | null;
  responseJson: string;
  sourceChatUrl: string;
};
type ChatGptImportSummary = {
  openQuestionsAttached: number;
  patchProposalsStored: number;
  repliesAttached: number;
  warnings: string[];
};
type PatchApplicability =
  | "exact_match"
  | "multiple_matches"
  | "not_found"
  | "table_row_rebase_available";
type AppliedPatchAnchorStatus =
  | "empty_applied_text"
  | "evolved_after_patch"
  | "exact_match"
  | "multiple_matches"
  | "normalized_match"
  | "not_found"
  | "row_match"
  | "section_match";
type TextMatch = { end: number; start: number };
type RecoveredAnchorReason =
  | "current_offsets_match"
  | "selected_text_unique_in_section"
  | "anchor_context_unique_match"
  | "table_cell_unique_match"
  | "selected_text_unique_in_document";
type RecoveredAnchorResult =
  | {
      matchEnd: number;
      matchStart: number;
      newAnchor: SelectedTextAnchor;
      reason: RecoveredAnchorReason;
      status: "recovered";
    }
  | {
      matchCount: number;
      reason: string;
      status: "ambiguous";
    }
  | {
      reason: string;
      status: "not_found";
    };
type PatchTableRowRebaseCandidate = {
  currentRowText: string;
  end: number;
  headerRow?: string;
  searchedWholeDocument: boolean;
  separatorRow?: string;
  start: number;
};
type PatchReviewAnchorStatus =
  | {
      kind: "accepted";
      matches: TextMatch[];
      status: AppliedPatchAnchorStatus;
      text: string;
    }
  | {
      applicability: PatchApplicability;
      kind: "historical" | "pending";
      matches: TextMatch[];
      tableRowRebase?: PatchTableRowRebaseCandidate;
      text: string;
    };
type PatchmarkPatchGroupStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "needs_review";
type PatchGroupApplicabilitySummary = Record<PatchApplicability, number>;
type DerivedPatchGroup = PatchmarkPatchGroup & {
  anchor_status_by_patch_id: Record<string, PatchReviewAnchorStatus>;
  applicability_by_patch_id: Record<string, PatchApplicability>;
  applicability_summary: PatchGroupApplicabilitySummary;
  display_id: string;
  is_legacy_single_patch_group: boolean;
  status: PatchmarkPatchGroupStatus;
};
type PatchDisplayState =
  | "applied"
  | "applied_evolved"
  | "needs_review"
  | "pending"
  | "rejected"
  | "stale";
type PatchGroupListDialogState = {
  commentId: string | null;
};
type CommentPositionMeasurementInput = {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  workspace: HTMLElement | null;
};
type VisualSelectionSnapshot = {
  blockText: string;
  blockKind: PatchmarkSelectedTextAnchorContextKind;
  selectedEndInBlock?: number;
  selectedStartInBlock?: number;
  selectedText: string;
};
type VisualTextMatch = {
  range: Range;
  searchText: string;
  top: number;
};
type VisualTextPosition = {
  node: Text;
  offset: number;
};
type VisualTextIndex = {
  positions: VisualTextPosition[];
  text: string;
};
type CssHighlightRegistry = {
  delete: (name: string) => void;
  set: (name: string, highlight: unknown) => void;
};
type CssHighlightConstructor = new (...ranges: Range[]) => unknown;

const ANCHOR_CONTEXT_CHARS = 160;
const SHORT_SELECTION_HELP =
  "Could not create a reliable anchor. Try selecting a larger phrase or add a section comment.";
const COMMENT_HIGHLIGHT_NAME = "patchmark-comment-anchors";
const STRICT_CHATGPT_IMPORT_ERROR =
  "Invalid Patchmark response. Metadata references must be inside field-local sources arrays. Markdown links are allowed only in original_text and suggested_text.";
const INVALID_CHATGPT_JSON_ERROR =
  "Invalid JSON. Ask ChatGPT to return one fenced json code block containing valid Patchmark JSON.";
const CHATGPT_IMPORT_REPAIR_PROMPT = `Please repair your previous response into exactly one fenced json code block containing valid Patchmark JSON.

Do not change the substance of the reply or patch.

Use one opening \`\`\`json fence.
Use one closing \`\`\` fence.
Do not include text before the opening fence.
Do not include text after the closing fence.
Do not use footnotes or reference links.

Source rules:
- Every \`url\` must be a raw URL string starting with \`https://\` or \`http://\`.
- Do not use Markdown links in metadata or source fields.
- Do not include \`[\`, \`]\`, \`(\`, or \`)\` around URLs.
- Do not include quotes, escaped quotes, or backslashes in URLs.
- Put all URLs only inside field-local source arrays.
- \`supports\` must be plain text only.
- Markdown links are allowed only in document Markdown fields: \`original_text\` and \`suggested_text\`.`;
const PROTOCOL_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const PROTOCOL_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/;
const PROTOCOL_BROKEN_MARKDOWN_LINK_PATTERN = /\]\(/;
const PROTOCOL_REFERENCE_LINK_PATTERN = /\[[^\]]+\]\[[^\]]+\]|\[\d+\]/;
const PROTOCOL_FOOTNOTE_PATTERN = /\[\^[^\]]+\]/;
const SOURCE_URL_MARKDOWN_PATTERN = /[\[\]\(\)"\\]/;
const DOCUMENT_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(https?:\/\/[^)]+\)/i;
const DOCUMENT_RAW_URL_PATTERN = /\bhttps?:\/\/\S+/i;
const SOURCE_SECTION_HEADING_PATTERN = /\b(source notes|references)\b/i;

export function DocumentEditor() {
  const documentWorkspaceRef = useRef<HTMLElement>(null);
  const editorDocumentRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Markdown is the source of truth across both editing modes.
  const [markdown, setMarkdown] = useState("");
  const [baselineMarkdown, setBaselineMarkdown] = useState<string | null>(null);
  const [activeFileHandle, setActiveFileHandle] =
    useState<MarkdownFileHandle | null>(null);
  const [projectHandle, setProjectHandle] =
    useState<PatchmarkProjectHandle | null>(null);
  const [restoredMarkdown, setRestoredMarkdown] = useState<string | null>(null);
  const [availableDraft, setAvailableDraft] = useState<DocumentDraft | null>(null);
  const [mode, setMode] = useState<EditorMode>("visual");
  const [documentVersion, setDocumentVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [versionEntries, setVersionEntries] = useState<PatchmarkVersionEntry[]>(
    []
  );
  const [comments, setComments] = useState<PatchmarkComment[]>([]);
  const [patches, setPatches] = useState<PatchmarkPatch[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [isCommentBusy, setIsCommentBusy] = useState(false);
  const [activeCommentState, setActiveCommentState] =
    useState<ActiveCommentState>({ kind: "none" });
  const [markdownSelection, setMarkdownSelection] =
    useState<MarkdownSelection>({
      end: 0,
      start: 0
    });
  const [markdownSelectionRequest, setMarkdownSelectionRequest] = useState<
    (MarkdownSelection & { nonce: number }) | null
  >(null);
  const [visualSelectionDraft, setVisualSelectionDraft] =
    useState<SelectedCommentAnchorDraft | null>(null);
  const [commentAddRequest, setCommentAddRequest] =
    useState<CommentAddRequest | null>(null);
  const [commentContextMenu, setCommentContextMenu] =
    useState<CommentContextMenuState | null>(null);
  const [commentPositions, setCommentPositions] = useState<Record<string, number>>(
    {}
  );
  const [snapshotDialog, setSnapshotDialog] =
    useState<SnapshotDialogState | null>(null);
  const [chatGptPromptDialog, setChatGptPromptDialog] =
    useState<ChatGptPromptDialogState | null>(null);
  const [documentLevelExportGuardDialog, setDocumentLevelExportGuardDialog] =
    useState<DocumentLevelExportGuardDialogState | null>(null);
  const [markCommentFocusGuardDialog, setMarkCommentFocusGuardDialog] =
    useState<MarkCommentFocusGuardDialogState | null>(null);
  const [chatGptImportDialog, setChatGptImportDialog] =
    useState<ChatGptImportDialogState | null>(null);
  const [selectedPatchId, setSelectedPatchId] = useState<string | null>(null);
  const [selectedPatchGroupId, setSelectedPatchGroupId] = useState<string | null>(
    null
  );
  const [patchGroupListDialog, setPatchGroupListDialog] =
    useState<PatchGroupListDialogState | null>(null);
  const [patchReviewCommentScopeId, setPatchReviewCommentScopeId] =
    useState<string | null>(null);
  const [patchReviewGroupScopeId, setPatchReviewGroupScopeId] =
    useState<string | null>(null);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const markdownSelectionDraft = useMemo(
    () => createMarkdownSelectionDraft(markdown, markdownSelection),
    [markdown, markdownSelection]
  );
  const selectedCommentDraft =
    mode === "markdown" ? markdownSelectionDraft : visualSelectionDraft;
  const selectedCommentHeading = useMemo(
    () =>
      typeof getDraftMarkdownStartOffset(selectedCommentDraft) === "number"
        ? getHeadingContainingOffset(
            markdown,
            headings,
            getDraftMarkdownStartOffset(selectedCommentDraft) ?? 0
          )
        : undefined,
    [headings, markdown, selectedCommentDraft]
  );
  const defaultCommentHeading = useMemo(
    () =>
      selectedCommentHeading ??
      getHeadingContainingOffset(markdown, headings, markdownSelection.start),
    [headings, markdown, markdownSelection.start, selectedCommentHeading]
  );
  const selectedCommentText = selectedCommentDraft?.selectedText.trim()
    ? selectedCommentDraft.selectedText
    : "";
  const selectedCommentAnchorContextKind =
    selectedCommentDraft?.anchorContext.kind ?? null;
  const commentAnchorSummaries = useMemo(
    () =>
      Object.fromEntries(
        comments.map((comment) => [
          comment.id,
          getCommentAnchorSummary(comment, markdown, headings)
        ])
      ),
    [comments, headings, markdown]
  );
  const pendingPatchCountsByCommentId = useMemo(
    () => getPendingPatchCountsByCommentId(patches),
    [patches]
  );
  const pendingPatches = useMemo(
    () => patches.filter((patch) => patch.status === "pending"),
    [patches]
  );
  const patchGroups = useMemo(
    () => derivePatchGroups(patches, markdown),
    [markdown, patches]
  );
  const pendingPatchGroups = useMemo(
    () =>
      patchGroups.filter((group) => group.status_summary.pending > 0),
    [patchGroups]
  );
  const patchGroupSummariesByCommentId = useMemo(
    () => getPatchGroupSummariesByCommentId(patchGroups),
    [patchGroups]
  );
  const selectedPatch = useMemo(
    () =>
      selectedPatchId
        ? patches.find((patch) => patch.id === selectedPatchId) ?? null
        : null,
    [patches, selectedPatchId]
  );
  const selectedPatchGroup = useMemo(
    () =>
      selectedPatchGroupId
        ? patchGroups.find((group) => group.id === selectedPatchGroupId) ?? null
        : null,
    [patchGroups, selectedPatchGroupId]
  );
  const selectedPatchGroupComment = useMemo(
    () =>
      selectedPatchGroup?.comment_id
        ? comments.find((comment) => comment.id === selectedPatchGroup.comment_id) ??
          null
        : null,
    [comments, selectedPatchGroup]
  );
  const patchGroupListGroups = useMemo(() => {
    if (!patchGroupListDialog) {
      return [];
    }

    return patchGroupListDialog.commentId
      ? patchGroups.filter(
          (group) => group.comment_id === patchGroupListDialog.commentId
        )
      : pendingPatchGroups;
  }, [patchGroupListDialog, patchGroups, pendingPatchGroups]);
  const selectedPatchDerivedGroup = useMemo(
    () =>
      selectedPatch
        ? patchGroups.find(
            (group) => group.id === getDerivedPatchGroupId(selectedPatch)
          ) ?? null
        : null,
    [patchGroups, selectedPatch]
  );
  const reviewablePatches = useMemo(
    () => {
      if (patchReviewGroupScopeId) {
        return (
          patchGroups.find((group) => group.id === patchReviewGroupScopeId)
            ?.patches ?? []
        );
      }

      if (patchReviewCommentScopeId) {
        return pendingPatches.filter(
          (patch) => patch.comment_id === patchReviewCommentScopeId
        );
      }

      return pendingPatches;
    },
    [patchGroups, patchReviewCommentScopeId, patchReviewGroupScopeId, pendingPatches]
  );
  const selectedPatchComment = useMemo(
    () =>
      selectedPatch?.comment_id
        ? comments.find((comment) => comment.id === selectedPatch.comment_id) ??
          null
        : null,
    [comments, selectedPatch]
  );
  const selectedPatchAnchorStatus = useMemo(
    () =>
      selectedPatch
        ? getPatchReviewAnchorStatus(markdown, selectedPatch, patches)
        : null,
    [markdown, patches, selectedPatch]
  );
  const isDirty =
    fileName !== null &&
    (baselineMarkdown === null || markdown !== baselineMarkdown);
  const isSaving = saveStatus === "saving";
  const isProjectMode = projectHandle !== null;
  const documentStatus: DocumentStatusKind = getDocumentStatus({
    isDirty,
    markdown,
    restoredMarkdown,
    saveStatus
  });

  useEffect(() => {
    setAvailableDraft(readMostRecentDocumentDraft());
  }, []);

  useEffect(() => {
    let isCancelled = false;

    if (!projectHandle) {
      setVersionEntries([]);
      setComments([]);
      setPatches([]);
      setSelectedPatchId(null);
      setSelectedPatchGroupId(null);
      setPatchGroupListDialog(null);
      setPatchReviewCommentScopeId(null);
      setPatchReviewGroupScopeId(null);
      setCommentsError(null);
      return;
    }

    void listProjectVersions(projectHandle).then((versions) => {
      if (!isCancelled) {
        setVersionEntries(versions);
      }
    });

    void readProjectComments(projectHandle)
      .then((projectComments) => {
        if (!isCancelled) {
          setComments(projectComments);
          setCommentsError(null);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setComments([]);
          setCommentsError(getProjectErrorMessage(error));
        }
      });

    void readProjectPatches(projectHandle)
      .then((projectPatches) => {
        if (!isCancelled) {
          setPatches(projectPatches);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setPatches([]);
          setCommentsError(getProjectErrorMessage(error));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [projectHandle]);

  useEffect(() => {
    if (selectedPatchId && !patches.some((patch) => patch.id === selectedPatchId)) {
      setSelectedPatchId(null);
      setPatchReviewCommentScopeId(null);
      setPatchReviewGroupScopeId(null);
    }
  }, [patches, selectedPatchId]);

  useEffect(() => {
    if (!projectHandle || isSaving || comments.length === 0) {
      return;
    }

    const recoveredComments = recoverPersistableStaleCommentAnchors({
      comments,
      headings,
      markdown
    });

    if (recoveredComments === comments) {
      return;
    }

    let isCancelled = false;

    void writeProjectComments(projectHandle, recoveredComments)
      .then(() => {
        if (!isCancelled) {
          setComments(recoveredComments);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setCommentsError(getProjectErrorMessage(error));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [comments, headings, isSaving, markdown, projectHandle]);

  useEffect(() => {
    if (!projectHandle || isSaving || patches.length === 0) {
      return;
    }

    const recoveredPatches = recoverHighConfidencePendingPatchAnchors({
      markdown,
      patches
    });

    if (recoveredPatches === patches) {
      return;
    }

    let isCancelled = false;

    void writeProjectPatches(projectHandle, recoveredPatches)
      .then(() => {
        if (!isCancelled) {
          setPatches(recoveredPatches);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setCommentsError(getProjectErrorMessage(error));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isSaving, markdown, patches, projectHandle]);

  useEffect(() => {
    if (
      selectedPatchGroupId &&
      !patchGroups.some((group) => group.id === selectedPatchGroupId)
    ) {
      setSelectedPatchGroupId(null);
      setPatchReviewGroupScopeId(null);
    }
  }, [patchGroups, selectedPatchGroupId]);

  useEffect(() => {
    const commentIds = new Set(comments.map((comment) => comment.id));

    setActiveCommentState((currentState) => {
      if (currentState.kind === "comment") {
        return commentIds.has(currentState.commentId)
          ? currentState
          : { kind: "none" };
      }

      if (currentState.kind === "anchor_group") {
        const nextCommentIds = currentState.commentIds.filter((commentId) =>
          commentIds.has(commentId)
        );

        if (nextCommentIds.length === currentState.commentIds.length) {
          return currentState;
        }

        if (nextCommentIds.length === 1) {
          return { kind: "comment", commentId: nextCommentIds[0] };
        }

        return nextCommentIds.length > 1
          ? { kind: "anchor_group", commentIds: nextCommentIds }
          : { kind: "none" };
      }

      return currentState;
    });
  }, [comments]);

  useEffect(() => {
    if (!fileName) {
      return;
    }

    saveDocumentDraft({
      fileName,
      markdown,
      updatedAt: new Date().toISOString()
    });
  }, [fileName, markdown]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!commentContextMenu) {
      return;
    }

    function closeCommentContextMenu() {
      setCommentContextMenu(null);
    }

    function handleContextMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeCommentContextMenu();
      }
    }

    window.addEventListener("click", closeCommentContextMenu);
    window.addEventListener("keydown", handleContextMenuKeyDown);
    window.addEventListener("scroll", closeCommentContextMenu, true);

    return () => {
      window.removeEventListener("click", closeCommentContextMenu);
      window.removeEventListener("keydown", handleContextMenuKeyDown);
      window.removeEventListener("scroll", closeCommentContextMenu, true);
    };
  }, [commentContextMenu]);

  useEffect(() => {
    let isCancelled = false;
    let animationFrameId: number | null = null;
    const delayedSyncTimeoutIds: number[] = [];
    const editorContainer = editorDocumentRef.current;
    const workspace = documentWorkspaceRef.current;

    function syncCommentAnchors() {
      if (isCancelled) {
        return;
      }

      const nextCommentPositions = measureCommentPositions({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode,
        workspace: documentWorkspaceRef.current
      });

      setCommentPositions((currentCommentPositions) =>
        areCommentPositionsEqual(currentCommentPositions, nextCommentPositions)
          ? currentCommentPositions
          : nextCommentPositions
      );

      updateVisualCommentHighlights({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode
      });
    }

    function scheduleCommentAnchorSync() {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        syncCommentAnchors();
      });
    }

    scheduleCommentAnchorSync();

    for (const delay of [60, 180, 420, 900]) {
      delayedSyncTimeoutIds.push(
        window.setTimeout(scheduleCommentAnchorSync, delay)
      );
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleCommentAnchorSync);
    const mutationObserver =
      typeof MutationObserver === "undefined" || !editorContainer
        ? null
        : new MutationObserver(scheduleCommentAnchorSync);

    if (resizeObserver) {
      if (editorContainer) {
        resizeObserver.observe(editorContainer);
      }

      if (workspace) {
        resizeObserver.observe(workspace);
      }
    }

    if (mutationObserver && editorContainer) {
      mutationObserver.observe(editorContainer, {
        characterData: true,
        childList: true,
        subtree: true
      });
    }
    window.addEventListener("resize", scheduleCommentAnchorSync);

    return () => {
      isCancelled = true;

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      for (const timeoutId of delayedSyncTimeoutIds) {
        window.clearTimeout(timeoutId);
      }

      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleCommentAnchorSync);
      clearVisualCommentHighlights();
    };
  }, [comments, documentVersion, headings, markdown, mode]);

  const handleSaveChanges = useCallback(async () => {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Save failed because Markdown content is invalid."
      });
      return;
    }

    if (projectHandle) {
      setSaveStatus("saving");
      setSaveFeedback(null);

      try {
        const nextProjectHandle = await saveProjectDocument(
          projectHandle,
          markdown
        );
        setProjectHandle(nextProjectHandle);
        setBaselineMarkdown(markdown);
        setRestoredMarkdown(null);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Saved changes to project document.md."
        });
      } catch (error) {
        setSaveStatus("failed");
        setSaveFeedback({
          kind: "error",
          message: getSaveErrorMessage(error)
        });
      }

      return;
    }

    if (!activeFileHandle) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "error",
        message:
          "Direct save is not available for this document. Use Save As or Download .md instead."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      await saveMarkdownToFileHandle(activeFileHandle, markdown);
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Saved changes to the Markdown file."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getSaveErrorMessage(error)
      });
    }
  }, [activeFileHandle, fileName, isSaving, markdown, projectHandle]);

  useEffect(() => {
    if (!fileName) {
      return;
    }

    function handleSaveShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveChanges();
      }
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [fileName, handleSaveChanges]);

  function handleFileLoaded(loadedFile: LoadedMarkdownFile) {
    setFileName(loadedFile.fileName);
    setMarkdown(loadedFile.markdown);
    setBaselineMarkdown(loadedFile.markdown);
    setActiveFileHandle(loadedFile.fileHandle);
    setProjectHandle(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
    setComments([]);
    setPatches([]);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setDocumentLevelExportGuardDialog(null);
    setMarkCommentFocusGuardDialog(null);
    setChatGptImportDialog(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  function handleRestoreDraft() {
    if (!availableDraft) {
      return;
    }

    setFileName(availableDraft.fileName);
    setMarkdown(availableDraft.markdown);
    setBaselineMarkdown(null);
    setActiveFileHandle(null);
    setProjectHandle(null);
    setRestoredMarkdown(availableDraft.markdown);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
    setComments([]);
    setPatches([]);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setDocumentLevelExportGuardDialog(null);
    setMarkCommentFocusGuardDialog(null);
    setChatGptImportDialog(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  function handleDiscardDraft() {
    if (!availableDraft) {
      return;
    }

    deleteDocumentDraft(availableDraft.fileName);
    setAvailableDraft(null);
  }

  function handleMarkdownChange(nextMarkdown: string) {
    setMarkdown(nextMarkdown);

    if (saveStatus !== "saving") {
      setSaveStatus("idle");
      setSaveFeedback(null);
    }
  }

  async function handleSaveAs() {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Save failed because Markdown content is invalid."
      });
      return;
    }

    if (!canSaveMarkdownFilePicker()) {
      downloadMarkdown(fileName, markdown);
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Direct Save As is not available in this browser. Downloaded a Markdown copy instead."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const fileHandle = await saveMarkdownAsFile(fileName, markdown);

      if (!fileHandle) {
        setSaveStatus("idle");
        return;
      }

      if (projectHandle) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message:
            "Saved an exported Markdown copy. The project folder remains active."
        });
        return;
      }

      setActiveFileHandle(fileHandle);
      setFileName(fileHandle.name);
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Saved Markdown to the selected file."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getSaveErrorMessage(error)
      });
    }
  }

  function handleDownload() {
    setSaveFeedback({
      kind: "info",
      message: "Downloaded a Markdown copy. Save status is unchanged."
    });
  }

  async function handleOpenProjectFolder() {
    if (isSaving) {
      return;
    }

    if (!canOpenProjectFolder()) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Project folders require a browser with File System Access API support. You can continue using Single File Mode."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const loadedProject = await openProjectFolder();

      if (!loadedProject) {
        setSaveStatus("idle");
        return;
      }

      loadProjectIntoEditor(loadedProject);
      setSaveFeedback({
        kind: "success",
        message: "Opened Patchmark project folder."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCreateProjectFromCurrentDocument() {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Project creation failed because Markdown content is invalid."
      });
      return;
    }

    if (!canOpenProjectFolder()) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Project folders require a browser with File System Access API support. You can continue using Single File Mode."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const loadedProject = await createProjectFromMarkdown({
        markdown,
        suggestedProjectName: fileName
      });

      if (!loadedProject) {
        setSaveStatus("idle");
        return;
      }

      loadProjectIntoEditor(loadedProject);
      setSaveFeedback({
        kind: "success",
        message: "Created Patchmark project from the current document."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCreateSnapshot() {
    if (!projectHandle || isSaving) {
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const snapshotResult = await createProjectSnapshot({
        project: projectHandle,
        markdown
      });

      if (!snapshotResult.created) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message: "No changes since latest snapshot."
        });
        return;
      }

      setProjectHandle(snapshotResult.project);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Created a Markdown snapshot in .patchmark/versions/."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  function handleGenerateChatGptPrompt() {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "ChatGPT prompt generation is available in Project Folder Mode."
      });
      return;
    }

    const focusedComments = getFocusedCommentsForExport(comments);

    if (focusedComments.length === 0) {
      setSaveFeedback({
        kind: "info",
        message:
          "No focused comments to export. Reply to a comment or mark it for ChatGPT first."
      });
      return;
    }

    const documentLevelFocusedComments = focusedComments.filter(
      (comment) => comment.anchor.kind === "document"
    );
    const nonDocumentFocusedComments = focusedComments.filter(
      (comment) => comment.anchor.kind !== "document"
    );

    if (documentLevelFocusedComments.length > 1) {
      setDocumentLevelExportGuardDialog({
        documentCommentIds: documentLevelFocusedComments.map((comment) => comment.id),
        kind: "multiple_document_comments",
        nonDocumentCommentIds: nonDocumentFocusedComments.map(
          (comment) => comment.id
        )
      });
      setSaveFeedback({
        kind: "info",
        message:
          "Only one document-level comment can be exported at a time."
      });
      return;
    }

    if (
      documentLevelFocusedComments.length === 1 &&
      nonDocumentFocusedComments.length > 0
    ) {
      setDocumentLevelExportGuardDialog({
        documentCommentId: documentLevelFocusedComments[0].id,
        kind: "mixed_document_comment",
        nonDocumentCommentIds: nonDocumentFocusedComments.map(
          (comment) => comment.id
        )
      });
      setSaveFeedback({
        kind: "info",
        message:
          "Document-level comments require a dedicated ChatGPT round."
      });
      return;
    }

    openChatGptPromptDialog({
      dedicatedDocumentReview: documentLevelFocusedComments.length === 1,
      focusedComments
    });
  }

  function openChatGptPromptDialog({
    dedicatedDocumentReview,
    focusedComments
  }: {
    dedicatedDocumentReview: boolean;
    focusedComments: PatchmarkComment[];
  }) {
    if (!projectHandle) {
      return;
    }

    const exportedAt = new Date().toISOString();
    const exportId = createCommentExportId(exportedAt);
    const fileTimestamp = createFileSafeTimestamp(exportedAt);
    const exportPayload = createFocusedCommentsExportPayload({
      comments: focusedComments,
      dedicatedDocumentReview,
      exportedAt,
      exportId,
      headings,
      markdown,
      project: projectHandle
    });
    const jsonText = `${JSON.stringify(exportPayload, null, 2)}\n`;
    const promptText = createFocusedCommentsChatGptPrompt(jsonText, {
      dedicatedDocumentReview
    });
    const fileNamePrefix = dedicatedDocumentReview
      ? "document-comment"
      : "focused-comments";

    setChatGptPromptDialog({
      commentIds: focusedComments.map((comment) => comment.id),
      dedicatedDocumentReview,
      exportedAt,
      exportId,
      payloadFileName: `${fileTimestamp}-${fileNamePrefix}-payload.json`,
      promptFileName: `${fileTimestamp}-${fileNamePrefix}-prompt.md`,
      jsonText,
      promptText
    });
    setSaveFeedback({
      kind: "info",
      message: dedicatedDocumentReview
        ? "Generated a dedicated ChatGPT prompt for one document-level comment."
        : `Generated a ChatGPT prompt for ${focusedComments.length} focused comment${
            focusedComments.length === 1 ? "" : "s"
          }.`
    });
  }

  function handleGenerateDedicatedDocumentPromptFromGuard() {
    if (
      !documentLevelExportGuardDialog ||
      documentLevelExportGuardDialog.kind !== "mixed_document_comment"
    ) {
      return;
    }

    const documentComment = comments.find(
      (comment) =>
        comment.id === documentLevelExportGuardDialog.documentCommentId &&
        comment.status === "open"
    );

    if (!documentComment) {
      setDocumentLevelExportGuardDialog(null);
      setSaveFeedback({
        kind: "error",
        message: "The document-level comment was not found."
      });
      return;
    }

    setDocumentLevelExportGuardDialog(null);
    openChatGptPromptDialog({
      dedicatedDocumentReview: true,
      focusedComments: [documentComment]
    });
  }

  async function handleUnmarkOtherFocusedCommentsAndGenerate() {
    if (
      !documentLevelExportGuardDialog ||
      documentLevelExportGuardDialog.kind !== "mixed_document_comment"
    ) {
      return;
    }

    const otherCommentIds = new Set(
      documentLevelExportGuardDialog.nonDocumentCommentIds
    );
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      otherCommentIds.has(comment.id) && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            updated_at: now
          }
        : comment
    );
    const documentComment = nextComments.find(
      (comment) =>
        comment.id === documentLevelExportGuardDialog.documentCommentId &&
        comment.status === "open"
    );

    if (!documentComment) {
      setDocumentLevelExportGuardDialog(null);
      setSaveFeedback({
        kind: "error",
        message: "The document-level comment was not found."
      });
      return;
    }

    try {
      await persistComments(
        nextComments,
        "Unmarked other comments for this dedicated ChatGPT round."
      );
      setDocumentLevelExportGuardDialog(null);
      openChatGptPromptDialog({
        dedicatedDocumentReview: true,
        focusedComments: [documentComment]
      });
    } catch {
      // persistComments already surfaced the error.
    }
  }

  async function handleCopyChatGptPrompt() {
    if (!chatGptPromptDialog) {
      return;
    }

    if (!navigator.clipboard) {
      setSaveFeedback({
        kind: "error",
        message: "Clipboard copy is not available in this browser."
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(chatGptPromptDialog.promptText);
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: "Prompt copied. Focused comments marked as exported."
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleSaveChatGptPrompt() {
    if (!projectHandle || !chatGptPromptDialog) {
      return;
    }

    try {
      const filePath = await writeProjectContextPack({
        contents: chatGptPromptDialog.promptText,
        fileName: chatGptPromptDialog.promptFileName,
        project: projectHandle
      });
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: `Prompt saved to ${filePath}. Focused comments marked as exported.`
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
    }
  }

  async function handleCopyFocusedJsonPayload() {
    if (!chatGptPromptDialog) {
      return;
    }

    if (!navigator.clipboard) {
      setSaveFeedback({
        kind: "error",
        message: "Clipboard copy is not available in this browser."
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(chatGptPromptDialog.jsonText);
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: "JSON payload copied. Focused comments marked as exported."
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleSaveFocusedJsonPayload() {
    if (!projectHandle || !chatGptPromptDialog) {
      return;
    }

    try {
      const filePath = await writeProjectContextPack({
        contents: chatGptPromptDialog.jsonText,
        fileName: chatGptPromptDialog.payloadFileName,
        project: projectHandle
      });
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: `JSON payload saved to ${filePath}. Focused comments marked as exported.`
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
    }
  }

  function handleOpenChatGptImportDialog() {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "ChatGPT response import is available in Project Folder Mode."
      });
      return;
    }

    setChatGptImportDialog({
      error: null,
      responseJson: "",
      sourceChatUrl: ""
    });
  }

  async function handleImportChatGptResponse(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!projectHandle || !chatGptImportDialog || isCommentBusy) {
      return;
    }

    let parsedResponse: PatchmarkCommentReplyImport;
    let sourceChatUrl: string | undefined;

    try {
      parsedResponse = parsePatchmarkCommentReplyImport(
        chatGptImportDialog.responseJson
      );
      sourceChatUrl = normalizeSourceChatUrl(
        chatGptImportDialog.sourceChatUrl
      );
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setChatGptImportDialog({
        ...chatGptImportDialog,
        error: message
      });
      setSaveFeedback({
        kind: "error",
        message
      });
      return;
    }

    setIsCommentBusy(true);
    setCommentsError(null);
    setSaveFeedback(null);

    try {
      const importedAt = new Date().toISOString();
      const importId = createCommentImportId(importedAt);
      const safeTimestamp = createFileSafeTimestamp(importedAt);
      const knownCommentIds = new Set(comments.map((comment) => comment.id));
      const unknownCommentIds = getUnknownImportCommentIds(
        parsedResponse,
        knownCommentIds
      );
      const importedCommentIds = getKnownImportCommentIds(
        parsedResponse,
        knownCommentIds
      );
      const existingPatches = await readProjectPatches(projectHandle);
      const importedPatches = createImportedPatchProposals({
        existingPatches,
        importedAt,
        importId,
        knownCommentIds,
        patchProposals: parsedResponse.patch_proposals,
        sourceChatUrl
      });
      const { nextComments, openQuestionsAttached, repliesAttached } =
        createImportedCommentThreads({
          comments,
          importedAt,
          importId,
          importedCommentIds,
          openQuestions: parsedResponse.open_questions,
          replies: parsedResponse.replies,
          sourceChatUrl
        });
      const importWarnings = unknownCommentIds.map(
        (commentId) =>
          `Response referenced a comment that was not found: ${commentId}`
      );
      const importWrapper = {
        import_id: importId,
        imported_at: importedAt,
        source_chat_url: sourceChatUrl,
        sources: parsedResponse.sources,
        raw_response: parsedResponse,
        warnings: importWarnings
      };

      await writeProjectImport({
        contents: `${JSON.stringify(importWrapper, null, 2)}\n`,
        fileName: `${safeTimestamp}-comment-reply-import.json`,
        project: projectHandle
      });

      if (importedPatches.length > 0) {
        await writeProjectPatches(projectHandle, [
          ...existingPatches,
          ...importedPatches
        ]);
      }

      await writeProjectComments(projectHandle, nextComments);

      setComments(nextComments);
      setPatches([...existingPatches, ...importedPatches]);
      setChatGptImportDialog(null);
      setSaveFeedback({
        kind: importWarnings.length > 0 ? "info" : "success",
        message: createChatGptImportSummaryMessage({
          openQuestionsAttached,
          patchProposalsStored: importedPatches.length,
          repliesAttached,
          warnings: importWarnings
        })
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setChatGptImportDialog({
        ...chatGptImportDialog,
        error: message
      });
      setSaveFeedback({
        kind: "error",
        message
      });
    } finally {
      setIsCommentBusy(false);
    }
  }

  async function markFocusedExportCommentsAsExported(
    exportDialog: ChatGptPromptDialogState
  ) {
    const exportedCommentIds = new Set(exportDialog.commentIds);
    const nextComments = comments.map((comment) =>
      exportedCommentIds.has(comment.id) && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "exported" as const,
              last_exported_at: exportDialog.exportedAt,
              last_export_id: exportDialog.exportId
            },
            updated_at: exportDialog.exportedAt
          }
        : comment
    );

    await persistComments(nextComments, "Marked focused comments as exported.");
  }

  async function handleViewSnapshot(version: PatchmarkVersionEntry) {
    if (!projectHandle) {
      return;
    }

    try {
      const snapshotMarkdown = await readProjectVersionMarkdown(
        projectHandle,
        version
      );
      setSnapshotDialog({
        kind: "view",
        snapshotMarkdown,
        version
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCompareSnapshot(version: PatchmarkVersionEntry) {
    if (!projectHandle) {
      return;
    }

    try {
      const snapshotMarkdown = await readProjectVersionMarkdown(
        projectHandle,
        version
      );
      setSnapshotDialog({
        currentMarkdown: markdown,
        kind: "compare",
        snapshotMarkdown,
        version
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleAddComment(values: CommentFormValues) {
    if (!projectHandle) {
      return;
    }

    const now = new Date().toISOString();
    const nextComment: PatchmarkComment = {
      id: createNextCommentId(comments),
      type: values.type,
      status: "open",
      anchor: createCommentAnchor({
        headings,
        markdown,
        selection: markdownSelection,
        selectedDraft: selectedCommentDraft,
        values
      }),
      comment: values.comment,
      thread: [],
      export_state: {
        focus_state: "idle"
      },
      created_at: now,
      updated_at: now
    };
    const nextComments = [...comments, nextComment];

    await persistComments(nextComments, "Added comment.");
    setActiveCommentState({ kind: "comment", commentId: nextComment.id });
  }

  async function handleEditComment(
    commentId: string,
    values: Pick<CommentFormValues, "comment" | "type">
  ) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            type: values.type,
            anchor: refreshCommentAnchorActionContext(
              comment.anchor,
              values.type
            ),
            comment: values.comment,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Updated comment.");
  }

  async function handleResolveComment(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            status: "resolved" as const,
            resolved_at: now,
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Resolved comment.");
  }

  async function handleReopenComment(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            status: "open" as const,
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            resolved_at: undefined,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Reopened comment.");
  }

  async function handleReplyToComment(commentId: string, content: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId && comment.status === "open"
        ? {
            ...comment,
            thread: [
              ...comment.thread,
              {
                id: createNextThreadEntryId(comment),
                role: "user" as const,
                content,
                created_at: now
              }
            ],
            export_state: {
              ...comment.export_state,
              focus_state: "in_focus" as const,
              marked_for_export_at: now
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Added reply and marked comment for ChatGPT.");
  }

  async function handleMarkCommentForExport(commentId: string) {
    const targetComment = comments.find(
      (comment) => comment.id === commentId && comment.status === "open"
    );

    if (!targetComment) {
      setSaveFeedback({
        kind: "error",
        message: "The comment was not found."
      });
      return;
    }

    const otherFocusedComments = getFocusedCommentsForExport(comments).filter(
      (comment) => comment.id !== commentId
    );
    const focusedDocumentComments = otherFocusedComments.filter(
      (comment) => comment.anchor.kind === "document"
    );
    const focusedNonDocumentComments = otherFocusedComments.filter(
      (comment) => comment.anchor.kind !== "document"
    );

    if (
      targetComment.anchor.kind !== "document" &&
      focusedDocumentComments.length > 0
    ) {
      setMarkCommentFocusGuardDialog({
        documentCommentIds: focusedDocumentComments.map((comment) => comment.id),
        kind: "mark_non_document_with_document_focus",
        targetCommentId: commentId
      });
      return;
    }

    if (targetComment.anchor.kind === "document") {
      if (focusedDocumentComments.length > 0) {
        setMarkCommentFocusGuardDialog({
          documentCommentIds: focusedDocumentComments.map(
            (comment) => comment.id
          ),
          kind: "mark_document_with_document_focus",
          nonDocumentCommentIds: focusedNonDocumentComments.map(
            (comment) => comment.id
          ),
          targetCommentId: commentId
        });
        return;
      }

      if (focusedNonDocumentComments.length > 0) {
        setMarkCommentFocusGuardDialog({
          kind: "mark_document_with_non_document_focus",
          nonDocumentCommentIds: focusedNonDocumentComments.map(
            (comment) => comment.id
          ),
          targetCommentId: commentId
        });
        return;
      }
    }

    await markCommentForExportWithFocusChanges({
      commentId,
      idleCommentIds: [],
      successMessage: "Marked comment for ChatGPT."
    });
  }

  async function handleConfirmMarkCommentFocusGuard() {
    if (!markCommentFocusGuardDialog) {
      return;
    }

    const guardDialog = markCommentFocusGuardDialog;
    const idleCommentIds =
      guardDialog.kind === "mark_non_document_with_document_focus"
        ? guardDialog.documentCommentIds
        : guardDialog.kind === "mark_document_with_non_document_focus"
          ? guardDialog.nonDocumentCommentIds
          : [
              ...guardDialog.documentCommentIds,
              ...guardDialog.nonDocumentCommentIds
            ];
    const successMessage =
      guardDialog.kind === "mark_non_document_with_document_focus"
        ? "Unmarked document-level comment and marked this comment for ChatGPT."
        : guardDialog.kind === "mark_document_with_document_focus" &&
            guardDialog.nonDocumentCommentIds.length === 0
          ? "Unmarked other document-level comment and marked this one for ChatGPT."
          : "Unmarked other focused comments and marked document-level comment for ChatGPT.";

    try {
      await markCommentForExportWithFocusChanges({
        commentId: guardDialog.targetCommentId,
        idleCommentIds,
        successMessage
      });
      setMarkCommentFocusGuardDialog(null);
    } catch {
      // persistComments already surfaced the error.
    }
  }

  async function markCommentForExportWithFocusChanges({
    commentId,
    idleCommentIds,
    successMessage
  }: {
    commentId: string;
    idleCommentIds: string[];
    successMessage: string;
  }) {
    const targetComment = comments.find(
      (comment) => comment.id === commentId && comment.status === "open"
    );

    if (!targetComment) {
      setSaveFeedback({
        kind: "error",
        message: "The comment was not found."
      });
      return;
    }

    const now = new Date().toISOString();
    const idleCommentIdSet = new Set(
      idleCommentIds.filter((idleCommentId) => idleCommentId !== commentId)
    );
    const nextComments = comments.map((comment) => {
      if (comment.id === commentId && comment.status === "open") {
        return {
          ...comment,
          export_state: {
            ...comment.export_state,
            focus_state: "in_focus" as const,
            marked_for_export_at: now
          },
          updated_at: now
        };
      }

      if (idleCommentIdSet.has(comment.id) && comment.status === "open") {
        return {
          ...comment,
          export_state: {
            ...comment.export_state,
            focus_state: "idle" as const,
            marked_for_export_at: undefined
          },
          updated_at: now
        };
      }

      return comment;
    });

    await persistComments(nextComments, successMessage);
  }

  async function handleUnmarkCommentForExport(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Removed comment from ChatGPT export queue.");
  }

  async function handleDeleteComment(commentId: string) {
    const nextComments = comments.filter((comment) => comment.id !== commentId);

    await persistComments(nextComments, "Deleted comment.");
  }

  async function handleFindComment(comment: PatchmarkComment) {
    setActiveCommentState({ kind: "comment", commentId: comment.id });
    const resolution = resolveCommentAnchor(comment, markdown, headings);

    if (comment.anchor.kind === "document") {
      setSaveFeedback({
        kind: "info",
        message: "This is a whole-document comment."
      });
      return;
    }

    if (resolution.status === "active" && resolution.start !== undefined) {
      jumpToMarkdownSelection(
        resolution.start,
        resolution.end ?? resolution.start
      );
      setSaveFeedback({
        kind: "success",
        message: "Showing comment anchor in Markdown Mode."
      });
      return;
    }

    if (resolution.status === "ambiguous") {
      setSaveFeedback({
        kind: "info",
        message: resolution.detail ?? "Open Markdown Mode and review manually."
      });
      return;
    }

    if (comment.anchor.kind === "selected_text") {
      const recovery = recoverSelectedTextAnchor({
        comment,
        headings,
        markdown
      });

      if (recovery.status === "recovered") {
        const createdAt = new Date().toISOString();
        const latestNeedsReviewImpact = getLatestNeedsReviewPatchImpact(comment);
        const recoveredComment = recoverCommentAnchorForFind({
          comment,
          createdAt,
          latestNeedsReviewImpact,
          newAnchor: recovery.newAnchor
        });
        const nextComments = comments.map((currentComment) =>
          currentComment.id === comment.id ? recoveredComment : currentComment
        );

        await persistComments(
          nextComments,
          latestNeedsReviewImpact
            ? `Recovered comment anchor after ${latestNeedsReviewImpact.patch_id}.`
            : "Recovered comment anchor from selected text."
        );
        jumpToMarkdownSelection(recovery.matchStart, recovery.matchEnd);
        setSaveFeedback({
          kind: "success",
          message: "Recovered comment anchor and selected it in Markdown Mode."
        });
        return;
      }

      if (recovery.status === "ambiguous") {
        setSaveFeedback({
          kind: "info",
          message: `Selected text still exists, but ${recovery.matchCount} matches were found. Review manually.`
        });
        return;
      }
    }

    if (
      comment.anchor.kind === "selected_text" &&
      resolution.contextStart !== undefined
    ) {
      jumpToMarkdownSelection(
        resolution.contextStart,
        resolution.contextEnd ?? resolution.contextStart
      );
      setSaveFeedback({
        kind: "info",
        message: "Exact selected text was not found. Showing anchor context."
      });
      return;
    }

    if (
      comment.anchor.kind === "selected_text" &&
      resolution.fallbackStart !== undefined
    ) {
      jumpToMarkdownSelection(
        resolution.fallbackStart,
        resolution.fallbackEnd ?? resolution.fallbackStart
      );
      setSaveFeedback({
        kind: "info",
        message: "Selected text was not found. Showing fallback section."
      });
      return;
    }

    setSaveFeedback({
      kind: "error",
      message:
        comment.anchor.kind === "section"
          ? "Target section not found."
          : "Selected text anchor not found. The text may have changed."
    });
  }

  function handleReviewFirstPendingPatch() {
    if (pendingPatchGroups.length === 0) {
      setSaveFeedback({
        kind: "info",
        message: "No pending patch proposals to review."
      });
      return;
    }

    if (pendingPatchGroups.length === 1) {
      handleOpenPatchGroup(pendingPatchGroups[0].id);
      return;
    }

    setPatchGroupListDialog({ commentId: null });
  }

  function handleOpenPatchGroup(groupId: string) {
    setPatchGroupListDialog(null);
    setSelectedPatchGroupId(groupId);
    setSelectedPatchId(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
  }

  function handleReviewCommentPatches(commentId: string) {
    const linkedGroups = patchGroups.filter(
      (group) => group.comment_id === commentId
    );

    if (linkedGroups.length === 0) {
      setSaveFeedback({
        kind: "info",
        message: "No patch proposal is linked to this comment."
      });
      return;
    }

    if (linkedGroups.length === 1 && linkedGroups[0].patches.length === 1) {
      handleReviewPatchFromGroup(linkedGroups[0], linkedGroups[0].patches[0]);
      return;
    }

    if (linkedGroups.length === 1) {
      handleOpenPatchGroup(linkedGroups[0].id);
      return;
    }

    setPatchGroupListDialog({ commentId });
  }

  function handleReviewPatchFromGroup(
    group: DerivedPatchGroup,
    patch: PatchmarkPatch
  ) {
    setSelectedPatchGroupId(group.id);
    setPatchReviewGroupScopeId(group.id);
    setPatchReviewCommentScopeId(null);
    setSelectedPatchId(patch.id);
  }

  function handleNavigatePatchReview(direction: -1 | 1) {
    if (!selectedPatch || reviewablePatches.length === 0) {
      return;
    }

    const currentIndex = reviewablePatches.findIndex(
      (patch) => patch.id === selectedPatch.id
    );
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + direction + reviewablePatches.length) %
          reviewablePatches.length;

    setSelectedPatchId(reviewablePatches[nextIndex].id);
  }

  function handleFindPatchAnchorText(patch: PatchmarkPatch) {
    if (patch.status === "accepted") {
      const anchorStatus = getAppliedPatchAnchorStatus(markdown, patch, patches);
      const match = anchorStatus.matches[0];

      if (isAcceptedPatchTraceable(anchorStatus) && match) {
        jumpToMarkdownSelection(match.start, match.end);
        setSaveFeedback({
          kind: "success",
          message:
            anchorStatus.status === "evolved_after_patch" ||
            anchorStatus.status === "row_match" ||
            anchorStatus.status === "section_match"
              ? "Showing evolved applied patch target in Markdown Mode."
              : "Showing applied patch text in Markdown Mode."
        });
        return;
      }

      setSaveFeedback({
        kind:
          anchorStatus.status === "multiple_matches" ||
          anchorStatus.status === "empty_applied_text"
            ? "info"
            : "error",
        message:
          anchorStatus.status === "empty_applied_text"
            ? "This accepted patch has no applied text to select."
          : anchorStatus.status === "multiple_matches"
            ? "Applied patch text appears multiple times."
              : "Applied patch target was not found."
      });
      return;
    }

    const pendingAnchorStatus = getPatchReviewAnchorStatus(markdown, patch);
    const matches =
      pendingAnchorStatus.kind !== "accepted" &&
      pendingAnchorStatus.applicability === "exact_match"
        ? pendingAnchorStatus.matches
        : findExactTextMatches(markdown, patch.original_text);

    if (matches.length === 1) {
      jumpToMarkdownSelection(
        matches[0].start,
        matches[0].end
      );
      setSaveFeedback({
        kind: "success",
        message: "Showing patch original text in Markdown Mode."
      });
      return;
    }

    setSaveFeedback({
      kind: matches.length > 1 ? "info" : "error",
      message:
        matches.length > 1
          ? "Patch original text appears multiple times."
          : "Patch original text was not found."
    });
  }

  async function handleAcceptPatch(patch: PatchmarkPatch) {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "Accept Patch is available in Project Folder Mode."
      });
      return;
    }

    if (isSaving) {
      return;
    }

    const storedPatch = patches.find((candidate) => candidate.id === patch.id) ?? patch;

    if (storedPatch.status !== "pending") {
      setSaveFeedback({
        kind: "info",
        message: `Patch ${storedPatch.id} is already ${storedPatch.status}.`
      });
      return;
    }

    const automaticRecovery = getHighConfidencePendingPatchAnchorRecovery(
      markdown,
      storedPatch
    );
    const recoveryTimestamp = automaticRecovery
      ? new Date().toISOString()
      : null;
    const currentPatch = automaticRecovery
      ? applyHighConfidencePendingPatchAnchorRecovery({
          patch: storedPatch,
          recoveredAt: recoveryTimestamp ?? new Date().toISOString(),
          recovery: automaticRecovery
        })
      : storedPatch;
    const currentPatchAnchorStatus = getPatchReviewAnchorStatus(markdown, currentPatch);
    const currentPatchApplicability =
      currentPatchAnchorStatus.kind === "pending"
        ? currentPatchAnchorStatus.applicability
        : "not_found";
    const acceptBlocker = getPatchAcceptDisabledMessage(
      currentPatch,
      currentPatchApplicability
    );

    if (acceptBlocker) {
      setSaveFeedback({
        kind: "error",
        message: acceptBlocker
      });
      return;
    }

    const confirmed = window.confirm(
      "Apply this patch to the document?\n\nPatchmark will create a snapshot before changing document.md.\nThe linked comment will remain open until you resolve it."
    );

    if (!confirmed) {
      return;
    }

    const occurrenceCount = countOccurrences(markdown, currentPatch.original_text);
    const originalStart = markdown.indexOf(currentPatch.original_text);
    const originalEnd = originalStart + currentPatch.original_text.length;
    const lengthDelta =
      currentPatch.suggested_text.length - currentPatch.original_text.length;

    if (occurrenceCount !== 1 || originalStart === -1) {
      setSaveFeedback({
        kind: "error",
        message:
          occurrenceCount > 1
            ? "Cannot apply automatically because the original text appears multiple times."
            : "Cannot apply because the original text was not found in the current document."
      });
      return;
    }

    const affectedComments = analyzeCommentsAffectedByPatch({
      comments,
      currentMarkdown: markdown,
      originalEnd,
      originalStart,
      patch: currentPatch
    });

    setSaveStatus("saving");
    setCommentsError(null);
    setSaveFeedback(null);

    try {
      const snapshotResult = await createProjectSnapshot({
        allowDuplicate: true,
        project: projectHandle,
        markdown,
        reason: `before accepting patch ${currentPatch.id}`
      });

      if (!snapshotResult.created) {
        throw new Error("Patchmark could not create a pre-apply safety snapshot.");
      }

      const nextMarkdown = replaceSingleOccurrenceAt({
        replacement: currentPatch.suggested_text,
        search: currentPatch.original_text,
        start: originalStart,
        text: markdown
      });
      const replacementStart = originalStart;
      const replacementEnd = replacementStart + currentPatch.suggested_text.length;
      const nextProjectHandle = await saveProjectDocument(
        snapshotResult.project,
        nextMarkdown
      );
      const appliedAt = new Date().toISOString();
      const appliedAnchorMetadata = createAppliedPatchAnchorMetadata({
        end: replacementEnd,
        markdown: nextMarkdown,
        start: replacementStart,
        text: currentPatch.suggested_text
      });
      const affectedCommentUpdate = updateAffectedCommentAnchors({
        affectedComments,
        comments,
        createdAt: appliedAt,
        lengthDelta,
        newMarkdown: nextMarkdown,
        patch: currentPatch,
        replacementEnd,
        replacementStart
      });
      const nextPatches = patches.map((candidate) =>
        candidate.id === currentPatch.id
          ? {
              ...candidate,
              anchor_recovery_history: currentPatch.anchor_recovery_history,
              original_text: currentPatch.original_text,
              previous_original_text: currentPatch.previous_original_text,
              reanchored_at: currentPatch.reanchored_at,
              reanchor_reason: currentPatch.reanchor_reason,
              status: "accepted" as const,
              resolved_at: appliedAt,
              accepted_at: appliedAt,
              applied_at: appliedAt,
              pre_apply_snapshot_id: snapshotResult.version.id,
              pre_apply_snapshot_file: snapshotResult.version.file,
              ...appliedAnchorMetadata
            }
          : candidate
      );

      setProjectHandle(nextProjectHandle);
      setMarkdown(nextMarkdown);
      setBaselineMarkdown(nextMarkdown);
      setRestoredMarkdown(null);
      setVersionEntries(nextProjectHandle.manifest.versions ?? []);
      setDocumentVersion((currentVersion) => currentVersion + 1);

      try {
        await writeProjectPatches(nextProjectHandle, nextPatches);
      } catch (error) {
        setSaveStatus("failed");
        setSaveFeedback({
          kind: "error",
          message: `Patch was applied to document.md, but Patchmark could not update patches.json: ${getProjectErrorMessage(error)}`
        });
        return;
      }

      setPatches(nextPatches);
      const linkedCommentMissing =
        Boolean(currentPatch.comment_id) && !affectedCommentUpdate.linkedCommentFound;

      try {
        await writeProjectComments(nextProjectHandle, affectedCommentUpdate.comments);
        setComments(affectedCommentUpdate.comments);
        setSaveStatus("idle");
        setSaveFeedback({
          kind:
            linkedCommentMissing || affectedCommentUpdate.needsReviewCount > 0
              ? "info"
              : "success",
          message: linkedCommentMissing
            ? "Patch applied, but the linked comment was not found. Other comment anchors were updated where needed."
            : affectedCommentUpdate.needsReviewCount > 0
              ? `Patch applied. ${affectedCommentUpdate.needsReviewCount} comment anchor${affectedCommentUpdate.needsReviewCount === 1 ? "" : "s"} need review.`
              : "Patch applied. Comment anchors were updated where needed."
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);
        setCommentsError(message);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Patch applied, but Patchmark could not update the linked comment thread."
        });
      }
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleUpdatePatchAnchor(patch: PatchmarkPatch) {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "Update patch anchor is available in Project Folder Mode."
      });
      return;
    }

    if (isSaving) {
      return;
    }

    const currentPatch = patches.find((candidate) => candidate.id === patch.id) ?? patch;

    if (currentPatch.status !== "pending") {
      setSaveFeedback({
        kind: "info",
        message: `Patch ${currentPatch.id} is already ${currentPatch.status}.`
      });
      return;
    }

    const anchorStatus = getPatchReviewAnchorStatus(markdown, currentPatch);

    if (
      anchorStatus.kind !== "pending" ||
      anchorStatus.applicability !== "table_row_rebase_available" ||
      !anchorStatus.tableRowRebase
    ) {
      setSaveFeedback({
        kind: "info",
        message: "No table-row anchor update is available for this patch."
      });
      return;
    }

    const tableRowRebase = anchorStatus.tableRowRebase;
    const reanchoredAt = new Date().toISOString();
    const nextPatches = patches.map((candidate) =>
      candidate.id === currentPatch.id
        ? {
            ...candidate,
            original_text: tableRowRebase.currentRowText,
            previous_original_text: currentPatch.original_text,
            reanchored_at: reanchoredAt,
            reanchor_reason: "table_row_normalized_match" as const
          }
        : candidate
    );

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      await writeProjectPatches(projectHandle, nextPatches);
      setPatches(nextPatches);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message:
          "Patch anchor updated to the current table row. Review, then accept the patch when ready."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleRejectPatch(patch: PatchmarkPatch) {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "Reject Patch is available in Project Folder Mode."
      });
      return;
    }

    if (isSaving) {
      return;
    }

    const currentPatch = patches.find((candidate) => candidate.id === patch.id) ?? patch;

    if (currentPatch.status !== "pending") {
      setSaveFeedback({
        kind: "info",
        message: `Patch ${currentPatch.id} is already ${currentPatch.status}.`
      });
      return;
    }

    const confirmed = window.confirm(
      "Reject this patch proposal?\n\nThe document will not be changed.\nThe linked comment will remain open."
    );

    if (!confirmed) {
      return;
    }

    setSaveStatus("saving");
    setCommentsError(null);
    setSaveFeedback(null);

    const rejectedAt = new Date().toISOString();
    const nextPatches = patches.map((candidate) =>
      candidate.id === currentPatch.id
        ? {
            ...candidate,
            status: "rejected" as const,
            resolved_at: rejectedAt,
            rejected_at: rejectedAt
          }
        : candidate
    );

    try {
      await writeProjectPatches(projectHandle, nextPatches);
      setPatches(nextPatches);

      if (!currentPatch.comment_id) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Patch rejected."
        });
        return;
      }

      const nextComments = appendPatchSystemThreadEntry({
        comments,
        commentId: currentPatch.comment_id,
        content: `Patch ${currentPatch.id} was rejected.`,
        createdAt: rejectedAt,
        patchId: currentPatch.id
      });

      if (!nextComments) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Patch rejected, but the linked comment was not found. Comment remains unresolved."
        });
        return;
      }

      try {
        await writeProjectComments(projectHandle, nextComments);
        setComments(nextComments);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Patch rejected. Comment remains open."
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);
        setCommentsError(message);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Patch rejected, but Patchmark could not update the linked comment thread."
        });
      }
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleRejectPatchGroup(group: DerivedPatchGroup) {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "Reject Patch Group is available in Project Folder Mode."
      });
      return;
    }

    if (isSaving) {
      return;
    }

    const pendingPatchIds = new Set(
      group.patches
        .filter((patch) => patch.status === "pending")
        .map((patch) => patch.id)
    );

    if (pendingPatchIds.size === 0) {
      setSaveFeedback({
        kind: "info",
        message: "This patch group has no pending patches to reject."
      });
      return;
    }

    const confirmed = window.confirm(
      "Reject all pending patches in this group? The document will not be changed."
    );

    if (!confirmed) {
      return;
    }

    setSaveStatus("saving");
    setCommentsError(null);
    setSaveFeedback(null);

    const rejectedAt = new Date().toISOString();
    const nextPatches = patches.map((candidate) =>
      pendingPatchIds.has(candidate.id) && candidate.status === "pending"
        ? {
            ...candidate,
            status: "rejected" as const,
            resolved_at: rejectedAt,
            rejected_at: rejectedAt
          }
        : candidate
    );

    try {
      await writeProjectPatches(projectHandle, nextPatches);
      setPatches(nextPatches);

      if (!group.comment_id) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Pending patches in group rejected."
        });
        return;
      }

      const nextComments = appendPatchSystemThreadEntry({
        comments,
        commentId: group.comment_id,
        content: `Pending patches in ${group.display_id} were rejected.`,
        createdAt: rejectedAt
      });

      if (!nextComments) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Pending patches in group rejected, but the linked comment was not found. Comment remains unresolved."
        });
        return;
      }

      try {
        await writeProjectComments(projectHandle, nextComments);
        setComments(nextComments);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Pending patches in group rejected. Comment remains open."
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);
        setCommentsError(message);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Pending patches in group rejected, but Patchmark could not update the linked comment thread."
        });
      }
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  function jumpToMarkdownSelection(start: number, end: number) {
    setMode("markdown");
    setMarkdownSelectionRequest({
      end,
      nonce: Date.now(),
      start
    });
  }

  function handleEditorMouseUp() {
    if (mode !== "visual") {
      return;
    }

    setVisualSelectionDraft(
      createVisualSelectionDraftResult({
        container: editorDocumentRef.current,
        markdown
      }).draft
    );
  }

  function handleEditorClick(event: React.MouseEvent<HTMLDivElement>) {
    if (mode !== "visual" || isToolbarContextMenuTarget(event.target)) {
      return;
    }

    const matchingCommentIds = findVisualCommentIdsAtPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      comments,
      container: editorDocumentRef.current,
      headings,
      markdown
    });

    if (matchingCommentIds.length === 1) {
      setActiveCommentState({
        kind: "comment",
        commentId: matchingCommentIds[0]
      });
      return;
    }

    if (matchingCommentIds.length > 1) {
      setActiveCommentState({
        kind: "anchor_group",
        commentIds: matchingCommentIds
      });
    }
  }

  function handleEditorContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    if (!fileName || isToolbarContextMenuTarget(event.target)) {
      return;
    }

    event.preventDefault();

    const selectionResult =
      mode === "markdown"
        ? createMarkdownSelectionDraftResult(markdown, markdownSelection)
        : createVisualSelectionDraftResult({
            container: editorDocumentRef.current,
            markdown
          });
    const selectedDraft = selectionResult.draft;
    const headingForSelection =
      typeof selectedDraft?.markdownStartOffset === "number"
        ? getHeadingContainingOffset(
            markdown,
            headings,
            selectedDraft.markdownStartOffset
          )
        : mode === "visual"
          ? findVisualHeadingForPoint({
              container: editorDocumentRef.current,
              headings,
              pointY: event.clientY
            }) ?? defaultCommentHeading
          : defaultCommentHeading;

    if (mode === "visual") {
      setVisualSelectionDraft(selectedDraft);
    }

    setCommentContextMenu({
      defaultHeadingLine: headingForSelection?.line ?? null,
      selectionHelp: selectionResult.help,
      selectedDraft,
      x: event.clientX,
      y: event.clientY
    });
  }

  function handleOpenCommentFromMenu(scope: CommentAnchorScope) {
    if (!commentContextMenu) {
      return;
    }

    const selectedDraft =
      commentContextMenu.selectedDraft?.anchorSource === "visual"
        ? commentContextMenu.selectedDraft
        : null;
    const positionTop = measurePendingCommentTop({
      scope,
      selectedDraft: commentContextMenu.selectedDraft,
      targetHeadingLine: commentContextMenu.defaultHeadingLine
    });

    setVisualSelectionDraft(
      selectedDraft
    );
    setCommentAddRequest({
      nonce: Date.now(),
      positionTop,
      scope,
      targetHeadingLine: commentContextMenu.defaultHeadingLine
    });
    setCommentContextMenu(null);
  }

  function measurePendingCommentTop({
    scope,
    selectedDraft,
    targetHeadingLine
  }: {
    scope: CommentAnchorScope;
    selectedDraft: SelectedCommentAnchorDraft | null;
    targetHeadingLine: number | null;
  }): number | null {
    const container = editorDocumentRef.current;
    const workspace = documentWorkspaceRef.current;

    if (!container || !workspace) {
      return scope === "document" ? 0 : null;
    }

    try {
      const anchor = createCommentAnchor({
        headings,
        markdown,
        selection: markdownSelection,
        selectedDraft,
        values: {
          anchorScope: scope,
          comment: "",
          targetHeadingLine,
          type: "note"
        }
      });
      const previewComment: PatchmarkComment = {
        id: "PM-COMMENT-DRAFT",
        type: "note",
        status: "open",
        anchor,
        comment: "",
        thread: [],
        export_state: {
          focus_state: "idle"
        },
        created_at: "",
        updated_at: ""
      };
      const workspaceRect = workspace.getBoundingClientRect();
      const editorRect = container.getBoundingClientRect();
      const editorTop = Math.max(0, editorRect.top - workspaceRect.top);

      return computeCommentPreferredTop({
        comment: previewComment,
        container,
        editorTop,
        headings,
        markdown,
        mode,
        workspaceRect
      });
    } catch {
      return scope === "document" ? 0 : null;
    }
  }

  async function persistComments(
    nextComments: PatchmarkComment[],
    successMessage: string
  ) {
    if (!projectHandle || isCommentBusy) {
      return;
    }

    setIsCommentBusy(true);
    setCommentsError(null);

    try {
      await writeProjectComments(projectHandle, nextComments);
      setComments(nextComments);
      setSaveFeedback({
        kind: "success",
        message: successMessage
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
      throw error;
    } finally {
      setIsCommentBusy(false);
    }
  }

  function loadProjectIntoEditor(loadedProject: LoadedPatchmarkProject) {
    setProjectHandle(loadedProject.project);
    setFileName(loadedProject.project.manifest.document_file);
    setMarkdown(loadedProject.markdown);
    setBaselineMarkdown(loadedProject.markdown);
    setActiveFileHandle(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSnapshotDialog(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
    setPatches([]);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setDocumentLevelExportGuardDialog(null);
    setMarkCommentFocusGuardDialog(null);
    setChatGptImportDialog(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  return (
    <section
      ref={documentWorkspaceRef}
      className="document-workspace"
      aria-label="Patchmark editor"
    >
      <aside className="document-sidebar" aria-label="Document navigation">
        <DocumentOutline headings={headings} />
        <VersionHistoryPanel
          isProjectMode={isProjectMode}
          versions={versionEntries}
          onCompareVersion={handleCompareSnapshot}
          onViewVersion={handleViewSnapshot}
        />
      </aside>

      <div className="editor-panel">
        <div className="document-toolbar">
          <div className="document-toolbar-primary">
            <div className="loader-row">
              <MarkdownFileLoader onFileLoaded={handleFileLoaded} />
              <span className="file-loader-help">Accepts .md and .markdown</span>
            </div>

            <div className="project-actions" aria-label="Project folder actions">
              <button
                type="button"
                disabled={isSaving}
                onClick={handleOpenProjectFolder}
              >
                Open Project Folder
              </button>
            <button
              type="button"
              disabled={!fileName || isSaving}
              onClick={handleCreateProjectFromCurrentDocument}
            >
              Create Project From Current Document
            </button>
            <button
              type="button"
              disabled={isSaving || isCommentBusy}
              onClick={handleGenerateChatGptPrompt}
            >
              Generate ChatGPT Prompt
            </button>
            <button
              type="button"
              disabled={isSaving || isCommentBusy}
              onClick={handleOpenChatGptImportDialog}
            >
              Import ChatGPT Response
            </button>
          </div>

            <div className="workspace-status" aria-label="Workspace status">
              <span>
                Mode:{" "}
                {isProjectMode ? "Patchmark Project" : "Single Markdown File"}
              </span>
              {projectHandle ? (
                <>
                  <span>Project: {projectHandle.manifest.project_name}</span>
                  <span>Document: {projectHandle.manifest.document_file}</span>
                </>
              ) : null}
            </div>

            {fileName ? (
              <div className="document-meta">
                <span>{isProjectMode ? "Project document" : "Loaded file"}</span>
                <strong title={fileName}>{fileName}</strong>
                <DocumentStatus status={documentStatus} />
              </div>
            ) : null}
          </div>

          {fileName ? (
            <div className="document-toolbar-controls">
              <DocumentActions
                fileName={fileName}
                isSaving={isSaving}
                markdown={markdown}
                onCreateSnapshot={handleCreateSnapshot}
                onDownload={handleDownload}
                onSaveAs={handleSaveAs}
                onSaveChanges={handleSaveChanges}
                showCreateSnapshot={isProjectMode}
              />
              <div className="mode-switcher" aria-label="Editor mode">
                <button
                  type="button"
                  aria-pressed={mode === "visual"}
                  onClick={() => setMode("visual")}
                >
                  Visual Mode
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "markdown"}
                  onClick={() => setMode("markdown")}
                >
                  Markdown Mode
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {saveFeedback ? (
          <div
            className={`document-save-banner document-save-banner-${saveFeedback.kind}`}
            role={saveFeedback.kind === "error" ? "alert" : "status"}
          >
            {saveFeedback.message}
          </div>
        ) : null}

        {!fileName && availableDraft ? (
          <DraftRestoreBanner
            draft={availableDraft}
            onRestore={handleRestoreDraft}
            onDiscard={handleDiscardDraft}
          />
        ) : null}

        <div
          ref={editorDocumentRef}
          className="editor-body"
          onClick={handleEditorClick}
          onContextMenu={handleEditorContextMenu}
          onMouseUp={handleEditorMouseUp}
        >
          {fileName ? (
            mode === "visual" ? (
              <VisualMarkdownEditor
                key={documentVersion}
                markdown={markdown}
                onMarkdownChange={handleMarkdownChange}
              />
            ) : (
              <MarkdownSourceEditor
                markdown={markdown}
                onMarkdownChange={handleMarkdownChange}
                onSelectionChange={setMarkdownSelection}
                selectionRequest={markdownSelectionRequest}
              />
            )
          ) : (
            <div className="empty-state">
              <div>
                <h2>Load a Markdown file to begin.</h2>
                <p>
                  Markdown is the source of truth across Visual Mode and
                  Markdown Mode.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <aside className="comments-rail" aria-label="Document comments">
        <CommentsPanel
          addRequest={commentAddRequest}
          activeCommentState={activeCommentState}
          anchorSummaries={commentAnchorSummaries}
          commentPositions={commentPositions}
          comments={comments}
          defaultSectionLine={defaultCommentHeading?.line ?? null}
          error={commentsError}
          headings={headings}
          isBusy={isCommentBusy}
          isProjectMode={isProjectMode}
          onAddComment={handleAddComment}
          onDeleteComment={handleDeleteComment}
          onEditComment={handleEditComment}
          onFindComment={handleFindComment}
          onMarkCommentForExport={handleMarkCommentForExport}
          onReopenComment={handleReopenComment}
          onReplyComment={handleReplyToComment}
          onReviewCommentPatches={handleReviewCommentPatches}
          onReviewFirstPendingPatch={handleReviewFirstPendingPatch}
          onResolveComment={handleResolveComment}
          onSetActiveCommentState={setActiveCommentState}
          onUnmarkCommentForExport={handleUnmarkCommentForExport}
          patchGroupSummariesByCommentId={patchGroupSummariesByCommentId}
          pendingPatchGroupTotal={pendingPatchGroups.length}
          pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
          pendingPatchTotal={pendingPatches.length}
          selectedTextPreview={selectedCommentText || null}
          selectedAnchorContextKind={selectedCommentAnchorContextKind}
        />
      </aside>

      {commentContextMenu ? (
        <div
          className="comment-context-menu"
          style={{ left: commentContextMenu.x, top: commentContextMenu.y }}
          role="menu"
          aria-label="Patchmark comment menu"
          onClick={(event) => event.stopPropagation()}
        >
          {!isProjectMode ? (
            <span className="comment-context-menu-note">
              Comments require Project Folder Mode.
            </span>
          ) : null}
          {commentContextMenu.selectedDraft || commentContextMenu.selectionHelp ? (
            <button
              type="button"
              role="menuitem"
              disabled={!isProjectMode || !commentContextMenu.selectedDraft}
              onClick={() => handleOpenCommentFromMenu("selected_text")}
            >
              Add Comment to Selection
            </button>
          ) : null}
          {isProjectMode && commentContextMenu.selectionHelp ? (
            <span className="comment-context-menu-note">
              {SHORT_SELECTION_HELP}
            </span>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!isProjectMode || !commentContextMenu.defaultHeadingLine}
            onClick={() => handleOpenCommentFromMenu("section")}
          >
            Add Comment to Section
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!isProjectMode}
            onClick={() => handleOpenCommentFromMenu("document")}
          >
            Add Comment to Document
          </button>
          {isProjectMode && !commentContextMenu.defaultHeadingLine ? (
            <span className="comment-context-menu-note">
              No section detected here.
            </span>
          ) : null}
        </div>
      ) : null}

      {snapshotDialog ? (
        <SnapshotDialog
          dialog={snapshotDialog}
          onClose={() => setSnapshotDialog(null)}
        />
      ) : null}

      {markCommentFocusGuardDialog ? (
        <div className="snapshot-dialog-backdrop">
          <section
            className="comment-export-dialog document-export-guard-dialog"
            aria-label="Mark for ChatGPT compatibility guard"
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Mark for ChatGPT</span>
                <h2>Document-level comments require a dedicated ChatGPT round.</h2>
                <p>
                  Full-document comments are exclusive focused units for the
                  current ChatGPT round.
                </p>
              </div>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setMarkCommentFocusGuardDialog(null)}
              >
                Cancel
              </button>
            </header>
            <div className="document-export-guard-body">
              {markCommentFocusGuardDialog.kind ===
              "mark_non_document_with_document_focus" ? (
                <>
                  <p>
                    A document-level comment is already marked for ChatGPT. To
                    mark this comment, unmark the document-level comment first.
                  </p>
                  <div className="comment-export-actions">
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => {
                        void handleConfirmMarkCommentFocusGuard();
                      }}
                    >
                      Unmark document-level comment and mark this comment
                    </button>
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => setMarkCommentFocusGuardDialog(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : markCommentFocusGuardDialog.kind ===
                "mark_document_with_non_document_focus" ? (
                <>
                  <p>
                    This is a document-level comment. Marking it will unmark{" "}
                    {markCommentFocusGuardDialog.nonDocumentCommentIds.length}{" "}
                    other focused comment
                    {markCommentFocusGuardDialog.nonDocumentCommentIds
                      .length === 1
                      ? ""
                      : "s"}
                    .
                  </p>
                  <div className="comment-export-actions">
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => {
                        void handleConfirmMarkCommentFocusGuard();
                      }}
                    >
                      Unmark other comments and mark document-level comment
                    </button>
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => setMarkCommentFocusGuardDialog(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Another document-level comment is already marked for
                    ChatGPT. Only one document-level comment can be focused at a
                    time.
                  </p>
                  {markCommentFocusGuardDialog.nonDocumentCommentIds.length >
                  0 ? (
                    <p>
                      Patchmark also found{" "}
                      {markCommentFocusGuardDialog.nonDocumentCommentIds.length}{" "}
                      other focused comment
                      {markCommentFocusGuardDialog.nonDocumentCommentIds
                        .length === 1
                        ? ""
                        : "s"}
                      , which will be unmarked so this document-level comment can
                      be handled alone.
                    </p>
                  ) : null}
                  <div className="comment-export-actions">
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => {
                        void handleConfirmMarkCommentFocusGuard();
                      }}
                    >
                      Unmark other document-level comment and mark this one
                    </button>
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => setMarkCommentFocusGuardDialog(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {documentLevelExportGuardDialog ? (
        <div className="snapshot-dialog-backdrop">
          <section
            className="comment-export-dialog document-export-guard-dialog"
            aria-label="Document-level ChatGPT export guard"
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Focused comments</span>
                <h2>Document-level comments require a dedicated ChatGPT round.</h2>
                <p>
                  Whole-document comments use full-document context and should
                  not be mixed with smaller section or selected-text tasks.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDocumentLevelExportGuardDialog(null)}
              >
                Cancel
              </button>
            </header>
            <div className="document-export-guard-body">
              {documentLevelExportGuardDialog.kind === "mixed_document_comment" ? (
                <>
                  <p>
                    This focused set includes a whole-document comment plus{" "}
                    {documentLevelExportGuardDialog.nonDocumentCommentIds.length}{" "}
                    other focused comment
                    {documentLevelExportGuardDialog.nonDocumentCommentIds.length === 1
                      ? ""
                      : "s"}
                    . Generate a dedicated prompt for the document-level comment,
                    or unmark the other comments first.
                  </p>
                  <div className="comment-export-actions">
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={handleGenerateDedicatedDocumentPromptFromGuard}
                    >
                      Generate dedicated prompt
                    </button>
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => {
                        void handleUnmarkOtherFocusedCommentsAndGenerate();
                      }}
                    >
                      Unmark other comments and continue
                    </button>
                    <button
                      type="button"
                      disabled={isCommentBusy}
                      onClick={() => setDocumentLevelExportGuardDialog(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Only one document-level comment can be exported at a time.
                    Choose one document-level comment for this ChatGPT round and
                    unmark the others.
                  </p>
                  <ul className="document-export-guard-list">
                    {documentLevelExportGuardDialog.documentCommentIds.map(
                      (commentId) => (
                        <li key={commentId}>{commentId}</li>
                      )
                    )}
                  </ul>
                  <div className="comment-export-actions">
                    <button
                      type="button"
                      onClick={() => setDocumentLevelExportGuardDialog(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {chatGptPromptDialog ? (
        <div className="snapshot-dialog-backdrop">
          <section
            className="comment-export-dialog"
            aria-label="Generate ChatGPT prompt"
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>
                  {chatGptPromptDialog.dedicatedDocumentReview
                    ? "Document-level comment"
                    : "Focused comments"}
                </span>
                <h2>
                  {chatGptPromptDialog.dedicatedDocumentReview
                    ? "Generate Dedicated ChatGPT Prompt"
                    : "Generate ChatGPT Prompt"}
                </h2>
                <p>
                  {chatGptPromptDialog.dedicatedDocumentReview
                    ? "This Markdown prompt is dedicated to one whole-document comment. Copying or saving marks only that comment as exported."
                    : "This Markdown prompt is ready to paste into ChatGPT. Copying or saving marks focused comments as exported, but does not resolve them."}
                </p>
              </div>
              <button type="button" onClick={() => setChatGptPromptDialog(null)}>
                Close
              </button>
            </header>
            <div className="comment-export-actions">
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleCopyChatGptPrompt}
              >
                Copy Prompt
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleSaveChatGptPrompt}
              >
                Save Prompt
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleCopyFocusedJsonPayload}
              >
                Copy JSON Payload
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleSaveFocusedJsonPayload}
              >
                Save JSON Payload
              </button>
              <span>{chatGptPromptDialog.promptFileName}</span>
            </div>
            <label className="comment-export-json">
              <span>Generated prompt</span>
              <textarea readOnly value={chatGptPromptDialog.promptText} />
            </label>
            <details className="comment-export-payload-details">
              <summary>JSON Payload</summary>
              <textarea readOnly value={chatGptPromptDialog.jsonText} />
            </details>
          </section>
        </div>
      ) : null}

      {chatGptImportDialog ? (
        <div className="snapshot-dialog-backdrop">
          <form
            className="comment-import-dialog"
            aria-label="Import ChatGPT response"
            onSubmit={handleImportChatGptResponse}
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Focused comments</span>
                <h2>Import ChatGPT Response</h2>
                <p>
                  Paste the JSON response from ChatGPT. Patchmark will attach
                  replies to matching comments and store patch proposals for
                  review.
                </p>
              </div>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setChatGptImportDialog(null)}
              >
                Cancel
              </button>
            </header>
            {chatGptImportDialog.error ? (
              <div className="comment-import-error" role="alert">
                <p>{chatGptImportDialog.error}</p>
                <label>
                  <span>Repair prompt</span>
                  <textarea readOnly value={CHATGPT_IMPORT_REPAIR_PROMPT} />
                </label>
              </div>
            ) : null}
            <div className="comment-import-fields">
              <label>
                <span>Optional ChatGPT chat URL</span>
                <input
                  type="url"
                  placeholder="https://chatgpt.com/..."
                  value={chatGptImportDialog.sourceChatUrl}
                  onChange={(event) =>
                    setChatGptImportDialog({
                      ...chatGptImportDialog,
                      error: null,
                      sourceChatUrl: event.target.value
                    })
                  }
                />
              </label>
              <label>
                <span>ChatGPT response JSON</span>
                <textarea
                  required
                  value={chatGptImportDialog.responseJson}
                  onChange={(event) =>
                    setChatGptImportDialog({
                      ...chatGptImportDialog,
                      error: null,
                      responseJson: event.target.value
                    })
                  }
                />
              </label>
            </div>
            <div className="comment-import-actions">
              <button type="submit" disabled={isCommentBusy}>
                Import
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setChatGptImportDialog(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {patchGroupListDialog ? (
        <PatchGroupListDialog
          groups={patchGroupListGroups}
          onClose={() => setPatchGroupListDialog(null)}
          onOpenGroup={handleOpenPatchGroup}
          scopeLabel={
            patchGroupListDialog.commentId
              ? `linked to ${patchGroupListDialog.commentId}`
              : "with pending proposals"
          }
        />
      ) : null}
      {selectedPatchGroup ? (
        <PatchGroupReviewDialog
          comment={selectedPatchGroupComment}
          group={selectedPatchGroup}
          isPatchActionBusy={isSaving}
          onClose={() => {
            setSelectedPatchGroupId(null);
            setPatchReviewGroupScopeId(null);
          }}
          onRejectPendingPatches={() => handleRejectPatchGroup(selectedPatchGroup)}
          onReviewPatch={(patch) =>
            handleReviewPatchFromGroup(selectedPatchGroup, patch)
          }
        />
      ) : null}
      {selectedPatch && selectedPatchAnchorStatus ? (
        <PatchReviewDialog
          anchorStatus={selectedPatchAnchorStatus}
          comment={selectedPatchComment}
          hasMultipleReviewablePatches={reviewablePatches.length > 1}
          isPatchActionBusy={isSaving}
          markdown={markdown}
          onAcceptPatch={() => handleAcceptPatch(selectedPatch)}
          onBackToGroup={
            selectedPatchDerivedGroup
              ? () => {
                  setSelectedPatchGroupId(selectedPatchDerivedGroup.id);
                  setSelectedPatchId(null);
                  setPatchReviewGroupScopeId(null);
                }
              : undefined
          }
          onClose={() => {
            setSelectedPatchId(null);
            setPatchReviewCommentScopeId(null);
            setPatchReviewGroupScopeId(null);
          }}
          onFindPatchAnchorText={() => handleFindPatchAnchorText(selectedPatch)}
          onNextPatch={() => handleNavigatePatchReview(1)}
          onPreviousPatch={() => handleNavigatePatchReview(-1)}
          onRejectPatch={() => handleRejectPatch(selectedPatch)}
          onUpdatePatchAnchor={() => handleUpdatePatchAnchor(selectedPatch)}
          patch={selectedPatch}
          patchGroup={selectedPatchDerivedGroup}
          patchIndex={Math.max(
            0,
            reviewablePatches.findIndex((patch) => patch.id === selectedPatch.id)
          )}
          reviewablePatchCount={reviewablePatches.length}
        />
      ) : null}
    </section>
  );
}

function PatchGroupListDialog({
  groups,
  onClose,
  onOpenGroup,
  scopeLabel
}: {
  groups: DerivedPatchGroup[];
  onClose: () => void;
  onOpenGroup: (groupId: string) => void;
  scopeLabel: string;
}) {
  return (
    <div className="snapshot-dialog-backdrop">
      <section className="comment-export-dialog patch-group-list-dialog">
        <header className="snapshot-dialog-header">
          <div>
            <span>Patch groups</span>
            <h2>Pending Patch Groups</h2>
            <p>
              Review bundles {scopeLabel}. Each patch still requires individual
              review.
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="patch-group-list-body">
          {groups.length === 0 ? (
            <p className="patch-review-source-note">
              No patch groups match this view.
            </p>
          ) : (
            groups.map((group) => (
              <PatchGroupSummaryCard
                group={group}
                key={group.id}
                onOpenGroup={onOpenGroup}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function PatchGroupReviewDialog({
  comment,
  group,
  isPatchActionBusy,
  onClose,
  onRejectPendingPatches,
  onReviewPatch
}: {
  comment: PatchmarkComment | null;
  group: DerivedPatchGroup;
  isPatchActionBusy: boolean;
  onClose: () => void;
  onRejectPendingPatches: () => void;
  onReviewPatch: (patch: PatchmarkPatch) => void;
}) {
  const latestChatGptReply = comment
    ? getLatestChatGptThreadEntry(comment)
    : null;
  const pendingPatchCount = group.status_summary.pending;
  const needsReviewCount = getPatchGroupNeedsReviewCount(group);
  const nextPendingPatch =
    group.patches.find((patch) => patch.status === "pending") ?? null;
  const rejectGroupButtonLabel =
    pendingPatchCount > 0 && pendingPatchCount < group.status_summary.total
      ? "Reject remaining pending patches"
      : "Reject Patch Group";

  return (
    <div className="snapshot-dialog-backdrop patch-review-backdrop">
      <section className="patch-review-dialog" aria-label="Review Patch Group">
        <header className="snapshot-dialog-header">
          <div>
            <span>Patch group</span>
            <h2>Review Patch Group</h2>
            <p>
              This is a review bundle. Patchmark will not apply or resolve
              anything automatically.
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="patch-review-body">
          <section className="patch-review-card">
            <h3>Group metadata</h3>
            <dl className="patch-metadata">
              <div>
                <dt>Patch group ID</dt>
                <dd>{group.display_id}</dd>
              </div>
              <div>
                <dt>Linked comment ID</dt>
                <dd>{group.comment_id ?? "None"}</dd>
              </div>
              <div>
                <dt>Source import ID</dt>
                <dd>{group.source_import_id ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Created at</dt>
                <dd>{formatPatchDate(group.created_at)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{getPatchGroupStatusLabel(group.status)}</dd>
              </div>
            </dl>
            {group.source_chat_url ? (
              <a
                className="patch-source-chat-link"
                href={group.source_chat_url}
                target="_blank"
                rel="noreferrer"
              >
                Open ChatGPT chat
              </a>
            ) : null}
          </section>

          <section className="patch-review-card">
            <h3>Status summary</h3>
            <div className="patch-group-progress" aria-label="Patch group progress">
              {getPatchGroupProgressItems(group.status_summary).map((item) => (
                <span
                  className={`patch-group-progress-item patch-group-progress-${item.key}`}
                  key={item.key}
                >
                  <strong>{item.count}</strong> {item.label}
                </span>
              ))}
            </div>
            <p>{formatPatchGroupStatusSummary(group.status_summary)}</p>
            <p>{formatPatchGroupApplicabilitySummary(group)}</p>
            {needsReviewCount > 0 ? (
              <p className="patch-group-needs-review">
                Needs review: {needsReviewCount} pending patch
                {needsReviewCount === 1 ? "" : "es"} cannot be applied
                automatically yet.
              </p>
            ) : null}
            <div className="patch-group-review-actions">
              <button
                type="button"
                className="patch-group-next-button"
                disabled={!nextPendingPatch}
                onClick={() => {
                  if (nextPendingPatch) {
                    onReviewPatch(nextPendingPatch);
                  }
                }}
              >
                Next pending patch
              </button>
              <button
                type="button"
                className="patch-group-reject-button"
                disabled={isPatchActionBusy || pendingPatchCount === 0}
                onClick={onRejectPendingPatches}
              >
                {rejectGroupButtonLabel}
              </button>
              <span>
                {pendingPatchCount > 0
                  ? `Rejects ${pendingPatchCount} pending patch${
                      pendingPatchCount === 1 ? "" : "es"
                    } only. The document will not be changed.`
                  : "No pending patches remain in this group."}
              </span>
            </div>
          </section>

          {comment ? (
            <section className="patch-review-card">
              <h3>Linked comment context</h3>
              <p>{comment.comment}</p>
              {latestChatGptReply ? (
                <blockquote className="patch-linked-reply">
                  Latest ChatGPT reply: {latestChatGptReply.content}
                </blockquote>
              ) : null}
            </section>
          ) : null}

          <section className="patch-review-card">
            <h3>Patches in this group</h3>
            <div className="patch-group-patch-list">
              {group.patches.map((patch, index) => (
                <PatchGroupPatchCard
                  group={group}
                  index={index}
                  key={patch.id}
                  onReviewPatch={onReviewPatch}
                  patch={patch}
                />
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function PatchGroupSummaryCard({
  group,
  onOpenGroup
}: {
  group: DerivedPatchGroup;
  onOpenGroup: (groupId: string) => void;
}) {
  return (
    <article className="patch-group-summary-card">
      <div>
        <span className={`patch-group-status patch-group-status-${group.status}`}>
          {getPatchGroupStatusLabel(group.status)}
        </span>
        <h3>{group.display_id}</h3>
        <div className="patch-group-progress patch-group-progress-compact">
          {getPatchGroupProgressItems(group.status_summary).map((item) => (
            <span
              className={`patch-group-progress-item patch-group-progress-${item.key}`}
              key={item.key}
            >
              <strong>{item.count}</strong> {item.label}
            </span>
          ))}
        </div>
        <p>{formatPatchGroupStatusSummary(group.status_summary)}</p>
        <p>{formatPatchGroupApplicabilitySummary(group)}</p>
        {group.comment_id ? <small>Linked comment: {group.comment_id}</small> : null}
      </div>
      <button type="button" onClick={() => onOpenGroup(group.id)}>
        Review group
      </button>
    </article>
  );
}

function PatchGroupPatchCard({
  group,
  index,
  onReviewPatch,
  patch
}: {
  group: DerivedPatchGroup;
  index: number;
  onReviewPatch: (patch: PatchmarkPatch) => void;
  patch: PatchmarkPatch;
}) {
  const anchorStatus =
    group.anchor_status_by_patch_id[patch.id] ??
    getPatchReviewAnchorStatus("", patch);
  const displayState = getPatchDisplayState(patch, anchorStatus);
  const lifecycleDetail = getPatchLifecycleDetail(patch);
  const snapshotDetail = getPatchSnapshotDetail(patch);

  return (
    <article
      className={`patch-group-patch-card patch-group-patch-card-${displayState}`}
    >
      <div>
        <div className="patch-group-patch-heading">
          <strong>
            Patch {index + 1} of {group.patches.length}
          </strong>
          <span className={`patch-status-badge patch-status-badge-${displayState}`}>
            {getPatchStatusBadgeLabel(displayState)}
          </span>
        </div>
        <span>{patch.id}</span>
        {lifecycleDetail ? <span>{lifecycleDetail}</span> : null}
        {snapshotDetail ? <span>{snapshotDetail}</span> : null}
        <span>Target: {patch.target_heading ?? "Not specified"}</span>
        <span>{getPatchReviewAnchorShortLabel(anchorStatus)}</span>
      </div>
      <p>{patch.reason}</p>
      <button type="button" onClick={() => onReviewPatch(patch)}>
        {getPatchReviewButtonLabel(displayState)}
      </button>
    </article>
  );
}

function PatchReviewDialog({
  anchorStatus,
  comment,
  hasMultipleReviewablePatches,
  isPatchActionBusy,
  markdown,
  onAcceptPatch,
  onBackToGroup,
  onClose,
  onFindPatchAnchorText,
  onNextPatch,
  onPreviousPatch,
  onRejectPatch,
  onUpdatePatchAnchor,
  patch,
  patchGroup,
  patchIndex,
  reviewablePatchCount
}: {
  anchorStatus: PatchReviewAnchorStatus;
  comment: PatchmarkComment | null;
  hasMultipleReviewablePatches: boolean;
  isPatchActionBusy: boolean;
  markdown: string;
  onAcceptPatch: () => void;
  onBackToGroup?: () => void;
  onClose: () => void;
  onFindPatchAnchorText: () => void;
  onNextPatch: () => void;
  onPreviousPatch: () => void;
  onRejectPatch: () => void;
  onUpdatePatchAnchor: () => void;
  patch: PatchmarkPatch;
  patchGroup: DerivedPatchGroup | null;
  patchIndex: number;
  reviewablePatchCount: number;
}) {
  const latestChatGptReply = comment
    ? getLatestChatGptThreadEntry(comment)
    : null;
  const suggestedTextSources = patch.suggested_text_sources ?? [];
  const reasonSources = patch.reason_sources ?? patch.sources ?? [];
  const riskSources = patch.risk_sources ?? [];
  const [reviewMode, setReviewMode] = useState<PatchReviewMode>("visual");
  const visualPreview = useMemo(
    () => createPatchVisualPreview(markdown, patch, anchorStatus),
    [anchorStatus, markdown, patch]
  );
  const acceptDisabledMessage = getPatchAcceptDisabledMessage(
    patch,
    anchorStatus.kind === "pending" ? anchorStatus.applicability : "not_found"
  );
  const sourceReferenceWarnings = getPatchSourceReferenceWarnings(patch);
  const canAcceptPatch =
    patch.status === "pending" && !acceptDisabledMessage && !isPatchActionBusy;
  const canRejectPatch = patch.status === "pending" && !isPatchActionBusy;
  const canUpdatePatchAnchor =
    anchorStatus.kind === "pending" &&
    anchorStatus.applicability === "table_row_rebase_available" &&
    !isPatchActionBusy;
  const patchDisplayState = getPatchDisplayState(patch, anchorStatus);

  useEffect(() => {
    setReviewMode("visual");
  }, [patch.id]);

  return (
    <div className="snapshot-dialog-backdrop patch-review-backdrop">
      <section className="patch-review-dialog" aria-label="Review Patch Proposal">
        <header className="snapshot-dialog-header">
          <div>
            <span>Patch proposal</span>
            <div className="patch-review-heading-row">
              <h2>Review Patch Proposal</h2>
              <span
                className={`patch-status-badge patch-status-badge-${patchDisplayState}`}
              >
                {getPatchStatusBadgeLabel(patchDisplayState)}
              </span>
            </div>
            <p>{getPatchReviewIntro(patchDisplayState)}</p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="patch-review-actions">
          {onBackToGroup ? (
            <button type="button" onClick={onBackToGroup}>
              Back to group
            </button>
          ) : null}
          <button type="button" onClick={onFindPatchAnchorText}>
            {patch.status === "accepted" ? "Find applied text" : "Find original text"}
          </button>
          {patch.status === "pending" ? (
            <div className="patch-decision-actions">
              {anchorStatus.kind === "pending" &&
              anchorStatus.applicability === "table_row_rebase_available" ? (
                <button
                  type="button"
                  className="patch-anchor-update-button"
                  disabled={!canUpdatePatchAnchor}
                  onClick={onUpdatePatchAnchor}
                >
                  Update patch anchor
                </button>
              ) : null}
              <button
                type="button"
                className="patch-accept-button"
                disabled={!canAcceptPatch}
                onClick={onAcceptPatch}
              >
                Accept Patch
              </button>
              <button
                type="button"
                disabled={!canRejectPatch}
                onClick={onRejectPatch}
              >
                Reject Patch
              </button>
              {acceptDisabledMessage ? (
                <span>{acceptDisabledMessage}</span>
              ) : (
                <span>
                  Accepting creates a safety snapshot. The linked comment stays open.
                </span>
              )}
            </div>
          ) : (
            <span>{getPatchResolvedStatusMessage(patch)}</span>
          )}
          {hasMultipleReviewablePatches ? (
            <>
              <button type="button" onClick={onPreviousPatch}>
                Previous patch
              </button>
              <button type="button" onClick={onNextPatch}>
                Next patch
              </button>
              <span>
                Patch {patchIndex + 1} of {reviewablePatchCount}
              </span>
            </>
          ) : null}
        </div>

        <div
          className={`patch-applicability patch-applicability-${getPatchReviewAnchorClassName(anchorStatus)}`}
          role="status"
        >
          <strong>{getPatchReviewAnchorLabel(anchorStatus)}</strong>
          <span>{getPatchReviewAnchorDetail(anchorStatus)}</span>
        </div>

        {sourceReferenceWarnings.length > 0 ? (
          <div className="patch-review-warnings" role="note">
            {sourceReferenceWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}

        <div className="patch-review-body">
          <section className="patch-review-card">
            <h3>Metadata</h3>
            <dl className="patch-metadata">
              <div>
                <dt>Patch ID</dt>
                <dd>{patch.id}</dd>
              </div>
              {patchGroup ? (
                <>
                  <div>
                    <dt>Patch group ID</dt>
                    <dd>{patchGroup.display_id}</dd>
                  </div>
                  <div>
                    <dt>Group position</dt>
                    <dd>
                      Patch{" "}
                      {patchGroup.patches.findIndex(
                        (groupPatch) => groupPatch.id === patch.id
                      ) + 1}{" "}
                      of {patchGroup.patches.length}
                    </dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>Status</dt>
                <dd>
                  <span
                    className={`patch-status-badge patch-status-badge-${patchDisplayState}`}
                  >
                    {getPatchStatusBadgeLabel(patchDisplayState)}
                  </span>
                </dd>
              </div>
              {patch.status === "accepted" ? (
                <div>
                  <dt>Applied anchor</dt>
                  <dd>{getPatchReviewAnchorShortLabel(anchorStatus)}</dd>
                </div>
              ) : null}
              {anchorStatus.kind === "accepted" ? (
                <div>
                  <dt>Anchor validation result</dt>
                  <dd>{getAcceptedPatchAnchorDiagnostic(anchorStatus)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Linked comment ID</dt>
                <dd>{patch.comment_id ?? "None"}</dd>
              </div>
              <div>
                <dt>Target heading</dt>
                <dd>{patch.target_heading ?? "Not specified"}</dd>
              </div>
              <div>
                <dt>Created at</dt>
                <dd>{formatPatchDate(patch.created_at)}</dd>
              </div>
              <div>
                <dt>Source import ID</dt>
                <dd>{patch.source_import_id ?? "Not recorded"}</dd>
              </div>
              {patch.accepted_at ? (
                <div>
                  <dt>Accepted at</dt>
                  <dd>{formatPatchDate(patch.accepted_at)}</dd>
                </div>
              ) : null}
              {patch.applied_at ? (
                <div>
                  <dt>Applied at</dt>
                  <dd>{formatPatchDate(patch.applied_at)}</dd>
                </div>
              ) : null}
              {patch.rejected_at ? (
                <div>
                  <dt>Rejected at</dt>
                  <dd>{formatPatchDate(patch.rejected_at)}</dd>
                </div>
              ) : null}
              {patch.pre_apply_snapshot_id ? (
                <div>
                  <dt>Pre-apply snapshot</dt>
                  <dd>{patch.pre_apply_snapshot_id}</dd>
                </div>
              ) : null}
              {patch.pre_apply_snapshot_file ? (
                <div>
                  <dt>Pre-apply snapshot file</dt>
                  <dd>{patch.pre_apply_snapshot_file}</dd>
                </div>
              ) : null}
              {patch.reanchored_at ? (
                <div>
                  <dt>Anchor updated at</dt>
                  <dd>{formatPatchDate(patch.reanchored_at)}</dd>
                </div>
              ) : null}
              {patch.reanchor_reason ? (
                <div>
                  <dt>Anchor update reason</dt>
                  <dd>{formatPatchReanchorReason(patch.reanchor_reason)}</dd>
                </div>
              ) : null}
            </dl>
            {patch.source_chat_url ? (
              <a
                className="patch-source-chat-link"
                href={patch.source_chat_url}
                target="_blank"
                rel="noreferrer"
              >
                Open ChatGPT chat
              </a>
            ) : null}
          </section>

          {comment ? (
            <section className="patch-review-card">
              <h3>Linked comment context</h3>
              <p>{comment.comment}</p>
              {latestChatGptReply ? (
                <blockquote className="patch-linked-reply">
                  Latest ChatGPT reply: {latestChatGptReply.content}
                </blockquote>
              ) : null}
            </section>
          ) : null}

          <section className="patch-review-card patch-review-mode-card">
            <div>
              <h3>Review mode</h3>
              <p>
                Visual mode is for readability only. Markdown remains the source
                of truth.
              </p>
            </div>
            <div className="patch-review-mode-switcher" aria-label="Patch review mode">
              <button
                type="button"
                aria-pressed={reviewMode === "visual"}
                onClick={() => setReviewMode("visual")}
              >
                Visual
              </button>
              <button
                type="button"
                aria-pressed={reviewMode === "markdown-source"}
                onClick={() => setReviewMode("markdown-source")}
              >
                Markdown Source
              </button>
            </div>
          </section>

          {reviewMode === "visual" ? (
            <div className="patch-review-preview-grid">
              <section className="patch-review-card">
                <h3>{patch.status === "accepted" ? "Applied current text" : "Current"}</h3>
                <MarkdownSnippetPreview markdown={visualPreview.originalMarkdown} />
                {visualPreview.usesCurrentMatchingRow ? (
                  <p className="patch-review-preview-note">
                    Preview uses the current matching table row. Markdown Source
                    shows the imported original_text until you update the patch
                    anchor.
                  </p>
                ) : visualPreview.usesGenericTableContext ? (
                  <p className="patch-review-preview-note">
                    Generic table headers are shown for readability only because
                    Patchmark could not find the current table header.
                  </p>
                ) : visualPreview.usesTableContext ? (
                  <p className="patch-review-preview-note">
                    Table header context is shown for readability only. Exact
                    matching still uses the original patch text.
                  </p>
                ) : null}
              </section>

              <section className="patch-review-card">
                <h3>{patch.status === "accepted" ? "Accepted replacement" : "Proposed"}</h3>
                <MarkdownSnippetPreview markdown={visualPreview.suggestedMarkdown} />
                {visualPreview.usesGenericTableContext ? (
                  <p className="patch-review-preview-note">
                    Generic table headers are display-only and will not be stored
                    with the patch.
                  </p>
                ) : visualPreview.usesTableContext ? (
                  <p className="patch-review-preview-note">
                    Table header context is display-only and will not be stored
                    with the patch.
                  </p>
                ) : null}
                <PatchSourceList
                  label="Suggested text sources"
                  sources={suggestedTextSources}
                />
              </section>
            </div>
          ) : (
            <>
              <section className="patch-review-card">
                <h3>Original text</h3>
                <p className="patch-review-source-note">
                  Exact Markdown Patchmark will use for matching/replacement in
                  Phase 3B.
                </p>
                <pre>{patch.original_text}</pre>
              </section>

              <section className="patch-review-card">
                <h3>Suggested replacement</h3>
                <p className="patch-review-source-note">
                  Exact Markdown Patchmark will use for matching/replacement in
                  Phase 3B.
                </p>
                <pre>{patch.suggested_text}</pre>
                <PatchSourceList
                  label="Suggested text sources"
                  sources={suggestedTextSources}
                />
              </section>
            </>
          )}

          <section className="patch-review-card">
            <h3>Reason</h3>
            <p>{patch.reason}</p>
            <PatchSourceList label="Reason sources" sources={reasonSources} />
          </section>

          {patch.risk ? (
            <section className="patch-review-card">
              <h3>Risk / tradeoff</h3>
              <p>{patch.risk}</p>
              <PatchSourceList label="Risk sources" sources={riskSources} />
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}

type PatchVisualPreview = {
  originalMarkdown: string;
  suggestedMarkdown: string;
  usesCurrentMatchingRow: boolean;
  usesGenericTableContext: boolean;
  usesTableContext: boolean;
};

function MarkdownSnippetPreview({ markdown }: { markdown: string }) {
  const previewBlocks = useMemo(
    () => renderMarkdownPreviewBlocks(markdown),
    [markdown]
  );

  if (markdown.trim().length === 0) {
    return <p className="markdown-snippet-empty">Empty Markdown snippet.</p>;
  }

  return <div className="markdown-snippet-preview">{previewBlocks}</div>;
}

function renderMarkdownPreviewBlocks(markdown: string): ReactNode[] {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const lines = normalizedMarkdown.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      index += 1;
      continue;
    }

    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      const fence = trimmedLine.slice(0, 3);
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        <pre key={`code-${blockIndex}`} className="markdown-snippet-code">
          {codeLines.join("\n")}
        </pre>
      );
      blockIndex += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmedLine);
    if (headingMatch) {
      blocks.push(
        renderMarkdownPreviewHeading(
          headingMatch[1].length,
          headingMatch[2],
          `heading-${blockIndex}`
        )
      );
      blockIndex += 1;
      index += 1;
      continue;
    }

    if (
      isMarkdownTableRowLine(line) &&
      index + 1 < lines.length &&
      isMarkdownTableSeparatorRow(lines[index + 1] ?? "")
    ) {
      const tableLines = [line, lines[index + 1] ?? ""];
      index += 2;

      while (index < lines.length && isMarkdownTableRowLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }

      blocks.push(renderMarkdownPreviewTable(tableLines, `table-${blockIndex}`));
      blockIndex += 1;
      continue;
    }

    const unorderedMatch = /^[-*+]\s+(.+)$/.exec(trimmedLine);
    if (unorderedMatch) {
      const items: string[] = [];

      while (index < lines.length) {
        const itemMatch = /^[-*+]\s+(.+)$/.exec((lines[index] ?? "").trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1]);
        index += 1;
      }

      blocks.push(
        <ul key={`ul-${blockIndex}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      blockIndex += 1;
      continue;
    }

    const orderedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmedLine);
    if (orderedMatch) {
      const items: string[] = [];

      while (index < lines.length) {
        const itemMatch = /^\d+[.)]\s+(.+)$/.exec((lines[index] ?? "").trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1]);
        index += 1;
      }

      blocks.push(
        <ol key={`ol-${blockIndex}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      blockIndex += 1;
      continue;
    }

    if (trimmedLine.startsWith(">")) {
      const quoteLines: string[] = [];

      while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }

      blocks.push(
        <blockquote key={`quote-${blockIndex}`}>
          {renderInlineMarkdown(quoteLines.join(" "))}
        </blockquote>
      );
      blockIndex += 1;
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmedLine)) {
      blocks.push(<hr key={`hr-${blockIndex}`} />);
      blockIndex += 1;
      index += 1;
      continue;
    }

    const paragraphLines = [trimmedLine];
    index += 1;

    while (
      index < lines.length &&
      !isMarkdownPreviewBlockStart(lines[index] ?? "", lines[index + 1] ?? "")
    ) {
      const paragraphLine = (lines[index] ?? "").trim();
      if (paragraphLine.length === 0) {
        break;
      }
      paragraphLines.push(paragraphLine);
      index += 1;
    }

    blocks.push(
      <p key={`p-${blockIndex}`}>{renderInlineMarkdown(paragraphLines.join(" "))}</p>
    );
    blockIndex += 1;
  }

  return blocks;
}

function renderMarkdownPreviewHeading(
  level: number,
  text: string,
  key: string
): ReactNode {
  if (level === 1) {
    return <h1 key={key}>{renderInlineMarkdown(text)}</h1>;
  }
  if (level === 2) {
    return <h2 key={key}>{renderInlineMarkdown(text)}</h2>;
  }
  if (level === 3) {
    return <h3 key={key}>{renderInlineMarkdown(text)}</h3>;
  }
  if (level === 4) {
    return <h4 key={key}>{renderInlineMarkdown(text)}</h4>;
  }
  if (level === 5) {
    return <h5 key={key}>{renderInlineMarkdown(text)}</h5>;
  }

  return <h6 key={key}>{renderInlineMarkdown(text)}</h6>;
}

function renderMarkdownPreviewTable(tableLines: string[], key: string): ReactNode {
  const headerCells = parseMarkdownTableRow(tableLines[0] ?? "");
  const bodyRows = tableLines.slice(2).map(parseMarkdownTableRow);

  return (
    <div key={key} className="markdown-snippet-table-scroll">
      <table>
        <thead>
          <tr>
            {headerCells.map((cell, index) => (
              <th key={`head-${index}`}>{renderInlineMarkdown(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${cellIndex}`}>{renderInlineMarkdown(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let matchIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(unescapeMarkdownText(text.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${matchIndex}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      const href = linkMatch?.[2] ?? "";
      const isSafeUrl = isSafeHttpUrl(href);

      if (linkMatch && isSafeUrl) {
        nodes.push(
          <a
            key={`link-${matchIndex}`}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInlineMarkdown(linkMatch[1])}
          </a>
        );
      } else {
        nodes.push(unescapeMarkdownText(token));
      }
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={`strong-${matchIndex}`}>
          {renderInlineMarkdown(token.slice(2, -2))}
        </strong>
      );
    } else {
      nodes.push(
        <em key={`em-${matchIndex}`}>{renderInlineMarkdown(token.slice(1, -1))}</em>
      );
    }

    lastIndex = match.index + token.length;
    matchIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(unescapeMarkdownText(text.slice(lastIndex)));
  }

  return nodes;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_[\]()#|>.-])/g, "$1");
}

function isMarkdownPreviewBlockStart(line: string, nextLine: string): boolean {
  const trimmedLine = line.trim();

  return (
    trimmedLine.length === 0 ||
    trimmedLine.startsWith("```") ||
    trimmedLine.startsWith("~~~") ||
    /^(#{1,6})\s+/.test(trimmedLine) ||
    /^[-*+]\s+/.test(trimmedLine) ||
    /^\d+[.)]\s+/.test(trimmedLine) ||
    trimmedLine.startsWith(">") ||
    /^(-{3,}|_{3,}|\*{3,})$/.test(trimmedLine) ||
    (isMarkdownTableRowLine(line) && isMarkdownTableSeparatorRow(nextLine))
  );
}

function createPatchVisualPreview(
  markdown: string,
  patch: PatchmarkPatch,
  anchorStatus?: PatchReviewAnchorStatus
): PatchVisualPreview {
  if (patch.status === "accepted") {
    const appliedText =
      anchorStatus?.kind === "accepted" && anchorStatus.text.trim().length > 0
        ? anchorStatus.text
        : getPatchAppliedText(patch);
    const tableContext = getPatchTablePreviewContext(
      markdown,
      appliedText,
      appliedText
    );

    if (tableContext) {
      const appliedMarkdown = [
        tableContext.headerRow,
        tableContext.separatorRow,
        appliedText.trim()
      ].join("\n");

      return {
        originalMarkdown: appliedMarkdown,
        suggestedMarkdown: appliedMarkdown,
        usesCurrentMatchingRow: false,
        usesGenericTableContext: false,
        usesTableContext: true
      };
    }

    return {
      originalMarkdown: appliedText,
      suggestedMarkdown: appliedText,
      usesCurrentMatchingRow: false,
      usesGenericTableContext: false,
      usesTableContext: false
    };
  }

  const tableContext = getPatchTablePreviewContext(
    markdown,
    patch.original_text,
    patch.suggested_text
  );

  if (tableContext) {
    return {
      originalMarkdown: [
        tableContext.headerRow,
        tableContext.separatorRow,
        patch.original_text.trim()
      ].join("\n"),
      suggestedMarkdown: [
        tableContext.headerRow,
        tableContext.separatorRow,
        patch.suggested_text.trim()
      ].join("\n"),
      usesCurrentMatchingRow: false,
      usesGenericTableContext: false,
      usesTableContext: true
    };
  }

  const fallbackTableContext = getPatchTableRowPreviewFallbackContext({
    anchorStatus,
    markdown,
    patch
  });

  if (fallbackTableContext) {
    return {
      originalMarkdown: [
        fallbackTableContext.headerRow,
        fallbackTableContext.separatorRow,
        fallbackTableContext.originalRow
      ].join("\n"),
      suggestedMarkdown: [
        fallbackTableContext.headerRow,
        fallbackTableContext.separatorRow,
        fallbackTableContext.suggestedRow
      ].join("\n"),
      usesCurrentMatchingRow: fallbackTableContext.usesCurrentMatchingRow,
      usesGenericTableContext: fallbackTableContext.usesGenericTableContext,
      usesTableContext: true
    };
  }

  return {
    originalMarkdown: patch.original_text,
    suggestedMarkdown: patch.suggested_text,
    usesCurrentMatchingRow: false,
    usesGenericTableContext: false,
    usesTableContext: false
  };
}

function getPatchTablePreviewContext(
  markdown: string,
  originalText: string,
  suggestedText: string
): { headerRow: string; separatorRow: string } | null {
  if (!isMarkdownTableDataSnippet(originalText) && !isMarkdownTableDataSnippet(suggestedText)) {
    return null;
  }

  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const normalizedOriginalText = originalText.replace(/\r\n/g, "\n");
  const originalMatch = findExactTextMatches(
    normalizedMarkdown,
    normalizedOriginalText
  )[0];
  if (!originalMatch) {
    return null;
  }

  const lines = normalizedMarkdown.split("\n");
  const lineStarts = getLineStartOffsets(normalizedMarkdown);
  const originalLineIndex = getLineIndexForOffset(lineStarts, originalMatch.start);

  for (let index = originalLineIndex - 1; index >= 1; index -= 1) {
    const candidateLine = lines[index] ?? "";

    if (isMarkdownTableSeparatorRow(candidateLine)) {
      const headerRow = lines[index - 1] ?? "";
      if (isMarkdownTableRowLine(headerRow)) {
        return {
          headerRow,
          separatorRow: candidateLine
        };
      }
    }

    if (!isMarkdownTableRowLine(candidateLine) && !isMarkdownTableSeparatorRow(candidateLine)) {
      break;
    }
  }

  return null;
}

function getPatchTableRowPreviewFallbackContext({
  anchorStatus,
  markdown,
  patch
}: {
  anchorStatus?: PatchReviewAnchorStatus;
  markdown: string;
  patch: PatchmarkPatch;
}): {
  headerRow: string;
  originalRow: string;
  separatorRow: string;
  suggestedRow: string;
  usesCurrentMatchingRow: boolean;
  usesGenericTableContext: boolean;
} | null {
  if (
    !isMarkdownTableDataSnippet(patch.original_text) ||
    !isMarkdownTableDataSnippet(patch.suggested_text)
  ) {
    return null;
  }

  const tableRowRebase =
    anchorStatus?.kind === "pending" ? anchorStatus.tableRowRebase : undefined;
  const rowCellCount = Math.max(
    parseMarkdownTableRow(tableRowRebase?.currentRowText ?? patch.original_text)
      .length,
    parseMarkdownTableRow(patch.suggested_text).length
  );
  const compatibleHeader = tableRowRebase
    ? {
        headerRow: tableRowRebase.headerRow,
        separatorRow: tableRowRebase.separatorRow
      }
    : getCompatibleTableHeaderForPatch(markdown, patch, rowCellCount);
  const genericHeader = createGenericTableHeaderContext(rowCellCount);
  const headerRow = compatibleHeader.headerRow ?? genericHeader.headerRow;
  const separatorRow =
    compatibleHeader.separatorRow ?? genericHeader.separatorRow;

  return {
    headerRow,
    originalRow: tableRowRebase?.currentRowText ?? patch.original_text.trim(),
    separatorRow,
    suggestedRow: patch.suggested_text.trim(),
    usesCurrentMatchingRow: Boolean(tableRowRebase),
    usesGenericTableContext: !compatibleHeader.headerRow
  };
}

function getCompatibleTableHeaderForPatch(
  markdown: string,
  patch: PatchmarkPatch,
  cellCount: number
): { headerRow?: string; separatorRow?: string } {
  const searchRange = getPatchTableRowSearchRange(markdown, patch);
  const tables = findMarkdownTablesInRange(markdown, searchRange);
  const compatibleTable = tables.find(
    (table) => parseMarkdownTableRow(table.headerRow).length === cellCount
  );

  return compatibleTable
    ? {
        headerRow: compatibleTable.headerRow,
        separatorRow: compatibleTable.separatorRow
      }
    : {};
}

function createGenericTableHeaderContext(cellCount: number): {
  headerRow: string;
  separatorRow: string;
} {
  const safeCellCount = Math.max(2, cellCount);
  const headers = Array.from(
    { length: safeCellCount },
    (_, index) => `Column ${index + 1}`
  );
  const separatorCells = headers.map(() => "---");

  return {
    headerRow: `| ${headers.join(" | ")} |`,
    separatorRow: `| ${separatorCells.join(" | ")} |`
  };
}

function getLineIndexForOffset(lineStarts: number[], offset: number): number {
  let lineIndex = 0;

  for (let index = 0; index < lineStarts.length; index += 1) {
    if ((lineStarts[index] ?? 0) > offset) {
      break;
    }
    lineIndex = index;
  }

  return lineIndex;
}

function isMarkdownTableDataSnippet(markdown: string): boolean {
  const lines = markdown
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.length === 1 &&
    isMarkdownTableRowLine(lines[0] ?? "") &&
    !isMarkdownTableSeparatorRow(lines[0] ?? "")
  );
}

function isMarkdownTableRowLine(line: string): boolean {
  const cells = parseMarkdownTableRow(line);

  return cells.length >= 2 && line.includes("|");
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = parseMarkdownTableRow(line);

  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function parseMarkdownTableRow(line: string): string[] {
  let trimmedLine = line.trim();

  if (trimmedLine.startsWith("|")) {
    trimmedLine = trimmedLine.slice(1);
  }

  if (trimmedLine.endsWith("|")) {
    trimmedLine = trimmedLine.slice(0, -1);
  }

  const cells: string[] = [];
  let currentCell = "";

  for (let index = 0; index < trimmedLine.length; index += 1) {
    const character = trimmedLine[index] ?? "";
    const previousCharacter = trimmedLine[index - 1] ?? "";

    if (character === "|" && previousCharacter !== "\\") {
      cells.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    currentCell += character;
  }

  cells.push(currentCell.trim());

  return cells.map((cell) => cell.replace(/\\\|/g, "|"));
}

function PatchSourceList({
  label,
  sources
}: {
  label: string;
  sources: PatchmarkSourceReference[];
}) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="patch-source-list">
      <span>{label}</span>
      <ul>
        {sources.map((source, index) => (
          <li key={`${source.url}-${index}`}>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title || source.url}
            </a>
            {source.supports ? <small>{source.supports}</small> : null}
            {source.note ? <small>{source.note}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function getDocumentStatus({
  isDirty,
  markdown,
  restoredMarkdown,
  saveStatus
}: {
  isDirty: boolean;
  markdown: string;
  restoredMarkdown: string | null;
  saveStatus: SaveStatus;
}): DocumentStatusKind {
  if (saveStatus === "saving") {
    return "saving";
  }

  if (saveStatus === "failed") {
    return "saveFailed";
  }

  if (saveStatus === "unavailable") {
    return "saveUnavailable";
  }

  if (restoredMarkdown !== null && markdown === restoredMarkdown) {
    return "restored";
  }

  return isDirty ? "dirty" : "saved";
}

function getDraftMarkdownStartOffset(
  draft: SelectedCommentAnchorDraft | null
): number | undefined {
  return (
    draft?.markdownStartOffset ?? draft?.anchorContext.markdown_start_offset
  );
}

function getSaveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Save failed: ${error.message}`;
  }

  return "Save failed. Your unsaved changes are still in Patchmark.";
}

function getProjectErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Project folder action failed. Your Markdown is still in Patchmark.";
}

function createNextCommentId(comments: PatchmarkComment[]): string {
  const nextNumber =
    comments.reduce((maxNumber, comment) => {
      const match = /^PM-COMMENT-(\d+)$/.exec(comment.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-COMMENT-${String(nextNumber).padStart(4, "0")}`;
}

function createNextThreadEntryId(comment: PatchmarkComment): string {
  const nextNumber =
    comment.thread.reduce((maxNumber, entry) => {
      const match = /^PM-THREAD-(\d+)$/.exec(entry.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-THREAD-${String(nextNumber).padStart(4, "0")}`;
}

function getFocusedCommentsForExport(
  comments: PatchmarkComment[]
): PatchmarkComment[] {
  return comments.filter(
    (comment) =>
      comment.status === "open" &&
      (comment.export_state.focus_state === "in_focus" ||
        comment.export_state.focus_state === "awaiting_reply")
  );
}

function createCommentExportId(exportedAt: string): string {
  return `comment-export-${createFileSafeTimestamp(exportedAt)}`;
}

function createFileSafeTimestamp(exportedAt: string): string {
  return exportedAt
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "-$1")
    .replace("T", "-")
    .replace("Z", "");
}

function createFocusedCommentsChatGptPrompt(
  jsonText: string,
  {
    dedicatedDocumentReview
  }: {
    dedicatedDocumentReview: boolean;
  }
): string {
  const dedicatedDocumentReviewNote = dedicatedDocumentReview
    ? `
## Dedicated Whole-Document Review Task

This is a dedicated whole-document review task.

Focus only on the exported document-level comment.

Do not address unrelated document issues unless they are necessary to resolve this comment.

If you propose changes, return reviewable patch proposals linked to this comment_id.

Document-level comments may produce multiple patch proposals. Keep each patch narrow and reviewable.

For reference-cleanup tasks, preserve necessary references in the actual Markdown document. Prefer concise inline Markdown links near the claims they support. Do not rely only on Patchmark source arrays, because those are review metadata and may not appear in the final Markdown export.

Prefer small exact patches over rewriting the whole document.
`
    : "";

  return `# Patchmark Focused Comments Review

You are helping review and improve a Markdown document through Patchmark.

Patchmark is the source of truth for the document. You are not editing the document directly. You are replying to focused comments and, when useful, proposing reviewable patches.

Patchmark is the document control layer. ChatGPT is the reasoning/review layer. The human user is the bridge.

## Collaboration Rules

- Reply to each exported comment by \`comment_id\`.
- Do not resolve comments.
- Only the human user can resolve comments in Patchmark.
- If a comment needs clarification, ask a question linked to that \`comment_id\`.
- If you suggest a document change, return a patch proposal linked to the \`comment_id\`.
- If one comment requires multiple document changes, return multiple \`patch_proposals\` with the same \`comment_id\`.
- Prefer several small exact patch proposals over one large rewrite.
- Each \`patch_proposal\` must have its own exact \`original_text\` and \`suggested_text\`.
- Patch proposals must use exact Markdown from the supplied context as \`original_text\`.
- Do not create a patch proposal unless \`original_text\` is copied exactly from the supplied Markdown context.
- Do not create or include \`patch_group_id\`; Patchmark creates patch group IDs during import.
- Do not rewrite the whole document unless explicitly requested.
- Preserve Markdown structure.
- Be clear about reason and risk/tradeoff.
- Drafting support only. Legal review may still be required.
${dedicatedDocumentReviewNote}

## Required Response Format

Return exactly one fenced JSON code block.

The response must contain:

- one opening \`\`\`json fence
- one valid JSON object
- one closing \`\`\` fence

Do not include any text before the opening fence.

Do not include any text after the closing fence.

Inside the JSON:

Markdown links are allowed only inside \`original_text\` and \`suggested_text\`, because those fields represent document Markdown.

Do not use Markdown links in \`reply\`, \`reason\`, \`risk\`, \`question\`, \`supports\`, \`note\`, or \`title\`.

If the comment asks to make references inline, every reference that remains necessary must be preserved directly inside \`suggested_text\` as Markdown document content.

Do not remove a final references/source-notes section unless the relevant source information has been preserved in the proposed document text through inline Markdown links or another visible Markdown source format.

If you propose deleting a Source Notes / References section, explain in \`risk\` whether visible source information would be lost.

Do not include footnotes.

Do not include reference-link definitions like [1]: https://...

Do not use [1] or [source][1] citations.

Do not put URLs inside prose metadata fields.

Every source URL must be placed in the nearest field-local sources array.

Do not collect field evidence in a top-level \`sources\` array.

Do not put source links after the JSON.

If you need to mention a phrase such as Core sourdough breads inside a JSON string, do not wrap it in straight double quotes. Either omit the quotes or use escaped JSON quotes.

Good:
\`"Change wording from Core sourdough breads to Current bread catalogue."\`

Also valid:
\`"Change wording from \\"Core sourdough breads\\" to \\"Current bread catalogue\\"."\`

Invalid:
\`"Change wording from "Core sourdough breads" to "Current bread catalogue"."\`

Place each source in the closest matching field:

- \`reply_sources\` for sources used in a comment reply.
- \`suggested_text_sources\` for sources used to justify or support suggested replacement text.
- \`reason_sources\` for sources used in the reason.
- \`risk_sources\` for sources used in the risk/tradeoff.
- \`question_sources\` for sources used in an open question.

If the same source supports multiple fields, repeat it in each relevant field-local sources array.

If a field uses no sources, return an empty array for that field's source array.

Source object rules:

- Every source must be an object with a raw \`url\` string.
- The \`url\` value must start with \`https://\` or \`http://\`.
- Do not wrap URLs in Markdown syntax.
- Do not include \`[\` or \`]\` in URLs.
- Do not include \`(\` or \`)\` in URLs.
- Do not include quotes, escaped quotes, or backslashes in URLs.
- Do not put URLs inside \`reply\`, \`reason\`, \`risk\`, or \`question\` text fields.
- Put URLs only in field-local source arrays.
- \`supports\` must be plain text describing what the source supports.

Source preservation rule:

- Patchmark sidecar source arrays are review metadata.
- If a reference must remain visible in the final Markdown document, include it directly in \`suggested_text\` as a Markdown link or another visible Markdown source format.
- Do not rely only on \`suggested_text_sources\` when the task asks for inline references.

Good inline-reference \`suggested_text\`:
\`"Thailand foodservice remains resilient. [USDA FAS estimated Thailand foodservice at about USD 35.4 billion in 2025](https://apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName?fileName=Food+Service+-+Hotel+Restaurant+Institutional+Annual_Bangkok_Thailand_TH2025-0045.pdf), despite modest economic growth."\`

Bad inline-reference \`suggested_text\`:
\`"Thailand foodservice remains resilient. USDA FAS estimated Thailand foodservice at about USD 35.4 billion in 2025, despite modest economic growth."\`

The bad version loses the visible source if Patchmark sidecar metadata is not exported.

Use this exact protocol:

\`\`\`json
{
  "protocol": "patchmark.comment_reply_import",
  "protocol_version": 1,
  "summary": "Brief summary of what you did.",
  "replies": [
    {
      "comment_id": "PM-COMMENT-0001",
      "reply": "Your reply to the comment. Do not put URLs or Markdown links in this text.",
      "reply_sources": [],
      "suggested_user_action": "review"
    }
  ],
  "patch_proposals": [
    {
      "comment_id": "PM-COMMENT-0001",
      "target_heading": "## Example Heading",
      "original_text": "Exact Markdown text to replace.",
      "suggested_text": "Replacement Markdown text.",
      "suggested_text_sources": [],
      "reason": "Why this change helps.",
      "reason_sources": [],
      "risk": "Tradeoff or caution.",
      "risk_sources": []
    }
  ],
  "open_questions": [
    {
      "comment_id": "PM-COMMENT-0001",
      "question": "Question for the human user.",
      "question_sources": []
    }
  ]
}
\`\`\`

Example sourced reply object:

\`\`\`json
{
  "comment_id": "PM-COMMENT-0003",
  "reply": "Campaillou should be added because it appears in the current public bread catalogue.",
  "reply_sources": [
    {
      "title": "Crust Chant — Bread Collection",
      "url": "https://crustchant.com/en/collections/bread/",
      "supports": "Shows that Campaillou appears in the public bread catalogue."
    }
  ],
  "suggested_user_action": "apply_patch"
}
\`\`\`

Allowed \`suggested_user_action\` values:

- \`review\`
- \`clarify\`
- \`apply_patch\`
- \`keep_open\`
- \`resolve_manually\`

If no patch is needed, return an empty \`patch_proposals\` array.

If no clarification is needed, return an empty \`open_questions\` array.

Remember: you may suggest \`resolve_manually\`, but you must not claim the comment is resolved. Only the human user resolves comments in Patchmark.

## Patchmark Export Payload

\`\`\`json
${jsonText.trimEnd()}
\`\`\`
`;
}

function parsePatchmarkCommentReplyImport(
  rawInput: string
): PatchmarkCommentReplyImport {
  let parsedResponse: unknown;

  try {
    parsedResponse = JSON.parse(stripMarkdownJsonFence(rawInput));
  } catch {
    throw new Error(INVALID_CHATGPT_JSON_ERROR);
  }

  if (!isRecord(parsedResponse)) {
    throw new Error("Invalid Patchmark response. Expected a JSON object.");
  }

  if (parsedResponse.protocol !== "patchmark.comment_reply_import") {
    throw new Error(
      "Invalid Patchmark response. Expected protocol `patchmark.comment_reply_import`."
    );
  }

  if (parsedResponse.protocol_version !== 1) {
    throw new Error(
      "Invalid Patchmark response. Expected protocol_version 1."
    );
  }

  if (
    !Array.isArray(parsedResponse.replies) ||
    !Array.isArray(parsedResponse.patch_proposals) ||
    !Array.isArray(parsedResponse.open_questions)
  ) {
    throw new Error(
      "Invalid Patchmark response. Expected replies, patch_proposals, and open_questions arrays."
    );
  }

  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary:
      typeof parsedResponse.summary === "string"
        ? validateProtocolTextField(parsedResponse.summary, "summary")
        : undefined,
    sources: normalizeImportedSources(parsedResponse.sources, "sources"),
    replies: parsedResponse.replies.map((reply, index) =>
      normalizeImportedReply(reply, index)
    ),
    patch_proposals:
      parsedResponse.patch_proposals.map((patchProposal, index) =>
        normalizeImportedPatchProposal(patchProposal, index)
      ),
    open_questions:
      parsedResponse.open_questions.map((openQuestion, index) =>
        normalizeImportedOpenQuestion(openQuestion, index)
      )
  };
}

function stripMarkdownJsonFence(rawInput: string): string {
  const trimmedInput = rawInput.trim();
  const fencedMatch = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmedInput);

  return fencedMatch ? fencedMatch[1].trim() : trimmedInput;
}

function normalizeImportedReply(
  reply: unknown,
  index: number
): PatchmarkCommentReplyImport["replies"][number] {
  if (
    !isRecord(reply) ||
    typeof reply.comment_id !== "string" ||
    typeof reply.reply !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each reply needs comment_id and reply."
    );
  }

  const replyPath = `replies[${index}]`;
  const replySourcesInput = reply.reply_sources ?? reply.sources;
  const replySourcesPath =
    reply.reply_sources === undefined
      ? `${replyPath}.sources`
      : `${replyPath}.reply_sources`;

  return {
    comment_id: reply.comment_id,
    reply: validateProtocolTextField(reply.reply, `${replyPath}.reply`),
    reply_sources: normalizeImportedSources(
      replySourcesInput,
      replySourcesPath
    ),
    suggested_user_action: isSuggestedUserAction(reply.suggested_user_action)
      ? reply.suggested_user_action
      : undefined,
    sources: normalizeImportedSources(reply.sources, `${replyPath}.sources`)
  };
}

function normalizeImportedPatchProposal(
  patchProposal: unknown,
  index: number
): PatchmarkCommentReplyImport["patch_proposals"][number] {
  if (
    !isRecord(patchProposal) ||
    typeof patchProposal.comment_id !== "string" ||
    typeof patchProposal.original_text !== "string" ||
    typeof patchProposal.suggested_text !== "string" ||
    typeof patchProposal.reason !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each patch proposal needs comment_id, original_text, suggested_text, and reason."
    );
  }

  const patchProposalPath = `patch_proposals[${index}]`;
  const reasonSourcesInput =
    patchProposal.reason_sources ?? patchProposal.sources;
  const reasonSourcesPath =
    patchProposal.reason_sources === undefined
      ? `${patchProposalPath}.sources`
      : `${patchProposalPath}.reason_sources`;

  return {
    comment_id: patchProposal.comment_id,
    target_heading:
      typeof patchProposal.target_heading === "string"
        ? patchProposal.target_heading
        : undefined,
    original_text: patchProposal.original_text,
    suggested_text: patchProposal.suggested_text,
    suggested_text_sources: normalizeImportedSources(
      patchProposal.suggested_text_sources,
      `${patchProposalPath}.suggested_text_sources`
    ),
    reason: validateProtocolTextField(
      patchProposal.reason,
      `${patchProposalPath}.reason`
    ),
    reason_sources: normalizeImportedSources(
      reasonSourcesInput,
      reasonSourcesPath
    ),
    risk:
      typeof patchProposal.risk === "string"
        ? validateProtocolTextField(patchProposal.risk, `${patchProposalPath}.risk`)
        : undefined,
    risk_sources: normalizeImportedSources(
      patchProposal.risk_sources,
      `${patchProposalPath}.risk_sources`
    ),
    sources: normalizeImportedSources(
      patchProposal.sources,
      `${patchProposalPath}.sources`
    )
  };
}

function validateProtocolTextField(value: string, fieldName: string): string {
  if (
    PROTOCOL_URL_PATTERN.test(value) ||
    PROTOCOL_MARKDOWN_LINK_PATTERN.test(value) ||
    PROTOCOL_BROKEN_MARKDOWN_LINK_PATTERN.test(value) ||
    PROTOCOL_REFERENCE_LINK_PATTERN.test(value) ||
    PROTOCOL_FOOTNOTE_PATTERN.test(value)
  ) {
    throw new Error(`${STRICT_CHATGPT_IMPORT_ERROR} Invalid field: ${fieldName}.`);
  }

  return value;
}

function normalizeSourceTextField(
  value: unknown,
  fieldPath: string
): string | undefined {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid source field at ${fieldPath}. Source title, note, and supports must be plain text strings.`
    );
  }

  const trimmedValue = value.trim();

  return trimmedValue
    ? validateProtocolTextField(trimmedValue, fieldPath)
    : undefined;
}

function normalizeImportedSources(
  sources: unknown,
  arrayPath: string
): PatchmarkSourceReference[] | undefined {
  if (sources === undefined) {
    return undefined;
  }

  if (!Array.isArray(sources)) {
    throw new Error(
      `Invalid source array at ${arrayPath}. Sources must be arrays of source objects.`
    );
  }

  return sources.map((source, index) =>
    normalizeImportedSourceReference(source, `${arrayPath}[${index}]`)
  );
}

function normalizeImportedSourceReference(
  source: unknown,
  sourcePath: string
): PatchmarkSourceReference {
  if (!isRecord(source)) {
    throw new Error(
      `Invalid source object at ${sourcePath}. Every source must be an object with a raw url string.`
    );
  }

  if (typeof source.url !== "string") {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  const rawUrl = source.url;

  if (!rawUrl.trim() || rawUrl.trim() !== rawUrl) {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  if (
    (!rawUrl.startsWith("https://") && !rawUrl.startsWith("http://")) ||
    SOURCE_URL_MARKDOWN_PATTERN.test(rawUrl)
  ) {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  let normalizedUrl: string;

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invalid protocol.");
    }

    normalizedUrl = url.toString();
  } catch {
    throw new Error(
      `Invalid source URL at ${sourcePath}.url. Source URLs must be raw http(s) URLs, not Markdown links.`
    );
  }

  const title =
    source.title === undefined
      ? undefined
      : normalizeSourceTextField(source.title, `${sourcePath}.title`);
  const note =
    source.note === undefined
      ? undefined
      : normalizeSourceTextField(source.note, `${sourcePath}.note`);
  const supports =
    source.supports === undefined
      ? undefined
      : normalizeSourceTextField(source.supports, `${sourcePath}.supports`);

  return {
    title,
    url: normalizedUrl,
    note,
    supports
  };
}

function normalizeImportedOpenQuestion(
  openQuestion: unknown,
  index: number
): PatchmarkCommentReplyImport["open_questions"][number] {
  if (
    !isRecord(openQuestion) ||
    typeof openQuestion.comment_id !== "string" ||
    typeof openQuestion.question !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each open question needs comment_id and question."
    );
  }

  const openQuestionPath = `open_questions[${index}]`;

  return {
    comment_id: openQuestion.comment_id,
    question: validateProtocolTextField(
      openQuestion.question,
      `${openQuestionPath}.question`
    ),
    question_sources: normalizeImportedSources(
      openQuestion.question_sources,
      `${openQuestionPath}.question_sources`
    )
  };
}

function normalizeSourceChatUrl(sourceChatUrl: string): string | undefined {
  const trimmedUrl = sourceChatUrl.trim();

  if (!trimmedUrl) {
    return undefined;
  }

  try {
    const url = new URL(trimmedUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invalid protocol.");
    }

    return url.toString();
  } catch {
    throw new Error("Source ChatGPT URL must be a valid http(s) URL.");
  }
}

function createCommentImportId(importedAt: string): string {
  return `PM-IMPORT-${createFileSafeTimestamp(importedAt)}`;
}

function getUnknownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: Set<string>
): string[] {
  const referencedCommentIds = [
    ...response.replies.map((reply) => reply.comment_id),
    ...response.patch_proposals.map((patchProposal) => patchProposal.comment_id),
    ...response.open_questions.map((openQuestion) => openQuestion.comment_id)
  ];

  return Array.from(
    new Set(
      referencedCommentIds.filter((commentId) => !knownCommentIds.has(commentId))
    )
  );
}

function getKnownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: Set<string>
): Set<string> {
  return new Set(
    [
      ...response.replies.map((reply) => reply.comment_id),
      ...response.patch_proposals.map((patchProposal) => patchProposal.comment_id),
      ...response.open_questions.map((openQuestion) => openQuestion.comment_id)
    ].filter((commentId) => knownCommentIds.has(commentId))
  );
}

function createImportedCommentThreads({
  comments,
  importedAt,
  importId,
  importedCommentIds,
  openQuestions,
  replies,
  sourceChatUrl
}: {
  comments: PatchmarkComment[];
  importedAt: string;
  importId: string;
  importedCommentIds: Set<string>;
  openQuestions: PatchmarkCommentReplyImport["open_questions"];
  replies: PatchmarkCommentReplyImport["replies"];
  sourceChatUrl?: string;
}): {
  nextComments: PatchmarkComment[];
  openQuestionsAttached: number;
  repliesAttached: number;
} {
  let openQuestionsAttached = 0;
  let repliesAttached = 0;

  const nextComments = comments.map((comment) => {
    const matchingReplies = replies.filter(
      (reply) => reply.comment_id === comment.id
    );
    const matchingOpenQuestions = openQuestions.filter(
      (openQuestion) => openQuestion.comment_id === comment.id
    );

    if (
      matchingReplies.length === 0 &&
      matchingOpenQuestions.length === 0 &&
      !importedCommentIds.has(comment.id)
    ) {
      return comment;
    }

    let nextThread = comment.thread;

    for (const reply of matchingReplies) {
      nextThread = [
        ...nextThread,
        createChatGptThreadEntry({
          content: reply.reply,
          createdAt: importedAt,
          importId,
          sources: reply.reply_sources,
          sourceChatUrl,
          suggestedUserAction: reply.suggested_user_action,
          thread: nextThread
        })
      ];
      repliesAttached += 1;
    }

    for (const openQuestion of matchingOpenQuestions) {
      nextThread = [
        ...nextThread,
        createChatGptThreadEntry({
          content: `Question: ${openQuestion.question}`,
          createdAt: importedAt,
          importId,
          sources: openQuestion.question_sources,
          sourceChatUrl,
          suggestedUserAction: "clarify",
          thread: nextThread
        })
      ];
      openQuestionsAttached += 1;
    }

    return {
      ...comment,
      thread: nextThread,
      export_state: {
        ...comment.export_state,
        focus_state: "reply_received" as const,
        marked_for_export_at: undefined,
        last_imported_at: importedAt,
        last_import_id: importId
      },
      updated_at: importedAt
    };
  });

  return {
    nextComments,
    openQuestionsAttached,
    repliesAttached
  };
}

function createChatGptThreadEntry({
  content,
  createdAt,
  importId,
  sources,
  sourceChatUrl,
  suggestedUserAction,
  thread
}: {
  content: string;
  createdAt: string;
  importId: string;
  sources?: PatchmarkSourceReference[];
  sourceChatUrl?: string;
  suggestedUserAction?: PatchmarkSuggestedUserAction;
  thread: PatchmarkCommentThreadEntry[];
}): PatchmarkCommentThreadEntry {
  return {
    id: createNextThreadEntryIdFromEntries(thread),
    role: "chatgpt",
    content,
    created_at: createdAt,
    sources,
    source_import_id: importId,
    source_chat_url: sourceChatUrl,
    suggested_user_action: suggestedUserAction
  };
}

function createImportedPatchProposals({
  existingPatches,
  importedAt,
  importId,
  knownCommentIds,
  patchProposals,
  sourceChatUrl
}: {
  existingPatches: PatchmarkPatch[];
  importedAt: string;
  importId: string;
  knownCommentIds: Set<string>;
  patchProposals: PatchmarkCommentReplyImport["patch_proposals"];
  sourceChatUrl?: string;
}): PatchmarkPatch[] {
  const validPatchProposals = patchProposals.filter((patchProposal) =>
    knownCommentIds.has(patchProposal.comment_id)
  );
  const groupIdsByCommentId = new Map<string, string>();

  validPatchProposals.forEach((patchProposal) => {
    if (groupIdsByCommentId.has(patchProposal.comment_id)) {
      return;
    }

    groupIdsByCommentId.set(
      patchProposal.comment_id,
      createNextPatchGroupId(existingPatches, groupIdsByCommentId.size)
    );
  });

  const groupTotalsByCommentId = validPatchProposals.reduce<Map<string, number>>(
    (totals, patchProposal) => {
      totals.set(
        patchProposal.comment_id,
        (totals.get(patchProposal.comment_id) ?? 0) + 1
      );
      return totals;
    },
    new Map()
  );
  const groupIndexesByCommentId = new Map<string, number>();

  return validPatchProposals.map((patchProposal, index) => {
    const currentGroupIndex =
      (groupIndexesByCommentId.get(patchProposal.comment_id) ?? 0) + 1;
    groupIndexesByCommentId.set(
      patchProposal.comment_id,
      currentGroupIndex
    );

    return {
      id: createNextPatchId(existingPatches, index),
      status: "pending" as const,
      patch_group_id: groupIdsByCommentId.get(patchProposal.comment_id),
      patch_group_index: currentGroupIndex,
      patch_group_total:
        groupTotalsByCommentId.get(patchProposal.comment_id) ?? 1,
      comment_id: patchProposal.comment_id,
      source_import_id: importId,
      source_chat_url: sourceChatUrl,
      target_heading: patchProposal.target_heading,
      original_text: patchProposal.original_text,
      suggested_text: patchProposal.suggested_text,
      suggested_text_sources: patchProposal.suggested_text_sources,
      reason: patchProposal.reason,
      reason_sources: patchProposal.reason_sources,
      risk: patchProposal.risk,
      risk_sources: patchProposal.risk_sources,
      sources: patchProposal.sources,
      created_at: importedAt
    };
  });
}

function createNextThreadEntryIdFromEntries(
  thread: PatchmarkCommentThreadEntry[]
): string {
  const nextNumber =
    thread.reduce((maxNumber, entry) => {
      const match = /^PM-THREAD-(\d+)$/.exec(entry.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-THREAD-${String(nextNumber).padStart(4, "0")}`;
}

function createNextPatchId(
  patches: PatchmarkPatch[],
  offset: number
): string {
  const nextNumber =
    patches.reduce((maxNumber, patch) => {
      const match = /^PM-PATCH-(\d+)$/.exec(patch.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) +
    offset +
    1;

  return `PM-PATCH-${String(nextNumber).padStart(4, "0")}`;
}

function createNextPatchGroupId(
  patches: PatchmarkPatch[],
  offset: number
): string {
  const nextNumber =
    patches.reduce((maxNumber, patch) => {
      const match = /^PM-PATCH-GROUP-(\d+)$/.exec(
        patch.patch_group_id ?? ""
      );

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) +
    offset +
    1;

  return `PM-PATCH-GROUP-${String(nextNumber).padStart(4, "0")}`;
}

function getPendingPatchCountsByCommentId(
  patches: PatchmarkPatch[]
): Record<string, number> {
  return patches.reduce<Record<string, number>>((counts, patch) => {
    if (patch.status !== "pending" || !patch.comment_id) {
      return counts;
    }

    counts[patch.comment_id] = (counts[patch.comment_id] ?? 0) + 1;
    return counts;
  }, {});
}

function derivePatchGroups(
  patches: PatchmarkPatch[],
  markdown: string
): DerivedPatchGroup[] {
  const groupedPatches = new Map<string, PatchmarkPatch[]>();
  const groupOrder = new Map<string, number>();

  patches.forEach((patch, index) => {
    const groupId = getDerivedPatchGroupId(patch);

    if (!groupedPatches.has(groupId)) {
      groupedPatches.set(groupId, []);
      groupOrder.set(groupId, index);
    }

    groupedPatches.get(groupId)?.push(patch);
  });

  return Array.from(groupedPatches.entries())
    .map(([groupId, groupPatches]) => {
      const patchesInOrder = [...groupPatches].sort(
        (firstPatch, secondPatch) =>
          getPatchGroupSortIndex(firstPatch) - getPatchGroupSortIndex(secondPatch)
      );
      const statusSummary = createPatchGroupStatusSummary(patchesInOrder);
      const anchorStatusByPatchId = createPatchGroupAnchorStatusByPatchId({
        allPatches: patches,
        markdown,
        patches: patchesInOrder
      });
      const applicabilitySummary = createPatchGroupApplicabilitySummary({
        markdown,
        patches: patchesInOrder
      });
      const applicabilityByPatchId = createPatchGroupApplicabilityByPatchId({
        markdown,
        patches: patchesInOrder
      });
      const firstPatch = patchesInOrder[0];
      const hasApplicabilityIssue = patchesInOrder.some(
        (patch) =>
          patch.status === "pending" &&
          applicabilityByPatchId[patch.id] !== "exact_match"
      );

      return {
        id: groupId,
        display_id: firstPatch?.patch_group_id ?? firstPatch?.id ?? groupId,
        comment_id: firstPatch?.comment_id,
        source_import_id: firstPatch?.source_import_id,
        source_chat_url: firstPatch?.source_chat_url,
        patches: patchesInOrder,
        created_at: firstPatch?.created_at ?? "",
        status_summary: statusSummary,
        anchor_status_by_patch_id: anchorStatusByPatchId,
        applicability_by_patch_id: applicabilityByPatchId,
        applicability_summary: applicabilitySummary,
        is_legacy_single_patch_group:
          patchesInOrder.length === 1 && !firstPatch?.patch_group_id,
        status: getPatchGroupStatus(statusSummary, hasApplicabilityIssue)
      };
    })
    .sort(
      (firstGroup, secondGroup) =>
        (groupOrder.get(firstGroup.id) ?? 0) -
        (groupOrder.get(secondGroup.id) ?? 0)
    );
}

function getDerivedPatchGroupId(patch: PatchmarkPatch): string {
  return patch.patch_group_id ?? `single-patch:${patch.id}`;
}

function getPatchGroupSortIndex(patch: PatchmarkPatch): number {
  return patch.patch_group_index ?? Number.MAX_SAFE_INTEGER;
}

function createPatchGroupStatusSummary(
  patches: PatchmarkPatch[]
): PatchmarkPatchGroup["status_summary"] {
  return patches.reduce<PatchmarkPatchGroup["status_summary"]>(
    (summary, patch) => ({
      total: summary.total + 1,
      pending: summary.pending + (patch.status === "pending" ? 1 : 0),
      accepted: summary.accepted + (patch.status === "accepted" ? 1 : 0),
      rejected: summary.rejected + (patch.status === "rejected" ? 1 : 0),
      stale: summary.stale + (patch.status === "stale" ? 1 : 0)
    }),
    {
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      stale: 0
    }
  );
}

function createPatchGroupApplicabilitySummary({
  markdown,
  patches
}: {
  markdown: string;
  patches: PatchmarkPatch[];
}): PatchGroupApplicabilitySummary {
  return patches.reduce<PatchGroupApplicabilitySummary>(
    (summary, patch) => {
      if (patch.status !== "pending") {
        return summary;
      }

      const applicability = getPatchApplicabilityForPatch(markdown, patch, patches);

      return {
        ...summary,
        [applicability]: summary[applicability] + 1
      };
    },
    {
      exact_match: 0,
      multiple_matches: 0,
      not_found: 0,
      table_row_rebase_available: 0
    }
  );
}

function createPatchGroupAnchorStatusByPatchId({
  allPatches,
  markdown,
  patches
}: {
  allPatches: PatchmarkPatch[];
  markdown: string;
  patches: PatchmarkPatch[];
}): Record<string, PatchReviewAnchorStatus> {
  return Object.fromEntries(
    patches.map((patch) => [
      patch.id,
      getPatchReviewAnchorStatus(markdown, patch, allPatches)
    ])
  );
}

function createPatchGroupApplicabilityByPatchId({
  markdown,
  patches
}: {
  markdown: string;
  patches: PatchmarkPatch[];
}): Record<string, PatchApplicability> {
  return Object.fromEntries(
    patches.map((patch) => [
      patch.id,
      getPatchApplicabilityForPatch(markdown, patch, patches)
    ])
  );
}

function getPatchGroupStatus(
  statusSummary: PatchmarkPatchGroup["status_summary"],
  hasApplicabilityIssue: boolean
): PatchmarkPatchGroupStatus {
  if (statusSummary.pending > 0 && hasApplicabilityIssue) {
    return "needs_review";
  }

  if (statusSummary.pending === statusSummary.total) {
    return "pending";
  }

  if (statusSummary.pending === 0) {
    return "completed";
  }

  return "in_progress";
}

function getPatchGroupSummariesByCommentId(
  patchGroups: DerivedPatchGroup[]
): Record<string, CommentPatchGroupSummary> {
  return patchGroups.reduce<Record<string, CommentPatchGroupSummary>>(
    (summaries, group) => {
      if (!group.comment_id) {
        return summaries;
      }

      const currentSummary = summaries[group.comment_id] ?? {
        accepted: 0,
        groupCount: 0,
        patchCount: 0,
        pending: 0,
        rejected: 0,
        stale: 0
      };

      summaries[group.comment_id] = {
        accepted: currentSummary.accepted + group.status_summary.accepted,
        groupCount: currentSummary.groupCount + 1,
        patchCount: currentSummary.patchCount + group.status_summary.total,
        pending: currentSummary.pending + group.status_summary.pending,
        rejected: currentSummary.rejected + group.status_summary.rejected,
        stale: currentSummary.stale + group.status_summary.stale
      };

      return summaries;
    },
    {}
  );
}

function getPatchApplicabilityForPatch(
  markdown: string,
  patch: PatchmarkPatch,
  patches: PatchmarkPatch[] = []
): PatchApplicability {
  const anchorStatus = getPatchReviewAnchorStatus(markdown, patch, patches);

  if (anchorStatus.kind === "accepted") {
    return "exact_match";
  }

  return anchorStatus.applicability;
}

type HighConfidencePendingPatchAnchorRecovery = {
  detail: string;
  match: TextMatch;
  method: PatchmarkPatchAnchorRecoveryMethod;
  recoveredText: string;
};

function recoverHighConfidencePendingPatchAnchors({
  markdown,
  patches
}: {
  markdown: string;
  patches: PatchmarkPatch[];
}): PatchmarkPatch[] {
  let didRecover = false;
  const recoveredAt = new Date().toISOString();
  const recoveredPatches = patches.map((patch) => {
    const recovery = getHighConfidencePendingPatchAnchorRecovery(markdown, patch);

    if (!recovery) {
      return patch;
    }

    didRecover = true;
    return applyHighConfidencePendingPatchAnchorRecovery({
      patch,
      recoveredAt,
      recovery
    });
  });

  return didRecover ? recoveredPatches : patches;
}

function applyHighConfidencePendingPatchAnchorRecovery({
  patch,
  recoveredAt,
  recovery
}: {
  patch: PatchmarkPatch;
  recoveredAt: string;
  recovery: HighConfidencePendingPatchAnchorRecovery;
}): PatchmarkPatch {
  return {
    ...patch,
    anchor_recovery_history: [
      ...(patch.anchor_recovery_history ?? []),
      {
        recovered_at: recoveredAt,
        confidence: "high_confidence",
        method: recovery.method,
        previous_original_text: patch.original_text,
        recovered_text: recovery.recoveredText,
        detail: recovery.detail
      }
    ],
    original_text: recovery.recoveredText,
    previous_original_text: patch.original_text,
    reanchored_at: recoveredAt,
    reanchor_reason:
      recovery.method === "unique_table_row_match"
        ? "table_row_normalized_match"
        : patch.reanchor_reason
  };
}

function getHighConfidencePendingPatchAnchorRecovery(
  markdown: string,
  patch: PatchmarkPatch
): HighConfidencePendingPatchAnchorRecovery | null {
  if (patch.status !== "pending" || patch.original_text.length === 0) {
    return null;
  }

  const exactMatches = findExactTextMatches(markdown, patch.original_text);
  if (exactMatches.length > 0) {
    return null;
  }

  const normalizedMatches = findNormalizedTextMatches(markdown, patch.original_text);
  if (isMarkdownTableDataSnippet(patch.original_text)) {
    const tableRowRebaseCandidates = findTableRowRebaseCandidates(markdown, patch);
    if (tableRowRebaseCandidates.length === 1) {
      const tableRowRebase = tableRowRebaseCandidates[0];

      return {
        detail: "Anchor automatically recovered using unique table-row match.",
        match: {
          end: tableRowRebase.end,
          start: tableRowRebase.start
        },
        method: "unique_table_row_match",
        recoveredText: tableRowRebase.currentRowText
      };
    }
  }

  const sectionRange = getPatchTargetHeadingSectionRange(
    markdown,
    patch.target_heading
  );
  if (sectionRange) {
    const sectionNormalizedMatches = normalizedMatches.filter((match) =>
      isTextMatchInsideRange(match, sectionRange)
    );

    if (sectionNormalizedMatches.length === 1) {
      const match = sectionNormalizedMatches[0];

      return {
        detail:
          "Anchor automatically recovered using unique section-context match.",
        match,
        method: "unique_section_context_match",
        recoveredText: markdown.slice(match.start, match.end)
      };
    }
  }

  if (normalizedMatches.length === 1) {
    const match = normalizedMatches[0];

    return {
      detail: "Anchor automatically recovered using unique normalized text match.",
      match,
      method: "normalized_match",
      recoveredText: markdown.slice(match.start, match.end)
    };
  }

  return null;
}

function getPatchReviewAnchorStatus(
  markdown: string,
  patch: PatchmarkPatch,
  patches: PatchmarkPatch[] = []
): PatchReviewAnchorStatus {
  if (patch.status === "accepted") {
    return getAppliedPatchAnchorStatus(markdown, patch, patches);
  }

  const matches = findExactTextMatches(markdown, patch.original_text);
  if (matches.length === 1) {
    return {
      applicability: "exact_match",
      kind: patch.status === "pending" ? "pending" : "historical",
      matches,
      text: patch.original_text
    };
  }

  if (matches.length > 1) {
    return {
      applicability: "multiple_matches",
      kind: patch.status === "pending" ? "pending" : "historical",
      matches,
      text: patch.original_text
    };
  }

  if (patch.status === "pending") {
    const highConfidenceRecovery = getHighConfidencePendingPatchAnchorRecovery(
      markdown,
      patch
    );

    if (highConfidenceRecovery) {
      return {
        applicability: "exact_match",
        kind: "pending",
        matches: [highConfidenceRecovery.match],
        text: highConfidenceRecovery.recoveredText
      };
    }

    const tableRowRebaseCandidates = findTableRowRebaseCandidates(markdown, patch);

    if (tableRowRebaseCandidates.length === 1) {
      const tableRowRebase = tableRowRebaseCandidates[0];

      return {
        applicability: "table_row_rebase_available",
        kind: "pending",
        matches: [
          {
            end: tableRowRebase.end,
            start: tableRowRebase.start
          }
        ],
        tableRowRebase,
        text: tableRowRebase.currentRowText
      };
    }

    if (tableRowRebaseCandidates.length > 1) {
      return {
        applicability: "multiple_matches",
        kind: "pending",
        matches: tableRowRebaseCandidates.map((candidate) => ({
          end: candidate.end,
          start: candidate.start
        })),
        text: patch.original_text
      };
    }
  }

  return {
    applicability: "not_found",
    kind: patch.status === "pending" ? "pending" : "historical",
    matches,
    text: patch.original_text
  };
}

function getAppliedPatchAnchorStatus(
  markdown: string,
  patch: PatchmarkPatch,
  patches: PatchmarkPatch[] = []
): Extract<PatchReviewAnchorStatus, { kind: "accepted" }> {
  const appliedText = getPatchAppliedText(patch);

  return locateAcceptedPatchAnchor({
    appliedText,
    markdown,
    patch,
    patches,
    visitedPatchIds: new Set([patch.id])
  });
}

function locateAcceptedPatchAnchor({
  appliedText,
  includeDescendants = true,
  markdown,
  patch,
  patches,
  visitedPatchIds
}: {
  appliedText: string;
  includeDescendants?: boolean;
  markdown: string;
  patch: PatchmarkPatch;
  patches: PatchmarkPatch[];
  visitedPatchIds: Set<string>;
}): Extract<PatchReviewAnchorStatus, { kind: "accepted" }> {
  if (appliedText.length === 0) {
    return {
      kind: "accepted",
      matches: [],
      status: "empty_applied_text",
      text: appliedText
    };
  }

  const offsetMatch = getAppliedPatchOffsetMatch(markdown, patch, appliedText);
  if (offsetMatch) {
    return {
      kind: "accepted",
      matches: [offsetMatch],
      status: "exact_match",
      text: appliedText
    };
  }

  const exactMatches = findExactTextMatches(markdown, appliedText);

  if (exactMatches.length === 1) {
    return {
      kind: "accepted",
      matches: exactMatches,
      status: "exact_match",
      text: appliedText
    };
  }

  if (exactMatches.length > 1) {
    return {
      kind: "accepted",
      matches: exactMatches,
      status: "multiple_matches",
      text: appliedText
    };
  }

  const normalizedMatches = getAppliedPatchNormalizedMatches(markdown, appliedText);
  if (normalizedMatches.length === 1) {
    return {
      kind: "accepted",
      matches: normalizedMatches,
      status: "normalized_match",
      text: markdown.slice(normalizedMatches[0].start, normalizedMatches[0].end)
    };
  }

  const tableRowMatch = findAcceptedPatchTableRowAnchorMatch({
    appliedText,
    markdown,
    patch
  });
  if (tableRowMatch) {
    return {
      kind: "accepted",
      matches: [tableRowMatch],
      status: "row_match",
      text: tableRowMatch.text
    };
  }

  const sectionMatch = findAcceptedPatchSectionAnchorMatch({
    appliedText,
    markdown,
    normalizedMatches,
    patch
  });
  if (sectionMatch) {
    return {
      kind: "accepted",
      matches: [sectionMatch],
      status: "section_match",
      text: sectionMatch.text
    };
  }

  const contextMatch = findAcceptedPatchSurroundingContextMatch({
    markdown,
    patch
  });
  if (contextMatch) {
    return {
      kind: "accepted",
      matches: [contextMatch],
      status: "evolved_after_patch",
      text: contextMatch.text
    };
  }

  if (includeDescendants) {
    const descendantMatch = findDescendantAcceptedPatchAnchorMatch({
      appliedText,
      markdown,
      patch,
      patches,
      visitedPatchIds
    });

    if (descendantMatch) {
      return {
        kind: "accepted",
        matches: descendantMatch.matches,
        status: "evolved_after_patch",
        text: descendantMatch.text
      };
    }
  }

  if (normalizedMatches.length > 1) {
    return {
      kind: "accepted",
      matches: normalizedMatches,
      status: "multiple_matches",
      text: appliedText
    };
  }

  return {
    kind: "accepted",
    matches: [],
    status: "not_found",
    text: appliedText
  };
}

function getPatchAppliedText(patch: PatchmarkPatch): string {
  return patch.applied_text ?? patch.suggested_text;
}

function getAppliedPatchOffsetMatch(
  markdown: string,
  patch: PatchmarkPatch,
  appliedText: string
): TextMatch | null {
  if (
    typeof patch.applied_start_offset !== "number" ||
    typeof patch.applied_end_offset !== "number" ||
    patch.applied_start_offset < 0 ||
    patch.applied_end_offset < patch.applied_start_offset ||
    patch.applied_end_offset > markdown.length
  ) {
    return null;
  }

  const candidate = markdown.slice(
    patch.applied_start_offset,
    patch.applied_end_offset
  );

  if (candidate !== appliedText) {
    return null;
  }

  return {
    end: patch.applied_end_offset,
    start: patch.applied_start_offset
  };
}

type AppliedPatchAnchorMatch = TextMatch & { text: string };

function getAppliedPatchNormalizedMatches(
  markdown: string,
  appliedText: string
): TextMatch[] {
  const plainText = getMarkdownPlainText(appliedText);
  const plainTextMatches =
    plainText && plainText !== normalizeDomText(appliedText)
      ? findMarkdownPlainTextMatches(markdown, plainText)
      : [];

  return dedupeTextMatches([
    ...findNormalizedTextMatches(markdown, appliedText),
    ...plainTextMatches
  ]);
}

function findAcceptedPatchTableRowAnchorMatch({
  appliedText,
  markdown,
  patch
}: {
  appliedText: string;
  markdown: string;
  patch: PatchmarkPatch;
}): AppliedPatchAnchorMatch | null {
  const appliedCells = getAcceptedPatchAppliedTableCells(patch, appliedText);
  const rowAnchor =
    patch.applied_table_row_anchor ?? createStableTableRowAnchor(appliedCells);

  if (!rowAnchor || appliedCells.length < 2) {
    return null;
  }

  const range = getAcceptedPatchSectionRange(markdown, patch) ?? {
    end: markdown.length,
    searchedWholeDocument: true,
    start: 0
  };
  const tables = findMarkdownTablesInRange(markdown, {
    end: range.end,
    searchedWholeDocument: "searchedWholeDocument" in range
      ? Boolean(range.searchedWholeDocument)
      : false,
    start: range.start
  });
  const candidateRows = tables.flatMap((table, tableIndex) => {
    if (
      typeof patch.applied_table_index === "number" &&
      patch.applied_table_index !== tableIndex
    ) {
      return [];
    }

    return table.rows.flatMap((row, rowIndex) => {
      const currentCells = parseMarkdownTableRow(row.text);
      const currentRowAnchor = createStableTableRowAnchor(currentCells);
      const hasCompatibleCellCount = currentCells.length === appliedCells.length;

      if (currentRowAnchor === rowAnchor && hasCompatibleCellCount) {
        return [
          {
            ...row,
            text: row.text
          }
        ];
      }

      if (
        typeof patch.applied_table_index === "number" &&
        typeof patch.applied_table_row_index === "number" &&
        patch.applied_table_index === tableIndex &&
        patch.applied_table_row_index === rowIndex &&
        hasCompatibleCellCount
      ) {
        return [
          {
            ...row,
            text: row.text
          }
        ];
      }

      return [];
    });
  });
  const uniqueRows = dedupeAppliedPatchAnchorMatches(candidateRows);

  return uniqueRows.length === 1 ? uniqueRows[0] : null;
}

function getAcceptedPatchAppliedTableCells(
  patch: PatchmarkPatch,
  appliedText: string
): string[] {
  if (patch.applied_table_row_cells && patch.applied_table_row_cells.length >= 2) {
    return patch.applied_table_row_cells;
  }

  if (!isMarkdownTableDataSnippet(appliedText)) {
    return [];
  }

  return parseMarkdownTableRow(appliedText);
}

function findAcceptedPatchSectionAnchorMatch({
  appliedText,
  markdown,
  normalizedMatches,
  patch
}: {
  appliedText: string;
  markdown: string;
  normalizedMatches: TextMatch[];
  patch: PatchmarkPatch;
}): AppliedPatchAnchorMatch | null {
  const sectionRange = getAcceptedPatchSectionRange(markdown, patch);

  if (!sectionRange) {
    return null;
  }

  const normalizedMatchesInSection = normalizedMatches.filter((match) =>
    isTextMatchInsideRange(match, sectionRange)
  );
  if (normalizedMatchesInSection.length === 1) {
    const match = normalizedMatchesInSection[0];

    return {
      ...match,
      text: markdown.slice(match.start, match.end)
    };
  }

  const sectionMarkdown = markdown.slice(sectionRange.start, sectionRange.end);
  const sectionMatches = dedupeTextMatches([
    ...findNormalizedTextMatches(sectionMarkdown, appliedText),
    ...findMarkdownPlainTextMatches(sectionMarkdown, getMarkdownPlainText(appliedText))
  ]).map((match) => ({
    start: sectionRange.start + match.start,
    end: sectionRange.start + match.end
  }));

  if (sectionMatches.length === 1) {
    const match = sectionMatches[0];

    return {
      ...match,
      text: markdown.slice(match.start, match.end)
    };
  }

  return null;
}

function findAcceptedPatchSurroundingContextMatch({
  markdown,
  patch
}: {
  markdown: string;
  patch: PatchmarkPatch;
}): AppliedPatchAnchorMatch | null {
  const before = patch.applied_context_before ?? "";
  const after = patch.applied_context_after ?? "";

  if (before.trim().length < 8 || after.trim().length < 8) {
    return null;
  }

  const contextMatches: AppliedPatchAnchorMatch[] = [];
  let beforeIndex = markdown.indexOf(before);

  while (beforeIndex !== -1) {
    const evolvedStart = beforeIndex + before.length;
    const afterIndex = markdown.indexOf(after, evolvedStart);

    if (afterIndex !== -1 && afterIndex >= evolvedStart) {
      contextMatches.push({
        start: evolvedStart,
        end: afterIndex,
        text: markdown.slice(evolvedStart, afterIndex)
      });
    }

    beforeIndex = markdown.indexOf(before, beforeIndex + before.length);
  }

  const sectionRange = getAcceptedPatchSectionRange(markdown, patch);
  const sectionFilteredMatches = sectionRange
    ? contextMatches.filter((match) => isTextMatchInsideRange(match, sectionRange))
    : contextMatches;
  const uniqueMatches = dedupeAppliedPatchAnchorMatches(
    sectionFilteredMatches.length > 0 ? sectionFilteredMatches : contextMatches
  );

  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

function findDescendantAcceptedPatchAnchorMatch({
  appliedText,
  markdown,
  patch,
  patches,
  visitedPatchIds
}: {
  appliedText: string;
  markdown: string;
  patch: PatchmarkPatch;
  patches: PatchmarkPatch[];
  visitedPatchIds: Set<string>;
}): { matches: TextMatch[]; text: string } | null {
  const descendants = patches.filter(
    (candidate) =>
      candidate.id !== patch.id &&
      candidate.status === "accepted" &&
      !visitedPatchIds.has(candidate.id) &&
      isLaterAcceptedPatch(candidate, patch) &&
      isLikelyDescendantAcceptedPatch(candidate, patch, appliedText)
  );

  for (const descendant of descendants) {
    visitedPatchIds.add(descendant.id);

    const descendantStatus = locateAcceptedPatchAnchor({
      appliedText: getPatchAppliedText(descendant),
      includeDescendants: false,
      markdown,
      patch: descendant,
      patches,
      visitedPatchIds
    });

    if (
      descendantStatus.status !== "not_found" &&
      descendantStatus.status !== "empty_applied_text" &&
      descendantStatus.matches.length > 0
    ) {
      return {
        matches: descendantStatus.matches,
        text: descendantStatus.text
      };
    }
  }

  return null;
}

function isLaterAcceptedPatch(
  candidate: PatchmarkPatch,
  patch: PatchmarkPatch
): boolean {
  const candidateTimestamp =
    candidate.applied_at ?? candidate.accepted_at ?? candidate.created_at;
  const patchTimestamp = patch.applied_at ?? patch.accepted_at ?? patch.created_at;

  return candidateTimestamp > patchTimestamp;
}

function isLikelyDescendantAcceptedPatch(
  candidate: PatchmarkPatch,
  patch: PatchmarkPatch,
  appliedText: string
): boolean {
  const normalizedAppliedText = normalizeAcceptedPatchComparisonText(appliedText);
  const normalizedCandidateOriginal = normalizeAcceptedPatchComparisonText(
    candidate.original_text
  );
  const normalizedPreviousOriginal = normalizeAcceptedPatchComparisonText(
    candidate.previous_original_text ?? ""
  );

  if (
    normalizedAppliedText &&
    ((normalizedCandidateOriginal &&
      normalizedCandidateOriginal === normalizedAppliedText) ||
      normalizedPreviousOriginal === normalizedAppliedText ||
      (normalizedAppliedText.length >= 24 &&
        normalizedCandidateOriginal.length >= 24 &&
        normalizedCandidateOriginal.includes(normalizedAppliedText)) ||
      (normalizedAppliedText.length >= 24 &&
        normalizedCandidateOriginal.length >= 24 &&
        normalizedAppliedText.includes(normalizedCandidateOriginal)))
  ) {
    return true;
  }

  if (acceptedPatchRangesOverlap(candidate, patch)) {
    return true;
  }

  const patchRowAnchor =
    patch.applied_table_row_anchor ??
    createStableTableRowAnchor(getAcceptedPatchAppliedTableCells(patch, appliedText));
  const candidateRowAnchor =
    candidate.applied_table_row_anchor ??
    createStableTableRowAnchor(parseMarkdownTableRow(candidate.original_text));

  return Boolean(patchRowAnchor && candidateRowAnchor && patchRowAnchor === candidateRowAnchor);
}

function acceptedPatchRangesOverlap(
  candidate: PatchmarkPatch,
  patch: PatchmarkPatch
): boolean {
  if (
    typeof candidate.applied_start_offset !== "number" ||
    typeof candidate.applied_end_offset !== "number" ||
    typeof patch.applied_start_offset !== "number" ||
    typeof patch.applied_end_offset !== "number"
  ) {
    return false;
  }

  return (
    candidate.applied_start_offset <= patch.applied_end_offset &&
    candidate.applied_end_offset >= patch.applied_start_offset
  );
}

function getAcceptedPatchSectionRange(
  markdown: string,
  patch: PatchmarkPatch
): (TextMatch & { searchedWholeDocument?: boolean }) | null {
  const headings = parseMarkdownHeadings(markdown);
  const appliedHeading = findAcceptedPatchHeading(headings, patch);

  if (appliedHeading) {
    return getSectionRange(markdown, headings, appliedHeading);
  }

  return getPatchTargetHeadingSectionRange(
    markdown,
    patch.applied_heading ?? patch.target_heading
  );
}

function findAcceptedPatchHeading(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  patch: PatchmarkPatch
) {
  const headingText = patch.applied_heading ?? patch.target_heading;
  const headingId = patch.applied_heading_id;

  if (!headingText && !headingId) {
    return null;
  }

  const candidates = headings.filter((heading) => {
    const textMatches =
      headingText &&
      normalizePatchTargetHeading(heading.text) ===
        normalizePatchTargetHeading(headingText);
    const idMatches = headingId && createMarkdownHeadingId(heading.text) === headingId;

    return textMatches || idMatches;
  });

  if (candidates.length <= 1 || !patch.applied_heading_path) {
    return candidates[0] ?? null;
  }

  return (
    candidates.find((heading) =>
      areHeadingPathsEqual(getHeadingPath(headings, heading), patch.applied_heading_path ?? [])
    ) ??
    candidates[0] ??
    null
  );
}

function isTextMatchInsideRange(match: TextMatch, range: TextMatch): boolean {
  return match.start >= range.start && match.end <= range.end;
}

function dedupeAppliedPatchAnchorMatches(
  matches: AppliedPatchAnchorMatch[]
): AppliedPatchAnchorMatch[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeAcceptedPatchComparisonText(text: string): string {
  return normalizeDomText(getMarkdownPlainText(text) || text).toLowerCase();
}

function getMarkdownPlainText(markdown: string): string {
  return buildMarkdownPlainTextIndex(markdown).text;
}

function createStableTableRowAnchor(cells: string[]): string | undefined {
  const normalizedCells = cells.map(normalizeTableCellForMatch);
  const stableCellIndex = normalizedCells.findIndex((cell) => cell.length > 0);

  if (stableCellIndex === -1) {
    return undefined;
  }

  return `${stableCellIndex}:${normalizedCells[stableCellIndex].toLowerCase()}`;
}

function findTableRowRebaseCandidates(
  markdown: string,
  patch: PatchmarkPatch
): PatchTableRowRebaseCandidate[] {
  if (
    !isMarkdownTableDataSnippet(patch.original_text) ||
    !isMarkdownTableDataSnippet(patch.suggested_text)
  ) {
    return [];
  }

  const normalizedOriginalCells = parseMarkdownTableRow(patch.original_text).map(
    normalizeTableCellForMatch
  );

  if (normalizedOriginalCells.length < 2) {
    return [];
  }

  const searchRange = getPatchTableRowSearchRange(markdown, patch);
  const tables = findMarkdownTablesInRange(markdown, searchRange);

  return tables.flatMap((table) =>
    table.rows.flatMap((row) => {
      const normalizedCurrentCells = parseMarkdownTableRow(row.text).map(
        normalizeTableCellForMatch
      );
      const cellsMatch =
        normalizedCurrentCells.length === normalizedOriginalCells.length &&
        normalizedCurrentCells.every(
          (cell, index) => cell === normalizedOriginalCells[index]
        );

      return cellsMatch
        ? [
            {
              currentRowText: row.text,
              end: row.end,
              headerRow: table.headerRow,
              searchedWholeDocument: searchRange.searchedWholeDocument,
              separatorRow: table.separatorRow,
              start: row.start
            }
          ]
        : [];
    })
  );
}

function getPatchTableRowSearchRange(
  markdown: string,
  patch: PatchmarkPatch
): { end: number; searchedWholeDocument: boolean; start: number } {
  const targetSectionRange = getPatchTargetHeadingSectionRange(
    markdown,
    patch.target_heading
  );

  if (targetSectionRange) {
    return {
      ...targetSectionRange,
      searchedWholeDocument: false
    };
  }

  return {
    end: markdown.length,
    searchedWholeDocument: true,
    start: 0
  };
}

function getPatchTargetHeadingSectionRange(
  markdown: string,
  targetHeading?: string
): { end: number; start: number } | null {
  if (!targetHeading) {
    return null;
  }

  const normalizedTargetHeading = normalizePatchTargetHeading(targetHeading);
  if (!normalizedTargetHeading) {
    return null;
  }

  const headings = parseMarkdownHeadings(markdown);
  const target = headings.find(
    (heading) => normalizePatchTargetHeading(heading.text) === normalizedTargetHeading
  );

  return target ? getSectionRange(markdown, headings, target) : null;
}

function normalizePatchTargetHeading(heading: string): string {
  return heading
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ");
}

function createMarkdownHeadingId(heading: string): string {
  return normalizePatchTargetHeading(heading)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function findMarkdownTablesInRange(
  markdown: string,
  range: { end: number; searchedWholeDocument: boolean; start: number }
): Array<{
  headerRow: string;
  rows: Array<{ end: number; start: number; text: string }>;
  searchedWholeDocument: boolean;
  separatorRow: string;
}> {
  const lines = markdown.split("\n");
  const lineStarts = getLineStartOffsets(markdown);
  const startLineIndex = getLineIndexForOffset(lineStarts, range.start);
  const endLineIndex = getLineIndexForOffset(
    lineStarts,
    Math.max(range.start, range.end - 1)
  );
  const tables: Array<{
    headerRow: string;
    rows: Array<{ end: number; start: number; text: string }>;
    searchedWholeDocument: boolean;
    separatorRow: string;
  }> = [];
  let lineIndex = startLineIndex;

  while (lineIndex < endLineIndex) {
    const headerRow = lines[lineIndex] ?? "";
    const separatorRow = lines[lineIndex + 1] ?? "";

    if (
      isMarkdownTableRowLine(headerRow) &&
      isMarkdownTableSeparatorRow(separatorRow)
    ) {
      const rows: Array<{ end: number; start: number; text: string }> = [];
      let rowIndex = lineIndex + 2;

      while (
        rowIndex <= endLineIndex &&
        isMarkdownTableRowLine(lines[rowIndex] ?? "")
      ) {
        const rowText = (lines[rowIndex] ?? "").replace(/\r$/, "");
        const start = lineStarts[rowIndex] ?? 0;

        rows.push({
          end: start + rowText.length,
          start,
          text: rowText
        });
        rowIndex += 1;
      }

      tables.push({
        headerRow: headerRow.replace(/\r$/, ""),
        rows,
        searchedWholeDocument: range.searchedWholeDocument,
        separatorRow: separatorRow.replace(/\r$/, "")
      });
      lineIndex = rowIndex;
      continue;
    }

    lineIndex += 1;
  }

  return tables;
}

function normalizeTableCellForMatch(cell: string): string {
  return cell.trim().replace(/\s+/g, " ");
}

function getPatchAcceptDisabledMessage(
  patch: PatchmarkPatch,
  applicability: PatchApplicability
): string | null {
  if (patch.status !== "pending") {
    return "Only pending patches can be accepted.";
  }

  if (!patch.original_text) {
    return "Cannot apply because the original text is empty.";
  }

  if (applicability === "multiple_matches") {
    return "Cannot apply automatically because the original text appears multiple times.";
  }

  if (applicability === "not_found") {
    return "Cannot apply because the original text was not found in the current document.";
  }

  return null;
}

function getPatchSourceReferenceWarnings(patch: PatchmarkPatch): string[] {
  const warnings: string[] = [];

  if (isSourceReferenceSectionDeletionPatch(patch)) {
    warnings.push(
      "This patch deletes a source/reference section. Confirm that all necessary references are preserved inline in the document before accepting."
    );
  }

  if (
    (patch.suggested_text_sources?.length ?? 0) > 0 &&
    !containsVisibleSourceReference(patch.suggested_text)
  ) {
    warnings.push(
      "This patch has source metadata, but the suggested Markdown does not contain a visible source reference. If accepted, the document may not show this source unless Patchmark export later renders sidecar sources."
    );
  }

  return warnings;
}

function isSourceReferenceSectionDeletionPatch(patch: PatchmarkPatch): boolean {
  if (patch.suggested_text.trim().length > 0) {
    return false;
  }

  const sourceLabelText = `${patch.target_heading ?? ""}\n${patch.original_text}`;

  return SOURCE_SECTION_HEADING_PATTERN.test(sourceLabelText);
}

function containsVisibleSourceReference(markdown: string): boolean {
  return (
    DOCUMENT_MARKDOWN_LINK_PATTERN.test(markdown) ||
    DOCUMENT_RAW_URL_PATTERN.test(markdown)
  );
}

function getPatchResolvedStatusMessage(patch: PatchmarkPatch): string {
  if (patch.status === "accepted") {
    return patch.applied_at
      ? `Applied · Applied at ${formatPatchDate(patch.applied_at)}`
      : "Applied";
  }

  if (patch.status === "rejected") {
    return patch.rejected_at
      ? `Rejected · Rejected at ${formatPatchDate(patch.rejected_at)}`
      : "Rejected";
  }

  if (patch.status === "stale") {
    return "Stale";
  }

  return "Pending";
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  let count = 0;
  let searchIndex = 0;

  while (searchIndex <= text.length) {
    const matchIndex = text.indexOf(search, searchIndex);

    if (matchIndex === -1) {
      break;
    }

    count += 1;
    searchIndex = matchIndex + search.length;
  }

  return count;
}

function replaceSingleOccurrenceAt({
  replacement,
  search,
  start,
  text
}: {
  replacement: string;
  search: string;
  start: number;
  text: string;
}): string {
  return text.slice(0, start) + replacement + text.slice(start + search.length);
}

function createAppliedPatchAnchorMetadata({
  end,
  markdown,
  start,
  text
}: {
  end: number;
  markdown: string;
  start: number;
  text: string;
}): Partial<PatchmarkPatch> {
  const contextRadius = 160;
  const safeStart = Math.max(0, Math.min(start, markdown.length));
  const safeEnd = Math.max(safeStart, Math.min(end, markdown.length));
  const headings = parseMarkdownHeadings(markdown);
  const containingHeading = getHeadingContainingOffset(
    markdown,
    headings,
    safeStart
  );
  const tableRowAnchorMetadata = createAppliedTableRowAnchorMetadata({
    containingHeading,
    headings,
    markdown,
    rowEnd: safeEnd,
    rowStart: safeStart,
    text
  });

  return {
    applied_text: text,
    applied_start_offset: safeStart,
    applied_end_offset: safeEnd,
    applied_context_before: markdown.slice(
      Math.max(0, safeStart - contextRadius),
      safeStart
    ),
    applied_context_after: markdown.slice(
      safeEnd,
      Math.min(markdown.length, safeEnd + contextRadius)
    ),
    applied_heading: containingHeading?.text,
    applied_heading_id: containingHeading
      ? createMarkdownHeadingId(containingHeading.text)
      : undefined,
    applied_heading_path: containingHeading
      ? getHeadingPath(headings, containingHeading)
      : undefined,
    ...tableRowAnchorMetadata
  };
}

function createAppliedTableRowAnchorMetadata({
  containingHeading,
  headings,
  markdown,
  rowEnd,
  rowStart,
  text
}: {
  containingHeading?: ReturnType<typeof parseMarkdownHeadings>[number];
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  rowEnd: number;
  rowStart: number;
  text: string;
}): Partial<PatchmarkPatch> {
  if (!isMarkdownTableDataSnippet(text)) {
    return {};
  }

  const appliedCells = parseMarkdownTableRow(text);
  const rowAnchor = createStableTableRowAnchor(appliedCells);

  if (!rowAnchor) {
    return {};
  }

  const searchRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : {
        start: 0,
        end: markdown.length
      };
  const tables = findMarkdownTablesInRange(markdown, {
    ...searchRange,
    searchedWholeDocument: !containingHeading
  });

  for (const [tableIndex, table] of tables.entries()) {
    const rowIndex = table.rows.findIndex(
      (row) => row.start === rowStart && row.end === rowEnd
    );

    if (rowIndex !== -1) {
      return {
        applied_table_index: tableIndex,
        applied_table_row_index: rowIndex,
        applied_table_row_anchor: rowAnchor,
        applied_table_row_cells: appliedCells.map(normalizeTableCellForMatch)
      };
    }
  }

  return {
    applied_table_row_anchor: rowAnchor,
    applied_table_row_cells: appliedCells.map(normalizeTableCellForMatch)
  };
}

type AffectedPatchComment = {
  commentId: string;
  impactKind: PatchCommentImpactKind;
};

type AffectedPatchCommentUpdate = {
  comments: PatchmarkComment[];
  linkedCommentFound: boolean;
  needsReviewCount: number;
  offsetShiftedCount: number;
  reanchoredCount: number;
  unchangedCount: number;
};

function analyzeCommentsAffectedByPatch({
  comments,
  currentMarkdown,
  originalEnd,
  originalStart,
  patch
}: {
  comments: PatchmarkComment[];
  currentMarkdown: string;
  originalEnd: number;
  originalStart: number;
  patch: PatchmarkPatch;
}): AffectedPatchComment[] {
  const headings = parseMarkdownHeadings(currentMarkdown);

  return comments.flatMap((comment) => {
    const impactKind = getPatchCommentImpactKind({
      comment,
      currentMarkdown,
      headings,
      originalEnd,
      originalStart,
      patch
    });

    return impactKind === "unaffected"
      ? []
      : [
          {
            commentId: comment.id,
            impactKind
          }
        ];
  });
}

function getPatchCommentImpactKind({
  comment,
  currentMarkdown,
  headings,
  originalEnd,
  originalStart,
  patch
}: {
  comment: PatchmarkComment;
  currentMarkdown: string;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  originalEnd: number;
  originalStart: number;
  patch: PatchmarkPatch;
}): PatchCommentImpactKind {
  if (comment.id === patch.comment_id) {
    return "linked_comment";
  }

  const { anchor } = comment;

  if (anchor.kind === "document") {
    return "unaffected";
  }

  if (anchor.kind === "section") {
    const sectionRange = getSectionAnchorRangeForImpact({
      anchor,
      headings,
      markdown: currentMarkdown
    });

    if (!sectionRange) {
      return "unaffected";
    }

    return sectionRange.start >= originalEnd ||
      rangesOverlap(sectionRange.start, sectionRange.end, originalStart, originalEnd)
      ? "section_may_have_shifted"
      : "unaffected";
  }

  const selectedRange = getSelectedAnchorRangeForImpact({
    anchor,
    originalStart,
    patch
  });

  if (!selectedRange) {
    return "unaffected";
  }

  if (selectedRange.start >= originalEnd) {
    return "anchor_after_replaced_range";
  }

  if (selectedRange.start >= originalStart && selectedRange.end <= originalEnd) {
    return "anchor_inside_replaced_range";
  }

  return rangesOverlap(
    selectedRange.start,
    selectedRange.end,
    originalStart,
    originalEnd
  )
    ? "anchor_intersects_replaced_range"
    : "unaffected";
}

function getSectionAnchorRangeForImpact({
  anchor,
  headings,
  markdown
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "section" }>;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): { end: number; start: number } | null {
  const currentHeading = findMatchingHeading(headings, {
    level: anchor.heading_level,
    text: anchor.heading
  });

  if (currentHeading) {
    return getSectionRange(markdown, headings, currentHeading);
  }

  if (
    typeof anchor.section_start_offset === "number" &&
    typeof anchor.section_end_offset === "number"
  ) {
    return {
      start: anchor.section_start_offset,
      end: anchor.section_end_offset
    };
  }

  return null;
}

function getSelectedAnchorRangeForImpact({
  anchor,
  originalStart,
  patch
}: {
  anchor: SelectedTextAnchor;
  originalStart: number;
  patch: PatchmarkPatch;
}): { end: number; start: number } | null {
  if (
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    return {
      start: anchor.markdown_start_offset,
      end: anchor.markdown_end_offset
    };
  }

  const matchesInOriginalText = findExactTextMatches(
    patch.original_text,
    anchor.selected_text
  );

  if (matchesInOriginalText.length === 0) {
    return null;
  }

  return {
    start: originalStart + matchesInOriginalText[0].start,
    end: originalStart + matchesInOriginalText[0].end
  };
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): boolean {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function updateAffectedCommentAnchors({
  affectedComments,
  comments,
  createdAt,
  lengthDelta,
  newMarkdown,
  patch,
  replacementEnd,
  replacementStart
}: {
  affectedComments: AffectedPatchComment[];
  comments: PatchmarkComment[];
  createdAt: string;
  lengthDelta: number;
  newMarkdown: string;
  patch: PatchmarkPatch;
  replacementEnd: number;
  replacementStart: number;
}): AffectedPatchCommentUpdate {
  const affectedByCommentId = new Map(
    affectedComments.map((affectedComment) => [
      affectedComment.commentId,
      affectedComment
    ])
  );
  let linkedCommentFound = false;
  let needsReviewCount = 0;
  let offsetShiftedCount = 0;
  let reanchoredCount = 0;
  let unchangedCount = 0;

  const nextComments = comments.map((comment) => {
    const affectedComment = affectedByCommentId.get(comment.id);

    if (!affectedComment) {
      return comment;
    }

    if (comment.id === patch.comment_id) {
      linkedCommentFound = true;
    }

    const update = updateSingleAffectedCommentAnchor({
      comment,
      createdAt,
      impactKind: affectedComment.impactKind,
      lengthDelta,
      newMarkdown,
      patch,
      replacementEnd,
      replacementStart
    });

    if (update.result === "needs_review") {
      needsReviewCount += 1;
    } else if (update.result === "offset_shifted") {
      offsetShiftedCount += 1;
    } else if (update.result === "reanchored") {
      reanchoredCount += 1;
    } else {
      unchangedCount += 1;
    }

    return update.comment;
  });

  return {
    comments: nextComments,
    linkedCommentFound,
    needsReviewCount,
    offsetShiftedCount,
    reanchoredCount,
    unchangedCount
  };
}

function updateSingleAffectedCommentAnchor({
  comment,
  createdAt,
  impactKind,
  lengthDelta,
  newMarkdown,
  patch,
  replacementEnd,
  replacementStart
}: {
  comment: PatchmarkComment;
  createdAt: string;
  impactKind: PatchCommentImpactKind;
  lengthDelta: number;
  newMarkdown: string;
  patch: PatchmarkPatch;
  replacementEnd: number;
  replacementStart: number;
}): { comment: PatchmarkComment; result: PatchmarkCommentPatchImpact["result"] } {
  const isLinkedComment = comment.id === patch.comment_id;

  if (comment.anchor.kind === "document") {
    const nextComment = appendPatchImpactToComment({
      comment,
      createdAt,
      impactKind,
      note: isLinkedComment
        ? "Linked document-level comment remains attached to the whole document."
        : "Document-level comment was not affected by this patch.",
      patchId: patch.id,
      result: "unchanged"
    });

    return {
      comment: isLinkedComment
        ? appendSystemThreadEntryToComment({
            comment: nextComment,
            content: `Patch ${patch.id} was applied to the document.`,
            createdAt,
            patchId: patch.id
          })
        : nextComment,
      result: "unchanged"
    };
  }

  if (comment.anchor.kind === "section") {
    return updateAffectedSectionCommentAnchor({
      comment,
      createdAt,
      impactKind,
      isLinkedComment,
      newMarkdown,
      patch
    });
  }

  if (isLinkedComment) {
    const newAnchor = createPatchReplacementAnchor({
      comment,
      newMarkdown,
      patch,
      replacementEnd,
      replacementStart
    });

    if (!newAnchor) {
      return markCommentAnchorNeedsReviewAfterPatch({
        comment,
        content: `Patch ${patch.id} was applied to the document, but Patchmark could not re-anchor this comment automatically.`,
        createdAt,
        impactKind,
        note: "The linked selected-text comment could not be re-anchored automatically.",
        patch
      });
    }

    return updateCommentAnchorAfterPatch({
      comment,
      content: `Patch ${patch.id} was applied to the document and this comment was re-anchored to the applied replacement.`,
      createdAt,
      impactKind,
      newAnchor,
      patch,
      reason: "patch_applied",
      result: "reanchored"
    });
  }

  if (impactKind === "anchor_after_replaced_range") {
    const shiftedAnchor = shiftSelectedTextAnchorAfterPatch({
      anchor: comment.anchor,
      lengthDelta,
      newMarkdown
    });

    if (!shiftedAnchor) {
      const recoveredAnchor = recoverSelectedTextAnchor({
        comment,
        headings: parseMarkdownHeadings(newMarkdown),
        markdown: newMarkdown,
        preferredHeadingText: patch.target_heading
      });

      if (recoveredAnchor.status === "recovered") {
        return updateCommentAnchorAfterPatch({
          comment,
          content: `Patch ${patch.id} shifted text before this comment and Patchmark recovered the anchor from the selected text.`,
          createdAt,
          impactKind,
          newAnchor: recoveredAnchor.newAnchor,
          note: "Anchor recovered from selected text after patch.",
          patch,
          reason: "anchor_recovered_after_patch",
          result: "reanchored"
        });
      }

      return markCommentAnchorNeedsReviewAfterPatch({
        comment,
        content: `Patch ${patch.id} may have affected this comment anchor. Please review it.`,
        createdAt,
        impactKind,
        note:
          recoveredAnchor.status === "ambiguous"
            ? `Patchmark could not verify the shifted selected-text anchor and found ${recoveredAnchor.matchCount} possible recovery matches.`
            : "Patchmark could not verify the shifted selected-text anchor or recover the selected text.",
        patch
      });
    }

    return updateCommentAnchorAfterPatch({
      comment,
      createdAt,
      impactKind,
      newAnchor: shiftedAnchor,
      note: "Offsets shifted after patch.",
      patch,
      reason: "offset_shifted_after_patch",
      result: "offset_shifted"
    });
  }

  if (impactKind === "anchor_inside_replaced_range") {
    const preservedAnchor = createPreservedSelectedTextAnchorInsidePatch({
      anchor: comment.anchor,
      comment,
      newMarkdown,
      patch,
      replacementStart
    });

    if (preservedAnchor) {
      return updateCommentAnchorAfterPatch({
        comment,
        content: `Patch ${patch.id} changed nearby text and Patchmark recovered this comment anchor in the replacement.`,
        createdAt,
        impactKind,
        newAnchor: preservedAnchor,
        note: "Anchor recovered from selected text after patch.",
        patch,
        reason: "anchor_recovered_after_patch",
        result: "reanchored"
      });
    }

    return markCommentAnchorNeedsReviewAfterPatch({
      comment,
      content: `Patch ${patch.id} may have affected this comment anchor. Please review it.`,
      createdAt,
      impactKind,
      note: "The selected text was inside the replaced range but could not be found exactly once in the replacement.",
      patch
    });
  }

  if (impactKind === "anchor_intersects_replaced_range") {
    return markCommentAnchorNeedsReviewAfterPatch({
      comment,
      content: `Patch ${patch.id} changed text overlapping this comment anchor. Please review the comment anchor.`,
      createdAt,
      impactKind,
      note: "The selected-text anchor partially overlapped the replaced range.",
      patch
    });
  }

  return {
    comment: appendPatchImpactToComment({
      comment,
      createdAt,
      impactKind,
      note: "Comment was classified as affected, but no anchor change was required.",
      patchId: patch.id,
      result: "unchanged"
    }),
    result: "unchanged"
  };
}

function createPatchReplacementAnchor({
  comment,
  newMarkdown,
  patch,
  replacementEnd,
  replacementStart
}: {
  comment: PatchmarkComment;
  newMarkdown: string;
  patch: PatchmarkPatch;
  replacementEnd: number;
  replacementStart: number;
}): SelectedTextAnchor | null {
  if (patch.suggested_text.length === 0 || replacementEnd < replacementStart) {
    return null;
  }

  return createSelectedTextAnchorAtRange({
    anchor: comment.anchor.kind === "selected_text" ? comment.anchor : undefined,
    anchorSource: "patch",
    comment,
    context: {
      kind: "block",
      plain_text: patch.suggested_text,
      markdown_text: patch.suggested_text,
      selected_start_in_context: 0,
      selected_end_in_context: patch.suggested_text.length,
      markdown_start_offset: replacementStart,
      markdown_end_offset: replacementEnd
    },
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: patch.suggested_text,
    start: replacementStart,
    end: replacementEnd
  });
}

function updateAffectedSectionCommentAnchor({
  comment,
  createdAt,
  impactKind,
  isLinkedComment,
  newMarkdown,
  patch
}: {
  comment: PatchmarkComment;
  createdAt: string;
  impactKind: PatchCommentImpactKind;
  isLinkedComment: boolean;
  newMarkdown: string;
  patch: PatchmarkPatch;
}): { comment: PatchmarkComment; result: PatchmarkCommentPatchImpact["result"] } {
  if (comment.anchor.kind !== "section") {
    return {
      comment,
      result: "unchanged"
    };
  }

  const newAnchor = refreshSectionAnchorAfterPatch({
    anchor: comment.anchor,
    newMarkdown
  });

  if (!newAnchor) {
    return markCommentAnchorNeedsReviewAfterPatch({
      comment,
      content: isLinkedComment
        ? `Patch ${patch.id} was applied to the document, but Patchmark could not re-anchor this comment automatically.`
        : `Patch ${patch.id} may have affected this comment anchor. Please review it.`,
      createdAt,
      impactKind,
      note: "The section heading could not be found after applying the patch.",
      patch
    });
  }

  if (areCommentAnchorsEqual(comment.anchor, newAnchor)) {
    const nextComment = appendPatchImpactToComment({
      comment,
      createdAt,
      impactKind,
      note: "Section comment remains attached to the same heading.",
      patchId: patch.id,
      result: "unchanged"
    });

    return {
      comment: isLinkedComment
        ? appendSystemThreadEntryToComment({
            comment: nextComment,
            content: `Patch ${patch.id} was applied to the document.`,
            createdAt,
            patchId: patch.id
          })
        : nextComment,
      result: "unchanged"
    };
  }

  return updateCommentAnchorAfterPatch({
    comment,
    content: isLinkedComment
      ? `Patch ${patch.id} was applied to the document and this comment was re-anchored to the applied replacement.`
      : undefined,
    createdAt,
    impactKind,
    newAnchor,
    patch,
    reason: "offset_shifted_after_patch",
    result: "offset_shifted"
  });
}

function refreshSectionAnchorAfterPatch({
  anchor,
  newMarkdown
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "section" }>;
  newMarkdown: string;
}): Extract<PatchmarkCommentAnchor, { kind: "section" }> | null {
  const nextHeadings = parseMarkdownHeadings(newMarkdown);
  const targetHeading = findMatchingHeading(nextHeadings, {
    level: anchor.heading_level,
    text: anchor.heading
  });

  if (!targetHeading) {
    return null;
  }

  const sectionRange = getSectionRange(newMarkdown, nextHeadings, targetHeading);

  return {
    ...anchor,
    heading: targetHeading.text,
    heading_level: targetHeading.level,
    heading_line: targetHeading.line,
    heading_path: getHeadingPath(nextHeadings, targetHeading),
    section_start_offset: sectionRange.start,
    section_end_offset: sectionRange.end
  };
}

function createPreservedSelectedTextAnchorInsidePatch({
  anchor,
  comment,
  newMarkdown,
  patch,
  replacementStart
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  newMarkdown: string;
  patch: PatchmarkPatch;
  replacementStart: number;
}): SelectedTextAnchor | null {
  const matchesInSuggestedText = findExactTextMatches(
    patch.suggested_text,
    anchor.selected_text
  );

  if (matchesInSuggestedText.length !== 1) {
    return null;
  }

  const start = replacementStart + matchesInSuggestedText[0].start;
  const end = replacementStart + matchesInSuggestedText[0].end;

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource: "patch",
    comment,
    context: {
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: anchor.selected_text,
      markdown_text: anchor.selected_text,
      selected_start_in_context: 0,
      selected_end_in_context: anchor.selected_text.length,
      markdown_start_offset: start,
      markdown_end_offset: end
    },
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: anchor.selected_text,
    start,
    end
  });
}

function shiftSelectedTextAnchorAfterPatch({
  anchor,
  lengthDelta,
  newMarkdown
}: {
  anchor: SelectedTextAnchor;
  lengthDelta: number;
  newMarkdown: string;
}): SelectedTextAnchor | null {
  if (
    typeof anchor.markdown_start_offset !== "number" ||
    typeof anchor.markdown_end_offset !== "number"
  ) {
    return null;
  }

  const start = anchor.markdown_start_offset + lengthDelta;
  const end = anchor.markdown_end_offset + lengthDelta;

  if (start < 0 || end < start || newMarkdown.slice(start, end) !== anchor.selected_text) {
    return null;
  }

  const shiftedContext = shiftAnchorContextOffsets(
    anchor.anchor_context,
    lengthDelta
  );

  return refreshSelectedAnchorPositionMetadata({
    anchor: {
      ...anchor,
      anchor_context: shiftedContext,
      markdown_start_offset: start,
      markdown_end_offset: end
    },
    markdown: newMarkdown,
    start,
    end
  });
}

function shiftAnchorContextOffsets(
  context: PatchmarkSelectedTextAnchorContext | undefined,
  lengthDelta: number
): PatchmarkSelectedTextAnchorContext | undefined {
  if (!context) {
    return undefined;
  }

  return {
    ...context,
    markdown_start_offset:
      typeof context.markdown_start_offset === "number"
        ? context.markdown_start_offset + lengthDelta
        : undefined,
    markdown_end_offset:
      typeof context.markdown_end_offset === "number"
        ? context.markdown_end_offset + lengthDelta
        : undefined
  };
}

function createSelectedTextAnchorAtRange({
  anchor,
  anchorSource,
  comment,
  context,
  markdown,
  preferredHeadingText,
  selectedText,
  start,
  end
}: {
  anchor?: SelectedTextAnchor;
  anchorSource: SelectedTextAnchor["anchor_source"];
  comment: PatchmarkComment;
  context: PatchmarkSelectedTextAnchorContext;
  markdown: string;
  preferredHeadingText?: string;
  selectedText: string;
  start: number;
  end: number;
}): SelectedTextAnchor {
  return refreshSelectedAnchorPositionMetadata({
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      selected_text_hash: anchor?.selected_text_hash,
      anchor_context: context,
      markdown_start_offset: start,
      markdown_end_offset: end,
      anchor_source: anchorSource,
      action_context:
        anchor?.action_context ??
        getDefaultCommentActionContext(comment.type, "selected_text")
    },
    markdown,
    preferredHeadingText,
    start,
    end
  });
}

function refreshSelectedAnchorPositionMetadata({
  anchor,
  markdown,
  preferredHeadingText,
  start,
  end
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  preferredHeadingText?: string;
  start: number;
  end: number;
}): SelectedTextAnchor {
  const headings = parseMarkdownHeadings(markdown);
  const containingHeadingByOffset = getHeadingContainingOffset(
    markdown,
    headings,
    start
  );
  const targetHeading = preferredHeadingText
    ? headings.find((heading) => heading.text === preferredHeadingText) ??
      containingHeadingByOffset
    : containingHeadingByOffset;
  const fallbackSectionRange = targetHeading
    ? getSectionRange(markdown, headings, targetHeading)
    : null;

  return {
    ...anchor,
    markdown_start_offset: start,
    markdown_end_offset: end,
    context_before: markdown.slice(
      Math.max(0, start - ANCHOR_CONTEXT_CHARS),
      start
    ),
    context_after: markdown.slice(
      end,
      Math.min(markdown.length, end + ANCHOR_CONTEXT_CHARS)
    ),
    containing_heading: preferredHeadingText ?? targetHeading?.text,
    containing_heading_level: targetHeading?.level,
    containing_heading_line: targetHeading?.line,
    containing_heading_path: targetHeading
      ? getHeadingPath(headings, targetHeading)
      : undefined,
    fallback_section_start_offset: fallbackSectionRange?.start,
    fallback_section_end_offset: fallbackSectionRange?.end
  };
}

function recoverSelectedTextAnchor({
  comment,
  headings,
  markdown,
  preferredHeadingText
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  preferredHeadingText?: string;
}): RecoveredAnchorResult {
  if (comment.anchor.kind !== "selected_text") {
    return {
      reason: "Only selected-text comments can be recovered from selected text.",
      status: "not_found"
    };
  }

  const { anchor } = comment;
  const currentOffsetMatch = getCurrentSelectedTextOffsetMatch(anchor, markdown);
  let ambiguousRecovery: Extract<RecoveredAnchorResult, { status: "ambiguous" }> | null =
    null;

  if (currentOffsetMatch) {
    return createRecoveredAnchorResult({
      anchor,
      comment,
      markdown,
      match: currentOffsetMatch,
      preferredHeadingText,
      reason: "current_offsets_match"
    });
  }

  const containingSectionRange = getSelectedAnchorContainingSectionRange({
    anchor,
    headings,
    markdown
  });

  if (containingSectionRange) {
    const sectionMatches = findExactTextMatches(
      markdown.slice(containingSectionRange.start, containingSectionRange.end),
      anchor.selected_text
    ).map((match) => ({
      start: containingSectionRange.start + match.start,
      end: containingSectionRange.start + match.end
    }));
    const sectionRecovery = createRecoveryResultFromMatches({
      anchor,
      comment,
      markdown,
      matches: sectionMatches,
      preferredHeadingText,
      reason: "selected_text_unique_in_section"
    });

    if (sectionRecovery.status === "recovered") {
      return sectionRecovery;
    }

    if (sectionRecovery.status === "ambiguous") {
      ambiguousRecovery = sectionRecovery;
    }

    const normalizedSectionMatches = findNormalizedTextMatches(
      markdown.slice(containingSectionRange.start, containingSectionRange.end),
      anchor.selected_text
    ).map((match) => ({
      start: containingSectionRange.start + match.start,
      end: containingSectionRange.start + match.end
    }));
    const normalizedSectionRecovery = createRecoveryResultFromMatches({
      anchor,
      comment,
      markdown,
      matches: normalizedSectionMatches,
      preferredHeadingText,
      reason: "selected_text_unique_in_section"
    });

    if (normalizedSectionRecovery.status === "recovered") {
      return normalizedSectionRecovery;
    }

    if (normalizedSectionRecovery.status === "ambiguous") {
      ambiguousRecovery = ambiguousRecovery ?? normalizedSectionRecovery;
    }
  }

  const contextResolution = resolveSelectedAnchorViaContext(markdown, anchor);

  if (contextResolution.status === "active") {
    return createRecoveredAnchorResult({
      anchor,
      comment,
      markdown,
      match: {
        start: contextResolution.start,
        end: contextResolution.end
      },
      preferredHeadingText,
      reason: "anchor_context_unique_match"
    });
  }

  const tableSearchRange =
    containingSectionRange ??
    ({
      start: 0,
      end: markdown.length
    } satisfies TextMatch);
  const tableMatches = findTableCellSelectedTextMatches({
    anchor,
    markdown,
    range: tableSearchRange
  });
  const tableRecovery = createRecoveryResultFromMatches({
    anchor,
    comment,
    markdown,
    matches: tableMatches,
    preferredHeadingText,
    reason: "table_cell_unique_match"
  });

  if (tableRecovery.status === "recovered") {
    return tableRecovery;
  }

  if (tableRecovery.status === "ambiguous") {
    ambiguousRecovery = ambiguousRecovery ?? tableRecovery;
  }

  const documentRecovery = createRecoveryResultFromMatches({
    anchor,
    comment,
    markdown,
    matches: findExactTextMatches(markdown, anchor.selected_text),
    preferredHeadingText,
    reason: "selected_text_unique_in_document"
  });

  if (documentRecovery.status === "recovered") {
    return documentRecovery;
  }

  if (documentRecovery.status === "ambiguous") {
    ambiguousRecovery = ambiguousRecovery ?? documentRecovery;
  }

  const normalizedDocumentRecovery = createRecoveryResultFromMatches({
    anchor,
    comment,
    markdown,
    matches: findNormalizedTextMatches(markdown, anchor.selected_text),
    preferredHeadingText,
    reason: "selected_text_unique_in_document"
  });

  if (normalizedDocumentRecovery.status === "recovered") {
    return normalizedDocumentRecovery;
  }

  if (normalizedDocumentRecovery.status === "ambiguous") {
    ambiguousRecovery = ambiguousRecovery ?? normalizedDocumentRecovery;
  }

  if (contextResolution.status === "ambiguous") {
    ambiguousRecovery = ambiguousRecovery ?? {
      matchCount: 2,
      reason: "Anchor context matched multiple places.",
      status: "ambiguous"
    };
  }

  if (ambiguousRecovery) {
    return ambiguousRecovery;
  }

  return {
    reason: "Selected text was not found uniquely in the section, context, table cells, or document.",
    status: "not_found"
  };
}

function getCurrentSelectedTextOffsetMatch(
  anchor: SelectedTextAnchor,
  markdown: string
): TextMatch | null {
  const start = anchor.markdown_start_offset;
  const end = anchor.markdown_end_offset;

  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end < start ||
    markdown.slice(start, end) !== anchor.selected_text
  ) {
    return null;
  }

  return { end, start };
}

function getSelectedAnchorContainingSectionRange({
  anchor,
  headings,
  markdown
}: {
  anchor: SelectedTextAnchor;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): TextMatch | null {
  const heading = findSelectedAnchorContainingHeading(anchor, headings);

  if (heading) {
    return getSectionRange(markdown, headings, heading);
  }

  const fallbackStart = anchor.fallback_section_start_offset;
  const fallbackEnd = anchor.fallback_section_end_offset;

  if (
    typeof fallbackStart === "number" &&
    typeof fallbackEnd === "number" &&
    fallbackStart >= 0 &&
    fallbackEnd > fallbackStart &&
    fallbackEnd <= markdown.length
  ) {
    return {
      start: fallbackStart,
      end: fallbackEnd
    };
  }

  return null;
}

function findSelectedAnchorContainingHeading(
  anchor: SelectedTextAnchor,
  headings: ReturnType<typeof parseMarkdownHeadings>
) {
  if (!anchor.containing_heading) {
    return null;
  }

  const candidates = headings.filter(
    (heading) =>
      heading.text === anchor.containing_heading &&
      (anchor.containing_heading_level === undefined ||
        heading.level === anchor.containing_heading_level)
  );

  if (candidates.length <= 1 || !anchor.containing_heading_path) {
    return candidates[0] ?? null;
  }

  const containingHeadingPath = anchor.containing_heading_path;

  return (
    candidates.find((heading) =>
      areHeadingPathsEqual(getHeadingPath(headings, heading), containingHeadingPath)
    ) ??
    candidates[0] ??
    null
  );
}

function areHeadingPathsEqual(firstPath: string[], secondPath: string[]): boolean {
  return (
    firstPath.length === secondPath.length &&
    firstPath.every((heading, index) => heading === secondPath[index])
  );
}

function findTableCellSelectedTextMatches({
  anchor,
  markdown,
  range
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  range: TextMatch;
}): TextMatch[] {
  const tables = findMarkdownTablesInRange(markdown, {
    start: range.start,
    end: range.end,
    searchedWholeDocument: range.start === 0 && range.end === markdown.length
  });
  const matches = tables.flatMap((table) =>
    table.rows.flatMap((row) => {
      const exactMatches = findExactTextMatches(row.text, anchor.selected_text);
      const normalizedMatches = findNormalizedTextMatches(
        row.text,
        anchor.selected_text
      );
      const plainMatches =
        anchor.anchor_context?.kind === "table_cell" || anchor.anchor_source === "visual"
          ? findMarkdownPlainTextMatches(row.text, anchor.selected_text)
          : [];

      return dedupeTextMatches([
        ...exactMatches,
        ...normalizedMatches,
        ...plainMatches
      ]).map((match) => ({
        start: row.start + match.start,
        end: row.start + match.end
      }));
    })
  );

  return dedupeTextMatches(matches);
}

function createRecoveryResultFromMatches({
  anchor,
  comment,
  markdown,
  matches,
  preferredHeadingText,
  reason
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  markdown: string;
  matches: TextMatch[];
  preferredHeadingText?: string;
  reason: RecoveredAnchorReason;
}): RecoveredAnchorResult {
  const uniqueMatches = dedupeTextMatches(matches);

  if (uniqueMatches.length === 0) {
    return {
      reason: "No matches found.",
      status: "not_found"
    };
  }

  if (uniqueMatches.length > 1) {
    return {
      matchCount: uniqueMatches.length,
      reason: "Selected text has multiple possible matches.",
      status: "ambiguous"
    };
  }

  return createRecoveredAnchorResult({
    anchor,
    comment,
    markdown,
    match: uniqueMatches[0],
    preferredHeadingText,
    reason
  });
}

function createRecoveredAnchorResult({
  anchor,
  comment,
  markdown,
  match,
  preferredHeadingText,
  reason
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  markdown: string;
  match: TextMatch;
  preferredHeadingText?: string;
  reason: RecoveredAnchorReason;
}): RecoveredAnchorResult {
  const recoveredSelectedText = markdown.slice(match.start, match.end);
  const context =
    createAnchorContextFromMarkdownRange(markdown, match) ??
    ({
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(recoveredSelectedText),
      markdown_text: recoveredSelectedText,
      selected_start_in_context: 0,
      selected_end_in_context: match.end - match.start,
      markdown_start_offset: match.start,
      markdown_end_offset: match.end
    } satisfies PatchmarkSelectedTextAnchorContext);

  return {
    matchStart: match.start,
    matchEnd: match.end,
    newAnchor: createSelectedTextAnchorAtRange({
      anchor,
      anchorSource: anchor.anchor_source ?? "markdown",
      comment,
      context,
      markdown,
      preferredHeadingText,
      selectedText: recoveredSelectedText,
      start: match.start,
      end: match.end
    }),
    reason,
    status: "recovered"
  };
}

function recoverCommentAnchorForFind({
  comment,
  createdAt,
  latestNeedsReviewImpact,
  newAnchor
}: {
  comment: PatchmarkComment;
  createdAt: string;
  latestNeedsReviewImpact: PatchmarkCommentPatchImpact | null;
  newAnchor: SelectedTextAnchor;
}): PatchmarkComment {
  const recoveredComment: PatchmarkComment = {
    ...comment,
    anchor: newAnchor,
    anchor_history: [
      ...(comment.anchor_history ?? []),
      {
        changed_at: createdAt,
        reason: "anchor_recovered_after_patch",
        source_patch_id: latestNeedsReviewImpact?.patch_id,
        previous_anchor: comment.anchor,
        new_anchor: newAnchor,
        impact_kind: latestNeedsReviewImpact?.impact_kind
      }
    ],
    updated_at: createdAt
  };

  if (!latestNeedsReviewImpact) {
    return recoveredComment;
  }

  return appendPatchImpactToComment({
    comment: recoveredComment,
    createdAt,
    impactKind: latestNeedsReviewImpact.impact_kind,
    note: "Anchor recovered from selected text during Find.",
    patchId: latestNeedsReviewImpact.patch_id,
    result: "reanchored"
  });
}

function recoverPersistableStaleCommentAnchors({
  comments,
  headings,
  markdown
}: {
  comments: PatchmarkComment[];
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): PatchmarkComment[] {
  let didRecover = false;
  const recoveredAt = new Date().toISOString();
  const recoveredComments = comments.map((comment) => {
    if (comment.anchor.kind !== "selected_text") {
      return comment;
    }

    if (getCurrentSelectedTextOffsetMatch(comment.anchor, markdown)) {
      return comment;
    }

    const recovery = recoverSelectedTextAnchor({
      comment,
      headings,
      markdown,
      preferredHeadingText: comment.anchor.containing_heading
    });

    if (
      recovery.status !== "recovered" ||
      areCommentAnchorsEqual(comment.anchor, recovery.newAnchor)
    ) {
      return comment;
    }

    didRecover = true;

    return recoverPersistableStaleCommentAnchor({
      comment,
      recoveredAt,
      recovery
    });
  });

  return didRecover ? recoveredComments : comments;
}

function recoverPersistableStaleCommentAnchor({
  comment,
  recoveredAt,
  recovery
}: {
  comment: PatchmarkComment;
  recoveredAt: string;
  recovery: Extract<RecoveredAnchorResult, { status: "recovered" }>;
}): PatchmarkComment {
  const latestPatchImpact = comment.patch_impacts?.at(-1);
  const recoveredComment: PatchmarkComment = {
    ...comment,
    anchor: recovery.newAnchor,
    anchor_history: [
      ...(comment.anchor_history ?? []),
      {
        changed_at: recoveredAt,
        reason: "anchor_recovered_after_patch",
        source_patch_id: latestPatchImpact?.patch_id,
        previous_anchor: comment.anchor,
        new_anchor: recovery.newAnchor,
        impact_kind: latestPatchImpact?.impact_kind
      }
    ],
    updated_at: recoveredAt
  };

  if (latestPatchImpact?.result !== "needs_review") {
    return recoveredComment;
  }

  return appendPatchImpactToComment({
    comment: recoveredComment,
    createdAt: recoveredAt,
    impactKind: latestPatchImpact.impact_kind,
    note: "Anchor recovered from current document state.",
    patchId: latestPatchImpact.patch_id,
    result: "reanchored"
  });
}

function updateCommentAnchorAfterPatch({
  comment,
  content,
  createdAt,
  impactKind,
  newAnchor,
  note,
  patch,
  reason,
  result
}: {
  comment: PatchmarkComment;
  content?: string;
  createdAt: string;
  impactKind: PatchCommentImpactKind;
  newAnchor: PatchmarkCommentAnchor;
  note?: string;
  patch: PatchmarkPatch;
  reason: NonNullable<PatchmarkComment["anchor_history"]>[number]["reason"];
  result: PatchmarkCommentPatchImpact["result"];
}): { comment: PatchmarkComment; result: PatchmarkCommentPatchImpact["result"] } {
  let nextComment = appendPatchImpactToComment({
    comment: {
      ...comment,
      anchor: newAnchor,
      anchor_history: [
        ...(comment.anchor_history ?? []),
        {
          changed_at: createdAt,
          reason,
          source_patch_id: patch.id,
          previous_anchor: comment.anchor,
          new_anchor: newAnchor,
          impact_kind: impactKind
        }
      ]
    },
    createdAt,
    impactKind,
    note,
    patchId: patch.id,
    result
  });

  if (content) {
    nextComment = appendSystemThreadEntryToComment({
      comment: nextComment,
      content,
      createdAt,
      patchId: patch.id
    });
  }

  return {
    comment: nextComment,
    result
  };
}

function markCommentAnchorNeedsReviewAfterPatch({
  comment,
  content,
  createdAt,
  impactKind,
  note,
  patch
}: {
  comment: PatchmarkComment;
  content: string;
  createdAt: string;
  impactKind: PatchCommentImpactKind;
  note: string;
  patch: PatchmarkPatch;
}): { comment: PatchmarkComment; result: "needs_review" } {
  const nextComment = appendSystemThreadEntryToComment({
    comment: appendPatchImpactToComment({
      comment: {
        ...comment,
        anchor_history: [
          ...(comment.anchor_history ?? []),
          {
            changed_at: createdAt,
            reason: "anchor_marked_needs_review_after_patch",
            source_patch_id: patch.id,
            previous_anchor: comment.anchor,
            impact_kind: impactKind
          }
        ]
      },
      createdAt,
      impactKind,
      note,
      patchId: patch.id,
      result: "needs_review"
    }),
    content,
    createdAt,
    patchId: patch.id
  });

  return {
    comment: nextComment,
    result: "needs_review"
  };
}

function appendPatchImpactToComment({
  comment,
  createdAt,
  impactKind,
  note,
  patchId,
  result
}: {
  comment: PatchmarkComment;
  createdAt: string;
  impactKind: PatchCommentImpactKind;
  note?: string;
  patchId: string;
  result: PatchmarkCommentPatchImpact["result"];
}): PatchmarkComment {
  return {
    ...comment,
    patch_impacts: [
      ...(comment.patch_impacts ?? []),
      {
        patch_id: patchId,
        impacted_at: createdAt,
        impact_kind: impactKind,
        result,
        note
      }
    ],
    updated_at: createdAt
  };
}

function areCommentAnchorsEqual(
  firstAnchor: PatchmarkCommentAnchor,
  secondAnchor: PatchmarkCommentAnchor
): boolean {
  return JSON.stringify(firstAnchor) === JSON.stringify(secondAnchor);
}

function appendSystemThreadEntryToComment({
  comment,
  content,
  createdAt,
  patchId
}: {
  comment: PatchmarkComment;
  content: string;
  createdAt: string;
  patchId: string;
}): PatchmarkComment {
  return {
    ...comment,
    thread: [
      ...comment.thread,
      {
        id: createNextThreadEntryId(comment),
        role: "system" as const,
        content,
        created_at: createdAt,
        source_patch_id: patchId
      }
    ],
    updated_at: createdAt
  };
}

function appendPatchSystemThreadEntry({
  comments,
  commentId,
  content,
  createdAt,
  patchId
}: {
  comments: PatchmarkComment[];
  commentId: string;
  content: string;
  createdAt: string;
  patchId?: string;
}): PatchmarkComment[] | null {
  let didAppend = false;

  const nextComments = comments.map((comment) => {
    if (comment.id !== commentId) {
      return comment;
    }

    didAppend = true;

    return {
      ...comment,
      thread: [
        ...comment.thread,
        {
          id: createNextThreadEntryId(comment),
          role: "system" as const,
          content,
          created_at: createdAt,
          ...(patchId ? { source_patch_id: patchId } : {})
        }
      ],
      updated_at: createdAt
    };
  });

  return didAppend ? nextComments : null;
}

function getPatchApplicabilityLabel(applicability: PatchApplicability): string {
  if (applicability === "exact_match") {
    return "Patch can be applied cleanly.";
  }

  if (applicability === "multiple_matches") {
    return "Patch matches multiple locations.";
  }

  if (applicability === "table_row_rebase_available") {
    return "Patch target recovered.";
  }

  return "Original text was not found.";
}

function getPatchReviewAnchorLabel(anchorStatus: PatchReviewAnchorStatus): string {
  if (anchorStatus.kind !== "accepted") {
    return getPatchApplicabilityLabel(anchorStatus.applicability);
  }

  if (anchorStatus.status === "empty_applied_text") {
    return "Patch was applied.";
  }

  if (isAcceptedPatchEvolved(anchorStatus)) {
    return "Patch content evolved after application.";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "Patch was applied, but the applied text now appears multiple times.";
  }

  if (anchorStatus.status !== "not_found") {
    return "Patch was applied.";
  }

  return "Patch was applied, but the applied text is no longer found.";
}

function getPatchApplicabilityShortLabel(
  applicability: PatchApplicability
): string {
  if (applicability === "exact_match") {
    return "Can apply cleanly";
  }

  if (applicability === "multiple_matches") {
    return "Multiple matches";
  }

  if (applicability === "table_row_rebase_available") {
    return "Recovered target";
  }

  return "Original text not found";
}

function getPatchReviewAnchorShortLabel(
  anchorStatus: PatchReviewAnchorStatus
): string {
  if (anchorStatus.kind !== "accepted") {
    return getPatchApplicabilityShortLabel(anchorStatus.applicability);
  }

  if (anchorStatus.status === "exact_match") {
    return "Applied text present";
  }

  if (anchorStatus.status === "normalized_match") {
    return "Applied text present after normalization";
  }

  if (isAcceptedPatchEvolved(anchorStatus)) {
    return "Applied content evolved";
  }

  if (anchorStatus.status === "empty_applied_text") {
    return "Applied empty replacement";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "Applied text appears multiple times";
  }

  return "Applied text not found";
}

function getPatchApplicabilityDetail(
  applicability: PatchApplicability
): string {
  if (applicability === "exact_match") {
    return "The original text appears exactly once in the current Markdown.";
  }

  if (applicability === "multiple_matches") {
    return "Review manually before applying in a later phase.";
  }

  if (applicability === "table_row_rebase_available") {
    return "Patchmark found one matching table row and can maintain this anchor automatically.";
  }

  return "The patch may be stale because the current document no longer contains the original text.";
}

function getPatchReviewAnchorDetail(anchorStatus: PatchReviewAnchorStatus): string {
  if (anchorStatus.kind !== "accepted") {
    return getPatchApplicabilityDetail(anchorStatus.applicability);
  }

  if (anchorStatus.status === "exact_match") {
    return "Applied text is present in the current document.";
  }

  if (anchorStatus.status === "normalized_match") {
    return "Applied text was recovered with normalized Markdown/plain-text matching.";
  }

  if (anchorStatus.status === "row_match") {
    return "Applied table-row content was recovered by structural row anchor.";
  }

  if (anchorStatus.status === "section_match") {
    return "Applied content was recovered inside the recorded section anchor.";
  }

  if (anchorStatus.status === "evolved_after_patch") {
    return "A later patch or surrounding context indicates this patch target evolved after application.";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "The accepted replacement exists, but Patchmark cannot identify one unique applied location.";
  }

  if (anchorStatus.status === "empty_applied_text") {
    return "This accepted patch applied an empty replacement, so there is no applied text to locate.";
  }

  return "The document may have changed after this patch was applied.";
}

function getPatchReviewAnchorClassName(
  anchorStatus: PatchReviewAnchorStatus
): PatchApplicability {
  if (anchorStatus.kind !== "accepted") {
    return anchorStatus.applicability;
  }

  if (
    anchorStatus.status === "empty_applied_text" ||
    anchorStatus.status === "evolved_after_patch" ||
    anchorStatus.status === "exact_match" ||
    anchorStatus.status === "normalized_match" ||
    anchorStatus.status === "row_match" ||
    anchorStatus.status === "section_match"
  ) {
    return "exact_match";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "multiple_matches";
  }

  return "not_found";
}

function isAcceptedPatchTraceable(
  anchorStatus: Extract<PatchReviewAnchorStatus, { kind: "accepted" }>
): boolean {
  return (
    anchorStatus.status === "evolved_after_patch" ||
    anchorStatus.status === "exact_match" ||
    anchorStatus.status === "normalized_match" ||
    anchorStatus.status === "row_match" ||
    anchorStatus.status === "section_match"
  );
}

function isAcceptedPatchEvolved(
  anchorStatus: Extract<PatchReviewAnchorStatus, { kind: "accepted" }>
): boolean {
  return (
    anchorStatus.status === "evolved_after_patch" ||
    anchorStatus.status === "row_match" ||
    anchorStatus.status === "section_match"
  );
}

function getAcceptedPatchAnchorDiagnostic(
  anchorStatus: Extract<PatchReviewAnchorStatus, { kind: "accepted" }>
):
  | "exact_match"
  | "evolved_after_patch"
  | "normalized_match"
  | "not_found"
  | "row_match"
  | "section_match" {
  if (
    anchorStatus.status === "empty_applied_text" ||
    anchorStatus.status === "multiple_matches"
  ) {
    return anchorStatus.matches.length > 0 ? "exact_match" : "not_found";
  }

  return anchorStatus.status;
}

function getPatchDisplayState(
  patch: PatchmarkPatch,
  anchorStatus: PatchReviewAnchorStatus
): PatchDisplayState {
  if (patch.status === "accepted") {
    return anchorStatus.kind === "accepted" && isAcceptedPatchEvolved(anchorStatus)
      ? "applied_evolved"
      : "applied";
  }

  if (patch.status === "rejected") {
    return "rejected";
  }

  if (patch.status === "stale") {
    return "stale";
  }

  if (
    anchorStatus.kind === "pending" &&
    anchorStatus.applicability !== "exact_match"
  ) {
    return "needs_review";
  }

  return "pending";
}

function getPatchStatusBadgeLabel(displayState: PatchDisplayState): string {
  if (displayState === "applied") {
    return "APPLIED";
  }

  if (displayState === "applied_evolved") {
    return "APPLIED AND EVOLVED";
  }

  if (displayState === "needs_review") {
    return "NEEDS REVIEW";
  }

  if (displayState === "rejected") {
    return "REJECTED";
  }

  if (displayState === "stale") {
    return "STALE BEFORE APPLY";
  }

  return "PENDING";
}

function getPatchReviewButtonLabel(displayState: PatchDisplayState): string {
  if (displayState === "applied" || displayState === "applied_evolved") {
    return "View applied patch";
  }

  if (displayState === "rejected") {
    return "View rejected patch";
  }

  if (displayState === "stale") {
    return "View stale patch";
  }

  return "Review patch";
}

function getPatchReviewIntro(displayState: PatchDisplayState): string {
  if (displayState === "applied") {
    return "This patch has already been applied. Review is read-only.";
  }

  if (displayState === "applied_evolved") {
    return "This patch was applied and its target content evolved later. Review is read-only.";
  }

  if (displayState === "rejected") {
    return "This patch was rejected. Review is read-only and the document was not changed.";
  }

  if (displayState === "stale") {
    return "This patch went stale before apply. Review is read-only.";
  }

  if (displayState === "needs_review") {
    return "Inspect this ChatGPT proposal. Patchmark needs a clean anchor before it can apply automatically.";
  }

  return "Inspect this ChatGPT proposal. Accepting applies the exact suggested replacement after a safety snapshot.";
}

function getPatchLifecycleDetail(patch: PatchmarkPatch): string | null {
  if (patch.status === "accepted") {
    return patch.applied_at
      ? `Applied ${formatPatchDate(patch.applied_at)}`
      : patch.accepted_at
        ? `Accepted ${formatPatchDate(patch.accepted_at)}`
        : "Applied";
  }

  if (patch.status === "rejected") {
    return patch.rejected_at
      ? `Rejected ${formatPatchDate(patch.rejected_at)}`
      : "Rejected";
  }

  if (patch.status === "stale") {
    return "Stale patch";
  }

  return null;
}

function getPatchSnapshotDetail(patch: PatchmarkPatch): string | null {
  if (patch.status !== "accepted" || !patch.pre_apply_snapshot_id) {
    return null;
  }

  return `Pre-apply snapshot: ${patch.pre_apply_snapshot_id}`;
}

function getPatchGroupProgressItems(
  statusSummary: PatchmarkPatchGroup["status_summary"]
): Array<{ count: number; key: PatchDisplayState | "total"; label: string }> {
  return [
    {
      count: statusSummary.total,
      key: "total",
      label: "total"
    },
    {
      count: statusSummary.accepted,
      key: "applied",
      label: "applied"
    },
    {
      count: statusSummary.pending,
      key: "pending",
      label: "pending"
    },
    {
      count: statusSummary.rejected,
      key: "rejected",
      label: "rejected"
    },
    {
      count: statusSummary.stale,
      key: "stale",
      label: "stale"
    }
  ];
}

function getPatchGroupNeedsReviewCount(group: DerivedPatchGroup): number {
  return (
    group.applicability_summary.multiple_matches +
    group.applicability_summary.not_found +
    group.applicability_summary.table_row_rebase_available
  );
}

function getPatchGroupStatusLabel(status: PatchmarkPatchGroupStatus): string {
  if (status === "needs_review") {
    return "Needs review";
  }

  if (status === "in_progress") {
    return "In progress";
  }

  if (status === "completed") {
    return "Completed";
  }

  return "Pending";
}

function formatPatchGroupStatusSummary(
  statusSummary: PatchmarkPatchGroup["status_summary"]
): string {
  return `${statusSummary.total} patch${
    statusSummary.total === 1 ? "" : "es"
  } total · ${statusSummary.pending} pending · ${
    statusSummary.accepted
  } applied · ${statusSummary.rejected} rejected · ${statusSummary.stale} stale`;
}

function formatPatchGroupApplicabilitySummary(
  group: DerivedPatchGroup
): string {
  const cleanCount = group.applicability_summary.exact_match;
  const needsReviewCount = getPatchGroupNeedsReviewCount(group);

  return `${cleanCount} can apply cleanly · ${needsReviewCount} need${
    needsReviewCount === 1 ? "s" : ""
  } review`;
}

function getLatestChatGptThreadEntry(
  comment: PatchmarkComment
): PatchmarkCommentThreadEntry | null {
  return (
    [...comment.thread]
      .reverse()
      .find((entry) => entry.role === "chatgpt") ?? null
  );
}

function formatPatchDate(dateValue: string): string {
  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return dateValue;
  }

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatPatchReanchorReason(
  reason: NonNullable<PatchmarkPatch["reanchor_reason"]>
): string {
  if (reason === "table_row_normalized_match") {
    return "Table row normalized match";
  }

  return reason;
}

function createChatGptImportSummaryMessage({
  openQuestionsAttached,
  patchProposalsStored,
  repliesAttached,
  warnings
}: ChatGptImportSummary): string {
  const summary = [
    "Imported ChatGPT response.",
    `Replies attached: ${repliesAttached}`,
    `Open questions attached: ${openQuestionsAttached}`,
    `Patch proposals stored: ${patchProposalsStored}`,
    `Warnings: ${warnings.length}`
  ];

  if (warnings.length > 0) {
    summary.push(`Some response items referenced comments that were not found: ${
      warnings
        .map((warning) => warning.split(": ").at(-1))
        .filter(Boolean)
        .join(", ")
    }`);
  }

  return summary.join(" ");
}

function isSuggestedUserAction(
  value: unknown
): value is PatchmarkSuggestedUserAction {
  return (
    typeof value === "string" &&
    [
      "review",
      "clarify",
      "apply_patch",
      "keep_open",
      "resolve_manually"
    ].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createFocusedCommentsExportPayload({
  comments,
  dedicatedDocumentReview,
  exportedAt,
  exportId,
  headings,
  markdown,
  project
}: {
  comments: PatchmarkComment[];
  dedicatedDocumentReview: boolean;
  exportedAt: string;
  exportId: string;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  project: PatchmarkProjectHandle;
}) {
  return {
    protocol: "patchmark.comment_export",
    protocol_version: 1,
    export_id: exportId,
    export_scope: dedicatedDocumentReview
      ? "dedicated_document_comment"
      : "focused_comments",
    project: {
      project_name: project.manifest.project_name,
      document_file: project.manifest.document_file,
      exported_at: exportedAt
    },
    instructions_for_chatgpt: {
      role:
        "You are helping review and improve a Markdown document through Patchmark comments.",
      rules: [
        "Reply to each exported comment by comment_id.",
        "Do not resolve comments. Only the human resolves comments.",
        "If you suggest a document change, return a patch proposal linked to the comment_id.",
        "If more information is needed, ask a clarification question linked to the comment_id.",
        "Preserve Markdown structure.",
        "Drafting support only. Legal review may still be required.",
        ...(dedicatedDocumentReview
          ? [
              "This is a dedicated whole-document review task.",
              "Focus only on the exported document-level comment.",
              "Do not address unrelated document issues unless they are necessary to resolve this comment.",
              "Prefer small exact patches over rewriting the whole document."
            ]
          : [])
      ],
      expected_response_format: "patchmark.comment_reply_import"
    },
    comments: comments.map((comment) =>
      createFocusedCommentExportEntry({
        comment,
        headings,
        markdown
      })
    )
  };
}

function createFocusedCommentExportEntry({
  comment,
  headings,
  markdown
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}) {
  const actionContext =
    comment.anchor.kind === "document"
      ? {
          ...(comment.anchor.action_context ??
            getDefaultCommentActionContext(comment.type, comment.anchor.kind)),
          default_scope: "full_document" as const,
          include_document_brief: true
        }
      : comment.anchor.action_context ??
        getDefaultCommentActionContext(comment.type, comment.anchor.kind);

  return {
    comment_id: comment.id,
    type: comment.type,
    intent: actionContext.intent_hint,
    anchor: createExportAnchor(comment.anchor),
    action_context: actionContext,
    comment: comment.comment,
    thread: comment.thread.map(createExportThreadEntry),
    context: createExportContext({
      actionContext,
      anchor: comment.anchor,
      headings,
      markdown
    })
  };
}

function createExportThreadEntry(entry: PatchmarkCommentThreadEntry) {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    created_at: entry.created_at
  };
}

function createExportAnchor(anchor: PatchmarkCommentAnchor) {
  if (anchor.kind === "document") {
    return {
      kind: "document"
    };
  }

  if (anchor.kind === "section") {
    return {
      kind: "section",
      heading: anchor.heading,
      heading_level: anchor.heading_level,
      heading_line: anchor.heading_line,
      heading_path: anchor.heading_path
    };
  }

  return {
    kind: "selected_text",
    selected_text: anchor.selected_text,
    anchor_context: anchor.anchor_context,
    containing_heading: anchor.containing_heading,
    containing_heading_level: anchor.containing_heading_level,
    containing_heading_line: anchor.containing_heading_line,
    containing_heading_path: anchor.containing_heading_path,
    anchor_source: anchor.anchor_source
  };
}

function createExportContext({
  actionContext,
  anchor,
  headings,
  markdown
}: {
  actionContext: PatchmarkCommentActionContext;
  anchor: PatchmarkCommentAnchor;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}) {
  const containingSectionMarkdown = getContainingSectionMarkdown(
    anchor,
    markdown,
    headings
  );

  return {
    document_brief: null,
    display_target: getCommentDisplayTarget(anchor),
    anchor_context:
      anchor.kind === "selected_text" ? anchor.anchor_context ?? null : null,
    containing_section_markdown:
      actionContext.default_scope === "containing_section"
        ? containingSectionMarkdown
        : null,
    full_document_markdown:
      actionContext.default_scope === "full_document" ? markdown : null,
    related_open_comments: []
  };
}

function getCommentDisplayTarget(anchor: PatchmarkCommentAnchor): string {
  if (anchor.kind === "document") {
    return "Whole document";
  }

  if (anchor.kind === "section") {
    return `${"#".repeat(anchor.heading_level ?? 1)} ${anchor.heading}`;
  }

  return anchor.selected_text;
}

function getContainingSectionMarkdown(
  anchor: PatchmarkCommentAnchor,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): string | null {
  if (anchor.kind === "document") {
    return null;
  }

  if (anchor.kind === "section") {
    const heading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!heading) {
      return null;
    }

    const sectionRange = getSectionRange(markdown, headings, heading);

    return markdown.slice(sectionRange.start, sectionRange.end);
  }

  const containingHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : null;

  if (containingHeading) {
    const sectionRange = getSectionRange(markdown, headings, containingHeading);

    return markdown.slice(sectionRange.start, sectionRange.end);
  }

  if (
    typeof anchor.fallback_section_start_offset === "number" &&
    typeof anchor.fallback_section_end_offset === "number"
  ) {
    return markdown.slice(
      anchor.fallback_section_start_offset,
      anchor.fallback_section_end_offset
    );
  }

  if (typeof anchor.markdown_start_offset === "number") {
    const heading = getHeadingContainingOffset(
      markdown,
      headings,
      anchor.markdown_start_offset
    );

    if (heading) {
      const sectionRange = getSectionRange(markdown, headings, heading);

      return markdown.slice(sectionRange.start, sectionRange.end);
    }
  }

  return null;
}

function createMarkdownSelectionDraft(
  markdown: string,
  selection: MarkdownSelection
): SelectedCommentAnchorDraft | null {
  return createMarkdownSelectionDraftResult(markdown, selection).draft;
}

function createMarkdownSelectionDraftResult(
  markdown: string,
  selection: MarkdownSelection
): SelectedCommentAnchorDraftResult {
  if (selection.end <= selection.start) {
    return {
      draft: null,
      help: null
    };
  }

  const selectedRange = trimRange(markdown, selection.start, selection.end);

  if (selectedRange.end <= selectedRange.start) {
    return {
      draft: null,
      help: null
    };
  }

  const selectedText = markdown.slice(selectedRange.start, selectedRange.end);
  const anchorContext = createAnchorContextFromMarkdownRange(
    markdown,
    selectedRange
  );

  if (!anchorContext) {
    return {
      draft: null,
      help: SHORT_SELECTION_HELP
    };
  }

  return {
    draft: {
      anchorSource: "markdown",
      anchorContext,
      markdownEndOffset: selectedRange.end,
      markdownStartOffset: selectedRange.start,
      selectedText
    },
    help: null
  };
}

function createVisualSelectionDraftResult({
  container,
  markdown
}: {
  container: HTMLElement | null;
  markdown: string;
}): SelectedCommentAnchorDraftResult {
  const snapshot = getBrowserSelectionSnapshotWithin(container);

  if (!snapshot) {
    return {
      draft: null,
      help: null
    };
  }

  const anchorContext = createAnchorContextFromVisualSnapshot(snapshot, markdown);

  if (!anchorContext) {
    return {
      draft: null,
      help: SHORT_SELECTION_HELP
    };
  }

  const selectedOffsets = findSelectedMarkdownOffsetsFromAnchorContext(
    anchorContext,
    snapshot.selectedText
  );
  const selectedTextMatches = findExactTextMatches(markdown, snapshot.selectedText);
  const uniqueSelectedTextMatch =
    selectedTextMatches.length === 1 ? selectedTextMatches[0] : null;

  return {
    draft: {
      anchorSource: "visual",
      anchorContext,
      markdownEndOffset: selectedOffsets?.end ?? uniqueSelectedTextMatch?.end,
      markdownStartOffset: selectedOffsets?.start ?? uniqueSelectedTextMatch?.start,
      selectedText: snapshot.selectedText
    },
    help: null
  };
}

function getBrowserSelectionSnapshotWithin(
  container: HTMLElement | null
): VisualSelectionSnapshot | null {
  if (!container || typeof window === "undefined") {
    return null;
  }

  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const { anchorNode, focusNode } = selection;

  if (
    !anchorNode ||
    !focusNode ||
    !container.contains(anchorNode) ||
    !container.contains(focusNode)
  ) {
    return null;
  }

  const selectedText = normalizeDomText(selection.toString());

  if (!selectedText) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const blockElement =
    commonAncestor?.closest(
      "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6, pre, code"
    ) ?? null;
  const blockText = normalizeDomText(blockElement?.textContent ?? selectedText);
  const selectedRangeInBlock = blockElement
    ? getSelectionOffsetsInsideElement(blockElement, range, selectedText)
    : null;

  return {
    blockText,
    blockKind: getVisualAnchorContextKind(blockElement),
    selectedEndInBlock: selectedRangeInBlock?.end,
    selectedStartInBlock: selectedRangeInBlock?.start,
    selectedText
  };
}

function createAnchorContextFromMarkdownRange(
  markdown: string,
  selectedRange: { end: number; start: number }
): PatchmarkSelectedTextAnchorContext | null {
  const blockRange = getMarkdownBlockRange(markdown, selectedRange);
  const trimmedBlockRange = trimRange(markdown, blockRange.start, blockRange.end);
  const blockText = markdown.slice(trimmedBlockRange.start, trimmedBlockRange.end);
  const blockKind = getMarkdownAnchorContextKind(blockText);
  const sentenceRange = getSentenceRangeWithinText(
    markdown.slice(blockRange.start, blockRange.end),
    selectedRange.start - blockRange.start,
    selectedRange.end - blockRange.start
  );

  if (sentenceRange && blockKind === "paragraph") {
    const absoluteSentenceRange = trimRange(
      markdown,
      blockRange.start + sentenceRange.start,
      blockRange.start + sentenceRange.end
    );

    return createAnchorContextFromMarkdownContextRange({
      kind: "sentence",
      markdown,
      contextRange: absoluteSentenceRange,
      selectedRange
    });
  }

  if (!blockText.trim()) {
    return null;
  }

  return createAnchorContextFromMarkdownContextRange({
    kind: blockKind,
    markdown,
    contextRange: trimmedBlockRange,
    selectedRange
  });
}

function createAnchorContextFromMarkdownContextRange({
  contextRange,
  kind,
  markdown,
  selectedRange
}: {
  contextRange: { end: number; start: number };
  kind: PatchmarkSelectedTextAnchorContextKind;
  markdown: string;
  selectedRange: { end: number; start: number };
}): PatchmarkSelectedTextAnchorContext {
  const markdownText = markdown.slice(contextRange.start, contextRange.end);

  return {
    kind,
    plain_text: normalizeDomText(markdownText),
    markdown_text: markdownText,
    selected_start_in_context: Math.max(0, selectedRange.start - contextRange.start),
    selected_end_in_context: Math.max(0, selectedRange.end - contextRange.start),
    markdown_start_offset: contextRange.start,
    markdown_end_offset: contextRange.end
  };
}

function createAnchorContextFromVisualSnapshot(
  snapshot: VisualSelectionSnapshot,
  markdown: string
): PatchmarkSelectedTextAnchorContext | null {
  if (!snapshot.blockText.trim()) {
    return null;
  }

  const exactContextMatches = findExactTextMatches(markdown, snapshot.blockText);
  const markdownPlainContextMatches = findMarkdownPlainTextMatches(
    markdown,
    snapshot.blockText
  );
  const contextMatches = dedupeTextMatches([
    ...exactContextMatches,
    ...markdownPlainContextMatches
  ]);
  const uniqueContextMatch = contextMatches.length === 1 ? contextMatches[0] : null;

  return {
    kind: snapshot.blockKind,
    plain_text: snapshot.blockText,
    markdown_text: uniqueContextMatch
      ? markdown.slice(uniqueContextMatch.start, uniqueContextMatch.end)
      : undefined,
    selected_start_in_context: snapshot.selectedStartInBlock,
    selected_end_in_context: snapshot.selectedEndInBlock,
    markdown_start_offset: uniqueContextMatch?.start,
    markdown_end_offset: uniqueContextMatch?.end
  };
}

function findSelectedMarkdownOffsetsFromAnchorContext(
  anchorContext: PatchmarkSelectedTextAnchorContext,
  selectedText: string
): { end: number; start: number } | null {
  if (
    typeof anchorContext.markdown_start_offset === "number" &&
    typeof anchorContext.selected_start_in_context === "number" &&
    typeof anchorContext.selected_end_in_context === "number"
  ) {
    const start =
      anchorContext.markdown_start_offset + anchorContext.selected_start_in_context;
    const end =
      anchorContext.markdown_start_offset + anchorContext.selected_end_in_context;

    if (anchorContext.markdown_text?.slice(
      anchorContext.selected_start_in_context,
      anchorContext.selected_end_in_context
    ) === selectedText) {
      return { end, start };
    }
  }

  if (
    typeof anchorContext.markdown_start_offset !== "number" ||
    !anchorContext.markdown_text
  ) {
    return null;
  }

  const contextMatches = findExactTextMatches(
    anchorContext.markdown_text,
    selectedText
  );
  const uniqueContextMatch =
    contextMatches.length === 1 ? contextMatches[0] : null;

  return uniqueContextMatch
    ? {
        start: anchorContext.markdown_start_offset + uniqueContextMatch.start,
        end: anchorContext.markdown_start_offset + uniqueContextMatch.end
      }
    : null;
}

function getSelectionOffsetsInsideElement(
  element: Element,
  selectionRange: Range,
  selectedText: string
): { end: number; start: number } | null {
  const beforeSelectionRange = document.createRange();
  beforeSelectionRange.selectNodeContents(element);
  beforeSelectionRange.setEnd(
    selectionRange.startContainer,
    selectionRange.startOffset
  );

  const start = normalizeDomText(beforeSelectionRange.toString()).length;
  beforeSelectionRange.detach();

  const blockText = normalizeDomText(element.textContent ?? "");
  const directEnd = start + selectedText.length;

  if (blockText.slice(start, directEnd) === selectedText) {
    return {
      end: directEnd,
      start
    };
  }

  const selectedTextMatches = findExactTextMatches(blockText, selectedText);

  return selectedTextMatches.length === 1 ? selectedTextMatches[0] : null;
}

function getVisualAnchorContextKind(
  element: Element | null
): PatchmarkSelectedTextAnchorContextKind {
  if (!element) {
    return "block";
  }

  const tagName = element.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tagName)) {
    return "heading";
  }

  if (tagName === "li") {
    return "list_item";
  }

  if (tagName === "td" || tagName === "th") {
    return "table_cell";
  }

  if (tagName === "blockquote") {
    return "blockquote";
  }

  if (tagName === "p") {
    return "paragraph";
  }

  return "block";
}

function getMarkdownAnchorContextKind(
  markdownText: string
): PatchmarkSelectedTextAnchorContextKind {
  const trimmedMarkdown = markdownText.trim();

  if (/^#{1,6}\s+/.test(trimmedMarkdown)) {
    return "heading";
  }

  if (/^([-*+]\s+|\d+\.\s+)/.test(trimmedMarkdown)) {
    return "list_item";
  }

  if (/^\|.*\|$/.test(trimmedMarkdown)) {
    return "table_cell";
  }

  if (/^>/.test(trimmedMarkdown)) {
    return "blockquote";
  }

  return "paragraph";
}

function trimRange(
  text: string,
  start: number,
  end: number
): { end: number; start: number } {
  let nextStart = Math.max(0, Math.min(start, text.length));
  let nextEnd = Math.max(nextStart, Math.min(end, text.length));

  while (nextStart < nextEnd && /\s/.test(text[nextStart])) {
    nextStart += 1;
  }

  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) {
    nextEnd -= 1;
  }

  return {
    end: nextEnd,
    start: nextStart
  };
}

function getMarkdownBlockRange(
  markdown: string,
  range: { end: number; start: number }
): { end: number; start: number } {
  const beforeSelection = markdown.slice(0, range.start);
  const afterSelection = markdown.slice(range.end);
  const previousBlankLineIndex = beforeSelection.search(/\n\s*\n[^\n]*$/);
  const nextBlankLineMatch = /\n\s*\n/.exec(afterSelection);
  const start =
    previousBlankLineIndex === -1
      ? 0
      : beforeSelection.lastIndexOf("\n", previousBlankLineIndex) + 1;
  const end = nextBlankLineMatch
    ? range.end + nextBlankLineMatch.index
    : markdown.length;

  return {
    end,
    start
  };
}

function getSentenceRangeWithinText(
  text: string,
  selectionStart: number,
  selectionEnd: number
): { end: number; start: number } | null {
  const safeStart = Math.max(0, Math.min(selectionStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, text.length));
  let sentenceStart = 0;
  let sentenceEnd = text.length;

  for (let index = safeStart - 1; index >= 0; index -= 1) {
    if (/[.!?]/.test(text[index])) {
      sentenceStart = index + 1;
      break;
    }
  }

  for (let index = safeEnd; index < text.length; index += 1) {
    if (/[.!?]/.test(text[index])) {
      sentenceEnd = index + 1;
      break;
    }
  }

  const trimmedRange = trimRange(text, sentenceStart, sentenceEnd);

  return trimmedRange.end > trimmedRange.start ? trimmedRange : null;
}

function isToolbarContextMenuTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest(".mdxeditor-toolbar"));
}

function measureCommentPositions({
  comments,
  container,
  headings,
  markdown,
  mode,
  workspace
}: CommentPositionMeasurementInput): Record<string, number> {
  if (!container || !workspace || comments.length === 0) {
    return {};
  }

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = container.getBoundingClientRect();
  const editorTop = Math.max(0, editorRect.top - workspaceRect.top);
  const preferredPositions: Record<string, number> = {};

  for (const comment of comments) {
    const top = computeCommentPreferredTop({
      comment,
      container,
      editorTop,
      headings,
      markdown,
      mode,
      workspaceRect
    });

    if (top !== null) {
      preferredPositions[comment.id] = top;
    }
  }

  return preferredPositions;
}

function computeCommentPreferredTop({
  comment,
  container,
  editorTop,
  headings,
  markdown,
  mode,
  workspaceRect
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  editorTop: number;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  workspaceRect: DOMRect;
}): number | null {
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return 0;
  }

  if (anchor.kind === "section") {
    const currentHeading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!currentHeading) {
      return null;
    }

    if (mode === "visual") {
      return (
        findVisualHeadingTop({
          container,
          heading: currentHeading,
          workspaceRect
        }) ?? estimateTopForLine(currentHeading.line, editorTop)
      );
    }

    return estimateTopForLine(currentHeading.line, editorTop);
  }

  const resolution = resolveCommentAnchor(comment, markdown, headings);

  if (resolution.status === "ambiguous") {
    return null;
  }

  if (resolution.status === "active" && resolution.start !== undefined) {
    if (mode === "visual") {
      const visualTextTop = findVisualSelectedTextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualTextTop !== null) {
        return visualTextTop;
      }

      const visualContextTop = findVisualAnchorContextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualContextTop !== null) {
        return visualContextTop;
      }

      const fallbackHeading = anchor.containing_heading
        ? findMatchingHeading(headings, {
            level: anchor.containing_heading_level,
            text: anchor.containing_heading
          })
        : null;
      const fallbackVisualTop = fallbackHeading
        ? findVisualHeadingTop({
            container,
            heading: fallbackHeading,
            workspaceRect
          })
        : null;

      return fallbackVisualTop;
    }

    return estimateTopForOffset(markdown, resolution.start, editorTop);
  }

  if (resolution.contextStart !== undefined) {
    if (mode === "visual") {
      const visualContextTop = findVisualAnchorContextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualContextTop !== null) {
        return visualContextTop;
      }
    }

    return estimateTopForOffset(markdown, resolution.contextStart, editorTop);
  }

  if (resolution.fallbackStart !== undefined) {
    if (mode === "visual") {
      const fallbackHeading = anchor.containing_heading
        ? findMatchingHeading(headings, {
            level: anchor.containing_heading_level,
            text: anchor.containing_heading
          })
        : null;
      const fallbackVisualTop = fallbackHeading
        ? findVisualHeadingTop({
            container,
            heading: fallbackHeading,
            workspaceRect
          })
        : null;

      if (fallbackVisualTop !== null) {
        return fallbackVisualTop;
      }
    }

    return estimateTopForOffset(markdown, resolution.fallbackStart, editorTop);
  }

  return null;
}

function areCommentPositionsEqual(
  firstPositions: Record<string, number>,
  secondPositions: Record<string, number>
): boolean {
  const firstIds = Object.keys(firstPositions);
  const secondIds = Object.keys(secondPositions);

  if (firstIds.length !== secondIds.length) {
    return false;
  }

  return firstIds.every(
    (commentId) => firstPositions[commentId] === secondPositions[commentId]
  );
}

function findVisualHeadingForPoint({
  container,
  headings,
  pointY
}: {
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  pointY: number;
}): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  if (!container) {
    return undefined;
  }

  const headingElements = getVisualHeadingElements(container);
  let nearestHeadingText = "";

  for (const headingElement of headingElements) {
    if (headingElement.getBoundingClientRect().top > pointY) {
      break;
    }

    nearestHeadingText = normalizeDomText(headingElement.textContent ?? "");
  }

  if (!nearestHeadingText) {
    return undefined;
  }

  return headings.find((heading) => heading.text === nearestHeadingText);
}

function findVisualHeadingTop({
  container,
  heading,
  workspaceRect
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
  workspaceRect: DOMRect;
}): number | null {
  const headingElement = getVisualHeadingElements(container).find(
    (element) => normalizeDomText(element.textContent ?? "") === heading.text
  );

  if (!headingElement) {
    return null;
  }

  return Math.max(0, headingElement.getBoundingClientRect().top - workspaceRect.top);
}

function findVisualHeadingRange({
  container,
  heading
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
}): Range | null {
  const headingElement = getVisualHeadingElements(container).find(
    (element) => normalizeDomText(element.textContent ?? "") === heading.text
  );

  if (!headingElement) {
    return null;
  }

  const range = document.createRange();
  range.selectNodeContents(headingElement);

  return range;
}

function findVisualSelectedTextTop({
  anchor,
  container,
  workspaceRect
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>;
  container: HTMLElement;
  workspaceRect: DOMRect;
}): number | null {
  const visualMatch = findUniqueVisualSelectedTextMatch({ anchor, container });

  return visualMatch ? Math.max(0, visualMatch.top - workspaceRect.top) : null;
}

function findVisualSelectedTextTopForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    const selectedMatch = findVisualSelectedTextMatchInsideResolvedContext({
      anchor,
      container,
      contextMatch,
      markdown,
      resolution
    });

    if (selectedMatch) {
      return Math.max(0, selectedMatch.top - workspaceRect.top);
    }

    return Math.max(0, contextMatch.top - workspaceRect.top);
  }

  return findVisualSelectedTextTop({ anchor, container, workspaceRect });
}

function findVisualAnchorContextTop({
  anchor,
  container,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findUniqueVisualAnchorContextMatch({ anchor, container });

  return contextMatch ? Math.max(0, contextMatch.top - workspaceRect.top) : null;
}

function findVisualAnchorContextTopForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    return Math.max(0, contextMatch.top - workspaceRect.top);
  }

  return findVisualAnchorContextTop({ anchor, container, workspaceRect });
}

function findUniqueVisualSelectedTextMatch({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch | null {
  const selectedMatches = findVisualTextMatches({
    container,
    searchText: anchor.selected_text
  });
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  if (contextMatches.length === 1) {
    const selectedMatchesInsideContext = selectedMatches.filter((match) =>
      isRangeInsideRange(match.range, contextMatches[0].range)
    );

    if (selectedMatchesInsideContext.length === 1) {
      return selectedMatchesInsideContext[0];
    }

    return null;
  }

  if (contextMatches.length > 1) {
    return null;
  }

  return selectedMatches.length === 1 ? selectedMatches[0] : null;
}

function findVisualSelectedTextMatchInsideResolvedContext({
  anchor,
  container,
  contextMatch,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  contextMatch: VisualTextMatch;
  markdown: string;
  resolution: CommentAnchorResolution;
}): VisualTextMatch | null {
  const selectedMatchesInsideContext = findVisualTextMatches({
    container,
    searchText: anchor.selected_text
  }).filter((match) => isRangeInsideRange(match.range, contextMatch.range));

  if (selectedMatchesInsideContext.length <= 1) {
    return selectedMatchesInsideContext[0] ?? null;
  }

  const selectedOrdinal = getSelectedTextOrdinalInsideResolvedContext({
    anchor,
    markdown,
    resolution
  });

  return typeof selectedOrdinal === "number"
    ? selectedMatchesInsideContext[selectedOrdinal] ?? null
    : null;
}

function findVisualAnchorContextMatchForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
}): VisualTextMatch | null {
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  if (contextMatches.length <= 1) {
    return contextMatches[0] ?? null;
  }

  const contextOrdinal = getAnchorContextOrdinalForResolution({
    anchor,
    markdown,
    resolution
  });

  return typeof contextOrdinal === "number"
    ? contextMatches[contextOrdinal] ?? null
    : null;
}

function getAnchorContextOrdinalForResolution({
  anchor,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  resolution: CommentAnchorResolution;
}): number | null {
  if (!anchor.anchor_context) {
    return null;
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);
  const resolvedContextStart =
    resolution.contextStart ??
    getContextStartContainingSelectedRange({
      contextMatches,
      selectedStart: resolution.start
    }) ??
    getStoredContextStartIfCurrent(markdown, anchor);

  if (typeof resolvedContextStart !== "number") {
    return null;
  }

  const contextOrdinal = contextMatches.findIndex(
    (match) => match.start === resolvedContextStart
  );

  return contextOrdinal >= 0 ? contextOrdinal : null;
}

function getSelectedTextOrdinalInsideResolvedContext({
  anchor,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  resolution: CommentAnchorResolution;
}): number | null {
  if (!anchor.anchor_context || typeof resolution.start !== "number") {
    return null;
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);
  const contextMatch = contextMatches.find(
    (match) =>
      resolution.start !== undefined &&
      resolution.start >= match.start &&
      resolution.start <= match.end
  );

  if (!contextMatch) {
    return null;
  }

  const selectedMatches = findSelectedTextMatchesInsideContext(
    markdown,
    contextMatch,
    anchor
  );
  const selectedOrdinal = selectedMatches.findIndex(
    (match) => match.start === resolution.start
  );

  return selectedOrdinal >= 0 ? selectedOrdinal : null;
}

function getContextStartContainingSelectedRange({
  contextMatches,
  selectedStart
}: {
  contextMatches: Array<{ end: number; start: number }>;
  selectedStart?: number;
}): number | null {
  if (typeof selectedStart !== "number") {
    return null;
  }

  return (
    contextMatches.find(
      (contextMatch) =>
        selectedStart >= contextMatch.start && selectedStart <= contextMatch.end
    )?.start ?? null
  );
}

function getStoredContextStartIfCurrent(
  markdown: string,
  anchor: SelectedTextAnchor
): number | null {
  const anchorContext = anchor.anchor_context;

  if (
    !anchorContext ||
    typeof anchorContext.markdown_start_offset !== "number" ||
    typeof anchorContext.markdown_end_offset !== "number" ||
    !anchorContext.markdown_text
  ) {
    return null;
  }

  return markdown.slice(
    anchorContext.markdown_start_offset,
    anchorContext.markdown_end_offset
  ) === anchorContext.markdown_text
    ? anchorContext.markdown_start_offset
    : null;
}

function findUniqueVisualAnchorContextMatch({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch | null {
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  return contextMatches.length === 1 ? contextMatches[0] : null;
}

function findVisualAnchorContextMatches({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch[] {
  if (!anchor.anchor_context?.plain_text) {
    return [];
  }

  const matches = findVisualTextMatches({
    container,
    searchText: anchor.anchor_context.plain_text
  });

  if (
    matches.length === 0 &&
    anchor.anchor_context.markdown_text &&
    anchor.anchor_context.markdown_text !== anchor.anchor_context.plain_text
  ) {
    return findVisualTextMatches({
      container,
      searchText: anchor.anchor_context.markdown_text
    });
  }

  return matches;
}

function isRangeInsideRange(range: Range, containingRange: Range): boolean {
  return (
    range.compareBoundaryPoints(Range.START_TO_START, containingRange) >= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, containingRange) <= 0
  );
}

function findVisualTextMatches({
  container,
  searchText
}: {
  container: HTMLElement;
  searchText: string;
}): VisualTextMatch[] {
  const trimmedSearchText = normalizeDomText(searchText);

  if (!trimmedSearchText) {
    return [];
  }

  const textIndex = buildVisualTextIndex(container);
  const matches: VisualTextMatch[] = [];
  let nextIndex = textIndex.text.indexOf(trimmedSearchText);

  while (nextIndex !== -1) {
    const range = createRangeFromVisualTextIndex(
      textIndex,
      nextIndex,
      nextIndex + trimmedSearchText.length
    );

    if (range) {
      const rect = range.getBoundingClientRect();

      if (rect.height > 0 || rect.width > 0) {
        matches.push({
          range,
          searchText: trimmedSearchText,
          top: Math.max(0, rect.top)
        });
      }
    }

    nextIndex = textIndex.text.indexOf(
      trimmedSearchText,
      nextIndex + trimmedSearchText.length
    );
  }

  return matches;
}

function buildVisualTextIndex(container: HTMLElement): VisualTextIndex {
  const root = getVisualSearchRoot(container);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      const parentElement = node.parentElement;

      if (
        parentElement?.closest(
          ".mdxeditor-toolbar, .comment-context-menu, script, style"
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textParts: string[] = [];
  const positions: VisualTextPosition[] = [];
  let currentNode = walker.nextNode() as Text | null;

  while (currentNode) {
    const nodeText = currentNode.textContent ?? "";

    for (let index = 0; index < nodeText.length; index += 1) {
      const character = nodeText[index];
      const isWhitespace = /\s/.test(character);
      const previousCharacter = textParts[textParts.length - 1];

      if (isWhitespace) {
        if (textParts.length > 0 && previousCharacter !== " ") {
          textParts.push(" ");
          positions.push({
            node: currentNode,
            offset: index
          });
        }
      } else {
        textParts.push(character);
        positions.push({
          node: currentNode,
          offset: index
        });
      }
    }

    currentNode = walker.nextNode() as Text | null;
  }

  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
  }

  return {
    positions,
    text: textParts.join("")
  };
}

function createRangeFromVisualTextIndex(
  textIndex: VisualTextIndex,
  start: number,
  end: number
): Range | null {
  const startPosition = textIndex.positions[start];
  const endPosition = textIndex.positions[end - 1];

  if (!startPosition || !endPosition) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);

  return range;
}

function getVisualHeadingElements(container: HTMLElement): HTMLElement[] {
  const root = getVisualSearchRoot(container);

  return Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
  );
}

function getVisualSearchRoot(container: HTMLElement): HTMLElement {
  return (
    container.querySelector<HTMLElement>(".patchmark-prose") ??
    container.querySelector<HTMLElement>(".visual-editor-fallback") ??
    container
  );
}

function findVisualCommentIdsAtPoint({
  clientX,
  clientY,
  comments,
  container,
  headings,
  markdown
}: {
  clientX: number;
  clientY: number;
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): string[] {
  if (!container) {
    return [];
  }

  return comments
    .filter((comment) => {
      const range = findVisualCommentAnchorRange({
        comment,
        container,
        headings,
        markdown
      });

      return range ? isPointInsideRangeClientRects(range, clientX, clientY) : false;
    })
    .map((comment) => comment.id);
}

function findVisualCommentAnchorRange({
  comment,
  container,
  headings,
  markdown
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): Range | null {
  const resolution = resolveCommentAnchor(comment, markdown, headings);

  if (resolution.status !== "active") {
    return null;
  }

  if (comment.anchor.kind === "document") {
    return null;
  }

  if (comment.anchor.kind === "section") {
    const currentHeading = findMatchingHeading(headings, {
      level: comment.anchor.heading_level,
      text: comment.anchor.heading
    });

    return currentHeading
      ? findVisualHeadingRange({ container, heading: currentHeading })
      : null;
  }

  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor: comment.anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    return (
      findVisualSelectedTextMatchInsideResolvedContext({
        anchor: comment.anchor,
        container,
        contextMatch,
        markdown,
        resolution
      })?.range ?? contextMatch.range
    );
  }

  return findUniqueVisualSelectedTextMatch({
    anchor: comment.anchor,
    container
  })?.range ?? null;
}

function isPointInsideRangeClientRects(
  range: Range,
  clientX: number,
  clientY: number
): boolean {
  return Array.from(range.getClientRects()).some(
    (rect) =>
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
  );
}

function updateVisualCommentHighlights({
  comments,
  container,
  headings,
  markdown,
  mode
}: {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
}): void {
  const highlightApi = getCssHighlightApi();

  if (!highlightApi) {
    return;
  }

  if (!container || mode !== "visual") {
    highlightApi.registry.delete(COMMENT_HIGHLIGHT_NAME);
    return;
  }

  const ranges: Range[] = [];

  for (const comment of comments) {
    const resolution = resolveCommentAnchor(comment, markdown, headings);

    if (resolution.status !== "active") {
      continue;
    }

    if (comment.anchor.kind === "document") {
      continue;
    }

    if (comment.anchor.kind === "section") {
      const currentHeading = findMatchingHeading(headings, {
        level: comment.anchor.heading_level,
        text: comment.anchor.heading
      });
      const range = currentHeading
        ? findVisualHeadingRange({
            container,
            heading: currentHeading
          })
        : null;

      if (range) {
        ranges.push(range);
      }

      continue;
    }

    const match = findUniqueVisualSelectedTextMatch({
      anchor: comment.anchor,
      container
    });

    if (match) {
      ranges.push(match.range);
    }
  }

  if (ranges.length === 0) {
    highlightApi.registry.delete(COMMENT_HIGHLIGHT_NAME);
    return;
  }

  highlightApi.registry.set(
    COMMENT_HIGHLIGHT_NAME,
    new highlightApi.Highlight(...ranges)
  );
}

function clearVisualCommentHighlights(): void {
  const highlightApi = getCssHighlightApi();

  highlightApi?.registry.delete(COMMENT_HIGHLIGHT_NAME);
}

function getCssHighlightApi():
  | { Highlight: CssHighlightConstructor; registry: CssHighlightRegistry }
  | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }

  const registry = (CSS as unknown as { highlights?: CssHighlightRegistry })
    .highlights;
  const HighlightConstructor = (
    window as unknown as { Highlight?: CssHighlightConstructor }
  ).Highlight;

  if (!registry || !HighlightConstructor) {
    return null;
  }

  return {
    Highlight: HighlightConstructor,
    registry
  };
}

function estimateTopForOffset(
  markdown: string,
  offset: number,
  editorTop: number
): number {
  const line = markdown.slice(0, offset).split(/\r?\n/).length;

  return estimateTopForLine(line, editorTop);
}

function estimateTopForLine(line: number, editorTop: number): number {
  return Math.max(0, editorTop + Math.max(0, line - 1) * 24);
}

function normalizeDomText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getHeadingPath(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  targetHeading: ReturnType<typeof parseMarkdownHeadings>[number]
): string[] {
  const path: ReturnType<typeof parseMarkdownHeadings> = [];

  for (const heading of headings) {
    while (path.length > 0 && path[path.length - 1].level >= heading.level) {
      path.pop();
    }

    path.push(heading);

    if (heading.line === targetHeading.line) {
      return path.map((pathHeading) => pathHeading.text);
    }
  }

  return [targetHeading.text];
}

type CommentAnchorResolution = CommentAnchorSummary & {
  contextEnd?: number;
  contextStart?: number;
  end?: number;
  fallbackEnd?: number;
  fallbackStart?: number;
  start?: number;
};

function createCommentAnchor({
  headings,
  markdown,
  selection,
  selectedDraft,
  values
}: {
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  selection: MarkdownSelection;
  selectedDraft: SelectedCommentAnchorDraft | null;
  values: CommentFormValues;
}): PatchmarkCommentAnchor {
  if (values.anchorScope === "document") {
    return {
      kind: "document",
      action_context: getDefaultCommentActionContext(values.type, "document")
    };
  }

  if (values.anchorScope === "section") {
    const targetHeading = values.targetHeadingLine
      ? headings.find((heading) => heading.line === values.targetHeadingLine)
      : undefined;

    if (!targetHeading) {
      throw new Error("Choose a target section.");
    }

    const sectionRange = getSectionRange(markdown, headings, targetHeading);

    return {
      kind: "section",
      heading: targetHeading.text,
      heading_level: targetHeading.level,
      heading_line: targetHeading.line,
      heading_path: getHeadingPath(headings, targetHeading),
      section_start_offset: sectionRange.start,
      section_end_offset: sectionRange.end,
      action_context: getDefaultCommentActionContext(values.type, "section")
    };
  }

  const usableSelectedDraft =
    selectedDraft ?? createMarkdownSelectionDraft(markdown, selection);
  const selectedText =
    usableSelectedDraft?.selectedText ??
    markdown.slice(selection.start, selection.end);

  if (!selectedText.trim()) {
    throw new Error("Select text in the editor before saving this comment.");
  }

  if (!usableSelectedDraft?.anchorContext) {
    throw new Error(SHORT_SELECTION_HELP);
  }

  const markdownStartOffset = usableSelectedDraft
    ? usableSelectedDraft.markdownStartOffset
    : selection.start;
  const markdownEndOffset = usableSelectedDraft
    ? usableSelectedDraft.markdownEndOffset
    : selection.end;
  const contextStartOffset =
    usableSelectedDraft.anchorContext.markdown_start_offset;
  const contextEndOffset = usableSelectedDraft.anchorContext.markdown_end_offset;
  const containingHeadingFromSelection =
    typeof markdownStartOffset === "number"
      ? getHeadingContainingOffset(markdown, headings, markdownStartOffset)
      : undefined;
  const containingHeadingFromContext =
    typeof contextStartOffset === "number"
      ? getHeadingContainingOffset(markdown, headings, contextStartOffset)
      : undefined;
  const containingHeadingFromForm = values.targetHeadingLine
    ? headings.find((heading) => heading.line === values.targetHeadingLine)
    : undefined;

  const containingHeading =
    containingHeadingFromSelection ??
    containingHeadingFromContext ??
    containingHeadingFromForm;
  const fallbackSectionRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : null;
  const contextBeforeStart = markdownStartOffset ?? contextStartOffset;
  const contextAfterEnd = markdownEndOffset ?? contextEndOffset;

  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: usableSelectedDraft.anchorContext,
    markdown_start_offset: markdownStartOffset,
    markdown_end_offset: markdownEndOffset,
    context_before:
      typeof contextBeforeStart !== "number"
        ? undefined
        : markdown.slice(
            Math.max(0, contextBeforeStart - ANCHOR_CONTEXT_CHARS),
            contextBeforeStart
          ),
    context_after:
      typeof contextAfterEnd !== "number"
        ? undefined
        : markdown.slice(
            contextAfterEnd,
            Math.min(markdown.length, contextAfterEnd + ANCHOR_CONTEXT_CHARS)
          ),
    containing_heading: containingHeading?.text,
    containing_heading_level: containingHeading?.level,
    containing_heading_line: containingHeading?.line,
    containing_heading_path: containingHeading
      ? getHeadingPath(headings, containingHeading)
      : undefined,
    anchor_source: usableSelectedDraft.anchorSource,
    fallback_section_start_offset: fallbackSectionRange?.start,
    fallback_section_end_offset: fallbackSectionRange?.end,
    action_context: getDefaultCommentActionContext(values.type, "selected_text")
  };
}

function getDefaultCommentActionContext(
  commentType: PatchmarkCommentType,
  anchorKind: PatchmarkCommentAnchor["kind"]
): PatchmarkCommentActionContext {
  return anchorKind === "document"
      ? {
          default_scope: "full_document",
          include_document_brief: true,
          include_open_comments: "focused_only",
          intent_hint: getActionIntentForCommentType(commentType)
        }
    : {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: getActionIntentForCommentType(commentType)
      };
}

function refreshCommentAnchorActionContext(
  anchor: PatchmarkCommentAnchor,
  commentType: PatchmarkCommentType
): PatchmarkCommentAnchor {
  return {
    ...anchor,
    action_context: {
      ...getDefaultCommentActionContext(commentType, anchor.kind),
      ...anchor.action_context,
      intent_hint: getActionIntentForCommentType(commentType)
    }
  };
}

function getActionIntentForCommentType(
  commentType: PatchmarkCommentType
): PatchmarkCommentActionIntent {
  if (commentType === "question" || commentType === "decision_needed") {
    return "decision";
  }

  if (commentType === "risk") {
    return "risk_review";
  }

  if (commentType === "research_needed") {
    return "research";
  }

  return "note";
}

function getCommentAnchorSummary(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CommentAnchorSummary {
  const resolution = resolveCommentAnchor(comment, markdown, headings);

  return {
    detail: resolution.detail,
    label: resolution.label,
    status: resolution.status
  };
}

function getLatestNeedsReviewPatchImpact(
  comment: PatchmarkComment
): PatchmarkCommentPatchImpact | null {
  const latestImpact = comment.patch_impacts?.at(-1);

  return latestImpact?.result === "needs_review" ? latestImpact : null;
}

function resolveCommentAnchor(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CommentAnchorResolution {
  const { anchor } = comment;
  const latestNeedsReviewImpact = getLatestNeedsReviewPatchImpact(comment);

  if (anchor.kind === "document") {
    return {
      label: "Whole document",
      status: "document"
    };
  }

  if (anchor.kind === "section") {
    const currentHeading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!currentHeading) {
      return {
        label: "Whole section: Target section not found",
        status: "not_found"
      };
    }

    const lineRange = getHeadingLineRange(markdown, currentHeading);

    return {
      end: lineRange.end,
      label: `Whole section: ${"#".repeat(currentHeading.level)} ${
        currentHeading.text
      }`,
      start: lineRange.start,
      status: "active"
    };
  }

  const offsetStart = anchor.markdown_start_offset;
  const offsetEnd = anchor.markdown_end_offset;

  if (
    typeof offsetStart === "number" &&
    typeof offsetEnd === "number" &&
    markdown.slice(offsetStart, offsetEnd) === anchor.selected_text
  ) {
    return {
      end: offsetEnd,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: offsetStart,
      status: "active"
    };
  }

  const contextResolution = resolveSelectedAnchorViaContext(markdown, anchor);

  if (contextResolution.status === "active") {
    return {
      contextEnd: contextResolution.contextEnd,
      contextStart: contextResolution.contextStart,
      end: contextResolution.end,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: contextResolution.start,
      status: "active"
    };
  }

  if (contextResolution.status === "ambiguous") {
    return {
      detail: "Could not identify a unique surrounding context.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "ambiguous"
    };
  }

  if (contextResolution.status === "context_found") {
    return {
      contextEnd: contextResolution.contextEnd,
      contextStart: contextResolution.contextStart,
      detail: "Exact selected text not found, surrounding context still exists.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "not_found"
    };
  }

  let matches = findExactTextMatches(markdown, anchor.selected_text);

  if (!anchor.anchor_context && matches.length > 1) {
    matches = filterMatchesByStoredContext(markdown, matches, anchor);
  }

  if (matches.length === 1) {
    return {
      end: matches[0].end,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: matches[0].start,
      status: "active"
    };
  }

  if (matches.length > 1) {
    return {
      detail: anchor.anchor_context
        ? "Could not identify a unique surrounding context."
        : "Multiple matches for selected text.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "ambiguous"
    };
  }

  const recoveredAnchor = recoverSelectedTextAnchor({
    comment,
    headings,
    markdown,
    preferredHeadingText: anchor.containing_heading
  });

  if (recoveredAnchor.status === "recovered") {
    return {
      end: recoveredAnchor.matchEnd,
      label: `Selected text in ${getSelectedTextHeadingLabel(
        recoveredAnchor.newAnchor
      )}`,
      start: recoveredAnchor.matchStart,
      status: "active"
    };
  }

  if (recoveredAnchor.status === "ambiguous") {
    return {
      detail: recoveredAnchor.reason,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "ambiguous"
    };
  }

  if (latestNeedsReviewImpact) {
    return {
      detail: `Affected by ${latestNeedsReviewImpact.patch_id}. Please review this anchor.`,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "not_found"
    };
  }

  const fallbackHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : null;

  if (fallbackHeading) {
    const lineRange = getHeadingLineRange(markdown, fallbackHeading);

    return {
      detail: "Text not found, section still exists.",
      fallbackEnd: lineRange.end,
      fallbackStart: lineRange.start,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "not_found"
    };
  }

  return {
    detail: "Anchor not found. The text may have changed.",
    label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
    status: "not_found"
  };
}

type SelectedAnchorContextResolution =
  | {
      contextEnd: number;
      contextStart: number;
      end: number;
      start: number;
      status: "active";
    }
  | {
      status: "ambiguous";
    }
  | {
      contextEnd: number;
      contextStart: number;
      status: "context_found";
    }
  | {
      status: "not_found";
    };

function resolveSelectedAnchorViaContext(
  markdown: string,
  anchor: SelectedTextAnchor
): SelectedAnchorContextResolution {
  if (!anchor.anchor_context) {
    return {
      status: "not_found"
    };
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);

  if (contextMatches.length === 0) {
    return {
      status: "not_found"
    };
  }

  const selectedMatches = contextMatches.flatMap((contextMatch) =>
    findSelectedTextMatchesInsideContext(markdown, contextMatch, anchor)
  );

  if (selectedMatches.length === 1) {
    return {
      ...selectedMatches[0],
      status: "active"
    };
  }

  if (selectedMatches.length > 1 || contextMatches.length > 1) {
    return {
      status: "ambiguous"
    };
  }

  return {
    contextEnd: contextMatches[0].end,
    contextStart: contextMatches[0].start,
    status: "context_found"
  };
}

function findAnchorContextMatches(
  markdown: string,
  anchorContext: PatchmarkSelectedTextAnchorContext
): Array<{ end: number; start: number }> {
  const matches: Array<{ end: number; start: number }> = [];

  if (
    typeof anchorContext.markdown_start_offset === "number" &&
    typeof anchorContext.markdown_end_offset === "number" &&
    anchorContext.markdown_text &&
    markdown.slice(
      anchorContext.markdown_start_offset,
      anchorContext.markdown_end_offset
    ) === anchorContext.markdown_text
  ) {
    matches.push({
      start: anchorContext.markdown_start_offset,
      end: anchorContext.markdown_end_offset
    });
  }

  if (anchorContext.markdown_text) {
    matches.push(...findExactTextMatches(markdown, anchorContext.markdown_text));
  }

  if (
    anchorContext.plain_text &&
    anchorContext.plain_text !== anchorContext.markdown_text
  ) {
    matches.push(...findExactTextMatches(markdown, anchorContext.plain_text));
    matches.push(...findNormalizedTextMatches(markdown, anchorContext.plain_text));
    matches.push(...findMarkdownPlainTextMatches(markdown, anchorContext.plain_text));
  }

  return dedupeTextMatches(matches);
}

function findSelectedTextMatchesInsideContext(
  markdown: string,
  contextMatch: { end: number; start: number },
  anchor: SelectedTextAnchor
): Array<{ contextEnd: number; contextStart: number; end: number; start: number }> {
  const contextText = markdown.slice(contextMatch.start, contextMatch.end);
  const directStart = anchor.anchor_context?.selected_start_in_context;
  const directEnd = anchor.anchor_context?.selected_end_in_context;

  if (
    typeof directStart === "number" &&
    typeof directEnd === "number" &&
    contextText.slice(directStart, directEnd) === anchor.selected_text
  ) {
    return [
      {
        contextEnd: contextMatch.end,
        contextStart: contextMatch.start,
        end: contextMatch.start + directEnd,
        start: contextMatch.start + directStart
      }
    ];
  }

  return findExactTextMatches(contextText, anchor.selected_text).map((match) => ({
    contextEnd: contextMatch.end,
    contextStart: contextMatch.start,
    end: contextMatch.start + match.end,
    start: contextMatch.start + match.start
  }));
}

function filterMatchesByStoredContext(
  markdown: string,
  matches: Array<{ end: number; start: number }>,
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): Array<{ end: number; start: number }> {
  const contextBefore = anchor.context_before ?? "";
  const contextAfter = anchor.context_after ?? "";

  if (!contextBefore && !contextAfter) {
    return matches;
  }

  const contextMatches = matches.filter((match) => {
    const beforeWindow = markdown.slice(
      Math.max(0, match.start - contextBefore.length),
      match.start
    );
    const afterWindow = markdown.slice(
      match.end,
      Math.min(markdown.length, match.end + contextAfter.length)
    );
    const beforeMatches = !contextBefore || beforeWindow === contextBefore;
    const afterMatches = !contextAfter || afterWindow === contextAfter;

    return beforeMatches && afterMatches;
  });

  return contextMatches.length > 0 ? contextMatches : matches;
}

function getSelectedTextHeadingLabel(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): string {
  if (!anchor.containing_heading) {
    return "document";
  }

  return `${"#".repeat(anchor.containing_heading_level ?? 1)} ${
    anchor.containing_heading
  }`;
}

function findExactTextMatches(
  markdown: string,
  selectedText: string
): Array<{ end: number; start: number }> {
  if (!selectedText) {
    return [];
  }

  const matches: Array<{ end: number; start: number }> = [];
  let nextIndex = markdown.indexOf(selectedText);

  while (nextIndex !== -1) {
    matches.push({
      end: nextIndex + selectedText.length,
      start: nextIndex
    });
    nextIndex = markdown.indexOf(selectedText, nextIndex + selectedText.length);
  }

  return matches;
}

function findNormalizedTextMatches(
  text: string,
  searchText: string
): Array<{ end: number; start: number }> {
  const textIndex = buildNormalizedSourceTextIndex(text);
  const normalizedSearchText = normalizeDomText(searchText);
  const matches: Array<{ end: number; start: number }> = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

function findMarkdownPlainTextMatches(
  markdown: string,
  searchText: string
): Array<{ end: number; start: number }> {
  const textIndex = buildMarkdownPlainTextIndex(markdown);
  const normalizedSearchText = normalizeDomText(searchText);
  const matches: Array<{ end: number; start: number }> = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

function buildMarkdownPlainTextIndex(markdown: string): {
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];
  const lines = markdown.split(/(\n)/);
  let markdownOffset = 0;

  for (const lineOrBreak of lines) {
    if (lineOrBreak === "\n") {
      appendNormalizedIndexedCharacter({
        character: " ",
        sourceOffset: markdownOffset,
        positions,
        textParts
      });
      markdownOffset += 1;
      continue;
    }

    const line = lineOrBreak;
    const prefixMatch = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.exec(line);
    let index = prefixMatch?.[0].length ?? 0;

    while (index < line.length) {
      const character = line[index];

      if (character === "(" && index > 0 && line[index - 1] === "]") {
        const closingIndex = line.indexOf(")", index);
        index = closingIndex === -1 ? line.length : closingIndex + 1;
        continue;
      }

      if (/[*_`\[\]\|\\]/.test(character)) {
        index += 1;
        continue;
      }

      appendNormalizedIndexedCharacter({
        character,
        sourceOffset: markdownOffset + index,
        positions,
        textParts
      });
      index += 1;
    }

    markdownOffset += line.length;
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
    positions,
    text: textParts.join("")
  };
}

function buildNormalizedSourceTextIndex(text: string): {
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    appendNormalizedIndexedCharacter({
      character: text[index],
      sourceOffset: index,
      positions,
      textParts
    });
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
    positions,
    text: textParts.join("")
  };
}

function appendNormalizedIndexedCharacter({
  character,
  positions,
  sourceOffset,
  textParts
}: {
  character: string;
  positions: number[];
  sourceOffset: number;
  textParts: string[];
}): void {
  const isWhitespace = /\s/.test(character);
  const previousCharacter = textParts[textParts.length - 1];

  if (isWhitespace) {
    if (textParts.length > 0 && previousCharacter !== " ") {
      textParts.push(" ");
      positions.push(sourceOffset);
    }

    return;
  }

  textParts.push(character);
  positions.push(sourceOffset);
}

function trimNormalizedTextIndex(
  textParts: string[],
  positions: number[]
): void {
  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
  }
}

function dedupeTextMatches(
  matches: Array<{ end: number; start: number }>
): Array<{ end: number; start: number }> {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getHeadingContainingOffset(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  offset: number
): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  const lineOffsets = getLineStartOffsets(markdown);
  let containingHeading: ReturnType<typeof parseMarkdownHeadings>[number] | undefined;

  for (const heading of headings) {
    const headingOffset = lineOffsets[heading.line - 1] ?? 0;

    if (headingOffset > offset) {
      break;
    }

    containingHeading = heading;
  }

  return containingHeading;
}

function findMatchingHeading(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  target: { level?: number; text: string }
) {
  return headings.find(
    (heading) =>
      heading.text === target.text &&
      (target.level === undefined || heading.level === target.level)
  );
}

function getSectionRange(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  targetHeading: ReturnType<typeof parseMarkdownHeadings>[number]
): { end: number; start: number } {
  const lineOffsets = getLineStartOffsets(markdown);
  const headingIndex = headings.findIndex(
    (heading) => heading.line === targetHeading.line
  );
  const nextPeerHeading = headings
    .slice(headingIndex + 1)
    .find((heading) => heading.level <= targetHeading.level);

  return {
    end: nextPeerHeading
      ? lineOffsets[nextPeerHeading.line - 1] ?? markdown.length
      : markdown.length,
    start: lineOffsets[targetHeading.line - 1] ?? 0
  };
}

function getHeadingLineRange(
  markdown: string,
  heading: ReturnType<typeof parseMarkdownHeadings>[number]
): { end: number; start: number } {
  const lineOffsets = getLineStartOffsets(markdown);
  const start = lineOffsets[heading.line - 1] ?? 0;
  const nextLineStart = lineOffsets[heading.line];

  return {
    end: nextLineStart ? Math.max(start, nextLineStart - 1) : markdown.length,
    start
  };
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

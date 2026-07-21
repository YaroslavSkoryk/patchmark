"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
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
  type CommentReplyRequest,
  type CommentFormValues
} from "@/components/comments-panel";
import { getLastKnownCommentAnchorPositionRange } from "@/lib/comments/comment-anchor-position";
import {
  appendConciseAnchorHistory,
  getHistoryPreviousAnchor
} from "@/lib/comments/comment-anchor-history";
import {
  cleanMarkdownHeadingText,
  getSelectedTextLocationLabel
} from "@/lib/comments/comment-card-display";
import {
  resolveCanonicalCommentTarget,
  type CanonicalTargetResolution
} from "@/lib/comments/canonical-target-resolution";
import {
  applyHumanReanchor,
  createDocumentHash,
  createHumanReanchorCandidates,
  createHumanReanchorProposal,
  expandMarkdownRangeForVisibleSelection,
  mapVisibleSelectionToMarkdownRange,
  type HumanReanchorCandidate,
  type HumanReanchorProposal
} from "@/lib/comments/comment-reanchor";
import {
  CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES,
  CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES
} from "@/lib/comments/chatgpt-prompt-rules";
import {
  classifyRangeAgainstEdit,
  deriveMarkdownChangeSet,
  deriveNativeMarkdownChangeSet,
  doesRangeIntersectEdit,
  isSafeManualAnchorTransformChangeSet,
  transformSelectedTextAnchorThroughEdit,
  transformSelectedTextAnchorThroughChangeSet,
  type AnchorEditRelationship,
  type AnchorTransformResult,
  type MarkdownChangeSet,
  type MarkdownEdit
} from "@/lib/comments/comment-anchor-transformation";
import {
  findChangedTableCellInPatchReplacement,
  findRetainedPatchOriginalTextInPatchReplacement,
  findRetainedSelectedTextInPatchReplacement,
  isSelectedAnchorEquivalentToPatchOriginalText
} from "@/lib/comments/comment-anchor-patch-mapping";
import { findUniqueCurrentTableRowForPatchOriginal } from "@/lib/comments/comment-anchor-table-row-recovery";
import {
  COMMENT_AFFORDANCE_MENU_SIZE,
  chooseSelectionAffordanceRect,
  createCommentAffordanceBounds,
  createPointAffordanceRect,
  placeCommentAffordance,
  toCommentAffordanceRect,
  type CommentAffordanceDirection,
  type CommentAffordanceRect
} from "@/lib/comments/comment-selection-affordance";
import {
  createVisualAnchorSearchTextCandidates,
  createVisualTableAnchorProjection,
  type VisualTableAnchorProjection
} from "@/lib/comments/comment-anchor-visual-projection";
import { editLatestUserReply } from "@/lib/comments/comment-thread-reply-edit";
import { DocumentActions } from "@/components/document-actions";
import { MarkdownFileLoader } from "@/components/markdown-file-loader";
import { LegacyProjectAssemblyDialog } from "@/components/legacy-project-assembly-dialog";
import { ProjectDocumentNavigator } from "@/components/project-document-navigator";
import {
  MarkdownSourceEditor,
  type MarkdownMutationHint,
  type MarkdownSelection
} from "@/components/markdown-source-editor";
import { DocumentOutline } from "@/components/document-outline";
import { DocumentStatus, type DocumentStatusKind } from "@/components/document-status";
import { DraftRestoreBanner } from "@/components/draft-restore-banner";
import { PdfExportPreview } from "@/components/pdf-export-preview";
import {
  SnapshotDialog,
  type SnapshotDialogState
} from "@/components/snapshot-dialog";
import { VersionHistoryPanel } from "@/components/version-history-panel";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";
import { downloadMarkdown } from "@/lib/files/download-markdown";
import {
  canSaveMarkdownFilePicker,
  openMarkdownFileWithPicker,
  saveMarkdownAsFile,
  saveMarkdownToFileHandle,
  type LoadedMarkdownFile,
  type MarkdownFileHandle
} from "@/lib/files/file-system-access";
import { parseMarkdownHeadings } from "@/lib/markdown/parse-headings";
import {
  createReadingBookmarkAnchorAdapter,
  getDocumentReadingBookmark,
  removeDocumentReadingBookmark,
  resolveReadingBookmark,
  setDocumentReadingBookmark
} from "@/lib/reading-bookmarks/reading-bookmark";
import {
  createAppliedPatchReviewContent,
  createPatchReviewSnippetPreview,
  dedupePatchReviewTextMatches,
  getPatchReviewMatchCardinality,
  getPatchReviewMatchingLocationsLabel,
  getPatchReviewMatchMethodLabel,
  type AppliedPatchReviewContent,
  type AppliedPatchReviewMatchCardinality,
  type AppliedPatchReviewMatchMethod,
  type PatchReviewTextMatch,
  type AppliedPatchOriginalSource
} from "@/lib/patches/patch-review-content";
import {
  resolvePendingPatchTarget,
  type PendingPatchApplicability,
  type PendingPatchTargetMatchMethod
} from "@/lib/patches/linked-patch-target-resolution";
import {
  CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
  createCanonicalTableContextsFromOccurrences,
  getCompleteTableOccurrencesForExport,
  replaceCompleteTableOccurrencesWithMarkers,
  validateAtomicTablePatchImport,
  type CanonicalTableContext
} from "@/lib/patches/atomic-table-patches";
import { getDeterministicAppliedPatchOffsetMatch } from "@/lib/patches/applied-patch-anchor";
import {
  getPatchDisplayTitle,
  getPatchDisplayTitleInfo,
  getPatchGroupDisplayTitle,
  normalizePatchDisplayTitleCandidate
} from "@/lib/patches/patch-display-title";
import {
  createCommentPatchHistorySummary,
  createRelatedAcceptedPatchHistory,
  getContinuableLinkedComment,
  getPatchFollowUpRelationship,
  type PatchFollowUpRelationship
} from "@/lib/patches/comment-patch-history";
import {
  addExistingDocumentToProject,
  archiveProjectDocument,
  canOpenProjectFolder,
  convertProjectToMultiDocument,
  createProjectDocumentGroup,
  createProjectFromMarkdown,
  createNewProjectDocument,
  createProjectSnapshot,
  deleteProjectDocumentGroup,
  getActiveProjectDocument,
  getProjectDocumentIdentity,
  getProjectDocumentList,
  getProjectDocumentGroups,
  getProjectDocumentExportIdentity,
  getProjectDocumentScopeId,
  getProjectTitle,
  isMultiDocumentProject,
  listProjectVersions,
  locateProjectDocument,
  moveProjectDocument,
  moveProjectDocumentGroup,
  moveProjectDocumentToGroup,
  openProjectFolder,
  openProjectDocument,
  readProjectVersionMarkdown,
  readProjectVersionMarkdownByRef,
  readProjectComments,
  readProjectPatches,
  resolveDocumentPathFromFileHandle,
  renameProjectDocumentGroup,
  restoreProjectDocument,
  restoreProjectLastKnownGood,
  saveProjectState,
  switchProjectDocument,
  updateProjectManifestMetadata,
  writeProjectContextPack,
  writeProjectComments,
  writeProjectImport,
  writeProjectPatches,
  updateProjectDocumentMetadata,
  type LoadedPatchmarkProject,
  type PatchmarkProjectDocumentListItem,
  type PatchmarkProjectHandle,
  type PatchmarkProjectRecoveryState
} from "@/lib/project/patchmark-project";
import {
  createCommentRef,
  createDocumentScopedKey,
  createProjectDocumentIdentity,
  createProjectDocumentKey,
  createVersionRef,
  isDocumentScopeCurrent
} from "@/lib/project/document-scoped-identity";
import {
  type PatchmarkDocumentGroup,
  type PatchmarkDocumentRole
} from "@/lib/project/multi-document-project";
import {
  CHATGPT_IMPORT_REPAIR_PROMPT,
  CHATGPT_INTERNAL_CITATION_PROMPT_RULES,
  normalizeSourceChatUrl,
  parsePatchmarkCommentReplyImport
} from "@/lib/imports/patchmark-comment-reply-import";
import {
  type CommentAnchorStatus,
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
  type PatchmarkReadingBookmark,
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
import {
  incrementEditPerformanceCounter,
  markEditPerformanceOperation,
  markLatestEditPerformanceOperation,
  recordEditPerformanceDuration,
  startEditPerformanceOperation,
  updateEditPerformanceMetadata
} from "@/lib/performance/edit-performance";

type EditorMode = "visual" | "markdown";
type ReadingBookmarkNavigationRequest = {
  bookmark: PatchmarkReadingBookmark | null;
  documentKey: string;
  markdown: string;
  mode: EditorMode;
  patches: PatchmarkPatch[];
};
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
  affordanceRect?: CommentAffordanceRect | null;
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
type ReanchorSession = {
  candidates: HumanReanchorCandidate[];
  commentId: string;
  documentId: string;
  documentHash: string;
  documentVersion: number;
  error: string | null;
  previousActiveCommentState: ActiveCommentState;
  previousStatus: CommentAnchorStatus;
  previewProposal: HumanReanchorProposal | null;
};
type ChatGptPromptDialogState = {
  commentIds: string[];
  dedicatedDocumentReview: boolean;
  documentId: string;
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
  documentId: string;
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
type PatchApplicability = PendingPatchApplicability;
type AppliedPatchAnchorStatus =
  | "empty_applied_text"
  | "evolved_after_patch"
  | "exact_match"
  | "multiple_matches"
  | "normalized_match"
  | "not_found"
  | "row_match"
  | "section_match";
type TextMatch = PatchReviewTextMatch;
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
      matchCardinality: AppliedPatchReviewMatchCardinality;
      matchMethod: AppliedPatchReviewMatchMethod;
      matches: TextMatch[];
      status: AppliedPatchAnchorStatus;
      text: string;
    }
  | {
      applicability: PatchApplicability;
      kind: "historical" | "pending";
      matchMethod?: PendingPatchTargetMatchMethod;
      matches: TextMatch[];
      tableRowRebase?: PatchTableRowRebaseCandidate;
      text: string;
    };
type DocumentMutationSource =
  | "composition"
  | "cut"
  | "formatter"
  | "manual_source"
  | "manual_visual"
  | "move"
  | "patch_apply"
  | "paste"
  | "programmatic_sync"
  | "project_load"
  | "redo"
  | "snapshot_restore"
  | "undo";
type CommentMutationOutcome =
  | "deleted"
  | "recovery_required"
  | "transformed_active"
  | "transformed_needs_review"
  | "unaffected";
type CommentMutationImpact = {
  commentId: string;
  outcome: CommentMutationOutcome;
  patchImpactKind?: PatchCommentImpactKind;
  relationship?: AnchorEditRelationship | "section_may_have_shifted";
  validation: CommentAnchorResolution;
};
type DocumentMutationPatchContext = {
  linkedCommentId?: string;
  patch: PatchmarkPatch;
  replacementStart: number;
};
type DocumentMutationResult = {
  commentImpacts: CommentMutationImpact[];
  comments: PatchmarkComment[];
  linkedCommentFound: boolean;
  markdown: string;
  needsReviewCount: number;
  offsetShiftedCount: number;
  reanchoredCount: number;
  recoveryRequiredCommentIds: string[];
  transformedCommentIds: string[];
  unchangedCount: number;
  validationResults: Record<string, CommentAnchorResolution>;
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
type DocumentScopedActiveCommentState = {
  documentId: string;
  state: ActiveCommentState;
};
type CommentPositionMeasurementInput = {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  patches?: PatchmarkPatch[];
  workspace: HTMLElement | null;
};
type VisualSelectionSnapshot = {
  affordanceRect: CommentAffordanceRect | null;
  blockText: string;
  blockKind: PatchmarkSelectedTextAnchorContextKind;
  direction: CommentAffordanceDirection;
  selectedEndInBlock?: number;
  selectedStartInBlock?: number;
  selectedText: string;
};
type VisualTextMatch = {
  range: Range;
  searchText: string;
  top: number;
};
type VisualTargetProjection =
  | {
      commentId: string;
      markdownRange: { end: number; start: number };
      projectionMethod:
        | "plain_text_range"
        | "section_heading"
        | "source_blocks"
        | "source_position"
        | "structural_block"
        | "table_cell"
        | "table_row";
      state: "resolved";
      structuralElements: HTMLElement[];
      textRanges: Range[];
    }
  | {
      commentId: string;
      reason: string;
      state: "not_projectable";
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
const COMMENT_OPEN_SELECTED_HIGHLIGHT_NAME =
  "patchmark-comment-open-selected-anchor";
const COMMENT_RESOLVED_SELECTED_HIGHLIGHT_NAME =
  "patchmark-comment-resolved-selected-anchor";
const COMMENT_REANCHOR_PREVIEW_HIGHLIGHT_NAME =
  "patchmark-comment-reanchor-preview";
const READING_BOOKMARK_HIGHLIGHT_NAME = "patchmark-reading-bookmark-target";
const DOCUMENT_MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(https?:\/\/[^)]+\)/i;
const DOCUMENT_RAW_URL_PATTERN = /\bhttps?:\/\/\S+/i;
const visualTextIndexCache = new WeakMap<HTMLElement, VisualTextIndex>();
let cachedDocumentLineStartOffsets:
  | {
      markdown: string;
      offsets: number[];
    }
  | undefined;
const SOURCE_SECTION_HEADING_PATTERN = /\b(source notes|references)\b/i;
const EMPTY_DOCUMENT_GROUPS: PatchmarkDocumentGroup[] = [];

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
  const activeDocumentId = projectHandle
    ? getProjectDocumentScopeId(projectHandle)
    : null;
  const activeDocumentIdRef = useRef<string | null>(activeDocumentId);
  activeDocumentIdRef.current = activeDocumentId;
  const activeDocumentIdentity = useMemo(
    () => (projectHandle ? getProjectDocumentIdentity(projectHandle) : null),
    [projectHandle]
  );
  const activeDocumentKey = activeDocumentIdentity
    ? createProjectDocumentKey(activeDocumentIdentity)
    : null;
  const activeDocumentKeyRef = useRef<string | null>(activeDocumentKey);
  activeDocumentKeyRef.current = activeDocumentKey;
  const activeProjectIdRef = useRef<string | null>(
    activeDocumentIdentity?.projectId ?? null
  );
  activeProjectIdRef.current = activeDocumentIdentity?.projectId ?? null;
  const [projectRecovery, setProjectRecovery] =
    useState<PatchmarkProjectRecoveryState | null>(null);
  const [projectDocuments, setProjectDocuments] = useState<
    PatchmarkProjectDocumentListItem[]
  >([]);
  const [restoredMarkdown, setRestoredMarkdown] = useState<string | null>(null);
  const [availableDraft, setAvailableDraft] = useState<DocumentDraft | null>(null);
  const [mode, setMode] = useState<EditorMode>("visual");
  const modeRef = useRef<EditorMode>(mode);
  modeRef.current = mode;
  const [documentVersion, setDocumentVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [versionEntries, setVersionEntries] = useState<PatchmarkVersionEntry[]>(
    []
  );
  const [comments, setComments] = useState<PatchmarkComment[]>([]);
  const [patches, setPatches] = useState<PatchmarkPatch[]>([]);
  const [isProjectDataLoading, setIsProjectDataLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [isCommentBusy, setIsCommentBusy] = useState(false);
  const [readingBookmarkBusyDocumentKey, setReadingBookmarkBusyDocumentKey] =
    useState<string | null>(null);
  const [
    readingBookmarkEmphasizedDocumentKey,
    setReadingBookmarkEmphasizedDocumentKey
  ] = useState<string | null>(null);
  const [readingBookmarkPosition, setReadingBookmarkPosition] = useState<{
    documentKey: string;
    top: number;
  } | null>(null);
  const [readingBookmarkMenuDocumentKey, setReadingBookmarkMenuDocumentKey] =
    useState<string | null>(null);
  const readingBookmarkMarkerRef = useRef<HTMLButtonElement>(null);
  const readingBookmarkMenuRef = useRef<HTMLDivElement>(null);
  const readingBookmarkRemoveButtonRef = useRef<HTMLButtonElement>(null);
  const readingBookmarkEmphasisTimeoutRef = useRef<number | null>(null);
  const pendingReadingBookmarkNavigationRef = useRef<string | null>(null);
  const continueReadingAtBookmarkRef = useRef<
    ((request: ReadingBookmarkNavigationRequest) => Promise<void>) | null
  >(null);
  const documentSwitchRequestRef = useRef(0);
  const [documentActiveCommentState, setDocumentActiveCommentState] =
    useState<DocumentScopedActiveCommentState | null>(null);
  const activeCommentState = useMemo<ActiveCommentState>(
    () =>
      activeDocumentId &&
      documentActiveCommentState?.documentId === activeDocumentId
        ? documentActiveCommentState.state
        : { kind: "none" },
    [activeDocumentId, documentActiveCommentState]
  );
  const setActiveCommentState = useCallback(
    (
      nextState:
        | ActiveCommentState
        | ((currentState: ActiveCommentState) => ActiveCommentState)
    ) => {
      if (!activeDocumentId) {
        setDocumentActiveCommentState(null);
        return;
      }
      setDocumentActiveCommentState((current) => {
        const currentState =
          current?.documentId === activeDocumentId
            ? current.state
            : ({ kind: "none" } as ActiveCommentState);
        return {
          documentId: activeDocumentId,
          state:
            typeof nextState === "function"
              ? nextState(currentState)
              : nextState
        };
      });
    },
    [activeDocumentId]
  );
  const lastScrolledActiveCommentKeyRef = useRef<string | null>(null);
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
  const [commentReplyRequest, setCommentReplyRequest] =
    useState<CommentReplyRequest | null>(null);
  const [commentContextMenu, setCommentContextMenu] =
    useState<CommentContextMenuState | null>(null);
  const [reanchorSession, setReanchorSession] =
    useState<ReanchorSession | null>(null);
  const [reanchorConfirmation, setReanchorConfirmation] =
    useState<HumanReanchorProposal | null>(null);
  const [commentPositions, setCommentPositions] = useState<Record<string, number>>(
    {}
  );
  const [snapshotDialog, setSnapshotDialog] =
    useState<SnapshotDialogState | null>(null);
  const [pdfExportTarget, setPdfExportTarget] = useState<{
    documentId: string | null;
    fileName: string;
    markdown: string;
  } | null>(null);
  const [isLegacyProjectAssemblyOpen, setIsLegacyProjectAssemblyOpen] =
    useState(false);
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
  const [recentlyAppliedPatchId, setRecentlyAppliedPatchId] = useState<
    string | null
  >(null);
  const pendingEditPerformanceOperationIdRef = useRef<string | null>(null);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const deferredPatchReviewMarkdown = useDeferredValue(markdown);
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
    () => {
      const startedAt = performance.now();
      const summaries = Object.fromEntries(
        comments.map((comment) => [
          comment.id,
          getCommentAnchorSummary(comment, markdown, headings, patches)
        ])
      );
      recordEditPerformanceDuration(
        pendingEditPerformanceOperationIdRef.current,
        "comment_anchor_summaries",
        performance.now() - startedAt
      );
      return summaries;
    },
    [comments, headings, markdown, patches]
  );
  const commentsById = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments]
  );
  const pendingPatchCountsByCommentId = useMemo(
    () => getPendingPatchCountsByCommentId(patches),
    [patches]
  );
  const pendingPatches = useMemo(
    () => patches.filter((patch) => patch.status === "pending"),
    [patches]
  );
  const shouldResolvePatchGroupAnchors = Boolean(
    patchGroupListDialog ||
      patchReviewCommentScopeId ||
      patchReviewGroupScopeId ||
      selectedPatchGroupId ||
      selectedPatchId
  );
  const patchGroups = useMemo(
    () => {
      const startedAt = performance.now();
      const groups = derivePatchGroups(
        patches,
        deferredPatchReviewMarkdown,
        comments,
        shouldResolvePatchGroupAnchors
      );
      recordEditPerformanceDuration(
        pendingEditPerformanceOperationIdRef.current,
        "patch_group_derivation",
        performance.now() - startedAt
      );
      return groups;
    },
    [
      comments,
      deferredPatchReviewMarkdown,
      patches,
      shouldResolvePatchGroupAnchors
    ]
  );
  const pendingPatchGroups = useMemo(
    () =>
      patchGroups.filter((group) => group.status_summary.pending > 0),
    [patchGroups]
  );
  const patchGroupSummariesByCommentId = useMemo(
    () => getPatchGroupSummariesByCommentId(patchGroups, commentsById),
    [commentsById, patchGroups]
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
        ? commentsById.get(selectedPatchGroup.comment_id) ?? null
        : null,
    [commentsById, selectedPatchGroup]
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
        ? commentsById.get(selectedPatch.comment_id) ?? null
        : null,
    [commentsById, selectedPatch]
  );
  const selectedPatchAnchorStatus = useMemo(
    () =>
      selectedPatch
        ? getPatchReviewAnchorStatus(markdown, selectedPatch, patches, comments)
        : null,
    [comments, markdown, patches, selectedPatch]
  );
  const selectedPatchFollowUpRelationship = useMemo(
    () =>
      selectedPatch
        ? getPatchFollowUpRelationship({
            comment: selectedPatchComment,
            patch: selectedPatch,
            patches
          })
        : null,
    [patches, selectedPatch, selectedPatchComment]
  );
  const isDirty =
    fileName !== null &&
    (baselineMarkdown === null || markdown !== baselineMarkdown);
  const isSaving = saveStatus === "saving";
  const isProjectMode = projectHandle !== null;
  const isProjectRecoveryReadOnly =
    projectRecovery !== null && projectRecovery.kind !== "migration_rolled_back";
  const isReanchorMode = reanchorSession !== null;
  const documentStatus: DocumentStatusKind = getDocumentStatus({
    isDirty,
    markdown,
    restoredMarkdown,
    saveStatus
  });
  const readingBookmark = useMemo(
    () =>
      projectHandle && activeDocumentIdentity
        ? getDocumentReadingBookmark({
            document: activeDocumentIdentity,
            manifest: projectHandle.manifest
          })
        : null,
    [activeDocumentIdentity, projectHandle]
  );
  const readingBookmarkResolution = useMemo(
    () =>
      readingBookmark
        ? resolveReadingBookmark({ bookmark: readingBookmark, markdown, patches })
        : null,
    [markdown, patches, readingBookmark]
  );
  const isReadingBookmarkBusy =
    activeDocumentKey !== null &&
    readingBookmarkBusyDocumentKey === activeDocumentKey;
  const isReadingBookmarkEmphasized =
    activeDocumentKey !== null &&
    readingBookmarkEmphasizedDocumentKey === activeDocumentKey;
  const isReadingBookmarkMenuOpen =
    activeDocumentKey !== null &&
    readingBookmarkMenuDocumentKey === activeDocumentKey;
  const readingBookmarkMenuId = activeDocumentKey
    ? `reading-bookmark-action-menu-${encodeURIComponent(activeDocumentKey)}`
    : undefined;
  const projectGroups = projectHandle
    ? getProjectDocumentGroups(projectHandle)
    : EMPTY_DOCUMENT_GROUPS;
  const activeDocumentGroup = projectHandle?.document?.group_id
    ? projectGroups.find(
        (group) => group.group_id === projectHandle.document?.group_id
      ) ?? null
    : null;
  continueReadingAtBookmarkRef.current = continueReadingAtBookmark;

  useEffect(() => {
    setAvailableDraft(readMostRecentDocumentDraft());
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let firstNavigationFrameId: number | null = null;
    let secondNavigationFrameId: number | null = null;

    if (!projectHandle) {
      setIsProjectDataLoading(false);
      setProjectDocuments([]);
      setVersionEntries([]);
      setComments([]);
      setPatches([]);
      setDocumentActiveCommentState(null);
      setSelectedPatchId(null);
      setSelectedPatchGroupId(null);
      setPatchGroupListDialog(null);
      setPatchReviewCommentScopeId(null);
      setPatchReviewGroupScopeId(null);
      setCommentsError(null);
      return;
    }

    setIsProjectDataLoading(true);
    const documentDataPromise =
      projectHandle.documentAvailability === "missing"
        ? Promise.resolve([
            [],
            [],
            []
          ] as [PatchmarkVersionEntry[], PatchmarkComment[], PatchmarkPatch[]])
        : Promise.all([
            listProjectVersions(projectHandle),
            readProjectComments(projectHandle),
            readProjectPatches(projectHandle)
          ]);
    void Promise.all([
      getProjectDocumentList(projectHandle),
      documentDataPromise
    ])
      .then(([documents, [versions, projectComments, projectPatches]]) => {
        if (!isCancelled) {
          setProjectDocuments(documents);
          setVersionEntries(versions);
          setComments(projectComments);
          setPatches(projectPatches);
          setCommentsError(null);
          setIsProjectDataLoading(false);
          const loadedIdentity = getProjectDocumentIdentity(projectHandle);
          const loadedDocumentKey = createProjectDocumentKey(loadedIdentity);
          if (
            pendingReadingBookmarkNavigationRef.current === loadedDocumentKey
          ) {
            pendingReadingBookmarkNavigationRef.current = null;
            const loadedBookmark = getDocumentReadingBookmark({
              document: loadedIdentity,
              manifest: projectHandle.manifest
            });
            firstNavigationFrameId = window.requestAnimationFrame(() => {
              firstNavigationFrameId = null;
              secondNavigationFrameId = window.requestAnimationFrame(() => {
                secondNavigationFrameId = null;
                void continueReadingAtBookmarkRef.current?.({
                  bookmark: loadedBookmark,
                  documentKey: loadedDocumentKey,
                  markdown: projectHandle.persistence.documentText,
                  mode: modeRef.current,
                  patches: projectPatches
                });
              });
            });
          }
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setProjectDocuments([]);
          setComments([]);
          setPatches([]);
          setCommentsError(getProjectErrorMessage(error));
          setIsProjectDataLoading(false);
        }
      });

    return () => {
      isCancelled = true;
      if (firstNavigationFrameId !== null) {
        window.cancelAnimationFrame(firstNavigationFrameId);
      }
      if (secondNavigationFrameId !== null) {
        window.cancelAnimationFrame(secondNavigationFrameId);
      }
    };
  }, [projectHandle]);

  useEffect(
    () => () => {
      if (readingBookmarkEmphasisTimeoutRef.current !== null) {
        window.clearTimeout(readingBookmarkEmphasisTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const menuDocumentKey = readingBookmarkMenuDocumentKey;

    if (!menuDocumentKey || menuDocumentKey !== activeDocumentKey) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      if (activeDocumentKeyRef.current === menuDocumentKey) {
        readingBookmarkRemoveButtonRef.current?.focus();
      }
    });

    function closeReadingBookmarkMenu(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        (readingBookmarkMenuRef.current?.contains(event.target) ||
          readingBookmarkMarkerRef.current?.contains(event.target))
      ) {
        return;
      }

      setReadingBookmarkMenuDocumentKey((currentKey) =>
        currentKey === menuDocumentKey ? null : currentKey
      );
    }

    function handleReadingBookmarkMenuKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setReadingBookmarkMenuDocumentKey((currentKey) =>
        currentKey === menuDocumentKey ? null : currentKey
      );
      if (activeDocumentKeyRef.current === menuDocumentKey) {
        readingBookmarkMarkerRef.current?.focus();
      }
    }

    window.addEventListener("pointerdown", closeReadingBookmarkMenu);
    window.addEventListener("keydown", handleReadingBookmarkMenuKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closeReadingBookmarkMenu);
      window.removeEventListener("keydown", handleReadingBookmarkMenuKeyDown);
    };
  }, [activeDocumentKey, readingBookmarkMenuDocumentKey]);

  useEffect(() => {
    if (
      !activeDocumentKey ||
      readingBookmarkMenuDocumentKey !== activeDocumentKey ||
      !readingBookmark ||
      readingBookmarkPosition?.documentKey !== activeDocumentKey ||
      mode !== "visual"
    ) {
      setReadingBookmarkMenuDocumentKey((currentKey) =>
        currentKey === readingBookmarkMenuDocumentKey ? null : currentKey
      );
    }
  }, [
    activeDocumentKey,
    mode,
    readingBookmark,
    readingBookmarkMenuDocumentKey,
    readingBookmarkPosition
  ]);

  useEffect(() => {
    if (selectedPatchId && !patches.some((patch) => patch.id === selectedPatchId)) {
      setSelectedPatchId(null);
      setPatchReviewCommentScopeId(null);
      setPatchReviewGroupScopeId(null);
    }
  }, [patches, selectedPatchId]);

  useEffect(() => {
    if (!projectHandle || isSaving || isDirty || comments.length === 0) {
      return;
    }

    let isCancelled = false;
    const operationId = pendingEditPerformanceOperationIdRef.current;
    const runRecovery = () => {
      if (isCancelled) {
        return;
      }

      const recoveryStartedAt = performance.now();
      const recoveredComments = recoverPersistableStaleCommentAnchors({
        comments,
        headings,
        markdown,
        patches
      });
      recordEditPerformanceDuration(
        operationId,
        "background_comment_recovery",
        performance.now() - recoveryStartedAt
      );
      markEditPerformanceOperation(operationId, "background_recovery_settled");

      if (recoveredComments === comments || isCancelled) {
        markEditPerformanceOperation(
          operationId,
          "background_recovery_persisted"
        );
        return;
      }

      const persistenceStartedAt = performance.now();
      void writeProjectComments(projectHandle, recoveredComments, {
        allowSupersede: true,
        reason: "background_anchor_convergence"
      })
        .then((result) => {
          if (!isCancelled && result.status !== "superseded") {
            setComments(recoveredComments);
            recordEditPerformanceDuration(
              operationId,
              "background_recovery_persistence",
              performance.now() - persistenceStartedAt
            );
            markEditPerformanceOperation(
              operationId,
              "background_recovery_persisted"
            );
          }
        })
        .catch((error) => {
          if (!isCancelled) {
            setCommentsError(getProjectErrorMessage(error));
            markEditPerformanceOperation(
              operationId,
              "background_recovery_persisted"
            );
          }
        });
    };
    const idleCallbackId =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(runRecovery, { timeout: 250 })
        : null;
    const timeoutId =
      idleCallbackId === null ? window.setTimeout(runRecovery, 0) : null;

    return () => {
      isCancelled = true;

      if (idleCallbackId !== null) {
        window.cancelIdleCallback(idleCallbackId);
      }

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [comments, headings, isDirty, isSaving, markdown, patches, projectHandle]);

  useEffect(() => {
    if (!projectHandle || isSaving || isDirty || patches.length === 0) {
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

    void writeProjectPatches(projectHandle, recoveredPatches, {
      allowSupersede: true,
      reason: "background_patch_anchor_recovery"
    })
      .then((result) => {
        if (!isCancelled && result.status !== "superseded") {
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
  }, [isDirty, isSaving, markdown, patches, projectHandle]);

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
  }, [comments, setActiveCommentState]);

  useEffect(() => {
    if (!fileName) {
      return;
    }

    const operationId = pendingEditPerformanceOperationIdRef.current;
    const persistenceStartedAt = performance.now();
    saveDocumentDraft({
      fileName,
      markdown,
      updatedAt: new Date().toISOString()
    });
    recordEditPerformanceDuration(
      operationId,
      "draft_persistence",
      performance.now() - persistenceStartedAt
    );
    markEditPerformanceOperation(operationId, "persistence_settled");
  }, [fileName, markdown]);

  useLayoutEffect(() => {
    const operationId = pendingEditPerformanceOperationIdRef.current;

    if (!operationId) {
      return;
    }

    incrementEditPerformanceCounter(operationId, "react_commit_count");
    markEditPerformanceOperation(operationId, "react_commit");

    const animationFrameId = window.requestAnimationFrame(() => {
      markEditPerformanceOperation(operationId, "visual_settled");
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [comments, markdown]);

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
    if (!reanchorSession) {
      return;
    }

    const previousActiveCommentState = reanchorSession.previousActiveCommentState;

    function handleReanchorEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      if (reanchorConfirmation) {
        setReanchorConfirmation(null);
      } else {
        setReanchorSession(null);
        setMarkdownSelection({ end: 0, start: 0 });
        setMarkdownSelectionRequest(null);
        setVisualSelectionDraft(null);
        if (
          isDocumentScopeCurrent(reanchorSession, activeDocumentIdRef.current)
        ) {
          setActiveCommentState(previousActiveCommentState);
        }
      }
    }

    window.addEventListener("keydown", handleReanchorEscape);
    return () => window.removeEventListener("keydown", handleReanchorEscape);
  }, [reanchorConfirmation, reanchorSession, setActiveCommentState]);

  useEffect(() => {
    let isCancelled = false;
    let animationFrameId: number | null = null;
    let settledTimeoutId: number | null = null;
    const editorContainer = editorDocumentRef.current;
    const workspace = documentWorkspaceRef.current;

    function syncCommentAnchors() {
      if (isCancelled) {
        return;
      }

      const operationId = pendingEditPerformanceOperationIdRef.current;
      const projectionStartedAt = performance.now();
      markEditPerformanceOperation(operationId, "visual_projection_start");
      const nextCommentPositions = measureCommentPositions({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode,
        patches,
        workspace: documentWorkspaceRef.current
      });

      setCommentPositions((currentCommentPositions) =>
        areCommentPositionsEqual(currentCommentPositions, nextCommentPositions)
          ? currentCommentPositions
          : nextCommentPositions
      );
      const nextReadingBookmarkTop = measureReadingBookmarkPosition({
        bookmark: readingBookmark,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode,
        patches
      });
      setReadingBookmarkPosition((currentPosition) => {
        if (activeDocumentKey === null || nextReadingBookmarkTop === null) {
          return null;
        }
        return currentPosition?.documentKey === activeDocumentKey &&
          currentPosition.top === nextReadingBookmarkTop
          ? currentPosition
          : { documentKey: activeDocumentKey, top: nextReadingBookmarkTop };
      });

      updateVisualCommentHighlights({
        activeCommentState,
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode,
        patches,
        previewComment: createReanchorPreviewComment({
          comments,
          proposal: reanchorSession?.previewProposal ?? null,
          targetCommentId: reanchorSession?.commentId ?? null
        })
      });
      updateVisualReadingBookmarkHighlight({
        bookmark: readingBookmark,
        container: editorDocumentRef.current,
        emphasized: isReadingBookmarkEmphasized,
        headings,
        markdown,
        mode,
        patches
      });
      recordEditPerformanceDuration(
        operationId,
        "visual_projection_and_rail",
        performance.now() - projectionStartedAt
      );
      incrementEditPerformanceCounter(operationId, "projection_pass_count");
      markEditPerformanceOperation(operationId, "visual_projection_end");

      if (settledTimeoutId !== null) {
        window.clearTimeout(settledTimeoutId);
      }

      settledTimeoutId = window.setTimeout(() => {
        settledTimeoutId = null;
        markLatestEditPerformanceOperation(
          operationId,
          "all_async_effects_settled"
        );
      }, 120);
    }

    function scheduleCommentAnchorSync() {
      if (editorContainer) {
        visualTextIndexCache.delete(editorContainer);
      }

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        syncCommentAnchors();
      });
    }

    scheduleCommentAnchorSync();

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

      if (settledTimeoutId !== null) {
        window.clearTimeout(settledTimeoutId);
      }

      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleCommentAnchorSync);
      clearVisualCommentHighlights();
      clearVisualReadingBookmarkHighlight();
    };
  }, [
    activeCommentState,
    activeDocumentKey,
    comments,
    documentVersion,
    headings,
    isReadingBookmarkEmphasized,
    markdown,
    mode,
    patches,
    readingBookmark,
    reanchorSession
  ]);

  useEffect(() => {
    const previewProposal = reanchorSession?.previewProposal;

    if (!previewProposal || mode !== "visual") {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const container = editorDocumentRef.current;
      const previewComment = createReanchorPreviewComment({
        comments,
        proposal: previewProposal,
        targetCommentId: reanchorSession.commentId
      });

      if (!container || !previewComment) {
        return;
      }

      const range = findVisualCommentAnchorRange({
        comment: previewComment,
        container,
        headings,
        markdown,
        patches
      });

      if (range) {
        scrollRangeIntoViewportIfNeeded(range);
      }
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [comments, headings, markdown, mode, patches, reanchorSession]);

  useEffect(() => {
    const activeCommentIds = getActiveCommentIds(activeCommentState);
    const activeCommentKey = activeDocumentId
      ? activeCommentIds
          .map((commentId) =>
            createDocumentScopedKey(
              createCommentRef(activeDocumentId, commentId)
            )
          )
          .join(",")
      : "";

    if (!activeCommentKey) {
      lastScrolledActiveCommentKeyRef.current = null;
      return;
    }

    if (
      mode !== "visual" ||
      activeCommentIds.length === 0 ||
      lastScrolledActiveCommentKeyRef.current === activeCommentKey
    ) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const container = editorDocumentRef.current;

      if (!container) {
        return;
      }

      const activeComment = comments.find(
        (comment) => comment.id === activeCommentIds[0]
      );

      if (!activeComment) {
        return;
      }

      const range = findVisualCommentAnchorRange({
        comment: activeComment,
        container,
        headings,
        markdown,
        patches
      });

      if (!range) {
        return;
      }

      lastScrolledActiveCommentKeyRef.current = activeCommentKey;
      scrollRangeIntoViewportIfNeeded(range);
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    activeCommentState,
    activeDocumentId,
    comments,
    headings,
    markdown,
    mode,
    patches
  ]);

  const handleSaveChanges = useCallback(async () => {
    if (!fileName || isSaving || isProjectDataLoading) {
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
        const result = await saveProjectState({
          comments,
          markdown,
          patches,
          project: projectHandle,
          reason: "explicit_save"
        });
        setProjectHandle(projectHandle);
        setBaselineMarkdown(markdown);
        setRestoredMarkdown(null);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message:
            result.status === "unchanged"
              ? "Everything is already saved."
              : "Saved project changes as one complete generation."
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
  }, [activeFileHandle, comments, fileName, isProjectDataLoading, isSaving, markdown, patches, projectHandle]);

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
    setProjectRecovery(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setPdfExportTarget(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentReplyRequest(null);
    setCommentContextMenu(null);
    setComments([]);
    setPatches([]);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setRecentlyAppliedPatchId(null);
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
    setProjectRecovery(null);
    setRestoredMarkdown(availableDraft.markdown);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setPdfExportTarget(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentReplyRequest(null);
    setCommentContextMenu(null);
    setComments([]);
    setPatches([]);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setRecentlyAppliedPatchId(null);
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

  function handleMarkdownChange(
    nextMarkdown: string,
    source: DocumentMutationSource,
    hint?: MarkdownMutationHint
  ) {
    const operationId = startEditPerformanceOperation({
      newMarkdownLength: nextMarkdown.length,
      oldMarkdownLength: markdown.length,
      source: getDocumentMutationSourceFromHint(source, hint)
    });
    pendingEditPerformanceOperationIdRef.current = operationId;
    applyManualMarkdownMutation(
      nextMarkdown,
      getDocumentMutationSourceFromHint(source, hint),
      operationId,
      hint
    );

    if (saveStatus !== "saving") {
      setSaveStatus("idle");
      setSaveFeedback(null);
    }
    markEditPerformanceOperation(operationId, "input_handler_return");
  }

  function applyManualMarkdownMutation(
    nextMarkdown: string,
    source: DocumentMutationSource,
    performanceOperationId?: string | null,
    hint?: MarkdownMutationHint
  ) {
    if (nextMarkdown === markdown) {
      return;
    }

    if (!isManualDocumentMutationSource(source)) {
      setMarkdown(nextMarkdown);
      return;
    }

    markEditPerformanceOperation(performanceOperationId, "change_set_start");
    const changeSetStartedAt = performance.now();
    const changeSet =
      (hint && hint.event !== "change"
        ? deriveNativeMarkdownChangeSet({
            newMarkdown: nextMarkdown,
            oldMarkdown: markdown,
            selectionEnd: hint.selectionEnd,
            selectionStart: hint.selectionStart,
            source: getMarkdownChangeSetSource(source)
          })
        : null) ??
      deriveMarkdownChangeSet({
        newMarkdown: nextMarkdown,
        oldMarkdown: markdown,
        source: getMarkdownChangeSetSource(source)
      });
    recordEditPerformanceDuration(
      performanceOperationId,
      "change_set_derivation",
      performance.now() - changeSetStartedAt
    );
    markEditPerformanceOperation(performanceOperationId, "change_set_end");
    updateEditPerformanceMetadata(performanceOperationId, {
      broad: changeSet?.broad,
      confidence: changeSet?.confidence,
      hunkCount: changeSet?.edits.length
    });

    if (!changeSet || comments.length === 0) {
      markEditPerformanceOperation(
        performanceOperationId,
        "state_update_requested"
      );
      setMarkdown(nextMarkdown);
      return;
    }

    markEditPerformanceOperation(
      performanceOperationId,
      "change_set_validation_start"
    );
    const validationStartedAt = performance.now();
    const affectedAnchorCount = countManualChangeSetIntersectingSelectedTextAnchors({
      changeSet,
      comments,
    });
    const safety = isSafeManualAnchorTransformChangeSet({
      affectedAnchorCount,
      changeSet,
      oldMarkdown: markdown
    });
    recordEditPerformanceDuration(
      performanceOperationId,
      "change_set_validation",
      performance.now() - validationStartedAt
    );
    markEditPerformanceOperation(
      performanceOperationId,
      "change_set_validation_end"
    );
    updateEditPerformanceMetadata(performanceOperationId, {
      affectedCommentCount: affectedAnchorCount
    });

    if (!safety.safe) {
      markEditPerformanceOperation(
        performanceOperationId,
        "state_update_requested"
      );
      setMarkdown(nextMarkdown);
      return;
    }

    const mutationResult = orchestrateDocumentMutation({
      comments,
      createdAt: new Date().toISOString(),
      changeSet,
      edits: changeSet.edits,
      newMarkdown: nextMarkdown,
      oldMarkdown: markdown,
      performanceOperationId,
      source
    });

    updateEditPerformanceMetadata(performanceOperationId, {
      recoveryRequiredCount: mutationResult.recoveryRequiredCommentIds.length,
      transformedCommentCount: mutationResult.transformedCommentIds.length
    });
    markEditPerformanceOperation(performanceOperationId, "state_update_requested");
    setMarkdown(mutationResult.markdown);

    if (mutationResult.comments !== comments) {
      setComments(mutationResult.comments);
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
        kind: loadedProject.recovery ? "info" : "success",
        message: loadedProject.recovery
          ? loadedProject.recovery.message
          : "Opened Patchmark project folder."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleRestoreProjectRecovery() {
    if (!projectHandle || !projectRecovery?.canRestore || isSaving) {
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      const restoredProject = await restoreProjectLastKnownGood(projectHandle);
      loadProjectIntoEditor(restoredProject);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message:
          "Restored the last complete project save. Questionable files were preserved for inspection."
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

  function handleOpenLegacyProjectAssembly() {
    if (isSaving) {
      return;
    }
    if (!canOpenProjectFolder()) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Project assembly requires a browser with File System Access API support."
      });
      return;
    }
    setSaveFeedback(null);
    setIsLegacyProjectAssemblyOpen(true);
  }

  function handleLegacyProjectAssemblyComplete(
    loadedProject: LoadedPatchmarkProject
  ) {
    loadProjectIntoEditor(loadedProject);
    setIsLegacyProjectAssemblyOpen(false);
    setSaveFeedback({
      kind: "success",
      message:
        "Created a new multi-document project. Source projects remain unchanged."
    });
  }

  async function flushActiveDocumentForBoundary(
    project: PatchmarkProjectHandle,
    reason: string
  ) {
    if (project.documentAvailability === "missing") {
      return;
    }
    await saveProjectState({
      comments,
      markdown,
      patches,
      project,
      reason
    });
    setBaselineMarkdown(markdown);
    setRestoredMarkdown(null);
  }

  async function handleSelectProjectDocument(
    documentId: string,
    options: { continueReading?: boolean } = {}
  ) {
    if (
      !projectHandle ||
      !isMultiDocumentProject(projectHandle) ||
      projectHandle.document?.document_id === documentId
    ) {
      return;
    }
    if (!confirmTransientDraftLoss()) {
      return;
    }
    const requestId = documentSwitchRequestRef.current + 1;
    documentSwitchRequestRef.current = requestId;
    persistProjectDocumentUiState(projectHandle, {
      activeCommentState,
      markdownSelection,
      mode,
      scrollY: window.scrollY
    });
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      const loaded = await switchProjectDocument({
        comments,
        documentId,
        markdown,
        patches,
        project: projectHandle
      });
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      if (requestId !== documentSwitchRequestRef.current) {
        return;
      }
      const targetDocumentKey = createProjectDocumentKey(
        createProjectDocumentIdentity(
          loaded.project.projectManifest!.project_id,
          documentId
        )
      );
      loadProjectIntoEditor(loaded, {
        pendingBookmarkDocumentKey: options.continueReading
          ? targetDocumentKey
          : null
      });
      setSaveFeedback({
        kind: loaded.project.documentAvailability === "missing" ? "info" : "success",
        message:
          loaded.project.documentAvailability === "missing"
            ? `The registered file ${loaded.project.document?.path} is missing.`
            : `Opened ${loaded.project.document?.display_title}.`
      });
    } catch (error) {
      if (requestId !== documentSwitchRequestRef.current) {
        return;
      }
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: `Could not switch documents. ${getProjectErrorMessage(error)}`
      });
    }
  }

  async function handleContinueReadingFromNavigator(documentId: string) {
    if (!projectHandle) {
      return;
    }
    if (projectHandle.document?.document_id === documentId) {
      await handleContinueReading();
      return;
    }
    await handleSelectProjectDocument(documentId, { continueReading: true });
  }

  async function handleCreateProjectDocument({
    displayTitle,
    groupId,
    path,
    role
  }: {
    displayTitle: string;
    groupId?: string | null;
    path: string;
    role: PatchmarkDocumentRole;
  }) {
    if (!projectHandle || isSaving) {
      return;
    }
    if (!confirmTransientDraftLoss()) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    let activeProject = projectHandle;
    try {
      await flushActiveDocumentForBoundary(activeProject, "before_create_document");
      if (!isMultiDocumentProject(activeProject)) {
        const converted = await convertProjectToMultiDocument(activeProject);
        activeProject = converted.project;
        loadProjectIntoEditor(converted);
      }
      const loaded = await createNewProjectDocument({
        displayTitle,
        groupId,
        path,
        project: activeProject,
        role
      });
      loadProjectIntoEditor(loaded);
      setSaveFeedback({
        kind: "success",
        message: `Created ${loaded.project.document?.display_title}.`
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleAddExistingProjectDocument(
    groupId?: string | null
  ) {
    if (!projectHandle || isSaving) {
      return;
    }
    if (!confirmTransientDraftLoss()) {
      return;
    }
    try {
      const selected = await openMarkdownFileWithPicker();
      if (!selected) {
        return;
      }
      if (!selected.fileHandle) {
        throw new Error(
          "Patchmark needs a filesystem handle to verify that this file is inside the project."
        );
      }
      const path = await resolveDocumentPathFromFileHandle(
        projectHandle,
        selected.fileHandle
      );
      setSaveStatus("saving");
      setSaveFeedback(null);
      await flushActiveDocumentForBoundary(
        projectHandle,
        "before_add_existing_document"
      );
      let activeProject = projectHandle;
      if (!isMultiDocumentProject(activeProject)) {
        const converted = await convertProjectToMultiDocument(activeProject);
        activeProject = converted.project;
        loadProjectIntoEditor(converted);
      }
      const loaded = await addExistingDocumentToProject({
        groupId,
        path,
        project: activeProject,
        role: null
      });
      loadProjectIntoEditor(loaded);
      setSaveFeedback({
        kind: "success",
        message: `Added ${loaded.project.document?.display_title} without changing its Markdown.`
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleUpdateProjectDocument(
    documentId: string,
    changes: { displayTitle?: string; role?: PatchmarkDocumentRole }
  ) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      await updateProjectDocumentMetadata({
        documentId,
        project: projectHandle,
        ...(changes.displayTitle !== undefined
          ? { displayTitle: changes.displayTitle }
          : {}),
        ...(changes.role !== undefined ? { role: changes.role } : {})
      });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({ kind: "success", message: "Updated document metadata." });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleMoveProjectDocument(
    documentId: string,
    direction: "up" | "down"
  ) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    try {
      await moveProjectDocument({ direction, documentId, project: projectHandle });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleCreateProjectDocumentGroup(title: string) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      await createProjectDocumentGroup({ project: projectHandle, title });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({ kind: "success", message: `Created ${title} group.` });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleRenameProjectDocumentGroup(
    groupId: string,
    title: string
  ) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      await renameProjectDocumentGroup({ groupId, project: projectHandle, title });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({ kind: "success", message: "Renamed document group." });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleMoveProjectDocumentGroup(
    groupId: string,
    direction: "up" | "down"
  ) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    try {
      await moveProjectDocumentGroup({ direction, groupId, project: projectHandle });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleMoveProjectDocumentToGroup(
    documentId: string,
    groupId: string | null
  ) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      await moveProjectDocumentToGroup({ documentId, groupId, project: projectHandle });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({ kind: "success", message: "Moved document metadata only." });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleRemoveProjectDocumentGroup(groupId: string) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      await deleteProjectDocumentGroup({ groupId, project: projectHandle });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Removed group. Its documents are now ungrouped."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleArchiveProjectDocument(documentId: string) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    setSaveFeedback(null);
    try {
      const isActive = projectHandle.document?.document_id === documentId;
      if (isActive && !confirmTransientDraftLoss()) {
        setSaveStatus("idle");
        return;
      }
      if (isActive) {
        persistProjectDocumentUiState(projectHandle, {
          activeCommentState,
          markdownSelection,
          mode,
          scrollY: window.scrollY
        });
        await flushActiveDocumentForBoundary(projectHandle, "before_archive_document");
      }
      await archiveProjectDocument({ documentId, project: projectHandle });
      const documents = await getProjectDocumentList(projectHandle);
      setProjectDocuments(documents);
      if (isActive) {
        const nextDocument =
          documents.find(
            (document) =>
              document.status === "active" && document.availability === "available"
          ) ?? documents.find((document) => document.status === "active");
        if (!nextDocument) {
          throw new Error("No active document remains after archive.");
        }
        loadProjectIntoEditor(
          await openProjectDocument(projectHandle, nextDocument.document_id)
        );
      } else {
        setSaveStatus("idle");
      }
      setSaveFeedback({ kind: "success", message: "Archived document metadata only." });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleRestoreProjectDocument(documentId: string) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    setSaveStatus("saving");
    try {
      await restoreProjectDocument({ documentId, project: projectHandle });
      setProjectDocuments(await getProjectDocumentList(projectHandle));
      setSaveStatus("idle");
      setSaveFeedback({ kind: "success", message: "Restored document." });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  async function handleLocateProjectDocument(documentId: string) {
    if (!projectHandle || isSaving || !isMultiDocumentProject(projectHandle)) {
      return;
    }
    if (!confirmTransientDraftLoss()) {
      return;
    }
    try {
      const selected = await openMarkdownFileWithPicker();
      if (!selected?.fileHandle) {
        return;
      }
      const path = await resolveDocumentPathFromFileHandle(
        projectHandle,
        selected.fileHandle
      );
      setSaveStatus("saving");
      persistProjectDocumentUiState(projectHandle, {
        activeCommentState,
        markdownSelection,
        mode,
        scrollY: window.scrollY
      });
      await flushActiveDocumentForBoundary(
        projectHandle,
        "before_locate_document"
      );
      const loaded = await locateProjectDocument({
        documentId,
        path,
        project: projectHandle
      });
      loadProjectIntoEditor(loaded);
      setSaveFeedback({
        kind: "success",
        message: `Located ${loaded.project.document?.display_title}.`
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({ kind: "error", message: getProjectErrorMessage(error) });
    }
  }

  function confirmTransientDraftLoss(): boolean {
    if (!commentAddRequest && !commentReplyRequest) {
      return true;
    }
    return window.confirm(
      "Switching documents will discard the unsubmitted comment or reply draft. Continue?"
    );
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

    const documentId = getProjectDocumentScopeId(projectHandle);
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
      patches,
      project: projectHandle
    });
    const jsonText = `${JSON.stringify(exportPayload, null, 2)}\n`;
    const promptText = createFocusedCommentsChatGptPrompt(jsonText, {
      dedicatedDocumentReview,
      observedAt: exportedAt.slice(0, 10)
    });
    const fileNamePrefix = dedicatedDocumentReview
      ? "document-comment"
      : "focused-comments";

    setChatGptPromptDialog({
      commentIds: focusedComments.map((comment) => comment.id),
      dedicatedDocumentReview,
      documentId,
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
    if (
      !chatGptPromptDialog ||
      !isDocumentScopeCurrent(
        chatGptPromptDialog,
        activeDocumentIdRef.current
      )
    ) {
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
    if (
      !projectHandle ||
      !chatGptPromptDialog ||
      !isDocumentScopeCurrent(
        chatGptPromptDialog,
        activeDocumentIdRef.current
      )
    ) {
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
    if (
      !chatGptPromptDialog ||
      !isDocumentScopeCurrent(
        chatGptPromptDialog,
        activeDocumentIdRef.current
      )
    ) {
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
    if (
      !projectHandle ||
      !chatGptPromptDialog ||
      !isDocumentScopeCurrent(
        chatGptPromptDialog,
        activeDocumentIdRef.current
      )
    ) {
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
      documentId: getProjectDocumentScopeId(projectHandle),
      error: null,
      responseJson: "",
      sourceChatUrl: ""
    });
  }

  async function handleImportChatGptResponse(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (
      !projectHandle ||
      !chatGptImportDialog ||
      isCommentBusy ||
      !isDocumentScopeCurrent(
        chatGptImportDialog,
        activeDocumentIdRef.current
      )
    ) {
      return;
    }

    let parsedResponse: PatchmarkCommentReplyImport;
    let sourceChatUrl: string | undefined;

    try {
      parsedResponse = parsePatchmarkCommentReplyImport(
        chatGptImportDialog.responseJson
      );
      validateAtomicTablePatchImport({
        markdown,
        patchProposals: parsedResponse.patch_proposals
      });
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
        comments,
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
        target_document: getProjectDocumentExportIdentity(projectHandle),
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

      const nextPatches = [...existingPatches, ...importedPatches];
      await saveProjectState({
        comments: nextComments,
        markdown,
        patches: nextPatches,
        project: projectHandle,
        reason: "import_chatgpt_response"
      });

      if (
        !isDocumentScopeCurrent(
          chatGptImportDialog,
          activeDocumentIdRef.current
        )
      ) {
        return;
      }

      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      setComments(nextComments);
      setPatches(nextPatches);
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
    if (
      !isDocumentScopeCurrent(exportDialog, activeDocumentIdRef.current)
    ) {
      throw new Error(
        "The target document changed before focused comments were updated."
      );
    }
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

    await persistComments(
      nextComments,
      "Marked focused comments as exported.",
      exportDialog.documentId
    );
  }

  async function handleViewSnapshot(
    version: PatchmarkVersionEntry,
    displayTitle?: string
  ) {
    if (!projectHandle) {
      return;
    }

    const versionRef = createVersionRef(
      getProjectDocumentScopeId(projectHandle),
      version.id
    );
    try {
      const snapshotMarkdown = await readProjectVersionMarkdownByRef(
        projectHandle,
        versionRef,
        version
      );
      if (!isDocumentScopeCurrent(versionRef, activeDocumentIdRef.current)) {
        return;
      }
      setSnapshotDialog({
        documentId: versionRef.documentId,
        displayTitle,
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

  async function handleCompareSnapshot(
    version: PatchmarkVersionEntry,
    displayTitle?: string
  ) {
    if (!projectHandle) {
      return;
    }

    const versionRef = createVersionRef(
      getProjectDocumentScopeId(projectHandle),
      version.id
    );
    try {
      const snapshotMarkdown = await readProjectVersionMarkdownByRef(
        projectHandle,
        versionRef,
        version
      );
      if (!isDocumentScopeCurrent(versionRef, activeDocumentIdRef.current)) {
        return;
      }
      setSnapshotDialog({
        currentMarkdown: markdown,
        documentId: versionRef.documentId,
        displayTitle,
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

  async function handleEditCommentReply(
    commentId: string,
    entryId: string,
    content: string
  ) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? editLatestUserReply({
            comment,
            editedAt: now,
            entryId,
            nextContent: content
          })
        : comment
    );

    await persistComments(
      nextComments,
      "Updated reply. Current thread is ready to re-export."
    );
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
    const resolution = resolveCommentAnchor(comment, markdown, headings, patches);

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

    const pendingAnchorStatus = getPatchReviewAnchorStatus(
      markdown,
      patch,
      patches,
      comments
    );
    const matches =
      pendingAnchorStatus.kind !== "accepted" &&
      pendingAnchorStatus.applicability === "exact_match"
        ? pendingAnchorStatus.matches
        : pendingAnchorStatus.kind !== "accepted"
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

  function handleContinuePatchDiscussion(patch: PatchmarkPatch) {
    const linkedComment = getContinuableLinkedComment({ comments, patch });

    if (!linkedComment) {
      const existingLinkedComment = patch.comment_id
        ? comments.find((comment) => comment.id === patch.comment_id) ?? null
        : null;
      setSaveFeedback({
        kind: "info",
        message: existingLinkedComment
          ? "The linked comment is resolved and was not reopened."
          : "The linked comment is unavailable."
      });
      return;
    }

    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setRecentlyAppliedPatchId(null);
    window.requestAnimationFrame(() => {
      void handleFindComment(linkedComment);
      window.requestAnimationFrame(() => {
        setCommentReplyRequest((currentRequest) => ({
          commentId: linkedComment.id,
          nonce: (currentRequest?.nonce ?? 0) + 1
        }));
      });
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
    const currentPatchAnchorStatus = getPatchReviewAnchorStatus(
      markdown,
      currentPatch,
      patches,
      comments
    );
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

    const resolvedPatchTarget =
      currentPatchAnchorStatus.kind === "pending" &&
      currentPatchAnchorStatus.applicability === "exact_match"
        ? currentPatchAnchorStatus.matches[0] ?? null
        : null;
    const originalStart = resolvedPatchTarget?.start ?? -1;
    const originalEnd = resolvedPatchTarget?.end ?? -1;
    if (
      !resolvedPatchTarget ||
      markdown.slice(originalStart, originalEnd) !== currentPatch.original_text
    ) {
      setSaveFeedback({
        kind: "error",
        message:
          "Cannot apply because the resolved patch target no longer matches the original text."
      });
      return;
    }

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
      const appliedAt = new Date().toISOString();
      const appliedAnchorMetadata = createAppliedPatchAnchorMetadata({
        end: replacementEnd,
        markdown: nextMarkdown,
        start: replacementStart,
        text: currentPatch.suggested_text
      });
      const mutationResult = orchestrateDocumentMutation({
        comments,
        createdAt: appliedAt,
        edits: [
          {
            oldStart: originalStart,
            oldEnd: originalEnd,
            insertedText: currentPatch.suggested_text
          }
        ],
        newMarkdown: nextMarkdown,
        oldMarkdown: markdown,
        patchContext: {
          linkedCommentId: currentPatch.comment_id,
          patch: currentPatch,
          replacementStart
        },
        source: "patch_apply"
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

      const linkedCommentMissing =
        Boolean(currentPatch.comment_id) && !mutationResult.linkedCommentFound;

      await saveProjectState({
        comments: mutationResult.comments,
        markdown: mutationResult.markdown,
        patches: nextPatches,
        project: snapshotResult.project,
        reason: `accept_patch:${currentPatch.id}`
      });
      setProjectHandle(snapshotResult.project);
      setMarkdown(mutationResult.markdown);
      setBaselineMarkdown(mutationResult.markdown);
      setRestoredMarkdown(null);
      setVersionEntries(snapshotResult.project.manifest.versions ?? []);
      setDocumentVersion((currentVersion) => currentVersion + 1);
      setComments(mutationResult.comments);
      setPatches(nextPatches);
      setRecentlyAppliedPatchId(currentPatch.id);
      setSaveStatus("idle");
      setSaveFeedback({
        kind:
          linkedCommentMissing || mutationResult.needsReviewCount > 0
            ? "info"
            : "success",
        message: linkedCommentMissing
          ? "Patch applied, but the linked comment was not found. Other comment anchors were updated where needed."
          : mutationResult.needsReviewCount > 0
            ? `Patch applied. ${mutationResult.needsReviewCount} comment anchor${mutationResult.needsReviewCount === 1 ? "" : "s"} need review.`
            : "Patch applied. Comment anchors were updated where needed."
      });
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

    if (isDirty) {
      setSaveFeedback({
        kind: "info",
        message: "Save document changes before updating a patch anchor."
      });
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

    const anchorStatus = getPatchReviewAnchorStatus(
      markdown,
      currentPatch,
      patches,
      comments
    );

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
      await saveProjectState({
        patches: nextPatches,
        project: projectHandle,
        reason: `update_patch_anchor:${currentPatch.id}`
      });
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

    if (isDirty) {
      setSaveFeedback({
        kind: "info",
        message: "Save document changes before rejecting a patch."
      });
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
    const nextComments = currentPatch.comment_id
      ? appendPatchSystemThreadEntry({
          comments,
          commentId: currentPatch.comment_id,
          content: `Patch ${currentPatch.id} was rejected.`,
          createdAt: rejectedAt,
          patchId: currentPatch.id
        })
      : null;

    try {
      await saveProjectState({
        comments: nextComments ?? undefined,
        patches: nextPatches,
        project: projectHandle,
        reason: `reject_patch:${currentPatch.id}`
      });
      setPatches(nextPatches);

      if (!currentPatch.comment_id) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Patch rejected."
        });
        return;
      }

      if (!nextComments) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Patch rejected, but the linked comment was not found. Comment remains unresolved."
        });
        return;
      }

      setComments(nextComments);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Patch rejected. Comment remains open."
      });
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

    if (isDirty) {
      setSaveFeedback({
        kind: "info",
        message: "Save document changes before rejecting a patch group."
      });
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
    const nextComments = group.comment_id
      ? appendPatchSystemThreadEntry({
          comments,
          commentId: group.comment_id,
          content: `Pending patches in ${group.display_id} were rejected.`,
          createdAt: rejectedAt
        })
      : null;

    try {
      await saveProjectState({
        comments: nextComments ?? undefined,
        patches: nextPatches,
        project: projectHandle,
        reason: `reject_patch_group:${group.id}`
      });
      setPatches(nextPatches);

      if (!group.comment_id) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Pending patches in group rejected."
        });
        return;
      }

      if (!nextComments) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message:
            "Pending patches in group rejected, but the linked comment was not found. Comment remains unresolved."
        });
        return;
      }

      setComments(nextComments);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Pending patches in group rejected. Comment remains open."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  function handleStartReanchor(commentId: string) {
    if (!projectHandle || reanchorSession) {
      return;
    }
    const documentId = getProjectDocumentScopeId(projectHandle);

    const comment = comments.find((candidate) => candidate.id === commentId);

    if (
      !comment ||
      comment.status !== "open" ||
      comment.anchor.kind !== "selected_text"
    ) {
      return;
    }

    const resolution = resolveCanonicalCommentTarget(comment, {
      headings,
      markdown,
      patches
    });
    const previousStatus = commentAnchorSummaries[commentId]?.status ??
      (resolution.state === "ambiguous"
        ? "ambiguous"
        : resolution.state === "not_found"
          ? "not_found"
          : "active");

    setCommentContextMenu(null);
    setCommentAddRequest(null);
    setCommentReplyRequest(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setReanchorConfirmation(null);
    setReanchorSession({
      candidates: createHumanReanchorCandidates({
        headings,
        markdown,
        resolution
      }),
      commentId,
      documentId,
      documentHash: createDocumentHash(markdown),
      documentVersion,
      error: null,
      previousActiveCommentState: activeCommentState,
      previousStatus,
      previewProposal: null
    });
    setActiveCommentState({ kind: "comment", commentId });
    setSaveFeedback(null);
  }

  function cancelReanchorMode() {
    if (!reanchorSession) {
      return;
    }

    setReanchorConfirmation(null);
    setReanchorSession(null);
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    if (
      isDocumentScopeCurrent(reanchorSession, activeDocumentIdRef.current)
    ) {
      setActiveCommentState(reanchorSession.previousActiveCommentState);
    }
  }

  function createProposalForRange(
    range: { end: number; start: number },
    source: "candidate" | "markdown" | "visual"
  ): HumanReanchorProposal | null {
    if (
      !reanchorSession ||
      !projectHandle ||
      !isDocumentScopeCurrent(reanchorSession, activeDocumentIdRef.current)
    ) {
      return null;
    }

    const comment = comments.find(
      (candidate) => candidate.id === reanchorSession.commentId
    );

    if (!comment || comment.anchor.kind !== "selected_text") {
      return null;
    }

    try {
      return createHumanReanchorProposal({
        documentId: reanchorSession.documentId,
        documentGeneration: reanchorSession.documentVersion,
        headings,
        markdown,
        previousAnchor: comment.anchor,
        range,
        saveGeneration: projectHandle.manifest.save_generation ?? 0,
        source
      });
    } catch (error) {
      setReanchorSession((current) =>
        current
          ? {
              ...current,
              error: getProjectErrorMessage(error)
            }
          : current
      );
      return null;
    }
  }

  function handleShowReanchorCandidate(candidate: HumanReanchorCandidate) {
    const proposal = createProposalForRange(candidate.range, "candidate");

    if (!proposal) {
      return;
    }

    setReanchorSession((current) =>
      current
        ? {
            ...current,
            error: null,
            previewProposal: proposal
          }
        : current
    );

    if (mode === "markdown") {
      jumpToMarkdownSelection(candidate.range.start, candidate.range.end);
    }
  }

  function handleUseReanchorCandidate(candidate: HumanReanchorCandidate) {
    const proposal = createProposalForRange(candidate.range, "candidate");

    if (!proposal) {
      return;
    }

    setReanchorSession((current) =>
      current
        ? {
            ...current,
            error: null,
            previewProposal: proposal
          }
        : current
    );
    setReanchorConfirmation(proposal);
  }

  function handleUseSelectionForReanchor() {
    if (!reanchorSession) {
      return;
    }

    const selectionDraft =
      mode === "markdown"
        ? createMarkdownSelectionDraft(markdown, markdownSelection)
        : visualSelectionDraft ??
          createVisualSelectionDraftResult({
            container: editorDocumentRef.current,
            markdown
          }).draft;
    const start = getDraftMarkdownStartOffset(selectionDraft);
    const end = selectionDraft?.markdownEndOffset;

    if (
      !selectionDraft ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      end <= start
    ) {
      setReanchorSession({
        ...reanchorSession,
        error: "Select document text before choosing a new anchor."
      });
      return;
    }

    const proposal = createProposalForRange(
      { start, end },
      mode === "visual" ? "visual" : "markdown"
    );

    if (!proposal) {
      return;
    }

    setReanchorSession({
      ...reanchorSession,
      error: null,
      previewProposal: proposal
    });
    setReanchorConfirmation(proposal);
  }

  async function handleConfirmReanchor() {
    if (
      !reanchorSession ||
      !reanchorConfirmation ||
      !projectHandle ||
      isCommentBusy ||
      !isDocumentScopeCurrent(reanchorSession, activeDocumentIdRef.current) ||
      !isDocumentScopeCurrent(
        reanchorConfirmation,
        activeDocumentIdRef.current
      )
    ) {
      return;
    }

    const comment = comments.find(
      (candidate) => candidate.id === reanchorSession.commentId
    );

    if (!comment) {
      setReanchorConfirmation(null);
      setReanchorSession({
        ...reanchorSession,
        error: "The comment is no longer available."
      });
      return;
    }

    const result = applyHumanReanchor({
      comment,
      currentDocumentId: getProjectDocumentScopeId(projectHandle),
      currentDocumentGeneration: documentVersion,
      currentSaveGeneration: projectHandle.manifest.save_generation ?? 0,
      markdown,
      patches,
      proposal: reanchorConfirmation,
      timestamp: new Date().toISOString()
    });

    if (result.kind === "no_op") {
      setReanchorConfirmation(null);
      setReanchorSession(null);
      setMarkdownSelection({ end: 0, start: 0 });
      setMarkdownSelectionRequest(null);
      setVisualSelectionDraft(null);
      setActiveCommentState({ kind: "comment", commentId: comment.id });
      setSaveFeedback({
        kind: "info",
        message: "This comment is already anchored to that text."
      });
      return;
    }

    if (result.kind === "resolved_comment") {
      setReanchorConfirmation(null);
      setReanchorSession({
        ...reanchorSession,
        error: "Reopen this resolved comment before changing its anchor."
      });
      return;
    }

    if (result.kind === "stale") {
      setReanchorConfirmation(null);
      setReanchorSession({
        ...reanchorSession,
        error: result.message,
        previewProposal: null
      });
      return;
    }

    const nextComments = comments.map((candidate) =>
      candidate.id === result.comment.id ? result.comment : candidate
    );
    setIsCommentBusy(true);
    setCommentsError(null);

    try {
      await saveProjectState({
        comments: nextComments,
        project: projectHandle,
        reason: `human_reanchor:${comment.id}`
      });
      if (
        !isDocumentScopeCurrent(reanchorSession, activeDocumentIdRef.current)
      ) {
        return;
      }
      lastScrolledActiveCommentKeyRef.current = null;
      setComments(nextComments);
      setReanchorConfirmation(null);
      setReanchorSession(null);
      setMarkdownSelection({ end: 0, start: 0 });
      setMarkdownSelectionRequest(null);
      setVisualSelectionDraft(null);
      setActiveCommentState({ kind: "comment", commentId: comment.id });
      setSaveFeedback({
        kind: "success",
        message: "Comment anchor updated."
      });
    } catch {
      setSaveFeedback({
        kind: "error",
        message:
          "Unable to update the comment anchor. The document and comment were not changed."
      });
    } finally {
      setIsCommentBusy(false);
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
    if (
      mode !== "visual" ||
      isReanchorMode ||
      isToolbarContextMenuTarget(event.target)
    ) {
      return;
    }

    const matchingCommentIds = findVisualCommentIdsAtPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      comments,
      container: editorDocumentRef.current,
      headings,
      markdown,
      patches
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

    if (isReanchorMode) {
      setCommentContextMenu(null);
      return;
    }

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

    const menuPosition = getCommentContextMenuPosition({
      container: editorDocumentRef.current,
      event,
      selectionRect: selectionResult.affordanceRect ?? null
    });

    setCommentContextMenu({
      defaultHeadingLine: headingForSelection?.line ?? null,
      selectionHelp: selectionResult.help,
      selectedDraft,
      x: menuPosition.x,
      y: menuPosition.y
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

  async function handleSetReadingBookmarkFromMenu() {
    if (
      !projectHandle ||
      !activeDocumentIdentity ||
      !activeDocumentKey ||
      !commentContextMenu ||
      isReadingBookmarkBusy ||
      isProjectRecoveryReadOnly
    ) {
      return;
    }

    const operationDocument = activeDocumentIdentity;
    const operationDocumentKey = activeDocumentKey;
    const scope: CommentAnchorScope = commentContextMenu.selectedDraft
      ? "selected_text"
      : "section";

    if (scope === "section" && !commentContextMenu.defaultHeadingLine) {
      setSaveFeedback({
        kind: "info",
        message: "Select text or open the menu inside a section to set a bookmark."
      });
      setCommentContextMenu(null);
      return;
    }

    const anchor = createCommentAnchor({
      headings,
      markdown,
      selection: markdownSelection,
      selectedDraft: commentContextMenu.selectedDraft,
      values: {
        anchorScope: scope,
        comment: "",
        targetHeadingLine: commentContextMenu.defaultHeadingLine,
        type: "note"
      }
    });

    if (anchor.kind === "document") {
      return;
    }

    setCommentContextMenu(null);
    setReadingBookmarkBusyDocumentKey(operationDocumentKey);

    try {
      await updateProjectManifestMetadata({
        project: projectHandle,
        reason: "set_reading_bookmark",
        update: (currentManifest) =>
          setDocumentReadingBookmark({
            anchor,
            document: operationDocument,
            manifest: currentManifest,
            timestamp: new Date().toISOString()
          }).manifest
      });
      setProjectDocuments((currentDocuments) =>
        currentDocuments.map((document) =>
          document.document_id === operationDocument.documentId
            ? { ...document, hasReadingBookmark: true }
            : document
        )
      );
      if (activeDocumentKeyRef.current === operationDocumentKey) {
        setProjectHandle((currentProject) =>
          currentProject === projectHandle
            ? { ...projectHandle, manifest: { ...projectHandle.manifest } }
            : currentProject
        );
        setSaveFeedback({
          kind: "success",
          message: "Reading bookmark set."
        });
      }
    } catch (error) {
      if (activeDocumentKeyRef.current === operationDocumentKey) {
        setSaveFeedback({
          kind: "error",
          message: getProjectErrorMessage(error)
        });
      }
    } finally {
      setReadingBookmarkBusyDocumentKey((currentKey) =>
        currentKey === operationDocumentKey ? null : currentKey
      );
    }
  }

  async function handleRemoveReadingBookmark() {
    if (
      !projectHandle ||
      !activeDocumentIdentity ||
      !activeDocumentKey ||
      !readingBookmark ||
      isReadingBookmarkBusy
    ) {
      return;
    }

    const operationDocument = activeDocumentIdentity;
    const operationDocumentKey = activeDocumentKey;
    setReadingBookmarkMenuDocumentKey((currentKey) =>
      currentKey === operationDocumentKey ? null : currentKey
    );
    setReadingBookmarkBusyDocumentKey(operationDocumentKey);

    try {
      await updateProjectManifestMetadata({
        project: projectHandle,
        reason: "remove_reading_bookmark",
        update: (currentManifest) =>
          removeDocumentReadingBookmark({
            document: operationDocument,
            manifest: currentManifest
          })
      });
      if (activeProjectIdRef.current === operationDocument.projectId) {
        setProjectDocuments((currentDocuments) =>
          currentDocuments.map((document) =>
            document.document_id === operationDocument.documentId
              ? { ...document, hasReadingBookmark: false }
              : document
          )
        );
      }
      if (activeDocumentKeyRef.current === operationDocumentKey) {
        setProjectHandle((currentProject) =>
          currentProject === projectHandle
            ? { ...projectHandle, manifest: { ...projectHandle.manifest } }
            : currentProject
        );
        setReadingBookmarkEmphasizedDocumentKey(null);
        setSaveFeedback({
          kind: "success",
          message: "Reading bookmark removed."
        });
      }
    } catch (error) {
      if (activeDocumentKeyRef.current === operationDocumentKey) {
        setSaveFeedback({
          kind: "error",
          message: getProjectErrorMessage(error)
        });
      }
    } finally {
      setReadingBookmarkBusyDocumentKey((currentKey) =>
        currentKey === operationDocumentKey ? null : currentKey
      );
    }
  }

  async function handleContinueReading() {
    if (!activeDocumentKey) {
      return;
    }
    await continueReadingAtBookmark({
      bookmark: readingBookmark,
      documentKey: activeDocumentKey,
      markdown,
      mode,
      patches
    });
  }

  async function continueReadingAtBookmark({
    bookmark,
    documentKey,
    markdown: targetMarkdown,
    mode: targetMode,
    patches: targetPatches
  }: ReadingBookmarkNavigationRequest) {
    if (activeDocumentKeyRef.current !== documentKey || !bookmark) {
      return;
    }

    const resolution = resolveReadingBookmark({
      bookmark,
      markdown: targetMarkdown,
      patches: targetPatches
    });
    if (resolution.state !== "available") {
      setSaveFeedback({
        kind: "info",
        message:
          "The reading bookmark cannot be located confidently. Replace or remove it."
      });
      return;
    }

    if (targetMode === "markdown") {
      jumpToMarkdownSelection(resolution.start, resolution.end);
    } else {
      const range = await waitForVisualReadingBookmarkRange({
        bookmark,
        container: editorDocumentRef.current,
        documentKey,
        getActiveDocumentKey: () => activeDocumentKeyRef.current,
        headings: parseMarkdownHeadings(targetMarkdown),
        markdown: targetMarkdown,
        patches: targetPatches
      });
      if (!range || activeDocumentKeyRef.current !== documentKey) {
        if (activeDocumentKeyRef.current === documentKey) {
          setSaveFeedback({
            kind: "info",
            message:
              "The reading bookmark is available in Markdown Mode but could not be shown visually."
          });
        }
        return;
      }

      scrollRangeIntoViewportIfNeeded(range);
      setReadingBookmarkEmphasizedDocumentKey(documentKey);
      if (readingBookmarkEmphasisTimeoutRef.current !== null) {
        window.clearTimeout(readingBookmarkEmphasisTimeoutRef.current);
      }
      readingBookmarkEmphasisTimeoutRef.current = window.setTimeout(() => {
        readingBookmarkEmphasisTimeoutRef.current = null;
        setReadingBookmarkEmphasizedDocumentKey((currentKey) =>
          currentKey === documentKey ? null : currentKey
        );
      }, 1800);
    }

    if (activeDocumentKeyRef.current === documentKey) {
      setSaveFeedback({
        kind: "success",
        message: "Continued reading at the saved bookmark."
      });
    }
  }

  function getCommentContextMenuPosition({
    container,
    event,
    selectionRect
  }: {
    container: HTMLElement | null;
    event: React.MouseEvent<HTMLDivElement>;
    selectionRect: CommentAffordanceRect | null;
  }): { x: number; y: number } {
    const containerRect = container
      ? toCommentAffordanceRect(container.getBoundingClientRect())
      : null;
    const bounds = createCommentAffordanceBounds({
      containerRect,
      menuSize: COMMENT_AFFORDANCE_MENU_SIZE,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    });
    const anchorRect =
      selectionRect ?? createPointAffordanceRect(event.clientX, event.clientY);
    const position = placeCommentAffordance({
      anchorRect,
      bounds,
      menuSize: COMMENT_AFFORDANCE_MENU_SIZE
    });

    return {
      x: Math.round(position.x),
      y: Math.round(position.y)
    };
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
    successMessage: string,
    expectedDocumentId?: string
  ) {
    if (!projectHandle || isCommentBusy) {
      return;
    }
    const operationDocumentId =
      expectedDocumentId ?? getProjectDocumentScopeId(projectHandle);
    if (
      getProjectDocumentScopeId(projectHandle) !== operationDocumentId ||
      activeDocumentIdRef.current !== operationDocumentId
    ) {
      throw new Error(
        "The target document changed before the comment operation began."
      );
    }

    setIsCommentBusy(true);
    setCommentsError(null);

    try {
      await saveProjectState({
        comments: nextComments,
        markdown,
        patches,
        project: projectHandle,
        reason: "update_comment_state"
      });
      if (activeDocumentIdRef.current !== operationDocumentId) {
        throw new Error(
          "The target document changed before the comment operation completed."
        );
      }
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
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

  function loadProjectIntoEditor(
    loadedProject: LoadedPatchmarkProject,
    options: { pendingBookmarkDocumentKey?: string | null } = {}
  ) {
    const restoredUiState = readProjectDocumentUiState(loadedProject.project);
    const loadedDocumentId = getProjectDocumentScopeId(loadedProject.project);
    pendingReadingBookmarkNavigationRef.current =
      options.pendingBookmarkDocumentKey ?? null;
    setProjectHandle(loadedProject.project);
    setProjectRecovery(loadedProject.recovery ?? null);
    setFileName(
      loadedProject.project.document?.path ??
        loadedProject.project.manifest.document_file
    );
    setMarkdown(loadedProject.markdown);
    setBaselineMarkdown(loadedProject.markdown);
    setActiveFileHandle(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSnapshotDialog(null);
    setIsLegacyProjectAssemblyOpen(false);
    setMarkdownSelection(
      restoredUiState?.markdownSelection ?? { end: 0, start: 0 }
    );
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentReplyRequest(null);
    setCommentContextMenu(null);
    setReanchorSession(null);
    setReanchorConfirmation(null);
    setCommentPositions({});
    setReadingBookmarkPosition(null);
    setReadingBookmarkEmphasizedDocumentKey(null);
    setReadingBookmarkMenuDocumentKey(null);
    setVersionEntries([]);
    setComments([]);
    setPatches([]);
    setDocumentActiveCommentState({
      documentId: loadedDocumentId,
      state: restoredUiState?.activeCommentState ?? { kind: "none" }
    });
    lastScrolledActiveCommentKeyRef.current = null;
    setIsProjectDataLoading(true);
    setSelectedPatchId(null);
    setSelectedPatchGroupId(null);
    setPatchGroupListDialog(null);
    setPatchReviewCommentScopeId(null);
    setPatchReviewGroupScopeId(null);
    setRecentlyAppliedPatchId(null);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setDocumentLevelExportGuardDialog(null);
    setMarkCommentFocusGuardDialog(null);
    setChatGptImportDialog(null);
    setMode(restoredUiState?.mode ?? "visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
    if (restoredUiState) {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: restoredUiState.scrollY });
      });
    }
  }

  return (
    <section
      ref={documentWorkspaceRef}
      className="document-workspace"
      aria-label="Patchmark editor"
    >
      <aside className="document-sidebar" aria-label="Document navigation">
        {projectHandle ? (
          <ProjectDocumentNavigator
            activeDocumentId={
              getActiveProjectDocument(projectHandle)?.document_id ??
              "legacy-document"
            }
            busy={
              isSaving ||
              isProjectDataLoading ||
              isCommentBusy ||
              isReadingBookmarkBusy
            }
            documents={projectDocuments}
            groups={projectGroups}
            legacy={!isMultiDocumentProject(projectHandle)}
            projectId={getProjectDocumentIdentity(projectHandle).projectId}
            projectTitle={getProjectTitle(projectHandle)}
            onAddExisting={(groupId) =>
              void handleAddExistingProjectDocument(groupId)
            }
            onArchive={(documentId) =>
              void handleArchiveProjectDocument(documentId)
            }
            onCreate={(request) => void handleCreateProjectDocument(request)}
            onCreateGroup={(title) =>
              void handleCreateProjectDocumentGroup(title)
            }
            onContinueReading={(documentId) =>
              void handleContinueReadingFromNavigator(documentId)
            }
            onLocate={(documentId) =>
              void handleLocateProjectDocument(documentId)
            }
            onMove={(documentId, direction) =>
              void handleMoveProjectDocument(documentId, direction)
            }
            onMoveGroup={(groupId, direction) =>
              void handleMoveProjectDocumentGroup(groupId, direction)
            }
            onMoveToGroup={(documentId, groupId) =>
              void handleMoveProjectDocumentToGroup(documentId, groupId)
            }
            onRemoveGroup={(groupId) =>
              void handleRemoveProjectDocumentGroup(groupId)
            }
            onRename={(documentId, displayTitle) =>
              void handleUpdateProjectDocument(documentId, { displayTitle })
            }
            onRenameGroup={(groupId, title) =>
              void handleRenameProjectDocumentGroup(groupId, title)
            }
            onRestore={(documentId) =>
              void handleRestoreProjectDocument(documentId)
            }
            onRoleChange={(documentId, role) =>
              void handleUpdateProjectDocument(documentId, { role })
            }
            onSelect={(documentId) =>
              void handleSelectProjectDocument(documentId)
            }
          />
        ) : null}
        <DocumentOutline headings={headings} />
        <VersionHistoryPanel
          key={`version-history:${activeDocumentId ?? "none"}`}
          comments={comments}
          isProjectMode={isProjectMode}
          patches={patches}
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
                disabled={isSaving || isReanchorMode}
                onClick={handleOpenProjectFolder}
              >
                Open Project Folder
              </button>
              <button
                type="button"
                disabled={isSaving || isReanchorMode}
                onClick={handleOpenLegacyProjectAssembly}
              >
                Create Project From Existing Patchmark Projects
              </button>
              <button
                type="button"
                disabled={!fileName || isProjectMode || isSaving || isReanchorMode}
                onClick={handleCreateProjectFromCurrentDocument}
              >
                Create Project From Current Document
              </button>
            <button
              type="button"
              disabled={isSaving || isCommentBusy || isReanchorMode}
              onClick={handleGenerateChatGptPrompt}
            >
              Generate ChatGPT Prompt
            </button>
            <button
              type="button"
              disabled={isSaving || isCommentBusy || isReanchorMode}
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
                  <span>Project: {getProjectTitle(projectHandle)}</span>
                  {activeDocumentGroup ? (
                    <span>Group: {activeDocumentGroup.title}</span>
                  ) : null}
                  <span>
                    Document:{" "}
                    {projectHandle.document?.display_title ??
                      projectHandle.manifest.document_file}
                  </span>
                </>
              ) : null}
            </div>

            {fileName ? (
              <div className="document-meta">
                <span>{isProjectMode ? "Project / document" : "Loaded file"}</span>
                <strong title={fileName}>
                  {projectHandle
                    ? [
                        getProjectTitle(projectHandle),
                        activeDocumentGroup?.title,
                        projectHandle.document?.display_title ?? fileName
                      ]
                        .filter(Boolean)
                        .join(" / ")
                    : fileName}
                </strong>
                <DocumentStatus status={documentStatus} />
              </div>
            ) : null}
          </div>

          {fileName ? (
            <div className="document-toolbar-controls">
              <DocumentActions
                fileName={fileName}
                isSaving={
                  isSaving ||
                  isProjectDataLoading ||
                  isProjectRecoveryReadOnly ||
                  isReanchorMode
                }
                markdown={markdown}
                onCreateSnapshot={handleCreateSnapshot}
                onDownload={handleDownload}
                onExportPdf={() =>
                  setPdfExportTarget({
                    documentId:
                      projectHandle?.document?.document_id ?? null,
                    fileName,
                    markdown
                  })
                }
                onSaveAs={handleSaveAs}
                onSaveChanges={handleSaveChanges}
                showCreateSnapshot={isProjectMode}
              />
              {readingBookmark ? (
                <div
                  className="reading-bookmark-controls"
                  aria-label="Reading bookmark controls"
                  key={`controls:${activeDocumentKey}`}
                >
                  {readingBookmarkResolution?.state === "available" ? (
                    <button
                      type="button"
                      disabled={isReadingBookmarkBusy || isReanchorMode}
                      onClick={() => void handleContinueReading()}
                    >
                      Continue reading
                    </button>
                  ) : (
                    <>
                      <span role="status">Bookmark location unavailable</span>
                      <button
                        type="button"
                        disabled={isReadingBookmarkBusy || isReanchorMode}
                        onClick={() => void handleRemoveReadingBookmark()}
                      >
                        Remove unavailable bookmark
                      </button>
                    </>
                  )}
                </div>
              ) : null}
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

        {projectRecovery ? (
          <div
            className="document-save-banner document-save-banner-info project-recovery-banner"
            role="status"
          >
            <strong>{projectRecovery.message}</strong>
            {projectRecovery.canRestore ? (
              <button
                type="button"
                disabled={isSaving}
                onClick={handleRestoreProjectRecovery}
              >
                Restore last complete save
              </button>
            ) : null}
            <details>
              <summary>Show technical details</summary>
              <ul>
                {projectRecovery.technicalDetails.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
                {projectRecovery.temporaryFiles.length > 0 ? (
                  <li>
                    Unfinished temporary files: {projectRecovery.temporaryFiles.join(", ")}
                  </li>
                ) : null}
              </ul>
            </details>
          </div>
        ) : null}

        {saveFeedback ? (
          <div
            className={`document-save-banner document-save-banner-${saveFeedback.kind}`}
            role={saveFeedback.kind === "error" ? "alert" : "status"}
          >
            {saveFeedback.message}
          </div>
        ) : null}

        {reanchorSession ? (
          <section className="reanchor-mode-panel" aria-label="Re-anchor comment">
            <div className="reanchor-mode-header">
              <div>
                <span>Re-anchoring comment</span>
                <strong>{reanchorSession.commentId}</strong>
                <p>
                  Choose a suggested location or select new text in the document.
                  Document editing is temporarily read-only.
                </p>
              </div>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={cancelReanchorMode}
              >
                Cancel
              </button>
            </div>

            {reanchorSession.candidates.length > 0 ? (
              <div className="reanchor-candidate-list">
                {reanchorSession.candidates.map((candidate, index) => (
                  <article
                    className="reanchor-candidate-card"
                    data-previewed={
                      reanchorSession.previewProposal?.id === candidate.id
                        ? "true"
                        : undefined
                    }
                    key={candidate.id}
                  >
                    <span>Possible location {index + 1}</span>
                    <strong>
                      {candidate.containingHeading ?? "Document beginning"}
                    </strong>
                    <small>{candidate.structureLabel}</small>
                    <p>“…{candidate.contextExcerpt.slice(0, 220)}…”</p>
                    <div>
                      <button
                        type="button"
                        onClick={() => handleShowReanchorCandidate(candidate)}
                      >
                        Show in document
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUseReanchorCandidate(candidate)}
                      >
                        Use this location
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="reanchor-empty-candidates">
                Patchmark did not find a safe suggested location. Select the
                relevant current text manually.
              </p>
            )}

            <div className="reanchor-manual-selection">
              <div>
                <strong>Select new text manually</strong>
                <span>
                  Current mode: {mode === "visual" ? "Visual Mode" : "Markdown Mode"}
                </span>
              </div>
              <button
                type="button"
                disabled={!selectedCommentDraft || isCommentBusy}
                onClick={handleUseSelectionForReanchor}
              >
                Use selection as new anchor
              </button>
            </div>

            {reanchorSession.error ? (
              <p className="comments-error" role="alert">
                {reanchorSession.error}
              </p>
            ) : null}
          </section>
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
          data-document-key={activeDocumentKey ?? undefined}
          onClick={handleEditorClick}
          onContextMenu={handleEditorContextMenu}
          onMouseUp={handleEditorMouseUp}
        >
          {fileName ? (
            mode === "visual" ? (
              <VisualMarkdownEditor
                key={documentVersion}
                markdown={markdown}
                onMarkdownChange={(nextMarkdown) =>
                  handleMarkdownChange(nextMarkdown, "manual_visual")
                }
                readOnly={isProjectRecoveryReadOnly || isReanchorMode}
              />
            ) : (
              <MarkdownSourceEditor
                markdown={markdown}
                onMarkdownChange={(nextMarkdown, hint) =>
                  handleMarkdownChange(nextMarkdown, "manual_source", hint)
                }
                onSelectionChange={setMarkdownSelection}
                readOnly={isProjectRecoveryReadOnly || isReanchorMode}
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
          {mode === "visual" &&
          readingBookmark &&
          readingBookmarkPosition?.documentKey === activeDocumentKey ? (
            <div
              key={`marker:${activeDocumentKey}`}
              className="reading-bookmark-marker"
              style={{ top: readingBookmarkPosition.top }}
            >
              <button
                ref={readingBookmarkMarkerRef}
                type="button"
                aria-controls={readingBookmarkMenuId}
                aria-expanded={isReadingBookmarkMenuOpen}
                aria-haspopup="menu"
                aria-label="Current reading bookmark. Open bookmark actions."
                className="reading-bookmark-indicator"
                onClick={(event) => {
                  event.stopPropagation();
                  const markerDocumentKey = activeDocumentKey;
                  setReadingBookmarkMenuDocumentKey((currentKey) =>
                    currentKey === markerDocumentKey ? null : markerDocumentKey
                  );
                }}
                title="Current reading bookmark"
              >
                <span aria-hidden="true">🔖</span>
              </button>
              {isReadingBookmarkMenuOpen ? (
                <div
                  ref={readingBookmarkMenuRef}
                  id={readingBookmarkMenuId}
                  className="reading-bookmark-action-menu"
                  role="menu"
                  aria-label="Reading bookmark actions"
                  key={`menu:${activeDocumentKey}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    ref={readingBookmarkRemoveButtonRef}
                    type="button"
                    role="menuitem"
                    disabled={isReadingBookmarkBusy || isReanchorMode}
                    onClick={() => void handleRemoveReadingBookmark()}
                  >
                    Remove bookmark
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="comments-rail" aria-label="Document comments">
        <CommentsPanel
          key={`comments:${activeDocumentId ?? "none"}`}
          addRequest={commentAddRequest}
          activeCommentState={activeCommentState}
          anchorSummaries={commentAnchorSummaries}
          commentPositions={commentPositions}
          comments={comments}
          defaultSectionLine={defaultCommentHeading?.line ?? null}
          error={commentsError}
          headings={headings}
          isBusy={isCommentBusy || isReanchorMode}
          isProjectMode={isProjectMode}
          onAddComment={handleAddComment}
          onDeleteComment={handleDeleteComment}
          onEditComment={handleEditComment}
          onEditReply={handleEditCommentReply}
          onFindComment={handleFindComment}
          onMarkCommentForExport={handleMarkCommentForExport}
          onReopenComment={handleReopenComment}
          onReplyComment={handleReplyToComment}
          onReviewCommentPatches={handleReviewCommentPatches}
          onStartReanchor={handleStartReanchor}
          onReviewFirstPendingPatch={handleReviewFirstPendingPatch}
          onResolveComment={handleResolveComment}
          onSetActiveCommentState={setActiveCommentState}
          onUnmarkCommentForExport={handleUnmarkCommentForExport}
          patchGroupSummariesByCommentId={patchGroupSummariesByCommentId}
          pendingPatchGroupTotal={pendingPatchGroups.length}
          pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
          pendingPatchTotal={pendingPatches.length}
          replyRequest={commentReplyRequest}
          selectedTextPreview={selectedCommentText || null}
          selectedAnchorContextKind={selectedCommentAnchorContextKind}
        />
      </aside>

      {commentContextMenu ? (
        <div
          className="comment-context-menu"
          style={{ left: commentContextMenu.x, top: commentContextMenu.y }}
          role="menu"
          aria-label="Patchmark document menu"
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
          <button
            type="button"
            role="menuitem"
            disabled={
              !isProjectMode ||
              isReadingBookmarkBusy ||
              (!commentContextMenu.selectedDraft &&
                !commentContextMenu.defaultHeadingLine)
            }
            onClick={() => void handleSetReadingBookmarkFromMenu()}
          >
            Set reading bookmark
          </button>
          {!isProjectMode ? (
            <span className="comment-context-menu-note">
              Reading bookmarks require Project Folder Mode.
            </span>
          ) : null}
        </div>
      ) : null}

      {reanchorSession && reanchorConfirmation ? (
        <div className="snapshot-dialog-backdrop">
          <section
            className="comment-export-dialog reanchor-confirmation-dialog"
            aria-label="Confirm comment re-anchor"
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Re-anchor comment</span>
                <h2>Confirm the new document target</h2>
                <p>
                  Review the current historical target and the proposed current
                  anchor before saving.
                </p>
              </div>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setReanchorConfirmation(null)}
              >
                Cancel
              </button>
            </header>
            <div className="reanchor-confirmation-body">
              <section className="reanchor-confirmation-card">
                <span>Current / historical anchor</span>
                <strong>
                  {getSelectedTextCommentAnchor(
                    commentsById.get(reanchorSession.commentId)
                  )?.containing_heading ?? "No containing heading"}
                </strong>
                <small>
                  State: {getHumanAnchorStateLabel(reanchorSession.previousStatus)}
                </small>
                <blockquote>
                  {getSelectedTextCommentAnchor(
                    commentsById.get(reanchorSession.commentId)
                  )?.selected_text ?? ""}
                </blockquote>
              </section>
              <section className="reanchor-confirmation-card">
                <span>New proposed anchor</span>
                <strong>
                  {reanchorConfirmation.containingHeading ??
                    "Document beginning"}
                </strong>
                <small>{reanchorConfirmation.structureLabel}</small>
                <MarkdownSnippetPreview markdown={reanchorConfirmation.selectedText} />
                <p>{reanchorConfirmation.contextExcerpt}</p>
              </section>
            </div>
            <div className="comment-export-actions reanchor-confirmation-actions">
              <button
                className="document-action-primary"
                type="button"
                disabled={isCommentBusy}
                onClick={() => void handleConfirmReanchor()}
              >
                Confirm re-anchor
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setReanchorConfirmation(null)}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {snapshotDialog && snapshotDialog.documentId === activeDocumentId ? (
        <SnapshotDialog
          dialog={snapshotDialog}
          onClose={() => setSnapshotDialog(null)}
        />
      ) : null}

      {isLegacyProjectAssemblyOpen ? (
        <LegacyProjectAssemblyDialog
          onClose={() => setIsLegacyProjectAssemblyOpen(false)}
          onComplete={handleLegacyProjectAssemblyComplete}
        />
      ) : null}

      {pdfExportTarget ? (
        <PdfExportPreview
          fileName={pdfExportTarget.fileName}
          markdown={pdfExportTarget.markdown}
          onClose={() => setPdfExportTarget(null)}
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
          commentsById={commentsById}
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
          allPatches={patches}
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
          followUpRelationship={selectedPatchFollowUpRelationship}
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
            setRecentlyAppliedPatchId(null);
          }}
          onFindPatchAnchorText={() => handleFindPatchAnchorText(selectedPatch)}
          onContinueDiscussion={() =>
            handleContinuePatchDiscussion(selectedPatch)
          }
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
          project={projectHandle}
          showApplyCompletion={recentlyAppliedPatchId === selectedPatch.id}
          reviewablePatchCount={reviewablePatches.length}
        />
      ) : null}
    </section>
  );
}

function PatchGroupListDialog({
  commentsById,
  groups,
  onClose,
  onOpenGroup,
  scopeLabel
}: {
  commentsById: Map<string, PatchmarkComment>;
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
                comment={
                  group.comment_id ? commentsById.get(group.comment_id) ?? null : null
                }
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
  allPatches,
  comment,
  group,
  isPatchActionBusy,
  onClose,
  onRejectPendingPatches,
  onReviewPatch
}: {
  allPatches: PatchmarkPatch[];
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
                  allPatches={allPatches}
                  comment={comment}
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
  comment,
  group,
  onOpenGroup
}: {
  comment: PatchmarkComment | null;
  group: DerivedPatchGroup;
  onOpenGroup: (groupId: string) => void;
}) {
  const groupTitle = getPatchGroupDisplayTitle(group.patches, comment);

  return (
    <article className="patch-group-summary-card">
      <div>
        <span className={`patch-group-status patch-group-status-${group.status}`}>
          {getPatchGroupStatusLabel(group.status)}
        </span>
        <h3>{groupTitle}</h3>
        <span>{formatPatchDate(group.created_at)}</span>
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
        <details className="patch-group-technical-details">
          <summary>Details</summary>
          <span>Patch group ID: {group.display_id}</span>
          {group.comment_id ? (
            <span>Linked comment ID: {group.comment_id}</span>
          ) : null}
        </details>
      </div>
      <button type="button" onClick={() => onOpenGroup(group.id)}>
        Review group
      </button>
    </article>
  );
}

function PatchGroupPatchCard({
  allPatches,
  comment,
  group,
  index,
  onReviewPatch,
  patch
}: {
  allPatches: PatchmarkPatch[];
  comment: PatchmarkComment | null;
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
  const patchTitle = getPatchDisplayTitle(patch, {
    comment,
    includeGroupPosition: true
  });
  const followUpRelationship = getPatchFollowUpRelationship({
    comment,
    patch,
    patches: allPatches
  });

  return (
    <article
      className={`patch-group-patch-card patch-group-patch-card-${displayState}`}
    >
      <div>
        <div className="patch-group-patch-heading">
          <strong>{patchTitle}</strong>
          <span className={`patch-status-badge patch-status-badge-${displayState}`}>
            {getPatchStatusBadgeLabel(displayState)}
          </span>
        </div>
        <span>
          Patch {index + 1} of {group.patches.length}
        </span>
        {lifecycleDetail ? <span>{lifecycleDetail}</span> : null}
        {followUpRelationship ? (
          <span className="patch-follow-up-inline">
            Refines: {followUpRelationship.display_title}
          </span>
        ) : null}
        <details className="patch-group-technical-details">
          <summary>Details</summary>
          <span>Patch ID: {patch.id}</span>
          {snapshotDetail ? <span>{snapshotDetail}</span> : null}
          <span>Target: {patch.target_heading ?? "Not specified"}</span>
          <span>{getPatchReviewAnchorShortLabel(anchorStatus)}</span>
        </details>
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
  followUpRelationship,
  hasMultipleReviewablePatches,
  isPatchActionBusy,
  markdown,
  onAcceptPatch,
  onBackToGroup,
  onClose,
  onContinueDiscussion,
  onFindPatchAnchorText,
  onNextPatch,
  onPreviousPatch,
  onRejectPatch,
  onUpdatePatchAnchor,
  patch,
  patchGroup,
  patchIndex,
  project,
  reviewablePatchCount,
  showApplyCompletion
}: {
  anchorStatus: PatchReviewAnchorStatus;
  comment: PatchmarkComment | null;
  followUpRelationship: PatchFollowUpRelationship | null;
  hasMultipleReviewablePatches: boolean;
  isPatchActionBusy: boolean;
  markdown: string;
  onAcceptPatch: () => void;
  onBackToGroup?: () => void;
  onClose: () => void;
  onContinueDiscussion: () => void;
  onFindPatchAnchorText: () => void;
  onNextPatch: () => void;
  onPreviousPatch: () => void;
  onRejectPatch: () => void;
  onUpdatePatchAnchor: () => void;
  patch: PatchmarkPatch;
  patchGroup: DerivedPatchGroup | null;
  patchIndex: number;
  project: PatchmarkProjectHandle | null;
  reviewablePatchCount: number;
  showApplyCompletion: boolean;
}) {
  const latestChatGptReply = comment
    ? getLatestChatGptThreadEntry(comment)
    : null;
  const suggestedTextSources = patch.suggested_text_sources ?? [];
  const reasonSources = patch.reason_sources ?? patch.sources ?? [];
  const riskSources = patch.risk_sources ?? [];
  const [reviewMode, setReviewMode] = useState<PatchReviewMode>("visual");
  const [preApplySnapshotMarkdown, setPreApplySnapshotMarkdown] = useState<
    string | null
  >(null);
  const appliedReviewContent = useMemo(
    () =>
      patch.status === "accepted" && anchorStatus.kind === "accepted"
        ? createAppliedPatchReviewContent({
            anchorStatus,
            patch,
            preApplySnapshotMarkdown
          })
        : null,
    [anchorStatus, patch, preApplySnapshotMarkdown]
  );
  const visualPreview = useMemo(
    () =>
      createPatchVisualPreview({
        acceptedReviewContent: appliedReviewContent,
        anchorStatus,
        markdown,
        patch,
        preApplySnapshotMarkdown
      }),
    [anchorStatus, appliedReviewContent, markdown, patch, preApplySnapshotMarkdown]
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
  const canContinueDiscussion =
    patch.status === "accepted" && comment?.status === "open";
  const patchDisplayState = getPatchDisplayState(patch, anchorStatus);
  const patchTitleInfo = getPatchDisplayTitleInfo(patch, {
    comment,
    includeGroupPosition: hasMultipleReviewablePatches
  });

  useEffect(() => {
    setReviewMode("visual");
  }, [patch.id]);

  useEffect(() => {
    let isCancelled = false;

    setPreApplySnapshotMarkdown(null);

    if (
      patch.status !== "accepted" ||
      !project ||
      !patch.pre_apply_snapshot_file
    ) {
      return () => {
        isCancelled = true;
      };
    }

    const snapshotVersion: PatchmarkVersionEntry = {
      id: patch.pre_apply_snapshot_id ?? patch.pre_apply_snapshot_file,
      file: patch.pre_apply_snapshot_file,
      created_at: patch.applied_at ?? patch.accepted_at ?? patch.created_at,
      reason: `before accepting patch ${patch.id}`
    };

    void readProjectVersionMarkdown(project, snapshotVersion)
      .then((snapshotMarkdown) => {
        if (!isCancelled) {
          setPreApplySnapshotMarkdown(snapshotMarkdown);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setPreApplySnapshotMarkdown(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [patch, project]);

  return (
    <div className="snapshot-dialog-backdrop patch-review-backdrop">
      <section className="patch-review-dialog" aria-label="Review Patch Proposal">
        <header className="snapshot-dialog-header">
          <div>
            <span>Patch proposal</span>
            <div className="patch-review-heading-row">
              <h2>{patchTitleInfo.title}</h2>
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

        {followUpRelationship ? (
          <div className="patch-follow-up-context" role="note">
            <strong>Follow-up change</strong>
            <span>
              {patch.status === "accepted" ? "Follow-up to" : "Refines"}: {followUpRelationship.display_title}
            </span>
          </div>
        ) : null}

        {canContinueDiscussion ? (
          <div className="patch-apply-completion" role="status">
            <div>
              <strong>
                {showApplyCompletion
                  ? "Patch applied"
                  : "Continue linked discussion"}
              </strong>
              <span>
                The linked comment remains open. Continue the discussion if you
                want another refinement.
              </span>
            </div>
            <button
              type="button"
              disabled={isPatchActionBusy}
              onClick={onContinueDiscussion}
            >
              Continue discussion
            </button>
          </div>
        ) : null}

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
                <dt>Display title</dt>
                <dd>{patchTitleInfo.title}</dd>
              </div>
              <div>
                <dt>Title source</dt>
                <dd>{formatPatchTitleSource(patchTitleInfo.source)}</dd>
              </div>
              <div>
                <dt>Patch ID</dt>
                <dd>{patch.id}</dd>
              </div>
              {followUpRelationship ? (
                <>
                  <div>
                    <dt>Earlier patch ID</dt>
                    <dd>{followUpRelationship.patch_id}</dd>
                  </div>
                  <div>
                    <dt>Earlier patch applied</dt>
                    <dd>{formatPatchDate(followUpRelationship.applied_at)}</dd>
                  </div>
                </>
              ) : null}
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
                <>
                  <div>
                    <dt>Match method</dt>
                    <dd>{getPatchReviewMatchMethodLabel(anchorStatus.matchMethod)}</dd>
                  </div>
                  <div>
                    <dt>Matching locations</dt>
                    <dd>
                      {getPatchReviewMatchingLocationsLabel({
                        cardinality: anchorStatus.matchCardinality,
                        count: anchorStatus.matches.length
                      })}
                    </dd>
                  </div>
                </>
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
            <>
              <div className="patch-review-preview-grid">
                <section className="patch-review-card">
                  <h3>
                    {patch.status === "accepted"
                      ? "Original before patch"
                      : "Current"}
                  </h3>
                  <MarkdownSnippetPreview markdown={visualPreview.originalMarkdown} />
                  {visualPreview.originalIsMalformedTableFragment ? (
                    <p className="patch-review-preview-note">
                      This snippet looks like table Markdown but has adjacent row
                      delimiters or missing row newlines, so Visual mode does not
                      invent table structure.
                    </p>
                  ) : appliedReviewContent?.originalSource === "pre_apply_snapshot" ? (
                    <p className="patch-review-preview-note">
                      Original text was recovered from the pre-apply snapshot for
                      display only. Patch history was not changed.
                    </p>
                  ) : appliedReviewContent?.originalSource === "unavailable" ? (
                    <p className="patch-review-preview-note">
                      Patchmark could not safely recover the original text for
                      this legacy patch.
                    </p>
                  ) : visualPreview.usesCurrentMatchingRow ? (
                    <p className="patch-review-preview-note">
                      Preview uses the current matching table row. Markdown
                      Source shows the imported original_text until you update
                      the patch anchor.
                    </p>
                  ) : visualPreview.usesGenericTableContext ? (
                    <p className="patch-review-preview-note">
                      Generic table headers are shown for readability only
                      because Patchmark could not find the current table header.
                    </p>
                  ) : visualPreview.usesTableContext ? (
                    <p className="patch-review-preview-note">
                      Table header context is shown for readability only. Exact
                      matching still uses the original patch text.
                    </p>
                  ) : null}
                </section>

                <section className="patch-review-card">
                  <h3>
                    {patch.status === "accepted"
                      ? "Applied replacement"
                      : "Proposed"}
                  </h3>
                  <MarkdownSnippetPreview markdown={visualPreview.suggestedMarkdown} />
                  {visualPreview.suggestedIsMalformedTableFragment ? (
                    <p className="patch-review-preview-note">
                      This replacement looks like table Markdown but has adjacent
                      row delimiters or missing row newlines. Markdown Source
                      shows the exact stored replacement.
                    </p>
                  ) : visualPreview.usesGenericTableContext ? (
                    <p className="patch-review-preview-note">
                      Generic table headers are display-only and will not be
                      stored with the patch.
                    </p>
                  ) : visualPreview.usesTableContext ? (
                    <p className="patch-review-preview-note">
                      Table header context is display-only and will not be
                      stored with the patch.
                    </p>
                  ) : null}
                  <PatchSourceList
                    label="Suggested text sources"
                    sources={suggestedTextSources}
                  />
                </section>
              </div>

              {visualPreview.currentMarkdown ? (
                <section className="patch-review-card">
                  <h3>Current text after later changes</h3>
                  <MarkdownSnippetPreview markdown={visualPreview.currentMarkdown} />
                  {visualPreview.currentIsMalformedTableFragment ? (
                    <p className="patch-review-preview-note">
                      This current text looks like table Markdown but has adjacent
                      row delimiters or missing row newlines, so Visual mode does
                      not invent table structure.
                    </p>
                  ) : visualPreview.currentUsesGenericTableContext ? (
                    <p className="patch-review-preview-note">
                      Generic table headers are display-only because Patchmark
                      could not find the current table header.
                    </p>
                  ) : visualPreview.currentUsesTableContext ? (
                    <p className="patch-review-preview-note">
                      Table header context is display-only for current-state
                      readability.
                    </p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : (
            <>
              {patch.status === "accepted" && appliedReviewContent ? (
                <>
                  <section className="patch-review-card">
                    <h3>Original before patch</h3>
                    <p className="patch-review-source-note">
                      {getAcceptedOriginalSourceNote(
                        appliedReviewContent.originalSource
                      )}
                    </p>
                    {appliedReviewContent.originalSource === "unavailable" ? (
                      <p>{appliedReviewContent.originalMarkdown}</p>
                    ) : (
                      <pre>{appliedReviewContent.originalMarkdown}</pre>
                    )}
                  </section>

                  <section className="patch-review-card">
                    <h3>Applied replacement</h3>
                    <p className="patch-review-source-note">
                      Exact Markdown replacement accepted at application time.
                    </p>
                    <pre>{appliedReviewContent.appliedMarkdown}</pre>
                    <PatchSourceList
                      label="Suggested text sources"
                      sources={suggestedTextSources}
                    />
                  </section>

                  {appliedReviewContent.currentMarkdown ? (
                    <section className="patch-review-card">
                      <h3>Current text after later changes</h3>
                      <p className="patch-review-source-note">
                        Exact current Markdown found through applied-anchor and
                        lineage validation.
                      </p>
                      <pre>{appliedReviewContent.currentMarkdown}</pre>
                    </section>
                  ) : null}
                </>
              ) : (
                <>
                  <section className="patch-review-card">
                    <h3>Original text</h3>
                    <p className="patch-review-source-note">
                      Exact Markdown Patchmark will use for
                      matching/replacement in Phase 3B.
                    </p>
                    <pre>{patch.original_text}</pre>
                  </section>

                  <section className="patch-review-card">
                    <h3>Suggested replacement</h3>
                    <p className="patch-review-source-note">
                      Exact Markdown Patchmark will use for
                      matching/replacement in Phase 3B.
                    </p>
                    <pre>{patch.suggested_text}</pre>
                    <PatchSourceList
                      label="Suggested text sources"
                      sources={suggestedTextSources}
                    />
                  </section>
                </>
              )}
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
  currentMarkdown?: string;
  currentIsMalformedTableFragment: boolean;
  currentUsesGenericTableContext: boolean;
  currentUsesTableContext: boolean;
  originalIsMalformedTableFragment: boolean;
  originalMarkdown: string;
  suggestedIsMalformedTableFragment: boolean;
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

function createPatchVisualPreview({
  acceptedReviewContent,
  anchorStatus,
  markdown,
  patch,
  preApplySnapshotMarkdown
}: {
  acceptedReviewContent: AppliedPatchReviewContent | null;
  anchorStatus?: PatchReviewAnchorStatus;
  markdown: string;
  patch: PatchmarkPatch;
  preApplySnapshotMarkdown?: string | null;
}): PatchVisualPreview {
  if (patch.status === "accepted") {
    const reviewContent =
      acceptedReviewContent ??
      (anchorStatus?.kind === "accepted"
        ? createAppliedPatchReviewContent({
            anchorStatus,
            patch,
            preApplySnapshotMarkdown
          })
        : null);
    const appliedMarkdown = reviewContent?.appliedMarkdown ?? getPatchAppliedText(patch);
    const originalMarkdown =
      reviewContent?.originalMarkdown ??
      (patch.original_text.length > 0
        ? patch.original_text
        : "Original text unavailable for this historical patch.");
    const originalPreview =
      reviewContent?.originalSource === "unavailable"
        ? {
            isMalformedTableFragment: false,
            markdown: originalMarkdown,
            usesGenericTableContext: false,
            usesTableContext: false
          }
        : createPatchReviewSnippetPreview({
            contextMarkdown: preApplySnapshotMarkdown ?? markdown,
            pairedMarkdown: appliedMarkdown,
            patch,
            snippetMarkdown: originalMarkdown
          });
    const appliedPreview = createPatchReviewSnippetPreview({
      contextMarkdown: markdown,
      pairedMarkdown: originalMarkdown,
      patch,
      snippetMarkdown: appliedMarkdown
    });
    const currentPreview = reviewContent?.currentMarkdown
      ? createPatchReviewSnippetPreview({
          contextMarkdown: markdown,
          pairedMarkdown: appliedMarkdown,
          patch,
          snippetMarkdown: reviewContent.currentMarkdown
        })
      : null;

    return {
      currentIsMalformedTableFragment:
        currentPreview?.isMalformedTableFragment ?? false,
      currentMarkdown: currentPreview?.markdown,
      currentUsesGenericTableContext:
        currentPreview?.usesGenericTableContext ?? false,
      currentUsesTableContext: currentPreview?.usesTableContext ?? false,
      originalIsMalformedTableFragment: originalPreview.isMalformedTableFragment,
      originalMarkdown: originalPreview.markdown,
      suggestedIsMalformedTableFragment: appliedPreview.isMalformedTableFragment,
      suggestedMarkdown: appliedPreview.markdown,
      usesCurrentMatchingRow: false,
      usesGenericTableContext:
        originalPreview.usesGenericTableContext ||
        appliedPreview.usesGenericTableContext,
      usesTableContext:
        originalPreview.usesTableContext || appliedPreview.usesTableContext
    };
  }

  const tableContext = getPatchTablePreviewContext(
    markdown,
    patch.original_text,
    patch.suggested_text
  );

  if (tableContext) {
    return {
      currentIsMalformedTableFragment: false,
      originalMarkdown: [
        tableContext.headerRow,
        tableContext.separatorRow,
        patch.original_text.trim()
      ].join("\n"),
      originalIsMalformedTableFragment: false,
      suggestedIsMalformedTableFragment: false,
      suggestedMarkdown: [
        tableContext.headerRow,
        tableContext.separatorRow,
        patch.suggested_text.trim()
      ].join("\n"),
      currentUsesGenericTableContext: false,
      currentUsesTableContext: false,
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
      currentIsMalformedTableFragment: false,
      originalMarkdown: [
        fallbackTableContext.headerRow,
        fallbackTableContext.separatorRow,
        fallbackTableContext.originalRow
      ].join("\n"),
      originalIsMalformedTableFragment: false,
      suggestedIsMalformedTableFragment: false,
      suggestedMarkdown: [
        fallbackTableContext.headerRow,
        fallbackTableContext.separatorRow,
        fallbackTableContext.suggestedRow
      ].join("\n"),
      currentUsesGenericTableContext: false,
      currentUsesTableContext: false,
      usesCurrentMatchingRow: fallbackTableContext.usesCurrentMatchingRow,
      usesGenericTableContext: fallbackTableContext.usesGenericTableContext,
      usesTableContext: true
    };
  }

  return {
    currentIsMalformedTableFragment: false,
    currentUsesGenericTableContext: false,
    currentUsesTableContext: false,
    originalIsMalformedTableFragment: false,
    originalMarkdown: patch.original_text,
    suggestedIsMalformedTableFragment: false,
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
    !isSingleMarkdownTableDataRowSnippet(patch.original_text) ||
    !isSingleMarkdownTableDataRowSnippet(patch.suggested_text)
  ) {
    return null;
  }

  const tableRowRebase =
    anchorStatus?.kind === "pending" ? anchorStatus.tableRowRebase : undefined;
  const rowCellCount = Math.max(
    parseMarkdownTableRow(tableRowRebase?.currentRowText ?? patch.original_text)
      .length,
    getMarkdownTableDataSnippetCellCount(patch.suggested_text)
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
  return getMarkdownTableDataRows(markdown).length > 0;
}

function isSingleMarkdownTableDataRowSnippet(markdown: string): boolean {
  return getMarkdownTableDataRows(markdown).length === 1;
}

function getMarkdownTableDataRows(markdown: string): string[] {
  const lines = markdown
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cellCounts = lines.map((line) => parseMarkdownTableRow(line).length);
  const expectedCellCount = cellCounts[0] ?? 0;

  if (
    lines.length === 0 ||
    expectedCellCount < 2 ||
    lines.some(hasAdjacentTableRowDelimiter)
  ) {
    return [];
  }

  return lines.every(
    (line, index) =>
      isMarkdownTableRowLine(line) &&
      !isMarkdownTableSeparatorRow(line) &&
      cellCounts[index] === expectedCellCount
  )
    ? lines
    : [];
}

function getMarkdownTableDataSnippetCellCount(markdown: string): number {
  const rows = getMarkdownTableDataRows(markdown);

  return rows.reduce(
    (largestCellCount, row) =>
      Math.max(largestCellCount, parseMarkdownTableRow(row).length),
    0
  );
}

function hasAdjacentTableRowDelimiter(line: string): boolean {
  const withoutOuterDelimiters = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "");

  return /\|\s*\|/.test(withoutOuterDelimiters);
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

function getAcceptedOriginalSourceNote(
  source: AppliedPatchOriginalSource
): string {
  if (source === "pre_apply_snapshot") {
    return "Recovered from the pre-apply snapshot for historical review. Patch history was not changed.";
  }

  if (source === "unavailable") {
    return "Original text unavailable for this historical patch.";
  }

  return "Exact persisted Markdown that existed before this patch was applied.";
}

type ProjectDocumentUiState = {
  activeCommentState: ActiveCommentState;
  markdownSelection: MarkdownSelection;
  mode: EditorMode;
  scrollY: number;
};

function persistProjectDocumentUiState(
  project: PatchmarkProjectHandle,
  state: ProjectDocumentUiState
): void {
  const key = getProjectDocumentUiStateKey(project);
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    return;
  }
}

function readProjectDocumentUiState(
  project: PatchmarkProjectHandle
): ProjectDocumentUiState | null {
  const key = getProjectDocumentUiStateKey(project);
  if (!key) {
    return null;
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      !("mode" in value) ||
      (value.mode !== "visual" && value.mode !== "markdown") ||
      !("scrollY" in value) ||
      typeof value.scrollY !== "number" ||
      !("markdownSelection" in value) ||
      !value.markdownSelection ||
      typeof value.markdownSelection !== "object" ||
      !("start" in value.markdownSelection) ||
      !("end" in value.markdownSelection) ||
      typeof value.markdownSelection.start !== "number" ||
      typeof value.markdownSelection.end !== "number"
    ) {
      return null;
    }
    return {
      activeCommentState: parseStoredActiveCommentState(
        "activeCommentState" in value ? value.activeCommentState : null
      ),
      markdownSelection: {
        start: value.markdownSelection.start,
        end: value.markdownSelection.end
      },
      mode: value.mode,
      scrollY: value.scrollY
    };
  } catch {
    return null;
  }
}

function parseStoredActiveCommentState(value: unknown): ActiveCommentState {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    return { kind: "none" };
  }
  if (value.kind === "comment" && "commentId" in value) {
    return typeof value.commentId === "string" && value.commentId.trim()
      ? { kind: "comment", commentId: value.commentId }
      : { kind: "none" };
  }
  if (
    value.kind === "anchor_group" &&
    "commentIds" in value &&
    Array.isArray(value.commentIds) &&
    value.commentIds.every(
      (commentId): commentId is string =>
        typeof commentId === "string" && Boolean(commentId.trim())
    )
  ) {
    return value.commentIds.length > 0
      ? { kind: "anchor_group", commentIds: value.commentIds }
      : { kind: "none" };
  }
  return { kind: "none" };
}

function getProjectDocumentUiStateKey(
  project: PatchmarkProjectHandle
): string | null {
  if (!project.projectManifest || !project.document) {
    return null;
  }
  return `patchmark:document-ui:${project.projectManifest.project_id}:${project.document.document_id}`;
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
    dedicatedDocumentReview,
    observedAt
  }: {
    dedicatedDocumentReview: boolean;
    observedAt: string;
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

Prefer small exact patches over rewriting the whole document, except when a change must be atomic to preserve valid Markdown structure. Structural table changes must use one complete-table patch.
`
    : "";

  return `# Patchmark Focused Comments Review

You are helping review and improve a Markdown document through Patchmark.

Patchmark is the source of truth for the document. You are not editing the document directly. You are replying to focused comments and, when useful, proposing reviewable patches.

Patchmark is the document control layer. ChatGPT is the reasoning/review layer. The human user is the bridge.

One or more earlier patches linked to a comment may already have been applied. Treat the supplied current Markdown as the source of truth.

Answer the latest user follow-up in the existing comment discussion. If a further document change is useful, propose a new patch using exact \`original_text\` from the current Markdown context.

Do not describe a new proposal as a revision of an already accepted patch. Earlier accepted patches are immutable history. Only the human can apply or reject a new patch, and only the human can resolve the comment.

## Collaboration Rules

- Reply to each exported comment by \`comment_id\`.
- Do not resolve comments.
- Only the human user can resolve comments in Patchmark.
- If a comment needs clarification, ask a question linked to that \`comment_id\`.
- If you suggest a document change, return a patch proposal linked to the \`comment_id\`.
- If one comment requires multiple document changes, return multiple \`patch_proposals\` with the same \`comment_id\`.
- Prefer several small exact patch proposals over one large rewrite, except when a change must be atomic to preserve valid Markdown structure. Structural table changes must use one complete-table patch.
- Each \`patch_proposal\` must have its own exact \`original_text\` and \`suggested_text\`.
- Patch proposals must use exact Markdown from the supplied context as \`original_text\`.
- Do not create a patch proposal unless \`original_text\` is copied exactly from the supplied Markdown context.
- Do not create or include \`patch_group_id\`; Patchmark creates patch group IDs during import.
- Each \`patch_proposal\` may include optional \`display_title\`: a concise 3–10 word action title such as \`"Add market signals for sourdough"\`.
- \`display_title\` must be plain text with no technical IDs, URLs, Markdown, citations, or status words.
- Title the new change itself. Do not use vague lineage labels such as \`"Update previous patch"\`, \`"Revise Patch 21"\`, or any technical patch ID.
- Do not rewrite the whole document unless explicitly requested.
- Preserve Markdown structure.
- Be clear about reason and risk/tradeoff.
- Drafting support only. Legal review may still be required.
${dedicatedDocumentReviewNote}

${CHATGPT_ATOMIC_TABLE_PROMPT_RULES}

${CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES}

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

Do not use Markdown links in \`display_title\`.

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

${CHATGPT_INTERNAL_CITATION_PROMPT_RULES}

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

Source date rules:

- Every source object must include \`published_at\` and \`observed_at\`.
- \`published_at\` is required but may be \`null\` when unavailable.
- \`updated_at\` is optional or may be \`null\`.
- \`observed_at\` is required and should normally be the complete date \`${observedAt}\` if you verify the source while answering this export.
- Date metadata must use ISO-style precision: \`YYYY-MM-DD\`, \`YYYY-MM\`, \`YYYY\`, or \`null\` for unknown \`published_at\`.
- Do not invent day or month precision the source does not provide.
- Do not infer publication dates from copyright years, footers, URL paths, search-result dates, cache dates, report numbers, current year, observation date, product availability, analysis periods, or forecast periods.
- If a page shows only an update date, use \`published_at: null\`, put that date in \`updated_at\`, and put the access date in \`observed_at\`.
- Repeated uses of the same URL across source arrays must use consistent \`published_at\`, \`updated_at\`, and \`observed_at\` values.
- Before returning, verify every source object has \`published_at\`, \`observed_at\`, and \`supports\`.

Source object rules:

- Every source must be an object with a raw \`url\` string.
- The \`url\` value must start with \`https://\` or \`http://\`.
- Every source must include \`published_at\`.
- Every source must include \`observed_at\`.
- \`updated_at\` should be included as \`null\` unless an explicit update date is known.
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
- Every newly introduced or materially revised visible Markdown reference in \`suggested_text\` must include the source date in document prose.
- If \`published_at\` is known, write a concise human-readable date near the link, such as \`— published 31 March 2026\`.
- If \`updated_at\` is relevant, write both dates, such as \`— published 12 January 2025; updated 3 June 2026\`.
- If \`published_at\` is \`null\`, write \`publication date unavailable\` and include the observation date near the link.
- For prices, menus, availability, delivery fees, opening hours, promotions, and other dynamic facts, include the observation date even when a publication date exists.
- Keep ISO-style dates in source metadata and human-readable dates in document Markdown.
- Do not rely only on \`suggested_text_sources\` when the task asks for inline references.

Good inline-reference \`suggested_text\`:
\`"Thailand foodservice remains resilient. [USDA FAS Thailand foodservice report](https://apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName?fileName=Food+Service+-+Hotel+Restaurant+Institutional+Annual_Bangkok_Thailand_TH2025-0045.pdf) — published 31 March 2026 — estimated Thailand foodservice at about USD 35.4 billion in 2025."\`

Good live-price \`suggested_text\`:
\`"Competitor pricing remains visible on [Example live menu](https://example.com/menu) — publication date unavailable; prices observed 13 July 2026."\`

Matching live-price source object:
\`{ "title": "Example live menu", "url": "https://example.com/menu", "published_at": null, "updated_at": null, "observed_at": "${observedAt}", "supports": "Shows the menu prices visible on the observation date." }\`

Bad inline-reference \`suggested_text\`:
\`"Thailand foodservice remains resilient. USDA FAS estimated Thailand foodservice at about USD 35.4 billion in 2025, despite modest economic growth."\`

The bad version loses the visible source and source date if Patchmark sidecar metadata is not exported.

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
      "display_title": "Add concise human-readable patch title",
      "target_heading": "## Example Heading",
      "original_text": "Exact Markdown text to replace.",
      "suggested_text": "Replacement Markdown text with [Example source](https://example.com/source) — published 31 March 2026.",
      "suggested_text_sources": [
        {
          "title": "Example source",
          "url": "https://example.com/source",
          "published_at": "2026-03-31",
          "updated_at": null,
          "observed_at": "${observedAt}",
          "supports": "What this source supports."
        }
      ],
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
      "published_at": null,
      "updated_at": null,
      "observed_at": "${observedAt}",
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
  comments,
  existingPatches,
  importedAt,
  importId,
  knownCommentIds,
  patchProposals,
  sourceChatUrl
}: {
  comments: PatchmarkComment[];
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
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));

  return validPatchProposals.map((patchProposal, index) => {
    const currentGroupIndex =
      (groupIndexesByCommentId.get(patchProposal.comment_id) ?? 0) + 1;
    groupIndexesByCommentId.set(
      patchProposal.comment_id,
      currentGroupIndex
    );

    const importedPatch = {
      id: createNextPatchId(existingPatches, index),
      status: "pending" as const,
      patch_group_id: groupIdsByCommentId.get(patchProposal.comment_id),
      patch_group_index: currentGroupIndex,
      patch_group_total:
        groupTotalsByCommentId.get(patchProposal.comment_id) ?? 1,
      comment_id: patchProposal.comment_id,
      source_import_id: importId,
      source_chat_url: sourceChatUrl,
      display_title: patchProposal.display_title,
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
    const displayTitle =
      importedPatch.display_title ??
      createDerivedImportedPatchDisplayTitle({
        comment: commentsById.get(patchProposal.comment_id) ?? null,
        patch: importedPatch
      });

    return {
      ...importedPatch,
      display_title: displayTitle
    };
  });
}

function createDerivedImportedPatchDisplayTitle({
  comment,
  patch
}: {
  comment: PatchmarkComment | null;
  patch: PatchmarkPatch;
}): string | undefined {
  const title = getPatchDisplayTitleInfo(patch, { comment }).title;

  return normalizePatchDisplayTitleCandidate(title) ?? undefined;
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
  markdown: string,
  comments: PatchmarkComment[] = [],
  includeAnchorResolution = true
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
      const anchorStatusByPatchId = includeAnchorResolution
        ? createPatchGroupAnchorStatusByPatchId({
            allPatches: patches,
            comments,
            markdown,
            patches: patchesInOrder
          })
        : {};
      const applicabilitySummary = includeAnchorResolution
        ? createPatchGroupApplicabilitySummary({
            comments,
            markdown,
            patches: patchesInOrder
          })
        : createDeferredPatchGroupApplicabilitySummary(patchesInOrder);
      const applicabilityByPatchId = includeAnchorResolution
        ? createPatchGroupApplicabilityByPatchId({
            comments,
            markdown,
            patches: patchesInOrder
          })
        : Object.fromEntries(
            patchesInOrder
              .filter((patch) => patch.status === "pending")
              .map((patch) => [patch.id, "exact_match" as const])
          );
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
      (firstGroup, secondGroup) => {
        const firstTimestamp = Date.parse(firstGroup.created_at);
        const secondTimestamp = Date.parse(secondGroup.created_at);
        const chronology =
          Number.isFinite(firstTimestamp) && Number.isFinite(secondTimestamp)
            ? firstTimestamp - secondTimestamp
            : firstGroup.created_at.localeCompare(secondGroup.created_at);

        return (
          chronology ||
          (groupOrder.get(firstGroup.id) ?? 0) -
            (groupOrder.get(secondGroup.id) ?? 0)
        );
      }
    );
}

function createDeferredPatchGroupApplicabilitySummary(
  patches: PatchmarkPatch[]
): PatchGroupApplicabilitySummary {
  return {
    exact_match: patches.filter((patch) => patch.status === "pending").length,
    multiple_matches: 0,
    not_found: 0,
    table_row_rebase_available: 0
  };
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
  comments = [],
  markdown,
  patches
}: {
  comments?: PatchmarkComment[];
  markdown: string;
  patches: PatchmarkPatch[];
}): PatchGroupApplicabilitySummary {
  return patches.reduce<PatchGroupApplicabilitySummary>(
    (summary, patch) => {
      if (patch.status !== "pending") {
        return summary;
      }

      const applicability = getPatchApplicabilityForPatch(
        markdown,
        patch,
        patches,
        comments
      );

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
  comments = [],
  markdown,
  patches
}: {
  allPatches: PatchmarkPatch[];
  comments?: PatchmarkComment[];
  markdown: string;
  patches: PatchmarkPatch[];
}): Record<string, PatchReviewAnchorStatus> {
  return Object.fromEntries(
    patches.map((patch) => [
      patch.id,
      getPatchReviewAnchorStatus(markdown, patch, allPatches, comments)
    ])
  );
}

function createPatchGroupApplicabilityByPatchId({
  comments = [],
  markdown,
  patches
}: {
  comments?: PatchmarkComment[];
  markdown: string;
  patches: PatchmarkPatch[];
}): Record<string, PatchApplicability> {
  return Object.fromEntries(
    patches.map((patch) => [
      patch.id,
      getPatchApplicabilityForPatch(markdown, patch, patches, comments)
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
  patchGroups: DerivedPatchGroup[],
  commentsById: Map<string, PatchmarkComment>
): Record<string, CommentPatchGroupSummary> {
  const allPatches = patchGroups.flatMap((group) => group.patches);
  const groupCountsByCommentId = patchGroups.reduce<Record<string, number>>(
    (counts, group) => {
      if (group.comment_id) {
        counts[group.comment_id] = (counts[group.comment_id] ?? 0) + 1;
      }

      return counts;
    },
    {}
  );
  const summaries: Record<string, CommentPatchGroupSummary> = {};

  for (const [commentId, groupCount] of Object.entries(groupCountsByCommentId)) {
    const comment = commentsById.get(commentId);

    if (!comment) {
      continue;
    }

    summaries[commentId] = {
      ...createCommentPatchHistorySummary({
        comment,
        patches: allPatches
      }),
      groupCount
    };
  }

  return summaries;
}

function getPatchApplicabilityForPatch(
  markdown: string,
  patch: PatchmarkPatch,
  patches: PatchmarkPatch[] = [],
  comments: PatchmarkComment[] = []
): PatchApplicability {
  const anchorStatus = getPatchReviewAnchorStatus(
    markdown,
    patch,
    patches,
    comments
  );

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
  if (isSingleMarkdownTableDataRowSnippet(patch.original_text)) {
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
  patches: PatchmarkPatch[] = [],
  comments: PatchmarkComment[] = []
): PatchReviewAnchorStatus {
  if (patch.status === "accepted") {
    return getAppliedPatchAnchorStatus(markdown, patch, patches);
  }

  const pendingResolution = resolvePendingPatchTarget({
    comments,
    markdown,
    patch,
    patches
  });

  if (pendingResolution.applicability === "exact_match") {
    return {
      applicability: "exact_match",
      kind: patch.status === "pending" ? "pending" : "historical",
      matchMethod:
        pendingResolution.method === "none"
          ? undefined
          : pendingResolution.method,
      matches: pendingResolution.matches,
      text: patch.original_text
    };
  }

  if (pendingResolution.applicability === "multiple_matches") {
    return {
      applicability: "multiple_matches",
      kind: patch.status === "pending" ? "pending" : "historical",
      matchMethod:
        pendingResolution.method === "none"
          ? undefined
          : pendingResolution.method,
      matches: pendingResolution.matches,
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
        matchMethod: "document_exact",
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
        matchMethod: "document_exact",
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
        matchMethod: "document_exact",
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
    matches: pendingResolution.matches,
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

function createAcceptedPatchAnchorStatus({
  matchMethod,
  matches,
  status,
  text
}: {
  matchMethod: AppliedPatchReviewMatchMethod;
  matches: TextMatch[];
  status: AppliedPatchAnchorStatus;
  text: string;
}): Extract<PatchReviewAnchorStatus, { kind: "accepted" }> {
  const distinctMatches = dedupePatchReviewTextMatches(matches);

  return {
    kind: "accepted",
    matchCardinality: getPatchReviewMatchCardinality(distinctMatches),
    matchMethod,
    matches: distinctMatches,
    status,
    text
  };
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
    return createAcceptedPatchAnchorStatus({
      matchMethod: "none",
      matches: [],
      status: "empty_applied_text",
      text: appliedText
    });
  }

  const offsetMatch = getDeterministicAppliedPatchOffsetMatch({
    appliedText,
    markdown,
    patch
  });

  if (offsetMatch) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: offsetMatch.matchMethod,
      matches: [offsetMatch],
      status: offsetMatch.status,
      text: offsetMatch.text
    });
  }

  const exactMatches = dedupePatchReviewTextMatches(
    findExactTextMatches(markdown, appliedText)
  );

  if (exactMatches.length === 1) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "exact",
      matches: exactMatches,
      status: "exact_match",
      text: appliedText
    });
  }

  const normalizedMatches = getAppliedPatchNormalizedMatches(markdown, appliedText);
  if (normalizedMatches.length === 1) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "normalized",
      matches: normalizedMatches,
      status: "normalized_match",
      text: markdown.slice(normalizedMatches[0].start, normalizedMatches[0].end)
    });
  }

  const tableRowMatch = findAcceptedPatchTableRowAnchorMatch({
    appliedText,
    markdown,
    patch
  });
  if (tableRowMatch) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "table_structural",
      matches: [tableRowMatch],
      status: "row_match",
      text: tableRowMatch.text
    });
  }

  const sectionMatch = findAcceptedPatchSectionAnchorMatch({
    appliedText,
    markdown,
    normalizedMatches,
    patch
  });
  if (sectionMatch) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "section_context",
      matches: [sectionMatch],
      status: "section_match",
      text: sectionMatch.text
    });
  }

  const contextMatch = findAcceptedPatchSurroundingContextMatch({
    markdown,
    patch
  });
  if (contextMatch) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "section_context",
      matches: [contextMatch],
      status: "evolved_after_patch",
      text: contextMatch.text
    });
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
      return createAcceptedPatchAnchorStatus({
        matchMethod: "descendant",
        matches: descendantMatch.matches,
        status: "evolved_after_patch",
        text: descendantMatch.text
      });
    }
  }

  if (exactMatches.length > 1) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "exact",
      matches: exactMatches,
      status: "multiple_matches",
      text: appliedText
    });
  }

  if (normalizedMatches.length > 1) {
    return createAcceptedPatchAnchorStatus({
      matchMethod: "normalized",
      matches: normalizedMatches,
      status: "multiple_matches",
      text: appliedText
    });
  }

  return createAcceptedPatchAnchorStatus({
    matchMethod: "none",
    matches: [],
    status: "not_found",
    text: appliedText
  });
}

function getPatchAppliedText(patch: PatchmarkPatch): string {
  return patch.applied_text ?? patch.suggested_text;
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

  return dedupeOverlappingAppliedPatchMatches([
    ...findNormalizedTextMatches(markdown, appliedText),
    ...plainTextMatches
  ]);
}

function dedupeOverlappingAppliedPatchMatches(matches: TextMatch[]): TextMatch[] {
  const distinctMatches = dedupeTextMatches(matches).sort(
    (firstMatch, secondMatch) =>
      firstMatch.start - secondMatch.start || firstMatch.end - secondMatch.end
  );
  const overlappingDedupedMatches: TextMatch[] = [];

  for (const match of distinctMatches) {
    const overlappingIndex = overlappingDedupedMatches.findIndex((candidate) =>
      doTextRangesOverlap(candidate, match)
    );

    if (overlappingIndex === -1) {
      overlappingDedupedMatches.push(match);
      continue;
    }

    const existingMatch = overlappingDedupedMatches[overlappingIndex];

    if (getTextRangeLength(match) > getTextRangeLength(existingMatch)) {
      overlappingDedupedMatches[overlappingIndex] = match;
    }
  }

  return overlappingDedupedMatches.sort(
    (firstMatch, secondMatch) =>
      firstMatch.start - secondMatch.start || firstMatch.end - secondMatch.end
  );
}

function doTextRangesOverlap(firstRange: TextMatch, secondRange: TextMatch): boolean {
  return firstRange.start < secondRange.end && secondRange.start < firstRange.end;
}

function getTextRangeLength(range: TextMatch): number {
  return range.end - range.start;
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

  if (!isSingleMarkdownTableDataRowSnippet(appliedText)) {
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
    !isSingleMarkdownTableDataRowSnippet(patch.original_text) ||
    !isSingleMarkdownTableDataRowSnippet(patch.suggested_text)
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
  if (!isSingleMarkdownTableDataRowSnippet(text)) {
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

function orchestrateDocumentMutation({
  changeSet,
  comments,
  createdAt,
  edits,
  newMarkdown,
  oldMarkdown,
  patchContext,
  source,
  performanceOperationId
}: {
  changeSet?: MarkdownChangeSet;
  comments: PatchmarkComment[];
  createdAt: string;
  edits: MarkdownEdit[];
  newMarkdown: string;
  oldMarkdown: string;
  patchContext?: DocumentMutationPatchContext;
  source: DocumentMutationSource;
  performanceOperationId?: string | null;
}): DocumentMutationResult {
  const edit = edits.length === 1 ? edits[0] : null;
  const effectiveChangeSet =
    changeSet ??
    ({
      broad: edits.length > 1,
      confidence: edits.length === 1 ? "high" : "medium",
      derivation: "native",
      edits,
      source: getMarkdownChangeSetSource(source)
    } satisfies MarkdownChangeSet);
  const headingParseStartedAt = performance.now();
  const oldHeadings = parseMarkdownHeadings(oldMarkdown);
  const newHeadings = parseMarkdownHeadings(newMarkdown);
  recordEditPerformanceDuration(
    performanceOperationId,
    "heading_parse",
    performance.now() - headingParseStartedAt
  );
  const commentImpacts: CommentMutationImpact[] = [];
  const recoveryRequiredCommentIds: string[] = [];
  const transformedCommentIds: string[] = [];
  const validationResults: Record<string, CommentAnchorResolution> = {};
  let didTransform = false;
  let linkedCommentFound = false;
  let needsReviewCount = 0;
  let offsetShiftedCount = 0;
  let reanchoredCount = 0;
  let unchangedCount = 0;

  const nextComments = comments.map((comment) => {
    const classificationStartedAt = performance.now();
    const classification = classifyCommentDocumentMutation({
      comment,
      edit,
      oldHeadings,
      oldMarkdown,
      patchContext,
      source
    });
    recordEditPerformanceDuration(
      performanceOperationId,
      "anchor_classification",
      performance.now() - classificationStartedAt
    );
    let nextComment = comment;
    let outcome: CommentMutationOutcome = "unaffected";

    if (patchContext?.linkedCommentId === comment.id) {
      linkedCommentFound = true;
    }

    if (isManualDocumentMutationSource(source)) {
      const transformStartedAt = performance.now();
      const manualUpdate =
        comment.anchor.kind === "selected_text"
          ? updateSelectedTextCommentThroughManualMutation({
              changeSet: effectiveChangeSet,
              comment,
              createdAt,
              newMarkdown,
              oldMarkdown,
              source
            })
          : null;
      recordEditPerformanceDuration(
        performanceOperationId,
        "anchor_transform_and_metadata_refresh",
        performance.now() - transformStartedAt
      );

      if (manualUpdate) {
        nextComment = manualUpdate.comment;
        outcome = manualUpdate.outcome;
      }
    } else if (
      source === "patch_apply" &&
      patchContext &&
      classification.patchImpactKind !== "unaffected"
    ) {
      const patchUpdate = updateSingleAffectedCommentAnchor({
        comment,
        createdAt,
        edit,
        impactKind: classification.patchImpactKind,
        newMarkdown,
        oldMarkdown,
        patch: patchContext.patch,
        replacementStart: patchContext.replacementStart
      });

      nextComment = patchUpdate.comment;
      outcome = getCommentMutationOutcomeFromPatchResult(patchUpdate.result);

      if (patchUpdate.result === "needs_review") {
        needsReviewCount += 1;
      } else if (patchUpdate.result === "offset_shifted") {
        offsetShiftedCount += 1;
      } else if (patchUpdate.result === "reanchored") {
        reanchoredCount += 1;
      } else {
        unchangedCount += 1;
      }
    } else {
      unchangedCount += 1;
    }

    if (nextComment !== comment) {
      didTransform = true;
      transformedCommentIds.push(comment.id);
    }

    const canonicalValidationStartedAt = performance.now();
    const fastValidation = resolveCommentAnchorAtKnownPosition(
      nextComment,
      newMarkdown,
      newHeadings
    );
    const validation =
      fastValidation ?? resolveCommentAnchor(nextComment, newMarkdown, newHeadings);
    incrementEditPerformanceCounter(
      performanceOperationId,
      fastValidation
        ? "fast_anchor_validation_count"
        : "full_anchor_recovery_count"
    );
    recordEditPerformanceDuration(
      performanceOperationId,
      "canonical_validation",
      performance.now() - canonicalValidationStartedAt
    );
    validationResults[comment.id] = validation;

    if (
      outcome === "transformed_needs_review" ||
      outcome === "recovery_required" ||
      validation.status === "ambiguous"
    ) {
      recoveryRequiredCommentIds.push(comment.id);
    }

    commentImpacts.push({
      commentId: comment.id,
      outcome,
      patchImpactKind: classification.patchImpactKind,
      relationship: classification.relationship,
      validation
    });

    return nextComment;
  });

  markEditPerformanceOperation(performanceOperationId, "anchor_settled");

  return {
    commentImpacts,
    comments: didTransform ? nextComments : comments,
    linkedCommentFound,
    markdown: newMarkdown,
    needsReviewCount,
    offsetShiftedCount,
    reanchoredCount,
    recoveryRequiredCommentIds,
    transformedCommentIds,
    unchangedCount,
    validationResults
  };
}

function classifyCommentDocumentMutation({
  comment,
  edit,
  oldHeadings,
  oldMarkdown,
  patchContext,
  source
}: {
  comment: PatchmarkComment;
  edit: MarkdownEdit | null;
  oldHeadings: ReturnType<typeof parseMarkdownHeadings>;
  oldMarkdown: string;
  patchContext?: DocumentMutationPatchContext;
  source: DocumentMutationSource;
}): {
  patchImpactKind: PatchCommentImpactKind;
  relationship?: AnchorEditRelationship | "section_may_have_shifted";
} {
  if (!edit) {
    return {
      patchImpactKind: "unaffected"
    };
  }

  if (source === "patch_apply" && comment.id === patchContext?.linkedCommentId) {
    return {
      patchImpactKind: "linked_comment"
    };
  }

  const { anchor } = comment;

  if (anchor.kind === "document") {
    return {
      patchImpactKind: "unaffected"
    };
  }

  if (anchor.kind === "section") {
    const sectionRange = getSectionAnchorRangeForImpact({
      anchor,
      headings: oldHeadings,
      markdown: oldMarkdown
    });

    if (!sectionRange) {
      return {
        patchImpactKind: "unaffected"
      };
    }

    const relationship = classifyRangeAgainstEdit(sectionRange, edit);

    return relationship !== "before" && relationship !== "unaffected"
      ? {
          patchImpactKind: "section_may_have_shifted",
          relationship: "section_may_have_shifted"
        }
      : {
          patchImpactKind: "unaffected",
          relationship
        };
  }

  const selectedRange = getSelectedAnchorRangeForImpact({
    anchor,
    originalStart: edit.oldStart,
    patch: patchContext?.patch
  });

  if (!selectedRange) {
    return {
      patchImpactKind: "unaffected"
    };
  }

  const relationship = classifyRangeAgainstEdit(selectedRange, edit);

  if (relationship === "after") {
    return {
      patchImpactKind: "anchor_after_replaced_range",
      relationship
    };
  }

  if (relationship === "before" || relationship === "unaffected") {
    return {
      patchImpactKind: "unaffected",
      relationship
    };
  }

  if (
    relationship === "anchor_inside_edit" ||
    relationship === "exact_replacement"
  ) {
    return {
      patchImpactKind: "anchor_inside_replaced_range",
      relationship
    };
  }

  return {
    patchImpactKind: "anchor_intersects_replaced_range",
    relationship
  };
}

function getCommentMutationOutcomeFromPatchResult(
  result: PatchmarkCommentPatchImpact["result"]
): CommentMutationOutcome {
  if (result === "needs_review") {
    return "transformed_needs_review";
  }

  if (result === "reanchored" || result === "offset_shifted") {
    return "transformed_active";
  }

  return "unaffected";
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
  patch?: PatchmarkPatch;
}): { end: number; start: number } | null {
  const storedRange = getSelectedAnchorKnownMarkdownRange(anchor);

  if (storedRange) {
    return storedRange;
  }

  if (!patch) {
    return null;
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

function getSelectedAnchorKnownMarkdownRange(
  anchor: SelectedTextAnchor
): { end: number; start: number } | null {
  if (
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    return {
      start: anchor.markdown_start_offset,
      end: anchor.markdown_end_offset
    };
  }

  if (
    typeof anchor.anchor_context?.markdown_start_offset === "number" &&
    typeof anchor.anchor_context.markdown_end_offset === "number"
  ) {
    return {
      start: anchor.anchor_context.markdown_start_offset,
      end: anchor.anchor_context.markdown_end_offset
    };
  }

  return null;
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): boolean {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function isManualDocumentMutationSource(source: DocumentMutationSource): boolean {
  return (
    source === "composition" ||
    source === "cut" ||
    source === "formatter" ||
    source === "manual_source" ||
    source === "manual_visual" ||
    source === "move" ||
    source === "paste" ||
    source === "redo" ||
    source === "undo"
  );
}

function getMarkdownChangeSetSource(
  source: DocumentMutationSource
): MarkdownChangeSet["source"] {
  if (
    source === "programmatic_sync" ||
    source === "project_load" ||
    source === "snapshot_restore"
  ) {
    return "programmatic";
  }

  if (source === "patch_apply") {
    return "patch_apply";
  }

  return source;
}

function getDocumentMutationSourceFromHint(
  source: DocumentMutationSource,
  hint?: MarkdownMutationHint
): DocumentMutationSource {
  if (!hint || source !== "manual_source") {
    return source;
  }

  if (hint.isComposing || hint.event === "compositionend") {
    return "composition";
  }

  if (hint.event === "paste" || hint.inputType === "insertFromPaste") {
    return "paste";
  }

  if (hint.event === "cut" || hint.inputType === "deleteByCut") {
    return "cut";
  }

  if (hint.inputType === "historyUndo") {
    return "undo";
  }

  if (hint.inputType === "historyRedo") {
    return "redo";
  }

  return source;
}

function countManualChangeSetIntersectingSelectedTextAnchors({
  changeSet,
  comments,
}: {
  changeSet: MarkdownChangeSet;
  comments: PatchmarkComment[];
}): number {
  return comments.filter((comment) => {
    const anchorStart =
      comment.anchor.kind === "selected_text"
        ? comment.anchor.markdown_start_offset
        : undefined;
    const anchorEnd =
      comment.anchor.kind === "selected_text"
        ? comment.anchor.markdown_end_offset
        : undefined;

    if (
      comment.status === "resolved" ||
      comment.anchor.kind !== "selected_text" ||
      typeof anchorStart !== "number" ||
      typeof anchorEnd !== "number"
    ) {
      return false;
    }

    return changeSet.edits.some((edit) =>
      doesRangeIntersectEdit(
        {
          start: anchorStart,
          end: anchorEnd
        },
        edit
      )
    );
  }).length;
}

function updateSelectedTextCommentThroughManualMutation({
  changeSet,
  comment,
  createdAt,
  newMarkdown,
  oldMarkdown,
  source
}: {
  changeSet: MarkdownChangeSet;
  comment: PatchmarkComment;
  createdAt: string;
  newMarkdown: string;
  oldMarkdown: string;
  source: DocumentMutationSource;
}): { comment: PatchmarkComment; outcome: CommentMutationOutcome } | null {
  if (comment.anchor.kind !== "selected_text") {
    return null;
  }

  const transform = transformSelectedTextAnchorThroughChangeSet({
    anchor: comment.anchor,
    changeSet,
    newMarkdown,
    oldMarkdown
  });
  const nextAnchor = createSelectedTextAnchorFromMutationTransform({
    anchor: comment.anchor,
    comment,
    newMarkdown,
    source,
    transform
  });

  if (!nextAnchor) {
    return {
      comment,
      outcome: "recovery_required"
    };
  }

  if (areCommentAnchorsEqual(comment.anchor, nextAnchor)) {
    return {
      comment,
      outcome: "unaffected"
    };
  }

  return {
    comment: {
      ...comment,
      anchor: nextAnchor,
      updated_at: createdAt
    },
    outcome:
      transform.outcome === "inactive" ? "deleted" : "transformed_active"
  };
}

function createSelectedTextAnchorFromMutationTransform({
  anchor,
  comment,
  newMarkdown,
  source,
  transform
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  newMarkdown: string;
  source: DocumentMutationSource;
  transform: AnchorTransformResult;
}): SelectedTextAnchor | null {
  if (transform.outcome === "needs_review") {
    return null;
  }

  if (transform.outcome === "inactive") {
    return createInactiveSelectedTextAnchorAfterManualDeletion({
      anchor,
      deletionOffset: transform.start,
      newMarkdown
    });
  }

  const context =
    createAnchorContextFromMarkdownRange(newMarkdown, {
      start: transform.start,
      end: transform.end
    }) ??
    ({
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(transform.selectedText),
      markdown_text: transform.selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: transform.selectedText.length,
      markdown_start_offset: transform.start,
      markdown_end_offset: transform.end
    } satisfies PatchmarkSelectedTextAnchorContext);

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource:
      source === "patch_apply"
        ? "patch"
        : source === "manual_visual"
        ? (anchor.anchor_source ?? "visual")
        : "markdown",
    comment,
    context,
    markdown: newMarkdown,
    preferredHeadingText: anchor.containing_heading,
    selectedText: transform.selectedText,
    start: transform.start,
    end: transform.end
  });
}

function createInactiveSelectedTextAnchorAfterManualDeletion({
  anchor,
  deletionOffset,
  newMarkdown
}: {
  anchor: SelectedTextAnchor;
  deletionOffset?: number;
  newMarkdown: string;
}): SelectedTextAnchor {
  const nextOffset = Math.max(
    0,
    Math.min(
      typeof deletionOffset === "number"
        ? deletionOffset
        : anchor.markdown_start_offset ?? 0,
      newMarkdown.length
    )
  );

  return refreshSelectedAnchorPositionMetadata({
    anchor: {
      ...anchor,
      selected_text: anchor.selected_text,
      anchor_context: anchor.anchor_context,
      markdown_start_offset: nextOffset,
      markdown_end_offset: nextOffset
    },
    markdown: newMarkdown,
    preferredHeadingText: anchor.containing_heading,
    start: nextOffset,
    end: nextOffset
  });
}

function updateSingleAffectedCommentAnchor({
  comment,
  createdAt,
  edit,
  impactKind,
  newMarkdown,
  oldMarkdown,
  patch,
  replacementStart
}: {
  comment: PatchmarkComment;
  createdAt: string;
  edit: MarkdownEdit | null;
  impactKind: PatchCommentImpactKind;
  newMarkdown: string;
  oldMarkdown: string;
  patch: PatchmarkPatch;
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
    const retainedAnchor =
      comment.anchor.kind === "selected_text"
        ? createRetainedSelectedTextAnchorInsidePatch({
            anchor: comment.anchor,
            comment,
            newMarkdown,
            originalStart: replacementStart,
            patch,
            replacementStart,
            replacementText: patch.suggested_text
          })
        : null;

    if (retainedAnchor) {
      return updateCommentAnchorAfterPatch({
        comment,
        content: `Patch ${patch.id} was applied to the document and this comment stayed anchored to the retained selected text.`,
        createdAt,
        impactKind,
        newAnchor: retainedAnchor,
        note: "Linked selected-text comment was mapped to retained text inside the applied replacement.",
        patch,
        reason: "anchor_recovered_after_patch",
        result: "reanchored"
      });
    }

    const changedTableCellAnchor =
      comment.anchor.kind === "selected_text"
        ? createChangedTableCellAnchorInsidePatch({
            anchor: comment.anchor,
            comment,
            newMarkdown,
            originalStart: replacementStart,
            patch,
            replacementStart,
            replacementText: patch.suggested_text
          })
        : null;

    if (changedTableCellAnchor) {
      return updateCommentAnchorAfterPatch({
        comment,
        content: `Patch ${patch.id} was applied to the document and this comment was re-anchored to the corresponding changed table cell.`,
        createdAt,
        impactKind,
        newAnchor: changedTableCellAnchor,
        note: "Linked selected-text comment was mapped to the corresponding changed table cell in the applied replacement.",
        patch,
        reason: "anchor_recovered_after_patch",
        result: "reanchored"
      });
    }

    const selectedAnchorIsCoveredByPatch =
      comment.anchor.kind === "selected_text" &&
      (isSelectedAnchorEquivalentToPatchOriginalText({
        anchor: comment.anchor,
        originalText: patch.original_text
      }) ||
        isSelectedAnchorInsidePatchOriginalText({
          anchor: comment.anchor,
          originalStart: replacementStart,
          originalText: patch.original_text
        }));
    const newAnchor = selectedAnchorIsCoveredByPatch
      ? createLinkedPatchTransformedAnchor({
          anchor: comment.anchor,
          comment,
          newMarkdown,
          oldMarkdown,
          patch,
          replacementStart
        })
      : null;

    if (!newAnchor) {
      return markCommentAnchorNeedsReviewAfterPatch({
        comment,
        content: `Patch ${patch.id} was applied to the document, but Patchmark could not re-anchor this comment automatically.`,
        createdAt,
        impactKind,
        note: "The linked selected-text comment was not uniquely retained in the applied replacement.",
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
    const transform =
      edit && comment.anchor.kind === "selected_text"
        ? transformSelectedTextAnchorThroughEdit({
            anchor: comment.anchor,
            edit,
            newMarkdown,
            oldMarkdown
          })
        : null;
    const shiftedAnchor =
      transform && comment.anchor.kind === "selected_text"
        ? createSelectedTextAnchorFromMutationTransform({
            anchor: comment.anchor,
            comment,
            newMarkdown,
            source: "patch_apply",
            transform
          })
        : null;

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

function createLinkedPatchTransformedAnchor({
  anchor,
  comment,
  newMarkdown,
  oldMarkdown,
  patch,
  replacementStart
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  newMarkdown: string;
  oldMarkdown: string;
  patch: PatchmarkPatch;
  replacementStart: number;
}): SelectedTextAnchor | null {
  const transform = transformSelectedTextAnchorThroughEdit({
    anchor,
    edit: {
      oldStart: replacementStart,
      oldEnd: replacementStart + patch.original_text.length,
      insertedText: patch.suggested_text
    },
    newMarkdown,
    oldMarkdown
  });

  if (transform.outcome !== "active") {
    const replacementText = patch.suggested_text;

    if (!replacementText.trim()) {
      return null;
    }

    return createAppliedReplacementAnchorForLinkedPatchRepair({
      anchor,
      comment,
      markdown: newMarkdown,
      patch,
      replacementEnd: replacementStart + replacementText.length,
      replacementStart,
      replacementText
    });
  }

  const context =
    createAnchorContextFromMarkdownRange(newMarkdown, {
      start: transform.start,
      end: transform.end
    }) ??
    ({
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(transform.selectedText),
      markdown_text: transform.selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: transform.selectedText.length,
      markdown_start_offset: transform.start,
      markdown_end_offset: transform.end
    } satisfies PatchmarkSelectedTextAnchorContext);

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource: "patch",
    comment,
    context,
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: transform.selectedText,
    start: transform.start,
    end: transform.end
  });
}

function createAppliedReplacementAnchorForLinkedPatchRepair({
  anchor,
  comment,
  markdown,
  patch,
  replacementEnd,
  replacementStart,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  markdown: string;
  patch: PatchmarkPatch;
  replacementEnd: number;
  replacementStart: number;
  replacementText: string;
}): SelectedTextAnchor {
  const context =
    createAnchorContextFromMarkdownRange(markdown, {
      start: replacementStart,
      end: replacementEnd
    }) ??
    ({
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(replacementText),
      markdown_text: replacementText,
      selected_start_in_context: 0,
      selected_end_in_context: replacementText.length,
      markdown_start_offset: replacementStart,
      markdown_end_offset: replacementEnd
    } satisfies PatchmarkSelectedTextAnchorContext);

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource: "patch",
    comment,
    context,
    markdown,
    preferredHeadingText: patch.target_heading,
    selectedText: replacementText,
    start: replacementStart,
    end: replacementEnd
  });
}

function isSelectedAnchorInsidePatchOriginalText({
  anchor,
  originalStart,
  originalText
}: {
  anchor: SelectedTextAnchor;
  originalStart: number;
  originalText: string;
}): boolean {
  if (!anchor.selected_text.trim()) {
    return false;
  }

  const storedRange = getSelectedAnchorKnownMarkdownRange(anchor);

  if (storedRange) {
    const originalEnd = originalStart + originalText.length;

    if (
      storedRange.start >= originalStart &&
      storedRange.end <= originalEnd
    ) {
      return true;
    }
  }

  return (
    findExactTextMatches(originalText, anchor.selected_text).length === 1 ||
    findMarkdownPlainTextMatches(originalText, anchor.selected_text).length === 1
  );
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
  return (
    createRetainedSelectedTextAnchorInsidePatch({
      anchor,
      comment,
      newMarkdown,
      originalStart: replacementStart,
      patch,
      replacementStart,
      replacementText: patch.suggested_text
    }) ??
    createChangedTableCellAnchorInsidePatch({
      anchor,
      comment,
      newMarkdown,
      originalStart: replacementStart,
      patch,
      replacementStart,
      replacementText: patch.suggested_text
    })
  );
}

function createRetainedSelectedTextAnchorInsidePatch({
  anchor,
  comment,
  newMarkdown,
  originalStart,
  patch,
  replacementStart,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  newMarkdown: string;
  originalStart?: number;
  patch: PatchmarkPatch;
  replacementStart: number;
  replacementText: string;
}): SelectedTextAnchor | null {
  const retainedMatch = findRetainedSelectedTextInPatchReplacement({
    anchor,
    originalStart,
    originalText: patch.original_text,
    replacementStart,
    replacementText
  });

  if (!retainedMatch) {
    return null;
  }

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource: "patch",
    comment,
    context: {
      kind: anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(retainedMatch.selectedText),
      markdown_text: retainedMatch.selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: retainedMatch.selectedText.length,
      markdown_start_offset: retainedMatch.start,
      markdown_end_offset: retainedMatch.end
    },
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: retainedMatch.selectedText,
    start: retainedMatch.start,
    end: retainedMatch.end
  });
}

function createChangedTableCellAnchorInsidePatch({
  anchor,
  comment,
  newMarkdown,
  originalStart,
  patch,
  replacementStart,
  replacementText
}: {
  anchor: SelectedTextAnchor;
  comment: PatchmarkComment;
  newMarkdown: string;
  originalStart?: number;
  patch: PatchmarkPatch;
  replacementStart: number;
  replacementText: string;
}): SelectedTextAnchor | null {
  const changedCellMatch = findChangedTableCellInPatchReplacement({
    anchor,
    originalStart,
    originalText: patch.original_text,
    replacementStart,
    replacementText
  });

  if (!changedCellMatch) {
    return null;
  }

  return createSelectedTextAnchorAtRange({
    anchor,
    anchorSource: "patch",
    comment,
    context: {
      kind: "table_cell",
      plain_text: normalizeDomText(changedCellMatch.selectedText),
      markdown_text: changedCellMatch.selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: changedCellMatch.selectedText.length,
      markdown_start_offset: changedCellMatch.start,
      markdown_end_offset: changedCellMatch.end
    },
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: changedCellMatch.selectedText,
    start: changedCellMatch.start,
    end: changedCellMatch.end
  });
}

function createRetainedPatchOriginalTextAnchorInsidePatch({
  comment,
  newMarkdown,
  patch,
  replacementStart,
  replacementText
}: {
  comment: PatchmarkComment;
  newMarkdown: string;
  patch: PatchmarkPatch;
  replacementStart: number;
  replacementText: string;
}): SelectedTextAnchor | null {
  const retainedMatch = findRetainedPatchOriginalTextInPatchReplacement({
    originalText: patch.original_text,
    replacementStart,
    replacementText
  });

  if (!retainedMatch) {
    return null;
  }

  return createSelectedTextAnchorAtRange({
    anchor: undefined,
    anchorSource: "patch",
    comment,
    context: {
      kind: "table_cell",
      plain_text: normalizeDomText(retainedMatch.selectedText),
      markdown_text: retainedMatch.selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: retainedMatch.selectedText.length,
      markdown_start_offset: retainedMatch.start,
      markdown_end_offset: retainedMatch.end
    },
    markdown: newMarkdown,
    preferredHeadingText: patch.target_heading,
    selectedText: retainedMatch.selectedText,
    start: retainedMatch.start,
    end: retainedMatch.end
  });
}

function createCurrentPatchOriginalTableRowAnchor({
  comment,
  markdown,
  patch
}: {
  comment: PatchmarkComment;
  markdown: string;
  patch: PatchmarkPatch;
}): SelectedTextAnchor | null {
  const retainedRow = findUniqueCurrentTableRowForPatchOriginal({
    markdown,
    patch
  });

  if (!retainedRow) {
    return null;
  }

  return createSelectedTextAnchorAtRange({
    anchor: comment.anchor.kind === "selected_text" ? comment.anchor : undefined,
    anchorSource: "patch",
    comment,
    context: {
      kind: "table_cell",
      plain_text: normalizeDomText(retainedRow.text),
      markdown_text: retainedRow.text,
      selected_start_in_context: 0,
      selected_end_in_context: retainedRow.text.length,
      markdown_start_offset: retainedRow.start,
      markdown_end_offset: retainedRow.end
    },
    markdown,
    selectedText: retainedRow.text,
    start: retainedRow.start,
    end: retainedRow.end
  });
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
  if (!anchor.selected_text) {
    return {
      reason: "Selected text was deleted.",
      status: "not_found"
    };
  }

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
    !anchor.selected_text ||
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
  const nextHistory = appendConciseAnchorHistory({
    cause: "canonical_recovery",
    commentId: comment.id,
    history: comment.anchor_history,
    impactKind: latestNeedsReviewImpact?.impact_kind,
    nextAnchor: newAnchor,
    previousAnchor: comment.anchor,
    reason: "anchor_recovered_after_patch",
    sourcePatchId: latestNeedsReviewImpact?.patch_id,
    timestamp: createdAt
  });

  if (nextHistory === comment.anchor_history) {
    return comment;
  }

  const recoveredComment: PatchmarkComment = {
    ...comment,
    anchor: newAnchor,
    anchor_history: nextHistory,
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

function repairRetainedLinkedPatchCommentAnchor({
  comment,
  markdown,
  patches,
  repairedAt
}: {
  comment: PatchmarkComment;
  markdown: string;
  patches: PatchmarkPatch[];
  repairedAt: string;
}): PatchmarkComment | null {
  if (!comment.anchor_history || comment.anchor.kind !== "selected_text") {
    return null;
  }

  const sourcePatchIdsWithOriginalHistory = new Set(
    comment.anchor_history
      .filter((historyEntry) => {
        const previousAnchor = getHistoryPreviousAnchor(historyEntry);
        return (
          historyEntry.source_patch_id &&
          historyEntry.reason !== "anchor_recovered_after_patch" &&
          previousAnchor?.kind === "selected_text"
        );
      })
      .map((historyEntry) => historyEntry.source_patch_id as string)
  );

  for (const historyEntry of [...comment.anchor_history].reverse()) {
    const previousAnchor = getHistoryPreviousAnchor(historyEntry);

    if (
      !historyEntry.source_patch_id ||
      previousAnchor?.kind !== "selected_text"
    ) {
      continue;
    }

    if (
      historyEntry.reason === "anchor_recovered_after_patch" &&
      sourcePatchIdsWithOriginalHistory.has(historyEntry.source_patch_id)
    ) {
      continue;
    }

    const patch = patches.find(
      (candidate) =>
        candidate.id === historyEntry.source_patch_id &&
        candidate.status === "accepted" &&
        candidate.comment_id === comment.id
    );

    if (!patch) {
      continue;
    }

    const appliedRange = locateCurrentAppliedPatchRange({ markdown, patch });
    let retainedAnchorCandidate: SelectedTextAnchor | null = null;
    let retainedAnchorCandidateNote =
      "Linked selected-text comment repaired to retained text inside the applied replacement.";

    if (appliedRange) {
      const replacementText = markdown.slice(appliedRange.start, appliedRange.end);
      const retainedAnchor = createRetainedSelectedTextAnchorInsidePatch({
        anchor: previousAnchor,
        comment,
        newMarkdown: markdown,
        originalStart: patch.applied_start_offset,
        patch,
        replacementStart: appliedRange.start,
        replacementText
      });

      const retainedPatchOriginalAnchor =
        createRetainedPatchOriginalTextAnchorInsidePatch({
          comment,
          newMarkdown: markdown,
          patch,
          replacementStart: appliedRange.start,
          replacementText
        });
      const changedTableCellAnchor = createChangedTableCellAnchorInsidePatch({
        anchor: previousAnchor,
        comment,
        newMarkdown: markdown,
        originalStart: patch.applied_start_offset,
        patch,
        replacementStart: appliedRange.start,
        replacementText
      });
      const appliedReplacementAnchor =
        isSelectedAnchorInsidePatchOriginalText({
          anchor: previousAnchor,
          originalStart: patch.applied_start_offset ?? appliedRange.start,
          originalText: patch.original_text
        }) && replacementText.trim()
          ? createAppliedReplacementAnchorForLinkedPatchRepair({
              anchor: previousAnchor,
              comment,
              markdown,
              patch,
              replacementEnd: appliedRange.end,
              replacementStart: appliedRange.start,
              replacementText
            })
          : null;
      const retainedSelectedTextSpansReplacement =
        retainedAnchor !== null &&
        normalizeAcceptedPatchComparisonText(retainedAnchor.selected_text) ===
          normalizeAcceptedPatchComparisonText(replacementText);
      retainedAnchorCandidate =
        retainedPatchOriginalAnchor && retainedSelectedTextSpansReplacement
          ? retainedPatchOriginalAnchor
          : retainedAnchor ??
            changedTableCellAnchor ??
            retainedPatchOriginalAnchor ??
            appliedReplacementAnchor;
      retainedAnchorCandidateNote = !retainedAnchor && changedTableCellAnchor
        ? "Linked selected-text comment repaired to the corresponding changed table cell in the applied replacement."
        : !retainedAnchor && !changedTableCellAnchor && appliedReplacementAnchor
          ? "Linked selected-text comment repaired to the applied replacement because the accepted patch replaced text containing the original selection."
        : retainedAnchorCandidateNote;
    }

    retainedAnchorCandidate =
      retainedAnchorCandidate ??
      (isSelectedAnchorEquivalentToPatchOriginalText({
        anchor: previousAnchor,
        originalText: patch.original_text
      })
        ? createCurrentPatchOriginalTableRowAnchor({
            comment,
            markdown,
            patch
          })
        : null);

    if (!retainedAnchorCandidate) {
      continue;
    }

    if (areCommentAnchorsEqual(comment.anchor, retainedAnchorCandidate)) {
      return null;
    }

    if (
      comment.anchor.selected_text === retainedAnchorCandidate.selected_text &&
      comment.anchor.markdown_start_offset ===
        retainedAnchorCandidate.markdown_start_offset &&
      comment.anchor.markdown_end_offset ===
        retainedAnchorCandidate.markdown_end_offset
    ) {
      return null;
    }

    return updateCommentAnchorAfterPatch({
      comment,
      createdAt: repairedAt,
      impactKind: historyEntry.impact_kind ?? "linked_comment",
      newAnchor: retainedAnchorCandidate,
      note: retainedAnchorCandidateNote,
      patch,
      reason: "anchor_recovered_after_patch",
      result: "reanchored"
    }).comment;
  }

  return null;
}

function repairCommentAnchorFromCanonicalResolution({
  comment,
  headings,
  markdown,
  patches,
  repairedAt
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
  repairedAt: string;
}): PatchmarkComment | null {
  const canonicalResolution = resolveCanonicalCommentTarget(comment, {
    headings,
    markdown,
    patches
  });

  if (
    canonicalResolution.state !== "resolved" ||
    canonicalResolution.confidence !== "high" ||
    !canonicalResolution.range ||
    !isPersistableCanonicalRecoveryMethod(canonicalResolution.method)
  ) {
    return null;
  }

  const nextAnchor = createCommentAnchorFromCanonicalResolution({
    comment,
    headings,
    markdown,
    resolution: canonicalResolution
  });

  if (!nextAnchor) {
    return null;
  }

  const latestNeedsReviewImpact = getLatestNeedsReviewPatchImpact(comment);
  const anchorAlreadyCurrent = areCommentAnchorsEqual(comment.anchor, nextAnchor);

  if (anchorAlreadyCurrent && !latestNeedsReviewImpact) {
    return null;
  }

  let nextComment: PatchmarkComment = anchorAlreadyCurrent
    ? {
        ...comment,
        updated_at: repairedAt
      }
    : {
        ...comment,
        anchor: nextAnchor,
        anchor_history: appendConciseAnchorHistory({
          cause: "canonical_recovery",
          commentId: comment.id,
          history: comment.anchor_history,
          impactKind: latestNeedsReviewImpact?.impact_kind,
          method: canonicalResolution.method,
          confidence: canonicalResolution.confidence,
          nextAnchor,
          previousAnchor: comment.anchor,
          reason: "anchor_recovered_after_patch",
          sourcePatchId: latestNeedsReviewImpact?.patch_id,
          timestamp: repairedAt
        }),
        updated_at: repairedAt
      };

  if (!anchorAlreadyCurrent && nextComment.anchor_history === comment.anchor_history) {
    return null;
  }

  if (latestNeedsReviewImpact) {
    nextComment = appendPatchImpactToComment({
      comment: nextComment,
      createdAt: repairedAt,
      impactKind: latestNeedsReviewImpact.impact_kind,
      note: "Anchor recovered from canonical current document state.",
      patchId: latestNeedsReviewImpact.patch_id,
      result: "reanchored"
    });
  }

  return nextComment;
}

function isPersistableCanonicalRecoveryMethod(
  method: CanonicalTargetResolution["method"]
): boolean {
  return (
    method === "accepted_patch_replacement" ||
    method === "historical_anchor" ||
    method === "markdown_plain" ||
    method === "section_heading_replacement"
  );
}

function createCommentAnchorFromCanonicalResolution({
  comment,
  headings,
  markdown,
  resolution
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CanonicalTargetResolution;
}): PatchmarkCommentAnchor | null {
  if (!resolution.range) {
    return null;
  }

  if (comment.anchor.kind === "section") {
    const heading = findHeadingAtRangeStart({
      headings,
      markdown,
      range: resolution.range
    });

    if (!heading) {
      return null;
    }

    const sectionRange = getSectionRange(markdown, headings, heading);

    return {
      ...comment.anchor,
      heading: heading.text,
      heading_level: heading.level,
      heading_line: heading.line,
      heading_path: getHeadingPath(headings, heading),
      section_start_offset: sectionRange.start,
      section_end_offset: sectionRange.end
    };
  }

  if (comment.anchor.kind !== "selected_text") {
    return null;
  }

  const selectedText = markdown.slice(resolution.range.start, resolution.range.end);
  const context =
    createAnchorContextFromMarkdownRange(markdown, resolution.range) ??
    ({
      kind: comment.anchor.anchor_context?.kind ?? "block",
      plain_text: normalizeDomText(selectedText),
      markdown_text: selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: selectedText.length,
      markdown_start_offset: resolution.range.start,
      markdown_end_offset: resolution.range.end
    } satisfies PatchmarkSelectedTextAnchorContext);

  return createSelectedTextAnchorAtRange({
    anchor: comment.anchor,
    anchorSource:
      resolution.method === "accepted_patch_replacement" ||
      resolution.method === "historical_anchor"
        ? "patch"
        : comment.anchor.anchor_source ?? "markdown",
    comment,
    context,
    markdown,
    preferredHeadingText:
      resolution.containingHeading ?? comment.anchor.containing_heading,
    selectedText,
    start: resolution.range.start,
    end: resolution.range.end
  });
}

function findHeadingAtRangeStart({
  headings,
  markdown,
  range
}: {
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  range: TextMatch;
}) {
  const lineStarts = getLineStartOffsets(markdown);
  const line = lineStarts.findIndex((lineStart) => lineStart === range.start) + 1;

  if (line > 0) {
    const exactHeading = headings.find((heading) => heading.line === line);

    if (exactHeading) {
      return exactHeading;
    }
  }

  return headings.find((heading) => {
    const lineStart = lineStarts[heading.line - 1] ?? -1;
    const nextStart = lineStarts[heading.line] ?? markdown.length;

    return lineStart === range.start && nextStart - 1 >= range.end;
  });
}

function locateCurrentAppliedPatchRange({
  markdown,
  patch
}: {
  markdown: string;
  patch: PatchmarkPatch;
}): TextMatch | null {
  const appliedText = getPatchAppliedText(patch);
  const deterministicMatch = getDeterministicAppliedPatchOffsetMatch({
    appliedText,
    markdown,
    patch
  });

  if (deterministicMatch) {
    return deterministicMatch;
  }

  const exactMatches = findExactTextMatches(markdown, appliedText);

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const contextMatch = findAcceptedPatchSurroundingContextMatch({
    markdown,
    patch
  });

  if (contextMatch) {
    return contextMatch;
  }

  const sectionMatch = findAcceptedPatchSectionAnchorMatch({
    appliedText,
    markdown,
    normalizedMatches: getAppliedPatchNormalizedMatches(markdown, appliedText),
    patch
  });

  return sectionMatch;
}

function recoverPersistableStaleCommentAnchors({
  comments,
  headings,
  markdown,
  patches
}: {
  comments: PatchmarkComment[];
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
}): PatchmarkComment[] {
  let didRecover = false;
  const recoveredAt = new Date().toISOString();
  const recoveredComments = comments.map((comment) => {
    const latestNeedsReviewImpact = getLatestNeedsReviewPatchImpact(comment);

    if (
      !latestNeedsReviewImpact &&
      isStoredCommentAnchorCurrentlyValid({ comment, headings, markdown })
    ) {
      return comment;
    }

    const canonicalRepair = repairCommentAnchorFromCanonicalResolution({
      comment,
      headings,
      markdown,
      patches,
      repairedAt: recoveredAt
    });

    if (canonicalRepair) {
      didRecover = true;
      return canonicalRepair;
    }

    const linkedPatchRepair = repairRetainedLinkedPatchCommentAnchor({
      comment,
      markdown,
      patches,
      repairedAt: recoveredAt
    });

    if (linkedPatchRepair) {
      didRecover = true;
      return linkedPatchRepair;
    }

    if (
      latestNeedsReviewImpact &&
      isStoredCommentAnchorCurrentlyValid({
        comment,
        headings,
        markdown
      })
    ) {
      didRecover = true;

      return appendPatchImpactToComment({
        comment: {
          ...comment,
          updated_at: recoveredAt
        },
        createdAt: recoveredAt,
        impactKind: latestNeedsReviewImpact.impact_kind,
        note: "Anchor currently resolves.",
        patchId: latestNeedsReviewImpact.patch_id,
        result: "reanchored"
      });
    }

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
  const nextHistory = appendConciseAnchorHistory({
    cause: "historical_convergence",
    commentId: comment.id,
    history: comment.anchor_history,
    impactKind: latestPatchImpact?.impact_kind,
    method: recovery.reason,
    nextAnchor: recovery.newAnchor,
    previousAnchor: comment.anchor,
    reason: "anchor_recovered_after_patch",
    sourcePatchId: latestPatchImpact?.patch_id,
    timestamp: recoveredAt
  });

  if (nextHistory === comment.anchor_history) {
    return comment;
  }

  const recoveredComment: PatchmarkComment = {
    ...comment,
    anchor: recovery.newAnchor,
    anchor_history: nextHistory,
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

function isStoredCommentAnchorCurrentlyValid({
  comment,
  headings,
  markdown
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): boolean {
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return true;
  }

  if (anchor.kind === "section") {
    return Boolean(
      findMatchingHeading(headings, {
        level: anchor.heading_level,
        text: anchor.heading
      })
    );
  }

  return Boolean(getCurrentSelectedTextOffsetMatch(anchor, markdown));
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
  const nextHistory = appendConciseAnchorHistory({
    cause: "patch_apply",
    commentId: comment.id,
    history: comment.anchor_history,
    impactKind,
    nextAnchor: newAnchor,
    previousAnchor: comment.anchor,
    reason,
    sourcePatchId: patch.id,
    timestamp: createdAt
  });
  let nextComment = appendPatchImpactToComment({
    comment: {
      ...comment,
      anchor: newAnchor,
      anchor_history: nextHistory
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
        anchor_history: appendConciseAnchorHistory({
          cause: "patch_apply",
          commentId: comment.id,
          history: comment.anchor_history,
          impactKind,
          nextState: "needs_review",
          previousAnchor: comment.anchor,
          reason: "anchor_marked_needs_review_after_patch",
          sourcePatchId: patch.id,
          timestamp: createdAt
        })
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
  const nextImpact = {
    patch_id: patchId,
    impacted_at: createdAt,
    impact_kind: impactKind,
    result,
    note
  } satisfies PatchmarkCommentPatchImpact;
  const hasEquivalentImpact = (comment.patch_impacts ?? []).some(
    (impact) =>
      impact.patch_id === nextImpact.patch_id &&
      impact.impact_kind === nextImpact.impact_kind &&
      impact.result === nextImpact.result &&
      impact.note === nextImpact.note
  );

  if (hasEquivalentImpact) {
    return comment;
  }

  return {
    ...comment,
    patch_impacts: [
      ...(comment.patch_impacts ?? []),
      nextImpact
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
    return "Patch was applied, but the applied text appears in multiple locations.";
  }

  if (anchorStatus.status !== "not_found") {
    return "Patch was applied.";
  }

  return "Patch was applied, but Patchmark cannot currently locate the applied text.";
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
    return "Applied text found";
  }

  if (anchorStatus.status === "normalized_match") {
    return "Applied text found after normalization";
  }

  if (isAcceptedPatchEvolved(anchorStatus)) {
    return "Applied content evolved";
  }

  if (anchorStatus.status === "empty_applied_text") {
    return "Applied empty replacement";
  }

  if (anchorStatus.status === "multiple_matches") {
    return "Applied text appears in multiple locations";
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
    if (
      anchorStatus.applicability === "exact_match" &&
      (anchorStatus.matchMethod === "linked_comment_anchor" ||
        anchorStatus.matchMethod === "linked_comment_context" ||
        anchorStatus.matchMethod === "linked_comment_structure")
    ) {
      return "Target resolved from linked comment. Matching locations: 1.";
    }

    if (
      anchorStatus.applicability === "exact_match" &&
      anchorStatus.matchMethod === "target_heading"
    ) {
      return "Target resolved within the patch target heading. Matching locations: 1.";
    }

    return getPatchApplicabilityDetail(anchorStatus.applicability);
  }

  if (anchorStatus.status === "exact_match") {
    return "Patch was applied. The applied replacement has one exact current match.";
  }

  if (anchorStatus.status === "normalized_match") {
    return "Patch was applied. The applied replacement has one normalized current match.";
  }

  if (anchorStatus.status === "row_match") {
    return "Patch was applied. This table row was changed again later.";
  }

  if (anchorStatus.status === "section_match") {
    return "Patch was applied. This region was changed again later.";
  }

  if (anchorStatus.status === "evolved_after_patch") {
    return "Patch was applied. This region was changed again later.";
  }

  if (anchorStatus.status === "multiple_matches") {
    return `Patch was applied, but Patchmark found ${anchorStatus.matches.length} ${getPatchReviewMatchMethodLabel(anchorStatus.matchMethod).toLowerCase()} matches and cannot choose one.`;
  }

  if (anchorStatus.status === "empty_applied_text") {
    return "This accepted patch applied an empty replacement, so there is no applied text to locate.";
  }

  return "Patch was applied, but Patchmark cannot currently locate the applied text.";
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

function formatPatchTitleSource(
  source: ReturnType<typeof getPatchDisplayTitleInfo>["source"]
): string {
  if (source === "display_title") {
    return "Explicit patch display title";
  }

  if (source === "linked_comment") {
    return "Linked comment summary";
  }

  if (source === "target_heading") {
    return "Target heading and patch action";
  }

  if (source === "reason") {
    return "Patch reason";
  }

  return "Technical fallback";
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

function createFocusedCommentsExportPayload({
  comments,
  dedicatedDocumentReview,
  exportedAt,
  exportId,
  headings,
  markdown,
  patches,
  project
}: {
  comments: PatchmarkComment[];
  dedicatedDocumentReview: boolean;
  exportedAt: string;
  exportId: string;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
  project: PatchmarkProjectHandle;
}) {
  const tableContexts = createCanonicalTableContextsForExport({
    comments,
    headings,
    markdown
  });

  return {
    protocol: "patchmark.comment_export",
    protocol_version: 1,
    export_id: exportId,
    export_scope: dedicatedDocumentReview
      ? "dedicated_document_comment"
      : "focused_comments",
    project: {
      ...getProjectDocumentExportIdentity(project),
      exported_at: exportedAt
    },
    instructions_for_chatgpt: {
      role:
        "You are helping review and improve a Markdown document through Patchmark comments.",
      rules: [
        "Reply to each exported comment by comment_id.",
        "Do not resolve comments. Only the human resolves comments.",
        "Earlier accepted patches linked to a comment may be included as related_patch_history. Treat them as immutable history.",
        "Treat the supplied current Markdown and current anchor context as the source of truth.",
        "Answer the latest user follow-up in the existing comment discussion.",
        "Any further document change must be a new patch using exact original_text from the current supplied Markdown, not a revision of an accepted patch.",
        "If you suggest a document change, return a patch proposal linked to the comment_id.",
        "If more information is needed, ask a clarification question linked to the comment_id.",
        "Prefer several small exact patch proposals over one large rewrite, except when a change must be atomic to preserve valid Markdown structure. Structural table changes must use one complete-table patch.",
        "For structural table changes, copy the complete table into original_text and return the complete resulting table in suggested_text.",
        ...CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES,
        "Preserve Markdown structure.",
        "Drafting support only. Legal review may still be required.",
        ...(dedicatedDocumentReview
          ? [
              "This is a dedicated whole-document review task.",
              "Focus only on the exported document-level comment.",
              "Do not address unrelated document issues unless they are necessary to resolve this comment.",
              "Prefer small exact patches over rewriting the whole document, except for atomic structural table changes."
            ]
          : [])
      ],
      expected_response_format: "patchmark.comment_reply_import"
    },
    ...(tableContexts.length > 0
      ? {
          table_contexts: tableContexts.map((tableContext) => ({
            table_id: tableContext.table_id,
            markdown: tableContext.markdown,
            containing_heading: tableContext.containing_heading,
            containing_heading_path: tableContext.containing_heading_path
          }))
        }
      : {}),
    comments: comments.map((comment) =>
      createFocusedCommentExportEntry({
        comment,
        headings,
        markdown,
        patches,
        tableContexts
      })
    )
  };
}

function createFocusedCommentExportEntry({
  comment,
  headings,
  markdown,
  patches,
  tableContexts
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
  tableContexts: CanonicalTableContext[];
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

  const relatedPatchHistory = createRelatedAcceptedPatchHistory({
    comment,
    patches
  });

  return {
    comment_id: comment.id,
    type: comment.type,
    intent: actionContext.intent_hint,
    anchor: createExportAnchor(comment.anchor),
    action_context: actionContext,
    comment: comment.comment,
    thread: comment.thread.map(createExportThreadEntry),
    ...(relatedPatchHistory.patches.length > 0
      ? {
          related_patch_history: relatedPatchHistory.patches,
          ...(relatedPatchHistory.earlier_applied_patch_count > 0
            ? {
                earlier_related_applied_patch_count:
                  relatedPatchHistory.earlier_applied_patch_count
              }
            : {})
        }
      : {}),
    context: createExportContext({
      actionContext,
      anchor: comment.anchor,
      comment,
      headings,
      markdown,
      patches,
      tableContexts
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

function createCanonicalTableContextsForExport({
  comments,
  headings,
  markdown
}: {
  comments: PatchmarkComment[];
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): CanonicalTableContext[] {
  const occurrences = comments.flatMap((comment) => {
    const sectionRange = getContainingSectionRange(
      comment.anchor,
      markdown,
      headings
    );

    return getCompleteTableOccurrencesForExport({
      anchor: comment.anchor,
      includeSectionTables: shouldIncludeSectionTablesForComment(comment),
      markdown,
      sectionRange
    });
  });

  return createCanonicalTableContextsFromOccurrences({
    getMetadata: (occurrence) => {
      const heading =
        getHeadingContainingOffset(markdown, headings, occurrence.start) ?? null;

      return {
        containing_heading: heading?.text,
        containing_heading_path: heading
          ? getHeadingPath(headings, heading)
          : undefined
      };
    },
    occurrences
  });
}

function shouldIncludeSectionTablesForComment(comment: PatchmarkComment): boolean {
  return isLikelyTableWideComment(comment.comment);
}

function isLikelyTableWideComment(commentText: string): boolean {
  return /\b(table|column|columns|header|delimiter|alignment|align|reorder|split|merge|sort|normalize|normalise|convert|tabular)\b/i.test(
    commentText
  );
}

function createExportContext({
  actionContext,
  anchor,
  comment,
  headings,
  markdown,
  patches,
  tableContexts
}: {
  actionContext: PatchmarkCommentActionContext;
  anchor: PatchmarkCommentAnchor;
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
  tableContexts: CanonicalTableContext[];
}) {
  const canonicalResolution = resolveCanonicalCommentTarget(comment, {
    headings,
    markdown,
    patches
  });
  const containingSectionRange =
    getContainingSectionRangeFromCanonical({
      canonicalResolution,
      headings,
      markdown
    }) ?? getContainingSectionRange(anchor, markdown, headings);
  const containingSectionMarkdown = containingSectionRange
    ? markdown.slice(containingSectionRange.start, containingSectionRange.end)
    : null;
  const commentTableContexts = getCanonicalTableContextsForComment({
    anchor,
    comment,
    markdown,
    sectionRange: containingSectionRange,
    tableContexts
  });

  return {
    document_brief: null,
    display_target: getCommentDisplayTarget({
      anchor,
      canonicalResolution,
      markdown
    }),
    anchor_context:
      anchor.kind === "selected_text"
        ? createExportAnchorContextWithTableMarkers({
            anchorContext: anchor.anchor_context ?? null,
            tableContexts
          })
        : null,
    ...(commentTableContexts.length > 0
      ? {
          complete_table_ids: commentTableContexts.map(
            (tableContext) => tableContext.table_id
          )
        }
      : {}),
    containing_section_markdown:
      actionContext.default_scope === "containing_section"
        ? containingSectionMarkdown && containingSectionRange
          ? replaceCompleteTableOccurrencesWithMarkers({
              markdown: containingSectionMarkdown,
              rangeStart: containingSectionRange.start,
              tableContexts
            })
          : containingSectionMarkdown
        : null,
    full_document_markdown:
      actionContext.default_scope === "full_document"
        ? replaceCompleteTableOccurrencesWithMarkers({
            markdown,
            tableContexts
          })
        : null,
    related_open_comments: []
  };
}

function getCanonicalTableContextsForComment({
  anchor,
  comment,
  markdown,
  sectionRange,
  tableContexts
}: {
  anchor: PatchmarkCommentAnchor;
  comment: PatchmarkComment;
  markdown: string;
  sectionRange: { end: number; start: number } | null;
  tableContexts: CanonicalTableContext[];
}): CanonicalTableContext[] {
  const occurrences = getCompleteTableOccurrencesForExport({
    anchor,
    includeSectionTables: shouldIncludeSectionTablesForComment(comment),
    markdown,
    sectionRange
  });
  const occurrenceKeys = new Set(
    occurrences.map((occurrence) => `${occurrence.start}:${occurrence.end}`)
  );

  return tableContexts.filter((tableContext) =>
    occurrenceKeys.has(`${tableContext.start}:${tableContext.end}`)
  );
}

function createExportAnchorContextWithTableMarkers({
  anchorContext,
  tableContexts
}: {
  anchorContext: PatchmarkSelectedTextAnchorContext | null;
  tableContexts: CanonicalTableContext[];
}): PatchmarkSelectedTextAnchorContext | null {
  if (
    !anchorContext?.markdown_text ||
    typeof anchorContext.markdown_start_offset !== "number"
  ) {
    return anchorContext;
  }

  const markdownText = replaceCompleteTableOccurrencesWithMarkers({
    markdown: anchorContext.markdown_text,
    rangeStart: anchorContext.markdown_start_offset,
    tableContexts
  });

  return markdownText === anchorContext.markdown_text
    ? anchorContext
    : {
        ...anchorContext,
        markdown_text: markdownText
      };
}

function getCommentDisplayTarget({
  anchor,
  canonicalResolution,
  markdown
}: {
  anchor: PatchmarkCommentAnchor;
  canonicalResolution?: CanonicalTargetResolution;
  markdown: string;
}): string {
  if (anchor.kind === "document") {
    return "Whole document";
  }

  if (anchor.kind === "section") {
    return `${"#".repeat(anchor.heading_level ?? 1)} ${anchor.heading}`;
  }

  return canonicalResolution?.state === "resolved" && canonicalResolution.range
    ? markdown.slice(canonicalResolution.range.start, canonicalResolution.range.end)
    : anchor.selected_text;
}

function getContainingSectionRangeFromCanonical({
  canonicalResolution,
  headings,
  markdown
}: {
  canonicalResolution: CanonicalTargetResolution;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}): { end: number; start: number } | null {
  if (canonicalResolution.state !== "resolved" || !canonicalResolution.range) {
    return null;
  }

  const heading = getHeadingContainingOffset(
    markdown,
    headings,
    canonicalResolution.range.start
  );

  return heading ? getSectionRange(markdown, headings, heading) : null;
}

function getContainingSectionRange(
  anchor: PatchmarkCommentAnchor,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): { end: number; start: number } | null {
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

    return getSectionRange(markdown, headings, heading);
  }

  const containingHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : null;

  if (containingHeading) {
    return getSectionRange(markdown, headings, containingHeading);
  }

  if (
    typeof anchor.fallback_section_start_offset === "number" &&
    typeof anchor.fallback_section_end_offset === "number"
  ) {
    return {
      end: anchor.fallback_section_end_offset,
      start: anchor.fallback_section_start_offset
    };
  }

  if (typeof anchor.markdown_start_offset === "number") {
    const heading = getHeadingContainingOffset(
      markdown,
      headings,
      anchor.markdown_start_offset
    );

    if (heading) {
      return getSectionRange(markdown, headings, heading);
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
  const exactSelectionRange = selectedOffsets ?? uniqueSelectedTextMatch;
  const markdownSelectionRange = exactSelectionRange
    ? expandMarkdownRangeForVisibleSelection({
        markdown,
        range: exactSelectionRange,
        selectedVisibleText: snapshot.selectedText
      })
    : null;

  return {
    affordanceRect: snapshot.affordanceRect,
    draft: {
      anchorSource: "visual",
      anchorContext,
      markdownEndOffset: markdownSelectionRange?.end,
      markdownStartOffset: markdownSelectionRange?.start,
      selectedText: markdownSelectionRange
        ? markdown.slice(markdownSelectionRange.start, markdownSelectionRange.end)
        : snapshot.selectedText
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
  const direction = getBrowserSelectionDirection(selection);
  const affordanceRect = getBrowserSelectionAffordanceRect({
    direction,
    range
  });
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
    affordanceRect,
    blockText,
    blockKind: getVisualAnchorContextKind(blockElement),
    direction,
    selectedEndInBlock: selectedRangeInBlock?.end,
    selectedStartInBlock: selectedRangeInBlock?.start,
    selectedText
  };
}

function getBrowserSelectionAffordanceRect({
  direction,
  range
}: {
  direction: CommentAffordanceDirection;
  range: Range;
}): CommentAffordanceRect | null {
  const clientRects = Array.from(range.getClientRects()).map(
    toCommentAffordanceRect
  );
  const selectedRect = chooseSelectionAffordanceRect({
    direction,
    rects: clientRects
  });

  if (selectedRect) {
    return selectedRect;
  }

  const boundingRect = toCommentAffordanceRect(range.getBoundingClientRect());

  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function getBrowserSelectionDirection(
  selection: Selection
): CommentAffordanceDirection {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;

  if (!anchorNode || !focusNode || anchorNode === focusNode) {
    return focusOffset < anchorOffset ? "backward" : "forward";
  }

  const position = anchorNode.compareDocumentPosition(focusNode);

  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return "backward";
  }

  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return "forward";
  }

  return "forward";
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
    anchorContext.markdown_text
  ) {
    const mappedRange = mapVisibleSelectionToMarkdownRange({
      contextMarkdown: anchorContext.markdown_text,
      contextStart: anchorContext.markdown_start_offset,
      selectedVisibleText: selectedText,
      visibleEnd: anchorContext.selected_end_in_context,
      visibleStart: anchorContext.selected_start_in_context
    });

    if (mappedRange) {
      return mappedRange;
    }
  }

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
  const previousBlankLineMatches = Array.from(
    beforeSelection.matchAll(/\n[^\S\r\n]*\n/g)
  );
  const previousBlankLineMatch = previousBlankLineMatches.at(-1);
  const nextBlankLineMatch = /\n\s*\n/.exec(afterSelection);
  const start =
    previousBlankLineMatch === undefined
      ? 0
      : previousBlankLineMatch.index + previousBlankLineMatch[0].length;
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
  patches = [],
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
      patches,
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
  patches = [],
  workspaceRect
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  editorTop: number;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  patches?: PatchmarkPatch[];
  workspaceRect: DOMRect;
}): number | null {
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return 0;
  }

  if (anchor.kind === "section") {
    const resolution = resolveCommentAnchor(comment, markdown, headings, patches);

    if (resolution.status !== "active" || typeof resolution.start !== "number") {
      return null;
    }

    if (mode === "visual") {
      const projectionTop = getVisualProjectionTop({
        projection: findVisualCommentAnchorProjection({
          comment,
          container,
          headings,
          markdown,
          patches
        }),
        workspaceRect
      });

      if (projectionTop !== null) {
        return projectionTop;
      }
    }

    return estimateTopForOffset(markdown, resolution.start, editorTop);
  }

  const resolution = resolveCommentAnchor(comment, markdown, headings, patches);

  if (resolution.status === "active" && resolution.start !== undefined) {
    if (mode === "visual") {
      const projectionTop = getVisualProjectionTop({
        projection: findVisualCommentAnchorProjection({
          comment,
          container,
          headings,
          markdown,
          patches
        }),
        workspaceRect
      });

      if (projectionTop !== null) {
        return projectionTop;
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

  if (resolution.status === "ambiguous") {
    const lastKnownRange = getLastKnownCommentAnchorPositionRange(comment);

    return lastKnownRange
      ? estimateTopForOffset(markdown, lastKnownRange.start, editorTop)
      : null;
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

  return headingElement.getBoundingClientRect().top - workspaceRect.top;
}

function getVisualHeadingLevel(element: HTMLElement): number {
  const parsedLevel = Number(element.tagName.replace(/^H/i, ""));

  return Number.isFinite(parsedLevel) ? parsedLevel : 1;
}

function findVisualHeadingElement({
  container,
  heading
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
}): HTMLElement | null {
  const headingElements = getVisualHeadingElements(container);
  const exactMatch = headingElements.find(
    (element) =>
      getVisualHeadingLevel(element) === heading.level &&
      normalizeDomText(element.textContent ?? "") === heading.text
  );

  return (
    exactMatch ??
    headingElements.find(
      (element) => normalizeDomText(element.textContent ?? "") === heading.text
    ) ??
    null
  );
}


function findVisualCommentAnchorProjection({
  comment,
  container,
  headings,
  markdown,
  patches = []
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches?: PatchmarkPatch[];
}): VisualTargetProjection {
  const resolution = resolveCommentAnchor(comment, markdown, headings, patches);

  if (resolution.status !== "active") {
    return {
      commentId: comment.id,
      reason: resolution.status,
      state: "not_projectable"
    };
  }

  if (comment.anchor.kind === "document") {
    return {
      commentId: comment.id,
      reason: "document_anchor",
      state: "not_projectable"
    };
  }

  const markdownRange = {
    end: resolution.end ?? resolution.start ?? 0,
    start: resolution.start ?? 0
  };

  if (comment.anchor.kind === "section") {
    const currentHeading = findHeadingForCanonicalRange({
      anchor: comment.anchor,
      headings,
      markdown,
      resolution
    });
    const headingRange = currentHeading
      ? findVisualHeadingRange({ container, heading: currentHeading })
      : null;
    const headingElement = currentHeading
      ? findVisualHeadingElement({ container, heading: currentHeading })
      : null;

    return headingRange
      ? {
          commentId: comment.id,
          markdownRange,
          projectionMethod: "section_heading",
          state: "resolved",
          structuralElements: headingElement ? [headingElement] : [],
          textRanges: [headingRange]
        }
      : {
          commentId: comment.id,
          reason: "section_heading_not_projected",
          state: "not_projectable"
        };
  }

  const tableProjection = createVisualTableAnchorProjection({
    markdown,
    range: markdownRange
  });
  const tableProjectionMatch = tableProjection
    ? findVisualTableProjectionMatch({ container, projection: tableProjection })
    : null;

  if (tableProjection && tableProjectionMatch) {
    return {
      commentId: comment.id,
      markdownRange,
      projectionMethod: isProjectedTableRow(tableProjection)
        ? "table_row"
        : "table_cell",
      state: "resolved",
      structuralElements: [],
      textRanges: [tableProjectionMatch.range]
    };
  }

  const sourceRangeMatch = findVisualSelectedTextMatchForResolvedSourceRange({
    anchor: comment.anchor,
    container,
    headings,
    markdown,
    resolution
  });

  if (sourceRangeMatch) {
    return {
      commentId: comment.id,
      markdownRange,
      projectionMethod: "source_position",
      state: "resolved",
      structuralElements: [],
      textRanges: [sourceRangeMatch.range]
    };
  }

  const sourceBlockRanges = findVisualSourceBlockRangesForResolvedSourceRange({
    anchor: comment.anchor,
    container,
    headings,
    markdown,
    resolution
  });

  if (sourceBlockRanges.length > 0) {
    return {
      commentId: comment.id,
      markdownRange,
      projectionMethod: "source_blocks",
      state: "resolved",
      structuralElements: [],
      textRanges: sourceBlockRanges
    };
  }

  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor: comment.anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    const selectedMatch = findVisualSelectedTextMatchInsideResolvedContext({
      anchor: comment.anchor,
      container,
      contextMatch,
      markdown,
      resolution
    });

    return {
      commentId: comment.id,
      markdownRange,
      projectionMethod: selectedMatch ? "plain_text_range" : "structural_block",
      state: "resolved",
      structuralElements: [],
      textRanges: [selectedMatch?.range ?? contextMatch.range]
    };
  }

  const uniqueVisibleMatch = findUniqueVisualSelectedTextMatch({
    anchor: comment.anchor,
    container
  });

  return uniqueVisibleMatch
    ? {
        commentId: comment.id,
        markdownRange,
        projectionMethod: "plain_text_range",
        state: "resolved",
        structuralElements: [],
        textRanges: [uniqueVisibleMatch.range]
      }
    : {
        commentId: comment.id,
        reason: "selected_text_not_projected",
        state: "not_projectable"
      };
}

function findHeadingForCanonicalRange({
  anchor,
  headings,
  markdown,
  resolution
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "section" }>;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  if (typeof resolution.start === "number") {
    const headingAtCanonicalStart = headings.find((heading) => {
      const lineRange = getHeadingLineRange(markdown, heading);

      return lineRange.start === resolution.start;
    });

    if (headingAtCanonicalStart) {
      return headingAtCanonicalStart;
    }
  }

  return findMatchingHeading(headings, {
    level: anchor.heading_level,
    text: anchor.heading
  });
}

function isProjectedTableRow(projection: VisualTableAnchorProjection): boolean {
  return projection.rows.some((row) => row.cells.length > 1);
}

function getVisualProjectionPrimaryRange(
  projection: VisualTargetProjection
): Range | null {
  return projection.state === "resolved" ? projection.textRanges[0] ?? null : null;
}

function getVisualProjectionTop({
  projection,
  workspaceRect
}: {
  projection: VisualTargetProjection;
  workspaceRect: DOMRect;
}): number | null {
  const range = getVisualProjectionPrimaryRange(projection);
  const primaryRect = range ? getPrimaryRangeClientRect(range) : null;

  return primaryRect ? primaryRect.top - workspaceRect.top : null;
}

function findVisualHeadingRange({
  container,
  heading
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
}): Range | null {
  const headingElement = findVisualHeadingElement({ container, heading });

  if (!headingElement) {
    return null;
  }

  const range = document.createRange();
  range.selectNodeContents(headingElement);

  return range;
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

  return contextMatch ? contextMatch.top - workspaceRect.top : null;
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
    return contextMatch.top - workspaceRect.top;
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

function findVisualSelectedTextMatchForResolvedSourceRange({
  anchor,
  container,
  headings,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): VisualTextMatch | null {
  if (
    resolution.status !== "active" ||
    typeof resolution.start !== "number" ||
    typeof resolution.end !== "number" ||
    resolution.end < resolution.start
  ) {
    return null;
  }

  const sourceRange = {
    end: resolution.end,
    start: resolution.start
  };
  const visualSectionRange = findVisualSectionRangeForResolvedAnchor({
    anchor,
    container,
    headings,
    markdown,
    resolution
  });
  const sourceSectionRange = findSourceSectionRangeForResolvedAnchor({
    anchor,
    headings,
    markdown,
    resolution
  });

  const sourceMarkdown = markdown.slice(sourceRange.start, sourceRange.end);

  for (const searchText of createVisualAnchorSearchTextCandidates({
    selectedMarkdown: anchor.selected_text,
    sourceMarkdown
  })) {
    const matches = findVisualTextMatches({ container, searchText }).filter(
      (match) =>
        !visualSectionRange || isRangeInsideRange(match.range, visualSectionRange)
    );

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      const sourceOrdinal = getSourceMatchOrdinalInsideScope({
        markdown,
        searchText,
        sourceRange,
        sourceScope: sourceSectionRange
      });

      if (
        typeof sourceOrdinal === "number" &&
        sourceOrdinal >= 0 &&
        sourceOrdinal < matches.length
      ) {
        return matches[sourceOrdinal];
      }
    }
  }

  return null;
}

function findVisualSourceBlockRangesForResolvedSourceRange({
  anchor,
  container,
  headings,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): Range[] {
  if (
    resolution.status !== "active" ||
    typeof resolution.start !== "number" ||
    typeof resolution.end !== "number" ||
    resolution.end <= resolution.start
  ) {
    return [];
  }

  const visualSectionRange = findVisualSectionRangeForResolvedAnchor({
    anchor,
    container,
    headings,
    markdown,
    resolution
  });
  const sourceSectionRange = findSourceSectionRangeForResolvedAnchor({
    anchor,
    headings,
    markdown,
    resolution
  });
  const sourceBlocks = getProjectedMarkdownSourceBlocks(markdown, {
    start: resolution.start,
    end: resolution.end
  });
  const projectedRanges: Range[] = [];

  for (const sourceBlock of sourceBlocks) {
    const projectedRange = findVisualSourceBlockRange({
      container,
      markdown,
      sourceBlock,
      sourceScope: sourceSectionRange,
      visualScope: visualSectionRange
    });

    if (projectedRange) {
      projectedRanges.push(projectedRange);
    }
  }

  return projectedRanges;
}

function findVisualSourceBlockRange({
  container,
  markdown,
  sourceBlock,
  sourceScope,
  visualScope
}: {
  container: HTMLElement;
  markdown: string;
  sourceBlock: { end: number; markdown: string; start: number };
  sourceScope: { end: number; start: number } | null;
  visualScope: Range | null;
}): Range | null {
  for (const searchText of createVisualAnchorSearchTextCandidates({
    sourceMarkdown: sourceBlock.markdown
  })) {
    if (normalizeDomText(searchText).length < 8) {
      continue;
    }

    const matches = findVisualTextMatches({ container, searchText }).filter(
      (match) => !visualScope || isRangeInsideRange(match.range, visualScope)
    );

    if (matches.length === 1) {
      return matches[0].range;
    }

    if (matches.length > 1) {
      const sourceOrdinal = getSourceMatchOrdinalInsideScope({
        markdown,
        searchText,
        sourceRange: {
          start: sourceBlock.start,
          end: sourceBlock.end
        },
        sourceScope
      });

      if (
        typeof sourceOrdinal === "number" &&
        sourceOrdinal >= 0 &&
        sourceOrdinal < matches.length
      ) {
        return matches[sourceOrdinal].range;
      }
    }
  }

  return null;
}

function getProjectedMarkdownSourceBlocks(
  markdown: string,
  sourceRange: { end: number; start: number }
): Array<{ end: number; markdown: string; start: number }> {
  const blocks: Array<{ end: number; markdown: string; start: number }> = [];
  const rangeStart = Math.max(0, Math.min(sourceRange.start, markdown.length));
  const rangeEnd = Math.max(rangeStart, Math.min(sourceRange.end, markdown.length));
  let lineStart = rangeStart;

  while (lineStart < rangeEnd) {
    const nextNewline = markdown.indexOf("\n", lineStart);
    const lineEnd =
      nextNewline === -1 ? rangeEnd : Math.min(nextNewline, rangeEnd);
    const lineText = markdown.slice(lineStart, lineEnd);
    const trimmedRange = trimRange(markdown, lineStart, lineEnd);

    if (lineText.trim() && trimmedRange.end > trimmedRange.start) {
      blocks.push({
        start: trimmedRange.start,
        end: trimmedRange.end,
        markdown: markdown.slice(trimmedRange.start, trimmedRange.end)
      });
    }

    if (nextNewline === -1 || nextNewline >= rangeEnd) {
      break;
    }

    lineStart = nextNewline + 1;
  }

  return blocks;
}

function findVisualSectionRangeForResolvedAnchor({
  anchor,
  container,
  headings,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): Range | null {
  const heading = findSourceHeadingForResolvedAnchor({
    anchor,
    headings,
    markdown,
    resolution
  });

  if (!heading) {
    return null;
  }

  return findVisualSectionRange({ container, heading });
}

function findVisualSectionRange({
  container,
  heading
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
}): Range | null {
  const root = getVisualSearchRoot(container);
  const headingElements = getVisualHeadingElements(container);
  const headingElement = findVisualHeadingElement({ container, heading });

  if (!headingElement) {
    return null;
  }

  const headingIndex = headingElements.findIndex(
    (element) => element === headingElement
  );
  const nextPeerHeading =
    headingIndex === -1
      ? null
      : headingElements
          .slice(headingIndex + 1)
          .find((element) => getVisualHeadingLevel(element) <= heading.level) ??
        null;
  const range = document.createRange();

  range.setStartAfter(headingElement);

  if (nextPeerHeading) {
    range.setEndBefore(nextPeerHeading);
  } else {
    range.setEnd(root, root.childNodes.length);
  }

  return range;
}

function findSourceSectionRangeForResolvedAnchor({
  anchor,
  headings,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): { end: number; start: number } | null {
  const heading = findSourceHeadingForResolvedAnchor({
    anchor,
    headings,
    markdown,
    resolution
  });

  return heading ? getSectionRange(markdown, headings, heading) : null;
}

function findSourceHeadingForResolvedAnchor({
  anchor,
  headings,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  resolution: CommentAnchorResolution;
}): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  const storedHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : undefined;

  return (
    storedHeading ??
    (typeof resolution.start === "number"
      ? getHeadingContainingOffset(markdown, headings, resolution.start)
      : undefined)
  );
}

function getSourceMatchOrdinalInsideScope({
  markdown,
  searchText,
  sourceRange,
  sourceScope
}: {
  markdown: string;
  searchText: string;
  sourceRange: { end: number; start: number };
  sourceScope: { end: number; start: number } | null;
}): number | null {
  const scopedMatches = findMarkdownPlainTextMatches(markdown, searchText).filter(
    (match) =>
      !sourceScope ||
      rangesOverlap(match.start, match.end, sourceScope.start, sourceScope.end)
  );
  const sourceMatchIndex = scopedMatches.findIndex((match) =>
    rangesOverlap(match.start, match.end, sourceRange.start, sourceRange.end)
  );

  return sourceMatchIndex >= 0 ? sourceMatchIndex : null;
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
          top: rect.top
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

function findVisualTableProjectionMatch({
  container,
  projection
}: {
  container: HTMLElement;
  projection: VisualTableAnchorProjection;
}): VisualTextMatch | null {
  const root = getVisualSearchRoot(container);
  const tableElement = Array.from(root.querySelectorAll("table"))[
    projection.tableIndex
  ];

  if (!tableElement) {
    return null;
  }

  const visualRows = Array.from(tableElement.querySelectorAll("tr")).filter(
    (rowElement) => getVisualTableContentCells(rowElement).length > 0
  );
  const rowRanges = projection.rows
    .map((rowProjection) => {
      const visualRowIndex = getVisualTableRowIndex(
        rowProjection.markdownRowIndex
      );
      const rowElement =
        typeof visualRowIndex === "number" ? visualRows[visualRowIndex] : null;

      if (!rowElement) {
        return null;
      }

      const cellElements = getVisualTableContentCells(rowElement);
      const cellRanges = rowProjection.cells
        .map((cellProjection) => {
          const cellElement = cellElements[cellProjection.cellIndex];

          return cellElement
            ? findVisualTextRangeInsideElement(
                cellElement,
                cellProjection.visibleText
              )
            : null;
        })
        .filter((range): range is Range => range !== null);

      return cellRanges.length === rowProjection.cells.length
        ? createRangeFromOrderedRanges(cellRanges)
        : null;
    })
    .filter((range): range is Range => range !== null);

  const range = createRangeFromOrderedRanges(rowRanges);

  if (!range) {
    return null;
  }

  const rect = range.getBoundingClientRect();

  if (rect.height <= 0 && rect.width <= 0) {
    return null;
  }

  return {
    range,
    searchText: "table anchor projection",
    top: rect.top
  };
}

function getVisualTableContentCells(rowElement: Element): HTMLElement[] {
  return Array.from(rowElement.querySelectorAll<HTMLElement>("th, td")).filter(
    (cellElement) =>
      !isVisualTableChromeCell(cellElement) &&
      (Boolean(cellElement.querySelector("[data-lexical-editor]")) ||
        normalizeDomText(cellElement.textContent ?? "").length > 0)
  );
}

function isVisualTableChromeCell(cellElement: HTMLElement): boolean {
  return (
    !cellElement.querySelector("[data-lexical-editor]") &&
    Boolean(
      cellElement.querySelector(
        [
          "button[title='Column menu']",
          "button[title='Row menu']",
          "[class*='tableColumnEditorTrigger']",
          "[class*='tableRowEditorTrigger']"
        ].join(",")
      )
    )
  );
}

function getVisualTableRowIndex(markdownRowIndex: number): number | null {
  if (markdownRowIndex === 0) {
    return 0;
  }

  if (markdownRowIndex < 2) {
    return null;
  }

  return markdownRowIndex - 1;
}

function findVisualTextRangeInsideElement(
  element: HTMLElement,
  searchText: string
): Range | null {
  const matches = findVisualTextMatches({
    container: element,
    searchText
  });

  if (matches[0]) {
    return matches[0].range;
  }

  if (normalizeDomText(element.textContent ?? "") !== normalizeDomText(searchText)) {
    return null;
  }

  const range = document.createRange();
  range.selectNodeContents(element);

  return range;
}

function createRangeFromOrderedRanges(ranges: Range[]): Range | null {
  const firstRange = ranges[0];
  const lastRange = ranges[ranges.length - 1];

  if (!firstRange || !lastRange) {
    return null;
  }

  const range = document.createRange();
  range.setStart(firstRange.startContainer, firstRange.startOffset);
  range.setEnd(lastRange.endContainer, lastRange.endOffset);

  return range;
}

function buildVisualTextIndex(container: HTMLElement): VisualTextIndex {
  const cachedIndex = visualTextIndexCache.get(container);

  if (cachedIndex) {
    return cachedIndex;
  }

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

  const textIndex = {
    positions,
    text: textParts.join("")
  };

  visualTextIndexCache.set(container, textIndex);

  return textIndex;
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
  markdown,
  patches = []
}: {
  clientX: number;
  clientY: number;
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches?: PatchmarkPatch[];
}): string[] {
  if (!container) {
    return [];
  }

  return comments
    .filter((comment) => {
      const projection = findVisualCommentAnchorProjection({
        comment,
        container,
        headings,
        markdown,
        patches
      });

      return projection.state === "resolved"
        ? projection.textRanges.some((range) =>
            isPointInsideRangeClientRects(range, clientX, clientY)
          )
        : false;
    })
    .map((comment) => comment.id);
}

function findVisualCommentAnchorRange({
  comment,
  container,
  headings,
  markdown,
  patches = []
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches?: PatchmarkPatch[];
}): Range | null {
  return getVisualProjectionPrimaryRange(
    findVisualCommentAnchorProjection({
      comment,
      container,
      headings,
      markdown,
      patches
    })
  );
}

function scrollRangeIntoViewportIfNeeded(range: Range): void {
  const primaryRect = getPrimaryRangeClientRect(range);

  if (!primaryRect) {
    return;
  }

  const viewportTopPadding = 160;
  const viewportBottomPadding = 180;
  const safeTop = viewportTopPadding;
  const safeBottom = window.innerHeight - viewportBottomPadding;

  if (primaryRect.top >= safeTop && primaryRect.bottom <= safeBottom) {
    return;
  }

  window.scrollBy({
    behavior: "auto",
    top: Math.round(primaryRect.top - viewportTopPadding)
  });
}

function getPrimaryRangeClientRect(range: Range): DOMRect | null {
  const rect = Array.from(range.getClientRects()).find(
    (clientRect) => clientRect.width > 0 && clientRect.height > 0
  );

  if (rect) {
    return rect;
  }

  const boundingRect = range.getBoundingClientRect();

  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function measureReadingBookmarkPosition({
  bookmark,
  container,
  headings,
  markdown,
  mode,
  patches = []
}: {
  bookmark: PatchmarkReadingBookmark | null;
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  patches?: PatchmarkPatch[];
}): number | null {
  if (!bookmark || !container || mode !== "visual") {
    return null;
  }

  const range = getVisualProjectionPrimaryRange(
    findVisualCommentAnchorProjection({
      comment: createReadingBookmarkAnchorAdapter(bookmark),
      container,
      headings,
      markdown,
      patches
    })
  );
  const primaryRect = range ? getPrimaryRangeClientRect(range) : null;

  return primaryRect
    ? Math.max(
        8,
        Math.round(primaryRect.top - container.getBoundingClientRect().top)
      )
    : null;
}

async function waitForVisualReadingBookmarkRange({
  bookmark,
  container,
  documentKey,
  getActiveDocumentKey,
  headings,
  markdown,
  patches
}: {
  bookmark: PatchmarkReadingBookmark;
  container: HTMLElement | null;
  documentKey: string;
  getActiveDocumentKey: () => string | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  patches: PatchmarkPatch[];
}): Promise<Range | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      !container ||
      getActiveDocumentKey() !== documentKey ||
      container.dataset.documentKey !== documentKey
    ) {
      return null;
    }
    const range = getVisualProjectionPrimaryRange(
      findVisualCommentAnchorProjection({
        comment: createReadingBookmarkAnchorAdapter(bookmark),
        container,
        headings,
        markdown,
        patches
      })
    );
    if (range && getPrimaryRangeClientRect(range)) {
      return range;
    }
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve())
    );
  }
  return null;
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
  activeCommentState,
  comments,
  container,
  headings,
  markdown,
  mode,
  patches = [],
  previewComment
}: {
  activeCommentState: ActiveCommentState;
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  patches?: PatchmarkPatch[];
  previewComment?: PatchmarkComment | null;
}): void {
  const highlightApi = getCssHighlightApi();

  if (!highlightApi) {
    return;
  }

  if (!container || mode !== "visual") {
    deleteVisualCommentHighlightRegistries(highlightApi.registry);
    return;
  }

  const activeCommentIds = getActiveCommentIds(activeCommentState);
  const openSelectedRanges: Range[] = [];
  const resolvedSelectedRanges: Range[] = [];
  const previewRanges: Range[] = [];

  for (const comment of comments) {
    if (!activeCommentIds.includes(comment.id)) {
      continue;
    }

    const projection = findVisualCommentAnchorProjection({
      comment,
      container,
      headings,
      markdown,
      patches
    });

    if (projection.state !== "resolved") {
      continue;
    }

    if (comment.status === "resolved") {
      resolvedSelectedRanges.push(...projection.textRanges);
    } else {
      openSelectedRanges.push(...projection.textRanges);
    }
  }

  if (previewComment) {
    const previewProjection = findVisualCommentAnchorProjection({
      comment: previewComment,
      container,
      headings,
      markdown,
      patches
    });

    if (previewProjection.state === "resolved") {
      previewRanges.push(...previewProjection.textRanges);
    }
  }

  setVisualCommentHighlightRegistry({
    Highlight: highlightApi.Highlight,
    name: COMMENT_OPEN_SELECTED_HIGHLIGHT_NAME,
    ranges: openSelectedRanges,
    registry: highlightApi.registry
  });
  setVisualCommentHighlightRegistry({
    Highlight: highlightApi.Highlight,
    name: COMMENT_REANCHOR_PREVIEW_HIGHLIGHT_NAME,
    ranges: previewRanges,
    registry: highlightApi.registry
  });
  setVisualCommentHighlightRegistry({
    Highlight: highlightApi.Highlight,
    name: COMMENT_RESOLVED_SELECTED_HIGHLIGHT_NAME,
    ranges: resolvedSelectedRanges,
    registry: highlightApi.registry
  });
}

function clearVisualCommentHighlights(): void {
  const highlightApi = getCssHighlightApi();

  if (highlightApi) {
    deleteVisualCommentHighlightRegistries(highlightApi.registry);
  }
}

function updateVisualReadingBookmarkHighlight({
  bookmark,
  container,
  emphasized,
  headings,
  markdown,
  mode,
  patches = []
}: {
  bookmark: PatchmarkReadingBookmark | null;
  container: HTMLElement | null;
  emphasized: boolean;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  patches?: PatchmarkPatch[];
}): void {
  const highlightApi = getCssHighlightApi();
  if (!highlightApi) {
    return;
  }
  if (!bookmark || !container || !emphasized || mode !== "visual") {
    highlightApi.registry.delete(READING_BOOKMARK_HIGHLIGHT_NAME);
    return;
  }
  const projection = findVisualCommentAnchorProjection({
    comment: createReadingBookmarkAnchorAdapter(bookmark),
    container,
    headings,
    markdown,
    patches
  });
  setVisualCommentHighlightRegistry({
    Highlight: highlightApi.Highlight,
    name: READING_BOOKMARK_HIGHLIGHT_NAME,
    ranges: projection.state === "resolved" ? projection.textRanges : [],
    registry: highlightApi.registry
  });
}

function clearVisualReadingBookmarkHighlight(): void {
  getCssHighlightApi()?.registry.delete(READING_BOOKMARK_HIGHLIGHT_NAME);
}

function getActiveCommentIds(activeCommentState: ActiveCommentState): string[] {
  if (activeCommentState.kind === "comment") {
    return [activeCommentState.commentId];
  }

  if (activeCommentState.kind === "anchor_group") {
    return activeCommentState.commentIds;
  }

  return [];
}

function setVisualCommentHighlightRegistry({
  Highlight,
  name,
  ranges,
  registry
}: {
  Highlight: CssHighlightConstructor;
  name: string;
  ranges: Range[];
  registry: CssHighlightRegistry;
}): void {
  if (ranges.length === 0) {
    registry.delete(name);
    return;
  }

  registry.set(name, new Highlight(...ranges));
}

function deleteVisualCommentHighlightRegistries(
  registry: CssHighlightRegistry
): void {
  registry.delete(COMMENT_OPEN_SELECTED_HIGHLIGHT_NAME);
  registry.delete(COMMENT_RESOLVED_SELECTED_HIGHLIGHT_NAME);
  registry.delete(COMMENT_REANCHOR_PREVIEW_HIGHLIGHT_NAME);
}

function createReanchorPreviewComment({
  comments,
  proposal,
  targetCommentId
}: {
  comments: PatchmarkComment[];
  proposal: HumanReanchorProposal | null;
  targetCommentId: string | null;
}): PatchmarkComment | null {
  if (!proposal || !targetCommentId) {
    return null;
  }

  const comment = comments.find((candidate) => candidate.id === targetCommentId);

  return comment
    ? {
        ...comment,
        anchor: proposal.anchor,
        status: "open"
      }
    : null;
}

function getSelectedTextCommentAnchor(
  comment: PatchmarkComment | undefined
): SelectedTextAnchor | null {
  return comment?.anchor.kind === "selected_text" ? comment.anchor : null;
}

function getHumanAnchorStateLabel(status: CommentAnchorStatus): string {
  if (status === "ambiguous") {
    return "Anchor needs review";
  }

  if (status === "not_found") {
    return "Anchor not found";
  }

  return status === "active" ? "Active" : "Document";
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
  headings: ReturnType<typeof parseMarkdownHeadings>,
  patches: PatchmarkPatch[] = []
): CommentAnchorSummary {
  const resolution = resolveCommentAnchor(comment, markdown, headings, patches);

  return {
    detail: resolution.detail,
    label: resolution.label,
    locationLabel: resolution.locationLabel,
    status: resolution.status
  };
}

function getLatestNeedsReviewPatchImpact(
  comment: PatchmarkComment
): PatchmarkCommentPatchImpact | null {
  const latestImpact = comment.patch_impacts?.at(-1);

  return latestImpact?.result === "needs_review" ? latestImpact : null;
}

function getAnchorNeedsReviewDetail(
  latestNeedsReviewImpact: PatchmarkCommentPatchImpact | null
): string {
  return latestNeedsReviewImpact
    ? `Patchmark found multiple possible matches after ${latestNeedsReviewImpact.patch_id}.`
    : "Patchmark found multiple possible matches.";
}

function getAnchorNotFoundDetail(
  latestNeedsReviewImpact: PatchmarkCommentPatchImpact | null
): string {
  return latestNeedsReviewImpact
    ? `The anchor stopped resolving after ${latestNeedsReviewImpact.patch_id} changed this section.`
    : "The anchor text no longer resolves in the current document.";
}

function resolveCommentAnchor(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  patches: PatchmarkPatch[] = []
): CommentAnchorResolution {
  const { anchor } = comment;
  const latestNeedsReviewImpact = getLatestNeedsReviewPatchImpact(comment);

  const knownPositionResolution = resolveCommentAnchorAtKnownPosition(
    comment,
    markdown,
    headings
  );

  if (knownPositionResolution) {
    return knownPositionResolution;
  }

  if (anchor.kind === "document") {
    return {
      label: "Whole document",
      status: "document"
    };
  }

  const canonicalResolution = resolveCanonicalCommentTarget(comment, {
    headings,
    markdown,
    patches
  });

  if (anchor.kind === "section") {
    if (canonicalResolution.state !== "resolved" || !canonicalResolution.range) {
      return {
        label: "Whole section: Target section not found",
        status: "not_found"
      };
    }

    return {
      end: canonicalResolution.range.end,
      label: `Whole section: ${cleanMarkdownHeadingText(anchor.heading)}`,
      start: canonicalResolution.range.start,
      status: "active"
    };
  }

  const selectedTextLocationLabel = getSelectedTextHeadingLabel(anchor);
  const selectedTextLabel = `Selected text in ${selectedTextLocationLabel}`;

  if (canonicalResolution.state === "resolved" && canonicalResolution.range) {
    return {
      end: canonicalResolution.range.end,
      label: selectedTextLabel,
      locationLabel: selectedTextLocationLabel,
      start: canonicalResolution.range.start,
      status: "active"
    };
  }

  if (canonicalResolution.state === "ambiguous") {
    return {
      detail: getAnchorNeedsReviewDetail(latestNeedsReviewImpact),
      label: selectedTextLabel,
      locationLabel: selectedTextLocationLabel,
      status: "ambiguous"
    };
  }

  const contextResolution = resolveSelectedAnchorViaContext(markdown, anchor);

  if (contextResolution.status === "context_found") {
    return {
      contextEnd: contextResolution.contextEnd,
      contextStart: contextResolution.contextStart,
      detail: getAnchorNotFoundDetail(latestNeedsReviewImpact),
      label: selectedTextLabel,
      locationLabel: selectedTextLocationLabel,
      status: "not_found"
    };
  }

  if (latestNeedsReviewImpact) {
    return {
      detail: getAnchorNotFoundDetail(latestNeedsReviewImpact),
      label: selectedTextLabel,
      locationLabel: selectedTextLocationLabel,
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
      detail: getAnchorNotFoundDetail(latestNeedsReviewImpact),
      fallbackEnd: lineRange.end,
      fallbackStart: lineRange.start,
      label: selectedTextLabel,
      locationLabel: selectedTextLocationLabel,
      status: "not_found"
    };
  }

  return {
    detail: "Anchor not found. The text may have changed.",
    label: selectedTextLabel,
    locationLabel: selectedTextLocationLabel,
    status: "not_found"
  };
}

function resolveCommentAnchorAtKnownPosition(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CommentAnchorResolution | null {
  const { anchor } = comment;

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
      return null;
    }

    const range = getHeadingLineRange(markdown, currentHeading);

    return {
      end: range.end,
      label: `Whole section: ${cleanMarkdownHeadingText(anchor.heading)}`,
      start: range.start,
      status: "active"
    };
  }

  if (
    typeof anchor.markdown_start_offset !== "number" ||
    typeof anchor.markdown_end_offset !== "number" ||
    anchor.markdown_end_offset <= anchor.markdown_start_offset ||
    markdown.slice(anchor.markdown_start_offset, anchor.markdown_end_offset) !==
      anchor.selected_text
  ) {
    return null;
  }

  const selectedTextLocationLabel = getSelectedTextHeadingLabel(anchor);

  return {
    end: anchor.markdown_end_offset,
    label: `Selected text in ${selectedTextLocationLabel}`,
    locationLabel: selectedTextLocationLabel,
    start: anchor.markdown_start_offset,
    status: "active"
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
  if (!anchor.selected_text) {
    return [];
  }

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

function getSelectedTextHeadingLabel(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): string {
  return getSelectedTextLocationLabel(anchor);
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
    let index = getMarkdownPlainTextLineContentStart(line);

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

function getMarkdownPlainTextLineContentStart(line: string): number {
  let index = 0;

  while (index < line.length) {
    const prefixMatch = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.exec(
      line.slice(index)
    );

    if (!prefixMatch) {
      break;
    }

    index += prefixMatch[0].length;
  }

  return index;
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
  const normalizedTargetText = normalizePatchTargetHeading(target.text);

  return headings.find(
    (heading) =>
      (heading.text === target.text ||
        normalizePatchTargetHeading(heading.text) === normalizedTargetText) &&
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
  if (cachedDocumentLineStartOffsets?.markdown === markdown) {
    return cachedDocumentLineStartOffsets.offsets;
  }

  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  cachedDocumentLineStartOffsets = { markdown, offsets };

  return offsets;
}

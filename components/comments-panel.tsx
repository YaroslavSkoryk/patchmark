"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import {
  ActionMenu,
  ActionMenuGroup,
  ActionMenuItem
} from "@/components/action-menu";
import { type MarkdownHeading } from "@/lib/markdown/parse-headings";
import {
  createFloatingCommentLayout,
  getStageRelativePreferredTop
} from "@/lib/comments/floating-comment-layout";
import {
  getLatestDocumentSwitchPerformanceOperationId,
  incrementDocumentSwitchPerformanceCounter,
  recordDocumentSwitchPerformanceDuration
} from "@/lib/performance/document-switch-performance";
import { sortCommentsByLastKnownAnchorPosition } from "@/lib/comments/comment-anchor-position";
import {
  getVisibleAnchorStatus,
  getPatchImpactForCurrentAnchorDisplay,
  getVisibleCommentThreadEntries,
} from "@/lib/comments/comment-anchor-state";
import { getLatestEditableUserReply } from "@/lib/comments/comment-thread-reply-edit";
import {
  getCleanCommentAnchorLabel,
  getCollapsedCommentTarget
} from "@/lib/comments/comment-card-display";
import {
  createCommentTrashSelectionKey,
  getVisibleActiveComments,
  type CommentTrashSummary
} from "@/lib/comments/comment-trash-operations";
import type {
  CommentPermanentDeletionMode,
  CommentPermanentDeletionSummary
} from "@/lib/comments/comment-permanent-deletion-operations";
import {
  type CommentAnchorStatus,
  type PatchmarkComment,
  type PatchmarkCommentAnchor,
  type PatchmarkSelectedTextAnchorContextKind,
  type PatchmarkCommentThreadEntry,
  type PatchmarkCommentType
} from "@/lib/project/project-types";

export type CommentAnchorScope = PatchmarkCommentAnchor["kind"];

export type CommentAddRequest = {
  nonce: number;
  positionTop?: number | null;
  scope: CommentAnchorScope;
  targetHeadingLine?: number | null;
};

export type CommentReplyRequest = {
  commentId: string;
  nonce: number;
};

export type CommentFormValues = {
  anchorScope: CommentAnchorScope;
  comment: string;
  targetHeadingLine: number | null;
  type: PatchmarkCommentType;
};

export type CommentAnchorSummary = {
  detail?: string;
  label: string;
  locationLabel?: string;
  status: CommentAnchorStatus;
};

export type CommentPatchGroupSummary = {
  accepted: number;
  groupCount: number;
  latestAcceptedTitle?: string;
  patchCount: number;
  pending: number;
  rejected: number;
  stale: number;
};

export type ActiveCommentState =
  | { kind: "none" }
  | { kind: "comment"; commentId: string }
  | { kind: "anchor_group"; commentIds: string[] };

type CommentsPanelProps = {
  addRequest: CommentAddRequest | null;
  activeCommentState: ActiveCommentState;
  anchorSummaries: Record<string, CommentAnchorSummary>;
  commentPositions: Record<string, number>;
  comments: PatchmarkComment[];
  documentId: string | null;
  documentTitle: string;
  defaultSectionLine: number | null;
  error: string | null;
  headings: MarkdownHeading[];
  isBusy: boolean;
  isDocumentCommentAvailable: boolean;
  isProjectMode: boolean;
  onAddComment: (values: CommentFormValues) => Promise<void>;
  onClosePanel?: () => void;
  onCloseAddComment: (reason: "cancel" | "submit") => void;
  onMoveCommentsToTrash: (request: {
    commentIds: string[];
    expectedSelectionFingerprint: string;
    unsavedDraftCommentIds: string[];
  }) => Promise<void>;
  onPermanentlyDeleteComments: (request: {
    commentIds: string[];
    confirmationPhrase: string;
    expectedSelectionFingerprint: string;
    mode: CommentPermanentDeletionMode;
    unsavedDraftCommentIds: string[];
  }) => Promise<void>;
  onOpenReviewBatch: (batchId: string) => void;
  onPrepareMoveCommentsToTrash: (
    commentIds: string[],
    unsavedDraftCommentIds: string[]
  ) => Promise<CommentTrashSummary>;
  onPreparePermanentDeleteComments: (
    commentIds: string[],
    unsavedDraftCommentIds: string[],
    mode: CommentPermanentDeletionMode
  ) => Promise<CommentPermanentDeletionSummary>;
  onRestoreCommentsFromTrash: (commentIds: string[]) => Promise<void>;
  onEditComment: (
    commentId: string,
    values: Pick<CommentFormValues, "comment" | "type">
  ) => Promise<void>;
  onEditReply: (
    commentId: string,
    entryId: string,
    content: string
  ) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onOpenDocumentComment: () => void;
  onReopenComment: (commentId: string) => Promise<void>;
  onReplyComment: (commentId: string, content: string) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onStartReanchor: (commentId: string) => void;
  onReviewFirstPendingPatch: () => void;
  onResolveComment: (commentId: string) => Promise<void>;
  onSetActiveCommentState: (state: ActiveCommentState) => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
  closePanelLabel?: string;
  patchGroupSummariesByCommentId: Record<string, CommentPatchGroupSummary>;
  pendingPatchGroupTotal: number;
  pendingPatchCountsByCommentId: Record<string, number>;
  pendingPatchTotal: number;
  projectId: string | null;
  replyRequest: CommentReplyRequest | null;
  selectedAnchorContextKind: PatchmarkSelectedTextAnchorContextKind | null;
  selectedTextPreview: string | null;
  spatialLayout?: boolean;
  trashedComments: PatchmarkComment[];
};

const commentTypeOptions: PatchmarkCommentType[] = [
  "note",
  "question",
  "risk",
  "research_needed",
  "decision_needed"
];
const COMMENT_CARD_GAP = 12;
const COMMENT_CARD_COMPACT_FALLBACK_HEIGHT = 110;
const COMMENT_CARD_ACTIVE_FALLBACK_HEIGHT = 320;
const COMMENT_ADD_FORM_FALLBACK_HEIGHT = 260;
const COMMENT_FLOATING_DRAFT_ID = "PM-COMMENT-DRAFT-FORM";
const COMMENT_FLOATING_STAGE_MIN_HEIGHT = 220;
const COMMENT_LAYOUT_DEBUG_STORAGE_KEY = "patchmark:debug-comment-layout";
const COMPACT_COMMENT_COMPOSER_QUERY = "(max-width: 900px)";
const EMPTY_COMMENT_POSITIONS: Record<string, number> = {};

type ActiveCommentFilter = "all" | "open" | "resolved";
type TrashCommentFilter = "all" | "open" | "resolved";
type CommentTrashDialogState = {
  commentIds: string[];
  summary: CommentTrashSummary;
  unsavedDraftCommentIds: string[];
};
type CommentPermanentDeletionDialogState = {
  commentIds: string[];
  confirmationInput: string;
  mode: CommentPermanentDeletionMode;
  summary: CommentPermanentDeletionSummary;
  unsavedDraftCommentIds: string[];
};

type FloatingLayoutItem =
  | {
      comment: PatchmarkComment;
      createdAt: string;
      fallbackHeight: number;
      id: string;
      kind: "comment";
      preferredTop: number;
    }
  | {
      createdAt: string;
      fallbackHeight: number;
      id: string;
      kind: "draft";
      preferredTop: number;
    };

export function CommentsPanel({
  addRequest,
  activeCommentState,
  anchorSummaries,
  commentPositions,
  comments,
  documentId,
  documentTitle,
  defaultSectionLine,
  error,
  headings,
  isBusy,
  isDocumentCommentAvailable,
  isProjectMode,
  onAddComment,
  onClosePanel,
  onCloseAddComment,
  onMoveCommentsToTrash,
  onPermanentlyDeleteComments,
  onOpenReviewBatch,
  onPrepareMoveCommentsToTrash,
  onPreparePermanentDeleteComments,
  onRestoreCommentsFromTrash,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onOpenDocumentComment,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onStartReanchor,
  onReviewFirstPendingPatch,
  onResolveComment,
  onSetActiveCommentState,
  onUnmarkCommentForExport,
  closePanelLabel = "Collapse comments",
  patchGroupSummariesByCommentId,
  pendingPatchGroupTotal,
  pendingPatchCountsByCommentId,
  pendingPatchTotal,
  projectId,
  replyRequest,
  selectedAnchorContextKind,
  selectedTextPreview,
  spatialLayout = true,
  trashedComments
}: CommentsPanelProps) {
  const handledAddRequestNonceRef = useRef<number | null>(null);
  const handledReplyRequestNonceRef = useRef<number | null>(null);
  const addFormRef = useRef<HTMLFormElement | null>(null);
  const addCommentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addScope, setAddScope] = useState<CommentAnchorScope>("document");
  const [addType, setAddType] = useState<PatchmarkCommentType>("note");
  const [addTargetLine, setAddTargetLine] = useState("");
  const [addComment, setAddComment] = useState("");
  const [addPositionTop, setAddPositionTop] = useState<number | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editType, setEditType] = useState<PatchmarkCommentType>("note");
  const [editComment, setEditComment] = useState("");
  const [replyingCommentId, setReplyingCommentId] = useState<string | null>(null);
  const [replyComment, setReplyComment] = useState("");
  const [editingReply, setEditingReply] = useState<{
    commentId: string;
    entryId: string;
  } | null>(null);
  const [editReplyContent, setEditReplyContent] = useState("");
  const [replyEditError, setReplyEditError] = useState("");
  const [formError, setFormError] = useState("");
  const [activeFilter, setActiveFilter] =
    useState<ActiveCommentFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedCommentKeys, setSelectedCommentKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [selectionNotice, setSelectionNotice] = useState("");
  const [trashDialog, setTrashDialog] =
    useState<CommentTrashDialogState | null>(null);
  const [permanentDeletionDialog, setPermanentDeletionDialog] =
    useState<CommentPermanentDeletionDialogState | null>(null);
  const [trashFilter, setTrashFilter] = useState<TrashCommentFilter>("all");
  const [selectedTrashKeys, setSelectedTrashKeys] = useState<Set<string>>(
    () => new Set()
  );
  const moveToTrashButtonRef = useRef<HTMLButtonElement | null>(null);
  const trashSummaryRef = useRef<HTMLElement | null>(null);
  const trashDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const permanentDeletionReturnFocusRef = useRef<HTMLElement | null>(null);
  const isCompactCommentComposer = useCompactCommentComposer();
  const useSpatialCommentLayout =
    spatialLayout && !isCompactCommentComposer;
  const canUseSelectedText = Boolean(selectedTextPreview);
  const canUseSection = headings.length > 0;
  const openCommentCount = comments.filter(
    (comment) => comment.status === "open"
  ).length;
  const visibleComments = useMemo(() => {
    return getVisibleActiveComments({
      comments,
      searchQuery,
      status: activeFilter
    });
  }, [activeFilter, comments, searchQuery]);
  const visibleTrashedComments = useMemo(
    () =>
      trashedComments.filter(
        (comment) => trashFilter === "all" || comment.status === trashFilter
      ),
    [trashFilter, trashedComments]
  );
  const selectedCommentIds = useMemo(
    () =>
      comments
        .filter((comment) =>
          selectedCommentKeys.has(
            createCommentTrashSelectionKey({
              commentId: comment.id,
              documentId: documentId ?? "",
              projectId: projectId ?? ""
            })
          )
        )
        .map((comment) => comment.id),
    [comments, documentId, projectId, selectedCommentKeys]
  );
  const selectedTrashCommentIds = useMemo(
    () =>
      trashedComments
        .filter((comment) =>
          selectedTrashKeys.has(
            createCommentTrashSelectionKey({
              commentId: comment.id,
              documentId: documentId ?? "",
              projectId: projectId ?? ""
            })
          )
        )
        .map((comment) => comment.id),
    [documentId, projectId, selectedTrashKeys, trashedComments]
  );

  const openAddForm = useCallback((
    preferredScope?: CommentAnchorScope,
    preferredHeadingLine?: number | null,
    preferredPositionTop?: number | null
  ) => {
    let nextScope = preferredScope ?? "document";

    if (nextScope === "selected_text" && !canUseSelectedText) {
      nextScope = canUseSection ? "section" : "document";
    }

    if (nextScope === "section" && !canUseSection) {
      nextScope = "document";
    }

    setAddScope(nextScope);
    setAddTargetLine(
      (nextScope === "section" || nextScope === "selected_text") &&
        (preferredHeadingLine ?? defaultSectionLine)
        ? String(preferredHeadingLine ?? defaultSectionLine)
        : ""
    );
    setEditingCommentId(null);
    setReplyingCommentId(null);
    setReplyComment("");
    setEditingReply(null);
    setEditReplyContent("");
    setReplyEditError("");
    setAddPositionTop(preferredPositionTop ?? null);
    setIsAdding(true);
    setFormError("");
  }, [canUseSection, canUseSelectedText, defaultSectionLine]);

  useEffect(() => {
    if (
      !addRequest ||
      handledAddRequestNonceRef.current === addRequest.nonce
    ) {
      return;
    }

    handledAddRequestNonceRef.current = addRequest.nonce;
    openAddForm(
      addRequest.scope,
      addRequest.targetHeadingLine ?? null,
      addRequest.positionTop ?? null
    );
  }, [addRequest, openAddForm]);

  useEffect(() => {
    if (!isAdding) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      addFormRef.current?.scrollIntoView({ block: "nearest" });
      addCommentInputRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isAdding]);

  function closeAddForm(reason: "cancel" | "submit") {
    setAddComment("");
    setAddTargetLine("");
    setAddPositionTop(null);
    setAddType("note");
    setAddScope("document");
    setIsAdding(false);
    setFormError("");
    onCloseAddComment(reason);
  }

  async function handleAddComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const trimmedComment = addComment.trim();

    if (!trimmedComment) {
      setFormError("Comment text is required.");
      return;
    }

    if (addScope === "selected_text" && !canUseSelectedText) {
      setFormError("Select text in the editor before saving this comment.");
      return;
    }

    if (addScope === "section" && !addTargetLine) {
      setFormError("Choose a target section.");
      return;
    }

    try {
      await onAddComment({
        anchorScope: addScope,
        comment: trimmedComment,
        targetHeadingLine: addTargetLine ? Number(addTargetLine) : null,
        type: addType
      });
      closeAddForm("submit");
    } catch {
      setFormError("Could not save comment. Your draft is still here.");
    }
  }

  function startEditing(comment: PatchmarkComment) {
    onSetActiveCommentState({ kind: "comment", commentId: comment.id });
    setEditingCommentId(comment.id);
    setIsAdding(false);
    setAddPositionTop(null);
    setReplyingCommentId(null);
    setReplyComment("");
    setEditingReply(null);
    setEditReplyContent("");
    setReplyEditError("");
    setEditType(comment.type);
    setEditComment(comment.comment);
    setFormError("");
  }

  function startReplying(comment: PatchmarkComment) {
    onSetActiveCommentState({ kind: "comment", commentId: comment.id });
    setReplyingCommentId(comment.id);
    setReplyComment("");
    setEditingCommentId(null);
    setEditingReply(null);
    setEditReplyContent("");
    setReplyEditError("");
    setIsAdding(false);
    setAddPositionTop(null);
    setFormError("");
  }

  function startEditingReply(
    comment: PatchmarkComment,
    entry: PatchmarkCommentThreadEntry
  ) {
    onSetActiveCommentState({ kind: "comment", commentId: comment.id });
    setEditingReply({
      commentId: comment.id,
      entryId: entry.id
    });
    setEditReplyContent(entry.content);
    setReplyEditError("");
    setEditingCommentId(null);
    setReplyingCommentId(null);
    setReplyComment("");
    setIsAdding(false);
    setAddPositionTop(null);
    setFormError("");
  }

  function stopEditingReply() {
    setEditingReply(null);
    setEditReplyContent("");
    setReplyEditError("");
  }

  useEffect(() => {
    if (
      !replyRequest ||
      handledReplyRequestNonceRef.current === replyRequest.nonce
    ) {
      return;
    }

    handledReplyRequestNonceRef.current = replyRequest.nonce;
    const comment = comments.find(
      (candidate) => candidate.id === replyRequest.commentId
    );

    if (!comment || comment.status !== "open") {
      return;
    }

    onSetActiveCommentState({ kind: "comment", commentId: comment.id });
    setReplyingCommentId(comment.id);
    setReplyComment("");
    setEditingCommentId(null);
    setIsAdding(false);
    setAddPositionTop(null);
    setFormError("");
  }, [comments, onSetActiveCommentState, replyRequest]);

  useEffect(() => {
    if (
      !replyingCommentId ||
      replyRequest?.commentId !== replyingCommentId
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(
        `patchmark-comment-card-${replyingCommentId}`
      );
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card
        ?.querySelector<HTMLTextAreaElement>("[data-comment-reply-input]")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [replyingCommentId, replyRequest]);

  async function handleEditComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!editingCommentId) {
      return;
    }

    const trimmedComment = editComment.trim();

    if (!trimmedComment) {
      setFormError("Comment text is required.");
      return;
    }

    try {
      await onEditComment(editingCommentId, {
        comment: trimmedComment,
        type: editType
      });
      setEditingCommentId(null);
      setEditComment("");
      setFormError("");
    } catch {
      setFormError("Could not update comment. Your draft is still here.");
    }
  }

  async function handleReplyComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!replyingCommentId) {
      return;
    }

    const trimmedReply = replyComment.trim();

    if (!trimmedReply) {
      setFormError("Reply text is required.");
      return;
    }

    try {
      await onReplyComment(replyingCommentId, trimmedReply);
      setReplyingCommentId(null);
      setReplyComment("");
      setFormError("");
    } catch {
      setFormError("Could not save reply. Your draft is still here.");
    }
  }

  async function handleEditReply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReplyEditError("");

    if (!editingReply) {
      return;
    }

    if (!editReplyContent.trim()) {
      setReplyEditError("Reply text is required.");
      return;
    }

    try {
      await onEditReply(
        editingReply.commentId,
        editingReply.entryId,
        editReplyContent
      );
      stopEditingReply();
    } catch {
      setReplyEditError("Could not update reply. Your draft is still here.");
    }
  }

  function getSelectionKey(commentId: string): string {
    return createCommentTrashSelectionKey({
      commentId,
      documentId: documentId ?? "",
      projectId: projectId ?? ""
    });
  }

  function getUnsavedDraftCommentIds(): string[] {
    return [
      ...(replyingCommentId && replyComment.trim()
        ? [replyingCommentId]
        : []),
      ...(editingCommentId &&
      (editComment !==
        comments.find((comment) => comment.id === editingCommentId)?.comment ||
        editType !==
          comments.find((comment) => comment.id === editingCommentId)?.type)
        ? [editingCommentId]
        : []),
      ...(editingReply && editReplyContent.trim()
        ? [editingReply.commentId]
        : [])
    ];
  }

  function clearBulkSelection(notice = "") {
    setSelectedCommentKeys(new Set());
    setSelectionNotice(notice);
  }

  function updateActiveFilter(nextFilter: ActiveCommentFilter) {
    setActiveFilter(nextFilter);
    if (isSelectionMode && selectedCommentKeys.size > 0) {
      clearBulkSelection("Selection cleared because the active filter changed.");
    }
  }

  function updateSearchQuery(nextQuery: string) {
    setSearchQuery(nextQuery);
    if (isSelectionMode && selectedCommentKeys.size > 0) {
      clearBulkSelection("Selection cleared because the comment search changed.");
    }
  }

  function toggleSelectedComment(commentId: string) {
    const key = getSelectionKey(commentId);
    setSelectedCommentKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    setSelectionNotice("");
  }

  function toggleSelectedTrashComment(commentId: string) {
    const key = getSelectionKey(commentId);
    setSelectedTrashKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function openTrashConfirmation(
    commentIds: string[],
    returnFocusElement?: HTMLElement | null
  ) {
    if (commentIds.length === 0) {
      return;
    }

    try {
      const activeElement =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null;
      trashDialogReturnFocusRef.current =
        returnFocusElement ?? activeElement ?? moveToTrashButtonRef.current;
      const unsavedDraftCommentIds = getUnsavedDraftCommentIds();
      const summary = await onPrepareMoveCommentsToTrash(
        commentIds,
        unsavedDraftCommentIds
      );
      setTrashDialog({
        commentIds,
        summary,
        unsavedDraftCommentIds
      });
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not prepare the Trash summary."
      );
    }
  }

  async function confirmMoveCommentsToTrash() {
    if (!trashDialog || trashDialog.summary.blockers.length > 0) {
      return;
    }

    try {
      await onMoveCommentsToTrash({
        commentIds: trashDialog.commentIds,
        expectedSelectionFingerprint: trashDialog.summary.selectionFingerprint,
        unsavedDraftCommentIds: trashDialog.unsavedDraftCommentIds
      });
      setTrashDialog(null);
      setIsSelectionMode(false);
      clearBulkSelection();
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not move comments to Trash. The selection is available to retry."
      );
    }
  }

  async function restoreComments(commentIds: string[]) {
    if (commentIds.length === 0) {
      return;
    }

    try {
      await onRestoreCommentsFromTrash(commentIds);
      setSelectedTrashKeys(new Set());
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not restore comments from Trash."
      );
    }
  }

  async function openPermanentDeletionConfirmation({
    commentIds,
    mode,
    returnFocusElement
  }: {
    commentIds: string[];
    mode: CommentPermanentDeletionMode;
    returnFocusElement?: HTMLElement | null;
  }) {
    if (commentIds.length === 0) {
      return;
    }
    try {
      const activeElement =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null;
      permanentDeletionReturnFocusRef.current =
        returnFocusElement ?? activeElement;
      const unsavedDraftCommentIds = getUnsavedDraftCommentIds();
      const summary = await onPreparePermanentDeleteComments(
        commentIds,
        unsavedDraftCommentIds,
        mode
      );
      setPermanentDeletionDialog({
        commentIds,
        confirmationInput: "",
        mode,
        summary,
        unsavedDraftCommentIds
      });
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not prepare the permanent-deletion summary."
      );
    }
  }

  async function confirmPermanentDeletion() {
    if (
      !permanentDeletionDialog ||
      permanentDeletionDialog.summary.blockers.length > 0
    ) {
      return;
    }
    try {
      await onPermanentlyDeleteComments({
        commentIds: permanentDeletionDialog.commentIds,
        confirmationPhrase: permanentDeletionDialog.confirmationInput,
        expectedSelectionFingerprint:
          permanentDeletionDialog.summary.selectionFingerprint,
        mode: permanentDeletionDialog.mode,
        unsavedDraftCommentIds:
          permanentDeletionDialog.unsavedDraftCommentIds
      });
      setPermanentDeletionDialog(null);
      setSelectedTrashKeys(new Set());
      window.requestAnimationFrame(() => trashSummaryRef.current?.focus());
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Permanent deletion failed. Trash remains unchanged."
      );
    }
  }

  const addForm = isAdding ? (
    <form
      ref={addFormRef}
      aria-label="Add comment"
      className="comment-form comment-form-popover"
      data-testid="comment-composer"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAddForm("cancel");
        }
      }}
      onSubmit={handleAddComment}
    >
      <CommentAnchorPreview
        anchorContextKind={selectedAnchorContextKind}
        headings={headings}
        scope={addScope}
        selectedTextPreview={selectedTextPreview}
        targetHeadingLine={addTargetLine ? Number(addTargetLine) : null}
      />
      <CommentTypeSelect value={addType} onChange={setAddType} />
      <label>
        <span>Comment text</span>
        <textarea
          ref={addCommentInputRef}
          aria-label="Comment text"
          data-comment-composer-input
          required
          value={addComment}
          onChange={(event) => setAddComment(event.target.value)}
        />
      </label>
      <div className="comment-form-actions">
        <button type="submit" disabled={isBusy}>
          Save Comment
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => closeAddForm("cancel")}
        >
          Cancel
        </button>
      </div>
    </form>
  ) : null;

  return (
    <section
      className="comments-panel"
      aria-label="Comments"
      data-comment-layout={useSpatialCommentLayout ? "spatial" : "compact"}
    >
      <header className="comments-panel-header">
        <div>
          <h2>Comments</h2>
          <span aria-live="polite">
            {comments.length} total · {openCommentCount} open
          </span>
        </div>
        {onClosePanel ? (
          <button
            type="button"
            className="comments-panel-close"
            aria-label={closePanelLabel}
            onClick={onClosePanel}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </header>
      {!isProjectMode ? (
        <p className="comments-empty">
          Comments are available in Project Folder Mode.
        </p>
      ) : error ? (
        <p className="comments-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          {formError ? (
            <p className="comments-error" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="comments-primary-actions">
            <button
              type="button"
              disabled={
                isBusy || !isDocumentCommentAvailable || isAdding
              }
              onClick={onOpenDocumentComment}
            >
              Comment on whole document
            </button>
            <button
              type="button"
              disabled={isBusy || comments.length === 0}
              aria-pressed={isSelectionMode}
              onClick={() => {
                if (isSelectionMode) {
                  setIsSelectionMode(false);
                  clearBulkSelection();
                } else {
                  setIsSelectionMode(true);
                  setSelectionNotice("");
                }
              }}
            >
              {isSelectionMode ? "Exit selection mode" : "Select comments"}
            </button>
          </div>
          {comments.length > 0 ? (
            <details className="comment-list-tools">
              <summary>
                Find and filter
                {searchQuery || activeFilter !== "all" ? (
                  <span> · Filtered</span>
                ) : null}
              </summary>
              <div className="comment-filter-bar">
                <label>
                  <span>Find comments</span>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => updateSearchQuery(event.target.value)}
                  />
                </label>
                <label>
                  <span>Active comments</span>
                  <select
                    value={activeFilter}
                    onChange={(event) =>
                      updateActiveFilter(event.target.value as ActiveCommentFilter)
                    }
                  >
                    <option value="all">All active</option>
                    <option value="open">Open</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </label>
                <span>
                  {visibleComments.length} of {comments.length} active
                </span>
              </div>
            </details>
          ) : null}
          {isSelectionMode ? (
            <div
              className="comment-bulk-action-bar"
              aria-label="Bulk comment actions"
            >
              <strong aria-live="polite">
                {selectedCommentIds.length} comment
                {selectedCommentIds.length === 1 ? "" : "s"} selected
              </strong>
              <button
                type="button"
                disabled={isBusy || visibleComments.length === 0}
                onClick={() => {
                  setSelectedCommentKeys(
                    new Set(visibleComments.map((comment) => getSelectionKey(comment.id)))
                  );
                  setSelectionNotice(
                    `${visibleComments.length} visible comment${
                      visibleComments.length === 1 ? "" : "s"
                    } selected.`
                  );
                }}
              >
                Select all visible
              </button>
              <button
                type="button"
                disabled={selectedCommentIds.length === 0}
                onClick={() => clearBulkSelection("Selection cleared.")}
              >
                Clear selection
              </button>
              <button
                ref={moveToTrashButtonRef}
                type="button"
                disabled={isBusy || selectedCommentIds.length === 0}
                onClick={(event) =>
                  void openTrashConfirmation(
                    selectedCommentIds,
                    event.currentTarget
                  )
                }
              >
                Move to Trash
              </button>
            </div>
          ) : null}
          {selectionNotice ? (
            <p className="comment-selection-notice" role="status">
              {selectionNotice}
            </p>
          ) : null}
          {pendingPatchTotal > 0 ? (
            <div className="patch-summary-card">
              <span>
                Pending patch group
                {pendingPatchGroupTotal === 1 ? "" : "s"}:{" "}
                {pendingPatchGroupTotal}
              </span>
              <span>
                Pending patch{pendingPatchTotal === 1 ? "" : "es"}:{" "}
                {pendingPatchTotal}
              </span>
              <button
                type="button"
                disabled={isBusy}
                onClick={onReviewFirstPendingPatch}
              >
                Review group{pendingPatchGroupTotal === 1 ? "" : "s"}
              </button>
            </div>
          ) : null}

          <FloatingCommentList
            addForm={isCompactCommentComposer ? null : addForm}
            addPositionTop={useSpatialCommentLayout ? addPositionTop : null}
            activeCommentState={activeCommentState}
            anchorSummaries={anchorSummaries}
            commentPositions={
              useSpatialCommentLayout
                ? commentPositions
                : EMPTY_COMMENT_POSITIONS
            }
            compactList={!useSpatialCommentLayout}
            comments={visibleComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            isBusy={isBusy}
            onDeleteComment={async (commentId) =>
              openTrashConfirmation([commentId])
            }
            onEditComment={handleEditComment}
            onEditReply={handleEditReply}
            onFindComment={onFindComment}
            onMarkCommentForExport={onMarkCommentForExport}
            onReopenComment={onReopenComment}
            onReplyComment={handleReplyComment}
            onReviewCommentPatches={onReviewCommentPatches}
            onStartReanchor={onStartReanchor}
            onResolveComment={onResolveComment}
            onSetActiveCommentState={onSetActiveCommentState}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onSetEditReplyContent={setEditReplyContent}
            onSetReplyComment={setReplyComment}
            onStartEditing={startEditing}
            onStartEditingReply={startEditingReply}
            onStartReplying={startReplying}
            onStopEditing={() => setEditingCommentId(null)}
            onStopEditingReply={stopEditingReply}
            onStopReplying={() => {
              setReplyingCommentId(null);
              setReplyComment("");
            }}
            onUnmarkCommentForExport={onUnmarkCommentForExport}
            patchGroupSummariesByCommentId={patchGroupSummariesByCommentId}
            pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
            editingReply={editingReply}
            editReplyContent={editReplyContent}
            replyEditError={replyEditError}
            replyingCommentId={replyingCommentId}
            replyComment={replyComment}
            isSelectionMode={isSelectionMode}
            onToggleSelection={toggleSelectedComment}
            selectedCommentKeys={selectedCommentKeys}
            getSelectionKey={getSelectionKey}
          />
          {isCompactCommentComposer && addForm
            ? createPortal(
                <div className="comment-composer-backdrop">
                  <div
                    aria-label="Add comment"
                    aria-modal="true"
                    className="comment-composer-sheet"
                    role="dialog"
                  >
                    {addForm}
                  </div>
                </div>,
                document.body
              )
            : null}
          <details className="comment-trash-section">
            <summary ref={trashSummaryRef} tabIndex={-1}>
              Trash · {trashedComments.length}
            </summary>
            <div className="comment-trash-controls">
              <label>
                <span>Show</span>
                <select
                  value={trashFilter}
                  onChange={(event) => {
                    setTrashFilter(event.target.value as TrashCommentFilter);
                    setSelectedTrashKeys(new Set());
                  }}
                >
                  <option value="all">All trashed</option>
                  <option value="open">Originally open</option>
                  <option value="resolved">Originally resolved</option>
                </select>
              </label>
              {visibleTrashedComments.length > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      setSelectedTrashKeys(
                        new Set(
                          visibleTrashedComments.map((comment) =>
                            getSelectionKey(comment.id)
                          )
                        )
                      )
                    }
                  >
                    Select all shown
                  </button>
                  <button
                    type="button"
                    disabled={selectedTrashCommentIds.length === 0}
                    onClick={() => setSelectedTrashKeys(new Set())}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || selectedTrashCommentIds.length === 0}
                    onClick={() => void restoreComments(selectedTrashCommentIds)}
                  >
                    Restore selected · {selectedTrashCommentIds.length}
                  </button>
                  <button
                    className="destructive-action"
                    type="button"
                    disabled={isBusy || selectedTrashCommentIds.length === 0}
                    onClick={(event) =>
                      void openPermanentDeletionConfirmation({
                        commentIds: selectedTrashCommentIds,
                        mode:
                          selectedTrashCommentIds.length === 1
                            ? "individual"
                            : "selected",
                        returnFocusElement: event.currentTarget
                      })
                    }
                  >
                    Delete selected forever · {selectedTrashCommentIds.length}
                  </button>
                </>
              ) : null}
              {trashedComments.length > 0 ? (
                <button
                  className="destructive-action"
                  type="button"
                  disabled={isBusy}
                  onClick={(event) =>
                    void openPermanentDeletionConfirmation({
                      commentIds: trashedComments.map((comment) => comment.id),
                      mode: "empty_trash",
                      returnFocusElement: event.currentTarget
                    })
                  }
                >
                  Empty Trash for {documentTitle}
                </button>
              ) : null}
            </div>
            {visibleTrashedComments.length === 0 ? (
              <p className="comments-empty">Trash is empty for this view.</p>
            ) : (
              <ol className="comment-trash-list">
                {visibleTrashedComments.map((comment) => {
                  const patchSummary =
                    patchGroupSummariesByCommentId[comment.id] ?? null;
                  const selected = selectedTrashKeys.has(
                    getSelectionKey(comment.id)
                  );
                  return (
                    <li key={comment.id}>
                      <article className="trashed-comment-card">
                        <label className="comment-selection-control">
                          <input
                            type="checkbox"
                            aria-label={`Select trashed comment ${comment.id}`}
                            checked={selected}
                            disabled={isBusy}
                            onChange={() =>
                              toggleSelectedTrashComment(comment.id)
                            }
                          />
                          <span>Select {comment.id}</span>
                        </label>
                        <div className="comment-card-meta">
                          <strong>{comment.id}</strong>
                          <span>Originally {comment.status}</span>
                        </div>
                        <p>{comment.comment}</p>
                        <dl className="comment-trash-metadata">
                          <div>
                            <dt>Anchor</dt>
                            <dd>
                              {anchorSummaries[comment.id]?.status ??
                                comment.anchor.kind}
                            </dd>
                          </div>
                          <div>
                            <dt>Replies</dt>
                            <dd>{comment.thread.length}</dd>
                          </div>
                          <div>
                            <dt>Patches</dt>
                            <dd>{patchSummary?.patchCount ?? 0}</dd>
                          </div>
                          <div>
                            <dt>Trashed</dt>
                            <dd>
                              {formatCommentDate(comment.trashed_at ?? "")}
                            </dd>
                          </div>
                        </dl>
                        <div className="trashed-comment-actions">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void restoreComments([comment.id])}
                          >
                            Restore
                          </button>
                          <button
                            className="destructive-action"
                            type="button"
                            disabled={isBusy}
                            onClick={(event) =>
                              void openPermanentDeletionConfirmation({
                                commentIds: [comment.id],
                                mode: "individual",
                                returnFocusElement: event.currentTarget
                              })
                            }
                          >
                            Delete forever
                          </button>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ol>
            )}
          </details>
          {trashDialog ? (
            <BulkCommentTrashDialog
              dialog={trashDialog}
              isBusy={isBusy}
              onCancel={() => {
                setTrashDialog(null);
                window.requestAnimationFrame(() =>
                  trashDialogReturnFocusRef.current?.focus()
                );
              }}
              onConfirm={() => void confirmMoveCommentsToTrash()}
              onOpenReviewBatch={onOpenReviewBatch}
            />
          ) : null}
          {permanentDeletionDialog ? (
            <CommentPermanentDeletionDialog
              dialog={permanentDeletionDialog}
              documentTitle={documentTitle}
              isBusy={isBusy}
              onCancel={() => {
                setPermanentDeletionDialog(null);
                window.requestAnimationFrame(() =>
                  permanentDeletionReturnFocusRef.current?.focus()
                );
              }}
              onChangeConfirmation={(confirmationInput) =>
                setPermanentDeletionDialog((current) =>
                  current ? { ...current, confirmationInput } : current
                )
              }
              onConfirm={() => void confirmPermanentDeletion()}
              onOpenReviewBatch={onOpenReviewBatch}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function useCompactCommentComposer(): boolean {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_COMMENT_COMPOSER_QUERY);
    const syncMatch = () => setIsCompact(mediaQuery.matches);

    syncMatch();
    mediaQuery.addEventListener("change", syncMatch);

    return () => mediaQuery.removeEventListener("change", syncMatch);
  }, []);

  return isCompact;
}

type CommentGroupProps = {
  activeCommentState: ActiveCommentState;
  anchorSummaries: Record<string, CommentAnchorSummary>;
  comments: PatchmarkComment[];
  editingCommentId: string | null;
  editComment: string;
  editingReply: { commentId: string; entryId: string } | null;
  editReplyContent: string;
  replyEditError: string;
  editType: PatchmarkCommentType;
  emptyMessage: string;
  getSelectionKey: (commentId: string) => string;
  isBusy: boolean;
  isSelectionMode: boolean;
  label: string;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onEditReply: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onReplyComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onStartReanchor: (commentId: string) => void;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetActiveCommentState: (state: ActiveCommentState) => void;
  onSetEditComment: (comment: string) => void;
  onSetEditReplyContent: (content: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
  onToggleSelection: (commentId: string) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStartEditingReply: (
    comment: PatchmarkComment,
    entry: PatchmarkCommentThreadEntry
  ) => void;
  onStartReplying: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  onStopEditingReply: () => void;
  onStopReplying: () => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
  patchGroupSummariesByCommentId: Record<string, CommentPatchGroupSummary>;
  pendingPatchCountsByCommentId: Record<string, number>;
  quiet?: boolean;
  replyingCommentId: string | null;
  replyComment: string;
  selectedCommentKeys: Set<string>;
};

type FloatingCommentListProps = Omit<
  CommentGroupProps,
  "emptyMessage" | "label" | "quiet"
> & {
  addForm: React.ReactNode;
  addPositionTop: number | null;
  commentPositions: Record<string, number>;
  compactList: boolean;
};

function FloatingCommentList({
  addForm,
  addPositionTop,
  activeCommentState,
  anchorSummaries,
  commentPositions,
  comments,
  compactList,
  editingCommentId,
  editComment,
  editingReply,
  editReplyContent,
  replyEditError,
  editType,
  getSelectionKey,
  isBusy,
  isSelectionMode,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onStartReanchor,
  onResolveComment,
  onSetActiveCommentState,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
  onToggleSelection,
  onStartEditing,
  onStartEditingReply,
  onStartReplying,
  onStopEditing,
  onStopEditingReply,
  onStopReplying,
  onUnmarkCommentForExport,
  patchGroupSummariesByCommentId,
  pendingPatchCountsByCommentId,
  replyingCommentId,
  replyComment,
  selectedCommentKeys
}: FloatingCommentListProps) {
  const floatingItemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const floatingStageRef = useRef<HTMLOListElement | null>(null);
  const layoutPassRef = useRef(0);
  const [measuredItemHeights, setMeasuredItemHeights] = useState<
    Record<string, number>
  >({});
  const [floatingStageOffsetTop, setFloatingStageOffsetTop] = useState(0);
  const positionedComments = useMemo(
    () =>
      comments
        .filter((comment) => commentPositions[comment.id] !== undefined)
        .sort((firstComment, secondComment) => {
          const firstTop = commentPositions[firstComment.id] ?? 0;
          const secondTop = commentPositions[secondComment.id] ?? 0;

          return (
            firstTop - secondTop ||
            firstComment.created_at.localeCompare(secondComment.created_at) ||
            firstComment.id.localeCompare(secondComment.id)
          );
        }),
    [commentPositions, comments]
  );
  const unpositionedComments = useMemo(
    () =>
      comments.filter(
        (comment) => commentPositions[comment.id] === undefined
      ),
    [commentPositions, comments]
  );
  const floatingLayoutItems = useMemo(
    () =>
      [
        ...(addForm && addPositionTop !== null
          ? [
              {
                createdAt: "",
                fallbackHeight: COMMENT_ADD_FORM_FALLBACK_HEIGHT,
                id: COMMENT_FLOATING_DRAFT_ID,
                kind: "draft" as const,
                preferredTop: getStageRelativePreferredTop(
                  addPositionTop,
                  floatingStageOffsetTop
                )
              }
            ]
          : []),
        ...positionedComments.map((comment) => ({
          comment,
          createdAt: comment.created_at,
          fallbackHeight: isCommentActive(activeCommentState, comment.id)
            ? COMMENT_CARD_ACTIVE_FALLBACK_HEIGHT
            : COMMENT_CARD_COMPACT_FALLBACK_HEIGHT,
          id: comment.id,
          kind: "comment" as const,
          preferredTop: getStageRelativePreferredTop(
            commentPositions[comment.id] ?? 0,
            floatingStageOffsetTop
          )
        }))
      ].sort(sortFloatingLayoutItems),
    [
      activeCommentState,
      addForm,
      addPositionTop,
      commentPositions,
      floatingStageOffsetTop,
      positionedComments
    ]
  );
  const floatingLayout = useMemo(
    () =>
      createFloatingCommentLayout(floatingLayoutItems, measuredItemHeights, {
        gap: COMMENT_CARD_GAP,
        minStageHeight: COMMENT_FLOATING_STAGE_MIN_HEIGHT
      }),
    [floatingLayoutItems, measuredItemHeights]
  );

  useLayoutEffect(() => {
    const itemIds = new Set(floatingLayoutItems.map((item) => item.id));

    for (const itemId of Object.keys(floatingItemRefs.current)) {
      if (!itemIds.has(itemId)) {
        delete floatingItemRefs.current[itemId];
      }
    }

    function measureFloatingItems() {
      const measurementStartedAt = performance.now();
      const nextMeasuredItemHeights: Record<string, number> = {};
      const nextFloatingStageOffsetTop = getFloatingStageOffsetTop(
        floatingStageRef.current
      );

      for (const itemId of itemIds) {
        const element = floatingItemRefs.current[itemId];

        if (element) {
          nextMeasuredItemHeights[itemId] = Math.ceil(
            element.getBoundingClientRect().height
          );
        }
      }

      logCommentLayoutDiagnostics({
        activeCommentState,
        floatingStageOffsetTop: nextFloatingStageOffsetTop,
        floatingItemRefs: floatingItemRefs.current,
        items: floatingLayoutItems,
        layout: floatingLayout,
        layoutPass: layoutPassRef.current + 1,
        stage: floatingStageRef.current
      });
      layoutPassRef.current += 1;

      setFloatingStageOffsetTop((currentFloatingStageOffsetTop) =>
        currentFloatingStageOffsetTop === nextFloatingStageOffsetTop
          ? currentFloatingStageOffsetTop
          : nextFloatingStageOffsetTop
      );

      setMeasuredItemHeights((currentMeasuredItemHeights) =>
        areMeasuredHeightsEqual(
          currentMeasuredItemHeights,
          nextMeasuredItemHeights
        )
          ? currentMeasuredItemHeights
          : nextMeasuredItemHeights
      );
      const operationId = getLatestDocumentSwitchPerformanceOperationId();
      recordDocumentSwitchPerformanceDuration(
        operationId,
        "comment_rail_dom_measurement",
        performance.now() - measurementStartedAt
      );
      incrementDocumentSwitchPerformanceCounter(
        operationId,
        "comment_rail_layout_pass_count"
      );
      incrementDocumentSwitchPerformanceCounter(
        operationId,
        "comment_cards_measured",
        itemIds.size
      );
    }

    measureFloatingItems();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureFloatingItems);

    if (resizeObserver) {
      for (const itemId of itemIds) {
        const element = floatingItemRefs.current[itemId];

        if (element) {
          resizeObserver.observe(element);
        }
      }
    }

    window.addEventListener("resize", measureFloatingItems);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureFloatingItems);
    };
  }, [
    addForm,
    activeCommentState,
    editComment,
    editingCommentId,
    floatingLayout,
    floatingLayoutItems,
    replyComment,
    replyingCommentId
  ]);

  if (comments.length === 0 && !addForm) {
    return (
      <p className="comments-empty">
        No comments yet. Right-click in the document to add one.
      </p>
    );
  }

  return (
    <div className="comment-floating-layout">
      {floatingLayoutItems.length > 0 ? (
        <ol
          className="comment-floating-stage"
          ref={floatingStageRef}
          style={{ minHeight: `${floatingLayout.stageHeight}px` }}
        >
          {floatingLayoutItems.map((item) => {
            const anchorRange =
              item.kind === "comment"
                ? getCommentAnchorDebugRange(item.comment)
                : null;
            const diagnostics = floatingLayout.diagnostics[item.id];
            const layoutTop =
              floatingLayout.positions[item.id] ?? item.preferredTop;

            return (
              <li
                className={`comment-floating-item ${
                  item.kind === "draft" ? "comment-floating-item-draft" : ""
                }`}
                data-comment-anchor-end={anchorRange?.end ?? undefined}
                data-comment-anchor-start={anchorRange?.start ?? undefined}
                data-comment-anchor-status={
                  item.kind === "comment"
                    ? anchorSummaries[item.comment.id]?.status
                    : undefined
                }
                data-comment-anchor-kind={
                  item.kind === "comment" ? item.comment.anchor.kind : undefined
                }
                data-comment-id={item.id}
                data-comment-layout-height={diagnostics?.height ?? undefined}
                data-comment-layout-top={layoutTop}
                data-comment-patch-impact-count={
                  item.kind === "comment"
                    ? item.comment.patch_impacts?.length ?? 0
                    : undefined
                }
                data-comment-pending-patch-count={
                  item.kind === "comment"
                    ? pendingPatchCountsByCommentId[item.comment.id] ?? 0
                    : undefined
                }
                data-comment-preferred-top={item.preferredTop}
                data-comment-status={
                  item.kind === "comment" ? item.comment.status : undefined
                }
                data-comment-thread-count={
                  item.kind === "comment" ? item.comment.thread.length : undefined
                }
                data-comment-type={
                  item.kind === "comment" ? item.comment.type : undefined
                }
                key={item.id}
                ref={(element) => {
                  floatingItemRefs.current[item.id] = element;
                }}
                style={{ top: layoutTop }}
              >
                {item.kind === "draft" ? (
                  addForm
                ) : (
                  <CommentCard
                    anchorSummaries={anchorSummaries}
                    comment={item.comment}
                    editingCommentId={editingCommentId}
                    editComment={editComment}
                    editingReply={editingReply}
                    editReplyContent={editReplyContent}
                    replyEditError={replyEditError}
                    editType={editType}
                    isSelected={selectedCommentKeys.has(
                      getSelectionKey(item.comment.id)
                    )}
                    isActive={isCommentActive(activeCommentState, item.comment.id)}
                    isBusy={isBusy}
                    isSelectionMode={isSelectionMode}
                    onDeleteComment={onDeleteComment}
                    onEditComment={onEditComment}
                    onEditReply={onEditReply}
                    onFindComment={onFindComment}
                    onMarkCommentForExport={onMarkCommentForExport}
                    onReopenComment={onReopenComment}
                    onReplyComment={onReplyComment}
                    onReviewCommentPatches={onReviewCommentPatches}
                    onStartReanchor={onStartReanchor}
                    onResolveComment={onResolveComment}
                    onActivateComment={(commentId) => {
                      onSetActiveCommentState({ kind: "comment", commentId });
                    }}
                    onClearActiveComment={() => {
                      onSetActiveCommentState({ kind: "none" });
                      restoreFocusToCollapsedCommentCard(item.comment.id);
                    }}
                    onSetEditComment={onSetEditComment}
                    onSetEditReplyContent={onSetEditReplyContent}
                    onSetEditType={onSetEditType}
                    onSetReplyComment={onSetReplyComment}
                    onToggleSelection={onToggleSelection}
                    onStartEditing={onStartEditing}
                    onStartEditingReply={onStartEditingReply}
                    onStartReplying={onStartReplying}
                    onStopEditing={onStopEditing}
                    onStopEditingReply={onStopEditingReply}
                    onStopReplying={onStopReplying}
                    onUnmarkCommentForExport={onUnmarkCommentForExport}
                    patchGroupSummary={
                      patchGroupSummariesByCommentId[item.comment.id] ?? null
                    }
                    pendingPatchCount={
                      pendingPatchCountsByCommentId[item.comment.id] ?? 0
                    }
                    quiet={item.comment.status === "resolved"}
                    replyingCommentId={replyingCommentId}
                    replyComment={replyComment}
                  />
                )}
              </li>
            );
          })}
        </ol>
      ) : null}

      {addForm && addPositionTop === null ? addForm : null}

      {unpositionedComments.length > 0 ? (
        <CommentGroup
          anchorSummaries={anchorSummaries}
          activeCommentState={activeCommentState}
          comments={sortCommentsByLastKnownAnchorPosition(unpositionedComments)}
          editingCommentId={editingCommentId}
          editComment={editComment}
          editingReply={editingReply}
          editReplyContent={editReplyContent}
          replyEditError={replyEditError}
          editType={editType}
          emptyMessage="No unpositioned comments."
          getSelectionKey={getSelectionKey}
          isBusy={isBusy}
          isSelectionMode={isSelectionMode}
          label={compactList ? "Comment threads" : "Unpositioned comments"}
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
          onEditReply={onEditReply}
          onFindComment={onFindComment}
          onMarkCommentForExport={onMarkCommentForExport}
          onReopenComment={onReopenComment}
          onReplyComment={onReplyComment}
          onReviewCommentPatches={onReviewCommentPatches}
          onStartReanchor={onStartReanchor}
          onResolveComment={onResolveComment}
          onSetActiveCommentState={onSetActiveCommentState}
          onSetEditComment={onSetEditComment}
          onSetEditReplyContent={onSetEditReplyContent}
          onSetEditType={onSetEditType}
          onSetReplyComment={onSetReplyComment}
          onToggleSelection={onToggleSelection}
          onStartEditing={onStartEditing}
          onStartEditingReply={onStartEditingReply}
          onStartReplying={onStartReplying}
          onStopEditing={onStopEditing}
          onStopEditingReply={onStopEditingReply}
          onStopReplying={onStopReplying}
          onUnmarkCommentForExport={onUnmarkCommentForExport}
          patchGroupSummariesByCommentId={patchGroupSummariesByCommentId}
          pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
          replyingCommentId={replyingCommentId}
          replyComment={replyComment}
          selectedCommentKeys={selectedCommentKeys}
        />
      ) : null}
    </div>
  );
}

function sortFloatingLayoutItems(
  firstItem: FloatingLayoutItem,
  secondItem: FloatingLayoutItem
): number {
  return (
    firstItem.preferredTop - secondItem.preferredTop ||
    firstItem.createdAt.localeCompare(secondItem.createdAt) ||
    firstItem.id.localeCompare(secondItem.id)
  );
}

function areMeasuredHeightsEqual(
  firstHeights: Record<string, number>,
  secondHeights: Record<string, number>
): boolean {
  const firstIds = Object.keys(firstHeights);
  const secondIds = Object.keys(secondHeights);

  if (firstIds.length !== secondIds.length) {
    return false;
  }

  return firstIds.every(
    (itemId) => firstHeights[itemId] === secondHeights[itemId]
  );
}

function logCommentLayoutDiagnostics({
  activeCommentState,
  floatingStageOffsetTop,
  floatingItemRefs,
  items,
  layout,
  layoutPass,
  stage
}: {
  activeCommentState: ActiveCommentState;
  floatingStageOffsetTop: number;
  floatingItemRefs: Record<string, HTMLLIElement | null>;
  items: FloatingLayoutItem[];
  layout: ReturnType<typeof createFloatingCommentLayout>;
  layoutPass: number;
  stage: HTMLOListElement | null;
}) {
  if (!isCommentLayoutDebugEnabled() || !stage) {
    return;
  }

  const stageRect = stage.getBoundingClientRect();
  const rail = stage.closest(".comments-rail");
  const activeCommentId = getActiveCommentDebugId(activeCommentState);
  const rows = items.map((item) => {
    const element = floatingItemRefs[item.id];
    const elementRect = element?.getBoundingClientRect();
    const anchorRange =
      item.kind === "comment" ? getCommentAnchorDebugRange(item.comment) : null;
    const diagnostics = layout.diagnostics[item.id];

    return {
      commentId: item.id,
      anchorStartOffset: anchorRange?.start ?? null,
      anchorEndOffset: anchorRange?.end ?? null,
      anchorElementIdentity:
        item.kind === "comment"
          ? getCommentAnchorDebugIdentity(item.comment)
          : "draft",
      anchorViewportTop: Math.round(stageRect.top + item.preferredTop),
      anchorContainerTop: Math.round(item.preferredTop),
      commentCalculatedTop: diagnostics?.calculatedTop ?? null,
      commentRenderedTop: elementRect
        ? Math.round(elementRect.top - stageRect.top)
        : null,
      commentCardHeight: elementRect ? Math.round(elementRect.height) : null,
      railScrollTop: rail?.scrollTop ?? null,
      documentScrollTop: Math.round(window.scrollY),
      activeCommentId,
      floatingStageOffsetTop,
      layoutPass
    };
  });
  const debugWindow = window as Window & {
    __patchmarkCommentLayoutDebugEvents?: Array<{
      activeCommentId: string;
      floatingStageOffsetTop: number;
      layoutPass: number;
      rows: typeof rows;
      stageHeight: number;
    }>;
  };

  debugWindow.__patchmarkCommentLayoutDebugEvents ??= [];
  debugWindow.__patchmarkCommentLayoutDebugEvents.push({
    activeCommentId,
    floatingStageOffsetTop,
    layoutPass,
    rows,
    stageHeight: layout.stageHeight
  });

  console.table(rows);
}

function getFloatingStageOffsetTop(stage: HTMLOListElement | null): number {
  if (!stage) {
    return 0;
  }

  const rail = stage.closest(".comments-rail");

  if (!rail) {
    return 0;
  }

  return Math.max(
    0,
    Math.round(stage.getBoundingClientRect().top - rail.getBoundingClientRect().top)
  );
}

function isCommentLayoutDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem(COMMENT_LAYOUT_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getActiveCommentDebugId(activeCommentState: ActiveCommentState): string {
  if (activeCommentState.kind === "comment") {
    return activeCommentState.commentId;
  }

  if (activeCommentState.kind === "anchor_group") {
    return activeCommentState.commentIds.join(",");
  }

  return "";
}

function getCommentAnchorDebugRange(
  comment: PatchmarkComment
): { end?: number; start?: number } | null {
  const { anchor } = comment;

  if (anchor.kind === "section") {
    return {
      end: anchor.section_end_offset,
      start: anchor.section_start_offset
    };
  }

  if (anchor.kind === "selected_text") {
    return {
      end:
        anchor.markdown_end_offset ??
        anchor.anchor_context?.markdown_end_offset ??
        anchor.fallback_section_end_offset,
      start:
        anchor.markdown_start_offset ??
        anchor.anchor_context?.markdown_start_offset ??
        anchor.fallback_section_start_offset
    };
  }

  return null;
}

function getCommentAnchorDebugIdentity(comment: PatchmarkComment): string {
  const { anchor } = comment;

  if (anchor.kind === "section") {
    return `section:${anchor.heading_level ?? 1}:${anchor.heading}`;
  }

  if (anchor.kind === "selected_text") {
    return `selected_text:${anchor.containing_heading ?? "document"}:${
      anchor.selected_text_hash ?? anchor.anchor_text_hash ?? ""
    }`;
  }

  return "document";
}

function CommentGroup({
  activeCommentState,
  anchorSummaries,
  comments,
  editingCommentId,
  editComment,
  editingReply,
  editReplyContent,
  replyEditError,
  editType,
  emptyMessage,
  getSelectionKey,
  isBusy,
  isSelectionMode,
  label,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onStartReanchor,
  onResolveComment,
  onSetActiveCommentState,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
  onToggleSelection,
  onStartEditing,
  onStartEditingReply,
  onStartReplying,
  onStopEditing,
  onStopEditingReply,
  onStopReplying,
  onUnmarkCommentForExport,
  patchGroupSummariesByCommentId,
  pendingPatchCountsByCommentId,
  replyingCommentId,
  replyComment,
  selectedCommentKeys,
  quiet = false
}: CommentGroupProps) {
  return (
    <div className="comment-group">
      <h3>{label}</h3>
      {comments.length === 0 ? (
        <p className="comments-empty">{emptyMessage}</p>
      ) : (
        <ol className="comment-list">
          {comments.map((comment) => {
            const anchorRange = getCommentAnchorDebugRange(comment);

            return (
              <li
                data-comment-anchor-end={anchorRange?.end ?? undefined}
                data-comment-anchor-start={anchorRange?.start ?? undefined}
                data-comment-anchor-status={
                  anchorSummaries[comment.id]?.status
                }
                data-comment-anchor-kind={comment.anchor.kind}
                data-comment-id={comment.id}
                data-comment-patch-impact-count={
                  comment.patch_impacts?.length ?? 0
                }
                data-comment-pending-patch-count={
                  pendingPatchCountsByCommentId[comment.id] ?? 0
                }
                data-comment-status={comment.status}
                data-comment-thread-count={comment.thread.length}
                data-comment-type={comment.type}
                key={comment.id}
              >
                <CommentCard
                  anchorSummaries={anchorSummaries}
                  comment={comment}
                  editingCommentId={editingCommentId}
                  editComment={editComment}
                  editingReply={editingReply}
                  editReplyContent={editReplyContent}
                  replyEditError={replyEditError}
                  editType={editType}
                  isSelected={selectedCommentKeys.has(
                    getSelectionKey(comment.id)
                  )}
                  isActive={isCommentActive(activeCommentState, comment.id)}
                  isBusy={isBusy}
                  isSelectionMode={isSelectionMode}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onEditReply={onEditReply}
                  onFindComment={onFindComment}
                  onMarkCommentForExport={onMarkCommentForExport}
                  onReopenComment={onReopenComment}
                  onReplyComment={onReplyComment}
                  onReviewCommentPatches={onReviewCommentPatches}
                  onStartReanchor={onStartReanchor}
                  onResolveComment={onResolveComment}
                  onActivateComment={(commentId) => {
                    onSetActiveCommentState({ kind: "comment", commentId });
                  }}
                  onClearActiveComment={() => {
                    onSetActiveCommentState({ kind: "none" });
                    restoreFocusToCollapsedCommentCard(comment.id);
                  }}
                  onSetEditComment={onSetEditComment}
                  onSetEditReplyContent={onSetEditReplyContent}
                  onSetEditType={onSetEditType}
                  onSetReplyComment={onSetReplyComment}
                  onToggleSelection={onToggleSelection}
                  onStartEditing={onStartEditing}
                  onStartEditingReply={onStartEditingReply}
                  onStartReplying={onStartReplying}
                  onStopEditing={onStopEditing}
                  onStopEditingReply={onStopEditingReply}
                  onStopReplying={onStopReplying}
                  onUnmarkCommentForExport={onUnmarkCommentForExport}
                  patchGroupSummary={
                    patchGroupSummariesByCommentId[comment.id] ?? null
                  }
                  pendingPatchCount={pendingPatchCountsByCommentId[comment.id] ?? 0}
                  quiet={quiet || comment.status === "resolved"}
                  replyingCommentId={replyingCommentId}
                  replyComment={replyComment}
                />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function isCommentActive(
  activeCommentState: ActiveCommentState,
  commentId: string
): boolean {
  if (activeCommentState.kind === "comment") {
    return activeCommentState.commentId === commentId;
  }

  if (activeCommentState.kind === "anchor_group") {
    return activeCommentState.commentIds.includes(commentId);
  }

  return false;
}

type CommentCardProps = {
  anchorSummaries: Record<string, CommentAnchorSummary>;
  comment: PatchmarkComment;
  editingCommentId: string | null;
  editComment: string;
  editingReply: { commentId: string; entryId: string } | null;
  editReplyContent: string;
  replyEditError: string;
  editType: PatchmarkCommentType;
  isActive: boolean;
  isBusy: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  onActivateComment: (commentId: string) => void;
  onClearActiveComment: () => void;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onEditReply: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onReplyComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onStartReanchor: (commentId: string) => void;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditReplyContent: (content: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
  onToggleSelection: (commentId: string) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStartEditingReply: (
    comment: PatchmarkComment,
    entry: PatchmarkCommentThreadEntry
  ) => void;
  onStartReplying: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  onStopEditingReply: () => void;
  onStopReplying: () => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
  patchGroupSummary: CommentPatchGroupSummary | null;
  pendingPatchCount: number;
  quiet?: boolean;
  replyingCommentId: string | null;
  replyComment: string;
};

type CompactCommentBadgesProps = {
  anchorSummary: CommentAnchorSummary;
  comment: PatchmarkComment;
  latestPatchImpact?: NonNullable<PatchmarkComment["patch_impacts"]>[number];
  patchGroupSummary: CommentPatchGroupSummary | null;
  pendingPatchCount: number;
};

function CompactCommentBadges({
  anchorSummary,
  comment,
  latestPatchImpact,
  patchGroupSummary,
  pendingPatchCount
}: CompactCommentBadgesProps) {
  const focusStateLabel = getCommentFocusStateLabel(comment);
  const displayPatchImpact = getPatchImpactForCurrentAnchorDisplay(
    {
      anchorStatus: anchorSummary.status,
      latestPatchImpact
    }
  );

  return (
    <div className="comment-compact-badges" aria-label="Comment badges">
      {comment.status === "resolved" ? (
        <span className="comment-focus-state comment-focus-state-resolved">
          Resolved
        </span>
      ) : null}
      {comment.status === "open" && focusStateLabel !== "Idle" ? (
        <span
          className={`comment-focus-state comment-focus-state-${comment.export_state.focus_state}`}
        >
          {focusStateLabel}
        </span>
      ) : null}
      {anchorSummary.status === "ambiguous" ||
      anchorSummary.status === "not_found" ? (
        <span
          className={`comment-anchor-status comment-anchor-status-${anchorSummary.status}`}
        >
          {getAnchorStatusLabel(anchorSummary.status)}
        </span>
      ) : null}
      {displayPatchImpact ? (
        <span
          className={`comment-anchor-status comment-patch-impact comment-patch-impact-${displayPatchImpact.result}`}
        >
          {getPatchImpactStatusLabel(displayPatchImpact)}
        </span>
      ) : null}
      {patchGroupSummary ? (
        <span className="comment-compact-patch-badge">
          {getCommentPatchGroupSummaryLabel(patchGroupSummary)}
          {patchGroupSummary.pending > 0
            ? ` · ${patchGroupSummary.pending} pending`
            : ""}
        </span>
      ) : pendingPatchCount > 0 ? (
        <span className="comment-compact-patch-badge">
          Pending patch{pendingPatchCount === 1 ? "" : "es"}: {pendingPatchCount}
        </span>
      ) : null}
    </div>
  );
}

function CommentCard({
  anchorSummaries,
  comment,
  editingCommentId,
  editComment,
  editingReply,
  editReplyContent,
  replyEditError,
  editType,
  isActive,
  isBusy,
  isSelected,
  isSelectionMode,
  onActivateComment,
  onClearActiveComment,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onStartReanchor,
  onResolveComment,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
  onToggleSelection,
  onStartEditing,
  onStartEditingReply,
  onStartReplying,
  onStopEditing,
  onStopEditingReply,
  onStopReplying,
  onUnmarkCommentForExport,
  patchGroupSummary,
  pendingPatchCount,
  replyingCommentId,
  replyComment,
  quiet = false
}: CommentCardProps) {
  const anchorSummary = anchorSummaries[comment.id] ?? {
    label: getCommentAnchorLabel(comment),
    status: "document" as const
  };
  const threadEntries = getVisibleCommentThreadEntries(comment.thread);
  const editableUserReply = getLatestEditableUserReply(comment);
  const isReplying = replyingCommentId === comment.id;
  const isEditing = editingCommentId === comment.id;
  const isQueuedForExport =
    comment.export_state.focus_state === "in_focus" ||
    comment.export_state.focus_state === "awaiting_reply";
  const focusStateLabel = getCommentFocusStateLabel(comment);
  const latestPatchImpact = comment.patch_impacts?.at(-1);
  const displayPatchImpact = getPatchImpactForCurrentAnchorDisplay(
    {
      anchorStatus: anchorSummary.status,
      latestPatchImpact
    }
  );
  const isCompact =
    isSelectionMode || (!isActive && !isEditing && !isReplying);
  const collapsedTarget = getCollapsedCommentTarget({
    comment,
    fallbackLabel: anchorSummary.label,
    locationLabel: anchorSummary.locationLabel
  });

  return (
    <article
      id={`patchmark-comment-card-${comment.id}`}
      aria-label={`${isActive ? "Active comment" : "Comment"} ${comment.id}${
        isSelectionMode ? (isSelected ? ", selected" : ", not selected") : ""
      }`}
      aria-current={isActive ? "true" : undefined}
      className={`comment-card ${quiet ? "comment-card-quiet" : ""} ${
        isCompact ? "comment-card-compact" : "comment-card-active"
      }`}
      data-active={isActive ? "true" : undefined}
      tabIndex={isCompact ? 0 : -1}
      onClick={(event) => {
        if (isSelectionMode && !isInteractiveCommentTarget(event.target)) {
          onToggleSelection(comment.id);
          return;
        }
        if (isCompact && !isInteractiveCommentTarget(event.target)) {
          onActivateComment(comment.id);
        }
      }}
      onKeyDown={(event) => {
        if (!isCompact || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }

        event.preventDefault();
        if (isSelectionMode) {
          onToggleSelection(comment.id);
        } else {
          onActivateComment(comment.id);
        }
      }}
    >
      {isSelectionMode ? (
        <label className="comment-selection-control">
          <input
            type="checkbox"
            aria-label={`Select comment ${comment.id} for Trash`}
            checked={isSelected}
            disabled={isBusy}
            onChange={() => onToggleSelection(comment.id)}
          />
          <span>Select {comment.id}</span>
        </label>
      ) : null}
      {isCompact ? (
        <>
          <div className="comment-compact-heading">
            <p className="comment-collapsed-preview">
              {truncateText(comment.comment, 110)}
            </p>
            <span>
              {threadEntries.length > 0
                ? `${threadEntries.length} repl${
                    threadEntries.length === 1 ? "y" : "ies"
                  }`
                : "No replies"}
            </span>
          </div>
          <span
            className="comment-compact-context"
            title={collapsedTarget.title}
          >
            {comment.type.replaceAll("_", " ")} · {comment.status}
            {collapsedTarget.secondary ? ` · ${collapsedTarget.secondary}` : ""}
          </span>
          <CompactCommentBadges
            anchorSummary={anchorSummary}
            comment={comment}
            latestPatchImpact={displayPatchImpact}
            patchGroupSummary={patchGroupSummary}
            pendingPatchCount={pendingPatchCount}
          />
        </>
      ) : isEditing ? (
        <form className="comment-form" onSubmit={onEditComment}>
          <CommentAnchorPreview
            anchorContextKind={
              comment.anchor.kind === "selected_text"
                ? comment.anchor.anchor_context?.kind ?? null
                : null
            }
            scope={comment.anchor.kind}
            selectedTextPreview={
              comment.anchor.kind === "selected_text"
                ? comment.anchor.selected_text
                : null
            }
            staticLabel={anchorSummary.label}
          />
          <CommentTypeSelect value={editType} onChange={onSetEditType} />
          <label>
            <span>Comment text</span>
            <textarea
              required
              value={editComment}
              onChange={(event) => onSetEditComment(event.target.value)}
            />
          </label>
          <div className="comment-form-actions">
            <button type="submit" disabled={isBusy}>
              Save Edit
            </button>
            <button type="button" disabled={isBusy} onClick={onStopEditing}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="comment-card-heading">
            <div className="comment-card-meta">
              <span className="comment-type">[{comment.type}]</span>
              <span>{comment.status}</span>
            </div>
            <button
              type="button"
              className="comment-card-close"
              disabled={isBusy}
              onClick={onClearActiveComment}
            >
              Close details
            </button>
          </div>
          <strong className="comment-target">{anchorSummary.label}</strong>
          {focusStateLabel !== "Idle" ? (
            <span
              className={`comment-focus-state comment-focus-state-${
                comment.status === "resolved"
                  ? "resolved"
                  : comment.export_state.focus_state
              }`}
            >
              {focusStateLabel}
            </span>
          ) : null}
          {shouldShowAnchorStatusBadge(anchorSummary.status) ? (
            <span
              className={`comment-anchor-status comment-anchor-status-${anchorSummary.status}`}
            >
              {getAnchorStatusLabel(anchorSummary.status)}
            </span>
          ) : null}
          {shouldShowAnchorStatusBadge(anchorSummary.status) &&
          anchorSummary.detail ? (
            <span className="comment-anchor-detail">{anchorSummary.detail}</span>
          ) : null}
          {displayPatchImpact ? (
            <>
              <span
                className={`comment-anchor-status comment-patch-impact comment-patch-impact-${displayPatchImpact.result}`}
              >
                {getPatchImpactStatusLabel(displayPatchImpact)}
              </span>
              {displayPatchImpact.note ? (
                <span className="comment-anchor-detail">
                  {displayPatchImpact.note}
                </span>
              ) : null}
            </>
          ) : null}
          {comment.anchor.kind === "selected_text" ? (
            <>
              <blockquote className="comment-selected-text">
                Selected: “{truncateText(comment.anchor.selected_text, 140)}”
              </blockquote>
              {comment.anchor.anchor_text &&
              comment.anchor.anchor_text !== comment.anchor.selected_text ? (
                <blockquote className="comment-selected-text">
                  Context: {getAnchorContextKindLabel(
                    comment.anchor.anchor_context?.kind ??
                      getLegacyAnchorTextSourceContextKind(
                        comment.anchor.anchor_text_source
                      )
                  )}
                </blockquote>
              ) : comment.anchor.anchor_context ? (
                <blockquote className="comment-selected-text">
                  Context: {getAnchorContextKindLabel(
                    comment.anchor.anchor_context.kind
                  )}
                </blockquote>
              ) : null}
              {comment.anchor.action_context ? (
                <blockquote className="comment-selected-text">
                  Action context:{" "}
                  {getActionScopeLabel(comment.anchor.action_context.default_scope)}
                </blockquote>
              ) : null}
            </>
          ) : null}
          <p>{comment.comment}</p>
          {patchGroupSummary ? (
            <div className="comment-pending-patches">
              <strong>{getCommentPatchGroupSummaryLabel(patchGroupSummary)}</strong>
              <span>{formatCommentPatchGroupStatusSummary(patchGroupSummary)}</span>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onReviewCommentPatches(comment.id)}
              >
                {getCommentPatchGroupReviewLabel(patchGroupSummary)}
              </button>
            </div>
          ) : pendingPatchCount > 0 ? (
            <div className="comment-pending-patches">
              <span>
                Pending patch proposal{pendingPatchCount === 1 ? "" : "s"}:{" "}
                {pendingPatchCount}
              </span>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onReviewCommentPatches(comment.id)}
              >
                Review patch{pendingPatchCount === 1 ? "" : "es"}
              </button>
            </div>
          ) : null}
          {threadEntries.length > 0 ? (
            <div className="comment-thread-preview">
              <span>
                Thread · {threadEntries.length} entr
                {threadEntries.length === 1 ? "y" : "ies"}
              </span>
              {threadEntries.map((entry) => {
                const isEditingThisReply =
                  editingReply?.commentId === comment.id &&
                  editingReply.entryId === entry.id;
                const canEditReply = editableUserReply?.entry.id === entry.id;

                return (
                  <div className="comment-thread-entry" key={entry.id}>
                    <div className="comment-thread-entry-header">
                      <strong>{getThreadRoleLabel(entry.role)}:</strong>
                      {entry.updated_at ? (
                        <span>Edited {formatCommentDate(entry.updated_at)}</span>
                      ) : null}
                    </div>
                    {isEditingThisReply ? (
                      <form
                        className="comment-form comment-reply-edit-form"
                        onSubmit={onEditReply}
                      >
                        <label>
                          <span>Edit reply</span>
                          <textarea
                            required
                            value={editReplyContent}
                            onChange={(event) =>
                              onSetEditReplyContent(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                onStopEditingReply();
                              }
                            }}
                          />
                        </label>
                        {replyEditError ? (
                          <p className="comment-form-error">{replyEditError}</p>
                        ) : null}
                        <div className="comment-form-actions">
                          <button type="submit" disabled={isBusy}>
                            Save
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={onStopEditingReply}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <p>{entry.content}</p>
                        {canEditReply ? (
                          <button
                            className="comment-thread-entry-action"
                            type="button"
                            disabled={isBusy}
                            onClick={() => onStartEditingReply(comment, entry)}
                          >
                            Edit reply
                          </button>
                        ) : null}
                      </>
                    )}
                    {entry.suggested_user_action ? (
                      <span>
                        Suggested action: {entry.suggested_user_action}
                      </span>
                    ) : null}
                    {entry.source_chat_url ? (
                      <a
                        href={entry.source_chat_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open ChatGPT chat
                      </a>
                    ) : null}
                    {entry.sources?.length ? (
                      <div className="comment-thread-sources">
                        <span>Sources</span>
                        <ul>
                          {entry.sources.map((source, index) => (
                            <li key={`${source.url}-${index}`}>
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {source.title || source.url}
                              </a>
                              {source.supports ? (
                                <small>{source.supports}</small>
                              ) : null}
                              {source.note ? <small>{source.note}</small> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {isReplying ? (
            <form className="comment-form comment-reply-form" onSubmit={onReplyComment}>
              <label>
                <span>User reply</span>
                <textarea
                  data-comment-reply-input
                  required
                  value={replyComment}
                  onChange={(event) => onSetReplyComment(event.target.value)}
                />
              </label>
              <div className="comment-form-actions">
                <button type="submit" disabled={isBusy}>
                  Save Reply
                </button>
                <button type="button" disabled={isBusy} onClick={onStopReplying}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          <span className="comment-timestamp">
            Updated {formatCommentDate(comment.updated_at)}
          </span>
          <div className="comment-card-actions">
            {comment.status === "open" &&
            comment.anchor.kind === "selected_text" &&
            (anchorSummary.status === "ambiguous" ||
              anchorSummary.status === "not_found") ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onStartReanchor(comment.id)}
              >
                Re-anchor
              </button>
            ) : null}
            {comment.status === "open" ? (
              <button
                className="comment-action-primary"
                type="button"
                disabled={isBusy}
                onClick={() => onStartReplying(comment)}
              >
                Reply
              </button>
            ) : null}
            {comment.status === "open" && onResolveComment ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onResolveComment(comment.id).catch(() => undefined);
                }}
              >
                Resolve
              </button>
            ) : null}
            {comment.status === "resolved" && onReopenComment ? (
              <button
                className="comment-action-primary"
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onReopenComment(comment.id).catch(() => undefined);
                }}
              >
                Reopen
              </button>
            ) : null}
            <ActionMenu
              label={`More actions for comment ${comment.id}`}
              rootClassName="comment-action-menu"
              triggerClassName="comment-action-menu-trigger"
              triggerChildren={<span aria-hidden="true">•••</span>}
              panelClassName="comment-action-menu-panel"
            >
              {(closeMenu) => (
                <>
                  <ActionMenuGroup
                    className="comment-action-menu-group"
                    label="Comment"
                    labelClassName="comment-action-menu-label"
                  >
                    <ActionMenuItem
                      className="comment-action-menu-item"
                      closeMenu={closeMenu}
                      disabled={isBusy}
                      onSelect={() => onFindComment(comment)}
                    >
                      Find in document
                    </ActionMenuItem>
                    {comment.status === "open" && isQueuedForExport ? (
                      <ActionMenuItem
                        className="comment-action-menu-item"
                        closeMenu={closeMenu}
                        disabled={isBusy}
                        onSelect={() => onUnmarkCommentForExport(comment.id)}
                      >
                        Unmark for ChatGPT
                      </ActionMenuItem>
                    ) : comment.status === "open" ? (
                      <ActionMenuItem
                        className="comment-action-menu-item"
                        closeMenu={closeMenu}
                        disabled={isBusy}
                        onSelect={() => onMarkCommentForExport(comment.id)}
                      >
                        Mark for ChatGPT
                      </ActionMenuItem>
                    ) : null}
                    {comment.status === "open" &&
                    comment.anchor.kind === "selected_text" &&
                    anchorSummary.status === "active" ? (
                      <ActionMenuItem
                        className="comment-action-menu-item"
                        closeMenu={closeMenu}
                        disabled={isBusy}
                        onSelect={() => onStartReanchor(comment.id)}
                      >
                        Change anchor
                      </ActionMenuItem>
                    ) : null}
                    <ActionMenuItem
                      className="comment-action-menu-item"
                      closeMenu={closeMenu}
                      disabled={isBusy}
                      onSelect={() => onStartEditing(comment)}
                    >
                      Edit comment
                    </ActionMenuItem>
                  </ActionMenuGroup>
                  <ActionMenuGroup
                    className="comment-action-menu-group"
                    label="Remove"
                    labelClassName="comment-action-menu-label"
                  >
                    <ActionMenuItem
                      className="comment-action-menu-item comment-action-menu-item-destructive"
                      closeMenu={closeMenu}
                      disabled={isBusy}
                      onSelect={() => onDeleteComment(comment.id)}
                    >
                      Move to Trash
                    </ActionMenuItem>
                  </ActionMenuGroup>
                </>
              )}
            </ActionMenu>
          </div>
        </>
      )}
    </article>
  );
}

function BulkCommentTrashDialog({
  dialog,
  isBusy,
  onCancel,
  onConfirm,
  onOpenReviewBatch
}: {
  dialog: CommentTrashDialogState;
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenReviewBatch: (batchId: string) => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const { summary } = dialog;
  const activeBatchBlockers = summary.blockers.filter(
    (blocker) => blocker.kind === "active_review_batch"
  );
  const reanchorBlockers = summary.blockers.filter(
    (blocker) => blocker.kind === "active_reanchor"
  );
  const draftBlockers = summary.blockers.filter(
    (blocker) => blocker.kind === "unsaved_draft"
  );
  const isBlocked = summary.blockers.length > 0;

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        aria-describedby="comment-trash-dialog-description"
        aria-labelledby="comment-trash-dialog-title"
        aria-modal="true"
        className="dialog-card comment-trash-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Tab" || !dialogRef.current) {
            return;
          }
          const focusable = Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              "button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]"
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
        }}
      >
        <h2 id="comment-trash-dialog-title">
          {isBlocked
            ? "Cannot move these comments to Trash"
            : `Move ${summary.selectedComments} comment${
                summary.selectedComments === 1 ? "" : "s"
              } to Trash?`}
        </h2>
        <p id="comment-trash-dialog-description">
          This preserves comment threads, anchors, patch history, imports, and
          Review Batch provenance for later restoration.
        </p>
        <dl className="comment-trash-summary">
          <div>
            <dt>Selected comments</dt>
            <dd>{summary.selectedComments}</dd>
          </div>
          <div>
            <dt>Replies</dt>
            <dd>{summary.replies}</dd>
          </div>
          <div>
            <dt>Pending patches</dt>
            <dd>{summary.pendingPatches}</dd>
          </div>
          <div>
            <dt>Accepted patches</dt>
            <dd>{summary.acceptedPatches}</dd>
          </div>
          <div>
            <dt>Rejected patches</dt>
            <dd>{summary.rejectedPatches}</dd>
          </div>
          <div>
            <dt>Unresolved anchors</dt>
            <dd>{summary.unresolvedAnchors}</dd>
          </div>
          <div>
            <dt>Linked to Review Batches</dt>
            <dd>{summary.linkedReviewBatchComments}</dd>
          </div>
          <div>
            <dt>Blocked comments</dt>
            <dd>{summary.blockedComments}</dd>
          </div>
        </dl>
        {summary.acceptedPatches > 0 ? (
          <p className="comment-trash-warning">
            Changes already applied to the Markdown will remain.
          </p>
        ) : null}
        {activeBatchBlockers.map((blocker) =>
          blocker.kind === "active_review_batch" ? (
            <div className="comment-trash-blocker" role="alert" key={blocker.batchId}>
              <p>
                {blocker.commentIds.length} selected comment
                {blocker.commentIds.length === 1 ? "" : "s"} belong
                {blocker.commentIds.length === 1 ? "s" : ""} to an exported batch
                awaiting ChatGPT. Import the response or cancel that batch first.
              </p>
              <button
                type="button"
                onClick={() => {
                  onCancel();
                  onOpenReviewBatch(blocker.batchId);
                }}
              >
                Open active Review Batch
              </button>
            </div>
          ) : null
        )}
        {reanchorBlockers.length > 0 ? (
          <p className="comment-trash-blocker" role="alert">
            Finish or cancel the active re-anchor session before moving its
            comment to Trash.
          </p>
        ) : null}
        {draftBlockers.length > 0 ? (
          <p className="comment-trash-blocker" role="alert">
            Save, cancel, or explicitly discard the selected comment or reply
            draft first. No draft was discarded.
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={isBusy}
            onClick={onCancel}
          >
            Cancel
          </button>
          {!isBlocked ? (
            <button type="button" disabled={isBusy} onClick={onConfirm}>
              Move {summary.selectedComments} comment
              {summary.selectedComments === 1 ? "" : "s"} to Trash
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CommentPermanentDeletionDialog({
  dialog,
  documentTitle,
  isBusy,
  onCancel,
  onChangeConfirmation,
  onConfirm,
  onOpenReviewBatch
}: {
  dialog: CommentPermanentDeletionDialogState;
  documentTitle: string;
  isBusy: boolean;
  onCancel: () => void;
  onChangeConfirmation: (value: string) => void;
  onConfirm: () => void;
  onOpenReviewBatch: (batchId: string) => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const { summary } = dialog;
  const isBlocked = summary.blockers.length > 0;
  const phraseMatches =
    dialog.confirmationInput.trim() === summary.confirmationPhrase;
  const title =
    dialog.mode === "empty_trash"
      ? `Permanently delete ${summary.selectedComments} comment${
          summary.selectedComments === 1 ? "" : "s"
        } from ${documentTitle}?`
      : summary.selectedComments === 1
        ? "Delete this comment forever?"
        : `Permanently delete ${summary.selectedComments} comments?`;

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        aria-describedby="comment-permanent-deletion-description"
        aria-labelledby="comment-permanent-deletion-title"
        aria-modal="true"
        className="dialog-card comment-permanent-deletion-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Tab" || !dialogRef.current) {
            return;
          }
          const focusable = Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              "button:not([disabled]), input:not([disabled]), [href]"
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
        }}
      >
        <h2 id="comment-permanent-deletion-title">
          {isBlocked ? "Cannot permanently delete these comments" : title}
        </h2>
        <div id="comment-permanent-deletion-description">
          <p>
            This permanently removes comment threads, anchors, and review
            proposal content from the active Patchmark document store.
          </p>
          <p>Accepted Markdown changes will remain.</p>
          <p>
            Previously exported prompts, imported-response archives, downloaded
            files, and external backups may still contain copies.
          </p>
          <p>This cannot be undone inside Patchmark.</p>
        </div>
        <dl className="comment-trash-summary">
          <div>
            <dt>Comments</dt>
            <dd>{summary.selectedComments}</dd>
          </div>
          <div>
            <dt>Replies</dt>
            <dd>{summary.replies}</dd>
          </div>
          <div>
            <dt>Pending patches</dt>
            <dd>{summary.pendingPatches}</dd>
          </div>
          <div>
            <dt>Accepted patches</dt>
            <dd>{summary.acceptedPatches}</dd>
          </div>
          <div>
            <dt>Rejected patches</dt>
            <dd>{summary.rejectedPatches}</dd>
          </div>
          <div>
            <dt>Review Batch references</dt>
            <dd>{summary.reviewBatchReferences}</dd>
          </div>
          <div>
            <dt>Imports</dt>
            <dd>{summary.imports}</dd>
          </div>
          <div>
            <dt>Minimal tombstones</dt>
            <dd>{summary.tombstones}</dd>
          </div>
        </dl>
        {summary.blockers.map((blocker, index) => {
          if (blocker.kind === "active_review_batch") {
            return (
              <div
                className="comment-trash-blocker"
                key={`${blocker.kind}:${blocker.batchId}`}
                role="alert"
              >
                <p>
                  {blocker.commentIds.length} comment
                  {blocker.commentIds.length === 1 ? "" : "s"} belong to an
                  exported Review Batch awaiting ChatGPT.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onCancel();
                    onOpenReviewBatch(blocker.batchId);
                  }}
                >
                  Open active Review Batch
                </button>
              </div>
            );
          }
          const messages = {
            corrupt_historical_reference: `Historical reference ${
              blocker.kind === "corrupt_historical_reference"
                ? blocker.reference
                : ""
            } cannot be preserved safely.`,
            in_flight_import:
              "Wait for the response import to finish before deleting.",
            in_flight_mutation:
              "Wait for the Trash, Restore, or re-anchor operation to finish.",
            unsaved_draft:
              "Save, cancel, or explicitly discard the associated local draft first."
          };
          return (
            <p
              className="comment-trash-blocker"
              key={`${blocker.kind}:${index}`}
              role="alert"
            >
              {messages[blocker.kind]}
            </p>
          );
        })}
        {!isBlocked ? (
          <label className="permanent-deletion-confirmation">
            <span>
              Type <strong>{summary.confirmationPhrase}</strong> to confirm
              (case-sensitive)
            </span>
            <input
              aria-describedby="permanent-deletion-confirmation-status"
              aria-label="Permanent deletion confirmation phrase"
              autoComplete="off"
              value={dialog.confirmationInput}
              onChange={(event) => onChangeConfirmation(event.target.value)}
            />
          </label>
        ) : null}
        <p
          id="permanent-deletion-confirmation-status"
          aria-live="polite"
          className="permanent-deletion-confirmation-status"
        >
          {!isBlocked && dialog.confirmationInput && !phraseMatches
            ? "Confirmation phrase does not match."
            : ""}
        </p>
        <div className="dialog-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={isBusy}
            onClick={onCancel}
          >
            Cancel
          </button>
          {!isBlocked ? (
            <button
              className="destructive-action"
              type="button"
              disabled={isBusy || !phraseMatches}
              onClick={onConfirm}
            >
              {dialog.mode === "empty_trash"
                ? `Empty Trash for ${documentTitle}`
                : summary.selectedComments === 1
                  ? "Delete forever"
                  : "Delete selected forever"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function isInteractiveCommentTarget(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, textarea, select, label, summary, [role='button']"
      )
    )
  );
}

function restoreFocusToCollapsedCommentCard(commentId: string) {
  window.requestAnimationFrame(() => {
    const card = document.getElementById(`patchmark-comment-card-${commentId}`);

    if (card?.classList.contains("comment-card-compact")) {
      card.focus({ preventScroll: true });
    }
  });
}

type CommentAnchorPreviewProps = {
  anchorContextKind?: PatchmarkSelectedTextAnchorContextKind | null;
  headings?: MarkdownHeading[];
  scope: CommentAnchorScope;
  selectedTextPreview?: string | null;
  staticLabel?: string;
  targetHeadingLine?: number | null;
};

function CommentAnchorPreview({
  anchorContextKind,
  headings = [],
  scope,
  selectedTextPreview,
  staticLabel,
  targetHeadingLine
}: CommentAnchorPreviewProps) {
  const targetHeading = targetHeadingLine
    ? headings.find((heading) => heading.line === targetHeadingLine)
    : undefined;
  const label = staticLabel ?? getAddAnchorPreviewLabel(scope, targetHeading);

  return (
    <div className="comment-anchor-preview">
      <span>Anchor preview</span>
      <strong>{label}</strong>
      {scope === "selected_text" ? (
        <>
          <p>
            Commenting on selected text: “
            {truncateText(selectedTextPreview ?? "", 220)}”
          </p>
          {anchorContextKind ? (
            <p>
              Anchored using {getAnchorContextKindLabel(anchorContextKind)}.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type CommentTypeSelectProps = {
  onChange: (type: PatchmarkCommentType) => void;
  value: PatchmarkCommentType;
};

function CommentTypeSelect({ onChange, value }: CommentTypeSelectProps) {
  return (
    <label>
      <span>Comment type</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as PatchmarkCommentType)}
      >
        {commentTypeOptions.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
    </label>
  );
}

function getCommentAnchorLabel(comment: PatchmarkComment): string {
  return getCleanCommentAnchorLabel(comment);
}

function getAnchorStatusLabel(status: CommentAnchorStatus): string {
  if (status === "document") {
    return "Whole document";
  }

  if (status === "active") {
    return "Anchor active";
  }

  if (status === "ambiguous") {
    return "Anchor needs review";
  }

  return "Anchor not found";
}

function shouldShowAnchorStatusBadge(status: CommentAnchorStatus): boolean {
  return getVisibleAnchorStatus(status) !== undefined;
}

function getPatchImpactStatusLabel({
  patch_id: patchId,
  result
}: NonNullable<PatchmarkComment["patch_impacts"]>[number]): string {
  if (result === "needs_review") {
    return `Needs review after ${patchId}`;
  }

  if (result === "reanchored") {
    return `Anchor recovered after ${patchId}`;
  }

  if (result === "offset_shifted") {
    return `Offset shifted after ${patchId}`;
  }

  return `Patch checked: ${patchId}`;
}

function getAddAnchorPreviewLabel(
  scope: CommentAnchorScope,
  targetHeading?: MarkdownHeading
): string {
  if (scope === "selected_text") {
    return "Commenting on selected text";
  }

  if (scope === "section") {
    return targetHeading
      ? `Commenting on whole section: ${"#".repeat(targetHeading.level)} ${
          targetHeading.text
        }`
      : "Commenting on whole section";
  }

  return "Commenting on whole document";
}

function getAnchorContextKindLabel(
  kind?: PatchmarkSelectedTextAnchorContextKind | null
): string {
  if (kind === "heading") {
    return "surrounding heading";
  }

  if (kind === "list_item") {
    return "surrounding list item";
  }

  if (kind === "table_cell") {
    return "surrounding table cell";
  }

  if (kind === "blockquote") {
    return "surrounding blockquote";
  }

  if (kind === "sentence") {
    return "surrounding sentence";
  }

  if (kind === "paragraph") {
    return "surrounding paragraph";
  }

  if (kind === "section") {
    return "containing section";
  }

  return "surrounding block";
}

function getLegacyAnchorTextSourceContextKind(
  source?: "selected" | "expanded_sentence" | "expanded_block" | null
): PatchmarkSelectedTextAnchorContextKind | null {
  if (source === "expanded_sentence") {
    return "sentence";
  }

  if (source === "expanded_block") {
    return "block";
  }

  return null;
}

function getActionScopeLabel(scope: string): string {
  if (scope === "full_document") {
    return "full document";
  }

  if (scope === "display_target") {
    return "selected text";
  }

  if (scope === "anchor_context") {
    return "anchor context";
  }

  return "containing section";
}

function getCommentFocusStateLabel(comment: PatchmarkComment): string {
  if (comment.status === "resolved") {
    return "Resolved";
  }

  if (
    comment.export_state.focus_state === "in_focus" &&
    comment.export_state.last_exported_at &&
    Date.parse(comment.updated_at) > Date.parse(comment.export_state.last_exported_at)
  ) {
    return "Changed since export";
  }

  if (comment.export_state.focus_state === "in_focus") {
    return "Marked for ChatGPT";
  }

  if (comment.export_state.focus_state === "exported") {
    return "Exported";
  }

  if (comment.export_state.focus_state === "awaiting_reply") {
    return "Awaiting reply";
  }

  if (comment.export_state.focus_state === "reply_received") {
    return "Reply received";
  }

  return "Idle";
}

function getThreadRoleLabel(role: PatchmarkComment["thread"][number]["role"]): string {
  if (role === "chatgpt") {
    return "ChatGPT reply";
  }

  if (role === "system") {
    return "System";
  }

  return "User reply";
}

function getCommentPatchGroupSummaryLabel(
  summary: CommentPatchGroupSummary
): string {
  if (summary.latestAcceptedTitle) {
    return `Latest change applied: ${summary.latestAcceptedTitle}`;
  }

  if (summary.patchCount === 1) {
    return `Patch proposal: ${getSinglePatchStatusLabel(summary)}`;
  }

  if (summary.pending === 0) {
    if (summary.accepted > 0 && summary.rejected === 0 && summary.stale === 0) {
      return summary.groupCount > 1 ? "Patch groups applied" : "Patch group applied";
    }

    if (summary.rejected > 0 && summary.accepted === 0 && summary.stale === 0) {
      return summary.groupCount > 1
        ? "Patch groups rejected"
        : "Patch group rejected";
    }

    return summary.groupCount > 1
      ? "Patch groups reviewed"
      : "Patch group reviewed";
  }

  if (summary.groupCount > 1) {
    return `Patch groups: ${summary.groupCount}`;
  }

  return `Patch group: ${summary.patchCount} proposals`;
}

function getCommentPatchGroupReviewLabel(
  summary: CommentPatchGroupSummary
): string {
  return summary.pending > 0
    ? "Review related patches"
    : "View related patches";
}

function formatCommentPatchGroupStatusSummary(
  summary: CommentPatchGroupSummary
): string {
  const parts = [
    summary.accepted > 0 ? `${summary.accepted} applied` : null,
    summary.pending > 0 ? `${summary.pending} pending` : null,
    summary.rejected > 0 ? `${summary.rejected} rejected` : null,
    summary.stale > 0 ? `${summary.stale} stale` : null
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "No patch proposals";
}

function getSinglePatchStatusLabel(summary: CommentPatchGroupSummary): string {
  if (summary.pending > 0) {
    return "pending";
  }

  if (summary.accepted > 0) {
    return "applied";
  }

  if (summary.rejected > 0) {
    return "rejected";
  }

  if (summary.stale > 0) {
    return "stale";
  }

  return "unknown";
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatCommentDate(updatedAt: string): string {
  const date = new Date(updatedAt);

  if (Number.isNaN(date.getTime())) {
    return updatedAt;
  }

  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

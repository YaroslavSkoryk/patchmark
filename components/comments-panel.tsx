"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { type MarkdownHeading } from "@/lib/markdown/parse-headings";
import {
  createFloatingCommentLayout,
  getStageRelativePreferredTop
} from "@/lib/comments/floating-comment-layout";
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
  defaultSectionLine: number | null;
  error: string | null;
  headings: MarkdownHeading[];
  isBusy: boolean;
  isProjectMode: boolean;
  onAddComment: (values: CommentFormValues) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
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
  onReopenComment: (commentId: string) => Promise<void>;
  onReplyComment: (commentId: string, content: string) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onReviewFirstPendingPatch: () => void;
  onResolveComment: (commentId: string) => Promise<void>;
  onSetActiveCommentState: (state: ActiveCommentState) => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
  patchGroupSummariesByCommentId: Record<string, CommentPatchGroupSummary>;
  pendingPatchGroupTotal: number;
  pendingPatchCountsByCommentId: Record<string, number>;
  pendingPatchTotal: number;
  selectedAnchorContextKind: PatchmarkSelectedTextAnchorContextKind | null;
  selectedTextPreview: string | null;
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
  defaultSectionLine,
  error,
  headings,
  isBusy,
  isProjectMode,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onReviewFirstPendingPatch,
  onResolveComment,
  onSetActiveCommentState,
  onUnmarkCommentForExport,
  patchGroupSummariesByCommentId,
  pendingPatchGroupTotal,
  pendingPatchCountsByCommentId,
  pendingPatchTotal,
  selectedAnchorContextKind,
  selectedTextPreview
}: CommentsPanelProps) {
  const handledAddRequestNonceRef = useRef<number | null>(null);
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
  const canUseSelectedText = Boolean(selectedTextPreview);
  const canUseSection = headings.length > 0;

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
      setAddComment("");
      setAddTargetLine("");
      setAddPositionTop(null);
      setAddType("note");
      setAddScope("document");
      setIsAdding(false);
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

  async function handleDeleteComment(commentId: string) {
    if (!window.confirm("Delete this comment?")) {
      return;
    }

    try {
      await onDeleteComment(commentId);
    } catch {
      setFormError("Could not delete comment.");
    }
  }

  const addForm = isAdding ? (
    <form className="comment-form comment-form-popover" onSubmit={handleAddComment}>
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
          onClick={() => {
            setIsAdding(false);
            setAddPositionTop(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  ) : null;

  return (
    <section className="comments-panel" aria-label="Comments">
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
            addForm={addForm}
            addPositionTop={addPositionTop}
            activeCommentState={activeCommentState}
            anchorSummaries={anchorSummaries}
            commentPositions={commentPositions}
            comments={comments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            isBusy={isBusy}
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onEditReply={handleEditReply}
            onFindComment={onFindComment}
            onMarkCommentForExport={onMarkCommentForExport}
            onReopenComment={onReopenComment}
            onReplyComment={handleReplyComment}
            onReviewCommentPatches={onReviewCommentPatches}
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
          />
        </>
      )}
    </section>
  );
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
  isBusy: boolean;
  label: string;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onEditReply: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onReplyComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetActiveCommentState: (state: ActiveCommentState) => void;
  onSetEditComment: (comment: string) => void;
  onSetEditReplyContent: (content: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
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
};

type FloatingCommentListProps = Omit<
  CommentGroupProps,
  "emptyMessage" | "label" | "quiet"
> & {
  addForm: React.ReactNode;
  addPositionTop: number | null;
  commentPositions: Record<string, number>;
};

function FloatingCommentList({
  addForm,
  addPositionTop,
  activeCommentState,
  anchorSummaries,
  commentPositions,
  comments,
  editingCommentId,
  editComment,
  editingReply,
  editReplyContent,
  replyEditError,
  editType,
  isBusy,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onResolveComment,
  onSetActiveCommentState,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
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
  replyComment
}: FloatingCommentListProps) {
  const floatingItemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const floatingStageRef = useRef<HTMLOListElement | null>(null);
  const layoutPassRef = useRef(0);
  const [measuredItemHeights, setMeasuredItemHeights] = useState<
    Record<string, number>
  >({});
  const [floatingStageOffsetTop, setFloatingStageOffsetTop] = useState(0);
  const positionedComments = comments
    .filter((comment) => commentPositions[comment.id] !== undefined)
    .sort((firstComment, secondComment) => {
      const firstTop = commentPositions[firstComment.id] ?? 0;
      const secondTop = commentPositions[secondComment.id] ?? 0;

      return (
        firstTop - secondTop ||
        firstComment.created_at.localeCompare(secondComment.created_at) ||
        firstComment.id.localeCompare(secondComment.id)
      );
    });
  const unpositionedComments = comments.filter(
    (comment) => commentPositions[comment.id] === undefined
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
                    isActive={isCommentActive(activeCommentState, item.comment.id)}
                    isBusy={isBusy}
                    onDeleteComment={onDeleteComment}
                    onEditComment={onEditComment}
                    onEditReply={onEditReply}
                    onFindComment={onFindComment}
                    onMarkCommentForExport={onMarkCommentForExport}
                    onReopenComment={onReopenComment}
                    onReplyComment={onReplyComment}
                    onReviewCommentPatches={onReviewCommentPatches}
                    onResolveComment={onResolveComment}
                    onActivateComment={(commentId) =>
                      onSetActiveCommentState({ kind: "comment", commentId })
                    }
                    onClearActiveComment={() =>
                      onSetActiveCommentState({ kind: "none" })
                    }
                    onSetEditComment={onSetEditComment}
                    onSetEditReplyContent={onSetEditReplyContent}
                    onSetEditType={onSetEditType}
                    onSetReplyComment={onSetReplyComment}
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
          isBusy={isBusy}
          label="Unpositioned comments"
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
          onEditReply={onEditReply}
          onFindComment={onFindComment}
          onMarkCommentForExport={onMarkCommentForExport}
          onReopenComment={onReopenComment}
          onReplyComment={onReplyComment}
          onReviewCommentPatches={onReviewCommentPatches}
          onResolveComment={onResolveComment}
          onSetActiveCommentState={onSetActiveCommentState}
          onSetEditComment={onSetEditComment}
          onSetEditReplyContent={onSetEditReplyContent}
          onSetEditType={onSetEditType}
          onSetReplyComment={onSetReplyComment}
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
  isBusy,
  label,
  onDeleteComment,
  onEditComment,
  onEditReply,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onResolveComment,
  onSetActiveCommentState,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
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
            return (
              <li key={comment.id}>
                <CommentCard
                  anchorSummaries={anchorSummaries}
                  comment={comment}
                  editingCommentId={editingCommentId}
                  editComment={editComment}
                  editingReply={editingReply}
                  editReplyContent={editReplyContent}
                  replyEditError={replyEditError}
                  editType={editType}
                  isActive={isCommentActive(activeCommentState, comment.id)}
                  isBusy={isBusy}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onEditReply={onEditReply}
                  onFindComment={onFindComment}
                  onMarkCommentForExport={onMarkCommentForExport}
                  onReopenComment={onReopenComment}
                  onReplyComment={onReplyComment}
                  onReviewCommentPatches={onReviewCommentPatches}
                  onResolveComment={onResolveComment}
                  onActivateComment={(commentId) =>
                    onSetActiveCommentState({ kind: "comment", commentId })
                  }
                  onClearActiveComment={() =>
                    onSetActiveCommentState({ kind: "none" })
                  }
                  onSetEditComment={onSetEditComment}
                  onSetEditReplyContent={onSetEditReplyContent}
                  onSetEditType={onSetEditType}
                  onSetReplyComment={onSetReplyComment}
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
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditReplyContent: (content: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
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
  onResolveComment,
  onSetEditComment,
  onSetEditReplyContent,
  onSetEditType,
  onSetReplyComment,
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
  const isCompact = !isActive && !isEditing && !isReplying;
  const collapsedTarget = getCollapsedCommentTarget({
    comment,
    fallbackLabel: anchorSummary.label,
    locationLabel: anchorSummary.locationLabel
  });

  return (
    <article
      aria-label={`${isActive ? "Active comment" : "Comment"} ${comment.id}`}
      aria-current={isActive ? "true" : undefined}
      className={`comment-card ${quiet ? "comment-card-quiet" : ""} ${
        isCompact ? "comment-card-compact" : "comment-card-active"
      }`}
      data-active={isActive ? "true" : undefined}
      tabIndex={isCompact ? 0 : undefined}
      onClick={(event) => {
        if (isCompact && !isInteractiveCommentTarget(event.target)) {
          onActivateComment(comment.id);
        }
      }}
      onKeyDown={(event) => {
        if (!isCompact || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }

        event.preventDefault();
        onActivateComment(comment.id);
      }}
    >
      {isCompact ? (
        <>
          <div className="comment-card-meta">
            <span className="comment-type">[{comment.type}]</span>
            <span>{comment.status}</span>
          </div>
          <div
            aria-label={collapsedTarget.title}
            className={`comment-target comment-target-${collapsedTarget.variant}`}
            title={collapsedTarget.title}
          >
            <strong className="comment-target-primary">
              {collapsedTarget.primary}
            </strong>
            {collapsedTarget.secondary ? (
              <span className="comment-target-secondary">
                {collapsedTarget.secondary}
              </span>
            ) : null}
          </div>
          <p className="comment-collapsed-preview">
            {truncateText(comment.comment, 130)}
          </p>
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
          <div className="comment-card-meta">
            <span className="comment-type">[{comment.type}]</span>
            <span>{comment.status}</span>
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
              <span>{getCommentPatchGroupSummaryLabel(patchGroupSummary)}</span>
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
            <button
              type="button"
              disabled={isBusy}
              onClick={() => {
                void onFindComment(comment).catch(() => undefined);
              }}
            >
              Find
            </button>
            {comment.status === "open" ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onStartReplying(comment)}
              >
                Reply
              </button>
            ) : null}
            {comment.status === "open" && isQueuedForExport ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onUnmarkCommentForExport(comment.id).catch(() => undefined);
                }}
              >
                Unmark
              </button>
            ) : comment.status === "open" ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onMarkCommentForExport(comment.id).catch(() => undefined);
                }}
              >
                Mark for ChatGPT
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
              <>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={onClearActiveComment}
                >
                  Close details
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    void onReopenComment(comment.id).catch(() => undefined);
                  }}
                >
                  Reopen
                </button>
              </>
            ) : null}
            {comment.status === "open" ? (
              <button type="button" disabled={isBusy} onClick={onClearActiveComment}>
                Close details
              </button>
            ) : null}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onStartEditing(comment)}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onDeleteComment(comment.id)}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </article>
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
  if (summary.groupCount > 1) {
    return summary.pending > 0 ? "Review groups" : "View groups";
  }

  if (summary.patchCount === 1) {
    return summary.pending > 0 ? "Review patch" : "View patch";
  }

  return summary.pending > 0 ? "Review group" : "View group";
}

function formatCommentPatchGroupStatusSummary(
  summary: CommentPatchGroupSummary
): string {
  const parts = [
    summary.pending > 0 ? `${summary.pending} pending` : null,
    summary.accepted > 0 ? `${summary.accepted} applied` : null,
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

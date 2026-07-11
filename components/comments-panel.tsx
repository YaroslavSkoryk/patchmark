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
  type CommentAnchorStatus,
  type PatchmarkComment,
  type PatchmarkCommentAnchor,
  type PatchmarkSelectedTextAnchorContextKind,
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
  status: CommentAnchorStatus;
};

type CommentsPanelProps = {
  addRequest: CommentAddRequest | null;
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
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment: (commentId: string) => Promise<void>;
  onReplyComment: (commentId: string, content: string) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onReviewFirstPendingPatch: () => void;
  onResolveComment: (commentId: string) => Promise<void>;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
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
const COMMENT_CARD_FALLBACK_HEIGHT = 180;
const COMMENT_ADD_FORM_FALLBACK_HEIGHT = 260;
const COMMENT_FLOATING_DRAFT_ID = "PM-COMMENT-DRAFT-FORM";

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
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onReviewFirstPendingPatch,
  onResolveComment,
  onUnmarkCommentForExport,
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
  const [formError, setFormError] = useState("");
  const [expandedResolvedCommentIds, setExpandedResolvedCommentIds] = useState<
    Set<string>
  >(new Set());
  const openComments = useMemo(
    () => comments.filter((comment) => comment.status === "open"),
    [comments]
  );
  const resolvedComments = useMemo(
    () => comments.filter((comment) => comment.status === "resolved"),
    [comments]
  );
  const canUseSelectedText = Boolean(selectedTextPreview);
  const canUseSection = headings.length > 0;

  useEffect(() => {
    const resolvedCommentIds = new Set(
      comments
        .filter((comment) => comment.status === "resolved")
        .map((comment) => comment.id)
    );

    setExpandedResolvedCommentIds((currentIds) => {
      const nextIds = new Set(
        [...currentIds].filter((commentId) => resolvedCommentIds.has(commentId))
      );

      return nextIds.size === currentIds.size ? currentIds : nextIds;
    });
  }, [comments]);

  function toggleResolvedComment(commentId: string) {
    setExpandedResolvedCommentIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (nextIds.has(commentId)) {
        nextIds.delete(commentId);
      } else {
        nextIds.add(commentId);
      }

      return nextIds;
    });
  }

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
    setEditingCommentId(comment.id);
    setIsAdding(false);
    setAddPositionTop(null);
    setReplyingCommentId(null);
    setReplyComment("");
    setEditType(comment.type);
    setEditComment(comment.comment);
    setFormError("");
  }

  function startReplying(comment: PatchmarkComment) {
    setReplyingCommentId(comment.id);
    setReplyComment("");
    setEditingCommentId(null);
    setIsAdding(false);
    setAddPositionTop(null);
    setFormError("");
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
                Pending patch{pendingPatchTotal === 1 ? "" : "es"}:{" "}
                {pendingPatchTotal}
              </span>
              <button
                type="button"
                disabled={isBusy}
                onClick={onReviewFirstPendingPatch}
              >
                Review patch{pendingPatchTotal === 1 ? "" : "es"}
              </button>
            </div>
          ) : null}

          <FloatingCommentList
            addForm={addForm}
            addPositionTop={addPositionTop}
            anchorSummaries={anchorSummaries}
            commentPositions={commentPositions}
            comments={openComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            expandedResolvedCommentIds={expandedResolvedCommentIds}
            isBusy={isBusy}
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onFindComment={onFindComment}
            onMarkCommentForExport={onMarkCommentForExport}
            onReopenComment={onReopenComment}
            onReplyComment={handleReplyComment}
            onReviewCommentPatches={onReviewCommentPatches}
            onResolveComment={onResolveComment}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onSetReplyComment={setReplyComment}
            onStartEditing={startEditing}
            onStartReplying={startReplying}
            onStopEditing={() => setEditingCommentId(null)}
            onStopReplying={() => {
              setReplyingCommentId(null);
              setReplyComment("");
            }}
            onToggleResolvedComment={toggleResolvedComment}
            onUnmarkCommentForExport={onUnmarkCommentForExport}
            pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
            replyingCommentId={replyingCommentId}
            replyComment={replyComment}
          />
          {resolvedComments.length > 0 ? (
            <CommentGroup
              anchorSummaries={anchorSummaries}
              comments={resolvedComments}
              editingCommentId={editingCommentId}
              editComment={editComment}
              editType={editType}
              emptyMessage="No resolved comments."
              expandedResolvedCommentIds={expandedResolvedCommentIds}
              isBusy={isBusy}
              label={`Resolved comments (${resolvedComments.length})`}
              onDeleteComment={handleDeleteComment}
              onEditComment={handleEditComment}
              onFindComment={onFindComment}
              onMarkCommentForExport={onMarkCommentForExport}
              onReopenComment={onReopenComment}
              onReplyComment={handleReplyComment}
              onReviewCommentPatches={onReviewCommentPatches}
              onResolveComment={onResolveComment}
              onSetEditComment={setEditComment}
              onSetEditType={setEditType}
              onSetReplyComment={setReplyComment}
              onStartEditing={startEditing}
              onStartReplying={startReplying}
              onStopEditing={() => setEditingCommentId(null)}
              onStopReplying={() => {
                setReplyingCommentId(null);
                setReplyComment("");
              }}
              onToggleResolvedComment={toggleResolvedComment}
              onUnmarkCommentForExport={onUnmarkCommentForExport}
              pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
              quiet
              replyingCommentId={replyingCommentId}
              replyComment={replyComment}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

type CommentGroupProps = {
  anchorSummaries: Record<string, CommentAnchorSummary>;
  comments: PatchmarkComment[];
  editingCommentId: string | null;
  editComment: string;
  editType: PatchmarkCommentType;
  emptyMessage: string;
  expandedResolvedCommentIds: Set<string>;
  isBusy: boolean;
  label: string;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onReplyComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStartReplying: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  onStopReplying: () => void;
  onToggleResolvedComment: (commentId: string) => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
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
  anchorSummaries,
  commentPositions,
  comments,
  editingCommentId,
  editComment,
  editType,
  expandedResolvedCommentIds,
  isBusy,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onSetReplyComment,
  onStartEditing,
  onStartReplying,
  onStopEditing,
  onStopReplying,
  onToggleResolvedComment,
  onUnmarkCommentForExport,
  pendingPatchCountsByCommentId,
  replyingCommentId,
  replyComment
}: FloatingCommentListProps) {
  const floatingItemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [measuredItemHeights, setMeasuredItemHeights] = useState<
    Record<string, number>
  >({});
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
                preferredTop: Math.max(0, addPositionTop)
              }
            ]
          : []),
        ...positionedComments.map((comment) => ({
          comment,
          createdAt: comment.created_at,
          fallbackHeight: COMMENT_CARD_FALLBACK_HEIGHT,
          id: comment.id,
          kind: "comment" as const,
          preferredTop: Math.max(0, commentPositions[comment.id] ?? 0)
        }))
      ].sort(sortFloatingLayoutItems),
    [addForm, addPositionTop, commentPositions, positionedComments]
  );
  const floatingLayout = useMemo(
    () => createFloatingLayout(floatingLayoutItems, measuredItemHeights),
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

      for (const itemId of itemIds) {
        const element = floatingItemRefs.current[itemId];

        if (element) {
          nextMeasuredItemHeights[itemId] = Math.ceil(
            element.getBoundingClientRect().height
          );
        }
      }

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
    editComment,
    editingCommentId,
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
          style={{ minHeight: `${floatingLayout.stageHeight}px` }}
        >
          {floatingLayoutItems.map((item) => (
            <li
              className={`comment-floating-item ${
                item.kind === "draft" ? "comment-floating-item-draft" : ""
              }`}
              key={item.id}
              ref={(element) => {
                floatingItemRefs.current[item.id] = element;
              }}
              style={{ top: floatingLayout.positions[item.id] ?? item.preferredTop }}
            >
              {item.kind === "draft" ? (
                addForm
              ) : (
                <CommentCard
                  anchorSummaries={anchorSummaries}
                  comment={item.comment}
                  editingCommentId={editingCommentId}
                  editComment={editComment}
                  editType={editType}
                  expandedResolvedCommentIds={expandedResolvedCommentIds}
                  isBusy={isBusy}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onFindComment={onFindComment}
                  onMarkCommentForExport={onMarkCommentForExport}
                  onReopenComment={onReopenComment}
                  onReplyComment={onReplyComment}
                  onReviewCommentPatches={onReviewCommentPatches}
                  onResolveComment={onResolveComment}
                  onSetEditComment={onSetEditComment}
                  onSetEditType={onSetEditType}
                  onSetReplyComment={onSetReplyComment}
                  onStartEditing={onStartEditing}
                  onStartReplying={onStartReplying}
                  onStopEditing={onStopEditing}
                  onStopReplying={onStopReplying}
                  onToggleResolvedComment={onToggleResolvedComment}
                  onUnmarkCommentForExport={onUnmarkCommentForExport}
                  pendingPatchCount={
                    pendingPatchCountsByCommentId[item.comment.id] ?? 0
                  }
                  quiet={item.comment.status === "resolved"}
                  replyingCommentId={replyingCommentId}
                  replyComment={replyComment}
                />
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {addForm && addPositionTop === null ? addForm : null}

      {unpositionedComments.length > 0 ? (
        <CommentGroup
          anchorSummaries={anchorSummaries}
          comments={sortCommentsByStatus(unpositionedComments)}
          editingCommentId={editingCommentId}
          editComment={editComment}
          editType={editType}
          emptyMessage="No comments need review."
          expandedResolvedCommentIds={expandedResolvedCommentIds}
          isBusy={isBusy}
          label="Needs review"
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
          onFindComment={onFindComment}
          onMarkCommentForExport={onMarkCommentForExport}
          onReopenComment={onReopenComment}
          onReplyComment={onReplyComment}
          onReviewCommentPatches={onReviewCommentPatches}
          onResolveComment={onResolveComment}
          onSetEditComment={onSetEditComment}
          onSetEditType={onSetEditType}
          onSetReplyComment={onSetReplyComment}
          onStartEditing={onStartEditing}
          onStartReplying={onStartReplying}
          onStopEditing={onStopEditing}
          onStopReplying={onStopReplying}
          onToggleResolvedComment={onToggleResolvedComment}
          onUnmarkCommentForExport={onUnmarkCommentForExport}
          pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
          quiet
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

function createFloatingLayout(
  items: FloatingLayoutItem[],
  measuredItemHeights: Record<string, number>
): {
  positions: Record<string, number>;
  stageHeight: number;
} {
  const positions: Record<string, number> = {};
  let previousBottom = -Infinity;

  for (const item of items) {
    const itemHeight = measuredItemHeights[item.id] ?? item.fallbackHeight;
    const nextTop = Math.max(
      item.preferredTop,
      Number.isFinite(previousBottom)
        ? previousBottom + COMMENT_CARD_GAP
        : item.preferredTop
    );

    positions[item.id] = nextTop;
    previousBottom = nextTop + itemHeight;
  }

  return {
    positions,
    stageHeight:
      items.length === 0
        ? 0
        : Math.max(220, previousBottom + COMMENT_CARD_GAP)
  };
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

function CommentGroup({
  anchorSummaries,
  comments,
  editingCommentId,
  editComment,
  editType,
  emptyMessage,
  expandedResolvedCommentIds,
  isBusy,
  label,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onSetReplyComment,
  onStartEditing,
  onStartReplying,
  onStopEditing,
  onStopReplying,
  onToggleResolvedComment,
  onUnmarkCommentForExport,
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
                  editType={editType}
                  expandedResolvedCommentIds={expandedResolvedCommentIds}
                  isBusy={isBusy}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onFindComment={onFindComment}
                  onMarkCommentForExport={onMarkCommentForExport}
                  onReopenComment={onReopenComment}
                  onReplyComment={onReplyComment}
                  onReviewCommentPatches={onReviewCommentPatches}
                  onResolveComment={onResolveComment}
                  onSetEditComment={onSetEditComment}
                  onSetEditType={onSetEditType}
                  onSetReplyComment={onSetReplyComment}
                  onStartEditing={onStartEditing}
                  onStartReplying={onStartReplying}
                  onStopEditing={onStopEditing}
                  onStopReplying={onStopReplying}
                  onToggleResolvedComment={onToggleResolvedComment}
                  onUnmarkCommentForExport={onUnmarkCommentForExport}
                  pendingPatchCount={pendingPatchCountsByCommentId[comment.id] ?? 0}
                  quiet={quiet}
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

type CommentCardProps = {
  anchorSummaries: Record<string, CommentAnchorSummary>;
  comment: PatchmarkComment;
  editingCommentId: string | null;
  editComment: string;
  editType: PatchmarkCommentType;
  expandedResolvedCommentIds: Set<string>;
  isBusy: boolean;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onMarkCommentForExport: (commentId: string) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onReplyComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReviewCommentPatches: (commentId: string) => void;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onSetReplyComment: (comment: string) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStartReplying: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  onStopReplying: () => void;
  onToggleResolvedComment: (commentId: string) => void;
  onUnmarkCommentForExport: (commentId: string) => Promise<void>;
  pendingPatchCount: number;
  quiet?: boolean;
  replyingCommentId: string | null;
  replyComment: string;
};

function CommentCard({
  anchorSummaries,
  comment,
  editingCommentId,
  editComment,
  editType,
  expandedResolvedCommentIds,
  isBusy,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onMarkCommentForExport,
  onReopenComment,
  onReplyComment,
  onReviewCommentPatches,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onSetReplyComment,
  onStartEditing,
  onStartReplying,
  onStopEditing,
  onStopReplying,
  onToggleResolvedComment,
  onUnmarkCommentForExport,
  pendingPatchCount,
  replyingCommentId,
  replyComment,
  quiet = false
}: CommentCardProps) {
  const anchorSummary = anchorSummaries[comment.id] ?? {
    label: getCommentAnchorLabel(comment),
    status: "document" as const
  };
  const threadPreviewEntries = comment.thread.slice(-3);
  const isReplying = replyingCommentId === comment.id;
  const isQueuedForExport =
    comment.export_state.focus_state === "in_focus" ||
    comment.export_state.focus_state === "awaiting_reply";
  const latestAnchorPatchId = comment.anchor_history?.at(-1)?.source_patch_id;
  const latestPatchImpact = comment.patch_impacts?.at(-1);
  const isResolvedCollapsed =
    comment.status === "resolved" &&
    editingCommentId !== comment.id &&
    !expandedResolvedCommentIds.has(comment.id);
  const hasQuietAnchorWarning =
    anchorSummary.status === "not_found" || anchorSummary.status === "ambiguous";

  return (
    <article
      className={`comment-card ${quiet ? "comment-card-quiet" : ""} ${
        isResolvedCollapsed ? "comment-card-collapsed" : ""
      }`}
    >
      {isResolvedCollapsed ? (
        <>
          <div className="comment-card-meta">
            <span className="comment-type">[{comment.type}]</span>
            <span>Resolved</span>
          </div>
          <strong className="comment-target">{anchorSummary.label}</strong>
          {hasQuietAnchorWarning ? (
            <span className="comment-anchor-detail">Anchor needs review</span>
          ) : null}
          <p className="comment-collapsed-preview">
            {truncateText(comment.comment, 120)}
          </p>
          <span className="comment-timestamp">
            Updated {formatCommentDate(comment.updated_at)}
          </span>
          <div className="comment-card-actions comment-card-actions-compact">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onToggleResolvedComment(comment.id)}
            >
              Expand
            </button>
            {onReopenComment ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onReopenComment(comment.id).catch(() => undefined);
                }}
              >
                Reopen
              </button>
            ) : null}
          </div>
        </>
      ) : editingCommentId === comment.id ? (
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
          <span
            className={`comment-focus-state comment-focus-state-${comment.status === "resolved"
              ? "resolved"
              : comment.export_state.focus_state
            }`}
          >
            {getCommentFocusStateLabel(comment)}
          </span>
          <span
            className={`comment-anchor-status comment-anchor-status-${anchorSummary.status}`}
          >
            {getAnchorStatusLabel(anchorSummary.status)}
          </span>
          {anchorSummary.detail ? (
            <span className="comment-anchor-detail">{anchorSummary.detail}</span>
          ) : null}
          {latestPatchImpact ? (
            <>
              <span
                className={`comment-anchor-status comment-patch-impact comment-patch-impact-${latestPatchImpact.result}`}
              >
                {getPatchImpactStatusLabel(latestPatchImpact.result)}
              </span>
              <span className="comment-anchor-detail">
                Affected by {latestPatchImpact.patch_id}
              </span>
            </>
          ) : null}
          {latestAnchorPatchId ? (
            <span className="comment-anchor-detail">
              Anchor updated by {latestAnchorPatchId}
            </span>
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
          {pendingPatchCount > 0 ? (
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
          {threadPreviewEntries.length > 0 ? (
            <div className="comment-thread-preview">
              <span>
                Thread preview
                {comment.thread.length > threadPreviewEntries.length
                  ? ` · latest ${threadPreviewEntries.length} of ${
                      comment.thread.length
                    }`
                  : ` · ${comment.thread.length} entr${
                      comment.thread.length === 1 ? "y" : "ies"
                    }`}
              </span>
              {threadPreviewEntries.map((entry) => (
                <div className="comment-thread-entry" key={entry.id}>
                  <strong>{getThreadRoleLabel(entry.role)}:</strong>
                  <p>{entry.content}</p>
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
              ))}
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
                  onClick={() => onToggleResolvedComment(comment.id)}
                >
                  Collapse
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
  if (comment.anchor.kind === "document") {
    return "Whole document";
  }

  if (comment.anchor.kind === "section") {
    return `Whole section: ${"#".repeat(comment.anchor.heading_level ?? 1)} ${
      comment.anchor.heading
    }`;
  }

  return `Selected text in ${getContainingHeadingLabel(comment.anchor)}`;
}

function getContainingHeadingLabel(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): string {
  if (!anchor.containing_heading) {
    return "document";
  }

  return `${"#".repeat(anchor.containing_heading_level ?? 1)} ${
    anchor.containing_heading
  }`;
}

function getAnchorStatusLabel(status: CommentAnchorStatus): string {
  if (status === "document") {
    return "Whole document";
  }

  if (status === "active") {
    return "Anchor active";
  }

  if (status === "ambiguous") {
    return "Multiple matches";
  }

  return "Anchor not found";
}

function getPatchImpactStatusLabel(
  result: NonNullable<PatchmarkComment["patch_impacts"]>[number]["result"]
): string {
  if (result === "needs_review") {
    return "Needs review";
  }

  if (result === "reanchored") {
    return "Re-anchored after patch";
  }

  if (result === "offset_shifted") {
    return "Offset shifted after patch";
  }

  return "Affected by patch";
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

function sortCommentsByStatus(comments: PatchmarkComment[]): PatchmarkComment[] {
  return [...comments].sort((firstComment, secondComment) => {
    if (firstComment.status === secondComment.status) {
      return firstComment.updated_at.localeCompare(secondComment.updated_at);
    }

    return firstComment.status === "open" ? -1 : 1;
  });
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

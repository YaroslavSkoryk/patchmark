"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  onReopenComment: (commentId: string) => Promise<void>;
  onResolveComment: (commentId: string) => Promise<void>;
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
  onReopenComment,
  onResolveComment,
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
  const [formError, setFormError] = useState("");
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
    setEditType(comment.type);
    setEditComment(comment.comment);
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

          <FloatingCommentList
            addForm={addForm}
            addPositionTop={addPositionTop}
            anchorSummaries={anchorSummaries}
            commentPositions={commentPositions}
            comments={[...openComments, ...resolvedComments]}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            isBusy={isBusy}
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onFindComment={onFindComment}
            onReopenComment={onReopenComment}
            onResolveComment={onResolveComment}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onStartEditing={startEditing}
            onStopEditing={() => setEditingCommentId(null)}
          />
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
  isBusy: boolean;
  label: string;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  quiet?: boolean;
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
  isBusy,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onReopenComment,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onStartEditing,
  onStopEditing
}: FloatingCommentListProps) {
  const positionedComments = comments
    .filter((comment) => commentPositions[comment.id] !== undefined)
    .sort((firstComment, secondComment) => {
      const firstTop = commentPositions[firstComment.id] ?? 0;
      const secondTop = commentPositions[secondComment.id] ?? 0;

      return firstTop - secondTop;
    });
  const unpositionedComments = comments.filter(
    (comment) => commentPositions[comment.id] === undefined
  );
  const positionedAddFormTop =
    addForm && addPositionTop !== null
      ? getStackedAddFormTop(addPositionTop, commentPositions)
      : null;
  const stageHeight =
    positionedComments.length === 0 && positionedAddFormTop === null
      ? 0
      : Math.max(
          220,
          positionedAddFormTop !== null ? positionedAddFormTop + 260 : 0,
          ...positionedComments.map(
            (comment) => (commentPositions[comment.id] ?? 0) + 180
          )
        );

  if (comments.length === 0 && !addForm) {
    return (
      <p className="comments-empty">
        No comments yet. Right-click in the document to add one.
      </p>
    );
  }

  return (
    <div className="comment-floating-layout">
      {positionedComments.length > 0 || positionedAddFormTop !== null ? (
        <ol
          className="comment-floating-stage"
          style={{ minHeight: `${stageHeight}px` }}
        >
          {addForm && positionedAddFormTop !== null ? (
            <li
              className="comment-floating-item comment-floating-item-draft"
              style={{ top: positionedAddFormTop }}
            >
              {addForm}
            </li>
          ) : null}
          {positionedComments.map((comment) => (
            <li
              className="comment-floating-item"
              key={comment.id}
              style={{ top: commentPositions[comment.id] }}
            >
              <CommentCard
                anchorSummaries={anchorSummaries}
                comment={comment}
                editingCommentId={editingCommentId}
                editComment={editComment}
                editType={editType}
                isBusy={isBusy}
                onDeleteComment={onDeleteComment}
                onEditComment={onEditComment}
                onFindComment={onFindComment}
                onReopenComment={onReopenComment}
                onResolveComment={onResolveComment}
                onSetEditComment={onSetEditComment}
                onSetEditType={onSetEditType}
                onStartEditing={onStartEditing}
                onStopEditing={onStopEditing}
                quiet={comment.status === "resolved"}
              />
            </li>
          ))}
        </ol>
      ) : null}

      {addForm && positionedAddFormTop === null ? addForm : null}

      {unpositionedComments.length > 0 ? (
        <CommentGroup
          anchorSummaries={anchorSummaries}
          comments={sortCommentsByStatus(unpositionedComments)}
          editingCommentId={editingCommentId}
          editComment={editComment}
          editType={editType}
          emptyMessage="No comments need review."
          isBusy={isBusy}
          label="Needs review"
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
          onFindComment={onFindComment}
          onReopenComment={onReopenComment}
          onResolveComment={onResolveComment}
          onSetEditComment={onSetEditComment}
          onSetEditType={onSetEditType}
          onStartEditing={onStartEditing}
          onStopEditing={onStopEditing}
          quiet
        />
      ) : null}
    </div>
  );
}

function getStackedAddFormTop(
  addPositionTop: number,
  commentPositions: Record<string, number>
): number {
  const minimumGap = 148;
  let nextTop = Math.max(0, addPositionTop);

  for (const commentTop of Object.values(commentPositions).sort(
    (firstTop, secondTop) => firstTop - secondTop
  )) {
    if (nextTop >= commentTop && nextTop < commentTop + minimumGap) {
      nextTop = commentTop + minimumGap;
    }
  }

  return nextTop;
}

function CommentGroup({
  anchorSummaries,
  comments,
  editingCommentId,
  editComment,
  editType,
  emptyMessage,
  isBusy,
  label,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onReopenComment,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onStartEditing,
  onStopEditing,
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
                  isBusy={isBusy}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onFindComment={onFindComment}
                  onReopenComment={onReopenComment}
                  onResolveComment={onResolveComment}
                  onSetEditComment={onSetEditComment}
                  onSetEditType={onSetEditType}
                  onStartEditing={onStartEditing}
                  onStopEditing={onStopEditing}
                  quiet={quiet}
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
  isBusy: boolean;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFindComment: (comment: PatchmarkComment) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  quiet?: boolean;
};

function CommentCard({
  anchorSummaries,
  comment,
  editingCommentId,
  editComment,
  editType,
  isBusy,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onReopenComment,
  onResolveComment,
  onSetEditComment,
  onSetEditType,
  onStartEditing,
  onStopEditing,
  quiet = false
}: CommentCardProps) {
  const anchorSummary = anchorSummaries[comment.id] ?? {
    label: getCommentAnchorLabel(comment),
    status: "document" as const
  };

  return (
    <article className={`comment-card ${quiet ? "comment-card-quiet" : ""}`}>
      {editingCommentId === comment.id ? (
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
            className={`comment-anchor-status comment-anchor-status-${anchorSummary.status}`}
          >
            {getAnchorStatusLabel(anchorSummary.status)}
          </span>
          {anchorSummary.detail ? (
            <span className="comment-anchor-detail">{anchorSummary.detail}</span>
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
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void onReopenComment(comment.id).catch(() => undefined);
                }}
              >
                Reopen
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MarkdownHeading } from "@/lib/markdown/parse-headings";
import {
  type CommentAnchorStatus,
  type PatchmarkComment,
  type PatchmarkCommentAnchor,
  type PatchmarkCommentType
} from "@/lib/project/project-types";

export type CommentAnchorScope = PatchmarkCommentAnchor["kind"];

export type CommentAddRequest = {
  nonce: number;
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
  comments: PatchmarkComment[];
  defaultSectionLine: number | null;
  error: string | null;
  headings: MarkdownHeading[];
  isBusy: boolean;
  isMarkdownMode: boolean;
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
  comments,
  defaultSectionLine,
  error,
  headings,
  isBusy,
  isMarkdownMode,
  isProjectMode,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onFindComment,
  onReopenComment,
  onResolveComment,
  selectedTextPreview
}: CommentsPanelProps) {
  const handledAddRequestNonceRef = useRef<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addScope, setAddScope] = useState<CommentAnchorScope>("document");
  const [addType, setAddType] = useState<PatchmarkCommentType>("note");
  const [addTargetLine, setAddTargetLine] = useState("");
  const [addComment, setAddComment] = useState("");
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
  const canEditComments = isProjectMode && !error;
  const canUseSelectedText = Boolean(selectedTextPreview);
  const canUseSection = headings.length > 0;

  const openAddForm = useCallback((
    preferredScope?: CommentAnchorScope,
    preferredHeadingLine?: number | null
  ) => {
    let nextScope =
      preferredScope ??
      (canUseSelectedText ? "selected_text" : canUseSection ? "section" : "document");

    if (nextScope === "selected_text" && !canUseSelectedText) {
      nextScope = canUseSection ? "section" : "document";
    }

    if (nextScope === "section" && !canUseSection) {
      nextScope = "document";
    }

    setAddScope(nextScope);
    setAddTargetLine(
      nextScope === "section" && (preferredHeadingLine ?? defaultSectionLine)
        ? String(preferredHeadingLine ?? defaultSectionLine)
        : ""
    );
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
    openAddForm(addRequest.scope, addRequest.targetHeadingLine ?? null);
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
      setAddType("note");
      setAddScope("document");
      setIsAdding(false);
    } catch {
      setFormError("Could not save comment. Your draft is still here.");
    }
  }

  function startEditing(comment: PatchmarkComment) {
    setEditingCommentId(comment.id);
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

  return (
    <section className="comments-panel" aria-label="Comments">
      <div className="comments-panel-heading">
        <h2>Comments</h2>
        {canEditComments ? (
          <div className="comments-panel-actions">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => openAddForm()}
            >
              Add Comment
            </button>
            {isMarkdownMode || canUseSelectedText ? (
              <button
                type="button"
                disabled={isBusy || !canUseSelectedText}
                onClick={() => openAddForm("selected_text")}
              >
                Add Comment to Selection
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

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
          {isAdding ? (
            <form className="comment-form" onSubmit={handleAddComment}>
              <fieldset className="comment-scope-options">
                <legend>Comment applies to</legend>
                <label>
                  <input
                    type="radio"
                    name="comment-anchor-scope"
                    value="selected_text"
                    checked={addScope === "selected_text"}
                    disabled={!canUseSelectedText}
                    onChange={() => setAddScope("selected_text")}
                  />
                  Selected text
                </label>
                <label>
                  <input
                    type="radio"
                    name="comment-anchor-scope"
                    value="section"
                    checked={addScope === "section"}
                    disabled={!canUseSection}
                    onChange={() => {
                      setAddScope("section");
                      setAddTargetLine(
                        defaultSectionLine ? String(defaultSectionLine) : ""
                      );
                    }}
                  />
                  Whole section
                </label>
                <label>
                  <input
                    type="radio"
                    name="comment-anchor-scope"
                    value="document"
                    checked={addScope === "document"}
                    onChange={() => setAddScope("document")}
                  />
                  Whole document
                </label>
              </fieldset>

              {addScope === "selected_text" ? (
                <div className="selected-text-preview">
                  <span>Selected text</span>
                  <p>{selectedTextPreview}</p>
                </div>
              ) : null}

              {addScope === "section" ? (
                <label>
                  <span>Target section</span>
                  <select
                    value={addTargetLine}
                    onChange={(event) => setAddTargetLine(event.target.value)}
                  >
                    <option value="">Choose a section</option>
                    {headings.map((heading) => (
                      <option
                        key={`${heading.line}-${heading.text}`}
                        value={heading.line}
                      >
                        {`${"  ".repeat(Math.max(0, heading.level - 1))}${"#".repeat(
                          heading.level
                        )} ${heading.text}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

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
                  onClick={() => setIsAdding(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {formError ? (
            <p className="comments-error" role="alert">
              {formError}
            </p>
          ) : null}

          <CommentGroup
            anchorSummaries={anchorSummaries}
            comments={openComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            emptyMessage="No open comments."
            isBusy={isBusy}
            label="Open comments"
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onFindComment={onFindComment}
            onResolveComment={onResolveComment}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onStartEditing={startEditing}
            onStopEditing={() => setEditingCommentId(null)}
          />

          <CommentGroup
            anchorSummaries={anchorSummaries}
            comments={resolvedComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            emptyMessage="No resolved comments."
            isBusy={isBusy}
            label="Resolved comments"
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onFindComment={onFindComment}
            onReopenComment={onReopenComment}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onStartEditing={startEditing}
            onStopEditing={() => setEditingCommentId(null)}
            quiet
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
            const anchorSummary = anchorSummaries[comment.id] ?? {
              label: getCommentAnchorLabel(comment),
              status: "document" as const
            };

            return (
              <li
                className={`comment-card ${quiet ? "comment-card-quiet" : ""}`}
                key={comment.id}
              >
                {editingCommentId === comment.id ? (
                  <form className="comment-form" onSubmit={onEditComment}>
                    <CommentTypeSelect
                      value={editType}
                      onChange={onSetEditType}
                    />
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
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={onStopEditing}
                      >
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
                    <strong className="comment-target">
                      {anchorSummary.label}
                    </strong>
                    <span
                      className={`comment-anchor-status comment-anchor-status-${anchorSummary.status}`}
                    >
                      {getAnchorStatusLabel(anchorSummary.status)}
                    </span>
                    {anchorSummary.detail ? (
                      <span className="comment-anchor-detail">
                        {anchorSummary.detail}
                      </span>
                    ) : null}
                    {comment.anchor.kind === "selected_text" ? (
                      <blockquote className="comment-selected-text">
                        Selected: “{truncateText(comment.anchor.selected_text, 140)}”
                      </blockquote>
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
                            void onResolveComment(comment.id).catch(
                              () => undefined
                            );
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
                            void onReopenComment(comment.id).catch(
                              () => undefined
                            );
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
              </li>
            );
          })}
        </ol>
      )}
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

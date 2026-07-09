"use client";

import { useMemo, useState } from "react";
import { type MarkdownHeading } from "@/lib/markdown/parse-headings";
import {
  type PatchmarkComment,
  type PatchmarkCommentType
} from "@/lib/project/project-types";

export type CommentFormValues = {
  comment: string;
  targetHeadingLine: number | null;
  type: PatchmarkCommentType;
};

type CommentsPanelProps = {
  comments: PatchmarkComment[];
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
  onReopenComment: (commentId: string) => Promise<void>;
  onResolveComment: (commentId: string) => Promise<void>;
};

const commentTypeOptions: PatchmarkCommentType[] = [
  "note",
  "question",
  "risk",
  "research_needed",
  "decision_needed"
];

export function CommentsPanel({
  comments,
  error,
  headings,
  isBusy,
  isProjectMode,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onReopenComment,
  onResolveComment
}: CommentsPanelProps) {
  const [isAdding, setIsAdding] = useState(false);
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

  async function handleAddComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const trimmedComment = addComment.trim();

    if (!trimmedComment) {
      setFormError("Comment text is required.");
      return;
    }

    try {
      await onAddComment({
        comment: trimmedComment,
        targetHeadingLine: addTargetLine ? Number(addTargetLine) : null,
        type: addType
      });
      setAddComment("");
      setAddTargetLine("");
      setAddType("note");
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
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              setIsAdding((currentValue) => !currentValue);
              setFormError("");
            }}
          >
            Add Comment
          </button>
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
              <label>
                <span>Target section</span>
                <select
                  value={addTargetLine}
                  onChange={(event) => setAddTargetLine(event.target.value)}
                >
                  <option value="">General document comment</option>
                  {headings.map((heading) => (
                    <option key={`${heading.line}-${heading.text}`} value={heading.line}>
                      {`${"  ".repeat(Math.max(0, heading.level - 1))}${"#".repeat(
                        heading.level
                      )} ${heading.text}`}
                    </option>
                  ))}
                </select>
              </label>
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
            comments={openComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            emptyMessage="No open comments."
            headings={headings}
            isBusy={isBusy}
            label="Open comments"
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onResolveComment={onResolveComment}
            onSetEditComment={setEditComment}
            onSetEditType={setEditType}
            onStartEditing={startEditing}
            onStopEditing={() => setEditingCommentId(null)}
          />

          <CommentGroup
            comments={resolvedComments}
            editingCommentId={editingCommentId}
            editComment={editComment}
            editType={editType}
            emptyMessage="No resolved comments."
            headings={headings}
            isBusy={isBusy}
            label="Resolved comments"
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
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
  comments: PatchmarkComment[];
  editingCommentId: string | null;
  editComment: string;
  editType: PatchmarkCommentType;
  emptyMessage: string;
  headings: MarkdownHeading[];
  isBusy: boolean;
  label: string;
  onDeleteComment: (commentId: string) => Promise<void>;
  onEditComment: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReopenComment?: (commentId: string) => Promise<void>;
  onResolveComment?: (commentId: string) => Promise<void>;
  onSetEditComment: (comment: string) => void;
  onSetEditType: (type: PatchmarkCommentType) => void;
  onStartEditing: (comment: PatchmarkComment) => void;
  onStopEditing: () => void;
  quiet?: boolean;
};

function CommentGroup({
  comments,
  editingCommentId,
  editComment,
  editType,
  emptyMessage,
  headings,
  isBusy,
  label,
  onDeleteComment,
  onEditComment,
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
          {comments.map((comment) => (
            <li
              className={`comment-card ${quiet ? "comment-card-quiet" : ""}`}
              key={comment.id}
            >
              {editingCommentId === comment.id ? (
                <form className="comment-form" onSubmit={onEditComment}>
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
                  <strong className="comment-target">
                    {getCommentTargetLabel(comment, headings)}
                  </strong>
                  <p>{comment.comment}</p>
                  <span className="comment-timestamp">
                    Updated {formatCommentDate(comment.updated_at)}
                  </span>
                  <div className="comment-card-actions">
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
            </li>
          ))}
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

function getCommentTargetLabel(
  comment: PatchmarkComment,
  headings: MarkdownHeading[]
): string {
  if (!comment.target_heading) {
    return "General document comment";
  }

  const targetHeadingExists = headings.some(
    (heading) =>
      heading.text === comment.target_heading &&
      heading.level === comment.target_heading_level
  );

  if (!targetHeadingExists) {
    return "Target section not found";
  }

  return `${"#".repeat(comment.target_heading_level ?? 1)} ${comment.target_heading}`;
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

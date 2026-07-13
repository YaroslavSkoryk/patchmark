import { getVisibleCommentThreadEntries } from "./comment-anchor-state.ts";
import type {
  PatchmarkComment,
  PatchmarkCommentExportState,
  PatchmarkCommentThreadEntry
} from "../project/project-types.ts";

export type EditableUserReply = {
  commentId: string;
  entry: PatchmarkCommentThreadEntry;
};

export function getLatestEditableUserReply(
  comment: PatchmarkComment
): EditableUserReply | null {
  if (comment.status !== "open") {
    return null;
  }

  const latestVisibleEntry = getVisibleCommentThreadEntries(comment.thread).at(-1);

  if (!latestVisibleEntry || latestVisibleEntry.role !== "user") {
    return null;
  }

  return {
    commentId: comment.id,
    entry: latestVisibleEntry
  };
}

export function isEditableUserReplyEntry({
  comment,
  entryId
}: {
  comment: PatchmarkComment;
  entryId: string;
}): boolean {
  return getLatestEditableUserReply(comment)?.entry.id === entryId;
}

export function editLatestUserReply({
  comment,
  editedAt,
  entryId,
  nextContent
}: {
  comment: PatchmarkComment;
  editedAt: string;
  entryId: string;
  nextContent: string;
}): PatchmarkComment {
  if (!nextContent.trim()) {
    throw new Error("Reply text is required.");
  }

  if (!isEditableUserReplyEntry({ comment, entryId })) {
    throw new Error(
      "Only the latest user reply can be edited. Add a new reply to correct earlier thread history."
    );
  }

  return {
    ...comment,
    export_state: getExportStateAfterUserReplyEdit({
      editedAt,
      exportState: comment.export_state
    }),
    thread: comment.thread.map((entry) =>
      entry.id === entryId
        ? {
            ...entry,
            content: nextContent,
            edit_history: [
              ...(entry.edit_history ?? []),
              {
                edited_at: editedAt,
                previous_content: entry.content
              }
            ],
            updated_at: editedAt
          }
        : entry
    ),
    updated_at: editedAt
  };
}

export function getExportStateAfterUserReplyEdit({
  editedAt,
  exportState
}: {
  editedAt: string;
  exportState: PatchmarkCommentExportState;
}): PatchmarkCommentExportState {
  if (
    exportState.focus_state === "exported" ||
    exportState.focus_state === "awaiting_reply"
  ) {
    return {
      ...exportState,
      focus_state: "in_focus",
      marked_for_export_at: editedAt
    };
  }

  if (exportState.focus_state === "idle") {
    return {
      ...exportState,
      focus_state: "in_focus",
      marked_for_export_at: editedAt
    };
  }

  return exportState;
}

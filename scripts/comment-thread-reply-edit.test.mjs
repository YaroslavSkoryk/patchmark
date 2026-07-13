import assert from "node:assert/strict";
import {
  editLatestUserReply,
  getLatestEditableUserReply,
  isEditableUserReplyEntry
} from "../lib/comments/comment-thread-reply-edit.ts";

const baseTime = "2026-07-13T08:00:00.000Z";
const editedAt = "2026-07-13T08:24:00.000Z";

function makeComment(overrides = {}) {
  return {
    id: "PM-COMMENT-0007",
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: "target text"
    },
    comment: "Original anchored comment.",
    thread: [],
    export_state: {
      focus_state: "idle"
    },
    created_at: baseTime,
    updated_at: baseTime,
    ...overrides
  };
}

function userEntry(id, content, createdAt = baseTime) {
  return {
    id,
    role: "user",
    content,
    created_at: createdAt
  };
}

function chatGptEntry(id, content, createdAt = baseTime) {
  return {
    id,
    role: "chatgpt",
    content,
    created_at: createdAt
  };
}

function systemEntry(id, content, createdAt = baseTime) {
  return {
    id,
    role: "system",
    content,
    created_at: createdAt
  };
}

{
  const comment = makeComment({
    thread: [
      chatGptEntry("PM-THREAD-0001", "Baguette should also be considered."),
      userEntry(
        "PM-THREAD-0002",
        "I do not think applied patch sounds good.\nLet's rephrase the sentence."
      )
    ]
  });
  const editableReply = getLatestEditableUserReply(comment);

  assert.equal(editableReply?.entry.id, "PM-THREAD-0002");

  const nextComment = editLatestUserReply({
    comment,
    editedAt,
    entryId: "PM-THREAD-0002",
    nextContent:
      "I do not think the applied patch sounds good.\n\nPlease rephrase the sentence more naturally."
  });

  assert.equal(nextComment.comment, "Original anchored comment.");
  assert.equal(nextComment.thread[0].content, "Baguette should also be considered.");
  assert.equal(
    nextComment.thread[1].content,
    "I do not think the applied patch sounds good.\n\nPlease rephrase the sentence more naturally."
  );
  assert.equal(nextComment.thread[1].id, "PM-THREAD-0002");
  assert.equal(nextComment.thread[1].created_at, baseTime);
  assert.equal(nextComment.thread[1].updated_at, editedAt);
  assert.deepEqual(nextComment.thread[1].edit_history, [
    {
      edited_at: editedAt,
      previous_content:
        "I do not think applied patch sounds good.\nLet's rephrase the sentence."
    }
  ]);
  assert.equal(nextComment.updated_at, editedAt);
}

{
  const exportedComment = makeComment({
    export_state: {
      focus_state: "exported",
      last_export_id: "comment-export-20260713-080000",
      last_exported_at: baseTime
    },
    thread: [userEntry("PM-THREAD-0001", "Current reply.")]
  });
  const nextComment = editLatestUserReply({
    comment: exportedComment,
    editedAt,
    entryId: "PM-THREAD-0001",
    nextContent: "Current reply, corrected."
  });

  assert.equal(nextComment.export_state.focus_state, "in_focus");
  assert.equal(nextComment.export_state.marked_for_export_at, editedAt);
  assert.equal(nextComment.export_state.last_export_id, "comment-export-20260713-080000");
  assert.equal(nextComment.export_state.last_exported_at, baseTime);
}

{
  const comment = makeComment({
    thread: [
      userEntry("PM-THREAD-0001", "Older user reply."),
      chatGptEntry("PM-THREAD-0002", "ChatGPT answered."),
      userEntry("PM-THREAD-0003", "Latest correction.")
    ]
  });

  assert.equal(isEditableUserReplyEntry({ comment, entryId: "PM-THREAD-0001" }), false);
  assert.equal(isEditableUserReplyEntry({ comment, entryId: "PM-THREAD-0003" }), true);
  assert.throws(
    () =>
      editLatestUserReply({
        comment,
        editedAt,
        entryId: "PM-THREAD-0001",
        nextContent: "Silently rewritten older reply."
      }),
    /Only the latest user reply can be edited/
  );
}

{
  const comment = makeComment({
    thread: [
      userEntry("PM-THREAD-0001", "User reply."),
      systemEntry("PM-THREAD-0002", "Patch PM-PATCH-0001 was applied.")
    ]
  });

  assert.equal(getLatestEditableUserReply(comment), null);
}

{
  const comment = makeComment({
    thread: [chatGptEntry("PM-THREAD-0001", "ChatGPT reply.")]
  });

  assert.equal(getLatestEditableUserReply(comment), null);
}

{
  const comment = makeComment({
    status: "resolved",
    thread: [userEntry("PM-THREAD-0001", "Resolved historical reply.")]
  });

  assert.equal(getLatestEditableUserReply(comment), null);
}

{
  const comment = makeComment({
    thread: [userEntry("PM-THREAD-0001", "Non-empty reply.")]
  });

  assert.throws(
    () =>
      editLatestUserReply({
        comment,
        editedAt,
        entryId: "PM-THREAD-0001",
        nextContent: "   \n\t"
      }),
    /Reply text is required/
  );
}

{
  const comment = makeComment({
    thread: [userEntry("PM-THREAD-0001", "First version.")]
  });
  const firstEdit = editLatestUserReply({
    comment,
    editedAt,
    entryId: "PM-THREAD-0001",
    nextContent: "Second version."
  });
  const secondEdit = editLatestUserReply({
    comment: firstEdit,
    editedAt: "2026-07-13T08:30:00.000Z",
    entryId: "PM-THREAD-0001",
    nextContent: "Third version."
  });

  assert.equal(secondEdit.thread.length, 1);
  assert.equal(secondEdit.thread[0].id, "PM-THREAD-0001");
  assert.deepEqual(
    secondEdit.thread[0].edit_history?.map((edit) => edit.previous_content),
    ["First version.", "Second version."]
  );
}

console.log("Comment thread reply edit tests passed.");

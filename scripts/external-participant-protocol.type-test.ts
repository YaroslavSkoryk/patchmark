import type {
  PatchmarkCommentReplyImport,
  PatchmarkExternalParticipantResponse
} from "../lib/project/project-types.ts";

declare const response: PatchmarkCommentReplyImport;

if (response.protocol_version === 3) {
  const firstPatch = response.patch_proposals[0];
  if (firstPatch.comment_target.kind === "response_comment") {
    const localRef: string = firstPatch.comment_target.local_ref;
    void localRef;
  } else {
    const persistedId: string = firstPatch.comment_target.comment_id;
    void persistedId;
  }
} else {
  const persistedId: string = response.patch_proposals[0].comment_id;
  void persistedId;
}

const externalResponse: PatchmarkExternalParticipantResponse = {
  protocol: "patchmark.comment_reply_import",
  protocol_version: 3,
  review_batch_id: "review_batch_type_test",
  project_id: "prj_type_test",
  document_id: "doc_type_test",
  new_comments: [
    {
      local_ref: "comment-1",
      document_id: "doc_type_test",
      type: "question",
      anchor: { kind: "section", heading: "Scope" },
      comment: "Is this scope intentional?"
    }
  ],
  replies: [],
  patch_proposals: [
    {
      patch_key: "clarify-scope",
      depends_on: [],
      comment_target: { kind: "response_comment", local_ref: "comment-1" },
      original_text: "Broad scope.",
      suggested_text: "Defined scope.",
      reason: "Makes the scope explicit."
    }
  ],
  open_questions: []
};

void externalResponse;

const invalidExternalResponse: PatchmarkExternalParticipantResponse = {
  protocol: "patchmark.comment_reply_import",
  protocol_version: 3,
  review_batch_id: "review_batch_type_test",
  project_id: "prj_type_test",
  document_id: "doc_type_test",
  new_comments: [],
  replies: [],
  patch_proposals: [
    {
      patch_key: "invalid-ambiguous-target",
      depends_on: [],
      comment_target: { kind: "existing_comment", comment_id: "PM-COMMENT-0001" },
      // @ts-expect-error Protocol v3 patches cannot also inject an overloaded comment_id.
      comment_id: "PM-COMMENT-0002",
      original_text: "Original.",
      suggested_text: "Suggested.",
      reason: "Reason."
    }
  ],
  open_questions: []
};

void invalidExternalResponse;

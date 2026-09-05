import { CHATGPT_ATOMIC_TABLE_PROMPT_RULES } from "../patches/atomic-table-patches.ts";
import type { ReviewBatchPromptEnvelope } from "../review-batches/review-batch-types.ts";

export const MANUAL_EXTERNAL_PARTICIPANT_PROTOCOL_VERSION = 3 as const;

export function getCommentReplyProtocolVersionForDelivery(
  delivery: "agent" | "manual"
): 2 | 3 {
  return delivery === "manual"
    ? MANUAL_EXTERNAL_PARTICIPANT_PROTOCOL_VERSION
    : 2;
}

export const MANUAL_EXTERNAL_PARTICIPANT_PAYLOAD_RULES = Object.freeze([
  "Follow the user's instruction expressed by the exported Patchmark comments.",
  "You may create independent anchored comments, reply to exported comments, and propose concrete text patches; each contribution kind is optional.",
  "Do not create comments merely to fill the response. A reply-only response is valid when that is all the instruction needs.",
  "Distinct observations should normally be separate comments at their relevant document locations, not replies in an unrelated existing thread.",
  "New comments must use unique response-local local_ref values and must not invent PM-COMMENT-* IDs.",
  "A local_ref exists only inside this response. Patchmark assigns persisted native comment IDs during import.",
  "A patch for an exported comment uses comment_target.kind existing_comment and its exact comment_id. A patch for a new response comment uses comment_target.kind response_comment and that comment's local_ref.",
  "Anchor new comments only to the exact exported document_snapshot for the exact document_id. Similar text in another document is not a valid target.",
  "Prefer the smallest meaningful selected text or exact section heading, with supported heading path and source context when useful. Do not fabricate offsets or hashes."
]);

export function createManualExternalParticipantV3Prompt({
  dedicatedDocumentInstruction,
  jsonText,
  observedAt,
  reviewBatchEnvelope
}: {
  dedicatedDocumentInstruction: boolean;
  jsonText: string;
  observedAt: string;
  reviewBatchEnvelope: ReviewBatchPromptEnvelope;
}): string {
  const exampleExistingCommentId = reviewBatchEnvelope.ordered_comment_ids[0];
  if (!exampleExistingCommentId) {
    throw new Error(
      "Manual external-participant protocol v3 requires at least one exported comment."
    );
  }
  const dedicatedNote = dedicatedDocumentInstruction
    ? `
## Document-scoped instruction

The exported document-level comment supplies the user's instruction for the whole exported document. Follow that instruction. You may create independent comments at separate relevant locations, reply to the exported comment, and propose patches when those contributions help fulfill it.
`
    : "";

  return `# Patchmark External Participant

You are participating in a Patchmark document.

Follow the user's instruction in the exported comments. Patchmark is the source of truth for document content and identity. You are not editing the document directly: return structured contributions for a human to review in Patchmark.

You may independently:

- create anchored comments where useful;
- reply to existing exported comments where appropriate;
- propose patches for concrete text changes.

The user's instruction determines which actions are useful. Do not create unnecessary comments. A response may contain only replies, only new comments, only patches, or any useful combination. Distinct observations should normally become independent comments at their own relevant locations instead of being placed in an unrelated existing thread.
${dedicatedNote}
## Identity and scope

- Return protocol patchmark.comment_reply_import with protocol_version 3.
- Preserve these exact response identities:
  - review_batch_id: ${reviewBatchEnvelope.review_batch_id}
  - project_id: ${reviewBatchEnvelope.project_id}
  - document_id: ${reviewBatchEnvelope.document_id}
- Use existing PM-COMMENT-* IDs only when they appear in the exported comments. Never invent a native comment ID.
- Every new comment needs a unique lowercase response-local local_ref, such as comment-1.
- A local_ref identifies that new comment only inside this response. Patchmark replaces it with a persisted native ID during import.
- Replies and open questions may reference only exported existing comment_id values.
- A patch for an existing exported comment uses { "kind": "existing_comment", "comment_id": "PM-COMMENT-..." }.
- A patch for a new comment in this response uses { "kind": "response_comment", "local_ref": "comment-1" }.

## New-comment anchors

Anchor every new comment against the exact document_snapshot.markdown in the export payload and repeat its exact document_id.

Use the smallest meaningful relevant location:

- { "kind": "document" } only for a genuinely whole-document comment.
- For a section, use its exact heading text. Add the supported heading_level, heading_line, and heading_path only when they match document_structure.
- For selected text, copy the exact smallest useful Markdown substring into selected_text, including source backslash escapes, inline Markdown, and soft line breaks when present. The corrected Patchmark anchor system preserves the visible punctuation represented by Markdown escapes.
- When useful, add anchor_context with an exact surrounding markdown_text and its corresponding visible plain_text, plus the exact containing heading/path.
- Prefer semantic and structural evidence. Do not calculate or fabricate raw offsets, hashes, line numbers, or fallback ranges. Omit optional positional evidence unless it is known exactly from the exported snapshot.
- Similar text in another document is never a valid target. If the intended occurrence is not uniquely identifiable in this exact snapshot, choose a larger meaningful selection/context or a section anchor.

## Patches

- Every patch needs a unique response-local lowercase patch_key and a depends_on array.
- Use an empty depends_on array for an independent patch.
- Dependencies may reference only patch keys in this response and must remain on the same resolved comment target.
- Copy original_text exactly from the exported Markdown. Keep changes narrow unless Markdown structure requires one atomic region.
- Do not create patch_group_id; Patchmark creates native patch identity during import.
- Human review remains required. Do not claim that a comment was resolved or a patch applied.

${CHATGPT_ATOMIC_TABLE_PROMPT_RULES}

## Sources and response hygiene

- Return exactly one fenced json code block and no text outside it.
- Keep summary, comment, reply, question, reason, risk, and source metadata as plain text without Markdown links or URLs.
- Markdown links are allowed only in document Markdown fields: original_text and suggested_text.
- Put evidence in the nearest field-local source array. Each source must use a raw HTTP(S) url, include published_at (which may be null), include the complete ${observedAt} observation date in observed_at, and include plain-text supports.
- If no sources are used for a field, return an empty source array.

- Do not include platform-internal citation tokens, private reference markers, search-result IDs, or file-citation syntax. Represent evidence only with Patchmark field-local source objects.

## Exact response schema

All contribution arrays are required, but any of them may be empty. Replace example content with evidence from the export payload. Do not copy placeholder IDs or anchor text unless they actually occur in the payload.

\`\`\`json
{
  "protocol": "patchmark.comment_reply_import",
  "protocol_version": 3,
  "review_batch_id": ${JSON.stringify(reviewBatchEnvelope.review_batch_id)},
  "project_id": ${JSON.stringify(reviewBatchEnvelope.project_id)},
  "document_id": ${JSON.stringify(reviewBatchEnvelope.document_id)},
  "summary": "Brief plain-text summary of the contributions.",
  "new_comments": [
    {
      "local_ref": "comment-1",
      "document_id": ${JSON.stringify(reviewBatchEnvelope.document_id)},
      "type": "question",
      "anchor": {
        "kind": "selected_text",
        "selected_text": "Exact smallest meaningful Markdown from document_snapshot.markdown.",
        "anchor_context": {
          "kind": "paragraph",
          "plain_text": "Visible text of the exact surrounding paragraph.",
          "markdown_text": "Exact Markdown of the surrounding paragraph."
        },
        "containing_heading": "Exact containing heading",
        "containing_heading_level": 2,
        "containing_heading_path": ["Parent heading", "Exact containing heading"],
        "anchor_source": "markdown"
      },
      "comment": "Independent comment at this location."
    }
  ],
  "replies": [
    {
      "comment_id": ${JSON.stringify(exampleExistingCommentId)},
      "reply": "Reply to an exported existing comment.",
      "reply_sources": [],
      "suggested_user_action": "review"
    }
  ],
  "patch_proposals": [
    {
      "patch_key": "patch-existing-1",
      "depends_on": [],
      "comment_target": {
        "kind": "existing_comment",
        "comment_id": ${JSON.stringify(exampleExistingCommentId)}
      },
      "display_title": "Improve existing wording",
      "target_heading": "Exact heading text",
      "original_text": "Exact Markdown text to replace.",
      "suggested_text": "Replacement Markdown text.",
      "suggested_text_sources": [],
      "reason": "Why this concrete change helps.",
      "reason_sources": [],
      "risk": "Tradeoff or caution.",
      "risk_sources": []
    },
    {
      "patch_key": "patch-new-comment-1",
      "depends_on": [],
      "comment_target": {
        "kind": "response_comment",
        "local_ref": "comment-1"
      },
      "display_title": "Clarify anchored wording",
      "target_heading": "Exact heading text",
      "original_text": "Exact Markdown text to replace.",
      "suggested_text": "Replacement Markdown text.",
      "suggested_text_sources": [],
      "reason": "Why this concrete change helps.",
      "reason_sources": [],
      "risk": "Tradeoff or caution.",
      "risk_sources": []
    }
  ],
  "open_questions": [
    {
      "comment_id": ${JSON.stringify(exampleExistingCommentId)},
      "question": "Clarification requested from the human.",
      "question_sources": []
    }
  ]
}
\`\`\`

Allowed new-comment type values: note, question, risk, research_needed, and decision_needed.

Allowed suggested_user_action values: review, clarify, apply_patch, keep_open, and resolve_manually.

## Patchmark Export Payload

\`\`\`json
${jsonText.trimEnd()}
\`\`\`
`;
}

export function createManualExternalParticipantV3RepairPrompt({
  specializedPrompt,
  validationError
}: {
  specializedPrompt?: string;
  validationError: string;
}): string {
  return `Please repair your previous response for the original Patchmark export and the user's original instruction.

Preserve the substantive comments, replies, patches, their source evidence, and the user's task. Change only what is necessary to satisfy the validation error.

Validation error from Patchmark:
${validationError}

Return exactly one fenced json code block containing patchmark.comment_reply_import protocol version 3. Do not downgrade to version 2 or version 1.

- Preserve the exact exported review_batch_id, project_id, and document_id.
- Preserve every correct exported existing PM-COMMENT-* ID. Never invent a native comment ID.
- Give every new comment a unique lowercase response-local local_ref; preserve correct existing local_ref relationships.
- A patch for an exported comment must use comment_target.kind "existing_comment" with its exact comment_id.
- A patch for a new comment must use comment_target.kind "response_comment" with that comment's exact local_ref.
- Anchor new comments only to the exact exported document snapshot and exact document_id. Correct contradictory selected text, context, heading/path evidence, or optional positions. Omit an optional offset or hash instead of fabricating it.
- Keep every patch_key unique, keep valid depends_on relationships, and keep each dependency on the same resolved comment target.
- Keep all required arrays: new_comments, replies, patch_proposals, and open_questions.
- Return no text outside the fenced JSON.
${specializedPrompt ? `\nAdditional repair requirement:\n${specializedPrompt}\n` : ""}`;
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAgentExchangeFeatureState } from "../lib/agent-exchange/feature-state.ts";
import {
  PATCHMARK_EXTERNAL_RESPONSE_LIMITS,
  parsePatchmarkCommentReplyImport,
  validatePatchmarkExternalParticipantResponseScope
} from "../lib/imports/patchmark-comment-reply-import.ts";

const projectId = "prj_external_protocol";
const documentId = "doc_external_protocol";
const reviewBatchId = "review_batch_external_protocol";
const existingCommentId = "PM-COMMENT-0001";

const legacyReplyOnly = parse({
  protocol: "patchmark.comment_reply_import",
  protocol_version: 1,
  replies: [{ comment_id: existingCommentId, reply: "Legacy reply." }],
  patch_proposals: [],
  open_questions: []
});
assert.equal(legacyReplyOnly.protocol_version, 1);
assert.equal(legacyReplyOnly.replies.length, 1);

const legacyReplyAndPatch = parse({
  protocol: "patchmark.comment_reply_import",
  protocol_version: 2,
  replies: [{ comment_id: existingCommentId, reply: "Legacy v2 reply." }],
  patch_proposals: [legacyPatch()],
  open_questions: []
});
assert.equal(legacyReplyAndPatch.protocol_version, 2);
assert.equal(legacyReplyAndPatch.patch_proposals[0].comment_id, existingCommentId);

const oneNewComment = parseV3({
  new_comments: [externalComment("comment-1")]
});
assert.equal(oneNewComment.new_comments.length, 1);
assert.deepEqual(oneNewComment.new_comments[0].anchor, {
  kind: "section",
  heading: "Clause 3",
  heading_level: 2,
  heading_line: 3,
  heading_path: ["Agreement", "Clause 3"]
});

const multipleNewComments = parseV3({
  new_comments: [
    externalComment("comment-1"),
    externalComment("comment-2", {
      kind: "selected_text",
      selected_text: "Payment is due in thirty days.",
      anchor_context: {
        kind: "sentence",
        plain_text: "Payment is due in thirty days.",
        selected_start_in_context: 0,
        selected_end_in_context: 30
      },
      containing_heading: "Clause 7"
    })
  ]
});
assert.equal(multipleNewComments.new_comments.length, 2);

const mixed = parseV3({
  new_comments: [externalComment("comment-1"), externalComment("comment-2")],
  replies: [{ comment_id: existingCommentId, reply: "Existing discussion reply." }],
  patch_proposals: [
    externalPatch("patch-existing", existingTarget(existingCommentId)),
    externalPatch("patch-new-one", responseTarget("comment-1")),
    externalPatch("patch-new-two", responseTarget("comment-2"))
  ],
  open_questions: [
    { comment_id: existingCommentId, question: "Should this remain optional?" }
  ]
});
assert.equal(mixed.replies.length, 1);
assert.equal(mixed.open_questions.length, 1);
assert.equal(mixed.patch_proposals.length, 3);
assert.deepEqual(mixed.patch_proposals[0].comment_target, {
  kind: "existing_comment",
  comment_id: existingCommentId
});
assert.deepEqual(mixed.patch_proposals.slice(1).map((patch) => patch.comment_target), [
  { kind: "response_comment", local_ref: "comment-1" },
  { kind: "response_comment", local_ref: "comment-2" }
]);
validatePatchmarkExternalParticipantResponseScope({
  allowedExistingCommentIds: new Set([existingCommentId]),
  documentId,
  projectId,
  response: mixed,
  reviewBatchId
});

assert.throws(
  () =>
    parseV3({
      new_comments: [externalComment("comment-1"), externalComment("comment-1")]
    }),
  /Duplicate response-local comment reference/
);
assert.throws(
  () =>
    parseV3({
      patch_proposals: [
        externalPatch("unknown-target", responseTarget("missing-comment"))
      ]
    }),
  /unknown response-local comment/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [externalComment("Bad Ref")]
    }),
  /lowercase response-local reference/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [
        externalComment("comment-1", {
          kind: "selected_text",
          selected_text: "Target",
          markdown_start_offset: 20,
          markdown_end_offset: 10
        })
      ]
    }),
  /complete ordered pair/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [
        { ...externalComment("comment-1"), document_id: "doc_outside_scope" }
      ]
    }),
  /outside the response document scope/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [externalComment("pm-comment-9999")]
    }),
  /must not use a Patchmark ID prefix/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [
        { ...externalComment("comment-1"), id: "PM-COMMENT-9999" }
      ]
    }),
  /unsupported field: id/
);
assert.throws(
  () =>
    validatePatchmarkExternalParticipantResponseScope({
      allowedExistingCommentIds: new Set([existingCommentId]),
      documentId,
      projectId,
      response: parseV3({
        patch_proposals: [
          externalPatch(
            "arbitrary-existing-id",
            existingTarget("PM-COMMENT-9999")
          )
        ]
      }),
      reviewBatchId
    }),
  /outside the allowed response scope/
);
assert.throws(
  () =>
    parseV3({
      new_comments: Array.from(
        { length: PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_array_items + 1 },
        (_, index) => externalComment(`comment-${index + 1}`)
      )
    }),
  /new_comments must contain at most/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [
        {
          ...externalComment("comment-1"),
          comment: "x".repeat(
            PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_body_length + 1
          )
        }
      ]
    }),
  /exceeds its bounds/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [
        externalComment(
          `c${"x".repeat(
            PATCHMARK_EXTERNAL_RESPONSE_LIMITS.maximum_local_ref_length
          )}`
        )
      ]
    }),
  /at most 64 characters/
);
assert.throws(
  () =>
    parseV3({
      patch_proposals: [
        {
          ...externalPatch("ambiguous-target", responseTarget("comment-1")),
          comment_id: existingCommentId
        }
      ],
      new_comments: [externalComment("comment-1")]
    }),
  /unsupported field: comment_id/
);
assert.throws(
  () =>
    parseV3({
      patch_proposals: [
        {
          ...externalPatch("ambiguous-ref", responseTarget("comment-1")),
          comment_target: {
            kind: "response_comment",
            local_ref: "comment-1",
            comment_id: existingCommentId
          }
        }
      ],
      new_comments: [externalComment("comment-1")]
    }),
  /unsupported field: comment_id/
);
assert.throws(
  () =>
    parseV3({
      new_comments: [externalComment("comment-1"), externalComment("comment-2")],
      patch_proposals: [
        externalPatch("first", responseTarget("comment-1")),
        externalPatch("second", responseTarget("comment-2"), {
          depends_on: ["first"]
        })
      ]
    }),
  /same comment target/
);

const pollutedText = JSON.stringify(
  v3Payload({ new_comments: [externalComment("comment-1")] })
).replace(
  '"comment":"External participant comment."',
  '"__proto__":{"polluted":true},"comment":"External participant comment."'
);
assert.throws(
  () => parsePatchmarkCommentReplyImport(pollutedText),
  /unsupported field: __proto__/
);
assert.equal({}.polluted, undefined);

const protocolV2Fixture = parsePatchmarkCommentReplyImport(
  readFileSync(
    new URL(
      "./fixtures/independent-protocol-v2-import-response.json",
      import.meta.url
    ),
    "utf8"
  )
);
assert.equal(protocolV2Fixture.protocol_version, 2);
assert.equal(protocolV2Fixture.patch_proposals.length, 4);

assert.equal(
  resolveAgentExchangeFeatureState("production", undefined).mode,
  "disabled"
);
assert.equal(parseV3({ new_comments: [externalComment("comment-1")] }).protocol_version, 3);

console.log(
  JSON.stringify(
    {
      backwardCompatibility: [
        legacyReplyOnly.protocol_version,
        legacyReplyAndPatch.protocol_version,
        protocolV2Fixture.protocol_version
      ],
      connectorReleaseState: "disabled",
      limits: PATCHMARK_EXTERNAL_RESPONSE_LIMITS,
      mixed: {
        newComments: mixed.new_comments.length,
        openQuestions: mixed.open_questions.length,
        patches: mixed.patch_proposals.length,
        replies: mixed.replies.length
      },
      protocolVersion: mixed.protocol_version
    },
    null,
    2
  )
);

function parse(value) {
  return parsePatchmarkCommentReplyImport(JSON.stringify(value));
}

function parseV3(overrides = {}) {
  const response = parse(v3Payload(overrides));
  assert.equal(response.protocol_version, 3);
  return response;
}

function v3Payload(overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 3,
    review_batch_id: reviewBatchId,
    project_id: projectId,
    document_id: documentId,
    summary: "External participant response.",
    new_comments: [],
    replies: [],
    patch_proposals: [],
    open_questions: [],
    ...overrides
  };
}

function externalComment(localRef, anchor = sectionAnchor()) {
  return {
    local_ref: localRef,
    document_id: documentId,
    type: "note",
    anchor,
    comment: "External participant comment."
  };
}

function sectionAnchor() {
  return {
    kind: "section",
    heading: "Clause 3",
    heading_level: 2,
    heading_line: 3,
    heading_path: ["Agreement", "Clause 3"]
  };
}

function existingTarget(commentId) {
  return { kind: "existing_comment", comment_id: commentId };
}

function responseTarget(localRef) {
  return { kind: "response_comment", local_ref: localRef };
}

function externalPatch(patchKey, commentTarget, overrides = {}) {
  return {
    patch_key: patchKey,
    depends_on: [],
    comment_target: commentTarget,
    display_title: "Clarify language",
    target_heading: "Clause 3",
    original_text: "Original wording.",
    suggested_text: "Clearer wording.",
    suggested_text_sources: [],
    reason: "Improves clarity.",
    reason_sources: [],
    risk: "Low risk.",
    risk_sources: [],
    ...overrides
  };
}

function legacyPatch() {
  return {
    patch_key: "legacy-patch",
    depends_on: [],
    comment_id: existingCommentId,
    original_text: "Original wording.",
    suggested_text: "Clearer wording.",
    reason: "Improves clarity."
  };
}

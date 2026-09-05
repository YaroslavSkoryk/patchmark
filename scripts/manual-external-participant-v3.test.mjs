import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION } from "../lib/agent-exchange/contracts.ts";
import { prepareAgentExchange } from "../lib/agent-exchange/prepared-exchange.ts";
import {
  createManualExternalParticipantV3Prompt,
  createManualExternalParticipantV3RepairPrompt,
  getCommentReplyProtocolVersionForDelivery,
  MANUAL_EXTERNAL_PARTICIPANT_PROTOCOL_VERSION
} from "../lib/comments/external-participant-prompt.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import { productReleaseState } from "../lib/release/product-release-state.ts";

const envelope = {
  review_batch_id: "review_batch_manual_v3_fixture",
  project_id: "project-manual-v3",
  document_id: "document-manual-v3",
  ordered_comment_ids: ["PM-COMMENT-0007"]
};
const userTasks = [
  "Leave questions where unclear.",
  "Reply to this comment only.",
  "Suggest improvements and propose patches."
];
const exportPayload = {
  protocol: "patchmark.comment_export",
  protocol_version: 1,
  review_batch: envelope,
  document_snapshot: {
    document_id: envelope.document_id,
    markdown: [
      "# Plan",
      "",
      "The Business of the Company is \\_\\_\\_ today."
    ].join("\n")
  },
  document_structure: [
    {
      heading: "Plan",
      heading_level: 1,
      heading_line: 1,
      heading_path: ["Plan"]
    }
  ],
  comments: userTasks.map((comment, index) => ({
    comment_id: `PM-COMMENT-000${index + 7}`,
    comment
  }))
};
const prompt = createManualExternalParticipantV3Prompt({
  dedicatedDocumentInstruction: true,
  jsonText: `${JSON.stringify(exportPayload, null, 2)}\n`,
  observedAt: "2042-01-02",
  reviewBatchEnvelope: envelope
});

assert.equal(MANUAL_EXTERNAL_PARTICIPANT_PROTOCOL_VERSION, 3);
assert.equal(getCommentReplyProtocolVersionForDelivery("manual"), 3);
assert.equal(getCommentReplyProtocolVersionForDelivery("agent"), 2);
assert.match(prompt, /You are participating in a Patchmark document/);
assert.match(prompt, /create anchored comments where useful/);
assert.match(prompt, /reply to existing exported comments/);
assert.match(prompt, /propose patches for concrete text changes/);
assert.match(prompt, /Do not create unnecessary comments/);
assert.match(prompt, /response may contain only replies/);
assert.match(prompt, /independent comments at their own relevant locations/);
assert.match(prompt, /"protocol_version": 3/);
assert.match(prompt, /"new_comments"/);
assert.match(prompt, /"kind": "existing_comment"/);
assert.match(prompt, /"kind": "response_comment"/);
assert.match(prompt, /unique lowercase response-local local_ref/);
assert.match(prompt, /Never invent a native comment ID/);
assert.match(prompt, /Patchmark replaces it with a persisted native ID/);
assert.match(prompt, /exact document_snapshot\.markdown/);
assert.match(prompt, /source backslash escapes/);
assert.match(prompt, /soft line breaks/);
assert.match(prompt, /Do not calculate or fabricate raw offsets/);
assert.match(prompt, /Similar text in another document is never a valid target/);
assert.match(prompt, new RegExp(envelope.review_batch_id));
assert.match(prompt, new RegExp(envelope.project_id));
assert.match(prompt, new RegExp(envelope.document_id));
assert.match(prompt, /The Business of the Company is \\\\_\\\\_\\\\_/);
for (const task of userTasks) assert.ok(prompt.includes(task));
assert.doesNotMatch(prompt, /review finding|AI finding|legal review entity/i);
assert.doesNotMatch(prompt, /ChatGPT|OpenAI|Codex|Claude/);
const responseSchemaMatch = /```json\n([\s\S]*?)\n```/.exec(prompt);
assert.ok(responseSchemaMatch);
const parsedResponseSchema = parsePatchmarkCommentReplyImport(
  responseSchemaMatch[1]
);
assert.equal(parsedResponseSchema.protocol_version, 3);
assert.equal(parsedResponseSchema.new_comments.length, 1);
assert.equal(parsedResponseSchema.replies[0].comment_id, "PM-COMMENT-0007");
assert.equal(
  parsedResponseSchema.patch_proposals[0].comment_target.kind,
  "existing_comment"
);
assert.equal(
  parsedResponseSchema.patch_proposals[1].comment_target.kind,
  "response_comment"
);

const localRefRepair = createManualExternalParticipantV3RepairPrompt({
  validationError:
    "Invalid Patchmark response. Patch patch-1 references unknown response-local comment comment-9."
});
assert.match(localRefRepair, /user's original instruction/);
assert.match(localRefRepair, /unknown response-local comment comment-9/);
assert.match(localRefRepair, /protocol version 3/);
assert.match(localRefRepair, /Do not downgrade to version 2/);
assert.match(localRefRepair, /preserve correct existing local_ref relationships/);
assert.match(localRefRepair, /existing_comment/);
assert.match(localRefRepair, /response_comment/);
assert.match(localRefRepair, /Never invent a native comment ID/);

const anchorRepair = createManualExternalParticipantV3RepairPrompt({
  validationError:
    "External comment comment-1 anchor was rejected: anchor_context does not contain the resolved target"
});
assert.match(anchorRepair, /anchor_context does not contain the resolved target/);
assert.match(anchorRepair, /exact exported document snapshot/);
assert.match(anchorRepair, /Omit an optional offset or hash instead of fabricating it/);

for (const protocolVersion of [1, 2]) {
  const parsed = parsePatchmarkCommentReplyImport(
    JSON.stringify({
      protocol: "patchmark.comment_reply_import",
      protocol_version: protocolVersion,
      replies: [],
      patch_proposals: [],
      open_questions: []
    })
  );
  assert.equal(parsed.protocol_version, protocolVersion);
}
const parsedV3 = parsePatchmarkCommentReplyImport(
  JSON.stringify({
    protocol: "patchmark.comment_reply_import",
    protocol_version: 3,
    review_batch_id: envelope.review_batch_id,
    project_id: envelope.project_id,
    document_id: envelope.document_id,
    new_comments: [],
    replies: [],
    patch_proposals: [],
    open_questions: []
  })
);
assert.equal(parsedV3.protocol_version, 3);

assert.equal(AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION, 2);
await assert.rejects(
  () =>
    prepareAgentExchange({
      batch: {
        status: "exported",
        response_protocol_version: 3
      },
      project: {}
    }),
  /requests protocol version 2/
);
assert.deepEqual(productReleaseState, {
  human_collaboration: false,
  agent_exchange: false
});

const documentEditorSource = readFileSync(
  "components/document-editor.tsx",
  "utf8"
);
assert.match(
  documentEditorSource,
  /getCommentReplyProtocolVersionForDelivery\(delivery\)/
);
assert.match(documentEditorSource, /responseProtocolVersion,/);
assert.match(documentEditorSource, /document_snapshot:/);
assert.match(documentEditorSource, /document_structure:/);
assert.match(documentEditorSource, /Comments added: \$\{commentsCreated\}/);
assert.match(documentEditorSource, /Replies imported: \$\{repliesAttached\}/);
assert.match(documentEditorSource, /Patches proposed: \$\{patchProposalsStored\}/);
assert.match(
  documentEditorSource,
  /This Review Batch requests manual protocol v3 delivery/
);

process.stdout.write(
  `${JSON.stringify(
    {
      agent_exchange_protocol_version: AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION,
      backward_compatible_manual_imports: [1, 2, 3],
      generic_participant_language: true,
      manual_protocol_version: MANUAL_EXTERNAL_PARTICIPANT_PROTOCOL_VERSION,
      repair_preserves_v3: true,
      release_state: productReleaseState,
      task_flexibility: userTasks.length
    },
    null,
    2
  )}\n`
);

import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  EXTERNAL_PARTICIPANT_PROTOCOL_VERSION,
  createExternalParticipantV3Prompt,
  getCommentReplyProtocolVersionForDelivery
} from "../lib/comments/external-participant-prompt.ts";
import {
  AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION
} from "../lib/agent-exchange/contracts.ts";
import {
  AgentExchangeOperationController,
  AgentExchangeOperationError
} from "../lib/agent-exchange/operation-controller.ts";
import { prepareAgentExchange } from "../lib/agent-exchange/prepared-exchange.ts";
import {
  importProjectCommentReplyResponseBytes
} from "../lib/imports/project-comment-reply-import.ts";
import {
  getProjectDocumentIdentity,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import {
  createTrackedReviewBatchExport
} from "../lib/review-batches/review-batch-export.ts";
import { listReviewBatches } from "../lib/review-batches/review-batch-repository.ts";
import { QualificationAgentExchangeConnector } from "./lib/agent-exchange-qualification-connector.ts";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree
} from "./lib/project-fixture-foundation.mjs";

const encoder = new TextEncoder();
const copies = [];
const EXISTING_COMMENT_ID = "PM-COMMENT-0007";
const SNAPSHOT_MARKDOWN = [
  "# Launch Plan",
  "",
  "The launch window opens at dawn.",
  "",
  "## Risks",
  "",
  "Backup route is stable.",
  "",
  "## Timeline",
  "",
  "Existing line stays.",
  ""
].join("\n");
let scenarioSequence = 0;
let operationSequence = 0;

try {
  assert.equal(EXTERNAL_PARTICIPANT_PROTOCOL_VERSION, 3);
  assert.equal(AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION, 3);
  assert.equal(getCommentReplyProtocolVersionForDelivery("manual"), 3);
  assert.equal(getCommentReplyProtocolVersionForDelivery("agent"), 3);

  const mixed = await createScenario("mixed", 3);
  assert.equal(mixed.batch.response_protocol_version, 3);
  assert.equal(mixed.prepared.expected_response_protocol_version, 3);
  assert.match(mixed.promptText, /# Patchmark External Participant/);
  assert.match(mixed.promptText, /"protocol_version": 3/);
  assert.match(mixed.promptText, /"new_comments"/);
  assert.match(mixed.promptText, /"kind": "response_comment"/);
  assert.equal((mixed.promptText.match(/The launch window opens at dawn\./g) ?? []).length, 1);

  const mixedResponse = createV3Response(mixed, {
    new_comments: [
      externalComment(mixed, "comment-a", {
        kind: "selected_text",
        selected_text: "The launch window opens at dawn.",
        containing_heading: "Launch Plan",
        containing_heading_level: 1,
        containing_heading_path: ["Launch Plan"],
        anchor_source: "markdown"
      }),
      externalComment(mixed, "comment-b", {
        kind: "section",
        heading: "Risks",
        heading_level: 2,
        heading_line: 5,
        heading_path: ["Launch Plan", "Risks"]
      })
    ],
    replies: [
      {
        comment_id: EXISTING_COMMENT_ID,
        reply: "The existing question is answered by the proposed clarification.",
        reply_sources: [],
        suggested_user_action: "review"
      }
    ],
    patch_proposals: [
      externalPatch(
        "clarify-launch-window",
        { kind: "response_comment", local_ref: "comment-a" },
        "launch window",
        "launch period",
        { target_heading: "Launch Plan" }
      )
    ]
  });
  const mixedImport = await executeResponse(mixed, mixedResponse);
  assert.equal(mixedImport.comments_created, 2);
  assert.equal(mixedImport.replies_attached, 1);
  assert.equal(mixedImport.patch_proposals_stored, 1);
  assert.deepEqual(mixedImport.warnings, []);
  assert.equal(mixedImport.review_batches[0].status, "responded");

  const created = mixedImport.comments.slice(1);
  assert.deepEqual(created.map((comment) => comment.id), [
    "PM-COMMENT-0008",
    "PM-COMMENT-0009"
  ]);
  assert.equal(created[0].anchor.kind, "selected_text");
  assert.equal(created[1].anchor.kind, "section");
  for (const comment of created) {
    assert.equal(comment.id.startsWith("PM-COMMENT-"), true);
    assert.equal("local_ref" in comment, false);
    assert.match(comment.source_import_id, /^PM-IMPORT-AE4-/);
  }
  assert.equal(mixedImport.comments[0].thread.length, 1);
  assert.equal(mixedImport.patches[0].comment_id, created[0].id);
  assert.equal(mixedImport.patches[0].source_patch_key, "clarify-launch-window");

  const reopenedMixed = await reopenScenario(mixed);
  const reloadedComments = await readProjectComments(reopenedMixed.project);
  const reloadedPatches = await readProjectPatches(reopenedMixed.project);
  assert.deepEqual(
    reloadedComments.map((comment) => ({
      anchorKind: comment.anchor.kind,
      id: comment.id,
      sourceImportId: comment.source_import_id ?? null,
      threadLength: comment.thread.length
    })),
    [
      {
        anchorKind: "document",
        id: EXISTING_COMMENT_ID,
        sourceImportId: null,
        threadLength: 1
      },
      {
        anchorKind: "selected_text",
        id: "PM-COMMENT-0008",
        sourceImportId: "PM-IMPORT-AE4-0001",
        threadLength: 0
      },
      {
        anchorKind: "section",
        id: "PM-COMMENT-0009",
        sourceImportId: "PM-IMPORT-AE4-0001",
        threadLength: 0
      }
    ]
  );
  assert.deepEqual(
    reloadedPatches.map((patch) => ({
      commentId: patch.comment_id,
      sourcePatchKey: patch.source_patch_key
    })),
    [
      {
        commentId: "PM-COMMENT-0008",
        sourcePatchKey: "clarify-launch-window"
      }
    ]
  );
  assert.equal(
    (await listReviewBatches(reopenedMixed.project))[0].status,
    "responded"
  );

  const completedDigest = digestProjectTree(mixed.copy.projectRoot).digest;
  await assert.rejects(
    () => executeResponse(mixed, mixedResponse),
    /already has an associated response/
  );
  assert.equal(digestProjectTree(mixed.copy.projectRoot).digest, completedDigest);
  await assert.rejects(
    () =>
      executeResponse(
        mixed,
        createV3Response(mixed, {
          summary: "Conflicting second response.",
          replies: [
            {
              comment_id: EXISTING_COMMENT_ID,
              reply: "Conflicting reply.",
              reply_sources: [],
              suggested_user_action: "review"
            }
          ]
        })
      ),
    /already has an associated response/
  );
  assert.equal(digestProjectTree(mixed.copy.projectRoot).digest, completedDigest);

  await proveVersionBoundary();
  await proveSafeRelocationAfterOutstandingEdit();
  await proveUnsafeOutstandingEditFailsClosed();
  await proveCancellationBeforeProviderResponse();
  await proveAutomatedV3FailuresAreAtomic();

  process.stdout.write(
    `${JSON.stringify(
      {
        assertions: "complete",
        cancellation_atomic: true,
        default_agent_exchange_protocol_version: 3,
        deterministic_mixed_counts: {
          comments_added: mixedImport.comments_created,
          patches_proposed: mixedImport.patch_proposals_stored,
          replies_imported: mixedImport.replies_attached,
          warnings: mixedImport.warnings.length
        },
        historical_v2_preserved: true,
        local_ref_to_native_id: true,
        outstanding_edit_relocation: "safe_or_fail_closed",
        replay_and_conflict_atomic: true,
        shared_importer: true,
        status: "ok"
      },
      null,
      2
    )}\n`
  );
} finally {
  for (const copy of copies.reverse()) {
    copy.cleanup();
    assert.equal(existsSync(copy.temporaryRoot), false);
  }
}

async function proveVersionBoundary() {
  const historical = await createScenario("historical-v2", 2);
  assert.equal(historical.prepared.expected_response_protocol_version, 2);
  const missingStoredVersion = await prepareAgentExchange({
    batch: { ...historical.batch, response_protocol_version: undefined },
    project: historical.project
  });
  assert.equal(missingStoredVersion.expected_response_protocol_version, 2);

  const historicalImport = await executeResponse(
    historical,
    createV2Response(historical)
  );
  assert.equal(historicalImport.replies_attached, 1);

  const v3Mismatch = await createScenario("v3-rejects-v2", 3);
  const v3Before = digestProjectTree(v3Mismatch.copy.projectRoot).digest;
  await assert.rejects(
    () => executeResponse(v3Mismatch, createV2Response(v3Mismatch)),
    /Expected protocol_version 3/
  );
  assert.equal(digestProjectTree(v3Mismatch.copy.projectRoot).digest, v3Before);

  const v2Mismatch = await createScenario("v2-rejects-v3", 2);
  const v2Before = digestProjectTree(v2Mismatch.copy.projectRoot).digest;
  await assert.rejects(
    () => executeResponse(v2Mismatch, createV3Response(v2Mismatch)),
    /Expected protocol_version 2/
  );
  assert.equal(digestProjectTree(v2Mismatch.copy.projectRoot).digest, v2Before);
}

async function proveSafeRelocationAfterOutstandingEdit() {
  const scenario = await createScenario("safe-relocation", 3);
  const connector = createConnector(
    createV3Response(scenario, {
      new_comments: [
        externalComment(scenario, "relocated-comment", {
          kind: "selected_text",
          selected_text: "Backup route is stable.",
          containing_heading: "Risks",
          containing_heading_level: 2,
          containing_heading_path: ["Launch Plan", "Risks"],
          anchor_source: "markdown"
        })
      ]
    }),
    "delayed"
  );
  const operation = beginImportOperation(scenario, connector);
  const completion = operation.execute();
  await connector.waitForSubmission();
  scenario.currentMarkdown = `Preface added while the agent was working.\n\n${SNAPSHOT_MARKDOWN}`;
  await saveProjectState({
    markdown: scenario.currentMarkdown,
    project: scenario.project,
    reason: "agent_exchange_v3_safe_outstanding_edit"
  });
  connector.resolveDelayed();
  const imported = await completion;
  assert.equal(imported.comments_created, 1);
  assert.equal(imported.comments[1].anchor.kind, "selected_text");
  assert.equal(
    imported.comments[1].anchor.markdown_start_offset,
    scenario.currentMarkdown.indexOf("Backup route is stable.")
  );
  assert.equal(scenario.project.persistence.documentText, scenario.currentMarkdown);
}

async function proveUnsafeOutstandingEditFailsClosed() {
  const scenario = await createScenario("unsafe-edit", 3);
  const connector = createConnector(
    createV3Response(scenario, {
      new_comments: [
        externalComment(scenario, "missing-after-edit", {
          kind: "selected_text",
          selected_text: "Backup route is stable.",
          containing_heading: "Risks",
          containing_heading_level: 2,
          containing_heading_path: ["Launch Plan", "Risks"],
          anchor_source: "markdown"
        })
      ]
    }),
    "delayed"
  );
  const operation = beginImportOperation(scenario, connector);
  const completion = operation.execute();
  await connector.waitForSubmission();
  scenario.currentMarkdown = SNAPSHOT_MARKDOWN.replace(
    "Backup route is stable.",
    "The route was removed from this revision."
  );
  await saveProjectState({
    markdown: scenario.currentMarkdown,
    project: scenario.project,
    reason: "agent_exchange_v3_unsafe_outstanding_edit"
  });
  const beforeResponse = digestProjectTree(scenario.copy.projectRoot).digest;
  connector.resolveDelayed();
  await assert.rejects(completion, /unresolved|selected_text_not_found/i);
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, beforeResponse);
  assert.equal((await readProjectComments(scenario.project)).length, 1);
  assert.deepEqual(await readProjectPatches(scenario.project), []);
}

async function proveCancellationBeforeProviderResponse() {
  const scenario = await createScenario("cancel", 3);
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  const connector = createConnector(createV3Response(scenario), "delayed", false);
  const operation = beginImportOperation(scenario, connector);
  const completion = operation.execute();
  await connector.waitForSubmission();
  operation.cancel();
  connector.resolveDelayed();
  await assert.rejects(
    completion,
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_cancelled"
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveAutomatedV3FailuresAreAtomic() {
  const failures = [
    {
      name: "malformed-new-comments",
      build: (scenario) => createV3Response(scenario, { new_comments: [{}] })
    },
    {
      name: "duplicate-local-ref",
      build: (scenario) =>
        createV3Response(scenario, {
          new_comments: [
            externalComment(scenario, "duplicate", { kind: "document" }),
            externalComment(scenario, "duplicate", { kind: "document" })
          ]
        })
    },
    {
      name: "unknown-response-comment-target",
      build: (scenario) =>
        createV3Response(scenario, {
          patch_proposals: [
            externalPatch(
              "unknown-target",
              { kind: "response_comment", local_ref: "missing-comment" },
              "launch window",
              "launch period"
            )
          ]
        })
    },
    {
      name: "wrong-document",
      build: (scenario) =>
        createV3Response(scenario, { document_id: "doc_wrong_target" })
    },
    {
      name: "ambiguous-anchor",
      markdown: `${SNAPSHOT_MARKDOWN}\nBackup route is stable.\n`,
      build: (scenario) =>
        createV3Response(scenario, {
          new_comments: [
            externalComment(scenario, "ambiguous", {
              kind: "selected_text",
              selected_text: "Backup route is stable.",
              anchor_source: "markdown"
            })
          ]
        })
    },
    {
      name: "unresolved-anchor",
      build: (scenario) =>
        createV3Response(scenario, {
          new_comments: [
            externalComment(scenario, "unresolved", {
              kind: "selected_text",
              selected_text: "Text absent from the exact snapshot.",
              anchor_source: "markdown"
            })
          ]
        })
    }
  ];

  for (const failure of failures) {
    const scenario = await createScenario(
      failure.name,
      3,
      failure.markdown ?? SNAPSHOT_MARKDOWN
    );
    const before = digestProjectTree(scenario.copy.projectRoot).digest;
    await assert.rejects(() => executeResponse(scenario, failure.build(scenario)));
    assert.equal(
      digestProjectTree(scenario.copy.projectRoot).digest,
      before,
      `${failure.name} must not persist partial response state`
    );
    assert.equal((await readProjectComments(scenario.project)).length, 1);
    assert.deepEqual(await readProjectPatches(scenario.project), []);
  }
}

async function createScenario(name, responseProtocolVersion, markdown = SNAPSHOT_MARKDOWN) {
  const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.multiDocumentCore);
  copies.push(copy);
  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(copy.projectRoot)
  );
  const identity = getProjectDocumentIdentity(loaded.project);
  const existingComment = {
    id: EXISTING_COMMENT_ID,
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment:
      responseProtocolVersion === 3
        ? "Read this document, add separate comments where useful, reply here, and propose a concrete patch."
        : "Historical protocol-v2 reply request.",
    thread: [],
    export_state: { focus_state: "in_focus" },
    created_at: "2044-01-01T00:00:00.000Z",
    updated_at: "2044-01-01T00:00:00.000Z"
  };
  await saveProjectState({
    comments: [existingComment],
    markdown,
    patches: [],
    reviewBatches: [],
    project: loaded.project,
    reason: `agent_exchange_v3_fixture:${name}`
  });
  const batchId = `review_batch_ae4_${String(++scenarioSequence).padStart(3, "0")}`;
  const exported = await createTrackedReviewBatchExport({
    algorithmVersion: null,
    batchId,
    batchType: "manual",
    buildPrompt: (envelope) => {
      const exportPayload = {
        protocol: "patchmark.comment_export",
        protocol_version: 1,
        review_batch: envelope,
        document_snapshot: {
          document_id: identity.documentId,
          markdown
        },
        document_structure: [
          {
            heading: "Launch Plan",
            heading_level: 1,
            heading_line: 1,
            heading_path: ["Launch Plan"]
          },
          {
            heading: "Risks",
            heading_level: 2,
            heading_line: 5,
            heading_path: ["Launch Plan", "Risks"]
          },
          {
            heading: "Timeline",
            heading_level: 2,
            heading_line: 9,
            heading_path: ["Launch Plan", "Timeline"]
          }
        ],
        comments: [
          {
            comment_id: EXISTING_COMMENT_ID,
            anchor: { kind: "document" },
            comment: existingComment.comment,
            thread: []
          }
        ]
      };
      const jsonText = `${JSON.stringify(exportPayload, null, 2)}\n`;
      return {
        jsonText,
        promptText:
          responseProtocolVersion === 3
            ? createExternalParticipantV3Prompt({
                dedicatedDocumentInstruction: true,
                jsonText,
                observedAt: "2044-01-02",
                reviewBatchEnvelope: envelope
              })
            : `# Historical Patchmark v2 request\n\n\`\`\`json\n${jsonText}\`\`\`\n`
      };
    },
    comments: [existingComment],
    documentGeneration: loaded.project.persistence.generation,
    documentTitle: `Agent Exchange v3 ${name}`,
    markdown,
    now: `2044-01-${String(scenarioSequence + 2).padStart(2, "0")}T00:00:00.000Z`,
    overLimitWarning: false,
    patches: [],
    project: loaded.project,
    responseProtocolVersion,
    section: null,
    source: "manual"
  });
  const prepared = await prepareAgentExchange({
    batch: exported.batch,
    maxResponseBytes: 64 * 1024,
    project: loaded.project
  });
  return {
    batch: exported.batch,
    copy,
    currentMarkdown: markdown,
    identity,
    prepared,
    project: loaded.project,
    promptText: exported.promptText
  };
}

function executeResponse(scenario, response) {
  const connector = createConnector(response);
  return beginImportOperation(scenario, connector).execute();
}

function createConnector(response, mode = "immediate", respectCancellation = true) {
  const connector = new QualificationAgentExchangeConnector();
  connector.configure({
    mode,
    respectCancellation,
    responseBytes: encoder.encode(JSON.stringify(response))
  });
  return connector;
}

function beginImportOperation(scenario, connector) {
  return new AgentExchangeOperationController().begin({
    connector,
    createOperationId: () =>
      `agent_exchange_v3_${String(++operationSequence).padStart(4, "0")}`,
    importResponse: async ({ binding, response_bytes, validate_before_commit }) => {
      const comments = await readProjectComments(scenario.project);
      const reviewBatches = await listReviewBatches(scenario.project);
      return importProjectCommentReplyResponseBytes({
        comments,
        expectedProtocolVersion: binding.expected_response_protocol_version,
        importedAt: `2045-01-${String(operationSequence).padStart(2, "0")}T00:00:00.000Z`,
        importId: `PM-IMPORT-AE4-${String(operationSequence).padStart(4, "0")}`,
        knownCommentIds: new Set(comments.map((comment) => comment.id)),
        markdown: scenario.project.persistence.documentText,
        project: scenario.project,
        responseBytes: response_bytes,
        reviewBatches,
        validateBeforeCommit: validate_before_commit
      });
    },
    prepared: scenario.prepared
  });
}

function createV3Response(scenario, overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 3,
    review_batch_id: scenario.batch.batch_id,
    project_id: scenario.identity.projectId,
    document_id: scenario.identity.documentId,
    summary: "Deterministic automated v3 response.",
    new_comments: [],
    replies: [],
    patch_proposals: [],
    open_questions: [],
    ...overrides
  };
}

function createV2Response(scenario) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 2,
    review_batch_id: scenario.batch.batch_id,
    project_id: scenario.identity.projectId,
    document_id: scenario.identity.documentId,
    summary: "Historical automated v2 response.",
    replies: [
      {
        comment_id: EXISTING_COMMENT_ID,
        reply: "Historical v2 response remains accepted for its stored batch.",
        reply_sources: [],
        suggested_user_action: "review"
      }
    ],
    patch_proposals: [],
    open_questions: []
  };
}

function externalComment(scenario, localRef, anchor) {
  return {
    local_ref: localRef,
    document_id: scenario.identity.documentId,
    type: "note",
    anchor,
    comment: `Automated external comment ${localRef}.`
  };
}

function externalPatch(
  patchKey,
  commentTarget,
  originalText,
  suggestedText,
  overrides = {}
) {
  return {
    patch_key: patchKey,
    depends_on: [],
    comment_target: commentTarget,
    original_text: originalText,
    suggested_text: suggestedText,
    suggested_text_sources: [],
    reason: `Deterministic reason for ${patchKey}.`,
    reason_sources: [],
    risk: "Minimal wording change.",
    risk_sources: [],
    ...overrides
  };
}

function reopenScenario(scenario) {
  return openProjectFolderHandle(new NodeDirectoryHandle(scenario.copy.projectRoot));
}

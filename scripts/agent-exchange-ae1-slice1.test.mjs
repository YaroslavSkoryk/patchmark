import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  AgentExchangeOperationController,
  AgentExchangeOperationError
} from "../lib/agent-exchange/operation-controller.ts";
import {
  copyPreparedExchangeForManualDelivery,
  prepareAgentExchange
} from "../lib/agent-exchange/prepared-exchange.ts";
import {
  importProjectCommentReplyResponse,
  importProjectCommentReplyResponseBytes
} from "../lib/imports/project-comment-reply-import.ts";
import { resolveAndApplyPendingPatch } from "../lib/patches/patch-application.ts";
import {
  getProjectDocumentIdentity,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import {
  createTrackedReviewBatchExport,
  readExactReviewBatchPrompt
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
const decoder = new TextDecoder();
const copies = [];
let operationSequence = 0;
const COMMENT_ID = "PM-COMMENT-AE-0001";
const IMPORTED_AT = "2040-03-01T00:00:00.000Z";
const IMPORT_ID = "PM-IMPORT-AE-0001";
const FIRST_ORIGINAL =
  "Synthetic operators calibrate imaginary lantern arrays before each rehearsal.";
const FIRST_SUGGESTED =
  "Synthetic operators carefully calibrate imaginary lantern arrays before each rehearsal.";
const SECOND_ORIGINAL = "before each rehearsal.";
const SECOND_SUGGESTED = "before every rehearsal.";

try {
  const automated = await createScenario("automated");
  const manual = await createScenario("manual");
  const automatedBytes = automated.manualBytes;
  assert.deepEqual(automatedBytes, manual.manualBytes);
  assert.deepEqual(automated.prepared.copy_request_bytes(), automatedBytes);
  assert.deepEqual(
    copyPreparedExchangeForManualDelivery(automated.prepared),
    automatedBytes
  );
  assert.equal(
    automated.prepared.request_byte_length,
    automatedBytes.byteLength
  );
  assert.match(automated.prepared.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(automated.prepared.authority, "none");

  const responseBytes = createResponseBytes(automated);
  const connector = new QualificationAgentExchangeConnector();
  connector.configure({
    mode: "delayed",
    responseBytes,
    respectCancellation: false
  });
  const controller = new AgentExchangeOperationController();
  const operation = beginImportOperation(controller, automated, connector);
  const firstExecution = operation.execute();
  const duplicateExecution = operation.execute();
  assert.strictEqual(firstExecution, duplicateExecution);
  await connector.waitForSubmission();
  const connectorReceived = connector.copySubmittedRequest();
  assert.deepEqual(connectorReceived, automatedBytes);
  connector.mutateOwnedSubmittedRequest((bytes) => {
    bytes[0] = bytes[0] ^ 0xff;
  });
  assert.deepEqual(automated.prepared.copy_request_bytes(), automatedBytes);
  assert.deepEqual(operation.copy_manual_fallback_bytes(), automatedBytes);
  connector.resolveDelayed();
  const automatedImport = await firstExecution;
  assert.equal(connector.submissionCount(), 1);
  assert.equal(connector.closedCount(), 1);
  assert.equal(operation.phase(), "completed");
  assert.equal(automatedImport.replies_attached, 1);
  assert.equal(automatedImport.patch_proposals_stored, 2);
  assert.equal(
    await readProjectMarkdown(automated),
    automated.originalMarkdown,
    "automated ingestion must not change Markdown"
  );

  const manualImport = await importProjectCommentReplyResponse({
    comments: await readProjectComments(manual.project),
    expectedProtocolVersion: 2,
    importedAt: IMPORTED_AT,
    importId: IMPORT_ID,
    knownCommentIds: new Set([COMMENT_ID]),
    markdown: manual.originalMarkdown,
    project: manual.project,
    responseText: decoder.decode(createResponseBytes(manual)),
    reviewBatches: await listReviewBatches(manual.project)
  });
  assert.deepEqual(
    projectSemanticState(automated, automatedImport),
    projectSemanticState(manual, manualImport),
    "manual and automated delivery must converge"
  );

  const duplicateDigest = digestProjectTree(automated.copy.projectRoot).digest;
  await assert.rejects(
    async () =>
      importProjectCommentReplyResponseBytes({
        comments: await readProjectComments(automated.project),
        expectedProtocolVersion: 2,
        importedAt: "2040-03-02T00:00:00.000Z",
        importId: "PM-IMPORT-DUPLICATE",
        knownCommentIds: new Set([COMMENT_ID]),
        markdown: automated.originalMarkdown,
        project: automated.project,
        responseBytes,
        reviewBatches: await listReviewBatches(automated.project)
      }),
    /already has an associated response/
  );
  assert.equal(
    digestProjectTree(automated.copy.projectRoot).digest,
    duplicateDigest
  );
  const conflictingBytes = createResponseBytes(automated, {
    reply: "A conflicting alternative reply."
  });
  await assert.rejects(
    async () =>
      importProjectCommentReplyResponseBytes({
        comments: await readProjectComments(automated.project),
        expectedProtocolVersion: 2,
        importedAt: "2040-03-02T00:01:00.000Z",
        importId: "PM-IMPORT-CONFLICT",
        knownCommentIds: new Set([COMMENT_ID]),
        markdown: automated.originalMarkdown,
        project: automated.project,
        responseBytes: conflictingBytes,
        reviewBatches: await listReviewBatches(automated.project)
      }),
    /already has an associated response/
  );
  assert.equal(
    digestProjectTree(automated.copy.projectRoot).digest,
    duplicateDigest
  );

  await proveExplicitPatchAuthority(automated);
  await proveFailureAndFallback();
  await proveConnectorInstanceIsolation();
  await proveCancellationAndLateResponse();
  await proveCommitTimeOwnershipRollback();
  await proveProjectSwitchIsolation();
  await proveStaleOperationRejection();
  await proveInvalidResponses();

  process.stdout.write(
    `${JSON.stringify(
      {
        assertions: "complete",
        automated_manual_convergence: true,
        cancellation_late_response_rejected: true,
        commit_time_ownership_rollback: true,
        connector_instance_operation_local: true,
        connector_request_copy_isolated: true,
        exact_request_bytes: automatedBytes.byteLength,
        hostile_responses_atomic: true,
        markdown_changed_only_after_acceptance: true,
        project_switch_isolated: true,
        qualification_connector_network_requests: 0,
        stale_operation_rejected: true,
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

async function createScenario(
  name,
  batchId = "review_batch_ae1_equivalent"
) {
  const copy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.multiDocumentCore);
  copies.push(copy);
  const loaded = await openProjectFolderHandle(
    new NodeDirectoryHandle(copy.projectRoot)
  );
  const identity = getProjectDocumentIdentity(loaded.project);
  assert.deepEqual(identity, {
    documentId: "doc_operations",
    projectId: "prj_fixture_constellation"
  });
  const comment = {
    id: COMMENT_ID,
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: "Improve the two operation phrases independently.",
    thread: [],
    export_state: { focus_state: "in_focus" },
    created_at: "2040-02-01T00:00:00.000Z",
    updated_at: "2040-02-01T00:00:00.000Z"
  };
  await saveProjectState({
    comments: [comment],
    project: loaded.project,
    reason: `agent_exchange_fixture:${name}`
  });
  const comments = await readProjectComments(loaded.project);
  const patches = await readProjectPatches(loaded.project);
  const exported = await createTrackedReviewBatchExport({
    algorithmVersion: null,
    batchId,
    batchType: "manual",
    buildPrompt: (envelope) => {
      const artifact = {
        protocol: "patchmark.comment_export",
        protocol_version: 1,
        review_batch: envelope,
        project: identity,
        comments: comments.map(({ id, comment: text }) => ({
          comment: text,
          comment_id: id
        }))
      };
      const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
      return {
        jsonText,
        promptText: `# Patchmark Focused Comments Review\n\n\`\`\`json\n${jsonText}\`\`\`\n`
      };
    },
    comments,
    documentGeneration: loaded.project.persistence.generation,
    documentTitle: "Orbital Garden Operations",
    markdown: loaded.markdown,
    now: "2040-02-02T00:00:00.000Z",
    overLimitWarning: false,
    patches,
    project: loaded.project,
    section: null,
    source: "manual"
  });
  const manualPrompt = await readExactReviewBatchPrompt({
    batch: exported.batch,
    project: loaded.project
  });
  assert.equal(manualPrompt, exported.promptText);
  const prepared = await prepareAgentExchange({
    batch: exported.batch,
    maxResponseBytes: 16 * 1024,
    project: loaded.project
  });
  return {
    batch: exported.batch,
    copy,
    manualBytes: encoder.encode(exported.promptText),
    originalMarkdown: loaded.markdown,
    prepared,
    project: loaded.project
  };
}

function createResponseBytes(scenario, overrides = {}) {
  return encoder.encode(
    JSON.stringify({
      protocol: overrides.protocol ?? "patchmark.comment_reply_import",
      protocol_version: overrides.protocolVersion ?? 2,
      review_batch_id:
        overrides.reviewBatchId ?? scenario.batch.batch_id,
      project_id: overrides.projectId ?? scenario.batch.project_id,
      document_id: overrides.documentId ?? scenario.batch.document_id,
      summary: "Deterministic Agent Exchange qualification response.",
      replies: [
        {
          comment_id: COMMENT_ID,
          reply: overrides.reply ?? "The two requested improvements are proposed separately.",
          reply_sources: [],
          suggested_user_action: "review"
        }
      ],
      patch_proposals: [
        {
          patch_key: "careful-calibration",
          depends_on: [],
          comment_id: COMMENT_ID,
          original_text: FIRST_ORIGINAL,
          suggested_text: FIRST_SUGGESTED,
          suggested_text_sources: [],
          reason: "Clarifies the care taken during calibration.",
          reason_sources: [],
          risk: "Minimal wording change.",
          risk_sources: []
        },
        {
          patch_key: "every-rehearsal",
          depends_on: [],
          comment_id: COMMENT_ID,
          original_text: SECOND_ORIGINAL,
          suggested_text: SECOND_SUGGESTED,
          suggested_text_sources: [],
          reason: "Uses more direct frequency wording.",
          reason_sources: [],
          risk: "Minimal wording change.",
          risk_sources: []
        }
      ],
      open_questions: []
    })
  );
}

function beginImportOperation(controller, scenario, connector) {
  return controller.begin({
    connector,
    createOperationId: () =>
      `agent_exchange_operation_${String(++operationSequence).padStart(4, "0")}`,
    importResponse: async ({ binding, response_bytes, validate_before_commit }) =>
      importProjectCommentReplyResponseBytes({
        comments: await readProjectComments(scenario.project),
        expectedProtocolVersion:
          binding.expected_response_protocol_version,
        importedAt: IMPORTED_AT,
        importId: IMPORT_ID,
        knownCommentIds: new Set([COMMENT_ID]),
        markdown: scenario.originalMarkdown,
        project: scenario.project,
        responseBytes: response_bytes,
        reviewBatches: await listReviewBatches(scenario.project),
        validateBeforeCommit: validate_before_commit
      }),
    prepared: scenario.prepared
  });
}

function projectSemanticState(scenario, imported) {
  return {
    comments: imported.comments,
    markdown: scenario.originalMarkdown,
    patches: imported.patches,
    review_batches: imported.review_batches
  };
}

async function proveExplicitPatchAuthority(scenario) {
  const comments = await readProjectComments(scenario.project);
  let patches = await readProjectPatches(scenario.project);
  const firstPatch = patches.find(
    (patch) => patch.source_patch_key === "careful-calibration"
  );
  const secondPatch = patches.find(
    (patch) => patch.source_patch_key === "every-rehearsal"
  );
  assert.ok(firstPatch && secondPatch);
  const resolution = resolveAndApplyPendingPatch({
    comments,
    documentId: scenario.batch.document_id,
    markdown: scenario.originalMarkdown,
    patch: firstPatch,
    patches
  });
  assert.equal(resolution.kind, "applied");
  patches = patches.map((patch) =>
    patch.id === firstPatch.id
      ? {
          ...patch,
          status: "accepted",
          accepted_at: "2040-03-03T00:00:00.000Z",
          applied_at: "2040-03-03T00:00:00.000Z",
          resolved_at: "2040-03-03T00:00:00.000Z"
        }
      : patch.id === secondPatch.id
        ? {
            ...patch,
            status: "rejected",
            rejected_at: "2040-03-03T00:01:00.000Z",
            resolved_at: "2040-03-03T00:01:00.000Z"
          }
        : patch
  );
  await saveProjectState({
    markdown: resolution.markdown,
    patches,
    project: scenario.project,
    reason: "agent_exchange_explicit_patch_authority"
  });
  assert.match(await readProjectMarkdown(scenario), /carefully calibrate/);
  assert.match(await readProjectMarkdown(scenario), /before each rehearsal/);
  assert.doesNotMatch(await readProjectMarkdown(scenario), /before every rehearsal/);
  const reopened = await openProjectFolderHandle(
    new NodeDirectoryHandle(scenario.copy.projectRoot)
  );
  assert.match(reopened.markdown, /carefully calibrate/);
  const reopenedPatches = await readProjectPatches(reopened.project);
  assert.equal(
    reopenedPatches.find((patch) => patch.id === firstPatch.id)?.status,
    "accepted"
  );
  assert.equal(
    reopenedPatches.find((patch) => patch.id === secondPatch.id)?.status,
    "rejected"
  );
}

async function proveFailureAndFallback() {
  const scenario = await createScenario("failure");
  const failed = new QualificationAgentExchangeConnector();
  failed.configure({ mode: "throw" });
  const operation = beginImportOperation(
    new AgentExchangeOperationController(),
    scenario,
    failed
  );
  await assert.rejects(
    operation.execute(),
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "connector_failed"
  );
  assert.deepEqual(operation.copy_manual_fallback_bytes(), scenario.manualBytes);

  const unavailable = new QualificationAgentExchangeConnector();
  unavailable.configure({
    availability: {
      status: "unavailable",
      reason: "connector_not_ready"
    }
  });
  const unavailableOperation = beginImportOperation(
    new AgentExchangeOperationController(),
    scenario,
    unavailable
  );
  await assert.rejects(
    unavailableOperation.execute(),
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "connector_unavailable"
  );
  assert.equal(unavailable.submissionCount(), 0);
  assert.deepEqual(
    unavailableOperation.copy_manual_fallback_bytes(),
    scenario.manualBytes
  );
}

async function proveConnectorInstanceIsolation() {
  const scenario = await createScenario("connector-instance-isolation");
  const controller = new AgentExchangeOperationController();
  const connector = new QualificationAgentExchangeConnector();
  const operation = beginImportOperation(controller, scenario, connector);
  assert.throws(
    () => beginImportOperation(controller, scenario, connector),
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "connector_instance_reused"
  );
  operation.cancel();
  await assert.rejects(
    operation.execute(),
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_cancelled"
  );
}

async function proveCancellationAndLateResponse() {
  const scenario = await createScenario("cancellation");
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  const connector = new QualificationAgentExchangeConnector();
  connector.configure({
    mode: "delayed",
    responseBytes: createResponseBytes(scenario),
    respectCancellation: false
  });
  const operation = beginImportOperation(
    new AgentExchangeOperationController(),
    scenario,
    connector
  );
  const completion = operation.execute();
  await connector.waitForSubmission();
  operation.cancel();
  assert.deepEqual(operation.copy_manual_fallback_bytes(), scenario.manualBytes);
  connector.resolveDelayed();
  await assert.rejects(
    completion,
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_cancelled"
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveCommitTimeOwnershipRollback() {
  const scenario = await createScenario("commit-time-ownership");
  const before = digestProjectTree(scenario.copy.projectRoot);
  const connector = new QualificationAgentExchangeConnector();
  connector.configure({ responseBytes: createResponseBytes(scenario) });
  const controller = new AgentExchangeOperationController();
  let ownershipChecks = 0;
  const operation = controller.begin({
    connector,
    createOperationId: () =>
      `agent_exchange_operation_${String(++operationSequence).padStart(4, "0")}`,
    importResponse: async ({
      binding,
      response_bytes,
      validate_before_commit
    }) =>
      importProjectCommentReplyResponseBytes({
        comments: await readProjectComments(scenario.project),
        expectedProtocolVersion: binding.expected_response_protocol_version,
        importedAt: IMPORTED_AT,
        importId: IMPORT_ID,
        knownCommentIds: new Set([COMMENT_ID]),
        markdown: scenario.originalMarkdown,
        project: scenario.project,
        responseBytes: response_bytes,
        reviewBatches: await listReviewBatches(scenario.project),
        validateBeforeCommit: () => {
          ownershipChecks += 1;
          if (ownershipChecks === 4) controller.invalidateCurrent();
          validate_before_commit();
        }
      }),
    prepared: scenario.prepared
  });
  await assert.rejects(
    operation.execute(),
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_invalidated"
  );
  assert.equal(ownershipChecks, 4);
  assert.deepEqual(
    digestProjectTree(scenario.copy.projectRoot).entries,
    before.entries
  );
}

async function proveProjectSwitchIsolation() {
  const projectA = await createScenario("project-a");
  const projectBCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(projectBCopy);
  const projectB = await openProjectFolderHandle(
    new NodeDirectoryHandle(projectBCopy.projectRoot)
  );
  const beforeA = digestProjectTree(projectA.copy.projectRoot).digest;
  const beforeB = digestProjectTree(projectBCopy.projectRoot).digest;
  const connector = new QualificationAgentExchangeConnector();
  connector.configure({
    mode: "delayed",
    responseBytes: createResponseBytes(projectA),
    respectCancellation: false
  });
  const controller = new AgentExchangeOperationController();
  const operation = beginImportOperation(controller, projectA, connector);
  const completion = operation.execute();
  await connector.waitForSubmission();
  controller.invalidateForProjectChange(
    getProjectDocumentIdentity(projectB.project).projectId
  );
  connector.resolveDelayed();
  await assert.rejects(
    completion,
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_invalidated"
  );
  assert.equal(digestProjectTree(projectA.copy.projectRoot).digest, beforeA);
  assert.equal(digestProjectTree(projectBCopy.projectRoot).digest, beforeB);
}

async function proveStaleOperationRejection() {
  const scenario = await createScenario("stale-operation");
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  const oldConnector = new QualificationAgentExchangeConnector();
  oldConnector.configure({
    mode: "delayed",
    responseBytes: createResponseBytes(scenario),
    respectCancellation: false
  });
  const controller = new AgentExchangeOperationController();
  const oldOperation = beginImportOperation(controller, scenario, oldConnector);
  const oldCompletion = oldOperation.execute();
  await oldConnector.waitForSubmission();

  const newerConnector = new QualificationAgentExchangeConnector();
  newerConnector.configure({
    availability: {
      status: "unavailable",
      reason: "connector_not_ready"
    }
  });
  const newerOperation = beginImportOperation(
    controller,
    scenario,
    newerConnector
  );
  await assert.rejects(newerOperation.execute(), /connector is unavailable/i);
  oldConnector.resolveDelayed();
  await assert.rejects(
    oldCompletion,
    (error) =>
      error instanceof AgentExchangeOperationError &&
      error.code === "operation_invalidated"
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveInvalidResponses() {
  const scenario = await createScenario("invalid-responses");
  const substitute = await createScenario(
    "substitute-response",
    "review_batch_ae1_substitute"
  );
  const valid = createResponseBytes(scenario);
  const initialDigest = digestProjectTree(scenario.copy.projectRoot).digest;
  const cases = [
    { name: "malformed", bytes: encoder.encode("{") },
    {
      name: "wrong portable protocol",
      bytes: createResponseBytes(scenario, { protocol: "patchmark.other" })
    },
    {
      name: "wrong portable version",
      bytes: createResponseBytes(scenario, { protocolVersion: 1 })
    },
    {
      name: "wrong portable project",
      bytes: createResponseBytes(scenario, { projectId: "wrong-project" })
    },
    {
      name: "wrong portable document",
      bytes: createResponseBytes(scenario, { documentId: "wrong-document" })
    },
    {
      name: "wrong portable batch",
      bytes: createResponseBytes(scenario, { reviewBatchId: "review_batch_wrong" })
    },
    {
      name: "appended invalid response",
      bytes: encoder.encode(`${decoder.decode(valid)}\ntrailing-data`)
    },
    {
      name: "substituted prepared exchange",
      bytes: createResponseBytes(substitute)
    },
    {
      name: "wrong operation binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, operation_id: "wrong-operation" })
    },
    {
      name: "wrong connector binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, connector_id: "wrong-connector" })
    },
    {
      name: "wrong request digest binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, request_sha256: "0".repeat(64) })
    },
    {
      name: "wrong request length binding",
      bytes: valid,
      transform: (binding) => ({
        ...binding,
        request_byte_length: binding.request_byte_length + 1
      })
    },
    {
      name: "wrong project binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, project_id: "wrong-project" })
    },
    {
      name: "wrong document binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, document_id: "wrong-document" })
    },
    {
      name: "wrong batch binding",
      bytes: valid,
      transform: (binding) => ({
        ...binding,
        review_batch_id: "review_batch_wrong"
      })
    },
    {
      name: "wrong response type binding",
      bytes: valid,
      transform: (binding) => ({
        ...binding,
        response_protocol: "patchmark.other"
      })
    },
    {
      name: "wrong response version binding",
      bytes: valid,
      transform: (binding) => ({ ...binding, response_protocol_version: 1 })
    },
    {
      name: "truncated length binding",
      bytes: valid,
      transform: (binding) => ({
        ...binding,
        response_byte_length: binding.response_byte_length + 1
      })
    },
    {
      name: "oversized response",
      bytes: new Uint8Array(scenario.prepared.max_response_bytes + 1)
    }
  ];

  for (const invalidCase of cases) {
    const connector = new QualificationAgentExchangeConnector();
    connector.configure({
      mode: "immediate",
      responseBindingTransform: invalidCase.transform,
      responseBytes: invalidCase.bytes
    });
    const operation = beginImportOperation(
      new AgentExchangeOperationController(),
      scenario,
      connector
    );
    await assert.rejects(operation.execute(), undefined, invalidCase.name);
    assert.equal(
      digestProjectTree(scenario.copy.projectRoot).digest,
      initialDigest,
      `${invalidCase.name} must leave authoritative state unchanged`
    );
  }
}

async function readProjectMarkdown(scenario) {
  const reopened = await openProjectFolderHandle(
    new NodeDirectoryHandle(scenario.copy.projectRoot)
  );
  return reopened.markdown;
}

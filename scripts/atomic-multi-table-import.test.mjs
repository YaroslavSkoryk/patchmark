import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolveCanonicalPatchTarget } from "../lib/comments/canonical-target-resolution.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import { findMarkdownTables } from "../lib/markdown/markdown-tables.ts";
import {
  ATOMIC_TABLE_IMPORT_ERROR,
  AtomicTablePatchValidationError,
  createAtomicTableRepairPrompt,
  inspectAtomicTablePatchImport,
  validateAtomicTablePatchImport
} from "../lib/patches/atomic-table-patches.ts";
import {
  getPatchDependencyClosureOrder,
  validateImportedPatchDependencySimulation
} from "../lib/patches/patch-dependencies.ts";
import { createRespondedReviewBatchRecords } from "../lib/review-batches/review-batch-progression.ts";
import { analyzeImportedReviewBatchResponse } from "../lib/review-batches/review-response-analysis.ts";
import {
  ATOMIC_MULTI_TABLE_RESPONSE_BYTES,
  ATOMIC_MULTI_TABLE_RESPONSE_PATH,
  ATOMIC_MULTI_TABLE_RESPONSE_SHA256,
  createAtomicMultiTableComment,
  createAtomicMultiTableMarkdown,
  readAtomicMultiTableResponseFixture
} from "./lib/atomic-multi-table-import-fixture.mjs";

const parseStartedAt = performance.now();
const { raw } = readAtomicMultiTableResponseFixture();
const response = parsePatchmarkCommentReplyImport(raw);
const parseDurationMs = performance.now() - parseStartedAt;
const proposal = response.patch_proposals[0];
const markdown = createAtomicMultiTableMarkdown(response);
const comment = createAtomicMultiTableComment(response, markdown);
const originalTables = findMarkdownTables(proposal.original_text);
const suggestedTables = findMarkdownTables(proposal.suggested_text);
const inspectionStartedAt = performance.now();
const diagnostics = inspectAtomicTablePatchImport({
  markdown,
  patchProposals: response.patch_proposals
});
const inspectionDurationMs = performance.now() - inspectionStartedAt;
const validationStartedAt = performance.now();
validateAtomicTablePatchImport({
  markdown,
  patchProposals: response.patch_proposals
});
const validationDurationMs = performance.now() - validationStartedAt;

assert.equal(
  readFileSync(ATOMIC_MULTI_TABLE_RESPONSE_PATH, "utf8"),
  `${raw}\n`
);
assert.equal(Buffer.byteLength(raw), ATOMIC_MULTI_TABLE_RESPONSE_BYTES);
assert.equal(response.protocol_version, 2);
assert.equal(response.patch_proposals.length, 1);
assert.equal(proposal.patch_key, "restructure-growth-scenarios-and-stages");
assert.deepEqual(proposal.depends_on, []);
assert.deepEqual(
  getPatchDependencyClosureOrder(response, proposal.patch_key),
  []
);
assert.equal(originalTables.length, 2);
assert.equal(suggestedTables.length, 3);
assert.ok(originalTables.every((table) => table.isWellFormed));
assert.ok(suggestedTables.every((table) => table.isWellFormed));
assert.equal(diagnostics.proposalCount, 1);
assert.deepEqual(diagnostics.proposals, [
  {
    directDependencies: [],
    exactMatchCount: 1,
    originalTableBlockCount: 2,
    patchKey: "restructure-growth-scenarios-and-stages",
    proposalIndex: 0,
    suggestedTableBlockCount: 3
  }
]);
assert.equal(diagnostics.structuralGroups.length, 2);
assert.ok(
  diagnostics.structuralGroups.every(
    (group) =>
      group.proposalIndexes.length === 1 &&
      group.proposalIndexes[0] === 0 &&
      group.structuralProposalIndexes.length === 1 &&
      group.incompleteStructuralProposalIndexes.length === 0
  )
);

const importedAt = "2026-07-31T12:30:00.000Z";
const importId = "PM-IMPORT-ATOMIC-MULTI-TABLE";
const importedPatch = {
  id: "PM-PATCH-0001",
  status: "pending",
  patch_group_id: "PM-PATCH-GROUP-0001",
  patch_group_index: 1,
  patch_group_total: 1,
  comment_id: proposal.comment_id,
  source_import_id: importId,
  source_patch_key: proposal.patch_key,
  depends_on_patch_ids: [],
  depends_on_patch_keys_snapshot: [],
  display_title: proposal.display_title,
  target_heading: proposal.target_heading,
  original_text: proposal.original_text,
  suggested_text: proposal.suggested_text,
  suggested_text_sources: proposal.suggested_text_sources,
  reason: proposal.reason,
  reason_sources: proposal.reason_sources,
  risk: proposal.risk,
  risk_sources: proposal.risk_sources,
  created_at: importedAt
};
const target = resolveCanonicalPatchTarget({
  comments: [comment],
  markdown,
  patch: importedPatch,
  patches: [importedPatch]
});
assert.equal(target.state, "resolved");
assert.equal(target.cardinality, "unique");
assert.equal(
  markdown.slice(target.range.start, target.range.end),
  proposal.original_text
);
const orders = validateImportedPatchDependencySimulation({
  baseDocumentState: "current",
  comments: [comment],
  existingPatches: [],
  importedPatches: [importedPatch],
  markdown
});
assert.deepEqual(orders.get(importedPatch.id), [importedPatch.id]);
assert.equal(importedPatch.status, "pending");

const respondedComment = {
  ...comment,
  thread: [
    {
      id: "PM-THREAD-0001",
      role: "chatgpt",
      content: response.replies[0].reply,
      created_at: importedAt,
      source_import_id: importId,
      suggested_user_action: response.replies[0].suggested_user_action,
      sources: response.replies[0].reply_sources
    }
  ]
};
const batch = createBatch(response, comment, markdown);
const responseAnalysis = analyzeImportedReviewBatchResponse({
  analyzedAt: importedAt,
  batch,
  comments: [respondedComment],
  importId,
  patches: [importedPatch]
});
const respondedBatch = createRespondedReviewBatchRecords({
  analysis: responseAnalysis,
  batchId: batch.batch_id,
  batches: [batch],
  importId,
  responseReceivedAt: importedAt
})[0];
assert.equal(responseAnalysis.coverage_status, "complete");
assert.deepEqual(responseAnalysis.aggregate, {
  expected_comments: 1,
  addressed_comments: 1,
  unanswered_comments: 0,
  replies_added: 1,
  patch_proposals_added: 1,
  clarification_questions: 0,
  explicit_no_change_responses: 0
});
assert.equal(respondedBatch.status, "responded");
assert.equal(respondedBatch.response_analysis.aggregate.patch_proposals_added, 1);
assert.equal(importedPatch.status, "pending");

const firstTable = [
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "| 3 | 4 |"
].join("\n");
const splitRows = [
  syntheticProposal({
    patch_key: "split-header",
    original_text: "| A | B |",
    suggested_text: "| A | B | C |"
  }),
  syntheticProposal({
    patch_key: "split-body",
    original_text: "| 1 | 2 |",
    suggested_text: "| 1 | 2 | 3 |"
  })
];
const splitRowsError = expectAtomicError(
  "split_structural_change_across_proposals",
  () =>
    validateAtomicTablePatchImport({
      markdown: firstTable,
      patchProposals: splitRows
    })
);
assert.match(splitRowsError.message, new RegExp(escapeRegExp(ATOMIC_TABLE_IMPORT_ERROR)));
assert.deepEqual(splitRowsError.patchKeys, ["split-header", "split-body"]);
assert.equal(splitRowsError.conflictingProposalCount, 2);
assert.match(createAtomicTableRepairPrompt(splitRowsError), /split-header/);

expectAtomicError("split_structural_change_across_proposals", () =>
  validateAtomicTablePatchImport({
    markdown: firstTable,
    patchProposals: [
      syntheticProposal({
        patch_key: "complete-table",
        original_text: firstTable,
        suggested_text: [
          "| A | B | C |",
          "| --- | --- | --- |",
          "| 1 | 2 |  |",
          "| 3 | 4 |  |"
        ].join("\n")
      }),
      syntheticProposal({
        patch_key: "row-edit",
        original_text: "| 1 | 2 |",
        suggested_text: "| 1 | two |"
      })
    ]
  })
);

const secondTable = ["| C | D |", "| --- | --- |", "| 5 | 6 |"].join("\n");
assert.doesNotThrow(() =>
  validateAtomicTablePatchImport({
    markdown: `## First\n\n${firstTable}\n\n## Second\n\n${secondTable}`,
    patchProposals: [
      syntheticProposal({
        patch_key: "first-independent",
        original_text: firstTable,
        suggested_text: [
          "| A | B | C |",
          "| --- | --- | --- |",
          "| 1 | 2 | 3 |",
          "| 3 | 4 | 5 |"
        ].join("\n")
      }),
      syntheticProposal({
        patch_key: "second-independent",
        original_text: secondTable,
        suggested_text: [
          "| C | D | E |",
          "| --- | --- | --- |",
          "| 5 | 6 | 7 |"
        ].join("\n")
      })
    ]
  })
);

expectAtomicError("incomplete_structural_region", () =>
  validateAtomicTablePatchImport({
    markdown: firstTable,
    patchProposals: [
      syntheticProposal({
        patch_key: "partial-boundary",
        original_text: "| A | B |",
        suggested_text: "| A | B | C |"
      })
    ]
  })
);

expectAtomicError("malformed_structural_markdown", () =>
  validateAtomicTablePatchImport({
    markdown: firstTable,
    patchProposals: [
      syntheticProposal({
        patch_key: "malformed-replacement",
        original_text: firstTable,
        suggested_text: [
          "| A | B |",
          "| --- | --- |",
          "| 1 | 2 | 3 |"
        ].join("\n")
      })
    ]
  })
);

const internalInvariant = new AtomicTablePatchValidationError({
  code: "single_proposal_split_invariant",
  message: "Patchmark internal structural validator invariant.",
  patchKeys: [proposal.patch_key],
  repairPromptEligible: false
});
assert.equal(createAtomicTableRepairPrompt(internalInvariant), "");

const conflictInspectionStartedAt = performance.now();
const conflictDiagnostics = inspectAtomicTablePatchImport({
  markdown: firstTable,
  patchProposals: splitRows
});
const conflictInspectionDurationMs = performance.now() - conflictInspectionStartedAt;
assert.equal(conflictDiagnostics.structuralGroups.length, 1);
assert.deepEqual(conflictDiagnostics.structuralGroups[0].proposalIndexes, [0, 1]);

console.log(
  JSON.stringify(
    {
      exactResponseBytes: Buffer.byteLength(raw),
      exactResponseSha256: ATOMIC_MULTI_TABLE_RESPONSE_SHA256,
      originalTableBlockCount: originalTables.length,
      suggestedTableBlockCount: suggestedTables.length,
      proposalCount: response.patch_proposals.length,
      dependencyClosure: [],
      structuralRegions: diagnostics.structuralGroups.map((group) => group.regionId),
      negativeScenarios: {
        completeTablePlusRow: "rejected",
        independentTables: "accepted",
        malformedReplacement: "rejected",
        partialBoundary: "rejected",
        splitRows: "rejected"
      },
      responseAnalysis: responseAnalysis.aggregate,
      reviewBatchStatus: respondedBatch.status,
      noAutomaticAcceptance: importedPatch.status === "pending",
      performanceMs: {
        conflictGrouping: round(conflictInspectionDurationMs),
        structuralInspection: round(inspectionDurationMs),
        protocolParsing: round(parseDurationMs),
        totalStructuralValidation: round(validationDurationMs)
      }
    },
    null,
    2
  )
);

function syntheticProposal(overrides) {
  return {
    patch_key: "synthetic",
    depends_on: [],
    comment_id: "PM-COMMENT-0001",
    original_text: "Original.",
    suggested_text: "Suggested.",
    reason: "Structural test.",
    reason_sources: [],
    risk: "Low risk.",
    risk_sources: [],
    suggested_text_sources: [],
    ...overrides
  };
}

function expectAtomicError(code, action) {
  let caught;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AtomicTablePatchValidationError);
  assert.equal(caught.code, code);
  return caught;
}

function createBatch(exactResponse, exactComment, exactMarkdown) {
  return {
    schema_version: 1,
    batch_id: exactResponse.review_batch_id,
    project_id: exactResponse.project_id,
    document_id: exactResponse.document_id,
    source: "guided_review",
    batch_type: "section",
    ordered_comment_ids: [exactComment.id],
    section: {
      section_key_snapshot: "heading:10-growth-path-and-scenarios",
      heading_snapshot: "10. Growth Path and Scenarios"
    },
    algorithm_version: 1,
    prompt_builder_version: 1,
    document_generation: 7,
    batch_record_generation: 8,
    document_content_sha256: "fixture",
    document_snapshot: {
      relative_path: ".patchmark/context-packs/atomic-exported-document.md",
      content_sha256: "fixture",
      bytes: Buffer.byteLength(exactMarkdown)
    },
    comment_fingerprints: [],
    estimated_prompt_tokens: 10,
    over_limit_warning: false,
    prompt_sha256: "fixture",
    context_pack: {
      relative_path: ".patchmark/context-packs/atomic-response.md",
      content_sha256: "fixture",
      bytes: 7
    },
    document_title_snapshot: "Growth strategy",
    status: "exported",
    created_at: "2026-07-31T12:29:20.000Z",
    exported_at: "2026-07-31T12:29:20.000Z",
    response_received_at: null,
    acknowledged_at: null,
    cancelled_at: null,
    cancel_reason: null,
    import_id: null,
    response_analysis: null
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round(value) {
  return Number(value.toFixed(3));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolveCanonicalPatchTarget } from "../lib/comments/canonical-target-resolution.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  PatchDependencyValidationError,
  createPatchDependencyRepairPrompt,
  getPatchDependencyClosureOrder,
  validateImportedPatchDependencySimulation
} from "../lib/patches/patch-dependencies.ts";
import {
  INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES,
  INDEPENDENT_PROTOCOL_V2_RESPONSE_PATH,
  INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256,
  createIndependentProtocolV2Comments,
  createIndependentProtocolV2ImportedPatches,
  createIndependentProtocolV2Markdown,
  readIndependentProtocolV2ResponseFixture
} from "./lib/independent-protocol-v2-import-fixture.mjs";

const { raw: exactRaw } = readIndependentProtocolV2ResponseFixture();
const storedFixture = readFileSync(
  INDEPENDENT_PROTOCOL_V2_RESPONSE_PATH,
  "utf8"
);
const exactResponse = parsePatchmarkCommentReplyImport(exactRaw);
const markdown = createIndependentProtocolV2Markdown(exactResponse);
const comments = createIndependentProtocolV2Comments(exactResponse, markdown);
const patches = createIndependentProtocolV2ImportedPatches(exactResponse);
const baseFingerprint = sha256(markdown);

assert.equal(Buffer.byteLength(exactRaw), INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES);
assert.equal(sha256(exactRaw), INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256);
assert.equal(storedFixture, `${exactRaw}\n`);
assert.equal(exactResponse.protocol_version, 2);
assert.equal(exactResponse.patch_proposals.length, 4);
assert.equal(new Set(patches.map((patch) => patch.source_patch_key)).size, 4);
assert.ok(
  exactResponse.patch_proposals.every(
    (proposal) =>
      Array.isArray(proposal.depends_on) && proposal.depends_on.length === 0
  )
);

const exactDiagnostics = patches.map((patch) => {
  const proposal = getProposal(exactResponse, patch.source_patch_key);
  const directDependencies = [...proposal.depends_on];
  const closure = getPatchDependencyClosureOrder(
    exactResponse,
    proposal.patch_key
  );
  const resolution = resolveCanonicalPatchTarget({
    comments,
    markdown,
    patch,
    patches: [patch]
  });

  assert.deepEqual(closure, []);
  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.cardinality, "unique");
  assert.ok(resolution.range);

  return {
    patchKey: proposal.patch_key,
    directDependencies,
    dependencyClosure: closure,
    documentFingerprint: baseFingerprint,
    documentState: "exported_base",
    patchesSimulatedBefore: [],
    target: {
      cardinality: resolution.cardinality,
      end: resolution.range.end,
      method: resolution.method,
      section: proposal.target_heading,
      start: resolution.range.start,
      state: resolution.state
    }
  };
});
const exactOrders = validateImportedPatchDependencySimulation({
  baseDocumentState: "current",
  comments,
  existingPatches: [],
  importedPatches: patches,
  markdown
});

for (const patch of patches) {
  assert.deepEqual(exactOrders.get(patch.id), [patch.id]);
  assert.equal(patch.status, "pending");
}

const formulaPatch = getPatch(patches, "explain-unit-economics-formulas");
const formulaDiagnostic = exactDiagnostics.find(
  (entry) => entry.patchKey === formulaPatch.source_patch_key
);
assert.ok(formulaDiagnostic);
assert.deepEqual(formulaDiagnostic.directDependencies, []);
assert.deepEqual(formulaDiagnostic.dependencyClosure, []);
assert.deepEqual(formulaDiagnostic.patchesSimulatedBefore, []);
assert.equal(formulaDiagnostic.target.cardinality, "unique");
assert.equal(formulaDiagnostic.target.state, "resolved");
assert.equal(
  exactOrders.get(formulaPatch.id)?.some((patchId) =>
    [
      getPatch(patches, "clarify-additional-utility-cost").id,
      getPatch(patches, "clarify-crust-chant-funded-promotions").id
    ].includes(patchId)
  ),
  false
);
assert.equal(
  getPatch(patches, "use-wholesale-bread-transfer-price").status,
  "pending"
);

const staleMarkdown = markdown.replace(
  "Let:\n\n* `R`",
  "Use these definitions:\n\n* `R`"
);
const staleError = expectDependencyError(
  "current_document_patch_target_missing",
  () =>
    validateImportedPatchDependencySimulation({
      baseDocumentState: "changed",
      comments,
      existingPatches: [],
      importedPatches: patches,
      markdown: staleMarkdown
    })
);
assert.equal(staleError.patchKey, "explain-unit-economics-formulas");
assert.match(staleError.message, /current saved document/);
assert.match(staleError.message, /changed after the prompt was exported/);
assert.doesNotMatch(staleError.message, /prerequisite/i);
assert.equal(createPatchDependencyRepairPrompt(staleError), "");

const dependencyRemoval = createSyntheticFixture({
  markdown: "## Changes\n\nShared target.\n",
  proposals: [
    syntheticProposal({
      patch_key: "remove-target",
      original_text: "Shared target.",
      suggested_text: ""
    }),
    syntheticProposal({
      patch_key: "dependent-target",
      depends_on: ["remove-target"],
      original_text: "Shared target.",
      suggested_text: "Dependent replacement."
    })
  ]
});
const dependencyRemovalError = expectDependencyError(
  "dependent_patch_stale_after_prerequisites",
  () => validateSyntheticFixture(dependencyRemoval)
);
assert.equal(dependencyRemovalError.patchKey, "dependent-target");
assert.equal(dependencyRemovalError.dependencyKey, "remove-target");
assert.match(
  dependencyRemovalError.message,
  /declared prerequisite remove-target changed its target/
);

const independentShift = createSyntheticFixture({
  markdown: "## Changes\n\nEarlier target.\n\nLater target.\n",
  proposals: [
    syntheticProposal({
      patch_key: "large-independent",
      original_text: "Earlier target.",
      suggested_text: `Earlier target.\n\n${"Long independent insertion. ".repeat(500)}`
    }),
    syntheticProposal({
      patch_key: "later-independent",
      original_text: "Later target.",
      suggested_text: "Later replacement."
    })
  ]
});
const independentShiftOrders = validateSyntheticFixture(independentShift);
assert.deepEqual(
  independentShiftOrders.get(
    getPatch(independentShift.patches, "later-independent").id
  ),
  [getPatch(independentShift.patches, "later-independent").id]
);

const dependentShift = createSyntheticFixture({
  markdown: "## Changes\n\nInsert before.\n\nShifted target.\n",
  proposals: [
    syntheticProposal({
      patch_key: "insert-before",
      original_text: "Insert before.",
      suggested_text: `Insert before.\n\n${"New prerequisite text. ".repeat(300)}`
    }),
    syntheticProposal({
      patch_key: "shifted-dependent",
      depends_on: ["insert-before"],
      original_text: "Shifted target.",
      suggested_text: "Shifted replacement."
    })
  ]
});
const dependentShiftOrders = validateSyntheticFixture(dependentShift);
assert.deepEqual(
  getOrderKeys(
    dependentShift.patches,
    dependentShiftOrders,
    "shifted-dependent"
  ),
  ["insert-before", "shifted-dependent"]
);

const ambiguous = createSyntheticFixture({
  markdown: "## Changes\n\nRepeated target.\n\nRepeated target.\n",
  proposals: [
    syntheticProposal({
      patch_key: "ambiguous-independent",
      original_text: "Repeated target.",
      suggested_text: "Replacement."
    })
  ]
});
const ambiguityError = expectDependencyError(
  "exported_document_patch_target_ambiguous",
  () => validateSyntheticFixture(ambiguous)
);
assert.match(ambiguityError.message, /target is ambiguous/);
assert.doesNotMatch(ambiguityError.message, /prerequisite/i);
assert.match(
  createPatchDependencyRepairPrompt(ambiguityError),
  /exported_document_patch_target_ambiguous/
);

const internalError = new PatchDependencyValidationError({
  code: "independent_patch_simulation_invariant",
  message:
    "Patchmark mutated an independent sibling simulation. The response itself was not the cause.",
  patchKey: "independent",
  repairPromptEligible: false
});
assert.equal(createPatchDependencyRepairPrompt(internalError), "");

const stress = createStressFixture();
const stressStartedAt = performance.now();
const stressOrders = validateSyntheticFixture(stress);
const stressDurationMs = performance.now() - stressStartedAt;
const independentStressPatches = stress.patches.slice(0, 40);
const dependencyStressPatches = stress.patches.slice(40);

assert.ok(
  independentStressPatches.every(
    (patch) =>
      stressOrders.get(patch.id)?.length === 1 &&
      stressOrders.get(patch.id)?.[0] === patch.id
  )
);
assert.deepEqual(
  getOrderKeys(
    stress.patches,
    stressOrders,
    dependencyStressPatches.at(-1).source_patch_key
  ),
  dependencyStressPatches.map((patch) => patch.source_patch_key)
);

console.log(
  JSON.stringify(
    {
      exactDiagnostics,
      exactResponseBytes: Buffer.byteLength(exactRaw),
      exactResponseSha256: sha256(exactRaw),
      formula: {
        baseDocumentTargetResult: formulaDiagnostic.target,
        computedDependencyClosure: formulaDiagnostic.dependencyClosure,
        declaredDependencies: formulaDiagnostic.directDependencies,
        patchesAppliedBeforeValidation:
          formulaDiagnostic.patchesSimulatedBefore,
        simulatedDocumentTargetResult: formulaDiagnostic.target
      },
      negativeVariants: {
        ambiguousTarget: ambiguityError.code,
        currentDocumentStale: staleError.code,
        dependentTargetRemoved: dependencyRemovalError.code,
        dependentTargetShifted: "passed",
        independentSiblingLengthShift: "passed"
      },
      noAutomaticAcceptance: patches.every(
        (patch) => patch.status === "pending"
      ),
      stress: {
        dependencyNodes: dependencyStressPatches.length,
        durationMs: Number(stressDurationMs.toFixed(2)),
        independentNodes: independentStressPatches.length,
        totalNodes: stress.patches.length
      }
    },
    null,
    2
  )
);

function createSyntheticFixture({ markdown, proposals }) {
  const response = parsePatchmarkCommentReplyImport(
    JSON.stringify({
      protocol: "patchmark.comment_reply_import",
      protocol_version: 2,
      project_id: "prj_independent_synthetic",
      document_id: "doc_independent_synthetic",
      summary: "Synthetic dependency simulation.",
      replies: [],
      patch_proposals: proposals,
      open_questions: []
    })
  );
  const idByKey = new Map(
    response.patch_proposals.map((proposal, index) => [
      proposal.patch_key,
      `PM-PATCH-SYNTHETIC-${String(index + 1).padStart(4, "0")}`
    ])
  );
  const patches = response.patch_proposals.map((proposal, index) => ({
    id: `PM-PATCH-SYNTHETIC-${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    comment_id: "PM-COMMENT-SYNTHETIC",
    source_import_id: "PM-IMPORT-SYNTHETIC",
    source_patch_key: proposal.patch_key,
    depends_on_patch_ids: proposal.depends_on.map((key) => idByKey.get(key)),
    depends_on_patch_keys_snapshot: [...proposal.depends_on],
    display_title: proposal.display_title,
    target_heading: proposal.target_heading,
    original_text: proposal.original_text,
    suggested_text: proposal.suggested_text,
    suggested_text_sources: proposal.suggested_text_sources,
    reason: proposal.reason,
    reason_sources: proposal.reason_sources,
    risk: proposal.risk,
    risk_sources: proposal.risk_sources,
    created_at: "2026-07-24T00:00:00.000Z"
  }));

  return {
    comments: [
      {
        id: "PM-COMMENT-SYNTHETIC",
        type: "note",
        status: "open",
        anchor: { kind: "document" },
        comment: "Review synthetic patches.",
        thread: [],
        export_state: { focus_state: "awaiting_reply" },
        created_at: "2026-07-24T00:00:00.000Z",
        updated_at: "2026-07-24T00:00:00.000Z"
      }
    ],
    markdown,
    patches,
    response
  };
}

function validateSyntheticFixture(fixture) {
  return validateImportedPatchDependencySimulation({
    baseDocumentState: "current",
    comments: fixture.comments,
    existingPatches: [],
    importedPatches: fixture.patches,
    markdown: fixture.markdown
  });
}

function syntheticProposal(overrides) {
  return {
    patch_key: "synthetic",
    depends_on: [],
    comment_id: "PM-COMMENT-SYNTHETIC",
    display_title: "Synthetic patch",
    target_heading: "## Changes",
    original_text: "Original.",
    suggested_text: "Suggested.",
    suggested_text_sources: [],
    reason: "Exercises dependency simulation.",
    reason_sources: [],
    risk: "Low risk.",
    risk_sources: [],
    ...overrides
  };
}

function createStressFixture() {
  const independentLines = Array.from(
    { length: 40 },
    (_, index) => `Independent target ${index + 1}.`
  );
  const dependencyLines = Array.from(
    { length: 6 },
    (_, index) => `Dependency target ${index + 1}.`
  );
  const proposals = [
    ...independentLines.map((line, index) =>
      syntheticProposal({
        patch_key: `independent-${String(index + 1).padStart(2, "0")}`,
        original_text: line,
        suggested_text: `${line}\n\n${"Long replacement. ".repeat(index + 20)}`
      })
    ),
    ...dependencyLines.map((line, index) =>
      syntheticProposal({
        patch_key: `dependency-${index + 1}`,
        depends_on: index === 0 ? [] : [`dependency-${index}`],
        original_text: line,
        suggested_text: `${line} Applied.`
      })
    )
  ];

  return createSyntheticFixture({
    markdown: `## Changes\n\n${[
      ...independentLines,
      ...dependencyLines
    ].join("\n\n")}\n`,
    proposals
  });
}

function expectDependencyError(code, operation) {
  try {
    operation();
  } catch (error) {
    assert.equal(error instanceof PatchDependencyValidationError, true);
    assert.equal(error.code, code);
    return error;
  }

  assert.fail(`Expected dependency error ${code}.`);
}

function getOrderKeys(allPatches, orders, patchKey) {
  const patch = getPatch(allPatches, patchKey);
  const byId = new Map(allPatches.map((candidate) => [candidate.id, candidate]));

  return (orders.get(patch.id) ?? []).map(
    (patchId) => byId.get(patchId)?.source_patch_key
  );
}

function getPatch(allPatches, patchKey) {
  const patch = allPatches.find(
    (candidate) => candidate.source_patch_key === patchKey
  );
  assert.ok(patch, `Missing patch ${patchKey}.`);
  return patch;
}

function getProposal(response, patchKey) {
  const proposal = response.patch_proposals.find(
    (candidate) => candidate.patch_key === patchKey
  );
  assert.ok(proposal, `Missing proposal ${patchKey}.`);
  return proposal;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

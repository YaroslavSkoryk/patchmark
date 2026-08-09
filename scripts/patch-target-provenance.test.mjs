import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import { resolveAndApplyPendingPatch } from "../lib/patches/patch-application.ts";
import { validateAtomicTablePatchImport } from "../lib/patches/atomic-table-patches.ts";
import {
  PatchDependencyValidationError,
  createPatchDependencyRepairPrompt,
  getPatchDependencyClosureOrder,
  validateImportedPatchDependencySimulation
} from "../lib/patches/patch-dependencies.ts";
import { resolvePendingPatchTarget } from "../lib/patches/linked-patch-target-resolution.ts";
import {
  preflightPatchBaseTarget,
  transformPendingPatchTargetProvenances
} from "../lib/patches/patch-target-provenance.ts";

const fixtureUrl = new URL(
  "./fixtures/dependency-induced-target-duplication.json",
  import.meta.url
);
const fixtureRaw = readFileSync(fixtureUrl, "utf8");
assert.equal(Buffer.byteLength(fixtureRaw), 5759);
assert.equal(
  createHash("sha256").update(fixtureRaw).digest("hex"),
  "27df71fdeb69fbe9d67a7e75a9d093243978a766a499be1fcc9351418e1e8a6f"
);
const response = parsePatchmarkCommentReplyImport(fixtureRaw);
const documentId = response.document_id;
const baseDocumentSha256 = createHash("sha256")
  .update(createBaseMarkdown(response))
  .digest("hex");
const comment = {
  id: "PM-COMMENT-0086",
  type: "note",
  status: "open",
  anchor: { kind: "document" },
  comment: "Keep the main sensitivity view concise without losing detail.",
  thread: [],
  export_state: { focus_state: "awaiting_reply" },
  created_at: "2026-08-06T00:00:00.000Z",
  updated_at: "2026-08-06T00:00:00.000Z"
};

assert.equal(response.review_batch_id, "review_batch_9a637b1d-0b08-48cf-8698-9318621ebe1f");
assert.equal(response.project_id, "prj_0b86549a-56aa-4f37-8f4e-68cba8c958a3");
assert.equal(documentId, "doc_2909a2c8-c4da-4cd0-8a03-f58387444ce6");
assert.deepEqual(
  getPatchDependencyClosureOrder(response, "present-essential-sensitivity-indicators"),
  ["add-complete-sensitivity-appendix"]
);

const baseMarkdown = createBaseMarkdown(response);
validateAtomicTablePatchImport({
  markdown: baseMarkdown,
  patchProposals: response.patch_proposals
});
const patches = createPatches(response);
const prerequisite = getPatch(patches, "add-complete-sensitivity-appendix");
const dependent = getPatch(patches, "present-essential-sensitivity-indicators");
const baseMatchCount = countMatches(baseMarkdown, dependent.original_text);
const baseHeadingMatchCount = countMatches(baseMarkdown, "### Scenario indicators");
assert.equal(baseMatchCount, 1);
assert.equal(baseHeadingMatchCount, 1);

const basePreflightStartedAt = performance.now();
const directBasePreflight = preflightPatchBaseTarget({
  baseDocumentSha256,
  documentId,
  markdown: baseMarkdown,
  patch: dependent
});
const basePreflightDurationMs = performance.now() - basePreflightStartedAt;
assert.equal(directBasePreflight.kind, "resolved");

const validationStartedAt = performance.now();
const orders = validateImportedPatchDependencySimulation({
  baseDocumentSha256,
  baseDocumentState: "current",
  comments: [comment],
  documentId,
  existingPatches: [],
  importedPatches: patches,
  markdown: baseMarkdown
});
const validationDurationMs = performance.now() - validationStartedAt;
assert.deepEqual(orders.get(dependent.id), [prerequisite.id, dependent.id]);
assert.ok(dependent.target_provenance);
assert.deepEqual(dependent.target_provenance.heading_ancestry, [
  "# Strategy",
  "## 10. Growth Path and Scenarios",
  "### Scenario indicators"
]);

const prerequisiteSimulationStartedAt = performance.now();
const prerequisiteApplication = resolveAndApplyPendingPatch({
  comments: [comment],
  documentId,
  markdown: baseMarkdown,
  patch: prerequisite,
  patches
});
const prerequisiteSimulationDurationMs =
  performance.now() - prerequisiteSimulationStartedAt;
assert.equal(prerequisiteApplication.kind, "applied");
const postPrerequisiteMarkdown = prerequisiteApplication.markdown;
const postPrerequisiteMatchCount = countMatches(
  postPrerequisiteMarkdown,
  dependent.original_text
);
const postPrerequisiteHeadingMatchCount = countMatches(
  postPrerequisiteMarkdown,
  "### Scenario indicators"
);
assert.equal(postPrerequisiteMatchCount, 2);
assert.equal(postPrerequisiteHeadingMatchCount, 2);

const rangeTransformationStartedAt = performance.now();
const afterPrerequisitePatches = transformPendingPatchTargetProvenances({
  edits: [
    {
      oldStart: prerequisiteApplication.start,
      oldEnd: prerequisiteApplication.start + prerequisite.original_text.length,
      insertedText: prerequisite.suggested_text
    }
  ],
  patches: patches.map((patch) =>
    patch.id === prerequisite.id ? { ...patch, status: "accepted" } : patch
  )
});
const rangeTransformationDurationMs =
  performance.now() - rangeTransformationStartedAt;
const mappedDependent = getPatch(
  afterPrerequisitePatches,
  "present-essential-sensitivity-indicators"
);
const finalValidationStartedAt = performance.now();
const mappedResolution = resolvePendingPatchTarget({
  comments: [comment],
  documentId,
  markdown: postPrerequisiteMarkdown,
  patch: mappedDependent,
  patches: afterPrerequisitePatches
});
const finalValidationDurationMs = performance.now() - finalValidationStartedAt;
assert.equal(mappedResolution.applicability, "exact_match");
assert.equal(mappedResolution.method, "base_target_provenance");
assert.equal(
  postPrerequisiteMarkdown.slice(
    mappedResolution.matches[0].start,
    mappedResolution.matches[0].end
  ),
  mappedDependent.original_text
);
assert.ok(
  mappedResolution.matches[0].start <
    postPrerequisiteMarkdown.indexOf("## Appendix A. Complete Channel-Mix Sensitivity")
);
const manuallyRewrittenMarkdown = `${postPrerequisiteMarkdown.slice(
  0,
  mappedResolution.matches[0].start
)}### Manually rewritten scenario indicators\n\nThe original main table was removed.${postPrerequisiteMarkdown.slice(
  mappedResolution.matches[0].end
)}`;
assert.equal(
  resolvePendingPatchTarget({
    comments: [comment],
    documentId,
    markdown: manuallyRewrittenMarkdown,
    patch: mappedDependent,
    patches: afterPrerequisitePatches
  }).applicability,
  "not_found"
);

const dependentApplication = resolveAndApplyPendingPatch({
  comments: [comment],
  documentId,
  markdown: postPrerequisiteMarkdown,
  patch: mappedDependent,
  patches: afterPrerequisitePatches
});
assert.equal(dependentApplication.kind, "applied");
assert.ok(dependentApplication.markdown.includes("### Essential scenario indicators"));
assert.ok(dependentApplication.markdown.includes("## Appendix A. Complete Channel-Mix Sensitivity"));
assert.equal(countMatches(dependentApplication.markdown, dependent.original_text), 1);
assert.ok(
  dependentApplication.markdown.indexOf(dependent.original_text) >
    dependentApplication.markdown.indexOf("## Appendix A. Complete Channel-Mix Sensitivity")
);

assertCopyTwiceStillMapsOriginal();
assertInsertIdenticalTargetBeforeOriginal();
assertInsertBeforeAndAfterTransform();
assertDependencyCreatedTargets();
assertBaseAmbiguityFails();
assertOriginalDeletionFails();
assertWrongDocumentFails();

console.log(
  JSON.stringify(
    {
      fixtureBytes: Buffer.byteLength(fixtureRaw),
      fixtureSha256: createHash("sha256").update(fixtureRaw).digest("hex"),
      patchKeys: response.patch_proposals.map((proposal) => proposal.patch_key),
      dependencyClosure: [
        "add-complete-sensitivity-appendix",
        "present-essential-sensitivity-indicators"
      ],
      baseMatchCount,
      baseHeadingMatchCount,
      postPrerequisiteMatchCount,
      postPrerequisiteHeadingMatchCount,
      mappedMethod: mappedResolution.method,
      performanceMs: {
        basePreflight: Number(basePreflightDurationMs.toFixed(3)),
        dependencySimulation: Number(
          prerequisiteSimulationDurationMs.toFixed(3)
        ),
        rangeTransformation: Number(
          rangeTransformationDurationMs.toFixed(3)
        ),
        finalValidation: Number(finalValidationDurationMs.toFixed(3)),
        totalImportValidation: Number(validationDurationMs.toFixed(3))
      },
      noAutomaticAcceptance: patches.every((patch) => patch.status === "pending"),
      negativeCases: 5
    },
    null,
    2
  )
);

function assertCopyTwiceStillMapsOriginal() {
  const copyTwice = structuredClone(response);
  const prerequisiteProposal = getProposal(
    copyTwice,
    "add-complete-sensitivity-appendix"
  );
  prerequisiteProposal.suggested_text += `\n\n## Appendix B. Second Complete Copy\n\n${dependent.original_text}`;
  const copiedPatches = createPatches(copyTwice);
  validateImportedPatchDependencySimulation({
    baseDocumentSha256,
    comments: [comment],
    documentId,
    existingPatches: [],
    importedPatches: copiedPatches,
    markdown: baseMarkdown
  });
}

function assertInsertIdenticalTargetBeforeOriginal() {
  const responseVariant = structuredClone(response);
  const prerequisiteProposal = getProposal(
    responseVariant,
    "add-complete-sensitivity-appendix"
  );
  prerequisiteProposal.original_text = "Planning basis.";
  prerequisiteProposal.suggested_text = `Planning basis.\n\n${dependent.original_text}`;
  prerequisiteProposal.target_heading = "## 10. Growth Path and Scenarios";
  const variantPatches = createPatches(responseVariant);
  validateImportedPatchDependencySimulation({
    baseDocumentSha256,
    comments: [comment],
    documentId,
    existingPatches: [],
    importedPatches: variantPatches,
    markdown: baseMarkdown
  });
}

function assertInsertBeforeAndAfterTransform() {
  for (const location of ["before", "after"]) {
    const target = "Unrelated prerequisite marker.";
    const markdown =
      location === "before"
        ? `${target}\n\n${baseMarkdown}`
        : `${baseMarkdown}\n\n${target}`;
    const responseVariant = structuredClone(response);
    const prerequisiteProposal = getProposal(
      responseVariant,
      "add-complete-sensitivity-appendix"
    );
    prerequisiteProposal.original_text = target;
    prerequisiteProposal.suggested_text = `${target}\n\nInserted prerequisite detail.`;
    prerequisiteProposal.target_heading = undefined;
    const variantPatches = createPatches(responseVariant);
    validateImportedPatchDependencySimulation({
      baseDocumentSha256: createHash("sha256").update(markdown).digest("hex"),
      comments: [comment],
      documentId,
      existingPatches: [],
      importedPatches: variantPatches,
      markdown
    });
  }
}

function assertDependencyCreatedTargets() {
  const marker = "Dependency-created target.";
  const createdResponse = structuredClone(response);
  const prerequisiteProposal = getProposal(
    createdResponse,
    "add-complete-sensitivity-appendix"
  );
  prerequisiteProposal.suggested_text += `\n\n${marker}`;
  const dependentProposal = getProposal(
    createdResponse,
    "present-essential-sensitivity-indicators"
  );
  dependentProposal.original_text = marker;
  dependentProposal.suggested_text = "Dependency-created target updated.";
  dependentProposal.target_heading = undefined;
  validateImportedPatchDependencySimulation({
    baseDocumentSha256,
    comments: [comment],
    documentId,
    existingPatches: [],
    importedPatches: createPatches(createdResponse),
    markdown: baseMarkdown
  });

  prerequisiteProposal.suggested_text += `\n\n${marker}`;
  expectDependencyError("dependency_target_genuine_ambiguity", () =>
    validateImportedPatchDependencySimulation({
      baseDocumentSha256,
      comments: [comment],
      documentId,
      existingPatches: [],
      importedPatches: createPatches(createdResponse),
      markdown: baseMarkdown
    })
  );
}

function assertBaseAmbiguityFails() {
  const duplicatedBase = `${baseMarkdown}\n\n## Duplicate Base\n\n${dependent.original_text}`;
  const error = expectDependencyError("dependency_target_genuine_ambiguity", () =>
    validateImportedPatchDependencySimulation({
      baseDocumentSha256: createHash("sha256").update(duplicatedBase).digest("hex"),
      comments: [comment],
      documentId,
      existingPatches: [],
      importedPatches: createPatches(response),
      markdown: duplicatedBase
    })
  );
  assert.equal(error.baseTargetUnique, false);
  assert.equal(error.baseMatchCount, 2);
  const repairPrompt = createPatchDependencyRepairPrompt(error);
  assert.match(repairPrompt, /present-essential-sensitivity-indicators/);
  assert.match(repairPrompt, /add-complete-sensitivity-appendix/);
  assert.match(repairPrompt, /Target heading: ### Scenario indicators/);
  assert.match(repairPrompt, /Base target match count: 2/);
  assert.match(
    repairPrompt,
    /scope the dependent patch to a unique owning parent heading/i
  );
  assert.doesNotMatch(repairPrompt, /Correct the `depends_on` graph/);
  assert.doesNotMatch(repairPrompt, /Sources or References/);
}

function assertOriginalDeletionFails() {
  const responseVariant = structuredClone(response);
  const prerequisiteProposal = getProposal(
    responseVariant,
    "add-complete-sensitivity-appendix"
  );
  prerequisiteProposal.original_text = dependent.original_text;
  prerequisiteProposal.suggested_text = `## Appendix A. Complete Channel-Mix Sensitivity\n\n${dependent.original_text}`;
  prerequisiteProposal.target_heading = "### Scenario indicators";
  expectDependencyError("dependent_patch_stale_after_prerequisites", () =>
    validateImportedPatchDependencySimulation({
      baseDocumentSha256,
      comments: [comment],
      documentId,
      existingPatches: [],
      importedPatches: createPatches(responseVariant),
      markdown: baseMarkdown
    })
  );
}

function assertWrongDocumentFails() {
  const resolution = resolvePendingPatchTarget({
    comments: [comment],
    documentId: "doc_other",
    markdown: baseMarkdown,
    patch: dependent,
    patches
  });
  assert.equal(resolution.applicability, "not_found");
  assert.equal(
    resolution.canonical.explanationCode,
    "base_target_provenance_document_mismatch"
  );
}

function createBaseMarkdown(parsedResponse) {
  const dependentProposal = getProposal(
    parsedResponse,
    "present-essential-sensitivity-indicators"
  );
  const prerequisiteProposal = getProposal(
    parsedResponse,
    "add-complete-sensitivity-appendix"
  );
  return `# Strategy\n\n## 10. Growth Path and Scenarios\n\nPlanning basis.\n\n${dependentProposal.original_text}\n\n### Stage gates informed by the scenarios\n\nStage-gate detail remains intact.\n\n${prerequisiteProposal.original_text}\n`;
}

function createPatches(parsedResponse) {
  const idByKey = new Map(
    parsedResponse.patch_proposals.map((proposal, index) => [
      proposal.patch_key,
      `PM-PATCH-${String(index + 1).padStart(4, "0")}`
    ])
  );
  return parsedResponse.patch_proposals.map((proposal, index) => ({
    id: `PM-PATCH-${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    comment_id: proposal.comment_id,
    source_import_id: "PM-IMPORT-PROVENANCE",
    source_patch_key: proposal.patch_key,
    depends_on_patch_ids: proposal.depends_on.map((patchKey) => idByKey.get(patchKey)),
    depends_on_patch_keys_snapshot: [...proposal.depends_on],
    display_title: proposal.display_title,
    target_heading: proposal.target_heading,
    original_text: proposal.original_text,
    suggested_text: proposal.suggested_text,
    reason: proposal.reason,
    risk: proposal.risk,
    created_at: "2026-08-06T00:00:00.000Z"
  }));
}

function getProposal(parsedResponse, patchKey) {
  const proposal = parsedResponse.patch_proposals.find(
    (candidate) => candidate.patch_key === patchKey
  );
  assert.ok(proposal, `Missing proposal ${patchKey}`);
  return proposal;
}

function getPatch(patchList, patchKey) {
  const patch = patchList.find((candidate) => candidate.source_patch_key === patchKey);
  assert.ok(patch, `Missing patch ${patchKey}`);
  return patch;
}

function countMatches(markdown, text) {
  return markdown.split(text).length - 1;
}

function expectDependencyError(code, operation) {
  try {
    operation();
  } catch (error) {
    assert.equal(error instanceof PatchDependencyValidationError, true);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected ${code}`);
}

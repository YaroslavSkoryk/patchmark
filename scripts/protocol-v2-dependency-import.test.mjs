import assert from "node:assert/strict";
import {
  parsePatchmarkCommentReplyImport
} from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  PatchDependencyValidationError,
  createPatchDependencyRepairPrompt,
  getPatchDependencyClosureOrder,
  getPatchDependencyReviewStatus,
  validateImportedPatchDependencySimulation,
  validatePatchDependencyGraph
} from "../lib/patches/patch-dependencies.ts";
import {
  createExactProtocolV2Markdown,
  readExactProtocolV2ResponseFixture
} from "./lib/protocol-v2-dependency-import-fixture.mjs";

const { parsed: exactResponseObject, raw: exactResponseRaw } =
  readExactProtocolV2ResponseFixture();
const markdown = createExactProtocolV2Markdown(exactResponseObject);
const comment = {
  id: "PM-COMMENT-0019",
  type: "note",
  status: "open",
  anchor: { kind: "document" },
  comment: "Move source information inline.",
  thread: [],
  export_state: { focus_state: "awaiting_reply" },
  created_at: "2026-07-24T00:00:00.000Z",
  updated_at: "2026-07-24T00:00:00.000Z"
};
const competitorPatchKeys = [
  "link-horme-evidence",
  "link-routine-evidence",
  "link-merak-evidence",
  "link-kaarom-evidence",
  "link-fix-evidence",
  "link-crumbs-evidence",
  "link-nana-evidence",
  "link-casa-lapin-evidence"
];
const analoguePatchKeys = [
  "link-holey-delivery-review",
  "link-sandwich-format-analogue"
];

const exactResponse = parsePatchmarkCommentReplyImport(exactResponseRaw);
validatePatchDependencyGraph(exactResponse);
assert.equal(exactResponse.protocol_version, 2);
assert.equal(exactResponse.patch_proposals.length, 18);
assert.equal(exactResponse.review_batch_id, exactResponseObject.review_batch_id);
assert.equal(exactResponse.project_id, exactResponseObject.project_id);
assert.equal(exactResponse.document_id, exactResponseObject.document_id);
assert.deepEqual(
  exactResponse.patch_proposals.map((proposal) => proposal.comment_id),
  Array(18).fill("PM-COMMENT-0019")
);

for (const patchKey of competitorPatchKeys) {
  assert.deepEqual(
    getProposal(exactResponse, patchKey).depends_on,
    ["competitor-observation-dates"]
  );
}
for (const patchKey of analoguePatchKeys) {
  assert.deepEqual(
    getProposal(exactResponse, patchKey).depends_on,
    ["analogue-observation-dates"]
  );
}

const exactPatches = createImportedPatches(exactResponse);
const exactOrders = validateImportedPatchDependencySimulation({
  comments: [comment],
  existingPatches: [],
  importedPatches: exactPatches,
  markdown
});
for (const patchKey of competitorPatchKeys) {
  assert.deepEqual(getOrderPatchKeys(exactPatches, exactOrders, patchKey), [
    "competitor-observation-dates",
    patchKey
  ]);
}
for (const patchKey of analoguePatchKeys) {
  assert.deepEqual(getOrderPatchKeys(exactPatches, exactOrders, patchKey), [
    "analogue-observation-dates",
    patchKey
  ]);
}
assert.deepEqual(
  getPatchDependencyClosureOrder(
    exactResponse,
    "remove-redundant-sources-section"
  ),
  exactResponse.patch_proposals
    .map((proposal) => proposal.patch_key)
    .filter((patchKey) => patchKey !== "remove-redundant-sources-section")
);
assert.equal(
  exactOrders.get(getPatch(exactPatches, "remove-redundant-sources-section").id)
    ?.length,
  18
);
assert.ok(exactPatches.every((patch) => patch.status === "pending"));
assert.ok(
  exactPatches.every(
    (patch) =>
      Array.isArray(patch.depends_on_patch_ids) &&
      Array.isArray(patch.depends_on_patch_keys_snapshot)
  )
);
assert.equal(
  getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: getPatch(exactPatches, "link-horme-evidence"),
    patches: exactPatches
  }).state,
  "blocked_by_pending_dependency"
);

{
  const missingDependency = cloneExactResponse();
  getProposal(missingDependency, "link-horme-evidence").depends_on = [];
  const error = expectDependencyError(
    "dependency_source_date_coverage_failed",
    () => parsePatchmarkCommentReplyImport(JSON.stringify(missingDependency))
  );

  assert.equal(error.patchKey, "link-horme-evidence");
  assert.equal(error.disclosurePrerequisiteStatus, "absent");
  assert.equal(error.observedAt, "2026-07-16");
  assert.match(error.sourceUrl ?? "", /^https:\/\/www\.wongnai\.com\//);
  const repairPrompt = createPatchDependencyRepairPrompt(error);
  assert.match(repairPrompt, /Failing patch_key: link-horme-evidence/);
  assert.match(repairPrompt, /Disclosure prerequisite status: absent/);
  assert.match(repairPrompt, /Correct the `depends_on` graph/);
  assert.match(repairPrompt, /Do not duplicate shared disclosure prose/);
}

{
  const wrongDate = cloneExactResponse();
  const disclosure = getProposal(
    wrongDate,
    "competitor-observation-dates"
  );
  disclosure.suggested_text = disclosure.suggested_text.replace(
    "16 July 2026",
    "15 July 2026"
  );
  const parsed = parsePatchmarkCommentReplyImport(JSON.stringify(wrongDate));
  const error = expectDependencyError(
    "dependency_source_date_coverage_failed",
    () =>
      validateImportedPatchDependencySimulation({
        comments: [comment],
        existingPatches: [],
        importedPatches: createImportedPatches(parsed),
        markdown
      })
  );

  assert.equal(error.patchKey, "link-horme-evidence");
  assert.equal(error.disclosurePrerequisiteStatus, "invalid");
  assert.equal(error.observedAt, "2026-07-16");
}

{
  const unrelatedDisclosure = cloneExactResponse();
  const unrelatedMarker = "Unrelated disclosure target.";
  const unrelatedMarkdown = `${markdown}\n\n## Unrelated\n\n${unrelatedMarker}\n`;
  const disclosure = getProposal(
    unrelatedDisclosure,
    "competitor-observation-dates"
  );
  disclosure.target_heading = "## Unrelated";
  disclosure.original_text = unrelatedMarker;
  disclosure.suggested_text = `${unrelatedMarker}\n\n${disclosure.suggested_text}`;
  const parsed = parsePatchmarkCommentReplyImport(
    JSON.stringify(unrelatedDisclosure)
  );
  const error = expectDependencyError(
    "dependency_source_date_coverage_failed",
    () =>
      validateImportedPatchDependencySimulation({
        comments: [comment],
        existingPatches: [],
        importedPatches: createImportedPatches(parsed),
        markdown: unrelatedMarkdown
      })
  );

  assert.equal(error.patchKey, "link-horme-evidence");
  assert.equal(error.disclosurePrerequisiteStatus, "unrelated");
}

{
  const missingSourcePrerequisite = cloneExactResponse();
  const deletion = getProposal(
    missingSourcePrerequisite,
    "remove-redundant-sources-section"
  );
  deletion.depends_on = deletion.depends_on.filter(
    (patchKey) => patchKey !== "link-horme-evidence"
  );
  const parsed = parsePatchmarkCommentReplyImport(
    JSON.stringify(missingSourcePrerequisite)
  );
  const error = expectDependencyError(
    "dependency_source_preservation_failed",
    () =>
      validateImportedPatchDependencySimulation({
        comments: [comment],
        existingPatches: [],
        importedPatches: createImportedPatches(parsed),
        markdown
      })
  );

  assert.equal(error.patchKey, "remove-redundant-sources-section");
  assert.match(error.sourceUrl ?? "", /^https:\/\/www\.wongnai\.com\//);
}

{
  const overlap = cloneExactResponse();
  const first = getProposal(overlap, "identify-internal-strategy-source");
  const second = getProposal(overlap, "link-historical-category-signal");
  const dependent = getProposal(overlap, "link-observed-menu-prices");
  second.original_text = first.original_text;
  second.target_heading = first.target_heading;
  dependent.depends_on = [first.patch_key, second.patch_key];
  const parsed = parsePatchmarkCommentReplyImport(JSON.stringify(overlap));
  const error = expectDependencyError(
    "dependency_patch_overlap_conflict",
    () =>
      validateImportedPatchDependencySimulation({
        comments: [comment],
        existingPatches: [],
        importedPatches: createImportedPatches(parsed),
        markdown
      })
  );

  assert.equal(error.patchKey, "link-observed-menu-prices");
  assert.equal(error.dependencyKey, "link-historical-category-signal");
}

console.log(
  JSON.stringify(
    {
      analogueDependentsCovered: analoguePatchKeys.length,
      competitorDependentsCovered: competitorPatchKeys.length,
      deletionClosureSize: 17,
      exactProposalCount: exactResponse.patch_proposals.length,
      exactResponseImported: true,
      negativeVariants: 5
    },
    null,
    2
  )
);

function cloneExactResponse() {
  return structuredClone(exactResponseObject);
}

function createImportedPatches(response) {
  const idByKey = new Map(
    response.patch_proposals.map((proposal, index) => [
      proposal.patch_key,
      `PM-PATCH-${String(index + 1).padStart(4, "0")}`
    ])
  );

  return response.patch_proposals.map((proposal, index) => ({
    id: `PM-PATCH-${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    patch_group_id: "PM-PATCH-GROUP-EXACT",
    patch_group_index: index + 1,
    patch_group_total: response.patch_proposals.length,
    comment_id: proposal.comment_id,
    source_import_id: "PM-IMPORT-EXACT",
    source_patch_key: proposal.patch_key,
    depends_on_patch_ids: proposal.depends_on.map((patchKey) =>
      idByKey.get(patchKey)
    ),
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

function getOrderPatchKeys(patches, orders, patchKey) {
  const patch = getPatch(patches, patchKey);
  const patchesById = new Map(patches.map((candidate) => [candidate.id, candidate]));

  return (orders.get(patch.id) ?? []).map(
    (patchId) => patchesById.get(patchId)?.source_patch_key
  );
}

function getPatch(patches, patchKey) {
  const patch = patches.find(
    (candidate) => candidate.source_patch_key === patchKey
  );
  assert.ok(patch, `Missing imported patch ${patchKey}.`);
  return patch;
}

function getProposal(response, patchKey) {
  const proposal = response.patch_proposals.find(
    (candidate) => candidate.patch_key === patchKey
  );
  assert.ok(proposal, `Missing response proposal ${patchKey}.`);
  return proposal;
}

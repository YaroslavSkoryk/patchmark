import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  parsePatchmarkCommentReplyImport
} from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  PatchDependencyValidationError,
  createPatchDependencyRepairPrompt,
  getPatchDependencyBlockerMessage,
  getPatchDependencyClosureOrder,
  getPatchDependencyReviewStatus,
  validateImportedPatchDependencySimulation
} from "../lib/patches/patch-dependencies.ts";

const commentId = "PM-COMMENT-0019";

{
  const editorSource = readFileSync(
    new URL("../components/document-editor.tsx", import.meta.url),
    "utf8"
  );
  const simulationIndex = editorSource.indexOf(
    "validateImportedPatchDependencySimulation({"
  );
  const importWriteIndex = editorSource.indexOf("await writeProjectImport({");
  const stateSaveIndex = editorSource.indexOf(
    "await saveProjectState({",
    importWriteIndex
  );
  const receiptIndex = editorSource.indexOf(
    "await recordReviewBatchResponseReceipt({"
  );

  assert.ok(simulationIndex > 0 && simulationIndex < importWriteIndex);
  assert.ok(importWriteIndex < stateSaveIndex && stateSaveIndex < receiptIndex);
  assert.match(editorSource, /"protocol_version": 2/);
  assert.match(editorSource, /"patch_key": "add-example-source"/);
  assert.match(editorSource, /"depends_on": \[\]/);
  assert.match(editorSource, /Review required patch/);
  assert.match(editorSource, /Dependencies never cause automatic acceptance/);
  assert.match(editorSource, /applyPatchReplacementAt\(\{/);
  assert.doesNotMatch(editorSource, /Accept all prerequisites/);
}

function proposal(overrides = {}) {
  return {
    patch_key: "independent-change",
    depends_on: [],
    comment_id: commentId,
    display_title: "Apply independent change",
    target_heading: "### 5.1 Local operators and current status",
    original_text: "Original text.",
    suggested_text: "Suggested text.",
    suggested_text_sources: [],
    reason: "Improves the document.",
    reason_sources: [],
    risk: "Low risk.",
    risk_sources: [],
    ...overrides
  };
}

function response(patchProposals, overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 2,
    project_id: "prj_competitor_review",
    document_id: "doc_competitor_review",
    summary: "Coordinated source cleanup.",
    replies: [],
    patch_proposals: patchProposals,
    open_questions: [],
    ...overrides
  };
}

function parse(input) {
  return parsePatchmarkCommentReplyImport(JSON.stringify(input));
}

function expectDependencyError(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof PatchDependencyValidationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function importedPatches(parsed) {
  const idByKey = new Map(
    parsed.patch_proposals.map((patch, index) => [
      patch.patch_key,
      `PM-PATCH-${String(index + 1).padStart(4, "0")}`
    ])
  );

  return parsed.patch_proposals.map((patch, index) => ({
    id: `PM-PATCH-${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    comment_id: patch.comment_id,
    source_import_id: "PM-IMPORT-DEPENDENCIES",
    source_patch_key: patch.patch_key,
    depends_on_patch_ids: patch.depends_on.map((key) => idByKey.get(key)),
    depends_on_patch_keys_snapshot: [...patch.depends_on],
    display_title: patch.display_title,
    target_heading: patch.target_heading,
    original_text: patch.original_text,
    suggested_text: patch.suggested_text,
    suggested_text_sources: patch.suggested_text_sources,
    reason: patch.reason,
    reason_sources: patch.reason_sources,
    risk: patch.risk,
    risk_sources: patch.risk_sources,
    created_at: "2026-07-16T12:00:00.000Z"
  }));
}

function comment() {
  return {
    id: commentId,
    type: "research",
    status: "open",
    anchor: { kind: "document" },
    comment: "Move the competitor sources inline without losing date context.",
    thread: [],
    export_state: { focus_state: "awaiting_reply" },
    created_at: "2026-07-16T10:00:00.000Z",
    updated_at: "2026-07-16T10:00:00.000Z"
  };
}

const competitorMarkdown = `# Competitive landscape

### 5.1 Local operators and current status

Competitor pages were reviewed.

- Horme has a listing.
- Example Bakery has a menu.

## Sources

- https://example.com/horme
- https://example.com/bakery
`;
const disclosureText =
  "The linked live listing, menu, directory and social pages below have no available publication date; publication date unavailable and status, menu, price and rating details were observed 16 July 2026.";
const coordinatedResponse = parse(
  response([
    proposal({
      patch_key: "competitor-observation-dates",
      display_title: "Explain competitor observation dates",
      original_text: "Competitor pages were reviewed.",
      suggested_text: `Competitor pages were reviewed.\n\n${disclosureText}`
    }),
    proposal({
      patch_key: "horme-inline-links",
      depends_on: ["competitor-observation-dates"],
      display_title: "Link Horme evidence",
      original_text: "- Horme has a listing.",
      suggested_text:
        "- [Horme](https://example.com/horme) has a live listing.",
      suggested_text_sources: [
        {
          title: "Horme live listing",
          url: "https://example.com/horme",
          published_at: null,
          updated_at: null,
          observed_at: "2026-07-16",
          supports: "Shows the current Horme listing."
        }
      ]
    }),
    proposal({
      patch_key: "bakery-inline-links",
      depends_on: ["competitor-observation-dates"],
      display_title: "Link bakery evidence",
      original_text: "- Example Bakery has a menu.",
      suggested_text:
        "- [Example Bakery](https://example.com/bakery) has a live menu.",
      suggested_text_sources: [
        {
          title: "Example Bakery live menu",
          url: "https://example.com/bakery",
          published_at: null,
          updated_at: null,
          observed_at: "2026-07-16",
          supports: "Shows the current bakery menu."
        }
      ]
    }),
    proposal({
      patch_key: "remove-sources-section",
      depends_on: ["horme-inline-links", "bakery-inline-links"],
      display_title: "Remove redundant Sources section",
      target_heading: "## Sources",
      original_text:
        "## Sources\n\n- https://example.com/horme\n- https://example.com/bakery",
      suggested_text: "",
      risk: "Safe only after both source links are preserved inline."
    })
  ])
);
const coordinatedPatches = importedPatches(coordinatedResponse);
const simulationOrders = validateImportedPatchDependencySimulation({
  comments: [comment()],
  existingPatches: [],
  importedPatches: coordinatedPatches,
  markdown: competitorMarkdown
});

assert.deepEqual(
  getPatchDependencyClosureOrder(
    coordinatedResponse,
    "remove-sources-section"
  ),
  [
    "competitor-observation-dates",
    "horme-inline-links",
    "bakery-inline-links"
  ]
);
assert.deepEqual(simulationOrders.get("PM-PATCH-0004"), [
  "PM-PATCH-0001",
  "PM-PATCH-0002",
  "PM-PATCH-0003",
  "PM-PATCH-0004"
]);

{
  const competitorKeys = [
    "horme",
    "routine",
    "merak",
    "kaarom",
    "fix",
    "crumbs",
    "nana",
    "casa-lapin"
  ];
  const analogueKeys = ["holey", "og-sandwich"];
  const competitorLines = competitorKeys.map(
    (key) => `- ${key} current listing.`
  );
  const analogueLines = analogueKeys.map(
    (key) => `- ${key} current analogue.`
  );
  const sourceUrls = [...competitorKeys, ...analogueKeys].map(
    (key) => `https://example.com/${key}`
  );
  const faithfulMarkdown = `# Market review

### 5.1 Local operators and current status

Competitor evidence introduction.

${competitorLines.join("\n")}

### 5.2 Wider analogues

Analogue evidence introduction.

${analogueLines.join("\n")}

## Sources

${sourceUrls.map((url) => `- ${url}`).join("\n")}`;
  const competitorLinkPatches = competitorKeys.map((key) =>
    proposal({
      patch_key: `${key}-inline-links`,
      depends_on: ["competitor-observation-dates"],
      display_title: `Link ${key} evidence`,
      original_text: `- ${key} current listing.`,
      suggested_text: `- [${key}](https://example.com/${key}) current listing.`,
      suggested_text_sources: [
        {
          title: `${key} live listing`,
          url: `https://example.com/${key}`,
          published_at: null,
          updated_at: null,
          observed_at: "2026-07-16",
          supports: `Shows the current ${key} listing.`
        }
      ]
    })
  );
  const analogueLinkPatches = analogueKeys.map((key) =>
    proposal({
      patch_key: `${key}-inline-link`,
      depends_on: ["analogue-observation-dates"],
      display_title: `Link ${key} analogue`,
      target_heading: "### 5.2 Wider analogues",
      original_text: `- ${key} current analogue.`,
      suggested_text: `- [${key}](https://example.com/${key}) current analogue.`,
      suggested_text_sources: [
        {
          title: `${key} live analogue`,
          url: `https://example.com/${key}`,
          published_at: null,
          updated_at: null,
          observed_at: "2026-07-16",
          supports: `Shows the current ${key} analogue.`
        }
      ]
    })
  );
  const faithfulResponse = parse(
    response([
      proposal({
        patch_key: "competitor-observation-dates",
        display_title: "Explain competitor observation dates",
        original_text: "Competitor evidence introduction.",
        suggested_text: `Competitor evidence introduction.\n\n${disclosureText}`
      }),
      ...competitorLinkPatches,
      proposal({
        patch_key: "analogue-observation-dates",
        display_title: "Explain analogue observation dates",
        target_heading: "### 5.2 Wider analogues",
        original_text: "Analogue evidence introduction.",
        suggested_text: `Analogue evidence introduction.\n\n${disclosureText}`
      }),
      ...analogueLinkPatches,
      proposal({
        patch_key: "remove-sources-section",
        depends_on: [
          ...competitorLinkPatches.map((patch) => patch.patch_key),
          ...analogueLinkPatches.map((patch) => patch.patch_key)
        ],
        display_title: "Remove redundant Sources section",
        target_heading: "## Sources",
        original_text: `## Sources\n\n${sourceUrls
          .map((url) => `- ${url}`)
          .join("\n")}`,
        suggested_text: "",
        risk: "Safe only after every visible source is preserved inline."
      })
    ])
  );
  const faithfulOrders = validateImportedPatchDependencySimulation({
    comments: [comment()],
    existingPatches: [],
    importedPatches: importedPatches(faithfulResponse),
    markdown: faithfulMarkdown
  });

  assert.equal(faithfulResponse.patch_proposals.length, 13);
  assert.equal(
    faithfulOrders.get("PM-PATCH-0013").length,
    faithfulResponse.patch_proposals.length
  );
}

{
  const missingPreservation = parse(
    response(
      coordinatedResponse.patch_proposals.map((patch) =>
        patch.patch_key === "remove-sources-section"
          ? { ...patch, depends_on: ["horme-inline-links"] }
          : patch
      )
    )
  );

  expectDependencyError("dependency_source_preservation_failed", () =>
    validateImportedPatchDependencySimulation({
      comments: [comment()],
      existingPatches: [],
      importedPatches: importedPatches(missingPreservation),
      markdown: competitorMarkdown
    })
  );
}

{
  const unrelatedDisclosure = parse(
    response([
      proposal({
        patch_key: "other-section-disclosure",
        target_heading: "## Sources",
        original_text: "## Sources",
        suggested_text: `## Sources\n\n${disclosureText}`
      }),
      proposal({
        patch_key: "dependent-link",
        depends_on: ["other-section-disclosure"],
        original_text: "- Horme has a listing.",
        suggested_text:
          "- [Horme](https://example.com/horme) has a live listing.",
        suggested_text_sources: [
          {
            title: "Horme live listing",
            url: "https://example.com/horme",
            published_at: null,
            updated_at: null,
            observed_at: "2026-07-16",
            supports: "Shows the current Horme listing."
          }
        ]
      })
    ])
  );

  expectDependencyError("dependency_source_date_coverage_failed", () =>
    validateImportedPatchDependencySimulation({
      comments: [comment()],
      existingPatches: [],
      importedPatches: importedPatches(unrelatedDisclosure),
      markdown: competitorMarkdown
    })
  );
}

{
  const wrongDateResponse = parse(
    response([
      proposal({
        patch_key: "wrong-date-disclosure",
        original_text: "Competitor pages were reviewed.",
        suggested_text:
          "Competitor pages were reviewed.\n\nPublication date unavailable; details were observed 15 July 2026."
      }),
      proposal({
        patch_key: "dated-link",
        depends_on: ["wrong-date-disclosure"],
        original_text: "- Horme has a listing.",
        suggested_text:
          "- [Horme](https://example.com/horme) has a live listing.",
        suggested_text_sources: [
          {
            title: "Horme live listing",
            url: "https://example.com/horme",
            published_at: null,
            updated_at: null,
            observed_at: "2026-07-16",
            supports: "Shows the current Horme listing."
          }
        ]
      })
    ])
  );

  expectDependencyError("dependency_source_date_coverage_failed", () =>
    validateImportedPatchDependencySimulation({
      comments: [comment()],
      existingPatches: [],
      importedPatches: importedPatches(wrongDateResponse),
      markdown: competitorMarkdown
    })
  );
}

expectDependencyError("duplicate_patch_key", () =>
  parse(
    response([
      proposal({ patch_key: "same" }),
      proposal({ patch_key: "same" })
    ])
  )
);
expectDependencyError("missing_patch_dependency", () =>
  parse(
    response([
      proposal({ patch_key: "dependent", depends_on: ["missing"] })
    ])
  )
);
expectDependencyError("self_patch_dependency", () =>
  parse(response([proposal({ patch_key: "self", depends_on: ["self"] })]))
);
expectDependencyError("duplicate_dependency_reference", () =>
  parse(
    response([
      proposal({ patch_key: "base" }),
      proposal({
        patch_key: "dependent",
        depends_on: ["base", "base"]
      })
    ])
  )
);
expectDependencyError("patch_dependency_cycle", () =>
  parse(
    response([
      proposal({ patch_key: "first", depends_on: ["second"] }),
      proposal({ patch_key: "second", depends_on: ["first"] })
    ])
  )
);
expectDependencyError("cross_comment_dependency", () =>
  parse(
    response([
      proposal({ patch_key: "first" }),
      proposal({
        patch_key: "second",
        depends_on: ["first"],
        comment_id: "PM-COMMENT-0020"
      })
    ])
  )
);
expectDependencyError("unsupported_dependency_protocol", () =>
  parse({
    ...response([proposal()]),
    protocol_version: 1
  })
);

{
  const legacySourcePatch = proposal({
    patch_key: undefined,
    depends_on: undefined,
    suggested_text:
      "[Live menu](https://example.com/menu) is available.",
    suggested_text_sources: [
      {
        title: "Live menu",
        url: "https://example.com/menu",
        published_at: null,
        updated_at: null,
        observed_at: "2026-07-16",
        supports: "Shows a live menu."
      }
    ]
  });
  let sourceDateError;
  try {
    parse(
      response([legacySourcePatch], {
        protocol_version: 1
      })
    );
  } catch (error) {
    sourceDateError = error;
  }

  assert.ok(sourceDateError instanceof Error);
  assert.match(sourceDateError.message, /publication date is available/);
  const repairPrompt = createPatchDependencyRepairPrompt(sourceDateError);
  assert.match(repairPrompt, /protocol_version 2/);
  assert.match(repairPrompt, /instead of repeating the disclosure/);
  assert.match(
    repairPrompt,
    /Preserve review_batch_id, project_id, document_id/
  );
}

{
  const conflictMarkdown = `## Section

Shared original.
`;
  const conflictResponse = parse(
    response([
      proposal({
        patch_key: "first",
        target_heading: "## Section",
        original_text: "Shared original.",
        suggested_text: "First replacement."
      }),
      proposal({
        patch_key: "second",
        depends_on: ["first"],
        target_heading: "## Section",
        original_text: "Shared original.",
        suggested_text: "Second replacement."
      })
    ])
  );

  expectDependencyError("dependent_patch_stale_after_prerequisites", () =>
    validateImportedPatchDependencySimulation({
      comments: [comment()],
      existingPatches: [],
      importedPatches: importedPatches(conflictResponse),
      markdown: conflictMarkdown
    })
  );
}

{
  const overlapMarkdown = `## Section

Shared prerequisite target.

Dependent target.
`;
  const overlapResponse = parse(
    response([
      proposal({
        patch_key: "first-prerequisite",
        target_heading: "## Section",
        original_text: "Shared prerequisite target.",
        suggested_text: "First prerequisite replacement."
      }),
      proposal({
        patch_key: "second-prerequisite",
        target_heading: "## Section",
        original_text: "Shared prerequisite target.",
        suggested_text: "Second prerequisite replacement."
      }),
      proposal({
        patch_key: "dependent",
        depends_on: ["first-prerequisite", "second-prerequisite"],
        target_heading: "## Section",
        original_text: "Dependent target.",
        suggested_text: "Dependent replacement."
      })
    ])
  );

  expectDependencyError("dependency_patch_overlap_conflict", () =>
    validateImportedPatchDependencySimulation({
      comments: [comment()],
      existingPatches: [],
      importedPatches: importedPatches(overlapResponse),
      markdown: overlapMarkdown
    })
  );
}

{
  const base = coordinatedPatches[0];
  const dependent = {
    ...coordinatedPatches[1],
    depends_on_patch_ids: [base.id]
  };
  const pendingStatus = getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: dependent,
    patches: [base, dependent]
  });
  assert.equal(pendingStatus.state, "blocked_by_pending_dependency");
  assert.match(
    getPatchDependencyBlockerMessage(pendingStatus),
    /not been accepted/
  );

  const rejectedStatus = getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: dependent,
    patches: [{ ...base, status: "rejected" }, dependent]
  });
  assert.equal(rejectedStatus.state, "blocked_by_rejected_dependency");

  const unavailableStatus = getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: dependent,
    patches: [dependent]
  });
  assert.equal(unavailableStatus.state, "blocked_by_unavailable_dependency");

  const foreignOwnershipStatus = getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: dependent,
    patches: [
      { ...base, source_import_id: "PM-IMPORT-OTHER-DOCUMENT" },
      dependent
    ]
  });
  assert.equal(
    foreignOwnershipStatus.state,
    "blocked_by_unavailable_dependency"
  );
  assert.equal(foreignOwnershipStatus.directDependencies[0].patch, null);

  const staleStatus = getPatchDependencyReviewStatus({
    applicability: "not_found",
    patch: dependent,
    patches: [{ ...base, status: "accepted" }, dependent]
  });
  assert.equal(staleStatus.state, "dependency_validation_stale");

  const readyStatus = getPatchDependencyReviewStatus({
    applicability: "exact_match",
    patch: dependent,
    patches: [{ ...base, status: "accepted" }, dependent]
  });
  assert.equal(readyStatus.state, "ready");
}

{
  const repairError = new PatchDependencyValidationError({
    code: "patch_dependency_cycle",
    message: "Cycle."
  });
  assert.match(
    createPatchDependencyRepairPrompt(repairError),
    /patch_dependency_cycle/
  );
  assert.match(
    createPatchDependencyRepairPrompt(repairError),
    /cyclic dependencies/
  );
}

{
  const nodeCount = 40;
  const lines = Array.from(
    { length: nodeCount },
    (_, index) => `Dependency line ${index + 1}.`
  );
  const stressResponse = parse(
    response(
      lines.map((line, index) =>
        proposal({
          patch_key: `node-${String(index + 1).padStart(2, "0")}`,
          depends_on:
            index === 0
              ? []
              : [`node-${String(index).padStart(2, "0")}`],
          target_heading: "## Dependency stress",
          original_text: line,
          suggested_text: `${line} Applied.`
        })
      )
    )
  );
  const startedAt = performance.now();
  const stressOrders = validateImportedPatchDependencySimulation({
    comments: [comment()],
    existingPatches: [],
    importedPatches: importedPatches(stressResponse),
    markdown: `## Dependency stress\n\n${lines.join("\n")}\n`
  });
  const durationMs = performance.now() - startedAt;

  assert.equal(stressOrders.get("PM-PATCH-0040").length, nodeCount);
  assert.ok(durationMs < 2_000, `Stress simulation took ${durationMs}ms.`);
  console.log(
    JSON.stringify(
      {
        faithfulFixture: commentId,
        graphFailuresCovered: 7,
        noAutomaticAcceptance: true,
        sourcePreservationValidated: true,
        stressDurationMs: Number(durationMs.toFixed(2)),
        stressNodeCount: nodeCount
      },
      null,
      2
    )
  );
}

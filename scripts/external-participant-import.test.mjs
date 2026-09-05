import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  ExternalCommentAnchorAdmissionError
} from "../lib/comments/external-comment-admission.ts";
import { getCleanCommentAnchorLabel } from "../lib/comments/comment-card-display.ts";
import { getLatestEditableUserReply } from "../lib/comments/comment-thread-reply-edit.ts";
import { resolveCanonicalCommentTarget } from "../lib/comments/canonical-target-resolution.ts";
import { getActiveComments } from "../lib/comments/comment-trash-operations.ts";
import { allocatePatchmarkCommentIds } from "../lib/comments/native-comment.ts";
import {
  importProjectCommentReplyResponse,
  importProjectCommentReplyResponseBytes
} from "../lib/imports/project-comment-reply-import.ts";
import { resolveAndApplyPendingPatch } from "../lib/patches/patch-application.ts";
import {
  createCommentPatchHistorySummary,
  createRelatedAcceptedPatchHistory
} from "../lib/patches/comment-patch-history.ts";
import {
  getProjectDocumentIdentity,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { createTrackedReviewBatchExport } from "../lib/review-batches/review-batch-export.ts";
import { listReviewBatches } from "../lib/review-batches/review-batch-repository.ts";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree
} from "./lib/project-fixture-foundation.mjs";

const encoder = new TextEncoder();
const copies = [];
let scenarioSequence = 0;
const EXISTING_COMMENT_ID = "PM-COMMENT-0007";
const IMPORTED_AT = "2041-04-01T00:00:00.000Z";
const IMPORT_ID = "PM-IMPORT-V3-QUALIFICATION";

try {
  assert.deepEqual(
    allocatePatchmarkCommentIds(
      [
        { id: "legacy-comment" },
        { id: "PM-COMMENT-0003" },
        { id: "PM-COMMENT-0005" }
      ],
      3
    ),
    ["PM-COMMENT-0006", "PM-COMMENT-0007", "PM-COMMENT-0008"]
  );

  await proveNativeCreationAndBehavior();
  await proveNewCommentsOnlyRemainSuccessfulPartialResponse();
  await proveSnapshotAdmissionFailuresAreAtomic();
  await proveCurrentDocumentRelocation();
  await proveDeletedCurrentTargetFailsClosed();
  await proveAmbiguousCurrentTargetFailsClosed();
  await proveManualAndBytePathsConverge();
  await proveMultiDocumentIsolation();
  await proveCommitOwnershipFailureIsAtomic();

  process.stdout.write(
    `${JSON.stringify(
      {
        assertions: "complete",
        atomic_failures: true,
        canonical_relocation: true,
        corrected_escaped_anchor_behavior: true,
        local_ref_mapping: true,
        manual_byte_path_convergence: true,
        multi_document_isolation: true,
        native_comment_creation: true,
        native_reply_patch_persistence: true,
        replay_protection: true,
        responded_partial_is_successful: true,
        status: "ok",
        two_stage_anchor_admission: true
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

async function proveNativeCreationAndBehavior() {
  const markdown = [
    "# Alpha",
    "",
    "The launch window opens at dawn.",
    "",
    "# Beta",
    "",
    "Backup route is stable.",
    "",
    "Existing line stays.",
    "",
    "The Business of the Company shall, unless and until the Parties",
    "hereto otherwise agree, be confined to carry on the business of \\_\\_\\_",
    ""
  ].join("\n");
  const scenario = await createScenario("native", markdown);
  const response = createResponse(scenario, {
    new_comments: [
      externalComment(scenario, "comment-a", {
        kind: "selected_text",
        selected_text: "The launch window opens at dawn.",
        markdown_start_offset: markdown.indexOf("The launch"),
        markdown_end_offset:
          markdown.indexOf("The launch") +
          "The launch window opens at dawn.".length,
        containing_heading: "Alpha",
        containing_heading_level: 1,
        containing_heading_line: 1,
        containing_heading_path: ["Alpha"]
      }),
      {
        ...externalComment(scenario, "comment-b", {
          kind: "section",
          heading: "Beta",
          heading_level: 1,
          heading_line: 5,
          heading_path: ["Beta"]
        }),
        type: "risk"
      },
      {
        ...externalComment(scenario, "comment-c", { kind: "document" }),
        type: "question"
      },
      externalComment(scenario, "comment-d", {
        kind: "selected_text",
        selected_text: "\\_\\_\\_",
        anchor_context: {
          kind: "paragraph",
          plain_text:
            "The Business of the Company shall, unless and until the Parties hereto otherwise agree, be confined to carry on the business of ___",
          markdown_text:
            "The Business of the Company shall, unless and until the Parties\nhereto otherwise agree, be confined to carry on the business of \\_\\_\\_"
        },
        containing_heading: "Beta",
        containing_heading_level: 1,
        containing_heading_path: ["Beta"],
        anchor_source: "markdown"
      })
    ],
    replies: [
      {
        comment_id: EXISTING_COMMENT_ID,
        reply: "The existing line can be tightened.",
        reply_sources: [],
        suggested_user_action: "review"
      }
    ],
    open_questions: [
      {
        comment_id: EXISTING_COMMENT_ID,
        question: "Should the line remain in Beta?",
        question_sources: []
      }
    ],
    patch_proposals: [
      externalPatch(
        "new-selected",
        responseCommentTarget("comment-a"),
        "launch window",
        "launch period"
      ),
      externalPatch(
        "beta-first",
        responseCommentTarget("comment-b"),
        "Backup route is stable.",
        "Backup route remains stable.",
        { target_heading: "Beta" }
      ),
      externalPatch(
        "beta-second",
        responseCommentTarget("comment-b"),
        "remains stable",
        "stays stable",
        { depends_on: ["beta-first"], target_heading: "Beta" }
      ),
      externalPatch(
        "existing-target",
        existingCommentTarget(EXISTING_COMMENT_ID),
        "Existing line stays.",
        "Existing line remains.",
        { target_heading: "Beta" }
      )
    ]
  });

  const imported = await importText(scenario, response);
  assert.equal(imported.comments_created, 4);
  assert.equal(imported.replies_attached, 1);
  assert.equal(imported.open_questions_attached, 1);
  assert.equal(imported.patch_proposals_stored, 4);
  assert.equal(imported.review_batches[0].status, "responded");
  assert.equal(imported.review_batches[0].import_id, IMPORT_ID);
  assert.deepEqual(
    imported.comments.slice(1).map((comment) => comment.id),
    [
      "PM-COMMENT-0008",
      "PM-COMMENT-0009",
      "PM-COMMENT-0010",
      "PM-COMMENT-0011"
    ]
  );
  assert.equal(imported.comments[0].thread.length, 2);
  assert.equal(imported.comments[0].export_state.focus_state, "reply_received");

  const selectedComment = imported.comments[1];
  const sectionComment = imported.comments[2];
  const documentComment = imported.comments[3];
  const escapedPlaceholderComment = imported.comments[4];
  assert.equal(selectedComment.anchor.kind, "selected_text");
  assert.equal(sectionComment.anchor.kind, "section");
  assert.equal(documentComment.anchor.kind, "document");
  assert.equal(escapedPlaceholderComment.anchor.kind, "selected_text");
  assert.equal(escapedPlaceholderComment.anchor.selected_text, "\\_\\_\\_");
  assert.equal(
    resolveCanonicalCommentTarget(escapedPlaceholderComment, { markdown }).state,
    "resolved"
  );
  assert.equal(sectionComment.type, "risk");
  assert.equal(documentComment.type, "question");
  assert.equal(
    getCleanCommentAnchorLabel(selectedComment),
    "Selected text in Alpha"
  );
  for (const comment of [
    selectedComment,
    sectionComment,
    documentComment,
    escapedPlaceholderComment
  ]) {
    assert.equal(comment.source_import_id, IMPORT_ID);
    assert.equal("local_ref" in comment, false);
    assert.equal(comment.status, "open");
    assert.equal(comment.thread.length, 0);
    assert.equal(comment.export_state.focus_state, "idle");
    assert.equal(comment.created_at, IMPORTED_AT);
    assert.equal(comment.updated_at, IMPORTED_AT);
  }

  const patchesByKey = new Map(
    imported.patches.map((patch) => [patch.source_patch_key, patch])
  );
  assert.equal(patchesByKey.get("new-selected")?.comment_id, selectedComment.id);
  assert.equal(patchesByKey.get("beta-first")?.comment_id, sectionComment.id);
  assert.equal(patchesByKey.get("beta-second")?.comment_id, sectionComment.id);
  assert.equal(
    patchesByKey.get("existing-target")?.comment_id,
    EXISTING_COMMENT_ID
  );
  assert.deepEqual(patchesByKey.get("beta-second")?.depends_on_patch_ids, [
    patchesByKey.get("beta-first")?.id
  ]);
  assert.equal(patchesByKey.get("new-selected")?.source_import_id, IMPORT_ID);
  assert.equal(patchesByKey.get("new-selected")?.source_patch_key, "new-selected");

  const reopened = await reopenScenario(scenario);
  const reloadedComments = await readProjectComments(reopened.project);
  const reloadedSelected = reloadedComments.find(
    (comment) => comment.id === selectedComment.id
  );
  assert.ok(reloadedSelected);
  assert.equal(reloadedSelected.source_import_id, IMPORT_ID);
  assert.equal("local_ref" in reloadedSelected, false);
  assert.equal(getActiveComments(reloadedComments).length, 5);

  const repliedAt = "2041-04-02T00:00:00.000Z";
  const repliedComments = reloadedComments.map((comment) =>
    comment.id === selectedComment.id
      ? {
          ...comment,
          thread: [
            ...comment.thread,
            {
              id: "PM-THREAD-0001",
              role: "user",
              content: "A normal human follow-up.",
              created_at: repliedAt
            }
          ],
          export_state: {
            ...comment.export_state,
            focus_state: "in_focus",
            marked_for_export_at: repliedAt
          },
          updated_at: repliedAt
        }
      : comment
  );
  await saveProjectState({
    comments: repliedComments,
    project: reopened.project,
    reason: "v3_native_reply_qualification"
  });
  const repliedReload = await reopenScenario(scenario);
  const repliedComment = (await readProjectComments(repliedReload.project)).find(
    (comment) => comment.id === selectedComment.id
  );
  assert.ok(repliedComment);
  assert.equal(
    getLatestEditableUserReply(repliedComment)?.entry.content,
    "A normal human follow-up."
  );

  const reloadedPatches = await readProjectPatches(repliedReload.project);
  const patchToAccept = reloadedPatches.find(
    (patch) => patch.source_patch_key === "new-selected"
  );
  const patchToReject = reloadedPatches.find(
    (patch) => patch.source_patch_key === "existing-target"
  );
  assert.ok(patchToAccept && patchToReject);
  const application = resolveAndApplyPendingPatch({
    comments: await readProjectComments(repliedReload.project),
    documentId: scenario.identity.documentId,
    markdown,
    patch: patchToAccept,
    patches: reloadedPatches
  });
  assert.equal(application.kind, "applied");
  if (application.kind !== "applied") {
    throw new Error("Expected the imported patch to apply.");
  }
  const decidedPatches = reloadedPatches.map((patch) =>
    patch.id === patchToAccept.id
      ? {
          ...patch,
          status: "accepted",
          accepted_at: repliedAt,
          applied_at: repliedAt,
          resolved_at: repliedAt,
          applied_text: patch.suggested_text,
          applied_start_offset: application.start,
          applied_end_offset: application.end
        }
      : patch.id === patchToReject.id
        ? {
            ...patch,
            status: "rejected",
            rejected_at: repliedAt,
            resolved_at: repliedAt
          }
        : patch
  );
  assert.deepEqual(
    createRelatedAcceptedPatchHistory({
      comment: repliedComment,
      patches: decidedPatches
    }).patches.map((patch) => patch.patch_id),
    [patchToAccept.id]
  );
  const historySummary = createCommentPatchHistorySummary({
    comment: repliedComment,
    patches: decidedPatches
  });
  assert.equal(historySummary.accepted, 1);
  assert.equal(historySummary.patchCount, 1);
  await saveProjectState({
    markdown: application.markdown,
    patches: decidedPatches,
    project: repliedReload.project,
    reason: "v3_native_patch_decisions"
  });
  const decisionReload = await reopenScenario(scenario);
  const persistedDecisions = await readProjectPatches(decisionReload.project);
  assert.equal(
    persistedDecisions.find((patch) => patch.id === patchToAccept.id)?.status,
    "accepted"
  );
  assert.equal(
    persistedDecisions.find((patch) => patch.id === patchToReject.id)?.status,
    "rejected"
  );

  const replayDigest = digestProjectTree(scenario.copy.projectRoot).digest;
  await assert.rejects(
    () => importBytes(scenario, response, "PM-IMPORT-V3-REPLAY"),
    /already has an associated response/
  );
  await assert.rejects(
    () =>
      importBytes(
        scenario,
        {
          ...response,
          new_comments: response.new_comments.map((comment, index) =>
            index === 0
              ? { ...comment, comment: "Conflicting second response." }
              : comment
          )
        },
        "PM-IMPORT-V3-CONFLICT"
      ),
    /already has an associated response/
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, replayDigest);
  assert.equal(
    (await readProjectComments((await reopenScenario(scenario)).project)).length,
    5
  );
}

async function proveNewCommentsOnlyRemainSuccessfulPartialResponse() {
  const markdown = [
    "# Operating model",
    "",
    "The launch assumption remains intentionally concise.",
    ""
  ].join("\n");
  const scenario = await createScenario("new-comments-partial", markdown);
  const response = createResponse(scenario, {
    new_comments: [
      externalComment(scenario, "comment-partial", {
        kind: "selected_text",
        selected_text: "launch assumption",
        anchor_context: {
          kind: "paragraph",
          plain_text: "The launch assumption remains intentionally concise.",
          markdown_text: "The launch assumption remains intentionally concise."
        },
        containing_heading: "Operating model",
        containing_heading_level: 1,
        containing_heading_path: ["Operating model"],
        anchor_source: "markdown"
      })
    ]
  });

  const imported = await importText(
    scenario,
    response,
    "PM-IMPORT-V3-NEW-COMMENTS-PARTIAL"
  );

  assert.equal(imported.comments_created, 1);
  assert.equal(imported.replies_attached, 0);
  assert.equal(imported.patch_proposals_stored, 0);
  assert.deepEqual(imported.warnings, []);
  assert.equal(imported.review_batches[0].status, "responded_partial");
  assert.equal(
    imported.review_batches[0].response_analysis.coverage_status,
    "partial"
  );
  assert.equal(
    imported.review_batches[0].response_analysis.aggregate.unanswered_comments,
    1
  );

  const reopened = await reopenScenario(scenario);
  const reloadedComments = await readProjectComments(reopened.project);
  assert.ok(
    reloadedComments.some(
      (comment) =>
        comment.source_import_id === "PM-IMPORT-V3-NEW-COMMENTS-PARTIAL"
    )
  );
}

async function proveSnapshotAdmissionFailuresAreAtomic() {
  const markdown = [
    "# Admission",
    "",
    "Unique target.",
    "",
    "Repeat me.",
    "",
    "Repeat me.",
    ""
  ].join("\n");
  const scenario = await createScenario("snapshot-failures", markdown);
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  const cases = [
    {
      name: "ambiguous snapshot",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(scenario, "ambiguous", {
            kind: "selected_text",
            selected_text: "Repeat me."
          })
        ]
      }),
      pattern: /exported snapshot target is ambiguous/
    },
    {
      name: "unresolved snapshot",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(scenario, "missing", {
            kind: "selected_text",
            selected_text: "Missing target."
          })
        ]
      }),
      pattern: /exported snapshot target is unresolved/
    },
    {
      name: "contradicting offsets",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(scenario, "contradiction", {
            kind: "selected_text",
            selected_text: "Unique target.",
            markdown_start_offset: 0,
            markdown_end_offset: "Unique target.".length
          })
        ]
      }),
      pattern: /offsets do not match selected_text/
    },
    {
      name: "contradicting context evidence",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(scenario, "bad-context", {
            ...selectedAnchor(markdown, "Unique target."),
            anchor_context: {
              kind: "paragraph",
              plain_text: "A different paragraph."
            }
          })
        ]
      }),
      pattern: /anchor_context does not contain the resolved target/
    },
    {
      name: "one invalid comment prevents partial creation",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(
            scenario,
            "valid-first",
            selectedAnchor(markdown, "Unique target.")
          ),
          externalComment(scenario, "invalid-second", {
            kind: "selected_text",
            selected_text: "Not present."
          })
        ]
      }),
      pattern: /invalid-second/
    },
    {
      name: "patch failure prevents comment creation",
      response: createResponse(scenario, {
        new_comments: [
          externalComment(
            scenario,
            "valid-comment",
            selectedAnchor(markdown, "Unique target.")
          )
        ],
        patch_proposals: [
          externalPatch(
            "missing-patch-target",
            responseCommentTarget("valid-comment"),
            "Patch text is absent.",
            "Replacement."
          )
        ]
      }),
      pattern: /could not be validated|does not match|no longer matches|not found/i
    },
    {
      name: "unknown local relationship",
      response: createResponse(scenario, {
        patch_proposals: [
          externalPatch(
            "unknown-local",
            responseCommentTarget("not-declared"),
            "Unique target.",
            "Updated target."
          )
        ]
      }),
      pattern: /unknown response-local comment/
    }
  ];

  for (const testCase of cases) {
    await assert.rejects(
      () => importText(scenario, testCase.response),
      testCase.pattern,
      testCase.name
    );
    assert.equal(
      digestProjectTree(scenario.copy.projectRoot).digest,
      before,
      `${testCase.name} must not mutate persistent state`
    );
  }

  await assert.rejects(
    () =>
      importText(
        scenario,
        createResponse(scenario, {
          new_comments: [
            externalComment(scenario, "typed-error", {
              kind: "selected_text",
              selected_text: "Never present."
            })
          ]
        })
      ),
    (error) =>
      error instanceof ExternalCommentAnchorAdmissionError &&
      error.code === "snapshot_anchor_not_found" &&
      error.localRef === "typed-error"
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveCurrentDocumentRelocation() {
  const snapshot = "# Relocation\n\nTarget sentence stays intact.\n";
  const current = `Preamble added later.\n\n${snapshot}`;
  const scenario = await createScenario("relocation", snapshot, current);
  const imported = await importText(
    scenario,
    createResponse(scenario, {
      new_comments: [
        externalComment(
          scenario,
          "shifted-target",
          selectedAnchor(snapshot, "Target sentence stays intact.", {
            containing_heading: "Relocation"
          })
        )
      ]
    })
  );
  const created = imported.comments.at(-1);
  assert.equal(created.anchor.kind, "selected_text");
  assert.equal(
    created.anchor.markdown_start_offset,
    current.indexOf("Target sentence stays intact.")
  );
  assert.equal(
    current.slice(
      created.anchor.markdown_start_offset,
      created.anchor.markdown_end_offset
    ),
    "Target sentence stays intact."
  );
}

async function proveDeletedCurrentTargetFailsClosed() {
  const snapshot = "# Deleted\n\nTarget will be deleted.\n";
  const current = "# Deleted\n\nReplacement prose only.\n";
  const scenario = await createScenario("deleted", snapshot, current);
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  await assert.rejects(
    () =>
      importText(
        scenario,
        createResponse(scenario, {
          new_comments: [
            externalComment(
              scenario,
              "deleted-target",
              selectedAnchor(snapshot, "Target will be deleted.")
            )
          ]
        })
      ),
    /current document target is unresolved/
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveAmbiguousCurrentTargetFailsClosed() {
  const snapshot = "# Ambiguous later\n\nOnce unique.\n";
  const current = "# Ambiguous later\n\nOnce unique.\n\nOnce unique.\n";
  const scenario = await createScenario("current-ambiguous", snapshot, current);
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  await assert.rejects(
    () =>
      importText(
        scenario,
        createResponse(scenario, {
          new_comments: [
            externalComment(
              scenario,
              "ambiguous-later",
              selectedAnchor(snapshot, "Once unique.")
            )
          ]
        })
      ),
    /current document target is ambiguous/
  );
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function proveManualAndBytePathsConverge() {
  const markdown = "# Delivery\n\nShared delivery target.\n";
  const manual = await createScenario("manual-path", markdown);
  const bytes = await createScenario("byte-path", markdown);
  const manualResponse = createResponse(manual, {
    new_comments: [
      externalComment(
        manual,
        "delivery-comment",
        selectedAnchor(markdown, "Shared delivery target.")
      )
    ],
    patch_proposals: [
      externalPatch(
        "delivery-patch",
        responseCommentTarget("delivery-comment"),
        "Shared delivery target.",
        "Shared transport target."
      )
    ]
  });
  const byteResponse = {
    ...manualResponse,
    project_id: bytes.identity.projectId,
    document_id: bytes.identity.documentId,
    review_batch_id: bytes.batch.batch_id,
    new_comments: manualResponse.new_comments.map((comment) => ({
      ...comment,
      document_id: bytes.identity.documentId
    }))
  };
  const manualResult = await importText(manual, manualResponse);
  const byteResult = await importBytes(bytes, byteResponse);
  assert.deepEqual(
    projectSemanticState(manualResult),
    projectSemanticState(byteResult)
  );
}

async function proveMultiDocumentIsolation() {
  const markdown = "# Shared\n\nIdentical selected text.\n";
  const scenario = await createScenario("multi-document", markdown);
  const second = await openProjectDocument(scenario.project, "doc_evidence");
  assert.ok(second);
  await saveProjectState({
    comments: [],
    markdown,
    patches: [],
    project: second.project,
    reason: "v3_identical_second_document"
  });
  const main = await openProjectDocument(second.project, scenario.identity.documentId);
  assert.ok(main);
  scenario.project = main.project;
  scenario.currentMarkdown = main.markdown;
  const beforeWrongDocument = digestProjectTree(scenario.copy.projectRoot).digest;
  const wrongDocumentResponse = createResponse(scenario, {
    document_id: "doc_evidence",
    new_comments: [
      {
        ...externalComment(
          scenario,
          "wrong-document",
          selectedAnchor(markdown, "Identical selected text.")
        ),
        document_id: "doc_evidence"
      }
    ]
  });
  await assert.rejects(
    () => importText(scenario, wrongDocumentResponse),
    /another project or document|outside the allowed project/i
  );
  assert.equal(
    digestProjectTree(scenario.copy.projectRoot).digest,
    beforeWrongDocument
  );

  await importText(
    scenario,
    createResponse(scenario, {
      new_comments: [
        externalComment(
          scenario,
          "right-document",
          selectedAnchor(markdown, "Identical selected text.")
        )
      ]
    })
  );
  const secondAfter = await openProjectDocument(scenario.project, "doc_evidence");
  assert.ok(secondAfter);
  assert.equal(secondAfter.markdown, markdown);
  assert.deepEqual(await readProjectComments(secondAfter.project), []);
  const mainAfter = await openProjectDocument(
    secondAfter.project,
    scenario.identity.documentId
  );
  assert.equal((await readProjectComments(mainAfter.project)).length, 2);
}

async function proveCommitOwnershipFailureIsAtomic() {
  const markdown = "# Ownership\n\nOwnership target.\n";
  const scenario = await createScenario("ownership", markdown);
  const before = digestProjectTree(scenario.copy.projectRoot).digest;
  let checks = 0;
  await assert.rejects(
    () =>
      importText(
        scenario,
        createResponse(scenario, {
          new_comments: [
            externalComment(
              scenario,
              "ownership-target",
              selectedAnchor(markdown, "Ownership target.")
            )
          ]
        }),
        IMPORT_ID,
        () => {
          checks += 1;
          if (checks === 3) {
            throw new Error("The project document changed during response import.");
          }
        }
      ),
    /document changed during response import/
  );
  assert.equal(checks, 3);
  assert.equal(digestProjectTree(scenario.copy.projectRoot).digest, before);
}

async function createScenario(name, snapshotMarkdown, currentMarkdown = snapshotMarkdown) {
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
    comment: "Existing exported review comment.",
    thread: [],
    export_state: { focus_state: "in_focus" },
    created_at: "2041-03-01T00:00:00.000Z",
    updated_at: "2041-03-01T00:00:00.000Z"
  };
  await saveProjectState({
    comments: [existingComment],
    markdown: snapshotMarkdown,
    patches: [],
    reviewBatches: [],
    project: loaded.project,
    reason: `v3_fixture:${name}`
  });
  const comments = await readProjectComments(loaded.project);
  const batchId = `review_batch_v3_${String(++scenarioSequence).padStart(3, "0")}`;
  const exported = await createTrackedReviewBatchExport({
    algorithmVersion: null,
    batchId,
    batchType: "manual",
    buildPrompt: (envelope) => ({
      jsonText: `${JSON.stringify({ envelope })}\n`,
      promptText: `Protocol-v3 external-participant fixture prompt.\n${JSON.stringify(envelope)}\n`
    }),
    comments,
    documentGeneration: loaded.project.persistence.generation,
    documentTitle: name,
    markdown: snapshotMarkdown,
    now: "2041-03-02T00:00:00.000Z",
    overLimitWarning: false,
    patches: [],
    project: loaded.project,
    responseProtocolVersion: 3,
    section: null,
    source: "manual"
  });
  assert.equal(exported.batch.response_protocol_version, 3);
  if (currentMarkdown !== snapshotMarkdown) {
    await saveProjectState({
      markdown: currentMarkdown,
      project: loaded.project,
      reason: `v3_document_changed_after_export:${name}`
    });
  }
  return {
    batch: exported.batch,
    copy,
    currentMarkdown,
    identity,
    project: loaded.project
  };
}

async function importText(
  scenario,
  response,
  importId = IMPORT_ID,
  validateBeforeCommit
) {
  return importProjectCommentReplyResponse({
    comments: await readProjectComments(scenario.project),
    expectedProtocolVersion: 3,
    importedAt: IMPORTED_AT,
    importId,
    knownCommentIds: new Set([EXISTING_COMMENT_ID]),
    markdown: scenario.currentMarkdown,
    project: scenario.project,
    responseText: JSON.stringify(response),
    reviewBatches: await listReviewBatches(scenario.project),
    validateBeforeCommit
  });
}

async function importBytes(scenario, response, importId = IMPORT_ID) {
  return importProjectCommentReplyResponseBytes({
    comments: await readProjectComments(scenario.project),
    expectedProtocolVersion: 3,
    importedAt: IMPORTED_AT,
    importId,
    knownCommentIds: new Set([EXISTING_COMMENT_ID]),
    markdown: scenario.currentMarkdown,
    project: scenario.project,
    responseBytes: encoder.encode(JSON.stringify(response)),
    reviewBatches: await listReviewBatches(scenario.project)
  });
}

async function reopenScenario(scenario) {
  return openProjectFolderHandle(new NodeDirectoryHandle(scenario.copy.projectRoot));
}

function createResponse(scenario, overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 3,
    review_batch_id: scenario.batch.batch_id,
    project_id: scenario.identity.projectId,
    document_id: scenario.identity.documentId,
    summary: "Protocol-v3 native import qualification response.",
    new_comments: [],
    replies: [],
    patch_proposals: [],
    open_questions: [],
    ...overrides
  };
}

function externalComment(scenario, localRef, anchor) {
  return {
    local_ref: localRef,
    document_id: scenario.identity.documentId,
    type: "note",
    anchor,
    comment: `External comment ${localRef}.`
  };
}

function selectedAnchor(markdown, selectedText, overrides = {}) {
  const start = markdown.indexOf(selectedText);
  assert.ok(start >= 0);
  return {
    kind: "selected_text",
    selected_text: selectedText,
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    ...overrides
  };
}

function responseCommentTarget(localRef) {
  return { kind: "response_comment", local_ref: localRef };
}

function existingCommentTarget(commentId) {
  return { kind: "existing_comment", comment_id: commentId };
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
    reason: `Qualification reason for ${patchKey}.`,
    reason_sources: [],
    risk: "Qualification-only wording change.",
    risk_sources: [],
    ...overrides
  };
}

function projectSemanticState(result) {
  return {
    comments: result.comments,
    comments_created: result.comments_created,
    open_questions_attached: result.open_questions_attached,
    patches: result.patches,
    patch_proposals_stored: result.patch_proposals_stored,
    replies_attached: result.replies_attached,
    review_batches: result.review_batches.map((batch) => ({
      import_id: batch.import_id,
      response_aggregate: batch.response_analysis?.aggregate,
      status: batch.status
    })),
    warnings: result.warnings
  };
}

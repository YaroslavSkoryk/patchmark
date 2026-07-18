import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyHumanReanchor,
  createDocumentHash,
  createHumanReanchorCandidates,
  createHumanReanchorProposal,
  expandMarkdownRangeForVisibleSelection,
  mapVisibleSelectionToMarkdownRange
} from "../lib/comments/comment-reanchor.ts";
import { resolveCanonicalCommentTarget } from "../lib/comments/canonical-target-resolution.ts";
import {
  createProjectFromMarkdown,
  getProjectPersistenceDebugState,
  resetProjectPersistenceDebugState,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import { NodeDirectoryHandle } from "./lib/node-directory-handle.mjs";

const duplicateMarkdown = [
  "# Growth Plan",
  "",
  "## Demand Generation",
  "Track LINE add conversion weekly.",
  "",
  "## Weekly Metrics",
  "Report LINE add growth and retention."
].join("\n");
const duplicateText = "LINE add";
const firstStart = duplicateMarkdown.indexOf(duplicateText);
const secondStart = duplicateMarkdown.lastIndexOf(duplicateText);
const originalComment = createComment({
  id: "PM-COMMENT-TEST",
  markdownStart: 9999,
  selectedText: duplicateText
});
const ambiguousResolution = resolveCanonicalCommentTarget(originalComment, {
  markdown: duplicateMarkdown
});

assert.equal(ambiguousResolution.state, "ambiguous");
assert.equal(ambiguousResolution.candidates.length, 2);

const duplicateCandidateResolution = {
  ...ambiguousResolution,
  candidates: [
    ambiguousResolution.candidates[0],
    {
      ...ambiguousResolution.candidates[0],
      supportingMethods: ["context"]
    },
    ambiguousResolution.candidates[1]
  ]
};
const candidates = createHumanReanchorCandidates({
  markdown: duplicateMarkdown,
  resolution: duplicateCandidateResolution
});

assert.equal(candidates.length, 2, "canonical ranges must be deduplicated");
assert.deepEqual(
  candidates.map((candidate) => candidate.id),
  [
    `${firstStart}:${firstStart + duplicateText.length}`,
    `${secondStart}:${secondStart + duplicateText.length}`
  ]
);

const secondCandidate = candidates[1];
const proposal = createHumanReanchorProposal({
  documentId: "doc-action-plan",
  documentGeneration: 7,
  markdown: duplicateMarkdown,
  previousAnchor: originalComment.anchor,
  range: secondCandidate.range,
  saveGeneration: 12,
  source: "candidate"
});
const relatedPatches = [
  {
    id: "PM-PATCH-TEST",
    status: "pending",
    comment_id: originalComment.id,
    original_text: "old",
    suggested_text: "new",
    reason: "test",
    created_at: "2026-07-15T00:00:00.000Z"
  }
];
const patchesBefore = JSON.stringify(relatedPatches);
const applied = applyHumanReanchor({
  comment: originalComment,
  currentDocumentId: "doc-action-plan",
  currentDocumentGeneration: 7,
  currentSaveGeneration: 12,
  markdown: duplicateMarkdown,
  patches: relatedPatches,
  proposal,
  timestamp: "2026-07-15T01:00:00.000Z"
});

assert.equal(applied.kind, "applied");
assert.equal(applied.comment.id, originalComment.id);
assert.deepEqual(applied.comment.thread, originalComment.thread);
assert.equal(applied.comment.status, originalComment.status);
assert.equal(applied.comment.anchor.markdown_start_offset, secondStart);
assert.equal(
  duplicateMarkdown.slice(
    applied.comment.anchor.markdown_start_offset,
    applied.comment.anchor.markdown_end_offset
  ),
  applied.comment.anchor.selected_text
);
assert.equal(applied.comment.anchor_history.length, 1);
assert.equal(applied.comment.anchor_history[0].format_version, 2);
assert.equal(applied.comment.anchor_history[0].cause, "human_reanchor");
assert.equal(
  applied.comment.anchor_history[0].reason,
  "anchor_reanchored_by_human"
);
assert.equal(applied.comment.anchor_history[0].mutation_generation, 13);
assert.equal(JSON.stringify(relatedPatches), patchesBefore);
assert.ok(
  JSON.stringify(applied.comment.anchor_history[0]).length < 1800,
  "one human transition must remain concise"
);

const repeated = applyHumanReanchor({
  comment: applied.comment,
  currentDocumentId: "doc-action-plan",
  currentDocumentGeneration: 7,
  currentSaveGeneration: 13,
  markdown: duplicateMarkdown,
  patches: relatedPatches,
  proposal: {
    ...proposal,
    saveGeneration: 13
  },
  timestamp: "2026-07-15T01:01:00.000Z"
});
assert.equal(repeated.kind, "no_op");

const stale = applyHumanReanchor({
  comment: originalComment,
  currentDocumentId: "doc-action-plan",
  currentDocumentGeneration: 8,
  currentSaveGeneration: 12,
  markdown: `${duplicateMarkdown}\nChanged`,
  proposal,
  timestamp: "2026-07-15T01:02:00.000Z"
});
assert.equal(stale.kind, "stale");
assert.match(stale.message, /document changed/i);

const switchedDocument = applyHumanReanchor({
  comment: originalComment,
  currentDocumentId: "doc-ready-to-eat",
  currentDocumentGeneration: 7,
  currentSaveGeneration: 12,
  markdown: duplicateMarkdown,
  proposal,
  timestamp: "2026-07-15T01:02:30.000Z"
});
assert.equal(switchedDocument.kind, "stale");
assert.match(switchedDocument.message, /switched/i);

const resolved = applyHumanReanchor({
  comment: { ...originalComment, status: "resolved" },
  currentDocumentId: "doc-action-plan",
  currentDocumentGeneration: 7,
  currentSaveGeneration: 12,
  markdown: duplicateMarkdown,
  proposal,
  timestamp: "2026-07-15T01:03:00.000Z"
});
assert.equal(resolved.kind, "resolved_comment");

const linkMarkdown =
  "| Brand | Delivery |\n| --- | --- |\n| PAUL | [PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery) |";
const linkLabel = "PAUL Thailand online delivery";
const linkContextStart = linkMarkdown.indexOf("| PAUL");
const linkContext = linkMarkdown.slice(linkContextStart);
const visibleContext = "PAUL PAUL Thailand online delivery";
const visibleStart = visibleContext.lastIndexOf(linkLabel);
const mappedLink = mapVisibleSelectionToMarkdownRange({
  contextMarkdown: linkContext,
  contextStart: linkContextStart,
  selectedVisibleText: linkLabel,
  visibleStart,
  visibleEnd: visibleStart + linkLabel.length
});
const fullLink = `[${linkLabel}](https://www.paulthailand.com/next-day-delivery)`;
assert.ok(mappedLink);
assert.equal(linkMarkdown.slice(mappedLink.start, mappedLink.end), fullLink);
const linkLabelStart = linkMarkdown.indexOf(linkLabel);
const expandedExactLink = expandMarkdownRangeForVisibleSelection({
  markdown: linkMarkdown,
  range: {
    start: linkLabelStart,
    end: linkLabelStart + linkLabel.length
  },
  selectedVisibleText: linkLabel
});
assert.equal(
  linkMarkdown.slice(expandedExactLink.start, expandedExactLink.end),
  fullLink
);

const linkProposal = createHumanReanchorProposal({
  documentId: "doc-action-plan",
  documentGeneration: 1,
  markdown: linkMarkdown,
  previousAnchor: createComment({ selectedText: "missing" }).anchor,
  range: mappedLink,
  saveGeneration: 2,
  source: "visual"
});
assert.equal(linkProposal.anchor.anchor_context.kind, "table_cell");
assert.equal(linkProposal.anchor.anchor_context.table_index, 0);
assert.equal(linkProposal.anchor.anchor_context.table_row_index, 2);
assert.equal(linkProposal.anchor.anchor_context.table_cell_index, 1);

const rowStart = linkMarkdown.indexOf("| PAUL");
const rowProposal = createHumanReanchorProposal({
  documentId: "doc-action-plan",
  documentGeneration: 1,
  markdown: linkMarkdown,
  previousAnchor: createComment({ selectedText: "missing" }).anchor,
  range: { start: rowStart, end: linkMarkdown.length },
  saveGeneration: 2,
  source: "markdown"
});
assert.equal(rowProposal.structureLabel, "Table row");
assert.equal(rowProposal.anchor.anchor_context.table_row_index, 2);
assert.equal(rowProposal.anchor.anchor_context.table_cell_index, undefined);

const multiBlockMarkdown = [
  "# Products",
  "",
  "### Early Cranberries & Walnut signal",
  "",
  "- **Household retail:** evidence",
  "- **Wholesale:** evidence",
  "- **Interpretation:** evidence",
  "",
  "## Next"
].join("\n");
const multiStart = multiBlockMarkdown.indexOf("### Early");
const multiEnd = multiBlockMarkdown.indexOf("\n\n## Next");
const multiProposal = createHumanReanchorProposal({
  documentId: "doc-action-plan",
  documentGeneration: 3,
  markdown: multiBlockMarkdown,
  previousAnchor: createComment({ selectedText: "missing" }).anchor,
  range: { start: multiStart, end: multiEnd },
  saveGeneration: 4,
  source: "markdown"
});
assert.equal(multiProposal.structureLabel, "Multiple blocks");
assert.equal(multiProposal.anchor.anchor_context.kind, "section");
assert.equal(
  multiBlockMarkdown.slice(
    multiProposal.anchor.markdown_start_offset,
    multiProposal.anchor.markdown_end_offset
  ),
  multiProposal.anchor.selected_text
);

assert.equal(proposal.documentHash, createDocumentHash(duplicateMarkdown));

const persistenceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "patchmark-human-reanchor-")
);
globalThis.window = {
  showDirectoryPicker: async () => new NodeDirectoryHandle(persistenceRoot)
};
const createdProject = await createProjectFromMarkdown({
  markdown: duplicateMarkdown,
  suggestedProjectName: "Human Reanchor Test"
});
assert.ok(createdProject);
resetProjectPersistenceDebugState(createdProject.project);
const committed = await saveProjectState({
  comments: [applied.comment],
  project: createdProject.project,
  reason: `human_reanchor:${applied.comment.id}`
});
const persistenceDebug = getProjectPersistenceDebugState(createdProject.project);
assert.equal(committed.status, "committed");
assert.equal(committed.generation, 1);
assert.equal(persistenceDebug.committedGenerations, 1);
const persistedComments = JSON.parse(
  fs.readFileSync(
    path.join(persistenceRoot, ".patchmark", "comments.json"),
    "utf8"
  )
);
assert.equal(persistedComments.length, 1);
assert.equal(persistedComments[0].id, applied.comment.id);
assert.equal(persistedComments[0].anchor.selected_text, duplicateText);
assert.equal(persistedComments[0].anchor_history.length, 1);

resetProjectPersistenceDebugState(createdProject.project);
const noOpDebug = getProjectPersistenceDebugState(createdProject.project);
assert.equal(noOpDebug.serializationCount, 0);
assert.equal(noOpDebug.writeCount, 0);
fs.rmSync(persistenceRoot, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ambiguousCandidates: candidates.length,
      candidateDeduplication: true,
      historyEntries: applied.comment.anchor_history.length,
      oneCommittedGeneration: committed.generation,
      linkSourceMapped: true,
      multiBlockMapped: true,
      noOpSuppressed: true,
      noOpWrites: noOpDebug.writeCount,
      patchIntegrity: JSON.stringify(relatedPatches) === patchesBefore,
      staleGuard: true,
      tableMetadata: true
    },
    null,
    2
  )
);

function createComment({
  id = "PM-COMMENT-FIXTURE",
  markdownStart = 0,
  selectedText
}) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: markdownStart,
      markdown_end_offset: markdownStart + selectedText.length,
      anchor_context: {
        kind: "paragraph",
        plain_text: selectedText,
        markdown_text: selectedText,
        markdown_start_offset: markdownStart,
        markdown_end_offset: markdownStart + selectedText.length,
        selected_start_in_context: 0,
        selected_end_in_context: selectedText.length
      },
      action_context: {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: "note"
      }
    },
    comment: "Fixture comment",
    thread: [
      {
        id: "PM-THREAD-TEST",
        role: "user",
        content: "Keep this thread.",
        created_at: "2026-07-15T00:00:00.000Z"
      }
    ],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

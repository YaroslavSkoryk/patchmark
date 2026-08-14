import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FIXTURE_IDS,
  getProjectFixtureRoot,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-04-01T00:00:00.000Z";

export const COMMENT_RAIL_FIXTURE = Object.freeze({
  documentId: "doc_fixture_atlas",
  lineCommentId: "PM-COMMENT-RAIL-LINE",
  linkedCommentId: "PM-COMMENT-RAIL-LINKED",
  lowerCommentId: "PM-COMMENT-RAIL-LOWER",
  projectId: "prj_fixture_atlas",
  topCommentId: "PM-COMMENT-RAIL-TOP"
});

export function applyCommentRailProject(projectRoot) {
  const root = requireWritableLegacyCopy(projectRoot);
  const paragraphs = Array.from({ length: 48 }, (_, index) =>
    createParagraph(index)
  );
  const markdown = [
    "# Synthetic Signal Garden",
    "",
    ...paragraphs.flatMap((paragraph, index) => [
      ...(index > 0 && index % 8 === 0
        ? [`## Synthetic Relay ${String(index / 8).padStart(2, "0")}`, ""]
        : []),
      paragraph,
      ""
    ])
  ].join("\n");
  const selectedComments = [
    [1, COMMENT_RAIL_FIXTURE.lineCommentId, "note", "Track the violet relay phrase."],
    [4, "PM-COMMENT-RAIL-0004", "note", "Confirm this invented calibration detail."],
    [8, "PM-COMMENT-RAIL-0008", "research_needed", "Check the synthetic lantern sequence."],
    [12, "PM-COMMENT-RAIL-0012", "note", "Keep this fictional signal explicit."],
    [16, "PM-COMMENT-RAIL-0016", "research_needed", "Review the model orbit description."],
    [20, COMMENT_RAIL_FIXTURE.linkedCommentId, "note", "Preserve the linked replacement history."],
    [24, "PM-COMMENT-RAIL-0024", "note", "Retain this invented checkpoint."],
    [28, "PM-COMMENT-RAIL-0028", "research_needed", "Verify the synthetic relay order."],
    [32, "PM-COMMENT-RAIL-0032", "note", "Keep the imaginary steward note."],
    [36, COMMENT_RAIL_FIXTURE.lowerCommentId, "research_needed", "Investigate the lower aurora relay phrase."],
    [40, "PM-COMMENT-RAIL-0040", "note", "Review this fictional garden marker."],
    [44, "PM-COMMENT-RAIL-0044", "research_needed", "Confirm the final synthetic observation."]
  ].map(([paragraphIndex, id, type, comment]) =>
    createSelectedComment({
      comment,
      id,
      markdown,
      selectedText: paragraphs[paragraphIndex],
      type
    })
  );
  const linkedComment = selectedComments.find(
    (comment) => comment.id === COMMENT_RAIL_FIXTURE.linkedCommentId
  );
  linkedComment.anchor_history = [
    {
      changed_at: fixedTimestamp,
      reason: "patch_applied",
      previous_anchor: createSelectedAnchor(
        "A linked draft mapped the glass observatory to an unstable amber ledger.",
        0
      ),
      new_anchor: linkedComment.anchor
    }
  ];
  const comments = [createTopComment(), ...selectedComments];
  const patches = [
    {
      id: "PM-PATCH-RAIL-LINKED",
      status: "accepted",
      comment_id: COMMENT_RAIL_FIXTURE.linkedCommentId,
      original_text:
        "A linked draft mapped the glass observatory to an unstable amber ledger.",
      suggested_text: paragraphs[20],
      applied_text: paragraphs[20],
      applied_start_offset: markdown.indexOf(paragraphs[20]),
      applied_end_offset: markdown.indexOf(paragraphs[20]) + paragraphs[20].length,
      reason: "Keep the synthetic replacement linked to its discussion.",
      created_at: fixedTimestamp,
      accepted_at: fixedTimestamp,
      applied_at: fixedTimestamp
    }
  ];

  writeProjectFixtureText(root, "document.md", markdown);
  writeProjectFixtureJson(root, ".patchmark/comments.json", comments);
  writeProjectFixtureJson(root, ".patchmark/patches.json", patches);

  return {
    ...COMMENT_RAIL_FIXTURE,
    commentCount: comments.length,
    documentBytes: Buffer.byteLength(markdown),
    lowerSelectedText: paragraphs[36],
    markdown,
    selectedCommentCount: selectedComments.length
  };
}

function createParagraph(index) {
  const ordinal = String(index + 1).padStart(2, "0");

  if (index === 1) {
    return "A violet relay signal crosses the invented garden while brass markers remain still.";
  }
  if (index === 20) {
    return "A linked replacement now maps the glass observatory to a stable violet ledger.";
  }
  if (index === 36) {
    return "The lower aurora relay phrase identifies a distant synthetic checkpoint for review.";
  }

  return `Synthetic observation ${ordinal} records an imaginary lantern, a clockwork seed, and a quiet orbital marker for deterministic layout review.`;
}

function createTopComment() {
  return {
    id: COMMENT_RAIL_FIXTURE.topCommentId,
    type: "research_needed",
    status: "resolved",
    anchor: { kind: "document" },
    comment: "Review the complete synthetic signal garden.",
    thread: Array.from({ length: 11 }, (_, index) => ({
      id: `PM-THREAD-RAIL-${String(index + 1).padStart(2, "0")}`,
      role: index % 2 === 0 ? "user" : "chatgpt",
      content: `Synthetic rail discussion entry ${index + 1}.`,
      created_at: fixedTimestamp
    })),
    export_state: { focus_state: "idle" },
    created_at: fixedTimestamp,
    updated_at: fixedTimestamp,
    resolved_at: fixedTimestamp
  };
}

function createSelectedComment({ comment, id, markdown, selectedText, type }) {
  return {
    id,
    type,
    status: "open",
    anchor: createSelectedAnchor(selectedText, markdown.indexOf(selectedText)),
    comment,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: fixedTimestamp,
    updated_at: fixedTimestamp
  };
}

function createSelectedAnchor(selectedText, start) {
  return {
    kind: "selected_text",
    selected_text: selectedText,
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    anchor_source: "markdown"
  };
}

function requireWritableLegacyCopy(projectRoot) {
  const root = realpathSync(projectRoot);
  const source = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);

  if (root === source) {
    throw new Error("Comment rail state must be applied to a fresh fixture copy.");
  }

  const manifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  if (
    manifest.project_id !== COMMENT_RAIL_FIXTURE.projectId ||
    manifest.document_id !== COMMENT_RAIL_FIXTURE.documentId
  ) {
    throw new Error("Comment rail state requires the legacy schema core.");
  }

  return root;
}

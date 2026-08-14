import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FIXTURE_IDS,
  getProjectFixtureRoot,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-06-01T00:00:00.000Z";

export const COMMENT_EDIT_FIXTURE = Object.freeze({
  documentId: "doc_fixture_atlas",
  projectId: "prj_fixture_atlas",
  replacementComment: "Edited synthetic comment content persisted exactly.",
  targetCommentId: "PM-COMMENT-EDIT-PRIMARY",
  unrelatedCommentId: "PM-COMMENT-EDIT-UNRELATED"
});

export function applyCommentEditProject(projectRoot, options = {}) {
  const root = requireWritableLegacyCopy(projectRoot);
  const paragraphCount = validateCount(
    "paragraphCount",
    options.paragraphCount ?? 48,
    12,
    500
  );
  const commentCount = validateCount(
    "commentCount",
    options.commentCount ?? 12,
    2,
    Math.min(100, paragraphCount)
  );
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) =>
    `Synthetic edit paragraph ${String(index + 1).padStart(3, "0")} keeps an invented amber beacon and a quiet glass compass available for deterministic anchor checks.`
  );
  const tableRows = Array.from(
    { length: 8 },
    (_, index) => `| Relay ${String(index + 1).padStart(2, "0")} | Stable |`
  );
  const markdown = [
    "# Synthetic Comment Edit Laboratory",
    "",
    "## Purpose.",
    "",
    ...paragraphs.slice(0, Math.ceil(paragraphCount / 2)).flatMap((paragraph) => [paragraph, ""]),
    "## Working principle.",
    "",
    ...paragraphs.slice(Math.ceil(paragraphCount / 2)).flatMap((paragraph) => [paragraph, ""]),
    "## Relay Table",
    "",
    "| Signal | State |",
    "| --- | --- |",
    ...tableRows,
    "",
    "## Source Notes",
    "",
    "All source notes are invented for deterministic local testing.",
    ""
  ].join("\n");
  const comments = paragraphs.slice(0, commentCount).map((selectedText, index) => {
    const start = markdown.indexOf(selectedText);
    const id =
      index === 0
        ? COMMENT_EDIT_FIXTURE.targetCommentId
        : index === 1
          ? COMMENT_EDIT_FIXTURE.unrelatedCommentId
          : `PM-COMMENT-EDIT-${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      type: index === 1 ? "research_needed" : "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_source: "markdown"
      },
      comment:
        index === 0
          ? "Original synthetic comment content."
          : `Unrelated synthetic comment ${index + 1}.`,
      thread:
        index === 0
          ? [
              {
                id: "PM-THREAD-EDIT-PRIMARY-01",
                role: "chatgpt",
                content: "Synthetic assistant context remains unchanged.",
                created_at: fixedTimestamp
              },
              {
                id: "PM-THREAD-EDIT-PRIMARY-02",
                role: "user",
                content: "Synthetic user reply remains unchanged.",
                created_at: fixedTimestamp
              }
            ]
          : index === 1
            ? [
                {
                  id: "PM-THREAD-EDIT-UNRELATED-01",
                  role: "user",
                  content: "Unrelated synthetic thread state.",
                  created_at: fixedTimestamp
                }
              ]
            : [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    };
  });

  writeProjectFixtureText(root, "document.md", markdown);
  writeProjectFixtureJson(root, ".patchmark/comments.json", comments);
  writeProjectFixtureJson(root, ".patchmark/patches.json", []);

  return {
    ...COMMENT_EDIT_FIXTURE,
    commentCount: comments.length,
    documentBytes: Buffer.byteLength(markdown),
    markdown,
    paragraphCount,
    tableRowCount: tableRows.length
  };
}

function requireWritableLegacyCopy(projectRoot) {
  const root = realpathSync(projectRoot);
  const source = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);

  if (root === source) {
    throw new Error("Comment edit state must be applied to a fresh fixture copy.");
  }

  const manifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  if (
    manifest.project_id !== COMMENT_EDIT_FIXTURE.projectId ||
    manifest.document_id !== COMMENT_EDIT_FIXTURE.documentId
  ) {
    throw new Error("Comment edit state requires the legacy schema core.");
  }

  return root;
}

function validateCount(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

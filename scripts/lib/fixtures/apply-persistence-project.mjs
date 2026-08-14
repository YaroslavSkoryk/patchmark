import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FIXTURE_IDS,
  getProjectFixtureRoot,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-05-01T00:00:00.000Z";

export const PERSISTENCE_FIXTURE = Object.freeze({
  documentId: "doc_fixture_atlas",
  primaryCommentId: "PM-COMMENT-PERSIST-PRIMARY",
  projectId: "prj_fixture_atlas"
});

export function applyPersistenceProject(projectRoot) {
  const root = requireWritableLegacyCopy(projectRoot);
  const paragraphs = Array.from({ length: 8 }, (_, index) =>
    `Synthetic persistence paragraph ${index + 1} records a fixed lantern state for save and reopen validation.`
  );
  const markdown = [
    "# Synthetic Persistence Observatory",
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""])
  ].join("\n");
  const comments = paragraphs.slice(0, 5).map((selectedText, index) => {
    const start = markdown.indexOf(selectedText);
    return {
      id:
        index === 0
          ? PERSISTENCE_FIXTURE.primaryCommentId
          : `PM-COMMENT-PERSIST-${String(index + 1).padStart(2, "0")}`,
      type: index === 1 ? "research_needed" : "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_source: "markdown"
      },
      comment: `Synthetic persistence comment ${index + 1}.`,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    };
  });
  const primaryText = paragraphs[0];
  const patches = [
    {
      id: "PM-PATCH-PERSIST-PRIMARY",
      status: "pending",
      comment_id: PERSISTENCE_FIXTURE.primaryCommentId,
      original_text: primaryText,
      suggested_text: `${primaryText} The persisted observation remains explicit.`,
      reason: "Exercise deterministic patch review without changing fixture identity.",
      created_at: fixedTimestamp
    }
  ];

  writeProjectFixtureText(root, "document.md", markdown);
  writeProjectFixtureJson(root, ".patchmark/comments.json", comments);
  writeProjectFixtureJson(root, ".patchmark/patches.json", patches);

  return {
    ...PERSISTENCE_FIXTURE,
    commentCount: comments.length,
    editUnit: "xy",
    markdown,
    patchCount: patches.length
  };
}

function requireWritableLegacyCopy(projectRoot) {
  const root = realpathSync(projectRoot);
  const source = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);

  if (root === source) {
    throw new Error("Persistence state must be applied to a fresh fixture copy.");
  }

  const manifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  if (
    manifest.project_id !== PERSISTENCE_FIXTURE.projectId ||
    manifest.document_id !== PERSISTENCE_FIXTURE.documentId
  ) {
    throw new Error("Persistence state requires the legacy schema core.");
  }

  return root;
}

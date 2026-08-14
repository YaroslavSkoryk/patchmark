import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FIXTURE_IDS,
  getProjectFixtureRoot,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-08-01T10:00:00.000Z";

export const PDF_EXPORT_FIXTURE = Object.freeze({
  activeCommentId: "PM-COMMENT-PDF-ACTIVE",
  activeDocumentSentinel: "ACTIVE PDF SENTINEL",
  commentOnlySentinel: "COMMENT ONLY PDF SENTINEL",
  documentId: "doc_fixture_atlas",
  fileName: "document.md",
  finalSentinel: "FINAL PDF SENTINEL",
  projectId: "prj_fixture_atlas",
  staleHistorySentinel: "STALE HISTORY PDF SENTINEL",
  suggestedName: "document.shareholder-clean.pdf",
  title: "Synthetic Indigo Ledger",
  versionId: "PM-VERSION-PDF-STALE"
});

export function applyPdfExportProject(projectRoot) {
  const root = requireWritableLegacyCopy(projectRoot);
  const selectedText =
    "The active indigo ledger belongs to the current document export only.";
  const paginationParagraphs = Array.from({ length: 14 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return `Evidence line ${ordinal} keeps the invented indigo, amber, and cobalt signals in a stable reading order for print pagination.`;
  });
  const currentMarkdown = [
    `# ${PDF_EXPORT_FIXTURE.title}`,
    "",
    PDF_EXPORT_FIXTURE.activeDocumentSentinel,
    "",
    selectedText,
    "",
    "## Export Scope",
    "",
    "This compact synthetic dossier verifies the active in-memory document at the browser print boundary.",
    "",
    "- Current document: indigo ledger",
    "- Print orientation: portrait",
    "- Output boundary: browser PDF",
    "",
    "The [invented export reference](https://example.invalid/patchmark-pdf-fixture) is deliberately non-private.",
    "",
    "## Structured Signals",
    "",
    "| Signal | State | Exact note |",
    "| --- | --- | --- |",
    "| Indigo | Active | Current document sentinel |",
    "| Amber | Ready | Stable table rendering |",
    "| Cobalt | Closed | No application chrome |",
    "| Silver | Idle | No history preview leak |",
    "",
    "## Pagination Evidence",
    "",
    ...paginationParagraphs.flatMap((paragraph) => [paragraph, ""]),
    "## Final Verification",
    "",
    "```text",
    "export_scope=current_in_memory_markdown",
    "project_mutation=none",
    "```",
    "",
    PDF_EXPORT_FIXTURE.finalSentinel
  ].join("\n");
  const staleMarkdown = [
    "# Synthetic Stale Export Snapshot",
    "",
    PDF_EXPORT_FIXTURE.staleHistorySentinel,
    "",
    "This invented historical state must never leak into the active PDF."
  ].join("\n");
  const versionFile = ".patchmark/versions/pm-pdf-stale.md";
  const originalManifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );

  writeProjectFixtureText(root, PDF_EXPORT_FIXTURE.fileName, currentMarkdown);
  writeProjectFixtureText(root, versionFile, staleMarkdown);
  writeProjectFixtureJson(root, ".patchmark/comments.json", [
    {
      id: PDF_EXPORT_FIXTURE.activeCommentId,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: currentMarkdown.indexOf(selectedText),
        markdown_end_offset:
          currentMarkdown.indexOf(selectedText) + selectedText.length,
        anchor_source: "markdown"
      },
      comment: PDF_EXPORT_FIXTURE.commentOnlySentinel,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    }
  ]);
  writeProjectFixtureJson(root, ".patchmark/manifest.json", {
    ...originalManifest,
    updated_at: fixedTimestamp,
    current_version: PDF_EXPORT_FIXTURE.versionId,
    versions: [
      {
        id: PDF_EXPORT_FIXTURE.versionId,
        file: versionFile,
        created_at: "2040-08-01T09:00:00.000Z",
        reason: "Synthetic stale export checkpoint",
        content_hash: createHash("sha256").update(staleMarkdown).digest("hex")
      }
    ]
  });

  return {
    ...PDF_EXPORT_FIXTURE,
    commentCount: 1,
    currentMarkdown,
    selectedText,
    staleMarkdown,
    versionFile
  };
}

function requireWritableLegacyCopy(projectRoot) {
  const root = realpathSync(projectRoot);
  const source = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);

  if (root === source) {
    throw new Error("PDF export state must be applied to a fresh fixture copy.");
  }

  const manifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  if (
    manifest.project_id !== PDF_EXPORT_FIXTURE.projectId ||
    manifest.document_id !== PDF_EXPORT_FIXTURE.documentId
  ) {
    throw new Error("PDF export state requires the legacy schema core.");
  }

  return root;
}

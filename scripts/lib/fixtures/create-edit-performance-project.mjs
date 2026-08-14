import { Buffer } from "node:buffer";
import {
  createFixtureSeedToken,
  prepareProjectFixtureDestination,
  validateFixtureInteger,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-02-01T00:00:00.000Z";

export function createEditPerformanceProject(destinationRoot, options = {}) {
  const paragraphCount = validateFixtureInteger(
    "paragraphCount",
    options.paragraphCount ?? 80,
    { min: 1, max: 2_000 }
  );
  const commentCount = validateFixtureInteger(
    "commentCount",
    options.commentCount ?? Math.min(24, paragraphCount),
    { min: 1, max: 500 }
  );
  const tableRowCount = validateFixtureInteger(
    "tableRowCount",
    options.tableRowCount ?? 12,
    { min: 1, max: 500 }
  );
  if (commentCount > paragraphCount) {
    throw new Error("commentCount must not exceed paragraphCount.");
  }
  const seed = options.seed ?? "patchmark-edit-performance-v1";
  const token = createFixtureSeedToken(seed);
  const root = prepareProjectFixtureDestination(destinationRoot);
  const projectId = `prj_edit_${token}`;
  const documentId = `doc_edit_${token}`;
  const documentPath = "edit-workbench.md";
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) =>
    createParagraph(token, index)
  );
  const markdown = createMarkdown({ paragraphs, tableRowCount, token });
  const comments = paragraphs.slice(0, commentCount).map((selectedText, index) => {
    const start = markdown.indexOf(selectedText);
    return {
      id: `PM-COMMENT-EDIT-${String(index + 1).padStart(4, "0")}`,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_source: "markdown"
      },
      comment: `Synthetic edit measurement anchor ${index + 1}.`,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    };
  });

  writeProjectFixtureText(root, documentPath, markdown);
  writeProjectFixtureJson(root, ".patchmark/project.json", {
    format: "patchmark-project",
    schema_version: 2,
    project_id: projectId,
    title: "Synthetic Edit Observatory",
    created_at: fixedTimestamp,
    manifest_revision: 1,
    groups: [
      {
        group_id: "group_edit_measurement",
        title: "Measurement",
        position: 1000,
        created_at: fixedTimestamp
      }
    ],
    documents: [
      {
        document_id: documentId,
        path: documentPath,
        display_title: "Synthetic Edit Workbench",
        group_id: "group_edit_measurement",
        role: "evidence",
        status: "active",
        position: 1000,
        added_at: fixedTimestamp,
        archived_at: null
      }
    ]
  });
  const store = `.patchmark/documents/${documentId}`;
  writeProjectFixtureJson(root, `${store}/document.json`, {
    format: "patchmark-document-store",
    schema_version: 1,
    document_id: documentId,
    created_at: fixedTimestamp,
    source: "created"
  });
  writeProjectFixtureJson(root, `${store}/manifest.json`, {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: "Synthetic Edit Observatory",
    document_file: "document.md",
    created_at: fixedTimestamp,
    updated_at: fixedTimestamp
  });
  writeProjectFixtureJson(root, `${store}/comments.json`, comments);
  writeProjectFixtureJson(root, `${store}/patches.json`, []);

  return {
    commentCount,
    documentBytes: Buffer.byteLength(markdown),
    documentId,
    paragraphCount,
    projectId,
    seedToken: token,
    tableRowCount
  };
}

function createMarkdown({ paragraphs, tableRowCount, token }) {
  return [
    "# Synthetic Edit Workbench",
    "",
    "## Deterministic markers",
    "",
    "Orbital purpose marker.",
    "",
    "Lantern working marker.",
    "",
    "Synthetic source notes marker.",
    "",
    "## Generated calibration paragraphs",
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    "## Generated signal table",
    "",
    "| Signal | Reading | Token |",
    "| --- | ---: | --- |",
    ...Array.from({ length: tableRowCount }, (_, index) =>
      `| Signal ${String(index + 1).padStart(3, "0")} | ${index + 10} | ${token}-${String(index + 1).padStart(3, "0")} |`
    ),
    ""
  ].join("\n");
}

function createParagraph(token, index) {
  const number = String(index + 1).padStart(4, "0");
  return `Calibration paragraph ${number} for synthetic seed ${token} keeps one stable anchor sentence for repeatable edit measurements.`;
}

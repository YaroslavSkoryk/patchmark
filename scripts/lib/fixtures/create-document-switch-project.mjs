import { Buffer } from "node:buffer";
import {
  createFixtureSeedToken,
  prepareProjectFixtureDestination,
  validateFixtureInteger,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-03-01T00:00:00.000Z";

export function createDocumentSwitchProject(destinationRoot, options = {}) {
  const documentCount = validateFixtureInteger(
    "documentCount",
    options.documentCount ?? 3,
    { min: 2, max: 12 }
  );
  const paragraphCountPerDocument = validateFixtureInteger(
    "paragraphCountPerDocument",
    options.paragraphCountPerDocument ?? 60,
    { min: 1, max: 2_000 }
  );
  const commentCountPerDocument = validateFixtureInteger(
    "commentCountPerDocument",
    options.commentCountPerDocument ?? Math.min(20, paragraphCountPerDocument),
    { min: 0, max: 500 }
  );
  const patchCountPerDocument = validateFixtureInteger(
    "patchCountPerDocument",
    options.patchCountPerDocument ?? 30,
    { min: 0, max: 1_000 }
  );
  const historyCountPerDocument = validateFixtureInteger(
    "historyCountPerDocument",
    options.historyCountPerDocument ?? 8,
    { min: 0, max: 100 }
  );
  if (commentCountPerDocument > paragraphCountPerDocument) {
    throw new Error(
      "commentCountPerDocument must not exceed paragraphCountPerDocument."
    );
  }
  const seed = options.seed ?? "patchmark-document-switch-v1";
  const token = createFixtureSeedToken(seed);
  const root = prepareProjectFixtureDestination(destinationRoot);
  const projectId = `prj_switch_${token}`;
  const documents = [];

  for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
    const ordinal = String(documentIndex + 1).padStart(2, "0");
    const documentId = `doc_switch_${ordinal}_${token}`;
    const documentPath = `switch-document-${ordinal}.md`;
    const displayTitle = `Synthetic Switch Document ${ordinal}`;
    const paragraphs = Array.from(
      { length: paragraphCountPerDocument },
      (_, paragraphIndex) => createParagraph(token, documentIndex, paragraphIndex)
    );
    const markdown = createMarkdown(displayTitle, paragraphs);
    const comments = createComments({
      commentCount: commentCountPerDocument,
      documentIndex,
      markdown,
      paragraphs
    });
    const patches = createPatches({
      comments,
      documentIndex,
      paragraphs,
      patchCount: patchCountPerDocument
    });
    const versions = Array.from(
      { length: historyCountPerDocument },
      (_, historyIndex) => {
        const snapshotId = `PM-SNAPSHOT-SWITCH-${ordinal}-${String(historyIndex + 1).padStart(3, "0")}`;
        const file = `.patchmark/versions/${snapshotId}.md`;
        return {
          id: snapshotId,
          file,
          created_at: fixedTimestamp,
          reason: `Synthetic switch snapshot ${historyIndex + 1}`
        };
      }
    );
    const store = `.patchmark/documents/${documentId}`;

    writeProjectFixtureText(root, documentPath, markdown);
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
      project_name: "Synthetic Switch Constellation",
      document_file: "document.md",
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp,
      ...(versions.length > 0
        ? { current_version: versions.at(-1).id, versions }
        : {})
    });
    writeProjectFixtureJson(root, `${store}/comments.json`, comments);
    writeProjectFixtureJson(root, `${store}/patches.json`, patches);
    for (let historyIndex = 0; historyIndex < versions.length; historyIndex += 1) {
      const snapshot = versions[historyIndex];
      writeProjectFixtureText(
        root,
        `${store}/versions/${snapshot.id}.md`,
        `${markdown}\nHistorical synthetic reading ${historyIndex + 1}.\n`
      );
    }
    documents.push({
      bytes: Buffer.byteLength(markdown),
      commentCount: comments.length,
      displayTitle,
      documentId,
      historyCount: versions.length,
      patchCount: patches.length,
      path: documentPath
    });
  }

  writeProjectFixtureJson(root, ".patchmark/project.json", {
    format: "patchmark-project",
    schema_version: 2,
    project_id: projectId,
    title: "Synthetic Switch Constellation",
    created_at: fixedTimestamp,
    manifest_revision: 1,
    groups: [
      {
        group_id: "group_switch_even",
        title: "Even Orbits",
        position: 1000,
        created_at: fixedTimestamp
      },
      {
        group_id: "group_switch_odd",
        title: "Odd Orbits",
        position: 2000,
        created_at: fixedTimestamp
      }
    ],
    documents: documents.map((document, index) => ({
      document_id: document.documentId,
      path: document.path,
      display_title: document.displayTitle,
      group_id: index % 2 === 0 ? "group_switch_odd" : "group_switch_even",
      role: index % 2 === 0 ? "research" : "summary",
      status: "active",
      position: (index + 1) * 1000,
      added_at: fixedTimestamp,
      archived_at: null
    }))
  });

  return {
    commentCountPerDocument,
    documentCount,
    documents,
    historyCountPerDocument,
    paragraphCountPerDocument,
    patchCountPerDocument,
    projectId,
    seedToken: token
  };
}

function createMarkdown(displayTitle, paragraphs) {
  return [
    `# ${displayTitle}`,
    "",
    "## Generated relay notes",
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""])
  ].join("\n");
}

function createParagraph(token, documentIndex, paragraphIndex) {
  const documentNumber = String(documentIndex + 1).padStart(2, "0");
  const paragraphNumber = String(paragraphIndex + 1).padStart(4, "0");
  return `Relay paragraph ${documentNumber}-${paragraphNumber} for synthetic seed ${token} carries a unique formulaic signal between fictional observatories.`;
}

function createComments({ commentCount, documentIndex, markdown, paragraphs }) {
  return paragraphs.slice(0, commentCount).map((selectedText, commentIndex) => {
    const start = markdown.indexOf(selectedText);
    return {
      id: `PM-COMMENT-SWITCH-${String(documentIndex + 1).padStart(2, "0")}-${String(commentIndex + 1).padStart(4, "0")}`,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_source: "markdown"
      },
      comment: `Synthetic switch anchor ${commentIndex + 1}.`,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    };
  });
}

function createPatches({ comments, documentIndex, paragraphs, patchCount }) {
  return Array.from({ length: patchCount }, (_, patchIndex) => ({
    id: `PM-PATCH-SWITCH-${String(documentIndex + 1).padStart(2, "0")}-${String(patchIndex + 1).padStart(4, "0")}`,
    status: "pending",
    ...(comments.length > 0
      ? { comment_id: comments[patchIndex % comments.length].id }
      : {}),
    display_title: `Synthetic relay adjustment ${patchIndex + 1}`,
    original_text: paragraphs[patchIndex % paragraphs.length],
    suggested_text: `${paragraphs[patchIndex % paragraphs.length]} Proposed synthetic adjustment ${patchIndex + 1}.`,
    reason: "Exercise deterministic document-switch patch loading.",
    created_at: fixedTimestamp
  }));
}

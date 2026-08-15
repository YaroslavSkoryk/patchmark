import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  createFixtureSeedToken,
  prepareProjectFixtureDestination,
  validateFixtureInteger,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-03-01T00:00:00.000Z";
const fixedSaveGeneration = 7;

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
  const paragraphRepeatCount = validateFixtureInteger(
    "paragraphRepeatCount",
    options.paragraphRepeatCount ?? 1,
    { min: 1, max: 20 }
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
  const documentProfiles = options.documentProfiles ?? [];
  if (
    !Array.isArray(documentProfiles) ||
    documentProfiles.length > documentCount
  ) {
    throw new Error(
      "documentProfiles must be an array no longer than documentCount."
    );
  }
  const includeMissingDocument = options.includeMissingDocument === true;
  const bookmarkDocumentIndex =
    options.bookmarkDocumentIndex === undefined
      ? null
      : validateFixtureInteger(
          "bookmarkDocumentIndex",
          options.bookmarkDocumentIndex,
          { min: 0, max: documentCount - 1 }
        );
  const seed = options.seed ?? "patchmark-document-switch-v1";
  const token = createFixtureSeedToken(seed);
  const root = prepareProjectFixtureDestination(destinationRoot);
  const projectId = `prj_switch_${token}`;
  const projectTitle = "Synthetic Switch Constellation";
  const groups = [
    {
      groupId: "group_switch_even",
      title: "Even Orbits",
      position: 1000
    },
    {
      groupId: "group_switch_odd",
      title: "Odd Orbits",
      position: 2000
    }
  ];
  const documents = [];

  for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
    const profile = resolveDocumentProfile(
      documentIndex,
      documentProfiles[documentIndex],
      {
        commentCount: commentCountPerDocument,
        historyCount: historyCountPerDocument,
        paragraphCount: paragraphCountPerDocument,
        paragraphRepeatCount,
        patchCount: patchCountPerDocument
      }
    );
    documents.push(
      createDocumentStore({
        codeBlockCount: profile.codeBlockCount,
        commentCount: profile.commentCount,
        displayTitle: createDisplayTitle(documentIndex),
        documentId: createDocumentId(documentIndex, token),
        documentIndex,
        groupId: groups[documentIndex % 2 === 0 ? 1 : 0].groupId,
        headingCount: profile.headingCount,
        historyCount: profile.historyCount,
        paragraphCount: profile.paragraphCount,
        paragraphRepeatCount: profile.paragraphRepeatCount,
        patchCount: profile.patchCount,
        path: createDocumentPath(documentIndex),
        position: (documentIndex + 1) * 1000,
        projectId,
        projectTitle,
        root,
        structuredCellRepeatCount: profile.structuredCellRepeatCount,
        structuredTableCount: profile.structuredTableCount,
        structuredTableRowsPerTable: profile.structuredTableRowsPerTable,
        withBookmark: documentIndex === bookmarkDocumentIndex,
        writeMarkdown: true
      })
    );
  }

  const missingDocument = includeMissingDocument
    ? createDocumentStore({
        codeBlockCount: 0,
        commentCount: 0,
        displayTitle: "Synthetic Missing Appendix",
        documentId: `doc_switch_missing_${token}`,
        documentIndex: documentCount,
        groupId: groups[0].groupId,
        headingCount: 1,
        historyCount: 0,
        paragraphCount: 1,
        paragraphRepeatCount: 1,
        patchCount: 0,
        path: "synthetic-missing-appendix.md",
        position: (documentCount + 1) * 1000,
        projectId,
        projectTitle,
        root,
        structuredCellRepeatCount: 1,
        structuredTableCount: 0,
        structuredTableRowsPerTable: 1,
        withBookmark: false,
        writeMarkdown: false
      })
    : null;

  writeProjectFixtureJson(root, ".patchmark/project.json", {
    format: "patchmark-project",
    schema_version: 2,
    project_id: projectId,
    title: projectTitle,
    created_at: fixedTimestamp,
    manifest_revision: 1,
    groups: groups.map((group) => ({
      group_id: group.groupId,
      title: group.title,
      position: group.position,
      created_at: fixedTimestamp
    })),
    documents: [...documents, ...(missingDocument ? [missingDocument] : [])].map(
      (document) => document.registry
    )
  });

  const bookmarkDocument =
    bookmarkDocumentIndex === null ? null : documents[bookmarkDocumentIndex];
  return {
    bookmarkDocumentId: bookmarkDocument?.documentId ?? null,
    bookmarkGroupTitle:
      groups.find((group) => group.groupId === bookmarkDocument?.groupId)?.title ??
      null,
    commentCountPerDocument,
    documentCount,
    documents,
    historyCountPerDocument,
    missingDocument,
    paragraphCountPerDocument,
    paragraphRepeatCount,
    patchCountPerDocument,
    projectId,
    projectTitle,
    seedToken: token
  };
}

function resolveDocumentProfile(documentIndex, profile, defaults) {
  if (
    profile !== undefined &&
    (profile === null || typeof profile !== "object" || Array.isArray(profile))
  ) {
    throw new Error(`documentProfiles[${documentIndex}] must be an object.`);
  }
  const value = profile ?? {};
  const paragraphCount = validateFixtureInteger(
    `documentProfiles[${documentIndex}].paragraphCount`,
    value.paragraphCount ?? defaults.paragraphCount,
    { min: 1, max: 2_000 }
  );
  const commentCount = validateFixtureInteger(
    `documentProfiles[${documentIndex}].commentCount`,
    value.commentCount ?? defaults.commentCount,
    { min: 0, max: 500 }
  );
  if (commentCount > paragraphCount) {
    throw new Error(
      `documentProfiles[${documentIndex}].commentCount must not exceed paragraphCount.`
    );
  }
  return {
    codeBlockCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].codeBlockCount`,
      value.codeBlockCount ?? 0,
      { min: 0, max: 200 }
    ),
    commentCount,
    headingCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].headingCount`,
      value.headingCount ?? 2,
      { min: 1, max: Math.min(100, paragraphCount + 1) }
    ),
    historyCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].historyCount`,
      value.historyCount ?? defaults.historyCount,
      { min: 0, max: 100 }
    ),
    paragraphCount,
    paragraphRepeatCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].paragraphRepeatCount`,
      value.paragraphRepeatCount ?? defaults.paragraphRepeatCount,
      { min: 1, max: 20 }
    ),
    structuredCellRepeatCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].structuredCellRepeatCount`,
      value.structuredCellRepeatCount ?? 1,
      { min: 1, max: 20 }
    ),
    structuredTableCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].structuredTableCount`,
      value.structuredTableCount ?? 0,
      { min: 0, max: 60 }
    ),
    structuredTableRowsPerTable: validateFixtureInteger(
      `documentProfiles[${documentIndex}].structuredTableRowsPerTable`,
      value.structuredTableRowsPerTable ?? 1,
      { min: 1, max: 40 }
    ),
    patchCount: validateFixtureInteger(
      `documentProfiles[${documentIndex}].patchCount`,
      value.patchCount ?? defaults.patchCount,
      { min: 0, max: 1_000 }
    )
  };
}

function createDocumentStore({
  codeBlockCount,
  commentCount,
  displayTitle,
  documentId,
  documentIndex,
  groupId,
  headingCount,
  historyCount,
  paragraphCount,
  paragraphRepeatCount,
  patchCount,
  path,
  position,
  projectId,
  projectTitle,
  root,
  structuredCellRepeatCount,
  structuredTableCount,
  structuredTableRowsPerTable,
  withBookmark,
  writeMarkdown
}) {
  const paragraphs = Array.from({ length: paragraphCount }, (_, paragraphIndex) =>
    createParagraph(tokenFor(documentId), documentIndex, paragraphIndex, paragraphRepeatCount)
  );
  const markdown = createMarkdown(displayTitle, paragraphs, headingCount, {
    codeBlockCount,
    documentIndex,
    structuredCellRepeatCount,
    structuredTableCount,
    structuredTableRowsPerTable
  });
  const comments = createComments({
    commentCount,
    documentIndex,
    markdown,
    paragraphs
  });
  const patches = createPatches({
    comments,
    documentIndex,
    paragraphs,
    patchCount
  });
  const versions = Array.from({ length: historyCount }, (_, historyIndex) => {
    const snapshotId = `PM-SNAPSHOT-SWITCH-${String(documentIndex + 1).padStart(2, "0")}-${String(historyIndex + 1).padStart(3, "0")}`;
    return {
      id: snapshotId,
      file: `.patchmark/versions/${snapshotId}.md`,
      created_at: fixedTimestamp,
      reason: `Synthetic switch snapshot ${historyIndex + 1}`
    };
  });
  const store = `.patchmark/documents/${documentId}`;
  const commitId = `PM-SAVE-SWITCH-${String(documentIndex + 1).padStart(2, "0")}`;
  const bookmarkText = paragraphs[Math.min(4, paragraphs.length - 1)].selectedText;
  const manifest = {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: projectTitle,
    document_file: "document.md",
    created_at: fixedTimestamp,
    updated_at: fixedTimestamp,
    ...(versions.length > 0
      ? { current_version: versions.at(-1).id, versions }
      : {}),
    save_generation: fixedSaveGeneration,
    save_commit_id: commitId,
    ...(withBookmark
      ? {
          reading_bookmark: {
            format_version: 1,
            document: { project_id: projectId, document_id: documentId },
            anchor: {
              kind: "selected_text",
              selected_text: bookmarkText,
              markdown_start_offset: markdown.indexOf(bookmarkText),
              markdown_end_offset:
                markdown.indexOf(bookmarkText) + bookmarkText.length,
              anchor_source: "markdown"
            },
            created_at: fixedTimestamp,
            updated_at: fixedTimestamp
          }
        }
      : {})
  };
  const commentsText = serializeJson(comments);
  const patchesText = serializeJson(patches);
  const manifestText = serializeJson(manifest);

  if (writeMarkdown) {
    writeProjectFixtureText(root, path, markdown);
  }
  writeProjectFixtureJson(root, `${store}/document.json`, {
    format: "patchmark-document-store",
    schema_version: 1,
    document_id: documentId,
    created_at: fixedTimestamp,
    source: "created"
  });
  writeProjectFixtureText(root, `${store}/manifest.json`, manifestText);
  writeProjectFixtureText(root, `${store}/comments.json`, commentsText);
  writeProjectFixtureText(root, `${store}/patches.json`, patchesText);
  writeProjectFixtureJson(root, `${store}/tasks.json`, []);
  for (let historyIndex = 0; historyIndex < versions.length; historyIndex += 1) {
    writeProjectFixtureText(
      root,
      `${store}/versions/${versions[historyIndex].id}.md`,
      `${markdown}\nHistorical synthetic reading ${historyIndex + 1}.\n`
    );
  }
  writeProjectFixtureJson(root, `${store}/save-commit.json`, {
    format_version: 1,
    generation: fixedSaveGeneration,
    commit_id: commitId,
    created_at: fixedTimestamp,
    files: {
      document: descriptor("document.md", markdown),
      comments: descriptor(".patchmark/comments.json", commentsText),
      patches: descriptor(".patchmark/patches.json", patchesText),
      manifest: descriptor(".patchmark/manifest.json", manifestText)
    }
  });

  return {
    bytes: Buffer.byteLength(markdown),
    commentCount: comments.length,
    displayTitle,
    documentId,
    documentKey: JSON.stringify(["project_document", projectId, documentId]),
    groupId,
    headingCount,
    historyCount: versions.length,
    manifestPath: `${store}/manifest.json`,
    patchCount: patches.length,
    path,
    registry: {
      document_id: documentId,
      path,
      display_title: displayTitle,
      group_id: groupId,
      role: documentIndex % 2 === 0 ? "research" : "summary",
      status: "active",
      position,
      added_at: fixedTimestamp,
      archived_at: null
    },
    saveCommitPath: `${store}/save-commit.json`,
    sentinel: paragraphs[0].selectedText,
    writeMarkdown
  };
}

function createDisplayTitle(documentIndex) {
  return `Synthetic Switch Document ${String(documentIndex + 1).padStart(2, "0")}`;
}

function createDocumentId(documentIndex, token) {
  return `doc_switch_${String(documentIndex + 1).padStart(2, "0")}_${token}`;
}

function createDocumentPath(documentIndex) {
  return `switch-document-${String(documentIndex + 1).padStart(2, "0")}.md`;
}

function createMarkdown(displayTitle, paragraphs, headingCount, structure) {
  const lines = [`# ${displayTitle}`, ""];
  if (headingCount === 1) {
    lines.push(...paragraphs.flatMap((paragraph) => [paragraph.markdown, ""]));
  } else {
    const sectionCount = headingCount - 1;
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
      lines.push(
        sectionIndex === 0
          ? "## Generated relay notes"
          : `## Generated relay segment ${String(sectionIndex + 1).padStart(2, "0")}`,
        ""
      );
      const start = Math.floor((sectionIndex * paragraphs.length) / sectionCount);
      const end = Math.floor(
        ((sectionIndex + 1) * paragraphs.length) / sectionCount
      );
      lines.push(
        ...paragraphs
          .slice(start, end)
          .flatMap((paragraph) => [paragraph.markdown, ""])
      );
    }
  }
  lines.push(...createStructuredWorkload(structure));
  return lines.join("\n");
}

function createStructuredWorkload({
  codeBlockCount,
  documentIndex,
  structuredCellRepeatCount,
  structuredTableCount,
  structuredTableRowsPerTable
}) {
  const lines = [];
  const delimiterWidth = 48 + documentIndex * 7;
  for (let tableIndex = 0; tableIndex < structuredTableCount; tableIndex += 1) {
    const tableNumber = String(tableIndex + 1).padStart(2, "0");
    lines.push(
      `| Relay | Assumption | Evidence | Decision |`,
      `| ${"-".repeat(delimiterWidth + tableIndex)} | :${"-".repeat(delimiterWidth + 4)} | ${"-".repeat(delimiterWidth + 9)}: | ${"-".repeat(delimiterWidth + 14)} |`
    );
    for (let rowIndex = 0; rowIndex < structuredTableRowsPerTable; rowIndex += 1) {
      const rowNumber = String(rowIndex + 1).padStart(2, "0");
      const repeatedCell = `Deterministic market signal ${tableNumber}-${rowNumber} remains fictional and locally generated. `.repeat(
        structuredCellRepeatCount
      );
      lines.push(
        `| **Relay ${tableNumber}-${rowNumber}** | ${repeatedCell}| [Synthetic evidence](https://example.test/relay-${tableNumber}-${rowNumber}) | \`review-${tableNumber}-${rowNumber}\` |`
      );
    }
    lines.push("");
  }
  for (let codeIndex = 0; codeIndex < codeBlockCount; codeIndex += 1) {
    const codeNumber = String(codeIndex + 1).padStart(3, "0");
    lines.push(
      "```json",
      JSON.stringify(
        {
          document: documentIndex + 1,
          note: "Deterministic fixture content only",
          relay: codeNumber
        },
        null,
        2
      ),
      "```",
      ""
    );
  }
  return lines;
}

function createParagraph(token, documentIndex, paragraphIndex, repeatCount) {
  const documentNumber = String(documentIndex + 1).padStart(2, "0");
  const paragraphNumber = String(paragraphIndex + 1).padStart(4, "0");
  const selectedText = `Relay paragraph ${documentNumber}-${paragraphNumber} for synthetic seed ${token} carries a unique formulaic signal between fictional observatories.`;
  const filler = ` Synthetic workload detail ${paragraphNumber} remains isolated to relay ${documentNumber}.`.repeat(
    repeatCount
  );
  return { markdown: `${selectedText}${filler}`, selectedText };
}

function createComments({ commentCount, documentIndex, markdown, paragraphs }) {
  return paragraphs.slice(0, commentCount).map((paragraph, commentIndex) => {
    const start = markdown.indexOf(paragraph.selectedText);
    return {
      id: `PM-COMMENT-SWITCH-${String(documentIndex + 1).padStart(2, "0")}-${String(commentIndex + 1).padStart(4, "0")}`,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: paragraph.selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + paragraph.selectedText.length,
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
    original_text: paragraphs[patchIndex % paragraphs.length].selectedText,
    suggested_text: `${paragraphs[patchIndex % paragraphs.length].selectedText} Proposed synthetic adjustment ${patchIndex + 1}.`,
    reason: "Exercise deterministic document-switch patch loading.",
    created_at: fixedTimestamp
  }));
}

function descriptor(path, text) {
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tokenFor(documentId) {
  return documentId.split("_").at(-1);
}

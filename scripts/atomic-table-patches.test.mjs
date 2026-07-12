import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATOMIC_TABLE_IMPORT_ERROR,
  CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
  createCanonicalTableContextsFromOccurrences,
  createPatchmarkTableMarker,
  getCompleteTableOccurrencesForExport,
  getCompleteTableMarkdownsForExport,
  replaceCompleteTableOccurrencesWithMarkers,
  validateAtomicTablePatchImport
} from "../lib/patches/atomic-table-patches.ts";
import {
  findMarkdownTables,
  parseMarkdownTableRow
} from "../lib/markdown/markdown-tables.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";

const table = [
  "| Product | Price | Notes |",
  "| :--- | ---: | :---: |",
  "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) |",
  "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` |"
].join("\n");

const documentMarkdown = [
  "# Plan",
  "",
  "Intro paragraph.",
  "",
  table,
  "",
  "Source note, not part of the table."
].join("\n");

function proposal(overrides = {}) {
  return {
    comment_id: "PM-COMMENT-0001",
    original_text: "Original.",
    suggested_text: "Suggested.",
    reason: "Reason.",
    reason_sources: [],
    risk: "Risk.",
    risk_sources: [],
    suggested_text_sources: [],
    ...overrides
  };
}

function importPayload(patchProposalOverrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Imported response.",
    replies: [],
    patch_proposals: [proposal(patchProposalOverrides)],
    open_questions: []
  };
}

function parseImportPayload(input) {
  return parsePatchmarkCommentReplyImport(
    `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
  );
}

function assertAccepted(patchProposals, markdown = documentMarkdown) {
  assert.doesNotThrow(() =>
    validateAtomicTablePatchImport({
      markdown,
      patchProposals
    })
  );
}

function assertRejected(patchProposals, markdown = documentMarkdown) {
  assert.throws(
    () =>
      validateAtomicTablePatchImport({
        markdown,
        patchProposals
      }),
    new RegExp(ATOMIC_TABLE_IMPORT_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
}

{
  assert.match(
    CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
    /complete-table patch required/i
  );
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /Return exactly one `patch_proposal`/);
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /Patch 1 adds a header cell/);
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /complete four-column table/);
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /\[\[PATCHMARK_TABLE:PM-TABLE-0001\]\]/);
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /Never copy a Patchmark table marker/);
  assert.match(
    readFileSync("components/document-editor.tsx", "utf8"),
    /CHATGPT_ATOMIC_TABLE_PROMPT_RULES/
  );
}

{
  assert.deepEqual(parseMarkdownTableRow("| A \\| B | `C | D` |  |"), [
    "A | B",
    "`C | D`",
    ""
  ]);
  assert.deepEqual(parseMarkdownTableRow("A | [B](https://example.com/a|b) | C"), [
    "A",
    "[B](https://example.com/a|b)",
    "C"
  ]);
}

{
  const tables = findMarkdownTables(
    [
      "```",
      "| Not | A table |",
      "| --- | --- |",
      "```",
      "",
      "Caption.",
      "| Real | Table |",
      "| ---: | :---: |",
      "| 1 | 2 |"
    ].join("\n")
  );

  assert.equal(tables.length, 1);
  assert.equal(tables[0].headerRow.text, "| Real | Table |");
  assert.equal(tables[0].delimiterRow.text, "| ---: | :---: |");
}

{
  const blockquoteTable = [
    "> | A | B |",
    "> | --- | --- |",
    "> | 1 | 2 |"
  ].join("\n");
  const noOuterPipeTable = ["A | B", "--- | ---", "1 | 2"].join("\n");

  assert.equal(findMarkdownTables(blockquoteTable).length, 1);
  assert.equal(findMarkdownTables(noOuterPipeTable).length, 1);
}

{
  const adjacentTables = [
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "| C | D |",
    "| --- | --- |",
    "| 3 | 4 |"
  ].join("\n");

  assert.equal(findMarkdownTables(adjacentTables).length, 2);
}

{
  const anchorStart = documentMarkdown.indexOf("Sourdough");
  const anchorEnd = anchorStart + "Sourdough".length;
  const completeTables = getCompleteTableMarkdownsForExport({
    anchor: {
      kind: "selected_text",
      selected_text: "Sourdough",
      markdown_start_offset: anchorStart,
      markdown_end_offset: anchorEnd,
      anchor_context: {
        kind: "table_cell",
        plain_text: "Sourdough",
        markdown_text: "Sourdough",
        markdown_start_offset: anchorStart,
        markdown_end_offset: anchorEnd
      }
    },
    markdown: documentMarkdown,
    sectionRange: {
      start: 0,
      end: documentMarkdown.length
    }
  });

  assert.equal(completeTables.length, 1);
  assert.equal(completeTables[0], table);
}

{
  const tableStart = documentMarkdown.indexOf(table);
  const occurrences = getCompleteTableOccurrencesForExport({
    anchor: {
      kind: "selected_text",
      selected_text: "Sourdough",
      markdown_start_offset: documentMarkdown.indexOf("Sourdough"),
      markdown_end_offset: documentMarkdown.indexOf("Sourdough") + "Sourdough".length
    },
    markdown: documentMarkdown,
    sectionRange: {
      start: 0,
      end: documentMarkdown.length
    }
  });
  const tableContexts = createCanonicalTableContextsFromOccurrences({
    getMetadata: () => ({
      containing_heading: "Plan",
      containing_heading_path: ["Plan"]
    }),
    occurrences: [occurrences[0], occurrences[0]]
  });
  const marker = createPatchmarkTableMarker(tableContexts[0].table_id);
  const containingSection = replaceCompleteTableOccurrencesWithMarkers({
    markdown: documentMarkdown,
    tableContexts
  });
  const promptLikePayload = JSON.stringify({
    table_contexts: tableContexts.map((tableContext) => ({
      table_id: tableContext.table_id,
      markdown: tableContext.markdown
    })),
    comments: [
      {
        context: {
          complete_table_ids: [tableContexts[0].table_id],
          containing_section_markdown: containingSection
        }
      }
    ]
  });
  const escapedTable = JSON.stringify(table).slice(1, -1);

  assert.equal(tableContexts.length, 1);
  assert.equal(tableContexts[0].start, tableStart);
  assert.equal(tableContexts[0].markdown, table);
  assert.match(containingSection, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(containingSection.includes(table), false);
  assert.ok(containingSection.indexOf("Intro paragraph.") < containingSection.indexOf(marker));
  assert.ok(containingSection.indexOf(marker) < containingSection.indexOf("Source note"));
  assert.equal(promptLikePayload.split(escapedTable).length - 1, 1);
}

{
  const duplicateMarkdown = `${table}\n\nBetween.\n\n${table}`;
  const firstStart = duplicateMarkdown.indexOf(table);
  const secondStart = duplicateMarkdown.lastIndexOf(table);
  const contexts = createCanonicalTableContextsFromOccurrences({
    occurrences: [
      {
        start: firstStart,
        end: firstStart + table.length,
        markdown: table
      },
      {
        start: secondStart,
        end: secondStart + table.length,
        markdown: table
      }
    ]
  });
  const markedMarkdown = replaceCompleteTableOccurrencesWithMarkers({
    markdown: duplicateMarkdown,
    tableContexts: contexts
  });

  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].table_id, "PM-TABLE-0001");
  assert.equal(contexts[1].table_id, "PM-TABLE-0002");
  assert.match(markedMarkdown, /\[\[PATCHMARK_TABLE:PM-TABLE-0001\]\]/);
  assert.match(markedMarkdown, /\[\[PATCHMARK_TABLE:PM-TABLE-0002\]\]/);
  assert.equal(markedMarkdown.includes(table), false);
}

{
  const adjacentMarkdown = [
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "| C | D |",
    "| --- | --- |",
    "| 3 | 4 |"
  ].join("\n");
  const tables = findMarkdownTables(adjacentMarkdown);
  const contexts = createCanonicalTableContextsFromOccurrences({
    occurrences: tables.map((foundTable) => ({
      start: foundTable.start,
      end: foundTable.end,
      markdown: foundTable.markdown
    }))
  });
  const markedMarkdown = replaceCompleteTableOccurrencesWithMarkers({
    markdown: adjacentMarkdown,
    tableContexts: contexts
  });

  assert.equal(contexts.length, 2);
  assert.match(markedMarkdown, /\[\[PATCHMARK_TABLE:PM-TABLE-0001\]\]/);
  assert.match(markedMarkdown, /\[\[PATCHMARK_TABLE:PM-TABLE-0002\]\]/);
}

{
  const blockquoteTable = [
    "> | A | B |",
    "> | --- | --- |",
    "> | 1 \\| 2 | `3 | 4` |"
  ].join("\n");
  const contexts = createCanonicalTableContextsFromOccurrences({
    occurrences: findMarkdownTables(blockquoteTable).map((foundTable) => ({
      start: foundTable.start,
      end: foundTable.end,
      markdown: foundTable.markdown
    }))
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].markdown, blockquoteTable);
}

{
  const splitColumnAddition = [
    proposal({
      original_text: "| Product | Price | Notes |",
      suggested_text: "| Product | Price | Notes | Margin |"
    }),
    proposal({
      original_text: "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) |",
      suggested_text:
        "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |"
    })
  ];

  assertRejected(splitColumnAddition);
}

{
  assert.throws(
    () =>
      parseImportPayload(
        importPayload({
          original_text: "[[PATCHMARK_TABLE:PM-TABLE-0001]]",
          suggested_text: table
        })
      ),
    /table context markers/
  );
  assert.throws(
    () =>
      parseImportPayload(
        importPayload({
          original_text: table,
          suggested_text: "[[PATCHMARK_COMPLETE_TABLE:0]]"
        })
      ),
    /table context markers/
  );
}

{
  const suggested = [
    "| Product | Price | Notes | Margin |",
    "| :--- | ---: | :---: | ---: |",
    "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |",
    "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 42% |"
  ].join("\n");

  assertAccepted([
    proposal({
      original_text: table,
      suggested_text: suggested
    })
  ]);
  assert.match(suggested, /\[Menu\]\(https:\/\/example\.com\/menu\?a=1&b=2\)/);
}

{
  assertAccepted([
    proposal({
      original_text: table,
      suggested_text: [
        "| Product | Notes |",
        "| :--- | :---: |",
        "| Sourdough | [Menu](https://example.com/menu?a=1&b=2) |",
        "| Campaillou | Contains escaped pipe \\| and `code | sample` |"
      ].join("\n")
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: table,
      suggested_text: [
        "| Notes | Product | Price |",
        "| :---: | :--- | ---: |",
        "| [Menu](https://example.com/menu?a=1&b=2) | Sourdough | 200 |",
        "| Contains escaped pipe \\| and `code | sample` | Campaillou | 240 |"
      ].join("\n")
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: table,
      suggested_text: [
        "- Product: Sourdough; price: 200; notes: [Menu](https://example.com/menu?a=1&b=2).",
        "- Product: Campaillou; price: 240; notes: Contains escaped pipe \\| and `code | sample`."
      ].join("\n")
    })
  ]);
}

{
  assertRejected([
    proposal({
      original_text: "| Product | Price | Notes |",
      suggested_text: "| Product | Minimum price | Maximum price | Notes |"
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: "Sourdough",
      suggested_text: "Classic Sourdough"
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: "| Product | Price | Notes |",
      suggested_text: "| Bread | Price | Notes |"
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: "| :--- | ---: | :---: |",
      suggested_text: "| :---: | ---: | :--- |"
    })
  ]);
}

{
  assertAccepted([
    proposal({
      original_text: "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) |",
      suggested_text:
        "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) |\n| Multigrain | 220 | New row |"
    })
  ]);
  assertAccepted([
    proposal({
      original_text: "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) |",
      suggested_text: ""
    })
  ]);
}

{
  const secondTable = [
    "| Channel | Status |",
    "| --- | --- |",
    "| LINE | Active |"
  ].join("\n");
  const markdown = `${documentMarkdown}\n\n${secondTable}`;

  assertAccepted(
    [
      proposal({
        original_text: table,
        suggested_text: [
          "| Product | Price | Notes | Margin |",
          "| :--- | ---: | :---: | ---: |",
          "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |",
          "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 42% |"
        ].join("\n")
      }),
      proposal({
        original_text: secondTable,
        suggested_text: [
          "| Channel | Status | Owner |",
          "| --- | --- | --- |",
          "| LINE | Active | Founder |"
        ].join("\n")
      })
    ],
    markdown
  );
}

{
  assertRejected([
    proposal({
      original_text: table,
      suggested_text: [
        "| Product | Price | Notes | Margin |",
        "| :--- | ---: | :---: | ---: |",
        "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |",
        "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 42% |"
      ].join("\n")
    }),
    proposal({
      original_text: table,
      suggested_text: [
        "| Product | Price | Notes | Cost |",
        "| :--- | ---: | :---: | ---: |",
        "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 120 |",
        "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 140 |"
      ].join("\n")
    })
  ]);
}

{
  const duplicateMarkdown = `${table}\n\n${table}`;

  assertAccepted(
    [
      proposal({
        original_text: table,
        suggested_text: [
          "| Product | Price | Notes | Margin |",
          "| :--- | ---: | :---: | ---: |",
          "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |",
          "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 42% |"
        ].join("\n")
      })
    ],
    duplicateMarkdown
  );
}

{
  const malformedTable = [
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "| 3 | 4 | 5 |"
  ].join("\n");

  assert.throws(
    () =>
      validateAtomicTablePatchImport({
        markdown: malformedTable,
        patchProposals: [
          proposal({
            original_text: malformedTable,
            suggested_text: [
              "| A | B | C |",
              "| --- | --- | --- |",
              "| 1 | 2 |  |",
              "| 3 | 4 | 5 |"
            ].join("\n"),
            reason: "Adds a missing column.",
            risk: "Low risk."
          })
        ]
      }),
    /malformed source table/
  );
}

{
  const unchangedAnchorText = "Sourdough";
  const suggested = [
    "| Product | Price | Notes | Margin |",
    "| :--- | ---: | :---: | ---: |",
    "| Sourdough | 200 | [Menu](https://example.com/menu?a=1&b=2) | 40% |",
    "| Campaillou | 240 | Contains escaped pipe \\| and `code | sample` | 42% |"
  ].join("\n");

  assert.equal(
    suggested.indexOf(unchangedAnchorText),
    suggested.lastIndexOf(unchangedAnchorText)
  );
}

console.log("Atomic table patch tests passed.");

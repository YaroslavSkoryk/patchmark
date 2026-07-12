import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATOMIC_TABLE_IMPORT_ERROR,
  CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
  getCompleteTableMarkdownsForExport,
  validateAtomicTablePatchImport
} from "../lib/patches/atomic-table-patches.ts";
import {
  findMarkdownTables,
  parseMarkdownTableRow
} from "../lib/markdown/markdown-tables.ts";

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

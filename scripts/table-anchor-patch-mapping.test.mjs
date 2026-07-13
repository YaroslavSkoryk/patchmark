import assert from "node:assert/strict";
import {
  findRetainedSelectedTextInPatchReplacement,
  isSelectedAnchorEquivalentToPatchOriginalText
} from "../lib/comments/comment-anchor-patch-mapping.ts";
import { getDeterministicAppliedPatchOffsetMatch } from "../lib/patches/applied-patch-anchor.ts";

const heading = "### 5.1 Early Pricing Reference Points";
const repeatedHeading = "### 5.1 Early Pricing Reference Points";
const tableHeader = [
  "| Brand | Channel | Price reference |",
  "| --- | --- | --- |"
].join("\n");
const paulRow =
  "| [PAUL Thailand online delivery](https://example.com/paul) | Online delivery | Croissant 95 THB |";
const conkeysRow =
  "| Conkey's Bakery | Live menu | Croissant 90 THB |";
const duplicatePaulRow =
  "| [PAUL Thailand online delivery](https://example.com/paul-other) | Online delivery | Croissant 95 THB |";
const originalMarkdown = [
  "# Plan",
  "",
  heading,
  "",
  tableHeader,
  paulRow,
  conkeysRow,
  "",
  repeatedHeading,
  "",
  tableHeader,
  duplicatePaulRow
].join("\n");
const originalStart = originalMarkdown.indexOf(paulRow);
const suggestedRows = [
  paulRow,
  "| Holey Artisan | Instagram pricing post | Croissant 105 THB |",
  "| PAUL catering | Brochure | Croissant 95 THB |"
].join("\n");
const replacementStart = originalStart;
const patchedMarkdown = `${originalMarkdown.slice(
  0,
  originalStart
)}${suggestedRows}${originalMarkdown.slice(originalStart + paulRow.length)}`;

function selectedAnchorInRow(selectedText) {
  const rowRelativeStart = paulRow.indexOf(selectedText);
  assert.notEqual(rowRelativeStart, -1);

  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: {
      kind: "table_cell",
      plain_text: selectedText,
      markdown_text: selectedText,
      selected_start_in_context: 0,
      selected_end_in_context: selectedText.length,
      markdown_start_offset: originalStart + rowRelativeStart,
      markdown_end_offset: originalStart + rowRelativeStart + selectedText.length
    },
    markdown_start_offset: originalStart + rowRelativeStart,
    markdown_end_offset: originalStart + rowRelativeStart + selectedText.length,
    containing_heading: "5.1 Early Pricing Reference Points",
    containing_heading_level: 3
  };
}

function retainedMatchFor(selectedText, overrides = {}) {
  return findRetainedSelectedTextInPatchReplacement({
    anchor: selectedAnchorInRow(selectedText),
    originalStart,
    originalText: paulRow,
    replacementStart,
    suggestedText: suggestedRows,
    ...overrides
  });
}

{
  const match = retainedMatchFor("PAUL Thailand online delivery");

  assert.deepEqual(match, {
    start: patchedMarkdown.indexOf("PAUL Thailand online delivery"),
    end:
      patchedMarkdown.indexOf("PAUL Thailand online delivery") +
      "PAUL Thailand online delivery".length,
    selectedText: "PAUL Thailand online delivery"
  });
}

{
  assert.equal(
    retainedMatchFor("PAUL Thailand online delivery")?.selectedText,
    "PAUL Thailand online delivery"
  );
  assert.equal(retainedMatchFor("Online delivery")?.selectedText, "Online delivery");
  assert.equal(retainedMatchFor("Croissant 95 THB")?.selectedText, "Croissant 95 THB");
}

{
  const adjacentCommentAnchors = [
    selectedAnchorInRow("PAUL Thailand online delivery"),
    selectedAnchorInRow("Online delivery"),
    selectedAnchorInRow("Croissant 95 THB")
  ];
  const mappedAnchors = adjacentCommentAnchors.map((anchor) =>
    findRetainedSelectedTextInPatchReplacement({
      anchor,
      originalStart,
      originalText: paulRow,
      replacementStart,
      suggestedText: suggestedRows
    })
  );

  assert.deepEqual(
    mappedAnchors.map((match) => match?.selectedText),
    ["PAUL Thailand online delivery", "Online delivery", "Croissant 95 THB"]
  );
}

{
  const duplicateText = "Croissant 95 THB";
  const match = retainedMatchFor(duplicateText);

  assert.equal(match?.start, patchedMarkdown.indexOf(duplicateText));
  assert.ok(patchedMarkdown.lastIndexOf(duplicateText) > match.start);
}

{
  const whitespaceOriginal =
    "| Bakery | Online delivery | Croissant\\|danish and `code | sample` |";
  const whitespaceSuggested =
    "| Bakery | Online   delivery | Croissant\\|danish and `code | sample` |\n| New | Row | Added |";
  const selectedText = "Online delivery";
  const anchor = {
    kind: "selected_text",
    selected_text: selectedText,
    markdown_start_offset: whitespaceOriginal.indexOf("Online"),
    markdown_end_offset:
      whitespaceOriginal.indexOf("Online") + selectedText.length,
    anchor_context: {
      kind: "table_cell",
      plain_text: selectedText,
      markdown_text: selectedText
    }
  };
  const match = findRetainedSelectedTextInPatchReplacement({
    anchor,
    originalStart: 0,
    originalText: whitespaceOriginal,
    replacementStart: 0,
    suggestedText: whitespaceSuggested
  });

  assert.equal(match?.selectedText, "Online   delivery");
}

{
  const fullOriginalTable = [tableHeader, paulRow, conkeysRow].join("\n");
  const fullSuggestedTable = [
    tableHeader,
    paulRow,
    conkeysRow,
    "| New bakery | New source | Croissant 100 THB |"
  ].join("\n");
  const selectedText = "Online delivery";
  const fullTableOriginalStart = originalMarkdown.indexOf(tableHeader);
  const fullTableReplacementStart = fullTableOriginalStart;
  const anchor = selectedAnchorInRow(selectedText);
  const match = findRetainedSelectedTextInPatchReplacement({
    anchor,
    originalStart: fullTableOriginalStart,
    originalText: fullOriginalTable,
    replacementStart: fullTableReplacementStart,
    suggestedText: fullSuggestedTable
  });

  assert.equal(match?.selectedText, selectedText);
}

{
  const selectedText = "Croissant 95 THB";
  const shiftedSuggested =
    "| [PAUL Thailand online delivery](https://example.com/paul) | Updated online delivery channel | Croissant 95 THB |";
  const match = findRetainedSelectedTextInPatchReplacement({
    anchor: selectedAnchorInRow(selectedText),
    originalStart,
    originalText: paulRow,
    replacementStart,
    suggestedText: shiftedSuggested
  });

  assert.equal(match?.selectedText, selectedText);
  assert.equal(match?.start, replacementStart + shiftedSuggested.indexOf(selectedText));
}

{
  const selectedText = "Croissant 95 THB";
  const partiallyEdited = paulRow.replace(selectedText, "Croissant 105 THB");
  const deleted = "";

  assert.equal(
    findRetainedSelectedTextInPatchReplacement({
      anchor: selectedAnchorInRow(selectedText),
      originalStart,
      originalText: paulRow,
      replacementStart,
      suggestedText: partiallyEdited
    }),
    null
  );
  assert.equal(
    findRetainedSelectedTextInPatchReplacement({
      anchor: selectedAnchorInRow(selectedText),
      originalStart,
      originalText: paulRow,
      replacementStart,
      suggestedText: deleted
    }),
    null
  );
}

{
  assert.equal(
    isSelectedAnchorEquivalentToPatchOriginalText({
      anchor: {
        kind: "selected_text",
        selected_text: paulRow
      },
      originalText: paulRow
    }),
    true
  );
  assert.equal(
    isSelectedAnchorEquivalentToPatchOriginalText({
      anchor: selectedAnchorInRow("Croissant 95 THB"),
      originalText: paulRow
    }),
    false
  );
}

{
  const appliedTwiceMarkdown = [
    heading,
    "",
    tableHeader,
    suggestedRows,
    "",
    "Preview copy that must not win:",
    suggestedRows
  ].join("\n");
  const appliedStart = appliedTwiceMarkdown.indexOf(suggestedRows);
  const match = getDeterministicAppliedPatchOffsetMatch({
    appliedText: suggestedRows,
    markdown: appliedTwiceMarkdown,
    patch: {
      applied_start_offset: appliedStart,
      applied_end_offset: appliedStart + suggestedRows.length
    }
  });

  assert.equal(match?.start, appliedStart);
  assert.equal(match?.status, "exact_match");
}

{
  const normalizedAppliedText = "| A | B |\n| C | D |";
  const currentText = "| A | B |\n| C |   D |";
  const markdown = `Intro\n${currentText}\nOutro\n${currentText}`;
  const start = markdown.indexOf(currentText);
  const match = getDeterministicAppliedPatchOffsetMatch({
    appliedText: normalizedAppliedText,
    markdown,
    patch: {
      applied_start_offset: start,
      applied_end_offset: start + currentText.length
    }
  });

  assert.equal(match?.status, "normalized_match");
  assert.equal(match?.text, currentText);
}

{
  const once = retainedMatchFor("Online delivery");
  const twice = retainedMatchFor("Online delivery");

  assert.deepEqual(twice, once);
}

console.log("Table anchor patch mapping tests passed.");

import assert from "node:assert/strict";

function findExactTextMatches(markdown, selectedText) {
  if (!selectedText) return [];
  const matches = [];
  let nextIndex = markdown.indexOf(selectedText);
  while (nextIndex !== -1) {
    matches.push({ start: nextIndex, end: nextIndex + selectedText.length });
    nextIndex = markdown.indexOf(selectedText, nextIndex + selectedText.length);
  }
  return matches;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function buildNormalizedIndex(text) {
  let normalized = "";
  const positions = [];
  let previousWasSpace = true;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (!previousWasSpace) {
        normalized += " ";
        positions.push(index);
      }
      previousWasSpace = true;
    } else {
      normalized += character;
      positions.push(index);
      previousWasSpace = false;
    }
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    positions.pop();
  }
  return { text: normalized, positions };
}

function findNormalizedTextMatches(text, searchText) {
  const index = buildNormalizedIndex(text);
  const normalizedSearch = normalizeText(searchText);
  const matches = [];
  let nextIndex = index.text.indexOf(normalizedSearch);
  while (nextIndex !== -1) {
    const start = index.positions[nextIndex];
    const end = index.positions[nextIndex + normalizedSearch.length - 1];
    if (typeof start === "number" && typeof end === "number") {
      matches.push({ start, end: end + 1 });
    }
    nextIndex = index.text.indexOf(normalizedSearch, nextIndex + normalizedSearch.length);
  }
  return matches;
}

function parseMarkdownTableRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === "|" && row[index - 1] !== "\\") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells.map((value) => value.replace(/\\\|/g, "|"));
}

function isTableRow(line) {
  return line.includes("|") && parseMarkdownTableRow(line).length >= 2;
}

function normalizeCell(cell) {
  return cell.trim().replace(/\s+/g, " ");
}

function getLineStarts(markdown) {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function findTableRowCandidates(markdown, originalRow) {
  const originalCells = parseMarkdownTableRow(originalRow).map(normalizeCell);
  const lines = markdown.split("\n");
  const starts = getLineStarts(markdown);
  return lines.flatMap((line, index) => {
    if (!isTableRow(line)) return [];
    const cells = parseMarkdownTableRow(line).map(normalizeCell);
    const matches = cells.length === originalCells.length && cells.every((cell, cellIndex) => cell === originalCells[cellIndex]);
    return matches ? [{ start: starts[index], end: starts[index] + line.length, text: line }] : [];
  });
}

function findHeadingSection(markdown, heading) {
  const lines = markdown.split("\n");
  const starts = getLineStarts(markdown);
  const headingIndex = lines.findIndex((line) => line.replace(/^#+\s+/, "").trim() === heading);
  if (headingIndex === -1) return null;
  const headingLevel = /^#+/.exec(lines[headingIndex])?.[0].length ?? 1;
  let endLine = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = /^(#+)\s+/.exec(lines[index]);
    if (match && match[1].length <= headingLevel) {
      endLine = index;
      break;
    }
  }
  return { start: starts[headingIndex], end: endLine < starts.length ? starts[endLine] : markdown.length };
}

function recoverPendingAnchor(markdown, patch) {
  if (patch.status !== "pending" || findExactTextMatches(markdown, patch.original_text).length > 0) return null;
  const normalizedMatches = findNormalizedTextMatches(markdown, patch.original_text);
  if (patch.original_text.includes("|")) {
    const rows = findTableRowCandidates(markdown, patch.original_text);
    if (rows.length === 1) {
      return { confidence: "HIGH_CONFIDENCE", method: "unique_table_row_match", text: rows[0].text };
    }
  }
  const section = patch.target_heading ? findHeadingSection(markdown, patch.target_heading) : null;
  if (section) {
    const sectionMatches = normalizedMatches.filter((match) => match.start >= section.start && match.end <= section.end);
    if (sectionMatches.length === 1) {
      const match = sectionMatches[0];
      return { confidence: "HIGH_CONFIDENCE", method: "unique_section_context_match", text: markdown.slice(match.start, match.end) };
    }
  }
  if (normalizedMatches.length === 1) {
    const match = normalizedMatches[0];
    return { confidence: "HIGH_CONFIDENCE", method: "normalized_match", text: markdown.slice(match.start, match.end) };
  }
  return { confidence: "AMBIGUOUS" };
}

function recoverDescendantPatch(markdown, parentPatch, patches) {
  const descendant = patches.find((patch) => patch.status === "accepted" && patch.original_text === parentPatch.applied_text);
  if (!descendant) return null;
  return findExactTextMatches(markdown, descendant.applied_text).length === 1
    ? { confidence: "HIGH_CONFIDENCE", method: "descendant_patch_chain" }
    : { confidence: "AMBIGUOUS" };
}

{
  const markdown = "| Product | Price |\n| --- | --- |\n| Baguette | 150 |\n| Bread | 200 |\n";
  const patch = { status: "pending", original_text: "| Bread   | 200   |" };
  assert.deepEqual(recoverPendingAnchor(markdown, patch), {
    confidence: "HIGH_CONFIDENCE",
    method: "unique_table_row_match",
    text: "| Bread | 200 |"
  });
}

{
  const markdown = "## Market\nOriginal   phrase with spacing.\n\n## Other\nOriginal   phrase with spacing.\n";
  const patch = { status: "pending", target_heading: "Market", original_text: "Original phrase with spacing." };
  assert.equal(recoverPendingAnchor(markdown, patch)?.method, "unique_section_context_match");
}

{
  const markdown = "## A\nRepeated   phrase.\n\n## B\nRepeated   phrase.\n";
  const patch = { status: "pending", original_text: "Repeated phrase." };
  assert.equal(recoverPendingAnchor(markdown, patch)?.confidence, "AMBIGUOUS");
}

{
  const markdown = "| Product | Price |\n| --- | --- |\n| Bread | 200 |\n| Bread | 200 |\n";
  const patch = { status: "pending", original_text: "| Bread   | 200   |" };
  assert.equal(recoverPendingAnchor(markdown, patch)?.confidence, "AMBIGUOUS");
}

{
  const markdown = "Final evolved paragraph.";
  const parentPatch = { status: "accepted", applied_text: "Intermediate paragraph." };
  const patches = [{ status: "accepted", original_text: "Intermediate paragraph.", applied_text: "Final evolved paragraph." }];
  assert.deepEqual(recoverDescendantPatch(markdown, parentPatch, patches), {
    confidence: "HIGH_CONFIDENCE",
    method: "descendant_patch_chain"
  });
}

console.log("Patch anchor recovery tests passed.");

import assert from "node:assert/strict";
import { getPatchImpactForCurrentAnchorDisplay } from "../lib/comments/comment-anchor-state.ts";

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

  return { positions, text: normalized };
}

function validateAnchor(markdown, anchor) {
  const offsetText = markdown.slice(
    anchor.markdown_start_offset,
    anchor.markdown_end_offset
  );

  if (offsetText === anchor.selected_text) {
    return "active";
  }

  return findNormalizedTextMatches(markdown, anchor.selected_text).length === 1
    ? "active"
    : "not_found";
}

function reanchorCommentToReplacement({
  comment,
  markdown,
  patchId,
  replacementEnd,
  replacementStart
}) {
  const replacementText = markdown.slice(replacementStart, replacementEnd);

  return {
    ...comment,
    anchor: {
      kind: "selected_text",
      selected_text: replacementText,
      anchor_context: {
        kind: "table_cell",
        plain_text: normalizeText(replacementText),
        markdown_text: replacementText,
        selected_start_in_context: 0,
        selected_end_in_context: replacementText.length,
        markdown_start_offset: replacementStart,
        markdown_end_offset: replacementEnd
      },
      markdown_start_offset: replacementStart,
      markdown_end_offset: replacementEnd
    },
    anchor_history: [
      ...(comment.anchor_history ?? []),
      {
        reason: "anchor_recovered_after_patch",
        source_patch_id: patchId
      }
    ],
    patch_impacts: [
      ...(comment.patch_impacts ?? []),
      {
        impact_kind: "linked_comment",
        patch_id: patchId,
        result: "reanchored"
      }
    ]
  };
}

function recoverPersistedAnchorFromCurrentMarkdown(comment, markdown) {
  const lines = markdown.split("\n");
  let cursor = 0;
  let start = -1;
  let end = -1;
  let currentRow = "";

  for (const line of lines) {
    const lineEnd = cursor + line.length;

    if (normalizeText(line) === normalizeText(comment.anchor.selected_text)) {
      start = cursor;
      end = lineEnd;
      currentRow = line;
      break;
    }

    cursor = lineEnd + 1;
  }

  if (normalizeText(currentRow) !== normalizeText(comment.anchor.selected_text)) {
    return comment;
  }

  return {
    ...comment,
    anchor: {
      ...comment.anchor,
      selected_text: currentRow,
      anchor_context: {
        ...comment.anchor.anchor_context,
        plain_text: normalizeText(currentRow),
        markdown_text: currentRow,
        selected_end_in_context: currentRow.length,
        markdown_start_offset: start,
        markdown_end_offset: end
      },
      markdown_start_offset: start,
      markdown_end_offset: end
    },
    anchor_history: [
      ...(comment.anchor_history ?? []),
      {
        reason: "anchor_recovered_after_patch",
        source_patch_id: comment.patch_impacts.at(-1)?.patch_id
      }
    ]
  };
}

{
  const initialMarkdown =
    "| Area | Current direction |\n| --- | --- |\n| Product | Original bread catalogue |\n";
  const selectedText = "| Product | Original bread catalogue |";
  const selectedStart = initialMarkdown.indexOf(selectedText);
  let comment = {
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: selectedStart,
      markdown_end_offset: selectedStart + selectedText.length
    },
    patch_impacts: [
      {
        impact_kind: "anchor_after_replaced_range",
        patch_id: "PM-PATCH-0019",
        result: "needs_review"
      }
    ]
  };
  const shiftedMarkdown =
    "| Area | Current direction |\n| --- | --- |\n| New row | Inserted above |\n| Product | Original bread catalogue |\n";
  const shiftedStart = shiftedMarkdown.indexOf(selectedText);

  comment = {
    ...comment,
    anchor: {
      ...comment.anchor,
      markdown_start_offset: shiftedStart,
      markdown_end_offset: shiftedStart + selectedText.length
    },
    patch_impacts: [
      ...comment.patch_impacts,
      {
        impact_kind: "anchor_after_replaced_range",
        patch_id: "PM-PATCH-0019",
        result: "reanchored"
      }
    ]
  };

  const suggestedText =
    "| Product | Current bread catalogue includes Original, Baguette, and Campaillou |";
  const patchedMarkdown = shiftedMarkdown.replace(selectedText, suggestedText);
  const replacementStart = patchedMarkdown.indexOf(suggestedText);

  comment = reanchorCommentToReplacement({
    comment,
    markdown: patchedMarkdown,
    patchId: "PM-PATCH-0020",
    replacementEnd: replacementStart + suggestedText.length,
    replacementStart
  });

  const reloadedComment = JSON.parse(JSON.stringify(comment));

  assert.equal(reloadedComment.anchor.selected_text, suggestedText);
  assert.equal(
    patchedMarkdown.slice(
      reloadedComment.anchor.markdown_start_offset,
      reloadedComment.anchor.markdown_end_offset
    ),
    suggestedText
  );
  assert.equal(validateAnchor(patchedMarkdown, reloadedComment.anchor), "active");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: reloadedComment.patch_impacts.at(-1)
    })?.result,
    "reanchored"
  );
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: {
        impact_kind: "anchor_after_replaced_range",
        patch_id: "PM-PATCH-0021",
        result: "needs_review"
      }
    }),
    undefined
  );

  const reformattedMarkdown = patchedMarkdown.replace(
    suggestedText,
    "| Product | Current bread catalogue includes Original, Baguette, and   Campaillou |"
  );

  assert.equal(validateAnchor(reformattedMarkdown, reloadedComment.anchor), "active");

  const paddedTechnologyRow = suggestedText.replace(
    / \|$/,
    "               |"
  );
  const paddedMarkdown = patchedMarkdown.replace(suggestedText, paddedTechnologyRow);
  const staleButRecoverableComment = {
    ...reloadedComment,
    anchor: {
      ...reloadedComment.anchor,
      selected_text: suggestedText,
      markdown_end_offset: reloadedComment.anchor.markdown_start_offset + suggestedText.length
    }
  };
  const recoveredPersistedComment = recoverPersistedAnchorFromCurrentMarkdown(
    staleButRecoverableComment,
    paddedMarkdown
  );

  assert.equal(validateAnchor(paddedMarkdown, staleButRecoverableComment.anchor), "active");
  assert.equal(recoveredPersistedComment.anchor.selected_text, paddedTechnologyRow);
  assert.equal(
    paddedMarkdown.slice(
      recoveredPersistedComment.anchor.markdown_start_offset,
      recoveredPersistedComment.anchor.markdown_end_offset
    ),
    paddedTechnologyRow
  );

  const invalidatedMarkdown = patchedMarkdown.replace(suggestedText, "");

  assert.equal(validateAnchor(invalidatedMarkdown, reloadedComment.anchor), "not_found");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "not_found",
      latestPatchImpact: reloadedComment.patch_impacts.at(-1)
    }),
    undefined
  );
}

console.log("Comment anchor consistency tests passed.");

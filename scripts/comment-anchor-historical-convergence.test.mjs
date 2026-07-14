import assert from "node:assert/strict";
import {
  resolveCanonicalCommentTarget,
  resolveCanonicalPatchTarget
} from "../lib/comments/canonical-target-resolution.ts";

const createdAt = "2026-07-14T00:00:00.000Z";

function createSelectedComment({
  id = "PM-COMMENT-TEST",
  selectedText,
  start,
  end,
  heading = "Target Section",
  history = [],
  status = "open"
}) {
  return {
    id,
    type: "note",
    status,
    comment: "Fixture comment",
    thread: [],
    export_state: {
      focus_state: "idle"
    },
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: end,
      anchor_context: {
        kind: "paragraph",
        plain_text: selectedText,
        markdown_text: selectedText,
        selected_start_in_context: 0,
        selected_end_in_context: selectedText.length,
        markdown_start_offset: start,
        markdown_end_offset: end
      },
      containing_heading: heading,
      containing_heading_level: 2,
      anchor_source: "visual"
    },
    anchor_history: history,
    created_at: createdAt,
    updated_at: createdAt
  };
}

function createSectionComment({
  heading,
  id = "PM-COMMENT-SECTION"
}) {
  return {
    id,
    type: "note",
    status: "open",
    comment: "Fixture section comment",
    thread: [],
    export_state: {
      focus_state: "idle"
    },
    anchor: {
      kind: "section",
      heading,
      heading_level: 2
    },
    created_at: createdAt,
    updated_at: createdAt
  };
}

function createPatch(overrides) {
  return {
    id: "PM-PATCH-TEST",
    status: "accepted",
    comment_id: "PM-COMMENT-TEST",
    original_text: "old",
    suggested_text: "new",
    reason: "Fixture patch",
    created_at: createdAt,
    accepted_at: createdAt,
    applied_at: createdAt,
    applied_text: overrides.suggested_text ?? "new",
    ...overrides
  };
}

{
  const markdown = [
    "## Target Section",
    "",
    "* Cash flow: weekly cash in/out, ingredient and packaging spend, fixed costs, and estimated operating time supported by available cash at the current net spending rate."
  ].join("\n");
  const originalText =
    "* Cash flow: weekly cash in/out, ingredient and packaging spend, fixed costs, runway.";
  const suggestedText =
    "* Cash flow: weekly cash in/out, ingredient and packaging spend, fixed costs, and estimated operating time supported by available cash at the current net spending rate.";
  const staleStart = originalText.indexOf("runway");
  const comment = createSelectedComment({
    selectedText: "runway",
    start: staleStart,
    end: staleStart + "runway".length
  });
  const patch = createPatch({
    original_text: originalText,
    suggested_text: suggestedText,
    applied_text: suggestedText,
    applied_start_offset: markdown.indexOf("* Cash flow"),
    applied_end_offset: markdown.indexOf("* Cash flow") + suggestedText.length
  });
  const resolution = resolveCanonicalCommentTarget(comment, {
    markdown,
    patches: [patch]
  });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "accepted_patch_replacement");
  assert.equal(
    markdown.slice(resolution.range.start, resolution.range.end),
    "and estimated operating time supported by available cash at the current net spending rate"
  );
}

{
  const markdown = [
    "## Target Section",
    "",
    "| Channel | Best use | Risk |",
    "| --- | --- | --- |",
    "| Wholesale delivery | Useful for one or more wholesale accounts when order size and agreed delivery terms justify the trip. | Payment discipline. |"
  ].join("\n");
  const originalText =
    "| Wholesale route | Useful when multiple accounts can be served on one schedule. | Payment discipline. |";
  const suggestedText =
    "| Wholesale delivery | Useful for one or more wholesale accounts when order size and agreed delivery terms justify the trip. | Payment discipline. |";
  const originalStart = 0;
  const selectedStart = originalText.indexOf("Useful when");
  const comment = createSelectedComment({
    selectedText: "Useful when multiple accounts can be served on one schedule.",
    start: originalStart + selectedStart,
    end:
      originalStart +
      selectedStart +
      "Useful when multiple accounts can be served on one schedule.".length
  });
  const appliedStart = markdown.indexOf("| Wholesale delivery");
  const patch = createPatch({
    original_text: originalText,
    suggested_text: suggestedText,
    applied_text: suggestedText,
    applied_start_offset: appliedStart,
    applied_end_offset: appliedStart + suggestedText.length
  });
  const resolution = resolveCanonicalCommentTarget(comment, {
    markdown,
    patches: [patch]
  });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "accepted_patch_replacement");
  assert.equal(
    markdown.slice(resolution.range.start, resolution.range.end),
    "Useful for one or more wholesale accounts when order size and agreed delivery terms justify the trip."
  );
}

{
  const markdown = [
    "## Target Section",
    "",
    "| Product | Signal |",
    "| --- | --- |",
    "| Cranberries & Walnut | Strongest-performing product in the available household retail data. |"
  ].join("\n");
  const historicalAnchor = {
    kind: "selected_text",
    selected_text:
      "Strongest-performing product in the available household retail data.",
    markdown_start_offset: 0,
    markdown_end_offset: 64,
    containing_heading: "Target Section",
    containing_heading_level: 2,
    anchor_source: "patch"
  };
  const comment = createSelectedComment({
    selectedText: "| Baguette | Stale overwritten row |",
    start: 0,
    end: 32,
    history: [
      {
        changed_at: createdAt,
        reason: "anchor_recovered_after_patch",
        source_patch_id: "PM-PATCH-HISTORICAL",
        previous_anchor: {
          ...historicalAnchor,
          selected_text: "Earlier text"
        },
        new_anchor: historicalAnchor,
        impact_kind: "linked_comment"
      }
    ]
  });
  const resolution = resolveCanonicalCommentTarget(comment, { markdown });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "historical_anchor");
  assert.equal(
    markdown.slice(resolution.range.start, resolution.range.end),
    historicalAnchor.selected_text
  );
}

{
  const markdown = [
    "## Target Section",
    "",
    "> **Early signal.** Evidence survives with Markdown formatting."
  ].join("\n");
  const selectedText = "Early signal. Evidence survives with Markdown formatting.";
  const comment = createSelectedComment({
    selectedText,
    start: 0,
    end: selectedText.length
  });
  const resolution = resolveCanonicalCommentTarget(comment, { markdown });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "markdown_plain");
}

{
  const originalText =
    "> **Early Cranberries & Walnut signal.** In the available household retail dataset, Cranberries & Walnut generated 50 units across 40 paid orders from 14 accounts, ranked first in cumulative sales and in weekly sales velocity after accounting for different product launch dates, and generated 26 lifetime repeat orders. In the current wholesale relationship, it generated 208 units across 16 paid orders and had the highest units-per-week rate. These results are encouraging but are not broad market validation: the retail accounts are neighboring households with existing founder relationships, while the wholesale data comes from one business customer operating several shops and does not include store-level sell-through or end-customer behavior.";
  const selectedText =
    "Early Cranberries & Walnut signal. In the available household retail dataset, Cranberries & Walnut generated 50 units across 40 paid orders from 14 accounts, ranked first in cumulative sales and in weekly sales velocity after accounting for different product launch dates, and generated 26 lifetime repeat orders. In the current wholesale relationship, it generated 208 units across 16 paid orders and had the highest units-per-week rate. These results are encouraging but are not broad market validation: the retail accounts are neighboring households with existing founder relationships, while the wholesale data comes from one business customer operating several shops and does not include store-level sell-through or end-customer behavior.";
  const appliedText = [
    "> **Early Cranberries & Walnut signal**",
    ">",
    "> - **Household retail:** 50 units across 40 paid orders from 14 neighboring households, including 26 repeat orders. It ranked first in total sales and in weekly sales rate adjusted for different product launch dates.",
    "> - **Wholesale:** 208 units across 16 paid orders from one customer operating several shops. It had the highest units-per-week rate in the available wholesale data.",
    "> - **Interpretation:** The product shows strong early performance across both channels, but this is not broad market validation. The retail sample is relationship-biased, and the wholesale data does not include store-level sell-through or end-customer behavior."
  ].join("\n");
  const currentAppliedText = appliedText.replaceAll("> - ", "> * ");
  const markdown = ["## Target Section", "", currentAppliedText].join("\n");
  const appliedStart = markdown.indexOf(currentAppliedText);
  const historicalAnchor = {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: {
      kind: "paragraph",
      plain_text: selectedText,
      markdown_text: originalText.slice(4),
      selected_start_in_context: 0,
      selected_end_in_context: selectedText.length,
      markdown_start_offset: appliedStart + 4,
      markdown_end_offset: appliedStart + originalText.length
    },
    containing_heading: "Target Section",
    containing_heading_level: 2,
    anchor_source: "visual"
  };
  const comment = createSelectedComment({
    selectedText,
    start: 0,
    end: selectedText.length,
    history: [
      {
        changed_at: createdAt,
        reason: "anchor_marked_needs_review_after_patch",
        source_patch_id: "PM-PATCH-MULTIBLOCK",
        previous_anchor: historicalAnchor,
        impact_kind: "linked_comment"
      }
    ]
  });
  const staleComment = {
    ...comment,
    anchor: historicalAnchor
  };
  const patch = createPatch({
    id: "PM-PATCH-MULTIBLOCK",
    original_text: originalText,
    suggested_text: appliedText,
    applied_text: appliedText,
    applied_start_offset: appliedStart,
    applied_end_offset: appliedStart + currentAppliedText.length
  });
  const resolution = resolveCanonicalCommentTarget(staleComment, {
    markdown,
    patches: [patch]
  });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "accepted_patch_replacement");
  assert.deepEqual(resolution.range, {
    start: appliedStart,
    end: appliedStart + currentAppliedText.length
  });
  assert.equal(
    markdown.slice(resolution.range.start, resolution.range.end),
    currentAppliedText
  );
}

{
  const originalText =
    "> **Early Cranberries & Walnut signal.** Dense evidence paragraph.";
  const selectedText = "Dense evidence paragraph.";
  const currentAppliedText = [
    "> **Early Cranberries & Walnut signal**",
    ">",
    "> * **Interpretation:** Easier shareholder wording."
  ].join("\n");
  const markdown = ["## Target Section", "", currentAppliedText].join("\n");
  const appliedStart = markdown.indexOf(currentAppliedText);
  const unrelatedComment = createSelectedComment({
    id: "PM-COMMENT-UNRELATED",
    selectedText,
    start: 0,
    end: selectedText.length
  });
  const patch = createPatch({
    id: "PM-PATCH-LINKED-ELSEWHERE",
    comment_id: "PM-COMMENT-LINKED",
    original_text: originalText,
    suggested_text: currentAppliedText,
    applied_text: currentAppliedText,
    applied_start_offset: appliedStart,
    applied_end_offset: appliedStart + currentAppliedText.length
  });
  const resolution = resolveCanonicalCommentTarget(unrelatedComment, {
    markdown,
    patches: [patch]
  });

  assert.equal(resolution.state, "not_found");
}

{
  const markdown = ["## First-Year Priorities", "", "Keep this section."].join("\n");
  const comment = createSectionComment({
    heading: "First 3-6 Month Priorities"
  });
  const patch = createPatch({
    comment_id: comment.id,
    original_text: "## First 3-6 Month Priorities",
    suggested_text: "## First-Year Priorities",
    applied_text: "## First-Year Priorities",
    applied_start_offset: 0,
    applied_end_offset: "## First-Year Priorities".length
  });
  const resolution = resolveCanonicalCommentTarget(comment, {
    markdown,
    patches: [patch]
  });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "section_heading_replacement");
}

{
  const markdown = ["## Target Section", "", "LINE add here. LINE add there."].join(
    "\n"
  );
  const comment = createSelectedComment({
    selectedText: "LINE add",
    start: 0,
    end: "LINE add".length
  });
  const resolution = resolveCanonicalCommentTarget(comment, { markdown });

  assert.equal(resolution.state, "ambiguous");
  assert.equal(resolution.cardinality, "multiple");
}

{
  const markdown = ["## Target Section", "", "The target was removed."].join("\n");
  const comment = createSelectedComment({
    selectedText: "deleted without replacement",
    start: 0,
    end: "deleted without replacement".length
  });
  const resolution = resolveCanonicalCommentTarget(comment, { markdown });

  assert.equal(resolution.state, "not_found");
}

{
  const markdown = [
    "## Target Section",
    "",
    "LINE add here. LINE add there."
  ].join("\n");
  const comment = createSelectedComment({
    selectedText: "LINE add",
    start: markdown.lastIndexOf("LINE add"),
    end: markdown.lastIndexOf("LINE add") + "LINE add".length
  });
  const patch = createPatch({
    comment_id: comment.id,
    status: "pending",
    original_text: "LINE add",
    suggested_text: "new LINE Official Account friend",
    target_heading: "Target Section"
  });
  const resolution = resolveCanonicalPatchTarget({
    comments: [comment],
    markdown,
    patch,
    patches: [patch]
  });

  assert.equal(resolution.state, "resolved");
  assert.equal(resolution.method, "linked_comment_anchor");
  assert.deepEqual(resolution.range, {
    start: markdown.lastIndexOf("LINE add"),
    end: markdown.lastIndexOf("LINE add") + "LINE add".length
  });
}

{
  const markdown = ["## Target Section", "", "Stable target."].join("\n");
  const start = markdown.indexOf("Stable target.");
  const comment = createSelectedComment({
    selectedText: "Stable target.",
    start,
    end: start + "Stable target.".length
  });
  const first = resolveCanonicalCommentTarget(comment, { markdown });
  const second = resolveCanonicalCommentTarget(comment, { markdown });

  assert.deepEqual(second, first);
}

console.log("Historical comment anchor convergence tests passed.");

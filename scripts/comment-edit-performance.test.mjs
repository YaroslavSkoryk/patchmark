import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  applyMarkdownEdits,
  deriveMarkdownChangeSet,
  deriveNativeMarkdownChangeSet,
  isSafeManualAnchorTransformChangeSet,
  transformSelectedTextAnchorThroughChangeSet
} from "../lib/comments/comment-anchor-transformation.ts";
import { resolveCanonicalCommentTarget } from "../lib/comments/canonical-target-resolution.ts";

const fixture = createPerformanceFixture();
const operationResults = {};

measureChangeSet("one_character", (markdown) => `${markdown}x`);
measureChangeSet(
  "multiline_paste",
  (markdown) => `${markdown}\n${"Pasted performance line.\n".repeat(80)}`
);
measureChangeSet("separated_hunks", (markdown) =>
  markdown
    .replace("Section 10", "Section 10 updated")
    .replace("Section 20", "Section 20 updated")
    .replace("Section 30", "Section 30 updated")
);
measureChangeSet("broad_rewrite", (markdown) =>
  markdown.replace(/ \| /g, "  |  ").replace(/\n\n/g, "\n\n\n")
);

const repeatedEditDurations = [];
let repeatedMarkdown = fixture.markdown;
let repeatedAnchors = fixture.comments.map((comment) => comment.anchor);

for (let index = 0; index < 100; index += 1) {
  const insertionOffset = repeatedMarkdown.indexOf("## Section 5");
  const nextMarkdown = `${repeatedMarkdown.slice(0, insertionOffset)}x${repeatedMarkdown.slice(insertionOffset)}`;
  const startedAt = performance.now();
  const changeSet = deriveNativeMarkdownChangeSet({
    newMarkdown: nextMarkdown,
    oldMarkdown: repeatedMarkdown,
    selectionEnd: insertionOffset,
    selectionStart: insertionOffset,
    source: "manual_source"
  });

  assert.ok(changeSet);
  repeatedAnchors = repeatedAnchors.map((anchor) => {
    const transform = transformSelectedTextAnchorThroughChangeSet({
      anchor,
      changeSet,
      newMarkdown: nextMarkdown,
      oldMarkdown: repeatedMarkdown
    });

    assert.equal(transform.outcome, "active");
    assert.equal(
      nextMarkdown.slice(transform.start, transform.end),
      transform.selectedText
    );

    return {
      ...anchor,
      markdown_start_offset: transform.start,
      markdown_end_offset: transform.end,
      selected_text: transform.selectedText
    };
  });
  repeatedMarkdown = nextMarkdown;
  repeatedEditDurations.push(performance.now() - startedAt);
}

const repeatedFirstHalf = percentile(repeatedEditDurations.slice(0, 50), 0.95);
const repeatedSecondHalf = percentile(repeatedEditDurations.slice(50), 0.95);
assert.ok(
  repeatedSecondHalf <= Math.max(25, repeatedFirstHalf * 4),
  `Repeated edit p95 grew unexpectedly: ${repeatedFirstHalf.toFixed(2)}ms to ${repeatedSecondHalf.toFixed(2)}ms`
);

const canonicalStartedAt = performance.now();
for (const comment of fixture.comments) {
  const resolution = resolveCanonicalCommentTarget(comment, {
    markdown: fixture.markdown
  });
  assert.equal(resolution.state, "resolved");
}
const canonicalFirstPassMs = performance.now() - canonicalStartedAt;
const canonicalWarmDurations = [];

for (let index = 0; index < 20; index += 1) {
  const startedAt = performance.now();
  for (const comment of fixture.comments) {
    resolveCanonicalCommentTarget(comment, { markdown: fixture.markdown });
  }
  canonicalWarmDurations.push(performance.now() - startedAt);
}

assert.ok(canonicalFirstPassMs < 1_000, "Canonical first pass became unbounded.");
assert.ok(
  percentile(canonicalWarmDurations, 0.95) < 250,
  "Warm canonical validation became unbounded."
);

console.log(
  JSON.stringify(
    {
      canonicalFirstPassMs: round(canonicalFirstPassMs),
      canonicalWarmP95Ms: round(percentile(canonicalWarmDurations, 0.95)),
      fixture: {
        chars: fixture.markdown.length,
        comments: fixture.comments.length,
        lines: fixture.markdown.split("\n").length
      },
      operations: operationResults,
      repeatedEdits: {
        count: repeatedEditDurations.length,
        firstHalfP95Ms: round(repeatedFirstHalf),
        maxMs: round(Math.max(...repeatedEditDurations)),
        secondHalfP95Ms: round(repeatedSecondHalf)
      }
    },
    null,
    2
  )
);

function measureChangeSet(name, mutate) {
  const nextMarkdown = mutate(fixture.markdown);
  const startedAt = performance.now();
  const changeSet = deriveMarkdownChangeSet({
    newMarkdown: nextMarkdown,
    oldMarkdown: fixture.markdown,
    source: "manual_source"
  });
  const duration = performance.now() - startedAt;

  assert.ok(changeSet);
  assert.equal(applyMarkdownEdits(fixture.markdown, changeSet.edits), nextMarkdown);
  const safety = isSafeManualAnchorTransformChangeSet({
    affectedAnchorCount: 0,
    changeSet,
    oldMarkdown: fixture.markdown
  });
  operationResults[name] = {
    broad: changeSet.broad,
    derivation: changeSet.derivation,
    durationMs: round(duration),
    hunkCount: changeSet.edits.length,
    safe: safety.safe
  };
}

function createPerformanceFixture() {
  const sections = Array.from({ length: 30 }, (_, index) => {
    const sectionNumber = index + 1;
    const paragraphFiller = ` Supporting detail ${sectionNumber}.`.repeat(82);
    return [
      `## Section ${sectionNumber}`,
      "",
      `Paragraph ${sectionNumber} describes a representative Patchmark plan with links, lists, and enough text for stable selected anchors.${paragraphFiller}`,
      "",
      "| Metric | Current | Next |",
      "| --- | --- | --- |",
      `| Section ${sectionNumber} metric | [Source](https://example.com/${sectionNumber}) | Validate the next step |`,
      "",
      `- Action ${sectionNumber}`,
      `- Review ${sectionNumber}`
    ].join("\n");
  });
  const markdown = `# Performance Fixture\n\n${sections.join("\n\n")}\n`;
  const comments = Array.from({ length: 30 }, (_, index) => {
    const selectedText = `Paragraph ${index + 1} describes a representative Patchmark plan`;
    const start = markdown.indexOf(selectedText);
    assert.notEqual(start, -1);
    return {
      id: `PM-PERF-${index + 1}`,
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_context: {
          kind: "paragraph",
          plain_text: selectedText,
          markdown_text: selectedText,
          selected_start_in_context: 0,
          selected_end_in_context: selectedText.length,
          markdown_start_offset: start,
          markdown_end_offset: start + selectedText.length
        }
      }
    };
  });

  return { comments, markdown };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

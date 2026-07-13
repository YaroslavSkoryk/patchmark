import assert from "node:assert/strict";
import {
  getPatchImpactForCurrentAnchorDisplay,
  getVisibleAnchorStatus,
  getVisibleCommentThreadEntries
} from "../lib/comments/comment-anchor-state.ts";
import {
  cleanCommentAnchorLabel,
  getCollapsedCommentTarget,
  getCleanCommentAnchorLabel,
  normalizeCollapsedCommentText
} from "../lib/comments/comment-card-display.ts";
import { readFileSync } from "node:fs";

function makeSelectedTextComment(overrides = {}) {
  return {
    id: overrides.id ?? "PM-COMMENT-0001",
    type: overrides.type ?? "question",
    status: overrides.status ?? "open",
    anchor: {
      kind: "selected_text",
      selected_text:
        overrides.selectedText ?? "with manageable founder effort",
      containing_heading: overrides.heading ?? "## 3. Market View",
      containing_heading_level: overrides.headingLevel ?? 2,
      ...overrides.anchor
    },
    comment: overrides.comment ?? "Please clarify this claim.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z"
  };
}

function collapsedTarget(comment, options = {}) {
  return getCollapsedCommentTarget({
    comment,
    fallbackLabel: options.fallbackLabel ?? getCleanCommentAnchorLabel(comment),
    locationLabel: options.locationLabel
  });
}

const recoveryImpact = {
  impact_kind: "linked_comment",
  patch_id: "PM-PATCH-0020",
  result: "reanchored"
};

const needsReviewImpact = {
  impact_kind: "anchor_intersects_replaced_range",
  patch_id: "PM-PATCH-0020",
  result: "needs_review"
};

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(getVisibleAnchorStatus("document"), undefined);
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "active",
      latestPatchImpact: needsReviewImpact
    }),
    undefined
  );
}

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  const visibleThread = getVisibleCommentThreadEntries([
    {
      id: "PM-THREAD-0001",
      role: "system",
      content:
        "Patch PM-PATCH-0020 shifted text before this comment and Patchmark recovered the anchor from the selected text.",
      created_at: "2026-07-12T00:00:00.000Z"
    },
    {
      id: "PM-THREAD-0002",
      role: "system",
      content:
        "Patch PM-PATCH-0021 was applied to the document and this comment was re-anchored to the applied replacement.",
      created_at: "2026-07-12T00:01:00.000Z"
    }
  ]);

  assert.deepEqual(visibleThread, []);
}

{
  assert.equal(getVisibleAnchorStatus("ambiguous"), "ambiguous");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "ambiguous",
      latestPatchImpact: needsReviewImpact
    }),
    undefined
  );
}

{
  assert.equal(getVisibleAnchorStatus("not_found"), "not_found");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "not_found",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
}

{
  const visibleThread = getVisibleCommentThreadEntries([
    {
      id: "PM-THREAD-0001",
      role: "system",
      content:
        "Patch PM-PATCH-0020 may have affected this comment anchor. Please review it.",
      created_at: "2026-07-12T00:00:00.000Z"
    },
    {
      id: "PM-THREAD-0002",
      role: "user",
      content: "Can you clarify this wording?",
      created_at: "2026-07-12T00:01:00.000Z"
    },
    {
      id: "PM-THREAD-0003",
      role: "chatgpt",
      content: "This wording means the software should support the launch.",
      created_at: "2026-07-12T00:02:00.000Z"
    },
    {
      id: "PM-THREAD-0004",
      role: "system",
      content: "Patch PM-PATCH-0022 was applied to the document.",
      created_at: "2026-07-12T00:03:00.000Z"
    }
  ]);

  assert.deepEqual(
    visibleThread.map((entry) => entry.id),
    ["PM-THREAD-0002", "PM-THREAD-0003", "PM-THREAD-0004"]
  );
}

{
  const unrelatedReviewState = {
    focus_state: "awaiting_reply"
  };

  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(unrelatedReviewState.focus_state, "awaiting_reply");
}

{
  assert.equal(getVisibleAnchorStatus("active"), undefined);
  assert.equal(getVisibleAnchorStatus("not_found"), "not_found");
  assert.equal(
    getPatchImpactForCurrentAnchorDisplay({
      anchorStatus: "not_found",
      latestPatchImpact: recoveryImpact
    }),
    undefined
  );
}

{
  const target = collapsedTarget(makeSelectedTextComment());

  assert.equal(target.primary, "“with manageable founder effort”");
  assert.equal(target.secondary, "3. Market View");
  assert.equal(target.title, "with manageable founder effort");
  assert.equal(target.variant, "selected_text");
  assert.equal(target.primary.includes("Selected text in"), false);
  assert.equal(target.primary.includes("##"), false);
}

{
  const openTarget = collapsedTarget(makeSelectedTextComment({ status: "open" }));
  const resolvedTarget = collapsedTarget(
    makeSelectedTextComment({ id: "PM-COMMENT-0002", status: "resolved" })
  );

  assert.equal(openTarget.primary, resolvedTarget.primary);
  assert.equal(openTarget.secondary, resolvedTarget.secondary);
}

{
  const longSelectedText =
    "This is a deliberately long selected passage that should remain available in full for the card title while CSS clamps the visible collapsed preview to two lines.";
  const comment = makeSelectedTextComment({ selectedText: longSelectedText });
  const target = collapsedTarget(comment);

  assert.equal(target.title, longSelectedText);
  assert.equal(target.primary, `“${longSelectedText}”`);
  assert.equal(comment.anchor.selected_text, longSelectedText);
}

{
  const multilineTarget = collapsedTarget(
    makeSelectedTextComment({
      selectedText: "  first line\n\nsecond\tline  "
    })
  );

  assert.equal(multilineTarget.primary, "“first line second line”");
  assert.equal(multilineTarget.title, "first line second line");
}

{
  const markdownLikeTarget = collapsedTarget(
    makeSelectedTextComment({
      selectedText:
        'Quotes, Unicode ✓, [link text](https://example.com), and `code` stay literal.'
    })
  );

  assert.equal(
    markdownLikeTarget.primary,
    "“Quotes, Unicode ✓, [link text](https://example.com), and `code` stay literal.”"
  );
}

{
  const emptyTarget = collapsedTarget(
    makeSelectedTextComment({ selectedText: " \n\t " }),
    {
      fallbackLabel: "Selected text in ## ## 3. Market View",
      locationLabel: "## ## 3. Market View"
    }
  );

  assert.equal(emptyTarget.primary, "3. Market View");
  assert.equal(emptyTarget.variant, "location");
}

{
  const sectionComment = {
    ...makeSelectedTextComment(),
    anchor: {
      kind: "section",
      heading: "## 3. Market View",
      heading_level: 2
    }
  };

  assert.equal(
    getCleanCommentAnchorLabel(sectionComment),
    "Whole section: 3. Market View"
  );
  assert.equal(
    cleanCommentAnchorLabel("Selected text in ## ## 3. Market View"),
    "Selected text in 3. Market View"
  );
}

{
  assert.equal(
    normalizeCollapsedCommentText("ordinary citation and content reference prose"),
    "ordinary citation and content reference prose"
  );
}

{
  const commentsPanelSource = readFileSync(
    new URL("../components/comments-panel.tsx", import.meta.url),
    "utf8"
  );
  const documentEditorSource = readFileSync(
    new URL("../components/document-editor.tsx", import.meta.url),
    "utf8"
  );
  const globalCssSource = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8"
  );

  assert.equal(commentsPanelSource.includes("comment-active-label"), false);
  assert.equal(commentsPanelSource.includes("aria-current"), true);
  assert.equal(globalCssSource.includes("-webkit-line-clamp: 2"), true);
  assert.equal(
    globalCssSource.includes("patchmark-comment-open-selected-anchor"),
    true
  );
  assert.equal(
    globalCssSource.includes("patchmark-comment-resolved-selected-anchor"),
    true
  );
  assert.equal(
    globalCssSource.includes("--comment-anchor-resolved-selected-background"),
    true
  );
  assert.equal(
    documentEditorSource.includes("COMMENT_OPEN_SELECTED_HIGHLIGHT_NAME"),
    true
  );
  assert.equal(
    documentEditorSource.includes("COMMENT_RESOLVED_SELECTED_HIGHLIGHT_NAME"),
    true
  );
  assert.equal(
    documentEditorSource.includes(
      "activeCommentState, comments, documentVersion, headings, markdown, mode"
    ),
    true
  );
  assert.equal(
    documentEditorSource.includes("findVisualSelectedTextMatchForResolvedSourceRange"),
    true
  );
  const sourceRangeMatchCall = documentEditorSource.indexOf(
    "const sourceRangeMatch = findVisualSelectedTextMatchForResolvedSourceRange"
  );
  const contextMatchCallAfterSource = documentEditorSource.indexOf(
    "const contextMatch = findVisualAnchorContextMatchForResolvedAnchor",
    sourceRangeMatchCall
  );

  assert.notEqual(sourceRangeMatchCall, -1);
  assert.notEqual(contextMatchCallAfterSource, -1);
  assert.ok(
    sourceRangeMatchCall < contextMatchCallAfterSource
  );
  assert.equal(
    documentEditorSource.includes('querySelector("[data-lexical-editor]")'),
    true
  );
  assert.equal(
    documentEditorSource.includes(
      'normalizeDomText(cellElement.textContent ?? "").length > 0'
    ),
    true
  );
  assert.equal(
    documentEditorSource.includes("scrollRangeIntoViewportIfNeeded"),
    true
  );
  assert.equal(
    documentEditorSource.includes("lastScrolledActiveCommentKeyRef"),
    true
  );
}

console.log("Comment card UX tests passed.");

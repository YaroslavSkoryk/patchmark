import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  createPage,
  createProjectPickerShim,
  evaluate,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit,
  waitForProjectComments
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const sourceProjectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const followUpText =
  "Keep this guidance, but restore acceptable-margin and production-complexity validation.";

if (!sourceProjectDir) {
  throw new Error("Set PATCHMARK_REAL_PROJECT_DIR to a real Patchmark project.");
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-continuation-"));
const projectDir = join(fixtureRoot, basename(sourceProjectDir));
cpSync(sourceProjectDir, projectDir, { recursive: true });

const fixture = prepareFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for patch continuation browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-continuation-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

let client;

try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  const pageWsUrl = await createPage(browserWsUrl, "about:blank");
  client = await CdpClient.connect(pageWsUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(projectDir)
    })
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickVisibleButton(client, "Open Project Folder");
  await waitForProjectComments(client);
  console.log("browser-step: project loaded");

  await openPatchGroupByTitle(client, fixture.linkedPatch.display_title);
  console.log("browser-step: linked group opened");
  await clickVisibleButton(client, "Next pending patch");
  await waitForText(client, "Accept Patch");
  console.log("browser-step: linked patch review opened");
  await evaluate(client, {
    expression: `window.confirm = () => true; true`,
    userGesture: true
  });
  await clickVisibleButton(client, "Accept Patch");
  await waitForText(client, "Continue discussion");
  console.log("browser-step: linked patch applied");

  const appliedState = await readFixtureState(
    client,
    fixture.linkedPatch.id,
    fixture.comment.id,
    fixture.linkedPatch.suggested_text,
    followUpText
  );
  assert.equal(appliedState.patchStatus, "accepted");
  assert.equal(appliedState.commentStatus, "open");
  assert.equal(appliedState.selectedText, fixture.linkedPatch.suggested_text);
  assert.equal(appliedState.documentIncludesSuggestedText, true);

  await clickVisibleButtonNonBlocking(client, "Continue discussion");
  console.log("browser-step: continuation clicked");
  await waitForReplyFocus(client, fixture.comment.id);
  console.log("browser-step: continuation focused");
  await fillFocusedReply(client, followUpText);
  await clickVisibleButton(client, "Save Reply");
  await waitForFixtureReply(client, fixture.comment.id, followUpText);
  console.log("browser-step: follow-up saved");

  await clickVisibleButton(client, "Generate ChatGPT Prompt");
  const exportState = await waitForExportPayload(client, fixture.comment.id);
  console.log("browser-step: prompt generated");
  const exportedComment = exportState.payload.comments.find(
    (comment) => comment.comment_id === fixture.comment.id
  );
  assert.equal(
    exportedComment.thread.some(
      (entry) => entry.role === "user" && entry.content === followUpText
    ),
    true
  );
  assert.equal(
    exportedComment.anchor.selected_text,
    fixture.linkedPatch.suggested_text
  );
  assert.equal(
    typeof exportedComment.context.containing_section_markdown,
    "string"
  );
  const exportedCurrentContextIncludesReplacement =
    exportedComment.context.containing_section_markdown.includes(
      fixture.linkedPatch.suggested_text
    ) ||
    (exportedComment.context.complete_table_ids ?? []).some((tableId) =>
      (exportState.payload.table_contexts ?? []).some(
        (table) =>
          table.table_id === tableId &&
          table.markdown.includes(fixture.linkedPatch.suggested_text)
      )
    );
  assert.equal(exportedCurrentContextIncludesReplacement, true);
  assert.equal(
    exportedComment.related_patch_history.some(
      (patch) =>
        patch.patch_id === fixture.linkedPatch.id &&
        patch.display_title === fixture.linkedPatch.display_title
    ),
    true
  );
  assert.match(exportState.prompt, /current Markdown as the source of truth/i);
  assert.match(
    exportState.prompt,
    /as a revision of an already accepted patch/i
  );

  await clickScopedButton(client, ".comment-export-dialog", "Close");
  await clickVisibleButton(client, "Import ChatGPT Response");
  const followUpImport = createFollowUpImport({
    commentId: fixture.comment.id,
    originalText: fixture.linkedPatch.suggested_text
  });
  await fillImportResponse(client, JSON.stringify(followUpImport, null, 2));
  await clickScopedButton(client, ".comment-import-dialog", "Import");
  const followUpState = await waitForPendingFollowUp(
    client,
    fixture.linkedPatch.id,
    fixture.comment.id
  );
  console.log("browser-step: follow-up patch imported");
  assert.equal(followUpState.acceptedStatus, "accepted");
  assert.equal(followUpState.pendingFollowUpExists, true);

  await openCommentPatchGroupByTitle(
    client,
    fixture.comment.id,
    "Restore validation requirements"
  );
  const followUpGroupText = await evaluate(client, {
    expression: `document.querySelector("[aria-label='Review Patch Group']")?.textContent ?? ""`
  });
  assert.match(followUpGroupText, /Restore validation requirements/);
  assert.match(
    followUpGroupText,
    /Refines:\s*Browser continuation test patch/
  );
  await clickVisibleButton(client, "Next pending patch");
  const pendingReviewText = await evaluate(client, {
    expression: `document.querySelector("[aria-label='Review Patch Proposal']")?.textContent ?? ""`
  });
  assert.match(pendingReviewText, /Restore validation requirements/);
  assert.match(
    pendingReviewText,
    /Refines:\s*Browser continuation test patch/
  );
  assert.match(pendingReviewText, new RegExp(`Patch ID\\s*${followUpState.patchId}`));
  await clickVisibleButton(client, "Accept Patch");
  await waitForText(client, "Follow-up to: Browser continuation test patch");
  const acceptedFollowUpState = await waitForAcceptedFollowUp(
    client,
    fixture.linkedPatch.id,
    followUpState.patchId,
    fixture.comment.id
  );
  assert.equal(acceptedFollowUpState.earlierStatus, "accepted");
  assert.equal(acceptedFollowUpState.followUpStatus, "accepted");
  assert.equal(acceptedFollowUpState.commentStatus, "open");
  await waitForPersistedPatch(
    projectDir,
    followUpState.patchId,
    "accepted"
  );
  console.log("browser-step: follow-up lineage applied");
  await clickScopedButton(client, ".patch-review-dialog", "Close");

  const commentSummaryText = await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.textContent ?? ""`
  });
  assert.match(
    commentSummaryText,
    /Latest change applied:\s*Restore validation requirements/
  );
  assert.match(commentSummaryText, /\d+ applied/);
  assert.match(commentSummaryText, /View related patches/);
  await waitForText(client, "Before applying: Restore validation requirements");

  await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.click(); true`,
    userGesture: true
  });
  await clickCommentPatchButton(client, fixture.comment.id);
  await waitForSelector(client, ".patch-group-list-dialog");
  const relatedPatchTitles = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".patch-group-summary-card h3")).map((heading) => heading.textContent?.trim())`
  });
  assert.ok(
    relatedPatchTitles.indexOf("Browser continuation test patch") <
      relatedPatchTitles.indexOf("Restore validation requirements")
  );
  await clickScopedButton(client, ".patch-group-list-dialog", "Close");

  await applyEdgePatchAndAssertNoContinuation(
    client,
    "Add browser legacy guidance"
  );
  console.log("browser-step: legacy no-link edge applied");
  await applyEdgePatchAndAssertNoContinuation(
    client,
    fixture.differentCommentPatch.display_title
  );
  console.log("browser-step: different-comment edge applied");

  await client.call("Page.reload");
  await waitForEditorShell(client);
  await clickVisibleButton(client, "Open Project Folder");
  await waitForProjectComments(client);
  console.log("browser-step: project reloaded");

  await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.click(); true`,
    userGesture: true
  });
  await clickCommentPatchButton(client, fixture.comment.id);
  await waitForSelector(client, ".patch-group-list-dialog");
  const reloadedRelatedPatchTitles = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".patch-group-summary-card h3")).map((heading) => heading.textContent?.trim())`
  });
  assert.ok(
    reloadedRelatedPatchTitles.includes("Restore validation requirements"),
    `Reloaded related titles: ${JSON.stringify(reloadedRelatedPatchTitles)}`
  );
  await clickCardButton(
    client,
    ".patch-group-summary-card",
    "Restore validation requirements",
    "Review group"
  );
  await waitForSelector(client, "[aria-label='Review Patch Group']");
  await clickVisibleButton(client, "View applied patch");
  await waitForText(client, "Follow-up to: Browser continuation test patch");
  await clickScopedButton(client, ".patch-review-dialog", "Close");

  await openCommentPatchGroupByTitle(
    client,
    fixture.comment.id,
    fixture.linkedPatch.display_title
  );
  await clickVisibleButton(client, "View applied patch");
  await waitForText(client, "Continue discussion");
  console.log("browser-step: accepted patch reopened");
  await clickVisibleButtonNonBlocking(client, "Continue discussion");
  await waitForReplyFocus(client, fixture.comment.id);

  await clickCommentButton(client, fixture.comment.id, "Resolve");
  await waitForCommentStatus(client, fixture.comment.id, "resolved");
  console.log("browser-step: linked comment resolved");
  await openCommentPatchGroupByTitle(
    client,
    fixture.comment.id,
    fixture.linkedPatch.display_title
  );
  await clickVisibleButton(client, "View applied patch");
  const resolvedContinuationCount = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".patch-review-dialog button"))
      .filter((button) => button.textContent?.trim() === "Continue discussion").length`
  });
  assert.equal(resolvedContinuationCount, 0);

  console.log(
    JSON.stringify(
      {
        editorUrl,
        projectDir,
        linkedPatchId: fixture.linkedPatch.id,
        linkedCommentId: fixture.comment.id,
        validated: [
          "apply keeps comment open and re-anchors to replacement",
          "continue activates comment and focuses reply",
          "follow-up export uses current context and accepted history",
          "follow-up import creates a separate titled pending patch",
          "pending and accepted review preserve descriptive lineage",
          "comment summary and version history use descriptive titles",
          "related patches remain chronological and title-first",
          "legacy and different-comment patches have no false lineage",
          "reload preserves thread, titles, lineage, and statuses",
          "resolved comments hide continuation"
        ]
      },
      null,
      2
    )
  );
  console.log("Patch continuation browser tests passed.");
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 1000);
  }
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function prepareFixture(projectDir) {
  const documentPath = join(projectDir, "document.md");
  const commentsPath = join(projectDir, ".patchmark", "comments.json");
  const patchesPath = join(projectDir, ".patchmark", "patches.json");
  const documentMarkdown = readFileSync(documentPath, "utf8");
  const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
  const patches = JSON.parse(readFileSync(patchesPath, "utf8"));
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  const sourcePatch = patches.find((patch) => {
    const comment = patch.comment_id ? commentsById.get(patch.comment_id) : null;
    const currentText =
      comment?.anchor.kind === "selected_text" &&
      countOccurrences(documentMarkdown, comment.anchor.selected_text) === 1
        ? comment.anchor.selected_text
        : patch.applied_text ?? patch.suggested_text;

    return (
      patch.status === "accepted" &&
      comment?.status === "open" &&
      comment.anchor.kind !== "document" &&
      typeof currentText === "string" &&
      currentText.length >= 30 &&
      currentText.length <= 3000 &&
      countOccurrences(documentMarkdown, currentText) === 1
    );
  });

  if (!sourcePatch) {
    throw new Error("Could not find a suitable accepted linked patch fixture.");
  }

  const comment = commentsById.get(sourcePatch.comment_id);
  const originalText =
    comment.anchor.kind === "selected_text" &&
    countOccurrences(documentMarkdown, comment.anchor.selected_text) === 1
      ? comment.anchor.selected_text
      : sourcePatch.applied_text ?? sourcePatch.suggested_text;
  const paragraphs = documentMarkdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        paragraph.length >= 40 &&
        paragraph.length <= 500 &&
        !paragraph.startsWith("#") &&
        !paragraph.includes("|") &&
        paragraph !== originalText &&
        countOccurrences(documentMarkdown, paragraph) === 1
    );

  if (paragraphs.length < 2) {
    throw new Error("Could not find enough unique paragraphs for edge fixtures.");
  }

  const nextPatchNumber =
    patches.reduce((maximum, patch) => {
      const match = /^PM-PATCH-(\d+)$/.exec(patch.id);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
  const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const linkedPatch = {
    id: `PM-PATCH-${String(nextPatchNumber).padStart(4, "0")}`,
    status: "pending",
    comment_id: comment.id,
    display_title: "Browser continuation test patch",
    target_heading: sourcePatch.target_heading,
    original_text: originalText,
    suggested_text: appendRefinement(
      originalText,
      "Browser continuation refinement."
    ),
    reason: "Validates continued refinement through the linked comment.",
    created_at: createdAt
  };
  const noLinkedPatch = {
    id: `PM-PATCH-${String(nextPatchNumber + 1).padStart(4, "0")}`,
    status: "pending",
    original_text: paragraphs[0],
    suggested_text: appendRefinement(
      paragraphs[0],
      "Browser no-link refinement."
    ),
    reason: "Add browser legacy guidance.",
    created_at: createdAt
  };
  const differentComment = {
    id: "PM-COMMENT-BROWSER-OTHER",
    type: "note",
    status: "resolved",
    anchor: { kind: "document" },
    comment: "Check unrelated browser validation guidance.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: createdAt,
    updated_at: createdAt,
    resolved_at: createdAt
  };
  const differentCommentPatch = {
    id: `PM-PATCH-${String(nextPatchNumber + 2).padStart(4, "0")}`,
    status: "pending",
    comment_id: differentComment.id,
    display_title: "Browser different-comment test patch",
    original_text: paragraphs[1],
    suggested_text: appendRefinement(
      paragraphs[1],
      "Browser different-comment refinement."
    ),
    reason: "Validates that unrelated comments do not create false lineage.",
    created_at: createdAt
  };

  const normalizedComments = comments.map((candidate) => ({
    ...candidate,
    export_state: {
      ...candidate.export_state,
      focus_state: "idle",
      marked_for_export_at: undefined
    }
  }));
  writeFileSync(
    commentsPath,
    `${JSON.stringify([...normalizedComments, differentComment], null, 2)}\n`
  );
  writeFileSync(
    patchesPath,
    `${JSON.stringify(
      [...patches, linkedPatch, noLinkedPatch, differentCommentPatch],
      null,
      2
    )}\n`
  );

  return { comment, differentCommentPatch, linkedPatch, noLinkedPatch };
}

function createFollowUpImport({ commentId, originalText }) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Follow-up refinement",
    replies: [],
    patch_proposals: [
      {
        comment_id: commentId,
        display_title: "Restore validation requirements",
        original_text: originalText,
        suggested_text: appendRefinement(
          originalText,
          "Validate acceptable margins and production complexity."
        ),
        suggested_text_sources: [],
        reason: "Restores requirements requested in the latest follow-up.",
        reason_sources: [],
        risk: "Adds validation detail while preserving current guidance.",
        risk_sources: []
      }
    ],
    open_questions: []
  };
}

async function openPatchGroupByTitle(client, title) {
  await clickSelector(client, ".patch-summary-card button");
  await waitForSelector(client, ".patch-group-list-dialog");
  await clickCardButton(client, ".patch-group-summary-card", title, "Review group");
  await waitForSelector(client, "[aria-label='Review Patch Group']");
}

async function openCommentPatchGroupByTitle(client, commentId, title) {
  await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${commentId}`
    )})?.click(); true`,
    userGesture: true
  });
  await waitForSelector(client, `#patchmark-comment-card-${commentId}[data-active='true']`);
  await waitFor(
    client,
    `(() => {
      const card = document.getElementById(${JSON.stringify(
        `patchmark-comment-card-${commentId}`
      )});
      return card ? Array.from(card.querySelectorAll("button"))
        .some((candidate) => /^(Review|View) (related patches|patch|patches|group|groups)$/.test(candidate.textContent?.trim() ?? "") && !candidate.disabled) : false;
    })()`,
    "comment related patches action"
  );
  await clickCommentPatchButton(client, commentId);
  await waitForSelector(client, ".patch-group-list-dialog");
  await clickCardButton(client, ".patch-group-summary-card", title, "Review group");
  await waitForSelector(client, "[aria-label='Review Patch Group']");
}

async function applyEdgePatchAndAssertNoContinuation(client, title) {
  await waitFor(
    client,
    `Array.from(document.querySelectorAll(".patch-summary-card button"))
      .some((button) => button.getClientRects().length > 0 && !button.disabled)`,
    "visible pending patch summary"
  );
  await clickSelector(client, ".patch-summary-card button");
  const edgeReviewState = await waitFor(
    client,
    `document.querySelector(".patch-group-list-dialog")
      ? "list"
      : document.querySelector("[aria-label='Review Patch Group']")
        ? "group"
        : null`,
    "edge patch group review"
  );
  if (edgeReviewState === "list") {
    await clickCardButton(
      client,
      ".patch-group-summary-card",
      title,
      "Review group"
    );
  }
  await waitForSelector(client, "[aria-label='Review Patch Group']");
  await clickVisibleButton(client, "Next pending patch");
  await evaluate(client, {
    expression: `window.confirm = () => true; true`,
    userGesture: true
  });
  await clickVisibleButton(client, "Accept Patch");
  await waitForText(client, "APPLIED");
  const continuationCount = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".patch-review-dialog button"))
      .filter((button) => button.textContent?.trim() === "Continue discussion").length`
  });
  assert.equal(continuationCount, 0);
  await clickScopedButton(client, ".patch-review-dialog", "Close");
}

async function fillFocusedReply(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("[data-comment-reply-input]");
      if (!textarea) throw new Error("Reply textarea not found");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
}

async function fillImportResponse(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector(".comment-import-fields textarea");
      if (!textarea) throw new Error("Import textarea not found");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForReplyFocus(client, commentId) {
  let latestState = null;

  for (let attempt = 0; attempt < 160; attempt += 1) {
    latestState = await evaluate(client, {
      expression: `(() => {
      const card = document.getElementById(${JSON.stringify(
        `patchmark-comment-card-${commentId}`
      )});
      const input = card?.querySelector("[data-comment-reply-input]") ?? null;
      return {
        active: card?.dataset.active === "true",
        activeElementTag: document.activeElement?.tagName ?? null,
        composerMounted: Boolean(input),
        focused: input === document.activeElement,
        patchReviewOpen: Boolean(document.querySelector("[aria-label='Review Patch Proposal']"))
      };
    })()`
    });

    if (
      latestState.active &&
      latestState.composerMounted &&
      latestState.focused &&
      !latestState.patchReviewOpen
    ) {
      return;
    }

    await delay(75);
  }

  throw new Error(
    `Timed out waiting for linked comment reply focus. Latest state: ${JSON.stringify(
      latestState
    )}`
  );
}

async function waitForFixtureReply(client, commentId, text) {
  await waitFor(
    client,
    `(() => {
      const value = window.__patchmarkFixtureWrites.get(".patchmark/comments.json");
      if (!value) return false;
      const comment = JSON.parse(value).find((entry) => entry.id === ${JSON.stringify(commentId)});
      return comment?.status === "open" && comment.thread.some((entry) => entry.role === "user" && entry.content === ${JSON.stringify(text)});
    })()`,
    "persisted follow-up reply"
  );
}

async function waitForCommentStatus(client, commentId, status) {
  await waitFor(
    client,
    `(() => {
      const value = window.__patchmarkFixtureWrites.get(".patchmark/comments.json");
      if (!value) return false;
      const comment = JSON.parse(value).find((entry) => entry.id === ${JSON.stringify(commentId)});
      return comment?.status === ${JSON.stringify(status)};
    })()`,
    `comment ${commentId} status ${status}`
  );
}

async function waitForExportPayload(client, commentId) {
  return waitFor(
    client,
    `(() => {
      const prompt = document.querySelector(".comment-export-json textarea")?.value;
      const json = document.querySelector(".comment-export-payload-details textarea")?.value;
      if (!prompt || !json) return null;
      const payload = JSON.parse(json);
      return payload.comments.some((comment) => comment.comment_id === ${JSON.stringify(commentId)})
        ? { prompt, payload }
        : null;
    })()`,
    "focused comment export payload"
  );
}

async function waitForPendingFollowUp(client, acceptedPatchId, commentId) {
  return waitFor(
    client,
    `(() => {
      const value = window.__patchmarkFixtureWrites.get(".patchmark/patches.json");
      if (!value) return null;
      const patches = JSON.parse(value);
      const accepted = patches.find((patch) => patch.id === ${JSON.stringify(acceptedPatchId)});
      const pending = patches.find((patch) => patch.id !== ${JSON.stringify(acceptedPatchId)} && patch.comment_id === ${JSON.stringify(commentId)} && patch.status === "pending" && patch.display_title === "Restore validation requirements");
      return accepted?.status === "accepted" && pending
        ? { acceptedStatus: accepted.status, patchId: pending.id, pendingFollowUpExists: true, suggestedText: pending.suggested_text }
        : null;
    })()`,
    "separate pending follow-up patch"
  );
}

async function waitForAcceptedFollowUp(
  client,
  earlierPatchId,
  followUpPatchId,
  commentId
) {
  return waitFor(
    client,
    `(() => {
      const patches = JSON.parse(window.__patchmarkFixtureWrites.get(".patchmark/patches.json") ?? "[]");
      const comments = JSON.parse(window.__patchmarkFixtureWrites.get(".patchmark/comments.json") ?? "[]");
      const earlier = patches.find((patch) => patch.id === ${JSON.stringify(earlierPatchId)});
      const followUp = patches.find((patch) => patch.id === ${JSON.stringify(followUpPatchId)});
      const comment = comments.find((entry) => entry.id === ${JSON.stringify(commentId)});
      return earlier?.status === "accepted" && followUp?.status === "accepted"
        ? { earlierStatus: earlier.status, followUpStatus: followUp.status, commentStatus: comment?.status }
        : null;
    })()`,
    "accepted independent follow-up records"
  );
}

async function waitForPersistedPatch(projectDir, patchId, status) {
  const patchesPath = join(projectDir, ".patchmark", "patches.json");

  for (let attempt = 0; attempt < 160; attempt += 1) {
    const patches = JSON.parse(readFileSync(patchesPath, "utf8"));
    const patch = patches.find((candidate) => candidate.id === patchId);

    if (patch?.status === status) {
      return;
    }

    await delay(75);
  }

  throw new Error(`Timed out waiting for persisted patch ${patchId} status ${status}.`);
}

async function readFixtureState(
  client,
  patchId,
  commentId,
  suggestedText,
  expectedFollowUp
) {
  return evaluate(client, {
    expression: `(() => {
      const comments = JSON.parse(window.__patchmarkFixtureWrites.get(".patchmark/comments.json") ?? "[]");
      const patches = JSON.parse(window.__patchmarkFixtureWrites.get(".patchmark/patches.json") ?? "[]");
      const comment = comments.find((entry) => entry.id === ${JSON.stringify(commentId)});
      const patch = patches.find((entry) => entry.id === ${JSON.stringify(patchId)});
      const documentMarkdown = window.__patchmarkFixtureWrites.get("document.md") ?? "";
      return {
        commentStatus: comment?.status ?? null,
        selectedText: comment?.anchor?.selected_text ?? null,
        hasFollowUp: comment?.thread?.some((entry) => entry.role === "user" && entry.content === ${JSON.stringify(expectedFollowUp)}) ?? false,
        patchStatus: patch?.status ?? null,
        documentIncludesSuggestedText: documentMarkdown.includes(${JSON.stringify(suggestedText)})
      };
    })()`
  });
}

async function clickVisibleButton(client, text) {
  await waitFor(
    client,
    `Array.from(document.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled && button.getClientRects().length > 0).length === 1`,
    `visible enabled button: ${text}`
  );
  await evaluate(client, {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll("button"))
        .filter((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled && button.getClientRects().length > 0);
      if (buttons.length !== 1) throw new Error("Expected one visible button ${text}, found " + buttons.length);
      buttons[0].click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickVisibleButtonNonBlocking(client, text) {
  void client.call("Runtime.evaluate", {
    awaitPromise: false,
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll("button"))
        .filter((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled);
      if (buttons.length !== 1) throw new Error("Expected one button ${text}, found " + buttons.length);
      buttons[0].click();
      return true;
    })()`,
    returnByValue: true,
    userGesture: true
  });
  await delay(100);
}

async function clickScopedButton(client, selector, text) {
  await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const buttons = root ? Array.from(root.querySelectorAll("button"))
        .filter((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled) : [];
      if (buttons.length !== 1) throw new Error("Expected one scoped button ${text}, found " + buttons.length);
      buttons[0].click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickSelector(client, selector) {
  await evaluate(client, {
    expression: `(() => {
      const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .filter((element) => element.getClientRects().length > 0 && !element.disabled);
      if (elements.length !== 1) throw new Error("Expected one visible selector ${selector}, found " + elements.length);
      elements[0].click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickCardButton(client, cardSelector, title, buttonText) {
  await evaluate(client, {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll(${JSON.stringify(cardSelector)}))
        .filter((card) => card.textContent?.includes(${JSON.stringify(title)}));
      if (cards.length !== 1) throw new Error("Expected one card ${title}, found " + cards.length);
      const button = Array.from(cards[0].querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(buttonText)} && !candidate.disabled);
      if (!button) throw new Error("Card button not found: ${buttonText}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickCommentPatchButton(client, commentId) {
  await evaluate(client, {
    expression: `(() => {
      const card = document.getElementById(${JSON.stringify(
        `patchmark-comment-card-${commentId}`
      )});
      const button = card ? Array.from(card.querySelectorAll("button"))
        .find((candidate) => /^(Review|View) (related patches|patch|patches|group|groups)$/.test(candidate.textContent?.trim() ?? "") && !candidate.disabled) : null;
      if (!button) throw new Error("Comment patch button not found");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickCommentButton(client, commentId, text) {
  await evaluate(client, {
    expression: `(() => {
      const card = document.getElementById(${JSON.stringify(
        `patchmark-comment-card-${commentId}`
      )});
      const button = card ? Array.from(card.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled) : null;
      if (!button) throw new Error("Comment button not found: ${text}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForText(client, text) {
  return waitFor(
    client,
    `document.body.textContent?.includes(${JSON.stringify(text)}) ?? false`,
    `text: ${text}`
  );
}

async function waitForSelector(client, selector) {
  return waitFor(
    client,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    `selector: ${selector}`
  );
}

async function waitFor(client, expression, description) {
  let latestValue = null;

  for (let attempt = 0; attempt < 160; attempt += 1) {
    latestValue = await evaluate(client, { expression });
    if (latestValue) {
      return latestValue;
    }
    await delay(75);
  }

  throw new Error(
    `Timed out waiting for ${description}. Latest value: ${JSON.stringify(latestValue)}`
  );
}

function countOccurrences(text, search) {
  if (!search) return 0;
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

function appendRefinement(text, refinement) {
  const trimmedEnd = text.trimEnd();

  if (trimmedEnd.startsWith("|") && trimmedEnd.endsWith("|")) {
    const trailingWhitespace = text.slice(trimmedEnd.length);
    return `${trimmedEnd.slice(0, -1).trimEnd()} ${refinement} |${trailingWhitespace}`;
  }

  return `${text} ${refinement}`;
}

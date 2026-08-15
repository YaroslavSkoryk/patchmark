import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";
import {
  PATCH_CONTINUATION_FIXTURE,
  applyPatchContinuationProject
} from "./lib/fixtures/apply-patch-continuation-project.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const evidenceRoot = process.env.PATCHMARK_PATCH_CONTINUATION_EVIDENCE_DIR;
const followUpText = PATCH_CONTINUATION_FIXTURE.followUpReply;
const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const fixtureCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
const projectDir = fixtureCopy.projectRoot;
let chrome;
let client;
let fixture;
let fixtureServer;
let userDataDir;

try {
  fixture = applyPatchContinuationProject(projectDir);
  const initialState = readPersistedContinuationState(projectDir);
  assertInitialContinuationState(initialState, fixture);
  writeContinuationEvidence(evidenceRoot, "initial-state.json", {
    phase: "initial",
    ...summarizeContinuationState(initialState, fixture)
  });
  const inventory = inventoryProject(projectDir);
  fixtureServer = await startFixtureFileServer(projectDir, inventory);
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome was not found for patch continuation browser tests.");
  }

  await assertEditorIsReachable(editorUrl);
  userDataDir = mkdtempSync(join(tmpdir(), "patchmark-continuation-chrome-"));
  chrome = spawn(
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
  await clickVisibleButton(client, "File");
  await clickVisibleButton(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelector(".document-save-banner")?.textContent?.includes("Opened Patchmark project folder")`,
    "project open completion"
  );
  await clickSelector(client, ".application-comments-trigger");
  await waitFor(
    client,
    `document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "true"`,
    "open Comments"
  );
  await waitFor(
    client,
    `document.querySelectorAll("#document-comments-panel .comment-card").length >= 5`,
    "current project comments"
  );
  console.log("browser-step: project loaded");

  await openPatchGroupByTitle(client, fixture.linkedPatch.display_title);
  console.log("browser-step: linked group opened");
  await waitForText(client, "Accept Patch");
  await captureEvidenceScreenshot(client, evidenceRoot, "01-initial-patch-review.png");
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
  assert.deepEqual(appliedState.dependsOnPatchIds, [fixture.basePatch.id]);
  assert.equal(appliedState.documentMarkdown, fixture.afterLinkedMarkdown);
  assert.equal(
    fixture.linkedPatch.suggested_text.includes(appliedState.selectedText),
    true,
    "The linked comment should remain anchored to text retained within the applied replacement."
  );
  assert.equal(appliedState.documentIncludesSuggestedText, true);
  writeContinuationEvidence(evidenceRoot, "linked-applied-state.json", {
    phase: "linked_patch_applied",
    ...summarizeContinuationState(
      readPersistedContinuationState(projectDir),
      fixture
    )
  });
  await captureEvidenceScreenshot(client, evidenceRoot, "02-continuation-ready.png");

  await clickVisibleButtonNonBlocking(client, "Continue discussion");
  console.log("browser-step: continuation clicked");
  await waitForReplyFocus(client, fixture.comment.id);
  console.log("browser-step: continuation focused");
  await fillFocusedReply(client, followUpText);
  await clickVisibleButton(client, "Save Reply");
  await waitForFixtureReply(client, fixture.comment.id, followUpText);
  console.log("browser-step: follow-up saved");

  await clickVisibleButton(client, "Review");
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
    fixture.linkedPatch.suggested_text.includes(
      exportedComment.anchor.selected_text
    ),
    true
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
  await clickVisibleButton(client, "Review");
  await clickVisibleButton(client, "Import ChatGPT Response");
  const followUpImport = createFollowUpImport({
    commentId: fixture.comment.id,
    originalText: fixture.linkedPatch.suggested_text,
    suggestedText: fixture.followUpSuggestedText
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
  assert.equal(followUpState.patchId, fixture.followUpPatchId);

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
  const afterFollowUpState = await waitForPersistedMarkdown(
    projectDir,
    fixture.afterFollowUpMarkdown
  );
  assertContinuationRecords(afterFollowUpState, fixture, {
    differentCommentStatus: "pending",
    followUpStatus: "accepted",
    linkedStatus: "accepted",
    noLinkedStatus: "pending"
  });
  writeContinuationEvidence(evidenceRoot, "follow-up-applied-state.json", {
    phase: "follow_up_applied",
    ...summarizeContinuationState(afterFollowUpState, fixture)
  });
  await captureEvidenceScreenshot(client, evidenceRoot, "03-follow-up-applied.png");
  console.log("browser-step: follow-up lineage applied");
  await clickSelector(client, ".patch-review-workspace-header > button");

  const commentSummaryText = await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.textContent ?? ""`
  });
  assert.match(
    commentSummaryText,
    /Latest change applied:\s*Restore validation requirements/
  );
  await waitForText(client, "Before applying: Restore validation requirements");

  await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.click(); true`,
    userGesture: true
  });
  await clickCommentPatchButton(client, fixture.comment.id);
  await waitForSelector(client, "[data-testid='patch-review-workspace']");
  const relatedPatchTitles = await readReviewQueuePatchTitles(client);
  assert.ok(relatedPatchTitles.includes("Browser continuation test patch"));
  assert.ok(relatedPatchTitles.includes("Restore validation requirements"));
  await clickSelector(client, ".patch-review-workspace-header > button");

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

  const beforeReloadState = await waitForPersistedMarkdown(
    projectDir,
    fixture.finalMarkdown
  );
  assertContinuationRecords(beforeReloadState, fixture, {
    differentCommentStatus: "accepted",
    followUpStatus: "accepted",
    linkedStatus: "accepted",
    noLinkedStatus: "accepted"
  });
  writeContinuationEvidence(evidenceRoot, "pre-reload-final-state.json", {
    phase: "before_reload",
    ...summarizeContinuationState(beforeReloadState, fixture)
  });

  await client.call("Page.reload");
  await waitForEditorShell(client);
  await clickVisibleButton(client, "File");
  await clickVisibleButton(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelector(".document-save-banner")?.textContent?.includes("Opened Patchmark project folder")`,
    "project reopen completion"
  );
  await clickSelector(client, ".application-comments-trigger");
  await waitFor(
    client,
    `document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "true"`,
    "reopen Comments"
  );
  await waitFor(
    client,
    `document.querySelectorAll("#document-comments-panel .comment-card").length >= 5`,
    "current project comments after reload"
  );
  console.log("browser-step: project reloaded");
  const reloadedState = readPersistedContinuationState(projectDir);
  assert.equal(reloadedState.markdown, fixture.finalMarkdown);
  assertContinuationRecords(reloadedState, fixture, {
    differentCommentStatus: "accepted",
    followUpStatus: "accepted",
    linkedStatus: "accepted",
    noLinkedStatus: "accepted"
  });
  writeContinuationEvidence(evidenceRoot, "reloaded-state.json", {
    phase: "reloaded",
    ...summarizeContinuationState(reloadedState, fixture)
  });

  await evaluate(client, {
    expression: `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${fixture.comment.id}`
    )})?.click(); true`,
    userGesture: true
  });
  await clickCommentPatchButton(client, fixture.comment.id);
  await waitForSelector(client, "[data-testid='patch-review-workspace']");
  const reloadedRelatedPatchTitles = await readReviewQueuePatchTitles(client);
  assert.ok(
    reloadedRelatedPatchTitles.includes("Restore validation requirements"),
    `Reloaded related titles: ${JSON.stringify(reloadedRelatedPatchTitles)}`
  );
  await selectReviewPatchByTitle(client, "Restore validation requirements");
  await waitForText(client, "Follow-up to: Browser continuation test patch");
  await captureEvidenceScreenshot(client, evidenceRoot, "04-reloaded-lineage.png");
  await clickSelector(client, ".patch-review-workspace-header > button");

  await openCommentPatchGroupByTitle(
    client,
    fixture.comment.id,
    fixture.linkedPatch.display_title
  );
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
  const resolvedContinuationCount = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".patch-review-dialog button"))
      .filter((button) => button.textContent?.trim() === "Continue discussion").length`
  });
  assert.equal(resolvedContinuationCount, 0);

  const finalState = readPersistedContinuationState(projectDir);
  assert.equal(finalState.markdown, fixture.finalMarkdown);
  assertContinuationRecords(finalState, fixture, {
    differentCommentStatus: "accepted",
    followUpStatus: "accepted",
    linkedStatus: "accepted",
    noLinkedStatus: "accepted"
  });
  assert.equal(
    finalState.comments.find((comment) => comment.id === fixture.comment.id)
      ?.status,
    "resolved"
  );
  writeContinuationEvidence(evidenceRoot, "final-state.json", {
    phase: "resolved",
    ...summarizeContinuationState(finalState, fixture)
  });
  if (evidenceRoot) {
    writeFileSync(join(evidenceRoot, "final-document.md"), finalState.markdown);
  }

  console.log(
    JSON.stringify(
      {
        fixture: {
          documentId: fixture.documentId,
          projectId: fixture.projectId
        },
        linkedPatchId: fixture.linkedPatch.id,
        linkedCommentId: fixture.comment.id,
        validated: [
          "apply keeps comment open and re-anchors to replacement",
          "continue activates comment and focuses reply",
          "follow-up export uses current context and accepted history",
          "follow-up import creates a separate titled pending patch",
          "pending and accepted review preserve descriptive lineage",
          "comment summary and version history use descriptive titles",
          "related patches remain batch-accessible and title-first",
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
  if (chrome) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 1000);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 1000);
    }
  }
  await fixtureServer?.close();
  if (userDataDir) {
    rmSync(userDataDir, { force: true, recursive: true });
    assert.equal(existsSync(userDataDir), false);
  }
  fixtureCopy.cleanup();
  assert.equal(existsSync(fixtureCopy.temporaryRoot), false);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
}

function readPersistedContinuationState(projectDir) {
  return {
    comments: JSON.parse(
      readFileSync(join(projectDir, ".patchmark", "comments.json"), "utf8")
    ),
    markdown: readFileSync(join(projectDir, "document.md"), "utf8"),
    patches: JSON.parse(
      readFileSync(join(projectDir, ".patchmark", "patches.json"), "utf8")
    ),
    unrelatedDocumentMarkdown: readFileSync(
      join(
        projectDir,
        PATCH_CONTINUATION_FIXTURE.unrelatedDocumentFileName
      ),
      "utf8"
    )
  };
}

function assertInitialContinuationState(state, fixture) {
  assert.equal(state.markdown, fixture.initialMarkdown);
  assert.equal(state.comments.length, 14);
  assert.equal(state.patches.length, 5);
  assertContinuationRecords(state, fixture, {
    differentCommentStatus: "pending",
    followUpStatus: null,
    linkedStatus: "pending",
    noLinkedStatus: "pending"
  });
}

function assertContinuationRecords(
  state,
  fixture,
  {
    differentCommentStatus,
    followUpStatus,
    linkedStatus,
    noLinkedStatus
  }
) {
  const patchesById = new Map(state.patches.map((patch) => [patch.id, patch]));
  assert.equal(patchesById.size, state.patches.length);
  assert.equal(patchesById.get(fixture.basePatch.id)?.status, "accepted");
  assert.equal(patchesById.get(fixture.linkedPatch.id)?.status, linkedStatus);
  assert.deepEqual(
    patchesById.get(fixture.linkedPatch.id)?.depends_on_patch_ids,
    [fixture.basePatch.id]
  );
  assert.equal(
    patchesById.get(fixture.noLinkedPatch.id)?.status,
    noLinkedStatus
  );
  assert.equal(
    patchesById.get(fixture.differentCommentPatch.id)?.status,
    differentCommentStatus
  );
  assert.equal(
    patchesById.get(fixture.followUpPatchId)?.status ?? null,
    followUpStatus
  );
  assert.deepEqual(
    patchesById.get(fixture.unrelatedPatch.id),
    fixture.unrelatedPatch
  );
  assert.equal(
    state.unrelatedDocumentMarkdown,
    fixture.unrelatedDocumentMarkdown
  );
  assert.equal(
    state.markdown.includes(fixture.unrelatedDocumentSentinel),
    false
  );
  assert.equal(
    state.markdown.includes(fixture.unrelatedPatchSentinel),
    false
  );
  if (linkedStatus === "accepted") {
    assert.equal(
      countOccurrences(state.markdown, "Browser continuation refinement."),
      1
    );
  }
  if (followUpStatus === "accepted") {
    assert.equal(
      countOccurrences(state.markdown, fixture.followUpRefinement),
      1
    );
  }
}

async function waitForPersistedMarkdown(projectDir, expectedMarkdown) {
  let latestState = null;

  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      latestState = readPersistedContinuationState(projectDir);
      if (latestState.markdown === expectedMarkdown) {
        return latestState;
      }
    } catch {
      latestState = null;
    }
    await delay(75);
  }

  throw new Error(
    `Timed out waiting for exact persisted continuation Markdown. Latest bytes: ${latestState?.markdown.length ?? 0}.`
  );
}

function summarizeContinuationState(state, fixture) {
  const patchesById = new Map(state.patches.map((patch) => [patch.id, patch]));
  const linkedComment = state.comments.find(
    (comment) => comment.id === fixture.comment.id
  );
  return {
    commentStatus: linkedComment?.status ?? null,
    documentBytes: Buffer.byteLength(state.markdown),
    markerCounts: {
      continuation: countOccurrences(
        state.markdown,
        "Browser continuation refinement."
      ),
      followUp: countOccurrences(state.markdown, fixture.followUpRefinement),
      unrelatedDocument: countOccurrences(
        state.markdown,
        fixture.unrelatedDocumentSentinel
      ),
      unrelatedPatch: countOccurrences(
        state.markdown,
        fixture.unrelatedPatchSentinel
      )
    },
    patchStatuses: {
      base: patchesById.get(fixture.basePatch.id)?.status ?? null,
      differentComment:
        patchesById.get(fixture.differentCommentPatch.id)?.status ?? null,
      followUp: patchesById.get(fixture.followUpPatchId)?.status ?? null,
      linked: patchesById.get(fixture.linkedPatch.id)?.status ?? null,
      noLinked: patchesById.get(fixture.noLinkedPatch.id)?.status ?? null,
      unrelated: patchesById.get(fixture.unrelatedPatch.id)?.status ?? null
    },
    prerequisitePatchIds:
      patchesById.get(fixture.linkedPatch.id)?.depends_on_patch_ids ?? [],
    replyPersisted:
      linkedComment?.thread.some(
        (entry) =>
          entry.role === "user" && entry.content === fixture.followUpReply
      ) ?? false,
    unrelatedDocumentUnchanged:
      state.unrelatedDocumentMarkdown === fixture.unrelatedDocumentMarkdown,
    unrelatedPatchUnchanged:
      JSON.stringify(patchesById.get(fixture.unrelatedPatch.id)) ===
      JSON.stringify(fixture.unrelatedPatch)
  };
}

function writeContinuationEvidence(evidenceRoot, fileName, value) {
  if (!evidenceRoot) {
    return;
  }
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    join(evidenceRoot, fileName),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

async function captureEvidenceScreenshot(client, evidenceRoot, fileName) {
  if (!evidenceRoot) {
    return;
  }
  mkdirSync(evidenceRoot, { recursive: true });
  const screenshot = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(
    join(evidenceRoot, fileName),
    Buffer.from(screenshot.data, "base64")
  );
}

function createFollowUpImport({ commentId, originalText, suggestedText }) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Follow-up refinement",
    replies: [],
    patch_proposals: [
      {
        comment_id: commentId,
        display_title: PATCH_CONTINUATION_FIXTURE.followUpDisplayTitle,
        original_text: originalText,
        suggested_text: suggestedText,
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
  await waitForSelector(client, "[data-testid='patch-review-workspace']");
  await selectReviewPatchByTitle(client, title);
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
  await waitForSelector(client, "[data-testid='patch-review-workspace']");
  await selectReviewPatchByTitle(client, title);
}

async function applyEdgePatchAndAssertNoContinuation(client, title) {
  await clickVisibleButton(client, "Review");
  await clickVisibleButton(client, "Review patch proposals");
  await waitForSelector(client, "[data-testid='patch-review-workspace']");
  await selectReviewPatchByTitle(client, title);
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
  await clickSelector(client, ".patch-review-workspace-header > button");
}

async function selectReviewPatchByTitle(client, title) {
  const batchCount = await evaluate(client, {
    expression: `document.querySelectorAll(".patch-review-batch-switcher button").length`
  });

  for (let index = 0; index < batchCount; index += 1) {
    await evaluate(client, {
      expression: `(() => {
        const button = document.querySelectorAll(".patch-review-batch-switcher button")[${index}];
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      userGesture: true
    });
    await delay(50);
    const selected = await evaluate(client, {
      expression: `(() => {
        const button = Array.from(document.querySelectorAll(".patch-review-queue-row button"))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(title)}));
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      userGesture: true
    });
    if (selected) {
      await waitFor(
        client,
        `document.querySelector("[aria-label='Review Patch Proposal'] h2")?.textContent?.includes(${JSON.stringify(title)})`,
        `selected review patch ${title}`
      );
      return;
    }
  }

  throw new Error(`Review patch not found: ${title}`);
}

async function readReviewQueuePatchTitles(client) {
  const batchCount = await evaluate(client, {
    expression: `document.querySelectorAll(".patch-review-batch-switcher button").length`
  });
  const titles = [];

  for (let index = 0; index < batchCount; index += 1) {
    await evaluate(client, {
      expression: `document.querySelectorAll(".patch-review-batch-switcher button")[${index}]?.click(); true`,
      userGesture: true
    });
    await delay(50);
    titles.push(
      ...(await evaluate(client, {
        expression: `Array.from(document.querySelectorAll(".patch-review-queue-row strong"))
          .map((heading) => heading.textContent?.trim())
          .filter(Boolean)`
      }))
    );
  }

  return [...new Set(titles)];
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
        dependsOnPatchIds: patch?.depends_on_patch_ids ?? [],
        documentMarkdown,
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  clickButtonByText,
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

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const screenshotPath = process.env.PATCHMARK_COMMENT_COMPOSER_SCREENSHOT;
const rewriteWorkspaceScreenshotPath =
  process.env.PATCHMARK_REWRITE_WORKSPACE_SCREENSHOT;
const rewriteWorkspaceReviewScreenshotPath =
  process.env.PATCHMARK_REWRITE_REVIEW_SCREENSHOT;
const rewriteWorkspaceTableScreenshotPath =
  process.env.PATCHMARK_REWRITE_TABLE_SCREENSHOT;
const preambleTarget =
  "Preamble selection has no deterministic containing section.";
const paragraphTarget =
  "Paragraph selection remains available without using a context menu.";
const tableTarget =
  "Break-even must be calculated after ingredient cost, packaging, labor, delivery, utilities, admin, accounting, tax/VAT handling, staff, and facility costs.";
const longRewriteUrl =
  "https://example.com/source/" + "long-path-segment-".repeat(18) + "final";
const longRewriteIdentifier =
  "PATCHMARK_REWRITE_IDENTIFIER_" + "UNBROKEN_SEGMENT_".repeat(22) + "END";
const longRewriteCodeLine =
  "const rewriteWorkspaceConstraint = \"" + "code-content-".repeat(28) + "\";";
const leftEdgeTarget = "Left edge selection target.";
const rightEdgeTarget = "Right edge selection target.";
const keyboardTarget =
  "Keyboard-created selections expose the same anchored comment action.";
const linkLabel = "Evidence link";
const multiBlockStart = "Multi-block anchor first paragraph.";
const multiBlockEnd = "Multi-block anchor second paragraph.";
const secondDocumentTarget =
  "Second-document selection must never reuse the first document draft.";

await run();

async function run() {
  const fixtureDir = createFixture();
  const fixtureInventory = inventoryProject(fixtureDir);
  const fixtureServer = await startFixtureFileServer(
    fixtureDir,
    fixtureInventory
  );
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the comment composer browser test."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-comment-composer-chrome-")
  );
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
        directories: fixtureInventory.directories,
        files: fixtureInventory.files,
        projectName: basename(fixtureDir)
      })
    });
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 820,
      mobile: false,
      width: 1500
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await waitForVisualEditor(client);

    let initialFingerprint = fingerprintProject(fixtureDir);
    const initialDocumentContentFingerprint = fingerprintDocumentContent(fixtureDir);
    const initialDocumentManifestReviewState = readDocumentManifestReviewState(
      fixtureDir,
      "doc_action"
    );
    await evaluate(client, {
      expression: `(() => {
        window.__patchmarkSelectionActionsEditorNode =
          document.querySelector("[aria-label='editable markdown']");
        return Boolean(window.__patchmarkSelectionActionsEditorNode);
      })()`
    });
    await installRewritePersistenceObserver(client);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const paragraphAction = await waitForSelectionAction(
      client,
      paragraphTarget
    );
    assertActionInViewport(paragraphAction);
    const chooserOpenStartedAt = Date.now();
    await openSelectionChooser(client);
    const paragraphChooser = await waitForChooser(
      client,
      paragraphTarget,
      "selection"
    );
    const chooserOpenLatencyMs = Date.now() - chooserOpenStartedAt;
    assertChooserInViewport(paragraphChooser);
    assertCompleteChooser(paragraphChooser);
    assert.match(paragraphChooser.text, /Action Plan/);
    assert.ok(paragraphChooser.selectionLatencyMs < 1000);
    assert.ok(chooserOpenLatencyMs < 1000);
    assert.equal(
      await evaluate(client, {
        expression: `document.querySelector("[aria-label='editable markdown']") === window.__patchmarkSelectionActionsEditorNode`
      }),
      true,
      "Opening the chooser must not remount the editor."
    );
    await cancelChooser(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Opening and cancelling the shared chooser must not write project files."
    );

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    const rewriteWorkspaceOpenStartedAt = Date.now();
    await chooseSelectionAction(client, "rewrite_selected_text");
    const rewriteWorkspace = await waitFor(
      client,
      "Rewrite Workspace",
      `(() => {
        const backdrop = document.querySelector("[data-testid='rewrite-workspace']");
        const workspace = backdrop?.querySelector(".rewrite-workspace");
        const current = workspace?.querySelector("[aria-label='Current document text Visual reference']");
        const draft = workspace?.querySelector("[aria-label='My rewrite Visual editor']");
        if (!backdrop || !workspace || !current || !draft) return null;
        const backdropRect = backdrop.getBoundingClientRect();
        const workspaceRect = workspace.getBoundingClientRect();
        const currentSurface = workspace.querySelector(".rewrite-current-pane .rewrite-editor-surface");
        const draftSurface = workspace.querySelector(".rewrite-draft-pane .rewrite-editor-surface");
        const bodyPanel = workspace.querySelector(".rewrite-workspace-body");
        const currentPane = workspace.querySelector(".rewrite-current-pane");
        const draftPane = workspace.querySelector(".rewrite-draft-pane");
        const actionBar = workspace.querySelector(".rewrite-workspace-rewrite-footer");
        const reviewScreen = workspace.querySelector(".rewrite-workspace-review-screen");
        const currentPaneRect = currentPane.getBoundingClientRect();
        const draftPaneRect = draftPane.getBoundingClientRect();
        const bodyPanelRect = bodyPanel.getBoundingClientRect();
        const actionBarRect = actionBar.getBoundingClientRect();
        return {
          current: current.textContent.trim(),
          draft: draft.textContent.trim(),
          currentEditable: current.getAttribute("contenteditable"),
          currentReadOnly: current.getAttribute("aria-readonly"),
          draftEditable: draft.getAttribute("contenteditable"),
          activeMode: workspace.querySelector("[aria-label='Rewrite comparison mode'] [aria-pressed='true']")?.textContent.trim(),
          activeScreen: workspace.querySelector("[aria-label='Rewrite workspace screens'] [aria-selected='true']")?.textContent.trim(),
          screenLabels: Array.from(workspace.querySelectorAll("[aria-label='Rewrite workspace screens'] [role='tab']")).map((tab) => tab.textContent.trim()),
          backdropRect: {
            height: Math.round(backdropRect.height),
            left: Math.round(backdropRect.left),
            top: Math.round(backdropRect.top),
            width: Math.round(backdropRect.width)
          },
          workspaceRect: {
            height: Math.round(workspaceRect.height),
            left: Math.round(workspaceRect.left),
            top: Math.round(workspaceRect.top),
            width: Math.round(workspaceRect.width)
          },
          bodyOverflow: getComputedStyle(document.body).overflow,
          workspaceOverflow: getComputedStyle(workspace).overflow,
          bodyPanelOverflow: getComputedStyle(bodyPanel).overflow,
          currentOverflowX: getComputedStyle(currentSurface).overflowX,
          currentOverflowY: getComputedStyle(currentSurface).overflowY,
          draftOverflowX: getComputedStyle(draftSurface).overflowX,
          draftOverflowY: getComputedStyle(draftSurface).overflowY,
          bodyPanelHeight: Math.round(bodyPanelRect.height),
          editorSurfaceHeight: Math.round(currentSurface.getBoundingClientRect().height),
          actionBarHeight: Math.round(actionBarRect.height),
          paneWidthDifference: Math.abs(Math.round(currentPaneRect.width - draftPaneRect.width)),
          reviewVisible: reviewScreen.getClientRects().length > 0,
          horizontalOverflow: workspace.scrollWidth > workspace.clientWidth ||
            currentSurface.scrollWidth > currentSurface.clientWidth + 1 ||
            draftSurface.scrollWidth > draftSurface.clientWidth + 1,
          hasPersistentActions: ["Close", "ChatGPT Review", "Apply rewrite"].every((label) =>
            Array.from(workspace.querySelectorAll("button")).some((button) =>
              button.textContent.trim() === label && button.getClientRects().length > 0
            )
          ),
          leftLabel: workspace.querySelector(".rewrite-current-pane")?.textContent,
          rightLabel: workspace.querySelector(".rewrite-draft-pane")?.textContent
        };
      })()`
    );
    const rewriteWorkspaceOpenLatencyMs = Date.now() - rewriteWorkspaceOpenStartedAt;
    assert.ok(rewriteWorkspaceOpenLatencyMs < 1000);
    assert.equal(rewriteWorkspace.current, paragraphTarget);
    assert.equal(rewriteWorkspace.draft, paragraphTarget);
    assert.equal(rewriteWorkspace.activeMode, "Visual");
    assert.equal(rewriteWorkspace.activeScreen, "Rewrite");
    assert.deepEqual(rewriteWorkspace.screenLabels, ["Rewrite", "ChatGPT Review"]);
    assert.notEqual(rewriteWorkspace.currentEditable, "true");
    assert.equal(rewriteWorkspace.currentReadOnly, "true");
    assert.equal(rewriteWorkspace.draftEditable, "true");
    assert.deepEqual(rewriteWorkspace.backdropRect, {
      height: 820,
      left: 0,
      top: 0,
      width: 1500
    });
    assert.deepEqual(rewriteWorkspace.workspaceRect, rewriteWorkspace.backdropRect);
    assert.equal(rewriteWorkspace.bodyOverflow, "hidden");
    assert.equal(rewriteWorkspace.workspaceOverflow, "hidden");
    assert.equal(rewriteWorkspace.bodyPanelOverflow, "hidden");
    assert.equal(rewriteWorkspace.currentOverflowX, "hidden");
    assert.equal(rewriteWorkspace.currentOverflowY, "auto");
    assert.equal(rewriteWorkspace.draftOverflowX, "hidden");
    assert.equal(rewriteWorkspace.draftOverflowY, "auto");
    assert.ok(rewriteWorkspace.bodyPanelHeight >= 580);
    assert.ok(rewriteWorkspace.editorSurfaceHeight >= 520);
    assert.ok(rewriteWorkspace.actionBarHeight <= 56);
    assert.ok(rewriteWorkspace.paneWidthDifference <= 1);
    assert.equal(rewriteWorkspace.reviewVisible, false);
    assert.equal(rewriteWorkspace.horizontalOverflow, false);
    assert.equal(rewriteWorkspace.hasPersistentActions, true);
    assert.match(rewriteWorkspace.leftLabel, /Current document text/);
    assert.match(rewriteWorkspace.rightLabel, /My rewrite/);
    if (rewriteWorkspaceScreenshotPath) {
      await saveScreenshot(client, rewriteWorkspaceScreenshotPath);
    }
    const markdownModeStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Markdown");
    const markdownWorkspace = await waitFor(
      client,
      "Rewrite Workspace Markdown mode",
      `(() => {
        const current = document.querySelector("[aria-label='Current document text Markdown reference']");
        const draft = document.querySelector("#rewrite-human-draft");
        return current && draft ? {
          current: current.value,
          currentReadOnly: current.readOnly,
          draft: draft.value,
          draftReadOnly: draft.readOnly,
          activeMode: document.querySelector("[aria-label='Rewrite comparison mode'] [aria-pressed='true']")?.textContent.trim()
        } : null;
      })()`
    );
    const rewriteVisualToMarkdownLatencyMs = Date.now() - markdownModeStartedAt;
    assert.ok(rewriteVisualToMarkdownLatencyMs < 1000);
    assert.equal(markdownWorkspace.current, paragraphTarget);
    assert.equal(markdownWorkspace.draft, paragraphTarget);
    assert.equal(markdownWorkspace.currentReadOnly, true);
    assert.equal(markdownWorkspace.draftReadOnly, false);
    assert.equal(markdownWorkspace.activeMode, "Markdown");

    const sourceRewriteDraft = `${paragraphTarget} Human clarification.`;
    const rewriteDraftSaveStartedAt = Date.now();
    await setRewriteMarkdownDraft(client, sourceRewriteDraft);
    const visualModeStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "Markdown draft represented visually",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Human clarification.")`
    );
    const rewriteMarkdownToVisualLatencyMs = Date.now() - visualModeStartedAt;
    assert.ok(rewriteMarkdownToVisualLatencyMs < 1000);
    const rewriteVisualTypingStartedAt = Date.now();
    await appendToRewriteVisualDraft(client, " Visual refinement.");
    await waitFor(
      client,
      "Visual rewrite transaction",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    const rewriteVisualTypingLatencyMs = Date.now() - rewriteVisualTypingStartedAt;
    assert.ok(rewriteVisualTypingLatencyMs < 1000);
    await clickRewriteWorkspaceButton(client, "Markdown");
    const rewriteDraft = await waitFor(
      client,
      "Visual rewrite serialized to Markdown",
      `document.querySelector("#rewrite-human-draft")?.value ?? null`,
      (value) =>
        typeof value === "string" &&
        value.includes("Human clarification.") &&
        value.includes("Visual refinement.")
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "repeated Visual mode",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    await clickRewriteWorkspaceButton(client, "Markdown");
    assert.equal(
      await waitFor(
        client,
        "stable repeated rewrite round trip",
        `document.querySelector("#rewrite-human-draft")?.value ?? null`
      ),
      rewriteDraft
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "Visual mode before semantic review",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    await waitFor(
      client,
      "project-saved rewrite draft",
      `document.querySelector(".rewrite-save-state")?.textContent?.includes("Saved to project")`
    );
    const rewriteDraftSaveLatencyMs = Date.now() - rewriteDraftSaveStartedAt;
    assert.ok(rewriteDraftSaveLatencyMs < 2000);
    const rewriteAuthoritativeSaveMetrics = await waitFor(
      client,
      "rewrite authoritative save metrics",
      `window.__patchmarkRewritePersistenceEvents?.at(-1) ?? null`
    );
    assert.ok(rewriteAuthoritativeSaveMetrics.durationMs < 2000);
    assert.equal(rewriteAuthoritativeSaveMetrics.revision >= 1, true);
    await pressEscape(client);
    assert.equal(
      await evaluate(client, {
        expression: `Boolean(document.querySelector("[data-testid='rewrite-workspace']")) && !document.querySelector("[aria-label='Close Rewrite Workspace?']")`
      }),
      true,
      "Escape must not close the full Rewrite Workspace or open its close confirmation."
    );
    const screenSwitchSaveEventCount = await evaluate(client, {
      expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
    });
    const rewriteSelectionBeforeReview = await evaluate(client, {
      expression: `(() => {
        window.__patchmarkRewriteDraftEditorNode =
          document.querySelector("[aria-label='My rewrite Visual editor']");
        const walker = document.createTreeWalker(
          window.__patchmarkRewriteDraftEditorNode,
          NodeFilter.SHOW_TEXT
        );
        let node = walker.nextNode();
        while (node && !node.textContent.includes("Visual refinement.")) {
          node = walker.nextNode();
        }
        if (!node) return null;
        const start = node.textContent.indexOf("Visual refinement.");
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "Visual refinement.".length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      })()`
    });
    assert.equal(rewriteSelectionBeforeReview, "Visual refinement.");
    const rewriteToReviewStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "ChatGPT Review");
    const reviewScreen = await waitFor(
      client,
      "ChatGPT Review workspace screen",
      `(() => {
        const reviewScreen = document.querySelector("#rewrite-workspace-review-screen");
        const rewriteScreen = document.querySelector("#rewrite-workspace-rewrite-screen");
        return reviewScreen && !reviewScreen.hidden ? {
          activeScreen: document.querySelector("[aria-label='Rewrite workspace screens'] [aria-selected='true']")?.textContent.trim(),
          draftEditorMounted: document.querySelector("[aria-label='My rewrite Visual editor']") === window.__patchmarkRewriteDraftEditorNode,
          hasIntent: Boolean(document.querySelector("#rewrite-intent-note")),
          hasImport: Array.from(reviewScreen.querySelectorAll("button")).some((button) => button.textContent.trim() === "Import semantic review"),
          hasPromptExport: Array.from(reviewScreen.querySelectorAll("button")).some((button) => button.textContent.trim() === "Review meaning with ChatGPT"),
          modeControlVisible: document.querySelector("[aria-label='Rewrite comparison mode']")?.getClientRects().length > 0,
          rewriteHidden: rewriteScreen.hidden,
          visibleComparisonPanes: Array.from(document.querySelectorAll(".rewrite-text-pane")).filter((pane) => pane.getClientRects().length > 0).length
        } : null;
      })()`
    );
    const rewriteToReviewLatencyMs = Date.now() - rewriteToReviewStartedAt;
    assert.ok(rewriteToReviewLatencyMs < 1000);
    assert.equal(reviewScreen.activeScreen, "ChatGPT Review");
    assert.equal(reviewScreen.draftEditorMounted, true);
    assert.equal(reviewScreen.hasIntent, true);
    assert.equal(reviewScreen.hasImport, true);
    assert.equal(reviewScreen.hasPromptExport, true);
    assert.equal(reviewScreen.modeControlVisible, false);
    assert.equal(reviewScreen.rewriteHidden, true);
    assert.equal(reviewScreen.visibleComparisonPanes, 0);
    if (rewriteWorkspaceReviewScreenshotPath) {
      await saveScreenshot(client, rewriteWorkspaceReviewScreenshotPath);
    }
    await delay(150);
    assert.equal(
      await evaluate(client, {
        expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
      }),
      screenSwitchSaveEventCount,
      "Opening ChatGPT Review must not create a canonical draft revision."
    );
    const reviewToRewriteStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Rewrite");
    await waitFor(
      client,
      "mounted Rewrite screen restored",
      `(() => {
        const screen = document.querySelector("#rewrite-workspace-rewrite-screen");
        const draft = document.querySelector("[aria-label='My rewrite Visual editor']");
        const selection = window.getSelection();
        return !screen?.hidden && draft === window.__patchmarkRewriteDraftEditorNode && draft.textContent.includes("Visual refinement.") ? {
          selectedText: selection.toString(),
          selectionInDraft: draft.contains(selection.anchorNode)
        } : null;
      })()`
    );
    const reviewToRewriteLatencyMs = Date.now() - reviewToRewriteStartedAt;
    assert.ok(reviewToRewriteLatencyMs < 1000);
    assert.equal(
      await evaluate(client, {
        expression: `document.querySelector("[aria-label='Rewrite comparison mode'] [aria-pressed='true']")?.textContent.trim()`
      }),
      "Visual"
    );
    const restoredRewriteSelection = await evaluate(client, {
      expression: `(() => {
        const draft = document.querySelector("[aria-label='My rewrite Visual editor']");
        const selection = window.getSelection();
        return {
          selectedText: selection.toString(),
          selectionInDraft: draft.contains(selection.anchorNode)
        };
      })()`
    });
    assert.equal(restoredRewriteSelection.selectedText, "Visual refinement.");
    assert.equal(restoredRewriteSelection.selectionInDraft, true);
    await clickRewriteWorkspaceButton(client, "ChatGPT Review");
    const rewritePromptStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Review meaning with ChatGPT");
    const promptText = await waitFor(
      client,
      "manual rewrite review prompt",
      `document.querySelector("[aria-label='Semantic review prompt']")?.value ?? null`
    );
    const rewritePromptLatencyMs = Date.now() - rewritePromptStartedAt;
    assert.ok(rewritePromptLatencyMs < 1000);
    assert.match(promptText, /patchmark\.human_rewrite_review_request/);
    assert.match(promptText, /patchmark\.human_rewrite_review_import/);
    assert.match(promptText, /rewrite_session_/);
    assert.match(promptText, /rewrite_review_/);
    const requestPayloadMatch = /Request payload:\s*```json\s*([\s\S]*?)\s*```/.exec(promptText);
    assert.ok(requestPayloadMatch, "Rewrite review request payload missing.");
    const requestPayload = JSON.parse(requestPayloadMatch[1]);
    await clickRewriteDialogButton(client, "Done");
    await clickRewriteWorkspaceButton(client, "Import semantic review");
    const semanticReviewResponse = createRewriteSemanticReviewResponse(requestPayload);
    await evaluate(client, {
      expression: `(() => {
        const textarea = document.querySelector("[aria-label='Semantic review response JSON']");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        ).set;
        setter.call(textarea, ${JSON.stringify(JSON.stringify(semanticReviewResponse))});
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`
    });
    await clickRewriteDialogButton(client, "Import review");
    const importedReview = await waitFor(
      client,
      "current semantic rewrite review",
      `(() => {
        const review = document.querySelector(".rewrite-review-pane")?.textContent ?? "";
        return review.includes("Current draft review") ? review : null;
      })()`
    );
    for (const category of [
      "Meaning preserved",
      "Meaning changed",
      "Important omissions",
      "New claims",
      "Contradictions",
      "Certainty changes",
      "Source and citation impact",
      "Ambiguities",
      "Suggested edits"
    ]) {
      assert.match(importedReview, new RegExp(category));
    }
    await clickRewriteWorkspaceButton(client, "Rewrite");
    await clickRewriteWorkspaceButton(client, "Markdown");
    assert.equal(
      await waitFor(
        client,
        "reviewed rewrite in Markdown mode",
        `document.querySelector("#rewrite-human-draft")?.value ?? null`
      ),
      rewriteDraft,
      "Importing semantic review must not mutate the human draft."
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "reviewed rewrite in Visual mode",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    await waitFor(
      client,
      "project-saved semantic rewrite review",
      `document.querySelector(".rewrite-save-state")?.textContent?.includes("Saved to project")`
    );
    await clickRewriteWorkspaceButton(client, "ChatGPT Review");
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 760,
      mobile: false,
      width: 430
    });
    const narrowReviewScreen = await waitFor(
      client,
      "narrow ChatGPT Review screen",
      `(() => {
        const workspace = document.querySelector("[data-testid='rewrite-workspace']");
        const primaryTabs = workspace?.querySelectorAll("[aria-label='Rewrite workspace screens'] [role='tab']");
        const reviewScreen = workspace?.querySelector("#rewrite-workspace-review-screen");
        if (!workspace || primaryTabs?.length !== 2 || reviewScreen?.hidden) return null;
        const rect = workspace.getBoundingClientRect();
        return {
          activeScreen: workspace.querySelector("[aria-label='Rewrite workspace screens'] [aria-selected='true']")?.textContent.trim(),
          height: Math.round(rect.height),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          primaryLabels: Array.from(primaryTabs).map((tab) => tab.textContent.trim()),
          visibleComparisonPanes: Array.from(workspace.querySelectorAll(".rewrite-text-pane")).filter((pane) => pane.getClientRects().length > 0).length,
          width: Math.round(rect.width)
        };
      })()`
    );
    assert.deepEqual(narrowReviewScreen.primaryLabels, ["Rewrite", "ChatGPT Review"]);
    assert.equal(narrowReviewScreen.activeScreen, "ChatGPT Review");
    assert.equal(narrowReviewScreen.height, 760);
    assert.equal(narrowReviewScreen.width, 430);
    assert.equal(narrowReviewScreen.visibleComparisonPanes, 0);
    assert.equal(narrowReviewScreen.horizontalOverflow, false);
    await clickRewriteWorkspaceButton(client, "Rewrite");
    const narrowRewriteScreen = await waitFor(
      client,
      "narrow Rewrite screen pane tabs",
      `(() => {
        const workspace = document.querySelector("[data-testid='rewrite-workspace']");
        const paneTabs = workspace?.querySelectorAll(".rewrite-workspace-tabs [role='tab']");
        if (!workspace || paneTabs?.length !== 2) return null;
        return {
          activeMode: workspace.querySelector("[aria-label='Rewrite comparison mode'] [aria-pressed='true']")?.textContent.trim(),
          activePane: workspace.querySelector(".rewrite-workspace-tabs [aria-selected='true']")?.textContent.trim(),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          paneLabels: Array.from(paneTabs).map((tab) => tab.textContent.trim()),
          visiblePanes: Array.from(workspace.querySelectorAll(".rewrite-workspace-body > section")).filter((pane) => pane.getClientRects().length > 0).length
        };
      })()`
    );
    assert.deepEqual(narrowRewriteScreen.paneLabels, ["Current text", "My rewrite"]);
    assert.equal(narrowRewriteScreen.activePane, "My rewrite");
    assert.equal(narrowRewriteScreen.activeMode, "Visual");
    assert.equal(narrowRewriteScreen.visiblePanes, 1);
    assert.equal(narrowRewriteScreen.horizontalOverflow, false);
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 820,
      mobile: false,
      width: 1500
    });
    await clickRewriteWorkspaceButton(client, "Close");
    await clickRewriteDialogButton(client, "Keep draft and close");
    assert.deepEqual(
      fingerprintDocumentContent(fixtureDir),
      initialDocumentContentFingerprint,
      "Saving and reviewing a rewrite draft must not change Markdown or document review content."
    );
    assert.deepEqual(
      readDocumentManifestReviewState(fixtureDir, "doc_action"),
      initialDocumentManifestReviewState,
      "Saving a rewrite draft must not change bookmarks, deletion history, or Version History."
    );
    const savedRewriteStore = readRewriteSessionStore(fixtureDir, "doc_action");
    const savedRewriteSession = savedRewriteStore.sessions.find(
      (session) => session.status === "draft"
    );
    assert.ok(savedRewriteSession);
    assert.equal(savedRewriteSession.human_draft, rewriteDraft);
    assert.equal(savedRewriteSession.review_rounds.length, 1);
    assert.equal(savedRewriteSession.review_rounds[0].status, "imported");
    await clearRewriteIndexedDb(client);
    await client.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await installRewritePersistenceObserver(client);
    await waitFor(
      client,
      "project-backed rewrite resume banner after IndexedDB clearing",
      `document.querySelector(".rewrite-resume-banner")?.textContent?.includes("Rewrite draft available")`
    );
    await clickButtonByText(client, "Resume rewrite");
    await waitFor(
      client,
      "resumed rewrite draft in Visual mode",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    await clickRewriteWorkspaceButton(client, "Markdown");
    assert.equal(
      await waitFor(
        client,
        "resumed exact rewrite draft",
        `document.querySelector("#rewrite-human-draft")?.value ?? null`
      ),
      rewriteDraft
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "resumed Visual rewrite before impact",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Visual refinement.")`
    );
    assert.equal(
      await evaluate(client, {
        expression: `document.querySelector("[data-testid='rewrite-workspace']")?.textContent?.includes("Current draft review")`
      }),
      true,
      "The imported review must survive clearing IndexedDB."
    );
    assert.equal(
      await evaluate(client, {
        expression: `document.querySelector(".rewrite-workspace-warning")?.textContent?.includes("browser recovery copy") ?? false`
      }),
      false,
      "A project-backed resume must not be labeled recovery-only."
    );
    const rewriteImpactStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Apply rewrite");
    const impactText = await waitFor(
      client,
      "rewrite impact preview",
      `document.querySelector("[aria-label='Apply human rewrite?']")?.textContent ?? null`
    );
    const rewriteImpactLatencyMs = Date.now() - rewriteImpactStartedAt;
    assert.ok(rewriteImpactLatencyMs < 1000);
    assert.match(impactText, /Applying this rewrite affects/);
    assert.match(impactText, /pending patch proposals/);
    assert.match(impactText, /will not resolve comments or accept patches/);
    await clickRewriteDialogButton(client, "Cancel");
    await clickRewriteWorkspaceButton(client, "Close");
    await clickRewriteDialogButton(client, "Discard draft");
    await waitFor(
      client,
      "rewrite workspace discarded",
      `!document.querySelector("[data-testid='rewrite-workspace']") && !document.querySelector(".rewrite-resume-banner")`
    );
    assert.deepEqual(
      fingerprintDocumentContent(fixtureDir),
      initialDocumentContentFingerprint,
      "The complete passive rewrite workflow must leave Markdown and document review content unchanged."
    );
    assert.deepEqual(
      readDocumentManifestReviewState(fixtureDir, "doc_action"),
      initialDocumentManifestReviewState
    );
    const discardedRewriteStore = readRewriteSessionStore(fixtureDir, "doc_action");
    assert.equal(
      discardedRewriteStore.sessions.some((session) => session.status === "draft"),
      false
    );
    assert.equal(
      discardedRewriteStore.sessions.some((session) => session.status === "discarded"),
      true
    );
    initialFingerprint = fingerprintProject(fixtureDir);

    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, tableTarget);
    await openSelectionChooser(client);
    const rewriteTableVisualRenderStartedAt = Date.now();
    await chooseSelectionAction(client, "rewrite_section");
    const tableRewriteWorkspace = await waitFor(
      client,
      "table-heavy Visual rewrite workspace",
      `(() => {
        const workspace = document.querySelector("[data-testid='rewrite-workspace']");
        const body = workspace?.querySelector(".rewrite-workspace-body");
        const currentPane = workspace?.querySelector(".rewrite-current-pane");
        const draftPane = workspace?.querySelector(".rewrite-draft-pane");
        const currentSurface = document.querySelector(".rewrite-current-pane .rewrite-editor-surface");
        const draftSurface = document.querySelector(".rewrite-draft-pane .rewrite-editor-surface");
        const currentEditor = document.querySelector("[aria-label='Current document text Visual reference']");
        const draftEditor = document.querySelector("[aria-label='My rewrite Visual editor']");
        const toolbar = draftSurface?.querySelector(".mdxeditor-toolbar");
        if (!workspace || !body || !currentPane || !draftPane || !currentSurface || !draftSurface || !currentEditor || !draftEditor || !toolbar) return null;
        const toolbarButtons = Array.from(toolbar.querySelectorAll("button"));
        if (toolbarButtons.length < 8) return null;
        const currentTables = currentEditor.querySelectorAll("table");
        const draftTables = draftEditor.querySelectorAll("table");
        if (currentTables.length === 0 || draftTables.length === 0) return null;
        const currentTable = currentTables[0];
        const draftTable = draftTables[0];
        const currentCell = currentTable.querySelector("th, td");
        const currentPaneRect = currentPane.getBoundingClientRect();
        const draftPaneRect = draftPane.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const currentTableRect = currentTable.getBoundingClientRect();
        const draftTableRect = draftTable.getBoundingClientRect();
        return {
          currentTables: currentTables.length,
          draftTables: draftTables.length,
          currentScrollable: currentSurface.scrollHeight > currentSurface.clientHeight,
          draftScrollable: draftSurface.scrollHeight > draftSurface.clientHeight,
          currentHorizontalOverflow: currentSurface.scrollWidth > currentSurface.clientWidth + 1,
          draftHorizontalOverflow: draftSurface.scrollWidth > draftSurface.clientWidth + 1,
          currentEditorHorizontalOverflow: currentEditor.scrollWidth > currentEditor.clientWidth + 1,
          draftEditorHorizontalOverflow: draftEditor.scrollWidth > draftEditor.clientWidth + 1,
          workspaceHorizontalOverflow: workspace.scrollWidth > workspace.clientWidth + 1,
          pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          paneWidthDifference: Math.abs(Math.round(currentPaneRect.width - draftPaneRect.width)),
          bodyHeight: Math.round(bodyRect.height),
          editorSurfaceHeight: Math.round(currentSurface.getBoundingClientRect().height),
          currentTableFitsPane: currentTableRect.width <= currentSurface.clientWidth + 1,
          draftTableFitsPane: draftTableRect.width <= draftSurface.clientWidth + 1,
          currentTableLayout: getComputedStyle(currentTable).tableLayout,
          currentCellWhiteSpace: getComputedStyle(currentCell).whiteSpace,
          currentCellOverflowWrap: getComputedStyle(currentCell).overflowWrap,
          toolbarHorizontalOverflow: toolbar.scrollWidth > toolbar.clientWidth + 1,
          toolbarFlexWrap: getComputedStyle(toolbar).flexWrap,
          toolbarButtonCount: toolbarButtons.length,
          visibleToolbarButtonCount: toolbarButtons.filter((button) => button.getClientRects().length > 0).length,
          longUrlVisible: currentEditor.textContent.includes(${JSON.stringify(longRewriteUrl)}),
          longUrlDestinationPreserved: Array.from(currentEditor.querySelectorAll("a")).some((link) =>
            link.textContent === ${JSON.stringify(longRewriteUrl)} && link.href === ${JSON.stringify(longRewriteUrl)}
          ),
          longIdentifierVisible: currentEditor.textContent.includes(${JSON.stringify(longRewriteIdentifier)}),
          longCodeVisible: currentEditor.textContent.includes(${JSON.stringify(longRewriteCodeLine)}),
          draftEditable: draftEditor.getAttribute("contenteditable")
        };
      })()`
    );
    const rewriteTableVisualRenderLatencyMs =
      Date.now() - rewriteTableVisualRenderStartedAt;
    assert.ok(rewriteTableVisualRenderLatencyMs < 5000);
    assert.equal(tableRewriteWorkspace.currentTables >= 1, true);
    assert.equal(tableRewriteWorkspace.draftTables >= 1, true);
    assert.equal(tableRewriteWorkspace.currentScrollable, true);
    assert.equal(tableRewriteWorkspace.draftScrollable, true);
    assert.equal(tableRewriteWorkspace.currentHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.draftHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.currentEditorHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.draftEditorHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.workspaceHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.pageHorizontalOverflow, false);
    assert.ok(tableRewriteWorkspace.paneWidthDifference <= 1);
    assert.ok(tableRewriteWorkspace.bodyHeight >= 580);
    assert.ok(tableRewriteWorkspace.editorSurfaceHeight >= 520);
    assert.equal(tableRewriteWorkspace.currentTableFitsPane, true);
    assert.equal(tableRewriteWorkspace.draftTableFitsPane, true);
    assert.equal(tableRewriteWorkspace.currentTableLayout, "fixed");
    assert.equal(tableRewriteWorkspace.currentCellWhiteSpace, "normal");
    assert.equal(tableRewriteWorkspace.currentCellOverflowWrap, "anywhere");
    assert.equal(tableRewriteWorkspace.toolbarHorizontalOverflow, false);
    assert.equal(tableRewriteWorkspace.toolbarFlexWrap, "wrap");
    assert.ok(tableRewriteWorkspace.toolbarButtonCount >= 8);
    assert.equal(
      tableRewriteWorkspace.visibleToolbarButtonCount,
      tableRewriteWorkspace.toolbarButtonCount
    );
    assert.equal(tableRewriteWorkspace.longUrlVisible, true);
    assert.equal(tableRewriteWorkspace.longUrlDestinationPreserved, true);
    assert.equal(tableRewriteWorkspace.longIdentifierVisible, true);
    assert.equal(tableRewriteWorkspace.longCodeVisible, true);
    assert.equal(tableRewriteWorkspace.draftEditable, "true");
    if (rewriteWorkspaceTableScreenshotPath) {
      await saveScreenshot(client, rewriteWorkspaceTableScreenshotPath);
    }
    await waitFor(
      client,
      "table-heavy rewrite saved before screen-state check",
      `document.querySelector(".rewrite-save-state")?.textContent?.includes("Saved to project")`
    );
    const tableScreenSwitchSaveEventCount = await evaluate(client, {
      expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
    });
    const tableScreenState = await evaluate(client, {
      expression: `(() => {
        const currentSurface = document.querySelector(".rewrite-current-pane .rewrite-editor-surface");
        const draftSurface = document.querySelector(".rewrite-draft-pane .rewrite-editor-surface");
        window.__patchmarkTableDraftEditorNode = document.querySelector("[aria-label='My rewrite Visual editor']");
        currentSurface.scrollTop = Math.min(320, currentSurface.scrollHeight - currentSurface.clientHeight);
        draftSurface.scrollTop = Math.min(360, draftSurface.scrollHeight - draftSurface.clientHeight);
        return {
          currentScrollTop: currentSurface.scrollTop,
          draftScrollTop: draftSurface.scrollTop
        };
      })()`
    });
    assert.ok(tableScreenState.currentScrollTop > 0);
    assert.ok(tableScreenState.draftScrollTop > 0);
    await clickRewriteWorkspaceButton(client, "ChatGPT Review");
    await waitFor(
      client,
      "table-heavy review screen",
      `!document.querySelector("#rewrite-workspace-review-screen")?.hidden`
    );
    await clickRewriteWorkspaceButton(client, "Rewrite");
    const restoredTableScreenState = await waitFor(
      client,
      "table-heavy mounted Rewrite state",
      `(() => {
        const currentSurface = document.querySelector(".rewrite-current-pane .rewrite-editor-surface");
        const draftSurface = document.querySelector(".rewrite-draft-pane .rewrite-editor-surface");
        const draftEditor = document.querySelector("[aria-label='My rewrite Visual editor']");
        return draftEditor === window.__patchmarkTableDraftEditorNode ? {
          currentScrollTop: currentSurface.scrollTop,
          draftScrollTop: draftSurface.scrollTop,
          activeMode: document.querySelector("[aria-label='Rewrite comparison mode'] [aria-pressed='true']")?.textContent.trim()
        } : null;
      })()`
    );
    assert.equal(restoredTableScreenState.activeMode, "Visual");
    assert.equal(
      Math.round(restoredTableScreenState.currentScrollTop),
      Math.round(tableScreenState.currentScrollTop)
    );
    assert.equal(
      Math.round(restoredTableScreenState.draftScrollTop),
      Math.round(tableScreenState.draftScrollTop)
    );
    await delay(150);
    assert.equal(
      await evaluate(client, {
        expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
      }),
      tableScreenSwitchSaveEventCount,
      "Switching workspace screens must not create a canonical draft revision."
    );
    const rewriteTableMarkdownRenderStartedAt = Date.now();
    await clickRewriteWorkspaceButton(client, "Markdown");
    const tableRewriteMarkdown = await waitFor(
      client,
      "table-heavy canonical Markdown",
      `document.querySelector("#rewrite-human-draft")?.value ?? null`,
      (value) =>
        typeof value === "string" &&
        value.includes("| Illustrative revenue logic | Operating objective |") &&
        value.includes(tableTarget)
    );
    const rewriteTableMarkdownRenderLatencyMs =
      Date.now() - rewriteTableMarkdownRenderStartedAt;
    assert.ok(rewriteTableMarkdownRenderLatencyMs < 1000);
    await delay(150);
    assert.equal(
      await evaluate(client, {
        expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
      }),
      tableScreenSwitchSaveEventCount,
      "Changing Visual and Markdown presentation must not create a canonical draft revision."
    );
    const tableMarkdownLayout = await evaluate(client, {
      expression: `(() => {
        const current = document.querySelector("[aria-label='Current document text Markdown reference']");
        const draft = document.querySelector("#rewrite-human-draft");
        const style = getComputedStyle(draft);
        window.__patchmarkTableMarkdownEditorNode = draft;
        return {
          currentHorizontalOverflow: current.scrollWidth > current.clientWidth + 1,
          draftHorizontalOverflow: draft.scrollWidth > draft.clientWidth + 1,
          draftWrap: draft.wrap,
          overflowX: style.overflowX,
          overflowWrap: style.overflowWrap,
          whiteSpace: style.whiteSpace,
          wordBreak: style.wordBreak
        };
      })()`
    });
    assert.equal(tableMarkdownLayout.currentHorizontalOverflow, false);
    assert.equal(tableMarkdownLayout.draftHorizontalOverflow, false);
    assert.equal(tableMarkdownLayout.draftWrap, "soft");
    assert.equal(tableMarkdownLayout.overflowX, "hidden");
    assert.equal(tableMarkdownLayout.overflowWrap, "anywhere");
    assert.equal(tableMarkdownLayout.whiteSpace, "pre-wrap");
    assert.equal(tableMarkdownLayout.wordBreak, "break-word");
    const markdownScreenSwitchSaveEventCount = await evaluate(client, {
      expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
    });
    await clickRewriteWorkspaceButton(client, "ChatGPT Review");
    await clickRewriteWorkspaceButton(client, "Rewrite");
    assert.equal(
      await waitFor(
        client,
        "mounted canonical Markdown after screen switch",
        `(() => {
          const draft = document.querySelector("#rewrite-human-draft");
          return draft === window.__patchmarkTableMarkdownEditorNode ? draft.value : null;
        })()`
      ),
      tableRewriteMarkdown
    );
    await delay(150);
    assert.equal(
      await evaluate(client, {
        expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
      }),
      markdownScreenSwitchSaveEventCount,
      "Soft wrapping and workspace navigation must not change canonical Markdown."
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "table-heavy repeated Visual mode",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.querySelectorAll("table").length > 0`
    );
    await clickRewriteWorkspaceButton(client, "Markdown");
    assert.equal(
      await waitFor(
        client,
        "stable table Markdown round trip",
        `document.querySelector("#rewrite-human-draft")?.value ?? null`
      ),
      tableRewriteMarkdown
    );
    const unsupportedRewriteMarkdown = `${tableRewriteMarkdown}\n\n<UnsupportedRewriteWidget />`;
    const unsupportedSaveEventCount = await evaluate(client, {
      expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
    });
    await setRewriteMarkdownDraft(client, unsupportedRewriteMarkdown);
    await waitFor(
      client,
      "unsupported Markdown authoritative save event",
      `window.__patchmarkRewritePersistenceEvents?.length > ${unsupportedSaveEventCount}`
    );
    assert.match(
      await evaluate(client, {
        expression: `document.querySelector(".rewrite-save-state")?.textContent ?? ""`
      }),
      /Saved to project/
    );
    await clickRewriteWorkspaceButton(client, "Visual");
    const unsupportedVisualState = await waitFor(
      client,
      "Markdown-safe unsupported Visual fallback",
      `(() => {
        const error = document.querySelector(".rewrite-draft-pane .visual-editor-error")?.textContent;
        const fallback = document.querySelector(".rewrite-draft-pane .visual-editor-fallback textarea");
        return error && fallback ? {
          error,
          fallbackReadOnly: fallback.readOnly,
          rawMarkdown: fallback.value,
          referenceStillVisual: document.querySelector("[aria-label='Current document text Visual reference']")?.querySelectorAll("table").length > 0
        } : null;
      })()`
    );
    assert.match(unsupportedVisualState.error, /could not render/i);
    assert.equal(unsupportedVisualState.fallbackReadOnly, false);
    assert.equal(unsupportedVisualState.rawMarkdown, unsupportedRewriteMarkdown);
    assert.equal(unsupportedVisualState.referenceStillVisual, true);
    await clickRewriteWorkspaceButton(client, "Markdown");
    assert.equal(
      await waitFor(
        client,
        "unsupported Markdown preserved after fallback",
        `document.querySelector("#rewrite-human-draft")?.value ?? null`
      ),
      unsupportedRewriteMarkdown
    );
    await clickRewriteWorkspaceButton(client, "Close");
    await clickRewriteDialogButton(client, "Discard draft");
    await waitFor(
      client,
      "table rewrite workspace discarded",
      `!document.querySelector("[data-testid='rewrite-workspace']")`
    );
    assert.deepEqual(
      fingerprintDocumentContent(fixtureDir),
      initialDocumentContentFingerprint,
      "Table and unsupported-Markdown draft work must not mutate the document before Apply."
    );
    initialFingerprint = fingerprintProject(fixtureDir);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    const rightClickChooser = await openRightClickChooser(client);
    assertChooserInViewport(rightClickChooser);
    assertCompleteChooser(rightClickChooser);
    assert.equal(rightClickChooser.text, paragraphChooser.text);
    await cancelChooser(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Right-click chooser cancellation must not write project files."
    );

    await selectVisualText(client, preambleTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, preambleTarget);
    await openSelectionChooser(client);
    const noSectionChooser = await waitForChooser(client, preambleTarget);
    assertChooserInViewport(noSectionChooser);
    assert.equal(noSectionChooser.actionIds.includes("section"), false);
    assert.equal(noSectionChooser.unavailableIds.includes("section"), true);
    assert.equal(noSectionChooser.actionIds.includes("selected_text"), true);
    assert.equal(noSectionChooser.actionIds.includes("document"), true);
    assert.match(noSectionChooser.text, /No containing section/);
    await cancelChooser(client);

    await selectVisualText(client, linkLabel, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, linkLabel);
    await openSelectionChooser(client);
    const linkChooser = await waitForChooser(client, linkLabel);
    assertCompleteChooser(linkChooser);
    assert.match(linkChooser.text, /Linked text/);
    await cancelChooser(client);

    const multiBlockSelectedText = await selectVisualRange(
      client,
      multiBlockStart,
      multiBlockEnd
    );
    const multiBlockAction = await waitForSelectionAction(
      client,
      multiBlockSelectedText
    );
    assertActionInViewport(multiBlockAction);
    await openSelectionChooser(client);
    const multiBlockChooser = await waitForChooser(client, multiBlockStart);
    assertCompleteChooser(multiBlockChooser);
    assert.match(multiBlockChooser.text, /Supported multi-block range/);
    await cancelChooser(client);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    const composerOpenStartedAt = Date.now();
    await chooseSelectionAction(client, "selected_text");
    const paragraphComposer = await waitForComposer(client, paragraphTarget);
    const composerOpenLatencyMs = Date.now() - composerOpenStartedAt;
    assert.ok(composerOpenLatencyMs < 1000);
    assertComposerInViewport(paragraphComposer);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a paragraph comment must not write project files."
    );

    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const tableAction = await waitForSelectionAction(client, tableTarget);
    assert.ok(tableAction.scrollY > 2000, "Table selection should require long scrolling.");
    assert.equal(tableAction.cellTag, "TD");
    assertActionInViewport(tableAction);
    await openSelectionChooser(client);
    const tableChooser = await waitForChooser(
      client,
      tableTarget,
      "selection"
    );
    assertChooserInViewport(tableChooser);
    assertCompleteChooser(tableChooser);
    assert.match(tableChooser.text, /Surrounding table cell/);
    assert.match(tableChooser.text, /10\. Growth Path and Scenarios/);
    await chooseSelectionAction(client, "selected_text");
    const tableComposer = await waitForComposer(client, tableTarget);
    assertComposerInViewport(tableComposer);
    assert.match(tableComposer.preview, /surrounding table cell/i);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a table comment must not write project files."
    );

    for (const edgeScenario of [
      { text: paragraphTarget, block: "start" },
      { text: tableTarget, block: "end" },
      { text: leftEdgeTarget, block: "center" },
      { text: rightEdgeTarget, block: "center" }
    ]) {
      await selectVisualText(client, edgeScenario.text, {
        dispatchMouseUp: true,
        scrollBlock: edgeScenario.block
      });
      const action = await waitForSelectionAction(client, edgeScenario.text);
      assertActionInViewport(action);
      await openSelectionChooser(client);
      const edgeChooser = await waitForChooser(client, edgeScenario.text);
      assertChooserInViewport(edgeChooser);
      await cancelChooser(client);
    }

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, tableTarget);
    assert.equal(
      await evaluate(client, {
        expression: `Boolean(document.querySelector("[data-testid='selection-actions-chooser']"))`
      }),
      false,
      "Changing the captured selection must close the old chooser."
    );
    await dismissSelectionAction(client);

    await selectVisualText(client, keyboardTarget, {
      dispatchMouseUp: false,
      scrollBlock: "center"
    });
    const keyboardAction = await waitForSelectionAction(client, keyboardTarget);
    assertActionInViewport(keyboardAction);
    await pressShortcut(client);
    const keyboardChooser = await waitForChooser(
      client,
      keyboardTarget,
      "keyboard"
    );
    assertChooserInViewport(keyboardChooser);
    assertCompleteChooser(keyboardChooser);
    await chooseSelectionAction(client, "selected_text");
    const keyboardComposer = await waitForComposer(client, keyboardTarget);
    assertComposerInViewport(keyboardComposer);
    await pressEscape(client);
    await waitForComposerMissing(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Keyboard cancellation must not write project files."
    );

    await clickButtonByText(client, "Markdown Mode");
    await selectMarkdownText(client, paragraphTarget);
    const markdownAction = await waitForMarkdownSelectionAction(client);
    assertActionInViewport(markdownAction);
    await openSelectionChooser(client);
    const markdownChooser = await waitForChooser(client, paragraphTarget);
    assertChooserInViewport(markdownChooser);
    assertCompleteChooser(markdownChooser);
    assert.match(markdownChooser.text, /Action Plan/);
    await cancelChooser(client);
    await clickButtonByText(client, "Visual Mode");
    await waitForVisualEditor(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Markdown chooser cancellation must not write project files."
    );

    for (const scopeScenario of [
      {
        actionId: "section",
        preview: "Commenting on whole section"
      },
      {
        actionId: "document",
        preview: "Commenting on whole document"
      }
    ]) {
      await selectVisualText(client, paragraphTarget, {
        dispatchMouseUp: true,
        scrollBlock: "center"
      });
      await waitForSelectionAction(client, paragraphTarget);
      await openSelectionChooser(client);
      await chooseSelectionAction(client, scopeScenario.actionId);
      const scopedComposer = await waitForComposer(
        client,
        scopeScenario.preview
      );
      assertComposerInViewport(scopedComposer);
      await cancelComposer(client);
      assert.deepEqual(
        fingerprintProject(fixtureDir),
        initialFingerprint,
        `Cancelling the ${scopeScenario.actionId} composer must not write project files.`
      );
    }

    await openWholeDocumentComposer(client);
    const wholeDocumentComposer = await waitForComposer(
      client,
      "Commenting on whole document"
    );
    assertComposerInViewport(wholeDocumentComposer);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a whole-document comment must not write project files."
    );

    const noSelectionChooser = await openChooserWithoutSelection(client);
    assertChooserInViewport(noSelectionChooser);
    assert.equal(noSelectionChooser.actionIds.includes("selected_text"), false);
    assert.equal(
      noSelectionChooser.unavailableIds.includes("selected_text"),
      true
    );
    assert.equal(noSelectionChooser.actionIds.includes("document"), true);
    assert.doesNotMatch(noSelectionChooser.text, new RegExp(paragraphTarget));
    await cancelChooser(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Right-clicking without a selection must not use or write a stale range."
    );

    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 760,
      mobile: false,
      width: 430
    });
    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    const narrowChooser = await waitForChooser(client, paragraphTarget);
    assertChooserInViewport(narrowChooser);
    assertCompleteChooser(narrowChooser);
    await cancelChooser(client);
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 820,
      mobile: false,
      width: 1500
    });

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await selectDocument(client, "Notes");
    await waitForActiveDocument(client, "Notes");
    assert.equal(
      await evaluate(client, {
        expression: `Boolean(document.querySelector("[data-testid='selection-actions-chooser']"))`
      }),
      false,
      "Switching documents must close the owning document chooser."
    );
    await selectVisualText(client, secondDocumentTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const secondDocumentAction = await waitForSelectionAction(
      client,
      secondDocumentTarget
    );
    assert.equal(secondDocumentAction.selectedText, secondDocumentTarget);
    await dismissSelectionAction(client);
    await selectDocument(client, "Action Plan");
    await waitForActiveDocument(client, "Action Plan");

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "section");
    const sectionComposer = await waitForComposer(
      client,
      "Commenting on whole section"
    );
    assert.doesNotMatch(
      sectionComposer.preview,
      /Commenting on selected text/
    );
    await fillComposer(client, "Fixture section comment.");
    await clickComposerButton(client, "Save Comment");
    await waitForComposerMissing(client, false);
    const sectionComment = await waitForPersistedComment(
      fixtureDir,
      "doc_action",
      { commentText: "Fixture section comment." }
    );
    assert.equal(sectionComment.anchor.kind, "section");
    assert.equal(sectionComment.anchor.heading, "Action Plan");
    assert.equal("selected_text" in sectionComment.anchor, false);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "document");
    const documentComposer = await waitForComposer(
      client,
      "Commenting on whole document"
    );
    assert.doesNotMatch(
      documentComposer.preview,
      /Commenting on selected text/
    );
    await fillComposer(client, "Fixture document comment.");
    await clickComposerButton(client, "Save Comment");
    await waitForComposerMissing(client, false);
    const documentComment = await waitForPersistedComment(
      fixtureDir,
      "doc_action",
      { commentText: "Fixture document comment." }
    );
    assert.equal(documentComment.anchor.kind, "document");
    assert.equal("selected_text" in documentComment.anchor, false);

    const commentCountBeforeBookmark = readFixtureComments(
      fixtureDir,
      "doc_action"
    ).length;
    await selectVisualText(client, keyboardTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, keyboardTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "bookmark");
    const bookmark = await waitForReadingBookmark(
      fixtureDir,
      "doc_action",
      keyboardTarget
    );
    assert.equal(bookmark.anchor.kind, "selected_text");
    assert.equal(bookmark.anchor.selected_text, keyboardTarget);
    assert.equal(
      readFixtureComments(fixtureDir, "doc_action").length,
      commentCountBeforeBookmark,
      "Setting a bookmark must not create a comment."
    );

    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, tableTarget);

    await openSelectionComposer(client);
    const submitComposer = await waitForComposer(client, tableTarget);
    assertComposerInViewport(submitComposer);
    if (screenshotPath) {
      await saveScreenshot(client, screenshotPath);
    }
    await fillComposer(client, "Fixture table-cell comment.");
    await clickComposerButton(client, "Save Comment");
    await waitForComposerMissing(client, false);
    const createdComment = await waitForPersistedComment(fixtureDir, "doc_action", {
      commentText: "Fixture table-cell comment.",
      selectedText: tableTarget
    });
    assert.equal(createdComment.anchor.kind, "selected_text");
    assert.equal(createdComment.anchor.selected_text, tableTarget);
    assert.equal(createdComment.anchor.anchor_context?.kind, "table_cell");
    await waitForCreatedCommentCard(client, createdComment.id);

    const submittedFingerprint = fingerprintProject(fixtureDir);
    await client.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await installRewritePersistenceObserver(client);
    await waitForCreatedCommentCard(client, createdComment.id);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      submittedFingerprint,
      "Reloading the submitted fixture must not create additional writes."
    );

    const existingAnchorAudit = await auditExistingAnchors(client);
    assert.equal(existingAnchorAudit.activeSelectedTextComments >= 4, true);
    assert.equal(existingAnchorAudit.linkCommentPresent, true);
    assert.equal(existingAnchorAudit.multiBlockCommentPresent, true);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "bookmark");
    await waitForReadingBookmark(
      fixtureDir,
      "doc_action",
      paragraphTarget
    );

    const appliedRewriteText = `${paragraphTarget} Applied human rewrite fixture.`;
    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "rewrite_selected_text");
    await waitFor(
      client,
      "rewrite workspace for apply",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.trim() === ${JSON.stringify(paragraphTarget)}`
    );
    const applySaveEventCount = await evaluate(client, {
      expression: `window.__patchmarkRewritePersistenceEvents?.length ?? 0`
    });
    await clickRewriteWorkspaceButton(client, "Markdown");
    await waitFor(
      client,
      "rewrite Markdown editor for apply",
      `document.querySelector("#rewrite-human-draft")?.value === ${JSON.stringify(paragraphTarget)}`
    );
    await setRewriteMarkdownDraft(client, appliedRewriteText);
    await clickRewriteWorkspaceButton(client, "Visual");
    await waitFor(
      client,
      "rewrite Visual editor for apply",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.includes("Applied human rewrite fixture.")`
    );
    await waitFor(
      client,
      "authoritative rewrite save event before apply",
      `window.__patchmarkRewritePersistenceEvents?.length > ${applySaveEventCount}`
    );
    await waitFor(
      client,
      "rewrite draft saved before apply",
      `document.querySelector(".rewrite-save-state")?.textContent?.includes("Saved to project")`
    );
    await clickRewriteWorkspaceButton(client, "Apply rewrite");
    const applyImpactText = await waitFor(
      client,
      "rewrite apply confirmation",
      `document.querySelector("[aria-label='Apply human rewrite?']")?.textContent ?? null`
    );
    assert.match(applyImpactText, /1 comment in this range/);
    assert.match(applyImpactText, /1 pending patch proposals/);
    assert.match(applyImpactText, /1 reading bookmark/);
    const rewriteApplyStartedAt = Date.now();
    await clickRewriteDialogButton(client, "Apply rewrite");
    await waitFor(
      client,
      "human rewrite applied",
      `!document.querySelector("[data-testid='rewrite-workspace']") && document.querySelector(".document-save-banner-success")?.textContent?.includes("Human rewrite applied")`
    );
    const rewriteApplyLatencyMs = Date.now() - rewriteApplyStartedAt;
    assert.ok(rewriteApplyLatencyMs < 5000);
    await waitForFixtureFile(
      join(fixtureDir, "action-plan.md"),
      (contents) => contents.includes(appliedRewriteText),
      "applied rewrite Markdown"
    );
    const appliedComments = readFixtureComments(fixtureDir, "doc_action");
    const preservedComment = appliedComments.find(
      (comment) => comment.id === "PM-COMMENT-0001"
    );
    assert.equal(preservedComment.status, "open");
    assert.equal(preservedComment.comment, "Existing anchor fixture PM-COMMENT-0001.");
    assert.equal(preservedComment.anchor.kind, "selected_text");
    const persistedPatches = JSON.parse(
      readFileSync(
        join(
          fixtureDir,
          ".patchmark",
          "documents",
          "doc_action",
          "patches.json"
        ),
        "utf8"
      )
    );
    assert.equal(persistedPatches[0].status, "stale");
    assert.equal(
      persistedPatches[0].human_rewrite_impact.reason,
      "overlapping_human_rewrite"
    );
    const appliedManifest = JSON.parse(
      readFileSync(
        join(
          fixtureDir,
          ".patchmark",
          "documents",
          "doc_action",
          "manifest.json"
        ),
        "utf8"
      )
    );
    assert.equal(appliedManifest.reading_bookmark.anchor.kind, "selected_text");
    assert.equal(appliedManifest.versions.length, 1);
    assert.equal(appliedManifest.versions[0].mutation.author_type, "human");
    assert.equal(
      appliedManifest.versions[0].mutation.mutation_type,
      "human_rewrite"
    );
    assert.equal(
      existsSync(
        join(
          fixtureDir,
          ".patchmark",
          "documents",
          "doc_action",
          appliedManifest.versions[0].file.replace(".patchmark/", "")
        )
      ),
      true
    );
    const appliedRewriteStore = readRewriteSessionStore(fixtureDir, "doc_action");
    assert.equal(
      appliedRewriteStore.sessions.some((session) => session.status === "draft"),
      false
    );
    assert.equal(
      appliedRewriteStore.sessions.some((session) => session.status === "applied"),
      true
    );
    await clearRewriteIndexedDb(client);
    await client.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await waitFor(
      client,
      "applied rewrite after restart",
      `document.querySelector(".editor-body")?.textContent?.includes(${JSON.stringify("Applied human rewrite fixture.")})`
    );
    assert.equal(
      await evaluate(client, {
        expression: `Boolean(document.querySelector(".rewrite-resume-banner"))`
      }),
      false,
      "Applied rewrite sessions must not return as active drafts after restart."
    );
    assert.match(
      await evaluate(client, {
        expression: `document.querySelector("[aria-label='Version History']")?.textContent ?? ""`
      }),
      /Before human rewrite/
    );

    await selectDocument(client, "Notes");
    await waitForActiveDocument(client, "Notes");
    await waitForVisualEditor(client);
    await selectVisualText(client, secondDocumentTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, secondDocumentTarget);
    await openSelectionChooser(client);
    await chooseSelectionAction(client, "rewrite_selected_text");
    await waitFor(
      client,
      "Notes rewrite workspace in Visual mode",
      `document.querySelector("[aria-label='My rewrite Visual editor']")?.textContent?.trim() === ${JSON.stringify(secondDocumentTarget)}`
    );
    await installRewritePersistenceObserver(client);
    await clickRewriteWorkspaceButton(client, "Markdown");
    const markdownAppliedRewrite = `${secondDocumentTarget} Markdown-mode apply fixture.`;
    await setRewriteMarkdownDraft(client, markdownAppliedRewrite);
    await waitFor(
      client,
      "Markdown-mode rewrite save",
      `window.__patchmarkRewritePersistenceEvents?.length > 0`
    );
    await waitFor(
      client,
      "Markdown-mode rewrite saved label",
      `document.querySelector(".rewrite-save-state")?.textContent?.includes("Saved to project")`
    );
    await clickRewriteWorkspaceButton(client, "Apply rewrite");
    await waitFor(
      client,
      "Markdown-mode impact confirmation",
      `document.querySelector("[aria-label='Apply human rewrite?']")?.textContent?.includes("Applying this rewrite affects")`
    );
    await clickRewriteDialogButton(client, "Apply rewrite");
    await waitFor(
      client,
      "Markdown-mode human rewrite applied",
      `!document.querySelector("[data-testid='rewrite-workspace']") && document.querySelector(".document-save-banner-success")?.textContent?.includes("Human rewrite applied")`
    );
    await waitForFixtureFile(
      join(fixtureDir, "notes.md"),
      (contents) => contents.includes(markdownAppliedRewrite),
      "Markdown-mode applied rewrite"
    );

    console.log(
      JSON.stringify(
        {
          kind: "comment-selection-composer-browser",
          editorUrl,
          paragraphAction,
          tableAction,
          chooserRenderCount: paragraphChooser.renderCount,
          selectionLatencyMs: paragraphChooser.selectionLatencyMs,
          chooserOpenLatencyMs,
          composerOpenLatencyMs,
          rewriteWorkspaceOpenLatencyMs,
          rewriteToReviewLatencyMs,
          reviewToRewriteLatencyMs,
          rewriteVisualToMarkdownLatencyMs,
          rewriteMarkdownToVisualLatencyMs,
          rewriteVisualTypingLatencyMs,
          rewriteTableVisualRenderLatencyMs,
          rewriteTableMarkdownRenderLatencyMs,
          rewriteDraftSaveLatencyMs,
          rewritePromptLatencyMs,
          rewriteImpactLatencyMs,
          rewriteApplyLatencyMs,
          rewriteAuthoritativeSaveMetrics,
          rewriteSurvivesIndexedDbClearing: true,
          editorRemounted: false,
          rewriteWorkspacePassiveWorkflow: true,
          rewriteWorkspaceApplyPersistence: true,
          rewriteWorkspaceMarkdownApplyPersistence: true,
          rewriteWorkspaceFullscreen: true,
          rewriteWorkspaceReviewSeparated: true,
          rewriteWorkspaceMountedScreenState: true,
          rewriteWorkspaceNoHorizontalOverflow: true,
          rewriteWorkspaceTableRoundTrip: true,
          rewriteWorkspaceUnsupportedMarkdownSafe: true,
          rewriteWorkspaceMeasurements: {
            bodyPanelHeight: rewriteWorkspace.bodyPanelHeight,
            editorSurfaceHeight: rewriteWorkspace.editorSurfaceHeight,
            actionBarHeight: rewriteWorkspace.actionBarHeight,
            paneWidthDifference: rewriteWorkspace.paneWidthDifference,
            tableBodyHeight: tableRewriteWorkspace.bodyHeight,
            tableEditorSurfaceHeight: tableRewriteWorkspace.editorSurfaceHeight,
            toolbarButtonCount: tableRewriteWorkspace.toolbarButtonCount
          },
          sectionCommentId: sectionComment.id,
          documentCommentId: documentComment.id,
          bookmarkKind: bookmark.anchor.kind,
          createdCommentId: createdComment.id,
          existingAnchorAudit,
          screenshotPath: screenshotPath ?? null,
          rewriteWorkspaceScreenshotPath:
            rewriteWorkspaceScreenshotPath ?? null,
          rewriteWorkspaceReviewScreenshotPath:
            rewriteWorkspaceReviewScreenshotPath ?? null,
          rewriteWorkspaceTableScreenshotPath:
            rewriteWorkspaceTableScreenshotPath ?? null
        },
        null,
        2
      )
    );
    console.log("Comment selection composer browser test passed.");
  } finally {
    await client?.close().catch(() => undefined);
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    await fixtureServer.forceClose().catch(() => undefined);
    rmSync(userDataDir, { force: true, recursive: true });
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}

function createRewriteSemanticReviewResponse(requestPayload) {
  return {
    protocol: "patchmark.human_rewrite_review_import",
    protocol_version: 1,
    rewrite_session_id: requestPayload.rewrite_session_id,
    rewrite_review_id: requestPayload.rewrite_review_id,
    project_id: requestPayload.project_id,
    document_id: requestPayload.document_id,
    base_text_sha256: requestPayload.base_text_sha256,
    human_draft_sha256: requestPayload.human_draft_sha256,
    overall_assessment: "review_recommended",
    summary: "The human clarification adds a small amount of meaning.",
    meaning_preserved: [
      {
        point: "The original selection remains intact.",
        current_text_evidence: requestPayload.current_text,
        rewrite_evidence: requestPayload.current_text
      }
    ],
    meaning_changed: [
      {
        topic: "Clarification",
        current_meaning: "No explicit clarification.",
        rewrite_meaning: "A human clarification is present.",
        assessment: "deliberate",
        severity: "low"
      }
    ],
    omitted_points: [
      {
        point: "No important point appears omitted.",
        importance: "low",
        reason: "The current text remains verbatim."
      }
    ],
    new_claims: [
      {
        claim: "Human clarification.",
        relative_support: "not_present_in_current_text",
        note: "This sentence is new relative to the supplied current text."
      }
    ],
    contradictions: [
      {
        issue: "No direct contradiction detected.",
        severity: "low"
      }
    ],
    certainty_changes: [
      {
        topic: "Selection certainty",
        from: "unchanged",
        to: "unchanged",
        impact: "No material certainty shift detected."
      }
    ],
    source_impacts: [
      {
        claim_or_source: "Human clarification.",
        impact: "source_support_changed",
        note: "The new sentence has no source marker in the supplied text."
      }
    ],
    ambiguities: [
      {
        issue: "The clarification is generic.",
        suggestion: "The human may make it more specific."
      }
    ],
    suggested_draft_edits: [
      {
        draft_excerpt: "Human clarification.",
        suggested_text: "Specific human clarification.",
        reason: "A specific description may read more clearly."
      }
    ]
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "patchmark-comment-composer-"));
  const metadata = join(root, ".patchmark");
  const now = "2026-07-28T00:00:00.000Z";
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const actionMarkdown = createActionMarkdown();
  const notesMarkdown = [
    "# Notes",
    "",
    secondDocumentTarget,
    "",
    "A separate document confirms document-scoped selection state."
  ].join("\n");
  const documents = [
    createDocumentStore({
      comments: createExistingComments(actionMarkdown, now),
      displayTitle: "Action Plan",
      documentId: "doc_action",
      markdown: actionMarkdown,
      now,
      path: "action-plan.md",
      position: 1000,
      patches: createExistingPatches(now),
      root,
      withBookmark: true
    }),
    createDocumentStore({
      comments: [],
      displayTitle: "Notes",
      documentId: "doc_notes",
      markdown: notesMarkdown,
      now,
      path: "notes.md",
      position: 2000,
      patches: [],
      root,
      withBookmark: false
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    serializeJson({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "prj_comment_composer",
      title: "Comment composer fixture",
      created_at: now,
      manifest_revision: 1,
      documents
    })
  );
  return root;
}

function createActionMarkdown() {
  const filler = Array.from({ length: 55 }, (_, index) => [
    `## Operating context ${index + 1}`,
    "",
    `Long-scroll fixture paragraph ${index + 1}. `.repeat(8),
    ""
  ]).flat();
  const scenarioRows = Array.from({ length: 110 }, (_, index) =>
    `| Scenario ${index + 1} with a deliberately descriptive label | ${
      40 + index * 12
    }–${70 + index * 16} units/week | Preserve source-linked assumptions and operational constraints | Track demand, margin, capacity, and delivery reliability before advancing | Decision gate ${index + 1} requires explicit human review |`
  );

  return [
    preambleTarget,
    "",
    "# Action Plan",
    "",
    paragraphTarget,
    "",
    keyboardTarget,
    "",
    `The [${linkLabel}](https://example.com/evidence) supports the current plan.`,
    "",
    multiBlockStart,
    "",
    multiBlockEnd,
    "",
    ...filler,
    "## 10. Growth Path and Scenarios",
    "",
    `Long source URL: [${longRewriteUrl}](${longRewriteUrl})`,
    "",
    longRewriteIdentifier,
    "",
    "```js",
    longRewriteCodeLine,
    "```",
    "",
    "| Illustrative revenue logic | Operating objective | Indicative scale | Learning carried forward | Decision gate |",
    "| --- | --- | --- | --- | --- |",
    `| ${leftEdgeTarget} | Controlled launch | 20–50 units/week | Observe real unit economics | ${rightEdgeTarget} |`,
    `| ${tableTarget} | Establish repeat demand | 60–150 units/week | The first 3–6 months should produce the data needed for a real break-even model. | Founder workload remains acceptable |`,
    ...scenarioRows,
    "",
    "## 11. Production, Capacity, and Operations",
    "",
    "Production growth must follow actual capacity, not only demand."
  ].join("\n");
}

function createExistingComments(markdown, now) {
  const paragraphStart = markdown.indexOf(paragraphTarget);
  const linkMarkdown = `[${linkLabel}](https://example.com/evidence)`;
  const linkStart = markdown.indexOf(linkMarkdown);
  const multiBlockText =
    "Multi-block anchor first paragraph.\n\nMulti-block anchor second paragraph.";
  const multiBlockStart = markdown.indexOf(multiBlockText);

  return [
    createComment({
      id: "PM-COMMENT-0001",
      now,
      selectedText: paragraphTarget,
      start: paragraphStart
    }),
    createComment({
      id: "PM-COMMENT-0002",
      now,
      selectedText: linkMarkdown,
      start: linkStart
    }),
    createComment({
      id: "PM-COMMENT-0003",
      now,
      selectedText: multiBlockText,
      start: multiBlockStart
    })
  ];
}

function createExistingPatches(now) {
  return [
    {
      id: "PM-PATCH-0001",
      status: "pending",
      target_heading: "Action Plan",
      original_text: paragraphTarget,
      suggested_text: `${paragraphTarget} ChatGPT-proposed expansion.`,
      reason: "Expand the opening action-plan paragraph.",
      created_at: now
    }
  ];
}

function createComment({ id, now, selectedText, start }) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      anchor_source: "markdown"
    },
    comment: `Existing anchor fixture ${id}.`,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now
  };
}

function createDocumentStore({
  comments,
  displayTitle,
  documentId,
  markdown,
  now,
  path,
  patches,
  position,
  root,
  withBookmark
}) {
  writeFileSync(join(root, path), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  for (const directory of ["versions", "context-packs", "imports", "recovery"]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  writeFileSync(join(store, "comments.json"), serializeJson(comments));
  writeFileSync(join(store, "patches.json"), serializeJson(patches));
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "review-batches.json"), "[]\n");
  writeFileSync(join(store, "review-queue-overrides.json"), "{}\n");
  writeFileSync(
    join(store, "manifest.json"),
    serializeJson({
      schema_version: 1,
      project_id: "prj_comment_composer",
      document_id: documentId,
      project_name: "Comment composer fixture",
      document_file: "document.md",
      created_at: now,
      updated_at: now,
      ...(withBookmark
        ? {
            reading_bookmark: {
              format_version: 1,
              document: {
                project_id: "prj_comment_composer",
                document_id: documentId
              },
              anchor: {
                kind: "selected_text",
                selected_text: paragraphTarget,
                markdown_start_offset: markdown.indexOf(paragraphTarget),
                markdown_end_offset:
                  markdown.indexOf(paragraphTarget) + paragraphTarget.length,
                anchor_source: "markdown"
              },
              created_at: now,
              updated_at: now
            }
          }
        : {})
    })
  );
  writeFileSync(
    join(store, "document.json"),
    serializeJson({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: documentId,
      created_at: now,
      source: "created"
    })
  );
  return {
    document_id: documentId,
    path,
    display_title: displayTitle,
    role: "research",
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

async function waitForActiveDocument(client, title) {
  await waitFor(client, `active document ${title}`, `(() => {
    const status = document.querySelector("[aria-label='Workspace status']");
    return Boolean(status?.textContent?.includes("Document: ${escapeJs(title)}"));
  })()`);
}

async function waitForVisualEditor(client) {
  await waitFor(client, "visual editor", `(() => {
    const editor = document.querySelector("[aria-label='editable markdown']");
    return Boolean(editor && editor.getAttribute("contenteditable") === "true");
  })()`);
}

async function selectVisualText(
  client,
  selectedText,
  { dispatchMouseUp, scrollBlock }
) {
  await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing.");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent.includes(${JSON.stringify(selectedText)})) {
        node = walker.nextNode();
      }
      if (!node) throw new Error("Selection text missing: ${escapeJs(selectedText)}");
      const start = node.textContent.indexOf(${JSON.stringify(selectedText)});
      node.parentElement.scrollIntoView({ block: ${JSON.stringify(scrollBlock)}, inline: "nearest" });
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + ${selectedText.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      if (${dispatchMouseUp ? "true" : "false"}) {
        document.querySelector(".editor-body")
          .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      return selection.toString();
    })()`,
    userGesture: true
  });
}

async function selectVisualRange(client, startText, endText) {
  return await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing.");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode = null;
      let endNode = null;
      let node = walker.nextNode();
      while (node) {
        if (!startNode && node.textContent.includes(${JSON.stringify(startText)})) {
          startNode = node;
        }
        if (node.textContent.includes(${JSON.stringify(endText)})) {
          endNode = node;
        }
        node = walker.nextNode();
      }
      if (!startNode || !endNode) throw new Error("Multi-block selection text missing.");
      startNode.parentElement.scrollIntoView({ block: "center", inline: "nearest" });
      const range = document.createRange();
      range.setStart(startNode, startNode.textContent.indexOf(${JSON.stringify(startText)}));
      range.setEnd(
        endNode,
        endNode.textContent.indexOf(${JSON.stringify(endText)}) +
          ${JSON.stringify(endText)}.length
      );
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.querySelector(".editor-body")
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    })()`,
    userGesture: true
  });
}

async function selectMarkdownText(client, selectedText) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      if (!textarea) throw new Error("Markdown editor missing.");
      const start = textarea.value.indexOf(${JSON.stringify(selectedText)});
      if (start < 0) throw new Error("Markdown selection text missing.");
      textarea.focus();
      textarea.setSelectionRange(start, start + ${JSON.stringify(selectedText)}.length);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { start, end: textarea.selectionEnd };
    })()`,
    userGesture: true
  });
}

async function waitForMarkdownSelectionAction(client) {
  return await waitFor(client, "Markdown selection action", `(() => {
    const action = document.querySelector("[data-testid='comment-selection-action']");
    const textarea = document.querySelector("textarea.markdown-source-editor");
    if (!action || !textarea || textarea.selectionEnd <= textarea.selectionStart) {
      return null;
    }
    const rect = action.getBoundingClientRect();
    const style = getComputedStyle(action);
    return {
      selectedText: textarea.value.slice(
        textarea.selectionStart,
        textarea.selectionEnd
      ),
      cellTag: null,
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toolbarBottom: 0,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex
      }
    };
  })()`, Boolean);
}

async function waitForSelectionAction(client, expectedText) {
  return await waitFor(client, "selection action", `(() => {
    const action = document.querySelector("[data-testid='comment-selection-action']");
    const selection = window.getSelection();
    if (!action || selection?.toString() !== ${JSON.stringify(expectedText)}) {
      return null;
    }
    const rect = action.getBoundingClientRect();
    const style = getComputedStyle(action);
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const cell = range?.commonAncestorContainer.parentElement?.closest("td, th");
    const toolbar = document.querySelector(".mdxeditor-toolbar")?.getBoundingClientRect();
    return {
      selectedText: selection.toString(),
      cellTag: cell?.tagName ?? null,
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toolbarBottom: toolbar?.bottom ?? 0,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex
      }
    };
  })()`, (value) => Boolean(value));
}

function assertActionInViewport(action) {
  assert.equal(action.style.display === "none", false);
  assert.equal(action.style.visibility, "visible");
  assert.notEqual(action.style.opacity, "0");
  assert.notEqual(action.style.pointerEvents, "none");
  assert.ok(Number(action.style.zIndex) >= 70);
  assert.ok(action.rect.left >= 8);
  assert.ok(action.rect.top >= Math.max(8, action.toolbarBottom));
  assert.ok(action.rect.right <= action.viewport.width - 8);
  assert.ok(action.rect.bottom <= action.viewport.height - 8);
}

async function openSelectionComposer(client) {
  await openSelectionChooser(client);
  await chooseSelectionAction(client, "selected_text");
}

async function openSelectionChooser(client) {
  const point = await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector("[data-testid='comment-selection-action']");
      if (!button) throw new Error("Selection action missing.");
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y
  });
  await client.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
  await client.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
  await waitForChooser(client);
}

async function waitForChooser(client, expectedExcerpt, expectedTrigger) {
  return await waitFor(client, "selection actions chooser", `(() => {
    const chooser = document.querySelector("[data-testid='selection-actions-chooser']");
    if (
      !chooser ||
      (${JSON.stringify(expectedExcerpt ?? null)} &&
        !chooser.textContent.includes(${JSON.stringify(expectedExcerpt ?? "")})) ||
      (${JSON.stringify(expectedTrigger ?? null)} &&
        chooser.dataset.chooserTrigger !== ${JSON.stringify(expectedTrigger ?? "")})
    ) {
      return null;
    }
    const rect = chooser.getBoundingClientRect();
    const style = getComputedStyle(chooser);
    return {
      actionIds: Array.from(
        chooser.querySelectorAll("[data-selection-action-option]")
      ).map((control) => control.dataset.selectionActionOption),
      unavailableIds: Array.from(
        chooser.querySelectorAll("[data-selection-action-unavailable]")
      ).map((control) => control.dataset.selectionActionUnavailable),
      text: chooser.textContent,
      trigger: chooser.dataset.chooserTrigger,
      selectionLatencyMs: Number(chooser.dataset.selectionLatencyMs || 0),
      renderCount: Number(chooser.dataset.renderCount || 0),
      activeAction:
        document.activeElement?.dataset?.selectionActionOption ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex
      }
    };
  })()`, (value) => Boolean(value?.activeAction));
}

function assertChooserInViewport(chooser) {
  assert.equal(chooser.style.display === "none", false);
  assert.equal(chooser.style.visibility, "visible");
  assert.notEqual(chooser.style.opacity, "0");
  assert.notEqual(chooser.style.pointerEvents, "none");
  assert.ok(Number(chooser.style.zIndex) >= 80);
  assert.ok(chooser.rect.left >= 8);
  assert.ok(
    chooser.rect.top >= 8,
    `Chooser top must stay in the viewport: ${JSON.stringify(chooser)}`
  );
  assert.ok(chooser.rect.right <= chooser.viewport.width - 8);
  assert.ok(chooser.rect.bottom <= chooser.viewport.height - 8);
}

function assertCompleteChooser(chooser) {
  assert.deepEqual(chooser.actionIds, [
    "selected_text",
    "section",
    "document",
    "rewrite_selected_text",
    "rewrite_section",
    "bookmark"
  ]);
  assert.deepEqual(chooser.unavailableIds, []);
  assert.match(chooser.text, /Selected text/);
  assert.match(chooser.text, /Current section/);
  assert.match(chooser.text, /Whole document/);
  assert.match(chooser.text, /Rewrite selected text/);
  assert.match(chooser.text, /Rewrite current section/);
  assert.match(chooser.text, /Set reading bookmark/);
}

async function clickRewriteWorkspaceButton(client, label) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(
        document.querySelectorAll("[data-testid='rewrite-workspace'] button")
      ).find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Rewrite Workspace button missing: ${escapeJs(label)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickRewriteDialogButton(client, label) {
  await evaluate(client, {
    expression: `(() => {
      const dialogs = Array.from(document.querySelectorAll(".rewrite-dialog"));
      const button = dialogs.flatMap((dialog) => Array.from(dialog.querySelectorAll("button")))
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Rewrite dialog button missing: ${escapeJs(label)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function setRewriteMarkdownDraft(client, markdown) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("#rewrite-human-draft");
      if (!textarea) throw new Error("Rewrite Markdown editor missing.");
      textarea.focus();
      textarea.setSelectionRange(0, textarea.value.length);
      return true;
    })()`,
    userGesture: true
  });
  await client.call("Input.insertText", { text: markdown });
}

async function appendToRewriteVisualDraft(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector("[aria-label='My rewrite Visual editor']");
      if (!editor) throw new Error("Rewrite Visual editor missing.");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`,
    userGesture: true
  });
  await client.call("Input.insertText", { text });
}

async function chooseSelectionAction(client, actionId) {
  await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(
        "[data-selection-action-option='${escapeJs(actionId)}']"
      );
      if (!button) throw new Error("Selection action option missing: ${escapeJs(actionId)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function cancelChooser(client) {
  await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(
        "[aria-label='Close comment scope chooser']"
      );
      if (!button) throw new Error("Chooser close button missing.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(client, "chooser close", `(() => (
    !document.querySelector("[data-testid='selection-actions-chooser']") &&
    ["editable markdown", "Markdown Mode"].includes(
      document.activeElement?.getAttribute("aria-label")
    )
  ))()`);
}

async function openRightClickChooser(client) {
  await evaluate(client, {
    expression: `(() => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) throw new Error("Selection missing.");
      const rect = selection.getRangeAt(0).getClientRects()[0];
      if (!rect) throw new Error("Selection rectangle missing.");
      document.querySelector(".editor-body").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.max(1, rect.width / 2),
          clientY: rect.top + Math.max(1, rect.height / 2)
        })
      );
      return true;
    })()`,
    userGesture: true
  });
  return await waitForChooser(client, null, "context_menu");
}

async function openChooserWithoutSelection(client) {
  await evaluate(client, {
    expression: `(() => {
      window.getSelection()?.removeAllRanges();
      const paragraph = Array.from(
        document.querySelectorAll(".patchmark-prose p")
      ).find((candidate) => candidate.textContent.includes(${JSON.stringify(paragraphTarget)}));
      if (!paragraph) throw new Error("Paragraph target missing.");
      paragraph.scrollIntoView({ block: "center" });
      const rect = paragraph.getBoundingClientRect();
      document.querySelector(".editor-body").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 4,
          clientY: rect.top + Math.max(2, rect.height / 2)
        })
      );
      return true;
    })()`,
    userGesture: true
  });
  return await waitForChooser(client, null, "context_menu");
}

async function waitForComposer(client, expectedPreviewText) {
  return await waitFor(client, "comment composer", `(() => {
    const form = document.querySelector("[data-testid='comment-composer']");
    if (!form || !form.textContent.includes(${JSON.stringify(expectedPreviewText)})) {
      return null;
    }
    const rect = form.getBoundingClientRect();
    const input = form.querySelector("[data-comment-composer-input]");
    const style = getComputedStyle(form);
    return {
      preview: form.textContent,
      activeInput: document.activeElement === input,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents
      }
    };
  })()`, (value) => Boolean(value?.activeInput));
}

function assertComposerInViewport(composer) {
  assert.equal(composer.style.display === "none", false);
  assert.equal(composer.style.visibility, "visible");
  assert.notEqual(composer.style.opacity, "0");
  assert.notEqual(composer.style.pointerEvents, "none");
  assert.ok(composer.rect.left >= 0);
  assert.ok(composer.rect.top >= 0);
  assert.ok(composer.rect.right <= composer.viewport.width);
  assert.ok(composer.rect.bottom <= composer.viewport.height);
}

async function cancelComposer(client) {
  await clickComposerButton(client, "Cancel");
  await waitForComposerMissing(client);
}

async function clickComposerButton(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const form = document.querySelector("[data-testid='comment-composer']");
      const button = Array.from(form?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Composer button missing: ${escapeJs(text)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForComposerMissing(client, requireEditorFocus = true) {
  await waitFor(client, "composer close", `(() => (
    !document.querySelector("[data-testid='comment-composer']") &&
    (
      !${JSON.stringify(requireEditorFocus)} ||
      document.activeElement?.getAttribute("aria-label") === "editable markdown"
    )
  ))()`);
}

async function dismissSelectionAction(client) {
  await evaluate(client, {
    expression: `(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(client, "selection action close", `(() => (
    !document.querySelector("[data-testid='comment-selection-action']")
  ))()`);
}

async function pressShortcut(client) {
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "M",
    code: "KeyM",
    modifiers: 9
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "M",
    code: "KeyM",
    modifiers: 9
  });
}

async function pressEscape(client) {
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape"
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape"
  });
}

async function openWholeDocumentComposer(client) {
  await clickButtonByText(client, "Comment on whole document");
}

async function selectDocument(client, title) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.textContent.includes(${JSON.stringify(title)}));
      if (!button || button.disabled) throw new Error("Document button missing: ${escapeJs(title)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function fillComposer(client, value) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("[data-comment-composer-input]");
      if (!textarea) throw new Error("Composer textarea missing.");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(textarea, ${JSON.stringify(value)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return textarea.value;
    })()`,
    userGesture: true
  });
}

async function waitForPersistedComment(
  fixtureDir,
  documentId,
  { commentText, selectedText = null }
) {
  const commentsPath = join(
    fixtureDir,
    ".patchmark",
    "documents",
    documentId,
    "comments.json"
  );
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
    const comment = comments.find(
      (candidate) =>
        candidate.comment === commentText &&
        (selectedText === null ||
          candidate.anchor?.selected_text === selectedText)
    );
    if (comment) {
      assert.equal(
        comments.filter(
          (candidate) => candidate.comment === commentText
        ).length,
        1
      );
      return comment;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for submitted comment: ${commentText}`);
}

function readFixtureComments(fixtureDir, documentId) {
  return JSON.parse(
    readFileSync(
      join(
        fixtureDir,
        ".patchmark",
        "documents",
        documentId,
        "comments.json"
      ),
      "utf8"
    )
  );
}

async function waitForReadingBookmark(
  fixtureDir,
  documentId,
  selectedText
) {
  const manifestPath = join(
    fixtureDir,
    ".patchmark",
    "documents",
    documentId,
    "manifest.json"
  );

  for (let attempt = 0; attempt < 160; attempt += 1) {
    const bookmark = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ).reading_bookmark;

    if (bookmark?.anchor?.selected_text === selectedText) {
      return bookmark;
    }
    await delay(50);
  }

  throw new Error("Timed out waiting for the selected-text bookmark.");
}

async function waitForCreatedCommentCard(client, commentId) {
  await waitFor(client, `comment card ${commentId}`, `(() => {
    const item = document.querySelector(${JSON.stringify(
      `[data-comment-id="${commentId}"]`
    )});
    return Boolean(
      item &&
      item.getAttribute("data-comment-anchor-kind") === "selected_text" &&
      item.getAttribute("data-comment-anchor-status") === "active"
    );
  })()`);
}

async function auditExistingAnchors(client) {
  return await evaluate(client, {
    expression: `(() => {
      const items = Array.from(document.querySelectorAll("[data-comment-anchor-kind='selected_text']"));
      return {
        activeSelectedTextComments: items.filter(
          (item) => item.getAttribute("data-comment-anchor-status") === "active"
        ).length,
        linkCommentPresent: Boolean(document.querySelector("[data-comment-id='PM-COMMENT-0002']")),
        multiBlockCommentPresent: Boolean(document.querySelector("[data-comment-id='PM-COMMENT-0003']"))
      };
    })()`
  });
}

async function saveScreenshot(client, path) {
  const result = await client.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

async function installRewritePersistenceObserver(client) {
  await evaluate(client, {
    expression: `(() => {
      window.__patchmarkRewritePersistenceEvents = [];
      if (!window.__patchmarkRewritePersistenceObserverInstalled) {
        window.addEventListener("patchmark:rewrite-persistence", (event) => {
          window.__patchmarkRewritePersistenceEvents.push(event.detail);
        });
        window.__patchmarkRewritePersistenceObserverInstalled = true;
      }
      return true;
    })()`
  });
}

async function waitFor(
  client,
  label,
  expression,
  predicate = (value) => Boolean(value)
) {
  let latest = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (predicate(latest)) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}.\n${JSON.stringify(latest, null, 2)}`
  );
}

async function waitForFixtureFile(path, predicate, label) {
  let latest = "";
  for (let attempt = 0; attempt < 180; attempt += 1) {
    latest = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (predicate(latest)) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.\n${latest.slice(0, 1000)}`);
}

function fingerprintProject(root) {
  return Object.fromEntries(
    listFiles(root).map((path) => {
      const content = readFileSync(path);
      return [
        relative(root, path),
        createHash("sha256").update(content).digest("hex")
      ];
    })
  );
}

function fingerprintDocumentContent(root) {
  return Object.fromEntries(
    listFiles(root)
      .filter((path) => {
        const projectPath = relative(root, path);
        return (
          !projectPath.includes("/.patchmark-tmp-") &&
          !projectPath.includes("/recovery/") &&
          !projectPath.endsWith("save-commit.json") &&
          !projectPath.endsWith("rewrite-sessions.json") &&
          !projectPath.endsWith("manifest.json")
        );
      })
      .map((path) => {
        const projectPath = relative(root, path);
        const content = readFileSync(path);
        return [
          projectPath,
          createHash("sha256").update(content).digest("hex")
        ];
      })
  );
}

function readDocumentManifestReviewState(root, documentId) {
  const manifest = JSON.parse(
    readFileSync(
      join(root, ".patchmark", "documents", documentId, "manifest.json"),
      "utf8"
    )
  );
  const readingBookmark = manifest.reading_bookmark
    ? structuredClone(manifest.reading_bookmark)
    : null;
  if (readingBookmark?.anchor) {
    delete readingBookmark.anchor.action_context;
  }
  return {
    comment_deletion_tombstones: manifest.comment_deletion_tombstones ?? [],
    current_version: manifest.current_version ?? null,
    reading_bookmark: readingBookmark,
    reading_bookmarks: manifest.reading_bookmarks ?? null,
    versions: manifest.versions ?? []
  };
}

function readRewriteSessionStore(root, documentId) {
  return JSON.parse(
    readFileSync(
      join(
        root,
        ".patchmark",
        "documents",
        documentId,
        "rewrite-sessions.json"
      ),
      "utf8"
    )
  );
}

async function clearRewriteIndexedDb(client) {
  await evaluate(client, {
    expression: `new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("patchmark-rewrite-state");
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve(false);
    })`
  });
}

function listFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else if (existsSync(path)) {
      files.push(path);
    }
  }
  return files.sort();
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeJs(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

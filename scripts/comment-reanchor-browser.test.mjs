import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
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
  waitForProcessExit,
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/";
const artifactRoot =
  process.env.PATCHMARK_PHASE8_ARTIFACT_DIR ??
  mkdtempSync(join(tmpdir(), "patchmark-reanchor-browser-"));
const fixtureDir = join(artifactRoot, "project-fixture");
const screenshotDir = join(artifactRoot, "screenshots");
const commentIds = {
  ambiguous: "PM-COMMENT-PHASE8-A",
  missing: "PM-COMMENT-PHASE8-B",
  link: "PM-COMMENT-PHASE8-C",
  multi: "PM-COMMENT-PHASE8-D",
  row: "PM-COMMENT-PHASE8-E",
  table: "PM-COMMENT-PHASE8-F",
  failure: "PM-COMMENT-PHASE8-G",
  business: "PM-COMMENT-PHASE8-H"
};
const paragraphReplacement =
  "Current explanatory phrase for deleted evidence.";
const secondParagraphReplacement =
  "A newer explanatory phrase should replace the first manual choice.";
const tableCellReplacement =
  "Break-even must be calculated after ingredient cost, packaging, labor, delivery, utilities, admin, accounting, tax/VAT handling, staff, and facility costs.";
const failureReplacement =
  "Persistence failure target remains available for a safe retry.";
const businessVisibleText =
  "The Business of the Company shall, unless and until the Parties hereto otherwise agree, be confined to carry on the business of ___";
const businessMarkdownText = [
  "The Business of the Company shall, unless and until the Parties",
  "hereto otherwise agree, be confined to carry on the business of \\_\\_\\_"
].join("\n");
const multiNodeVisibleText =
  "A selection across multiple rendered text nodes stays within one supported paragraph.";
const multiNodeMarkdownText =
  "A selection across **multiple rendered text nodes** stays within one supported paragraph.";

rmSync(fixtureDir, { force: true, recursive: true });
rmSync(screenshotDir, { force: true, recursive: true });
mkdirSync(artifactRoot, { recursive: true });
mkdirSync(screenshotDir, { recursive: true });
preparePhase8Fixture(fixtureDir);

const actionStore = join(
  fixtureDir,
  ".patchmark",
  "documents",
  "doc_action"
);
const patchesPath = join(actionStore, "patches.json");
const commentsPath = join(actionStore, "comments.json");
const patchesBefore = readFileSync(patchesPath);
const commentsBeforeCancelHash = sha256(readFileSync(commentsPath));
const inventory = inventoryProject(fixtureDir);
const fixtureServer = await startFixtureFileServer(fixtureDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = join(artifactRoot, "chrome-profile");
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
const runtimeExceptions = [];

try {
  qualification: {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  const pageWsUrl = await createPage(browserWsUrl, "about:blank");
  client = await CdpClient.connect(pageWsUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    runtimeExceptions.push({
      description: exceptionDetails?.exception?.description,
      text: exceptionDetails?.text
    });
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(fixtureDir)
    })
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1100,
    mobile: false,
    width: 1700
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForPhase8Comments(client);
  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);

  await activateComment(client, commentIds.business);
  await clickCommentButton(client, commentIds.business, "Re-anchor");
  await waitForSelector(client, ".reanchor-empty-candidates");
  await selectVisualRange(client, businessVisibleText);
  await waitForWorkspaceSelection(client, businessMarkdownText);
  await clickWithin(client, ".reanchor-mode-panel", "Cancel");
  await waitForSelectorToDisappear(client, ".reanchor-mode-panel");
  assert.equal(
    sha256(readFileSync(commentsPath)),
    commentsBeforeCancelHash,
    "Selecting the screenshot regression range and cancelling must not write project state."
  );

  const initialFingerprint = fingerprintProject(fixtureDir);
  await activateComment(client, commentIds.ambiguous);
  const baselineEntry = await evaluate(client, {
    expression: `(() => {
      window.scrollTo({ top: Math.max(0, document.body.scrollHeight - window.innerHeight - 320) });
      window.__patchmarkReanchorEditorNode = document.querySelector("[aria-label='editable markdown']");
      const editor = window.__patchmarkReanchorEditorNode;
      return {
        editorHeight: editor?.getBoundingClientRect().height ?? 0,
        tableButtonCount: editor?.querySelectorAll("button").length ?? 0,
        scrollY: window.scrollY,
        readCount: window.__patchmarkFixtureReadLog?.length ?? 0
      };
    })()`
  });
  const controlsStartedAt = Date.now();
  await clickCommentButton(client, commentIds.ambiguous, "Re-anchor");
  await waitForSelector(client, ".reanchor-workspace");
  const workspaceEntry = await measureWorkspace(client);
  await assertFocusedTestId(client, "reanchor-workspace");
  if (process.env.PATCHMARK_REANCHOR_STATE_DIAGNOSTIC === "1") {
    console.log(
      JSON.stringify(
        {
          checkpoint: "selection_only_workspace_ready",
          baselineEntry,
          workspaceEntry
        },
        null,
        2
      )
    );
  }
  const controlsLatencyMs = Date.now() - controlsStartedAt;
  assert.ok(
    Math.abs(workspaceEntry.scrollY - baselineEntry.scrollY) <= 1,
    `Opening re-anchor must preserve deep scroll position. Before ${baselineEntry.scrollY}, after ${workspaceEntry.scrollY}.`
  );
  assert.equal(workspaceEntry.editorSame, true, "Editor must not remount.");
  assert.equal(
    workspaceEntry.editorContentEditable,
    "true",
    "Visual re-anchor must preserve the rendered editor tree."
  );
  assert.equal(
    workspaceEntry.editorAriaReadOnly,
    "true",
    "Visual re-anchor must expose selection-only state to assistive technology."
  );
  assert.equal(workspaceEntry.editorRole, "textbox");
  assert.equal(workspaceEntry.editorSelectionOnly, true);
  assert.equal(workspaceEntry.editorBodyAriaBusy, null);
  assert.equal(workspaceEntry.editorAriaBusy, null);
  assert.equal(
    workspaceEntry.editorDocumentKey,
    workspaceEntry.editorBodyDocumentKey,
    "Selection-only semantics must belong to the accepted document editor."
  );
  assert.equal(workspaceEntry.editorBodySwitching, null);
  assert.equal(workspaceEntry.focusInEditor, false);
  if (process.env.PATCHMARK_REANCHOR_FOCUSED_ACCESSIBILITY === "1") {
    console.log(
      JSON.stringify(
        {
          checkpoint: "selection_only_accessibility_pass",
          editorAriaReadOnly: workspaceEntry.editorAriaReadOnly,
          editorContentEditable: workspaceEntry.editorContentEditable,
          editorDocumentKey: workspaceEntry.editorDocumentKey,
          editorRole: workspaceEntry.editorRole,
          editorSelectionOnly: workspaceEntry.editorSelectionOnly
        },
        null,
        2
      )
    );
    break qualification;
  }
  assert.ok(
    Math.abs(workspaceEntry.editorHeight - baselineEntry.editorHeight) <= 1,
    "Visual re-anchor must not collapse table-heavy editor content."
  );
  assert.equal(
    workspaceEntry.tableButtonCount,
    baselineEntry.tableButtonCount,
    "Visual re-anchor must preserve table-control geometry."
  );
  const blockedMutationBefore = await evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector("[aria-label='editable markdown']");
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent?.trim()) {
        textNode = walker.nextNode();
      }
      if (!textNode) throw new Error("Visual editor text is unavailable.");
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      editor.focus({ preventScroll: true });
      return {
        scrollY: window.scrollY,
        text: editor.textContent
      };
    })()`,
    userGesture: true
  });
  await client.call("Input.insertText", {
    text: "PATCHMARK_BLOCKED_REANCHOR_MUTATION"
  });
  await delay(50);
  const blockedMutationAfter = await evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector("[aria-label='editable markdown']");
      return {
        scrollY: window.scrollY,
        text: editor.textContent
      };
    })()`
  });
  assert.deepEqual(
    blockedMutationAfter,
    blockedMutationBefore,
    "Visual re-anchor must block document mutations without changing layout."
  );
  assert.equal(workspaceEntry.position, "fixed");
  assertWorkspaceInViewport(workspaceEntry);
  assert.equal(workspaceEntry.commentsPanelVisible, false);
  assert.equal(workspaceEntry.candidateCount, 2);
  assert.equal(workspaceEntry.selectedCandidateCount, 0);
  assert.equal(workspaceEntry.expandedPreviewCount, 0);
  assert.equal(
    workspaceEntry.readCount,
    baselineEntry.readCount,
    "Opening re-anchor must not reload project files."
  );
  assert.ok(controlsLatencyMs < 1000, "Re-anchor controls should appear promptly.");
  await waitForSelector(client, ".reanchor-candidate-list");
  await capture(client, "02-suggested-candidate-list.png");
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 820
  });
  const narrowWorkspace = await waitForWorkspaceViewport(client);
  assertWorkspaceInViewport(narrowWorkspace);
  assert.equal(narrowWorkspace.pageHorizontalOverflow <= 1, true);
  await capture(client, "11-narrow-candidate-list.png");
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1100,
    mobile: false,
    width: 1700
  });
  await waitForWorkspaceViewport(client);
  const candidateEntryScrollY = await evaluate(client, { expression: "window.scrollY" });
  const fingerprintBeforeCandidateSelection = fingerprintProject(fixtureDir);
  await selectCandidate(client, 0);
  await waitForSelectedCandidatePreview(client, 0);
  await waitForPreviewHighlight(client);
  assert.deepEqual(
    fingerprintProject(fixtureDir),
    fingerprintBeforeCandidateSelection,
    "Candidate selection must remain inspection-only."
  );
  await capture(client, "03-candidate-preview.png");
  await clickWithin(client, ".reanchor-mode-panel", "Return to previous position");
  await waitForScrollNear(client, candidateEntryScrollY);
  await clickWithin(client, ".reanchor-mode-panel", "Cancel");
  await waitForSelectorToDisappear(client, ".reanchor-mode-panel");
  await assertFocusedComment(client, commentIds.ambiguous);
  assert.equal(sha256(readFileSync(commentsPath)), commentsBeforeCancelHash);
  assert.deepEqual(
    fingerprintProject(fixtureDir),
    initialFingerprint,
    "Preview and cancellation must not write authoritative project files."
  );

  await activateComment(client, commentIds.ambiguous);
  await clickCommentButton(client, commentIds.ambiguous, "Re-anchor");
  await selectCandidate(client, 1);
  await waitForSelectedCandidatePreview(client, 1);
  await clickWithin(client, ".reanchor-candidate-preview", "Review this location");
  await waitForSelector(client, ".reanchor-confirmation-dialog");
  await assertConfirmationModalState(client);
  await capture(client, "04-final-confirmation.png");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForSelectorToDisappear(client, ".reanchor-confirmation-dialog");
  await waitForPersistedAnchor(commentsPath, commentIds.ambiguous, "LINE add");
  await assertFocusedComment(client, commentIds.ambiguous);
  await assertActiveCommentProjection(client, commentIds.ambiguous, "LINE add");
  await capture(client, "05-successfully-reanchored.png");

  const writesBeforeNoOp = await getFixtureWriteCount(client);
  await openHealthyChangeAnchor(client, commentIds.ambiguous);
  await openDetails(client, ".reanchor-recovery-details");
  await capture(client, "12-concise-recovery-history.png");
  await selectCandidate(client, 0);
  await clickWithin(client, ".reanchor-candidate-preview", "Review this location");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForText(client, "This comment is already anchored to that text.");
  assert.equal(await getFixtureWriteCount(client), writesBeforeNoOp);

  await activateComment(client, commentIds.business);
  await clickCommentButton(client, commentIds.business, "Re-anchor");
  await waitForSelector(client, ".reanchor-empty-candidates");
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1000,
    mobile: false,
    width: 620
  });
  const forwardBusinessSelection = await selectVisualRange(
    client,
    businessVisibleText
  );
  assert.ok(
    forwardBusinessSelection.lineRectCount > 1,
    "the business paragraph must exercise browser line wrapping"
  );
  await waitForWorkspaceSelection(client, businessMarkdownText);

  const reversedBusinessSelection = await selectVisualRange(
    client,
    businessVisibleText,
    { reverse: true }
  );
  assert.equal(reversedBusinessSelection.direction, "backward");
  await waitForWorkspaceSelection(client, businessMarkdownText);

  const multiNodeSelection = await selectVisualRange(
    client,
    multiNodeVisibleText
  );
  assert.ok(
    multiNodeSelection.textNodeCount > 1,
    "the regression must span multiple rendered text nodes"
  );
  await waitForWorkspaceSelection(client, multiNodeMarkdownText);

  await selectVisualAcrossBlocks(
    client,
    businessVisibleText,
    multiNodeVisibleText
  );
  await waitForRejectedWorkspaceSelection(client);

  await selectVisualRange(client, businessVisibleText);
  await waitForWorkspaceSelection(client, businessMarkdownText);
  await clickWithin(
    client,
    ".reanchor-mode-panel",
    "Use selection as new anchor"
  );
  await clickWithin(
    client,
    ".reanchor-confirmation-dialog",
    "Confirm re-anchor"
  );
  const repairedBusinessComment = await waitForPersistedAnchor(
    commentsPath,
    commentIds.business,
    businessMarkdownText
  );
  assert.equal(repairedBusinessComment.id, commentIds.business);
  assert.equal(repairedBusinessComment.type, "note");
  assert.equal(repairedBusinessComment.status, "open");
  assert.equal(repairedBusinessComment.thread.length, 1);
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1100,
    mobile: false,
    width: 1700
  });
  await assertActiveCommentProjection(
    client,
    commentIds.business,
    businessMarkdownText
  );

  await activateComment(client, commentIds.missing);
  await capture(client, "01-missing-anchor-reanchor.png");
  await clickCommentButton(client, commentIds.missing, "Re-anchor");
  await waitForSelector(client, ".reanchor-empty-candidates");
  await capture(client, "13-no-candidate-manual-path.png");
  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  const beforeManualCancelFingerprint = fingerprintProject(fixtureDir);
  await selectVisualText(client, paragraphReplacement);
  await waitForWorkspaceSelection(client, paragraphReplacement);
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector(".comment-selection-action"))`
    }),
    false,
    "The ordinary Add comment affordance must be suppressed during re-anchor."
  );
  await evaluate(client, {
    expression: `(() => {
      const selection = window.getSelection();
      const rect = selection?.rangeCount
        ? selection.getRangeAt(0).getClientRects()[0]
        : null;
      if (!rect) throw new Error("Re-anchor selection rectangle missing.");
      document.querySelector(".editor-body").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.max(1, rect.width / 2),
          clientY: rect.top + Math.max(1, rect.height / 2)
        })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "M",
          shiftKey: true
        })
      );
      return true;
    })()`,
    userGesture: true
  });
  await delay(50);
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(
        document.querySelector("[data-testid='selection-actions-chooser']")
      )`
    }),
    false,
    "Right-click and keyboard scope actions must stay suppressed during re-anchor."
  );
  await selectVisualText(client, secondParagraphReplacement);
  await waitForWorkspaceSelection(client, secondParagraphReplacement);
  await capture(client, "14-visual-manual-selection.png");
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(
    client,
    ".reanchor-confirmation-dialog",
    "Choose different text"
  );
  await waitForSelectorToDisappear(client, ".reanchor-confirmation-dialog");
  await clickWithin(client, ".reanchor-mode-panel", "Cancel");
  await waitForSelectorToDisappear(client, ".reanchor-mode-panel");
  await assertFocusedComment(client, commentIds.missing);
  assert.deepEqual(
    fingerprintProject(fixtureDir),
    beforeManualCancelFingerprint,
    "Selecting, previewing, and cancelling must not write project state."
  );

  await activateComment(client, commentIds.missing);
  await clickCommentButton(client, commentIds.missing, "Re-anchor");
  await selectVisualText(client, paragraphReplacement);
  await waitForWorkspaceSelection(client, paragraphReplacement);
  await setConfirmResult(client, false);
  await selectDocument(client, "Notes");
  await waitForActiveDocument(client, "Action Plan");
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector(".reanchor-workspace"))`
    }),
    true,
    "Rejected switching must keep the current re-anchor session."
  );
  await setConfirmResult(client, true);
  await selectDocument(client, "Notes");
  await waitForActiveDocument(client, "Notes");
  await waitForSelectorToDisappear(client, ".reanchor-workspace");
  const duplicateComment = JSON.parse(
    readFileSync(
      join(
        fixtureDir,
        ".patchmark",
        "documents",
        "doc_notes",
        "comments.json"
      ),
      "utf8"
    )
  ).find((comment) => comment.id === commentIds.missing);
  assert.equal(duplicateComment.anchor.selected_text, "Different historical text");
  await selectDocument(client, "Action Plan");
  await waitForActiveDocument(client, "Action Plan");
  await waitForPhase8Comments(client);
  await waitForVisualEditor(client);

  await activateComment(client, commentIds.missing);
  await clickCommentButton(client, commentIds.missing, "Re-anchor");
  await selectVisualText(client, paragraphReplacement);
  await waitForWorkspaceSelection(client, paragraphReplacement);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForPersistedAnchor(
    commentsPath,
    commentIds.missing,
    paragraphReplacement
  );
  const stalePatchAfterReanchor = JSON.parse(
    readFileSync(patchesPath, "utf8")
  ).find((patch) => patch.id === "PM-PATCH-PHASE8");
  assert.equal(stalePatchAfterReanchor.status, "stale");
  assert.equal(stalePatchAfterReanchor.original_text, "Deleted historical evidence");

  await activateComment(client, commentIds.link);
  await clickCommentButton(client, commentIds.link, "Re-anchor");
  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  const linkLabel = "PAUL Thailand online delivery";
  await selectVisualLink(client, linkLabel);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  const fullLink = `[${linkLabel}](https://www.paulthailand.com/next-day-delivery)`;
  await waitForPersistedAnchor(commentsPath, commentIds.link, fullLink);
  await capture(client, "06-table-link-reanchor.png");

  await activateComment(client, commentIds.multi);
  await clickCommentButton(client, commentIds.multi, "Re-anchor");
  await clickButtonByText(client, "Markdown Mode");
  const multiBlock = await selectMarkdownSection(
    client,
    "### Early Cranberries & Walnut signal",
    "## Similar Rows"
  );
  await capture(client, "15-markdown-manual-selection.png");
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForPersistedAnchor(commentsPath, commentIds.multi, multiBlock);
  await capture(client, "07-multi-block-reanchor.png");

  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  await activateComment(client, commentIds.multi);
  await assertActiveCommentProjection(client, commentIds.multi, multiBlock);
  await capture(client, "08-removed-from-unpositioned.png");

  await activateComment(client, commentIds.row);
  await clickCommentButton(client, commentIds.row, "Re-anchor");
  await clickButtonByText(client, "Markdown Mode");
  const selectedRow = "| Baguette | Shared signal |";
  await selectMarkdownText(client, selectedRow);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  const persistedRowComment = await waitForPersistedAnchor(
    commentsPath,
    commentIds.row,
    selectedRow
  );
  assert.equal(persistedRowComment.anchor.anchor_context.table_row_index, 3);

  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  await activateComment(client, commentIds.table);
  await clickCommentButton(client, commentIds.table, "Re-anchor");
  await evaluate(client, {
    expression: `(() => {
      const root = document.documentElement.style;
      root.setProperty("--safe-area-top", "12px");
      root.setProperty("--safe-area-right", "10px");
      root.setProperty("--safe-area-bottom", "34px");
      root.setProperty("--safe-area-left", "10px");
      return true;
    })()`
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 844,
    mobile: true,
    width: 393
  });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  const mobileWorkspace = await waitForWorkspaceViewport(client);
  assertWorkspaceInViewport(mobileWorkspace);
  assert.ok(
    mobileWorkspace.width <= 393,
    "Mobile workspace must avoid horizontal overflow."
  );
  assert.equal(mobileWorkspace.pageHorizontalOverflow <= 1, true);
  assert.equal(mobileWorkspace.hoverFine, false);
  assert.equal(mobileWorkspace.bodyOverflow, "");
  assert.ok(mobileWorkspace.left >= 10);
  assert.ok(mobileWorkspace.right <= 383);
  assert.ok(mobileWorkspace.bottom <= 810);
  assert.equal(mobileWorkspace.paddingBottom, "46px");
  assert.match(mobileWorkspace.focusBoxShadow, /inset/);
  await selectVisualText(client, tableCellReplacement);
  const tableSelectionState = await waitForWorkspaceSelection(
    client,
    tableCellReplacement
  );
  assert.equal(tableSelectionState.contextKind, "table_cell");
  assert.equal(tableSelectionState.selectionText, tableCellReplacement);
  await capture(client, "09-mobile-workspace.png");
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await waitForSelector(client, ".reanchor-confirmation-dialog");
  await assertConfirmationModalState(client);
  await scrollIntoView(client, ".reanchor-confirmation-actions");
  await capture(client, "16-mobile-confirmation.png");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  const persistedTableComment = await waitForPersistedAnchor(
    commentsPath,
    commentIds.table,
    tableCellReplacement
  );
  assert.equal(
    persistedTableComment.anchor.anchor_context.kind,
    "table_cell"
  );
  await evaluate(client, {
    expression: `(() => {
      const root = document.documentElement.style;
      root.removeProperty("--safe-area-top");
      root.removeProperty("--safe-area-right");
      root.removeProperty("--safe-area-bottom");
      root.removeProperty("--safe-area-left");
      return true;
    })()`
  });
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1100,
    mobile: false,
    width: 1700
  });
  await capture(client, "10-table-reanchored.png");

  await activateComment(client, commentIds.failure);
  await clickCommentButton(client, commentIds.failure, "Re-anchor");
  await selectVisualText(client, failureReplacement);
  const failureSelectionState = await waitForWorkspaceSelection(
    client,
    failureReplacement
  );
  assert.ok(
    Number(failureSelectionState.selectionLatencyMs) < 250,
    "Selection updates should remain responsive."
  );
  await focusButtonWithin(
    client,
    ".reanchor-mode-panel",
    "Use selection as new anchor"
  );
  await pressFocusedKey(client, "Enter");
  await waitForSelector(client, ".reanchor-confirmation-dialog");
  await pressFocusedKey(client, "Escape");
  await waitForSelectorToDisappear(client, ".reanchor-confirmation-dialog");
  await assertFocusedTestId(client, "reanchor-workspace");
  await focusButtonWithin(
    client,
    ".reanchor-mode-panel",
    "Use selection as new anchor"
  );
  await pressFocusedKey(client, "Enter");
  await waitForSelector(client, ".reanchor-confirmation-dialog");
  const commentsBeforeFailureHash = sha256(readFileSync(commentsPath));
  await injectNextWriteFailure(client);
  await focusButtonWithin(
    client,
    ".reanchor-confirmation-dialog",
    "Confirm re-anchor"
  );
  await pressFocusedKey(client, "Enter");
  await waitForText(client, "The previous anchor remains authoritative.");
  await capture(client, "17-persistence-failure-retry.png");
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector(".reanchor-confirmation-dialog"))`
    }),
    true,
    "Persistence failure must keep the confirmation open."
  );
  assert.equal(
    sha256(readFileSync(commentsPath)),
    commentsBeforeFailureHash,
    "Persistence failure must preserve the authoritative comment anchor."
  );
  const confirmationStartedAt = Date.now();
  await focusButtonWithin(
    client,
    ".reanchor-confirmation-dialog",
    "Confirm re-anchor"
  );
  await pressFocusedKey(client, "Enter");
  await waitForPersistedAnchor(
    commentsPath,
    commentIds.failure,
    failureReplacement
  );
  const confirmationLatencyMs = Date.now() - confirmationStartedAt;
  assert.ok(
    confirmationLatencyMs < 2500,
    "Re-anchor confirmation should remain responsive."
  );

  await activateComment(client, commentIds.missing);
  await clickCommentButton(client, commentIds.missing, "Mark for ChatGPT");
  await waitForEnabledButton(client, "body", "Generate ChatGPT Prompt");
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitForSelector(client, ".comment-export-dialog textarea");
  const exportContainsNewAnchor = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".comment-export-dialog textarea"))
      .some((element) => element.value.includes(${JSON.stringify(paragraphReplacement)}))`
  });
  assert.equal(exportContainsNewAnchor, true);
  await clickWithin(client, ".comment-export-dialog", "Close");

  assert.deepEqual(readFileSync(patchesPath), patchesBefore);
  const finalComments = JSON.parse(readFileSync(commentsPath, "utf8"));
  const verifiedIds = [
    commentIds.ambiguous,
    commentIds.missing,
    commentIds.link,
    commentIds.multi,
    commentIds.row,
    commentIds.table,
    commentIds.failure,
    commentIds.business
  ];

  for (const commentId of verifiedIds) {
    const comment = finalComments.find((candidate) => candidate.id === commentId);
    assert.ok(comment, `Missing ${commentId}`);
    assert.equal(comment.thread.length, 1);
    assert.equal(
      comment.anchor_history.filter((entry) => entry.cause === "human_reanchor").length,
      1
    );
    assert.equal(comment.status, "open");
  }

  const pageReloaded = new Promise((resolve) => {
    const removeListener = client.on("Page.loadEventFired", () => {
      removeListener();
      resolve();
    });
  });
  await client.call("Page.reload", { ignoreCache: true });
  await Promise.race([
    pageReloaded,
    delay(15_000).then(() => {
      throw new Error("Timed out waiting for the re-anchor fixture reload.");
    })
  ]);
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForPhase8Comments(client);
  await waitForVisualEditor(client);
  await activateComment(client, commentIds.ambiguous);
  await assertActiveCommentProjection(client, commentIds.ambiguous, "LINE add");
  await activateComment(client, commentIds.business);
  await assertActiveCommentProjection(
    client,
    commentIds.business,
    businessMarkdownText
  );

  console.log(
    JSON.stringify(
      {
        artifactRoot,
        fixtureDir,
        screenshots: screenshotFiles(),
        commentsReanchored: verifiedIds.length,
        cancelWrites: 0,
        noOpWrites: 0,
        patchBytesUnchanged: true,
        reloadStable: true,
        exportUsesNewAnchor: exportContainsNewAnchor,
        controlsLatencyMs,
        confirmationLatencyMs,
        deepScrollPreserved: true,
        editorRemounted: false,
        mobileWorkspaceVisible: true
      },
      null,
      2
    )
  );
  }
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
}

function preparePhase8Fixture(projectDir) {
  const metadataDir = join(projectDir, ".patchmark");
  const now = "2026-07-30T00:00:00.000Z";
  mkdirSync(join(metadataDir, "documents"), { recursive: true });
  const filler = Array.from({ length: 48 }, (_, index) => [
    `## Long document context ${index + 1}`,
    "",
    `Deep-scroll re-anchor fixture paragraph ${index + 1}. `.repeat(12),
    ""
  ]).flat();
  const document = [
    "# Patchmark Phase 8 Fixture",
    "",
    ...filler,
    "## Demand Generation Plan",
    "The first LINE add candidate belongs to demand generation.",
    "",
    "## Weekly Metrics",
    "The second LINE add candidate belongs to weekly reporting.",
    "",
    "## Replacement Evidence",
    paragraphReplacement,
    "",
    secondParagraphReplacement,
    "",
    "## Public References",
    "| Brand | Delivery |",
    "| --- | --- |",
    "| PAUL | [PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery) |",
    "",
    "## Growth Path and Scenarios",
    "| Illustrative revenue logic | How to read it |",
    "| --- | --- |",
    `| ${tableCellReplacement} | This remains a provisional planning model. |`,
    "",
    "## Product Evidence",
    "### Early Cranberries & Walnut signal",
    "",
    "- **Household retail:** current evidence",
    "- **Wholesale:** current evidence",
    "- **Interpretation:** current evidence",
    "",
    "## Similar Rows",
    "| Product | Signal |",
    "| --- | --- |",
    "| Original | Shared signal |",
    "| Baguette | Shared signal |",
    "",
    "## Persistence Failure",
    failureReplacement,
    "",
    "## 3. AGREEMENTS OF THE PARTIES",
    "",
    "### 3.1 Business of the Company",
    "",
    businessMarkdownText,
    "",
    multiNodeMarkdownText
  ].join("\n");
  const comments = [
    fixtureComment(commentIds.ambiguous, "LINE add", "Choose the relevant occurrence."),
    fixtureComment(commentIds.missing, "Deleted historical evidence", "Select replacement evidence."),
    fixtureComment(commentIds.link, "Old PAUL delivery text", "Select the current PAUL link."),
    fixtureComment(commentIds.multi, "Old product evidence", "Select current multi-block evidence."),
    fixtureComment(commentIds.row, "| Missing | Shared signal |", "Select the intended row."),
    fixtureComment(commentIds.table, "Old break-even table text", "Select the current table cell."),
    fixtureComment(commentIds.failure, "Old persistence target", "Verify atomic retry behavior."),
    fixtureComment(commentIds.business, "Deleted business wording", "Repair the business paragraph anchor.")
  ];
  const patches = [
    {
      id: "PM-PATCH-PHASE8",
      status: "stale",
      comment_id: commentIds.missing,
      original_text: "Deleted historical evidence",
      suggested_text: paragraphReplacement,
      reason: "Fixture patch integrity check.",
      created_at: now
    }
  ];
  const duplicateDocument = [
    "# Duplicate Local Comment ID",
    "",
    "This document deliberately contains the same local comment ID.",
    "",
    "Only this document owns its local duplicate."
  ].join("\n");
  const documents = [
    createDocumentStore({
      comments,
      displayTitle: "Action Plan",
      documentId: "doc_action",
      markdown: document,
      now,
      patches,
      path: "action-plan.md",
      position: 1000,
      projectDir
    }),
    createDocumentStore({
      comments: [
        fixtureComment(
          commentIds.missing,
          "Different historical text",
          "Duplicate local ID in another document."
        )
      ],
      displayTitle: "Notes",
      documentId: "doc_notes",
      markdown: duplicateDocument,
      now,
      patches: [],
      path: "notes.md",
      position: 2000,
      projectDir
    })
  ];

  writeFileSync(
    join(metadataDir, "project.json"),
    serializeJson({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "project-reanchor-fixture",
      title: "Re-anchor fixture",
      created_at: now,
      manifest_revision: 1,
      documents
    })
  );
}

function createDocumentStore({
  comments,
  displayTitle,
  documentId,
  markdown,
  now,
  patches,
  path,
  position,
  projectDir
}) {
  writeFileSync(join(projectDir, path), markdown);
  const store = join(projectDir, ".patchmark", "documents", documentId);
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
      project_id: "project-reanchor-fixture",
      document_id: documentId,
      project_name: "Re-anchor fixture",
      document_file: "document.md",
      created_at: now,
      updated_at: now
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

function fixtureComment(id, selectedText, comment) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: 900000,
      markdown_end_offset: 900000 + selectedText.length,
      containing_heading: "Historical section",
      anchor_context: {
        kind: "paragraph",
        plain_text: selectedText,
        markdown_text: selectedText
      },
      action_context: {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: "note"
      }
    },
    comment,
    thread: [
      {
        id: `${id}-THREAD`,
        role: "user",
        content: "Preserve this complete thread.",
        created_at: "2026-07-15T00:00:00.000Z"
      }
    ],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

async function activateComment(pageClient, commentId) {
  await evaluate(pageClient, {
    expression: `(() => {
      const article = document.querySelector(${JSON.stringify(`#patchmark-comment-card-${commentId}`)});
      if (!article) throw new Error("Missing comment ${commentId}");
      article.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitForSelector(pageClient, `#patchmark-comment-card-${commentId}[aria-current="true"]`);
}

async function clickCommentButton(pageClient, commentId, text) {
  const menuText = new Map([
    ["Change anchor", "Change anchor"],
    ["Find", "Find in document"],
    ["Mark for ChatGPT", "Mark for ChatGPT"]
  ]).get(text);

  if (menuText) {
    await activateComment(pageClient, commentId);
    await evaluate(pageClient, {
      expression: `(() => {
        const card = document.querySelector(${JSON.stringify(`#patchmark-comment-card-${commentId}`)});
        const trigger = card?.querySelector(".comment-action-menu-trigger");
        if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing comment action menu");
        trigger.click();
      })()`,
      userGesture: true
    });
    await waitForEnabledButton(
      pageClient,
      ".comment-action-menu-panel",
      menuText
    );
    await clickWithin(pageClient, ".comment-action-menu-panel", menuText);
    return;
  }

  await clickWithin(pageClient, `#patchmark-comment-card-${commentId}`, text);
}

async function clickWithin(pageClient, selector, text) {
  await waitForEnabledButton(pageClient, selector, text);
  await evaluate(pageClient, {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const button = Array.from(root?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Missing enabled button ${text} in ${selector}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function selectCandidate(pageClient, index) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = document.querySelectorAll(".reanchor-candidate-option")[${index}];
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        throw new Error("Missing candidate option ${index}");
      }
      button.focus({ preventScroll: true });
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForSelectedCandidatePreview(pageClient, index) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await evaluate(pageClient, {
      expression: `(() => {
        const options = Array.from(document.querySelectorAll(".reanchor-candidate-option"));
        return {
          previewCount: document.querySelectorAll(".reanchor-candidate-preview").length,
          selectedCount: options.filter((option) => option.getAttribute("aria-pressed") === "true").length,
          selectedIndex: options.findIndex((option) => option.getAttribute("aria-pressed") === "true")
        };
      })()`
    });
    if (
      state.previewCount === 1 &&
      state.selectedCount === 1 &&
      state.selectedIndex === index
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for candidate ${index} preview.`);
}

async function assertConfirmationModalState(pageClient) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await evaluate(pageClient, {
      expression: `(() => {
        const dialog = document.querySelector(".reanchor-confirmation-dialog");
        return {
          activeHeading: document.activeElement === dialog?.querySelector("h2"),
          ariaBusy: dialog?.getAttribute("aria-busy") ?? null,
          ariaModal: dialog?.getAttribute("aria-modal") ?? null,
          bodyOverflow: document.body.style.overflow,
          commentsPanelCount: document.querySelectorAll(".comments-panel").length,
          role: dialog?.getAttribute("role") ?? null,
          workspaceCount: document.querySelectorAll(".reanchor-workspace").length
        };
      })()`
    });
    if (state.activeHeading) {
      assert.equal(state.role, "dialog");
      assert.equal(state.ariaModal, "true");
      assert.equal(state.bodyOverflow, "hidden");
      assert.equal(state.workspaceCount, 0);
      assert.equal(state.commentsPanelCount, 0);
      return;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for the focused re-anchor confirmation dialog.");
}

async function assertFocusedTestId(pageClient, testId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const focused = await evaluate(pageClient, {
      expression: `document.activeElement?.getAttribute("data-testid") === ${JSON.stringify(testId)}`
    });
    if (focused) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for focus on ${testId}.`);
}

async function assertFocusedComment(pageClient, commentId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const focused = await evaluate(pageClient, {
      expression: `document.activeElement?.id === ${JSON.stringify(`patchmark-comment-card-${commentId}`)}`
    });
    if (focused) return;
    await delay(25);
  }
  throw new Error(`Timed out restoring focus to ${commentId}.`);
}

async function openDetails(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const details = document.querySelector(${JSON.stringify(selector)});
      if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing details disclosure");
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      return true;
    })()`,
    userGesture: true
  });
}

async function scrollIntoView(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing element to scroll into view");
      element.scrollIntoView({ block: "end" });
      return true;
    })()`
  });
  await delay(50);
}

async function measureWorkspace(pageClient) {
  return await waitForWorkspaceViewport(pageClient);
}

async function waitForWorkspaceViewport(pageClient) {
  let latestState = null;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    latestState = await evaluate(pageClient, {
      expression: `(() => {
        const workspace = document.querySelector(".reanchor-workspace");
        if (!workspace) return null;
        const rect = workspace.getBoundingClientRect();
        const style = getComputedStyle(workspace);
        const editor = document.querySelector("[aria-label='editable markdown']");
        const editorBody = editor?.closest(".editor-body");
        const editorShell = editor?.closest("[data-editor-document-key]");
        return {
          bottom: rect.bottom,
          activeElementTestId: document.activeElement?.getAttribute("data-testid") ?? null,
          bodyOverflow: document.body.style.overflow,
          candidateCount: workspace.querySelectorAll(".reanchor-candidate-option").length,
          commentsPanelVisible: Boolean(document.querySelector(".comments-panel")),
          deferredCodeRunCount: editor?.querySelectorAll("[data-deferred-code-run]").length ?? 0,
          deferredEditorCount: editor?.querySelectorAll(".cm-editor").length ?? 0,
          editorBodyAriaBusy: editorBody?.getAttribute("aria-busy") ?? null,
          editorBodyDocumentKey: editorBody?.getAttribute("data-document-key") ?? null,
          editorBodySwitchPhase: editorBody?.getAttribute("data-document-switch-phase") ?? null,
          editorBodySwitching: editorBody?.getAttribute("data-document-switching") ?? null,
          editorAriaReadOnly: editor?.getAttribute("aria-readonly"),
          editorAriaBusy: editor?.getAttribute("aria-busy") ?? null,
          editorContentEditable: editor?.getAttribute("contenteditable"),
          editorContentFingerprint: editorShell?.getAttribute("data-editor-content-fingerprint") ?? null,
          editorDocumentKey: editorShell?.getAttribute("data-editor-document-key") ?? null,
          editorHeight: editor?.getBoundingClientRect().height ?? 0,
          editorRequestGeneration: editorShell?.getAttribute("data-editor-request-generation") ?? null,
          editorRole: editor?.getAttribute("role") ?? null,
          editorSame:
            window.__patchmarkReanchorEditorNode ===
            editor,
          editorSelectionOnly: editorShell?.classList.contains("visual-editor-selection-only") ?? false,
          focusInEditor: Boolean(editor?.contains(document.activeElement)),
          height: rect.height,
          left: rect.left,
          expandedPreviewCount: workspace.querySelectorAll(".reanchor-candidate-preview").length,
          hoverFine: matchMedia("(hover: hover) and (pointer: fine)").matches,
          focusBoxShadow: style.boxShadow,
          paddingBottom: style.paddingBottom,
          pageHorizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          position: style.position,
          readCount: window.__patchmarkFixtureReadLog?.length ?? 0,
          right: rect.right,
          scrollY: window.scrollY,
          selectionLatencyMs: workspace.getAttribute("data-selection-latency-ms"),
          selectionText:
            workspace.querySelector(".reanchor-selection-status")?.textContent ?? "",
          selectedCandidateCount: workspace.querySelectorAll('.reanchor-candidate-option[aria-pressed="true"]').length,
          top: rect.top,
          tableButtonCount: editor?.querySelectorAll("button").length ?? 0,
          visibility: style.visibility,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          width: rect.width
        };
      })()`
    });

    if (
      latestState &&
      latestState.visibility === "visible" &&
      latestState.width > 0 &&
      latestState.height > 0 &&
      latestState.top >= 0 &&
      latestState.bottom <= latestState.viewportHeight + 1
    ) {
      return latestState;
    }

    await delay(25);
  }

  throw new Error(
    `Timed out waiting for viewport-stable re-anchor workspace.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

function assertWorkspaceInViewport(workspace) {
  assert.ok(workspace.top >= 0, "Workspace must remain below the viewport top.");
  assert.ok(
    workspace.bottom <= workspace.viewportHeight + 1,
    "Workspace must remain above the viewport bottom."
  );
  assert.ok(workspace.left >= 0, "Workspace must remain inside the left edge.");
  assert.ok(
    workspace.right <= workspace.viewportWidth + 1,
    "Workspace must remain inside the right edge."
  );
}

async function waitForScrollNear(pageClient, expectedScrollY) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const currentScrollY = await evaluate(pageClient, {
      expression: "window.scrollY"
    });
    if (Math.abs(currentScrollY - expectedScrollY) <= 2) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out returning to scroll position ${expectedScrollY}.`);
}

async function selectVisualText(pageClient, selectedText) {
  await evaluate(pageClient, {
    expression: `(() => {
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.data.includes(${JSON.stringify(selectedText)})) {
        node = walker.nextNode();
      }
      if (!node) throw new Error("Visual selection text missing");
      const start = node.data.indexOf(${JSON.stringify(selectedText)});
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + ${JSON.stringify(selectedText)}.length);
      node.parentElement?.scrollIntoView({ block: "center" });
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.querySelector(".editor-body")
        ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return {
        selectedText: selection.toString(),
        scrollY: window.scrollY
      };
    })()`,
    userGesture: true
  });
}

async function selectVisualRange(
  pageClient,
  selectedText,
  { reverse = false } = {}
) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const normalize = (value) => value.replace(/\\s+/g, " ").trim();
      const selectedText = ${JSON.stringify(selectedText)};
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing");
      const block = Array.from(
        root.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, code, td, th")
      ).find((candidate) => normalize(candidate.textContent ?? "") === selectedText);
      if (!block) throw new Error("Visual selection block missing: " + selectedText);

      const points = [];
      const visibleParts = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        for (let index = 0; index < textNode.data.length; index += 1) {
          const character = textNode.data[index];
          if (/\\s/.test(character)) {
            if (
              visibleParts.length > 0 &&
              visibleParts[visibleParts.length - 1] !== " "
            ) {
              visibleParts.push(" ");
              points.push({ node: textNode, offset: index });
            }
          } else {
            visibleParts.push(character);
            points.push({ node: textNode, offset: index });
          }
        }
        textNode = walker.nextNode();
      }
      while (visibleParts[visibleParts.length - 1] === " ") {
        visibleParts.pop();
        points.pop();
      }

      const visibleText = visibleParts.join("");
      const start = visibleText.indexOf(selectedText);
      if (start < 0) throw new Error("Normalized Visual selection text missing");
      const end = start + selectedText.length;
      const startPoint = points[start];
      const endPoint = points[end - 1];
      if (!startPoint || !endPoint) throw new Error("Visual range points missing");

      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset + 1);
      const selection = window.getSelection();
      selection.removeAllRanges();
      if (${JSON.stringify(reverse)}) {
        selection.setBaseAndExtent(
          endPoint.node,
          endPoint.offset + 1,
          startPoint.node,
          startPoint.offset
        );
      } else {
        selection.addRange(range);
      }
      block.scrollIntoView({ block: "center" });
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.querySelector(".editor-body")
        ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return {
        direction: ${JSON.stringify(reverse)} ? "backward" : "forward",
        lineRectCount: range.getClientRects().length,
        selectedText: normalize(selection.toString()),
        textNodeCount: new Set(
          points.slice(start, end).map((point) => point.node)
        ).size
      };
    })()`,
    userGesture: true
  });
}

async function selectVisualAcrossBlocks(pageClient, firstText, secondText) {
  await evaluate(pageClient, {
    expression: `(() => {
      const normalize = (value) => value.replace(/\\s+/g, " ").trim();
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing");
      const blocks = Array.from(root.querySelectorAll("p"));
      const firstBlock = blocks.find(
        (candidate) => normalize(candidate.textContent ?? "") === ${JSON.stringify(firstText)}
      );
      const secondBlock = blocks.find(
        (candidate) => normalize(candidate.textContent ?? "") === ${JSON.stringify(secondText)}
      );
      if (!firstBlock || !secondBlock) throw new Error("Cross-block range missing");
      const firstWalker = document.createTreeWalker(firstBlock, NodeFilter.SHOW_TEXT);
      const secondWalker = document.createTreeWalker(secondBlock, NodeFilter.SHOW_TEXT);
      const firstNode = firstWalker.nextNode();
      let secondNode = secondWalker.nextNode();
      let lastSecondNode = secondNode;
      while (secondNode) {
        lastSecondNode = secondNode;
        secondNode = secondWalker.nextNode();
      }
      if (!firstNode || !lastSecondNode) throw new Error("Cross-block text missing");
      const range = document.createRange();
      range.setStart(firstNode, 0);
      range.setEnd(lastSecondNode, lastSecondNode.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.querySelector(".editor-body")
        ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return normalize(selection.toString());
    })()`,
    userGesture: true
  });
}

async function waitForWorkspaceSelection(pageClient, selectedText) {
  let latestState = null;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    latestState = await evaluate(pageClient, {
      expression: `(() => {
        const workspace = document.querySelector(".reanchor-workspace");
        const button = Array.from(workspace?.querySelectorAll("button") ?? [])
          .find((candidate) => candidate.textContent?.trim() === "Use selection as new anchor");
        const status = workspace?.querySelector(".reanchor-selection-status");
        return {
          buttonEnabled: Boolean(button && !button.disabled),
          contextKind: status?.getAttribute("data-selection-context") ?? null,
          selectionLatencyMs: workspace?.getAttribute("data-selection-latency-ms") ?? null,
          selectionText: status?.getAttribute("data-selection-text") ?? ""
        };
      })()`
    });
    if (
      latestState.buttonEnabled &&
      latestState.selectionText === selectedText
    ) {
      return latestState;
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for re-anchor selection ${selectedText}.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function waitForRejectedWorkspaceSelection(pageClient) {
  let latestState = null;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    latestState = await evaluate(pageClient, {
      expression: `(() => {
        const workspace = document.querySelector(".reanchor-workspace");
        const button = Array.from(workspace?.querySelectorAll("button") ?? [])
          .find((candidate) => candidate.textContent?.trim() === "Use selection as new anchor");
        return {
          buttonDisabled: Boolean(button?.disabled),
          help: workspace?.querySelector(".reanchor-selection-status")?.textContent ?? ""
        };
      })()`
    });
    if (latestState.buttonDisabled) {
      return latestState;
    }
    await delay(25);
  }

  throw new Error(
    `Timed out waiting for rejected cross-block selection.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function setConfirmResult(pageClient, result) {
  await evaluate(pageClient, {
    expression: `window.confirm = () => ${JSON.stringify(result)}; true`
  });
}

async function selectDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll(".project-document-select"));
      const button = buttons.find((candidate) =>
        candidate.textContent?.includes(${JSON.stringify(title)})
      );
      if (!button || button.disabled) {
        throw new Error("Document selector unavailable: ${title}");
      }
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForActiveDocument(pageClient, title) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const active = await evaluate(pageClient, {
      expression: `document.querySelector("[aria-label='Workspace status']")
        ?.textContent?.includes(${JSON.stringify(`Document: ${title}`)}) ?? false`
    });
    if (active) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for active document ${title}.`);
}

async function focusButtonWithin(pageClient, selector, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const button = Array.from(root?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Missing enabled button ${text}");
      button.focus({ preventScroll: true });
      return document.activeElement === button;
    })()`,
    userGesture: true
  });
}

async function pressFocusedKey(pageClient, key) {
  const windowsVirtualKeyCode = key === "Escape" ? 27 : 13;
  await pageClient.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    text: key === "Enter" ? "\r" : undefined,
    type: "keyDown",
    unmodifiedText: key === "Enter" ? "\r" : undefined,
    windowsVirtualKeyCode
  });
  await pageClient.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    type: "keyUp",
    windowsVirtualKeyCode
  });
}

async function injectNextWriteFailure(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      window.__patchmarkFixtureWriteControls.failNextSequence =
        window.__patchmarkFixtureWriteStats.nextSequence;
      return window.__patchmarkFixtureWriteStats.nextSequence;
    })()`
  });
}

async function openHealthyChangeAnchor(pageClient, commentId) {
  await clickCommentButton(pageClient, commentId, "Change anchor");
  await waitForSelector(pageClient, ".reanchor-mode-panel");
}

async function selectMarkdownText(pageClient, selectedText) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea missing");
      const start = textarea.value.indexOf(${JSON.stringify(selectedText)});
      if (start < 0) throw new Error("Selection text missing");
      textarea.focus();
      textarea.setSelectionRange(start, start + ${JSON.stringify(selectedText)}.length);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { start, end: start + ${JSON.stringify(selectedText)}.length };
    })()`,
    userGesture: true
  });
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
}

async function selectMarkdownSection(pageClient, startText, nextHeading) {
  const selectedText = await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea missing");
      const start = textarea.value.indexOf(${JSON.stringify(startText)});
      const next = textarea.value.indexOf(${JSON.stringify(nextHeading)}, start + 1);
      if (start < 0 || next < 0) throw new Error("Markdown section boundary missing");
      const end = textarea.value.slice(0, next).trimEnd().length;
      const selectedText = textarea.value.slice(start, end);
      textarea.focus();
      textarea.setSelectionRange(start, end);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selectedText;
    })()`,
    userGesture: true
  });
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
  return selectedText;
}

async function selectVisualLink(pageClient, label) {
  await evaluate(pageClient, {
    expression: `(() => {
      const link = Array.from(document.querySelectorAll(".patchmark-prose a"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!link) throw new Error("Visual link missing");
      const range = document.createRange();
      range.selectNodeContents(link);
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
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
}

async function assertActiveCommentProjection(pageClient, commentId, expectedText) {
  await clickCommentButton(pageClient, commentId, "Find");
  let sourceSelection = null;
  let latestFindState = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latestFindState = await evaluate(pageClient, {
      expression: `(() => {
        const textarea = document.querySelector("textarea.markdown-source-editor");
        return {
          bodyText: document.body.textContent?.slice(0, 1200) ?? "",
          feedback: Array.from(document.querySelectorAll("[role='status'], [role='alert']"))
            .map((element) => element.textContent?.trim())
            .filter(Boolean)
            .slice(-6),
          markdownPressed:
            document.querySelector("[aria-label='Editor mode'] button[aria-pressed='true']")
              ?.textContent?.trim() ?? null,
          selection: textarea
            ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
            : null,
          textarea: Boolean(textarea)
        };
      })()`
    });
    if (latestFindState.textarea) {
      sourceSelection = latestFindState.selection;
      break;
    }
    await delay(50);
  }
  if (sourceSelection === null) {
    throw new Error(
      `Find did not open Markdown Mode.\n${JSON.stringify(
        { latestFindState, runtimeExceptions },
        null,
        2
      )}`
    );
  }
  assert.equal(sourceSelection, expectedText);
  const rail = await evaluate(pageClient, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(`[data-comment-id="${commentId}"]`)});
      const card = document.querySelector(${JSON.stringify(`#patchmark-comment-card-${commentId}`)});
      return {
        absolute: item ? getComputedStyle(item).position === "absolute" : false,
        cardText: card?.textContent ?? "",
        floating: item?.classList.contains("comment-floating-item") ?? false,
        inlineTop: item instanceof HTMLElement ? item.style.top : "",
        layout: document.querySelector(".comments-panel")?.getAttribute("data-comment-layout") ?? null,
        status: item?.getAttribute("data-comment-anchor-status") ?? null
      };
    })()`
  });
  assert.equal(rail.layout, "compact");
  assert.equal(rail.floating, false);
  assert.equal(rail.absolute, false);
  assert.equal(rail.inlineTop, "");
  assert.equal(rail.status, "active");
  assert.equal(rail.cardText.includes(expectedText.slice(0, 100)), true);
  await clickButtonByText(pageClient, "Visual Mode");
  await waitForVisualEditor(pageClient);
  await waitForOpenHighlight(pageClient);
  const visualRail = await evaluate(pageClient, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(`[data-comment-id="${commentId}"]`)});
      return {
        floating: item?.classList.contains("comment-floating-item") ?? false,
        layout: document.querySelector(".comments-panel")?.getAttribute("data-comment-layout") ?? null,
        status: item?.getAttribute("data-comment-anchor-status") ?? null
      };
    })()`
  });
  assert.equal(visualRail.layout, "spatial");
  assert.equal(visualRail.floating, true);
  assert.equal(visualRail.status, "active");
}

async function waitForPersistedAnchor(commentsPath, commentId, selectedText) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
    const comment = comments.find((candidate) => candidate.id === commentId);
    if (
      comment?.anchor?.selected_text === selectedText &&
      comment.anchor_history?.some((entry) => entry.cause === "human_reanchor")
    ) {
      return comment;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${commentId} persistence.`);
}

async function waitForVisualEditor(pageClient) {
  let latestState = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    latestState = await evaluate(pageClient, {
      expression: `({
        bodyText: document.body.textContent?.slice(0, 500) ?? "",
        mode: document.querySelector("[aria-label='Editor mode'] button[aria-pressed='true']")?.textContent?.trim() ?? null,
        proseLength: document.querySelector(".patchmark-prose")?.textContent?.length ?? 0
      })`
    });
    if (latestState.proseLength > 100) return;
    if (latestState.mode === "Markdown Mode" && attempt % 20 === 0) {
      await evaluate(pageClient, {
        expression: `(() => {
          const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "Visual Mode" && !candidate.disabled);
          button?.click();
        })()`,
        userGesture: true
      });
    }
    await delay(50);
  }
  throw new Error(`Visual editor did not become ready: ${JSON.stringify(latestState)}`);
}

async function waitForPhase8Comments(pageClient) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await evaluate(pageClient, {
      expression: `({
        comments: ${JSON.stringify(Object.values(commentIds))}
          .filter((commentId) => document.querySelector("#patchmark-comment-card-" + commentId))
          .length,
        projectText: document.body.textContent?.includes("Mode: Patchmark Project") ?? false
      })`
    });

    if (state.comments >= Object.keys(commentIds).length && state.projectText) {
      return;
    }

    await delay(50);
  }

  throw new Error("Timed out waiting for the Phase 8 fixture comments.");
}

async function waitForPreviewHighlight(pageClient) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await highlightRectCount(pageClient, "patchmark-comment-reanchor-preview");
    if (count > 0) return;
    await delay(50);
  }
  throw new Error("Candidate preview highlight did not render.");
}

async function waitForOpenHighlight(pageClient) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await highlightRectCount(pageClient, "patchmark-comment-open-selected-anchor");
    if (count > 0) return;
    await delay(50);
  }
  throw new Error("Confirmed anchor highlight did not render.");
}

async function highlightRectCount(pageClient, name) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const highlight = CSS.highlights?.get(${JSON.stringify(name)});
      if (!highlight) return 0;
      return Array.from(highlight).reduce((total, range) =>
        total + Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).length, 0);
    })()`
  });
}

async function waitForSelector(pageClient, selector) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await evaluate(pageClient, { expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))` })) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForSelectorToDisappear(pageClient, selector) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (!(await evaluate(pageClient, { expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))` }))) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${selector} to disappear`);
}

async function waitForEnabledButton(pageClient, selector, text) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await evaluate(pageClient, {
      expression: `(() => Array.from(document.querySelector(${JSON.stringify(selector)})?.querySelectorAll("button") ?? [])
        .some((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled))()`
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for enabled ${text}`);
}

async function waitForText(pageClient, text) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const found = await evaluate(pageClient, {
      expression: `document.body.textContent?.includes(${JSON.stringify(text)}) ?? false`
    });
    if (found) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function getFixtureWriteCount(pageClient) {
  return await evaluate(pageClient, {
    expression: `window.__patchmarkFixtureWriteLog?.length ?? 0`
  });
}

async function capture(pageClient, fileName) {
  const result = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(join(screenshotDir, fileName), Buffer.from(result.data, "base64"));
}

function screenshotFiles() {
  return [
    "01-missing-anchor-reanchor.png",
    "02-suggested-candidate-list.png",
    "03-candidate-preview.png",
    "04-final-confirmation.png",
    "05-successfully-reanchored.png",
    "06-table-link-reanchor.png",
    "07-multi-block-reanchor.png",
    "08-removed-from-unpositioned.png",
    "09-mobile-workspace.png",
    "10-table-reanchored.png",
    "11-narrow-candidate-list.png",
    "12-concise-recovery-history.png",
    "13-no-candidate-manual-path.png",
    "14-visual-manual-selection.png",
    "15-markdown-manual-selection.png",
    "16-mobile-confirmation.png",
    "17-persistence-failure-retry.png"
  ].map((fileName) => join(screenshotDir, fileName));
}

function fingerprintProject(root) {
  return Object.fromEntries(
    listFiles(root).map((path) => [
      relative(root, path),
      sha256(readFileSync(path))
    ])
  );
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

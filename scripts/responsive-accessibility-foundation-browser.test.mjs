import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
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
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";
import { createPatchReviewFoundationFixture } from "./lib/patch-review-foundation-fixture.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/";
const evidenceDir = process.env.PATCHMARK_PHASE7_EVIDENCE_DIR;
const baselineAudit = process.env.PATCHMARK_PHASE7_BASELINE_AUDIT === "1";
const workspaceBaselineAudit =
  process.env.PATCHMARK_MARKDOWN_WORKSPACE_BASELINE_AUDIT === "1";
const railBaselineAudit =
  process.env.PATCHMARK_COMMENT_RAIL_BASELINE_AUDIT === "1";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-phase7-fixture-"));
const fixture = createPatchReviewFoundationFixture(fixtureRoot);
prepareRegressionFixture(fixture, fixtureRoot);
addVersionHistoryFixture(fixture.store, fixture.markdown);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
const measurements = {};

if (!chromePath) {
  throw new Error("Chrome was not found for Phase 7 browser tests.");
}
if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
}
await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-phase7-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-sandbox",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-features=Translate,MediaRouter",
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

let client;
try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  client = await CdpClient.connect(await createPage(browserWsUrl, "about:blank"));
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Accessibility.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(fixtureRoot)
    })
  });

  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await client.call("Page.navigate", { url: `${editorUrl}?phase7=${Date.now()}` });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('.document-meta strong')?.textContent?.includes('Review Surface')`,
    "Phase 7 fixture"
  );
  const initialWrites = await fixtureWriteCount();

  const viewportMeta = await evaluate(client, {
    expression: `document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''`
  });
  if (!baselineAudit) {
    assert.match(viewportMeta, /width=device-width/);
    assert.match(viewportMeta, /viewport-fit=cover/);
  }

  measurements.desktop = await readLayout();
  assert.equal(measurements.desktop.applicationBarHeight, 56);
  assert.equal(measurements.desktop.documentWidth, 1080);
  assert.equal(measurements.desktop.horizontalOverflow, false);
  await screenshot("01-desktop-workspace-1440x1000.png");

  measurements.commentActivation = await verifyCommentActivationRegression(
    initialWrites
  );
  measurements.markdownLayout = await verifyMarkdownLayoutRegression(initialWrites);
  measurements.commentRail = await verifyModeSpecificCommentRailRegression(
    initialWrites
  );

  if (baselineAudit) {
    assert.equal(measurements.commentActivation.modeAfterPrimary, "Markdown Mode");
    assert.ok(measurements.markdownLayout.desktop.textareaHeight < 250);
    assert.ok(measurements.commentRail.markdown.pageExcessBelowEditor > 1000);
    console.log("Phase 6 baseline reproduces both Phase 7 review regressions.");
  } else if (workspaceBaselineAudit) {
    assert.equal(measurements.commentActivation.modeAfterPrimary, "Visual Mode");
    assert.ok(measurements.markdownLayout.desktop.unusedBottom > 100);
    console.log("Pre-correction Markdown workspace gap reproduced.");
  } else if (railBaselineAudit) {
    assert.equal(measurements.commentActivation.modeAfterPrimary, "Visual Mode");
    assert.equal(measurements.commentRail.markdown.layoutMode, "spatial");
    assert.ok(measurements.commentRail.markdown.pageExcessBelowEditor > 1000);
    console.log("Pre-correction Markdown spatial comment rail reproduced.");
  } else {
    assert.equal(measurements.commentActivation.modeAfterPrimary, "Visual Mode");
    assertMarkdownWorkspace("desktop", measurements.markdownLayout.desktop);

    await setViewport({ height: 900, mobile: false, width: 768 });
  await waitFor(`matchMedia('(max-width: 900px)').matches`, "narrow layout");
  measurements.narrow = await readLayout();
  assert.equal(measurements.narrow.applicationBarHeight, 56);
  assert.equal(measurements.narrow.horizontalOverflow, false);
  await screenshot("02-narrow-workspace-768x900.png");

  await setViewport({ height: 844, mobile: true, width: 393 });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  measurements.mobile = await readLayout();
  assert.equal(measurements.mobile.applicationBarHeight, 56);
  assert.equal(measurements.mobile.horizontalOverflow, false);
  assert.equal(measurements.mobile.hoverFine, false);
  assert.equal(measurements.mobile.smallApplicationTargetCount, 0);
  await screenshot("03-mobile-workspace-393x844.png");

  await setViewport({ height: 844, mobile: true, width: 320 });
  await setSafeArea({ bottom: 34, left: 10, right: 10, top: 12 });
  measurements.compact = await readLayout();
  assert.equal(measurements.compact.applicationBarHeight, 56);
  assert.equal(measurements.compact.documentWidth, 280);
  assert.equal(measurements.compact.horizontalOverflow, false);
  await screenshot("04-compact-reflow-320x844.png");

  await clickSelector(".application-navigation-trigger");
  await waitFor(
    `Boolean(document.querySelector('#document-navigation-drawer[role="dialog"]'))`,
    "navigation dialog"
  );
  measurements.navigation = await readSurface("#document-navigation-drawer");
  assert.equal(measurements.navigation.focus.inside, true);
  assert.equal(measurements.navigation.focus.name, "Close document navigation");
  assert.equal(measurements.navigation.bodyOverflow, "hidden");
  assert.equal(measurements.navigation.applicationBarInert, true);
  assert.equal(measurements.navigation.editorPanelInert, true);
  assert.equal(measurements.navigation.paddingBottom, "58px");
  assert.ok(measurements.navigation.rect.top >= 68);
  assert.equal(measurements.navigation.pageHorizontalOverflow, false);
  const navigationAx = await readAxNames();
  assert.equal(navigationAx.dialogs.includes("Document navigation"), true);
  assert.equal(navigationAx.buttons.includes("File menu"), false);
  assert.equal(
    navigationAx.buttons.filter((name) => name === "Close document navigation").length,
    1
  );
  await screenshot("05-compact-navigation-modal.png");

  await pressKey("Tab", { shift: true });
  assert.equal(await focusInside("#document-navigation-drawer"), true);
  await pressKey("Tab");
  assert.equal(await focusInside("#document-navigation-drawer"), true);
  await pressKey("Escape");
  await waitFor(
    `!document.querySelector('#document-navigation-drawer[role="dialog"]')`,
    "navigation Escape close"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.application-navigation-trigger')`,
    "navigation focus restoration"
  );
  assert.equal(await bodyOverflow(), "visible");

  await clickSelector(".application-navigation-trigger");
  await waitFor(
    `Boolean(document.querySelector('#document-navigation-drawer[role="dialog"]'))`,
    "navigation reopen"
  );
  await clickSelector(".document-navigation-backdrop");
  await waitFor(
    `!document.querySelector('#document-navigation-drawer[role="dialog"]')`,
    "navigation outside close"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.application-navigation-trigger')`,
    "navigation outside focus restoration"
  );

  await clickSelector(".application-comments-trigger");
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === false`,
    "comments sheet"
  );
  await waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Close comments'`,
    "comments sheet focus"
  );
  measurements.comments = await readSurface("#document-comments-panel");
  assert.equal(measurements.comments.focus.name, "Close comments");
  assert.equal(measurements.comments.applicationBarInert, true);
  assert.equal(measurements.comments.editorPanelInert, true);
  assert.ok(measurements.comments.rect.bottom <= 810);
  assert.equal(measurements.comments.pageHorizontalOverflow, false);
  const commentsAx = await readAxNames();
  assert.equal(commentsAx.dialogs.includes("Document comments"), true);
  assert.equal(commentsAx.buttons.includes("File menu"), false);
  assert.equal(
    commentsAx.buttons.filter((name) => name === "Close comments").length,
    1
  );
  await screenshot("06-compact-comments-safe-area.png");

  await setViewport({ height: 900, mobile: false, width: 1440 });
  await waitFor(
    `document.querySelector('#document-comments-panel')?.getAttribute('role') === null`,
    "desktop comments rail after resize"
  );
  assert.equal(await bodyOverflow(), "visible");
  assert.equal(await visibleCount("#document-comments-panel"), 1);
  await setViewport({ height: 844, mobile: true, width: 320 });
  await waitFor(
    `document.querySelector('#document-comments-panel')?.getAttribute('role') === 'dialog'`,
    "mobile comments sheet after resize"
  );
  assert.equal(await bodyOverflow(), "hidden");
  await pressKey("Escape");
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === true`,
    "comments Escape close"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.application-comments-trigger')`,
    "comments focus restoration"
  );
  assert.equal(await bodyOverflow(), "visible");

  await clickButtonByText(client, "File");
  await waitFor(
    `Boolean(document.querySelector('.application-menu-panel:not([hidden])'))`,
    "File menu"
  );
  await waitFor(
    `document.querySelector('.application-menu-panel:not([hidden])')?.contains(document.activeElement)`,
    "File menu focus"
  );
  measurements.fileMenu = await readSurface(".application-menu-panel");
  assert.ok(measurements.fileMenu.rect.left >= 20);
  assert.ok(measurements.fileMenu.rect.right <= 300);
  assert.ok(measurements.fileMenu.rect.bottom <= 810);
  assert.equal(measurements.fileMenu.focus.inside, true);
  assert.equal(measurements.fileMenu.pageHorizontalOverflow, false);
  await screenshot("07-compact-file-menu-safe-area.png");
  await pressKey("Escape");
  await waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'File menu'`,
    "File menu focus restoration"
  );

  await openReviewWorkspace();
  measurements.review = await readSurface("[data-testid='patch-review-workspace']");
  assert.equal(measurements.review.focus.inside, true);
  assert.equal(measurements.review.applicationBarInert, true);
  assert.equal(measurements.review.editorPanelInert, true);
  assert.equal(measurements.review.bodyOverflow, "hidden");
  assert.ok(measurements.review.rect.top >= 12);
  assert.ok(measurements.review.rect.bottom <= 810);
  assert.equal(measurements.review.pageHorizontalOverflow, false);
  assert.equal(await visibleCount("[role='dialog']"), 1);
  const reviewAx = await readAxNames();
  assert.equal(reviewAx.dialogs.includes("Review Patch Group"), true);
  assert.equal(reviewAx.buttons.includes("File menu"), false);
  assert.equal(reviewAx.buttons.includes("Accept Patch"), true);
  await screenshot("08-compact-review-safe-area.png");

  await focusSelector(
    "[data-testid='patch-review-workspace'] button[aria-label='Close Review']"
  );
  await pressKey("Tab", { shift: true });
  assert.equal(await focusInside("[data-testid='patch-review-workspace']"), true);
  await pressKey("Tab");
  assert.equal(await focusInside("[data-testid='patch-review-workspace']"), true);

  const selectedPatchBeforeResize = await text(
    "[aria-label='Review Patch Proposal'] h2"
  );
  await setViewport({ height: 393, mobile: true, width: 844 });
  await waitFor(
    `document.querySelector('[data-testid="patch-review-workspace"]')?.getBoundingClientRect().bottom <= innerHeight - 34 + 1`,
    "landscape Review safe area"
  );
  measurements.reviewLandscape = await readSurface(
    "[data-testid='patch-review-workspace']"
  );
  assert.equal(
    await text("[aria-label='Review Patch Proposal'] h2"),
    selectedPatchBeforeResize
  );
  assert.equal(measurements.reviewLandscape.pageHorizontalOverflow, false);
  await screenshot("09-landscape-review-844x393.png");

  await setViewport({ height: 844, mobile: true, width: 320 });
  await waitFor(
    `document.querySelector('[data-testid="patch-review-workspace"]')?.getBoundingClientRect().width <= 300`,
    "compact Review after resize"
  );
  assert.equal(
    await text("[aria-label='Review Patch Proposal'] h2"),
    selectedPatchBeforeResize
  );
  await pressKey("Escape");
  await waitFor(
    `!document.querySelector('[data-testid="patch-review-workspace"]')`,
    "Review Escape close"
  );
  await waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Review menu'`,
    "Review focus restoration"
  );
  assert.equal(await bodyOverflow(), "visible");
  assert.equal(await anyBackgroundInert(), false);

  await clearSafeArea();
  await setViewport({ height: 900, mobile: false, width: 1440 });
  await waitFor(
    `!matchMedia('(max-width: 900px)').matches`,
    "desktop version history layout"
  );
  await clickSelector(".document-tools > summary");
  await clickSelector(".document-tools-switcher [role='tab']:last-child");
  await waitFor(
    `Boolean(document.querySelector('.version-history-view-all'))`,
    "version history archive trigger"
  );
  await clickSelector(".version-history-view-all");
  await waitFor(
    `Boolean(document.querySelector('.version-history-dialog[role="dialog"]'))`,
    "version history dialog"
  );
  measurements.versionHistory = await readSurface(".version-history-dialog");
  assertWorkspaceSurface(measurements.versionHistory, 16);
  assert.equal(measurements.versionHistory.focus.name, "Close");
  assert.equal(measurements.versionHistory.bodyOverflow, "hidden");
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('.app-shell')?.inert ?? false`
    }),
    true
  );
  const historyAx = await readAxNames();
  assert.equal(historyAx.dialogs.includes("All Versions"), true);
  assert.equal(historyAx.buttons.includes("File menu"), false);
  await pressKey("Tab", { shift: true });
  assert.equal(await focusInside(".version-history-dialog"), true);
  await pressKey("Tab");
  assert.equal(await focusInside(".version-history-dialog"), true);
  await screenshot("10-desktop-version-history-focus.png");
  await pressKey("Escape");
  await waitFor(
    `!document.querySelector('.version-history-dialog')`,
    "version history Escape close"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.version-history-view-all')`,
    "version history focus restoration"
  );
  assert.equal(await bodyOverflow(), "visible");

  await clickSelector(".version-history-view-all");
  await waitFor(
    `Boolean(document.querySelector('.version-history-dialog[role="dialog"]'))`,
    "reopened version history dialog"
  );
  await clickVersionAction("View");
  await waitFor(
    `Boolean(document.querySelector('[aria-label="View snapshot"]'))`,
    "desktop snapshot workspace"
  );
  measurements.snapshotDesktop = await readSurface("[aria-label='View snapshot']");
  assertWorkspaceSurface(measurements.snapshotDesktop, 16);
  await screenshot("10A-desktop-snapshot-workspace.png");
  await clickSelector("[aria-label='View snapshot'] .snapshot-dialog-header button");
  await waitFor(
    `!document.querySelector('[aria-label="View snapshot"]')`,
    "desktop snapshot close"
  );

  await setViewport({ height: 900, mobile: false, width: 768 });
  await clickSelector(".version-history-view-all");
  await waitFor(
    `Boolean(document.querySelector('.version-history-dialog[role="dialog"]'))`,
    "narrow version history workspace"
  );
  measurements.versionHistoryNarrow = await readSurface(".version-history-dialog");
  assertWorkspaceSurface(measurements.versionHistoryNarrow, 8);
  await screenshot("10B-narrow-version-history-workspace.png");
  await clickVersionAction("View");
  await waitFor(
    `Boolean(document.querySelector('[aria-label="View snapshot"]'))`,
    "narrow snapshot workspace"
  );
  measurements.snapshotNarrow = await readSurface("[aria-label='View snapshot']");
  assertWorkspaceSurface(measurements.snapshotNarrow, 8);
  await screenshot("10C-narrow-snapshot-workspace.png");
  await clickSelector("[aria-label='View snapshot'] .snapshot-dialog-header button");
  await waitFor(
    `!document.querySelector('[aria-label="View snapshot"]')`,
    "narrow snapshot close"
  );

  await setViewport({ height: 844, mobile: true, width: 320 });

  await evaluate(client, {
    expression: `(() => {
      const style = document.createElement('style');
      style.id = 'patchmark-phase7-text-spacing';
      style.textContent = '* { line-height: calc(1em + 0.5rem) !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }';
      document.head.append(style);
      return true;
    })()`
  });
  measurements.textSpacing = await readLayout();
  assert.equal(measurements.textSpacing.horizontalOverflow, false);
  await screenshot("11-compact-text-spacing.png");
  await evaluate(client, {
    expression: `document.querySelector('#patchmark-phase7-text-spacing')?.remove()`
  });

  await client.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  const reducedMotion = await evaluate(client, {
    expression: `(() => {
      const style = getComputedStyle(document.querySelector('.application-menu-trigger'));
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionDuration: style.transitionDuration
      };
    })()`
  });
  assert.equal(reducedMotion.matches, true);
  assert.equal(reducedMotion.transitionDuration, "0s");
  measurements.reducedMotion = reducedMotion;
  }

  assert.equal(await fixtureWriteCount(), initialWrites);

  if (evidenceDir) {
    writeFileSync(
      join(evidenceDir, "measurements.json"),
      `${JSON.stringify(measurements, null, 2)}\n`
    );
  }
  console.log(JSON.stringify({ evidenceDir: evidenceDir ?? null, measurements }, null, 2));
  console.log("Responsive accessibility foundation browser tests passed.");
} finally {
  await client?.close().catch(() => {});
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function verifyCommentActivationRegression(initialWrites) {
  const commentId = "PM-COMMENT-0001";
  const cardSelector = `#patchmark-comment-card-${commentId}`;
  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await ensureEditorMode("Visual Mode");
  await waitFor(
    `Boolean(document.querySelector('.patchmark-prose'))`,
    "Visual editor before comment activation"
  );
  await ensureCommentsOpen();
  await waitFor(
    `document.querySelector(${JSON.stringify(cardSelector)})?.classList.contains('comment-card-compact')`,
    "14-reply comment compact card"
  );

  const collapsed = await readCommentRegressionState(commentId);
  await screenshot("R01-collapsed-14-reply-comment-visual.png");
  assert.equal(collapsed.threadDataCount, 14);
  assert.equal(collapsed.replyLabel, "14 replies");
  assert.equal(collapsed.focusState, "Reply received");
  assert.equal(collapsed.pendingPatchCount, 1);
  assert.equal(collapsed.status, "open");
  assert.equal(collapsed.documentTitle, "Phase 5 Evidence / Review Surface");
  assert.equal(collapsed.fixtureWrites, initialWrites);

  await clickSelector(`${cardSelector} .comment-collapsed-preview`);
  await waitFor(
    `document.querySelector(${JSON.stringify(cardSelector)})?.getAttribute('aria-current') === 'true'`,
    "canonical comment thread after primary activation"
  );
  await delay(150);
  const primary = await readCommentRegressionState(commentId);
  await screenshot("R02-expanded-canonical-thread-after-primary-activation.png");
  assert.equal(primary.threadEntryCount, 14);
  assert.equal(primary.threadDataCount, 14);
  assert.equal(primary.commentId, commentId);
  assert.equal(primary.status, "open");
  assert.equal(primary.pendingPatchCount, 1);
  assert.equal(primary.patchRelationshipVisible, true);
  assert.equal(primary.documentTitle, collapsed.documentTitle);
  assert.equal(primary.windowScrollY, collapsed.windowScrollY);
  assert.equal(primary.fixtureWrites, initialWrites);

  if (baselineAudit) {
    assert.equal(primary.mode, "Markdown Mode");
    assert.match(primary.contextStatus, /Showing comment anchor in Markdown Mode/);
    await clickSelector(`${cardSelector} .comment-card-close`);
    await waitFor(
      `document.querySelector(${JSON.stringify(cardSelector)})?.classList.contains('comment-card-compact')`,
      "Phase 6 baseline comment collapsed"
    );
    await ensureEditorMode("Visual Mode");
    await ensureCommentsClosed();
    return {
      collapsed,
      modeAfterPrimary: primary.mode,
      primary
    };
  }

  assert.equal(primary.mode, "Visual Mode");
  assert.equal(primary.contextStatus.includes("Showing comment anchor"), false);
  assert.ok(primary.highlightRangeCount > 0);
  assert.equal(primary.commentsOpen, true);
  await closeActiveComment(commentId);

  for (const [label, selector] of [
    ["reply count", `${cardSelector} .comment-compact-heading > span`],
    ["metadata", `${cardSelector} .comment-compact-context`],
    ["status badge", `${cardSelector} .comment-focus-state-reply_received`]
  ]) {
    await clickSelector(selector);
    await waitFor(
      `document.querySelector(${JSON.stringify(cardSelector)})?.getAttribute('aria-current') === 'true'`,
      `comment activation from ${label}`
    );
    const nestedState = await readCommentRegressionState(commentId);
    assert.equal(nestedState.mode, "Visual Mode");
    assert.equal(nestedState.threadEntryCount, 14);
    assert.equal(nestedState.fixtureWrites, initialWrites);
    await closeActiveComment(commentId);
  }

  for (const key of ["Enter", " "]) {
    await focusSelector(cardSelector);
    if (key === "Enter") {
      await screenshot("R01A-keyboard-focus-collapsed-comment.png");
    }
    await pressKey(key);
    await waitFor(
      `document.querySelector(${JSON.stringify(cardSelector)})?.getAttribute('aria-current') === 'true'`,
      `${key === " " ? "Space" : key} comment activation`
    );
    const keyboardState = await readCommentRegressionState(commentId);
    assert.equal(keyboardState.mode, "Visual Mode");
    assert.equal(keyboardState.threadEntryCount, 14);
    await closeActiveComment(commentId);
  }

  await clickSelector(`${cardSelector} .comment-collapsed-preview`);
  await waitFor(
    `document.querySelector(${JSON.stringify(cardSelector)})?.getAttribute('aria-current') === 'true'`,
    "comment before explicit anchor location"
  );
  await focusSelector(`${cardSelector} .comment-action-menu-trigger`);
  await pressKey("Enter");
  await waitFor(
    `document.activeElement?.textContent?.trim() === 'Find in document'`,
    "Find in document keyboard focus"
  );
  await screenshot("R02A-keyboard-focus-find-in-document.png");
  await clickButtonByText(client, "Find in document");
  await waitFor(
    `document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim() === 'Markdown Mode'`,
    "explicit Find in document Markdown Mode"
  );
  const explicitFind = await readCommentRegressionState(commentId);
  assert.equal(explicitFind.commentId, commentId);
  assert.equal(explicitFind.threadEntryCount, 14);
  assert.equal(explicitFind.pendingPatchCount, 1);
  assert.match(explicitFind.contextStatus, /Showing comment anchor in Markdown Mode/);
  assert.equal(explicitFind.fixtureWrites, initialWrites);
  await screenshot("R03-explicit-find-in-document-markdown.png");
  await closeActiveComment(commentId);
  await ensureEditorMode("Visual Mode");
  await ensureCommentsClosed();

  await setViewport({ height: 844, mobile: true, width: 393 });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  await ensureCommentsOpen();
  await touchSelector(`${cardSelector} .comment-collapsed-preview`);
  await waitFor(
    `document.querySelector(${JSON.stringify(cardSelector)})?.getAttribute('aria-current') === 'true'`,
    "touch comment activation"
  );
  const touchState = await readCommentRegressionState(commentId);
  assert.equal(touchState.mode, "Visual Mode");
  assert.equal(touchState.threadEntryCount, 14);
  assert.equal(touchState.fixtureWrites, initialWrites);
  await closeActiveComment(commentId);
  await ensureCommentsClosed();
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await setViewport({ height: 1000, mobile: false, width: 1440 });

  return {
    collapsed,
    explicitFind,
    modeAfterPrimary: primary.mode,
    primary,
    touch: touchState
  };
}

async function verifyMarkdownLayoutRegression(initialWrites) {
  await setViewport({ height: 900, mobile: false, width: 1440 });
  await ensureCommentsClosed();
  await ensureEditorMode("Visual Mode");
  const visualBefore = await readVisualEditorLayout();
  await screenshot("R04-visual-mode-desktop-comparison.png");
  await ensureEditorMode("Markdown Mode");
  const desktop = await readMarkdownEditorLayout();
  await screenshot("R05-desktop-markdown-editor-filled.png");

  const scrollEvidence = await captureMarkdownScrollEvidence();

  if (baselineAudit) {
    await setViewport({ height: 1000, mobile: false, width: 1440 });
    await ensureEditorMode("Visual Mode");
    return { desktop, scrollEvidence, visualBefore };
  }

  const preservedState = await setMarkdownEditorState();
  const inputContinuity = await verifyMarkdownInputContinuity(preservedState);
  const desktopTall = await resizeMarkdownAndVerifyState(
    "tall desktop resize",
    { height: 1100, mobile: false, width: 1440 },
    preservedState
  );
  await screenshot("R08-tall-desktop-markdown-editor.png");
  const desktopShort = await resizeMarkdownAndVerifyState(
    "short desktop resize",
    { height: 700, mobile: false, width: 1440 },
    preservedState
  );
  await screenshot("R09-short-desktop-markdown-editor.png");

  const narrow = await resizeMarkdownAndVerifyState(
    "narrow desktop resize",
    { height: 900, mobile: false, width: 768 },
    preservedState
  );
  await screenshot("R10-narrow-markdown-editor-filled.png");

  const mobile = await resizeMarkdownAndVerifyState(
    "mobile resize",
    { height: 844, mobile: true, width: 393 },
    preservedState
  );
  await screenshot("R11-mobile-markdown-editor-filled.png");

  const landscape = await resizeMarkdownAndVerifyState(
    "landscape mobile resize",
    { height: 393, mobile: true, width: 844 },
    preservedState
  );
  await screenshot("R12-landscape-mobile-markdown-editor.png");

  const compact = await resizeMarkdownAndVerifyState(
    "320 CSS pixel resize",
    { height: 844, mobile: true, width: 320 },
    preservedState
  );
  await screenshot("R13-compact-320-markdown-editor-filled.png");

  const zoomEquivalent = await resizeMarkdownAndVerifyState(
    "200 percent equivalent resize",
    { height: 500, mobile: false, width: 720 },
    preservedState
  );
  await screenshot("R14-200-percent-equivalent-markdown-editor.png");

  if (workspaceBaselineAudit) {
    await setViewport({ height: 900, mobile: false, width: 1440 });
    const beforeComments = await readMarkdownEditorLayout();
    await screenshot("R15-before-comments-markdown.png");
    await ensureCommentsOpen();
    const comments = await readMarkdownEditorLayout();
    await screenshot("R16-comments-open-markdown.png");
    await ensureCommentsClosed();
    await ensureEditorMode("Visual Mode");
    return {
      beforeComments,
      comments,
      compact,
      desktop,
      desktopShort,
      desktopTall,
      landscape,
      mobile,
      narrow,
      inputContinuity,
      scrollEvidence,
      visualBefore,
      zoomEquivalent
    };
  }

  for (const [label, layout] of [
    ["desktop", desktop],
    ["tall desktop", desktopTall],
    ["short desktop", desktopShort],
    ["narrow", narrow],
    ["mobile", mobile],
    ["landscape mobile", landscape],
    ["compact", compact],
    ["200% equivalent", zoomEquivalent]
  ]) {
    assertMarkdownWorkspace(label, layout);
  }
  assert.ok(desktopTall.textareaHeight > desktop.textareaHeight);
  assert.ok(desktop.textareaHeight > desktopShort.textareaHeight);
  assert.ok(desktop.scrollHeight > desktop.clientHeight + 100);
  assert.equal(scrollEvidence.atBeginning.scrollTop, 0);
  assert.ok(scrollEvidence.atEnd.scrollTop > 100);
  assert.ok(
    Math.abs(
      scrollEvidence.atEnd.scrollTop -
        (scrollEvidence.atEnd.scrollHeight - scrollEvidence.atEnd.clientHeight)
    ) <= 2
  );
  assert.equal(desktop.fixtureWrites, initialWrites);

  await setViewport({ height: 900, mobile: false, width: 1440 });
  await assertMarkdownStatePreserved("desktop restore", preservedState, true, false);
  await restoreMarkdownEditorState(preservedState);
  const surfaceLayouts = {};
  surfaceLayouts.beforeComments = await readMarkdownEditorLayout();
  await screenshot("R15-before-comments-markdown.png");
  await ensureCommentsOpen();
  surfaceLayouts.comments = await readMarkdownEditorLayout();
  assertMarkdownWorkspace("comments open", surfaceLayouts.comments);
  await assertMarkdownStatePreserved("comments open", preservedState, false);
  await screenshot("R16-comments-open-markdown.png");
  await ensureCommentsClosed();
  await assertMarkdownStatePreserved("comments closed", preservedState, false);

  await clickSelector(".document-navigation-close");
  await waitFor(
    `document.querySelector('#document-navigation-drawer')?.hidden === true`,
    "desktop navigation collapsed during Markdown layout check"
  );
  surfaceLayouts.navigationClosed = await readMarkdownEditorLayout();
  assertMarkdownWorkspace("navigation closed", surfaceLayouts.navigationClosed);
  await assertMarkdownStatePreserved("navigation closed", preservedState, false);
  await clickSelector(".application-navigation-trigger");
  await waitFor(
    `document.querySelector('#document-navigation-drawer')?.hidden === false`,
    "desktop navigation reopened during Markdown layout check"
  );
  await assertMarkdownStatePreserved("navigation reopened", preservedState, false);

  await openReviewWorkspace();
  surfaceLayouts.review = await readMarkdownEditorLayout();
  assertMarkdownWorkspace("Review open", surfaceLayouts.review);
  await assertMarkdownStatePreserved("Review open", preservedState, false);
  await pressKey("Escape");
  await waitFor(
    `!document.querySelector('[data-testid="patch-review-workspace"]')`,
    "Review closed during Markdown layout check"
  );
  await assertMarkdownStatePreserved("Review closed", preservedState, false);

  await ensureCommentsOpen();
  await clickSelector(
    "#patchmark-comment-card-PM-COMMENT-0001 .comment-collapsed-preview"
  );
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0001')?.getAttribute('aria-current') === 'true'`,
    "active comment before Repair layout check"
  );
  await clickSelector(
    "#patchmark-comment-card-PM-COMMENT-0001 .comment-action-menu-trigger"
  );
  await clickButtonByText(client, "Change anchor");
  await waitFor(
    `Boolean(document.querySelector('.reanchor-workspace'))`,
    "Repair workspace during Markdown layout check"
  );
  surfaceLayouts.repair = await readMarkdownEditorLayout();
  assertMarkdownWorkspace("Repair open", surfaceLayouts.repair);
  await assertMarkdownStatePreserved("Repair open", preservedState, false);
  await clickSelector(".reanchor-mode-header button");
  await waitFor(
    `!document.querySelector('.reanchor-workspace')`,
    "Repair workspace closed during Markdown layout check"
  );
  await closeActiveComment("PM-COMMENT-0001");
  await ensureCommentsClosed();
  await assertMarkdownStatePreserved("Repair closed", preservedState, false);

  const repeatedLayouts = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await ensureEditorMode("Visual Mode");
    await ensureEditorMode("Markdown Mode");
    const layout = await readMarkdownEditorLayout();
    assertMarkdownWorkspace(`mode switch cycle ${cycle + 1}`, layout);
    repeatedLayouts.push(layout);
  }
  assert.equal(
    repeatedLayouts.every(
      (layout) => Math.abs(layout.textareaHeight - repeatedLayouts[0].textareaHeight) <= 1
    ),
    true
  );
  await ensureEditorMode("Visual Mode");
  const visualAfter = await readVisualEditorLayout();
  assert.ok(Math.abs(visualAfter.editorBodyHeight - visualBefore.editorBodyHeight) <= 1);
  assert.equal(visualAfter.editorWidth, visualBefore.editorWidth);
  assert.equal(await fixtureWriteCount(), initialWrites);

  return {
    compact,
    desktop,
    desktopShort,
    desktopTall,
    inputContinuity,
    landscape,
    mobile,
    narrow,
    preservedState: {
      documentTitle: preservedState.documentTitle,
      scrollTop: preservedState.scrollTop,
      selectionEnd: preservedState.selectionEnd,
      selectionStart: preservedState.selectionStart,
      valueHash: createHash("sha256").update(preservedState.value).digest("hex"),
      valueLength: preservedState.value.length
    },
    repeatedLayouts,
    scrollEvidence,
    surfaceLayouts,
    visualAfter,
    visualBefore,
    zoomEquivalent
  };
}

async function verifyModeSpecificCommentRailRegression(initialWrites) {
  const expandedCommentId = "PM-COMMENT-0001";
  const lateCommentId = "PM-COMMENT-RAIL-LATE-08";
  await clearSafeArea();
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await setViewport({ height: 900, mobile: false, width: 1440 });
  await ensureEditorMode("Visual Mode");
  await ensureCommentsOpen();
  const visual = await readCommentRailLayout();
  await screenshot("C01-visual-spatial-comment-rail.png");

  if (baselineAudit) {
    await ensureEditorMode("Markdown Mode");
    const markdown = await readCommentRailLayout();
    await screenshot("C02-phase6-markdown-spatial-comment-rail.png");
    await ensureCommentsClosed();
    await ensureEditorMode("Visual Mode");
    return { markdown, visual };
  }

  await clickSelector(
    `#patchmark-comment-card-${expandedCommentId} .comment-collapsed-preview`
  );
  await waitFor(
    `document.querySelector('#patchmark-comment-card-${expandedCommentId}')?.getAttribute('aria-current') === 'true'`,
    "expanded 14-reply Visual comment"
  );
  const visualExpanded = await readCommentRailLayout();
  await screenshot("C02-visual-expanded-14-reply-thread.png");

  await ensureEditorMode("Markdown Mode");
  const markdownExpanded = await readCommentRailLayout();
  await screenshot("C03-markdown-compact-expanded-14-reply-thread.png");
  await closeActiveComment(expandedCommentId);

  await clickSelector(
    `#patchmark-comment-card-${lateCommentId} .comment-collapsed-preview`
  );
  await waitFor(
    `document.querySelector('#patchmark-comment-card-${lateCommentId}')?.getAttribute('aria-current') === 'true'`,
    "late Markdown comment active"
  );
  const lateRange = await evaluate(client, {
    expression: `(() => {
      const item = document.querySelector('[data-comment-id=${JSON.stringify(
        lateCommentId
      )}]');
      return {
        end: Number(item?.getAttribute('data-comment-anchor-end') ?? -1),
        start: Number(item?.getAttribute('data-comment-anchor-start') ?? -1)
      };
    })()`
  });
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      textarea.scrollTop = 0;
      return true;
    })()`
  });
  await clickSelector(
    `#patchmark-comment-card-${lateCommentId} .comment-action-menu-trigger`
  );
  await clickButtonByText(client, "Find in document");
  await waitFor(
    `document.activeElement === document.querySelector('.markdown-source-editor') && document.querySelector('.markdown-source-editor')?.selectionStart === ${JSON.stringify(
      lateRange.start
    )} && document.querySelector('.markdown-source-editor')?.selectionEnd === ${JSON.stringify(
      lateRange.end
    )}`,
    "late Markdown Find in document selection"
  );
  const findState = await readCommentRailLayout();
  await screenshot("C04-markdown-explicit-find-late-anchor.png");

  await ensureEditorMode("Visual Mode");
  const visualRestored = await readCommentRailLayout();
  await screenshot("C05-visual-spatial-rail-restored.png");

  const repeated = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await ensureEditorMode("Markdown Mode");
    repeated.push(await readCommentRailLayout());
    await ensureEditorMode("Visual Mode");
  }
  await ensureEditorMode("Markdown Mode");

  const responsive = {};
  for (const [label, viewport] of [
    ["narrow", { height: 900, mobile: false, width: 768 }],
    ["mobile", { height: 844, mobile: true, width: 393 }],
    ["compact", { height: 844, mobile: true, width: 320 }],
    ["landscape", { height: 393, mobile: true, width: 844 }],
    ["zoomEquivalent", { height: 500, mobile: false, width: 720 }]
  ]) {
    await setViewport(viewport);
    responsive[label] = await readCommentRailLayout();
    await screenshot(`C06-${label}-markdown-compact-comments.png`);
  }

  await setViewport({ height: 900, mobile: false, width: 1440 });
  const markdown = await readCommentRailLayout();
  const finalCommentReachability = await scrollCommentRailToEnd();

  if (!railBaselineAudit && !workspaceBaselineAudit) {
    assert.equal(visual.layoutMode, "spatial");
    assert.ok(visual.floatingItemCount > 0);
    assert.ok(visual.inlineTopCount > 0);
    assert.ok(visual.maxGap > 100);
    assert.equal(visual.horizontalOverflow, false);
    assert.equal(visualExpanded.activeCommentId, expandedCommentId);
    assert.equal(visualExpanded.activeThreadEntryCount, 14);

    for (const [label, layout] of [
      ["desktop expanded", markdownExpanded],
      ["desktop", markdown],
      ...Object.entries(responsive)
    ]) {
      assertCompactMarkdownCommentRail(label, layout);
    }
    assert.equal(markdownExpanded.activeCommentId, expandedCommentId);
    assert.equal(markdownExpanded.activeThreadEntryCount, 14);
    assert.equal(findState.activeCommentId, lateCommentId);
    assert.equal(findState.markdownSelectionStart, lateRange.start);
    assert.equal(findState.markdownSelectionEnd, lateRange.end);
    assert.ok(findState.markdownScrollTop > 0);
    assert.equal(findState.windowScrollY, 0);
    assert.equal(findState.fixtureWrites, initialWrites);
    assert.equal(visualRestored.layoutMode, "spatial");
    assert.equal(visualRestored.activeCommentId, lateCommentId);
    assert.equal(
      visualRestored.preferredTops[lateCommentId],
      visual.preferredTops[lateCommentId]
    );
    assert.equal(
      repeated.every(
        (layout) =>
          layout.layoutMode === "compact" &&
          layout.floatingItemCount === 0 &&
          layout.pageExcessBelowEditor <= layout.appShellPaddingBottom + 2
      ),
      true
    );
    assert.equal(finalCommentReachability.reachable, true);
    assert.equal(await fixtureWriteCount(), initialWrites);
  }

  await closeActiveComment(lateCommentId);
  const focusAfterClose = await evaluate(client, {
    expression: `document.activeElement?.id ?? ''`
  });
  await ensureCommentsClosed();
  await ensureEditorMode("Visual Mode");
  await setViewport({ height: 1000, mobile: false, width: 1440 });

  return {
    finalCommentReachability,
    findState,
    focusAfterClose,
    markdown,
    markdownExpanded,
    repeated,
    responsive,
    visual,
    visualExpanded,
    visualRestored
  };
}

function assertCompactMarkdownCommentRail(label, layout) {
  assert.equal(layout.mode, "Markdown Mode", `${label} mode changed.`);
  assert.equal(layout.layoutMode, "compact", `${label} retained spatial layout.`);
  assert.equal(layout.floatingItemCount, 0, `${label} retained floating items.`);
  assert.equal(layout.inlineTopCount, 0, `${label} retained inline top offsets.`);
  assert.equal(layout.absoluteItemCount, 0, `${label} retained absolute items.`);
  assert.equal(layout.renderedCommentCount, layout.uniqueCommentCount);
  assert.equal(layout.renderedCommentCount, layout.semanticListItemCount);
  assert.ok(layout.maxGap <= 12, `${label} comment gap was ${layout.maxGap}px.`);
  assert.ok(
    layout.pageExcessBelowEditor <= layout.appShellPaddingBottom + 2,
    `${label} extended ${layout.pageExcessBelowEditor}px below the editor.`
  );
  assert.equal(layout.horizontalOverflow, false);
  assert.ok(
    layout.railHeight <= layout.usableRailHeight + 2,
    `${label} rail height ${layout.railHeight}px exceeded usable ${layout.usableRailHeight}px at ${layout.viewport.width}x${layout.viewport.height}.`
  );
  assert.ok(layout.railScrollHeight > layout.railClientHeight);
}

async function readCommentRailLayout() {
  await waitFor(
    `document.querySelectorAll('#document-comments-panel .comment-card').length >= 1`,
    "comment rail layout"
  );
  return evaluate(client, {
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const rail = document.querySelector('#document-comments-panel');
      const panel = document.querySelector('.comments-panel');
      const editor = document.querySelector('.editor-panel')?.getBoundingClientRect();
      const textarea = document.querySelector('.markdown-source-editor');
      const textareaRect = textarea?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const shellPaddingBottom = Number.parseFloat(shell ? getComputedStyle(shell).paddingBottom : '0');
      const items = Array.from(rail?.querySelectorAll('[data-comment-id]') ?? []).filter((item) => item.getClientRects().length > 0);
      const cards = items.map((item) => item.querySelector('.comment-card')).filter(Boolean);
      const ids = items.map((item) => item.getAttribute('data-comment-id') ?? '');
      const gaps = items.slice(1).map((item, index) => {
        const previous = items[index].getBoundingClientRect();
        return Math.round(item.getBoundingClientRect().top - previous.bottom);
      });
      const preferredTops = Object.fromEntries(items.map((item) => [
        item.getAttribute('data-comment-id') ?? '',
        Number(item.getAttribute('data-comment-preferred-top') ?? -1)
      ]));
      const activeCard = cards.find((card) => card.getAttribute('aria-current') === 'true');
      return {
        absoluteItemCount: items.filter((item) => getComputedStyle(item).position === 'absolute').length,
        activeCommentId: activeCard?.id?.replace('patchmark-comment-card-', '') ?? null,
        activeThreadEntryCount: activeCard?.querySelectorAll('.comment-thread-entry').length ?? 0,
        appShellPaddingBottom: shellPaddingBottom,
        commentIds: ids,
        fixtureWrites: window.__patchmarkFixtureWriteLog?.length ?? 0,
        floatingItemCount: rail?.querySelectorAll('.comment-floating-item').length ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        inlineStageMinHeight: rail?.querySelector('.comment-floating-stage')?.style.minHeight ?? '',
        inlineTopCount: items.filter((item) => item.style.top !== '').length,
        layoutMode: panel?.getAttribute('data-comment-layout') ?? (rail?.querySelector('.comment-floating-item') ? 'spatial' : 'compact'),
        markdownClientHeight: textarea?.clientHeight ?? 0,
        markdownScrollHeight: textarea?.scrollHeight ?? 0,
        markdownScrollTop: Math.round(textarea?.scrollTop ?? 0),
        markdownSelectionEnd: textarea?.selectionEnd ?? -1,
        markdownSelectionStart: textarea?.selectionStart ?? -1,
        maxGap: Math.max(0, ...gaps),
        mode: document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim() ?? '',
        pageClientHeight: document.documentElement.clientHeight,
        pageExcessBelowEditor: Math.round(document.documentElement.scrollHeight - (textareaRect?.bottom ?? editor?.bottom ?? 0)),
        pageScrollHeight: document.documentElement.scrollHeight,
        preferredTops,
        railBottom: Math.round(railRect?.bottom ?? 0),
        railClientHeight: rail?.clientHeight ?? 0,
        railHeight: Math.round(railRect?.height ?? 0),
        railOverflowY: rail ? getComputedStyle(rail).overflowY : '',
        railScrollHeight: rail?.scrollHeight ?? 0,
        railScrollTop: Math.round(rail?.scrollTop ?? 0),
        railTop: Math.round(railRect?.top ?? 0),
        renderedCommentCount: items.length,
        semanticListItemCount: rail?.querySelectorAll('ol.comment-list > li[data-comment-id]').length ?? 0,
        uniqueCommentCount: new Set(ids).size,
        usableRailHeight: Math.round(
          innerHeight -
            (railRect?.top ?? 0) -
            (matchMedia('(min-width: 901px)').matches ? shellPaddingBottom : 0)
        ),
        viewport: { height: innerHeight, width: innerWidth },
        windowScrollY: Math.round(window.scrollY)
      };
    })()`
  });
}

async function scrollCommentRailToEnd() {
  return evaluate(client, {
    expression: `(() => {
      const rail = document.querySelector('#document-comments-panel');
      const items = Array.from(rail?.querySelectorAll('[data-comment-id]') ?? []).filter((item) => item.getClientRects().length > 0);
      const last = items.at(-1);
      if (!(rail instanceof HTMLElement) || !(last instanceof HTMLElement)) {
        return { reachable: false, scrollTop: 0 };
      }
      rail.scrollTop = rail.scrollHeight;
      const railRect = rail.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        reachable: lastRect.bottom <= railRect.bottom + 1 && lastRect.bottom >= railRect.top,
        scrollTop: Math.round(rail.scrollTop)
      };
    })()`
  });
}

function assertMarkdownWorkspace(label, layout) {
  assert.ok(
    Math.abs(layout.unusedBottom) <= 2,
    `${label} left ${layout.unusedBottom}px beneath the Markdown editor.`
  );
  assert.ok(
    Math.abs(layout.panelBottom - layout.usableBottom) <= 2,
    `${label} panel bottom did not reach the usable workspace bottom.`
  );
  assert.ok(
    Math.abs(layout.textareaBottom - layout.editorBodyBottom) <= 1,
    `${label} Markdown editor did not fill its editor body.`
  );
  assert.ok(layout.textareaHeight > 80, `${label} Markdown editor is not usable.`);
  assert.equal(layout.horizontalOverflow, false);
  assert.equal(layout.overflowY, "auto");
  assert.equal(layout.scrollOwner, "textarea");
}

async function captureMarkdownScrollEvidence() {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      textarea.scrollTop = 0;
      return true;
    })()`
  });
  const atBeginning = await readMarkdownEditorLayout();
  await screenshot("R06-long-markdown-beginning.png");
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      textarea.scrollTop = textarea.scrollHeight;
      return true;
    })()`
  });
  const atEnd = await readMarkdownEditorLayout();
  await screenshot("R07-long-markdown-end.png");
  return { atBeginning, atEnd };
}

async function setMarkdownEditorState() {
  return evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      const selectionStart = Math.min(420, Math.max(0, textarea.value.length - 30));
      const selectionEnd = Math.min(textarea.value.length, selectionStart + 24);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selectionStart, selectionEnd);
      textarea.scrollTop = Math.min(640, Math.max(0, textarea.scrollHeight - textarea.clientHeight));
      return {
        active: document.activeElement === textarea,
        documentTitle: document.querySelector('.document-meta strong')?.textContent?.trim() ?? '',
        scrollTop: Math.round(textarea.scrollTop),
        selectionEnd: textarea.selectionEnd,
        selectionStart: textarea.selectionStart,
        value: textarea.value,
        viewport: {
          clientHeight: document.documentElement.clientHeight,
          clientWidth: document.documentElement.clientWidth,
          height: innerHeight,
          width: innerWidth
        }
      };
    })()`
  });
}

async function readMarkdownEditorState() {
  return evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      return {
        active: document.activeElement === textarea,
        documentTitle: document.querySelector('.document-meta strong')?.textContent?.trim() ?? '',
        scrollTop: Math.round(textarea.scrollTop),
        selectionEnd: textarea.selectionEnd,
        selectionStart: textarea.selectionStart,
        value: textarea.value
      };
    })()`
  });
}

async function verifyMarkdownInputContinuity(expected) {
  const compositionEvents = await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      globalThis.__patchmarkPhase7MarkdownTextarea = textarea;
      const events = [];
      textarea.addEventListener('compositionstart', () => events.push('compositionstart'), { once: true });
      textarea.addEventListener('compositionend', () => events.push('compositionend'), { once: true });
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '文' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '文' }));
      return events;
    })()`
  });
  assert.deepEqual(compositionEvents, ["compositionstart", "compositionend"]);

  await client.call("Input.insertText", {
    text: expected.value.slice(expected.selectionStart, expected.selectionEnd)
  });
  const afterInput = await readMarkdownEditorState();
  const nodePreserved = await evaluate(client, {
    expression: `globalThis.__patchmarkPhase7MarkdownTextarea === document.querySelector('.markdown-source-editor')`
  });
  assert.equal(afterInput.value, expected.value);
  assert.equal(nodePreserved, true);
  assert.equal(await fixtureWriteCount(), 0);
  await restoreMarkdownEditorState(expected);

  return {
    compositionEvents,
    fixtureWrites: await fixtureWriteCount(),
    nodePreserved,
    valueHash: createHash("sha256").update(afterInput.value).digest("hex")
  };
}

async function assertMarkdownStatePreserved(
  label,
  expected,
  requireFocus = true,
  requireExactScroll = true
) {
  const actual = await readMarkdownEditorState();
  assert.equal(actual.value, expected.value, `${label} changed Markdown contents.`);
  assert.equal(actual.documentTitle, expected.documentTitle, `${label} changed document identity.`);
  assert.equal(actual.selectionStart, expected.selectionStart, `${label} changed selection start.`);
  assert.equal(actual.selectionEnd, expected.selectionEnd, `${label} changed selection end.`);
  if (requireExactScroll) {
    assert.ok(
      Math.abs(actual.scrollTop - expected.scrollTop) <= 2,
      `${label} changed Markdown scroll position from ${expected.scrollTop} to ${actual.scrollTop}.`
    );
  } else {
    assert.ok(actual.scrollTop > 0, `${label} lost the active Markdown position.`);
  }
  if (requireFocus) {
    assert.equal(actual.active, true, `${label} moved focus away from Markdown.`);
  }
  assert.equal(await fixtureWriteCount(), 0);
  return actual;
}

async function resizeMarkdownAndVerifyState(label, viewport, expected) {
  await setViewport(viewport);
  const layout = await readMarkdownEditorLayout();
  await assertMarkdownStatePreserved(
    label,
    expected,
    true,
    viewport.width === expected.viewport.width
  );
  return layout;
}

async function restoreMarkdownEditorState(expected) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector('.markdown-source-editor');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing Markdown editor');
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(${JSON.stringify(expected.selectionStart)}, ${JSON.stringify(expected.selectionEnd)});
      textarea.scrollTop = ${JSON.stringify(expected.scrollTop)};
      return true;
    })()`
  });
  await assertMarkdownStatePreserved("restored desktop editor state", expected);
}

async function readCommentRegressionState(commentId) {
  return evaluate(client, {
    expression: `(() => {
      const card = document.getElementById(${JSON.stringify(
        "patchmark-comment-card-"
      )} + ${JSON.stringify(commentId)});
      const item = card?.closest('[data-comment-id]');
      const activeMode = document.querySelector('.mode-switcher button[aria-pressed="true"]');
      const compactContext = card?.querySelector('.comment-compact-context')?.textContent?.trim() ?? '';
      const patchBadge = card?.querySelector('.comment-compact-patch-badge')?.textContent?.trim() ?? '';
      const replyLabel = card?.querySelector('.comment-compact-heading > span')?.textContent?.trim() ?? '';
      const threadEntryCount = card?.querySelectorAll('.comment-thread-entry').length ?? 0;
      const activePatchText = card?.querySelector('.comment-pending-patches')?.textContent?.trim() ?? '';
      const activeStatus = card?.querySelector('.comment-card-meta span:last-child')?.textContent?.trim() ?? '';
      let highlightRangeCount = 0;
      for (const name of ['patchmark-comment-open-selected-anchor', 'patchmark-comment-resolved-selected-anchor']) {
        const highlight = globalThis.CSS?.highlights?.get(name);
        if (highlight) highlightRangeCount += Array.from(highlight).length;
      }
      return {
        commentId: item?.getAttribute('data-comment-id') ?? card?.id?.replace('patchmark-comment-card-', '') ?? null,
        commentsOpen: document.querySelector('#document-comments-panel')?.hidden === false,
        contextStatus: document.querySelector('.document-context-status')?.textContent?.trim() ?? '',
        documentTitle: document.querySelector('.document-meta strong')?.textContent?.trim() ?? '',
        fixtureWrites: window.__patchmarkFixtureWriteLog?.length ?? 0,
        focusState: card?.querySelector('.comment-focus-state')?.textContent?.trim() ?? '',
        highlightRangeCount,
        mode: activeMode?.textContent?.trim() ?? '',
        patchRelationshipVisible: Boolean(card?.querySelector('.comment-pending-patches')),
        pendingPatchCount: Number(item?.getAttribute('data-comment-pending-patch-count') ?? patchBadge.match(/(\\d+) pending/)?.[1] ?? activePatchText.match(/(\\d+) pending/)?.[1] ?? 0),
        replyLabel,
        status: item?.getAttribute('data-comment-status') ?? (activeStatus ? activeStatus.toLowerCase() : compactContext.includes('open') ? 'open' : ''),
        threadDataCount: Number(item?.getAttribute('data-comment-thread-count') ?? replyLabel.match(/(\\d+) repl/)?.[1] ?? threadEntryCount),
        threadEntryCount,
        windowScrollY: Math.round(window.scrollY)
      };
    })()`
  });
}

async function readMarkdownEditorLayout() {
  await waitFor(
    `Boolean(document.querySelector('.markdown-source-editor'))`,
    "Markdown editor layout"
  );
  return evaluate(client, {
    expression: `(() => {
      const shellElement = document.querySelector('.app-shell');
      const workspaceElement = document.querySelector('.document-workspace');
      const editorElement = document.querySelector('.editor-panel');
      const bodyElement = document.querySelector('.editor-body');
      const shell = shellElement?.getBoundingClientRect();
      const workspace = workspaceElement?.getBoundingClientRect();
      const editor = editorElement?.getBoundingClientRect();
      const body = bodyElement?.getBoundingClientRect();
      const textarea = document.querySelector('.markdown-source-editor');
      const rect = textarea?.getBoundingClientRect();
      const shellStyle = shellElement ? getComputedStyle(shellElement) : null;
      const editorStyle = editorElement ? getComputedStyle(editorElement) : null;
      const bodyStyle = bodyElement ? getComputedStyle(bodyElement) : null;
      const shellPaddingBottom = Number.parseFloat(shellStyle?.paddingBottom ?? '0');
      const usableBottom = innerHeight - shellPaddingBottom;
      return {
        appShellBottom: Math.round(shell?.bottom ?? 0),
        appShellPaddingBottom: shellPaddingBottom,
        clientHeight: textarea?.clientHeight ?? 0,
        editorBodyBottom: Math.round(body?.bottom ?? 0),
        editorBodyHeight: Math.round(body?.height ?? 0),
        editorBodyOverflowY: bodyStyle?.overflowY ?? '',
        editorBodyTop: Math.round(body?.top ?? 0),
        editorPanelOverflowY: editorStyle?.overflowY ?? '',
        editorWidth: Math.round(editor?.width ?? 0),
        fixtureWrites: window.__patchmarkFixtureWriteLog?.length ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowY: textarea ? getComputedStyle(textarea).overflowY : '',
        pageClientHeight: document.documentElement.clientHeight,
        pageOverflowY: getComputedStyle(document.documentElement).overflowY,
        pageScrollHeight: document.documentElement.scrollHeight,
        panelBottom: Math.round(editor?.bottom ?? 0),
        panelHeight: Math.round(editor?.height ?? 0),
        panelTop: Math.round(editor?.top ?? 0),
        scrollHeight: textarea?.scrollHeight ?? 0,
        scrollOwner: textarea && textarea.scrollHeight > textarea.clientHeight + 1 ? 'textarea' : 'none',
        scrollTop: Math.round(textarea?.scrollTop ?? 0),
        textareaBottom: Math.round(rect?.bottom ?? 0),
        textareaHeight: Math.round(rect?.height ?? 0),
        textareaTop: Math.round(rect?.top ?? 0),
        textareaWidth: Math.round(rect?.width ?? 0),
        unusedBottom: Math.round(usableBottom - (rect?.bottom ?? 0)),
        usableBottom: Math.round(usableBottom),
        workspaceBottom: Math.round(workspace?.bottom ?? 0),
        workspaceTop: Math.round(workspace?.top ?? 0),
        viewport: { height: innerHeight, width: innerWidth }
      };
    })()`
  });
}

async function readVisualEditorLayout() {
  await waitFor(
    `Boolean(document.querySelector('.patchmark-prose'))`,
    "Visual editor layout"
  );
  return evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector('.editor-panel')?.getBoundingClientRect();
      const body = document.querySelector('.editor-body')?.getBoundingClientRect();
      return {
        editorBodyBottom: Math.round(body?.bottom ?? 0),
        editorBodyHeight: Math.round(body?.height ?? 0),
        editorBodyTop: Math.round(body?.top ?? 0),
        editorWidth: Math.round(editor?.width ?? 0),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        pageClientHeight: document.documentElement.clientHeight,
        pageScrollHeight: document.documentElement.scrollHeight,
        panelBottom: Math.round(editor?.bottom ?? 0),
        panelHeight: Math.round(editor?.height ?? 0),
        panelTop: Math.round(editor?.top ?? 0)
      };
    })()`
  });
}

async function ensureEditorMode(label) {
  const activeMode = await evaluate(client, {
    expression: `document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim() ?? ''`
  });
  if (activeMode !== label) {
    await clickButtonByText(client, label);
  }
  await waitFor(
    `document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim() === ${JSON.stringify(
      label
    )}`,
    label
  );
}

async function ensureCommentsOpen() {
  if (
    await evaluate(client, {
      expression: `document.querySelector('#document-comments-panel')?.hidden !== false`
    })
  ) {
    await clickSelector(".application-comments-trigger");
  }
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === false`,
    "comments open"
  );
}

async function ensureCommentsClosed() {
  if (
    await evaluate(client, {
      expression: `document.querySelector('#document-comments-panel')?.hidden === false`
    })
  ) {
    await clickSelector(".comments-panel-close");
  }
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === true`,
    "comments closed"
  );
}

async function closeActiveComment(commentId) {
  await clickSelector(
    `#patchmark-comment-card-${commentId} .comment-card-close`
  );
  await waitFor(
    `document.querySelector('#patchmark-comment-card-${commentId}')?.classList.contains('comment-card-compact')`,
    `comment ${commentId} collapsed`
  );
  await waitFor(
    `document.activeElement?.id === ${JSON.stringify(
      `patchmark-comment-card-${commentId}`
    )}`,
    `comment ${commentId} focus restoration`
  );
}

async function touchSelector(selector) {
  const point = await evaluate(client, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Missing touch target');
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
  await client.call("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, radiusX: 1, radiusY: 1, ...point }],
    type: "touchStart"
  });
  await client.call("Input.dispatchTouchEvent", {
    touchPoints: [],
    type: "touchEnd"
  });
}

async function openReviewWorkspace() {
  await clickButtonByText(client, "Review");
  await waitFor(
    `Boolean(document.querySelector('[role="menu"]:not([hidden])'))`,
    "Review menu"
  );
  await clickButtonByText(client, "Review patch proposals");
  await waitFor(
    `Boolean(document.querySelector('[data-testid="patch-review-workspace"]'))`,
    "Review workspace"
  );
}

async function clickVersionAction(label) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('.version-history-dialog button'))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!(button instanceof HTMLButtonElement)) throw new Error('Version action missing: ${label}');
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

function assertWorkspaceSurface(surface, inset) {
  assert.deepEqual(
    [
      Math.round(surface.rect.left),
      Math.round(surface.viewport.clientWidth - surface.rect.right),
      Math.round(surface.rect.top),
      Math.round(surface.viewport.clientHeight - surface.rect.bottom)
    ],
    [inset, inset, inset, inset]
  );
  assert.equal(surface.pageHorizontalOverflow, false);
  assert.equal(surface.maxWidth, "none");
  assert.equal(surface.maxHeight, "none");
}

async function readLayout() {
  return evaluate(client, {
    expression: `(() => {
      const bar = document.querySelector('.application-bar')?.getBoundingClientRect();
      const editor = document.querySelector('.editor-panel')?.getBoundingClientRect();
      const applicationTargets = Array.from(document.querySelectorAll('.application-bar button'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getBoundingClientRect());
      return {
        applicationBarHeight: Math.round(bar?.height ?? 0),
        documentWidth: Math.round(editor?.width ?? 0),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        hoverFine: matchMedia('(hover: hover) and (pointer: fine)').matches,
        smallApplicationTargetCount: applicationTargets.filter((rect) => rect.width < 40 || rect.height < 40).length,
        viewport: {
          clientHeight: document.documentElement.clientHeight,
          clientWidth: document.documentElement.clientWidth,
          height: innerHeight,
          width: innerWidth
        }
      };
    })()`
  });
}

async function readSurface(selector) {
  return evaluate(client, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return {
        applicationBarInert: document.querySelector('.application-bar')?.inert ?? false,
        bodyOverflow: getComputedStyle(document.body).overflow,
        editorPanelInert: document.querySelector('.editor-panel')?.inert ?? false,
        focus: {
          inside: Boolean(element?.contains(document.activeElement)),
          name: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 100) || document.activeElement?.tagName
        },
        pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        maxHeight: style?.maxHeight ?? null,
        maxWidth: style?.maxWidth ?? null,
        paddingBottom: style?.paddingBottom ?? null,
        rect: rect ? {
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          width: Math.round(rect.width)
        } : null,
        viewport: {
          clientHeight: document.documentElement.clientHeight,
          clientWidth: document.documentElement.clientWidth,
          height: innerHeight,
          width: innerWidth
        }
      };
    })()`
  });
}

async function readAxNames() {
  const result = await client.call("Accessibility.getFullAXTree");
  const nodes = result.nodes.filter((node) => !node.ignored);
  return {
    buttons: nodes
      .filter((node) => node.role?.value === "button")
      .map((node) => node.name?.value ?? ""),
    dialogs: nodes
      .filter((node) => node.role?.value === "dialog")
      .map((node) => node.name?.value ?? "")
  };
}

async function setSafeArea({ bottom, left, right, top }) {
  await evaluate(client, {
    expression: `(() => {
      const root = document.documentElement.style;
      root.setProperty('--safe-area-top', '${top}px');
      root.setProperty('--safe-area-right', '${right}px');
      root.setProperty('--safe-area-bottom', '${bottom}px');
      root.setProperty('--safe-area-left', '${left}px');
      window.dispatchEvent(new Event('resize'));
      return true;
    })()`
  });
}

async function clearSafeArea() {
  await evaluate(client, {
    expression: `(() => {
      const root = document.documentElement.style;
      root.removeProperty('--safe-area-top');
      root.removeProperty('--safe-area-right');
      root.removeProperty('--safe-area-bottom');
      root.removeProperty('--safe-area-left');
      window.dispatchEvent(new Event('resize'));
      return true;
    })()`
  });
}

async function fixtureWriteCount() {
  return evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog?.length ?? 0`
  });
}

async function anyBackgroundInert() {
  return evaluate(client, {
    expression: `Boolean(document.querySelector('.application-bar')?.inert || Array.from(document.querySelector('.document-workspace')?.children ?? []).some((element) => element.inert))`
  });
}

async function bodyOverflow() {
  return evaluate(client, {
    expression: `getComputedStyle(document.body).overflow`
  });
}

async function focusInside(selector) {
  return evaluate(client, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement) ?? false`
  });
}

async function visibleCount(selector) {
  return evaluate(client, {
    expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((element) => element.getClientRects().length > 0).length`
  });
}

async function focusSelector(selector) {
  await evaluate(client, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Missing focus target');
      element.focus({ preventScroll: true });
      return document.activeElement === element;
    })()`
  });
}

async function clickSelector(selector) {
  await evaluate(client, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Missing click target');
      element.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function text(selector) {
  return evaluate(client, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`
  });
}

async function setViewport(viewport) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    ...viewport
  });
}

async function pressKey(key, { shift = false } = {}) {
  const keyDefinition = {
    " ": { code: "Space", virtualKeyCode: 32 },
    Enter: { code: "Enter", virtualKeyCode: 13 },
    Escape: { code: "Escape", virtualKeyCode: 27 },
    Tab: { code: "Tab", virtualKeyCode: 9 }
  }[key] ?? { code: key, virtualKeyCode: 0 };
  await client.call("Input.dispatchKeyEvent", {
    code: keyDefinition.code,
    key,
    modifiers: shift ? 8 : 0,
    nativeVirtualKeyCode: keyDefinition.virtualKeyCode,
    type: "keyDown",
    windowsVirtualKeyCode: keyDefinition.virtualKeyCode
  });
  await client.call("Input.dispatchKeyEvent", {
    code: keyDefinition.code,
    key,
    modifiers: shift ? 8 : 0,
    nativeVirtualKeyCode: keyDefinition.virtualKeyCode,
    type: "keyUp",
    windowsVirtualKeyCode: keyDefinition.virtualKeyCode
  });
}

async function waitFor(expression, label) {
  let value;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    value = await evaluate(client, { expression });
    if (value) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function screenshot(name) {
  if (!evidenceDir) {
    return;
  }
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(evidenceDir, name), Buffer.from(result.data, "base64"));
}

function addVersionHistoryFixture(store, markdown) {
  const versions = Array.from({ length: 4 }, (_, index) => ({
    created_at: `2026-08-0${index + 1}T00:00:00.000Z`,
    file: `versions/phase7-version-${index + 1}.md`,
    id: `PM-VERSION-PHASE7-${index + 1}`,
    reason: `Phase 7 safe fixture version ${index + 1}`
  }));

  for (const [index, version] of versions.entries()) {
    writeFileSync(
      join(store, version.file),
      `${markdown}\n\nVersion ${index + 1} fixture.\n`
    );
  }

  const manifestPath = join(store, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.versions = versions;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText);

  const saveCommitPath = join(store, "save-commit.json");
  const saveCommit = JSON.parse(readFileSync(saveCommitPath, "utf8"));
  saveCommit.files.manifest = {
    ...saveCommit.files.manifest,
    bytes: Buffer.byteLength(manifestText),
    sha256: createHash("sha256").update(manifestText).digest("hex")
  };
  writeFileSync(saveCommitPath, `${JSON.stringify(saveCommit, null, 2)}\n`);
}

function prepareRegressionFixture(fixture, root) {
  const importedAt = "2026-08-10T01:00:00.000Z";
  const longTail = Array.from(
    { length: 120 },
    (_, index) =>
      `Long-form review evidence paragraph ${index + 1} preserves a usable Markdown scrolling viewport.`
  );
  fixture.markdown = [
    fixture.markdown,
    "",
    "## Extended regression evidence",
    "",
    ...longTail.flatMap((paragraph) => [paragraph, ""])
  ].join("\n");
  for (const [index, paragraphIndex] of [9, 24, 39, 54, 69, 84, 99, 119].entries()) {
    const selectedText = longTail[paragraphIndex];
    const start = fixture.markdown.indexOf(selectedText);
    fixture.comments.push({
      id: `PM-COMMENT-RAIL-LATE-${String(index + 1).padStart(2, "0")}`,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: selectedText,
        markdown_start_offset: start,
        markdown_end_offset: start + selectedText.length,
        anchor_source: "markdown"
      },
      comment: `Late-document rail comment ${index + 1} keeps long metadata and discussion text wrapped inside the established comment width.`,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: `2026-08-10T01:${String(index).padStart(2, "0")}:00.000Z`,
      updated_at: importedAt
    });
  }
  fixture.comments.push({
    id: "PM-COMMENT-RAIL-UNAVAILABLE",
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: "Removed late-document sentence requiring human repair.",
      containing_heading: "Extended regression evidence",
      containing_heading_level: 2
    },
    comment: "Unavailable late-document anchor remains visible without creating spatial height.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-08-10T01:59:00.000Z",
    updated_at: importedAt
  });
  fixture.comments[0].thread = Array.from({ length: 14 }, (_, index) => ({
    id: `PM-THREAD-REGRESSION-${String(index + 1).padStart(2, "0")}`,
    role: index % 2 === 0 ? "user" : "chatgpt",
    content:
      index % 2 === 0
        ? `Canonical user reply ${index + 1} preserves discussion identity.`
        : `Canonical ChatGPT reply ${index + 1} preserves patch lineage.`,
    created_at: `2026-08-10T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
    ...(index % 2 === 1 ? { source_import_id: "PM-IMPORT-0001" } : {})
  }));
  fixture.comments[0].export_state = {
    focus_state: "reply_received",
    last_import_id: "PM-IMPORT-0001",
    last_imported_at: importedAt
  };
  fixture.comments[0].updated_at = importedAt;

  const documentText = fixture.markdown;
  const commentsText = `${JSON.stringify(fixture.comments, null, 2)}\n`;
  writeFileSync(join(root, "review.md"), documentText);
  writeFileSync(join(fixture.store, "comments.json"), commentsText);

  const saveCommitPath = join(fixture.store, "save-commit.json");
  const saveCommit = JSON.parse(readFileSync(saveCommitPath, "utf8"));
  saveCommit.files.document = {
    ...saveCommit.files.document,
    bytes: Buffer.byteLength(documentText),
    sha256: createHash("sha256").update(documentText).digest("hex")
  };
  saveCommit.files.comments = {
    ...saveCommit.files.comments,
    bytes: Buffer.byteLength(commentsText),
    sha256: createHash("sha256").update(commentsText).digest("hex")
  };
  writeFileSync(saveCommitPath, `${JSON.stringify(saveCommit, null, 2)}\n`);
}

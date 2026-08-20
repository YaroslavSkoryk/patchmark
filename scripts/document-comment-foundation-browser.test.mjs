import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
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
const evidenceDir = process.env.PATCHMARK_PHASE4_EVIDENCE_DIR;
const measurements = {};
const fixtureRoot = createFixture();
const fixtureFingerprint = fingerprintDirectory(fixtureRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found.");
}

if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-phase4-browser-"));
const chrome = spawn(chromePath, [
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
], { stdio: ["ignore", "ignore", "pipe"] });

let client;
try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  client = await CdpClient.connect(await createPage(browserWsUrl, "about:blank"));
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(fixtureRoot)
    })
  });

  await openFixture({ height: 1000, mobile: false, width: 1440 });
  const collapsed = await readLayout();
  measurements.desktopCollapsed = collapsed;
  assert.equal(collapsed.applicationBarHeight, 48);
  assert.equal(collapsed.commentsHidden, true);
  assert.equal(collapsed.navigationWidth, 272);
  assert.ok(collapsed.documentWidth > 1000);
  assert.ok(collapsed.readingWidth <= 920);
  assert.equal(collapsed.horizontalOverflow, false);
  assert.equal(collapsed.documentToolsOpen, false);
  await screenshot("01-desktop-document-comments-collapsed.png");

  await openExactSelectionComposer(
    "Exact comment anchors remain synchronized across modes."
  );
  await clickSelector('[data-testid="comment-composer"] button[type="submit"]');
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('[data-comment-composer-input]')?.matches(':invalid')`
    }),
    true
  );
  await screenshot("15-desktop-exact-selection-comment-composer.png");
  await pressKey("Escape");
  await waitFor(
    `!document.querySelector('[data-testid="comment-composer"]')`,
    "desktop selection composer dismissed"
  );
  if (!(await evaluate(client, { expression: `document.querySelector('#document-comments-panel')?.hidden` }))) {
    await clickSelector(".comments-panel-close");
  }
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === true`,
    "comments collapsed after selection composer"
  );

  await clickSelector(".application-comments-trigger");
  await waitFor(
    `!document.querySelector('#document-comments-panel')?.hidden`,
    "desktop comments open"
  );
  const compact = await readLayout();
  measurements.desktopCompact = compact;
  assert.equal(compact.commentsWidth, 336);
  assert.equal(compact.compactCardCount, 5);
  assert.equal(compact.activeCardCount, 0);
  assert.equal(compact.compactActionCount, 0);
  assert.equal(compact.commentLayout, "spatial");
  assert.equal(compact.floatingItemCount, 5);
  assert.equal(compact.absoluteCommentItemCount, 5);
  assert.equal(compact.inlineCommentTopCount, 5);
  assert.ok(compact.maxCompactCardHeight < 120);
  await screenshot("02-desktop-compact-comment-rail.png");

  await clickSelector(
    "#patchmark-comment-card-PM-COMMENT-0001 .comment-collapsed-preview"
  );
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0001')?.getAttribute('aria-current') === 'true'`,
    "ordinary comment active"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim()`
    }),
    "Visual Mode"
  );
  const active = await readLayout();
  measurements.desktopActive = active;
  assert.equal(active.activeCardCount, 1);
  assert.equal(active.directActiveActions.includes("Reply"), true);
  assert.equal(active.directActiveActions.includes("Resolve"), true);
  assert.equal(active.directActiveActions.includes("Mark for ChatGPT"), false);
  assert.ok(active.activeAnchorEnd > active.activeAnchorStart);
  await screenshot("03-desktop-active-ordinary-comment.png");

  await clickSelector(
    "#patchmark-comment-card-PM-COMMENT-0001 .comment-action-menu-trigger"
  );
  await waitFor(
    `!document.querySelector('.comment-action-menu-panel')?.hidden`,
    "ordinary comment action menu"
  );
  const menu = await evaluate(client, {
    expression: `(() => ({
      labels: Array.from(document.querySelectorAll('.comment-action-menu-panel [role="menuitem"]')).filter((item) => item.getClientRects().length > 0).map((item) => item.textContent.trim()),
      destructive: document.querySelector('.comment-action-menu-item-destructive')?.textContent.trim(),
      activeRole: document.activeElement?.getAttribute('role')
    }))()`
  });
  assert.deepEqual(menu.labels, [
    "Find in document",
    "Mark for ChatGPT",
    "Change anchor",
    "Edit comment",
    "Move to Trash"
  ]);
  assert.equal(menu.destructive, "Move to Trash");
  await screenshot("04-desktop-ordinary-comment-action-menu.png");
  await pressKey("Escape");

  await clickSelector("#patchmark-comment-card-PM-COMMENT-0003");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0003')?.getAttribute('aria-current') === 'true'`,
    "pending patch discussion active"
  );
  assert.match(
    await elementText("#patchmark-comment-card-PM-COMMENT-0003"),
    /Patch proposal: pending[\s\S]*Review related patches/
  );
  assert.equal(
    await countVisible("#patchmark-comment-card-PM-COMMENT-0003 .comment-thread-preview"),
    1
  );
  await screenshot("05-desktop-pending-patch-discussion.png");

  await clickSelector("#patchmark-comment-card-PM-COMMENT-0004");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0004')?.getAttribute('aria-current') === 'true'`,
    "applied patch discussion active"
  );
  assert.match(
    await elementText("#patchmark-comment-card-PM-COMMENT-0004"),
    /Applied patch discussion remains in this canonical thread/
  );
  assert.equal(
    await countVisible("#patchmark-comment-card-PM-COMMENT-0004 .comment-thread-preview"),
    1
  );
  await screenshot("06-desktop-applied-patch-discussion.png");

  await clickSelector("#patchmark-comment-card-PM-COMMENT-0005");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0005')?.getAttribute('aria-current') === 'true'`,
    "unavailable comment active"
  );
  assert.equal(
    await countVisible("#patchmark-comment-card-PM-COMMENT-0005 .comment-anchor-status-not_found"),
    1
  );
  assert.equal(
    await countVisible("#patchmark-comment-card-PM-COMMENT-0005 button", "Re-anchor"),
    1
  );
  await screenshot("07-desktop-unavailable-anchor.png");

  await clickSelector(".comments-panel-close");
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === true`,
    "desktop comments collapsed"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.application-comments-trigger')`,
    "desktop comments focus restoration"
  );
  await clickSelector(".document-tools > summary");
  await waitFor(`document.querySelector('.document-tools')?.open === true`, "document tools open");
  assert.equal(await countVisible("[aria-label='Document Outline']"), 1);
  await screenshot("08-desktop-document-tools-outline.png");
  await clickSelector(".document-tools-switcher [role='tab']:last-child");
  assert.equal(await countVisible("[aria-label='Version History']"), 1);
  await screenshot("09-desktop-document-tools-history.png");

  await clickSelector(".application-comments-trigger");
  await clickSelector("#patchmark-comment-card-PM-COMMENT-0002");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0002')?.getAttribute('aria-current') === 'true'`,
    "compact comment discussion"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim()`
    }),
    "Visual Mode"
  );
  await clickSelector(
    "#patchmark-comment-card-PM-COMMENT-0002 .comment-action-menu-trigger"
  );
  await clickButtonByText(client, "Find in document");
  await waitFor(
    `document.querySelector('.document-context-status')?.textContent?.includes('Showing comment anchor in Markdown Mode')`,
    "explicit Find in document status"
  );
  assert.equal(
    await countVisible(".document-save-banner:not(.document-context-status)"),
    0
  );
  const shortMarkdownLayout = await evaluate(client, {
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const workspace = document.querySelector('.document-workspace')?.getBoundingClientRect();
      const textarea = document.querySelector('.markdown-source-editor');
      const rect = textarea?.getBoundingClientRect();
      const paddingBottom = Number.parseFloat(shell ? getComputedStyle(shell).paddingBottom : '0');
      const usableBottom = innerHeight - paddingBottom;
      return {
        clientHeight: textarea?.clientHeight ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollHeight: textarea?.scrollHeight ?? 0,
        textareaBottom: Math.round(rect?.bottom ?? 0),
        textareaHeight: Math.round(rect?.height ?? 0),
        unusedBottom: Math.round(usableBottom - (rect?.bottom ?? 0)),
        usableBottom: Math.round(usableBottom),
        workspaceTop: Math.round(workspace?.top ?? 0)
      };
    })()`
  });
  measurements.shortMarkdownLayout = shortMarkdownLayout;
  assert.ok(Math.abs(shortMarkdownLayout.unusedBottom) <= 2);
  assert.ok(shortMarkdownLayout.textareaHeight > 400);
  assert.ok(shortMarkdownLayout.scrollHeight <= shortMarkdownLayout.clientHeight + 2);
  assert.equal(shortMarkdownLayout.horizontalOverflow, false);
  const markdownComments = await readLayout();
  measurements.desktopMarkdownComments = markdownComments;
  assert.equal(markdownComments.mode, "Markdown Mode");
  assert.equal(markdownComments.commentLayout, "compact");
  assert.equal(markdownComments.floatingItemCount, 0);
  assert.equal(markdownComments.absoluteCommentItemCount, 0);
  assert.equal(markdownComments.inlineCommentTopCount, 0);
  assert.equal(markdownComments.semanticCommentItemCount, 5);
  assert.equal(markdownComments.uniqueCommentItemCount, 5);
  assert.ok(markdownComments.maxCommentItemGap <= 12);
  assert.equal(markdownComments.activeCommentId, "PM-COMMENT-0002");
  assert.equal(markdownComments.markdownSelectionStart, markdownComments.activeAnchorStart);
  assert.equal(markdownComments.markdownSelectionEnd, markdownComments.activeAnchorEnd);
  assert.ok(
    markdownComments.pageExcessBelowEditor <= markdownComments.appShellPaddingBottom + 2
  );
  await screenshot("10-desktop-markdown-context-status.png");

  await clickSelector(".comment-card-close");
  await waitFor(
    `document.querySelectorAll('.comment-card[aria-current="true"]').length === 0`,
    "active comment collapsed before mobile resize"
  );
  await waitFor(
    `document.activeElement?.id === 'patchmark-comment-card-PM-COMMENT-0002'`,
    "collapsed comment focus restoration"
  );
  await clickSelector(".comments-panel-close");
  await clickButtonByText(client, "Visual Mode");
  await waitFor(`Boolean(document.querySelector('.patchmark-prose'))`, "mobile visual editor");
  if (await evaluate(client, { expression: `document.querySelector('.document-tools')?.open === true` })) {
    await clickSelector(".document-tools > summary");
  }
  await setViewport({ height: 844, mobile: true, width: 390 });
  await waitFor(`matchMedia('(max-width: 900px)').matches`, "mobile viewport");
  const mobileClosed = await readLayout();
  measurements.mobileClosed = mobileClosed;
  assert.equal(mobileClosed.applicationBarHeight, 88);
  assert.equal(mobileClosed.commentsHidden, true);
  assert.equal(mobileClosed.horizontalOverflow, false);
  await screenshot("11-mobile-document-comments-closed.png");

  await clickSelector(".application-comments-trigger");
  await waitFor(
    `document.querySelector('#document-comments-panel')?.getAttribute('role') === 'dialog'`,
    "mobile comments dialog"
  );
  await waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Close comments'`,
    "mobile comments focus"
  );
  const mobileOpen = await readLayout();
  measurements.mobileOpen = mobileOpen;
  assert.equal(mobileOpen.commentsModal, true);
  assert.ok(mobileOpen.commentsTop >= 180);
  assert.ok(mobileOpen.commentsHeight <= 650);
  assert.equal(mobileOpen.floatingItemCount, 0);
  assert.equal(mobileOpen.bodyOverflow, "hidden");
  assert.equal(mobileOpen.activeElementLabel, "Close comments");
  assert.equal(mobileOpen.horizontalOverflow, false);
  await screenshot("12-mobile-comments-open.png");

  await clickSelector("#patchmark-comment-card-PM-COMMENT-0001");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0001')?.getAttribute('aria-current') === 'true'`,
    "mobile active thread"
  );
  await screenshot("13-mobile-active-comment.png");
  await pressKey("Escape");
  await waitFor(
    `document.querySelector('#document-comments-panel')?.hidden === true`,
    "mobile comments dismissed"
  );
  await waitFor(
    `document.activeElement === document.querySelector('.application-comments-trigger')`,
    "mobile comments focus restoration"
  );
  assert.equal(
    await evaluate(client, { expression: `getComputedStyle(document.body).overflow` }),
    "visible"
  );

  await clickButtonByText(client, "Visual Mode");
  await waitFor(`Boolean(document.querySelector('.patchmark-prose'))`, "mobile composer visual editor");
  await openExactSelectionComposer(
    "Exact comment anchors remain synchronized across modes."
  );
  await screenshot("16-mobile-exact-selection-comment-composer.png");
  await pressKey("Tab");
  await waitFor(
    `document.activeElement?.textContent?.trim() === 'Save Comment'`,
    "mobile composer keyboard focus"
  );
  await screenshot("17-mobile-keyboard-focus-visible.png");
  await evaluate(client, {
    expression: `(() => {
      const form = document.querySelector('[data-testid="comment-composer"]');
      const button = Array.from(form?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent?.trim() === 'Cancel');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Comment composer Cancel button was not found.');
      button.click();
    })()`,
    userGesture: true
  });
  await waitFor(
    `!document.querySelector('[data-testid="comment-composer"]')`,
    "mobile selection composer dismissed"
  );
  if (!(await evaluate(client, { expression: `document.querySelector('#document-comments-panel')?.hidden` }))) {
    await clickSelector(".comments-panel-close");
  }

  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('.project-document-select')).find((candidate) => candidate.querySelector('span')?.textContent?.trim() === 'Notes');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Notes document button was not found.');
      button.focus();
      button.click();
    })()`,
    userGesture: true
  });
  await waitFor(
    `document.querySelector('.application-document-breadcrumb')?.getAttribute('title')?.includes('Notes')`,
    "no-comments document"
  );
  await clickSelector(".application-comments-trigger");
  await waitFor(
    `!document.querySelector('#document-comments-panel')?.hidden`,
    "no-comments rail"
  );
  assert.match(await elementText("#document-comments-panel"), /0 total · 0 open/);
  assert.match(await elementText("#document-comments-panel"), /No comments yet/);
  const mobileNoComments = await readLayout();
  measurements.mobileNoComments = mobileNoComments;
  assert.ok(mobileNoComments.commentsHeight < 420);
  await screenshot("14-mobile-no-comments-state.png");

  if (evidenceDir) {
    writeFileSync(
      join(evidenceDir, "after-measurements.json"),
      `${JSON.stringify(measurements, null, 2)}\n`
    );
  }

  assert.equal(
    fingerprintDirectory(fixtureRoot),
    fixtureFingerprint,
    "Read-only presentation checks must not write the fixture"
  );
  console.log("Document/comment browser foundation tests passed.");
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function openFixture(viewport) {
  await setViewport(viewport);
  const navigationUrl = new URL(editorUrl);
  const navigationNonce = `${Date.now()}-${viewport.width}`;
  navigationUrl.searchParams.set("phase4Evidence", navigationNonce);
  const pageLoaded = new Promise((resolve) => {
    const removeListener = client.on("Page.loadEventFired", () => {
      removeListener();
      resolve();
    });
  });
  await client.call("Page.navigate", { url: navigationUrl.toString() });
  await Promise.race([
    pageLoaded,
    delay(15_000).then(() => {
      throw new Error("Timed out waiting for the Phase 4 fixture page load.");
    })
  ]);
  await waitFor(
    `new URL(location.href).searchParams.get('phase4Evidence') === ${JSON.stringify(navigationNonce)}`,
    "Phase 4 fixture navigation"
  );
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('.application-document-breadcrumb')?.getAttribute('title')?.includes('Phase 4 Evidence / Action Plan')`,
    "Phase 4 fixture"
  );
  await waitFor(`Boolean(document.querySelector('.patchmark-prose'))`, "visual editor");
}

async function setViewport(viewport) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    ...viewport
  });
}

async function openExactSelectionComposer(selectedText) {
  await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector('.patchmark-prose');
      if (!root) throw new Error('Visual editor is missing.');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes(${JSON.stringify(selectedText)})) node = walker.nextNode();
      if (!node) throw new Error('Exact selection text is missing.');
      const start = node.textContent.indexOf(${JSON.stringify(selectedText)});
      node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + ${selectedText.length});
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      document.querySelector('.editor-body')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`,
    userGesture: true
  });
  await waitFor(
    `window.getSelection()?.toString() === ${JSON.stringify(selectedText)} && Boolean(document.querySelector('[data-testid="comment-selection-action"]'))`,
    "exact selection comment action"
  );
  await clickSelector("[data-testid='comment-selection-action']");
  await waitFor(
    `Boolean(document.querySelector('[data-selection-action-option="selected_text"]'))`,
    "selected-text action option"
  );
  await clickSelector("[data-selection-action-option='selected_text']");
  await waitFor(
    `document.querySelector('[data-testid="comment-composer"]')?.textContent?.includes(${JSON.stringify(selectedText)}) && document.activeElement === document.querySelector('[data-comment-composer-input]')`,
    "exact selection comment composer"
  );
}

async function readLayout() {
  return await evaluate(client, {
    expression: `(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const comments = document.querySelector('#document-comments-panel');
      const documentRect = rect('.editor-panel');
      const commentsRect = comments?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('.comment-card'));
      const compactCards = cards.filter((card) => card.classList.contains('comment-card-compact'));
      const activeCard = cards.find((card) => card.getAttribute('aria-current') === 'true');
      const activeItem = activeCard?.closest('[data-comment-id]');
      const commentItems = Array.from(comments?.querySelectorAll('[data-comment-id]') ?? []).filter((item) => item.getClientRects().length > 0);
      const commentIds = commentItems.map((item) => item.getAttribute('data-comment-id') ?? '');
      const commentGaps = commentItems.slice(1).map((item, index) => {
        const previous = commentItems[index].getBoundingClientRect();
        return Math.round(item.getBoundingClientRect().top - previous.bottom);
      });
      const markdownEditor = document.querySelector('.markdown-source-editor');
      const markdownRect = markdownEditor?.getBoundingClientRect();
      const shell = document.querySelector('.app-shell');
      const appShellPaddingBottom = Number.parseFloat(shell ? getComputedStyle(shell).paddingBottom : '0');
      const highlightNames = ['patchmark-comment-open-selected-anchor', 'patchmark-comment-resolved-selected-anchor'];
      let highlightRangeCount = 0;
      for (const name of highlightNames) {
        const highlight = globalThis.CSS?.highlights?.get(name);
        if (highlight) for (const range of highlight) highlightRangeCount += Array.from(range.getClientRects()).filter((item) => item.width > 0 && item.height > 0).length;
      }
      return {
        absoluteCommentItemCount: commentItems.filter((item) => getComputedStyle(item).position === 'absolute').length,
        activeCardCount: cards.filter((card) => card.getAttribute('aria-current') === 'true').length,
        activeCommentId: activeCard?.id?.replace('patchmark-comment-card-', '') ?? null,
        activeAnchorEnd: Number(activeItem?.getAttribute('data-comment-anchor-end') ?? 0),
        activeAnchorStart: Number(activeItem?.getAttribute('data-comment-anchor-start') ?? 0),
        activeCardHeight: Math.round(activeCard?.getBoundingClientRect().height ?? 0),
        activeElementLabel: document.activeElement?.getAttribute('aria-label'),
        appShellPaddingBottom,
        applicationBarHeight: Math.round(rect('.application-bar')?.height ?? 0),
        bodyOverflow: getComputedStyle(document.body).overflow,
        commentLayout: document.querySelector('.comments-panel')?.getAttribute('data-comment-layout') ?? '',
        commentsHeight: Math.round(commentsRect?.height ?? 0),
        commentsHidden: comments?.hidden ?? true,
        commentsModal: comments?.getAttribute('aria-modal') === 'true',
        commentsTop: Math.round(commentsRect?.top ?? 0),
        commentsWidth: Math.round(commentsRect?.width ?? 0),
        compactActionCount: compactCards.reduce((count, card) => count + Array.from(card.querySelectorAll('button, summary')).filter((control) => control.getClientRects().length > 0).length, 0),
        compactCardCount: compactCards.length,
        directActiveActions: activeCard ? Array.from(activeCard.querySelectorAll('button')).filter((button) => button.getClientRects().length > 0).map((button) => button.textContent.trim()) : [],
        documentToolsOpen: document.querySelector('.document-tools')?.open ?? false,
        documentWidth: Math.round(documentRect?.width ?? 0),
        floatingItemCount: document.querySelectorAll('.comment-floating-item').length,
        framedRegionCount: Array.from(document.querySelectorAll('.editor-panel, .outline-panel, .version-history-panel, .comment-card, .comments-primary-actions, .comment-filter-bar')).filter((element) => getComputedStyle(element).borderTopWidth !== '0px' && element.getClientRects().length > 0).length,
        highlightRangeCount,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        inlineCommentTopCount: commentItems.filter((item) => item.style.top !== '').length,
        markdownSelectionEnd: markdownEditor?.selectionEnd ?? -1,
        markdownSelectionStart: markdownEditor?.selectionStart ?? -1,
        maxCompactCardHeight: Math.max(0, ...compactCards.map((card) => Math.round(card.getBoundingClientRect().height))),
        maxCommentItemGap: Math.max(0, ...commentGaps),
        mode: document.querySelector('.mode-switcher button[aria-pressed="true"]')?.textContent?.trim() ?? '',
        navigationWidth: Math.round(rect('.document-sidebar')?.width ?? 0),
        pageExcessBelowEditor: Math.round(document.documentElement.scrollHeight - (markdownRect?.bottom ?? documentRect?.bottom ?? 0)),
        readingWidth: Math.round(rect('.patchmark-prose')?.width ?? 0),
        semanticCommentItemCount: comments?.querySelectorAll('ol.comment-list > li[data-comment-id]').length ?? 0,
        uniqueCommentItemCount: new Set(commentIds).size,
        visibleControlCount: Array.from(document.querySelectorAll('button, input, select, textarea, summary')).filter((control) => control.getClientRects().length > 0).length
      };
    })()`
  });
}

async function clickSelector(selector) {
  await evaluate(client, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error(${JSON.stringify(`Missing selector: ${selector}`)});
      element.focus();
      element.click();
    })()`,
    userGesture: true
  });
}

async function pressKey(key) {
  await client.call("Input.dispatchKeyEvent", { key, type: "keyDown" });
  await client.call("Input.dispatchKeyEvent", { key, type: "keyUp" });
}

async function elementText(selector) {
  return await evaluate(client, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`
  });
}

async function countVisible(selector, text = null) {
  return await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((element) => element.getClientRects().length > 0 && (${JSON.stringify(text)} === null || element.textContent?.trim() === ${JSON.stringify(text)})).length`
  });
}

async function waitFor(expression, label) {
  let latest = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (latest) return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

async function screenshot(fileName) {
  if (!evidenceDir) return;
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(evidenceDir, fileName), Buffer.from(result.data, "base64"));
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "patchmark-phase4-fixture-"));
  const metadata = join(root, ".patchmark");
  const now = "2026-08-10T00:00:00.000Z";
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const actionMarkdown = [
    "# Action Plan",
    "",
    "The document remains the primary work surface.",
    "",
    "## Evidence",
    "",
    "Exact comment anchors remain synchronized across modes.",
    "",
    "## Review",
    "",
    "Pending patch discussion stays attached to one canonical comment thread.",
    "",
    "Applied patch discussion remains available after the document changes.",
    "",
    "## Wide content",
    "",
    "| Surface | Expected behavior |",
    "| --- | --- |",
    "| Document | Readable and dominant |",
    "| Comments | Contextual and compact |"
  ].join("\n");
  const notesMarkdown = "# Notes\n\nThis document intentionally has no comments.\n";
  const documents = [
    createDocumentStore({
      comments: createComments(actionMarkdown, now),
      displayTitle: "Action Plan",
      documentId: "doc_action",
      markdown: actionMarkdown,
      now,
      path: "action-plan.md",
      patches: createPatches(actionMarkdown, now),
      position: 1000,
      root,
      withVersion: true
    }),
    createDocumentStore({
      comments: [],
      displayTitle: "Notes",
      documentId: "doc_notes",
      markdown: notesMarkdown,
      now,
      path: "notes.md",
      patches: [],
      position: 2000,
      root,
      withVersion: false
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    serialize({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "prj_phase4",
      title: "Phase 4 Evidence",
      created_at: now,
      manifest_revision: 1,
      documents
    })
  );
  return root;
}

function createComments(markdown, now) {
  return [
    createComment({
      comment: "Clarify why the document must remain dominant.",
      id: "PM-COMMENT-0001",
      markdown,
      now,
      selectedText: "The document remains the primary work surface.",
      thread: [
        { id: "THREAD-1", role: "user", content: "Keep the hierarchy quiet.", created_at: now },
        { id: "THREAD-2", role: "chatgpt", content: "The active thread can carry the detail.", created_at: now }
      ]
    }),
    createComment({
      comment: "Historical note about exact anchor synchronization.",
      id: "PM-COMMENT-0002",
      markdown,
      now,
      selectedText: "Exact comment anchors remain synchronized across modes.",
      status: "resolved"
    }),
    createComment({
      comment: "Review this pending patch before changing the workflow.",
      id: "PM-COMMENT-0003",
      markdown,
      now,
      selectedText: "Pending patch discussion stays attached to one canonical comment thread.",
      thread: [
        { id: "THREAD-3", role: "user", content: "Does this preserve provenance?", created_at: now },
        { id: "THREAD-4", role: "chatgpt", content: "Yes; review remains pending.", created_at: now }
      ]
    }),
    createComment({
      comment: "Applied patch discussion remains in this canonical thread.",
      id: "PM-COMMENT-0004",
      markdown,
      now,
      selectedText: "Applied patch discussion remains available after the document changes.",
      thread: [
        { id: "THREAD-5", role: "user", content: "Keep this discussion after application.", created_at: now }
      ]
    }),
    {
      ...createComment({
        comment: "This unavailable anchor still requires human repair.",
        id: "PM-COMMENT-0005",
        markdown,
        now,
        selectedText: "A removed sentence that no longer exists."
      }),
      anchor: {
        kind: "selected_text",
        selected_text: "A removed sentence that no longer exists.",
        containing_heading: "Review",
        containing_heading_level: 2
      }
    }
  ];
}

function createComment({ comment, id, markdown, now, selectedText, status = "open", thread = [] }) {
  const start = markdown.indexOf(selectedText);
  return {
    id,
    type: "note",
    status,
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      anchor_source: "markdown"
    },
    comment,
    thread,
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now,
    ...(status === "resolved" ? { resolved_at: now } : {})
  };
}

function createPatches(markdown, now) {
  const pendingText = "Pending patch discussion stays attached to one canonical comment thread.";
  const appliedText = "Applied patch discussion remains available after the document changes.";
  return [
    {
      id: "PM-PATCH-0001",
      status: "pending",
      comment_id: "PM-COMMENT-0003",
      original_text: pendingText,
      suggested_text: `${pendingText} Provenance remains explicit.`,
      reason: "Preserve explicit provenance.",
      created_at: now
    },
    {
      id: "PM-PATCH-0002",
      status: "accepted",
      comment_id: "PM-COMMENT-0004",
      original_text: "Applied patch discussion was previously unavailable.",
      suggested_text: appliedText,
      applied_text: appliedText,
      applied_start_offset: markdown.indexOf(appliedText),
      applied_end_offset: markdown.indexOf(appliedText) + appliedText.length,
      accepted_at: now,
      applied_at: now,
      reason: "Preserve the canonical discussion after application.",
      created_at: now
    }
  ];
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
  withVersion
}) {
  writeFileSync(join(root, path), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  for (const directory of ["versions", "context-packs", "imports", "recovery"]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  const versions = withVersion
    ? [{ id: "VERSION-1", file: "versions/version-1.md", created_at: now, reason: "Phase 4 baseline" }]
    : [];
  if (withVersion) {
    writeFileSync(join(store, "versions", "version-1.md"), markdown);
  }
  writeFileSync(join(store, "comments.json"), serialize(comments));
  writeFileSync(join(store, "patches.json"), serialize(patches));
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "review-batches.json"), "[]\n");
  writeFileSync(join(store, "review-queue-overrides.json"), "{}\n");
  writeFileSync(
    join(store, "manifest.json"),
    serialize({
      schema_version: 1,
      project_id: "prj_phase4",
      document_id: documentId,
      project_name: "Phase 4 Evidence",
      document_file: "document.md",
      created_at: now,
      updated_at: now,
      versions
    })
  );
  writeFileSync(
    join(store, "document.json"),
    serialize({
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
    role: "decision",
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  const files = walk(root).sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function walk(root) {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

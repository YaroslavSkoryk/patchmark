import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
const evidenceDir = process.env.PATCHMARK_PHASE5_EVIDENCE_DIR;
const isWorkspaceDialogBaseline =
  process.env.PATCHMARK_WORKSPACE_DIALOG_BASELINE === "1";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-phase5-review-fixture-"));
const fixture = createPatchReviewFoundationFixture(fixtureRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
const measurements = {};

if (!chromePath) throw new Error("Chrome was not found for Phase 5 browser tests.");
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-phase5-review-chrome-"));
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
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(fixtureRoot)
    })
  });

  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await client.call("Page.navigate", { url: `${editorUrl}?phase5=${Date.now()}` });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('.application-document-breadcrumb')?.getAttribute('title')?.includes('Review Surface')`,
    "Phase 5 project"
  );
  await screenshot("01-desktop-review-closed.png");

  await openReviewWorkspace();
  const initialWrites = await writeCount();
  const initialState = await readReviewState();
  measurements.desktopInitial = initialState;
  assert.equal(initialState.batchCount, 3);
  assert.equal(initialState.patchRowCount, 4);
  assert.equal(initialState.inspectorCount, 1);
  assert.equal(initialState.inactivePatchControlMax, 1);
  assert.equal(initialState.selectedPatchTitle, "Clarify review hierarchy");
  assert.equal(initialState.bodyOverflow, "hidden");
  assert.equal(initialState.horizontalOverflow, false);
  assert.equal(initialState.commentsHidden, true);
  assert.equal(initialState.navigationDialogOpen, false);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('[data-testid="patch-review-workspace"]')?.contains(document.activeElement)`
    }),
    true
  );
  assert.ok(initialState.proposalWidth > 430);
  assert.match(initialState.proposalText, /Decision callbacks remain unchanged/);
  assert.match(initialState.proposalText, /Persistent content/);
  assert.equal(await writeCount(), initialWrites);
  await screenshot("02-desktop-compact-review-queue.png");
  await screenshot("03-desktop-focused-patch-inspector.png");

  await setViewport({ height: 984, mobile: false, width: 2048 });
  const wideState = await readReviewState();
  measurements.wide = wideState;
  assert.equal(wideState.bodyOverflow, "hidden");
  assert.equal(wideState.horizontalOverflow, false);
  assert.equal(await writeCount(), initialWrites);
  if (!isWorkspaceDialogBaseline) {
    assertWorkspaceBounds(wideState, 16);
    assert.ok(wideState.queueWidth > initialState.queueWidth);
    assert.ok(wideState.proposalWidth > initialState.proposalWidth);
    assert.equal(wideState.genericCloseCount, 1);
    assert.deepEqual(wideState.closeLabels, ["Close"]);
    assert.deepEqual(wideState.closeAccessibleNames, ["Close Review"]);
  }
  await screenshot(
    isWorkspaceDialogBaseline
      ? "00-wide-review-before.png"
      : "00-wide-review-after.png"
  );

  if (!isWorkspaceDialogBaseline) {
    measurements.viewports = {};
    const workspaceViewports = [
      { height: 900, inset: 16, label: "1440x900", mobile: false, width: 1440 },
      { height: 768, inset: 16, label: "1024x768", mobile: false, width: 1024 },
      { height: 900, inset: 8, label: "768x900", mobile: false, width: 768 },
      { height: 844, inset: 6, label: "393x844", mobile: true, width: 393 },
      { height: 393, inset: 8, label: "844x393", mobile: true, width: 844 },
      { height: 700, inset: 6, label: "320x700", mobile: true, width: 320 },
      { height: 450, inset: 8, label: "200-percent-reflow", mobile: false, width: 720 }
    ];

    for (const viewport of workspaceViewports) {
      await setViewport({
        height: viewport.height,
        mobile: viewport.mobile,
        width: viewport.width
      });
      const state = await readReviewState();
      measurements.viewports[viewport.label] = state;
      assertWorkspaceBounds(state, viewport.inset);
      assert.equal(state.bodyOverflow, "hidden");
      assert.equal(state.horizontalOverflow, false);
      assert.equal(state.genericCloseCount, 1);
      assert.equal(state.workspaceOverflow, "hidden");
      assert.equal(
        [state.queueOverflow, state.batchOverflow, state.patchListOverflow]
          .some((overflow) => overflow.includes("auto")),
        true
      );
      assert.equal(state.bodyScrollX, 0);
      assert.equal(state.bodyScrollY, 0);
      assert.equal(await writeCount(), initialWrites);
      await screenshot(`workspace-${viewport.label}.png`);
    }

    await setViewport({ height: 984, mobile: false, width: 2048 });
    await evaluate(client, {
      expression: `(() => {
        window.__workspaceDialogCloseCount = 0;
        window.__workspaceDialogWasOpen = Boolean(document.querySelector('[data-testid="patch-review-workspace"]'));
        window.__workspaceDialogObserver?.disconnect();
        window.__workspaceDialogObserver = new MutationObserver(() => {
          const isOpen = Boolean(document.querySelector('[data-testid="patch-review-workspace"]'));
          if (window.__workspaceDialogWasOpen && !isOpen) {
            window.__workspaceDialogCloseCount += 1;
          }
          window.__workspaceDialogWasOpen = isOpen;
        });
        window.__workspaceDialogObserver.observe(document.body, { childList: true, subtree: true });
        const close = document.querySelector('[data-testid="patch-review-workspace"] button[aria-label="Close Review"]');
        if (!(close instanceof HTMLButtonElement)) throw new Error('Global Review close control missing');
        close.focus();
        return document.activeElement === close;
      })()`
    });
    await screenshot("workspace-global-close-keyboard-focus.png");
    await evaluate(client, {
      expression: `document.querySelector('[data-testid="patch-review-workspace"] button[aria-label="Close Review"]')?.click(); true`,
      userGesture: true
    });
    await waitFor(`!document.querySelector('[data-testid="patch-review-workspace"]')`, "global Review close");
    assert.equal(
      await evaluate(client, { expression: `window.__workspaceDialogCloseCount` }),
      1
    );
    assert.equal(
      await evaluate(client, { expression: `document.activeElement?.getAttribute('aria-label')` }),
      "Review menu"
    );
    assert.equal(
      await evaluate(client, { expression: `getComputedStyle(document.body).overflow` }),
      "visible"
    );
    await openReviewWorkspace();
    const reopenedWideState = await readReviewState();
    measurements.reopenedWide = reopenedWideState;
    assert.deepEqual(
      [reopenedWideState.reviewWidth, reopenedWideState.reviewHeight, reopenedWideState.queueWidth],
      [wideState.reviewWidth, wideState.reviewHeight, wideState.queueWidth]
    );
    assert.equal(await writeCount(), initialWrites);
  }
  await setViewport({ height: 1000, mobile: false, width: 1440 });

  await clickPatchRow("Blocked dependent patch");
  const blockedState = await readSelectedPatchState();
  assert.equal(blockedState.acceptDisabled, true);
  assert.match(blockedState.dependencyText, /Requires 1 patch/);
  assert.match(blockedState.dependencyText, /awaiting review/);
  assert.equal(await writeCount(), initialWrites);
  await screenshot("04-desktop-dependency-blocked-patch.png");

  await clickPatchRow("Clarify review hierarchy");
  await clickButtonByText(client, "Discussion");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0001')?.getAttribute('aria-current') === 'true' && Boolean(document.querySelector('.comment-reply-form'))`,
    "canonical pending patch discussion"
  );
  assert.equal(
    await visibleCount("#patchmark-comment-card-PM-COMMENT-0001"),
    1
  );
  assert.equal(await visibleCount("[aria-label='Review Patch Proposal']"), 0);
  await screenshot("05-desktop-canonical-discussion-before-application.png");
  await clickComposerCancel();
  await closeComments();

  await openReviewWorkspace();
  assert.equal(
    await text("[aria-label='Review Patch Proposal'] h2"),
    "Clarify review hierarchy"
  );
  await setViewport({ height: 900, mobile: false, width: 820 });
  const narrowState = await readReviewState();
  measurements.narrow = narrowState;
  assert.ok(narrowState.queueHeight <= 236);
  assert.equal(narrowState.horizontalOverflow, false);
  assert.equal(narrowState.inspectorCount, 1);
  await screenshot("06-desktop-narrow-review-open.png");

  await setViewport({ height: 852, mobile: true, width: 393 });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  const mobileState = await readReviewState();
  measurements.mobile = mobileState;
  assert.equal(mobileState.applicationBarHeight, 88);
  assert.ok(mobileState.queueHeight <= 66);
  assert.ok(mobileState.proposalTop < 360);
  assert.equal(mobileState.horizontalOverflow, false);
  assert.equal(mobileState.reviewModal, true);
  assert.equal(mobileState.commentsHidden, true);
  assert.equal(
    await evaluate(client, {
      expression: `matchMedia("(hover: hover) and (pointer: fine)").matches`
    }),
    false
  );
  await screenshot("06-mobile-review-open-content-first.png");
  await scrollControlIntoView("Accept Patch");
  const mobileDecisionState = await controlRect("Accept Patch");
  assert.ok(mobileDecisionState.top >= 0);
  assert.ok(mobileDecisionState.bottom <= 852);
  await screenshot("07-mobile-decision-controls.png");

  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await clickPatchRow("Clarify review hierarchy");
  await evaluate(client, {
    expression: `window.__phase5ConfirmCount = 0; window.confirm = () => { window.__phase5ConfirmCount += 1; return false; }; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Accept Patch");
  assert.equal(
    await evaluate(client, { expression: `window.__phase5ConfirmCount` }),
    1
  );
  assert.equal(await writeCount(), initialWrites);
  assert.equal((await readSelectedPatchState()).status, "PENDING");

  const patchesPath = `.patchmark/documents/${fixture.documentId}/patches.json`;
  await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteControls.failNextPath = ${JSON.stringify(patchesPath)}; window.confirm = () => true; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Accept Patch");
  await waitFor(
    `document.querySelector('.document-save-banner')?.textContent?.includes('Injected fixture write failure')`,
    "patch application failure"
  );
  assert.equal(
    await visibleCount("[data-testid='patch-review-workspace'] .patch-review-feedback"),
    1
  );
  assert.match(
    await text("[data-testid='patch-review-workspace'] .patch-review-feedback"),
    /Injected fixture write failure/
  );
  assert.equal((await readSelectedPatchState()).status, "PENDING");
  assert.equal((await readSelectedPatchState()).acceptDisabled, false);
  await screenshot("09-desktop-application-failure-retry.png");

  await evaluate(client, {
    expression: `window.confirm = () => true; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Accept Patch");
  await waitForPatchStatus("PM-PATCH-0001", "accepted");
  await waitFor(
    `document.querySelector('[aria-label="Review Patch Proposal"] .patch-review-heading-row .patch-status-badge')?.textContent?.trim() === 'APPLIED'`,
    "applied patch status"
  );
  const appliedState = await readSelectedPatchState();
  assert.equal(appliedState.status, "APPLIED");
  assert.equal(appliedState.activeElementStatus, "APPLIED");
  assert.match(
    await writtenFile("review.md"),
    /Queue hierarchy stays clear with one focused inspector/
  );
  await screenshot("10-desktop-applied-patch.png");

  await clickButtonByText(client, "Continue discussion");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-PM-COMMENT-0001')?.getAttribute('aria-current') === 'true' && Boolean(document.querySelector('.comment-reply-form'))`,
    "canonical applied patch discussion"
  );
  assert.equal(
    await visibleCount("#patchmark-comment-card-PM-COMMENT-0001"),
    1
  );
  await screenshot("11-desktop-same-discussion-after-application.png");
  await clickComposerCancel();
  await closeComments();

  await openReviewWorkspace();
  await clickPatchRow("Blocked dependent patch");
  assert.equal((await readSelectedPatchState()).acceptDisabled, true);
  await clickButtonByText(client, "Review required patch");
  assert.equal(
    await text("[aria-label='Review Patch Proposal'] h2"),
    "Required prerequisite"
  );
  await clickButtonByText(client, "Accept Patch");
  await waitForPatchStatus("PM-PATCH-0003", "accepted");
  await clickPatchRow("Blocked dependent patch");
  await waitFor(
    `Array.from(document.querySelectorAll('[aria-label="Review Patch Proposal"] button')).some((button) => button.textContent?.trim() === 'Accept Patch' && !button.disabled)`,
    "dependent patch unlock"
  );
  assert.equal((await readSelectedPatchState()).acceptDisabled, false);

  await evaluate(client, {
    expression: `window.confirm = () => false; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Reject Patch");
  assert.equal((await readSelectedPatchState()).status, "PENDING");
  await evaluate(client, {
    expression: `window.confirm = () => true; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Reject Patch");
  await waitForPatchStatus("PM-PATCH-0004", "rejected");
  assert.equal((await readSelectedPatchState()).status, "REJECTED");
  assert.match(await writtenFile("review.md"), /Dependent source remains stable/);
  await screenshot("12-desktop-rejected-and-completed-batch.png");

  await clickBatch(/Manual Review 2/);
  assert.match(await text(".patch-review-batch-switcher button[aria-current='true']"), /Complete/);
  assert.ok((await visibleCount(".patch-status-badge-applied")) >= 2);
  assert.ok((await visibleCount(".patch-status-badge-rejected")) >= 1);
  await screenshot("13-desktop-historical-batch.png");

  await clickBatch(/Manual Review 1/);
  await clickPatchRow("Unavailable historical target");
  const staleState = await readSelectedPatchState();
  assert.equal(staleState.status, "STALE BEFORE APPLY");
  assert.equal(staleState.hasAcceptButton, false);
  assert.match(staleState.applicabilityText, /not found/i);
  await screenshot("14-desktop-stale-repair-required-state.png");

  if (!isWorkspaceDialogBaseline) {
    await evaluate(client, {
      expression: `window.__workspaceDialogCloseCount = 0; window.__workspaceDialogWasOpen = true; true`
    });
  }
  await pressKey("Escape");
  await waitFor(`!document.querySelector('[data-testid="patch-review-workspace"]')`, "Review close");
  await waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Review menu'`,
    "Review trigger focus restoration"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.getAttribute('aria-label')`
    }),
    "Review menu"
  );
  assert.equal(
    await evaluate(client, { expression: `getComputedStyle(document.body).overflow` }),
    "visible"
  );
  if (!isWorkspaceDialogBaseline) {
    assert.equal(
      await evaluate(client, { expression: `window.__workspaceDialogCloseCount` }),
      1
    );
  }
  await screenshot("15-desktop-keyboard-focus-restored.png");

  if (evidenceDir) {
    writeFileSync(
      join(evidenceDir, "after-measurements.json"),
      `${JSON.stringify(measurements, null, 2)}\n`
    );
  }
  console.log(JSON.stringify({ evidenceDir: evidenceDir ?? null, measurements }, null, 2));
  console.log("Patch review foundation browser tests passed.");
} finally {
  await client?.close().catch(() => {});
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function openReviewWorkspace() {
  await clickButtonByText(client, "Review");
  await waitFor(`Boolean(document.querySelector('[role="menu"]:not([hidden])'))`, "Review menu");
  await clickButtonByText(client, "Review patch proposals");
  await waitFor(`Boolean(document.querySelector('[data-testid="patch-review-workspace"]'))`, "Review workspace");
}

async function clickPatchRow(title) {
  await evaluate(client, {
    expression: `(() => { const row = Array.from(document.querySelectorAll('.patch-review-queue-row')).find((item) => item.textContent?.includes(${JSON.stringify(title)})); const button = row?.querySelector('button'); if (!(button instanceof HTMLButtonElement)) throw new Error('Patch row not found: ${title}'); button.click(); return true; })()`,
    userGesture: true
  });
  await waitFor(
    `document.querySelector('[aria-label="Review Patch Proposal"] h2')?.textContent?.trim() === ${JSON.stringify(title)}`,
    `selected patch ${title}`
  );
}

async function clickBatch(pattern) {
  await evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('.patch-review-batch-switcher button')).find((item) => ${pattern}.test(item.textContent ?? '')); if (!(button instanceof HTMLButtonElement)) throw new Error('Review Batch not found'); button.click(); return true; })()`,
    userGesture: true
  });
}

async function readReviewState() {
  return evaluate(client, {
    expression: `(() => {
      const workspace = document.querySelector('[data-testid="patch-review-workspace"]');
      const inspector = document.querySelector('[aria-label="Review Patch Proposal"]');
      const proposal = document.querySelector('.patch-review-preview-grid');
      const queue = document.querySelector('.patch-review-queue');
      const inspectorShell = document.querySelector('.patch-review-inspector-shell');
      const patchBody = document.querySelector('.patch-review-body');
      const layout = document.querySelector('.patch-review-workspace-layout');
      const batchSwitcher = document.querySelector('.patch-review-batch-switcher');
      const patchList = document.querySelector('.patch-review-queue-patches');
      const visible = (element) => Boolean(element?.getClientRects().length);
      const workspaceRect = workspace?.getBoundingClientRect();
      const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
      const closeButtons = Array.from(workspace?.querySelectorAll('button') ?? [])
        .filter((button) => button.textContent?.trim() === 'Close' && visible(button));
      const framedRegions = Array.from(
        workspace?.querySelectorAll('.patch-review-card, .patch-group-patch-card') ?? []
      ).filter(visible).filter(
        (element) => getComputedStyle(element).borderTopWidth !== '0px'
      );
      const inactivePatchControls = Array.from(
        workspace?.querySelectorAll('.patch-review-queue-row') ?? []
      ).map((row) => Array.from(row.querySelectorAll('button, summary, a')).filter(visible).length);
      return {
        applicationBarHeight: Math.round(document.querySelector('.application-bar')?.getBoundingClientRect().height ?? 0),
        activePatchControls: Array.from(inspector?.querySelectorAll('button, summary, a') ?? []).filter(visible).length,
        batchCount: document.querySelectorAll('.patch-review-batch-switcher li').length,
        documentWidth: Math.round(document.querySelector('.editor-panel')?.getBoundingClientRect().width ?? 0),
        framedRegions: framedRegions.length,
        fullPatchCards: document.querySelectorAll('[aria-label="Review Patch Proposal"]').length,
        inactivePatchControlMax: Math.max(0, ...inactivePatchControls),
        patchRowCount: document.querySelectorAll('.patch-review-queue-row').length,
        inspectorCount: document.querySelectorAll('[aria-label="Review Patch Proposal"]').length,
        selectedPatchTitle: document.querySelector('[aria-label="Review Patch Proposal"] h2')?.textContent?.trim() ?? '',
        proposalText: proposal?.textContent ?? '',
        proposalWidth: Math.round(proposal?.getBoundingClientRect().width ?? 0),
        proposalTop: Math.round(proposal?.getBoundingClientRect().top ?? 0),
        inspectorHeight: Math.round(inspectorShell?.getBoundingClientRect().height ?? 0),
        inspectorWidth: Math.round(inspectorShell?.getBoundingClientRect().width ?? 0),
        layoutHeight: Math.round(layout?.getBoundingClientRect().height ?? 0),
        layoutWidth: Math.round(layout?.getBoundingClientRect().width ?? 0),
        queueHeight: Math.round(queue?.getBoundingClientRect().height ?? 0),
        queueWidth: Math.round(queue?.getBoundingClientRect().width ?? 0),
        clientHeight: workspace?.clientHeight ?? 0,
        clientWidth: workspace?.clientWidth ?? 0,
        scrollHeight: workspace?.scrollHeight ?? 0,
        scrollWidth: workspace?.scrollWidth ?? 0,
        leftGap: Math.round(workspaceRect?.left ?? 0),
        rightGap: Math.round(innerWidth - (workspaceRect?.right ?? innerWidth)),
        topGap: Math.round(workspaceRect?.top ?? 0),
        bottomGap: Math.round(innerHeight - (workspaceRect?.bottom ?? innerHeight)),
        computedHeight: workspaceStyle?.height ?? '',
        computedMaxHeight: workspaceStyle?.maxHeight ?? '',
        computedMaxWidth: workspaceStyle?.maxWidth ?? '',
        computedWidth: workspaceStyle?.width ?? '',
        bodyScrollX: window.scrollX,
        bodyScrollY: window.scrollY,
        batchOverflow: batchSwitcher ? getComputedStyle(batchSwitcher).overflowX + '/' + getComputedStyle(batchSwitcher).overflowY : '',
        inspectorOverflow: inspectorShell ? getComputedStyle(inspectorShell).overflowX + '/' + getComputedStyle(inspectorShell).overflowY : '',
        patchBodyOverflow: patchBody ? getComputedStyle(patchBody).overflowX + '/' + getComputedStyle(patchBody).overflowY : '',
        patchListOverflow: patchList ? getComputedStyle(patchList).overflowX + '/' + getComputedStyle(patchList).overflowY : '',
        queueOverflow: queue ? getComputedStyle(queue).overflowX + '/' + getComputedStyle(queue).overflowY : '',
        workspaceOverflow: workspaceStyle?.overflow ?? '',
        closeAccessibleNames: closeButtons.map((button) => button.getAttribute('aria-label') || button.textContent?.trim() || ''),
        closeLabels: closeButtons.map((button) => button.textContent?.trim() ?? ''),
        genericCloseCount: closeButtons.length,
        reviewHeight: Math.round(workspaceRect?.height ?? 0),
        reviewModal: workspace?.getAttribute('aria-modal') === 'true',
        reviewTop: Math.round(workspaceRect?.top ?? 0),
        reviewWidth: Math.round(workspaceRect?.width ?? 0),
        visibleControls: Array.from(workspace?.querySelectorAll('button, summary, a') ?? []).filter(visible).length,
        bodyOverflow: getComputedStyle(document.body).overflow,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        commentsHidden: document.querySelector('#document-comments-panel')?.hidden ?? true,
        navigationDialogOpen: Boolean(document.querySelector('#document-navigation-drawer[role="dialog"]'))
      };
    })()`
  });
}

function assertWorkspaceBounds(state, maximumInset) {
  const gaps = [state.leftGap, state.rightGap, state.topGap, state.bottomGap];
  assert.ok(Math.max(...gaps) <= maximumInset);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
  assert.equal(state.clientWidth, state.reviewWidth - 2);
  assert.equal(state.clientHeight, state.reviewHeight - 2);
  assert.equal(state.scrollWidth, state.clientWidth);
  assert.equal(state.scrollHeight, state.clientHeight);
  assert.equal(state.computedMaxWidth, "none");
  assert.equal(state.computedMaxHeight, "none");
}

async function readSelectedPatchState() {
  return evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector('[aria-label="Review Patch Proposal"]');
      const accept = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Accept Patch');
      const badge = dialog?.querySelector('.patch-review-heading-row .patch-status-badge');
      return {
        acceptDisabled: Boolean(accept?.disabled),
        activeElementStatus: document.activeElement?.getAttribute('role') === 'status' ? document.activeElement.textContent?.trim() ?? '' : '',
        applicabilityText: dialog?.querySelector('.patch-applicability')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        dependencyText: dialog?.querySelector('.patch-dependency-summary')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        hasAcceptButton: Boolean(accept),
        status: badge?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
      };
    })()`
  });
}

async function waitForPatchStatus(patchId, status) {
  await waitFor(
    `(() => { const raw = window.__patchmarkFixtureWrites?.get(${JSON.stringify(`.patchmark/documents/${fixture.documentId}/patches.json`)}); if (!raw) return false; return JSON.parse(raw).find((patch) => patch.id === ${JSON.stringify(patchId)})?.status === ${JSON.stringify(status)}; })()`,
    `${patchId} ${status}`
  );
}

async function writtenFile(path) {
  return evaluate(client, {
    expression: `window.__patchmarkFixtureWrites?.get(${JSON.stringify(path)}) ?? ''`
  });
}

async function writeCount() {
  return evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog?.length ?? 0`
  });
}

async function visibleCount(selector) {
  return evaluate(client, {
    expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((element) => element.getClientRects().length > 0).length`
  });
}

async function text(selector) {
  return evaluate(client, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`
  });
}

async function clickComposerCancel() {
  await evaluate(client, {
    expression: `(() => { const composer = document.querySelector('.comment-reply-form'); const button = Array.from(composer?.querySelectorAll('button') ?? []).find((item) => item.textContent?.trim() === 'Cancel'); if (!(button instanceof HTMLButtonElement)) throw new Error('Reply cancel button missing'); button.click(); return true; })()`,
    userGesture: true
  });
  await waitFor(`!document.querySelector('.comment-reply-form')`, "reply composer close");
}

async function closeComments() {
  await evaluate(client, {
    expression: `(() => { const button = document.querySelector('.comments-panel-close'); if (!(button instanceof HTMLButtonElement)) throw new Error('Comments close button missing'); button.click(); return true; })()`,
    userGesture: true
  });
  await waitFor(`document.querySelector('#document-comments-panel')?.hidden === true`, "comments close");
}

async function scrollControlIntoView(label) {
  await evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === ${JSON.stringify(label)} && item.getClientRects().length > 0); if (!(button instanceof HTMLButtonElement)) throw new Error('Control missing: ${label}'); button.scrollIntoView({ block: 'center' }); return true; })()`,
    userGesture: true
  });
}

async function controlRect(label) {
  return evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === ${JSON.stringify(label)} && item.getClientRects().length > 0); const rect = button?.getBoundingClientRect(); return { top: rect?.top ?? -1, bottom: rect?.bottom ?? -1 }; })()`
  });
}

async function setViewport(viewport) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    ...viewport
  });
}

async function pressKey(key) {
  const virtualKeyCode = key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
  await client.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: virtualKeyCode,
    type: "keyDown",
    windowsVirtualKeyCode: virtualKeyCode
  });
  await client.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: virtualKeyCode,
    type: "keyUp",
    windowsVirtualKeyCode: virtualKeyCode
  });
}

async function waitFor(expression, label) {
  let value;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    value = await evaluate(client, { expression });
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function screenshot(name) {
  if (!evidenceDir) return;
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(evidenceDir, name), Buffer.from(result.data, "base64"));
}

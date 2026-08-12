import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/";
const layoutBaselineAudit =
  process.env.PATCHMARK_APPLICATION_BAR_BASELINE_AUDIT === "1";
const interactionStateBaselineAudit =
  process.env.PATCHMARK_APPLICATION_MENU_STATE_BASELINE_AUDIT === "1";
const artifactRoot =
  process.env.PATCHMARK_PHASE2_ARTIFACT_ROOT ??
  mkdtempSync(join(tmpdir(), "patchmark-application-shell-artifacts-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-shell-fixture-"));
const newProjectDir = join(fixtureRoot, "new-project");
const existingProjectDir = join(fixtureRoot, "existing-project");
const workspaceDialogMeasurements = {};

mkdirSync(artifactRoot, { recursive: true });
mkdirSync(newProjectDir, { recursive: true });
createProjectFixture(existingProjectDir);

const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for application shell browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-shell-chrome-"));
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
  await client.call("Accessibility.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      pickerPaths: ["new-project", "existing-project"],
      projectName: "phase2-fixtures"
    })
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      Object.defineProperty(window, "showOpenFilePicker", {
        configurable: true,
        value: undefined
      });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined
      });
    })();`
  });

  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);

  const applicationBarLayouts = await captureApplicationBarLayouts(client);
  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  const applicationBarAccessibility = await readApplicationBarAccessibility(client);
  assert.equal(applicationBarAccessibility.bannerCount, 1);
  assert.equal(
    applicationBarAccessibility.navigations.includes("Application actions"),
    true
  );
  assert.equal(applicationBarAccessibility.buttons.includes("File menu"), true);
  assert.equal(applicationBarAccessibility.buttons.includes("Review menu"), true);
  assert.equal(
    applicationBarAccessibility.buttons.some((name) =>
      name.startsWith("Open comments.")
    ),
    true
  );

  const desktopShell = await readShellState(client);
  assert.equal(desktopShell.bar.height, 56);
  assert.equal(desktopShell.workspace.top, 68);
  assert.deepEqual(desktopShell.controls, ["File", "Review"]);
  assert.equal(desktopShell.headerWrapped, false);
  assert.equal(desktopShell.horizontalOverflow, false);
  await capture(client, "01-desktop-shell-1440x1000.png");

  await clickVisibleButton(client, "File");
  const openFileMenu = await waitForOpenMenu(client, "File");
  assert.deepEqual(openFileMenu.labels, [
    "Load Markdown",
    "Open Project Folder",
    "Create Project From Existing Patchmark Projects",
    "Create Project From Current Document"
  ]);
  await capture(client, "02-desktop-file-menu-open.png");

  await clickOutsideMenu(client);
  await waitForMenuClosed(client, "File");

  await focusButton(client, "File");
  await pressKey(client, "Enter", "Enter", 13);
  await waitForOpenMenu(client, "File");
  await waitFor(
    client,
    "first File menu item focus",
    `document.activeElement?.textContent?.trim() === "Load Markdown"`
  );
  await pressKey(client, "ArrowDown", "ArrowDown", 40);
  assert.equal(await activeText(client), "Open Project Folder");
  await pressKey(client, "Escape", "Escape", 27);
  await waitForMenuClosed(client, "File");
  assert.equal(await activeText(client), "File");
  await capture(client, "03-desktop-file-trigger-keyboard-focus.png");

  await focusButton(client, "File");
  await pressKey(client, " ", "Space", 32);
  await waitForOpenMenu(client, "File");
  await evaluate(client, {
    expression: `(() => {
      const input = document.querySelector(".file-loader-input");
      window.__patchmarkPhase2FileInputClicks = 0;
      input.addEventListener("click", (event) => {
        window.__patchmarkPhase2FileInputClicks += 1;
        event.preventDefault();
      });
      return true;
    })()`
  });
  await clickVisibleButton(client, "Load Markdown");
  assert.equal(
    await evaluate(client, {
      expression: "window.__patchmarkPhase2FileInputClicks"
    }),
    1,
    "The relocated import action must activate the original file input"
  );
  await evaluate(client, {
    expression: `(() => {
      const input = document.querySelector(".file-loader-input");
      const transfer = new DataTransfer();
      transfer.items.add(new File([
        "# Phase 2 import\\n\\nSafe local fixture content.\\n"
      ], "phase2-import.md", { type: "text/markdown" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.files.length;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    "standalone Markdown import",
    `document.querySelector(".document-meta strong")?.textContent?.includes("phase2-import.md")`
  );
  await waitForMenuClosed(client, "File");

  const applicationMenuInteractionStates =
    await captureApplicationMenuInteractionStates(client);
  writeFileSync(
    join(artifactRoot, "application-menu-interaction-states.json"),
    `${JSON.stringify(applicationMenuInteractionStates, null, 2)}\n`
  );

  await evaluate(client, {
    expression: `(() => {
      window.__patchmarkPhase2Downloads = [];
      HTMLAnchorElement.prototype.click = function () {
        window.__patchmarkPhase2Downloads.push({
          download: this.download,
          href: this.href
        });
      };
      return true;
    })()`
  });

  await openMenuItem(client, "File", "Save As");
  await waitFor(
    client,
    "Save As fallback",
    `document.querySelector(".document-save-banner")?.textContent?.includes("Direct Save As is not available")`
  );
  assert.equal(await downloadCount(client), 1);
  assert.equal(await activeText(client), "File");

  await openMenuItem(client, "File", "Download .md");
  await waitFor(
    client,
    "Markdown download feedback",
    `document.querySelector(".document-save-banner")?.textContent?.includes("Downloaded a Markdown copy")`
  );
  assert.equal(await downloadCount(client), 2);
  assert.equal(await activeText(client), "File");
  await capture(client, "04-relocated-download-activated.png");

  await openMenuItem(client, "File", "Export PDF");
  await waitFor(
    client,
    "PDF export preview",
    `Boolean(document.querySelector("[aria-label='Clean shareholder PDF document preview']"))`
  );
  workspaceDialogMeasurements.pdfDesktop = await readWorkspaceSurface(
    client,
    ".pdf-export-dialog",
    ".pdf-export-dialog-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.pdfDesktop, 16);
  await capture(client, "05-relocated-pdf-export-activated.png");
  await setViewport(client, { height: 844, mobile: true, width: 393 });
  workspaceDialogMeasurements.pdfMobile = await readWorkspaceSurface(
    client,
    ".pdf-export-dialog",
    ".pdf-export-dialog-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.pdfMobile, 6);
  await capture(client, "05A-pdf-export-mobile-workspace.png");
  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await clickVisibleButton(client, "Close");
  await waitFor(
    client,
    "PDF export preview close",
    `!document.querySelector("[aria-label='Clean shareholder PDF document preview']")`
  );

  await openMenuItem(
    client,
    "File",
    "Create Project From Current Document"
  );
  await waitFor(
    client,
    "new project creation",
    `document.querySelector("[aria-label='Workspace status']")?.textContent?.includes("Patchmark Project")`
  );
  await waitForFile(join(newProjectDir, ".patchmark", "manifest.json"));

  await openMenuItem(client, "File", "Open Project Folder");
  await waitFor(
    client,
    "existing project open",
    `document.querySelector("[aria-label='Workspace status']")?.textContent?.includes("Project: Phase 2 Existing")`
  );

  await openMenuItem(
    client,
    "File",
    "Create Project From Existing Patchmark Projects"
  );
  await waitFor(
    client,
    "legacy project assembly dialog",
    `Boolean(document.querySelector("[aria-label='Create project from existing Patchmark projects']"))`
  );
  workspaceDialogMeasurements.legacyAssemblyDesktop = await readWorkspaceSurface(
    client,
    ".legacy-assembly-dialog",
    ".legacy-assembly-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.legacyAssemblyDesktop, 16);
  await capture(client, "05B-legacy-assembly-desktop-workspace.png");
  await setViewport(client, { height: 844, mobile: true, width: 393 });
  workspaceDialogMeasurements.legacyAssemblyMobile = await readWorkspaceSurface(
    client,
    ".legacy-assembly-dialog",
    ".legacy-assembly-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.legacyAssemblyMobile, 6);
  await capture(client, "05C-legacy-assembly-mobile-workspace.png");
  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await clickVisibleButton(client, "Cancel");

  await openMenuItem(client, "Review", "Generate ChatGPT Prompt");
  await waitFor(
    client,
    "prompt generation feedback",
    `document.querySelector(".document-save-banner")?.textContent?.includes("No focused comments to export")`
  );

  await openMenuItem(client, "Review", "Import ChatGPT Response");
  await waitFor(
    client,
    "ChatGPT response import dialog",
    `Boolean(document.querySelector("[aria-label='Import ChatGPT response']"))`
  );
  const compactImportState = await readCompactSurface(
    client,
    "[aria-label='Import ChatGPT response']"
  );
  assert.equal(compactImportState.hasWorkspaceClass, false);
  assert.ok(compactImportState.width < 1000);
  assert.ok(compactImportState.width < compactImportState.viewportWidth - 200);
  await capture(client, "05D-compact-import-dialog-unchanged.png");
  await clickVisibleButton(client, "Cancel");

  await openMenuItem(client, "Review", "Guided Review");
  await waitFor(
    client,
    "Guided Review wizard",
    `Boolean(document.querySelector("[aria-label='Guided Review Wizard']"))`
  );
  workspaceDialogMeasurements.guidedReviewDesktop = await readWorkspaceSurface(
    client,
    ".guided-review-wizard-dialog",
    ".guided-review-wizard-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.guidedReviewDesktop, 16);
  await capture(client, "05E-guided-review-desktop-workspace.png");
  await setViewport(client, { height: 844, mobile: true, width: 393 });
  workspaceDialogMeasurements.guidedReviewMobile = await readWorkspaceSurface(
    client,
    ".guided-review-wizard-dialog",
    ".guided-review-wizard-body"
  );
  assertWorkspaceSurface(workspaceDialogMeasurements.guidedReviewMobile, 6);
  await capture(client, "05F-guided-review-mobile-workspace.png");
  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await clickVisibleButton(client, "Close Guided Review");

  assert.equal(
    await evaluate(client, {
      expression: `Array.from(document.querySelectorAll("summary, button"))
        .some((control) => control.textContent?.trim() === "Add document" && control.getClientRects().length > 0)`
    }),
    true
  );
  await evaluate(client, {
    expression: `(() => {
      const summary = Array.from(document.querySelectorAll("summary"))
        .find((control) => control.textContent?.trim() === "Add document" && control.getClientRects().length > 0);
      summary?.click();
      return Boolean(summary);
    })()`,
    userGesture: true
  });
  assert.equal(
    await evaluate(client, {
      expression: `Array.from(document.querySelectorAll("button"))
        .some((control) => control.textContent?.trim() === "Add existing document" && control.getClientRects().length > 0)`
    }),
    true
  );

  await setViewport(client, { height: 900, mobile: false, width: 900 });
  const narrowShell = await readShellState(client);
  assert.equal(narrowShell.bar.height, 56);
  assert.equal(narrowShell.headerWrapped, false);
  assert.equal(narrowShell.horizontalOverflow, false);
  await capture(client, "06-narrow-shell-900x900.png");

  await setViewport(client, { height: 852, mobile: true, width: 393 });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  const mobileShell = await readShellState(client);
  assert.equal(mobileShell.bar.height, 56);
  assert.equal(mobileShell.headerWrapped, false);
  assert.equal(mobileShell.horizontalOverflow, false);
  assert.ok(mobileShell.triggerHeight >= 40);
  assert.equal(
    await evaluate(client, {
      expression: `matchMedia("(hover: hover) and (pointer: fine)").matches`
    }),
    false
  );
  await capture(client, "07-mobile-shell-393x852.png");

  const mobileDefaultBackground = await triggerBackground(client, "File");
  await touchButton(client, "File");
  const mobileMenu = await waitForOpenMenu(client, "File");
  assert.ok(mobileMenu.rect.left >= 0);
  assert.ok(mobileMenu.rect.right <= 393);
  assert.ok(mobileMenu.rect.height < 790);
  await capture(client, "08-mobile-file-menu-open.png");
  await touchButton(client, "File");
  await waitForMenuClosed(client, "File");
  await delay(150);
  assert.equal(await triggerBackground(client, "File"), mobileDefaultBackground);

  const result = {
    applicationBarAccessibility,
    applicationBarLayouts,
    applicationMenuInteractionStates,
    artifacts: artifactRoot,
    desktop: desktopShell,
    mobile: mobileShell,
    narrow: narrowShell,
    workspaceDialogMeasurements
  };
  writeFileSync(
    join(artifactRoot, "workspace-dialog-measurements.json"),
    `${JSON.stringify(workspaceDialogMeasurements, null, 2)}\n`
  );
  console.log(JSON.stringify(result, null, 2));
  console.log("Application shell browser tests passed.");
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function readWorkspaceSurface(pageClient, selector, scrollOwnerSelector) {
  return evaluate(pageClient, {
    expression: `(() => {
      const surface = document.querySelector(${JSON.stringify(selector)});
      const scrollOwner = document.querySelector(${JSON.stringify(scrollOwnerSelector)});
      const rect = surface?.getBoundingClientRect();
      const style = surface ? getComputedStyle(surface) : null;
      const scrollStyle = scrollOwner ? getComputedStyle(scrollOwner) : null;
      return {
        bodyOverflow: getComputedStyle(document.body).overflow,
        bottomGap: Math.round(innerHeight - (rect?.bottom ?? innerHeight)),
        clientHeight: surface?.clientHeight ?? 0,
        clientWidth: surface?.clientWidth ?? 0,
        focusedInside: Boolean(surface?.contains(document.activeElement)),
        height: Math.round(rect?.height ?? 0),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        leftGap: Math.round(rect?.left ?? 0),
        maxHeight: style?.maxHeight ?? '',
        maxWidth: style?.maxWidth ?? '',
        rightGap: Math.round(innerWidth - (rect?.right ?? innerWidth)),
        scrollHeight: surface?.scrollHeight ?? 0,
        scrollOwnerOverflow: scrollStyle ? scrollStyle.overflowX + '/' + scrollStyle.overflowY : '',
        scrollWidth: surface?.scrollWidth ?? 0,
        topGap: Math.round(rect?.top ?? 0),
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
        width: Math.round(rect?.width ?? 0)
      };
    })()`
  });
}

function assertWorkspaceSurface(surface, inset) {
  assert.deepEqual(
    [surface.leftGap, surface.rightGap, surface.topGap, surface.bottomGap],
    [inset, inset, inset, inset]
  );
  assert.equal(surface.bodyOverflow, "hidden");
  assert.equal(surface.horizontalOverflow, false);
  assert.equal(surface.maxWidth, "none");
  assert.equal(surface.maxHeight, "none");
  assert.equal(surface.clientWidth, surface.width - 2);
  assert.equal(surface.clientHeight, surface.height - 2);
  assert.equal(surface.scrollWidth, surface.clientWidth);
  assert.equal(surface.scrollHeight, surface.clientHeight);
  assert.equal(surface.scrollOwnerOverflow.includes("auto"), true);
}

async function readCompactSurface(pageClient, selector) {
  return evaluate(pageClient, {
    expression: `(() => {
      const surface = document.querySelector(${JSON.stringify(selector)});
      return {
        hasWorkspaceClass: surface?.classList.contains('workspace-dialog-surface') ?? false,
        viewportWidth: innerWidth,
        width: Math.round(surface?.getBoundingClientRect().width ?? 0)
      };
    })()`
  });
}

async function openMenuItem(pageClient, menuLabel, itemLabel) {
  await clickVisibleButton(pageClient, menuLabel);
  await waitForOpenMenu(pageClient, menuLabel);
  await clickVisibleButton(pageClient, itemLabel);
  await waitForMenuClosed(pageClient, menuLabel);
}

async function readShellState(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => {
      const rect = (node) => {
        const value = node.getBoundingClientRect();
        return {
          bottom: Math.round(value.bottom),
          height: Math.round(value.height),
          left: Math.round(value.left),
          right: Math.round(value.right),
          top: Math.round(value.top),
          width: Math.round(value.width)
        };
      };
      const bar = document.querySelector(".application-bar");
      const actions = document.querySelector(".application-bar-actions");
      const identity = document.querySelector(".application-identity");
      const controls = Array.from(document.querySelectorAll(".application-menu-trigger"));
      const controlRects = controls.map(rect);
      const orderedControls = Array.from(
        document.querySelectorAll(
          ".application-bar-actions > .application-menu > .application-menu-trigger, .application-bar-actions > .application-comments-trigger"
        )
      ).filter((control) => control.getClientRects().length > 0);
      const comments = document.querySelector(".application-comments-trigger");
      const badge = comments?.querySelector(".application-comments-count");
      const file = controls.find((control) => control.textContent.trim() === "File");
      const navigation = document.querySelector(".application-navigation-trigger");
      const navigationVisible = Boolean(navigation?.getClientRects().length);
      const barRect = rect(bar);
      const actionsRect = rect(actions);
      const fileRect = rect(file);
      const navigationRect = navigationVisible ? rect(navigation) : null;
      return {
        actionOrder: orderedControls.map((control) =>
          control.classList.contains("application-comments-trigger")
            ? "Comments"
            : control.textContent.trim()
        ),
        actions: actionsRect,
        actionsLeftGap: actionsRect.left - barRect.left,
        actionsRightGap: barRect.right - actionsRect.right,
        bar: barRect,
        barAriaLabel: bar.getAttribute("aria-label"),
        badgeParentIsComments: badge?.parentElement === comments,
        badgeText: badge?.textContent?.trim() ?? null,
        controls: controls.map((control) => control.textContent.trim()),
        emptyIdentityCount: Array.from(document.querySelectorAll(".application-identity"))
          .filter((element) => !element.textContent?.trim()).length,
        fileLeftGap: fileRect.left - barRect.left,
        headerWrapped: controlRects.some((control) =>
          Math.abs(control.top - controlRects[0].top) > 2
        ),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        identityCount: document.querySelectorAll(".application-identity").length,
        navigationFileGap: navigationRect ? fileRect.left - navigationRect.right : null,
        navigationVisible,
        pageTitle: document.title,
        triggerHeight: Math.min(...controlRects.map((control) => control.height)),
        visibleWordmark: identity?.textContent?.trim() ?? null,
        workspace: rect(document.querySelector(".document-workspace"))
      };
    })()`
  });
}

async function captureApplicationBarLayouts(pageClient) {
  const measurements = {};
  for (const [label, viewport] of [
    ["wide", { height: 96, mobile: false, width: 2048 }],
    ["desktop", { height: 900, mobile: false, width: 1440 }],
    ["narrow", { height: 900, mobile: false, width: 768 }],
    ["mobile", { height: 844, mobile: true, width: 393 }],
    ["compact", { height: 844, mobile: true, width: 320 }],
    ["zoomEquivalent", { height: 500, mobile: false, width: 720 }]
  ]) {
    await setViewport(pageClient, viewport);
    const state = await readShellState(pageClient);
    assert.equal(state.bar.height, 56);
    assert.deepEqual(state.actionOrder, ["File", "Review", "Comments"]);
    assert.equal(state.badgeParentIsComments, true);
    assert.equal(state.badgeText, "0");
    assert.equal(state.headerWrapped, false);
    assert.equal(state.horizontalOverflow, false);
    assert.equal(state.pageTitle, "Patchmark");

    if (layoutBaselineAudit) {
      assert.equal(state.identityCount, 1);
      assert.equal(state.visibleWordmark, "Patchmark");
      assert.equal(state.actionsRightGap, 0);
    } else {
      assert.equal(state.identityCount, 0);
      assert.equal(state.emptyIdentityCount, 0);
      assert.equal(state.visibleWordmark, null);
      assert.equal(state.barAriaLabel, "Patchmark application");
      assert.ok(state.actionsLeftGap <= 1, `${label} action group is not left aligned.`);
      if (state.navigationVisible) {
        assert.ok(
          state.navigationFileGap >= 0 && state.navigationFileGap <= 8,
          `${label} File menu does not follow document navigation.`
        );
      } else {
        assert.ok(state.fileLeftGap <= 1, `${label} File menu lost the bar inset.`);
      }
    }

    await capture(pageClient, `00-${label}-application-bar.png`);
    await clickVisibleButton(pageClient, "File");
    const menu = await waitForOpenMenu(pageClient, "File");
    assert.ok(menu.rect.left >= 0, `${label} File menu opened left of the viewport.`);
    assert.ok(menu.rect.right <= viewport.width, `${label} File menu opened right of the viewport.`);
    assert.ok(menu.rect.top >= 0, `${label} File menu opened above the viewport.`);
    assert.ok(menu.rect.bottom <= viewport.height, `${label} File menu opened below the viewport.`);
    await capture(pageClient, `00-${label}-file-menu-open.png`);
    await clickVisibleButton(pageClient, "File");
    await waitForMenuClosed(pageClient, "File");
    measurements[label] = { ...state, fileMenu: menu.rect, viewport };
  }
  writeFileSync(
    join(artifactRoot, "application-bar-measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`
  );
  return measurements;
}

async function captureApplicationMenuInteractionStates(pageClient) {
  await setViewport(pageClient, { height: 900, mobile: false, width: 1440 });
  await pageClient.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  const initialWrites = await fixtureWriteCount(pageClient);

  const fileTrigger = await exerciseTopLevelControl(pageClient, "File", "menu");
  await clickVisibleButton(pageClient, "File");
  await waitForOpenMenu(pageClient, "File");
  await movePointer(pageClient, { x: 1390, y: 890 });
  await capture(pageClient, "09-desktop-file-trigger-open.png");
  await focusBody(pageClient);
  const sectionPoint = await menuSectionPoint(pageClient, "Open");
  await movePointer(pageClient, sectionPoint);

  const resting = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  assertCompleteRow(resting, "Open Project Folder");
  await capture(pageClient, "10-desktop-menu-resting.png");

  const commandPoint = await visibleButtonPoint(
    pageClient,
    "Open Project Folder"
  );
  await movePointer(pageClient, commandPoint);
  const hovered = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  if (interactionStateBaselineAudit) {
    assert.equal(
      hovered.backgroundImage,
      resting.backgroundImage,
      "Baseline should reproduce the missing portaled-menu hover feedback"
    );
  } else {
    assert.notEqual(
      hovered.backgroundImage,
      resting.backgroundImage,
      "An enabled menu command needs visible hover feedback"
    );
    assert.match(hovered.backgroundImage, /rgba\(47, 111, 85, 0\.07\)/);
  }
  await capture(pageClient, "11-desktop-command-hovered.png");

  await movePointer(pageClient, sectionPoint);
  const restoredAfterHover = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  assert.equal(restoredAfterHover.backgroundImage, resting.backgroundImage);

  await clickVisibleButton(pageClient, "File");
  await waitForMenuClosed(pageClient, "File");
  await focusButton(pageClient, "File");
  await pressKey(pageClient, "Enter", "Enter", 13);
  await waitForOpenMenu(pageClient, "File");
  await waitFor(
    pageClient,
    "first File menu item focus for state audit",
    `document.activeElement?.textContent?.trim() === "Load Markdown"`
  );
  await pressKey(pageClient, "ArrowDown", "ArrowDown", 40);
  const keyboard = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  assert.equal(keyboard.focused, true);
  if (!interactionStateBaselineAudit) {
    assert.notEqual(keyboard.backgroundImage, resting.backgroundImage);
    assert.equal(keyboard.outlineStyle, "solid");
    assert.equal(keyboard.outlineWidth, "2px");
  }
  await capture(pageClient, "12-desktop-command-keyboard-highlighted.png");
  await pressKey(pageClient, "Escape", "Escape", 27);
  await waitForMenuClosed(pageClient, "File");
  assert.equal(await activeText(pageClient), "File");

  await clickVisibleButton(pageClient, "File");
  await waitForOpenMenu(pageClient, "File");
  await focusBody(pageClient);
  await movePointer(pageClient, sectionPoint);
  const reopened = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  assert.equal(
    reopened.backgroundImage,
    resting.backgroundImage,
    "Reopening a menu must not retain stale command highlighting"
  );
  await movePointer(pageClient, commandPoint);
  await mouseDown(pageClient, commandPoint);
  const pressed = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  if (interactionStateBaselineAudit) {
    assert.equal(
      pressed.backgroundImage,
      hovered.backgroundImage,
      "Baseline should reproduce the missing portaled-menu pressed feedback"
    );
  } else {
    assert.match(pressed.backgroundImage, /rgba\(22, 35, 29, 0\.14\)/);
    assert.notEqual(pressed.backgroundImage, hovered.backgroundImage);
  }
  await capture(pageClient, "13-desktop-command-held-down.png");
  await mouseUp(pageClient, sectionPoint);
  await movePointer(pageClient, sectionPoint);
  assert.equal(
    (await readMenuItemVisualState(pageClient, "Open Project Folder"))
      .backgroundImage,
    resting.backgroundImage
  );

  const sectionBefore = await readMenuSectionVisualState(pageClient, "Open");
  await movePointer(pageClient, sectionPoint);
  const sectionAfter = await readMenuSectionVisualState(pageClient, "Open");
  assert.deepEqual(sectionAfter, sectionBefore);
  await clickVisibleButton(pageClient, "File");
  await waitForMenuClosed(pageClient, "File");

  const reviewTrigger = await exerciseTopLevelControl(
    pageClient,
    "Review",
    "menu"
  );
  await clickVisibleButton(pageClient, "Review");
  await waitForOpenMenu(pageClient, "Review");
  await focusBody(pageClient);
  const disabledPoint = await visibleButtonPoint(
    pageClient,
    "Review patch proposals",
    true
  );
  const disabledResting = await readMenuItemVisualState(
    pageClient,
    "Review patch proposals"
  );
  await movePointer(pageClient, disabledPoint);
  await mouseDown(pageClient, disabledPoint);
  const disabledPressed = await readMenuItemVisualState(
    pageClient,
    "Review patch proposals"
  );
  await mouseUp(pageClient, disabledPoint);
  assert.equal(disabledResting.disabled, true);
  assert.equal(disabledPressed.backgroundImage, disabledResting.backgroundImage);
  if (!interactionStateBaselineAudit) {
    assert.equal(disabledResting.cursor, "not-allowed");
    assert.ok(Number(disabledResting.opacity) < 1);
  }
  assert.equal((await waitForOpenMenu(pageClient, "Review")).expanded, "true");
  await clickVisibleButton(pageClient, "Review");
  await waitForMenuClosed(pageClient, "Review");

  const commentsTrigger = await exerciseTopLevelControl(
    pageClient,
    "Comments",
    "surface"
  );
  for (const state of [
    commentsTrigger.resting,
    commentsTrigger.hovered,
    commentsTrigger.pressed,
    commentsTrigger.open,
    commentsTrigger.closed
  ]) {
    assert.ok(state.badgeContrast >= 4.5, "Comments badge contrast regressed");
  }

  const focusStates = {};
  await focusBody(pageClient);
  for (const label of ["File", "Review", "Comments"]) {
    await pressKey(pageClient, "Tab", "Tab", 9);
    const state = await readTopLevelControlVisualState(pageClient, label);
    assert.equal(state.focused, true);
    assert.equal(state.outlineStyle, "solid");
    assert.equal(state.outlineWidth, "2px");
    focusStates[label] = state;
  }

  await pageClient.call("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
    media: "screen"
  });
  assert.equal(
    await evaluate(pageClient, {
      expression: `matchMedia("(forced-colors: active)").matches`
    }),
    true
  );
  await focusButton(pageClient, "File");
  await pressKey(pageClient, "Enter", "Enter", 13);
  await waitForOpenMenu(pageClient, "File");
  await waitFor(
    pageClient,
    "forced-colors first menu item focus",
    `document.activeElement?.textContent?.trim() === "Load Markdown"`
  );
  const forcedColors = await readMenuItemVisualState(pageClient, "Load Markdown");
  assert.equal(forcedColors.outlineStyle, "solid");
  assert.equal(forcedColors.outlineWidth, "2px");
  await capture(pageClient, "17-forced-colors-keyboard-highlight.png");
  await pressKey(pageClient, "Escape", "Escape", 27);
  await waitForMenuClosed(pageClient, "File");
  await pageClient.call("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "none" }],
    media: "screen"
  });

  await pageClient.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  await setViewport(pageClient, { height: 844, mobile: true, width: 393 });
  await touchButton(pageClient, "File");
  await waitForOpenMenu(pageClient, "File");
  await focusBody(pageClient);
  const mobileResting = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  const mobilePoint = await visibleButtonPoint(
    pageClient,
    "Open Project Folder"
  );
  const mobileSectionPoint = await menuSectionPoint(pageClient, "Open");
  await movePointer(pageClient, mobilePoint, "pen");
  await mouseDown(pageClient, mobilePoint, "pen");
  const mobilePressed = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  if (!interactionStateBaselineAudit) {
    assert.match(mobilePressed.backgroundImage, /rgba\(22, 35, 29, 0\.14\)/);
  }
  await capture(pageClient, "14-mobile-command-held-down.png");
  await mouseUp(pageClient, mobileSectionPoint, "pen");
  await movePointer(pageClient, mobileSectionPoint, "pen");
  await delay(120);
  const mobileReleased = await readMenuItemVisualState(
    pageClient,
    "Open Project Folder"
  );
  assert.equal(
    mobileReleased.backgroundImage,
    mobileResting.backgroundImage,
    "Touch-width release must not leave a sticky synthetic hover"
  );
  await capture(pageClient, "15-mobile-menu-after-release.png");

  await setViewport(pageClient, { height: 844, mobile: true, width: 320 });
  const wrapped = await readMenuItemVisualState(
    pageClient,
    "Create Project From Existing Patchmark Projects"
  );
  assertCompleteRow(wrapped, "wrapped compact command");
  assert.ok(wrapped.rect.height > 40, "The long compact label should wrap");
  assert.ok(wrapped.scrollWidth <= wrapped.clientWidth);
  await capture(pageClient, "16-compact-wrapped-command.png");
  await touchButton(pageClient, "File");
  await waitForMenuClosed(pageClient, "File");

  await pageClient.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await setViewport(pageClient, { height: 900, mobile: false, width: 1440 });

  assert.equal(
    await fixtureWriteCount(pageClient),
    initialWrites,
    "Hover, focus, pressed, and open-state checks must not persist data"
  );

  return {
    commentsTrigger,
    disabled: {
      pressed: disabledPressed,
      resting: disabledResting
    },
    fileTrigger,
    focusStates,
    forcedColors,
    initialWrites,
    keyboard,
    mobile: {
      pressed: mobilePressed,
      released: mobileReleased,
      resting: mobileResting
    },
    pointer: {
      hovered,
      pressed,
      reopened,
      resting,
      restoredAfterHover
    },
    reviewTrigger,
    wrapped,
    writesAfterStates: await fixtureWriteCount(pageClient)
  };
}

async function exerciseTopLevelControl(pageClient, label, kind) {
  const resting = await readTopLevelControlVisualState(pageClient, label);
  const point = await visibleButtonPoint(pageClient, label);
  await movePointer(pageClient, point);
  const hovered = await readTopLevelControlVisualState(pageClient, label);
  assert.notEqual(hovered.backgroundImage, resting.backgroundImage);
  await mouseDown(pageClient, point);
  const pressed = await readTopLevelControlVisualState(pageClient, label);
  assert.match(pressed.backgroundImage, /rgba\(22, 35, 29, 0\.14\)/);
  await mouseUp(pageClient, point);
  if (kind === "menu") {
    await waitForOpenMenu(pageClient, label);
  } else {
    await waitFor(
      pageClient,
      `${label} surface open`,
      `document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "true"`
    );
  }
  await movePointer(pageClient, { x: 1390, y: 890 });
  const open = await readTopLevelControlVisualState(pageClient, label);
  assert.equal(open.ariaExpanded, "true");
  assert.notEqual(open.backgroundColor, resting.backgroundColor);
  await clickVisibleButton(pageClient, label);
  if (kind === "menu") {
    await waitForMenuClosed(pageClient, label);
  } else {
    await waitFor(
      pageClient,
      `${label} surface closed`,
      `document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "false"`
    );
  }
  await movePointer(pageClient, { x: 1390, y: 890 });
  await delay(80);
  const closed = await readTopLevelControlVisualState(pageClient, label);
  assert.equal(closed.backgroundImage, resting.backgroundImage);
  assert.equal(closed.backgroundColor, resting.backgroundColor);
  return { closed, hovered, open, pressed, resting };
}

function assertCompleteRow(state, label) {
  assert.ok(
    Math.abs(state.rect.width - state.groupContentWidth) <= 1,
    `${label} does not fill the usable command-row width`
  );
  assert.ok(state.rect.left >= state.panelRect.left);
  assert.ok(state.rect.right <= state.panelRect.right);
}

async function readMenuItemVisualState(pageClient, label) {
  return evaluate(pageClient, {
    expression: `(() => {
      const item = Array.from(document.querySelectorAll("[role='menuitem']"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} && candidate.getClientRects().length > 0);
      if (!(item instanceof HTMLElement)) throw new Error("Visible menu item not found: ${escapeJs(label)}");
      const group = item.closest(".application-menu-group");
      const panel = item.closest(".application-menu-panel");
      const style = getComputedStyle(item);
      const groupStyle = getComputedStyle(group);
      const rect = item.getBoundingClientRect();
      const groupRect = group.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
        clientWidth: item.clientWidth,
        cursor: style.cursor,
        disabled: item instanceof HTMLButtonElement && item.disabled,
        focused: document.activeElement === item,
        groupContentWidth: groupRect.width - parseFloat(groupStyle.paddingLeft) - parseFloat(groupStyle.paddingRight),
        opacity: style.opacity,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        panelRect: {
          bottom: panelRect.bottom,
          left: panelRect.left,
          right: panelRect.right,
          top: panelRect.top
        },
        rect: {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width
        },
        scrollWidth: item.scrollWidth
      };
    })()`
  });
}

async function readMenuSectionVisualState(pageClient, label) {
  return evaluate(pageClient, {
    expression: `(() => {
      const section = Array.from(document.querySelectorAll(".application-menu-group-label"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} && candidate.getClientRects().length > 0);
      const style = getComputedStyle(section);
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        cursor: style.cursor,
        role: section.getAttribute("role")
      };
    })()`
  });
}

async function readTopLevelControlVisualState(pageClient, label) {
  return evaluate(pageClient, {
    expression: `(() => {
      const control = ${label === "Comments"
        ? 'document.querySelector(".application-comments-trigger")'
        : `Array.from(document.querySelectorAll(".application-menu-trigger")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)})`};
      if (!(control instanceof HTMLElement)) throw new Error("Top-level control not found: ${escapeJs(label)}");
      const style = getComputedStyle(control);
      const badge = control.querySelector(".application-comments-count");
      const badgeStyle = badge ? getComputedStyle(badge) : null;
      const parseRgb = (value) => (value.match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = parseRgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const badgeContrast = badgeStyle
        ? (Math.max(luminance(badgeStyle.color), luminance(badgeStyle.backgroundColor)) + 0.05) /
          (Math.min(luminance(badgeStyle.color), luminance(badgeStyle.backgroundColor)) + 0.05)
        : null;
      return {
        ariaExpanded: control.getAttribute("aria-expanded"),
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        badgeBackgroundColor: badgeStyle?.backgroundColor ?? null,
        badgeColor: badgeStyle?.color ?? null,
        badgeContrast,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        focused: document.activeElement === control,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    })()`
  });
}

async function fixtureWriteCount(pageClient) {
  return evaluate(pageClient, {
    expression: "window.__patchmarkFixtureWriteLog?.length ?? 0"
  });
}

async function focusBody(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      return document.activeElement === document.body;
    })()`
  });
}

async function menuSectionPoint(pageClient, label) {
  return evaluate(pageClient, {
    expression: `(() => {
      const section = Array.from(document.querySelectorAll(".application-menu-group-label"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} && candidate.getClientRects().length > 0);
      const rect = section.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
}

async function readApplicationBarAccessibility(pageClient) {
  const tree = await pageClient.call("Accessibility.getFullAXTree");
  const nodesForRole = (role) =>
    tree.nodes
      .filter((node) => node.role?.value === role && !node.ignored);
  const namesForRole = (role) =>
    nodesForRole(role)
      .map((node) => node.name?.value ?? "")
      .filter(Boolean);
  return {
    bannerCount: nodesForRole("banner").length,
    banners: namesForRole("banner"),
    buttons: namesForRole("button"),
    navigations: namesForRole("navigation")
  };
}

async function waitForOpenMenu(pageClient, label) {
  return waitFor(
    pageClient,
    `${label} menu open`,
    `(() => {
      const trigger = Array.from(document.querySelectorAll(".application-menu-trigger"))
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
      const menu = trigger
        ? document.getElementById(trigger.getAttribute("aria-controls"))
        : null;
      if (!trigger || !menu || menu.hidden) return null;
      const rect = menu.getBoundingClientRect();
      return {
        expanded: trigger.getAttribute("aria-expanded"),
        enabledLabels: Array.from(menu.querySelectorAll("[role='menuitem']"))
          .filter((item) => !item.disabled)
          .map((item) => item.textContent.trim()),
        labels: Array.from(menu.querySelectorAll("[role='menuitem']"))
          .map((item) => item.textContent.trim()),
        rect: {
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top)
        }
      };
    })()`
  );
}

async function waitForMenuClosed(pageClient, label) {
  await waitFor(
    pageClient,
    `${label} menu closed`,
    `(() => {
      const trigger = Array.from(document.querySelectorAll(".application-menu-trigger"))
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
      const menu = trigger
        ? document.getElementById(trigger.getAttribute("aria-controls"))
        : null;
      return trigger?.getAttribute("aria-expanded") === "false" && menu?.hidden;
    })()`
  );
}

async function clickVisibleButton(pageClient, label) {
  const point = await visibleButtonPoint(pageClient, label);
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function visibleButtonPoint(pageClient, label, includeDisabled = false) {
  return evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => (candidate.textContent?.trim() === ${JSON.stringify(label)} ||
          (${JSON.stringify(label)} === "Comments" && candidate.classList.contains("application-comments-trigger"))) &&
          ${includeDisabled ? "true" : "!candidate.disabled"} && candidate.getClientRects().length > 0);
      if (!button) throw new Error("Visible button not found: ${escapeJs(label)}");
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
}

async function movePointer(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    pointerType,
    type: "mouseMoved",
    x: point.x,
    y: point.y
  });
}

async function mouseDown(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
}

async function mouseUp(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function touchButton(pageClient, label) {
  const point = await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} &&
          !candidate.disabled && candidate.getClientRects().length > 0);
      if (!button) throw new Error("Touch button not found: ${escapeJs(label)}");
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
  await pageClient.call("Input.dispatchTouchEvent", {
    touchPoints: [{ x: point.x, y: point.y }],
    type: "touchStart"
  });
  await pageClient.call("Input.dispatchTouchEvent", {
    touchPoints: [],
    type: "touchEnd"
  });
}

async function clickOutsideMenu(pageClient) {
  const point = await evaluate(pageClient, {
    expression: `(() => {
      const rect = document.querySelector(".document-workspace").getBoundingClientRect();
      return { x: rect.left + 10, y: rect.bottom - 10 };
    })()`
  });
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function focusButton(pageClient, label) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} &&
          candidate.getClientRects().length > 0);
      button?.focus();
      return document.activeElement === button;
    })()`
  });
}

async function pressKey(pageClient, key, code, keyCode) {
  const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: keyCode,
    type: "rawKeyDown",
    windowsVirtualKeyCode: keyCode
  });
  if (text) {
    await pageClient.call("Input.dispatchKeyEvent", {
      key,
      nativeVirtualKeyCode: keyCode,
      text,
      type: "char",
      unmodifiedText: text,
      windowsVirtualKeyCode: keyCode
    });
  }
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: keyCode,
    type: "keyUp",
    windowsVirtualKeyCode: keyCode
  });
}

async function activeText(pageClient) {
  return evaluate(pageClient, {
    expression: "document.activeElement?.textContent?.trim() ?? ''"
  });
}

async function triggerBackground(pageClient, label) {
  return evaluate(pageClient, {
    expression: `(() => {
      const trigger = Array.from(document.querySelectorAll(".application-menu-trigger"))
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
      return getComputedStyle(trigger).backgroundImage;
    })()`
  });
}

async function downloadCount(pageClient) {
  return evaluate(pageClient, {
    expression: "window.__patchmarkPhase2Downloads.length"
  });
}

async function capture(pageClient, fileName) {
  const screenshot = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(join(artifactRoot, fileName), Buffer.from(screenshot.data, "base64"));
}

async function setViewport(pageClient, { height, mobile, width }) {
  await pageClient.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile,
    width
  });
  await delay(100);
}

async function waitFor(pageClient, label, expression) {
  let latestValue = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latestValue = await evaluate(pageClient, { expression });
    if (latestValue) {
      return latestValue;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.\n${JSON.stringify(latestValue)}`);
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for safe fixture file ${path}.`);
}

function createProjectFixture(root) {
  const metadata = join(root, ".patchmark");
  const documentId = "doc_phase2";
  const now = "2026-08-09T00:00:00.000Z";
  mkdirSync(join(metadata, "documents", documentId, "versions"), {
    recursive: true
  });
  for (const directory of ["context-packs", "imports", "recovery"]) {
    mkdirSync(join(metadata, "documents", documentId, directory), {
      recursive: true
    });
  }
  writeFileSync(join(root, "shell-audit.md"), "# Shell Audit\n\nSafe fixture.\n");
  writeFileSync(
    join(metadata, "project.json"),
    `${JSON.stringify(
      {
        format: "patchmark-project",
        schema_version: 2,
        project_id: "prj_phase2_shell",
        title: "Phase 2 Existing",
        created_at: now,
        manifest_revision: 1,
        groups: [],
        documents: [
          {
            document_id: documentId,
            path: "shell-audit.md",
            display_title: "Shell Audit",
            group_id: null,
            role: "research",
            status: "active",
            position: 1000,
            added_at: now,
            archived_at: null
          }
        ]
      },
      null,
      2
    )}\n`
  );
  const store = join(metadata, "documents", documentId);
  writeFileSync(
    join(store, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        project_id: "prj_phase2_shell",
        document_id: documentId,
        project_name: "Phase 2 Existing",
        document_file: "document.md",
        created_at: now,
        updated_at: now
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(store, "comments.json"), "[]\n");
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(
    join(store, "document.json"),
    `${JSON.stringify(
      {
        format: "patchmark-document-store",
        schema_version: 1,
        document_id: documentId,
        created_at: now,
        source: "created"
      },
      null,
      2
    )}\n`
  );
}

function escapeJs(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

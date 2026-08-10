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
const artifactRoot =
  process.env.PATCHMARK_PHASE2_ARTIFACT_ROOT ??
  mkdtempSync(join(tmpdir(), "patchmark-application-shell-artifacts-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-shell-fixture-"));
const newProjectDir = join(fixtureRoot, "new-project");
const existingProjectDir = join(fixtureRoot, "existing-project");

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
  await capture(client, "05-relocated-pdf-export-activated.png");
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
  await clickVisibleButton(client, "Cancel");

  await openMenuItem(client, "Review", "Guided Review");
  await waitFor(
    client,
    "Guided Review wizard",
    `Boolean(document.querySelector("[aria-label='Guided Review Wizard']"))`
  );
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
    artifacts: artifactRoot,
    desktop: desktopShell,
    mobile: mobileShell,
    narrow: narrowShell
  };
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
      const identity = document.querySelector(".application-identity");
      const controls = Array.from(document.querySelectorAll(".application-menu-trigger"));
      const controlRects = controls.map(rect);
      return {
        bar: rect(bar),
        controls: controls.map((control) => control.textContent.trim()),
        headerWrapped: controlRects.some((control) =>
          Math.abs(control.top - rect(identity).top) > 10
        ),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        triggerHeight: Math.min(...controlRects.map((control) => control.height)),
        workspace: rect(document.querySelector(".document-workspace"))
      };
    })()`
  });
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
  const point = await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} &&
          !candidate.disabled && candidate.getClientRects().length > 0);
      if (!button) throw new Error("Visible button not found: ${escapeJs(label)}");
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
      return { x: rect.left + 10, y: rect.top + 10 };
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

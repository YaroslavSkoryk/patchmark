import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3118/";
const evidenceDir = process.env.PATCHMARK_PHASE3_EVIDENCE_DIR;
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-navigation-browser-"));
const projectTitle =
  "Patchmark navigation project with an intentionally long descriptive name";
createNavigationFixture(fixtureRoot, projectTitle);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for project navigation browser tests.");
}

await assertEditorIsReachable(editorUrl);
if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
}

const userDataDir = mkdtempSync(
  join(tmpdir(), "patchmark-navigation-browser-chrome-")
);
const chrome = spawn(
  chromePath,
  [
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
      projectName: projectTitle
    })
  });
  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelectorAll(".project-document-item").length === 3`,
    "three navigation documents"
  );

  const desktop = await readNavigationState(client);
  assert.equal(desktop.appBarHeight, 56);
  assert.equal(desktop.sidebarWidth, 272);
  assert.equal(desktop.activeTitle, "Action Plan");
  assert.equal(desktop.activeAriaCurrent, "page");
  assert.equal(desktop.horizontalOverflow, false);
  assert.equal(desktop.projectTitleAttribute, projectTitle);
  assert.deepEqual(desktop.rowControlCounts, [2, 2, 2]);
  await capture(client, "04-desktop-long-name-navigation.png");

  await clickProjectToggle(client);
  assert.equal(
    await readAttribute(client, ".project-navigation-project-toggle", "aria-expanded"),
    "false"
  );
  await clickProjectToggle(client);
  assert.equal(
    await readAttribute(client, ".project-navigation-project-toggle", "aria-expanded"),
    "true"
  );

  const addDocumentCount = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll("summary"))
      .filter((summary) => summary.textContent?.trim() === "Add document").length`
  });
  assert.equal(addDocumentCount, 1);

  const actionTrigger = await getRect(
    client,
    `button[aria-label="Actions for Action Plan"]`
  );
  await clickPoint(client, actionTrigger);
  await waitForOpenNavigationMenu(client);
  const pointerMenuState = await evaluate(client, {
    expression: `(() => {
      const panel = document.querySelector(".project-navigation-menu-panel:not([hidden])");
      return {
        archiveDestructive: panel?.querySelector(".project-navigation-menu-item-destructive")?.textContent?.trim(),
        labels: Array.from(panel?.querySelectorAll("[role='menuitem']") ?? []).map((item) => item.textContent?.trim()),
        moveUpDisabled: Array.from(panel?.querySelectorAll("[role='menuitem']") ?? [])
          .find((item) => item.textContent?.trim() === "Move up")?.disabled
      };
    })()`
  });
  assert.equal(pointerMenuState.archiveDestructive, "Archive");
  assert.equal(pointerMenuState.moveUpDisabled, true);
  assert.deepEqual(pointerMenuState.labels, [
    "Move up",
    "Move down",
    "Rename",
    "Change role",
    "Archive"
  ]);
  await capture(client, "05-desktop-document-menu.png");

  const editorPoint = await getRect(client, ".document-toolbar");
  await clickPoint(client, editorPoint);
  await waitForClosedNavigationMenus(client);

  await focusSelector(client, `button[aria-label="Actions for Action Plan"]`);
  await pressKey(client, "ArrowDown");
  await waitForOpenNavigationMenu(client);
  await waitFor(
    client,
    `document.activeElement?.textContent?.trim() === "Move down"`,
    "first enabled document menu item focus"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.textContent?.trim()`
    }),
    "Move down"
  );
  await pressKey(client, "Escape");
  await waitForClosedNavigationMenus(client);
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.getAttribute("aria-label")`
    }),
    "Actions for Action Plan"
  );

  await openMenuAndChoose(client, "Actions for Action Plan", "Rename");
  await waitFor(client, `Boolean(document.querySelector("input[aria-label='Document name'], .project-document-item input"))`, "rename editor");
  await capture(client, "06-desktop-rename-edit.png");
  await clickInlineAction(client, "Action Plan", "Cancel");
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.getAttribute("aria-label")`
    }),
    "Actions for Action Plan"
  );

  await openMenuAndChoose(client, "Actions for Action Plan", "Change role");
  await evaluate(client, {
    expression: `(() => {
      const select = document.querySelector("select[aria-label='Role for Action Plan']");
      if (!select) throw new Error("Role editor missing.");
      select.value = "evidence";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const save = Array.from(select.closest("form")?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.trim() === "Save");
      save?.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitForManifest(client, fixtureRoot, (manifest) =>
    manifest.documents.find(({ document_id }) => document_id === "doc_action")
      ?.role === "evidence"
  );

  const editorWidthBeforeCollapse = await readRectWidth(client, ".editor-panel");
  await clickSelector(client, ".document-navigation-close");
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === true`,
    "collapsed desktop navigation"
  );
  const editorWidthAfterCollapse = await readRectWidth(client, ".editor-panel");
  assert.ok(editorWidthAfterCollapse > editorWidthBeforeCollapse + 200);
  assert.equal(
    await isVisible(client, ".application-navigation-trigger"),
    true
  );
  await capture(client, "07-desktop-navigation-collapsed.png");
  await clickSelector(client, ".application-navigation-trigger");
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === false`,
    "restored desktop navigation"
  );

  await setViewport(client, { height: 900, mobile: false, width: 900 });
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === true`,
    "closed narrow navigation"
  );
  assert.equal((await readNavigationState(client)).horizontalOverflow, false);
  await capture(client, "08-narrow-navigation-closed.png");

  await setViewport(client, { height: 852, mobile: true, width: 393 });
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });
  assert.equal((await readNavigationState(client)).horizontalOverflow, false);
  await capture(client, "09-mobile-navigation-closed.png");

  const mobileTrigger = await getRect(client, ".application-navigation-trigger");
  await touchPoint(client, mobileTrigger);
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.getAttribute("role") === "dialog"`,
    "open mobile navigation drawer"
  );
  const mobileOpenState = await evaluate(client, {
    expression: `(() => ({
      activeElement: document.activeElement?.getAttribute("aria-label"),
      ariaModal: document.querySelector(".document-sidebar")?.getAttribute("aria-modal"),
      bodyOverflow: document.body.style.overflow,
      drawer: (() => {
        const rect = document.querySelector(".document-sidebar")?.getBoundingClientRect();
        return rect ? { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top } : null;
      })()
    }))()`
  });
  assert.equal(mobileOpenState.activeElement, "Close document navigation");
  assert.equal(mobileOpenState.ariaModal, "true");
  assert.equal(mobileOpenState.bodyOverflow, "hidden");
  assert.ok(mobileOpenState.drawer.right <= 393);
  await delay(350);
  assert.equal(
    await evaluate(client, {
      expression: `getComputedStyle(document.querySelector(".application-navigation-trigger")).backgroundImage`
    }),
    "none"
  );
  await capture(client, "10-mobile-navigation-open.png");

  const mobileDocumentMenu = await getRect(
    client,
    `button[aria-label="Actions for Action Plan"]`
  );
  await touchPoint(client, mobileDocumentMenu);
  await waitForOpenNavigationMenu(client);
  await waitFor(
    client,
    `document.activeElement?.getAttribute("role") === "menuitem"`,
    "mobile document menu focus"
  );
  await delay(350);
  await capture(client, "11-mobile-document-menu.png");
  await pressKey(client, "Tab");
  await waitForClosedNavigationMenus(client);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector(".document-sidebar")?.contains(document.activeElement)`
    }),
    true
  );
  await touchPoint(
    client,
    await getRect(client, `button[aria-label="Actions for Action Plan"]`)
  );
  await waitForOpenNavigationMenu(client);
  await waitFor(
    client,
    `document.activeElement?.getAttribute("role") === "menuitem"`,
    "reopened mobile document menu focus"
  );
  await pressKey(client, "Escape");
  await waitForClosedNavigationMenus(client);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector(".document-sidebar")?.hidden`
    }),
    false
  );
  await pressKey(client, "Escape");
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === true`,
    "Escape-closed mobile navigation"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.classList.contains("application-navigation-trigger")`
    }),
    true
  );

  await touchPoint(client, await getRect(client, ".application-navigation-trigger"));
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === false`,
    "reopened mobile navigation"
  );
  await clickDocument(client, "Notes");
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === true && document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Notes"`,
    "mobile selection closes navigation"
  );
  assert.equal((await readNavigationState(client)).horizontalOverflow, false);

  await setViewport(client, { height: 1000, mobile: false, width: 1440 });
  await client.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await waitFor(
    client,
    `document.querySelector(".document-sidebar")?.hidden === false`,
    "desktop navigation before Add Document"
  );
  await evaluate(client, {
    expression: `(() => {
      const addSummary = Array.from(document.querySelectorAll("summary"))
        .find((summary) => summary.textContent?.trim() === "Add document");
      addSummary?.click();
      const createSummary = Array.from(document.querySelectorAll("summary"))
        .find((summary) => summary.textContent?.trim() === "Create new document");
      createSummary?.click();
      const form = createSummary?.parentElement?.querySelector("form");
      const labels = Array.from(form?.querySelectorAll("label") ?? []);
      const titleInput = labels.find((label) => label.textContent?.includes("Display title"))?.querySelector("input");
      const pathInput = labels.find((label) => label.textContent?.includes("Relative Markdown path"))?.querySelector("input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!titleInput || !pathInput || !setter) throw new Error("Add document form unavailable.");
      setter.call(titleInput, "Created from navigation");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(pathInput, "created-from-navigation.md");
      pathInput.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = Array.from(form?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.trim() === "Create document");
      submit?.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitForManifest(client, fixtureRoot, (manifest) =>
    manifest.documents.some(
      ({ display_title }) => display_title === "Created from navigation"
    )
  );

  process.stdout.write(
    `${JSON.stringify({
      activeDocumentSemantics: true,
      desktopCollapse: true,
      documentMenuKeyboard: true,
      longNames: true,
      mobileDrawer: true,
      navigation: true,
      touchOpen: true
    })}\n`
  );
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function readNavigationState(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const active = document.querySelector(".project-document-item[data-active='true']");
      return {
        activeAriaCurrent: active?.querySelector(".project-document-select")?.getAttribute("aria-current") ?? null,
        activeTitle: active?.querySelector(".project-document-select span")?.textContent ?? null,
        appBarHeight: Math.round(rect(".application-bar")?.height ?? 0),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        projectTitleAttribute: document.querySelector(".project-navigation-project-toggle strong")?.getAttribute("title") ?? null,
        rowControlCounts: Array.from(document.querySelectorAll(".project-document-item"))
          .filter((item) => item.getClientRects().length > 0)
          .map((item) => Array.from(item.querySelectorAll(":scope > .project-document-row-main button"))
            .filter((button) => button.getClientRects().length > 0).length),
        sidebarWidth: Math.round(rect(".document-sidebar")?.width ?? 0)
      };
    })()`
  });
}

async function clickProjectToggle(pageClient) {
  await clickSelector(pageClient, ".project-navigation-project-toggle");
}

async function clickDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent === ${JSON.stringify(title)} && !candidate.disabled);
      if (!button) throw new Error("Document not available: " + ${JSON.stringify(title)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function openMenuAndChoose(pageClient, triggerLabel, itemLabel) {
  await clickSelector(
    pageClient,
    `button[aria-label=${JSON.stringify(triggerLabel)}]`
  );
  await waitForOpenNavigationMenu(pageClient);
  await evaluate(pageClient, {
    expression: `(() => {
      const panel = document.querySelector(".project-navigation-menu-panel:not([hidden])");
      const item = Array.from(panel?.querySelectorAll("[role='menuitem']") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(itemLabel)} && !candidate.disabled);
      if (!item) throw new Error("Menu item unavailable: " + ${JSON.stringify(itemLabel)});
      item.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickInlineAction(pageClient, title, action) {
  await evaluate(pageClient, {
    expression: `(() => {
      const article = Array.from(document.querySelectorAll(".project-document-item"))
        .find((candidate) => candidate.querySelector(".project-document-select span")?.textContent === ${JSON.stringify(title)});
      const button = Array.from(article?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(action)});
      if (!button) throw new Error("Inline action unavailable.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await delay(50);
}

async function clickSelector(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
      element.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function focusSelector(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
      element.focus();
      return true;
    })()`
  });
}

async function getRect(pageClient, selector) {
  const rect = await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || !element.getClientRects().length) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
  if (!rect) {
    throw new Error(`Visible selector not found: ${selector}`);
  }
  return rect;
}

async function clickPoint(pageClient, point) {
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function touchPoint(pageClient, point) {
  await pageClient.call("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, radiusX: 6, radiusY: 6, x: point.x, y: point.y }],
    type: "touchStart"
  });
  await pageClient.call("Input.dispatchTouchEvent", {
    touchPoints: [],
    type: "touchEnd"
  });
}

async function pressKey(pageClient, key) {
  const codes = {
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    Enter: { code: "Enter", keyCode: 13 },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 }
  };
  const keyData = codes[key];
  await pageClient.call("Input.dispatchKeyEvent", {
    code: keyData.code,
    key,
    nativeVirtualKeyCode: keyData.keyCode,
    type: "keyDown",
    windowsVirtualKeyCode: keyData.keyCode
  });
  await pageClient.call("Input.dispatchKeyEvent", {
    code: keyData.code,
    key,
    nativeVirtualKeyCode: keyData.keyCode,
    type: "keyUp",
    windowsVirtualKeyCode: keyData.keyCode
  });
}

async function readAttribute(pageClient, selector, attribute) {
  return evaluate(pageClient, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attribute)}) ?? null`
  });
}

async function readRectWidth(pageClient, selector) {
  return evaluate(pageClient, {
    expression: `Math.round(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width ?? 0)`
  });
}

async function isVisible(pageClient, selector) {
  return evaluate(pageClient, {
    expression: `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`
  });
}

async function waitForOpenNavigationMenu(pageClient) {
  await waitFor(
    pageClient,
    `Boolean(document.querySelector(".project-navigation-menu-panel:not([hidden])"))`,
    "open project navigation menu"
  );
}

async function waitForClosedNavigationMenus(pageClient) {
  await waitFor(
    pageClient,
    `!document.querySelector(".project-navigation-menu-panel:not([hidden])")`,
    "closed project navigation menus"
  );
}

async function waitFor(pageClient, expression, label) {
  let latest = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await evaluate(pageClient, { expression: `Boolean(${expression})` });
    if (latest) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForManifest(pageClient, root, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const manifest = JSON.parse(
      readFileSync(join(root, ".patchmark", "project.json"), "utf8")
    );
    if (predicate(manifest)) {
      return;
    }
    await evaluate(pageClient, { expression: "true" });
    await delay(50);
  }
  throw new Error("Timed out waiting for project manifest update.");
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

async function capture(pageClient, fileName) {
  if (!evidenceDir) {
    return;
  }
  const screenshot = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(evidenceDir, fileName), Buffer.from(screenshot.data, "base64"));
}

function createNavigationFixture(root, title) {
  const metadata = join(root, ".patchmark");
  const documentsRoot = join(metadata, "documents");
  mkdirSync(documentsRoot, { recursive: true });
  const now = "2026-08-10T00:00:00.000Z";
  const documents = [
    createDocumentFixture({
      displayTitle: "Action Plan",
      documentId: "doc_action",
      markdown: "# Action Plan\n\nDecision body.\n",
      now,
      path: "action-plan.md",
      position: 1000,
      role: "decision",
      root,
      title
    }),
    createDocumentFixture({
      displayTitle: "Notes",
      documentId: "doc_notes",
      markdown: "# Notes\n\nResearch notes.\n",
      now,
      path: "notes.md",
      position: 2000,
      role: "research",
      root,
      title
    }),
    createDocumentFixture({
      displayTitle:
        "A document title long enough to verify safe navigation truncation",
      documentId: "doc_long",
      markdown: "# Long document\n\nLong-name fixture.\n",
      now,
      path: "long-document-name-for-navigation-regression.md",
      position: 3000,
      role: "summary",
      root,
      title
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    `${JSON.stringify(
      {
        created_at: now,
        documents,
        format: "patchmark-project",
        manifest_revision: 1,
        project_id: "prj_navigation",
        schema_version: 1,
        title
      },
      null,
      2
    )}\n`
  );
}

function createDocumentFixture({
  displayTitle,
  documentId,
  markdown,
  now,
  path: documentPath,
  position,
  role,
  root,
  title
}) {
  writeFileSync(join(root, documentPath), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  for (const directory of [
    "versions",
    "context-packs",
    "imports",
    "recovery"
  ]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  writeFileSync(
    join(store, "manifest.json"),
    `${JSON.stringify(
      {
        created_at: now,
        document_file: "document.md",
        document_id: documentId,
        project_id: "prj_navigation",
        project_name: title,
        schema_version: 1,
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
        created_at: now,
        document_id: documentId,
        format: "patchmark-document-store",
        schema_version: 1,
        source: "created"
      },
      null,
      2
    )}\n`
  );
  return {
    added_at: now,
    archived_at: null,
    display_title: displayTitle,
    document_id: documentId,
    path: documentPath,
    position,
    role,
    status: "active"
  };
}

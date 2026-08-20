import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
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
import { createDocumentSwitchProject } from "./lib/fixtures/create-document-switch-project.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const expectation = process.env.PATCHMARK_COMPACT_HEADER_EXPECT ?? "after";
const artifactRoot =
  process.env.PATCHMARK_COMPACT_HEADER_ARTIFACT_ROOT ??
  mkdtempSync(join(tmpdir(), "patchmark-compact-top-panel-artifacts-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-compact-top-panel-fixture-"));
const fixture = createDocumentSwitchProject(fixtureRoot, {
  bookmarkDocumentIndex: 0,
  commentCountPerDocument: 3,
  documentCount: 3,
  documentProfiles: [
    {
      codeBlockCount: 5,
      commentCount: 3,
      headingCount: 5,
      historyCount: 2,
      paragraphCount: 28,
      paragraphRepeatCount: 3,
      patchCount: 4,
      structuredCellRepeatCount: 2,
      structuredTableCount: 3,
      structuredTableRowsPerTable: 4
    },
    {
      commentCount: 2,
      headingCount: 4,
      historyCount: 2,
      paragraphCount: 24,
      paragraphRepeatCount: 2,
      patchCount: 3
    },
    {
      commentCount: 1,
      headingCount: 3,
      historyCount: 1,
      paragraphCount: 18,
      paragraphRepeatCount: 2,
      patchCount: 2
    }
  ],
  historyCountPerDocument: 2,
  paragraphCountPerDocument: 24,
  paragraphRepeatCount: 2,
  patchCountPerDocument: 3,
  seed: "compact-top-panel-v1"
});

const longNames = applyLongFixtureNames(fixtureRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory, {
  persistWrites: true
});
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for compact top-panel browser tests.");
}

mkdirSync(artifactRoot, { recursive: true });
await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-compact-top-panel-chrome-"));
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
  const browserUrl = await waitForDevToolsUrl(chrome);
  const pageUrl = await createPage(browserUrl, "about:blank");
  client = await CdpClient.connect(pageUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: longNames.projectTitle
    })}
      (() => {
        const clipboardWrites = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => clipboardWrites.push(String(value))
          }
        });
        window.__patchmarkCompactClipboardWrites = clipboardWrites;
      })();`
  });

  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await activateMenuItem("File", "Open Project Folder");
  await waitFor(
    "long fixture project",
    expectation === "before"
      ? `document.querySelector(".document-meta strong")?.textContent?.includes(${JSON.stringify(longNames.documentTitles[0])})`
      : `document.querySelector(".application-document-breadcrumb")?.getAttribute("title") === ${JSON.stringify(longNames.fullPath)}`
  );
  await waitForDocumentReady(
    longNames.documentTitles[0],
    longNames.contentMarkers[0]
  );

  const visualDesktop = await captureGeometry("01-desktop-visual.png");
  await clickButton("Markdown Mode");
  await waitFor("Markdown editor", `Boolean(document.querySelector(".markdown-source-editor"))`);
  const markdownDesktop = await captureGeometry("02-desktop-markdown.png");

  await setViewport({ height: 900, mobile: false, width: 900 });
  const laptop = await captureGeometry("03-laptop-markdown.png");
  await setViewport({ height: 900, mobile: false, width: 768 });
  const tablet = await captureGeometry("04-tablet-markdown.png");
  await setViewport({ height: 844, mobile: true, width: 393 });
  const mobile = await captureGeometry("05-mobile-markdown.png");
  await setViewport({ height: 844, mobile: true, width: 320 });
  const compact = await captureGeometry("06-compact-320-markdown.png");

  const geometry = {
    compact,
    laptop,
    markdownDesktop,
    mobile,
    tablet,
    visualDesktop
  };

  if (expectation === "after") {
    assertAfterGeometry(geometry);
    await exerciseFileActions();
    await exerciseModeAndComments();
    await exerciseRapidSwitch();
  } else if (expectation !== "before") {
    throw new Error(`Unsupported PATCHMARK_COMPACT_HEADER_EXPECT: ${expectation}`);
  }

  writeFileSync(
    join(artifactRoot, `${expectation}-measurements.json`),
    `${JSON.stringify(
      {
        expectation,
        geometry,
        projectPath: longNames.fullPath
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ artifactRoot, expectation, geometry }, null, 2));
  console.log(`Compact top-panel ${expectation} browser test passed.`);
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function applyLongFixtureNames(root) {
  const projectPath = join(root, ".patchmark", "project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  const contentMarkers = project.documents.map(
    (document) => document.display_title
  );
  const projectTitle =
    "Synthetic Strategic Planning Workspace With A Deliberately Long Accessible Project Name";
  const groupTitles = [
    "Long-Range Product Evidence And Operational Readiness",
    "Customer Research, Market Signals, And Launch Decisions"
  ];
  const documentTitles = project.documents.map(
    (_, index) =>
      [
        "Comprehensive Founder Economics, Market View, And Sustainable Growth Strategy",
        "Detailed Operating Plan With Customer Evidence And Measured Expansion Milestones",
        "Consolidated Risk Register, Decision Log, And Responsible Follow-Through"
      ][index]
  );

  project.title = projectTitle;
  project.groups = project.groups.map((group, index) => ({
    ...group,
    title: groupTitles[index]
  }));
  project.documents = project.documents.map((document, index) => ({
    ...document,
    display_title: documentTitles[index]
  }));
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);

  const firstDocument = project.documents[0];
  const firstGroup = project.groups.find(
    (group) => group.group_id === firstDocument.group_id
  );
  return {
    contentMarkers,
    documentPaths: project.documents.map((document) => document.path),
    documentTitles,
    fullPath: `${projectTitle} / ${firstGroup.title} / ${documentTitles[0]}`,
    projectTitle
  };
}

async function exerciseFileActions() {
  await setViewport({ height: 1000, mobile: false, width: 1440 });
  const menu = await openMenu("File");
  const labels = await evaluate(client, {
    expression: `Array.from(document.querySelector(${JSON.stringify(
      `#${menu.id}`
    )}).querySelectorAll("[role='menuitem']")).map((item) => item.textContent.trim())`
  });
  for (const label of ["Save Changes", "Create Snapshot", "Copy Markdown"]) {
    assert.equal(labels.includes(label), true, `${label} is missing from File.`);
  }
  await waitFor(
    "File menu keyboard focus",
    `document.activeElement?.getAttribute("role") === "menuitem"`
  );
  await pressKey("Escape", "Escape", 27);
  await waitFor("File menu close", `document.activeElement?.getAttribute("aria-label") === "File menu"`);

  const exactMarkdown = `${await readMarkdown()}\n\nCompact header exact-save marker.\n`;
  await replaceMarkdown(exactMarkdown);
  await waitForStatus("Unsaved");
  await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteControls.delayBySequence[window.__patchmarkFixtureWriteStats.nextSequence] = 300`
  });
  await activateMenuItem("File", "Save Changes");
  await waitForStatus("Saving…");
  await waitForStatus("Saved");
  assert.equal(await readFixtureFile(longNames.documentPaths[0]), exactMarkdown);
  assert.equal(await activeLabel(), "File menu");
  await screenshot("07-saved-inline-state.png");

  const snapshotMarkdown = `${exactMarkdown}\nSnapshot-only marker.\n`;
  await replaceMarkdown(snapshotMarkdown);
  await activateMenuItem("File", "Copy Markdown");
  await waitFor(
    "copy confirmation",
    `document.querySelector(".document-context-status")?.textContent?.trim() === "Copied Markdown."`
  );
  const clipboardWrites = await evaluate(client, {
    expression: "window.__patchmarkCompactClipboardWrites.slice()"
  });
  assert.deepEqual(clipboardWrites, [snapshotMarkdown]);
  await screenshot("08-copy-confirmation.png");

  const writesBeforeSnapshot = await fixtureWriteCount();
  await activateMenuItem("File", "Create Snapshot");
  await waitFor(
    "snapshot confirmation",
    `document.querySelector(".document-context-status")?.textContent?.includes("Created a Markdown snapshot")`
  );
  const snapshotWrites = await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog.slice(${writesBeforeSnapshot}).map((entry) => entry.path)`
  });
  assert.equal(
    snapshotWrites.some((path) => path.includes("/versions/") && path.endsWith(".md")),
    true
  );
  await screenshot("09-snapshot-confirmation.png");

  const failedMarkdown = `${snapshotMarkdown}\nFailure-state marker.\n`;
  await replaceMarkdown(failedMarkdown);
  await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteControls.failNextSequence = window.__patchmarkFixtureWriteStats.nextSequence`
  });
  await activateMenuItem("File", "Save Changes");
  await waitForStatus("Save failed");
  const failure = await evaluate(client, {
    expression: `(() => {
      const alert = document.querySelector(".document-save-banner-error[role='alert']");
      return { text: alert?.textContent?.trim() ?? "", visible: Boolean(alert?.getClientRects().length) };
    })()`
  });
  assert.equal(failure.visible, true);
  assert.equal(failure.text, "Save failed. Your unsaved changes are still in Patchmark.");
  assert.equal(failure.text.includes("/tmp/"), false);
  assert.equal(failure.text.includes(longNames.documentPaths[0]), false);
  assert.equal(failure.text.includes("Injected fixture"), false);
  await screenshot("10-save-failure-private-actionable.png");

  await activateMenuItem("File", "Save Changes");
  await waitForStatus("Saved");
  assert.equal(await readFixtureFile(longNames.documentPaths[0]), failedMarkdown);
}

async function exerciseModeAndComments() {
  await focusButton("Visual Mode");
  await pressKey(" ", "Space", 32);
  await waitForDocumentReady(
    longNames.documentTitles[0],
    longNames.contentMarkers[0]
  );
  assert.equal(await activeLabel(), "Visual Mode");
  await focusButton("Markdown Mode");
  await pressKey(" ", "Space", 32);
  await waitFor("keyboard Markdown mode", `Boolean(document.querySelector(".markdown-source-editor"))`);
  assert.equal(await activeLabel(), "Markdown Mode");
  await focusButton("Visual Mode");
  await pressKey(" ", "Space", 32);
  await waitForDocumentReady(
    longNames.documentTitles[0],
    longNames.contentMarkers[0]
  );

  await setViewport({ height: 900, mobile: false, width: 768 });
  await client.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(client);
  await activateMenuItem("File", "Open Project Folder");
  await waitForDocumentReady(
    longNames.documentTitles[0],
    longNames.contentMarkers[0]
  );
  await waitFor(
    "narrow navigation mode",
    `matchMedia("(max-width: 900px)").matches && document.querySelector(".application-navigation-trigger")?.getClientRects().length > 0`
  );
  await clickButtonByAriaPrefix("Open comments.");
  await waitFor(
    "tablet modal comments",
    `document.querySelector("#document-comments-panel")?.getAttribute("role") === "dialog"`
  );
  await focusButtonByAria("Close comments");
  const modalState = await evaluate(client, {
    expression: `(() => ({
      editorInert: document.querySelector(".editor-panel")?.inert === true,
      expanded: document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded"),
      overflow: document.documentElement.scrollWidth > innerWidth
    }))()`
  });
  assert.equal(modalState.editorInert, true);
  assert.equal(modalState.expanded, "true");
  assert.equal(modalState.overflow, false);
  await screenshot("11-tablet-comments-modal.png");
  await pressKey("Escape", "Escape", 27);
  await waitFor(
    "comments Escape close",
    `document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "false"`
  );
  await waitFor(
    "comments focus restoration",
    `!document.querySelector(".application-bar")?.inert && document.activeElement === document.querySelector(".application-comments-trigger")`
  );
}

async function exerciseRapidSwitch() {
  await setViewport({ height: 1000, mobile: false, width: 1440 });
  await evaluate(client, {
    expression: `(() => {
      const titles = ${JSON.stringify(longNames.documentTitles)};
      const ids = ${JSON.stringify(fixture.documents.map((document) => document.documentId))};
      const markers = ${JSON.stringify(longNames.contentMarkers)};
      const titleToId = Object.fromEntries(titles.map((title, index) => [title, ids[index]]));
      const titleToMarker = Object.fromEntries(titles.map((title, index) => [title, markers[index]]));
      const mismatches = [];
      const samples = [];
      let active = true;
      const record = () => {
        if (!active) return;
        const activeTitle = document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent?.trim() ?? null;
        const breadcrumbTitle = document.querySelector(".application-breadcrumb-document")?.textContent?.trim() ?? null;
        const editor = document.querySelector(".editor-body");
        const editorKey = editor?.getAttribute("data-document-key") ?? "";
        const editorSurface = document.querySelector(".markdown-source-editor") ?? document.querySelector(".visual-editor-shell");
        const editorText = document.querySelector(".markdown-source-editor")?.value ?? document.querySelector(".patchmark-mdx-editor")?.textContent ?? "";
        const preview = document.querySelector(".document-switch-target-preview");
        const previewText = preview?.textContent ?? "";
        const previewVisible = Boolean(
          preview &&
          getComputedStyle(preview).visibility !== "hidden" &&
          getComputedStyle(preview).display !== "none"
        );
        const editorContentVisible = Boolean(
          editorSurface &&
          getComputedStyle(editorSurface).visibility !== "hidden" &&
          getComputedStyle(editorSurface).display !== "none"
        );
        const visibleText = previewVisible
          ? previewText
          : editorContentVisible
            ? editorText
            : "";
        const state = {
          activeTitle,
          breadcrumbTitle,
          editorContentVisible,
          editorKey,
          previewVisible,
          switching: editor?.getAttribute("data-document-switching") === "true",
          visibleText: visibleText.slice(0, 260)
        };
        samples.push(state);
        if (activeTitle && (
          breadcrumbTitle !== activeTitle ||
          !editorKey.includes(titleToId[activeTitle]) ||
          (visibleText.length > 0 && !visibleText.includes(titleToMarker[activeTitle]))
        )) mismatches.push(state);
      };
      const observer = new MutationObserver(record);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
      record();
      window.__patchmarkCompactAtomicObserver = {
        stop: () => {
          active = false;
          observer.disconnect();
          return { mismatches, samples };
        }
      };
      return true;
    })()`
  });

  await clickDocument(longNames.documentTitles[1]);
  await waitFor(
    "intermediate request",
    `document.querySelector(".project-document-item[data-requested='true'] .project-document-select span")?.textContent?.trim() === ${JSON.stringify(longNames.documentTitles[1])}`
  );
  await clickDocument(longNames.documentTitles[2]);
  await waitForDocumentReady(
    longNames.documentTitles[2],
    longNames.contentMarkers[2]
  );
  const observations = await evaluate(client, {
    expression: "window.__patchmarkCompactAtomicObserver.stop()"
  });
  assert.ok(observations.samples.length >= 2);
  assert.deepEqual(observations.mismatches, []);
  const staleFeedback = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll("[role='status'], [role='alert']"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => /^Opened /.test(text))`
  });
  assert.deepEqual(staleFeedback, []);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector(".application-breadcrumb-document")?.textContent?.trim()`
    }),
    longNames.documentTitles[2]
  );
  await screenshot("12-rapid-switch-latest-document.png");
  writeFileSync(
    join(artifactRoot, "rapid-switch-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`
  );
}

function assertAfterGeometry(geometry) {
  assert.equal(geometry.visualDesktop.bar.height, 48);
  assert.equal(geometry.markdownDesktop.bar.height, 48);
  assert.ok(geometry.visualDesktop.editorToolbar.height > 0);
  assert.equal(geometry.markdownDesktop.editorToolbar.height, 0);
  assert.equal(geometry.visualDesktop.legacyToolbarCount, 0);
  assert.equal(geometry.markdownDesktop.legacyToolbarCount, 0);
  assert.equal(geometry.visualDesktop.openedFeedbackCount, 0);
  assert.equal(geometry.markdownDesktop.openedFeedbackCount, 0);
  assert.equal(geometry.visualDesktop.breadcrumb.fullPathAccessible, true);
  assert.equal(geometry.visualDesktop.breadcrumb.truncated, true);
  for (const [label, measurement] of Object.entries(geometry)) {
    assert.equal(measurement.horizontalOverflow, false, `${label} overflowed horizontally.`);
    assert.equal(measurement.status.visible, true, `${label} hid save status.`);
    assert.equal(measurement.mode.visible, true, `${label} hid the mode switch.`);
  }
  assert.equal(geometry.mobile.bar.height, 88);
  assert.equal(geometry.compact.bar.height, 88);
}

async function captureGeometry(fileName) {
  await waitFor("stable editor geometry", `document.querySelector(".editor-body")?.getAttribute("data-document-switching") !== "true"`);
  const measurement = await evaluate(client, {
    expression: `(() => {
      const rect = (element) => {
        if (!element || !element.getClientRects().length) return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
        const value = element.getBoundingClientRect();
        return { bottom: value.bottom, height: value.height, left: value.left, right: value.right, top: value.top, width: value.width };
      };
      const bar = document.querySelector(".application-bar");
      const toolbar = document.querySelector(".patchmark-mdx-editor .mdxeditor-toolbar");
      const markdown = document.querySelector(".markdown-source-editor");
      const richText = document.querySelector(".patchmark-mdx-editor [contenteditable='true']");
      const firstContent = markdown ?? richText?.firstElementChild ?? richText;
      const breadcrumb = document.querySelector(".application-document-breadcrumb");
      const documentTitle = document.querySelector(".application-breadcrumb-document");
      const status = document.querySelector(".document-status");
      const mode = document.querySelector(".mode-switcher");
      const fullPath = ${JSON.stringify(longNames.fullPath)};
      return {
        bar: rect(bar),
        breadcrumb: {
          ariaLabel: breadcrumb?.getAttribute("aria-label") ?? "",
          fullPathAccessible: breadcrumb?.getAttribute("title") === fullPath && breadcrumb?.getAttribute("aria-label") === "Current document: " + fullPath,
          title: breadcrumb?.getAttribute("title") ?? "",
          truncated: Boolean(documentTitle && documentTitle.scrollWidth > documentTitle.clientWidth)
        },
        content: rect(firstContent),
        editorToolbar: rect(toolbar),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        legacyToolbarCount: document.querySelectorAll(".document-toolbar").length,
        mode: { ...rect(mode), visible: Boolean(mode?.getClientRects().length) },
        openedFeedbackCount: Array.from(document.querySelectorAll("[role='status'], [role='alert']")).filter((element) => /^Opened /.test(element.textContent?.trim() ?? "")).length,
        status: { ...rect(status), text: status?.textContent?.trim() ?? "", visible: Boolean(status?.getClientRects().length) },
        topToFirstContent: rect(firstContent).top - rect(bar).top,
        viewport: { height: innerHeight, width: innerWidth }
      };
    })()`
  });
  await screenshot(fileName);
  return measurement;
}

async function openMenu(label) {
  await clickButtonByAria(`${label} menu`);
  return waitFor(
    `${label} menu`,
    `(() => {
      const trigger = document.querySelector(${JSON.stringify(`[aria-label="${label} menu"]`)});
      const menu = trigger ? document.getElementById(trigger.getAttribute("aria-controls")) : null;
      return menu && !menu.hidden ? { id: menu.id } : null;
    })()`
  );
}

async function activateMenuItem(menuLabel, itemLabel) {
  await openMenu(menuLabel);
  await waitFor(
    `${itemLabel} enabled`,
    `Array.from(document.querySelectorAll("button"))
      .some((candidate) => candidate.getClientRects().length > 0 && candidate.textContent?.trim() === ${JSON.stringify(itemLabel)} && !candidate.disabled)`
  );
  await clickButton(itemLabel);
  await waitFor(
    `${menuLabel} focus restoration`,
    `document.activeElement?.getAttribute("aria-label") === ${JSON.stringify(`${menuLabel} menu`)}`
  );
}

async function waitForDocumentReady(title, contentMarker = title) {
  await waitFor(
    `${title} ready`,
    `(() => {
      const active = document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent?.trim();
      const editor = document.querySelector(".editor-body");
      const content = document.querySelector(".markdown-source-editor")?.value ?? document.querySelector(".patchmark-mdx-editor")?.textContent ?? "";
      return active === ${JSON.stringify(title)} && editor?.getAttribute("data-document-switching") !== "true" && !editor?.inert && content.includes(${JSON.stringify(contentMarker)});
    })()`
  );
}

async function waitForStatus(label) {
  await waitFor(
    `document status ${label}`,
    `document.querySelector(".document-status")?.textContent?.trim() === ${JSON.stringify(label)}`
  );
}

async function replaceMarkdown(value) {
  await evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector(".markdown-source-editor");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, ${JSON.stringify(value)});
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return editor.value;
    })()`,
    userGesture: true
  });
}

async function readMarkdown() {
  return evaluate(client, {
    expression: `document.querySelector(".markdown-source-editor")?.value ?? ""`
  });
}

async function readFixtureFile(path) {
  return evaluate(client, {
    awaitPromise: true,
    expression: `window.__patchmarkFixtureReadFile(${JSON.stringify(path)})`
  });
}

async function fixtureWriteCount() {
  return evaluate(client, {
    expression: "window.__patchmarkFixtureWriteLog.length"
  });
}

async function clickDocument(title) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === ${JSON.stringify(title)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not select ${title}.`);
}

async function clickButton(label) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getClientRects().length > 0 && candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not click ${label}.`);
}

async function clickButtonByAria(label) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not click ${label}.`);
}

async function clickButtonByAriaPrefix(prefix) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button[aria-label]"))
        .find((candidate) => candidate.getAttribute("aria-label")?.startsWith(${JSON.stringify(prefix)}));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not click control starting with ${prefix}.`);
}

async function focusButton(label) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getClientRects().length > 0 && candidate.textContent?.trim() === ${JSON.stringify(label)});
      button?.focus();
      return document.activeElement === button;
    })()`
  });
}

async function focusButtonByAria(label) {
  const focused = await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
      button?.focus();
      return document.activeElement === button;
    })()`
  });
  assert.equal(focused, true, `Could not focus ${label}.`);
}

async function activeLabel() {
  return evaluate(client, {
    expression: `document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? ""`
  });
}

async function pressKey(key, code, keyCode) {
  await client.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: keyCode,
    type: "keyDown",
    windowsVirtualKeyCode: keyCode
  });
  await client.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: keyCode,
    type: "keyUp",
    windowsVirtualKeyCode: keyCode
  });
}

async function setViewport({ height, mobile, width }) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile,
    width
  });
  await waitFor(
    `${width}x${height} viewport`,
    `innerWidth === ${width} && innerHeight === ${height}`
  );
}

async function screenshot(fileName) {
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(join(artifactRoot, fileName), Buffer.from(result.data, "base64"));
}

async function waitFor(label, expression) {
  let latest = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (latest) return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}. Latest: ${JSON.stringify(latest)}`);
}

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
import { basename, join } from "node:path";
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
const targetText = "Resume reading from this durable sentence.";

await run();

async function run() {
  const fixtureDir = createFixture();
  const originalDocument = readFileSync(join(fixtureDir, "document.md"), "utf8");
  const originalComments = readFileSync(
    join(fixtureDir, ".patchmark", "comments.json"),
    "utf8"
  );
  const originalPatches = readFileSync(
    join(fixtureDir, ".patchmark", "patches.json"),
    "utf8"
  );
  const inventory = inventoryProject(fixtureDir);
  const fixtureServer = await startFixtureFileServer(fixtureDir, inventory);
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the reading bookmark browser test."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-bookmark-chrome-"));
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
  let pageClient;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, "about:blank");

    pageClient = await CdpClient.connect(pageWsUrl);
    await pageClient.call("Page.enable");
    await pageClient.call("Runtime.enable");
    await pageClient.call("Page.addScriptToEvaluateOnNewDocument", {
      source: createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: inventory.directories,
        files: inventory.files,
        projectName: basename(fixtureDir)
      })
    });
    await pageClient.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 900,
      mobile: false,
      width: 1440
    });
    await pageClient.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(pageClient);
    await openFixture(pageClient);
    await setBookmarkFromMarkdownMode(pageClient, fixtureDir);

    assertUnrelatedFilesUnchanged({
      fixtureDir,
      originalComments,
      originalDocument,
      originalPatches
    });

    const storedManifest = readManifest(fixtureDir);
    const storedBookmarks = Object.values(storedManifest.reading_bookmarks ?? {});
    assert.equal(storedBookmarks.length, 1);
    assert.equal(storedBookmarks[0].document.project_id, storedManifest.project_id);
    assert.equal(storedBookmarks[0].document.document_file, "document.md");
    assert.equal(storedBookmarks[0].anchor.kind, "selected_text");
    assert.equal(storedBookmarks[0].anchor.selected_text, targetText);
    await waitForButtonMissing(pageClient, "Remove bookmark");

    await clickButtonByText(pageClient, "Visual Mode");
    await waitForVisualBookmark(pageClient);
    await evaluate(pageClient, {
      expression: "window.scrollTo({ top: 0, behavior: 'auto' }); true"
    });
    await clickButtonByText(pageClient, "Continue reading");
    const visualResult = await waitForVisualContinuation(pageClient);

    assert.ok(visualResult.highlightRectCount > 0);
    assert.ok(visualResult.targetTop >= 0 && visualResult.targetTop < 760);

    await clickBookmarkMarker(pageClient);
    await waitForButton(pageClient, "Remove bookmark");
    await pressKey(pageClient, "Escape");
    await waitForButtonMissing(pageClient, "Remove bookmark");
    await waitForPersistedBookmark(fixtureDir, true);
    await waitForVisualBookmark(pageClient);

    await clickBookmarkMarker(pageClient);
    await waitForButton(pageClient, "Remove bookmark");
    await clickButtonByText(pageClient, "Remove bookmark");
    await waitForPersistedBookmark(fixtureDir, false);
    await waitForButtonMissing(pageClient, "Continue reading");
    await waitForElementMissing(pageClient, ".reading-bookmark-marker");

    await setBookmarkFromMarkdownMode(pageClient, fixtureDir);
    await clickButtonByText(pageClient, "Visual Mode");
    await waitForVisualBookmark(pageClient);
    await focusElement(pageClient, ".reading-bookmark-indicator");
    await pressKey(pageClient, "Enter");
    await waitForButton(pageClient, "Remove bookmark");
    assert.equal(
      await getActiveElementText(pageClient),
      "Remove bookmark"
    );
    await pressKey(pageClient, "Enter");
    await waitForPersistedBookmark(fixtureDir, false);
    await waitForButtonMissing(pageClient, "Continue reading");
    await waitForElementMissing(pageClient, ".reading-bookmark-marker");

    await setBookmarkFromMarkdownMode(pageClient, fixtureDir);

    await pageClient.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(pageClient);
    await openFixture(pageClient);
    await waitForButton(pageClient, "Continue reading");
    await clickButtonByText(pageClient, "Markdown Mode");
    await waitForElement(pageClient, ".markdown-source-editor");
    await evaluate(pageClient, {
      expression: `(() => {
        const textarea = document.querySelector(".markdown-source-editor");
        textarea.focus();
        textarea.setSelectionRange(0, 0);
        textarea.scrollTop = 0;
        textarea.dispatchEvent(new Event("select", { bubbles: true }));
        return true;
      })()`
    });
    await clickButtonByText(pageClient, "Continue reading");
    const sourceResult = await waitForMarkdownContinuation(pageClient);

    assert.equal(sourceResult.selectedText, targetText);
    assert.ok(sourceResult.scrollTop > 0);

    await makeBookmarkUnavailableInMemory(pageClient);
    await waitForText(pageClient, "Bookmark location unavailable");
    await waitForButtonMissing(pageClient, "Continue reading");
    await waitForButtonMissing(pageClient, "Remove bookmark");
    await waitForButton(pageClient, "Remove unavailable bookmark");
    await clickButtonByText(pageClient, "Remove unavailable bookmark");
    await waitForPersistedBookmark(fixtureDir, false);
    await waitForTextMissing(pageClient, "Bookmark location unavailable");
    assertUnrelatedFilesUnchanged({
      fixtureDir,
      originalComments,
      originalDocument,
      originalPatches
    });

    console.log("Reading bookmark browser test passed.");
  } finally {
    await pageClient?.close().catch(() => undefined);
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    await fixtureServer.forceClose().catch(() => undefined);
    rmSync(userDataDir, { force: true, recursive: true });
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}

function createFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "patchmark-bookmark-project-"));
  const patchmarkDir = join(fixtureDir, ".patchmark");
  const filler = Array.from(
    { length: 90 },
    (_, index) => `Paragraph ${index + 1} before the saved reading location.`
  );
  const markdown = [
    "# Reading bookmark browser fixture",
    "",
    ...filler.flatMap((line) => [line, ""]),
    "## Saved location",
    "",
    targetText,
    "",
    "The document continues after the bookmark."
  ].join("\n");
  const now = "2026-07-20T00:00:00.000Z";

  mkdirSync(patchmarkDir, { recursive: true });
  writeFileSync(join(fixtureDir, "document.md"), markdown);
  writeFileSync(join(patchmarkDir, "comments.json"), "[]\n");
  writeFileSync(join(patchmarkDir, "patches.json"), "[]\n");
  writeFileSync(
    join(patchmarkDir, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        project_id: "PM-PROJECT-BOOKMARK-BROWSER",
        project_name: "Reading bookmark browser fixture",
        document_file: "document.md",
        created_at: now,
        updated_at: now
      },
      null,
      2
    )}\n`
  );

  return fixtureDir;
}

async function openFixture(pageClient) {
  await clickButtonByText(pageClient, "Open Project Folder");
  await waitFor(pageClient, "project folder", `(() => {
    const status = document.querySelector("[aria-label='Workspace status']");
    return Boolean(status?.textContent?.includes("Reading bookmark browser fixture"));
  })()`);
}

async function setBookmarkFromMarkdownMode(pageClient, fixtureDir) {
  await clickButtonByText(pageClient, "Markdown Mode");
  await waitForElement(pageClient, ".markdown-source-editor");
  await selectTargetAndOpenMenu(pageClient);
  await clickButtonByText(pageClient, "Set reading bookmark");
  await waitForButton(pageClient, "Continue reading");
  await waitForButtonMissing(pageClient, "Remove bookmark");
  await waitForPersistedBookmark(fixtureDir, true);
}

async function clickBookmarkMarker(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const marker = document.querySelector(".reading-bookmark-indicator");

      if (!marker) {
        throw new Error("Reading bookmark marker was not found.");
      }

      marker.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function focusElement(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});

      if (!element) {
        throw new Error("Element was not found: ${selector}");
      }

      element.focus();
      return true;
    })()`
  });
}

async function getActiveElementText(pageClient) {
  return evaluate(pageClient, {
    expression: "document.activeElement?.textContent?.trim() ?? ''"
  });
}

async function pressKey(pageClient, key) {
  const virtualKeyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : 0;
  await pageClient.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: virtualKeyCode,
    text: key === "Enter" ? "\r" : undefined,
    type: "keyDown",
    unmodifiedText: key === "Enter" ? "\r" : undefined,
    windowsVirtualKeyCode: virtualKeyCode
  });
  await pageClient.call("Input.dispatchKeyEvent", {
    code: key,
    key,
    nativeVirtualKeyCode: virtualKeyCode,
    type: "keyUp",
    windowsVirtualKeyCode: virtualKeyCode
  });
}

async function makeBookmarkUnavailableInMemory(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      const nextValue = textarea.value.replace(
        ${JSON.stringify(targetText)},
        "The saved reading target was removed from this unsaved draft."
      );
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;

      valueSetter.call(textarea, nextValue);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
}

async function selectTargetAndOpenMenu(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      const start = textarea.value.indexOf(${JSON.stringify(targetText)});

      if (start < 0) {
        throw new Error("Bookmark target was not found in Markdown Mode.");
      }

      textarea.focus();
      textarea.setSelectionRange(start, start + ${targetText.length});
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
  await delay(75);
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      textarea.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 720,
        clientY: 520
      }));
      return true;
    })()`,
    userGesture: true
  });
  await waitForElement(pageClient, ".comment-context-menu");
}

async function waitForVisualBookmark(pageClient) {
  await waitFor(pageClient, "visual reading bookmark", `(() => {
    const prose = document.querySelector(".patchmark-prose");
    const indicator = document.querySelector(".reading-bookmark-indicator");
    return Boolean(prose?.textContent?.includes(${JSON.stringify(targetText)}) && indicator);
  })()`);
}

async function waitForVisualContinuation(pageClient) {
  let latest = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    latest = await evaluate(pageClient, {
      expression: `(() => {
        const highlight = globalThis.CSS?.highlights?.get("patchmark-reading-bookmark-target");
        const ranges = highlight ? Array.from(highlight) : [];
        const rects = ranges.flatMap((range) => Array.from(range.getClientRects()));
        const visibleRect = rects.find((rect) => rect.width > 0 && rect.height > 0);
        return {
          highlightRectCount: rects.filter((rect) => rect.width > 0 && rect.height > 0).length,
          targetTop: visibleRect?.top ?? -1
        };
      })()`
    });

    if (latest.highlightRectCount > 0 && latest.targetTop >= 0) {
      return latest;
    }

    await delay(50);
  }

  throw new Error(`Timed out waiting for bookmark emphasis: ${JSON.stringify(latest)}`);
}

async function waitForMarkdownContinuation(pageClient) {
  let latest = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    latest = await evaluate(pageClient, {
      expression: `(() => {
        const textarea = document.querySelector(".markdown-source-editor");
        return {
          scrollTop: textarea?.scrollTop ?? 0,
          selectedText: textarea
            ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
            : ""
        };
      })()`
    });

    if (latest.selectedText === targetText) {
      return latest;
    }

    await delay(50);
  }

  throw new Error(`Timed out waiting for Markdown bookmark selection: ${JSON.stringify(latest)}`);
}

async function waitForPersistedBookmark(fixtureDir, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const manifest = readManifest(fixtureDir);
    const hasBookmark = Object.keys(manifest.reading_bookmarks ?? {}).length > 0;

    if (hasBookmark === expected) {
      return;
    }

    await delay(50);
  }

  throw new Error(
    `Timed out waiting for persisted bookmark state ${String(expected)}.`
  );
}

async function waitForButton(pageClient, text) {
  await waitFor(pageClient, `button ${text}`, `Array.from(document.querySelectorAll("button"))
    .some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
}

async function waitForButtonMissing(pageClient, text) {
  await waitFor(pageClient, `button removal ${text}`, `!Array.from(document.querySelectorAll("button"))
    .some((button) => button.textContent?.trim() === ${JSON.stringify(text)})`);
}

async function waitForElement(pageClient, selector) {
  await waitFor(
    pageClient,
    `element ${selector}`,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  );
}

async function waitForElementMissing(pageClient, selector) {
  await waitFor(
    pageClient,
    `element removal ${selector}`,
    `!document.querySelector(${JSON.stringify(selector)})`
  );
}

async function waitForText(pageClient, text) {
  await waitFor(
    pageClient,
    `text ${text}`,
    `document.body.textContent?.includes(${JSON.stringify(text)}) === true`
  );
}

async function waitForTextMissing(pageClient, text) {
  await waitFor(
    pageClient,
    `text removal ${text}`,
    `document.body.textContent?.includes(${JSON.stringify(text)}) !== true`
  );
}

async function waitFor(pageClient, label, expression) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await evaluate(pageClient, { expression })) {
      return;
    }

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

function readManifest(fixtureDir) {
  return JSON.parse(
    readFileSync(join(fixtureDir, ".patchmark", "manifest.json"), "utf8")
  );
}

function assertUnrelatedFilesUnchanged({
  fixtureDir,
  originalComments,
  originalDocument,
  originalPatches
}) {
  assert.equal(readFileSync(join(fixtureDir, "document.md"), "utf8"), originalDocument);
  assert.equal(
    readFileSync(join(fixtureDir, ".patchmark", "comments.json"), "utf8"),
    originalComments
  );
  assert.equal(
    readFileSync(join(fixtureDir, ".patchmark", "patches.json"), "utf8"),
    originalPatches
  );
}

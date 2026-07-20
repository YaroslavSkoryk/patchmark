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
const targetText = "Resume reading from this equivalent durable sentence.";

await run();

async function run() {
  const fixtureDir = createFixture();
  const originals = captureUnrelatedFiles(fixtureDir);
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
    await waitForActiveDocument(pageClient, "First chapter");
    await clickButtonByText(pageClient, "Markdown Mode");
    await waitForElement(pageClient, ".markdown-source-editor");

    await selectTargetAndOpenMenu(pageClient);
    await clickButtonByText(pageClient, "Set reading bookmark");
    await waitForPersistedBookmark(fixtureDir, "doc_first", true);
    await waitForNavigatorBookmarks(pageClient, 1);
    assertStoredIdentity(fixtureDir, "doc_first");
    await clickButtonByText(pageClient, "Visual Mode");
    await waitForVisualBookmark(pageClient, "FIRST DOCUMENT ONLY");

    await selectNavigatorDocument(pageClient, "Second chapter");
    await waitForActiveDocument(pageClient, "Second chapter");
    await clickButtonByText(pageClient, "Markdown Mode");
    await waitForElement(pageClient, ".markdown-source-editor");
    await selectTargetAndOpenMenu(pageClient);
    await clickButtonByText(pageClient, "Set reading bookmark");
    await waitForPersistedBookmark(fixtureDir, "doc_second", true);
    await waitForNavigatorBookmarks(pageClient, 2);
    assertStoredIdentity(fixtureDir, "doc_second");
    assertUnrelatedFilesUnchanged(fixtureDir, originals);

    await clickButtonByText(pageClient, "Visual Mode");
    await waitForVisualBookmark(pageClient, "SECOND DOCUMENT ONLY");
    await clickNavigatorBookmark(pageClient, "First chapter");
    await waitForActiveDocument(pageClient, "First chapter");
    const firstContinuation = await waitForVisualContinuation(
      pageClient,
      "doc_first",
      "FIRST DOCUMENT ONLY"
    );
    assert.ok(firstContinuation.highlightRectCount > 0);
    assert.equal(firstContinuation.editorCount, 1);

    await clickNavigatorBookmark(pageClient, "Second chapter");
    await waitForActiveDocument(pageClient, "Second chapter");
    const secondContinuation = await waitForVisualContinuation(
      pageClient,
      "doc_second",
      "SECOND DOCUMENT ONLY"
    );
    assert.ok(secondContinuation.highlightRectCount > 0);
    assert.equal(secondContinuation.editorCount, 1);

    await pageClient.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(pageClient);
    await openFixture(pageClient);
    await waitForActiveDocument(pageClient, "Second chapter");
    await waitForNavigatorBookmarks(pageClient, 2);
    await waitForButton(pageClient, "Continue reading");
    await clickButtonByText(pageClient, "Markdown Mode");
    await waitForElement(pageClient, ".markdown-source-editor");
    await resetMarkdownSelection(pageClient);
    await clickButtonByText(pageClient, "Continue reading");
    const sourceResult = await waitForMarkdownContinuation(pageClient);
    assert.equal(sourceResult.selectedText, targetText);
    assert.ok(sourceResult.scrollTop > 0);

    await clickButtonByText(pageClient, "Remove bookmark");
    await waitForPersistedBookmark(fixtureDir, "doc_second", false);
    await waitForNavigatorBookmarks(pageClient, 1);
    assert.ok(readManifest(fixtureDir, "doc_first").reading_bookmark);
    assert.equal(readManifest(fixtureDir, "doc_second").reading_bookmark, undefined);
    assertUnrelatedFilesUnchanged(fixtureDir, originals);

    console.log("Multi-document reading bookmark browser test passed.");
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
  const metadataDir = join(fixtureDir, ".patchmark");
  const now = "2026-07-20T00:00:00.000Z";
  mkdirSync(join(metadataDir, "documents"), { recursive: true });
  const documents = [
    createDocumentFixture({
      documentId: "doc_first",
      documentPath: "first.md",
      fixtureDir,
      marker: "FIRST DOCUMENT ONLY",
      now,
      position: 1000,
      title: "First chapter"
    }),
    createDocumentFixture({
      documentId: "doc_second",
      documentPath: "second.md",
      fixtureDir,
      marker: "SECOND DOCUMENT ONLY",
      now,
      position: 2000,
      title: "Second chapter"
    })
  ];
  writeFileSync(
    join(metadataDir, "project.json"),
    `${JSON.stringify({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "prj_bookmark_browser",
      title: "Reading bookmark browser fixture",
      created_at: now,
      manifest_revision: 1,
      documents
    }, null, 2)}\n`
  );
  return fixtureDir;
}

function createDocumentFixture({
  documentId,
  documentPath,
  fixtureDir,
  marker,
  now,
  position,
  title
}) {
  const filler = Array.from(
    { length: 90 },
    (_, index) => `Paragraph ${index + 1} before the saved reading location.`
  );
  const markdown = [
    `# ${title}`,
    "",
    marker,
    "",
    ...filler.flatMap((line) => [line, ""]),
    "## Saved location",
    "",
    targetText,
    "",
    "The document continues after the bookmark."
  ].join("\n");
  const store = join(fixtureDir, ".patchmark", "documents", documentId);
  mkdirSync(join(store, "versions"), { recursive: true });
  mkdirSync(join(store, "context-packs"), { recursive: true });
  mkdirSync(join(store, "imports"), { recursive: true });
  mkdirSync(join(store, "recovery"), { recursive: true });
  writeFileSync(join(fixtureDir, documentPath), markdown);
  const targetStart = markdown.indexOf(targetText);
  writeFileSync(
    join(store, "comments.json"),
    `${JSON.stringify([
      {
        id: "PM-COMMENT-SHARED",
        type: "note",
        status: "open",
        anchor: {
          kind: "selected_text",
          selected_text: targetText,
          markdown_start_offset: targetStart,
          markdown_end_offset: targetStart + targetText.length,
          anchor_source: "markdown"
        },
        comment: `Comment coexisting with ${title} bookmark`,
        thread: [],
        export_state: { focus_state: "idle" },
        created_at: now,
        updated_at: now
      }
    ], null, 2)}\n`
  );
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(
    join(store, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      project_name: "Reading bookmark browser fixture",
      document_file: "document.md",
      created_at: now,
      updated_at: now
    }, null, 2)}\n`
  );
  writeFileSync(
    join(store, "document.json"),
    `${JSON.stringify({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: documentId,
      created_at: now,
      source: "created"
    }, null, 2)}\n`
  );
  return {
    document_id: documentId,
    path: documentPath,
    display_title: title,
    role: null,
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

async function openFixture(pageClient) {
  await clickButtonByText(pageClient, "Open Project Folder");
  await waitFor(pageClient, "project folder", `(() => {
    const status = document.querySelector("[aria-label='Workspace status']");
    return Boolean(status?.textContent?.includes("Reading bookmark browser fixture"));
  })()`);
}

async function selectTargetAndOpenMenu(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      const start = textarea.value.indexOf(${JSON.stringify(targetText)});
      if (start < 0) throw new Error("Bookmark target was not found.");
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

async function selectNavigatorDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(title)}));
      if (!button) throw new Error("Navigator document was not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickNavigatorBookmark(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const label = ${JSON.stringify(`Continue reading in ${title}`)};
      const button = Array.from(document.querySelectorAll(".project-document-bookmark"))
        .find((candidate) => candidate.getAttribute("aria-label") === label);
      if (!button) throw new Error("Navigator bookmark was not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForActiveDocument(pageClient, title) {
  await waitFor(pageClient, `active document ${title}`, `(() => {
    const status = document.querySelector("[aria-label='Workspace status']");
    const active = document.querySelector(".project-document-item[data-active='true']");
    return Boolean(
      status?.textContent?.includes(${JSON.stringify(`Document: ${title}`)}) &&
      active?.textContent?.includes(${JSON.stringify(title)})
    );
  })()`);
}

async function waitForNavigatorBookmarks(pageClient, expected) {
  await waitFor(
    pageClient,
    `${expected} navigator bookmarks`,
    `document.querySelectorAll(".project-document-bookmark").length === ${expected}`
  );
}

async function waitForVisualBookmark(pageClient, marker) {
  await waitFor(pageClient, "visual reading bookmark", `(() => {
    const prose = document.querySelector(".patchmark-prose");
    const indicator = document.querySelector(".reading-bookmark-indicator");
    return Boolean(
      prose?.textContent?.includes(${JSON.stringify(marker)}) &&
      prose?.textContent?.includes(${JSON.stringify(targetText)}) &&
      indicator &&
      document.querySelector(".comment-card")
    );
  })()`);
}

async function waitForVisualContinuation(pageClient, documentId, marker) {
  let latest = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    latest = await evaluate(pageClient, {
      expression: `(() => {
        const editor = document.querySelector(".editor-body");
        const prose = document.querySelector(".patchmark-prose");
        const highlight = globalThis.CSS?.highlights?.get("patchmark-reading-bookmark-target");
        const ranges = highlight ? Array.from(highlight) : [];
        const rects = ranges.flatMap((range) => Array.from(range.getClientRects()));
        const visibleRect = rects.find((rect) => rect.width > 0 && rect.height > 0);
        return {
          activeKey: editor?.dataset.documentKey ?? "",
          editorCount: document.querySelectorAll(".editor-body").length,
          highlightRectCount: rects.filter((rect) => rect.width > 0 && rect.height > 0).length,
          markerVisible: Boolean(prose?.textContent?.includes(${JSON.stringify(marker)})),
          targetTop: visibleRect?.top ?? -1
        };
      })()`
    });
    if (
      latest.activeKey.includes(documentId) &&
      latest.editorCount === 1 &&
      latest.highlightRectCount > 0 &&
      latest.markerVisible &&
      latest.targetTop >= 0 &&
      latest.targetTop < 760
    ) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for bookmark emphasis: ${JSON.stringify(latest)}`);
}

async function resetMarkdownSelection(pageClient) {
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
    if (latest.selectedText === targetText) return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for Markdown continuation: ${JSON.stringify(latest)}`);
}

async function waitForPersistedBookmark(fixtureDir, documentId, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const hasBookmark = Boolean(readManifest(fixtureDir, documentId).reading_bookmark);
    if (hasBookmark === expected) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${documentId} bookmark ${String(expected)}.`);
}

async function waitForButton(pageClient, text) {
  await waitFor(pageClient, `button ${text}`, `Array.from(document.querySelectorAll("button"))
    .some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
}

async function waitForElement(pageClient, selector) {
  await waitFor(
    pageClient,
    `element ${selector}`,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  );
}

async function waitFor(pageClient, label, expression) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate(pageClient, { expression })) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function readManifest(fixtureDir, documentId) {
  return JSON.parse(
    readFileSync(
      join(fixtureDir, ".patchmark", "documents", documentId, "manifest.json"),
      "utf8"
    )
  );
}

function assertStoredIdentity(fixtureDir, documentId) {
  const bookmark = readManifest(fixtureDir, documentId).reading_bookmark;
  assert.equal(bookmark.document.project_id, "prj_bookmark_browser");
  assert.equal(bookmark.document.document_id, documentId);
  assert.equal(bookmark.anchor.kind, "selected_text");
  assert.equal(bookmark.anchor.selected_text, targetText);
}

function captureUnrelatedFiles(fixtureDir) {
  return {
    project: readFileSync(join(fixtureDir, ".patchmark", "project.json"), "utf8"),
    documents: Object.fromEntries(
      ["doc_first", "doc_second"].map((documentId) => [
        documentId,
        {
          comments: readFileSync(
            join(
              fixtureDir,
              ".patchmark",
              "documents",
              documentId,
              "comments.json"
            ),
            "utf8"
          ),
          markdown: readFileSync(
            join(fixtureDir, documentId === "doc_first" ? "first.md" : "second.md"),
            "utf8"
          ),
          patches: readFileSync(
            join(
              fixtureDir,
              ".patchmark",
              "documents",
              documentId,
              "patches.json"
            ),
            "utf8"
          )
        }
      ])
    )
  };
}

function assertUnrelatedFilesUnchanged(fixtureDir, originals) {
  assert.equal(
    readFileSync(join(fixtureDir, ".patchmark", "project.json"), "utf8"),
    originals.project
  );
  for (const [documentId, original] of Object.entries(originals.documents)) {
    assert.equal(
      readFileSync(
        join(fixtureDir, documentId === "doc_first" ? "first.md" : "second.md"),
        "utf8"
      ),
      original.markdown
    );
    assert.equal(
      readFileSync(
        join(
          fixtureDir,
          ".patchmark",
          "documents",
          documentId,
          "comments.json"
        ),
        "utf8"
      ),
      original.comments
    );
    assert.equal(
      readFileSync(
        join(
          fixtureDir,
          ".patchmark",
          "documents",
          documentId,
          "patches.json"
        ),
        "utf8"
      ),
      original.patches
    );
  }
}

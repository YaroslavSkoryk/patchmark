import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const screenshotPath = process.env.PATCHMARK_COMMENT_COMPOSER_SCREENSHOT;
const paragraphTarget =
  "Paragraph selection remains available without using a context menu.";
const tableTarget =
  "Break-even must be calculated after ingredient cost, packaging, labor, delivery, utilities, admin, accounting, tax/VAT handling, staff, and facility costs.";
const leftEdgeTarget = "Left edge selection target.";
const rightEdgeTarget = "Right edge selection target.";
const keyboardTarget =
  "Keyboard-created selections expose the same anchored comment action.";
const linkLabel = "Evidence link";
const secondDocumentTarget =
  "Second-document selection must never reuse the first document draft.";

await run();

async function run() {
  const fixtureDir = createFixture();
  const fixtureInventory = inventoryProject(fixtureDir);
  const fixtureServer = await startFixtureFileServer(
    fixtureDir,
    fixtureInventory
  );
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the comment composer browser test."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-comment-composer-chrome-")
  );
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
        directories: fixtureInventory.directories,
        files: fixtureInventory.files,
        projectName: basename(fixtureDir)
      })
    });
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 820,
      mobile: false,
      width: 1500
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await waitForVisualEditor(client);

    const initialFingerprint = fingerprintProject(fixtureDir);

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const paragraphAction = await waitForSelectionAction(
      client,
      paragraphTarget
    );
    assertActionInViewport(paragraphAction);
    await openSelectionComposer(client);
    const paragraphComposer = await waitForComposer(client, paragraphTarget);
    assertComposerInViewport(paragraphComposer);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a paragraph comment must not write project files."
    );

    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const tableAction = await waitForSelectionAction(client, tableTarget);
    assert.ok(tableAction.scrollY > 2000, "Table selection should require long scrolling.");
    assert.equal(tableAction.cellTag, "TD");
    assertActionInViewport(tableAction);
    await openSelectionComposer(client);
    const tableComposer = await waitForComposer(client, tableTarget);
    assertComposerInViewport(tableComposer);
    assert.match(tableComposer.preview, /surrounding table cell/i);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a table comment must not write project files."
    );

    for (const edgeScenario of [
      { text: paragraphTarget, block: "start" },
      { text: tableTarget, block: "end" },
      { text: leftEdgeTarget, block: "center" },
      { text: rightEdgeTarget, block: "center" }
    ]) {
      await selectVisualText(client, edgeScenario.text, {
        dispatchMouseUp: true,
        scrollBlock: edgeScenario.block
      });
      const action = await waitForSelectionAction(client, edgeScenario.text);
      assertActionInViewport(action);
      await dismissSelectionAction(client);
    }

    await selectVisualText(client, keyboardTarget, {
      dispatchMouseUp: false,
      scrollBlock: "center"
    });
    const keyboardAction = await waitForSelectionAction(client, keyboardTarget);
    assertActionInViewport(keyboardAction);
    await pressShortcut(client);
    const keyboardComposer = await waitForComposer(client, keyboardTarget);
    assertComposerInViewport(keyboardComposer);
    await pressEscape(client);
    await waitForComposerMissing(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Keyboard cancellation must not write project files."
    );

    await openWholeDocumentComposer(client);
    const wholeDocumentComposer = await waitForComposer(
      client,
      "Commenting on whole document"
    );
    assertComposerInViewport(wholeDocumentComposer);
    await cancelComposer(client);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      initialFingerprint,
      "Cancelling a whole-document comment must not write project files."
    );

    await selectVisualText(client, paragraphTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, paragraphTarget);
    await dismissSelectionAction(client);
    await selectDocument(client, "Notes");
    await waitForActiveDocument(client, "Notes");
    await selectVisualText(client, secondDocumentTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    const secondDocumentAction = await waitForSelectionAction(
      client,
      secondDocumentTarget
    );
    assert.equal(secondDocumentAction.selectedText, secondDocumentTarget);
    await dismissSelectionAction(client);
    await selectDocument(client, "Action Plan");
    await waitForActiveDocument(client, "Action Plan");
    await selectVisualText(client, tableTarget, {
      dispatchMouseUp: true,
      scrollBlock: "center"
    });
    await waitForSelectionAction(client, tableTarget);

    await openSelectionComposer(client);
    const submitComposer = await waitForComposer(client, tableTarget);
    assertComposerInViewport(submitComposer);
    if (screenshotPath) {
      await saveScreenshot(client, screenshotPath);
    }
    await fillComposer(client, "Fixture table-cell comment.");
    await clickComposerButton(client, "Save Comment");
    const createdComment = await waitForPersistedComment(
      fixtureDir,
      "doc_action",
      tableTarget
    );
    assert.equal(createdComment.anchor.kind, "selected_text");
    assert.equal(createdComment.anchor.selected_text, tableTarget);
    assert.equal(createdComment.anchor.anchor_context?.kind, "table_cell");
    await waitForCreatedCommentCard(client, createdComment.id);

    const submittedFingerprint = fingerprintProject(fixtureDir);
    await client.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForActiveDocument(client, "Action Plan");
    await waitForCreatedCommentCard(client, createdComment.id);
    assert.deepEqual(
      fingerprintProject(fixtureDir),
      submittedFingerprint,
      "Reloading the submitted fixture must not create additional writes."
    );

    const existingAnchorAudit = await auditExistingAnchors(client);
    assert.equal(existingAnchorAudit.activeSelectedTextComments >= 4, true);
    assert.equal(existingAnchorAudit.linkCommentPresent, true);
    assert.equal(existingAnchorAudit.multiBlockCommentPresent, true);

    console.log(
      JSON.stringify(
        {
          kind: "comment-selection-composer-browser",
          editorUrl,
          paragraphAction,
          tableAction,
          createdCommentId: createdComment.id,
          existingAnchorAudit,
          screenshotPath: screenshotPath ?? null
        },
        null,
        2
      )
    );
    console.log("Comment selection composer browser test passed.");
  } finally {
    await client?.close().catch(() => undefined);
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    await fixtureServer.forceClose().catch(() => undefined);
    rmSync(userDataDir, { force: true, recursive: true });
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "patchmark-comment-composer-"));
  const metadata = join(root, ".patchmark");
  const now = "2026-07-28T00:00:00.000Z";
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const actionMarkdown = createActionMarkdown();
  const notesMarkdown = [
    "# Notes",
    "",
    secondDocumentTarget,
    "",
    "A separate document confirms document-scoped selection state."
  ].join("\n");
  const documents = [
    createDocumentStore({
      comments: createExistingComments(actionMarkdown, now),
      displayTitle: "Action Plan",
      documentId: "doc_action",
      markdown: actionMarkdown,
      now,
      path: "action-plan.md",
      position: 1000,
      root,
      withBookmark: true
    }),
    createDocumentStore({
      comments: [],
      displayTitle: "Notes",
      documentId: "doc_notes",
      markdown: notesMarkdown,
      now,
      path: "notes.md",
      position: 2000,
      root,
      withBookmark: false
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    serializeJson({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "prj_comment_composer",
      title: "Comment composer fixture",
      created_at: now,
      manifest_revision: 1,
      documents
    })
  );
  return root;
}

function createActionMarkdown() {
  const filler = Array.from({ length: 55 }, (_, index) => [
    `## Operating context ${index + 1}`,
    "",
    `Long-scroll fixture paragraph ${index + 1}. `.repeat(8),
    ""
  ]).flat();

  return [
    "# Action Plan",
    "",
    paragraphTarget,
    "",
    keyboardTarget,
    "",
    `The [${linkLabel}](https://example.com/evidence) supports the current plan.`,
    "",
    "Multi-block anchor first paragraph.",
    "",
    "Multi-block anchor second paragraph.",
    "",
    ...filler,
    "## 10. Growth Path and Scenarios",
    "",
    "| Illustrative revenue logic | How to read it |",
    "| --- | --- |",
    `| ${leftEdgeTarget} | ${rightEdgeTarget} |`,
    `| ${tableTarget} | The first 3–6 months should produce the data needed for a real break-even model. |`,
    "",
    "## 11. Production, Capacity, and Operations",
    "",
    "Production growth must follow actual capacity, not only demand."
  ].join("\n");
}

function createExistingComments(markdown, now) {
  const paragraphStart = markdown.indexOf(paragraphTarget);
  const linkMarkdown = `[${linkLabel}](https://example.com/evidence)`;
  const linkStart = markdown.indexOf(linkMarkdown);
  const multiBlockText =
    "Multi-block anchor first paragraph.\n\nMulti-block anchor second paragraph.";
  const multiBlockStart = markdown.indexOf(multiBlockText);

  return [
    createComment({
      id: "PM-COMMENT-0001",
      now,
      selectedText: paragraphTarget,
      start: paragraphStart
    }),
    createComment({
      id: "PM-COMMENT-0002",
      now,
      selectedText: linkMarkdown,
      start: linkStart
    }),
    createComment({
      id: "PM-COMMENT-0003",
      now,
      selectedText: multiBlockText,
      start: multiBlockStart
    })
  ];
}

function createComment({ id, now, selectedText, start }) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      anchor_source: "markdown"
    },
    comment: `Existing anchor fixture ${id}.`,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now
  };
}

function createDocumentStore({
  comments,
  displayTitle,
  documentId,
  markdown,
  now,
  path,
  position,
  root,
  withBookmark
}) {
  writeFileSync(join(root, path), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  for (const directory of ["versions", "context-packs", "imports", "recovery"]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  writeFileSync(join(store, "comments.json"), serializeJson(comments));
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "review-batches.json"), "[]\n");
  writeFileSync(join(store, "review-queue-overrides.json"), "{}\n");
  writeFileSync(
    join(store, "manifest.json"),
    serializeJson({
      schema_version: 1,
      project_id: "prj_comment_composer",
      document_id: documentId,
      project_name: "Comment composer fixture",
      document_file: "document.md",
      created_at: now,
      updated_at: now,
      ...(withBookmark
        ? {
            reading_bookmark: {
              format_version: 1,
              document: {
                project_id: "prj_comment_composer",
                document_id: documentId
              },
              anchor: {
                kind: "selected_text",
                selected_text: paragraphTarget,
                markdown_start_offset: markdown.indexOf(paragraphTarget),
                markdown_end_offset:
                  markdown.indexOf(paragraphTarget) + paragraphTarget.length,
                anchor_source: "markdown"
              },
              created_at: now,
              updated_at: now
            }
          }
        : {})
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

async function waitForActiveDocument(client, title) {
  await waitFor(client, `active document ${title}`, `(() => {
    const status = document.querySelector("[aria-label='Workspace status']");
    return Boolean(status?.textContent?.includes("Document: ${escapeJs(title)}"));
  })()`);
}

async function waitForVisualEditor(client) {
  await waitFor(client, "visual editor", `(() => {
    const editor = document.querySelector("[aria-label='editable markdown']");
    return Boolean(editor && editor.getAttribute("contenteditable") === "true");
  })()`);
}

async function selectVisualText(
  client,
  selectedText,
  { dispatchMouseUp, scrollBlock }
) {
  await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector(".patchmark-prose");
      if (!root) throw new Error("Visual editor missing.");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent.includes(${JSON.stringify(selectedText)})) {
        node = walker.nextNode();
      }
      if (!node) throw new Error("Selection text missing: ${escapeJs(selectedText)}");
      const start = node.textContent.indexOf(${JSON.stringify(selectedText)});
      node.parentElement.scrollIntoView({ block: ${JSON.stringify(scrollBlock)}, inline: "nearest" });
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + ${selectedText.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      if (${dispatchMouseUp ? "true" : "false"}) {
        document.querySelector(".editor-body")
          .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      return selection.toString();
    })()`,
    userGesture: true
  });
}

async function waitForSelectionAction(client, expectedText) {
  return await waitFor(client, "selection action", `(() => {
    const action = document.querySelector("[data-testid='comment-selection-action']");
    const selection = window.getSelection();
    if (!action || selection?.toString() !== ${JSON.stringify(expectedText)}) {
      return null;
    }
    const rect = action.getBoundingClientRect();
    const style = getComputedStyle(action);
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const cell = range?.commonAncestorContainer.parentElement?.closest("td, th");
    const toolbar = document.querySelector(".mdxeditor-toolbar")?.getBoundingClientRect();
    return {
      selectedText: selection.toString(),
      cellTag: cell?.tagName ?? null,
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toolbarBottom: toolbar?.bottom ?? 0,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex
      }
    };
  })()`, (value) => Boolean(value));
}

function assertActionInViewport(action) {
  assert.equal(action.style.display === "none", false);
  assert.equal(action.style.visibility, "visible");
  assert.notEqual(action.style.opacity, "0");
  assert.notEqual(action.style.pointerEvents, "none");
  assert.ok(Number(action.style.zIndex) >= 70);
  assert.ok(action.rect.left >= 8);
  assert.ok(action.rect.top >= Math.max(8, action.toolbarBottom));
  assert.ok(action.rect.right <= action.viewport.width - 8);
  assert.ok(action.rect.bottom <= action.viewport.height - 8);
}

async function openSelectionComposer(client) {
  await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector("[data-testid='comment-selection-action']");
      if (!button) throw new Error("Selection action missing.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForComposer(client, expectedPreviewText) {
  return await waitFor(client, "comment composer", `(() => {
    const form = document.querySelector("[data-testid='comment-composer']");
    if (!form || !form.textContent.includes(${JSON.stringify(expectedPreviewText)})) {
      return null;
    }
    const rect = form.getBoundingClientRect();
    const input = form.querySelector("[data-comment-composer-input]");
    const style = getComputedStyle(form);
    return {
      preview: form.textContent,
      activeInput: document.activeElement === input,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents
      }
    };
  })()`, (value) => Boolean(value?.activeInput));
}

function assertComposerInViewport(composer) {
  assert.equal(composer.style.display === "none", false);
  assert.equal(composer.style.visibility, "visible");
  assert.notEqual(composer.style.opacity, "0");
  assert.notEqual(composer.style.pointerEvents, "none");
  assert.ok(composer.rect.left >= 0);
  assert.ok(composer.rect.top >= 0);
  assert.ok(composer.rect.right <= composer.viewport.width);
  assert.ok(composer.rect.bottom <= composer.viewport.height);
}

async function cancelComposer(client) {
  await clickComposerButton(client, "Cancel");
  await waitForComposerMissing(client);
}

async function clickComposerButton(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const form = document.querySelector("[data-testid='comment-composer']");
      const button = Array.from(form?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Composer button missing: ${escapeJs(text)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForComposerMissing(client) {
  await waitFor(client, "composer close", `(() => (
    !document.querySelector("[data-testid='comment-composer']") &&
    document.activeElement?.getAttribute("aria-label") === "editable markdown"
  ))()`);
}

async function dismissSelectionAction(client) {
  await evaluate(client, {
    expression: `(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(client, "selection action close", `(() => (
    !document.querySelector("[data-testid='comment-selection-action']")
  ))()`);
}

async function pressShortcut(client) {
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "M",
    code: "KeyM",
    modifiers: 9
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "M",
    code: "KeyM",
    modifiers: 9
  });
}

async function pressEscape(client) {
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape"
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape"
  });
}

async function openWholeDocumentComposer(client) {
  await evaluate(client, {
    expression: `(() => {
      window.getSelection()?.removeAllRanges();
      const editor = document.querySelector(".editor-body");
      const rect = editor.getBoundingClientRect();
      editor.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(rect.left + 24, 360),
        clientY: Math.min(rect.bottom - 24, 420)
      }));
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(client, "document context menu", `(() => (
    Boolean(document.querySelector("[aria-label='Patchmark document menu']"))
  ))()`);
  await clickButtonByText(client, "Add Comment to Document");
}

async function selectDocument(client, title) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.textContent.includes(${JSON.stringify(title)}));
      if (!button || button.disabled) throw new Error("Document button missing: ${escapeJs(title)}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function fillComposer(client, value) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("[data-comment-composer-input]");
      if (!textarea) throw new Error("Composer textarea missing.");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(textarea, ${JSON.stringify(value)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return textarea.value;
    })()`,
    userGesture: true
  });
}

async function waitForPersistedComment(fixtureDir, documentId, selectedText) {
  const commentsPath = join(
    fixtureDir,
    ".patchmark",
    "documents",
    documentId,
    "comments.json"
  );
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
    const comment = comments.find(
      (candidate) =>
        candidate.comment === "Fixture table-cell comment." &&
        candidate.anchor?.selected_text === selectedText
    );
    if (comment) {
      assert.equal(
        comments.filter(
          (candidate) => candidate.comment === "Fixture table-cell comment."
        ).length,
        1
      );
      return comment;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for the submitted table-cell comment.");
}

async function waitForCreatedCommentCard(client, commentId) {
  await waitFor(client, `comment card ${commentId}`, `(() => {
    const item = document.querySelector(${JSON.stringify(
      `[data-comment-id="${commentId}"]`
    )});
    return Boolean(
      item &&
      item.getAttribute("data-comment-anchor-kind") === "selected_text" &&
      item.getAttribute("data-comment-anchor-status") === "active"
    );
  })()`);
}

async function auditExistingAnchors(client) {
  return await evaluate(client, {
    expression: `(() => {
      const items = Array.from(document.querySelectorAll("[data-comment-anchor-kind='selected_text']"));
      return {
        activeSelectedTextComments: items.filter(
          (item) => item.getAttribute("data-comment-anchor-status") === "active"
        ).length,
        linkCommentPresent: Boolean(document.querySelector("[data-comment-id='PM-COMMENT-0002']")),
        multiBlockCommentPresent: Boolean(document.querySelector("[data-comment-id='PM-COMMENT-0003']"))
      };
    })()`
  });
}

async function saveScreenshot(client, path) {
  const result = await client.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

async function waitFor(
  client,
  label,
  expression,
  predicate = (value) => Boolean(value)
) {
  let latest = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (predicate(latest)) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}.\n${JSON.stringify(latest, null, 2)}`
  );
}

function fingerprintProject(root) {
  return Object.fromEntries(
    listFiles(root).map((path) => {
      const content = readFileSync(path);
      return [
        relative(root, path),
        createHash("sha256").update(content).digest("hex")
      ];
    })
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

function escapeJs(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { hostname, tmpdir } from "node:os";
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
import {
  PDF_EXPORT_FIXTURE,
  applyPdfExportProject
} from "./lib/fixtures/apply-pdf-export-project.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const configuredEvidenceRoot = process.env.PATCHMARK_PDF_EVIDENCE_DIR;
const evidenceRoot =
  configuredEvidenceRoot ?? mkdtempSync(join(tmpdir(), "patchmark-pdf-export-"));
const ownsEvidenceRoot = !configuredEvidenceRoot;
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 1100);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1500);
const cancelMarker = "UNSAVED CANCEL PDF SENTINEL";
const successMarker = "UNSAVED SUCCESS PDF SENTINEL";
const repeatMarker = "UNSAVED REPEAT PDF SENTINEL";
const codeBlockLines = [
  "export_scope=current_in_memory_markdown",
  "project_mutation=none"
];
const codeBlockToolbarText = "Plain text";
const codeBlockToolbarSelector =
  '.patchmark-pdf-mdx-editor .patchmark-pdf-prose [class*="_codeMirrorToolbar_"]';
const codeBlockWrapperSelector =
  '.patchmark-pdf-mdx-editor .patchmark-pdf-prose [class*="_codeMirrorWrapper_"]';
const paginationMarkers = Array.from(
  { length: 14 },
  (_, index) => `Evidence line ${String(index + 1).padStart(2, "0")}`
);
const shortDocumentMode = process.env.PATCHMARK_PDF_SHORT_DOCUMENT === "1";
const expectedPageCount = shortDocumentMode ? 1 : 2;
const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const copies = [];
let chrome;
let client;
let fixtureServer;
let userDataDir;

mkdirSync(evidenceRoot, { recursive: true });

try {
  const fixtureCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const secondCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(fixtureCopy, secondCopy);
  assert.deepEqual(digestProjectTree(fixtureCopy.projectRoot), sourceDigest);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigest);
  const projectDir = fixtureCopy.projectRoot;
  const fixtureContract = applyPdfExportProject(projectDir);
  const secondContract = applyPdfExportProject(secondCopy.projectRoot);
  if (shortDocumentMode) {
    const shortMarkdown = [
      `# ${fixtureContract.title}`,
      "",
      fixtureContract.activeDocumentSentinel,
      "",
      fixtureContract.selectedText,
      "",
      "## Short Export",
      "",
      "This bounded invented document verifies single-page print flow.",
      "",
      fixtureContract.finalSentinel
    ].join("\n");
    writeFileSync(join(projectDir, PDF_EXPORT_FIXTURE.fileName), shortMarkdown);
    writeFileSync(
      join(secondCopy.projectRoot, PDF_EXPORT_FIXTURE.fileName),
      shortMarkdown
    );
    fixtureContract.currentMarkdown = shortMarkdown;
    secondContract.currentMarkdown = shortMarkdown;
  }
  const variantDigest = digestProjectTree(projectDir);
  assert.deepEqual(fixtureContract, secondContract);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), variantDigest);

  const documentPath = join(projectDir, PDF_EXPORT_FIXTURE.fileName);
  const commentsPath = join(projectDir, ".patchmark", "comments.json");
  const manifestPath = join(projectDir, ".patchmark", "manifest.json");
  const versionPath = join(projectDir, fixtureContract.versionFile);
  const projectBytesBefore = new Map(
    [documentPath, commentsPath, manifestPath, versionPath].map((path) => [
      path,
      readFileSync(path)
    ])
  );
  const inventory = inventoryProject(projectDir);
  fixtureServer = await startFixtureFileServer(projectDir, inventory);
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome was not found for PDF export browser validation.");
  }

  await assertEditorIsReachable(editorUrl);
  userDataDir = mkdtempSync(join(tmpdir(), "patchmark-pdf-chrome-"));
  chrome = spawn(
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

  const browserWsUrl = await waitForDevToolsUrl(chrome);
  const pageWsUrl = await createPage(browserWsUrl, "about:blank");
  client = await CdpClient.connect(pageWsUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: basename(projectDir)
    })}\n${createPrintBoundaryShim()}`
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: viewportHeight,
    mobile: false,
    width: viewportWidth
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  const originalPageTitle = await evaluate(client, {
    expression: "document.title"
  });
  await clickButtonByText(client, "Open Project Folder");
  await waitForPdfProject(client, fixtureContract);
  await clickButtonByText(client, "Markdown Mode");
  await activateFixtureComment(client);
  await setEditorScrollPosition(client);

  await appendUnsavedMarkdown(client, cancelMarker);
  await focusButtonByText(client, "Export PDF");
  const stateBeforeCancel = await readEditorState(client, [cancelMarker]);
  await clickButtonByText(client, "Export PDF");
  await waitForPdfPreview(client, [cancelMarker]);
  assert.deepEqual(listPdfFiles(evidenceRoot), []);
  assert.equal(await readPrintBoundaryCount(client), 0);
  await closePdfPreviewWithEscape(client);
  const stateAfterCancel = await waitForPdfPreviewClosed(client, [cancelMarker]);
  assertEditorStatePreserved(stateAfterCancel, stateBeforeCancel);
  assert.equal(stateAfterCancel.focusedButtonText, "File");
  assert.equal(stateAfterCancel.editorInteractive, true);
  assert.deepEqual(listPdfFiles(evidenceRoot), []);

  await appendUnsavedMarkdown(client, successMarker);
  await focusButtonByText(client, "Export PDF");
  const stateBeforeFirstPrint = await readEditorState(client, [
    cancelMarker,
    successMarker
  ]);
  await clickButtonByText(client, "Export PDF");
  await waitForPdfPreview(client, [cancelMarker, successMarker]);
  const previewState = await readPreviewState(client);
  assertPreviewContract(previewState, fixtureContract, [cancelMarker, successMarker]);
  const screenshotPath = join(evidenceRoot, "synthetic-pdf-preview.png");
  const screenshot = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  const screenLayoutDiagnostic = await readLayoutState(client, "screen");
  writeFileSync(
    join(evidenceRoot, "screen-layout-diagnostic.json"),
    `${JSON.stringify(screenLayoutDiagnostic, null, 2)}\n`
  );
  const printLayoutDiagnostic = await readLayoutState(client, "print");
  writeFileSync(
    join(evidenceRoot, "print-layout-diagnostic.json"),
    `${JSON.stringify(printLayoutDiagnostic, null, 2)}\n`
  );
  const screenCodeBlockDiagnostic = await readCodeBlockState(client, "screen");
  writeFileSync(
    join(evidenceRoot, "screen-code-block-diagnostic.json"),
    `${JSON.stringify(screenCodeBlockDiagnostic, null, 2)}\n`
  );
  const printCodeBlockDiagnostic = await readCodeBlockState(client, "print");
  writeFileSync(
    join(evidenceRoot, "print-code-block-diagnostic.json"),
    `${JSON.stringify(printCodeBlockDiagnostic, null, 2)}\n`
  );
  const restoredScreenCodeBlockDiagnostic = await readCodeBlockState(
    client,
    "screen"
  );
  writeFileSync(
    join(evidenceRoot, "restored-screen-code-block-diagnostic.json"),
    `${JSON.stringify(restoredScreenCodeBlockDiagnostic, null, 2)}\n`
  );
  if (!shortDocumentMode) {
    assertScreenCodeBlockContract(screenCodeBlockDiagnostic);
    assertPrintCodeBlockContract(printCodeBlockDiagnostic);
    assertScreenCodeBlockGeometryPreserved(
      restoredScreenCodeBlockDiagnostic,
      screenCodeBlockDiagnostic
    );
  }

  await triggerPrintBoundary(client, 1, fixtureContract.suggestedName);
  const firstPdfPath = join(evidenceRoot, "synthetic-pdf-export-first.pdf");
  await writeChromePdf(client, firstPdfPath);
  const firstInspection = inspectAndRenderPdf({
    evidenceRoot,
    expectedLastPageMarker: successMarker,
    expectedMarkers: [
      fixtureContract.title,
      fixtureContract.activeDocumentSentinel,
      ...(shortDocumentMode ? [] : paginationMarkers),
      ...(shortDocumentMode ? [] : codeBlockLines),
      fixtureContract.finalSentinel,
      cancelMarker,
      successMarker
    ],
    forbiddenMarkers: [
      repeatMarker,
      codeBlockToolbarText,
      fixtureContract.commentOnlySentinel,
      fixtureContract.staleHistorySentinel
    ],
    pdfPath: firstPdfPath,
    renderDirectory: join(evidenceRoot, "first-rendered-pages")
  });
  await waitForPrintIdle(client, originalPageTitle);
  await closePdfPreview(client);
  const stateAfterFirstPrint = await waitForPdfPreviewClosed(client, [
    cancelMarker,
    successMarker
  ]);
  assertEditorStatePreserved(stateAfterFirstPrint, stateBeforeFirstPrint);
  assert.equal(stateAfterFirstPrint.focusedButtonText, "File");
  assert.equal(stateAfterFirstPrint.editorInteractive, true);

  await appendUnsavedMarkdown(client, repeatMarker);
  await focusButtonByText(client, "Export PDF");
  const stateBeforeSecondPrint = await readEditorState(client, [
    cancelMarker,
    successMarker,
    repeatMarker
  ]);
  await clickButtonByText(client, "Export PDF");
  await waitForPdfPreview(client, [cancelMarker, successMarker, repeatMarker]);
  const repeatedPreviewState = await readPreviewState(client);
  assertPreviewContract(repeatedPreviewState, fixtureContract, [
    cancelMarker,
    successMarker,
    repeatMarker
  ]);
  await triggerPrintBoundary(client, 2, fixtureContract.suggestedName);
  const secondPdfPath = join(evidenceRoot, "synthetic-pdf-export-second.pdf");
  await writeChromePdf(client, secondPdfPath);
  const secondInspection = inspectAndRenderPdf({
    evidenceRoot,
    expectedLastPageMarker: repeatMarker,
    expectedMarkers: [
      fixtureContract.title,
      fixtureContract.activeDocumentSentinel,
      ...(shortDocumentMode ? [] : paginationMarkers),
      ...(shortDocumentMode ? [] : codeBlockLines),
      fixtureContract.finalSentinel,
      cancelMarker,
      successMarker,
      repeatMarker
    ],
    forbiddenMarkers: [
      codeBlockToolbarText,
      fixtureContract.commentOnlySentinel,
      fixtureContract.staleHistorySentinel
    ],
    pdfPath: secondPdfPath,
    renderDirectory: join(evidenceRoot, "second-rendered-pages")
  });
  assert.doesNotMatch(firstInspection.normalizedText, new RegExp(repeatMarker));
  assert.match(secondInspection.normalizedText, new RegExp(repeatMarker));
  assert.notEqual(firstInspection.semanticDigest, secondInspection.semanticDigest);
  await waitForPrintIdle(client, originalPageTitle);
  await closePdfPreview(client);
  const stateAfterSecondPrint = await waitForPdfPreviewClosed(client, [
    cancelMarker,
    successMarker,
    repeatMarker
  ]);
  assertEditorStatePreserved(stateAfterSecondPrint, stateBeforeSecondPrint);
  assert.equal(stateAfterSecondPrint.focusedButtonText, "File");
  assert.equal(stateAfterSecondPrint.editorInteractive, true);

  const printBoundaryCalls = await evaluate(client, {
    expression: "window.__PATCHMARK_PDF_PRINT_CALLS__ ?? []"
  });
  assert.equal(printBoundaryCalls.length, 2);
  assert.equal(
    printBoundaryCalls.every(
      (call) =>
        call.title === fixtureContract.suggestedName.replace(/\.pdf$/i, "")
    ),
    true
  );
  assert.match(printBoundaryCalls[0].previewText, new RegExp(successMarker));
  assert.doesNotMatch(printBoundaryCalls[0].previewText, new RegExp(repeatMarker));
  assert.match(printBoundaryCalls[1].previewText, new RegExp(repeatMarker));

  for (const [path, bytes] of projectBytesBefore) {
    assert.deepEqual(readFileSync(path), bytes);
  }
  assert.deepEqual(digestProjectTree(projectDir), variantDigest);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), variantDigest);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);

  const lifecycleManifest = {
    cancellation: {
      outputCount: 0,
      printBoundaryCalls: 0,
      stateRestored: true
    },
    fixture: {
      digest: variantDigest.digest,
      documentId: fixtureContract.documentId,
      projectId: fixtureContract.projectId,
      sourceDigest: sourceDigest.digest
    },
    outputs: [firstInspection, secondInspection].map((inspection) => ({
      fileBytes: inspection.fileBytes,
      pageCount: inspection.pageCount,
      pageSizes: inspection.pageSizes,
      pdfPath: inspection.pdfPath,
      pdfSha256: inspection.pdfSha256,
      pdfVersion: inspection.pdfVersion,
      semanticDigest: inspection.semanticDigest,
      title: inspection.title
    })),
    codeBlock: {
      print: printCodeBlockDiagnostic,
      restoredScreen: restoredScreenCodeBlockDiagnostic,
      screen: screenCodeBlockDiagnostic
    },
    printBoundaryCalls: printBoundaryCalls.length,
    repeatedOutputFresh: true,
    screenshotPath
  };
  writeFileSync(
    join(evidenceRoot, "pdf-export-lifecycle-manifest.json"),
    `${JSON.stringify(lifecycleManifest, null, 2)}\n`
  );
  console.log(JSON.stringify(lifecycleManifest, null, 2));
  console.log("PDF export browser tests passed.");
} finally {
  await client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 1000);
    }
    chrome.stderr?.destroy();
  }
  await fixtureServer?.forceClose();
  if (userDataDir) {
    rmSync(userDataDir, { force: true, recursive: true });
  }
  for (const copy of copies.reverse()) {
    copy.cleanup();
    assert.equal(existsSync(copy.temporaryRoot), false);
  }
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
  if (ownsEvidenceRoot) {
    rmSync(evidenceRoot, { force: true, recursive: true });
    assert.equal(existsSync(evidenceRoot), false);
  }
}

function createPrintBoundaryShim() {
  return `(() => {
    window.__PATCHMARK_PDF_PRINT_CALLS__ = [];
    Object.defineProperty(window, "print", {
      configurable: true,
      value: () => {
        window.__PATCHMARK_PDF_PRINT_CALLS__.push({
          previewText: document.querySelector(".pdf-export-document")?.textContent ?? "",
          title: document.title
        });
      },
      writable: true
    });
  })();`;
}

async function activateFixtureComment(client) {
  await evaluate(client, {
    expression: `(() => {
      const row = document.querySelector(${JSON.stringify(
        `[data-comment-id="${PDF_EXPORT_FIXTURE.activeCommentId}"]`
      )});
      const card = row?.querySelector("article");
      if (!(card instanceof HTMLElement)) {
        throw new Error("Deterministic PDF comment is unavailable");
      }
      card.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(
      `[data-comment-id="${PDF_EXPORT_FIXTURE.activeCommentId}"] article`
    )})?.getAttribute("aria-current") === "true"`,
    "active PDF fixture comment"
  );
}

async function setEditorScrollPosition(client) {
  await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.scrollTop = Math.min(120, textarea.scrollHeight - textarea.clientHeight);
      window.scrollTo(0, Math.min(80, document.documentElement.scrollHeight - innerHeight));
      return true;
    })()`
  });
}

async function readEditorState(client, markers = []) {
  return evaluate(client, {
    expression: `(() => {
      const markers = ${JSON.stringify(markers)};
      const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");
      const markdown = textarea?.value ?? "";
      const modeButton = Array.from(document.querySelectorAll(".mode-switcher button"))
        .find((button) => button.getAttribute("aria-pressed") === "true");
      return {
        activeCommentId: document.querySelector("article[aria-current='true']")
          ?.closest("[data-comment-id]")?.dataset.commentId ?? null,
        editorInteractive: textarea instanceof HTMLTextAreaElement && !textarea.disabled,
        focusedButtonText: document.activeElement instanceof HTMLButtonElement
          ? document.activeElement.textContent?.trim() ?? null
          : null,
        markdownLength: markdown.length,
        markerPresence: Object.fromEntries(markers.map((marker) => [marker, markdown.includes(marker)])),
        mode: modeButton?.textContent?.trim() ?? null,
        scrollY: window.scrollY,
        textareaScrollTop: textarea?.scrollTop ?? null
      };
    })()`
  });
}

function assertEditorStatePreserved(actual, expected) {
  assert.equal(actual.activeCommentId, expected.activeCommentId);
  assert.equal(actual.markdownLength, expected.markdownLength);
  assert.deepEqual(actual.markerPresence, expected.markerPresence);
  assert.equal(actual.mode, "Markdown Mode");
  assert.equal(actual.scrollY, expected.scrollY);
  assert.equal(actual.textareaScrollTop, expected.textareaScrollTop);
}

async function focusButtonByText(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && !element.disabled);
      const menu = button?.closest("[role='menu']");
      if (!menu?.hidden) return true;
      document.getElementById(menu.getAttribute("aria-labelledby"))?.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && !element.disabled);
      return Boolean(button && !button.closest("[role='menu']")?.hidden);
    })()`,
    `visible button ${text}`
  );
  const focused = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && !element.disabled);
      button?.focus();
      return document.activeElement === button;
    })()`,
    userGesture: true
  });
  assert.equal(focused, true, `Could not focus button: ${text}`);
}

async function closePdfPreview(client) {
  await evaluate(client, {
    expression: `document.querySelector(".pdf-export-close")?.click()`,
    userGesture: true
  });
}

async function closePdfPreviewWithEscape(client) {
  await client.call("Input.dispatchKeyEvent", {
    code: "Escape",
    key: "Escape",
    type: "keyDown"
  });
  await client.call("Input.dispatchKeyEvent", {
    code: "Escape",
    key: "Escape",
    type: "keyUp"
  });
}

async function waitForPdfPreviewClosed(client, markers = []) {
  let latestState = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await readEditorState(client, markers);
    const overlayState = await evaluate(client, {
      expression: `({
        bodyClass: document.body.classList.contains("patchmark-pdf-preview-open"),
        hasPreview: Boolean(document.querySelector(".pdf-export-portal-root"))
      })`
    });
    latestState = { ...state, ...overlayState };

    if (!latestState.hasPreview && !latestState.bodyClass) {
      return latestState;
    }
    await delay(50);
  }

  throw new Error(
    `Timed out waiting for PDF preview to close.\n${JSON.stringify(latestState, null, 2)}`
  );
}

async function waitForPdfProject(client, fixtureContract) {
  await waitFor(
    client,
    `(() => {
      const statusText = document.querySelector("[aria-label='Workspace status']")?.textContent ?? "";
      const exportButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Export PDF");
      return statusText.includes("Project: Synthetic Atlas") &&
        statusText.includes("Document: document.md") &&
        Boolean(exportButton && !exportButton.disabled) &&
        document.body.textContent?.includes(${JSON.stringify(fixtureContract.activeDocumentSentinel)}) &&
        Boolean(document.querySelector(${JSON.stringify(
          `[data-comment-id="${PDF_EXPORT_FIXTURE.activeCommentId}"] article`
        )}));
    })()`,
    "deterministic PDF export project"
  );
}

async function appendUnsavedMarkdown(client, marker) {
  const result = await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: "missing textarea" };
      }
      const previousValue = textarea.value;
      const nextValue = previousValue + "\\n\\n## ${escapeForTemplateLiteral(marker)}\\n\\nThis unsaved invented section must appear only after the current export target captures it.\\n";
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, nextValue);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: nextValue.slice(previousValue.length),
        inputType: "insertText"
      }));
      return {
        ok: textarea.value === nextValue,
        reason: textarea.value === nextValue ? null : "value did not update"
      };
    })()`,
    userGesture: true
  });
  assert.equal(result.ok, true, result.reason ?? "Markdown append failed");
}

async function waitForPdfPreview(client, markers) {
  await waitFor(
    client,
    `(() => {
      const preview = document.querySelector(".pdf-export-document");
      const printButton = Array.from(document.querySelectorAll(".pdf-export-controls button"))
        .find((button) => button.textContent?.trim() === "Print / Save PDF");
      const text = preview?.textContent ?? "";
      return Boolean(preview) &&
        ${JSON.stringify(markers)}.every((marker) => text.includes(marker)) &&
        !document.querySelector(".pdf-export-render-loading") &&
        !document.querySelector(".pdf-export-render-error") &&
        document.activeElement === printButton;
    })()`,
    "ready PDF preview"
  );
}

async function readPreviewState(client) {
  return evaluate(client, {
    expression: `(() => {
      const portal = document.querySelector(".pdf-export-portal-root");
      const dialog = document.querySelector(".pdf-export-dialog");
      const preview = document.querySelector(".pdf-export-document");
      const controls = document.querySelector(".pdf-export-controls");
      const printButton = controls?.querySelector("button");
      const collectCss = (rules) => Array.from(rules ?? []).flatMap((rule) => [
        String(rule.cssText),
        ...collectCss(rule.cssRules)
      ]);
      const cssRules = Array.from(document.styleSheets)
        .flatMap((sheet) => {
          try {
            return collectCss(sheet.cssRules);
          } catch {
            return [];
          }
        });
      const cssText = cssRules.join("\\n");
      const pageRule = cssRules.find((rule) => rule.trim().startsWith("@page")) ?? "";
      return {
        bodyClass: document.body.classList.contains("patchmark-pdf-preview-open"),
        controlsText: controls?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        dialogLabel: dialog?.getAttribute("aria-labelledby") ?? null,
        dialogModal: dialog?.getAttribute("aria-modal") ?? null,
        focusedPrintButton: document.activeElement === printButton,
        parentIsBody: portal?.parentElement === document.body,
        previewText: preview?.textContent ?? "",
        printRules: {
          a4: /size:\\s*a4(?:\\s+portrait)?/i.test(pageRule),
          hideApp: cssText.includes("body.patchmark-pdf-preview-open > :not(.pdf-export-portal-root)"),
          hideControls: cssText.includes("body.patchmark-pdf-preview-open .pdf-export-controls"),
          margins: /margin:\\s*16mm 14mm 18mm/.test(pageRule),
          repeatTableHeader: cssText.includes("display: table-header-group")
        }
      };
    })()`
  });
}

function assertPreviewContract(previewState, fixtureContract, markers) {
  assert.equal(previewState.bodyClass, true);
  assert.ok(previewState.dialogLabel);
  assert.equal(previewState.dialogModal, "true");
  assert.equal(previewState.focusedPrintButton, true);
  assert.equal(previewState.parentIsBody, true);
  assert.match(previewState.controlsText, new RegExp(fixtureContract.title));
  assert.match(previewState.controlsText, new RegExp(fixtureContract.suggestedName));
  for (const marker of [
    fixtureContract.activeDocumentSentinel,
    fixtureContract.finalSentinel,
    ...markers
  ]) {
    assert.match(previewState.previewText, new RegExp(marker));
  }
  for (const marker of [
    fixtureContract.commentOnlySentinel,
    fixtureContract.staleHistorySentinel,
    "Document Outline",
    "Comments",
    "Version History",
    "Loading PDF preview",
    "Print / Save PDF"
  ]) {
    assert.doesNotMatch(previewState.previewText, new RegExp(marker));
  }
  assert.deepEqual(previewState.printRules, {
    a4: true,
    hideApp: true,
    hideControls: true,
    margins: true,
    repeatTableHeader: true
  });
}

async function triggerPrintBoundary(client, expectedCount, suggestedName) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".pdf-export-controls button"))
        .find((candidate) => candidate.textContent?.trim() === "Print / Save PDF");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Print / Save PDF button is unavailable");
      }
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `window.__PATCHMARK_PDF_PRINT_CALLS__?.length === ${expectedCount} &&
      document.title === ${JSON.stringify(suggestedName.replace(/\.pdf$/i, ""))}`,
    `print boundary call ${expectedCount}`
  );
}

async function readLayoutState(client, media) {
  await client.call("Emulation.setEmulatedMedia", { media });
  try {
    return await evaluate(client, {
      expression: `(() => {
        const trackedProperties = [
          "align-self",
          "contain",
          "display",
          "flex",
          "flex-basis",
          "flex-grow",
          "flex-shrink",
          "grid-auto-rows",
          "grid-template-rows",
          "height",
          "max-height",
          "min-height",
          "overflow",
          "overflow-x",
          "overflow-y",
          "position",
          "transform"
        ];
        const printable = document.querySelector(".patchmark-pdf-prose");
        const printableRect = printable?.getBoundingClientRect();
        const describe = (element) => {
          const style = element ? getComputedStyle(element) : null;
          const rect = element?.getBoundingClientRect();
          const matchedRules = [];
          let cascadeOrder = 0;
          const visitRules = (rules, context, source) => {
            for (const rule of Array.from(rules ?? [])) {
              cascadeOrder += 1;
              if (rule instanceof CSSMediaRule) {
                if (matchMedia(rule.conditionText).matches) {
                  visitRules(
                    rule.cssRules,
                    [...context, "@media " + rule.conditionText],
                    source
                  );
                }
                continue;
              }
              if (rule instanceof CSSSupportsRule) {
                visitRules(
                  rule.cssRules,
                  [...context, "@supports " + rule.conditionText],
                  source
                );
                continue;
              }
              if (!(rule instanceof CSSStyleRule)) continue;
              try {
                if (!element.matches(rule.selectorText)) continue;
              } catch {
                continue;
              }
              const declarations = {};
              for (const property of trackedProperties) {
                const value = rule.style.getPropertyValue(property);
                if (value) {
                  declarations[property] = {
                    priority: rule.style.getPropertyPriority(property),
                    value
                  };
                }
              }
              if (Object.keys(declarations).length > 0) {
                matchedRules.push({
                  cascadeOrder,
                  context,
                  declarations,
                  selector: rule.selectorText,
                  source
                });
              }
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              visitRules(
                sheet.cssRules,
                [],
                sheet.href ?? sheet.ownerNode?.getAttribute("data-href") ?? "inline"
              );
            } catch {
              matchedRules.push({ source: sheet.href ?? "unreadable", unreadable: true });
            }
          }
          return {
            clientHeight: element?.clientHeight ?? null,
            clientWidth: element?.clientWidth ?? null,
            computed: style
              ? Object.fromEntries(
                  trackedProperties.map((property) => [
                    property,
                    style.getPropertyValue(property)
                  ])
                )
              : null,
            contentExtendsBelow: Boolean(
              printableRect && rect && printableRect.bottom > rect.bottom + 0.5
            ),
            id: element?.id || null,
            label:
              element === document.documentElement
                ? "html"
                : element === document.body
                  ? "body"
                  : (element?.tagName.toLowerCase() ?? "missing") +
                    (element?.classList.length
                      ? "." + Array.from(element.classList).join(".")
                      : ""),
            matchedRules,
            display: style?.display ?? null,
            height: style?.height ?? null,
            overflow: style?.overflow ?? null,
            rectBottom: rect?.bottom ?? null,
            rectHeight: rect?.height ?? null,
            rectLeft: rect?.left ?? null,
            rectRight: rect?.right ?? null,
            rectTop: rect?.top ?? null,
            scrollHeight: element?.scrollHeight ?? null,
            scrollWidth: element?.scrollWidth ?? null
          };
        };
        const previewText = document.querySelector(".pdf-export-document")?.textContent ?? "";
        const ancestors = [];
        for (let element = printable; element; element = element.parentElement) {
          ancestors.push(describe(element));
          if (element === document.documentElement) break;
        }
        return {
          ancestors,
          media: ${JSON.stringify(media)},
          previewHasFinalSentinel: previewText.includes(${JSON.stringify(PDF_EXPORT_FIXTURE.finalSentinel)}),
          previewHasSuccessSentinel: previewText.includes(${JSON.stringify(successMarker)}),
          viewport: {
            height: innerHeight,
            width: innerWidth
          }
        };
      })()`
    });
  } finally {
    await client.call("Emulation.setEmulatedMedia", { media: "" });
  }
}

async function readCodeBlockState(client, media) {
  await client.call("Emulation.setEmulatedMedia", { media });
  try {
    return await evaluate(client, {
      expression: `(() => {
        const toolbar = document.querySelector(${JSON.stringify(codeBlockToolbarSelector)});
        const wrapper = document.querySelector(${JSON.stringify(codeBlockWrapperSelector)});
        const codeContent = wrapper?.querySelector(".cm-content");
        const printable = document.querySelector(".patchmark-pdf-prose");
        const findExactText = (selector, text) =>
          Array.from(printable?.querySelectorAll(selector) ?? []).find(
            (element) => element.textContent?.trim() === text
          );
        const describe = (element) => {
          const style = element ? getComputedStyle(element) : null;
          const rect = element?.getBoundingClientRect();
          return {
            className: element?.getAttribute("class") ?? null,
            clientHeight: element?.clientHeight ?? null,
            clientWidth: element?.clientWidth ?? null,
            computed: style
              ? {
                  backgroundColor: style.backgroundColor,
                  border: style.border,
                  display: style.display,
                  height: style.height,
                  opacity: style.opacity,
                  overflow: style.overflow,
                  padding: style.padding,
                  pointerEvents: style.pointerEvents,
                  position: style.position,
                  visibility: style.visibility,
                  width: style.width,
                  zIndex: style.zIndex
                }
              : null,
            rect: rect
              ? {
                  bottom: rect.bottom,
                  height: rect.height,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  width: rect.width
                }
              : null,
            scrollHeight: element?.scrollHeight ?? null,
            scrollWidth: element?.scrollWidth ?? null,
            tagName: element?.tagName ?? null,
            text: element?.textContent?.replace(/\\s+/g, " ").trim() ?? null
          };
        };
        const matchingRules = [];
        const visitRules = (rules, context, source) => {
          for (const rule of Array.from(rules ?? [])) {
            if (rule instanceof CSSMediaRule) {
              if (matchMedia(rule.conditionText).matches) {
                visitRules(rule.cssRules, [...context, "@media " + rule.conditionText], source);
              }
              continue;
            }
            if (!(rule instanceof CSSStyleRule) || !toolbar) continue;
            try {
              if (!toolbar.matches(rule.selectorText)) continue;
            } catch {
              continue;
            }
            matchingRules.push({
              context,
              cssText: rule.style.cssText,
              selector: rule.selectorText,
              source
            });
          }
        };
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            visitRules(
              sheet.cssRules,
              [],
              sheet.href ?? sheet.ownerNode?.getAttribute("data-href") ?? "inline"
            );
          } catch {
            matchingRules.push({ source: sheet.href ?? "unreadable", unreadable: true });
          }
        }
        return {
          codeContent: describe(codeContent),
          codeLines: Array.from(wrapper?.querySelectorAll(".cm-line") ?? [], (line) =>
            line.textContent ?? ""
          ),
          controls: Array.from(toolbar?.querySelectorAll("button, [role='button'], [role='combobox']") ?? [], (control) => ({
            ariaLabel: control.getAttribute("aria-label"),
            disabled: control instanceof HTMLButtonElement ? control.disabled : null,
            rect: describe(control).rect,
            role: control.getAttribute("role"),
            tabIndex: control.tabIndex,
            tagName: control.tagName,
            text: control.textContent?.replace(/\\s+/g, " ").trim() ?? "",
            title: control.getAttribute("title")
          })),
          matchingRules,
          media: ${JSON.stringify(media)},
          selector: ${JSON.stringify(codeBlockToolbarSelector)},
          surrounding: {
            after: describe(findExactText("p", ${JSON.stringify(PDF_EXPORT_FIXTURE.finalSentinel)})),
            before: describe(findExactText("h2", "Final Verification"))
          },
          toolbar: describe(toolbar),
          toolbarContainedByWrapper: Boolean(toolbar && wrapper?.contains(toolbar)),
          toolbarNextSiblingContainsCode: Boolean(
            toolbar?.nextElementSibling && toolbar.nextElementSibling.contains(codeContent)
          ),
          wrapper: describe(wrapper)
        };
      })()`
    });
  } finally {
    await client.call("Emulation.setEmulatedMedia", { media: "" });
  }
}

function assertScreenCodeBlockContract(state) {
  assert.equal(state.media, "screen");
  assert.equal(state.toolbarContainedByWrapper, true);
  assert.equal(state.toolbarNextSiblingContainsCode, true);
  assert.match(state.toolbar.className, /_codeMirrorToolbar_/);
  assert.match(state.wrapper.className, /_codeMirrorWrapper_/);
  assert.equal(state.toolbar.computed.display, "flex");
  assert.equal(state.toolbar.computed.position, "absolute");
  assert.equal(state.toolbar.computed.visibility, "visible");
  assert.ok(state.toolbar.rect.width > 0);
  assert.ok(state.toolbar.rect.height > 0);
  assert.deepEqual(state.codeLines, codeBlockLines);
  assert.equal(state.codeContent.computed.display, "block");
  assert.equal(state.codeContent.computed.visibility, "visible");
  assert.equal(state.controls.length, 2);
  assert.deepEqual(
    state.controls.map(({ ariaLabel, disabled, role, text, title }) => ({
      ariaLabel,
      disabled,
      role,
      text,
      title
    })),
    [
      {
        ariaLabel: "Language",
        disabled: true,
        role: "combobox",
        text: codeBlockToolbarText,
        title: null
      },
      {
        ariaLabel: null,
        disabled: true,
        role: null,
        text: "",
        title: "Delete code block"
      }
    ]
  );
}

function assertPrintCodeBlockContract(state) {
  assert.equal(state.media, "print");
  assert.equal(state.toolbarContainedByWrapper, true);
  assert.equal(state.toolbarNextSiblingContainsCode, true);
  assert.equal(state.toolbar.computed.display, "none");
  assert.deepEqual(state.codeLines, codeBlockLines);
  assert.equal(state.codeContent.computed.display, "block");
  assert.equal(state.codeContent.computed.visibility, "visible");
  assert.ok(state.codeContent.rect.width > 0);
  assert.ok(state.codeContent.rect.height > 0);
  assert.ok(state.codeContent.scrollWidth <= state.codeContent.clientWidth + 1);
  assert.ok(state.codeContent.scrollHeight <= state.codeContent.clientHeight + 1);
  for (const property of ["height", "width"]) {
    assert.equal(state.toolbar.rect[property], 0);
    for (const control of state.controls) {
      assert.equal(control.rect[property], 0);
    }
  }
  assert.equal(
    state.matchingRules.some(
      (rule) =>
        rule.context?.includes("@media print") &&
        rule.selector?.includes('[class*="_codeMirrorToolbar_"]') &&
        /display:\s*none/.test(rule.cssText)
    ),
    true
  );
  assert.ok(state.codeContent.rect.left >= state.wrapper.rect.left);
  assert.ok(state.codeContent.rect.right <= state.wrapper.rect.right);
  assert.ok(state.codeContent.rect.top >= state.wrapper.rect.top);
  assert.ok(state.codeContent.rect.bottom <= state.wrapper.rect.bottom);
  assert.ok(state.wrapper.rect.top >= state.surrounding.before.rect.bottom);
  assert.ok(state.surrounding.after.rect.top >= state.wrapper.rect.bottom);
}

function assertScreenCodeBlockGeometryPreserved(actual, expected) {
  for (const key of ["codeContent", "controls", "surrounding", "toolbar", "wrapper"]) {
    assert.deepEqual(actual[key], expected[key]);
  }
  assert.deepEqual(actual.codeLines, expected.codeLines);
}

async function readPrintBoundaryCount(client) {
  return evaluate(client, {
    expression: "window.__PATCHMARK_PDF_PRINT_CALLS__?.length ?? 0"
  });
}

async function waitForPrintIdle(client, originalPageTitle) {
  await waitFor(
    client,
    `(() => {
      const button = document.querySelector(".pdf-export-controls button");
      return button?.textContent?.trim() === "Print / Save PDF" &&
        button?.getAttribute("aria-busy") === "false" &&
        !button.disabled &&
        document.title === ${JSON.stringify(originalPageTitle)};
    })()`,
    "PDF print control idle"
  );
}

async function writeChromePdf(client, pdfPath) {
  assert.equal(existsSync(pdfPath), false, `PDF output already exists: ${pdfPath}`);
  const pdf = await client.call("Page.printToPDF", {
    displayHeaderFooter: false,
    landscape: false,
    preferCSSPageSize: true,
    printBackground: true
  });
  const bytes = Buffer.from(pdf.data, "base64");
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(bytes.length > 10_000);
  writeFileSync(pdfPath, bytes);
}

function inspectAndRenderPdf({
  evidenceRoot,
  expectedLastPageMarker,
  expectedMarkers,
  forbiddenMarkers,
  pdfPath,
  renderDirectory
}) {
  const fileBytes = statSync(pdfPath).size;
  const pdfSha256 = createHash("sha256")
    .update(readFileSync(pdfPath))
    .digest("hex");
  const initialInfo = runCommand("pdfinfo", [pdfPath]);
  const pageCount = Number(readPdfInfoField(initialInfo, "Pages"));
  assert.equal(pageCount, expectedPageCount);
  const detailedInfo = runCommand("pdfinfo", [
    "-f",
    "1",
    "-l",
    String(pageCount),
    "-box",
    pdfPath
  ]);
  const pdfVersion = readPdfInfoField(detailedInfo, "PDF version");
  const title = readPdfInfoField(detailedInfo, "Title");
  assert.equal(title, PDF_EXPORT_FIXTURE.suggestedName.replace(/\.pdf$/i, ""));
  const pageSizes = Array.from(
    detailedInfo.matchAll(/Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/g),
    (match) => ({
      height: Number(match[3]),
      page: Number(match[1]),
      width: Number(match[2])
    })
  );
  assert.equal(pageSizes.length, pageCount);
  for (const pageSize of pageSizes) {
    assert.ok(Math.abs(pageSize.width - 595.28) <= 0.5);
    assert.ok(Math.abs(pageSize.height - 841.89) <= 0.5);
  }

  const pdfKitInspection = inspectPdfWithPdfKit(pdfPath);
  assert.equal(pdfKitInspection.pageCount, pageCount);
  assert.equal(pdfKitInspection.pageTexts.length, pageCount);
  const normalizedPageTexts = pdfKitInspection.pageTexts.map(normalizePdfText);
  const normalizedText = normalizePdfText(pdfKitInspection.pageTexts.join("\n"));
  const pageNonblank = normalizedPageTexts.map((text) => text.length > 0);
  assert.equal(
    pageNonblank.every(Boolean),
    true,
    `PDF contains a blank content page: ${JSON.stringify(pageNonblank)}`
  );
  if (!shortDocumentMode) {
    assert.equal(countOccurrences(normalizedText, codeBlockLines.join(" ")), 1);
  }
  let previousIndex = -1;
  for (const marker of expectedMarkers) {
    const markerIndex = normalizedText.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `PDF marker order failed for ${marker}`);
    assert.equal(countOccurrences(normalizedText, marker), 1);
    previousIndex = markerIndex;
  }
  for (const marker of [
    ...forbiddenMarkers,
    "Document Outline",
    "Generate ChatGPT Prompt",
    "Import ChatGPT Response",
    "Clean Shareholder PDF Preview",
    "Loading PDF preview",
    "Print / Save PDF",
    evidenceRoot,
    process.env.USER ?? "",
    hostname()
  ].filter(Boolean)) {
    assert.doesNotMatch(normalizedText, new RegExp(escapeRegExp(marker)));
  }
  assert.match(normalizedPageTexts.at(-1), new RegExp(expectedLastPageMarker));

  assert.equal(existsSync(renderDirectory), false);
  mkdirSync(renderDirectory, { recursive: true });
  runCommand("pdftoppm", [
    "-png",
    "-r",
    "96",
    pdfPath,
    join(renderDirectory, "page")
  ]);
  const renderedPages = readdirSync(renderDirectory)
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => {
      const path = join(renderDirectory, file);
      const dimensions = readPngDimensions(path);
      assert.ok(statSync(path).size > 10_000);
      assert.ok(dimensions.width >= 790 && dimensions.width <= 800);
      assert.ok(dimensions.height >= 1120 && dimensions.height <= 1130);
      return { file, ...dimensions };
    });
  assert.equal(renderedPages.length, pageCount);

  const semanticManifest = {
    normalization: {
      excluded: [
        "creation and modification dates",
        "trailer identifiers",
        "object ordering and compression",
        "font subset identifiers",
        "producer metadata"
      ],
      pageSizesRoundedByParser: true,
      textWhitespaceCollapsed: true
    },
    normalizedPageTexts,
    pageNonblank,
    pageCount,
    pageSizes,
    pdfVersion,
    title
  };
  const semanticDigest = createHash("sha256")
    .update(JSON.stringify(semanticManifest))
    .digest("hex");
  const manifestPath = `${pdfPath}.semantic.json`;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...semanticManifest,
        fileBytes,
        pdfPath,
        pdfSha256,
        renderedPages,
        semanticDigest
      },
      null,
      2
    )}\n`
  );

  return {
    fileBytes,
    normalizedText,
    pageCount,
    pageSizes,
    pdfPath,
    pdfSha256,
    pdfVersion,
    semanticDigest,
    title
  };
}

function inspectPdfWithPdfKit(pdfPath) {
  if (process.platform !== "darwin") {
    throw new Error("PDFKit semantic inspection requires macOS.");
  }
  const script = `ObjC.import("PDFKit");
ObjC.import("Foundation");
function run(argv) {
  const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!document) throw new Error("PDFKit could not open PDF");
  const pageCount = Number(ObjC.unwrap(document.pageCount));
  const pageTexts = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageTexts.push(ObjC.unwrap(document.pageAtIndex(index).string) || "");
  }
  return JSON.stringify({ pageCount, pageTexts });
}`;
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, pdfPath],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`PDFKit inspection failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

function runCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with ${result.status}: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function readPdfInfoField(output, field) {
  const match = new RegExp(`^${escapeRegExp(field)}:\\s*(.+)$`, "m").exec(output);
  if (!match?.[1]) {
    throw new Error(`pdfinfo field is unavailable: ${field}`);
  }
  return match[1].trim();
}

function readPngDimensions(path) {
  const bytes = readFileSync(path);
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16)
  };
}

function normalizePdfText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function countOccurrences(value, marker) {
  return value.split(marker).length - 1;
}

function listPdfFiles(root) {
  return readdirSync(root).filter((file) => file.endsWith(".pdf")).sort();
}

async function waitFor(client, expression, description) {
  let latestValue = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    latestValue = await evaluate(client, { expression });
    if (latestValue) {
      return latestValue;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}. Latest value: ${JSON.stringify(latestValue)}`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeForTemplateLiteral(value) {
  return value.replace(/[`\\$]/g, "\\$&");
}

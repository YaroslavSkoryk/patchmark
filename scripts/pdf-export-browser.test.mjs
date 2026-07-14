import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
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
const sourceProjectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const evidenceRoot =
  process.env.PATCHMARK_PDF_EVIDENCE_DIR ??
  mkdtempSync(join(tmpdir(), "patchmark-pdf-export-"));
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 1100);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1500);
const unsavedMarker = `PDF export unsaved marker ${Date.now()}`;
const secondUnsavedMarker = `PDF export reopened marker ${Date.now()}`;

if (!sourceProjectDir) {
  throw new Error("Set PATCHMARK_REAL_PROJECT_DIR to a real Patchmark project.");
}

mkdirSync(evidenceRoot, { recursive: true });

const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-pdf-fixture-"));
const projectDir = join(fixtureRoot, basename(sourceProjectDir));
cpSync(sourceProjectDir, projectDir, { recursive: true });

const documentPath = join(projectDir, "document.md");
const originalDocument = readFileSync(documentPath, "utf8");
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for PDF export browser validation.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-pdf-chrome-"));
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

const pdfPath = join(evidenceRoot, "patchmark-shareholder-clean.pdf");
const screenshotPath = join(evidenceRoot, "patchmark-shareholder-clean-preview.png");
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
      projectName: basename(projectDir)
    })
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: viewportHeight,
    mobile: false,
    width: viewportWidth
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  console.log("browser-step: editor shell ready");
  await clickButtonByText(client, "Open Project Folder");
  await waitForProjectLoaded(client);
  console.log("browser-step: project loaded");
  await clickButtonByText(client, "Markdown Mode");
  await appendUnsavedMarkdown(client, unsavedMarker);
  console.log("browser-step: unsaved edit added");
  await focusButtonByText(client, "Export PDF");
  const stateBeforeExport = await readEditorState(client, [unsavedMarker]);
  await clickButtonByText(client, "Export PDF");
  await waitForPdfPreview(client, unsavedMarker);
  console.log("browser-step: first preview open");

  const previewState = await evaluate(client, {
    expression: `(() => {
      const portal = document.querySelector(".pdf-export-portal-root");
      const preview = document.querySelector(".pdf-export-document");
      const controls = document.querySelector(".pdf-export-controls");
      return {
        bodyClass: document.body.classList.contains("patchmark-pdf-preview-open"),
        hasPreview: Boolean(preview),
        parentIsBody: portal?.parentElement === document.body,
        previewText: preview?.textContent ?? "",
        controlText: controls?.textContent ?? "",
        containsPatchmarkUiWords: /Document Outline|Comments|Version History|Generate ChatGPT Prompt|Import ChatGPT Response/.test(preview?.textContent ?? ""),
        printHiddenControlsRule: Array.from(document.styleSheets)
          .flatMap((sheet) => {
            try {
              return Array.from(sheet.cssRules);
            } catch {
              return [];
            }
          })
          .some((rule) => String(rule.cssText).includes("body.patchmark-pdf-preview-open .pdf-export-controls"))
      };
    })()`
  });

  assert.equal(previewState.bodyClass, true);
  assert.equal(previewState.hasPreview, true);
  assert.equal(previewState.parentIsBody, true);
  assert.match(previewState.previewText, new RegExp(escapeRegExp(unsavedMarker)));
  assert.equal(previewState.containsPatchmarkUiWords, false);
  assert.equal(previewState.printHiddenControlsRule, true);

  const screenshot = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log("browser-step: preview screenshot captured");

  const pdf = await client.call("Page.printToPDF", {
    displayHeaderFooter: false,
    landscape: false,
    preferCSSPageSize: true,
    printBackground: true
  });
  writeFileSync(pdfPath, Buffer.from(pdf.data, "base64"));
  console.log("browser-step: pdf generated");
  assert.ok(Buffer.byteLength(pdf.data, "base64") > 10_000);
  assert.equal(readFileSync(documentPath, "utf8"), originalDocument);
  await closePdfPreview(client);
  const stateAfterClose = await waitForPdfPreviewClosed(client, [unsavedMarker]);
  console.log("browser-step: first preview closed");

  assert.equal(stateAfterClose.activeCommentId, stateBeforeExport.activeCommentId);
  assert.equal(stateAfterClose.mode, "Markdown Mode");
  assert.equal(stateAfterClose.markdownLength, stateBeforeExport.markdownLength);
  assert.deepEqual(stateAfterClose.markerPresence, stateBeforeExport.markerPresence);
  assert.equal(stateAfterClose.scrollY, stateBeforeExport.scrollY);
  assert.equal(stateAfterClose.focusedButtonText, "Export PDF");

  assert.equal(readFileSync(documentPath, "utf8"), originalDocument);

  await appendUnsavedMarkdown(client, secondUnsavedMarker);
  console.log("browser-step: second unsaved edit added");
  await focusButtonByText(client, "Export PDF");
  await clickButtonByText(client, "Export PDF");
  await waitForPdfPreview(client, secondUnsavedMarker);
  console.log("browser-step: second preview open");
  await closePdfPreview(client);
  await waitForPdfPreviewClosed(client);
  console.log("browser-step: second preview closed");

  console.log(
    JSON.stringify(
      {
        fixtureDir: projectDir,
        pdfPath,
        screenshotPath,
        secondUnsavedMarker,
        unsavedMarker
      },
      null,
      2
    )
  );
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 1000);
  }
  await Promise.race([fixtureServer.close(), delay(3000)]);
  rmSync(fixtureRoot, { force: true, recursive: true });
  rmSync(userDataDir, { force: true, recursive: true });
}

async function readEditorState(client, markers = []) {
  return await evaluate(client, {
    expression: `(() => {
      const markers = ${JSON.stringify(markers)};
      const activeCard = document.querySelector("[id^='patchmark-comment-card-'][data-active='true']");
      const modeButton = Array.from(document.querySelectorAll(".mode-switcher button"))
        .find((button) => button.getAttribute("aria-pressed") === "true");
      const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");
      const markdown = textarea?.value ?? "";
      const activeButton = document.activeElement instanceof HTMLButtonElement
        ? document.activeElement.textContent?.trim() ?? null
        : null;

      return {
        activeCommentId: activeCard?.id ?? null,
        focusedButtonText: activeButton,
        markdownLength: markdown.length,
        markerPresence: Object.fromEntries(markers.map((marker) => [marker, markdown.includes(marker)])),
        mode: modeButton?.textContent?.trim() ?? null,
        scrollY: window.scrollY,
        textareaScrollTop: textarea?.scrollTop ?? null
      };
    })()`
  });
}

async function focusButtonByText(client, text) {
  const result = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && !element.disabled);

      if (!button) {
        return false;
      }

      button.focus();
      return document.activeElement === button;
    })()`,
    userGesture: true
  });

  assert.equal(result, true, `Could not focus button: ${text}`);
}

async function closePdfPreview(client) {
  await evaluate(client, {
    expression: `document.querySelector(".pdf-export-close")?.click()`,
    userGesture: true
  });
}

async function waitForPdfPreviewClosed(client, markers = []) {
  let latestState = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const markers = ${JSON.stringify(markers)};
        const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");
        const markdown = textarea?.value ?? "";
        const activeCard = document.querySelector("[id^='patchmark-comment-card-'][data-active='true']");
        const modeButton = Array.from(document.querySelectorAll(".mode-switcher button"))
          .find((button) => button.getAttribute("aria-pressed") === "true");
        const activeButton = document.activeElement instanceof HTMLButtonElement
          ? document.activeElement.textContent?.trim() ?? null
          : null;

        return {
          activeCommentId: activeCard?.id ?? null,
          bodyClass: document.body.classList.contains("patchmark-pdf-preview-open"),
          focusedButtonText: activeButton,
          hasPreview: Boolean(document.querySelector(".pdf-export-portal-root")),
          markdownLength: markdown.length,
          markerPresence: Object.fromEntries(markers.map((marker) => [marker, markdown.includes(marker)])),
          mode: modeButton?.textContent?.trim() ?? null,
          scrollY: window.scrollY
        };
      })()`
    });

    latestState = state;

    if (!state.hasPreview && !state.bodyClass) {
      return state;
    }

    await delay(50);
  }

  throw new Error(
    `Timed out waiting for PDF preview to close.\n${JSON.stringify(latestState, null, 2)}`
  );
}

async function waitForProjectLoaded(client) {
  let latestState = null;

  for (let attempt = 0; attempt < 180; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const statusText = document.querySelector("[aria-label='Workspace status']")?.textContent ?? "";
        const exportButton = Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Export PDF");
        return {
          statusText,
          canExport: Boolean(exportButton && !exportButton.disabled),
          bodyText: document.body.textContent?.slice(0, 1000)
        };
      })()`
    });

    latestState = state;

    if (state.statusText.includes("Patchmark Project") && state.canExport) {
      return;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for project load.\n${JSON.stringify(latestState, null, 2)}`
  );
}

async function appendUnsavedMarkdown(client, marker) {
  const result = await evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector("textarea[aria-label='Markdown Mode']");

      if (!textarea) {
        return { ok: false, reason: "missing textarea" };
      }

      const previousValue = textarea.value;
      const nextValue = previousValue + "\\n\\n## ${escapeForTemplateLiteral(marker)}\\n\\nThis unsaved heading should appear in the PDF export preview.\\n";
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

      valueSetter?.call(textarea, nextValue);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue.slice(previousValue.length) }));

      return {
        ok: textarea.value === nextValue,
        reason: textarea.value === nextValue ? null : "value did not update"
      };
    })()`,
    userGesture: true
  });

  assert.equal(result.ok, true, result.reason ?? "Markdown append failed");
}

async function waitForPdfPreview(client, marker) {
  let latestState = null;

  for (let attempt = 0; attempt < 180; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const preview = document.querySelector(".pdf-export-document");
        return {
          hasPreview: Boolean(preview),
          hasMarker: (preview?.textContent ?? "").includes(${JSON.stringify(marker)}),
          renderError: document.querySelector(".pdf-export-render-error")?.textContent ?? null
        };
      })()`
    });

    latestState = state;

    if (state.hasPreview && state.hasMarker && !state.renderError) {
      return;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for PDF preview.\n${JSON.stringify(latestState, null, 2)}`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeForTemplateLiteral(value) {
  return value.replace(/[`\\$]/g, "\\$&");
}

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
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-multi-browser-"));
const projectDir = join(fixtureRoot, "Crust Chant");
createMultiDocumentFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for multi-document browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-multi-browser-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless",
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
      projectName: "Crust Chant"
    })
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1000,
    mobile: false,
    width: 1500
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelectorAll(".project-document-item").length === 3`,
    "three project documents"
  );

  const initial = await readNavigatorState(client);
  assert.equal(initial.activeTitle, "Action Plan");
  assert.deepEqual(initial.titles, [
    "Action Plan",
    "Ready-to-Eat Investigation",
    "Evidence Summary"
  ]);
  assert.deepEqual(initial.roles, ["Decision", "Research", "Summary"]);

  await clickButtonByText(client, "Markdown Mode");
  await waitFor(client, `Boolean(document.querySelector(".markdown-source-editor"))`, "Markdown editor");
  const marker = `Switch barrier marker ${Date.now()}`;
  await appendMarkdown(client, marker);
  await clickProjectDocument(client, "Ready-to-Eat Investigation");
  await waitFor(
    client,
    `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Ready-to-Eat Investigation"`,
    "research document active"
  );
  await waitFor(
    client,
    `document.querySelector(".patchmark-prose")?.textContent?.includes("Research body")`,
    "research Markdown loaded"
  );
  assert.match(readFileSync(join(projectDir, "action-plan.md"), "utf8"), new RegExp(marker));

  await clickProjectDocument(client, "Action Plan");
  await waitFor(
    client,
    `Boolean(document.querySelector(".markdown-source-editor")) && document.querySelector(".markdown-source-editor")?.value.includes(${JSON.stringify(marker)})`,
    "Action Plan mode and content restored"
  );
  const restoredMode = await evaluate(client, {
    expression: `document.querySelector("button[aria-pressed='true']")?.textContent?.trim()`
  });
  assert.equal(restoredMode, "Markdown Mode");

  await renameDocument(client, "Ready-to-Eat Investigation", "RTE Investigation");
  await waitFor(
    client,
    `Array.from(document.querySelectorAll(".project-document-select span")).some((element) => element.textContent === "RTE Investigation")`,
    "renamed display title"
  );
  assert.match(
    readFileSync(join(projectDir, "ready-to-eat-investigation.md"), "utf8"),
    /^# Ready-to-Eat Investigation/m,
    "Display-title changes must not edit Markdown headings."
  );

  await archiveDocument(client, "RTE Investigation");
  await waitFor(
    client,
    `document.querySelector(".project-archived-documents summary")?.textContent?.includes("Archived (1)")`,
    "archived document group"
  );
  await clickButtonByText(client, "Restore");
  await waitFor(
    client,
    `!document.querySelector(".project-archived-documents") && Array.from(document.querySelectorAll(".project-document-select span")).some((element) => element.textContent === "RTE Investigation")`,
    "restored document"
  );

  const finalState = await readNavigatorState(client);
  assert.equal(finalState.activeTitle, "Action Plan");
  assert.equal(finalState.titles.includes("RTE Investigation"), true);
  await evaluate(client, {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll(".project-document-select"));
      const research = buttons.find((button) => button.querySelector("span")?.textContent === "RTE Investigation");
      const summary = buttons.find((button) => button.querySelector("span")?.textContent === "Evidence Summary");
      research?.click();
      summary?.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Evidence Summary"`,
    "latest rapid document selection"
  );
  process.stdout.write(
    `${JSON.stringify({
      navigator: true,
      saveBeforeSwitch: true,
      documentUiStateRestore: true,
      displayTitleMetadataOnly: true,
      archiveRestore: true,
      staleSwitchProtection: true
    }, null, 2)}\n`
  );
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function readNavigatorState(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => ({
      activeTitle: document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent ?? null,
      roles: Array.from(document.querySelectorAll(".project-document-item .project-document-badges span:first-child")).map((element) => element.textContent?.trim()),
      titles: Array.from(document.querySelectorAll(".project-document-select span")).map((element) => element.textContent?.trim())
    }))()`
  });
}

async function appendMarkdown(pageClient, marker) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      if (!textarea) throw new Error("Markdown editor not found.");
      const previous = textarea.value;
      const next = previous + "\\n\\n" + ${JSON.stringify(marker)} + "\\n";
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, next);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: next.slice(previous.length),
        inputType: "insertText"
      }));
      return true;
    })()`,
    userGesture: true
  });
}

async function clickProjectDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const title = ${JSON.stringify(title)};
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent === title && !candidate.disabled);
      if (!button) throw new Error("Document button not found: " + title);
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function renameDocument(pageClient, currentTitle, nextTitle) {
  await evaluate(pageClient, {
    expression: `(() => {
      window.prompt = () => ${JSON.stringify(nextTitle)};
      const article = Array.from(document.querySelectorAll(".project-document-item"))
        .find((candidate) => candidate.querySelector(".project-document-select span")?.textContent === ${JSON.stringify(currentTitle)});
      const button = Array.from(article?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === "Rename");
      if (!button) throw new Error("Rename button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function archiveDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const article = Array.from(document.querySelectorAll(".project-document-item"))
        .find((candidate) => candidate.querySelector(".project-document-select span")?.textContent === ${JSON.stringify(title)});
      const button = Array.from(article?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === "Archive");
      if (!button) throw new Error("Archive button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitFor(pageClient, expression, label) {
  let latest = false;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latest = await evaluate(pageClient, { expression: `Boolean(${expression})` });
    if (latest) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function createMultiDocumentFixture(root) {
  const metadata = join(root, ".patchmark");
  const documentsRoot = join(metadata, "documents");
  mkdirSync(documentsRoot, { recursive: true });
  const now = "2026-07-17T00:00:00.000Z";
  const documents = [
    createDocumentFixture({
      documentId: "doc_action",
      displayTitle: "Action Plan",
      markdown: "# Action Plan\n\nDecision body.\n",
      path: "action-plan.md",
      position: 1000,
      role: "decision",
      root,
      now
    }),
    createDocumentFixture({
      documentId: "doc_research",
      displayTitle: "Ready-to-Eat Investigation",
      markdown: "# Ready-to-Eat Investigation\n\nResearch body.\n",
      path: "ready-to-eat-investigation.md",
      position: 2000,
      role: "research",
      root,
      now
    }),
    createDocumentFixture({
      documentId: "doc_summary",
      displayTitle: "Evidence Summary",
      markdown: "# Evidence Summary\n\nSummary body.\n",
      path: "evidence-summary.md",
      position: 3000,
      role: "summary",
      root,
      now
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    `${JSON.stringify({
      format: "patchmark-project",
      schema_version: 1,
      project_id: "prj_browser",
      title: "Crust Chant",
      created_at: now,
      manifest_revision: 1,
      documents
    }, null, 2)}\n`
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
  root
}) {
  writeFileSync(join(root, documentPath), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  mkdirSync(join(store, "versions"), { recursive: true });
  mkdirSync(join(store, "context-packs"), { recursive: true });
  mkdirSync(join(store, "imports"), { recursive: true });
  mkdirSync(join(store, "recovery"), { recursive: true });
  writeFileSync(
    join(store, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      project_name: "Crust Chant",
      document_file: "document.md",
      created_at: now,
      updated_at: now
    }, null, 2)}\n`
  );
  writeFileSync(join(store, "comments.json"), "[]\n");
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
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
    display_title: displayTitle,
    role,
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

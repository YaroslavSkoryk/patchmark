import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-review-queue-browser-"));
const projectDir = join(fixtureRoot, "Guided Review Fixture");
createReviewQueueFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for review queue browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-review-queue-chrome-"));
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
      projectName: "Guided Review Fixture"
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
    `document.querySelectorAll(".comment-floating-item").length === 4`,
    "first document comments"
  );
  await clearFixtureWriteLog(client);
  const beforePreview = fingerprintDirectory(projectDir);

  await clickButtonByText(client, "Guided Review Preview");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Guided Review Preview"]')?.textContent?.includes("Market Evidence")`,
    "first review proposal"
  );
  const firstPreview = await readPreview(client);
  assert.equal(firstPreview.documentTitle, "Market Review");
  assert.equal(firstPreview.proposalTitle, "Market Evidence");
  assert.deepEqual(firstPreview.proposedCommentIds, [
    "PM-COMMENT-0001",
    "PM-COMMENT-0002"
  ]);
  assert.deepEqual(firstPreview.counts, {
    "Awaiting ChatGPT": 0,
    "Awaiting your review": 1,
    Blocked: 0,
    Deferred: 0,
    "Ready for ChatGPT": 3,
    Resolved: 0
  });
  await clickPreviewClose(client);
  await clickButtonByText(client, "Guided Review Preview");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Guided Review Preview"]'))`,
    "reopened review preview"
  );

  await clickProjectDocument(client, "Second Review");
  await waitFor(
    client,
    `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Second Review"`,
    "second document active"
  );
  await waitFor(
    client,
    `!document.querySelector('[aria-label="Guided Review Preview"]')`,
    "preview closed after switch"
  );
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item").length === 1`,
    "second document comments"
  );
  await clickButtonByText(client, "Guided Review Preview");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Guided Review Preview"]')?.textContent?.includes("Second Signals")`,
    "second review proposal"
  );
  const secondPreview = await readPreview(client);
  assert.equal(secondPreview.documentTitle, "Second Review");
  assert.equal(secondPreview.proposalTitle, "Second Signals");
  assert.deepEqual(secondPreview.proposedCommentIds, ["PM-COMMENT-0001"]);
  await clickPreviewClose(client);

  assert.equal(await getFixtureWriteCount(client), 0);
  assert.equal(fingerprintDirectory(projectDir), beforePreview);

  await clickProjectDocument(client, "Market Review");
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item").length === 4`,
    "first document restored"
  );
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value.includes("PM-COMMENT-0001")`,
    "existing manual prompt"
  );
  await clickButtonByText(client, "Save Prompt");
  await waitFor(
    client,
    `window.__patchmarkFixtureWriteLog?.some((entry) => entry.path.includes("context-packs/") && entry.status === "completed")`,
    "manual context-pack write"
  );
  await waitFor(
    client,
    `window.__patchmarkFixtureWriteLog?.some((entry) => entry.path.endsWith("comments.json") && entry.status === "completed")`,
    "manual comment export-state write"
  );
  const manualWritePaths = await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog.map((entry) => entry.path)`
  });
  assert.ok(manualWritePaths.some((path) => path.includes("context-packs/")));
  assert.ok(manualWritePaths.some((path) => path.endsWith("comments.json")));
  assert.ok(manualWritePaths.every((path) => !path.includes("review-batch")));

  console.log(
    JSON.stringify(
      {
        duplicateLocalIdIsolated: true,
        firstPreview,
        manualExportWritePaths: manualWritePaths,
        noWriteFingerprintStable: true,
        previewWriteCount: 0,
        secondPreview,
        switchClosedPreview: true
      },
      null,
      2
    )
  );
  console.log("Review queue browser tests passed.");
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function readPreview(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => {
      const dialog = document.querySelector('[aria-label="Guided Review Preview"]');
      const counts = Object.fromEntries(Array.from(dialog?.querySelectorAll(".guided-review-counts > div") ?? []).map((item) => [
        item.querySelector("dt")?.textContent?.trim(),
        Number(item.querySelector("dd")?.textContent ?? 0)
      ]));
      const proposal = dialog?.querySelector(".guided-review-proposal");
      return {
        counts,
        documentTitle: dialog?.querySelector(".guided-review-document strong")?.textContent?.trim() ?? null,
        proposalTitle: proposal?.querySelector("h3")?.textContent?.trim() ?? null,
        proposedCommentIds: Array.from(proposal?.querySelectorAll(".guided-review-comment-card > header > strong") ?? []).map((element) => element.textContent?.trim())
      };
    })()`
  });
}

async function clickPreviewClose(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = document.querySelector('[aria-label="Guided Review Preview"] .snapshot-dialog-header > button');
      if (!button) throw new Error("Guided Review close button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    pageClient,
    `!document.querySelector('[aria-label="Guided Review Preview"]')`,
    "review preview closed"
  );
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

async function clearFixtureWriteLog(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      window.__patchmarkFixtureWriteLog.length = 0;
      return true;
    })()`
  });
}

async function getFixtureWriteCount(pageClient) {
  return evaluate(pageClient, {
    expression: `window.__patchmarkFixtureWriteLog?.length ?? 0`
  });
}

async function waitFor(pageClient, expression, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate(pageClient, { expression: `Boolean(${expression})` })) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function createReviewQueueFixture(root) {
  const metadata = join(root, ".patchmark");
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const now = "2026-07-20T00:00:00.000Z";
  const firstMarkdown = [
    "# Market Review",
    "",
    "Introduction signal.",
    "",
    "## Market Evidence",
    "",
    "### Retail",
    "",
    "Retail signal is growing.",
    "",
    "### Wholesale",
    "",
    "Wholesale signal is stable.",
    "",
    "## Operations",
    "",
    "Operations signal needs review.",
    "",
    "Assistant-reviewed signal.",
    ""
  ].join("\n");
  const secondMarkdown = [
    "# Second Review",
    "",
    "## Second Signals",
    "",
    "A second-document signal uses the same local comment ID.",
    ""
  ].join("\n");
  const documents = [
    createDocumentFixture({
      comments: [
        createComment({
          comment: "Review retail evidence.",
          focusState: "in_focus",
          id: "PM-COMMENT-0001",
          markdown: firstMarkdown,
          selectedText: "Retail signal is growing.",
          timestamp: "2026-07-20T00:00:01.000Z"
        }),
        createComment({
          comment: "Review wholesale evidence.",
          id: "PM-COMMENT-0002",
          markdown: firstMarkdown,
          selectedText: "Wholesale signal is stable.",
          timestamp: "2026-07-20T00:00:02.000Z"
        }),
        createComment({
          comment: "Review operations evidence.",
          id: "PM-COMMENT-0003",
          markdown: firstMarkdown,
          selectedText: "Operations signal needs review.",
          timestamp: "2026-07-20T00:00:03.000Z"
        }),
        createComment({
          assistantReply: "The current wording is sufficiently specific.",
          comment: "Check the final signal.",
          id: "PM-COMMENT-0004",
          markdown: firstMarkdown,
          selectedText: "Assistant-reviewed signal.",
          timestamp: "2026-07-20T00:00:04.000Z"
        })
      ],
      displayTitle: "Market Review",
      documentId: "doc_market",
      markdown: firstMarkdown,
      now,
      path: "market-review.md",
      position: 1000,
      root
    }),
    createDocumentFixture({
      comments: [
        createComment({
          comment: "Review the second document only.",
          id: "PM-COMMENT-0001",
          markdown: secondMarkdown,
          selectedText: "A second-document signal uses the same local comment ID.",
          timestamp: "2026-07-20T00:00:01.000Z"
        })
      ],
      displayTitle: "Second Review",
      documentId: "doc_second",
      markdown: secondMarkdown,
      now,
      path: "second-review.md",
      position: 2000,
      root
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    `${JSON.stringify(
      {
        format: "patchmark-project",
        schema_version: 1,
        project_id: "prj_guided_review",
        title: "Guided Review Fixture",
        created_at: now,
        manifest_revision: 1,
        documents
      },
      null,
      2
    )}\n`
  );
}

function createDocumentFixture({
  comments,
  displayTitle,
  documentId,
  markdown,
  now,
  path: documentPath,
  position,
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
    `${JSON.stringify(
      {
        schema_version: 1,
        project_id: "prj_guided_review",
        document_id: documentId,
        project_name: "Guided Review Fixture",
        document_file: "document.md",
        created_at: now,
        updated_at: now,
        save_generation: 12
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(store, "comments.json"), `${JSON.stringify(comments, null, 2)}\n`);
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
  return {
    document_id: documentId,
    path: documentPath,
    display_title: displayTitle,
    role: "research",
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function createComment({
  assistantReply,
  comment,
  focusState = "idle",
  id,
  markdown,
  selectedText,
  timestamp
}) {
  const start = markdown.indexOf(selectedText);
  assert.notEqual(start, -1);
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      context_before: markdown.slice(Math.max(0, start - 80), start),
      context_after: markdown.slice(start + selectedText.length, start + selectedText.length + 80),
      anchor_source: "markdown"
    },
    comment,
    thread: assistantReply
      ? [
          {
            id: `${id}-REPLY-1`,
            role: "chatgpt",
            content: assistantReply,
            created_at: "2026-07-20T00:01:00.000Z",
            source_import_id: `${id}-IMPORT-1`
          }
        ]
      : [],
    export_state: { focus_state: focusState },
    created_at: timestamp,
    updated_at: timestamp
  };
}

function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  for (const path of listFiles(root)) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(root) {
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

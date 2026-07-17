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
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-assembly-browser-"));
const actionPath = join(fixtureRoot, "action-source");
const researchPath = join(fixtureRoot, "research-source");
const destinationPath = join(fixtureRoot, "destination");
createLegacyFixture(actionPath, {
  idPrefix: "ACTION-BROWSER",
  marker: "ACTION_PLAN_UNIQUE_MARKER",
  title: "Action Plan"
});
createLegacyFixture(researchPath, {
  idPrefix: "READY-BROWSER",
  marker: "READY_TO_EAT_UNIQUE_MARKER",
  title: "Ready-to-Eat Investigation"
});
mkdirSync(destinationPath);
const sourceBytesBefore = new Map([
  [join(actionPath, "document.md"), readFileSync(join(actionPath, "document.md"))],
  [join(actionPath, ".patchmark", "comments.json"), readFileSync(join(actionPath, ".patchmark", "comments.json"))],
  [join(researchPath, "document.md"), readFileSync(join(researchPath, "document.md"))],
  [join(researchPath, ".patchmark", "comments.json"), readFileSync(join(researchPath, ".patchmark", "comments.json"))]
]);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for legacy assembly browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-assembly-browser-chrome-"));
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
      pickerPaths: ["action-source", "research-source", "destination"],
      projectName: "Assembly fixtures"
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
  await clickButtonByText(
    client,
    "Create Project From Existing Patchmark Projects"
  );
  await waitFor(
    client,
    `Boolean(document.querySelector(".legacy-assembly-dialog"))`,
    "assembly wizard"
  );

  await clickButtonByText(client, "Add Source Project");
  await waitFor(
    client,
    `document.querySelectorAll(".legacy-source-card").length === 1`,
    "first validated source"
  );
  await clickButtonByText(client, "Add Source Project");
  await waitFor(
    client,
    `document.querySelectorAll(".legacy-source-card").length === 2`,
    "second validated source"
  );
  const sourceSummary = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".legacy-source-card")).map((card) => card.textContent)`
  });
  assert.equal(sourceSummary[0].includes("Comments2"), true);
  assert.equal(sourceSummary[0].includes("Replies1"), true);
  assert.equal(sourceSummary[0].includes("Patches1"), true);

  await clickButtonByText(client, "Configure Destination");
  await setConfiguration(client);
  await clickButtonByText(client, "Choose Empty Folder");
  await waitFor(
    client,
    `Array.from(document.querySelectorAll(".legacy-assembly-project-fields button")).some((button) => button.textContent?.includes("Selected: destination"))`,
    "destination selection"
  );
  await waitFor(
    client,
    `Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Review Assembly" && !button.disabled)`,
    "review action enabled"
  );
  await clickButtonByText(client, "Review Assembly");
  await waitFor(
    client,
    `document.querySelector(".legacy-assembly-review-summary")?.textContent?.includes("2 documents")`,
    "assembly review"
  );
  const reviewText = await evaluate(client, {
    expression: `document.querySelector(".legacy-assembly-review")?.textContent ?? ""`
  });
  assert.match(reviewText, /4 comments/);
  assert.match(reviewText, /2 replies/);
  assert.match(reviewText, /2 patch proposals/);
  assert.match(reviewText, /0 detected identity collisions/);
  assert.match(reviewText, /source projects will remain unchanged/i);

  await clickButtonByText(client, "Create Project");
  await waitFor(
    client,
    `document.querySelectorAll(".project-document-item").length === 2`,
    "assembled project navigator"
  );
  await waitFor(
    client,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Crust Chant")`,
    "assembled workspace"
  );
  const manifest = JSON.parse(
    readFileSync(join(destinationPath, ".patchmark", "project.json"), "utf8")
  );
  assert.equal(manifest.documents.length, 2);
  assert.notEqual(manifest.documents[0].document_id, manifest.documents[1].document_id);
  assert.deepEqual(
    manifest.documents.map(({ path }) => path),
    ["action-plan.md", "ready-to-eat-investigation.md"]
  );

  await waitFor(
    client,
    `document.querySelector(".patchmark-prose")?.textContent?.includes("ACTION_PLAN_UNIQUE_MARKER")`,
    "Action Plan document"
  );
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-export-dialog textarea"))`,
    "Action Plan prompt"
  );
  const actionPrompt = await evaluate(client, {
    expression: `document.querySelector(".comment-export-dialog textarea")?.value ?? ""`
  });
  assert.match(actionPrompt, /ACTION_PLAN_UNIQUE_MARKER/);
  assert.doesNotMatch(actionPrompt, /READY_TO_EAT_UNIQUE_MARKER/);
  await clickWithin(client, ".comment-export-dialog", "Close");

  await clickButtonByText(client, "Export PDF");
  await waitFor(
    client,
    `Boolean(document.querySelector(".pdf-export-document"))`,
    "Action Plan PDF preview"
  );
  await clickProjectDocument(client, "Ready-to-Eat Investigation");
  await waitFor(
    client,
    `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Ready-to-Eat Investigation"`,
    "research document active behind PDF"
  );
  await waitFor(
    client,
    `document.querySelector(".pdf-export-document")?.textContent?.includes("ACTION_PLAN_UNIQUE_MARKER")`,
    "captured Action Plan PDF after switch"
  );
  const capturedPdfText = await evaluate(client, {
    expression: `document.querySelector(".pdf-export-document")?.textContent ?? ""`
  });
  assert.match(capturedPdfText, /ACTION_PLAN_UNIQUE_MARKER/);
  assert.doesNotMatch(capturedPdfText, /READY_TO_EAT_UNIQUE_MARKER/);
  await clickWithin(client, ".pdf-export-dialog", "Close");
  await waitFor(
    client,
    `document.querySelector(".patchmark-prose")?.textContent?.includes("READY_TO_EAT_UNIQUE_MARKER")`,
    "research document content"
  );
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-export-dialog textarea"))`,
    "research prompt"
  );
  const researchPrompt = await evaluate(client, {
    expression: `document.querySelector(".comment-export-dialog textarea")?.value ?? ""`
  });
  assert.match(researchPrompt, /READY_TO_EAT_UNIQUE_MARKER/);
  assert.doesNotMatch(researchPrompt, /ACTION_PLAN_UNIQUE_MARKER/);
  await clickWithin(client, ".comment-export-dialog", "Close");

  for (const [filePath, expected] of sourceBytesBefore) {
    assert.equal(readFileSync(filePath).equals(expected), true);
  }
  process.stdout.write(
    `${JSON.stringify({
      guidedWizard: true,
      validatedSourceSummaries: true,
      destinationConfiguration: true,
      reviewScreen: true,
      normalLoaderHandoff: true,
      promptIsolation: true,
      pdfTargetCaptureDuringSwitch: true,
      sourceFilesUnchanged: true
    }, null, 2)}\n`
  );
} finally {
  if (client) {
    await Promise.race([client.close().catch(() => undefined), delay(2000)]);
  }
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 1000);
  }
  await Promise.race([fixtureServer.forceClose(), delay(2000)]);
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function setConfiguration(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const title = document.querySelector(".legacy-assembly-project-fields input");
      const cards = Array.from(document.querySelectorAll(".legacy-configured-card"));
      if (!title || cards.length !== 2) throw new Error("Configuration fields missing.");
      setInput(title, "Crust Chant");
      setInput(cards[0].querySelectorAll("input")[0], "Action Plan");
      setInput(cards[0].querySelectorAll("input")[1], "action-plan.md");
      setInput(cards[1].querySelectorAll("input")[0], "Ready-to-Eat Investigation");
      setInput(cards[1].querySelectorAll("input")[1], "ready-to-eat-investigation.md");
      setSelect(cards[0].querySelector("select"), "decision");
      setSelect(cards[1].querySelector("select"), "research");
      return true;

      function setInput(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      function setSelect(select, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })()`,
    userGesture: true
  });
}

async function clickProjectDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent === ${JSON.stringify(title)});
      if (!button) throw new Error("Document button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickWithin(pageClient, selector, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const button = Array.from(root?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error("Button not found: " + ${JSON.stringify(text)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitFor(pageClient, expression, label) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(pageClient, { expression: `Boolean(${expression})` })) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function createLegacyFixture(root, { idPrefix, marker, title }) {
  const metadata = join(root, ".patchmark");
  mkdirSync(join(metadata, "versions"), { recursive: true });
  mkdirSync(join(metadata, "context-packs"), { recursive: true });
  mkdirSync(join(metadata, "imports"), { recursive: true });
  mkdirSync(join(metadata, "recovery"), { recursive: true });
  const now = "2026-07-17T00:00:00.000Z";
  const markdown = `# ${title}\n\n${marker}\n\nIndependent document context.\n`;
  const commentId = `PM-COMMENT-${idPrefix}`;
  writeFileSync(join(root, "document.md"), markdown);
  writeFileSync(
    join(metadata, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      project_name: title,
      document_file: "document.md",
      created_at: now,
      updated_at: now
    }, null, 2)}\n`
  );
  writeFileSync(
    join(metadata, "comments.json"),
    `${JSON.stringify([
      {
        id: commentId,
        type: "question",
        status: "open",
        anchor: { kind: "document" },
        comment: `Review ${marker}`,
        thread: [
          {
            id: `PM-THREAD-${idPrefix}`,
            role: "user",
            content: `Follow up on ${marker}`,
            created_at: now
          }
        ],
        export_state: { focus_state: "in_focus" },
        created_at: now,
        updated_at: now
      },
      {
        id: `${commentId}-RESOLVED`,
        type: "note",
        status: "resolved",
        anchor: { kind: "document" },
        comment: `Resolved ${marker}`,
        thread: [],
        export_state: { focus_state: "idle" },
        created_at: now,
        updated_at: now,
        resolved_at: now
      }
    ], null, 2)}\n`
  );
  writeFileSync(
    join(metadata, "patches.json"),
    `${JSON.stringify([
      {
        id: `PM-PATCH-${idPrefix}`,
        status: "pending",
        comment_id: commentId,
        original_text: marker,
        suggested_text: `${marker}_REVIEWED`,
        reason: "Browser isolation fixture",
        created_at: now
      }
    ], null, 2)}\n`
  );
  writeFileSync(join(metadata, "tasks.json"), "[]\n");
}

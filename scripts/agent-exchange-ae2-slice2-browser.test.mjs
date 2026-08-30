import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  CodexExecAdapter,
  createCodexEnvironment
} from "../local-connector/codex-exec-adapter.ts";
import { createPatchmarkLocalConnector } from "../local-connector/server.ts";
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

const commentId = "PM-COMMENT-AE2-LOCAL-0001";
const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const editorOrigin = new URL(editorUrl).origin;
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-ae2-local-browser-"));
const sourceFixture = new URL("./fixtures/projects/core-multidoc", import.meta.url).pathname;
const fakeCodex = new URL("./fixtures/agent-exchange/fake-codex.mjs", import.meta.url).pathname;
const capturePath = join(fixtureRoot, "codex-capture.json");
const projects = ["Success", "Cancel", "Reload"].map((name, index) =>
  createScenarioProject(name, index + 1)
);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const pairingCodes = [];
const connector = createPatchmarkLocalConnector({
  adapter: new CodexExecAdapter({
    environment: {
      ...createCodexEnvironment(process.env),
      PATCHMARK_FAKE_CAPTURE_PATH: capturePath,
      PATCHMARK_FAKE_CODEX_SCENARIO: "patchmark-delay",
      PATCHMARK_FAKE_DELAY_MS: "1500"
    },
    executable: fakeCodex,
    operationTimeoutMs: 10_000
  }),
  allowInsecureLoopbackOriginsForTests: true,
  allowedOrigins: [editorOrigin],
  onPairingCode: (code) => pairingCodes.push(code)
});
await connector.start();

const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for AE-2 Slice 2 qualification.");
await assertEditorIsReachable(editorUrl);
const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-ae2-local-chrome-"));
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
const consoleErrors = [];
const exceptions = [];
const networkFailures = [];
const evidence = {};

try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  client = await CdpClient.connect(await createPage(browserWsUrl, "about:blank"));
  client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      consoleErrors.push(
        event.args?.map((item) => item.value ?? item.description).join(" ")
      );
    }
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(
      event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text
    );
  });
  client.on("Network.loadingFailed", (event) => {
    if (!event.canceled && event.errorText !== "net::ERR_ABORTED") {
      networkFailures.push(event.errorText);
    }
  });
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Network.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      pickerPaths: projects,
      projectName: basename(fixtureRoot)
    })
  });
  await setViewport(1440, 1000);
  await client.call("Page.navigate", {
    url: `${editorUrl}?agent-exchange-ae2-slice2=${Date.now()}`
  });
  await waitForEditorShell(client);

  await openNextProject("Success");
  await openComments();
  await waitForSendAction();
  await keyboardActivateButton("Send to agent");
  await waitForPhase("pairing");
  assert.equal(
    await evaluate(client, { expression: "document.activeElement?.id" }),
    "patchmark-agent-exchange-pairing-code"
  );
  assert.match(await agentText(), /session stays only in this browser tab/i);
  await setPairingCode("A".repeat(43));
  await keyboardActivateButton("Pair and send");
  await waitFor(
    "Boolean(document.querySelector('[role=alert]'))",
    "actionable invalid pairing error"
  );
  assert.equal(await currentPhase(), "pairing");
  await setPairingCode(pairingCodes[0]);
  await keyboardActivateButton("Pair and send");
  await waitForPhase("waiting");
  await waitFor(
    "['ready', 'failed'].includes(document.querySelector('[data-testid=\"agent-exchange-actions\"]')?.getAttribute('data-agent-exchange-phase'))",
    "Agent Exchange terminal response"
  );
  const terminalPhase = await currentPhase();
  if (terminalPhase !== "ready") {
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    const diagnostic = spawnSync(fakeCodex, ["exec"], {
      encoding: "utf8",
      env: {
        ...createCodexEnvironment(process.env),
        PATCHMARK_FAKE_CODEX_SCENARIO: "patchmark-delay",
        PATCHMARK_FAKE_DELAY_MS: "0"
      },
      input: Buffer.from(captured.stdinBase64, "base64")
    });
    process.stderr.write(
      `Fake Codex diagnostic: ${JSON.stringify({ status: diagnostic.status, stderr: diagnostic.stderr, stdout: diagnostic.stdout })}\n`
    );
  }
  assert.equal(terminalPhase, "ready", await agentText());
  assert.equal(readComments(projects[0])[0].thread.length, 1);
  assert.match(
    readComments(projects[0])[0].thread[0].content,
    /local Codex connector returned this review reply/
  );
  assert.deepEqual(readPatches(projects[0]), []);
  const firstCapture = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.equal(
    Buffer.from(firstCapture.stdinBase64, "base64").toString("utf8"),
    readOnlyPromptPack(projects[0])
  );
  evidence.success = {
    exactRequestBytes: true,
    pairedInProductUi: true,
    repliesImported: 1,
    sessionPersistence: "tab-memory-only"
  };

  await openNextProject("Cancel");
  await openComments();
  await waitForSendAction();
  await keyboardActivateButton("Send to agent");
  await waitForPhase("waiting");
  await keyboardActivateButton("Cancel");
  await waitForPhase("cancelled");
  assert.equal(readComments(projects[1])[0].thread.length, 0);
  await keyboardActivateButton("Use manual export instead");
  await waitFor(
    "Boolean(document.querySelector('[aria-label=\"Generate ChatGPT prompt\"]'))",
    "manual fallback dialog"
  );
  assert.equal(await fallbackPromptText(), readOnlyPromptPack(projects[1]));
  await evaluate(client, {
    expression:
      "document.querySelector('[aria-label=\"Generate ChatGPT prompt\"] button')?.click(); true",
    userGesture: true
  });
  evidence.cancel = {
    importedReplies: 0,
    manualFallbackExact: true,
    terminalPhase: "cancelled"
  };

  await openNextProject("Reload");
  await openComments();
  await waitForSendAction();
  await keyboardActivateButton("Send to agent");
  await waitForPhase("waiting");
  await client.call("Page.reload");
  await waitForEditorShell(client);
  await delay(300);
  assert.equal(readComments(projects[2])[0].thread.length, 0);
  evidence.reload = {
    activeRequestCancelled: true,
    lateImportRejected: true
  };

  await setViewport(390, 844);
  await openNextProject("Success");
  await openComments();
  await waitFor(
    "Boolean(document.querySelector('[data-testid=\"agent-exchange-actions\"]'))",
    "responsive Agent Exchange surface"
  );
  const bounds = await evaluate(client, {
    expression: `(() => {
      const surface = document.querySelector('[data-testid="agent-exchange-actions"]');
      const rect = surface?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, viewport: innerWidth } : null;
    })()`
  });
  assert.ok(bounds && bounds.left >= 0 && bounds.right <= bounds.viewport + 1);
  evidence.responsive = bounds;

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(networkFailures, []);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...evidence,
        codex_live_model_calls: 0,
        consoleErrors,
        exceptions,
        networkFailures,
        status: "ok"
      },
      null,
      2
    )}\n`
  );
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await connector.stop().catch(() => undefined);
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function createScenarioProject(name, sequence) {
  const relativePath = `Project ${String(sequence).padStart(2, "0")} ${name}`;
  const projectRoot = join(fixtureRoot, relativePath);
  cpSync(sourceFixture, projectRoot, { recursive: true });
  const projectId = `prj_ae2_local_${String(sequence).padStart(2, "0")}`;
  const projectFile = join(projectRoot, ".patchmark", "project.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.project_id = projectId;
  project.title = `AE2 Local ${name}`;
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  for (const documentId of ["doc_operations", "doc_evidence", "doc_summary"]) {
    const manifestPath = join(
      projectRoot,
      ".patchmark",
      "documents",
      documentId,
      "manifest.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.project_id = projectId;
    manifest.project_name = project.title;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const commentsPath = join(
    projectRoot,
    ".patchmark",
    "documents",
    "doc_operations",
    "comments.json"
  );
  writeFileSync(commentsPath, `${JSON.stringify([createComment()], null, 2)}\n`);
  return relativePath;
}

function createComment() {
  return {
    anchor: { kind: "document" },
    comment: "Return one deterministic connector reply.",
    created_at: "2040-02-01T00:00:00.000Z",
    export_state: { focus_state: "in_focus" },
    id: commentId,
    status: "open",
    thread: [],
    type: "note",
    updated_at: "2040-02-01T00:00:00.000Z"
  };
}

async function openNextProject(expectedName) {
  const hasProject = await evaluate(client, {
    expression: "document.body.textContent?.includes('Project:')"
  });
  if (hasProject) {
    await clickButtonByText(client, "File");
    await waitFor(
      "Boolean(document.querySelector('[role=menu]:not([hidden])'))",
      "File menu"
    );
  }
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('[aria-label="Workspace status"]')?.textContent?.includes(${JSON.stringify(`AE2 Local ${expectedName}`)}) && document.querySelector('.application-comments-count')?.textContent?.trim() === '1'`,
    `project ${expectedName}`
  );
}

async function openComments() {
  const open = await evaluate(client, {
    expression:
      "document.querySelector('.application-comments-trigger')?.getAttribute('aria-expanded') === 'true'"
  });
  if (!open) {
    await evaluate(client, {
      expression:
        "document.querySelector('.application-comments-trigger')?.click(); true",
      userGesture: true
    });
  }
  await waitFor(
    "!document.querySelector('#document-comments-panel')?.hidden",
    "Comments open"
  );
}

async function waitForSendAction() {
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Send to agent' && !button.disabled)",
    "Send to agent action"
  );
}

async function keyboardActivateButton(text) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error('Button missing: ${text}');
      button.focus();
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function setPairingCode(value) {
  await evaluate(client, {
    expression: `(() => {
      const input = document.querySelector('#patchmark-agent-exchange-pairing-code');
      if (!(input instanceof HTMLInputElement)) throw new Error('Pairing input missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    `document.querySelector('#patchmark-agent-exchange-pairing-code')?.value === ${JSON.stringify(value)}`,
    "pairing code input"
  );
}

async function waitForPhase(phase) {
  await waitFor(
    `document.querySelector('[data-testid="agent-exchange-actions"]')?.getAttribute('data-agent-exchange-phase') === ${JSON.stringify(phase)}`,
    `Agent Exchange phase ${phase}`
  );
}

function currentPhase() {
  return evaluate(client, {
    expression:
      "document.querySelector('[data-testid=\"agent-exchange-actions\"]')?.getAttribute('data-agent-exchange-phase') ?? 'idle'"
  });
}

function agentText() {
  return evaluate(client, {
    expression:
      "document.querySelector('[data-testid=\"agent-exchange-actions\"]')?.textContent ?? ''"
  });
}

function fallbackPromptText() {
  return evaluate(client, {
    expression:
      "document.querySelector('[aria-label=\"Generate ChatGPT prompt\"] textarea')?.value ?? document.querySelector('[aria-label=\"Generate ChatGPT prompt\"] pre')?.textContent ?? ''"
  });
}

async function waitFor(expression, label) {
  let latest;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    latest = await evaluate(client, { expression: `Boolean(${expression})` });
    if (latest) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

function setViewport(width, height) {
  return client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: width <= 480,
    width
  });
}

function readOnlyPromptPack(projectPath) {
  const directory = join(
    fixtureRoot,
    projectPath,
    ".patchmark",
    "documents",
    "doc_operations",
    "context-packs"
  );
  const file = readdirSync(directory).find(
    (name) =>
      name.endsWith("-prompt.md") && !name.endsWith("-document-snapshot.md")
  );
  assert.ok(file, "expected an exact prompt pack");
  return readFileSync(join(directory, file), "utf8");
}

function readComments(projectPath) {
  return readJson(projectPath, "comments.json");
}

function readPatches(projectPath) {
  return readJson(projectPath, "patches.json");
}

function readJson(projectPath, fileName) {
  return JSON.parse(
    readFileSync(
      join(
        fixtureRoot,
        projectPath,
        ".patchmark",
        "documents",
        "doc_operations",
        fileName
      ),
      "utf8"
    )
  );
}

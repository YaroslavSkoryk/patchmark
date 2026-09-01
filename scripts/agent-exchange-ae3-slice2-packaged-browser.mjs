import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { isCodexProviderFailureDiagnostic } from "../local-connector/codex-exec-adapter.ts";
import { isLocalConnectorProtocolDiagnostic } from "../lib/agent-exchange/local-connector-protocol.ts";

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
const providerMode = process.env.PATCHMARK_AE3_SLICE2_PROVIDER_MODE ?? "real";
if (providerMode !== "real" && providerMode !== "fake") {
  throw new Error("PATCHMARK_AE3_SLICE2_PROVIDER_MODE must be real or fake.");
}
const expectedPhase = process.env.PATCHMARK_AE3_SLICE2_EXPECTED_PHASE ?? "ready";
if (expectedPhase !== "failed" && expectedPhase !== "ready") {
  throw new Error("PATCHMARK_AE3_SLICE2_EXPECTED_PHASE must be failed or ready.");
}
const providerEvidencePrefix = providerMode === "real" ? "REAL" : "FAKE";
const evidenceDirectory = requireAbsolutePath(
  "PATCHMARK_AE3_SLICE2_EVIDENCE_DIR",
  process.env.PATCHMARK_AE3_SLICE2_EVIDENCE_DIR
);
const connectorLauncher = requireAbsolutePath(
  "PATCHMARK_PACKAGED_CONNECTOR",
  process.env.PATCHMARK_PACKAGED_CONNECTOR
);
const qualificationHome = requireAbsolutePath(
  "PATCHMARK_QUALIFICATION_HOME",
  process.env.PATCHMARK_QUALIFICATION_HOME
);
const codexHome = requireAbsolutePath("CODEX_HOME", process.env.CODEX_HOME);
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-ae3-packaged-browser-"));
const projectPath = "Packaged Real Codex";
const projectRoot = join(fixtureRoot, projectPath);
const sourceFixture = new URL("./fixtures/projects/core-multidoc", import.meta.url).pathname;
cpSync(sourceFixture, projectRoot, { recursive: true });
prepareProject(projectRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const connector = launchConnector();
const pairingCode = await connector.waitForPairingCode();
await connector.waitFor(/Detected Codex: 0\.151\.0 — supported/);

const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Google Chrome was not found.");
const chromeVersion = await readProcessOutput(chromePath, ["--version"]);
assert.match(chromeVersion, /^Google Chrome 152\.0\.7977\.(?:64|65)/);
await assertEditorIsReachable(editorUrl);
const userDataDirectory = mkdtempSync(join(tmpdir(), "patchmark-ae3-packaged-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDirectory}`,
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
const connectorResponses = [];
const exceptions = [];
const networkFailures = [];
const pendingConnectorResponseReads = [];
const startedAt = Date.now();

try {
  const browserWebSocketUrl = await waitForDevToolsUrl(chrome);
  client = await CdpClient.connect(await createPage(browserWebSocketUrl, "about:blank"));
  client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      consoleErrors.push(event.args?.map((item) => item.value ?? item.description).join(" "));
    }
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text);
  });
  client.on("Network.loadingFailed", (event) => {
    if (!event.canceled && event.errorText !== "net::ERR_ABORTED") {
      networkFailures.push(event.errorText);
    }
  });
  client.on("Network.responseReceived", (event) => {
    if (event.response.url !== "http://127.0.0.1:43187/v1/exchanges") return;
    const response = {
      error_code: null,
      qualification_diagnostic: readQualificationDiagnosticHeader(
        event.response.headers
      ),
      qualification_structural_diagnostic:
        readQualificationStructuralDiagnosticHeader(event.response.headers),
      status: event.response.status
    };
    connectorResponses.push(response);
    if (event.response.status < 400) return;
    pendingConnectorResponseReads.push(
      client.call("Network.getResponseBody", { requestId: event.requestId })
        .then((value) => {
          const text = value.base64Encoded
            ? Buffer.from(value.body, "base64").toString("utf8")
            : value.body;
          const error = readConnectorError(text);
          response.error_code = error?.code ?? null;
        })
        .catch(() => undefined)
    );
  });
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Network.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      pickerPaths: [projectPath],
      projectName: basename(fixtureRoot)
    })
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1000,
    mobile: false,
    width: 1440
  });
  await client.call("Page.navigate", {
    url: `${editorUrl}?agent-exchange-ae3-slice2-packaged=${Date.now()}`
  });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('[aria-label="Workspace status"]')?.textContent?.includes("AE3 Packaged Real Codex")`,
    "qualification project"
  );
  await openComments();
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === "Send to agent" && !button.disabled)`,
    "Send to agent"
  );
  await clickButton("Send to agent");
  await waitForPhase("pairing");
  assert.equal(
    await evaluate(client, { expression: "document.activeElement?.id" }),
    "patchmark-agent-exchange-pairing-code"
  );
  const prompt = readPromptPack(projectRoot);
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    join(evidenceDirectory, `${providerEvidencePrefix}_PROVIDER_REQUEST.md`),
    prompt
  );
  await setPairingCode(pairingCode);
  await clickButton("Pair and send");
  await waitForPhase("waiting", 60_000);
  await waitFor(
    `['ready', 'failed'].includes(document.querySelector('[data-testid="agent-exchange-actions"]')?.getAttribute('data-agent-exchange-phase'))`,
    "real Codex response",
    10 * 60_000
  );
  const phase = await currentPhase();
  const statusText = await agentText();
  await delay(100);
  await Promise.allSettled(pendingConnectorResponseReads);
  const comments = readDocumentJson(projectRoot, "comments.json");
  const patches = readDocumentJson(projectRoot, "patches.json");
  if (phase === "ready") {
    assert.ok(
      comments[0]?.thread?.length >= 1,
      "the strict importer must attach a reply"
    );
    await clickButton("Review replies and suggestions");
    await waitFor(
      `document.body.textContent?.includes("Packaged connector qualification")`,
      "imported reply review"
    );
  } else {
    assert.equal(comments[0]?.thread?.length, 0);
    assert.equal(patches.length, 0);
  }

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(networkFailures, []);
  const result = {
    chrome: chromeVersion.trim(),
    codex: "0.151.0",
    connector: "0.1.0 packaged artifact",
    connector_responses: connectorResponses,
    console_errors: consoleErrors,
    credentials_in_payload: false,
    duration_ms: Date.now() - startedAt,
    imported_patch_proposals: patches.length,
    imported_replies: comments[0].thread.length,
    network_failures: networkFailures,
    private_project_data_sent: false,
    prompt_byte_length: Buffer.byteLength(prompt),
    prompt_sha256: await sha256Text(prompt),
    provider_kind: providerMode,
    provider_tool_events: phase === "ready" ? 0 : null,
    provider_turn_count: providerMode === "real" ? 1 : 0,
    status:
      phase === expectedPhase
        ? phase === "ready"
          ? "ok"
          : "expected_failure"
        : "failed",
    synthetic_fixture_only: true,
    ui_terminal_phase: phase
  };
  writeQualificationResult(result);
  assert.equal(phase, expectedPhase, statusText);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  connector.child.kill("SIGTERM");
  await connector.exited().catch(() => connector.child.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDirectory, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function prepareProject(projectDirectory) {
  const projectFile = join(projectDirectory, ".patchmark/project.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.project_id = "prj_ae3_packaged_real_codex";
  project.title = "AE3 Packaged Real Codex";
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  for (const documentId of ["doc_operations", "doc_evidence", "doc_summary"]) {
    const manifestPath = join(
      projectDirectory,
      ".patchmark/documents",
      documentId,
      "manifest.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.project_id = project.project_id;
    manifest.project_name = project.title;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const syntheticDocuments = {
    doc_evidence: "# Evidence\n\nSynthetic packaging evidence only. No user or private project data.\n",
    doc_operations:
      "# Operations\n\nThis is an invented document for the Patchmark packaged-connector qualification.\n",
    doc_summary: "# Summary\n\nSynthetic qualification summary.\n"
  };
  for (const [documentId, markdown] of Object.entries(syntheticDocuments)) {
    writeFileSync(
      join(projectDirectory, ".patchmark/documents", documentId, "document.md"),
      markdown
    );
  }
  const commentsPath = join(
    projectDirectory,
    ".patchmark/documents/doc_operations/comments.json"
  );
  writeFileSync(
    commentsPath,
    `${JSON.stringify(
      [
        {
          anchor: { kind: "document" },
          comment:
            "Reply with the exact sentence ‘Packaged connector qualification passed.’ and do not propose a patch.",
          created_at: "2040-03-01T00:00:00.000Z",
          export_state: { focus_state: "in_focus" },
          id: "PM-COMMENT-AE3-PACKAGED-0001",
          status: "open",
          thread: [],
          type: "note",
          updated_at: "2040-03-01T00:00:00.000Z"
        }
      ],
      null,
      2
    )}\n`
  );
}

function launchConnector() {
  const child = spawn(connectorLauncher, [], {
    cwd: evidenceDirectory,
    env: {
      CODEX_HOME: codexHome,
      HOME: qualificationHome,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: tmpdir()
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const waitForOutput = async (pattern) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = pattern.exec(output);
      if (match) return match;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(25);
    }
    throw new Error(
      `Packaged connector did not become ready: ${output.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")}`
    );
  };
  return {
    child,
    exited: () => waitForProcessExit(child, 5_000),
    waitFor: waitForOutput,
    async waitForPairingCode() {
      const match = await waitForOutput(/Patchmark pairing code: ([A-Za-z0-9_-]{43})/);
      return match[1];
    }
  };
}

async function openComments() {
  const open = await evaluate(client, {
    expression:
      "document.querySelector('.application-comments-trigger')?.getAttribute('aria-expanded') === 'true'"
  });
  if (!open) {
    await evaluate(client, {
      expression: "document.querySelector('.application-comments-trigger')?.click(); true",
      userGesture: true
    });
  }
  await waitFor("!document.querySelector('#document-comments-panel')?.hidden", "Comments panel");
}

async function clickButton(text) {
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
}

function waitForPhase(phase, timeout = 20_000) {
  return waitFor(
    `document.querySelector('[data-testid="agent-exchange-actions"]')?.getAttribute('data-agent-exchange-phase') === ${JSON.stringify(phase)}`,
    `Agent Exchange phase ${phase}`,
    timeout
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

async function waitFor(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, { expression: `Boolean(${expression})` })) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function readPromptPack(projectDirectory) {
  const directory = join(
    projectDirectory,
    ".patchmark/documents/doc_operations/context-packs"
  );
  const file = readdirSync(directory).find(
    (name) => name.endsWith("-prompt.md") && !name.endsWith("-document-snapshot.md")
  );
  assert.ok(file, "expected the exact generated prompt pack");
  return readFileSync(join(directory, file), "utf8");
}

function readDocumentJson(projectDirectory, fileName) {
  return JSON.parse(
    readFileSync(
      join(projectDirectory, ".patchmark/documents/doc_operations", fileName),
      "utf8"
    )
  );
}

function readConnectorError(text) {
  try {
    const value = JSON.parse(text);
    if (
      typeof value?.error?.code !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.error.code)
    ) {
      return null;
    }
    if (Object.keys(value.error).length !== 1) return null;
    return { code: value.error.code };
  } catch {
    return null;
  }
}

function readQualificationStructuralDiagnosticHeader(headers) {
  return readQualificationHeader(
    headers,
    "x-patchmark-qualification-structural-diagnostic",
    isLocalConnectorProtocolDiagnostic
  );
}

function readQualificationDiagnosticHeader(headers) {
  return readQualificationHeader(
    headers,
    "x-patchmark-qualification-diagnostic",
    isCodexProviderFailureDiagnostic
  );
}

function readQualificationHeader(headers, headerName, validate) {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === headerName
  );
  if (!entry || typeof entry[1] !== "string") return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(entry[1])) return null;
    const bytes = Buffer.from(entry[1], "base64url");
    if (bytes.toString("base64url") !== entry[1]) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

function writeQualificationResult(result) {
  writeFileSync(
    join(evidenceDirectory, `${providerEvidencePrefix}_PROVIDER_RESULT.json`),
    `${JSON.stringify(result, null, 2)}\n`
  );
}

function requireAbsolutePath(name, value) {
  if (!value?.startsWith("/") || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
}

function readProcessOutput(executable, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", rejectOutput);
    child.once("exit", (code) => code === 0 ? resolveOutput(output) : rejectOutput(new Error(output)));
  });
}

async function sha256Text(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

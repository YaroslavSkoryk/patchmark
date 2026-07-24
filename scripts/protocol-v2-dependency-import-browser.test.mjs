import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
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
import {
  EXACT_PROTOCOL_V2_RESPONSE_BYTES,
  EXACT_PROTOCOL_V2_RESPONSE_SHA256,
  createExactProtocolV2ProjectFixture
} from "./lib/protocol-v2-dependency-import-fixture.mjs";

const editorUrl =
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const fixtureRoot = mkdtempSync(
  join(tmpdir(), "patchmark-exact-v2-browser-")
);
const projectDir = join(fixtureRoot, "Strategy Exact Protocol V2");
const fixture = createExactProtocolV2ProjectFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath =
  process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for protocol-v2 import browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(
  join(tmpdir(), "patchmark-exact-v2-browser-chrome-")
);
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

try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  const pageWsUrl = await createPage(browserWsUrl, "about:blank");
  client = await CdpClient.connect(pageWsUrl);
  client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      consoleErrors.push(
        event.args
          ?.map((argument) => argument.value ?? argument.description)
          .join(" ")
      );
    }
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(event.exceptionDetails?.text ?? "Unknown exception");
  });
  client.on("Network.loadingFailed", (event) => {
    if (!event.canceled) {
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
      projectName: "Strategy Exact Protocol V2"
    })
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.body.textContent?.includes("Strategy Exact Protocol V2") &&
      document.querySelectorAll(".comment-floating-item article[aria-label]").length === 1`,
    "exact protocol-v2 project"
  );

  await clickButtonByText(client, "Import ChatGPT Response");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-import-dialog"))`,
    "import dialog"
  );

  const missingDependency = structuredClone(fixture.response);
  getProposal(missingDependency, "link-horme-evidence").depends_on = [];
  await setImportResponse(client, JSON.stringify(missingDependency));
  await clickButtonByText(client, "Import");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-import-error"))`,
    "missing dependency error"
  );
  const negativeState = await evaluate(client, {
    expression: `(() => {
      const alert = document.querySelector(".comment-import-error");
      return {
        error: alert?.querySelector("p")?.textContent?.trim() ?? "",
        repairPrompt: alert?.querySelector("textarea")?.value ?? "",
        writes: window.__patchmarkFixtureWriteLog?.length ?? 0
      };
    })()`
  });
  assert.match(negativeState.error, /link-horme-evidence/);
  assert.match(
    negativeState.error,
    /https:\/\/www\.wongnai\.com\/restaurants\//
  );
  assert.match(negativeState.error, /2026-07-16/);
  assert.match(
    negativeState.repairPrompt,
    /dependency_source_date_coverage_failed/
  );
  assert.match(negativeState.repairPrompt, /Disclosure prerequisite status: absent/);
  assert.match(negativeState.repairPrompt, /Correct the `depends_on` graph/);
  assert.equal(negativeState.writes, 0);
  assert.equal(readReviewBatch(fixture.store).status, "exported");

  const exactTextareaState = await setImportResponse(client, fixture.raw);
  assert.equal(exactTextareaState.bytes, EXACT_PROTOCOL_V2_RESPONSE_BYTES);
  assert.equal(exactTextareaState.unchanged, true);
  await clickButtonByText(client, "Import");
  await waitFor(
    client,
    `!document.querySelector(".comment-import-dialog") &&
      document.querySelector(".document-save-banner")?.textContent?.includes("Patch proposals stored: 18")`,
    "successful exact response import"
  );
  await waitFor(
    client,
    `(() => {
      const raw = window.__patchmarkFixtureWrites?.get(
        ".patchmark/documents/${fixture.response.document_id}/review-batches.json"
      );
      return raw && JSON.parse(raw)[0]?.status === "response_received";
    })()`,
    "Review Batch response receipt"
  );

  const comments = readJson(join(fixture.store, "comments.json"));
  const patches = readJson(join(fixture.store, "patches.json"));
  const reviewBatch = readReviewBatch(fixture.store);
  const importFiles = readdirSync(join(fixture.store, "imports")).filter(
    (fileName) => fileName.endsWith("-comment-reply-import.json")
  );
  const writeLog = await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog?.map((entry) => ({
      path: entry.path,
      sequence: entry.sequence,
      status: entry.status
    })) ?? []`
  });
  const finalPatchWrite = writeLog.findLast(
    (entry) =>
      entry.path ===
      `.patchmark/documents/${fixture.response.document_id}/patches.json`
  );
  const receiptWrite = writeLog.findLast(
    (entry) =>
      entry.path ===
      `.patchmark/documents/${fixture.response.document_id}/review-batches.json`
  );

  assert.equal(comments[0].thread.length, 1);
  assert.equal(comments[0].thread[0].content, fixture.response.replies[0].reply);
  assert.equal(patches.length, 18);
  assert.ok(patches.every((patch) => patch.status === "pending"));
  assert.deepEqual(
    patches.find(
      (patch) => patch.source_patch_key === "link-horme-evidence"
    )?.depends_on_patch_keys_snapshot,
    ["competitor-observation-dates"]
  );
  assert.equal(
    patches.find(
      (patch) =>
        patch.source_patch_key === "remove-redundant-sources-section"
    )?.depends_on_patch_keys_snapshot.length,
    17
  );
  assert.equal(reviewBatch.status, "response_received");
  assert.ok(reviewBatch.import_id);
  assert.equal(importFiles.length, 1);
  assert.ok(writeLog.every((entry) => entry.status === "completed"));
  assert.ok(finalPatchWrite);
  assert.ok(receiptWrite);
  assert.ok(receiptWrite.sequence > finalPatchWrite.sequence);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(networkFailures, []);

  console.log(
    JSON.stringify(
      {
        exactResponseBytes: EXACT_PROTOCOL_V2_RESPONSE_BYTES,
        exactResponseSha256: EXACT_PROTOCOL_V2_RESPONSE_SHA256,
        failedValidationWrites: negativeState.writes,
        importedPatches: patches.length,
        noAutomaticAcceptance: patches.every(
          (patch) => patch.status === "pending"
        ),
        productionUrl: editorUrl,
        reviewBatchStatus: reviewBatch.status,
        receiptAfterPatchCommit:
          receiptWrite.sequence > finalPatchWrite.sequence
      },
      null,
      2
    )
  );
} finally {
  await client?.close().catch(() => {});
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 2_000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function setImportResponse(pageClient, responseText) {
  return evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector(".comment-import-fields textarea");
      if (!textarea) throw new Error("Import response field missing.");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(textarea, ${JSON.stringify(responseText)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        bytes: new TextEncoder().encode(textarea.value).byteLength,
        unchanged: textarea.value === ${JSON.stringify(responseText)}
      };
    })()`,
    userGesture: true
  });
}

async function waitFor(pageClient, expression, label) {
  let latest = null;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    latest = await evaluate(pageClient, {
      expression: `Boolean(${expression})`
    });
    if (latest) {
      return;
    }
    await delay(50);
  }

  const body = await evaluate(pageClient, {
    expression: "document.body.textContent?.slice(0, 4000) ?? ''"
  });
  throw new Error(`Timed out waiting for ${label}.\n${body}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readReviewBatch(store) {
  return readJson(join(store, "review-batches.json"))[0];
}

function getProposal(response, patchKey) {
  const proposal = response.patch_proposals.find(
    (candidate) => candidate.patch_key === patchKey
  );
  assert.ok(proposal, `Missing response proposal ${patchKey}.`);
  return proposal;
}

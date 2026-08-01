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
  ATOMIC_MULTI_TABLE_RESPONSE_BYTES,
  ATOMIC_MULTI_TABLE_RESPONSE_SHA256,
  createAtomicMultiTableProjectFixture
} from "./lib/atomic-multi-table-import-fixture.mjs";

const editorUrl =
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const chromePath =
  process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for atomic multi-table browser tests.");
}

await assertEditorIsReachable(editorUrl);

const conflictResult = await runImportScenario({
  chromePath,
  editorUrl,
  genuineConflict: true
});
const exactResult = await runImportScenario({
  chromePath,
  editorUrl,
  genuineConflict: false
});

console.log(
  JSON.stringify(
    {
      exactImport: exactResult,
      genuineConflict: conflictResult
    },
    null,
    2
  )
);

async function runImportScenario({
  chromePath,
  editorUrl,
  genuineConflict
}) {
  const fixtureRoot = mkdtempSync(
    join(
      tmpdir(),
      genuineConflict
        ? "patchmark-atomic-table-conflict-browser-"
        : "patchmark-atomic-multi-table-browser-"
    )
  );
  const projectDir = join(fixtureRoot, "Atomic Multi Table");
  const fixture = createAtomicMultiTableProjectFixture(projectDir);
  const responseText = genuineConflict
    ? createGenuineConflictResponse(fixture.response)
    : fixture.raw;
  const inventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(projectDir, inventory);
  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-atomic-multi-table-chrome-")
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
  const consoleErrors = [];
  const exceptions = [];
  const networkFailures = [];
  let client;

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
        projectName: "Atomic Multi Table"
      })
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitFor(
      client,
      `document.body.textContent?.includes("Atomic Multi Table") &&
        document.body.textContent?.includes("Restructure the planning tables")`,
      "atomic multi-table project"
    );
    await delay(500);
    await evaluate(client, {
      expression: `window.__patchmarkFixtureWriteLog.length = 0`
    });
    await clickButtonByText(client, "Import ChatGPT Response");
    await waitFor(
      client,
      `Boolean(document.querySelector(".comment-import-dialog"))`,
      "import dialog"
    );
    const textareaState = await setImportResponse(client, responseText);
    assert.equal(textareaState.unchanged, true);
    await clickButtonByText(client, "Import");

    if (genuineConflict) {
      await waitFor(
        client,
        `Boolean(document.querySelector(".comment-import-error"))`,
        "genuine structural conflict"
      );
      const uiState = await evaluate(client, {
        expression: `(() => {
          const error = document.querySelector(".comment-import-error");
          return {
            errorCode: error?.dataset.errorCode ?? "",
            message: error?.querySelector("p")?.textContent?.trim() ?? "",
            repairPromptVisible: Boolean(error?.querySelector("textarea")),
            writes: window.__patchmarkFixtureWriteLog?.map((entry) => ({
              path: entry.path,
              status: entry.status
            })) ?? []
          };
        })()`
      });
      const comments = readJson(join(fixture.store, "comments.json"));
      const patches = readJson(join(fixture.store, "patches.json"));
      const reviewBatch = readJson(
        join(fixture.store, "review-batches.json")
      )[0];
      const importFiles = readdirSync(join(fixture.store, "imports")).filter(
        (fileName) => fileName.endsWith("-comment-reply-import.json")
      );

      assert.equal(
        uiState.errorCode,
        "split_structural_change_across_proposals"
      );
      assert.match(uiState.message, /across multiple patch proposals/);
      assert.equal(uiState.repairPromptVisible, true);
      assert.deepEqual(uiState.writes, []);
      assert.equal(comments[0].thread.length, 0);
      assert.equal(patches.length, 0);
      assert.equal(reviewBatch.status, "exported");
      assert.equal(reviewBatch.response_analysis, null);
      assert.equal(importFiles.length, 0);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(exceptions, []);
      assert.deepEqual(networkFailures, []);

      return {
        errorCode: uiState.errorCode,
        noPartialWrites: true,
        repairPromptVisible: uiState.repairPromptVisible,
        reviewBatchStatus: reviewBatch.status
      };
    }

    assert.equal(textareaState.bytes, ATOMIC_MULTI_TABLE_RESPONSE_BYTES);
    await waitFor(
      client,
      `!document.querySelector(".comment-import-dialog") &&
        document.querySelector(".document-save-banner")?.textContent?.includes("Patch proposals stored: 1")`,
      "successful exact atomic multi-table import"
    );
    const comments = readJson(join(fixture.store, "comments.json"));
    const patches = readJson(join(fixture.store, "patches.json"));
    const reviewBatch = readJson(
      join(fixture.store, "review-batches.json")
    )[0];
    const importFiles = readdirSync(join(fixture.store, "imports")).filter(
      (fileName) => fileName.endsWith("-comment-reply-import.json")
    );
    const writeLog = await evaluate(client, {
      expression: `window.__patchmarkFixtureWriteLog?.map((entry) => ({
        path: entry.path,
        status: entry.status
      })) ?? []`
    });

    assert.equal(comments[0].thread.length, 1);
    assert.equal(comments[0].thread[0].content, fixture.response.replies[0].reply);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "pending");
    assert.equal(patches[0].source_patch_key, fixture.response.patch_proposals[0].patch_key);
    assert.deepEqual(patches[0].depends_on_patch_ids, []);
    assert.equal(reviewBatch.status, "responded");
    assert.equal(reviewBatch.response_analysis.coverage_status, "complete");
    assert.deepEqual(reviewBatch.response_analysis.aggregate, {
      expected_comments: 1,
      addressed_comments: 1,
      unanswered_comments: 0,
      replies_added: 1,
      patch_proposals_added: 1,
      clarification_questions: 0,
      explicit_no_change_responses: 0
    });
    assert.equal(importFiles.length, 1);
    assert.ok(writeLog.length > 0);
    assert.ok(writeLog.every((entry) => entry.status === "completed"));
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(exceptions, []);
    assert.deepEqual(networkFailures, []);

    await clickButtonByText(client, "Guided Review");
    await waitFor(
      client,
      `Boolean(document.querySelector('[aria-label="Review Batch response summary"]'))`,
      "Review Batch response summary"
    );
    const responseSummary = await evaluate(client, {
      expression: `document.querySelector('[aria-label="Review Batch response summary"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`
    });
    assert.match(responseSummary, /1 of 1/);
    assert.match(responseSummary, /Patch proposals1/);

    return {
      exactResponseBytes: textareaState.bytes,
      exactResponseSha256: ATOMIC_MULTI_TABLE_RESPONSE_SHA256,
      importedPatchCount: patches.length,
      noAutomaticAcceptance: patches[0].status === "pending",
      responseAnalysis: reviewBatch.response_analysis.aggregate,
      reviewBatchStatus: reviewBatch.status
    };
  } finally {
    await client?.close().catch(() => {});
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 2_000);
    await fixtureServer.close();
    rmSync(userDataDir, { force: true, recursive: true });
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function createGenuineConflictResponse(response) {
  const firstProposal = response.patch_proposals[0];
  const originalRow =
    "| Stage 1: Controlled launch  | Small order windows, limited SKUs, direct retail first, small wholesale samples only.                             | Roughly 20-50 bread-unit equivalents per week, depending on production schedule and demand.      | Can the company produce, deliver, collect payment, and receive useful feedback without chaos? |";
  const secondProposal = {
    ...firstProposal,
    patch_key: "rewrite-stage-one-row-independently",
    display_title: "Rewrite stage one row independently",
    original_text: originalRow,
    suggested_text: originalRow.replace("Small order windows", "Limited order windows"),
    reason: "Rewords one row independently.",
    risk: "Conflicts with the complete structural replacement."
  };

  return JSON.stringify(
    {
      ...response,
      patch_proposals: [firstProposal, secondProposal]
    },
    null,
    2
  );
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ready = await evaluate(pageClient, {
      expression: `Boolean(${expression})`
    });
    if (ready) {
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

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
  INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES,
  INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256,
  createIndependentProtocolV2ProjectFixture
} from "./lib/independent-protocol-v2-import-fixture.mjs";

const editorUrl =
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const chromePath =
  process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error(
    "Chrome was not found for independent protocol-v2 browser tests."
  );
}

await assertEditorIsReachable(editorUrl);

const staleResult = await runImportScenario({
  chromePath,
  editorUrl,
  staleFormula: true
});
const exactResult = await runImportScenario({
  chromePath,
  editorUrl,
  staleFormula: false
});

console.log(
  JSON.stringify(
    {
      exactImport: exactResult,
      staleImport: staleResult
    },
    null,
    2
  )
);

async function runImportScenario({ chromePath, editorUrl, staleFormula }) {
  const fixtureRoot = mkdtempSync(
    join(
      tmpdir(),
      staleFormula
        ? "patchmark-independent-stale-browser-"
        : "patchmark-independent-exact-browser-"
    )
  );
  const projectDir = join(fixtureRoot, "Independent Protocol V2");
  const fixture = createIndependentProtocolV2ProjectFixture(projectDir, {
    staleFormula
  });
  const inventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(projectDir, inventory);
  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-independent-v2-browser-chrome-")
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
        projectName: "Independent Protocol V2"
      })
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitFor(
      client,
      `document.body.textContent?.includes("Independent Protocol V2") &&
        document.body.textContent?.includes("Review explain-unit-economics-formulas.")`,
      "independent protocol-v2 project"
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
    const textareaState = await setImportResponse(client, fixture.raw);
    assert.equal(textareaState.bytes, INDEPENDENT_PROTOCOL_V2_RESPONSE_BYTES);
    assert.equal(textareaState.unchanged, true);
    await clickButtonByText(client, "Import");

    if (staleFormula) {
      await waitFor(
        client,
        `Boolean(document.querySelector(".comment-import-error"))`,
        "current-document stale error"
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
        "current_document_patch_target_missing"
      );
      assert.match(uiState.message, /current saved document/);
      assert.match(
        uiState.message,
        /changed after the prompt was exported/
      );
      assert.doesNotMatch(uiState.message, /prerequisite/i);
      assert.equal(uiState.repairPromptVisible, false);
      assert.deepEqual(uiState.writes, []);
      assert.deepEqual(
        comments.map((comment) => comment.thread.length),
        [0, 0, 0, 0]
      );
      assert.equal(patches.length, 0);
      assert.equal(reviewBatch.status, "exported");
      assert.equal(reviewBatch.response_analysis, null);
      assert.equal(importFiles.length, 0);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(exceptions, []);
      assert.deepEqual(networkFailures, []);

      return {
        errorCode: uiState.errorCode,
        noPartialWrites: uiState.writes.length === 0,
        repairPromptVisible: uiState.repairPromptVisible,
        reviewBatchStatus: reviewBatch.status
      };
    }

    await waitFor(
      client,
      `!document.querySelector(".comment-import-dialog") &&
        document.querySelector(".document-save-banner")?.textContent?.includes("Patch proposals stored: 4")`,
      "successful exact independent import"
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

    assert.deepEqual(
      comments.map((comment) => comment.thread.length),
      [1, 1, 1, 1]
    );
    assert.deepEqual(
      comments.map((comment) => comment.thread[0]?.content),
      fixture.response.replies.map((reply) => reply.reply)
    );
    assert.equal(patches.length, 4);
    assert.ok(patches.every((patch) => patch.status === "pending"));
    assert.ok(
      patches.every(
        (patch) =>
          patch.depends_on_patch_ids.length === 0 &&
          patch.depends_on_patch_keys_snapshot.length === 0
      )
    );
    assert.equal(reviewBatch.status, "responded");
    assert.equal(reviewBatch.response_analysis.coverage_status, "complete");
    assert.deepEqual(reviewBatch.response_analysis.aggregate, {
      expected_comments: 4,
      addressed_comments: 4,
      unanswered_comments: 0,
      replies_added: 4,
      patch_proposals_added: 4,
      clarification_questions: 0,
      explicit_no_change_responses: 0
    });
    assert.equal(importFiles.length, 1);
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
    assert.match(responseSummary, /4 of 4/);
    assert.match(responseSummary, /Patch proposals4/);
    await clickButtonByText(client, "Close Guided Review");
    await waitFor(
      client,
      `!document.querySelector('[aria-label="Guided Review Wizard"]')`,
      "Guided Review close"
    );

    await openCommentPatch(
      client,
      "Review clarify-additional-utility-cost.",
      "Clarify additional utility cost"
    );
    const firstPatchState = await readPatchDialogState(client);
    assert.equal(firstPatchState.acceptDisabled, false);
    assert.equal(firstPatchState.hasDependencySummary, false);
    await evaluate(client, {
      expression: `window.confirm = () => true; true`,
      userGesture: true
    });
    await clickButtonByText(client, "Accept Patch");
    const patchPath =
      `.patchmark/documents/${fixture.response.document_id}/patches.json`;
    await waitFor(
      client,
      `(() => {
        const raw = window.__patchmarkFixtureWrites?.get(${JSON.stringify(
          patchPath
        )});
        if (!raw) return false;
        const stored = JSON.parse(raw);
        return stored[0]?.status === "accepted" &&
          stored.slice(1).every((patch) => patch.status === "pending");
      })()`,
      "one independent patch accepted"
    );
    await clickButtonByText(client, "Back to group");
    await waitFor(
      client,
      `Boolean(document.querySelector('[aria-label="Review Patch Group"]'))`,
      "first patch group"
    );
    await clickButtonByText(client, "Close");
    await waitFor(
      client,
      `!document.querySelector('[aria-label="Review Patch Group"]')`,
      "first patch group close"
    );

    await openCommentPatch(
      client,
      "Review explain-unit-economics-formulas.",
      "Explain unit economics formulas"
    );
    const formulaPatchState = await readPatchDialogState(client);
    assert.equal(formulaPatchState.acceptDisabled, false);
    assert.equal(formulaPatchState.hasDependencySummary, false);
    const persistedAfterAcceptance = readJson(
      join(fixture.store, "patches.json")
    );
    assert.equal(persistedAfterAcceptance[0].status, "accepted");
    assert.ok(
      persistedAfterAcceptance
        .slice(1)
        .every((patch) => patch.status === "pending")
    );

    return {
      exactResponseBytes: textareaState.bytes,
      exactResponseSha256: INDEPENDENT_PROTOCOL_V2_RESPONSE_SHA256,
      formulaStillReviewableAfterSiblingAcceptance:
        !formulaPatchState.acceptDisabled,
      importedPatchCount: patches.length,
      noDependencyBadges: !formulaPatchState.hasDependencySummary,
      noAutomaticAcceptance: persistedAfterAcceptance
        .slice(1)
        .every((patch) => patch.status === "pending"),
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

async function openCommentPatch(client, commentText, patchTitle) {
  await evaluate(client, {
    expression: `(() => {
      const article = Array.from(document.querySelectorAll("article[aria-label]"))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(
          commentText
        )}));
      if (!article) throw new Error("Comment card not found.");
      article.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `Array.from(document.querySelectorAll("article[aria-label]"))
      .find((candidate) => candidate.textContent?.includes(${JSON.stringify(
        commentText
      )}))
      ?.querySelector(".comment-pending-patches button")`,
    `comment patch action for ${patchTitle}`
  );
  await evaluate(client, {
    expression: `(() => {
      const article = Array.from(document.querySelectorAll("article[aria-label]"))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(
          commentText
        )}));
      const reviewButton = article?.querySelector(".comment-pending-patches button");
      if (!reviewButton) throw new Error("Comment patch review button not found.");
      reviewButton.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review Patch Group"]'))`,
    `patch group for ${patchTitle}`
  );
  await evaluate(client, {
    expression: `(() => {
      const card = Array.from(document.querySelectorAll(".patch-group-patch-card"))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(
          patchTitle
        )}));
      const button = card?.querySelector("button:not([disabled])");
      if (!button) throw new Error("Patch card not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `document.querySelector('[aria-label="Review Patch Proposal"] h2')?.textContent?.trim() === ${JSON.stringify(
      patchTitle
    )}`,
    `patch proposal ${patchTitle}`
  );
}

async function readPatchDialogState(client) {
  return evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector('[aria-label="Review Patch Proposal"]');
      const accept = Array.from(dialog?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.trim() === "Accept Patch");
      return {
        acceptDisabled: Boolean(accept?.disabled),
        hasDependencySummary: Boolean(
          dialog?.querySelector(".patch-dependency-summary")
        )
      };
    })()`
  });
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

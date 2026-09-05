import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  TARGET_DUPLICATION_RESPONSE_BYTES,
  TARGET_DUPLICATION_RESPONSE_SHA256,
  createTargetDuplicationProjectFixture
} from "./lib/dependency-induced-target-duplication-fixture.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-target-provenance-browser-"));
const projectDir = join(fixtureRoot, "Strategy Target Duplication");
const fixture = createTargetDuplicationProjectFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for target provenance browser tests.");
}

await assertEditorIsReachable(editorUrl);
const userDataDir = mkdtempSync(
  join(tmpdir(), "patchmark-target-provenance-browser-chrome-")
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
      projectName: "Strategy Target Duplication"
    })
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.body.textContent?.includes("Strategy Target Duplication") &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Import ChatGPT Response"
      )`,
    "target duplication project"
  );

  await clickButtonByText(client, "Import ChatGPT Response");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-import-dialog"))`,
    "target duplication import dialog"
  );
  const invalidResponse = structuredClone(fixture.response);
  const dependencyCreatedMarker = "Dependency-created ambiguous target.";
  invalidResponse.patch_proposals[0].suggested_text +=
    `\n\n${dependencyCreatedMarker}\n\n${dependencyCreatedMarker}`;
  invalidResponse.patch_proposals[1].original_text = dependencyCreatedMarker;
  invalidResponse.patch_proposals[1].suggested_text =
    "Dependency-created target updated.";
  delete invalidResponse.patch_proposals[1].target_heading;
  await setImportResponse(client, JSON.stringify(invalidResponse));
  await clickButtonByText(client, "Import");
  await waitFor(
    client,
    `Boolean(document.querySelector(".comment-import-error"))`,
    "genuine target ambiguity"
  );
  const failureState = await evaluate(client, {
    expression: `(() => {
      const error = document.querySelector(".comment-import-error");
      return {
        text: error?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        repair: error?.querySelector("textarea")?.value ?? "",
        writes: window.__patchmarkFixtureWriteLog?.length ?? 0
      };
    })()`
  });
  assert.match(failureState.text, /ambiguous after declared prerequisite/);
  assert.match(failureState.repair, /dependency_target_genuine_ambiguity/);
  assert.match(failureState.repair, /Base target match count: 0/);
  assert.match(failureState.repair, /Post-prerequisite target match count: 2/);
  assert.doesNotMatch(failureState.repair, /Sources or References/);
  assert.equal(failureState.writes, 0);
  assert.equal(readJson(join(fixture.store, "patches.json")).length, 0);
  assert.equal(readJson(join(fixture.store, "comments.json"))[0].thread.length, 0);
  assert.equal(readJson(join(fixture.store, "review-batches.json"))[0].status, "exported");

  const textareaState = await setImportResponse(client, fixture.raw);
  assert.deepEqual(textareaState, {
    bytes: TARGET_DUPLICATION_RESPONSE_BYTES,
    unchanged: true
  });
  await clickButtonByText(client, "Import");
  await waitFor(
    client,
    `!document.querySelector(".comment-import-dialog") &&
      document.querySelector(".document-save-banner")?.textContent?.includes("Patches proposed: 2")`,
    "successful target duplication import"
  );

  const comments = readJson(join(fixture.store, "comments.json"));
  const patches = readJson(join(fixture.store, "patches.json"));
  const reviewBatch = readJson(join(fixture.store, "review-batches.json"))[0];
  assert.equal(comments[0].thread.length, 1);
  assert.equal(comments[0].thread[0].content, fixture.response.replies[0].reply);
  assert.equal(patches.length, 2);
  assert.ok(patches.every((patch) => patch.status === "pending"));
  assert.deepEqual(patches[1].depends_on_patch_keys_snapshot, [
    "add-complete-sensitivity-appendix"
  ]);
  assert.equal(patches[1].target_provenance.document_id, fixture.response.document_id);
  assert.deepEqual(patches[1].target_provenance.heading_ancestry, [
    "# Strategy",
    "## 10. Growth Path and Scenarios",
    "### Scenario indicators"
  ]);
  assert.equal(reviewBatch.status, "responded");
  assert.equal(reviewBatch.response_analysis.aggregate.replies_added, 1);
  assert.equal(reviewBatch.response_analysis.aggregate.patch_proposals_added, 2);
  assert.equal(readFileSync(join(projectDir, "strategy.md"), "utf8"), fixture.markdown);

  await client.call("Page.reload");
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.body.textContent?.includes("Strategy Target Duplication") &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Import ChatGPT Response"
      )`,
    "reopened target duplication project"
  );
  assert.equal(readJson(join(fixture.store, "patches.json")).length, 2);
  assert.equal(readJson(join(fixture.store, "review-batches.json"))[0].status, "responded");

  console.log(
    JSON.stringify(
      {
        fixtureBytes: TARGET_DUPLICATION_RESPONSE_BYTES,
        fixtureSha256: TARGET_DUPLICATION_RESPONSE_SHA256,
        failedValidationWrites: failureState.writes,
        importedReplies: 1,
        importedPendingPatches: 2,
        noAutomaticAcceptance: true,
        reviewBatchStatus: reviewBatch.status,
        restartPersistence: true,
        productionUrl: editorUrl
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

async function setImportResponse(client, value) {
  return evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector(".comment-import-fields textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Response textarea not found.");
      }
      const value = ${JSON.stringify(value)};
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        bytes: new TextEncoder().encode(value).byteLength,
        unchanged: textarea.value === value
      };
    })()`,
    userGesture: true
  });
}

async function waitFor(client, expression, label) {
  let latestValue;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    latestValue = await evaluate(client, { expression });
    if (latestValue) {
      return;
    }
    await delay(50);
  }
  const bodyText = await evaluate(client, {
    expression: `document.body.textContent?.replace(/\\s+/g, " ").trim().slice(0, 1200) ?? ""`
  });
  throw new Error(
    `Timed out waiting for ${label}. Latest value: ${JSON.stringify(latestValue)}. Body: ${bodyText}`
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

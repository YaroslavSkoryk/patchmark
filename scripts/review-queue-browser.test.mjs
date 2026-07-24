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
import { basename, join, relative } from "node:path";
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
  const beforeWizard = fingerprintDirectory(projectDir);

  await clickButtonByText(client, "Guided Review");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review queue overview"]'))`,
    "first queue overview"
  );
  const firstOverview = await readWizard(client);
  assert.equal(firstOverview.documentTitle, "Market Review");
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.textContent?.trim() === "Close Guided Review"`
    }),
    true
  );
  assert.deepEqual(firstOverview.counts, {
    "Awaiting ChatGPT": 0,
    "Awaiting your review": 1,
    Blocked: 0,
    Deferred: 0,
    "Ready for ChatGPT": 3,
    Resolved: 0
  });
  await clickButtonByText(client, "Prepare next batch");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Proposed review batch"]')?.textContent?.includes("Market Evidence")`,
    "first review proposal"
  );
  const firstProposal = await readWizard(client);
  assert.equal(firstProposal.proposalTitle, "Next review batch");
  assert.deepEqual(firstProposal.proposedCommentIds, [
    "PM-COMMENT-0001",
    "PM-COMMENT-0002"
  ]);
  await clickCardAction(client, "PM-COMMENT-0002", "Remove from this batch");
  await waitFor(
    client,
    `document.querySelectorAll('[aria-label="Proposed review batch"] > .guided-review-comment-list .guided-review-comment-card').length === 1`,
    "transient removal"
  );
  assert.equal(await getFixtureWriteCount(client), 0);
  await clickButtonByText(client, "Reset suggestion");
  await waitFor(
    client,
    `document.querySelectorAll('[aria-label="Proposed review batch"] > .guided-review-comment-list .guided-review-comment-card').length === 2`,
    "proposal reset"
  );
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 820,
    mobile: false,
    width: 390
  });
  const responsiveState = await evaluate(client, {
      expression: `(() => {
        const dialog = document.querySelector('[aria-label="Guided Review Wizard"]');
        const summary = dialog?.querySelector('.guided-review-proposal-summary dl');
        const actions = dialog?.querySelector('.guided-review-wizard-actions');
        return {
          actionsDirection: actions ? getComputedStyle(actions).flexDirection : null,
          columns: summary ? getComputedStyle(summary).gridTemplateColumns : null,
          dialog: Boolean(dialog),
          media: matchMedia('(max-width: 900px)').matches,
          viewportWidth: window.innerWidth
        };
      })()`
    });
  assert.deepEqual(responsiveState, {
    actionsDirection: "column",
    columns: responsiveState.columns,
    dialog: true,
    media: true,
    viewportWidth: 390
  });
  assert.equal(responsiveState.columns?.includes(" "), false);
  await client.call("Input.dispatchKeyEvent", {
    code: "Escape",
    key: "Escape",
    type: "keyDown"
  });
  await waitFor(
    client,
    `!document.querySelector('[aria-label="Guided Review Wizard"]')`,
    "wizard closed with Escape"
  );
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1000,
    mobile: false,
    width: 1500
  });
  await clickButtonByText(client, "Guided Review");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Guided Review Wizard"]'))`,
    "reopened guided review"
  );

  await clickProjectDocument(client, "Second Review");
  await waitFor(
    client,
    `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent === "Second Review"`,
    "second document active"
  );
  await waitFor(
    client,
    `!document.querySelector('[aria-label="Guided Review Wizard"]')`,
    "wizard closed after switch"
  );
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item").length === 1`,
    "second document comments"
  );
  await clickButtonByText(client, "Guided Review");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review queue overview"]'))`,
    "second queue overview"
  );
  await clickButtonByText(client, "Prepare next batch");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Proposed review batch"]')?.textContent?.includes("Second Signals")`,
    "second review proposal"
  );
  const secondProposal = await readWizard(client);
  assert.equal(secondProposal.documentTitle, "Second Review");
  assert.deepEqual(secondProposal.proposedCommentIds, ["PM-COMMENT-0001"]);
  await clickWizardClose(client);

  assert.equal(await getFixtureWriteCount(client), 0);
  assert.equal(fingerprintDirectory(projectDir), beforeWizard);

  await clickProjectDocument(client, "Market Review");
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item").length === 4`,
    "first document restored"
  );
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value.includes('"review_batch_id"')`,
    "tracked manual prompt"
  );
  await waitFor(
    client,
    `window.__patchmarkFixtureWriteLog?.some((entry) => entry.path.includes("context-packs/") && entry.status === "completed")`,
    "manual context-pack write"
  );
  await waitFor(
    client,
    `window.__patchmarkFixtureWriteLog?.some((entry) => entry.path.endsWith("review-batches.json") && entry.status === "completed")`,
    "manual review batch write"
  );
  const manualWritePaths = await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog.map((entry) => entry.path)`
  });
  assert.ok(manualWritePaths.some((path) => path.includes("context-packs/")));
  assert.ok(manualWritePaths.some((path) => path.endsWith("review-batches.json")));
  assert.ok(manualWritePaths.every((path) => !path.endsWith("comments.json")));
  const exactExportedPrompt = await evaluate(client, {
    expression:
      `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value ?? ""`
  });
  const exportedPayload = JSON.parse(
    exactExportedPrompt.match(/## Patchmark Export Payload\n\n```json\n([\s\S]+)\n```\n?$/)?.[1]
  );
  const exportedBatchId = exportedPayload.review_batch.review_batch_id;
  assert.ok(exportedBatchId.startsWith("review_batch_"));
  assert.equal(exportedPayload.review_batch.document_id, "doc_market");
  assert.deepEqual(exportedPayload.review_batch.ordered_comment_ids, [
    "PM-COMMENT-0001"
  ]);

  await closePromptDialog(client);
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item").length === 4`,
    "reopened document comments"
  );
  await clickButtonByText(client, "Guided Review");
  await waitFor(
    client,
    `document.querySelector('[aria-label="Active Review Batch"]')?.textContent?.includes("Batch awaiting ChatGPT response")`,
    "active batch after restart"
  );
  assert.match(
    await evaluate(client, {
      expression:
        `document.querySelector('[aria-label="Active Review Batch"]')?.textContent ?? ""`
    }),
    /Source: Manual selection/
  );
  await clickButtonByText(client, "Open saved context pack");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Generate ChatGPT prompt"]'))`,
    "saved context pack reopened"
  );
  const reopenedPrompt = await evaluate(client, {
    expression:
      `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value ?? ""`
  });
  assert.equal(reopenedPrompt, exactExportedPrompt);
  await closePromptDialog(client);
  await clickButtonByText(client, "Cancel batch");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Cancel Review Batch"]'))`,
    "cancel confirmation"
  );
  await clickButtonByText(client, "Cancel exported batch");
  await waitFor(
    client,
    `!document.querySelector('[aria-label="Active Review Batch"]') && Boolean(document.querySelector('[aria-label="Review queue overview"]'))`,
    "cancelled batch removed from active evidence"
  );
  const persistedBatches = JSON.parse(
    readFileSync(
      join(
        projectDir,
        ".patchmark",
        "documents",
        "doc_market",
        "review-batches.json"
      ),
      "utf8"
    )
  );
  const cancelledBatch = persistedBatches.find(
    (batch) => batch.batch_id === exportedBatchId
  );
  assert.equal(cancelledBatch.status, "cancelled");
  assert.ok(
    statSync(
      join(
        projectDir,
        ".patchmark",
        "documents",
        "doc_market",
        "context-packs",
        basename(cancelledBatch.context_pack.relative_path)
      )
    ).isFile()
  );

  await clearFixtureWriteLog(client);
  await clickButtonByText(client, "Prepare next batch");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Proposed review batch"]'))`,
    "proposal before deferral"
  );
  await clickCardAction(client, "PM-COMMENT-0002", "Defer comment");
  await waitFor(
    client,
    `Array.from(document.querySelectorAll('.guided-review-counts > div')).some((item) => item.querySelector('dt')?.textContent?.trim() === 'Deferred' && item.querySelector('dd')?.textContent?.trim() === '1')`,
    "persisted deferral reflected in queue"
  );
  const deferWritePaths = await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteLog.map((entry) => entry.path)`
  });
  assert.ok(
    deferWritePaths.some((path) =>
      path.endsWith("review-queue-overrides.json")
    )
  );
  assert.ok(deferWritePaths.every((path) => !path.endsWith("comments.json")));
  assert.ok(deferWritePaths.every((path) => !path.endsWith("patches.json")));
  await evaluate(client, {
    expression: `(() => {
      const details = Array.from(document.querySelectorAll('.guided-review-detail-list'))
        .find((candidate) => candidate.querySelector('summary')?.textContent?.includes('Deferred comments'));
      if (!details) throw new Error('Deferred comments list not found.');
      details.open = true;
      return true;
    })()`
  });
  await clickButtonByText(client, "Return to queue");
  await waitFor(
    client,
    `Array.from(document.querySelectorAll('.guided-review-counts > div')).some((item) => item.querySelector('dt')?.textContent?.trim() === 'Deferred' && item.querySelector('dd')?.textContent?.trim() === '0')`,
    "restored deferred comment"
  );

  await clickButtonByText(client, "Prepare next batch");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Proposed review batch"]'))`,
    "guided adjusted proposal"
  );
  await clickCardAction(client, "PM-COMMENT-0002", "Remove from this batch");
  await clickButtonByText(client, "Generate prompt for this batch");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Generate ChatGPT prompt"]'))`,
    "guided tracked prompt"
  );
  const guidedPrompt = await evaluate(client, {
    expression:
      `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value ?? ""`
  });
  const guidedPayload = JSON.parse(
    guidedPrompt.match(/## Patchmark Export Payload\n\n```json\n([\s\S]+)\n```\n?$/)?.[1]
  );
  const guidedEnvelope = guidedPayload.review_batch;
  assert.equal(guidedEnvelope.document_id, "doc_market");
  assert.deepEqual(guidedEnvelope.ordered_comment_ids, ["PM-COMMENT-0001"]);
  await closePromptDialog(client);
  await clickButtonByText(client, "Import response");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Import ChatGPT response"]'))`,
    "response import dialog"
  );
  await fillImportResponse(client, {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    review_batch_id: guidedEnvelope.review_batch_id,
    project_id: guidedEnvelope.project_id,
    document_id: guidedEnvelope.document_id,
    summary: "Reviewed the tracked batch.",
    replies: [],
    patch_proposals: [],
    open_questions: []
  });
  await clickButtonByText(client, "Import");
  await waitFor(
    client,
    `!document.querySelector('[aria-label="Import ChatGPT response"]') && Boolean(document.querySelector('[aria-label="Review Batch response summary"]'))`,
    "exact response summary"
  );
  assert.equal(
    await evaluate(client, {
      expression: `document.activeElement?.textContent?.trim() === "Review response summary"`
    }),
    true
  );
  const receivedBatches = JSON.parse(
    readFileSync(
      join(
        projectDir,
        ".patchmark",
        "documents",
        "doc_market",
        "review-batches.json"
      ),
      "utf8"
    )
  );
  const receivedBatch = receivedBatches.find(
    (batch) => batch.batch_id === guidedEnvelope.review_batch_id
  );
  assert.equal(receivedBatch.status, "responded_partial");
  assert.ok(receivedBatch.import_id);
  assert.equal(receivedBatch.response_analysis.coverage_status, "partial");
  assert.equal(receivedBatch.response_analysis.aggregate.addressed_comments, 0);
  assert.equal(receivedBatch.response_analysis.aggregate.unanswered_comments, 1);
  assert.deepEqual(receivedBatch.selection_adjustment, {
    base_proposal_comment_ids: ["PM-COMMENT-0001", "PM-COMMENT-0002"],
    final_comment_ids: ["PM-COMMENT-0001"],
    transiently_removed_comment_ids: ["PM-COMMENT-0002"],
    transiently_added_comment_ids: []
  });
  assert.match(
    await evaluate(client, {
      expression: `document.querySelector('[aria-label="Review Batch response summary"] [role="status"]')?.textContent ?? ""`
    }),
    /did not address 1 comment/
  );
  await clickButtonByText(client, "Continue to next batch");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review queue overview"]'))`,
    "queue after partial response acknowledgment"
  );
  const partialProgressionOverview = await readWizard(client);
  assert.ok(partialProgressionOverview.counts["Ready for ChatGPT"] > 0);
  const acknowledgedBatches = JSON.parse(
    readFileSync(
      join(
        projectDir,
        ".patchmark",
        "documents",
        "doc_market",
        "review-batches.json"
      ),
      "utf8"
    )
  );
  assert.equal(
    acknowledgedBatches.find(
      (batch) => batch.batch_id === guidedEnvelope.review_batch_id
    ).status,
    "acknowledged"
  );

  console.log(
    JSON.stringify(
      {
        duplicateLocalIdIsolated: true,
        deferWritesOnlyReviewMetadata: true,
        firstOverview,
        firstProposal,
        manualExportWritePaths: manualWritePaths,
        noWriteFingerprintStable: true,
        exactPromptReopenedAfterRestart: reopenedPrompt === exactExportedPrompt,
        cancellationKeptContextPack: true,
        partialResponseSummary: true,
        partialProgressionOverview,
        transientWriteCount: 0,
        secondProposal,
        switchClosedWizard: true
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

async function readWizard(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => {
      const dialog = document.querySelector('[aria-label="Guided Review Wizard"]');
      const counts = Object.fromEntries(Array.from(dialog?.querySelectorAll(".guided-review-counts > div") ?? []).map((item) => [
        item.querySelector("dt")?.textContent?.trim(),
        Number(item.querySelector("dd")?.textContent ?? 0)
      ]));
      const proposal = dialog?.querySelector('[aria-label="Proposed review batch"]');
      return {
        counts,
        documentTitle: dialog?.querySelector(".guided-review-document strong")?.textContent?.trim() ?? null,
        proposalTitle: proposal?.querySelector("h3")?.textContent?.trim() ?? null,
        proposedCommentIds: Array.from(proposal?.querySelectorAll(":scope > .guided-review-comment-list .guided-review-comment-card > header > strong") ?? []).map((element) => element.textContent?.trim())
      };
    })()`
  });
}

async function clickWizardClose(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = document.querySelector('[aria-label="Guided Review Wizard"] .snapshot-dialog-header > button');
      if (!button) throw new Error("Guided Review close button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    pageClient,
    `!document.querySelector('[aria-label="Guided Review Wizard"]')`,
    "guided review closed"
  );
}

async function clickCardAction(pageClient, commentId, action) {
  await evaluate(pageClient, {
    expression: `(() => {
      const commentId = ${JSON.stringify(commentId)};
      const action = ${JSON.stringify(action)};
      const card = Array.from(document.querySelectorAll('.guided-review-comment-card'))
        .find((candidate) => candidate.querySelector('header strong')?.textContent?.trim() === commentId);
      const button = Array.from(card?.querySelectorAll('button') ?? [])
        .find((candidate) => candidate.textContent?.trim() === action && !candidate.disabled);
      if (!button) throw new Error('Guided Review action not found: ' + commentId + ' / ' + action);
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function closePromptDialog(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = document.querySelector('[aria-label="Generate ChatGPT prompt"] .snapshot-dialog-header > button');
      if (!button) throw new Error("Prompt close button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    pageClient,
    `!document.querySelector('[aria-label="Generate ChatGPT prompt"]')`,
    "prompt dialog closed"
  );
}

async function fillImportResponse(pageClient, response) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector('[aria-label="Import ChatGPT response"] .comment-import-fields textarea');
      if (!textarea) throw new Error("Import response textarea not found.");
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      valueSetter.call(textarea, ${JSON.stringify(JSON.stringify(response, null, 2))});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
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

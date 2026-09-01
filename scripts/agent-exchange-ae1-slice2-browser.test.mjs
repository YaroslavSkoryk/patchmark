import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const commentId = "PM-COMMENT-AE2-0001";
const originalMarkdown = "# Orbital Garden Operations\n\nSynthetic operators calibrate imaginary lantern arrays before each rehearsal.\n";
const firstOriginal = "Synthetic operators calibrate imaginary lantern arrays before each rehearsal.";
const firstSuggested = "Synthetic operators carefully calibrate imaginary lantern arrays before each rehearsal.";
const secondOriginal = "before each rehearsal.";
const secondSuggested = "before every rehearsal.";
const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-agent-exchange-slice2-"));
const sourceFixture = new URL("./fixtures/projects/core-multidoc", import.meta.url).pathname;
const scenarioNames = [
  "Success",
  "Cancel",
  "Unavailable",
  "Interrupted",
  "Malformed",
  "Persistence",
  "Scope Switch",
  "Target",
  "Guided",
  "Reload"
];
const projectPaths = scenarioNames.map((name, index) =>
  createScenarioProject(name, index + 1)
);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-agent-exchange-slice2-chrome-"));

if (!chromePath) throw new Error("Chrome was not found for Agent Exchange Slice 2 qualification.");
await assertEditorIsReachable(editorUrl);

const chrome = spawn(chromePath, [
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
], { stdio: ["ignore", "ignore", "pipe"] });

let client;
const consoleErrors = [];
const exceptions = [];
const networkFailures = [];
const evidence = {
  accessibility: {},
  cancellation: {},
  failures: {},
  guided: {},
  productionCapabilities: {},
  reload: {},
  responsive: {},
  success: {},
  switching: {}
};

try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  client = await CdpClient.connect(await createPage(browserWsUrl, "about:blank"));
  client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      consoleErrors.push(event.args?.map((item) => item.value ?? item.description).join(" "));
    }
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text);
  });
  client.on("Network.loadingFailed", (event) => {
    if (!event.canceled) networkFailures.push(event.errorText);
  });
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Network.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      pickerPaths: projectPaths,
      projectName: basename(fixtureRoot)
    })
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createQualificationDriverShim()
  });
  await setViewport(1440, 1000);
  await client.call("Page.navigate", { url: `${editorUrl}?agent-exchange-slice2=${Date.now()}` });
  await waitForEditorShell(client);

  await openNextProject("Success");
  await openComments();
  await waitForSendAction();
  assert.equal(await agentDomCount(), 1);
  assert.equal(await humanCollaborationDomCount(), 0);
  const beforeExplicitSend = await connectorEvidence();
  assert.deepEqual(beforeExplicitSend, {
    aborts: 0,
    availabilityChecks: 0,
    closes: 0,
    connectorCreations: 0,
    operationIds: 0,
    submissions: []
  });
  evidence.productionCapabilities = {
    beforeExplicitSend,
    connectorNetworkRequests: 0,
    humanCollaborationDom: 0
  };

  await configureConnector({ holdAvailability: true, mode: "delayed" });
  await activateSendTwiceInOneTask();
  await waitForPhase("sending");
  assert.equal(
    await evaluate(client, { expression: `document.activeElement?.textContent?.trim()` }),
    "Cancel"
  );
  assert.equal((await connectorEvidence()).availabilityChecks, 1);
  assert.equal(countPromptPacks(projectPaths[0]), 1, "double activation creates one tracked export");
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.releaseAvailability()` });
  await waitForPhase("waiting");
  const submitted = await connectorEvidence();
  assert.equal(submitted.submissions.length, 1);
  const promptText = readOnlyPromptPack(projectPaths[0]);
  assert.equal(new TextDecoder().decode(Uint8Array.from(submitted.submissions[0].requestBytes)), promptText);

  await closeComments();
  assert.equal(await visibleAgentDomCount(), 0);
  assert.equal(
    await evaluate(client, { expression: `document.activeElement?.classList.contains('application-comments-trigger')` }),
    true
  );
  await openComments();
  await waitForPhase("waiting");
  await evaluate(client, { expression: `document.querySelector('#patchmark-comment-card-${commentId}')?.focus(); true` });
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await waitForPhase("ready");
  assert.equal(
    await evaluate(client, { expression: `document.activeElement?.id` }),
    `patchmark-comment-card-${commentId}`,
    "late completion does not steal focus"
  );
  assert.equal(readComments(projectPaths[0])[0].thread.length, 1);
  assert.equal(readPatches(projectPaths[0]).length, 2);
  assert.equal(readMarkdown(projectPaths[0]), originalMarkdown);
  await keyboardActivateButton("Review replies and suggestions");
  await waitFor(
    `document.querySelector('#patchmark-comment-card-${commentId}')?.getAttribute('aria-current') === 'true'`,
    "imported response comment focus"
  );
  const focusedReview = await evaluate(client, {
    expression: `(() => ({
      activeId: document.activeElement?.id,
      reply: document.querySelector('#patchmark-comment-card-${commentId}')?.textContent,
      reviewName: Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Review replies and suggestions')?.textContent ?? null
    }))()`
  });
  assert.equal(focusedReview.activeId, `patchmark-comment-card-${commentId}`);
  assert.match(focusedReview.reply, /two requested improvements are proposed separately/i);

  await openPatchReview();
  await evaluate(client, { expression: `window.confirm = () => true; true`, userGesture: true });
  await clickButtonByText(client, "Accept Patch");
  await waitForFile(projectPaths[0], "carefully calibrate");
  assert.match(readMarkdown(projectPaths[0]), /carefully calibrate/);
  await selectPatchRow(1);
  await clickButtonByText(client, "Reject Patch");
  await waitFor(
    `document.querySelector('[aria-label="Review Patch Proposal"] .patch-status-badge')?.textContent?.includes('REJECTED')`,
    "second proposal rejection"
  );
  assert.doesNotMatch(readMarkdown(projectPaths[0]), /before every rehearsal/);
  evidence.success = {
    exactSubmittedBytes: true,
    promptPacks: countPromptPacks(projectPaths[0]),
    replies: readComments(projectPaths[0])[0].thread.length,
    patches: readPatches(projectPaths[0]).map((patch) => patch.status)
  };

  await client.call("Page.reload");
  await waitForEditorShell(client);
  assert.equal((await connectorEvidence()).submissions.length, 0, "reload does not resume transient operation");
  await openNextProject("Success");
  assert.ok(
    readComments(projectPaths[0])[0].thread.some((entry) =>
      entry.content?.includes("two requested improvements are proposed separately")
    )
  );
  assert.deepEqual(readPatches(projectPaths[0]).map((patch) => patch.status).sort(), ["accepted", "rejected"]);

  await openNextProject("Cancel");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "delayed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await keyboardActivateButton("Cancel");
  await waitForPhase("cancelled");
  const cancelFocus = await evaluate(client, { expression: `document.activeElement?.textContent?.trim()` });
  assert.equal(cancelFocus, "Use manual export instead");
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await delay(150);
  assert.equal(readComments(projectPaths[1])[0].thread.length, 0);
  assert.equal(readPatches(projectPaths[1]).length, 0);
  assert.equal(await currentPhase(), "cancelled");
  evidence.cancellation = {
    aborts: (await connectorEvidence()).aborts,
    lateImportRejected: true,
    fallbackFocus: cancelFocus
  };

  await openNextProject("Unavailable");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "unavailable" });
  await keyboardActivateSend();
  await waitForPhase("failed");
  assert.match(await agentText(), /Patchmark Connector isn’t running/);
  const unavailablePrompt = readOnlyPromptPack(projectPaths[2]);
  await keyboardActivateButton("Use manual export instead");
  await waitFor(`Boolean(document.querySelector('[aria-label="Generate ChatGPT prompt"]'))`, "manual fallback dialog");
  assert.equal(await fallbackPromptText(), unavailablePrompt);
  await keyboardActivateButton("Copy Prompt");
  await clickButtonByText(client, "Close");

  await openNextProject("Interrupted");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "submit_throw" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("failed");
  assert.match(await agentText(), /Couldn’t reach agent/);

  await openNextProject("Malformed");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "malformed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await waitForPhase("failed");
  assert.match(await agentText(), /couldn’t be imported/i);
  assert.equal(readComments(projectPaths[4])[0].thread.length, 0);
  assert.equal(readPatches(projectPaths[4]).length, 0);

  await openNextProject("Persistence");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "delayed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await evaluate(client, {
    expression: `window.__patchmarkFixtureWriteControls.failNextPath = ${JSON.stringify(`${projectPaths[5]}/.patchmark/documents/doc_operations/review-batches.json`)}; window.__patchmarkAgentExchangeControl.completeNext(); true`
  });
  await waitForPhase("failed");
  assert.match(await agentText(), /couldn’t be imported/i);
  assert.equal(readComments(projectPaths[5])[0].thread.length, 0);
  assert.equal(readPatches(projectPaths[5]).length, 0);
  evidence.failures = {
    interruption: true,
    malformedAtomic: true,
    persistenceRollback: true,
    unavailableFallbackExact: true
  };

  await openNextProject("Scope Switch");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "delayed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await clickProjectDocument("Quiet Orbit Summary");
  await waitForWorkspaceDocument("Quiet Orbit Summary");
  assert.equal(await currentPhase(), "idle");
  assert.doesNotMatch(await agentText(), /Waiting for agent|Sending/);
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await delay(150);
  assert.equal(readComments(projectPaths[6])[0].thread.length, 0);
  assert.equal(readPatches(projectPaths[6]).length, 0);

  await clickProjectDocument("Orbital Garden Operations");
  await waitForWorkspaceDocument("Orbital Garden Operations");
  await openComments();
  assert.equal(await currentPhase(), "idle", "returning to the document does not revive invalidated operation");
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "delayed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await openNextProject("Target");
  assert.equal(await currentPhase(), "idle");
  assert.doesNotMatch(await agentText(), /Waiting for agent|Sending/);
  await openComments();
  await waitForSendAction();
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await delay(150);
  assert.equal(await currentPhase(), "waiting", "older completion cannot replace the newer operation status");
  assert.equal(readComments(projectPaths[6])[0].thread.length, 0);
  assert.equal(readComments(projectPaths[7])[0].thread.length, 0);
  await clickButtonByText(client, "Cancel");
  await waitForPhase("cancelled");
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.completeNext()` });
  await delay(100);
  assert.equal(readComments(projectPaths[7])[0].thread.length, 0);
  evidence.switching = {
    documentIsolation: true,
    projectIsolation: true,
    staleOlderCompletionRejected: true
  };

  await openNextProject("Guided");
  await clickButtonByText(client, "Review");
  await waitFor(`Boolean(document.querySelector('[role="menu"]:not([hidden])'))`, "Review menu");
  await clickButtonByText(client, "Guided Review");
  await waitFor(`Boolean(document.querySelector('[aria-label="Guided Review Wizard"]'))`, "Guided Review");
  await clickButtonByText(client, "Prepare next batch");
  await waitFor(`Boolean(document.querySelector('[data-testid="agent-exchange-proposal-action"]'))`, "Guided Review agent action");
  await configureConnector({ holdAvailability: false, mode: "unavailable" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("failed");
  assert.equal(countPromptPacks(projectPaths[8]), 1);
  assert.equal(readReviewBatches(projectPaths[8])[0].source, "guided_review");
  evidence.guided = {
    promptPacks: countPromptPacks(projectPaths[8]),
    source: readReviewBatches(projectPaths[8])[0].source
  };
  await clickButtonByText(client, "Close Guided Review");
  await openComments();
  await waitForPhase("failed");
  await setViewport(390, 844);
  await client.call("Emulation.setEmulatedMedia", {
    features: [
      { name: "forced-colors", value: "active" },
      { name: "prefers-reduced-motion", value: "reduce" }
    ]
  });
  const narrow = await evaluate(client, {
    expression: `(() => {
      const surface = document.querySelector('[data-testid="agent-exchange-actions"]');
      const rect = surface?.getBoundingClientRect();
      const button = Array.from(surface?.querySelectorAll('button') ?? []).find((item) => item.textContent?.trim() === 'Use manual export instead');
      return {
        forcedColors: matchMedia('(forced-colors: active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        surfaceWithinViewport: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth),
        buttonWithinViewport: Boolean(button && button.getBoundingClientRect().right <= innerWidth),
        buttonName: button?.textContent?.trim(),
        liveRegion: surface?.querySelector('[role="status"][aria-live="polite"]')?.textContent?.trim()
      };
    })()`
  });
  assert.deepEqual(narrow, {
    forcedColors: true,
    reducedMotion: true,
    horizontalOverflow: false,
    surfaceWithinViewport: true,
    buttonWithinViewport: true,
    buttonName: "Use manual export instead",
    liveRegion: "Patchmark Connector isn’t runningLaunch Patchmark Connector, then try again or use the exact manual export."
  });
  await setViewport(720, 844);
  const zoomEquivalent = await evaluate(client, {
    expression: `({ horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, actionVisible: Boolean(document.querySelector('[data-testid="agent-exchange-actions"] button')) })`
  });
  assert.deepEqual(zoomEquivalent, { actionVisible: true, horizontalOverflow: false });
  evidence.accessibility = {
    accessibleNames: ["Send to agent", "Cancel", "Use manual export instead", "Review replies and suggestions"],
    focusAndKeyboard: true,
    liveRegion: true
  };
  evidence.responsive = { narrow, zoomEquivalent };

  await client.call("Emulation.setEmulatedMedia", { features: [] });
  await setViewport(1440, 1000);
  await openNextProject("Reload");
  await openComments();
  await waitForSendAction();
  await configureConnector({ holdAvailability: false, mode: "delayed" });
  await clickButtonByText(client, "Send to agent");
  await waitForPhase("waiting");
  assert.equal(countPromptPacks(projectPaths[9]), 1);
  await client.call("Page.reload");
  await waitForEditorShell(client);
  await delay(150);
  assert.equal((await connectorEvidence()).submissions.length, 0);
  assert.equal(await visibleAgentDomCount(), 0);
  assert.equal(readComments(projectPaths[9])[0].thread.length, 0);
  assert.equal(readReviewBatches(projectPaths[9])[0].status, "exported");
  evidence.reload = {
    inFlightNotResumed: true,
    persistedManualBatchRetained: true,
    responseImported: false
  };

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(networkFailures, []);
  process.stdout.write(`${JSON.stringify({
    ...evidence,
    consoleErrors,
    exceptions,
    networkFailures,
    status: "ok"
  }, null, 2)}\n`);
} finally {
  await client?.close().catch(() => {});
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000).catch(() => chrome.kill("SIGKILL"));
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function createScenarioProject(name, sequence) {
  const relativePath = `Project ${String(sequence).padStart(2, "0")} ${name}`;
  const projectRoot = join(fixtureRoot, relativePath);
  cpSync(sourceFixture, projectRoot, { recursive: true });
  const projectId = `prj_agent_exchange_slice2_${String(sequence).padStart(2, "0")}`;
  const projectFile = join(projectRoot, ".patchmark", "project.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.project_id = projectId;
  project.title = `Agent Exchange ${name}`;
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  for (const documentId of ["doc_operations", "doc_evidence", "doc_summary"]) {
    const manifestPath = join(projectRoot, ".patchmark", "documents", documentId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.project_id = projectId;
    manifest.project_name = project.title;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const commentsPath = join(projectRoot, ".patchmark", "documents", "doc_operations", "comments.json");
  writeFileSync(commentsPath, `${JSON.stringify([createComment()], null, 2)}\n`);
  return relativePath;
}

function createComment() {
  return {
    id: commentId,
    type: "note",
    status: "open",
    anchor: { kind: "document" },
    comment: "Improve the two operation phrases independently.",
    thread: [],
    export_state: { focus_state: "in_focus" },
    created_at: "2040-02-01T00:00:00.000Z",
    updated_at: "2040-02-01T00:00:00.000Z"
  };
}

function createQualificationDriverShim() {
  return `(() => {
    const encoder = new TextEncoder();
    const control = {
      mode: 'delayed',
      holdAvailability: false,
      availabilityResolvers: [],
      submissionResolvers: [],
      evidence: { availabilityChecks: 0, submissions: [], closes: 0, aborts: 0, connectorCreations: 0, operationIds: 0 },
      configure(next) {
        this.mode = next.mode;
        this.holdAvailability = Boolean(next.holdAvailability);
        this.availabilityResolvers.length = 0;
        this.submissionResolvers.length = 0;
        this.evidence = { availabilityChecks: 0, submissions: [], closes: 0, aborts: 0, connectorCreations: 0, operationIds: 0 };
      },
      releaseAvailability() {
        for (const resolve of this.availabilityResolvers.splice(0)) resolve({ status: 'available' });
      },
      completeNext() {
        const pending = this.submissionResolvers.shift();
        if (pending) pending.resolve(makeConnectorResponse(pending.binding, this.mode));
      }
    };
    function makeConnectorResponse(binding, mode) {
      const response = mode === 'malformed'
        ? encoder.encode('{"invalid":')
        : encoder.encode(JSON.stringify({
            protocol: 'patchmark.comment_reply_import',
            protocol_version: 2,
            review_batch_id: binding.review_batch_id,
            project_id: binding.project_id,
            document_id: binding.document_id,
            summary: 'Deterministic Agent Exchange qualification response.',
            replies: [{
              comment_id: ${JSON.stringify(commentId)},
              reply: 'The two requested improvements are proposed separately.',
              reply_sources: [],
              suggested_user_action: 'review'
            }],
            patch_proposals: [
              {
                patch_key: 'careful-calibration', depends_on: [], comment_id: ${JSON.stringify(commentId)},
                original_text: ${JSON.stringify(firstOriginal)}, suggested_text: ${JSON.stringify(firstSuggested)},
                suggested_text_sources: [], reason: 'Clarifies the care taken during calibration.', reason_sources: [],
                risk: 'Minimal wording change.', risk_sources: []
              },
              {
                patch_key: 'every-rehearsal', depends_on: [], comment_id: ${JSON.stringify(commentId)},
                original_text: ${JSON.stringify(secondOriginal)}, suggested_text: ${JSON.stringify(secondSuggested)},
                suggested_text_sources: [], reason: 'Uses more direct frequency wording.', reason_sources: [],
                risk: 'Minimal wording change.', risk_sources: []
              }
            ],
            open_questions: []
          }));
      return {
        binding: {
          ...binding,
          response_byte_length: response.byteLength,
          response_protocol: 'patchmark.comment_reply_import',
          response_protocol_version: 2
        },
        response_bytes: response
      };
    }
    let sequence = 0;
    globalThis.__patchmarkAgentExchangeControl = control;
    globalThis.__patchmarkAgentExchangeProductQualificationDriver = {
      createOperationId: () => {
        control.evidence.operationIds += 1;
        return 'agent_exchange_product_' + String(++sequence).padStart(4, '0');
      },
      createConnector() {
        control.evidence.connectorCreations += 1;
        return {
          descriptor: { id: 'qualification.deterministic', version: 'ae1.slice2' },
          async checkAvailability({ signal }) {
            control.evidence.availabilityChecks += 1;
            signal.addEventListener('abort', () => { control.evidence.aborts += 1; }, { once: true });
            if (control.mode === 'availability_throw') throw new Error('qualification interruption');
            if (control.mode === 'unavailable') return { status: 'unavailable', reason: 'connector_not_ready' };
            if (!control.holdAvailability) return { status: 'available' };
            return await new Promise((resolve) => control.availabilityResolvers.push(resolve));
          },
          async submit({ binding, request_bytes, signal }) {
            control.evidence.submissions.push({ binding: structuredClone(binding), requestBytes: Array.from(request_bytes) });
            if (control.mode === 'submit_throw') throw new Error('qualification interruption');
            if (control.mode === 'immediate') return makeConnectorResponse(binding, control.mode);
            return await new Promise((resolve, reject) => {
              control.submissionResolvers.push({ binding, resolve, reject });
              signal.addEventListener('abort', () => undefined, { once: true });
            });
          },
          close() { control.evidence.closes += 1; }
        };
      }
    };
  })();`;
}

async function openNextProject(expectedName) {
  const hasProject = await evaluate(client, { expression: `document.body.textContent?.includes('Project:')` });
  if (hasProject) {
    await clickButtonByText(client, "File");
    await waitFor(`Boolean(document.querySelector('[role="menu"]:not([hidden])'))`, "File menu");
  }
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    `document.querySelector('[aria-label="Workspace status"]')?.textContent?.includes(${JSON.stringify(`Agent Exchange ${expectedName}`)}) && document.querySelector('.application-comments-count')?.textContent?.trim() === '1'`,
    `project ${expectedName}`
  );
}

async function openComments() {
  const open = await evaluate(client, { expression: `document.querySelector('.application-comments-trigger')?.getAttribute('aria-expanded') === 'true'` });
  if (!open) {
    await evaluate(client, { expression: `document.querySelector('.application-comments-trigger')?.click(); true`, userGesture: true });
  }
  await waitFor(`!document.querySelector('#document-comments-panel')?.hidden`, "Comments open");
}

async function closeComments() {
  await evaluate(client, {
    expression: `(() => { const button = document.querySelector('#document-comments-panel .comments-panel-close'); if (!(button instanceof HTMLButtonElement)) throw new Error('Comments close missing'); button.click(); return true; })()`,
    userGesture: true
  });
  await waitFor(`document.querySelector('#document-comments-panel')?.hidden === true`, "Comments closed");
}

async function waitForSendAction() {
  await waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Send to agent' && !button.disabled)`, "Send to agent action");
}

async function configureConnector(configuration) {
  await evaluate(client, { expression: `window.__patchmarkAgentExchangeControl.configure(${JSON.stringify(configuration)}); true` });
}

async function activateSendTwiceInOneTask() {
  await evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Send to agent' && !item.disabled); if (!(button instanceof HTMLButtonElement)) throw new Error('Send missing'); button.click(); button.click(); return true; })()`,
    userGesture: true
  });
}

async function keyboardActivateSend() {
  await keyboardActivateButton("Send to agent");
}

async function keyboardActivateButton(text) {
  await evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled); if (!(button instanceof HTMLButtonElement)) throw new Error('Button missing: ${text}'); button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click(); return true; })()`,
    userGesture: true
  });
}

async function waitForPhase(phase) {
  await waitFor(`document.querySelector('[data-testid="agent-exchange-actions"]')?.getAttribute('data-agent-exchange-phase') === ${JSON.stringify(phase)}`, `Agent Exchange phase ${phase}`);
}

async function currentPhase() {
  return evaluate(client, { expression: `document.querySelector('[data-testid="agent-exchange-actions"]')?.getAttribute('data-agent-exchange-phase') ?? 'idle'` });
}

async function connectorEvidence() {
  return evaluate(client, { expression: `structuredClone(window.__patchmarkAgentExchangeControl.evidence)` });
}

async function agentText() {
  return evaluate(client, { expression: `document.querySelector('[data-testid="agent-exchange-actions"]')?.textContent ?? ''` });
}

async function agentDomCount() {
  return evaluate(client, { expression: `document.querySelectorAll('[data-testid="agent-exchange-actions"]').length` });
}

async function visibleAgentDomCount() {
  return evaluate(client, { expression: `Array.from(document.querySelectorAll('[data-testid="agent-exchange-actions"]')).filter((element) => element.getClientRects().length > 0).length` });
}

async function humanCollaborationDomCount() {
  return evaluate(client, { expression: `document.querySelectorAll('[data-testid*="collaboration-qualification"], [class*="collaboration-qualification"]').length` });
}

async function fallbackPromptText() {
  return evaluate(client, { expression: `document.querySelector('[aria-label="Generate ChatGPT prompt"] textarea')?.value ?? document.querySelector('[aria-label="Generate ChatGPT prompt"] pre')?.textContent ?? ''` });
}

async function openPatchReview() {
  await clickButtonByText(client, "Review");
  await waitFor(`Boolean(document.querySelector('[role="menu"]:not([hidden])'))`, "Review menu");
  await clickButtonByText(client, "Review patch proposals");
  await waitFor(`Boolean(document.querySelector('[data-testid="patch-review-workspace"]'))`, "patch review workspace");
}

async function selectPatchRow(index) {
  await evaluate(client, {
    expression: `(() => { const rows = document.querySelectorAll('.patch-review-queue-row'); const button = rows[${index}]?.querySelector('button'); if (!(button instanceof HTMLButtonElement)) throw new Error('Patch row missing'); button.click(); return true; })()`,
    userGesture: true
  });
}

async function clickProjectDocument(title) {
  await evaluate(client, {
    expression: `(() => { const button = Array.from(document.querySelectorAll('.project-document-select')).find((item) => item.querySelector('span')?.textContent?.trim() === ${JSON.stringify(title)}); if (!(button instanceof HTMLButtonElement)) throw new Error('Document button missing'); button.click(); return true; })()`,
    userGesture: true
  });
}

async function waitForWorkspaceDocument(title) {
  let latest;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    latest = await evaluate(client, {
      expression: `(() => ({
        workspace: document.querySelector('[aria-label="Workspace status"]')?.textContent ?? '',
        feedback: document.querySelector('.document-save-banner')?.textContent ?? '',
        active: document.querySelector('.project-document-item[data-active="true"]')?.textContent ?? '',
        requested: document.querySelector('.project-document-item[data-requested="true"]')?.textContent ?? ''
      }))()`
    });
    if (latest.workspace.includes(`Document: ${title}`)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for document ${title}: ${JSON.stringify(latest)}`);
}

async function waitForFile(projectPath, text) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (readMarkdown(projectPath).includes(text)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for persisted text: ${text}`);
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

async function setViewport(width, height) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: width <= 480,
    width
  });
}

function countPromptPacks(projectPath) {
  const directory = join(fixtureRoot, projectPath, ".patchmark", "documents", "doc_operations", "context-packs");
  try {
    return readdirSync(directory).filter((name) => name.endsWith("-prompt.md") && !name.endsWith("-document-snapshot.md")).length;
  } catch {
    return 0;
  }
}

function readOnlyPromptPack(projectPath) {
  const directory = join(fixtureRoot, projectPath, ".patchmark", "documents", "doc_operations", "context-packs");
  const file = readdirSync(directory).find((name) => name.endsWith("-prompt.md") && !name.endsWith("-document-snapshot.md"));
  assert.ok(file, "expected one exact prompt pack");
  return readFileSync(join(directory, file), "utf8");
}

function readComments(projectPath) {
  return readJson(projectPath, "comments.json");
}

function readPatches(projectPath) {
  return readJson(projectPath, "patches.json");
}

function readReviewBatches(projectPath) {
  return readJson(projectPath, "review-batches.json");
}

function readJson(projectPath, fileName) {
  return JSON.parse(readFileSync(join(fixtureRoot, projectPath, ".patchmark", "documents", "doc_operations", fileName), "utf8"));
}

function readMarkdown(projectPath) {
  return readFileSync(join(fixtureRoot, projectPath, "operations.md"), "utf8");
}

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
const evidenceDir = process.env.PATCHMARK_PROJECT_RESUME_EVIDENCE_DIR;
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-resume-browser-"));
const projectDir = join(fixtureRoot, "Strategy");
createProjectFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for project resume browser tests.");
}
if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-resume-chrome-"));
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
  await setViewport(client, { height: 1000, width: 1440 });
  client.on("Page.javascriptDialogOpening", () => {
    void client.call("Page.handleJavaScriptDialog", { accept: true });
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: "Strategy"
    })
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      localStorage.setItem(
        "patchmark:draft:document.md",
        JSON.stringify({
          fileName: "document.md",
          markdown: "# Legacy filename-only recovery\\n",
          updatedAt: "2026-07-21T03:39:00.000Z"
        })
      );
    })();`
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  progress("landing_ready");

  assert.equal(await hasButton(client, "Restore draft"), false);
  assert.equal(await hasButton(client, "Discard draft"), false);
  await waitFor(
    client,
    `document.querySelector(".legacy-recovery-panel")?.textContent?.includes("Legacy unscoped recovery data")`,
    "legacy recovery quarantine"
  );

  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Strategy")`,
    "Strategy project open"
  );
  progress("project_opened");
  const projectBeforeUnsavedEdit = fingerprintTree(projectDir);
  await clickButtonByText(client, "Markdown Mode");
  const safeRecoveryMarker = `SAFE_RECOVERY_${Date.now()}`;
  await appendMarkdown(client, safeRecoveryMarker);
  await waitForRecoveryCount(client, 1);
  progress("safe_recovery_captured");
  assert.deepEqual(fingerprintTree(projectDir), projectBeforeUnsavedEdit);

  await reloadToLanding(client);
  progress("reloaded_to_resume");
  await waitFor(
    client,
    `document.querySelector(".project-resume-banner")?.textContent?.includes("Resume Strategy")`,
    "project-aware resume banner"
  );
  assert.equal(await hasButton(client, "Restore draft"), false);
  assert.equal(await hasButton(client, "Discard draft"), false);
  assert.match(
    await textContent(client, ".project-resume-banner"),
    /Unsaved changes may be available in 1 document/
  );
  await confirmAndClick(client, "Reopen Strategy folder");
  await waitFor(
    client,
    `document.querySelector(".document-recovery-banner-recovered")?.textContent?.includes("Unsaved changes recovered")`,
    "safe document recovery"
  );
  await waitFor(
    client,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Strategy") && document.querySelector(".application-document-breadcrumb")?.textContent?.includes("Action Plan")`,
    "resumed project context"
  );
  assert.equal(
    await textContent(client, ".document-context-status"),
    "",
    "Routine project resume must not add a persistent success banner."
  );
  const compactResumeLayout = await verifyCompactResumeLayout(client);
  if (evidenceDir) {
    writeFileSync(
      join(evidenceDir, "measurements.json"),
      `${JSON.stringify(compactResumeLayout, null, 2)}\n`
    );
  }
  progress("safe_recovery_loaded");
  await waitFor(
    client,
    `document.querySelector(".markdown-source-editor")?.value.includes(${JSON.stringify(safeRecoveryMarker)})`,
    "recovered dirty Markdown"
  );
  assert.deepEqual(fingerprintTree(projectDir), projectBeforeUnsavedEdit);

  await clickButtonByText(client, "Save Changes");
  await waitForRecoveryCount(client, 0);
  progress("safe_recovery_saved");
  await waitFor(
    client,
    `!document.querySelector(".document-recovery-banner")`,
    "recovery cleared after save"
  );
  assert.match(readFileSync(join(projectDir, "action-plan.md"), "utf8"), new RegExp(safeRecoveryMarker));

  const savedMarkdown = readFileSync(join(projectDir, "action-plan.md"), "utf8");
  await seedRecovery(client, {
    documentId: "doc_action",
    documentTitle: "Action Plan",
    markdown: savedMarkdown,
    baseMarkdown: savedMarkdown
  });
  await reloadAndResume(client);
  await waitForRecoveryCount(client, 0);
  progress("already_saved_cleared");
  assert.equal(await hasSelector(client, ".document-recovery-banner"), false);

  const conflictRecoveryMarker = `CONFLICT_RECOVERY_${Date.now()}`;
  await appendMarkdown(client, conflictRecoveryMarker);
  await waitForRecoveryCount(client, 1);
  progress("conflict_recovery_captured");
  const conflictRecoveredMarkdown = await evaluate(client, {
    expression: `document.querySelector(".markdown-source-editor")?.value ?? ""`
  });
  const independentSavedMarker = `INDEPENDENT_SAVED_${Date.now()}`;
  const independentlyChangedMarkdown = `${savedMarkdown}\n${independentSavedMarker}\n`;
  await replaceMarkdown(client, independentlyChangedMarkdown);
  await clickButtonByText(client, "Save Changes");
  await waitForRecoveryCount(client, 0);
  await waitFor(
    client,
    `document.querySelector(".document-status")?.textContent?.trim() === "Saved" && !document.querySelector(".document-save-banner-success")`,
    "independent project save"
  );
  await seedRecovery(client, {
    documentId: "doc_action",
    documentTitle: "Action Plan",
    markdown: conflictRecoveredMarkdown,
    baseMarkdown: savedMarkdown
  });
  const projectBeforeConflictDecision = fingerprintTree(projectDir);

  await reloadAndResume(client);
  await waitFor(
    client,
    `document.querySelector(".document-recovery-banner-conflict")?.textContent?.includes("saved document has also changed") || document.querySelector(".document-recovery-banner-conflict")?.textContent?.includes("conflict")`,
    "conflict-aware recovery"
  );
  progress("conflict_loaded");
  await ensureMarkdownMode(client);
  const conflictEditorMarkdown = await evaluate(client, {
    expression: `document.querySelector(".markdown-source-editor")?.value ?? ""`
  });
  assert.equal(
    conflictEditorMarkdown.includes(independentSavedMarker),
    true,
    `The saved Markdown must remain the initial working copy during conflict review. Current editor: ${JSON.stringify(conflictEditorMarkdown)}`
  );
  assert.equal(conflictEditorMarkdown.includes(conflictRecoveryMarker), false);
  await clickButtonByText(client, "Review versions");
  await waitFor(
    client,
    `document.querySelectorAll(".document-recovery-comparison pre").length === 2`,
    "saved and recovered comparison"
  );
  const comparisons = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".document-recovery-comparison pre")).map((element) => element.textContent)`
  });
  assert.match(comparisons[0], new RegExp(independentSavedMarker));
  assert.match(comparisons[1], new RegExp(conflictRecoveryMarker));
  await confirmAndClick(client, "Use recovered changes as working copy");
  await waitFor(
    client,
    `document.querySelector(".markdown-source-editor")?.value.includes(${JSON.stringify(conflictRecoveryMarker)})`,
    "recovered conflict working copy"
  );
  assert.deepEqual(fingerprintTree(projectDir), projectBeforeConflictDecision);
  await confirmAndClick(client, "Discard recovered changes");
  await waitForRecoveryCount(client, 0);
  progress("conflict_discarded");
  await waitFor(
    client,
    `document.querySelector(".markdown-source-editor")?.value.includes(${JSON.stringify(independentSavedMarker)})`,
    "saved Markdown restored after discard"
  );
  assert.deepEqual(fingerprintTree(projectDir), projectBeforeConflictDecision);

  const activeBase = readFileSync(join(projectDir, "action-plan.md"), "utf8");
  await seedRecovery(client, {
    documentId: "doc_action",
    documentTitle: "Action Plan",
    markdown: `${activeBase}\nMULTI_ACTIVE_RECOVERY\n`,
    baseMarkdown: activeBase
  });
  await seedRecovery(client, {
    documentId: "doc_summary",
    documentTitle: "Evidence Summary",
    markdown: "# Evidence Summary\n\nSummary body.\n\nMULTI_SUMMARY_RECOVERY\n",
    baseMarkdown: "# Evidence Summary\n\nSummary body.\n"
  });
  await reloadToLanding(client);
  progress("multiple_recoveries_seeded");
  await waitFor(
    client,
    `document.querySelector(".project-resume-banner")?.textContent?.includes("2 documents")`,
    "multiple recovery summary"
  );
  await confirmAndClick(client, "Reopen Strategy folder");
  await waitFor(
    client,
    `Boolean(document.querySelector(".document-recovery-banner-recovered"))`,
    "active recovery from multiple records"
  );
  await confirmAndClick(client, "Discard recovered changes");
  await waitForRecoveryCount(client, 1);
  progress("multiple_recovery_independent_discard");
  assert.equal(
    await evaluate(client, {
      expression: `Array.from(document.querySelectorAll(".project-document-recovery")).some((element) => element.closest(".project-document-item")?.textContent?.includes("Evidence Summary"))`
    }),
    true
  );

  const projectBeforeStaleHandleResume = fingerprintTree(projectDir);
  assert.equal(
    JSON.parse(
      projectBeforeStaleHandleResume[
        ".patchmark/documents/doc_shareholders/comments.json"
      ]
    ).length,
    7
  );
  const validHandleInstanceId = "local_project_valid_handle_resume";
  await seedPersistedOpfsProjectHandle(client, {
    directoryName: "Strategy-valid-resume",
    files: projectBeforeStaleHandleResume,
    localInstanceId: validHandleInstanceId,
    removeAfterSeed: false
  });
  const shareholdersSavedMarkdown =
    projectBeforeStaleHandleResume["shareholders.md"];
  const shareholdersRecoveryMarker = "VALID_HANDLE_UNSAVED_RECOVERY";
  const shareholdersRecoveredMarkdown =
    `# SHAREHOLDERS AGREEMENT\n\n` +
    `Recovered working Markdown intentionally omits the persisted selected-text anchor.\n\n` +
    `${shareholdersRecoveryMarker}\n`;
  const validHandlePickerGuardId = await installProjectPickerFailureGuard(client);
  try {
    await reloadToLanding(client);
    await waitFor(
      client,
      `document.querySelector(".project-resume-banner")?.textContent?.includes("Resume Strategy") && document.querySelector(".project-resume-banner")?.textContent?.includes("SHAREHOLDERS AGREEMENT")`,
      "valid stored-handle Shareholders resume banner"
    );
    await clickButtonByText(client, "Resume Strategy");
    await assertValidHandleShareholdersProjection(client, {
      expectedFirstAnchorStatus: "active",
      expectedMarkdownText: "Shareholders fixture terms."
    });
    assert.deepEqual(await readProjectPickerGuardCalls(client), {
      directory: 0,
      file: 0
    });
    const validHandleIdentity = await readProjectInstanceIdentity(client, {
      localInstanceId: validHandleInstanceId
    });
    assert.deepEqual(validHandleIdentity, {
      documentId: "doc_shareholders",
      localInstanceId: validHandleInstanceId,
      projectId: "prj_resume_browser"
    });
    progress("valid_stored_handle_comments_loaded");

    await seedRecovery(client, {
      baseMarkdown: shareholdersSavedMarkdown,
      documentId: "doc_shareholders",
      documentTitle: "SHAREHOLDERS AGREEMENT",
      localInstanceId: validHandleInstanceId,
      markdown: shareholdersRecoveredMarkdown
    });
    await reloadToLanding(client);
    await waitFor(
      client,
      `document.querySelector(".project-resume-banner")?.textContent?.includes("Resume Strategy") && document.querySelector(".project-resume-banner")?.textContent?.includes("Unsaved changes may be available in 1 document")`,
      "valid stored-handle unsaved recovery resume banner"
    );
    await clickButtonByText(client, "Resume Strategy");
    await waitFor(
      client,
      `document.querySelector(".document-recovery-banner-recovered")?.textContent?.includes("Unsaved changes recovered")`,
      "valid stored-handle Shareholders recovery application"
    );
    await assertValidHandleShareholdersProjection(client, {
      expectedFirstAnchorStatus: "not_found",
      expectedMarkdownText: shareholdersRecoveryMarker,
      expectFirstAnchorRepair: true
    });
    assert.deepEqual(await readProjectPickerGuardCalls(client), {
      directory: 0,
      file: 0
    });
    assert.deepEqual(
      await readProjectInstanceIdentity(client, {
        localInstanceId: validHandleInstanceId
      }),
      validHandleIdentity
    );
    assert.deepEqual(fingerprintTree(projectDir), projectBeforeStaleHandleResume);
    progress("valid_stored_handle_unsaved_recovery_loaded");

    await reloadToLanding(client);
    await waitFor(
      client,
      `document.querySelector(".project-resume-banner")?.textContent?.includes("Resume Strategy") && document.querySelector(".project-resume-banner")?.textContent?.includes("Unsaved changes may be available in 1 document")`,
      "second valid stored-handle unsaved recovery resume banner"
    );
    await clickButtonByText(client, "Resume Strategy");
    await assertValidHandleShareholdersProjection(client, {
      expectedFirstAnchorStatus: "not_found",
      expectedMarkdownText: shareholdersRecoveryMarker,
      expectFirstAnchorRepair: true
    });
    assert.deepEqual(await readProjectPickerGuardCalls(client), {
      directory: 0,
      file: 0
    });
    assert.deepEqual(fingerprintTree(projectDir), projectBeforeStaleHandleResume);
    progress("valid_stored_handle_second_recovery_resume_loaded");
  } finally {
    await removeProjectPickerFailureGuard(client, validHandlePickerGuardId);
  }

  const staleHandleInstanceId = "local_project_stale_handle_resume";
  const recoveryCountBeforeStaleHandleResume =
    await readDeviceRecoveryCount(client);
  await seedPersistedOpfsProjectHandle(client, {
    directoryName: "Strategy-stale-resume",
    files: projectBeforeStaleHandleResume,
    localInstanceId: staleHandleInstanceId,
    removeAfterSeed: true
  });
  await reloadToLanding(client);
  await waitFor(
    client,
    `document.querySelector(".project-resume-banner")?.textContent?.includes("Resume Strategy") && document.querySelector(".project-resume-banner")?.textContent?.includes("SHAREHOLDERS AGREEMENT")`,
    "stored-handle Shareholders resume banner"
  );
  await makePersistedProjectHandleFailWithoutPermissionState(client, {
    localInstanceId: staleHandleInstanceId
  });
  await clickButtonByText(client, "Resume Strategy");
  await waitFor(
    client,
    `document.querySelector(".project-resume-banner [role='alert']")?.textContent?.includes("Select the existing Strategy folder") && Array.from(document.querySelectorAll(".project-resume-banner button")).some((button) => button.textContent?.trim() === "Reopen Strategy folder")`,
    "actionable stored-handle resume failure"
  );
  assert.equal(await hasSelector(client, ".empty-state"), true);
  assert.equal(await textContent(client, ".application-comments-trigger"), "Comments0");
  assert.equal(
    await readDeviceRecoveryCount(client),
    recoveryCountBeforeStaleHandleResume,
    "A failed stored-handle resume must preserve document recovery records."
  );
  await restoreProjectPickerAfterStaleHandleFailure(client);
  await confirmAndClick(client, "Reopen Strategy folder");
  await waitFor(
    client,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Strategy") && document.querySelector(".application-document-breadcrumb")?.textContent?.includes("SHAREHOLDERS AGREEMENT")`,
    "Shareholders project context after folder reauthorization"
  );
  await waitFor(
    client,
    `document.querySelectorAll(".project-document-item").length === 3 && document.querySelector(".application-comments-trigger")?.textContent?.replace(/\\s+/g, "") === "Comments6"`,
    "Shareholders navigation and comments after resume"
  );
  await clickButtonByText(client, "Markdown Mode");
  await waitFor(
    client,
    `document.querySelector(".markdown-source-editor")?.value.includes("Shareholders fixture terms") && document.querySelector(".document-tools")?.textContent?.includes("1 heading")`,
    "Shareholders Markdown and heading projection after resume"
  );
  const resumedIdentity = await readProjectInstanceIdentity(client, {
    localInstanceId: staleHandleInstanceId
  });
  assert.deepEqual(resumedIdentity, {
    documentId: "doc_shareholders",
    localInstanceId: staleHandleInstanceId,
    projectId: "prj_resume_browser"
  });
  assert.deepEqual(fingerprintTree(projectDir), projectBeforeStaleHandleResume);
  progress("stale_handle_failure_recovered_by_reselection");

  console.log(
    JSON.stringify(
      {
        noAmbiguousLandingBanner: true,
        legacyRecoveryQuarantined: true,
        projectAwareResume: true,
        localInstanceReselectionConfirmation: true,
        safeRecoveryDirtyBuffer: true,
        noAutomaticMarkdownWrite: true,
        successfulSaveCleanup: true,
        alreadySavedCleanup: true,
        conflictReview: true,
        recoveredConflictWorkingCopyNoWrite: true,
        explicitDiscardNoProjectWrites: true,
        multipleRecoveriesIndependent: true,
        validStoredHandleResume: true,
        validStoredHandleNoReselection: true,
        validStoredHandleIdentityPreserved: true,
        validStoredHandleSevenStoredComments: true,
        validStoredHandleSixActiveComments: true,
        validStoredHandleOneTrashedComment: true,
        validStoredHandleReplyPreserved: true,
        validStoredHandlePatchPreserved: true,
        validStoredHandleReviewBatchPreserved: true,
        validStoredHandleUnsavedRecoveryApplied: true,
        validStoredHandleRecoveryIdentityPreserved: true,
        validStoredHandleRecoveryBrokenAnchorRepairable: true,
        validStoredHandleSecondResume: true,
        staleStoredHandleFailureSurfaced: true,
        staleStoredHandleRecoveryPreserved: true,
        staleStoredHandleReselection: true,
        shareholdersResumeIdentityPreserved: true,
        shareholdersResumeNavigation: true,
        shareholdersResumeMarkdown: true,
        shareholdersResumeSevenStoredComments: true,
        shareholdersResumeSixActiveComments: true,
        compactResumeLayout
      },
      null,
      2
    )
  );
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome).catch(() => undefined);
  await fixtureServer.close().catch(() => fixtureServer.forceClose());
  try {
    rmSync(userDataDir, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    });
  } catch {}
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function reloadAndResume(pageClient) {
  await reloadToLanding(pageClient);
  await waitFor(
    pageClient,
    `Boolean(document.querySelector(".project-resume-banner"))`,
    "resume banner after reload"
  );
  await confirmAndClick(pageClient, "Reopen Strategy folder");
  await waitFor(
    pageClient,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Strategy")`,
    "resumed Strategy project"
  );
}

async function verifyCompactResumeLayout(pageClient) {
  const measurements = {};
  for (const [label, viewport] of [
    ["desktop", { height: 1000, width: 1440 }],
    ["narrow", { height: 900, width: 768 }],
    ["mobile", { height: 844, width: 393 }],
    ["compact", { height: 844, width: 320 }],
    ["zoomEquivalent", { height: 500, width: 720 }]
  ]) {
    await setViewport(pageClient, viewport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const measurement = await evaluate(pageClient, {
      expression: `(() => {
        const applicationBar = document.querySelector('.application-bar');
        const breadcrumb = document.querySelector('.application-document-breadcrumb');
        const documentStatus = document.querySelector('.document-status');
        const modeSwitch = document.querySelector('.mode-switcher');
        if (
          !(applicationBar instanceof HTMLElement) ||
          !(breadcrumb instanceof HTMLElement) ||
          !(documentStatus instanceof HTMLElement) ||
          !(modeSwitch instanceof HTMLElement)
        ) {
          throw new Error('Compact resume controls not found.');
        }
        const applicationBarRect = applicationBar.getBoundingClientRect();
        const breadcrumbRect = breadcrumb.getBoundingClientRect();
        const documentStatusRect = documentStatus.getBoundingClientRect();
        const modeSwitchRect = modeSwitch.getBoundingClientRect();
        return {
          applicationBarHeight: Math.round(applicationBarRect.height),
          breadcrumbText: breadcrumb.textContent?.trim() ?? '',
          breadcrumbTitle: breadcrumb.title,
          documentStatus: documentStatus.textContent?.trim() ?? '',
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          modeSwitchRightInset: Number((applicationBarRect.right - modeSwitchRect.right).toFixed(2)),
          noRoutineResumeStatus: !document.querySelector('.document-context-status'),
          rowsAligned:
            Math.abs(breadcrumbRect.top + breadcrumbRect.height / 2 - (documentStatusRect.top + documentStatusRect.height / 2)) <= 1,
          viewport: { height: innerHeight, width: innerWidth }
        };
      })()`
    });

    assert.equal(
      measurement.applicationBarHeight,
      label === "mobile" || label === "compact" ? 88 : 48
    );
    assert.equal(measurement.horizontalOverflow, false);
    assert.equal(measurement.noRoutineResumeStatus, true);
    assert.equal(measurement.rowsAligned, true);
    assert.ok(measurement.modeSwitchRightInset >= 0, `${label} clipped the mode switch.`);
    assert.match(measurement.breadcrumbText, /Action Plan/);
    assert.match(measurement.breadcrumbTitle, /Strategy \/ Strategy Documents \/ Action Plan/);
    assert.match(measurement.documentStatus, /Saved|Unsaved|Restored/);

    measurements[label] = measurement;
    await captureScreenshot(pageClient, `${label}-compact-resume.png`);
  }
  await setViewport(pageClient, { height: 1000, width: 1440 });
  return measurements;
}

async function setViewport(pageClient, { height, width }) {
  await pageClient.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    screenHeight: height,
    screenWidth: width,
    width
  });
}

async function captureScreenshot(pageClient, fileName) {
  if (!evidenceDir) return;
  const result = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(evidenceDir, fileName), Buffer.from(result.data, "base64"));
}

async function reloadToLanding(pageClient) {
  await pageClient.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(pageClient);
}

async function appendMarkdown(pageClient, marker) {
  await ensureMarkdownMode(pageClient);
  await evaluate(pageClient, {
    expression: `(() => {
      const editor = document.querySelector(".markdown-source-editor");
      if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Markdown editor not found.");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, editor.value + "\\n" + ${JSON.stringify(marker)} + "\\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return editor.value;
    })()`
  });
}

async function replaceMarkdown(pageClient, markdown) {
  await ensureMarkdownMode(pageClient);
  await evaluate(pageClient, {
    expression: `(() => {
      const editor = document.querySelector(".markdown-source-editor");
      if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Markdown editor not found.");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, ${JSON.stringify(markdown)});
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return editor.value;
    })()`
  });
}

async function ensureMarkdownMode(pageClient) {
  if (await hasSelector(pageClient, ".markdown-source-editor")) {
    return;
  }
  await clickButtonByText(pageClient, "Markdown Mode");
  await waitFor(
    pageClient,
    `Boolean(document.querySelector(".markdown-source-editor"))`,
    "Markdown editor"
  );
}

async function seedRecovery(pageClient, {
  baseMarkdown,
  documentId,
  documentTitle,
  localInstanceId = null,
  markdown
}) {
  await evaluate(pageClient, {
    expression: `(async () => {
      const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const all = (store) => new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const database = await open();
      const readTransaction = database.transaction("project-instances", "readonly");
      const instances = await all(readTransaction.objectStore("project-instances"));
      const requestedLocalInstanceId = ${JSON.stringify(localInstanceId)};
      const instance = requestedLocalInstanceId
        ? instances.find((candidate) => candidate.local_instance_id === requestedLocalInstanceId)
        : instances.sort((left, right) => Date.parse(right.last_opened_at) - Date.parse(left.last_opened_at))[0];
      if (!instance) throw new Error("Project instance for recovery seed was not found.");
      const now = new Date().toISOString();
      const recoveryId = "project:" + encodeURIComponent(instance.local_instance_id) + ":" + encodeURIComponent(instance.project_id) + ":" + encodeURIComponent(${JSON.stringify(documentId)});
      const record = {
        schema_version: 1,
        owner_type: "project_document",
        recovery_id: recoveryId,
        local_instance_id: instance.local_instance_id,
        project_id: instance.project_id,
        document_id: ${JSON.stringify(documentId)},
        project_title_snapshot: "Strategy",
        document_title_snapshot: ${JSON.stringify(documentTitle)},
        group_title_snapshot: "Strategy Documents",
        base_content_sha256: await hash(${JSON.stringify(baseMarkdown)}),
        base_document_generation: 0,
        recovered_content_sha256: await hash(${JSON.stringify(markdown)}),
        markdown: ${JSON.stringify(markdown)},
        created_at: now,
        updated_at: now
      };
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("document-recoveries", "readwrite");
        transaction.objectStore("document-recoveries").put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return recoveryId;
    })()`,
    awaitPromise: true
  });
}

async function waitForRecoveryCount(pageClient, count) {
  await waitFor(
    pageClient,
    `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const values = await new Promise((resolve, reject) => {
        const request = database.transaction("document-recoveries", "readonly").objectStore("document-recoveries").getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      return values.length === ${count};
    })()`,
    `${count} recovery records`,
    true
  );
}

async function readDeviceRecoveryCount(pageClient) {
  return evaluate(pageClient, {
    expression: `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const values = await new Promise((resolve, reject) => {
        const request = database.transaction("document-recoveries", "readonly")
          .objectStore("document-recoveries")
          .getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      return values.length;
    })()`,
    awaitPromise: true
  });
}

async function seedPersistedOpfsProjectHandle(
  pageClient,
  { directoryName, files, localInstanceId, removeAfterSeed }
) {
  await evaluate(pageClient, {
    expression: `(async () => {
      const files = ${JSON.stringify(files)};
      const opfs = await navigator.storage.getDirectory();
      const directoryName = ${JSON.stringify(directoryName)};
      await opfs.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
      const project = await opfs.getDirectoryHandle(directoryName, { create: true });
      for (const [path, text] of Object.entries(files)) {
        const parts = path.split("/");
        const name = parts.pop();
        let directory = project;
        for (const part of parts) {
          directory = await directory.getDirectoryHandle(part, { create: true });
        }
        const file = await directory.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        await writable.write(text);
        await writable.close();
      }
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("project-instances", "readwrite");
        transaction.objectStore("project-instances").put({
          schema_version: 1,
          local_instance_id: ${JSON.stringify(localInstanceId)},
          project_id: "prj_resume_browser",
          project_title_snapshot: "Strategy",
          last_document_id: "doc_shareholders",
          last_document_title_snapshot: "SHAREHOLDERS AGREEMENT",
          last_group_id: "grp_strategy",
          last_opened_at: new Date().toISOString(),
          directory_handle: project
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      localStorage.setItem(
        "patchmark:active-document:prj_resume_browser",
        "doc_shareholders"
      );
      if (${JSON.stringify(removeAfterSeed)}) {
        await opfs.removeEntry(directoryName, { recursive: true });
      }
      return true;
    })()`,
    awaitPromise: true
  });
}

async function installProjectPickerFailureGuard(pageClient) {
  const { identifier } = await pageClient.call(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `(() => {
        window.__patchmarkValidHandleOriginalShowDirectoryPicker = window.showDirectoryPicker;
        window.__patchmarkValidHandleOriginalShowOpenFilePicker = window.showOpenFilePicker;
        window.__patchmarkValidHandlePickerCalls = 0;
        window.__patchmarkValidHandleFilePickerCalls = 0;
        window.showDirectoryPicker = async () => {
          window.__patchmarkValidHandlePickerCalls += 1;
          throw new Error("A valid stored-handle Resume must not open the folder picker.");
        };
        window.showOpenFilePicker = async () => {
          window.__patchmarkValidHandleFilePickerCalls += 1;
          throw new Error("Project recovery must not enter standalone Markdown loading.");
        };
      })();`
    }
  );
  return identifier;
}

async function readProjectPickerGuardCalls(pageClient) {
  return evaluate(pageClient, {
    expression: `({
      directory: window.__patchmarkValidHandlePickerCalls ?? 0,
      file: window.__patchmarkValidHandleFilePickerCalls ?? 0
    })`
  });
}

async function removeProjectPickerFailureGuard(pageClient, identifier) {
  await pageClient.call("Page.removeScriptToEvaluateOnNewDocument", {
    identifier
  });
  await evaluate(pageClient, {
    expression: `(() => {
      if (window.__patchmarkValidHandleOriginalShowDirectoryPicker) {
        window.showDirectoryPicker = window.__patchmarkValidHandleOriginalShowDirectoryPicker;
      }
      if (window.__patchmarkValidHandleOriginalShowOpenFilePicker) {
        window.showOpenFilePicker = window.__patchmarkValidHandleOriginalShowOpenFilePicker;
      }
      return true;
    })()`
  });
}

async function assertValidHandleShareholdersProjection(
  pageClient,
  {
    expectedFirstAnchorStatus,
    expectedMarkdownText,
    expectFirstAnchorRepair = false
  }
) {
  await waitFor(
    pageClient,
    `document.querySelector(".workspace-status")?.textContent?.includes("Project: Strategy") && document.querySelector(".application-document-breadcrumb")?.textContent?.includes("SHAREHOLDERS AGREEMENT")`,
    "valid stored-handle Shareholders context"
  );
  await waitFor(
    pageClient,
    `document.querySelectorAll(".project-document-item").length === 3 && document.querySelector(".application-comments-trigger")?.textContent?.replace(/\\s+/g, "") === "Comments6"`,
    "valid stored-handle navigation and comments"
  );
  await clickButtonByText(pageClient, "Markdown Mode");
  await waitFor(
    pageClient,
    `document.querySelector(".markdown-source-editor")?.value.includes(${JSON.stringify(expectedMarkdownText)}) && document.querySelector(".document-tools")?.textContent?.includes("1 heading")`,
    "valid stored-handle Markdown and headings"
  );
  await evaluate(pageClient, {
    expression: `(() => {
      const trigger = document.querySelector(".application-comments-trigger");
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Comments trigger not found.");
      }
      if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      return true;
    })()`
  });
  await waitFor(
    pageClient,
    `document.querySelector(".comments-panel")?.textContent?.includes("Trash · 1")`,
    "valid stored-handle Trash projection"
  );
  if (expectFirstAnchorRepair) {
    await evaluate(pageClient, {
      expression: `document.querySelector("#patchmark-comment-card-PM-COMMENT-RESUME-0001")?.click(); true`
    });
    await waitFor(
      pageClient,
      `Array.from(document.querySelectorAll("#patchmark-comment-card-PM-COMMENT-RESUME-0001 button")).some((button) => button.textContent?.trim() === "Re-anchor")`,
      "recovery-invalidated comment repair control"
    );
  }
  const commentProjection = await evaluate(pageClient, {
    expression: `(() => {
      const activeComments = Array.from(document.querySelectorAll(".comment-list > li[data-comment-id]"));
      return {
        activeCount: activeComments.length,
        activeIds: activeComments.map((comment) => comment.getAttribute("data-comment-id")).sort(),
        anchorStatuses: Object.fromEntries(activeComments.map((comment) => [
          comment.getAttribute("data-comment-id"),
          comment.getAttribute("data-comment-anchor-status")
        ])),
        firstThreadCount: activeComments.find((comment) => comment.getAttribute("data-comment-id") === "PM-COMMENT-RESUME-0001")?.getAttribute("data-comment-thread-count"),
        firstPendingPatchCount: activeComments.find((comment) => comment.getAttribute("data-comment-id") === "PM-COMMENT-RESUME-0001")?.getAttribute("data-comment-pending-patch-count"),
        firstRepairable: Array.from(document.querySelectorAll("#patchmark-comment-card-PM-COMMENT-RESUME-0001 button")).some((button) => button.textContent?.trim() === "Re-anchor"),
        trashCount: document.querySelectorAll(".comment-trash-list > li").length,
        trashIds: Array.from(document.querySelectorAll(".comment-trash-list strong")).map((element) => element.textContent?.trim())
      };
    })()`
  });
  assert.deepEqual(commentProjection, {
    activeCount: 6,
    activeIds: [
      "PM-COMMENT-RESUME-0001",
      "PM-COMMENT-RESUME-0002",
      "PM-COMMENT-RESUME-0003",
      "PM-COMMENT-RESUME-0004",
      "PM-COMMENT-RESUME-0005",
      "PM-COMMENT-RESUME-0006"
    ],
    anchorStatuses: {
      "PM-COMMENT-RESUME-0001": expectedFirstAnchorStatus,
      "PM-COMMENT-RESUME-0002": "document",
      "PM-COMMENT-RESUME-0003": "document",
      "PM-COMMENT-RESUME-0004": "document",
      "PM-COMMENT-RESUME-0005": "document",
      "PM-COMMENT-RESUME-0006": "document"
    },
    firstThreadCount: "1",
    firstPendingPatchCount: "1",
    firstRepairable: expectFirstAnchorRepair,
    trashCount: 1,
    trashIds: ["PM-COMMENT-RESUME-0007"]
  });

  await evaluate(pageClient, {
    expression: `(() => {
      const review = document.querySelector('[aria-label="Review menu"]');
      if (!(review instanceof HTMLButtonElement)) throw new Error("Review menu not found.");
      review.click();
      return true;
    })()`
  });
  await waitFor(
    pageClient,
    `Boolean(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Review patch proposals"))`,
    "Review patch proposals menu item"
  );
  await evaluate(pageClient, {
    expression: `(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => candidate.textContent?.trim() === "Review patch proposals");
      if (!(item instanceof HTMLElement)) throw new Error("Review patch proposals item not found.");
      item.click();
      return true;
    })()`
  });
  await waitFor(
    pageClient,
    `document.querySelector(".patch-review-batch-switcher")?.textContent?.includes("Manual Review")`,
    "valid stored-handle Review Batch projection"
  );
  assert.match(
    await textContent(pageClient, ".patch-review-workspace"),
    /1 patch(?:es)? awaiting a decision/
  );
}

async function makePersistedProjectHandleFailWithoutPermissionState(
  pageClient,
  { localInstanceId }
) {
  await evaluate(pageClient, {
    expression: `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction("project-instances", "readonly")
          .objectStore("project-instances")
          .get(${JSON.stringify(localInstanceId)});
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      const prototype = Object.getPrototypeOf(record.directory_handle);
      window.__patchmarkResumeOriginalQueryPermission = prototype.queryPermission;
      window.__patchmarkResumeOriginalShowDirectoryPicker = window.showDirectoryPicker;
      Object.defineProperty(prototype, "queryPermission", {
        configurable: true,
        value: async () => {
          throw new Error("Injected unavailable permission state.");
        }
      });
      window.showDirectoryPicker = async () => {
        throw new DOMException("Injected picker cancellation.", "AbortError");
      };
      return true;
    })()`,
    awaitPromise: true
  });
}

async function restoreProjectPickerAfterStaleHandleFailure(pageClient) {
  await evaluate(pageClient, {
    expression: `(() => {
      window.showDirectoryPicker = window.__patchmarkResumeOriginalShowDirectoryPicker;
      return true;
    })()`
  });
}

async function readProjectInstanceIdentity(pageClient, { localInstanceId }) {
  return evaluate(pageClient, {
    expression: `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("patchmark-device-state", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction("project-instances", "readonly")
          .objectStore("project-instances")
          .get(${JSON.stringify(localInstanceId)});
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      return {
        documentId: record.last_document_id,
        localInstanceId: record.local_instance_id,
        projectId: record.project_id
      };
    })()`,
    awaitPromise: true
  });
}

async function confirmAndClick(pageClient, label) {
  await evaluate(pageClient, {
    expression: `(() => {
      window.confirm = () => true;
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: " + ${JSON.stringify(label)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function hasButton(pageClient, label) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === ${JSON.stringify(label)})`
  });
}

async function hasSelector(pageClient, selector) {
  return evaluate(pageClient, {
    expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  });
}

async function textContent(pageClient, selector) {
  return evaluate(pageClient, {
    expression: `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`
  });
}

async function waitFor(pageClient, expression, label, awaitPromise = false) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (
      await evaluate(pageClient, {
        expression,
        ...(awaitPromise ? { awaitPromise: true } : {})
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function fingerprintTree(root) {
  const result = {};
  visit(root);
  return result;

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        result[relative(root, path)] = readFileSync(path, "utf8");
      }
    }
  }
}

function createProjectFixture(root) {
  const metadata = join(root, ".patchmark");
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const now = "2026-07-21T00:00:00.000Z";
  const groupId = "grp_strategy";
  const documents = [
    createDocumentFixture({
      displayTitle: "Action Plan",
      documentId: "doc_action",
      groupId,
      markdown: "# Action Plan\n\nDecision body.\n",
      now,
      path: "action-plan.md",
      position: 1000,
      role: "decision",
      root
    }),
    createDocumentFixture({
      displayTitle: "Evidence Summary",
      documentId: "doc_summary",
      groupId,
      markdown: "# Evidence Summary\n\nSummary body.\n",
      now,
      path: "evidence-summary.md",
      position: 2000,
      role: "summary",
      root
    }),
    createDocumentFixture({
      comments: createShareholdersComments(now),
      displayTitle: "SHAREHOLDERS AGREEMENT",
      documentId: "doc_shareholders",
      groupId,
      markdown: "# SHAREHOLDERS AGREEMENT\n\nShareholders fixture terms.\n",
      now,
      patches: createShareholdersPatches(now),
      path: "shareholders.md",
      position: 3000,
      reviewBatches: createShareholdersReviewBatches(now),
      role: null,
      root
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    `${JSON.stringify(
      {
        format: "patchmark-project",
        schema_version: 2,
        project_id: "prj_resume_browser",
        title: "Strategy",
        created_at: now,
        manifest_revision: 1,
        groups: [
          {
            group_id: groupId,
            title: "Strategy Documents",
            position: 1000,
            created_at: now
          }
        ],
        documents
      },
      null,
      2
    )}\n`
  );
}

function progress(label) {
  process.stdout.write(`[project-resume-browser] ${label}\n`);
}

function createDocumentFixture({
  comments = [],
  displayTitle,
  documentId,
  groupId,
  markdown,
  now,
  patches = [],
  path: documentPath,
  position,
  reviewBatches = [],
  role,
  root
}) {
  writeFileSync(join(root, documentPath), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  mkdirSync(join(store, "versions"), { recursive: true });
  mkdirSync(join(store, "context-packs"), { recursive: true });
  mkdirSync(join(store, "imports"), { recursive: true });
  mkdirSync(join(store, "recovery"), { recursive: true });
  const committed = reviewBatches.length > 0;
  const commitId = `PM-SAVE-000002-${documentId}`;
  const manifestText = serializeJson({
    schema_version: 1,
    project_id: "prj_resume_browser",
    document_id: documentId,
    project_name: "Strategy",
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    ...(committed
      ? {
          save_generation: 2,
          save_commit_id: commitId
        }
      : {}),
    ...(documentId === "doc_summary"
      ? {
          reading_bookmark: {
            format_version: 1,
            document: {
              project_id: "prj_resume_browser",
              document_id: documentId
            },
            anchor: {
              kind: "selected_text",
              selected_text: "Summary body.",
              markdown_start_offset: markdown.indexOf("Summary body."),
              markdown_end_offset:
                markdown.indexOf("Summary body.") + "Summary body.".length,
              anchor_source: "markdown"
            },
            created_at: now,
            updated_at: now
          }
        }
      : {})
  });
  const commentsText = serializeJson(comments);
  const patchesText = serializeJson(patches);
  const reviewBatchesText = serializeJson(reviewBatches);
  writeFileSync(join(store, "manifest.json"), manifestText);
  writeFileSync(join(store, "comments.json"), commentsText);
  writeFileSync(join(store, "patches.json"), patchesText);
  writeFileSync(join(store, "tasks.json"), "[]\n");
  if (committed) {
    writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
    writeFileSync(
      join(store, "save-commit.json"),
      serializeJson({
        format_version: 1,
        generation: 2,
        commit_id: commitId,
        created_at: now,
        files: {
          document: descriptor("document.md", markdown),
          comments: descriptor(".patchmark/comments.json", commentsText),
          patches: descriptor(".patchmark/patches.json", patchesText),
          review_batches: descriptor(
            ".patchmark/review-batches.json",
            reviewBatchesText
          ),
          manifest: descriptor(".patchmark/manifest.json", manifestText)
        }
      })
    );
  }
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
    group_id: groupId,
    role,
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function createShareholdersComments(now) {
  return Array.from({ length: 7 }, (_, index) => ({
    id: `PM-COMMENT-RESUME-${String(index + 1).padStart(4, "0")}`,
    type: "note",
    status: "open",
    anchor:
      index === 0
        ? {
            kind: "selected_text",
            selected_text: "Shareholders fixture terms.",
            markdown_start_offset: 26,
            markdown_end_offset: 53,
            anchor_source: "markdown"
          }
        : { kind: "document" },
    comment: `Shareholders resume comment ${index + 1}.`,
    thread:
      index === 0
        ? [
            {
              id: "PM-THREAD-RESUME-0001",
              role: "chatgpt",
              content: "Persisted Shareholders reply.",
              created_at: now
            }
          ]
        : [],
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now,
    ...(index === 6
      ? {
          trashed_at: now,
          trash_operation_id: "comment_trash_resume_fixture"
        }
      : {})
  }));
}

function createShareholdersPatches(now) {
  return [
    {
      id: "PM-PATCH-RESUME-0001",
      status: "pending",
      comment_id: "PM-COMMENT-RESUME-0001",
      original_text: "Shareholders fixture terms.",
      suggested_text: "Shareholders fixture terms remain available.",
      reason: "Exercise persisted patch projection during Resume.",
      created_at: now
    }
  ];
}

function createShareholdersReviewBatches(now) {
  return [
    {
      schema_version: 1,
      batch_id: "review_batch_valid_handle_resume",
      project_id: "prj_resume_browser",
      document_id: "doc_shareholders",
      source: "manual",
      batch_type: "manual",
      ordered_comment_ids: ["PM-COMMENT-RESUME-0001"],
      section: null,
      algorithm_version: null,
      prompt_builder_version: 1,
      document_generation: 1,
      batch_record_generation: 2,
      document_content_sha256: "a".repeat(64),
      comment_fingerprints: [
        {
          comment_id: "PM-COMMENT-RESUME-0001",
          fingerprint: "b".repeat(64)
        }
      ],
      estimated_prompt_tokens: 100,
      over_limit_warning: false,
      prompt_sha256: "c".repeat(64),
      context_pack: {
        relative_path:
          ".patchmark/context-packs/review_batch_valid_handle_resume-prompt.md",
        content_sha256: "d".repeat(64),
        bytes: 100
      },
      document_title_snapshot: "SHAREHOLDERS AGREEMENT",
      status: "exported",
      created_at: now,
      exported_at: now,
      response_received_at: null,
      cancelled_at: null,
      cancel_reason: null,
      import_id: null
    }
  ];
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function descriptor(path, text) {
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

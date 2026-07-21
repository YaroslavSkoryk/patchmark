import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-resume-browser-"));
const projectDir = join(fixtureRoot, "Strategy");
createProjectFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for project resume browser tests.");
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
    `document.querySelector(".document-save-banner-success")?.textContent?.includes("Saved project changes")`,
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
        multipleRecoveriesIndependent: true
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
      const instance = instances.sort((left, right) => Date.parse(right.last_opened_at) - Date.parse(left.last_opened_at))[0];
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
  displayTitle,
  documentId,
  groupId,
  markdown,
  now,
  path: documentPath,
  position,
  role,
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
        project_id: "prj_resume_browser",
        document_id: documentId,
        project_name: "Strategy",
        document_file: "document.md",
        created_at: now,
        updated_at: now,
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
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(store, "comments.json"), "[]\n");
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
    group_id: groupId,
    role,
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

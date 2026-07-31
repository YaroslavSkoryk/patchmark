import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const editorUrl =
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const projectId = "prj_comment_trash_browser";
const mainDocumentId = "doc_cleanup";
const secondDocumentId = "doc_second";
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-comment-trash-browser-"));
const projectDir = join(fixtureRoot, "Comment Trash Fixture");
const mainStore = join(
  projectDir,
  ".patchmark",
  "documents",
  mainDocumentId
);
const secondStore = join(
  projectDir,
  ".patchmark",
  "documents",
  secondDocumentId
);

createFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for comment Trash browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-comment-trash-chrome-"));
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
      projectName: basename(projectDir)
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
  await waitForCommentCount(client, 4);
  await waitForText(client, "4 of 4 active", "active comment count");
  await waitForText(client, "Trash · 1", "initial Trash count");
  await clearFixtureWriteLog(client);

  const initialFingerprint = fingerprintDirectory(projectDir);
  const initialMainComments = readJson(join(mainStore, "comments.json"));
  const immutableBefore = readImmutableFixtureState();

  assert.equal(
    await getFocusStateText(client, "PM-COMMENT-0001"),
    "Marked for ChatGPT"
  );
  await clickButtonByText(client, "Select comments");
  await waitForSelectionMode(client, 4);
  assert.equal(await getSelectedCount(client), 0);
  assert.equal(await isButtonDisabled(client, "Move to Trash"), true);
  assert.equal(
    await getFocusStateText(client, "PM-COMMENT-0001"),
    "Marked for ChatGPT"
  );

  await clickCommentSelection(client, "PM-COMMENT-0003");
  assert.equal(await getSelectedCount(client), 1);
  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Cannot move these comments to Trash");
  assert.equal(await hasButton(client, "Open active Review Batch"), true);
  assert.equal(await hasEnabledTrashConfirm(client), false);
  await clickDialogButton(client, "Cancel");
  await waitForNoTrashDialog(client);
  assert.equal(await getSelectedCount(client), 1);
  await clickButtonByText(client, "Clear selection");

  await clickButtonByText(client, "Exit selection mode");
  await activateComment(client, "PM-COMMENT-0001");
  await clickCommentButton(client, "PM-COMMENT-0001", "Reply");
  await setReplyDraft(client, "Unsaved reply must survive blocked Trash.");
  await clickButtonByText(client, "Select comments");
  await clickCommentSelection(client, "PM-COMMENT-0001");
  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Cannot move these comments to Trash");
  assert.match(
    await getTrashDialogText(client),
    /No draft was discarded/
  );
  await clickDialogButton(client, "Cancel");
  await clickButtonByText(client, "Exit selection mode");
  assert.equal(
    await getReplyDraft(client, "PM-COMMENT-0001"),
    "Unsaved reply must survive blocked Trash."
  );
  await clickCommentFormButton(
    client,
    "PM-COMMENT-0001",
    ".comment-reply-form",
    "Cancel"
  );

  await clickButtonByText(client, "Select comments");
  await clickCommentSelection(client, "PM-COMMENT-0001");
  await clickCommentSelection(client, "PM-COMMENT-0002");
  assert.equal(await getSelectedCount(client), 2);
  await setActiveFilter(client, "resolved");
  assert.equal(await getSelectedCount(client), 0);
  assert.match(await getSelectionNotice(client), /filter changed/);
  await clickButtonByText(client, "Select all visible");
  assert.deepEqual(await getSelectedCommentIds(client), ["PM-COMMENT-0002"]);
  await clickButtonByText(client, "Clear selection");
  await setActiveFilter(client, "all");
  await setCommentSearch(client, "historical");
  await clickButtonByText(client, "Select all visible");
  assert.deepEqual(await getSelectedCommentIds(client), ["PM-COMMENT-0004"]);
  await setCommentSearch(client, "");
  assert.equal(await getSelectedCount(client), 0);
  assert.match(await getSelectionNotice(client), /search changed/);

  await clickCommentSelection(client, "PM-COMMENT-0001");
  await clickCommentSelection(client, "PM-COMMENT-0002");
  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Move 2 comments to Trash?");
  assert.deepEqual(await readTrashSummary(client), {
    "Accepted patches": 1,
    "Blocked comments": 0,
    "Linked to Review Batches": 1,
    "Pending patches": 1,
    "Rejected patches": 1,
    Replies: 3,
    "Selected comments": 2,
    "Unresolved anchors": 0
  });
  assert.match(
    await getTrashDialogText(client),
    /Changes already applied to the Markdown will remain\./
  );
  assert.equal(await getActiveElementText(client), "Cancel");
  await dispatchKey(client, "Tab", { shift: true });
  assert.equal(await getActiveElementText(client), "Move 2 comments to Trash");
  await dispatchKey(client, "Tab");
  assert.equal(await getActiveElementText(client), "Cancel");
  await dispatchKey(client, "Escape");
  await waitForNoTrashDialog(client);
  await waitForActiveElementText(client, "Move to Trash");
  assert.equal(await getActiveElementText(client), "Move to Trash");
  assert.equal(await getSelectedCount(client), 2);
  assert.equal(await getFixtureWriteCount(client), 0);
  assert.equal(
    fingerprintDirectory(projectDir),
    initialFingerprint,
    "Selection, blockers, summaries, and cancellation must not write files."
  );

  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 820,
    mobile: false,
    width: 390
  });
  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Move 2 comments to Trash?");
  const responsiveDialog = await readResponsiveDialog(client);
  assert.equal(responsiveDialog.actionsDirection, "column");
  assert.equal(responsiveDialog.dialogVisible, true);
  assert.equal(responsiveDialog.viewportWidth, 390);
  await dispatchKey(client, "Escape");
  await waitForNoTrashDialog(client);
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1000,
    mobile: false,
    width: 1500
  });

  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Move 2 comments to Trash?");
  await clickDialogButton(client, "Move 2 comments to Trash");
  await waitForText(client, "2 of 2 active", "post-Trash active count");
  await waitForText(client, "Trash · 3", "post-Trash count");
  await waitForCommentCount(client, 2);
  await waitForFixtureWritesToSettle(client);

  const movedComments = readJson(join(mainStore, "comments.json"));
  const movedById = new Map(movedComments.map((comment) => [comment.id, comment]));
  const firstMoved = movedById.get("PM-COMMENT-0001");
  const secondMoved = movedById.get("PM-COMMENT-0002");
  assert.ok(firstMoved.trashed_at);
  assert.equal(firstMoved.trashed_at, secondMoved.trashed_at);
  assert.equal(firstMoved.trash_operation_id, secondMoved.trash_operation_id);
  assert.match(firstMoved.trash_operation_id, /^comment_trash_/);
  assert.equal(firstMoved.status, "open");
  assert.equal(secondMoved.status, "resolved");
  assert.deepEqual(firstMoved.thread, initialMainComments[0].thread);
  assert.equal(firstMoved.updated_at, initialMainComments[0].updated_at);
  assert.equal(secondMoved.resolved_at, initialMainComments[1].resolved_at);
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector('[data-comment-id="PM-COMMENT-0001"], [data-comment-id="PM-COMMENT-0002"]'))`
    }),
    false,
    "Trashed comments must leave the active rail and card list."
  );
  assert.deepEqual(readImmutableFixtureState(), immutableBefore);
  assert.deepEqual(
    readJson(join(secondStore, "comments.json")),
    immutableBefore.secondComments
  );
  assert.equal(
    readJson(join(mainStore, "manifest.json")).reading_bookmark.anchor.selected_text,
    immutableBefore.readingBookmark.anchor.selected_text
  );

  await openTrashSection(client);
  assert.deepEqual(await getTrashCommentIds(client), [
    "PM-COMMENT-0001",
    "PM-COMMENT-0002",
    "PM-COMMENT-0005"
  ]);
  assert.match(
    await getTrashCardText(client, "PM-COMMENT-0002"),
    /Originally resolved/
  );
  assert.match(
    await getTrashCardText(client, "PM-COMMENT-0001"),
    /Replies\s*2/
  );
  assert.match(
    await getTrashCardText(client, "PM-COMMENT-0001"),
    /Patches\s*2/
  );

  await clickTrashCardButton(client, "PM-COMMENT-0001", "Restore");
  await waitForText(client, "3 of 3 active", "single restore active count");
  await waitForText(client, "Trash · 2", "single restore Trash count");
  await waitForCommentCount(client, 3);
  const restoredFirst = readJson(join(mainStore, "comments.json")).find(
    (comment) => comment.id === "PM-COMMENT-0001"
  );
  assert.equal(restoredFirst.id, initialMainComments[0].id);
  assert.equal(restoredFirst.status, initialMainComments[0].status);
  assert.deepEqual(restoredFirst.thread, initialMainComments[0].thread);
  assert.equal(restoredFirst.trashed_at, undefined);
  assert.equal(restoredFirst.trash_operation_id, undefined);
  assert.ok(restoredFirst.restored_at);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector('[data-comment-id="PM-COMMENT-0001"]')?.getAttribute("data-comment-anchor-status")`
    }),
    "active"
  );

  await openTrashSection(client);
  await clickTrashSelection(client, "PM-COMMENT-0002");
  await clickTrashSelection(client, "PM-COMMENT-0005");
  await clickButtonByText(client, "Restore selected · 2");
  await waitForText(client, "5 of 5 active", "bulk restore active count");
  await waitForText(client, "Trash · 0", "empty Trash count");
  await waitForActiveCardCount(client, 5);
  const fullyRestoredComments = readJson(join(mainStore, "comments.json"));
  const restoredById = new Map(
    fullyRestoredComments.map((comment) => [comment.id, comment])
  );
  assert.equal(restoredById.get("PM-COMMENT-0002").status, "resolved");
  assert.equal(restoredById.get("PM-COMMENT-0002").anchor.kind, "document");
  assert.equal(restoredById.get("PM-COMMENT-0005").status, "open");
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector("#patchmark-comment-card-PM-COMMENT-0005 .comment-anchor-status-not_found")?.textContent?.trim()`
    }),
    "Anchor not found"
  );
  await activateComment(client, "PM-COMMENT-0005");
  assert.equal(
    await hasCommentButton(client, "PM-COMMENT-0005", "Re-anchor"),
    true
  );
  assert.deepEqual(readImmutableFixtureState(), immutableBefore);

  await clickButtonByText(client, "Select comments");
  await clickCommentSelection(client, "PM-COMMENT-0001");
  await clickProjectDocument(client, "Second Document");
  await waitForText(client, "1 of 1 active", "second document active count");
  await waitForCommentCount(client, 1);
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector('[aria-label="Bulk comment actions"]'))`
    }),
    false
  );
  assert.deepEqual(
    readJson(join(secondStore, "comments.json")),
    immutableBefore.secondComments
  );
  await clickProjectDocument(client, "Cleanup Review");
  await waitForText(client, "5 of 5 active", "main document restored");
  assert.equal(
    await evaluate(client, {
      expression: `Boolean(document.querySelector('[aria-label="Bulk comment actions"]'))`
    }),
    false
  );

  assert.equal(
    await hasCommentButton(client, "PM-COMMENT-0001", "Delete forever"),
    false,
    "Active comments must not expose permanent deletion."
  );
  await clickButtonByText(client, "Select comments");
  await clickCommentSelection(client, "PM-COMMENT-0001");
  await clickCommentSelection(client, "PM-COMMENT-0002");
  await clickButtonByText(client, "Move to Trash");
  await waitForDialog(client, "Move 2 comments to Trash?");
  await clickDialogButton(client, "Move 2 comments to Trash");
  await waitForText(client, "Trash · 2", "permanent deletion fixture Trash");
  await openTrashSection(client);
  await clearFixtureWriteLog(client);
  const permanentCancellationFingerprint = fingerprintDirectory(projectDir);
  await clickTrashCardButton(client, "PM-COMMENT-0001", "Delete forever");
  await waitForPermanentDeletionDialog(client, "Delete this comment forever?");
  assert.match(
    await getPermanentDeletionDialogText(client),
    /Previously exported prompts, imported-response archives, downloaded files, and external backups may still contain copies/
  );
  assert.equal(await isPermanentDeletionConfirmDisabled(client), true);
  await setPermanentDeletionConfirmation(client, "delete");
  assert.equal(await isPermanentDeletionConfirmDisabled(client), true);
  assert.match(
    await getPermanentDeletionDialogText(client),
    /Confirmation phrase does not match/
  );
  await setPermanentDeletionConfirmation(client, "DELETE");
  assert.equal(await isPermanentDeletionConfirmDisabled(client), false);
  await dispatchKey(client, "Escape");
  await waitForNoPermanentDeletionDialog(client);
  assert.equal(await getFixtureWriteCount(client), 0);
  assert.equal(
    fingerprintDirectory(projectDir),
    permanentCancellationFingerprint,
    "Cancelling permanent deletion must produce zero authoritative writes."
  );

  await clickTrashCardButton(client, "PM-COMMENT-0001", "Delete forever");
  await waitForPermanentDeletionDialog(client, "Delete this comment forever?");
  await setPermanentDeletionConfirmation(client, " DELETE ");
  await clickPermanentDeletionDialogButton(client, "Delete forever");
  await waitForText(client, "Trash · 1", "individual permanent deletion");
  await waitForFixtureWritesToSettle(client);

  const afterIndividualDeleteComments = readJson(
    join(mainStore, "comments.json")
  );
  const afterIndividualDeletePatches = readJson(join(mainStore, "patches.json"));
  const afterIndividualDeleteManifest = readJson(
    join(mainStore, "manifest.json")
  );
  assert.equal(
    afterIndividualDeleteComments.some(
      (comment) => comment.id === "PM-COMMENT-0001"
    ),
    false
  );
  assert.equal(
    afterIndividualDeletePatches.some(
      (patch) => patch.comment_id === "PM-COMMENT-0001"
    ),
    false
  );
  assert.deepEqual(
    afterIndividualDeleteManifest.comment_deletion_tombstones[0].patches,
    [
      { patch_id: "PM-PATCH-0001", status: "pending" },
      { patch_id: "PM-PATCH-0002", status: "accepted" }
    ]
  );
  const persistedTombstoneText = JSON.stringify(
    afterIndividualDeleteManifest.comment_deletion_tombstones[0]
  );
  assert.doesNotMatch(persistedTombstoneText, /Review alpha evidence/);
  assert.doesNotMatch(persistedTombstoneText, /Alpha evidence draft/);
  assert.equal(
    readFileSync(join(projectDir, "cleanup.md"), "utf8"),
    immutableBefore.mainMarkdown
  );
  assert.deepEqual(
    readJson(join(mainStore, "review-batches.json")),
    immutableBefore.reviewBatches
  );
  assert.equal(
    fingerprintDirectory(join(mainStore, "versions")),
    immutableBefore.versions
  );
  assert.deepEqual(
    readJson(join(secondStore, "comments.json")),
    immutableBefore.secondComments
  );

  await clickButtonByText(client, "Empty Trash for Cleanup Review");
  await waitForPermanentDeletionDialog(
    client,
    "Permanently delete 1 comment from Cleanup Review?"
  );
  assert.equal(await isPermanentDeletionConfirmDisabled(client), true);
  await setPermanentDeletionConfirmation(client, "EMPTY TRASH");
  await clickPermanentDeletionDialogButton(
    client,
    "Empty Trash for Cleanup Review"
  );
  await waitForText(client, "Trash · 0", "Empty Trash completion");
  await waitForFixtureWritesToSettle(client);
  assert.equal(readJson(join(mainStore, "comments.json")).length, 3);
  assert.equal(
    readJson(join(mainStore, "manifest.json"))
      .comment_deletion_tombstones.length,
    2
  );
  assert.equal(
    readFileSync(join(projectDir, "cleanup.md"), "utf8"),
    immutableBefore.mainMarkdown
  );
  assert.deepEqual(
    readJson(join(secondStore, "comments.json")),
    immutableBefore.secondComments
  );

  await client.call("Page.reload");
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForText(client, "3 of 3 active", "restart active count");
  await waitForText(client, "Trash · 0", "restart empty Trash");
  assert.equal(
    await evaluate(client, {
      expression: `document.body.textContent?.includes("Review alpha evidence.")`
    }),
    false
  );

  console.log(
    JSON.stringify(
      {
        acceptedMarkdownPreserved: true,
        activeBatchBlockedAtomically: true,
        activeRailAndCardsExcludedTrash: true,
        bulkRestoreAtomicUiFlow: true,
        connectedHistoryPreserved: true,
        contentFreeTombstonesPersisted: true,
        deleteForeverConfirmationAndCancellation: true,
        documentScopedSwitchClearsSelection: true,
        duplicateLocalIdIsolated: true,
        emptyTrashDocumentScoped: true,
        filterAndSearchClearSelection: true,
        individualRestore: true,
        noActivePermanentDeleteControls: true,
        noWriteCancellationFingerprintStable: true,
        permanentDeletionSurvivesRestart: true,
        productionResponsiveAndKeyboardDialog: true,
        staleAnchorRestoredForReanchor: true,
        trashSortDeterministic: true,
        unsavedDraftBlockedAndPreserved: true,
        url: editorUrl
      },
      null,
      2
    )
  );
  console.log("Comment Trash browser tests passed.");
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 3000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function readImmutableFixtureState() {
  const mainManifest = readJson(join(mainStore, "manifest.json"));
  return {
    mainMarkdown: readFileSync(join(projectDir, "cleanup.md"), "utf8"),
    patches: readJson(join(mainStore, "patches.json")),
    projectManifest: readJson(join(projectDir, ".patchmark", "project.json")),
    readingBookmark: mainManifest.reading_bookmark,
    reviewBatches: readJson(join(mainStore, "review-batches.json")),
    secondComments: readJson(join(secondStore, "comments.json")),
    versions: fingerprintDirectory(join(mainStore, "versions"))
  };
}

async function waitFor(pageClient, expression, label) {
  let latest;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    latest = await evaluate(pageClient, {
      expression: `(() => {
        try {
          return {
            ready: Boolean(${expression}),
            error: null,
            alerts: Array.from(document.querySelectorAll('[role="alert"], .comments-error'))
              .map((element) => element.textContent?.trim())
              .filter(Boolean),
            dialogTitle: document.querySelector(".comment-trash-dialog h2")?.textContent?.trim() ?? null,
            activeCommentIds: Array.from(document.querySelectorAll(".comment-floating-item[data-comment-id]"))
              .map((element) => element.getAttribute("data-comment-id"))
          };
        } catch (error) {
          return { ready: false, error: String(error) };
        }
      })()`
    });
    if (latest.ready) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

async function waitForText(pageClient, text, label) {
  await waitFor(
    pageClient,
    `document.body.textContent?.includes(${JSON.stringify(text)})`,
    label
  );
}

async function waitForCommentCount(pageClient, count) {
  await waitFor(
    pageClient,
    `document.querySelectorAll(".comment-floating-item[data-comment-id]").length === ${count}`,
    `${count} active comments`
  );
}

async function waitForActiveCardCount(pageClient, count) {
  await waitFor(
    pageClient,
    `document.querySelectorAll('[id^="patchmark-comment-card-"]').length === ${count}`,
    `${count} active comment cards`
  );
}

async function waitForSelectionMode(pageClient, count) {
  await waitFor(
    pageClient,
    `document.querySelectorAll('input[aria-label^="Select comment "][aria-label$=" for Trash"]').length === ${count}`,
    "selection mode"
  );
}

async function waitForDialog(pageClient, title) {
  await waitFor(
    pageClient,
    `document.querySelector(".comment-trash-dialog h2")?.textContent?.trim() === ${JSON.stringify(title)}`,
    `Trash dialog ${title}`
  );
}

async function waitForNoTrashDialog(pageClient) {
  await waitFor(
    pageClient,
    `!document.querySelector(".comment-trash-dialog")`,
    "Trash dialog close"
  );
}

async function waitForPermanentDeletionDialog(pageClient, title) {
  await waitFor(
    pageClient,
    `document.querySelector(".comment-permanent-deletion-dialog h2")?.textContent?.trim() === ${JSON.stringify(title)}`,
    `permanent deletion dialog ${title}`
  );
}

async function waitForNoPermanentDeletionDialog(pageClient) {
  await waitFor(
    pageClient,
    `!document.querySelector(".comment-permanent-deletion-dialog")`,
    "permanent deletion dialog close"
  );
}

async function waitForFixtureWritesToSettle(pageClient) {
  await waitFor(
    pageClient,
    `(window.__patchmarkFixtureWriteStats?.activeWrites ?? 0) === 0`,
    "fixture writes to settle"
  );
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

async function clickCommentSelection(pageClient, commentId) {
  await clickBySelector(
    pageClient,
    `input[aria-label=${JSON.stringify(`Select comment ${commentId} for Trash`)}]`
  );
}

async function clickTrashSelection(pageClient, commentId) {
  await clickBySelector(
    pageClient,
    `input[aria-label=${JSON.stringify(`Select trashed comment ${commentId}`)}]`
  );
}

async function clickBySelector(pageClient, selector) {
  await evaluate(pageClient, {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement) || element.matches(":disabled")) {
        throw new Error("Interactive element not found: " + ${JSON.stringify(selector)});
      }
      element.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function getSelectedCount(pageClient) {
  return evaluate(pageClient, {
    expression: `Number(document.querySelector('[aria-label="Bulk comment actions"] strong')?.textContent?.match(/\\d+/)?.[0] ?? -1)`
  });
}

async function getSelectedCommentIds(pageClient) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll('input[aria-label^="Select comment "][aria-label$=" for Trash"]:checked')).map((input) => input.getAttribute("aria-label").replace(/^Select comment | for Trash$/g, "")).sort()`
  });
}

async function getSelectionNotice(pageClient) {
  return evaluate(pageClient, {
    expression: `document.querySelector(".comment-selection-notice")?.textContent?.trim() ?? ""`
  });
}

async function getFocusStateText(pageClient, commentId) {
  return evaluate(pageClient, {
    expression: `document.querySelector(${JSON.stringify(
      `[data-comment-id="${commentId}"] .comment-focus-state`
    )})?.textContent?.trim() ?? ""`
  });
}

async function isButtonDisabled(pageClient, text) {
  return evaluate(pageClient, {
    expression: `Boolean(Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === ${JSON.stringify(text)})?.disabled)`
  });
}

async function hasButton(pageClient, text) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === ${JSON.stringify(text)})`
  });
}

async function hasEnabledTrashConfirm(pageClient) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll(".comment-trash-dialog button")).some((button) => /^Move \\d+ comments? to Trash$/.test(button.textContent?.trim() ?? "") && !button.disabled)`
  });
}

async function getTrashDialogText(pageClient) {
  return evaluate(pageClient, {
    expression: `document.querySelector(".comment-trash-dialog")?.textContent ?? ""`
  });
}

async function getPermanentDeletionDialogText(pageClient) {
  return evaluate(pageClient, {
    expression: `document.querySelector(".comment-permanent-deletion-dialog")?.textContent ?? ""`
  });
}

async function isPermanentDeletionConfirmDisabled(pageClient) {
  return evaluate(pageClient, {
    expression: `Boolean(Array.from(document.querySelectorAll(".comment-permanent-deletion-dialog .destructive-action")).find((button) => button.textContent?.trim() !== "")?.disabled)`
  });
}

async function setPermanentDeletionConfirmation(pageClient, value) {
  await setFormControlValue(
    pageClient,
    `input[aria-label="Permanent deletion confirmation phrase"]`,
    value,
    "HTMLInputElement"
  );
}

async function clickPermanentDeletionDialogButton(pageClient, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".comment-permanent-deletion-dialog button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Permanent deletion dialog button not found: " + ${JSON.stringify(text)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickDialogButton(pageClient, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".comment-trash-dialog button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Trash dialog button not found: " + ${JSON.stringify(text)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function readTrashSummary(pageClient) {
  return evaluate(pageClient, {
    expression: `Object.fromEntries(Array.from(document.querySelectorAll(".comment-trash-summary > div")).map((item) => [
      item.querySelector("dt")?.textContent?.trim(),
      Number(item.querySelector("dd")?.textContent ?? 0)
    ]))`
  });
}

async function getActiveElementText(pageClient) {
  return evaluate(pageClient, {
    expression: `document.activeElement?.textContent?.trim() ?? ""`
  });
}

async function waitForActiveElementText(pageClient, text) {
  await waitFor(
    pageClient,
    `document.activeElement?.textContent?.trim() === ${JSON.stringify(text)}`,
    `focus to return to ${text}`
  );
}

async function dispatchKey(pageClient, key, { shift = false } = {}) {
  const code = key === "Escape" ? "Escape" : key;
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    modifiers: shift ? 8 : 0,
    type: "keyDown"
  });
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    modifiers: shift ? 8 : 0,
    type: "keyUp"
  });
}

async function readResponsiveDialog(pageClient) {
  return evaluate(pageClient, {
    expression: `(() => {
      const dialog = document.querySelector(".comment-trash-dialog");
      const actions = dialog?.querySelector(".dialog-actions");
      return {
        actionsDirection: actions ? getComputedStyle(actions).flexDirection : null,
        dialogVisible: Boolean(dialog && dialog.getBoundingClientRect().width > 0),
        viewportWidth: window.innerWidth
      };
    })()`
  });
}

async function setActiveFilter(pageClient, value) {
  await setFormControlValue(
    pageClient,
    `.comment-filter-bar select`,
    value,
    "HTMLSelectElement"
  );
}

async function setCommentSearch(pageClient, value) {
  await setFormControlValue(
    pageClient,
    `.comment-filter-bar input[type="search"]`,
    value,
    "HTMLInputElement"
  );
}

async function setFormControlValue(
  pageClient,
  selector,
  value,
  prototypeName
) {
  await evaluate(pageClient, {
    expression: `(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!control) throw new Error("Control not found: " + ${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window[${JSON.stringify(
        prototypeName
      )}].prototype, "value").set;
      setter.call(control, ${JSON.stringify(value)});
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    userGesture: true
  });
  await delay(50);
}

async function activateComment(pageClient, commentId) {
  await evaluate(pageClient, {
    expression: `(() => {
      const positionedCard = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"] article[aria-label]`
      )});
      const card = positionedCard ?? document.getElementById(
        ${JSON.stringify(`patchmark-comment-card-${commentId}`)}
      );
      if (!card) throw new Error("Comment card not found: " + ${JSON.stringify(commentId)});
      card.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    pageClient,
    `document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${commentId}`
    )})?.getAttribute("aria-current") === "true"`,
    `active comment ${commentId}`
  );
}

async function clickCommentButton(pageClient, commentId, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const card = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"]`
      )});
      const button = Array.from(card?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Comment button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function hasCommentButton(pageClient, commentId, text) {
  return evaluate(pageClient, {
    expression: `Array.from(document.getElementById(${JSON.stringify(
      `patchmark-comment-card-${commentId}`
    )})?.querySelectorAll("button") ?? []).some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`
  });
}

async function setReplyDraft(pageClient, value) {
  await setFormControlValue(
    pageClient,
    `[data-comment-reply-input]`,
    value,
    "HTMLTextAreaElement"
  );
}

async function getReplyDraft(pageClient, commentId) {
  return evaluate(pageClient, {
    expression: `document.querySelector(${JSON.stringify(
      `[data-comment-id="${commentId}"] [data-comment-reply-input]`
    )})?.value ?? ""`
  });
}

async function clickCommentFormButton(
  pageClient,
  commentId,
  formSelector,
  text
) {
  await evaluate(pageClient, {
    expression: `(() => {
      const form = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"] ${formSelector}`
      )});
      const button = Array.from(form?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Comment form button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function openTrashSection(pageClient) {
  const isOpen = await evaluate(pageClient, {
    expression: `Boolean(document.querySelector(".comment-trash-section")?.open)`
  });
  if (!isOpen) {
    await clickBySelector(pageClient, ".comment-trash-section > summary");
  }
}

async function getTrashCommentIds(pageClient) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll(".trashed-comment-card strong")).map((element) => element.textContent?.trim())`
  });
}

async function getTrashCardText(pageClient, commentId) {
  return evaluate(pageClient, {
    expression: `Array.from(document.querySelectorAll(".trashed-comment-card")).find((card) => card.querySelector("strong")?.textContent?.trim() === ${JSON.stringify(commentId)})?.textContent ?? ""`
  });
}

async function clickTrashCardButton(pageClient, commentId, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const card = Array.from(document.querySelectorAll(".trashed-comment-card"))
        .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === ${JSON.stringify(commentId)});
      const button = Array.from(card?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Trash card button not found.");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickProjectDocument(pageClient, title) {
  await evaluate(pageClient, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === ${JSON.stringify(title)} && !candidate.disabled);
      if (!button) throw new Error("Document button not found: " + ${JSON.stringify(title)});
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

function createFixture(root) {
  const metadata = join(root, ".patchmark");
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const now = "2026-07-31T04:00:00.000Z";
  const mainMarkdown = [
    "# Cleanup Review",
    "",
    "## Evidence",
    "",
    "Alpha evidence remains in the Markdown after an accepted patch.",
    "",
    "Beta evidence is complete.",
    "",
    "## Active Batch",
    "",
    "Gamma evidence is waiting for ChatGPT.",
    "",
    "## Historical Batch",
    "",
    "Delta historical response is complete.",
    ""
  ].join("\n");
  const secondMarkdown = [
    "# Second Document",
    "",
    "A duplicate local comment ID belongs only to this document.",
    ""
  ].join("\n");
  const comments = [
    createSelectedTextComment({
      comment: "Review alpha evidence.",
      focusState: "in_focus",
      id: "PM-COMMENT-0001",
      markdown: mainMarkdown,
      selectedText:
        "Alpha evidence remains in the Markdown after an accepted patch.",
      thread: [
        createReply("PM-REPLY-0001", "user", "Please preserve this thread."),
        createReply("PM-REPLY-0002", "chatgpt", "The evidence is preserved.")
      ],
      timestamp: "2026-07-01T00:00:01.000Z"
    }),
    {
      ...createBaseComment({
        comment: "Resolved document-level cleanup note.",
        id: "PM-COMMENT-0002",
        status: "resolved",
        thread: [
          createReply("PM-REPLY-0003", "user", "Keep the resolved state.")
        ],
        timestamp: "2026-07-01T00:00:02.000Z"
      }),
      anchor: { kind: "document" },
      resolved_at: "2026-07-02T00:00:00.000Z"
    },
    createSelectedTextComment({
      comment: "This comment belongs to the active exported batch.",
      id: "PM-COMMENT-0003",
      markdown: mainMarkdown,
      selectedText: "Gamma evidence is waiting for ChatGPT.",
      timestamp: "2026-07-01T00:00:03.000Z"
    }),
    {
      ...createBaseComment({
        comment: "Historical batch comment can move safely.",
        id: "PM-COMMENT-0004",
        timestamp: "2026-07-01T00:00:04.000Z"
      }),
      anchor: {
        kind: "section",
        heading: "Historical Batch",
        heading_level: 2,
        heading_line: 13
      }
    },
    {
      ...createBaseComment({
        comment: "Stale anchor should restore for human re-anchor.",
        id: "PM-COMMENT-0005",
        timestamp: "2026-07-01T00:00:05.000Z"
      }),
      anchor: {
        kind: "selected_text",
        selected_text: "Removed stale evidence.",
        markdown_start_offset: 900,
        markdown_end_offset: 923,
        context_before: "missing",
        context_after: "missing",
        anchor_source: "markdown"
      },
      trashed_at: "2026-07-30T04:00:00.000Z",
      trash_operation_id: "comment_trash_fixture"
    }
  ];
  const alphaStart = mainMarkdown.indexOf(
    "Alpha evidence remains in the Markdown after an accepted patch."
  );
  const patches = [
    {
      id: "PM-PATCH-0001",
      status: "pending",
      comment_id: "PM-COMMENT-0001",
      original_text: "Alpha evidence",
      suggested_text: "Alpha verified evidence",
      reason: "Pending alpha clarification.",
      created_at: now
    },
    {
      id: "PM-PATCH-0002",
      status: "accepted",
      comment_id: "PM-COMMENT-0001",
      original_text: "Alpha evidence draft.",
      suggested_text:
        "Alpha evidence remains in the Markdown after an accepted patch.",
      reason: "Applied alpha wording.",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-01T01:00:00.000Z",
      accepted_at: "2026-07-01T01:00:00.000Z",
      applied_at: "2026-07-01T01:00:00.000Z",
      applied_text:
        "Alpha evidence remains in the Markdown after an accepted patch.",
      applied_start_offset: alphaStart,
      applied_end_offset:
        alphaStart +
        "Alpha evidence remains in the Markdown after an accepted patch."
          .length
    },
    {
      id: "PM-PATCH-0003",
      status: "rejected",
      comment_id: "PM-COMMENT-0002",
      original_text: "Beta evidence",
      suggested_text: "Beta historical evidence",
      reason: "Rejected beta wording.",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-01T02:00:00.000Z",
      rejected_at: "2026-07-01T02:00:00.000Z"
    },
    {
      id: "PM-PATCH-0004",
      status: "pending",
      comment_id: "PM-COMMENT-0005",
      original_text: "Removed stale evidence.",
      suggested_text: "Restored stale evidence.",
      reason: "Preserved hidden pending proposal.",
      created_at: now
    }
  ];
  const reviewBatches = [
    createReviewBatch({
      batchId: "review_batch_active_comment_trash",
      commentId: "PM-COMMENT-0003",
      documentId: mainDocumentId,
      status: "exported"
    }),
    createReviewBatch({
      batchId: "review_batch_historical_comment_trash",
      commentId: "PM-COMMENT-0002",
      documentId: mainDocumentId,
      status: "cancelled"
    })
  ];
  const documents = [
    createDocumentFixture({
      comments,
      displayTitle: "Cleanup Review",
      documentId: mainDocumentId,
      markdown: mainMarkdown,
      now,
      patches,
      path: "cleanup.md",
      position: 1000,
      reviewBatches,
      root,
      withBookmark: true
    }),
    createDocumentFixture({
      comments: [
        createSelectedTextComment({
          comment: "Same local ID, different owning document.",
          id: "PM-COMMENT-0001",
          markdown: secondMarkdown,
          selectedText:
            "A duplicate local comment ID belongs only to this document.",
          timestamp: "2026-07-01T00:00:01.000Z"
        })
      ],
      displayTitle: "Second Document",
      documentId: secondDocumentId,
      markdown: secondMarkdown,
      now,
      patches: [],
      path: "second.md",
      position: 2000,
      reviewBatches: [],
      root,
      withBookmark: false
    })
  ];
  writeFileSync(
    join(metadata, "project.json"),
    serializeJson({
      format: "patchmark-project",
      schema_version: 1,
      project_id: projectId,
      title: "Comment Trash Fixture",
      created_at: now,
      manifest_revision: 1,
      documents
    })
  );
}

function createDocumentFixture({
  comments,
  displayTitle,
  documentId,
  markdown,
  now,
  patches,
  path,
  position,
  reviewBatches,
  root,
  withBookmark
}) {
  writeFileSync(join(root, path), markdown);
  const store = join(root, ".patchmark", "documents", documentId);
  for (const directory of [
    "context-packs",
    "imports",
    "recovery",
    "versions"
  ]) {
    mkdirSync(join(store, directory), { recursive: true });
  }
  const versionId = `PM-VERSION-000001-${documentId}`;
  const versionFile = `versions/${versionId}.md`;
  const commitId = `PM-SAVE-000007-${documentId}`;
  writeFileSync(join(store, versionFile), `${markdown}\nHistorical snapshot.\n`);
  const commentsText = serializeJson(comments);
  const patchesText = serializeJson(patches);
  const reviewBatchesText = serializeJson(reviewBatches);
  const reviewQueueOverridesText = serializeJson({
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    deferred_comments: []
  });
  const manifestText = serializeJson({
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: displayTitle,
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    current_version: versionId,
    versions: [
      {
        id: versionId,
        file: versionFile,
        created_at: now,
        reason: "fixture baseline"
      }
    ],
    save_generation: 7,
    save_commit_id: commitId,
    ...(withBookmark
      ? {
          reading_bookmark: {
            format_version: 1,
            document: {
              project_id: projectId,
              document_id: documentId
            },
            anchor: {
              kind: "selected_text",
              selected_text: "Beta evidence is complete.",
              markdown_start_offset: markdown.indexOf(
                "Beta evidence is complete."
              ),
              markdown_end_offset:
                markdown.indexOf("Beta evidence is complete.") +
                "Beta evidence is complete.".length,
              anchor_source: "markdown",
              action_context: {
                default_scope: "containing_section",
                include_document_brief: true,
                include_open_comments: "same_section",
                intent_hint: "note"
              }
            },
            created_at: now,
            updated_at: now
          }
        }
      : {})
  });
  writeFileSync(join(store, "comments.json"), commentsText);
  writeFileSync(join(store, "patches.json"), patchesText);
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "review-batches.json"), reviewBatchesText);
  writeFileSync(
    join(store, "review-queue-overrides.json"),
    reviewQueueOverridesText
  );
  writeFileSync(join(store, "manifest.json"), manifestText);
  writeFileSync(
    join(store, "document.json"),
    serializeJson({
      format: "patchmark-document-store",
      schema_version: 1,
      document_id: documentId,
      created_at: now,
      source: "created"
    })
  );
  writeFileSync(
    join(store, "save-commit.json"),
    serializeJson({
      format_version: 1,
      generation: 7,
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
        review_queue_overrides: descriptor(
          ".patchmark/review-queue-overrides.json",
          reviewQueueOverridesText
        ),
        manifest: descriptor(".patchmark/manifest.json", manifestText)
      }
    })
  );
  return {
    document_id: documentId,
    path,
    display_title: displayTitle,
    role: "research",
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function createBaseComment({
  comment,
  focusState = "idle",
  id,
  status = "open",
  thread = [],
  timestamp
}) {
  return {
    id,
    type: "note",
    status,
    comment,
    thread,
    export_state: { focus_state: focusState },
    created_at: timestamp,
    updated_at: timestamp
  };
}

function createSelectedTextComment({
  comment,
  focusState,
  id,
  markdown,
  selectedText,
  thread,
  timestamp
}) {
  const start = markdown.indexOf(selectedText);
  assert.notEqual(start, -1);
  return {
    ...createBaseComment({
      comment,
      focusState,
      id,
      thread,
      timestamp
    }),
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length,
      context_before: markdown.slice(Math.max(0, start - 80), start),
      context_after: markdown.slice(
        start + selectedText.length,
        start + selectedText.length + 80
      ),
      anchor_source: "markdown"
    }
  };
}

function createReply(id, role, content) {
  return {
    id,
    role,
    content,
    created_at: "2026-07-01T00:30:00.000Z"
  };
}

function createReviewBatch({ batchId, commentId, documentId, status }) {
  const now = "2026-07-01T03:00:00.000Z";
  const cancelled = status === "cancelled";
  return {
    schema_version: 1,
    batch_id: batchId,
    project_id: projectId,
    document_id: documentId,
    source: "guided_review",
    batch_type: "section",
    ordered_comment_ids: [commentId],
    section: {
      section_key_snapshot: "h2:1:fixture",
      heading_snapshot: "Fixture"
    },
    algorithm_version: 1,
    prompt_builder_version: 1,
    document_generation: 7,
    batch_record_generation: 8,
    document_content_sha256: "a".repeat(64),
    comment_fingerprints: [
      {
        comment_id: commentId,
        fingerprint: "b".repeat(64)
      }
    ],
    estimated_prompt_tokens: 100,
    over_limit_warning: false,
    prompt_sha256: "c".repeat(64),
    context_pack: {
      relative_path: `.patchmark/context-packs/${batchId}.md`,
      content_sha256: "d".repeat(64),
      bytes: 100
    },
    document_title_snapshot: "Cleanup Review",
    status,
    created_at: now,
    exported_at: now,
    response_received_at: null,
    cancelled_at: cancelled ? "2026-07-01T04:00:00.000Z" : null,
    cancel_reason: cancelled ? "user_cancelled" : null,
    import_id: null
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

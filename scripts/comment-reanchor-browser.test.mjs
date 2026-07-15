import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
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
  waitForProcessExit,
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/";
const sourceProjectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const artifactRoot =
  process.env.PATCHMARK_PHASE8_ARTIFACT_DIR ??
  join(tmpdir(), `patchmark-phase8-${Date.now()}`);
const fixtureDir = join(artifactRoot, "project-fixture");
const screenshotDir = join(artifactRoot, "screenshots");
const commentIds = {
  ambiguous: "PM-COMMENT-PHASE8-A",
  missing: "PM-COMMENT-PHASE8-B",
  link: "PM-COMMENT-PHASE8-C",
  multi: "PM-COMMENT-PHASE8-D",
  row: "PM-COMMENT-PHASE8-E"
};

if (!sourceProjectDir || !existsSync(join(sourceProjectDir, "document.md"))) {
  throw new Error(
    "Set PATCHMARK_REAL_PROJECT_DIR to a Patchmark project. The script copies it before validation."
  );
}

mkdirSync(artifactRoot, { recursive: true });
mkdirSync(screenshotDir, { recursive: true });
cpSync(sourceProjectDir, fixtureDir, { recursive: true });
preparePhase8Fixture(fixtureDir);

const patchesPath = join(fixtureDir, ".patchmark", "patches.json");
const commentsPath = join(fixtureDir, ".patchmark", "comments.json");
const patchesBefore = readFileSync(patchesPath);
const commentsBeforeCancelHash = sha256(readFileSync(commentsPath));
const inventory = inventoryProject(fixtureDir);
const fixtureServer = await startFixtureFileServer(fixtureDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = join(artifactRoot, "chrome-profile");
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
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
      projectName: basename(fixtureDir)
    })
  });
  await client.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 1100,
    mobile: false,
    width: 1700
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForPhase8Comments(client);
  await waitForVisualEditor(client);

  await activateComment(client, commentIds.ambiguous);
  await clickCommentButton(client, commentIds.ambiguous, "Re-anchor");
  await waitForSelector(client, ".reanchor-candidate-list");
  await capture(client, "02-suggested-candidate-list.png");
  await clickCandidateButton(client, 0, "Show in document");
  await waitForPreviewHighlight(client);
  await capture(client, "03-candidate-preview.png");
  await clickWithin(client, ".reanchor-mode-panel", "Cancel");
  await waitForSelectorToDisappear(client, ".reanchor-mode-panel");
  assert.equal(sha256(readFileSync(commentsPath)), commentsBeforeCancelHash);

  await activateComment(client, commentIds.ambiguous);
  await clickCommentButton(client, commentIds.ambiguous, "Re-anchor");
  await clickCandidateButton(client, 1, "Show in document");
  await clickCandidateButton(client, 1, "Use this location");
  await waitForSelector(client, ".reanchor-confirmation-dialog");
  await capture(client, "04-final-confirmation.png");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForSelectorToDisappear(client, ".reanchor-confirmation-dialog");
  await waitForPersistedAnchor(commentsPath, commentIds.ambiguous, "LINE add");
  await assertActiveCommentProjection(client, commentIds.ambiguous, "LINE add");
  await capture(client, "05-successfully-reanchored.png");

  const writesBeforeNoOp = await getFixtureWriteCount(client);
  await openHealthyChangeAnchor(client, commentIds.ambiguous);
  await clickCandidateButton(client, 0, "Use this location");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForText(client, "This comment is already anchored to that text.");
  assert.equal(await getFixtureWriteCount(client), writesBeforeNoOp);

  await activateComment(client, commentIds.missing);
  await capture(client, "01-missing-anchor-reanchor.png");
  await clickCommentButton(client, commentIds.missing, "Re-anchor");
  await clickButtonByText(client, "Markdown Mode");
  const replacementPhrase = "Current explanatory phrase for deleted evidence.";
  await selectMarkdownText(client, replacementPhrase);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForPersistedAnchor(commentsPath, commentIds.missing, replacementPhrase);

  await activateComment(client, commentIds.link);
  await clickCommentButton(client, commentIds.link, "Re-anchor");
  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  const linkLabel = "PAUL Thailand online delivery";
  await selectVisualLink(client, linkLabel);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  const fullLink = `[${linkLabel}](https://www.paulthailand.com/next-day-delivery)`;
  await waitForPersistedAnchor(commentsPath, commentIds.link, fullLink);
  await capture(client, "06-table-link-reanchor.png");

  await activateComment(client, commentIds.multi);
  await clickCommentButton(client, commentIds.multi, "Re-anchor");
  await clickButtonByText(client, "Markdown Mode");
  const multiBlock = await selectMarkdownSection(
    client,
    "### Early Cranberries & Walnut signal",
    "## Similar Rows"
  );
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  await waitForPersistedAnchor(commentsPath, commentIds.multi, multiBlock);
  await capture(client, "07-multi-block-reanchor.png");

  await clickButtonByText(client, "Visual Mode");
  await waitForVisualEditor(client);
  await activateComment(client, commentIds.multi);
  await assertActiveCommentProjection(client, commentIds.multi, multiBlock);
  await capture(client, "08-removed-from-unpositioned.png");

  await activateComment(client, commentIds.row);
  await clickCommentButton(client, commentIds.row, "Re-anchor");
  await clickButtonByText(client, "Markdown Mode");
  const selectedRow = "| Baguette | Shared signal |";
  await selectMarkdownText(client, selectedRow);
  await clickWithin(client, ".reanchor-mode-panel", "Use selection as new anchor");
  await clickWithin(client, ".reanchor-confirmation-dialog", "Confirm re-anchor");
  const persistedRowComment = await waitForPersistedAnchor(
    commentsPath,
    commentIds.row,
    selectedRow
  );
  assert.equal(persistedRowComment.anchor.anchor_context.table_row_index, 3);

  await activateComment(client, commentIds.missing);
  await clickCommentButton(client, commentIds.missing, "Mark for ChatGPT");
  await waitForEnabledButton(client, "body", "Generate ChatGPT Prompt");
  await clickButtonByText(client, "Generate ChatGPT Prompt");
  await waitForSelector(client, ".comment-export-dialog textarea");
  const exportContainsNewAnchor = await evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".comment-export-dialog textarea"))
      .some((element) => element.value.includes(${JSON.stringify(replacementPhrase)}))`
  });
  assert.equal(exportContainsNewAnchor, true);
  await clickWithin(client, ".comment-export-dialog", "Close");

  assert.deepEqual(readFileSync(patchesPath), patchesBefore);
  const finalComments = JSON.parse(readFileSync(commentsPath, "utf8"));
  const verifiedIds = [
    commentIds.ambiguous,
    commentIds.missing,
    commentIds.link,
    commentIds.multi,
    commentIds.row
  ];

  for (const commentId of verifiedIds) {
    const comment = finalComments.find((candidate) => candidate.id === commentId);
    assert.ok(comment, `Missing ${commentId}`);
    assert.equal(comment.thread.length, 1);
    assert.equal(
      comment.anchor_history.filter((entry) => entry.cause === "human_reanchor").length,
      1
    );
    assert.equal(comment.status, "open");
  }

  await client.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForPhase8Comments(client);
  await waitForVisualEditor(client);
  await activateComment(client, commentIds.ambiguous);
  await assertActiveCommentProjection(client, commentIds.ambiguous, "LINE add");

  console.log(
    JSON.stringify(
      {
        artifactRoot,
        fixtureDir,
        screenshots: screenshotFiles(),
        commentsReanchored: verifiedIds.length,
        cancelWrites: 0,
        noOpWrites: 0,
        patchBytesUnchanged: true,
        reloadStable: true,
        exportUsesNewAnchor: exportContainsNewAnchor
      },
      null,
      2
    )
  );
} finally {
  await client?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 1000);
  }
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
}

function preparePhase8Fixture(projectDir) {
  const metadataDir = join(projectDir, ".patchmark");
  const manifestPath = join(metadataDir, "manifest.json");
  const document = [
    "# Patchmark Phase 8 Fixture",
    "",
    "## Demand Generation Plan",
    "The first LINE add candidate belongs to demand generation.",
    "",
    "## Weekly Metrics",
    "The second LINE add candidate belongs to weekly reporting.",
    "",
    "## Replacement Evidence",
    "Current explanatory phrase for deleted evidence.",
    "",
    "## Public References",
    "| Brand | Delivery |",
    "| --- | --- |",
    "| PAUL | [PAUL Thailand online delivery](https://www.paulthailand.com/next-day-delivery) |",
    "",
    "## Product Evidence",
    "### Early Cranberries & Walnut signal",
    "",
    "- **Household retail:** current evidence",
    "- **Wholesale:** current evidence",
    "- **Interpretation:** current evidence",
    "",
    "## Similar Rows",
    "| Product | Signal |",
    "| --- | --- |",
    "| Original | Shared signal |",
    "| Baguette | Shared signal |"
  ].join("\n");
  const comments = [
    fixtureComment(commentIds.ambiguous, "LINE add", "Choose the relevant occurrence."),
    fixtureComment(commentIds.missing, "Deleted historical evidence", "Select replacement evidence."),
    fixtureComment(commentIds.link, "Old PAUL delivery text", "Select the current PAUL link."),
    fixtureComment(commentIds.multi, "Old product evidence", "Select current multi-block evidence."),
    fixtureComment(commentIds.row, "| Missing | Shared signal |", "Select the intended row.")
  ];
  const patches = [
    {
      id: "PM-PATCH-PHASE8",
      status: "pending",
      comment_id: commentIds.missing,
      original_text: "Deleted historical evidence",
      suggested_text: "Current explanatory phrase for deleted evidence.",
      reason: "Fixture patch integrity check.",
      created_at: "2026-07-15T00:00:00.000Z"
    }
  ];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.save_generation;
  delete manifest.save_commit_id;
  manifest.updated_at = "2026-07-15T00:00:00.000Z";

  writeFileSync(join(projectDir, "document.md"), document);
  writeFileSync(join(metadataDir, "comments.json"), `${JSON.stringify(comments, null, 2)}\n`);
  writeFileSync(join(metadataDir, "patches.json"), `${JSON.stringify(patches, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const fileName of [
    "save-commit.json",
    "document.md.lkg",
    "comments.json.lkg",
    "patches.json.lkg",
    "manifest.json.lkg",
    "save-commit.json.lkg"
  ]) {
    const filePath = join(metadataDir, fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

function fixtureComment(id, selectedText, comment) {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: 900000,
      markdown_end_offset: 900000 + selectedText.length,
      containing_heading: "Historical section",
      anchor_context: {
        kind: "paragraph",
        plain_text: selectedText,
        markdown_text: selectedText
      },
      action_context: {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: "note"
      }
    },
    comment,
    thread: [
      {
        id: `${id}-THREAD`,
        role: "user",
        content: "Preserve this complete thread.",
        created_at: "2026-07-15T00:00:00.000Z"
      }
    ],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

async function activateComment(pageClient, commentId) {
  await evaluate(pageClient, {
    expression: `(() => {
      const article = document.querySelector(${JSON.stringify(`#patchmark-comment-card-${commentId}`)});
      if (!article) throw new Error("Missing comment ${commentId}");
      article.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitForSelector(pageClient, `#patchmark-comment-card-${commentId}[aria-current="true"]`);
}

async function clickCommentButton(pageClient, commentId, text) {
  await clickWithin(pageClient, `#patchmark-comment-card-${commentId}`, text);
}

async function clickWithin(pageClient, selector, text) {
  await evaluate(pageClient, {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const button = Array.from(root?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled);
      if (!button) throw new Error("Missing enabled button ${text} in ${selector}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickCandidateButton(pageClient, index, text) {
  await clickWithin(pageClient, `.reanchor-candidate-card:nth-child(${index + 1})`, text);
}

async function openHealthyChangeAnchor(pageClient, commentId) {
  await activateComment(pageClient, commentId);
  await evaluate(pageClient, {
    expression: `(() => {
      const details = document.querySelector(${JSON.stringify(`#patchmark-comment-card-${commentId} .comment-secondary-actions`)});
      if (!details) throw new Error("Missing Change anchor menu");
      details.open = true;
      const button = Array.from(details.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "Change anchor");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitForSelector(pageClient, ".reanchor-mode-panel");
}

async function selectMarkdownText(pageClient, selectedText) {
  await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea missing");
      const start = textarea.value.indexOf(${JSON.stringify(selectedText)});
      if (start < 0) throw new Error("Selection text missing");
      textarea.focus();
      textarea.setSelectionRange(start, start + ${JSON.stringify(selectedText)}.length);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { start, end: start + ${JSON.stringify(selectedText)}.length };
    })()`,
    userGesture: true
  });
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
}

async function selectMarkdownSection(pageClient, startText, nextHeading) {
  const selectedText = await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea missing");
      const start = textarea.value.indexOf(${JSON.stringify(startText)});
      const next = textarea.value.indexOf(${JSON.stringify(nextHeading)}, start + 1);
      if (start < 0 || next < 0) throw new Error("Markdown section boundary missing");
      const end = textarea.value.slice(0, next).trimEnd().length;
      const selectedText = textarea.value.slice(start, end);
      textarea.focus();
      textarea.setSelectionRange(start, end);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selectedText;
    })()`,
    userGesture: true
  });
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
  return selectedText;
}

async function selectVisualLink(pageClient, label) {
  await evaluate(pageClient, {
    expression: `(() => {
      const link = Array.from(document.querySelectorAll(".patchmark-prose a"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!link) throw new Error("Visual link missing");
      const range = document.createRange();
      range.selectNodeContents(link);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      document.querySelector(".editor-body")
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    })()`,
    userGesture: true
  });
  await waitForEnabledButton(pageClient, ".reanchor-mode-panel", "Use selection as new anchor");
}

async function assertActiveCommentProjection(pageClient, commentId, expectedText) {
  await clickCommentButton(pageClient, commentId, "Find");
  await waitForSelector(pageClient, "textarea.markdown-source-editor");
  const sourceSelection = await evaluate(pageClient, {
    expression: `(() => {
      const textarea = document.querySelector("textarea.markdown-source-editor");
      return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    })()`
  });
  assert.equal(sourceSelection, expectedText);
  await clickButtonByText(pageClient, "Visual Mode");
  await waitForVisualEditor(pageClient);
  await waitForOpenHighlight(pageClient);
  const rail = await evaluate(pageClient, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(`[data-comment-id="${commentId}"]`)});
      return {
        floating: item?.classList.contains("comment-floating-item") ?? false,
        status: item?.getAttribute("data-comment-anchor-status") ?? null
      };
    })()`
  });
  assert.deepEqual(rail, { floating: true, status: "active" });
}

async function waitForPersistedAnchor(commentsPath, commentId, selectedText) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
    const comment = comments.find((candidate) => candidate.id === commentId);
    if (
      comment?.anchor?.selected_text === selectedText &&
      comment.anchor_history?.some((entry) => entry.cause === "human_reanchor")
    ) {
      return comment;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${commentId} persistence.`);
}

async function waitForVisualEditor(pageClient) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const ready = await evaluate(pageClient, {
      expression: `(document.querySelector(".patchmark-prose")?.textContent?.length ?? 0) > 100`
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error("Visual editor did not become ready.");
}

async function waitForPhase8Comments(pageClient) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await evaluate(pageClient, {
      expression: `({
        comments: ${JSON.stringify(Object.values(commentIds))}
          .filter((commentId) => document.querySelector("#patchmark-comment-card-" + commentId))
          .length,
        projectText: document.body.textContent?.includes("Mode: Patchmark Project") ?? false
      })`
    });

    if (state.comments >= Object.keys(commentIds).length && state.projectText) {
      return;
    }

    await delay(50);
  }

  throw new Error("Timed out waiting for the Phase 8 fixture comments.");
}

async function waitForPreviewHighlight(pageClient) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await highlightRectCount(pageClient, "patchmark-comment-reanchor-preview");
    if (count > 0) return;
    await delay(50);
  }
  throw new Error("Candidate preview highlight did not render.");
}

async function waitForOpenHighlight(pageClient) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await highlightRectCount(pageClient, "patchmark-comment-open-selected-anchor");
    if (count > 0) return;
    await delay(50);
  }
  throw new Error("Confirmed anchor highlight did not render.");
}

async function highlightRectCount(pageClient, name) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const highlight = CSS.highlights?.get(${JSON.stringify(name)});
      if (!highlight) return 0;
      return Array.from(highlight).reduce((total, range) =>
        total + Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).length, 0);
    })()`
  });
}

async function waitForSelector(pageClient, selector) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await evaluate(pageClient, { expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))` })) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForSelectorToDisappear(pageClient, selector) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (!(await evaluate(pageClient, { expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))` }))) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${selector} to disappear`);
}

async function waitForEnabledButton(pageClient, selector, text) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await evaluate(pageClient, {
      expression: `(() => Array.from(document.querySelector(${JSON.stringify(selector)})?.querySelectorAll("button") ?? [])
        .some((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled))()`
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for enabled ${text}`);
}

async function waitForText(pageClient, text) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const found = await evaluate(pageClient, {
      expression: `document.body.textContent?.includes(${JSON.stringify(text)}) ?? false`
    });
    if (found) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function getFixtureWriteCount(pageClient) {
  return await evaluate(pageClient, {
    expression: `window.__patchmarkFixtureWriteLog?.length ?? 0`
  });
}

async function capture(pageClient, fileName) {
  const result = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(join(screenshotDir, fileName), Buffer.from(result.data, "base64"));
}

function screenshotFiles() {
  return [
    "01-missing-anchor-reanchor.png",
    "02-suggested-candidate-list.png",
    "03-candidate-preview.png",
    "04-final-confirmation.png",
    "05-successfully-reanchored.png",
    "06-table-link-reanchor.png",
    "07-multi-block-reanchor.png",
    "08-removed-from-unpositioned.png"
  ].map((fileName) => join(screenshotDir, fileName));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import {
  CdpClient,
  assertEditorIsReachable,
  clickButtonByText,
  createPage,
  createProjectPickerShim,
  evaluate as evaluateCdp,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";
import {
  COMMENT_EDIT_FIXTURE,
  applyCommentEditProject
} from "./lib/fixtures/apply-comment-edit-project.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const editorUrl = addPerformanceQuery(
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/"
);
let projectDir = null;
const tracePath = process.env.PATCHMARK_PERFORMANCE_TRACE_PATH;
const sampleCount = Number(process.env.PATCHMARK_PERFORMANCE_SAMPLES ?? 10);
const scenarioNames = new Set(
  (process.env.PATCHMARK_PERFORMANCE_SCENARIOS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
);

if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  throw new Error("PATCHMARK_PERFORMANCE_SAMPLES must be a positive integer.");
}

const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const fixtureCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
const secondCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
assert.deepEqual(digestProjectTree(fixtureCopy.projectRoot), sourceDigest);
assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigest);
projectDir = fixtureCopy.projectRoot;
const fixtureContract = applyCommentEditProject(projectDir);
const variantDigest = digestProjectTree(projectDir);

try {
  await run();
} finally {
  projectDir = null;
  fixtureCopy.cleanup();
  secondCopy.cleanup();
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
}

async function run() {
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome was not found for edit performance validation.");
  }

  await assertEditorIsReachable(editorUrl);

  const fixtureInventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(
    projectDir,
    fixtureInventory,
    { persistWrites: true }
  );
  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-performance-chrome-"));
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
  let pageClient;
  let stopTrace;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, "about:blank");
    pageClient = await CdpClient.connect(pageWsUrl);
    const call = pageClient.call.bind(pageClient);
    pageClient.call = async (method, parameters = {}) => {
      try {
        return await call(method, parameters);
      } catch (error) {
        throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await pageClient.call("Page.enable");
    await pageClient.call("Runtime.enable");
    await pageClient.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: fixtureInventory.directories,
        files: fixtureInventory.files,
        projectName: basename(projectDir)
      })}\n${createLongTaskObserverScript()}`
    });
    await pageClient.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(pageClient);
    await clickButtonByText(pageClient, "Open Project Folder");
    await waitForCommentEditProject(pageClient);
    await clickButtonByText(pageClient, "Markdown Mode");
    await waitForMarkdownEditor(pageClient);

    if (tracePath) {
      stopTrace = await startPerformanceTrace(pageClient, tracePath);
    }

    const fixture = await readFixtureMetrics(pageClient);
    const scenarios = createScenarios(fixture).filter(
      (scenario) => scenarioNames.size === 0 || scenarioNames.has(scenario.name)
    );

    if (scenarios.length === 0) {
      throw new Error("PATCHMARK_PERFORMANCE_SCENARIOS did not match any scenario.");
    }
    const results = {};

    for (const scenario of scenarios) {
      const samples = [];

      await runScenarioIteration(pageClient, scenario, false);

      for (let index = 0; index < sampleCount; index += 1) {
        samples.push(await runScenarioIteration(pageClient, scenario, true));
      }

      results[scenario.name] = summarizeSamples(samples);
    }
    if (scenarioNames.size === 0) {
      assert.equal(Object.keys(results).length, 12);
    }

    const commentIdentityEdit = await runCommentIdentityEdit(pageClient);
    assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigest);

    console.log(
      JSON.stringify(
        {
          editorUrl,
          fixture: {
            ...fixture,
            contract: { ...fixtureContract, markdown: undefined },
            projectDir,
            sourceDigest: sourceDigest.digest,
            variantDigest: variantDigest.digest
          },
          commentIdentityEdit,
          sampleCount,
          results
        },
        null,
        2
      )
    );
  } finally {
    await stopTrace?.();
    await pageClient?.close();
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 1000);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 1000);
    }
    chrome.stderr?.destroy();
    await fixtureServer.forceClose();
    rmSync(userDataDir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100
    });
  }
}

async function runCommentIdentityEdit(pageClient) {
  await clickButtonByText(pageClient, "Visual Mode");
  await waitForFixtureWritesToSettle(pageClient);
  await ensureCommentsOpen(pageClient);

  const commentsPath = join(projectDir, ".patchmark", "comments.json");
  const beforeComments = readJson(commentsPath);
  const beforeIdentity = readLegacyIdentity(projectDir);
  const beforeTree = digestProjectTree(projectDir);
  const targetBefore = findComment(
    beforeComments,
    COMMENT_EDIT_FIXTURE.targetCommentId
  );
  const unrelatedBefore = beforeComments.filter(
    (comment) => comment.id !== COMMENT_EDIT_FIXTURE.targetCommentId
  );

  await activateComment(pageClient, COMMENT_EDIT_FIXTURE.targetCommentId);
  await evaluate(
    pageClient,
    `(() => {
      const card = document.querySelector(${JSON.stringify(
        `[data-comment-id="${COMMENT_EDIT_FIXTURE.targetCommentId}"]`
      )});
      const trigger = card?.querySelector(".comment-action-menu-trigger");
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) {
        throw new Error("Comment action menu is unavailable");
      }
      trigger.click();
      return true;
    })()`
  );
  await waitForCondition(
    pageClient,
    `Array.from(document.querySelectorAll(".comment-action-menu-panel [role='menuitem']"))
      .some((item) => item.textContent?.trim() === "Edit comment" && item.getClientRects().length > 0)`,
    "Edit comment menu item"
  );
  await clickButtonByText(pageClient, "Edit comment");
  await waitForCondition(
    pageClient,
    `Boolean(document.querySelector(${JSON.stringify(
      `[data-comment-id="${COMMENT_EDIT_FIXTURE.targetCommentId}"] .comment-form textarea`
    )}))`,
    "comment edit form"
  );
  await evaluate(
    pageClient,
    `(() => {
      const textarea = document.querySelector(${JSON.stringify(
        `[data-comment-id="${COMMENT_EDIT_FIXTURE.targetCommentId}"] .comment-form textarea`
      )});
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Comment edit textarea is unavailable");
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, ${JSON.stringify(COMMENT_EDIT_FIXTURE.replacementComment)});
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: ${JSON.stringify(COMMENT_EDIT_FIXTURE.replacementComment)},
        inputType: "insertText"
      }));
      return textarea.value;
    })()`
  );
  await clickButtonByText(pageClient, "Save Edit");
  await waitForFixtureWritesToSettle(pageClient);
  await waitForDiskComment(
    commentsPath,
    COMMENT_EDIT_FIXTURE.targetCommentId,
    COMMENT_EDIT_FIXTURE.replacementComment
  );

  const afterComments = readJson(commentsPath);
  const afterIdentity = readLegacyIdentity(projectDir);
  const afterTree = digestProjectTree(projectDir);
  const targetAfter = findComment(
    afterComments,
    COMMENT_EDIT_FIXTURE.targetCommentId
  );
  const unrelatedAfter = afterComments.filter(
    (comment) => comment.id !== COMMENT_EDIT_FIXTURE.targetCommentId
  );
  assert.equal(targetAfter.comment, COMMENT_EDIT_FIXTURE.replacementComment);
  assert.deepEqual(afterIdentity, beforeIdentity);
  assert.deepEqual(
    unrelatedAfter.map((comment) => createStableCommentSemantics(comment)),
    unrelatedBefore.map((comment) => createStableCommentSemantics(comment))
  );
  assert.deepEqual(
    createStableCommentSemantics(targetAfter, { omitContent: true }),
    createStableCommentSemantics(targetBefore, { omitContent: true })
  );
  assert.notEqual(targetAfter.updated_at, targetBefore.updated_at);
  const changedFiles = diffTreeFiles(beforeTree, afterTree);
  assert.ok(changedFiles.includes(".patchmark/comments.json"));
  assert.equal(changedFiles.includes("document.md"), false);
  assert.equal(changedFiles.includes(".patchmark/patches.json"), false);

  await pageClient.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(pageClient);
  await clickButtonByText(pageClient, "Open Project Folder");
  await waitForCommentEditProject(pageClient);
  await ensureCommentsOpen(pageClient);
  await activateComment(pageClient, COMMENT_EDIT_FIXTURE.targetCommentId);
  await waitForCondition(
    pageClient,
    `document.querySelector(${JSON.stringify(
      `[data-comment-id="${COMMENT_EDIT_FIXTURE.targetCommentId}"]`
    )})?.textContent?.includes(${JSON.stringify(
      COMMENT_EDIT_FIXTURE.replacementComment
    )}) === true`,
    "reopened edited comment"
  );

  return {
    changedFiles,
    canonicalizedUnrelatedComments: unrelatedAfter.filter(
      (comment) => comment.anchor?.anchor_context
    ).length,
    identity: afterIdentity,
    preservedCommentId: targetAfter.id,
    preservedThreadIds: targetAfter.thread.map((entry) => entry.id),
    reopenedExact: true,
    replacementComment: targetAfter.comment,
    semanticDigest: createCommentSemanticDigest(afterIdentity, afterComments),
    sourceUnchanged: digestProjectTree(sourceRoot).digest === sourceDigest.digest,
    unrelatedCommentCount: unrelatedAfter.length
  };
}

async function ensureCommentsOpen(pageClient) {
  const hidden = await evaluate(
    pageClient,
    `document.querySelector("#document-comments-panel")?.hidden ?? true`
  );
  if (!hidden) return;
  await evaluate(
    pageClient,
    `(() => {
      const button = document.querySelector(".application-comments-trigger");
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        throw new Error("Comments trigger is unavailable");
      }
      button.click();
      return true;
    })()`
  );
  await waitForCondition(
    pageClient,
    `document.querySelector("#document-comments-panel")?.hidden === false &&
      document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "true"`,
    "Comments rail open"
  );
}

async function waitForCommentEditProject(pageClient) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await evaluate(
      pageClient,
      `(() => {
        const trigger = document.querySelector(".application-comments-trigger");
        const loaded = Array.from(document.querySelectorAll("[aria-label='Workspace status'] *"))
          .some((element) => element.textContent?.includes("Project:"));
        return {
          expanded: trigger?.getAttribute("aria-expanded") === "true",
          loaded,
          triggerReady: trigger instanceof HTMLButtonElement && !trigger.disabled
        };
      })()`
    );
    if (state.loaded && state.triggerReady) {
      if (!state.expanded) {
        await evaluate(
          pageClient,
          `(() => {
            const trigger = document.querySelector(".application-comments-trigger");
            if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) {
              throw new Error("Comments trigger is unavailable");
            }
            trigger.click();
            return true;
          })()`
        );
      }
      const commentsReady = await evaluate(
        pageClient,
        `(() => {
          const ids = Array.from(document.querySelectorAll("[data-comment-id]"))
            .map((element) => element.getAttribute("data-comment-id"));
          return {
            expanded: document.querySelector(".application-comments-trigger")?.getAttribute("aria-expanded") === "true",
            hidden: document.querySelector("#document-comments-panel")?.hidden ?? true,
            targetPresent: ids.includes(${JSON.stringify(
              COMMENT_EDIT_FIXTURE.targetCommentId
            )}),
            total: new Set(ids).size
          };
        })()`
      );
      if (
        commentsReady.expanded &&
        !commentsReady.hidden &&
        commentsReady.targetPresent &&
        commentsReady.total === fixtureContract.commentCount
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for deterministic comment-edit project.");
}

async function activateComment(pageClient, commentId) {
  await evaluate(
    pageClient,
    `(() => {
      const card = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"]`
      )});
      const target = card?.querySelector(".comment-collapsed-preview") ?? card;
      if (!(target instanceof HTMLElement)) {
        throw new Error("Comment card is unavailable");
      }
      target.click();
      return true;
    })()`
  );
  await waitForCondition(
    pageClient,
    `document.querySelector(${JSON.stringify(
      `[data-comment-id="${commentId}"] article`
    )})?.getAttribute("aria-current") === "true"`,
    `active comment ${commentId}`
  );
}

async function waitForFixtureWritesToSettle(pageClient) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(
      pageClient,
      `({
        active: window.__patchmarkFixtureWriteStats?.activeWrites ?? 0,
        writes: window.__patchmarkFixtureWriteLog?.length ?? 0
      })`
    );
    if (state.active === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const confirmed = await evaluate(
        pageClient,
        `window.__patchmarkFixtureWriteStats?.activeWrites ?? 0`
      );
      if (confirmed === 0) return state.writes;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fixture writes to settle.");
}

async function waitForCondition(pageClient, expression, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate(pageClient, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForDiskComment(filePath, commentId, expectedContent) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const comment = readJson(filePath).find((entry) => entry.id === commentId);
    if (comment?.comment === expectedContent) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for persisted comment ${commentId}.`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readLegacyIdentity(root) {
  const manifest = readJson(join(root, ".patchmark", "manifest.json"));
  return {
    documentId: manifest.document_id,
    projectId: manifest.project_id,
    schemaVersion: manifest.schema_version
  };
}

function findComment(comments, commentId) {
  const comment = comments.find((entry) => entry.id === commentId);
  assert.ok(comment, `Missing comment ${commentId}.`);
  return comment;
}

function createStableCommentSemantics(comment, { omitContent = false } = {}) {
  return {
    anchor: {
      kind: comment.anchor?.kind,
      markdownEndOffset: comment.anchor?.markdown_end_offset ?? null,
      markdownStartOffset: comment.anchor?.markdown_start_offset ?? null,
      selectedText: comment.anchor?.selected_text ?? null
    },
    comment: omitContent ? "<edited-content>" : comment.comment,
    createdAt: comment.created_at,
    exportState: comment.export_state,
    id: comment.id,
    resolvedAt: comment.resolved_at ?? null,
    status: comment.status,
    thread: comment.thread,
    type: comment.type
  };
}

function diffTreeFiles(before, after) {
  const beforeFiles = new Map(
    before.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => [entry.path, entry.sha256])
  );
  const afterFiles = new Map(
    after.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => [entry.path, entry.sha256])
  );
  return [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .filter((path) => beforeFiles.get(path) !== afterFiles.get(path))
    .sort();
}

function createCommentSemanticDigest(identity, comments) {
  const normalized = comments.map((comment) =>
    createStableCommentSemantics(comment)
  );
  return createHash("sha256")
    .update("patchmark-phase2-comment-edit\0")
    .update(JSON.stringify({ comments: normalized, identity }))
    .digest("hex");
}

async function startPerformanceTrace(pageClient, outputPath) {
  const traceEvents = [];
  let resolveComplete;
  const tracingComplete = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const removeDataListener = pageClient.on(
    "Tracing.dataCollected",
    ({ value = [] }) => traceEvents.push(...value)
  );
  const removeCompleteListener = pageClient.on(
    "Tracing.tracingComplete",
    () => resolveComplete()
  );

  await pageClient.call("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing",
    transferMode: "ReportEvents"
  });

  return async () => {
    await pageClient.call("Tracing.end");
    await Promise.race([
      tracingComplete,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out collecting Chrome trace.")), 10_000)
      )
    ]);
    removeDataListener();
    removeCompleteListener();
    writeFileSync(outputPath, JSON.stringify({ traceEvents }));
  };
}

function createScenarios(fixture) {
  const anchorStart = fixture.firstSelectedAnchorStart;
  const anchorEnd = fixture.firstSelectedAnchorEnd;
  const anchorText = fixture.firstSelectedText;
  const outsideStart = Math.max(0, fixture.firstSelectedAnchorStart - 80);
  const tableCellStart = fixture.firstTableCellStart;
  const tableCellEnd = fixture.firstTableCellEnd;
  const tableCellText = fixture.firstTableCellText;

  return [
    {
      name: "typing_outside_anchor",
      mutate: (markdown) => splice(markdown, outsideStart, outsideStart, "x"),
      source: { data: "x", end: outsideStart, inputType: "insertText", start: outsideStart }
    },
    {
      name: "typing_inside_anchor",
      mutate: (markdown) => splice(markdown, anchorStart + 1, anchorStart + 1, "x"),
      source: { data: "x", end: anchorStart + 1, inputType: "insertText", start: anchorStart + 1 }
    },
    {
      name: "small_replacement",
      mutate: (markdown) =>
        splice(
          markdown,
          anchorStart,
          Math.min(anchorEnd, anchorStart + Math.max(10, Math.min(30, anchorText.length))),
          "responsive replacement text"
        ),
      source: {
        data: "responsive replacement text",
        end: Math.min(anchorEnd, anchorStart + Math.max(10, Math.min(30, anchorText.length))),
        inputType: "insertText",
        start: anchorStart
      }
    },
    {
      name: "multiline_paste",
      mutate: (markdown) =>
        splice(markdown, outsideStart, outsideStart, `\n${"Performance paste line.\n".repeat(70)}`),
      source: {
        data: `\n${"Performance paste line.\n".repeat(70)}`,
        end: outsideStart,
        inputType: "insertFromPaste",
        start: outsideStart
      }
    },
    {
      name: "separated_hunks",
      mutate: (markdown) =>
        markdown
          .replace("Purpose.", "Purpose!")
          .replace("Working principle.", "Working principle!")
          .replace("Source Notes", "Source Notes!"),
      source: null
    },
    {
      name: "bold_wrapper",
      mutate: (markdown) => splice(markdown, anchorStart, anchorEnd, `**${anchorText}**`),
      source: { data: `**${anchorText}**`, end: anchorEnd, inputType: "insertText", start: anchorStart }
    },
    {
      name: "link_wrapper",
      mutate: (markdown) =>
        splice(markdown, anchorStart, anchorEnd, `[${anchorText}](https://example.com)`),
      source: {
        data: `[${anchorText}](https://example.com)`,
        end: anchorEnd,
        inputType: "insertText",
        start: anchorStart
      }
    },
    {
      name: "table_cell_update",
      mutate: (markdown) => splice(markdown, tableCellStart, tableCellEnd, `${tableCellText} updated`),
      source: {
        data: `${tableCellText} updated`,
        end: tableCellEnd,
        inputType: "insertText",
        start: tableCellStart
      }
    },
    {
      name: "table_spacing_rewrite",
      mutate: (markdown) => markdown.replace(/ \| /g, "  |  "),
      source: null
    },
    {
      name: "broad_rewrite",
      mutate: (markdown) =>
        markdown
          .replace(/ \| /g, "  |  ")
          .replace(/\n\n/g, "\n\n\n")
          .replace(/^(-|\*) /gm, "$1  "),
      source: null
    },
    {
      name: "undo",
      mutate: (markdown) => splice(markdown, outsideStart, outsideStart, "u"),
      source: { data: null, end: outsideStart, inputType: "historyUndo", start: outsideStart }
    },
    {
      name: "redo",
      mutate: (markdown) => splice(markdown, outsideStart, outsideStart, "r"),
      source: { data: null, end: outsideStart, inputType: "historyRedo", start: outsideStart }
    }
  ];
}

async function runScenarioIteration(pageClient, scenario, collect) {
  const baseline = await getTextareaValue(pageClient);
  const nextMarkdown = scenario.mutate(baseline);
  assert.notEqual(nextMarkdown, baseline, `${scenario.name} must change Markdown`);
  await clearPerformanceRecords(pageClient);
  const dispatchDuration = await setTextareaValue(pageClient, {
    hint: scenario.source,
    value: nextMarkdown
  });
  const operation = await waitForEditPerformanceOperation(pageClient);
  const longTasks = await readAndClearLongTasks(pageClient);
  await setTextareaValue(pageClient, { hint: null, value: baseline });
  await waitForTextareaValue(pageClient, baseline);
  await waitForRecoveryPerformanceOperation(pageClient);
  await clearPerformanceRecords(pageClient);

  return collect
    ? {
        counters: operation.counters,
        dispatchDuration,
        durations: operation.durations,
        longTasks,
        marks: operation.marks,
        metadata: operation.metadata
      }
    : null;
}

async function readFixtureMetrics(pageClient) {
  return evaluate(
    pageClient,
    `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      const comments = [...document.querySelectorAll("[data-comment-id]")];
      const selected = comments
        .map((element) => ({
          end: Number(element.getAttribute("data-comment-anchor-end")),
          kind: element.getAttribute("data-comment-anchor-kind"),
          start: Number(element.getAttribute("data-comment-anchor-start"))
        }))
        .filter((comment) => comment.kind === "selected_text" && Number.isFinite(comment.start) && Number.isFinite(comment.end));
      const markdown = textarea?.value ?? "";
      const representativeSelected = selected
        .map((comment) => ({
          ...comment,
          text: markdown.slice(comment.start, comment.end)
        }))
        .filter((comment) =>
          comment.text.length >= 20 &&
          comment.text.length <= 180 &&
          !comment.text.includes("|") &&
          !comment.text.includes("\\n")
        )
        .sort((first, second) => first.text.length - second.text.length)[0] ?? selected[0];
      const tableMatch = /\\|\\s*([^|\\n]{3,80}?)\\s*\\|/.exec(markdown);
      if (!textarea || selected.length === 0 || !representativeSelected || !tableMatch || tableMatch.index === undefined) {
        throw new Error("Performance fixture is missing textarea, selected anchors, or a table cell.");
      }
      const tableCellText = tableMatch[1].trim();
      const cellRelativeStart = tableMatch[0].indexOf(tableCellText);
      return {
        chars: markdown.length,
        commentCount: comments.length,
        firstSelectedAnchorEnd: representativeSelected.end,
        firstSelectedAnchorStart: representativeSelected.start,
        firstSelectedText: markdown.slice(representativeSelected.start, representativeSelected.end),
        firstTableCellEnd: tableMatch.index + cellRelativeStart + tableCellText.length,
        firstTableCellStart: tableMatch.index + cellRelativeStart,
        firstTableCellText: tableCellText,
        lines: markdown.split(/\\r?\\n/).length,
        selectedCommentCount: selected.length
      };
    })()`
  );
}

async function waitForMarkdownEditor(pageClient) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      pageClient,
      `Boolean(document.querySelector(".markdown-source-editor"))`
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Markdown Source editor.");
}

async function getTextareaValue(pageClient) {
  return evaluate(
    pageClient,
    `document.querySelector(".markdown-source-editor")?.value ?? ""`
  );
}

async function setTextareaValue(pageClient, { hint, value }) {
  return evaluate(
    pageClient,
    `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea not found");
      const hint = ${JSON.stringify(hint)};
      const nextValue = ${JSON.stringify(value)};
      if (hint) {
        textarea.focus();
        textarea.setSelectionRange(hint.start, hint.end);
        textarea.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: hint.data,
          inputType: hint.inputType
        }));
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      const startedAt = performance.now();
      const canApplyRangeEdit =
        hint &&
        typeof hint.data === "string" &&
        textarea.value.slice(0, hint.start) +
          hint.data +
          textarea.value.slice(hint.end) ===
          nextValue;

      if (canApplyRangeEdit) {
        textarea.setRangeText(hint.data, hint.start, hint.end, "end");
      } else {
        setter.call(textarea, nextValue);
      }
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: hint?.data ?? null,
        inputType: hint?.inputType ?? "insertText"
      }));
      return performance.now() - startedAt;
    })()`
  );
}

async function waitForTextareaValue(pageClient, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await getTextareaValue(pageClient)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Markdown textarea state.");
}

async function clearPerformanceRecords(pageClient) {
  await evaluate(
    pageClient,
    `window.__PATCHMARK_EDIT_PERFORMANCE__?.clear(); window.__PATCHMARK_LONG_TASKS__ = []; true`
  );
}

async function waitForEditPerformanceOperation(pageClient) {
  const deadline = Date.now() + 10_000;
  let latestOperation = null;
  while (Date.now() < deadline) {
    const operation = await evaluate(
      pageClient,
      `window.__PATCHMARK_EDIT_PERFORMANCE__?.getRecords().at(-1) ?? null`
    );
    latestOperation = operation;
    if (
      operation?.marks?.all_async_effects_settled !== undefined &&
      operation?.marks?.persistence_settled !== undefined &&
      operation.marks.persistence_settled >=
        operation.marks.all_async_effects_settled
    ) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for dirty edit persistence to settle.\n${JSON.stringify(
      latestOperation,
      null,
      2
    )}`
  );
}

async function waitForRecoveryPerformanceOperation(pageClient) {
  const deadline = Date.now() + 10_000;
  let latestOperation = null;
  while (Date.now() < deadline) {
    const operation = await evaluate(
      pageClient,
      `window.__PATCHMARK_EDIT_PERFORMANCE__?.getRecords().at(-1) ?? null`
    );
    latestOperation = operation;
    if (
      operation?.marks?.all_async_effects_settled !== undefined &&
      operation?.marks?.background_recovery_settled !== undefined &&
      operation?.marks?.background_recovery_persisted !== undefined &&
      operation.marks.all_async_effects_settled >=
        operation.marks.background_recovery_persisted
    ) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for baseline reset recovery to settle.\n${JSON.stringify(
      latestOperation,
      null,
      2
    )}`
  );
}

async function readAndClearLongTasks(pageClient) {
  return evaluate(
    pageClient,
    `(() => { const tasks = window.__PATCHMARK_LONG_TASKS__ ?? []; window.__PATCHMARK_LONG_TASKS__ = []; return tasks; })()`
  );
}

function summarizeSamples(samples) {
  return {
    anchorSettleMs: summarize(samples.map((sample) => sample.marks.anchor_settled)),
    dispatchMs: summarize(samples.map((sample) => sample.dispatchDuration)),
    fullSettleMs: summarize(
      samples.map((sample) => sample.marks.all_async_effects_settled)
    ),
    inputBlockingMs: summarize(
      samples.map((sample) => sample.marks.input_handler_return)
    ),
    fastAnchorValidationCount: samples.reduce(
      (total, sample) => total + (sample.counters.fast_anchor_validation_count ?? 0),
      0
    ),
    fullAnchorRecoveryCount: samples.reduce(
      (total, sample) => total + (sample.counters.full_anchor_recovery_count ?? 0),
      0
    ),
    longTaskCount: samples.reduce(
      (total, sample) => total + sample.longTasks.length,
      0
    ),
    maxLongTaskMs: Math.max(
      0,
      ...samples.flatMap((sample) => sample.longTasks.map((task) => task.duration))
    ),
    projectionPasses: summarize(
      samples.map((sample) => sample.counters.projection_pass_count ?? 0)
    ),
    stageDurationsMs: summarizeDurationMap(samples),
    stateCommitMs: summarize(samples.map((sample) => sample.marks.react_commit)),
    visualMs: summarize(samples.map((sample) => sample.marks.visual_settled))
  };
}

function summarizeDurationMap(samples) {
  const names = new Set(samples.flatMap((sample) => Object.keys(sample.durations)));
  return Object.fromEntries(
    [...names].map((name) => [
      name,
      summarize(samples.map((sample) => sample.durations[name] ?? 0))
    ])
  );
}

function summarize(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((first, second) => first - second);
  if (sorted.length === 0) {
    return null;
  }
  return {
    max: round(sorted.at(-1)),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)])
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function splice(text, start, end, insertedText) {
  return `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
}

function addPerformanceQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("patchmarkPerformance", "1");
  return parsed.toString();
}

function createLongTaskObserverScript() {
  return `
    window.__PATCHMARK_LONG_TASKS__ = [];
    if (typeof PerformanceObserver !== "undefined") {
      try {
        new PerformanceObserver((list) => {
          window.__PATCHMARK_LONG_TASKS__.push(
            ...list.getEntries().map((entry) => ({
              duration: entry.duration,
              name: entry.name,
              startTime: entry.startTime
            }))
          );
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
  `;
}

function evaluate(client, expression) {
  return evaluateCdp(client, { expression });
}

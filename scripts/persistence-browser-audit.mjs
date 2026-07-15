import crypto from "node:crypto";
import { basename } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  CdpClient,
  assertEditorIsReachable,
  createPage,
  createProjectPickerShim,
  evaluate,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit,
  waitForProjectComments
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl = addPerformanceQuery(
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3117/"
);
const projectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const rapidEditCount = Number(process.env.PATCHMARK_RAPID_EDIT_COUNT ?? 75);

if (!projectDir) {
  throw new Error(
    "Set PATCHMARK_REAL_PROJECT_DIR to a copied Patchmark project fixture."
  );
}

if (!Number.isInteger(rapidEditCount) || rapidEditCount < 1) {
  throw new Error("PATCHMARK_RAPID_EDIT_COUNT must be a positive integer.");
}

await run();

async function run() {
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome was not found for persistence validation.");
  }

  await assertEditorIsReachable(editorUrl);

  const inventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(projectDir, inventory, {
    persistWrites: false
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-persistence-chrome-"));
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
      source: `${createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: inventory.directories,
        files: inventory.files,
        projectName: basename(projectDir)
      })}\n${createPersistenceObserverScript()}`
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    progress("editor_ready");
    const projectLoadStartedAt = performance.now();
    await clickExactButton(client, "Open Project Folder");
    await waitForProjectComments(client);
    const projectLoadMs = performance.now() - projectLoadStartedAt;
    progress("project_loaded");

    const originalHashes = {
      comments: hashFile(join(projectDir, ".patchmark", "comments.json")),
      document: hashFile(join(projectDir, "document.md")),
      manifest: hashFile(join(projectDir, ".patchmark", "manifest.json")),
      patches: hashFile(join(projectDir, ".patchmark", "patches.json"))
    };
    const initialLoad = await waitForWriteQuiet(client, 500, 4_000);
    const noOpResults = [];
    progress("initial_load_sampled");

    await clearAuditLogs(client);
    await runAuditedAction(client, noOpResults, "open_or_activate_comment", () =>
      clickFirstComment(client)
    );
    await runAuditedAction(client, noOpResults, "close_or_deactivate_comment", () =>
      clickFirstComment(client)
    );
    await runAuditedAction(client, noOpResults, "find", () =>
      clickFirstMatchingButton(client, /^Find(?: |$)/)
    );
    await runAuditedAction(client, noOpResults, "scroll", () =>
      evaluate(client, {
        expression: "window.scrollBy(0, 700); window.scrollBy(0, -350); true"
      })
    );
    await runAuditedAction(client, noOpResults, "patch_review", async () => {
      await clickFirstMatchingButton(
        client,
        /^(Review|View) (related )?(patch|applied patch|rejected patch|stale patch)/
      );
      await delay(200);
      await clickExactButton(client, "Close");
    });
    await runAuditedAction(client, noOpResults, "pdf_preview", async () => {
      await clickExactButton(client, "Export PDF");
      await delay(200);
      await clickExactButton(client, "Close");
    });
    await runAuditedAction(client, noOpResults, "save_without_changes", () =>
      clickExactButton(client, "Save Changes")
    );
    await runAuditedAction(client, noOpResults, "canonical_validation", async () => {
      await clickExactButton(client, "Markdown Mode");
      await clickExactButton(client, "Visual Mode");
    });
    await runAuditedAction(client, noOpResults, "harmless_rerender", () =>
      evaluate(client, {
        expression:
          "window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('scroll')); true"
      })
    );
    await clearAuditLogs(client);
    const reloadStartedAt = performance.now();
    await client.call("Page.reload", { ignoreCache: true });
    await waitForEditorShell(client);
    await clickExactButton(client, "Open Project Folder");
    await waitForProjectComments(client);
    const reloadQuiet = await waitForWriteQuiet(client, 500, 4_000);
    noOpResults.push({
      name: "reload",
      error: null,
      quiet: reloadQuiet.quiet,
      durationMs: Math.round((performance.now() - reloadStartedAt) * 100) / 100,
      ...summarizeAudit(await readAuditLogs(client))
    });
    progress("no_op_actions_sampled");

    await clearAuditLogs(client);
    await clickExactButton(client, "Markdown Mode");
    await waitForMarkdownEditor(client);
    for (let index = 0; index < rapidEditCount; index += 1) {
      await appendTextareaText(client, index % 2 === 0 ? "x" : "y");
      await delay(4);
    }
    const rapidEditQuiet = await waitForWriteQuiet(client, 500, 4_000);
    const rapidEditAudit = await readAuditLogs(client);
    const performanceRecords = await evaluate(client, {
      expression:
        "window.__PATCHMARK_EDIT_PERFORMANCE__?.getRecords().slice(-" +
        rapidEditCount +
        ") ?? []"
    });
    const rapidEditBeforeSave = summarizeAudit(rapidEditAudit);

    await clearAuditLogs(client);
    await clickExactButton(client, "Save Changes");
    const rapidSaveQuiet = await waitForWriteQuiet(client, 500, 5_000);
    const rapidSave = summarizeAudit(await readAuditLogs(client));
    progress("rapid_edits_sampled");

    const partialSave = await runPartialDocumentSave(client);
    progress("partial_save_sampled");
    const longTasks = await evaluate(client, {
      expression: "window.__PATCHMARK_PERSISTENCE_LONG_TASKS__ ?? []"
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          editorUrl,
          projectDir,
          projectLoadMs: Math.round(projectLoadMs * 100) / 100,
          originalHashes,
          initialLoad: summarizeAudit(initialLoad),
          noOpInteractions: noOpResults,
          rapidEdits: {
            requestedEdits: rapidEditCount,
            performanceRecords: performanceRecords.length,
            quiet: rapidEditQuiet.quiet,
            beforeSave: rapidEditBeforeSave,
            saveQuiet: rapidSaveQuiet.quiet,
            explicitSave: rapidSave
          },
          partialSave,
          longTasks: summarizeLongTasks(longTasks)
        },
        null,
        2
      )}\n`
    );
  } finally {
    if (client) await client.close().catch(() => {});
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 2_000).catch(() => {});
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 2_000).catch(() => {});
    }
    await fixtureServer.forceClose().catch(() => {});
    rmSync(userDataDir, { force: true, recursive: true });
  }
}

function createPersistenceObserverScript() {
  return `(() => {
    const originalStringify = JSON.stringify;
    const originalMap = Array.prototype.map;
    const commentMapLog = [];
    const stringifyLog = [];
    Array.prototype.map = function(...args) {
      const isCommentArray =
        this.length > 0 &&
        typeof this[0]?.id === "string" &&
        this[0].id.startsWith("PM-COMMENT-");
      const startedAt = isCommentArray ? performance.now() : 0;
      const result = originalMap.apply(this, args);
      if (isCommentArray) {
        commentMapLog.push({ count: this.length, duration: performance.now() - startedAt });
      }
      return result;
    };
    JSON.stringify = function(...args) {
      const startedAt = performance.now();
      const result = originalStringify.apply(this, args);
      const duration = performance.now() - startedAt;
      if (typeof result === "string" && result.length >= 1000000) {
        stringifyLog.push({ bytes: new TextEncoder().encode(result).byteLength, duration });
      }
      return result;
    };
    window.__PATCHMARK_PERSISTENCE_STRINGIFY_LOG__ = stringifyLog;
    window.__PATCHMARK_PERSISTENCE_COMMENT_MAP_LOG__ = commentMapLog;
    window.__PATCHMARK_PERSISTENCE_LONG_TASKS__ = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__PATCHMARK_PERSISTENCE_LONG_TASKS__.push({
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  })();`;
}

async function runAuditedAction(client, results, name, action) {
  await clearAuditLogs(client);
  const startedAt = performance.now();
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const quietResult = await waitForWriteQuiet(client, 250, 1_500);
  results.push({
    name,
    error,
    quiet: quietResult.quiet,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    ...summarizeAudit(await readAuditLogs(client))
  });
}

async function runPartialDocumentSave(client) {
  await clickExactButton(client, "Markdown Mode").catch(() => {});
  await waitForMarkdownEditor(client);
  await appendTextareaText(client, " partial-save-audit");
  await clearAuditLogs(client);
  await evaluate(client, {
    expression:
      "window.__patchmarkFixtureWriteControls.failNextPath = '.patchmark/comments.json'; true"
  });
  await clickExactButton(client, "Save Changes");
  const quiet = await waitForWriteQuiet(client, 500, 5_000);
  const audit = await readAuditLogs(client);
  const feedback = await evaluate(client, {
    expression:
      "Array.from(document.querySelectorAll('[role=alert], .save-feedback')).map((node) => node.textContent?.trim()).filter(Boolean).at(-1) ?? null"
  });
  return { quiet: quiet.quiet, feedback, ...summarizeAudit(audit) };
}

async function clearAuditLogs(client) {
  await evaluate(client, {
    expression: `(() => {
      window.__patchmarkFixtureWriteLog.length = 0;
      window.__patchmarkFixtureWriteStats.maximumActiveWrites = window.__patchmarkFixtureWriteStats.activeWrites;
      window.__PATCHMARK_PERSISTENCE_STRINGIFY_LOG__.length = 0;
      window.__PATCHMARK_PERSISTENCE_COMMENT_MAP_LOG__.length = 0;
      return true;
    })()`
  });
}

async function readAuditLogs(client) {
  return evaluate(client, {
    expression: `({
      writes: window.__patchmarkFixtureWriteLog,
      writeStats: window.__patchmarkFixtureWriteStats,
      stringifies: window.__PATCHMARK_PERSISTENCE_STRINGIFY_LOG__,
      commentMaps: window.__PATCHMARK_PERSISTENCE_COMMENT_MAP_LOG__
    })`
  });
}

async function waitForWriteQuiet(client, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let unchangedSince = Date.now();

  while (Date.now() < deadline) {
    const state = await readAuditLogs(client);
    if (state.writes.length !== lastCount || state.writeStats.activeWrites > 0) {
      lastCount = state.writes.length;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return { ...state, quiet: true };
    }
    await delay(100);
  }

  return { ...(await readAuditLogs(client)), quiet: false };
}

function summarizeAudit(audit) {
  const writes = audit.writes ?? [];
  const stringifies = audit.stringifies ?? [];
  const commentMaps = audit.commentMaps ?? [];
  return {
    attemptedWrites: writes.length,
    completedWrites: writes.filter((event) => event.status === "completed").length,
    failedWrites: writes.filter((event) => event.status === "failed").length,
    bytesAttempted: writes.reduce((total, event) => total + event.bytes, 0),
    bytesCompleted: writes
      .filter((event) => event.status === "completed")
      .reduce((total, event) => total + event.bytes, 0),
    commentsWrites: writes.filter(
      (event) => event.path === ".patchmark/comments.json"
    ).length,
    paths: Object.fromEntries(
      Object.entries(Object.groupBy(writes, (event) => event.path)).map(
        ([path, events]) => [path, events.length]
      )
    ),
    serializationOperations: stringifies.length,
    serializedBytes: stringifies.reduce((total, event) => total + event.bytes, 0),
    stringifyMedianMs: percentile(
      stringifies.map((event) => event.duration).sort((a, b) => a - b),
      0.5
    ),
    stringifyP95Ms: percentile(
      stringifies.map((event) => event.duration).sort((a, b) => a - b),
      0.95
    ),
    commentArrayMapOperations: commentMaps.length,
    commentArrayMapMedianMs: percentile(
      commentMaps.map((event) => event.duration).sort((a, b) => a - b),
      0.5
    ),
    commentArrayMapP95Ms: percentile(
      commentMaps.map((event) => event.duration).sort((a, b) => a - b),
      0.95
    ),
    commentArrayMapMaximumMs: Math.round(
      (Math.max(0, ...commentMaps.map((event) => event.duration)) + Number.EPSILON) *
        100
    ) / 100,
    maximumActiveWrites: audit.writeStats?.maximumActiveWrites ?? 0
  };
}

function summarizeLongTasks(entries) {
  const durations = entries.map((entry) => entry.duration).sort((a, b) => a - b);
  return {
    count: entries.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maximumMs: durations.at(-1) ?? 0
  };
}

async function clickExactButton(client, text) {
  return evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((node) => node.textContent?.trim() === ${JSON.stringify(text)} && !node.disabled);
      if (!button) throw new Error("Button not found: ${text}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function clickFirstMatchingButton(client, pattern) {
  return evaluate(client, {
    expression: `(() => {
      const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const button = Array.from(document.querySelectorAll("button"))
        .find((node) => pattern.test(node.textContent?.trim() ?? "") && !node.disabled);
      if (!button) throw new Error("Matching button not found: " + pattern);
      button.click();
      return button.textContent?.trim();
    })()`,
    userGesture: true
  });
}

async function clickFirstComment(client) {
  return evaluate(client, {
    expression: `(() => {
      const target = document.querySelector("[data-comment-id] article[aria-label]") ??
        document.querySelector("[data-comment-id]");
      if (!target) throw new Error("Comment card not found");
      target.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForMarkdownEditor(client) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(client, {
      expression: "Boolean(document.querySelector('.markdown-source-editor'))"
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for Markdown Mode.");
}

async function appendTextareaText(client, text) {
  return evaluate(client, {
    expression: `(() => {
      const textarea = document.querySelector(".markdown-source-editor");
      if (!textarea) throw new Error("Markdown textarea not found");
      const start = textarea.value.length;
      textarea.focus();
      textarea.setSelectionRange(start, start);
      textarea.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: ${JSON.stringify(text)},
        inputType: "insertText"
      }));
      textarea.setRangeText(${JSON.stringify(text)}, start, start, "end");
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: ${JSON.stringify(text)},
        inputType: "insertText"
      }));
      return textarea.value.length;
    })()`,
    userGesture: true
  });
}

function addPerformanceQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("patchmarkPerformance", "1");
  return parsed.href;
}

function hashFile(path) {
  return crypto.createHash("sha256").update(readFileSync(path)).digest("hex");
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * percentileValue) - 1)
  );
  return Math.round(values[index] * 100) / 100;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function progress(stage) {
  process.stderr.write(`[persistence-browser-audit] ${stage}\n`);
}

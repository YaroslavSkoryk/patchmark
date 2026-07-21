import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

const editorUrl = addPerformanceQuery(
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/"
);
const sampleCount = Number(process.env.PATCHMARK_SWITCH_SAMPLES ?? 6);
const stressTransitions = Number(
  process.env.PATCHMARK_SWITCH_STRESS_TRANSITIONS ?? 60
);
const outputPath = process.env.PATCHMARK_SWITCH_PERFORMANCE_OUTPUT;
const sourceProjectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const expectOptimized =
  process.env.PATCHMARK_SWITCH_EXPECT_OPTIMIZED !== "0";
const fixtureRoot = sourceProjectDir
  ? null
  : mkdtempSync(join(tmpdir(), "patchmark-switch-performance-"));
const projectDir = sourceProjectDir ?? join(fixtureRoot, "Strategy Performance");

if (!sourceProjectDir) {
  createStrategyScaleFixture(projectDir);
}

if (!Number.isInteger(sampleCount) || sampleCount < 2) {
  throw new Error("PATCHMARK_SWITCH_SAMPLES must be an integer of at least 2.");
}

if (!Number.isInteger(stressTransitions) || stressTransitions < 10) {
  throw new Error(
    "PATCHMARK_SWITCH_STRESS_TRANSITIONS must be an integer of at least 10."
  );
}

await run();

async function run() {
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error("Chrome was not found for document-switch performance tests.");
  }

  await assertEditorIsReachable(editorUrl);
  const inventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(projectDir, inventory, {
    persistWrites: !sourceProjectDir
  });
  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-switch-performance-chrome-")
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
    const browserUrl = await waitForDevToolsUrl(chrome);
    const pageUrl = await createPage(browserUrl, "about:blank");
    client = await CdpClient.connect(pageUrl);
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: inventory.directories,
        files: inventory.files,
        projectName: basename(projectDir)
      })}\n${createLongTaskObserverScript()}`
    });
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 1000,
      mobile: false,
      width: 1600
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForCondition(
      client,
      `document.querySelectorAll(".project-document-item").length >= 2 &&
        !document.querySelector(".visual-editor-loading") &&
        Boolean(document.querySelector(".patchmark-prose"))`,
      "initial project document"
    );

    const titles = await readAvailableDocumentTitles(client);
    assert.ok(titles.length >= 2, "The project must contain two available documents.");
    const firstTitle = sourceProjectDir
      ? titles[0]
      : titles.find((title) => title === "Action Plan") ?? titles[0];
    const secondTitle = sourceProjectDir
      ? titles[1]
      : titles.find((title) => title === "Ready-to-Eat Channel Research") ??
        titles[1];
    const thirdTitle = sourceProjectDir
      ? titles[2] ?? titles[0]
      : titles.find((title) => title === "Business Dimensions Framework") ??
        titles[2] ??
        titles[0];
    const cold = await measureSwitch(client, secondTitle);
    if (expectOptimized) {
      assert.equal(cold.writeCount, 0, "An unchanged cold switch must not write.");
      assert.equal(
        cold.record.counters.recovery_records_written ?? 0,
        0,
        "An unchanged cold switch must not create recovery churn."
      );
    }
    assert.equal(
      cold.versionBodyReadCount,
      0,
      "Normal switching must not read historical version bodies."
    );

    const warmSamples = [];
    let nextTitle = firstTitle;
    for (let index = 0; index < sampleCount; index += 1) {
      warmSamples.push(await measureSwitch(client, nextTitle));
      nextTitle = nextTitle === firstTitle ? secondTitle : firstTitle;
    }
    if (expectOptimized) {
      assert.ok(
        warmSamples.every((sample) => sample.writeCount === 0),
        "Unchanged warm switches must not write."
      );
      assert.ok(
        warmSamples.every(
          (sample) =>
            (sample.record.counters.recovery_records_written ?? 0) === 0
        ),
        "Unchanged warm switches must not create recovery churn."
      );
    }

    await ensureActiveDocument(client, secondTitle);
    await clickButtonByText(client, "Markdown Mode");
    await waitForCondition(
      client,
      `Boolean(document.querySelector(".markdown-source-editor"))`,
      "Markdown Mode"
    );
    await appendMarkdown(client, `\nDirty switch marker ${Date.now()}\n`);
    const dirty = await measureSwitch(client, firstTitle);
    assert.ok(dirty.writeCount > 0, "A dirty Markdown switch must persist first.");
    assert.equal(
      dirty.record.counters.recovery_records_written,
      1,
      "A dirty Markdown switch must preserve recovery until save succeeds."
    );
    assert.equal(
      dirty.record.counters.recovery_records_cleared,
      1,
      "A dirty Markdown switch must clear its matching recovery after save."
    );
    assert.ok(
      dirty.record.marks.current_authoritative_state_persisted <=
        dirty.record.marks.first_target_render,
      "Authoritative persistence must finish before target render."
    );

    await clickButtonByText(client, "Visual Mode");
    await waitForCondition(
      client,
      `Boolean(document.querySelector(".patchmark-prose"))`,
      "Visual Mode after dirty save"
    );
    const rapid = await measureRapidSwitch(client, secondTitle, thirdTitle);
    assert.equal(rapid.activeTitle, thirdTitle, "The latest rapid switch must win.");

    let fixtureScenarios = null;
    if (!sourceProjectDir) {
      const missing = await measureMissingSwitch(client, "Missing Appendix");
      assert.equal(missing.writeCount, 0, "A missing target must not cause writes.");
      assert.equal(
        missing.unrelatedDocumentReadCount,
        0,
        "A missing target must not load unrelated document stores."
      );

      await measureSwitch(client, firstTitle);
      await toggleGroup(client, "Research");
      await waitForGroupExpanded(client, "Research", false);
      const bookmark = await measureBookmarkSwitch(client, secondTitle);
      assert.equal(bookmark.record.metadata.trigger, "bookmark");
      assert.equal(bookmark.writeCount, 0, "Group expansion must remain local UI state.");
      await waitForGroupExpanded(client, "Research", true);

      await ensureMarkdownMode(client);
      const failedSaveMarker = `Failed save marker ${Date.now()}`;
      await appendMarkdown(client, `\n${failedSaveMarker}\n`);
      const saveFailure = await measureSaveFailure(
        client,
        firstTitle,
        secondTitle
      );
      assert.equal(saveFailure.activeTitle, secondTitle);
      assert.ok(saveFailure.failedWriteCount > 0, "The injected save must fail.");
      assert.equal(saveFailure.recoveryVisible, true);
      const saveRetry = await measureSwitch(client, firstTitle);
      assert.ok(saveRetry.writeCount > 0, "Retry must persist the dirty source.");

      await measureSwitch(client, secondTitle);
      const externalMarker = `External change marker ${Date.now()}`;
      await updateFixtureMarkdownWithValidCommit(
        client,
        "action-plan.md",
        ".patchmark/documents/doc_action/save-commit.json",
        externalMarker
      );
      const externalChange = await measureSwitch(client, firstTitle);
      await waitForCondition(
        client,
        `document.querySelector(".patchmark-prose")?.textContent?.includes(${JSON.stringify(
          externalMarker
        )}) || document.querySelector(".markdown-source-editor")?.value?.includes(${JSON.stringify(
          externalMarker
        )})`,
        "externally changed target Markdown"
      );
      const versionHistory = await verifyVersionHistoryMetadata(client, 49);
      fixtureScenarios = {
        bookmark: summarizeSamples([bookmark]),
        externalChange: summarizeSamples([externalChange]),
        missing,
        saveFailure,
        saveRetry: summarizeSamples([saveRetry]),
        versionHistory
      };
    }

    const stressSamples = [];
    for (let index = 0; index < stressTransitions; index += 1) {
      const activeTitle = await readActiveDocumentTitle(client);
      const targetTitle = activeTitle === firstTitle ? secondTitle : firstTitle;
      stressSamples.push(await measureSwitch(client, targetTitle));
    }

    const derivedStateCacheSize = await evaluate(client, {
      expression: `window.__PATCHMARK_DOCUMENT_SWITCH_CACHE__?.size ?? 0`
    });
    assert.equal(
      derivedStateCacheSize,
      0,
      "Switching must not retain an unvalidated derived editor-state cache."
    );

    const summary = {
      source: sourceProjectDir ? "real_project_safe_read_fixture" : "generated_strategy_scale",
      expectOptimized,
      editorUrl,
      projectDir,
      fixture: readProjectFixtureSummary(projectDir, firstTitle),
      documents: { firstTitle, secondTitle, thirdTitle },
      cold: summarizeSamples([cold]),
      warm: summarizeSamples(warmSamples),
      dirty: summarizeSamples([dirty]),
      rapid,
      ...(fixtureScenarios ?? {}),
      stress: {
        transitions: stressTransitions,
        derivedStateCacheSize,
        ...summarizeSamples(stressSamples)
      }
    };

    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    console.log(JSON.stringify(summary, null, 2));
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
    if (fixtureRoot) {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }
}

async function measureSwitch(client, targetTitle) {
  await resetMeasurementState(client);
  const requestedAt = performance.now();
  await clickDocument(client, targetTitle);
  await waitForTargetEditor(client, targetTitle);
  const observedFirstUsableMs = performance.now() - requestedAt;
  const record = await waitForSwitchRecord(client, targetTitle, true);
  const wallTime = performance.now() - requestedAt;
  const state = await readMeasurementState(client);
  return createMeasurement(
    record,
    state,
    observedFirstUsableMs,
    wallTime
  );
}

async function measureRapidSwitch(client, intermediateTitle, targetTitle) {
  await resetMeasurementState(client);
  await clickDocument(client, intermediateTitle);
  await delay(25);
  await clickDocument(client, targetTitle);
  await waitForTargetEditor(client, targetTitle);
  const record = await waitForSwitchRecord(client, targetTitle, true);
  const allRecords = await evaluate(client, {
    expression: `window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.getRecords() ?? []`
  });
  return {
    activeTitle: await readActiveDocumentTitle(client),
    completedTargetId: record.metadata.targetDocumentId,
    operationCount: allRecords.length,
    staleOperationCompleted:
      allRecords.length > 1 &&
      allRecords.slice(0, -1).some((candidate) =>
        Number.isFinite(candidate.marks.first_usable_editor)
      )
  };
}

async function measureBookmarkSwitch(client, targetTitle) {
  await resetMeasurementState(client);
  const requestedAt = performance.now();
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(${JSON.stringify(
        `button[aria-label="Continue reading in ${targetTitle}"]`
      )});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not continue reading in ${targetTitle}.`);
  await waitForTargetEditor(client, targetTitle);
  const observedFirstUsableMs = performance.now() - requestedAt;
  const record = await waitForSwitchRecord(client, targetTitle, true);
  return createMeasurement(
    record,
    await readMeasurementState(client),
    observedFirstUsableMs,
    performance.now() - requestedAt
  );
}

async function measureMissingSwitch(client, targetTitle) {
  await resetMeasurementState(client);
  const requestedAt = performance.now();
  await clickDocument(client, targetTitle);
  try {
    await waitForCondition(
      client,
      `document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent === ${JSON.stringify(targetTitle)} &&
        document.querySelector(".document-save-banner-info")?.textContent?.includes("is missing")`,
      "missing target state"
    );
  } catch (error) {
    const state = await evaluate(client, {
      expression: `({
        activeTitle: document.querySelector(
          ".project-document-item[data-active='true'] .project-document-select span"
        )?.textContent ?? null,
        banner: document.querySelector(".document-save-banner")?.textContent ?? null,
        requestedTitle: document.querySelector(
          ".project-document-item[data-requested='true'] .project-document-select span"
        )?.textContent ?? null
      })`
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(
        state
      )}`
    );
  }
  const state = await readMeasurementState(client);
  return {
    firstVisibleMs: round(performance.now() - requestedAt),
    readCount: state.reads.length,
    unrelatedDocumentReadCount: state.reads.filter(
      (read) => !read.path.includes("doc_missing")
    ).length,
    writeCount: state.writes.length
  };
}

async function measureSaveFailure(client, targetTitle, sourceTitle) {
  await resetMeasurementState(client);
  await evaluate(client, {
    expression: `(() => {
      window.__patchmarkFixtureWriteControls.failNextSequence =
        window.__patchmarkFixtureWriteStats.nextSequence;
      return true;
    })()`
  });
  await clickDocument(client, targetTitle);
  await waitForCondition(
    client,
    `document.querySelector(".document-save-banner-error")?.textContent?.includes("Could not switch documents") &&
      document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent === ${JSON.stringify(sourceTitle)}`,
    "failed save barrier"
  );
  const state = await readMeasurementState(client);
  return {
    activeTitle: await readActiveDocumentTitle(client),
    failedWriteCount: state.writes.filter((write) => write.status === "failed").length,
    recoveryVisible: await evaluate(client, {
      expression: `document.querySelector(".project-document-item[data-active='true']")?.textContent?.includes("Unsaved recovery") ?? false`
    })
  };
}

async function verifyVersionHistoryMetadata(client, expectedCount) {
  await resetMeasurementState(client);
  await clickButtonByText(client, "View all versions");
  await waitForCondition(
    client,
    `document.querySelectorAll(".version-entry-full").length === ${expectedCount}`,
    "complete Version History metadata"
  );
  const state = await readMeasurementState(client);
  const versionBodyReadCount = state.reads.filter((read) =>
    /\/versions\/[^/]+\.md$/.test(read.path)
  ).length;
  assert.equal(
    versionBodyReadCount,
    0,
    "Opening Version History metadata must not read version bodies."
  );
  await clickButtonByText(client, "Close");
  await waitForCondition(
    client,
    `!document.querySelector(".version-history-dialog")`,
    "closed Version History"
  );
  return { entries: expectedCount, versionBodyReadCount };
}

function createMeasurement(record, state, observedFirstUsableMs, wallTime) {
  const longTasks = state.longTasks.filter(
    (task) => task.startTime >= state.measurementStartedAt
  );
  return {
    firstUsableMs: observedFirstUsableMs,
    instrumentedFirstUsableMs: record.marks.first_usable_editor,
    secondaryCompleteMs: record.marks.secondary_work_complete,
    wallTimeMs: wallTime,
    longestTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
    readCount: state.reads.length,
    bytesRead: state.reads.reduce((total, read) => total + read.bytes, 0),
    writeCount: state.writes.length,
    bytesWritten: state.writes.reduce((total, write) => total + write.bytes, 0),
    versionBodyReadCount: state.reads.filter((read) =>
      /\/versions\/[^/]+\.md$/.test(read.path)
    ).length,
    record
  };
}

function summarizeSamples(samples) {
  const firstUsable = samples.map((sample) => sample.firstUsableMs);
  const secondary = samples.map((sample) => sample.secondaryCompleteMs);
  const longestTasks = samples.map((sample) => sample.longestTaskMs);
  return {
    samples: samples.length,
    firstUsableMs: summarizeNumbers(firstUsable),
    secondaryCompleteMs: summarizeNumbers(secondary),
    longestTaskMs: summarizeNumbers(longestTasks),
    medianReads: median(samples.map((sample) => sample.readCount)),
    medianBytesRead: median(samples.map((sample) => sample.bytesRead)),
    medianWrites: median(samples.map((sample) => sample.writeCount)),
    medianReactRenders: median(
      samples.map((sample) => sample.record.counters.react_render_count ?? 0)
    ),
    medianReactCommits: median(
      samples.map((sample) => sample.record.counters.react_commit_count ?? 0)
    ),
    medianProjectionPasses: median(
      samples.map(
        (sample) => sample.record.counters.comment_projection_pass_count ?? 0
      )
    ),
    medianRailLayoutPasses: median(
      samples.map(
        (sample) => sample.record.counters.comment_rail_layout_pass_count ?? 0
      )
    ),
    phaseMedianMs: summarizePhaseDurations(samples)
  };
}

function summarizePhaseDurations(samples) {
  const names = new Set(
    samples.flatMap((sample) => Object.keys(sample.record.durations))
  );
  return Object.fromEntries(
    [...names].sort().map((name) => [
      name,
      round(median(samples.map((sample) => sample.record.durations[name] ?? 0)))
    ])
  );
}

function summarizeNumbers(values) {
  return {
    median: round(median(values)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values))
  };
}

function median(values) {
  return percentile(values, 0.5);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function resetMeasurementState(client) {
  await evaluate(client, {
    expression: `(() => {
      window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.clear();
      window.__patchmarkFixtureReadLog?.splice(0);
      window.__patchmarkFixtureWriteLog?.splice(0);
      window.__patchmarkSwitchLongTasks?.splice(0);
      window.__patchmarkSwitchMeasurementStartedAt = performance.now();
      return true;
    })()`
  });
}

async function readMeasurementState(client) {
  return evaluate(client, {
    expression: `({
      longTasks: window.__patchmarkSwitchLongTasks ?? [],
      measurementStartedAt: window.__patchmarkSwitchMeasurementStartedAt ?? 0,
      reads: window.__patchmarkFixtureReadLog ?? [],
      writes: window.__patchmarkFixtureWriteLog ?? []
    })`
  });
}

async function waitForSwitchRecord(client, targetTitle, requireSecondary) {
  let latestRecords = [];
  for (let attempt = 0; attempt < 600; attempt += 1) {
    latestRecords = await evaluate(client, {
      expression: `window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.getRecords() ?? []`
    });
    const activeTitle = await readActiveDocumentTitle(client);
    const record = latestRecords.at(-1);
    if (
      activeTitle === targetTitle &&
      record?.marks?.first_usable_editor !== undefined &&
      (!requireSecondary || record?.marks?.secondary_work_complete !== undefined)
    ) {
      return record;
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for switch to ${targetTitle}. ${JSON.stringify(
      latestRecords.at(-1),
      null,
      2
    )}`
  );
}

async function waitForCondition(client, expression, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await evaluate(client, { expression })) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForTargetEditor(client, targetTitle) {
  const expression = `(() => {
      const activeTitle = document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent;
      const visualEditor = document.querySelector(".patchmark-prose");
      const sourceEditor = document.querySelector(".markdown-source-editor");
      return activeTitle === ${JSON.stringify(targetTitle)} && (
        (visualEditor?.textContent?.includes(${JSON.stringify(targetTitle)}) &&
          visualEditor.getAttribute("contenteditable") !== "false") ||
        (sourceEditor?.value?.includes(${JSON.stringify(`# ${targetTitle}`)}) &&
          !sourceEditor.readOnly)
      );
    })()`;
  try {
    await waitForCondition(
      client,
      expression,
      `usable target editor for ${targetTitle}`
    );
  } catch (error) {
    const state = await evaluate(client, {
      expression: `({
        activeTitle: document.querySelector(
          ".project-document-item[data-active='true'] .project-document-select span"
        )?.textContent ?? null,
        cache: window.__PATCHMARK_DOCUMENT_SWITCH_CACHE__ ?? null,
        requestedTitle: document.querySelector(
          ".project-document-item[data-requested='true'] .project-document-select span"
        )?.textContent ?? null,
        sourceStart: document.querySelector(".markdown-source-editor")?.value?.slice(0, 120) ?? null,
        visualStart: document.querySelector(".patchmark-prose")?.textContent?.slice(0, 120) ?? null
      })`
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(
        state
      )}`
    );
  }
}

async function clickDocument(client, title) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".project-document-select"))
        .find((candidate) => candidate.querySelector("span")?.textContent === ${JSON.stringify(
          title
        )});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not request ${title}.`);
}

async function ensureActiveDocument(client, title) {
  if ((await readActiveDocumentTitle(client)) !== title) {
    await measureSwitch(client, title);
  }
}

async function ensureMarkdownMode(client) {
  if (
    await evaluate(client, {
      expression: `Boolean(document.querySelector(".markdown-source-editor"))`
    })
  ) {
    return;
  }
  await clickButtonByText(client, "Markdown Mode");
  await waitForCondition(
    client,
    `Boolean(document.querySelector(".markdown-source-editor"))`,
    "Markdown Mode"
  );
}

async function toggleGroup(client, title) {
  const clicked = await evaluate(client, {
    expression: `(() => {
      const header = Array.from(document.querySelectorAll(".project-document-group-header"))
        .find((candidate) => candidate.querySelector("strong")?.textContent === ${JSON.stringify(
          title
        )});
      const button = header?.querySelector(":scope > button");
      if (!button) return false;
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  assert.equal(clicked, true, `Could not toggle ${title}.`);
}

async function waitForGroupExpanded(client, title, expanded) {
  await waitForCondition(
    client,
    `Array.from(document.querySelectorAll(".project-document-group-header"))
      .find((candidate) => candidate.querySelector("strong")?.textContent === ${JSON.stringify(
        title
      )})
      ?.querySelector(":scope > button")?.getAttribute("aria-expanded") === ${JSON.stringify(
        String(expanded)
      )}`,
    `${title} expanded ${String(expanded)}`
  );
}

async function updateFixtureMarkdownWithValidCommit(
  client,
  markdownPath,
  commitPath,
  marker
) {
  const result = await evaluate(client, {
    expression: `(async () => {
      const markdownPath = ${JSON.stringify(markdownPath)};
      const commitPath = ${JSON.stringify(commitPath)};
      const nextMarkdown = (await window.__patchmarkFixtureReadFile(markdownPath)) +
        "\\n${marker}\\n";
      const hashBytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(nextMarkdown)
      );
      const sha256 = Array.from(new Uint8Array(hashBytes))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const commit = JSON.parse(await window.__patchmarkFixtureReadFile(commitPath));
      commit.files.document = {
        ...commit.files.document,
        bytes: new TextEncoder().encode(nextMarkdown).byteLength,
        sha256
      };
      await window.__patchmarkFixtureSetFile(markdownPath, nextMarkdown);
      await window.__patchmarkFixtureSetFile(
        commitPath,
        JSON.stringify(commit, null, 2) + "\\n"
      );
      return { bytes: nextMarkdown.length, sha256 };
    })()`
  });
  assert.ok(result?.sha256, "The external fixture update must produce a hash.");
}

async function readActiveDocumentTitle(client) {
  return evaluate(client, {
    expression: `document.querySelector(".project-document-item[data-active='true'] .project-document-select span")?.textContent ?? null`
  });
}

async function readAvailableDocumentTitles(client) {
  return evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".project-document-item:not([data-missing='true']) .project-document-select span"))
      .map((element) => element.textContent)`
  });
}

async function appendMarkdown(client, suffix) {
  await evaluate(client, {
    expression: `(() => {
      const editor = document.querySelector(".markdown-source-editor");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(editor, editor.value + ${JSON.stringify(suffix)});
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: ${JSON.stringify(suffix)},
        inputType: "insertText"
      }));
      return true;
    })()`,
    userGesture: true
  });
}

function readProjectFixtureSummary(root, title) {
  const project = JSON.parse(
    readFileSync(join(root, ".patchmark", "project.json"), "utf8")
  );
  const document = project.documents.find(
    (candidate) => candidate.display_title === title
  );
  assert.ok(document, `Could not find fixture document ${title}.`);
  const store = join(root, ".patchmark", "documents", document.document_id);
  const markdown = readFileSync(join(root, document.path), "utf8");
  const comments = JSON.parse(readFileSync(join(store, "comments.json"), "utf8"));
  const patches = JSON.parse(readFileSync(join(store, "patches.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(store, "manifest.json"), "utf8"));
  return {
    comments: comments.length,
    documentBytes: Buffer.byteLength(markdown),
    documentCharacters: markdown.length,
    patches: patches.length,
    replies: comments.reduce(
      (total, comment) => total + (comment.thread?.length ?? 0),
      0
    ),
    versions: manifest.versions?.length ?? 0
  };
}

function createLongTaskObserverScript() {
  return `(() => {
    window.__patchmarkSwitchLongTasks = [];
    window.__patchmarkSwitchMeasurementStartedAt = 0;
    if (typeof PerformanceObserver === "function") {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__patchmarkSwitchLongTasks.push({
              duration: entry.duration,
              startTime: entry.startTime
            });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch {}
    }
  })();`;
}

function addPerformanceQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("patchmarkSwitchPerformance", "1");
  return parsed.toString();
}

function createStrategyScaleFixture(root) {
  const now = "2026-07-01T09:00:00.000Z";
  mkdirSync(join(root, ".patchmark", "documents"), { recursive: true });
  const missingDocument = createDocumentStore({
    displayTitle: "Missing Appendix",
    documentId: "doc_missing",
    groupId: "group_research",
    large: false,
    now,
    path: "missing-appendix.md",
    position: 2000,
    projectId: "prj_strategy_performance",
    root,
    role: "evidence"
  });
  rmSync(join(root, missingDocument.path));
  const documents = [
    createDocumentStore({
      displayTitle: "Action Plan",
      documentId: "doc_action",
      groupId: "group_strategy",
      large: true,
      now,
      path: "action-plan.md",
      position: 1000,
      projectId: "prj_strategy_performance",
      root,
      role: "decision"
    }),
    createDocumentStore({
      displayTitle: "Ready-to-Eat Channel Research",
      documentId: "doc_rte",
      groupId: "group_research",
      large: true,
      now,
      path: "ready-to-eat-channel-research.md",
      position: 1000,
      projectId: "prj_strategy_performance",
      root,
      role: "research",
      withBookmark: true
    }),
    createDocumentStore({
      displayTitle: "Business Dimensions Framework",
      documentId: "doc_dimensions",
      groupId: "group_strategy",
      large: false,
      now,
      path: "business-dimensions-framework.md",
      position: 2000,
      projectId: "prj_strategy_performance",
      root,
      role: "summary"
    }),
    missingDocument
  ];
  writeFileSync(
    join(root, ".patchmark", "project.json"),
    serializeJson({
      format: "patchmark-project",
      schema_version: 2,
      project_id: "prj_strategy_performance",
      title: "Strategy Performance",
      created_at: now,
      manifest_revision: 1,
      groups: [
        {
          group_id: "group_strategy",
          title: "Strategy",
          position: 1000,
          created_at: now
        },
        {
          group_id: "group_research",
          title: "Research",
          position: 2000,
          created_at: now
        }
      ],
      documents
    })
  );
}

function createDocumentStore({
  displayTitle,
  documentId,
  groupId,
  large,
  now,
  path,
  position,
  projectId,
  root,
  role,
  withBookmark = false
}) {
  const markdown = createStressMarkdown(displayTitle, documentId, large);
  const comments = createStressComments(markdown, documentId, large, now);
  const patches = createStressPatches(documentId, large, now);
  const versionCount = large ? 49 : 4;
  const store = join(root, ".patchmark", "documents", documentId);
  mkdirSync(join(store, "versions"), { recursive: true });
  mkdirSync(join(store, "context-packs"), { recursive: true });
  mkdirSync(join(store, "imports"), { recursive: true });
  mkdirSync(join(store, "recovery"), { recursive: true });
  writeFileSync(join(root, path), markdown);
  const versions = Array.from({ length: versionCount }, (_, index) => {
    const id = `PM-SNAPSHOT-${String(index + 1).padStart(3, "0")}`;
    const file = `.patchmark/versions/${id}.md`;
    writeFileSync(
      join(store, "versions", `${id}.md`),
      `${markdown}\nHistorical version ${index + 1}.\n`
    );
    return { id, file, created_at: now, reason: `fixture version ${index + 1}` };
  });
  const commitId = `PM-SAVE-000007-${documentId}`;
  const bookmarkPhrase = `Anchor phrase 5 for ${documentId}.`;
  const manifest = {
    schema_version: 1,
    project_id: projectId,
    document_id: documentId,
    project_name: displayTitle,
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    current_version: versions.at(-1)?.id,
    versions,
    save_generation: 7,
    save_commit_id: commitId,
    ...(withBookmark
      ? {
          reading_bookmark: {
            format_version: 1,
            document: { project_id: projectId, document_id: documentId },
            anchor: {
              kind: "selected_text",
              selected_text: bookmarkPhrase,
              markdown_start_offset: markdown.indexOf(bookmarkPhrase),
              markdown_end_offset:
                markdown.indexOf(bookmarkPhrase) + bookmarkPhrase.length,
              anchor_source: "markdown"
            },
            created_at: now,
            updated_at: now
          }
        }
      : {})
  };
  const commentsText = serializeJson(comments);
  const patchesText = serializeJson(patches);
  const manifestText = serializeJson(manifest);
  writeFileSync(join(store, "comments.json"), commentsText);
  writeFileSync(join(store, "patches.json"), patchesText);
  writeFileSync(join(store, "manifest.json"), manifestText);
  writeFileSync(join(store, "tasks.json"), "[]\n");
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
        manifest: descriptor(".patchmark/manifest.json", manifestText)
      }
    })
  );
  return {
    document_id: documentId,
    path,
    display_title: displayTitle,
    group_id: groupId,
    role,
    status: "active",
    position,
    added_at: now,
    archived_at: null
  };
}

function createStressMarkdown(title, documentId, large) {
  const commentCount = large ? 31 : 5;
  const patchCount = large ? 59 : 8;
  const sectionCount = large ? 85 : 12;
  const lines = [`# ${title}`, "", `Document fixture ${documentId}.`, ""];
  for (let index = 0; index < commentCount; index += 1) {
    lines.push(
      `## Review Area ${index + 1}`,
      "",
      `Anchor phrase ${index + 1} for ${documentId}. This paragraph carries unique review context and enough surrounding language for deterministic selected-text projection.`,
      ""
    );
  }
  lines.push("## Patch Targets", "");
  for (let index = 0; index < patchCount; index += 1) {
    lines.push(`Patch target ${index + 1} for ${documentId} remains uniquely actionable.`);
  }
  for (let index = 0; index < sectionCount; index += 1) {
    lines.push(
      "",
      `## Operating Dimension ${index + 1}`,
      "",
      `This is a substantial strategy paragraph ${index + 1} for ${documentId}. `.repeat(
        large ? 12 : 3
      ),
      "",
      "| Dimension | Signal | Decision |",
      "| --- | --- | --- |",
      `| Channel ${index + 1} | [Evidence](https://example.com/${documentId}/${index + 1}) | Continue measured validation |`,
      `| Risk ${index + 1} | Market variability | Keep a reversible checkpoint |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function createStressComments(markdown, documentId, large, now) {
  const commentCount = large ? 31 : 5;
  return Array.from({ length: commentCount }, (_, index) => {
    const selectedText = `Anchor phrase ${index + 1} for ${documentId}.`;
    const start = markdown.indexOf(selectedText);
    const replyCount = large ? (index < 16 ? 8 : 7) : 2;
    return {
      id: `PM-COMMENT-${String(index + 1).padStart(3, "0")}`,
      type: index % 4 === 0 ? "risk" : "note",
      status: "open",
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
        containing_heading: `Review Area ${index + 1}`,
        anchor_source: "markdown"
      },
      comment: `Review thread ${index + 1} for ${documentId}.`,
      thread: Array.from({ length: replyCount }, (_, replyIndex) => ({
        id: `PM-REPLY-${String(index + 1).padStart(3, "0")}-${String(
          replyIndex + 1
        ).padStart(2, "0")}`,
        role: replyIndex % 2 === 0 ? "user" : "chatgpt",
        content: `Detailed reply ${replyIndex + 1} for comment ${index + 1}. `.repeat(6),
        created_at: now
      })),
      export_state: { focus_state: "idle" },
      created_at: now,
      updated_at: now
    };
  });
}

function createStressPatches(documentId, large, now) {
  const patchCount = large ? 59 : 8;
  const commentCount = large ? 31 : 5;
  return Array.from({ length: patchCount }, (_, index) => ({
    id: `PM-PATCH-${String(index + 1).padStart(3, "0")}`,
    status: "pending",
    comment_id: `PM-COMMENT-${String((index % commentCount) + 1).padStart(
      3,
      "0"
    )}`,
    display_title: `Patch proposal ${index + 1}`,
    target_heading: "Patch Targets",
    original_text: `Patch target ${index + 1} for ${documentId} remains uniquely actionable.`,
    suggested_text: `Patch target ${index + 1} for ${documentId} is now validated and actionable.`,
    reason: `Measured recommendation ${index + 1}. `.repeat(5),
    risk: "Preserve rollback and document identity guarantees.",
    created_at: now
  }));
}

function descriptor(path, text) {
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text)
  };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

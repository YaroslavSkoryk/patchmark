import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
import { createDocumentSwitchProject } from "./lib/fixtures/create-document-switch-project.mjs";

const editorUrl = addPerformanceQuery(
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/"
);
const sampleCount = Number(process.env.PATCHMARK_SWITCH_SAMPLES ?? 6);
const stressTransitions = Number(
  process.env.PATCHMARK_SWITCH_STRESS_TRANSITIONS ?? 60
);
const outputPath = process.env.PATCHMARK_SWITCH_PERFORMANCE_OUTPUT;
const expectOptimized =
  process.env.PATCHMARK_SWITCH_EXPECT_OPTIMIZED !== "0";
const expectAtomic = process.env.PATCHMARK_SWITCH_EXPECT_ATOMIC !== "0";
const projectDir = mkdtempSync(join(tmpdir(), "patchmark-switch-performance-"));
const fixtureContract = createDocumentSwitchProject(projectDir, {
  bookmarkDocumentIndex: 1,
  commentCountPerDocument: 31,
  documentCount: 3,
  documentProfiles: [
    {
      codeBlockCount: 24,
      commentCount: 31,
      headingCount: 4,
      historyCount: 49,
      paragraphCount: 90,
      paragraphRepeatCount: 8,
      patchCount: 59,
      structuredCellRepeatCount: 3,
      structuredTableCount: 26,
      structuredTableRowsPerTable: 9
    },
    {
      commentCount: 17,
      headingCount: 7,
      historyCount: 37,
      paragraphCount: 70,
      paragraphRepeatCount: 6,
      patchCount: 41,
      structuredCellRepeatCount: 4,
      structuredTableCount: 26,
      structuredTableRowsPerTable: 9
    },
    {
      commentCount: 0,
      headingCount: 3,
      historyCount: 3,
      paragraphCount: 12,
      paragraphRepeatCount: 2,
      patchCount: 0
    }
  ],
  historyCountPerDocument: 49,
  includeMissingDocument: true,
  paragraphCountPerDocument: 85,
  paragraphRepeatCount: 12,
  patchCountPerDocument: 59,
  seed: "document-switch-browser-v1"
});

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
    persistWrites: true
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
        projectName: fixtureContract.projectTitle
      })}\n${createLongTaskObserverScript()}\n${createDocumentSwitchConsistencyObserverScript()}`
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
    assert.deepEqual(
      [...titles].sort(),
      fixtureContract.documents.map((document) => document.displayTitle).sort(),
      "The browser must expose the exact deterministic document set."
    );
    const [firstDocument, secondDocument, thirdDocument] =
      fixtureContract.documents;
    const firstTitle = firstDocument.displayTitle;
    const secondTitle = secondDocument.displayTitle;
    const thirdTitle = thirdDocument.displayTitle;
    await ensureActiveDocument(client, firstTitle);
    await assertActiveDocumentIdentity(client, firstDocument);
    const cold = await measureSwitch(client, secondTitle, {
      sourceDocument: firstDocument,
      targetDocument: secondDocument
    });
    assert.ok(
      cold.record.marks.target_preview_visible <
        cold.record.marks.first_usable_editor,
      "A structured Visual Mode target must become visibly readable before its editor hydration completes."
    );
    assert.ok(
      cold.record.marks.target_preview_visible < 1_000,
      `The target-content preview took ${cold.record.marks.target_preview_visible} ms to appear.`
    );
    await assertDocumentScopedSurface(client, secondDocument);
    const currentDocumentRequest = await assertCurrentDocumentRequestIsNoop(
      client,
      secondDocument
    );
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
    const largeFirstToSecondSamples = [];
    const largeSecondToFirstSamples = [];
    let nextTitle = firstTitle;
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = await measureSwitch(client, nextTitle);
      warmSamples.push(sample);
      (nextTitle === firstTitle
        ? largeSecondToFirstSamples
        : largeFirstToSecondSamples
      ).push(sample);
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
    const largeToSmallSamples = [];
    const smallToLargeSamples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      largeToSmallSamples.push(await measureSwitch(client, thirdTitle));
      await assertDocumentScopedSurface(client, thirdDocument);
      smallToLargeSamples.push(await measureSwitch(client, secondTitle));
      await assertDocumentScopedSurface(client, secondDocument);
    }

    const openSurfaceSwitch = await measureOpenSurfaceSwitch(
      client,
      firstDocument
    );

    await ensureActiveDocument(client, secondTitle);
    await clickButtonByText(client, "Markdown Mode");
    await waitForCondition(
      client,
      `Boolean(document.querySelector(".markdown-source-editor"))`,
      "Markdown Mode"
    );
    const dirtyMarker = "Deterministic dirty switch marker.";
    await appendMarkdown(client, `\n${dirtyMarker}\n`);
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
    const rapid = await measureRapidSwitch(
      client,
      firstDocument,
      secondDocument,
      thirdDocument
    );
    assert.equal(rapid.activeTitle, thirdTitle, "The latest rapid switch must win.");

    const missing = await measureMissingSwitch(
      client,
      fixtureContract.missingDocument.displayTitle,
      fixtureContract.missingDocument.documentId
    );
    assert.equal(missing.writeCount, 0, "A missing target must not cause writes.");
    assert.equal(
      missing.unrelatedDocumentReadCount,
      0,
      "A missing target must not load unrelated document stores."
    );

    await measureSwitch(client, firstTitle);
    await toggleGroup(client, fixtureContract.bookmarkGroupTitle);
    await waitForGroupExpanded(client, fixtureContract.bookmarkGroupTitle, false);
    const bookmark = await measureBookmarkSwitch(client, secondTitle);
    assert.equal(bookmark.record.metadata.trigger, "bookmark");
    assert.equal(bookmark.writeCount, 0, "Group expansion must remain local UI state.");
    await waitForGroupExpanded(client, fixtureContract.bookmarkGroupTitle, true);

    await ensureMarkdownMode(client);
    const failedSaveMarker = "Deterministic failed-save marker.";
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
    const externalMarker = "Deterministic external-change marker.";
    await updateFixtureMarkdownWithValidCommit(
      client,
      firstDocument.path,
      firstDocument.saveCommitPath,
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
    const versionHistory = await verifyVersionHistoryMetadata(
      client,
      firstDocument.historyCount
    );

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
    const reload = await verifyReloadBoundary(client, {
      dirtyMarker,
      firstDocument,
      secondDocument
    });

    const summary = {
      source: "deterministic_document_switch_fixture",
      expectAtomic,
      expectOptimized,
      fixture: readProjectFixtureSummary(projectDir, firstTitle),
      documents: fixtureContract.documents.map((document) => ({
        documentId: document.documentId,
        title: document.displayTitle
      })),
      cold: summarizeSamples([cold]),
      currentDocumentRequest,
      warm: summarizeSamples(warmSamples),
      largeFirstToSecond: summarizeSamples(largeFirstToSecondSamples),
      largeSecondToFirst: summarizeSamples(largeSecondToFirstSamples),
      largeToSmall: summarizeSamples(largeToSmallSamples),
      smallToLarge: summarizeSamples(smallToLargeSamples),
      openSurfaceSwitch,
      dirty: summarizeSamples([dirty]),
      rapid,
      bookmark: summarizeSamples([bookmark]),
      externalChange: summarizeSamples([externalChange]),
      missing,
      reload,
      saveFailure,
      saveRetry: summarizeSamples([saveRetry]),
      versionHistory,
      stress: {
        transitions: stressTransitions,
        derivedStateCacheSize,
        firstUsableSeriesMs: stressSamples.map((sample) =>
          round(sample.firstUsableMs)
        ),
        firstToSecond: summarizeSamples(
          stressSamples.filter((_, index) => index % 2 === 0)
        ),
        secondToFirst: summarizeSamples(
          stressSamples.filter((_, index) => index % 2 === 1)
        ),
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
    void fixtureServer.forceClose().catch((error) => {
      process.stderr.write(`Fixture server cleanup failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
    rmSync(userDataDir, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  }
}

async function measureSwitch(client, targetTitle, consistency) {
  await resetMeasurementState(client);
  if (consistency) {
    await startConsistencyObservation(client, consistency);
  }
  const requestedAt = performance.now();
  await clickDocument(client, targetTitle);
  await waitForTargetEditor(client, targetTitle);
  const observedFirstUsableMs = performance.now() - requestedAt;
  const record = await waitForSwitchRecord(client, targetTitle, true);
  const wallTime = performance.now() - requestedAt;
  const state = await readMeasurementState(client);
  const measurement = createMeasurement(
    record,
    state,
    observedFirstUsableMs,
    wallTime
  );
  if (!consistency) {
    return measurement;
  }
  const observedStates = await stopConsistencyObservation(client);
  if (expectAtomic) {
    assertAtomicSwitchStates(observedStates, consistency);
  }
  return { ...measurement, consistency: summarizeConsistency(observedStates) };
}

async function assertCurrentDocumentRequestIsNoop(client, document) {
  const recordsBefore = await evaluate(client, {
    expression: `window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.getRecords().length ?? 0`
  });
  const activeControl = await evaluate(client, {
    expression: `(() => {
      const button = Array.from(
        document.querySelectorAll(".project-document-select")
      ).find((candidate) =>
        candidate.textContent?.includes(${JSON.stringify(document.displayTitle)})
      );
      button?.click();
      return { disabled: button?.disabled ?? null, found: Boolean(button) };
    })()`
  });
  assert.equal(activeControl.found, true, "The active document control must exist.");
  assert.equal(
    activeControl.disabled,
    true,
    "The committed document control must remain a disabled no-op."
  );
  await assertActiveDocumentIdentity(client, document);
  const state = await evaluate(client, {
    expression: `({
      records: window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.getRecords().length ?? 0,
      requested: document.querySelector(
        ".project-document-item[data-requested='true']"
      ) !== null
    })`
  });
  assert.equal(
    state.records,
    recordsBefore,
    "Requesting the committed document must not start another switch."
  );
  assert.equal(
    state.requested,
    false,
    "Requesting the committed document must not create pending state."
  );
  return { operationCount: state.records, requested: state.requested };
}

async function measureOpenSurfaceSwitch(client, targetDocument) {
  const surfacesFound = await evaluate(client, {
    expression: `(() => {
      const comments = document.querySelector(".application-comments-trigger");
      if (comments?.getAttribute("aria-expanded") !== "true") comments?.click();
      const tools = document.querySelector(".document-tools");
      if (tools instanceof HTMLDetailsElement) tools.open = true;
      return {
        comments: Boolean(comments),
        tools: tools instanceof HTMLDetailsElement
      };
    })()`
  });
  assert.deepEqual(
    surfacesFound,
    { comments: true, tools: true },
    "Comments and document tools must exist before this switch."
  );
  await waitForCondition(
    client,
    `document.querySelector(".application-comments-trigger")
        ?.getAttribute("aria-expanded") === "true" &&
      document.querySelector(".document-tools")?.hasAttribute("open") === true`,
    "open comments and document tools"
  );
  const measurement = await measureSwitch(client, targetDocument.displayTitle);
  await assertDocumentScopedSurface(client, targetDocument);
  const settled = await evaluate(client, {
    expression: `({
      comments: document.querySelector(".application-comments-trigger")
        ?.getAttribute("aria-expanded") === "true",
      tools: document.querySelector(".document-tools")?.hasAttribute("open") === true
    })`
  });
  assert.equal(
    settled.comments,
    true,
    "The open comments surface must remain coherent after switching."
  );
  return {
    commentsOpen: settled.comments,
    firstUsableMs: round(measurement.firstUsableMs),
    toolsOpen: settled.tools
  };
}

async function measureRapidSwitch(
  client,
  sourceDocument,
  intermediateDocument,
  targetDocument
) {
  await resetMeasurementState(client);
  await startConsistencyObservation(client, {
    sourceDocument,
    targetDocument
  });
  await clickDocument(client, intermediateDocument.displayTitle);
  await waitForCondition(
    client,
    `document.querySelector(
      ".project-document-item[data-requested='true'] .project-document-select span"
    )?.textContent === ${JSON.stringify(intermediateDocument.displayTitle)}`,
    "intermediate rapid switch request"
  );
  await clickDocument(client, targetDocument.displayTitle);
  await waitForTargetEditor(client, targetDocument.displayTitle);
  const record = await waitForSwitchRecord(
    client,
    targetDocument.displayTitle,
    true
  );
  const allRecords = await evaluate(client, {
    expression: `window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?.getRecords() ?? []`
  });
  const observedStates = await stopConsistencyObservation(client);
  if (expectAtomic) {
    assertAtomicSwitchStates(observedStates, {
      sourceDocument,
      targetDocument
    });
  }
  const intermediateCommittedStates = observedStates.filter(
    (state) =>
      state.activeTitle === intermediateDocument.displayTitle ||
      state.documentMeta?.includes(intermediateDocument.displayTitle) ||
      state.notification?.includes(
        `Opened ${intermediateDocument.displayTitle}.`
      )
  );
  if (expectAtomic) {
    assert.deepEqual(
      intermediateCommittedStates,
      [],
      `Rapid switching visibly committed the superseded intermediate document. ${JSON.stringify(
        intermediateCommittedStates.slice(0, 6),
        null,
        2
      )}`
    );
  }
  return {
    activeTitle: await readActiveDocumentTitle(client),
    completedTargetId: record.metadata.targetDocumentId,
    consistency: summarizeConsistency(observedStates),
    intermediateCommitted: intermediateCommittedStates.length > 0,
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

async function measureMissingSwitch(client, targetTitle, targetDocumentId) {
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
      (read) => !read.path.includes(targetDocumentId)
    ).length,
    writeCount: state.writes.length
  };
}

async function verifyReloadBoundary(
  client,
  { dirtyMarker, firstDocument, secondDocument }
) {
  await client.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForCondition(
    client,
    `document.querySelectorAll(".project-document-item").length === ${fixtureContract.documents.length + 1}`,
    "deterministic project after reload"
  );
  await ensureActiveDocument(client, firstDocument.displayTitle);
  await measureSwitch(client, secondDocument.displayTitle);
  const markerCount = await evaluate(client, {
    expression: `(() => {
      const text = document.querySelector(".markdown-source-editor")?.value ??
        document.querySelector(".patchmark-prose")?.textContent ?? "";
      return text.split(${JSON.stringify(dirtyMarker)}).length - 1;
    })()`
  });
  assert.equal(markerCount, 1, "Reload must preserve the dirty-switch save exactly once.");
  await assertActiveDocumentIdentity(client, secondDocument);
  return {
    activeDocumentId: secondDocument.documentId,
    dirtyMarkerCount: markerCount,
    persisted: true
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
    previewVisibleMs: record.marks.target_preview_visible,
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
  const previewVisible = samples
    .map((sample) => sample.previewVisibleMs)
    .filter(Number.isFinite);
  const secondary = samples.map((sample) => sample.secondaryCompleteMs);
  const longestTasks = samples.map((sample) => sample.longestTaskMs);
  const consistency = samples.find((sample) => sample.consistency)?.consistency;
  return {
    samples: samples.length,
    ...(consistency ? { consistency } : {}),
    firstUsableMs: summarizeNumbers(firstUsable),
    ...(previewVisible.length > 0
      ? { previewVisibleMs: summarizeNumbers(previewVisible) }
      : {}),
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
  const targetDocument = fixtureContract.documents.find(
    (document) => document.displayTitle === targetTitle
  );
  assert.ok(targetDocument, `Unknown deterministic target ${targetTitle}.`);
  const unrelatedSentinels = fixtureContract.documents
    .filter((document) => document.documentId !== targetDocument.documentId)
    .map((document) => document.sentinel);
  const expression = `(() => {
      const activeTitle = document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent;
      const documentKey = document.querySelector(".editor-body")?.getAttribute(
        "data-document-key"
      );
      const visualEditor = document.querySelector(".patchmark-prose");
      const sourceEditor = document.querySelector(".markdown-source-editor");
      const editorText = visualEditor?.textContent ?? sourceEditor?.value ?? "";
      return activeTitle === ${JSON.stringify(targetTitle)} &&
        documentKey === ${JSON.stringify(targetDocument.documentKey)} &&
        editorText.includes(${JSON.stringify(targetTitle)}) &&
        editorText.includes(${JSON.stringify(targetDocument.sentinel)}) &&
        !${JSON.stringify(unrelatedSentinels)}.some((sentinel) =>
          editorText.includes(sentinel)
        ) && (
          (visualEditor && visualEditor.getAttribute("contenteditable") !== "false") ||
          (sourceEditor && !sourceEditor.readOnly)
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
        documentKey: document.querySelector(".editor-body")?.getAttribute("data-document-key") ?? null,
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

async function assertActiveDocumentIdentity(client, document) {
  const state = await evaluate(client, {
    expression: `({
      documentKey: document.querySelector(".editor-body")?.getAttribute("data-document-key") ?? null,
      title: document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent ?? null
    })`
  });
  assert.deepEqual(state, {
    documentKey: document.documentKey,
    title: document.displayTitle
  });
}

async function assertDocumentScopedSurface(client, document) {
  const state = await evaluate(client, {
    expression: `({
      comments: Number(
        document.querySelector(".application-comments-count")?.textContent ??
          "NaN"
      ),
      tools: document.querySelector(".document-tools summary small")
        ?.textContent?.trim() ?? null
    })`
  });
  assert.equal(
    state.comments,
    document.commentCount,
    `${document.displayTitle} must expose only its comment count.`
  );
  assert.ok(
    state.tools?.startsWith(`${document.headingCount} heading`),
    `${document.displayTitle} must expose only its heading count. ${state.tools}`
  );
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

async function startConsistencyObservation(
  client,
  { sourceDocument, targetDocument }
) {
  await evaluate(client, {
    expression: `window.__patchmarkDocumentSwitchConsistency.start(${JSON.stringify(
      {
        sourceDocument: {
          commentCount: sourceDocument.commentCount,
          documentKey: sourceDocument.documentKey,
          headingCount: sourceDocument.headingCount,
          sentinel: sourceDocument.sentinel,
          title: sourceDocument.displayTitle
        },
        targetDocument: {
          commentCount: targetDocument.commentCount,
          documentKey: targetDocument.documentKey,
          headingCount: targetDocument.headingCount,
          sentinel: targetDocument.sentinel,
          title: targetDocument.displayTitle
        }
      }
    )})`
  });
}

async function stopConsistencyObservation(client) {
  return evaluate(client, {
    expression: `window.__patchmarkDocumentSwitchConsistency.stop()`
  });
}

function assertAtomicSwitchStates(
  observedStates,
  { sourceDocument, targetDocument }
) {
  const mixedStates = observedStates.filter(
    (state) =>
      state.targetChromeCommitted &&
      state.sourceFingerprintVisible &&
      !state.targetFingerprintVisible
  );
  const prematureNotifications = observedStates.filter(
    (state) =>
      state.targetOpenedNotification && !state.targetFingerprintVisible
  );
  const stalePreviews = observedStates.filter(
    (state) => state.stalePreviewVisible
  );
  const staleInteractiveStates = mixedStates.filter(
    (state) => !state.saveChangesDisabled || !state.createSnapshotDisabled
  );
  const misleadingTargetStates = observedStates.filter(
    (state) =>
      state.targetChromeCommitted &&
      !state.targetFingerprintVisible &&
      (!state.switchingStateVisible ||
        !state.saveChangesDisabled ||
        !state.createSnapshotDisabled)
  );

  assert.deepEqual(
    mixedStates,
    [],
    `Document switching exposed ${targetDocument.displayTitle} chrome with ${sourceDocument.displayTitle} editor content. ${JSON.stringify(
      mixedStates.slice(0, 6),
      null,
      2
    )}`
  );
  assert.deepEqual(
    prematureNotifications,
    [],
    `The Opened notification preceded the target editor fingerprint. ${JSON.stringify(
      prematureNotifications.slice(0, 6),
      null,
      2
    )}`
  );
  assert.deepEqual(
    staleInteractiveStates,
    [],
    `Document actions became interactive against stale editor content. ${JSON.stringify(
      staleInteractiveStates.slice(0, 6),
      null,
      2
    )}`
  );
  assert.deepEqual(
    stalePreviews,
    [],
    `The target preview exposed ${sourceDocument.displayTitle} content. ${JSON.stringify(
      stalePreviews.slice(0, 6),
      null,
      2
    )}`
  );
  assert.deepEqual(
    misleadingTargetStates,
    [],
    `Target chrome appeared without either ready target content or an explicit protected switching state. ${JSON.stringify(
      misleadingTargetStates.slice(0, 6),
      null,
      2
    )}`
  );
}

function summarizeConsistency(observedStates) {
  return {
    mixedVisibleStateCount: observedStates.filter(
      (state) =>
        state.targetChromeCommitted &&
        state.sourceFingerprintVisible &&
        !state.targetFingerprintVisible
    ).length,
    observedStateCount: observedStates.length,
    prematureOpenedNotificationCount: observedStates.filter(
      (state) =>
        state.targetOpenedNotification && !state.targetFingerprintVisible
    ).length,
    stalePreviewCount: observedStates.filter(
      (state) => state.stalePreviewVisible
    ).length,
    targetPreviewObserved: observedStates.some(
      (state) => state.targetPreviewVisible
    ),
    targetCommittedBeforeFingerprint: observedStates.some(
      (state) =>
        state.targetChromeCommitted && !state.targetFingerprintVisible
    ),
    targetOpenedAfterFingerprint: observedStates
      .filter((state) => state.targetOpenedNotification)
      .every((state) => state.targetFingerprintVisible)
  };
}

function createDocumentSwitchConsistencyObserverScript() {
  return `(() => {
    let configuration = null;
    let records = [];
    let previousSignature = null;
    const observer = new MutationObserver(() => sample());

    function buttonDisabled(label) {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === label);
      return !button || button.disabled;
    }

    function sample() {
      if (!configuration) return;
      const editor = document.querySelector(".editor-body");
      const editorSurface = document.querySelector(".markdown-source-editor") ??
        document.querySelector(".visual-editor-shell");
      const editorText = document.querySelector(".markdown-source-editor")?.value ??
        document.querySelector(".patchmark-prose")?.textContent ?? "";
      const preview = document.querySelector(".document-switch-target-preview");
      const previewText = preview?.textContent ?? "";
      const previewVisible = Boolean(
        preview &&
        getComputedStyle(preview).visibility !== "hidden" &&
        getComputedStyle(preview).display !== "none"
      );
      const editorContentVisible = Boolean(
        editorSurface &&
        getComputedStyle(editorSurface).visibility !== "hidden" &&
        getComputedStyle(editorSurface).display !== "none"
      );
      const activeTitle = document.querySelector(
        ".project-document-item[data-active='true'] .project-document-select span"
      )?.textContent ?? null;
      const requestedTitle = document.querySelector(
        ".project-document-item[data-requested='true'] .project-document-select span"
      )?.textContent ?? null;
      const documentMeta = document.querySelector(".document-meta strong")
        ?.textContent?.trim() ?? null;
      const commentsCount = Number(
        document.querySelector(".application-comments-count")?.textContent ??
          "NaN"
      );
      const documentToolsSummary = document.querySelector(
        ".document-tools summary small"
      )?.textContent?.trim() ?? null;
      const notification = document.querySelector(".document-save-banner")
        ?.textContent?.trim() ?? null;
      const documentKey = editor?.getAttribute("data-document-key") ?? null;
      const targetChromeCommitted =
        activeTitle === configuration.targetDocument.title ||
        documentKey === configuration.targetDocument.documentKey ||
        documentMeta?.includes(configuration.targetDocument.title) === true ||
        (commentsCount === configuration.targetDocument.commentCount &&
          documentToolsSummary?.startsWith(
            configuration.targetDocument.headingCount + " heading"
          ) === true);
      const state = {
        activeTitle,
        commentsCount,
        createSnapshotDisabled: buttonDisabled("Create Snapshot"),
        documentKey,
        documentMeta,
        documentToolsSummary,
        notification,
        requestedTitle,
        saveChangesDisabled: buttonDisabled("Save Changes"),
        sourceFingerprintPresent: editorText.includes(
          configuration.sourceDocument.sentinel
        ),
        sourceFingerprintVisible:
          editorContentVisible &&
          editorText.includes(configuration.sourceDocument.sentinel),
        switchingStateVisible: Boolean(
          document.querySelector(".document-switch-loading")
        ),
        targetPreviewVisible:
          previewVisible &&
          previewText.includes(configuration.targetDocument.sentinel),
        stalePreviewVisible:
          previewVisible &&
          previewText.includes(configuration.sourceDocument.sentinel),
        targetChromeCommitted,
        targetFingerprintVisible:
          editorContentVisible &&
          editorText.includes(configuration.targetDocument.sentinel),
        targetOpenedNotification:
          notification?.includes(
            "Opened " + configuration.targetDocument.title + "."
          ) === true,
        timestamp: performance.now()
      };
      const signature = JSON.stringify({ ...state, timestamp: 0 });
      if (signature === previousSignature) return;
      previousSignature = signature;
      records.push(state);
    }

    window.__patchmarkDocumentSwitchConsistency = {
      start(nextConfiguration) {
        configuration = nextConfiguration;
        records = [];
        previousSignature = null;
        observer.disconnect();
        observer.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
        sample();
      },
      stop() {
        sample();
        observer.disconnect();
        const result = records;
        configuration = null;
        records = [];
        previousSignature = null;
        return result;
      }
    };
  })();`;
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

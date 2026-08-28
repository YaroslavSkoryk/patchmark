import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const warmupCount = Number(
  process.env.PATCHMARK_SWITCH_WARMUP_SAMPLES ?? 4
);
const stressTransitions = Number(
  process.env.PATCHMARK_SWITCH_STRESS_TRANSITIONS ?? 60
);
const codeBlockCount = Number(
  process.env.PATCHMARK_SWITCH_CODE_BLOCK_COUNT ?? 110
);
const structuredTableCount = Number(
  process.env.PATCHMARK_SWITCH_TABLE_COUNT ?? 26
);
const commentCount = Number(
  process.env.PATCHMARK_SWITCH_COMMENT_COUNT ?? 31
);
const historyCount = Number(
  process.env.PATCHMARK_SWITCH_HISTORY_COUNT ?? 49
);
const paragraphCount = Number(
  process.env.PATCHMARK_SWITCH_PARAGRAPH_COUNT ?? 90
);
const patchCount = Number(
  process.env.PATCHMARK_SWITCH_PATCH_COUNT ?? 59
);
const profileEditorCostOnly =
  process.env.PATCHMARK_SWITCH_PROFILE_EDITOR_COST_ONLY === "1";
const verifyFullScroll =
  process.env.PATCHMARK_SWITCH_VERIFY_FULL_SCROLL === "1";
const outputPath = process.env.PATCHMARK_SWITCH_PERFORMANCE_OUTPUT;
const checkoutLabel = process.env.PATCHMARK_SWITCH_CHECKOUT_LABEL ?? "current";
const fixtureProfile =
  process.env.PATCHMARK_SWITCH_FIXTURE_PROFILE ?? "realistic_asymmetric";
const includeRawSamples =
  process.env.PATCHMARK_SWITCH_INCLUDE_RAW_SAMPLES === "1";
const includeResourceOwnership =
  process.env.PATCHMARK_SWITCH_INCLUDE_RESOURCE_OWNERSHIP === "1";
const instrumentResources =
  process.env.PATCHMARK_SWITCH_INSTRUMENT_RESOURCES !== "0";
const quiet = process.env.PATCHMARK_SWITCH_QUIET === "1";
const serverMode = process.env.PATCHMARK_SWITCH_SERVER_MODE ?? "development-webpack";
const expectOptimized =
  process.env.PATCHMARK_SWITCH_EXPECT_OPTIMIZED !== "0";
const expectAtomic = process.env.PATCHMARK_SWITCH_EXPECT_ATOMIC !== "0";
const browserErrors = [];
const projectDir = mkdtempSync(join(tmpdir(), "patchmark-switch-performance-"));
const realisticDocumentProfiles = [
  {
    codeBlockCount,
    commentCount,
    headingCount: 4,
    historyCount,
    paragraphCount,
    paragraphRepeatCount: 8,
    patchCount,
    structuredCellRepeatCount: 3,
    structuredTableCount,
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
    structuredTableCount,
    structuredTableRowsPerTable: 9
  }
];
const equalComplexityProfile = {
  codeBlockCount,
  commentCount: 31,
  headingCount: 4,
  historyCount: 49,
  paragraphCount: 90,
  paragraphRepeatCount: 8,
  patchCount: 59,
  structuredCellRepeatCount: 3,
  structuredDelimiterWidth: 64,
  structuredTableCount,
  structuredTableRowsPerTable: 9
};
const fixtureContract = createDocumentSwitchProject(projectDir, {
  bookmarkDocumentIndex: 1,
  commentCountPerDocument: 31,
  documentCount: 3,
  documentProfiles: [
    ...(fixtureProfile === "equal_complexity"
      ? [equalComplexityProfile, equalComplexityProfile]
      : realisticDocumentProfiles),
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

if (!Number.isInteger(warmupCount) || warmupCount < 2) {
  throw new Error(
    "PATCHMARK_SWITCH_WARMUP_SAMPLES must be an integer of at least 2."
  );
}

if (!["equal_complexity", "realistic_asymmetric"].includes(fixtureProfile)) {
  throw new Error(
    "PATCHMARK_SWITCH_FIXTURE_PROFILE must be equal_complexity or realistic_asymmetric."
  );
}

if (
  !Number.isInteger(codeBlockCount) ||
  codeBlockCount < 0 ||
  codeBlockCount > 200
) {
  throw new Error(
    "PATCHMARK_SWITCH_CODE_BLOCK_COUNT must be an integer from 0 through 200."
  );
}

if (
  !Number.isInteger(structuredTableCount) ||
  structuredTableCount < 0 ||
  structuredTableCount > 60
) {
  throw new Error(
    "PATCHMARK_SWITCH_TABLE_COUNT must be an integer from 0 through 60."
  );
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
      "--enable-precise-memory-info",
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
    await client.call("HeapProfiler.enable");
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(
        exceptionDetails?.exception?.description ??
          exceptionDetails?.text ??
          "Unknown runtime exception"
      );
    });
    client.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") {
        browserErrors.push(
          event.args?.map((argument) => argument.value ?? argument.description)
            .filter(Boolean)
            .join(" ") || "Unknown console error"
        );
      }
    });
    const browserVersion = await client.call("Browser.getVersion");
    await client.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: inventory.directories,
        files: inventory.files,
        projectName: fixtureContract.projectTitle
      })}\n${createLongTaskObserverScript()}\n${createSwitchResourceObserverScript(instrumentResources)}\n${createDocumentSwitchConsistencyObserverScript()}`
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

    const warmupSamples = [];
    let warmupTitle = firstTitle;
    for (let index = 0; index < warmupCount; index += 1) {
      warmupSamples.push(await measureSwitch(client, warmupTitle));
      warmupTitle = warmupTitle === firstTitle ? secondTitle : firstTitle;
    }

    const warmSamples = [];
    const largeFirstToSecondSamples = [];
    const largeSecondToFirstSamples = [];
    let nextTitle =
      (await readActiveDocumentTitle(client)) === firstTitle
        ? secondTitle
        : firstTitle;
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
      assert.ok(
        summarizeSamples(largeSecondToFirstSamples).firstUsableMs.p95 < 1_000,
        "The realistic code-heavy target must not retain a multi-second warm switch."
      );
      assert.ok(
        summarizeSamples(largeFirstToSecondSamples).firstUsableMs.p95 < 1_000,
        "The realistic table-heavy target must not retain a multi-second warm switch."
      );
    }

    if (profileEditorCostOnly) {
      const summary = {
        source: "deterministic_document_switch_editor_cost_profile",
        benchmark: createBenchmarkIdentity({
          browserVersion,
          firstDocument,
          secondDocument
        }),
        browserErrors,
        checkoutLabel,
        codeBlockCount,
        fixtureProfile,
        structuredTableCount,
        fixture: readProjectFixtureSummary(projectDir, firstTitle),
        ...(includeResourceOwnership
          ? { resourceOwnership: await readResourceOwnership(client) }
          : {}),
        documents: fixtureContract.documents.map((document) =>
          readProjectFixtureSummary(projectDir, document.displayTitle)
        ),
        cold: summarizeSamples([cold]),
        warmup: summarizeSamples(warmupSamples),
        warm: summarizeSamples(warmSamples),
        largeFirstToSecond: summarizeSamples(largeFirstToSecondSamples),
        largeSecondToFirst: summarizeSamples(largeSecondToFirstSamples),
        ...(includeRawSamples
          ? {
              rawSamples: {
                cold: compactSamples([cold]),
                warm: compactSamples(warmSamples)
              }
            }
          : {})
      };
      if (outputPath) {
        writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
      }
      if (!quiet) {
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const deferredHeavyEditors = await verifyDeferredHeavyEditorActivation(
      client,
      {
        codeBlockCount,
        codeDocument: firstDocument,
        tableCount: structuredTableCount,
        tableDocument: secondDocument
      }
    );

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

    const lifecycleBeforeStress = await readCollectedLifecycleState(client);
    const stressSamples = [];
    for (let index = 0; index < stressTransitions; index += 1) {
      const activeTitle = await readActiveDocumentTitle(client);
      const targetTitle = activeTitle === firstTitle ? secondTitle : firstTitle;
      stressSamples.push(await measureSwitch(client, targetTitle));
    }
    const lifecycleAfterStress = await readCollectedLifecycleState(client);
    for (const editorKind of Object.keys(lifecycleBeforeStress.editorRoots)) {
      assert.ok(
        lifecycleAfterStress.editorRoots[editorKind] <=
          lifecycleBeforeStress.editorRoots[editorKind],
        `Repeated switching must not accumulate ${editorKind} editor roots.`
      );
    }
    for (const sample of stressSamples) {
      if (sample.record.marks.target_initial_import_awaited !== undefined) {
        assert.equal(
          sample.record.counters.mdx_set_markdown_count ?? 0,
          0,
          "A target-owned initial MDX import must not be applied again with setMarkdown."
        );
      }
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
      benchmark: createBenchmarkIdentity({
        browserVersion,
        firstDocument,
        secondDocument
      }),
      browserErrors,
      checkoutLabel,
      codeBlockCount,
      expectAtomic,
      expectOptimized,
      fixtureProfile,
      fixture: readProjectFixtureSummary(projectDir, firstTitle),
      ...(includeResourceOwnership
        ? { resourceOwnership: await readResourceOwnership(client) }
        : {}),
      documents: fixtureContract.documents.map((document) => ({
        documentId: document.documentId,
        title: document.displayTitle
      })),
      cold: summarizeSamples([cold]),
      warmup: summarizeSamples(warmupSamples),
      currentDocumentRequest,
      deferredHeavyEditors,
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
        lifecycle: {
          after: lifecycleAfterStress,
          before: lifecycleBeforeStress,
          heapGrowthBytes:
            lifecycleAfterStress.heap.usedSize -
            lifecycleBeforeStress.heap.usedSize
        },
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
      },
      ...(includeRawSamples
        ? {
            rawSamples: {
              cold: compactSamples([cold]),
              stress: compactSamples(stressSamples),
              warm: compactSamples(warmSamples)
            }
          }
        : {})
    };

    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    if (!quiet) {
      console.log(JSON.stringify(summary, null, 2));
    }
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

async function verifyDeferredHeavyEditorActivation(
  client,
  { codeBlockCount, codeDocument, tableCount, tableDocument }
) {
  await ensureActiveDocument(client, codeDocument.displayTitle);
  const codeBefore = await evaluate(client, {
    expression: `(() => {
      const deferred = Array.from(
        document.querySelectorAll(".patchmark-deferred-code-block")
      );
      const target = deferred.at(-1);
      return {
        codeMirrorCount: document.querySelectorAll(".cm-editor").length,
        deferredCount: deferred.length,
        targetText: (target?.matches("code") ? target : target?.querySelector("code"))
          ?.textContent ?? null,
        targetFingerprint: (target?.matches("code") ? target : target?.querySelector("code"))
          ?.textContent
          ?.replace(/\\s+/g, "").slice(0, 80) ?? null
      };
    })()`
  });
  assert.ok(
    codeBefore.deferredCount >= Math.max(1, codeBlockCount - 4),
    "Offscreen code blocks must remain lightweight until they approach the viewport."
  );
  assert.ok(codeBefore.targetText, "A deferred code block must preserve its code.");
  await evaluate(client, {
    expression: `document.querySelectorAll(".patchmark-deferred-code-block")
      .item(document.querySelectorAll(".patchmark-deferred-code-block").length - 1)
      ?.scrollIntoView({ block: "center" })`
  });
  await waitForCondition(
    client,
    `Array.from(document.querySelectorAll(".cm-content"))
      .some((content) => content.textContent?.replace(/\\s+/g, "")
        .includes(${JSON.stringify(codeBefore.targetFingerprint)}))`,
    "viewport-activated CodeMirror editor"
  );
  const codeAfter = await evaluate(client, {
    expression: `({
      codeMirrorCount: document.querySelectorAll(".cm-editor").length,
      deferredCount: document.querySelectorAll(".patchmark-deferred-code-block").length,
      targetVisible: Array.from(document.querySelectorAll(".cm-content"))
        .some((content) => content.textContent?.replace(/\\s+/g, "")
          .includes(${JSON.stringify(codeBefore.targetFingerprint)}))
    })`
  });
  assert.equal(
    codeAfter.targetVisible,
    true,
    "Viewport activation must retain exact code-block content."
  );
  assert.ok(
    codeAfter.deferredCount < codeBefore.deferredCount,
    "Viewport activation must replace the lightweight block with CodeMirror."
  );

  let fullScroll = null;
  if (verifyFullScroll) {
    let maximumCodeMirrorCount = codeAfter.codeMirrorCount;
    let previousDeferredCount = codeAfter.deferredCount;
    for (
      let pass = 0;
      pass < codeBlockCount && previousDeferredCount > 0;
      pass += 1
    ) {
      await evaluate(client, {
        expression: `(() => {
          const target = document.querySelector(".patchmark-deferred-code-block");
          target?.scrollIntoView({ block: "center" });
          target?.click();
        })()`
      });
      await waitForCondition(
        client,
        `document.querySelectorAll(".patchmark-deferred-code-block").length < ${previousDeferredCount}`,
        `full-scroll code activation pass ${pass + 1}`
      );
      const resourceState = await evaluate(client, {
        expression: `({
          codeMirrorCount: document.querySelectorAll(".cm-editor").length,
          deferredCount: document.querySelectorAll(".patchmark-deferred-code-block").length
        })`
      });
      previousDeferredCount = resourceState.deferredCount;
      maximumCodeMirrorCount = Math.max(
        maximumCodeMirrorCount,
        resourceState.codeMirrorCount
      );
    }
    assert.equal(
      previousDeferredCount,
      0,
      "A full top-to-bottom traversal must eventually activate every encountered code editor."
    );
    assert.ok(
      maximumCodeMirrorCount <= codeBlockCount,
      "Activated code-editor resources must remain bounded by this document's code-block count."
    );
    await evaluate(client, {
      expression: `document.querySelector(".editor-body")?.scrollTo({ top: 0 })`
    });
    fullScroll = {
      afterReturnToTop: await evaluate(client, {
        expression: `({
          codeMirrorCount: document.querySelectorAll(".cm-editor").length,
          deferredCount: document.querySelectorAll(".patchmark-deferred-code-block").length
        })`
      }),
      maximumCodeMirrorCount,
      retainedActivatedEditors: true
    };
  }

  await ensureActiveDocument(client, tableDocument.displayTitle);
  if (fullScroll) {
    fullScroll.afterDocumentSwitch = await evaluate(client, {
      expression: `({
        codeMirrorCount: document.querySelectorAll(".cm-editor").length,
        deferredCount: document.querySelectorAll(".patchmark-deferred-code-block").length
      })`
    });
    assert.equal(fullScroll.afterDocumentSwitch.codeMirrorCount, 0);
  }
  const tableBefore = await evaluate(client, {
    expression: `(() => {
      const deferred = Array.from(
        document.querySelectorAll(".patchmark-deferred-table")
      );
      const target = deferred.at(-1);
      return {
        deferredCount: deferred.length,
        targetText: target?.querySelector("td, th")?.textContent ?? null
      };
    })()`
  });
  assert.ok(
    tableBefore.deferredCount >= Math.max(1, tableCount - 2),
    "Offscreen tables must not eagerly construct every nested cell editor."
  );
  assert.ok(tableBefore.targetText, "A deferred table must preserve cell content.");
  await evaluate(client, {
    expression: `document.querySelectorAll(".patchmark-deferred-table")
      .item(document.querySelectorAll(".patchmark-deferred-table").length - 1)
      ?.scrollIntoView({ block: "center" })`
  });
  await waitForCondition(
    client,
    `document.querySelectorAll(".patchmark-deferred-table").length < ${tableBefore.deferredCount} &&
      document.querySelector(".patchmark-prose table [data-tool-cell]") !== null`,
    "viewport-activated full table editor"
  );
  const tableAfter = await evaluate(client, {
    expression: `({
      deferredCount: document.querySelectorAll(".patchmark-deferred-table").length,
      targetVisible: document.querySelector(".patchmark-prose")?.textContent
        ?.includes(${JSON.stringify(tableBefore.targetText)}) ?? false
    })`
  });
  assert.equal(
    tableAfter.targetVisible,
    true,
    "Viewport activation must retain exact table-cell content."
  );

  return { codeAfter, codeBefore, fullScroll, tableAfter, tableBefore };
}

async function measureSwitch(client, targetTitle, consistency) {
  await resetMeasurementState(client);
  if (consistency) {
    await startConsistencyObservation(client, consistency);
  }
  const requestedAt = performance.now();
  await clickDocument(client, targetTitle);
  await waitForTargetEditor(client, targetTitle);
  const paintedAt = await waitForTargetPaint(client);
  const record = await waitForSwitchRecord(client, targetTitle, true);
  const observedFirstUsableMs = paintedAt - record.startedAt;
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
      state.documentBreadcrumb?.includes(intermediateDocument.displayTitle)
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
    heapDeltaBytes:
      state.resources.heapUsedBytes - state.resourcesAtStart.heapUsedBytes,
    resourceDelta: Object.fromEntries(
      Object.keys(state.resources)
        .filter((key) => key !== "heapUsedBytes")
        .map((key) => [
          key,
          state.resources[key] - (state.resourcesAtStart[key] ?? 0)
        ])
    ),
    editorRoots: state.editorRoots,
    targetMode: state.targetMode,
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
    failureCount: 0,
    runtimeErrorCount: browserErrors.length,
    semanticReadinessFailureCount: 0,
    staleGenerationRejectionCount: samples.reduce(
      (total, sample) =>
        total + (sample.record.counters.stale_generation_rejections ?? 0),
      0
    ),
    timeoutCount: 0,
    ...(consistency ? { consistency } : {}),
    firstUsableMs: summarizeNumbers(firstUsable),
    ...(previewVisible.length > 0
      ? { previewVisibleMs: summarizeNumbers(previewVisible) }
      : {}),
    secondaryCompleteMs: summarizeNumbers(secondary),
    longestTaskMs: summarizeNumbers(longestTasks),
    heapDeltaBytes: summarizeNumbers(
      samples.map((sample) => sample.heapDeltaBytes)
    ),
    maxEditorRoots: {
      codeMirror: Math.max(
        ...samples.map((sample) => sample.editorRoots.codeMirror)
      ),
      lexical: Math.max(...samples.map((sample) => sample.editorRoots.lexical)),
      mdx: Math.max(...samples.map((sample) => sample.editorRoots.mdx))
    },
    targetModes: [...new Set(samples.map((sample) => sample.targetMode))],
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
    resourceDeltaMedians: Object.fromEntries(
      Object.keys(samples[0]?.resourceDelta ?? {}).map((key) => [
        key,
        median(samples.map((sample) => sample.resourceDelta[key] ?? 0))
      ])
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
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const center = median(values);
  return {
    count: values.length,
    min: round(Math.min(...values)),
    median: round(center),
    mean: round(average),
    p75: round(percentile(values, 0.75)),
    p90: round(percentile(values, 0.9)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mad: round(median(values.map((value) => Math.abs(value - center))))
  };
}

function compactSamples(samples) {
  return samples.map((sample) => ({
    bytesRead: sample.bytesRead,
    editorRoots: sample.editorRoots,
    firstUsableMs: round(sample.firstUsableMs),
    heapDeltaBytes: sample.heapDeltaBytes,
    instrumentedFirstUsableMs: round(sample.instrumentedFirstUsableMs),
    longestTaskMs: round(sample.longestTaskMs),
    marks: sample.record.marks,
    phases: sample.record.durations,
    counters: sample.record.counters,
    resourceDelta: sample.resourceDelta,
    targetMode: sample.targetMode,
    wallTimeMs: round(sample.wallTimeMs)
  }));
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
      window.__patchmarkSwitchResourcesAtStart = {
        ...(window.__patchmarkSwitchResources ?? {}),
        heapUsedBytes: performance.memory?.usedJSHeapSize ?? 0
      };
      return true;
    })()`
  });
}

async function readMeasurementState(client) {
  return evaluate(client, {
    expression: `({
      editorRoots: {
        codeMirror: document.querySelectorAll(".cm-editor").length,
        lexical: document.querySelectorAll(".patchmark-prose").length,
        mdx: document.querySelectorAll(".patchmark-mdx-editor").length
      },
      targetMode: document.querySelector(".markdown-source-editor")
        ? "markdown"
        : "visual",
      longTasks: window.__patchmarkSwitchLongTasks ?? [],
      measurementStartedAt: window.__patchmarkSwitchMeasurementStartedAt ?? 0,
      resources: {
        ...(window.__patchmarkSwitchResources ?? {}),
        heapUsedBytes: performance.memory?.usedJSHeapSize ?? 0
      },
      resourcesAtStart: window.__patchmarkSwitchResourcesAtStart ?? {},
      reads: window.__patchmarkFixtureReadLog ?? [],
      writes: window.__patchmarkFixtureWriteLog ?? []
    })`
  });
}

async function readCollectedLifecycleState(client) {
  await client.call("HeapProfiler.collectGarbage");
  const heap = await client.call("Runtime.getHeapUsage");
  const editorRoots = await evaluate(client, {
    expression: `({
      codeMirror: document.querySelectorAll(".cm-editor").length,
      lexical: document.querySelectorAll(".patchmark-prose").length,
      visualShell: document.querySelectorAll(".visual-editor-shell").length
    })`
  });
  return { editorRoots, heap };
}

async function waitForTargetPaint(client) {
  return evaluate(client, {
    expression: `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
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
    documentId: document.document_id,
    documentBytes: Buffer.byteLength(markdown),
    documentCharacters: markdown.length,
    fencedCodeBlocks: (markdown.match(/^```/gm)?.length ?? 0) / 2,
    headings: markdown.match(/^#{1,6} /gm)?.length ?? 0,
    markdownSha256: createHash("sha256").update(markdown).digest("hex"),
    modeAtBenchmarkStart: "visual",
    path: document.path,
    patches: patches.length,
    replies: comments.reduce(
      (total, comment) => total + (comment.thread?.length ?? 0),
      0
    ),
    versions: manifest.versions?.length ?? 0
  };
}

function createBenchmarkIdentity({ browserVersion, firstDocument, secondDocument }) {
  return {
    browserJsVersion: browserVersion.jsVersion,
    browserProduct: browserVersion.product,
    checkoutLabel,
    completionBoundary:
      "identity + target semantic fingerprint + interaction safety + two animation frames",
    cpuThrottlingRate: 1,
    directions: {
      firstToSecond: {
        sourceDocumentId: firstDocument.documentId,
        targetDocumentId: secondDocument.documentId,
        targetStructure: fixtureProfile === "equal_complexity"
          ? "equal code-and-table-heavy control"
          : "table-heavy visual target"
      },
      secondToFirst: {
        sourceDocumentId: secondDocument.documentId,
        targetDocumentId: firstDocument.documentId,
        targetStructure: fixtureProfile === "equal_complexity"
          ? "equal code-and-table-heavy control"
          : "code-and-table-heavy visual target"
      }
    },
    fixtureProfile,
    fixtureSeed: "document-switch-browser-v1",
    measuredWarmSwitches: sampleCount,
    profileEditorCostOnly,
    serverMode,
    startBoundary: "navigator document-selection click handler",
    stressTransitions,
    timeoutMs: 15_000,
    warmupSwitches: warmupCount
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
  const openedNotifications = observedStates.filter(
    (state) => state.openedNotification
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
    openedNotifications,
    [],
    `Routine document-open notifications must remain absent. ${JSON.stringify(
      openedNotifications.slice(0, 6),
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
    openedNotificationCount: observedStates.filter(
      (state) => state.openedNotification
    ).length,
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
      const documentBreadcrumb = document.querySelector(
        ".application-document-breadcrumb"
      )?.getAttribute("title") ?? null;
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
      const targetMetadataIsDistinct =
        configuration.targetDocument.commentCount !==
          configuration.sourceDocument.commentCount ||
        configuration.targetDocument.headingCount !==
          configuration.sourceDocument.headingCount;
      const targetChromeCommitted =
        activeTitle === configuration.targetDocument.title ||
        documentKey === configuration.targetDocument.documentKey ||
        documentBreadcrumb?.includes(configuration.targetDocument.title) === true ||
        (targetMetadataIsDistinct &&
          commentsCount === configuration.targetDocument.commentCount &&
          documentToolsSummary?.startsWith(
            configuration.targetDocument.headingCount + " heading"
          ) === true);
      const state = {
        activeTitle,
        commentsCount,
        createSnapshotDisabled: buttonDisabled("Create Snapshot"),
        documentKey,
        documentBreadcrumb,
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
        switchingStateVisible:
          editor?.getAttribute("data-document-switching") === "true" ||
          Boolean(document.querySelector(".document-status-opening")),
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
        openedNotification: /^Opened /.test(notification ?? ""),
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

async function readResourceOwnership(client) {
  return await evaluate(client, {
    expression: `(() => {
      const metrics = window.__patchmarkSwitchResources ?? {};
      const groups = Object.entries(metrics.eventListenerGroups ?? {})
        .map(([group, counts]) => ({ group, ...counts }))
        .sort((left, right) => right.added - left.added);
      return {
        eventListenersAdded: metrics.eventListenersAdded ?? 0,
        eventListenersRemoved: metrics.eventListenersRemoved ?? 0,
        groups,
        intersectionObserversActive: metrics.intersectionObserversActive ?? 0,
        intersectionObserversCreated: metrics.intersectionObserversCreated ?? 0,
        mutationObserversActive: metrics.mutationObserversActive ?? 0,
        mutationObserversCreated: metrics.mutationObserversCreated ?? 0
      };
    })()`
  });
}

function createSwitchResourceObserverScript(instrument) {
  if (!instrument) {
    return `window.__patchmarkSwitchResources = {
      eventListenersAdded: 0,
      eventListenersRemoved: 0,
      intersectionObserverCallbacks: 0,
      intersectionObserversActive: 0,
      intersectionObserversCreated: 0,
      mutationObserverCallbacks: 0,
      mutationObserversActive: 0,
      mutationObserversCreated: 0
    };`;
  }
  return `(() => {
    const metrics = {
      eventListenersAdded: 0,
      eventListenersRemoved: 0,
      eventListenerGroups: {},
      intersectionObserverCallbacks: 0,
      intersectionObserversActive: 0,
      intersectionObserversCreated: 0,
      mutationObserverCallbacks: 0,
      mutationObserversActive: 0,
      mutationObserversCreated: 0
    };
    window.__patchmarkSwitchResources = metrics;

    const addEventListener = EventTarget.prototype.addEventListener;
    const removeEventListener = EventTarget.prototype.removeEventListener;
    const listenerRegistrations = new WeakMap();
    const normalizeCallSite = (stack) => {
      const line = stack?.split("\\n").find((candidate) =>
        candidate.includes(" at ") &&
        !candidate.includes("normalizeCallSite") &&
        !candidate.includes("EventTarget.addEventListener") &&
        !candidate.includes("EventTarget.removeEventListener") &&
        !candidate.includes("createSwitchResourceObserverScript"));
      return (line ?? "unknown").trim().replace(/:\\d+:\\d+(?=\\)?$)/, "");
    };
    const classifyOwner = (site) => {
      if (/codemirror|@lezer/i.test(site)) return "codemirror_code_block";
      if (/Lexical|lexical/i.test(site)) return "lexical_core";
      if (/mdxeditor|MDXEditor/i.test(site)) {
        if (/table/i.test(site)) return "mdxeditor_tables";
        if (/toolbar|dialog/i.test(site)) return "mdxeditor_toolbar_dialog";
        return "mdxeditor_core";
      }
      if (/document-editor|comment|rail/i.test(site)) return "patchmark_comment_rail";
      if (/react-dom|react/i.test(site)) return "react_runtime";
      if (/webpack|next|_next/i.test(site)) return "browser_framework_runtime";
      if (/patchmark.*test|__patchmark/i.test(site)) return "test_instrumentation";
      return "other";
    };
    const targetGroup = (target) => {
      if (target === window) return "window";
      if (target === document) return "document";
      if (target instanceof Element) {
        return target.tagName.toLowerCase() +
          (target.classList.length ? "." + [...target.classList].slice(0, 2).join(".") : "");
      }
      return target?.constructor?.name ?? typeof target;
    };
    const captureValue = (options) =>
      typeof options === "boolean" ? options : Boolean(options?.capture);
    const incrementGroup = (group, field) => {
      const record = metrics.eventListenerGroups[group] ??= {
        active: 0,
        added: 0,
        removed: 0
      };
      record[field] += 1;
    };
    EventTarget.prototype.addEventListener = function(...args) {
      metrics.eventListenersAdded += 1;
      const [type, listener, options] = args;
      const site = normalizeCallSite(new Error().stack);
      const group = [
        classifyOwner(site),
        String(type),
        targetGroup(this),
        site
      ].join("|");
      let byType = listenerRegistrations.get(this);
      if (!byType) listenerRegistrations.set(this, byType = new Map());
      let byListener = byType.get(type);
      if (!byListener) byType.set(type, byListener = new Map());
      let byCapture = byListener.get(listener);
      if (!byCapture) byListener.set(listener, byCapture = new Map());
      const capture = captureValue(options);
      if (!byCapture.has(capture)) {
        byCapture.set(capture, group);
        incrementGroup(group, "added");
        incrementGroup(group, "active");
      }
      return addEventListener.apply(this, args);
    };
    EventTarget.prototype.removeEventListener = function(...args) {
      metrics.eventListenersRemoved += 1;
      const [type, listener, options] = args;
      const byType = listenerRegistrations.get(this);
      const byListener = byType?.get(type);
      const byCapture = byListener?.get(listener);
      const capture = captureValue(options);
      const group = byCapture?.get(capture);
      if (group) {
        incrementGroup(group, "removed");
        metrics.eventListenerGroups[group].active -= 1;
        byCapture.delete(capture);
      }
      return removeEventListener.apply(this, args);
    };

    const NativeIntersectionObserver = window.IntersectionObserver;
    if (typeof NativeIntersectionObserver === "function") {
      window.IntersectionObserver = class extends NativeIntersectionObserver {
        constructor(callback, options) {
          const observed = new Set();
          super((entries, observer) => {
            metrics.intersectionObserverCallbacks += 1;
            callback(entries, observer);
          }, options);
          this.__patchmarkObserved = observed;
          metrics.intersectionObserversCreated += 1;
        }
        observe(target) {
          if (!this.__patchmarkObserved.has(target)) {
            this.__patchmarkObserved.add(target);
            metrics.intersectionObserversActive += 1;
          }
          return super.observe(target);
        }
        unobserve(target) {
          if (this.__patchmarkObserved.delete(target)) {
            metrics.intersectionObserversActive -= 1;
          }
          return super.unobserve(target);
        }
        disconnect() {
          metrics.intersectionObserversActive -= this.__patchmarkObserved.size;
          this.__patchmarkObserved.clear();
          return super.disconnect();
        }
      };
    }

    const NativeMutationObserver = window.MutationObserver;
    if (typeof NativeMutationObserver === "function") {
      window.MutationObserver = class extends NativeMutationObserver {
        constructor(callback) {
          super((entries, observer) => {
            metrics.mutationObserverCallbacks += 1;
            callback(entries, observer);
          });
          this.__patchmarkActive = false;
          metrics.mutationObserversCreated += 1;
        }
        observe(...args) {
          if (!this.__patchmarkActive) {
            this.__patchmarkActive = true;
            metrics.mutationObserversActive += 1;
          }
          return super.observe(...args);
        }
        disconnect() {
          if (this.__patchmarkActive) {
            this.__patchmarkActive = false;
            metrics.mutationObserversActive -= 1;
          }
          return super.disconnect();
        }
      };
    }
  })();`;
}

function addPerformanceQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("patchmarkSwitchPerformance", "1");
  return parsed.toString();
}

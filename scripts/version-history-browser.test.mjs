import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
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
import {
  VERSION_HISTORY_FIXTURE,
  applyVersionHistoryProject
} from "./lib/fixtures/apply-version-history-project.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const screenshotPath = process.env.PATCHMARK_SCREENSHOT_PATH;
const captureOnly = process.env.PATCHMARK_CAPTURE_ONLY === "1";
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 900);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1440);
const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
const sourceDigest = digestProjectTree(sourceRoot);
const copies = [];
let chrome;
let client;
let fixtureServer;
let userDataDir;

try {
  const fixtureCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  const secondCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  copies.push(fixtureCopy, secondCopy);
  assert.deepEqual(digestProjectTree(fixtureCopy.projectRoot), sourceDigest);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), sourceDigest);
  const projectDir = fixtureCopy.projectRoot;
  const fixtureContract = applyVersionHistoryProject(projectDir);
  const secondContract = applyVersionHistoryProject(secondCopy.projectRoot);
  const variantDigest = digestProjectTree(projectDir);
  assert.deepEqual(fixtureContract, secondContract);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), variantDigest);
  const documentPath = join(projectDir, "document.md");
  const patchesPath = join(projectDir, ".patchmark", "patches.json");
  const manifestPath = join(projectDir, ".patchmark", "manifest.json");
  const documentBefore = readFileSync(documentPath, "utf8");
  const patchesBefore = readFileSync(patchesPath, "utf8");
  const manifestBefore = readFileSync(manifestPath, "utf8");
  const storedVersions = JSON.parse(manifestBefore).versions ?? [];
  assert.equal(storedVersions.length, fixtureContract.snapshotCount);

  const inventory = inventoryProject(projectDir);
  fixtureServer = await startFixtureFileServer(projectDir, inventory);
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome was not found for version history browser tests.");
  }
  await assertEditorIsReachable(editorUrl);
  userDataDir = mkdtempSync(join(tmpdir(), "patchmark-version-history-chrome-"));
  chrome = spawn(
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
    height: viewportHeight,
    mobile: false,
    width: viewportWidth
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitForHistoryProject(client, fixtureContract);
  const historyControlBefore = await openHistoryTool(client);
  assert.equal(historyControlBefore.controlsPanel, true);
  assert.equal(historyControlBefore.panelHidden, true);
  assert.equal(historyControlBefore.selected, false);
  await evaluate(client, {
    expression: `(() => {
      window.scrollTo(0, Math.min(240, document.documentElement.scrollHeight - innerHeight));
      const row = document.querySelector(${JSON.stringify(
        `[data-comment-id="${VERSION_HISTORY_FIXTURE.activeCommentId}"]`
      )});
      const comment = row?.querySelector("article");
      if (!(comment instanceof HTMLElement)) {
        throw new Error("Deterministic history comment is unavailable");
      }
      comment.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(
      `[data-comment-id="${VERSION_HISTORY_FIXTURE.activeCommentId}"] article`
    )})?.getAttribute("aria-current") === "true"`,
    "active comment before archive"
  );
  const sidebarBefore = await evaluate(client, {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll(".version-entry-compact"));
      const historyTab = Array.from(document.querySelectorAll("[role='tab']"))
        .find((tab) => tab.textContent?.trim() === "History");
      return {
        activeCommentId: document.querySelector("article[aria-current='true']")
          ?.closest("[data-comment-id]")?.dataset.commentId ?? null,
        count: cards.length,
        documentToolsOpen: document.querySelector("details.document-tools")?.open ?? false,
        historyPanelHidden: document.getElementById(historyTab?.getAttribute("aria-controls") ?? "")?.hidden ?? true,
        historySelected: historyTab?.getAttribute("aria-selected") === "true",
        scrollY: window.scrollY,
        signature: cards.map((card) => ({
          file: card.dataset.versionFile,
          id: card.dataset.versionId,
          title: card.querySelector("strong")?.textContent?.trim()
        })),
        titleStyles: cards.map((card) => {
          const title = card.querySelector("strong");
          const style = title ? getComputedStyle(title) : null;
          return {
            clamp: style?.webkitLineClamp ?? null,
            clientWidth: title?.clientWidth ?? 0,
            scrollWidth: title?.scrollWidth ?? 0,
            whiteSpace: style?.whiteSpace ?? null
          };
        }),
        totalLabel: document.querySelector(".version-history-panel h2")?.textContent?.replace(/\\s+/g, " ").trim()
      };
    })()`
  });
  assert.equal(sidebarBefore.count, 3);
  assert.equal(sidebarBefore.activeCommentId, VERSION_HISTORY_FIXTURE.activeCommentId);
  assert.equal(sidebarBefore.documentToolsOpen, true);
  assert.equal(sidebarBefore.historyPanelHidden, false);
  assert.equal(sidebarBefore.historySelected, true);
  assert.deepEqual(
    sidebarBefore.signature,
    fixtureContract.newestFirst.slice(0, 3).map(({ file, id, title }) => ({
      file,
      id,
      title
    }))
  );
  assert.match(sidebarBefore.totalLabel, new RegExp(`Version History\\s*·\\s*${storedVersions.length}`));
  assert.equal(sidebarBefore.titleStyles.every((style) => style.clamp === "2"), true);
  assert.equal(
    sidebarBefore.titleStyles.every(
      (style) => style.whiteSpace === "normal" && style.scrollWidth <= style.clientWidth
    ),
    true
  );
  await clickButtonByText(client, "View all versions");
  await waitFor(
    client,
    `Boolean(document.querySelector(".version-history-dialog"))`,
    "version archive dialog"
  );

  if (screenshotPath) {
    const screenshot = await client.call("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png"
    });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  }

  if (captureOnly) {
    console.log(`Captured version history modal: ${screenshotPath}`);
  } else {
    const archiveState = await evaluate(client, {
      expression: `(() => {
        const root = document.querySelector(".version-history-modal-root");
        const dialog = document.querySelector(".version-history-dialog");
        const body = document.querySelector(".version-history-dialog-body");
        const header = document.querySelector(".version-history-dialog-header");
        const close = header?.querySelector("button");
        const dialogRect = dialog?.getBoundingClientRect();
        const representativePoints = dialogRect
          ? [
              [dialogRect.left + 40, dialogRect.top + 40],
              [dialogRect.left + dialogRect.width / 2, dialogRect.top + dialogRect.height / 2]
            ]
          : [];
        const fullTitles = Array.from(document.querySelectorAll(".version-entry-full strong"));
        const headingLabels = Array.from(document.querySelectorAll(".version-entry-full .version-entry-meta span:first-child"))
          .map((element) => element.textContent?.trim() ?? "");
        return {
          archiveCount: document.querySelectorAll(".version-entry-full").length,
          backgroundInert: Array.from(document.body.children)
            .filter((element) => element !== root)
            .every((element) => element.inert),
          bodyOverflow: document.body.style.overflow,
          closeFocused: document.activeElement === close,
          closeVisible: close ? close.getBoundingClientRect().bottom <= innerHeight : false,
          dialogParentIsBody: root?.parentElement === document.body,
          fullTitlesUnclamped: fullTitles.every((title) => {
            const style = getComputedStyle(title);
            return style.webkitLineClamp === "none" && style.whiteSpace === "normal";
          }),
          headingsHideHashes: headingLabels.every((heading) => !/^#{1,6}\\s+/.test(heading)),
          internalScroll: Boolean(body && body.scrollHeight > body.clientHeight),
          rootPosition: root ? getComputedStyle(root).position : null,
          signature: Array.from(document.querySelectorAll(".version-entry-full")).map((card) => ({
            file: card.dataset.versionFile,
            id: card.dataset.versionId,
            title: card.querySelector("strong")?.textContent?.trim()
          })),
          topLayersAreArchive: representativePoints.every(([x, y]) =>
            Boolean(document.elementFromPoint(x, y)?.closest(".version-history-dialog"))
          )
        };
      })()`
    });
    assert.equal(archiveState.archiveCount, storedVersions.length);
    assert.equal(archiveState.backgroundInert, true);
    assert.equal(archiveState.bodyOverflow, "hidden");
    assert.equal(archiveState.closeFocused, true);
    assert.equal(archiveState.closeVisible, true);
    assert.equal(archiveState.dialogParentIsBody, true);
    assert.equal(archiveState.fullTitlesUnclamped, true);
    assert.equal(archiveState.headingsHideHashes, true);
    assert.equal(archiveState.internalScroll, true);
    assert.equal(archiveState.rootPosition, "fixed");
    assert.deepEqual(
      archiveState.signature,
      fixtureContract.newestFirst.map(({ file, id, title }) => ({ file, id, title }))
    );
    assert.equal(archiveState.topLayersAreArchive, true);

    const scrolledArchiveState = await evaluate(client, {
      expression: `(() => {
        const body = document.querySelector(".version-history-dialog-body");
        if (!body) return null;
        const details = document.querySelectorAll(".version-entry-full details")[4];
        body.scrollTop = Math.min(600, body.scrollHeight - body.clientHeight);
        details?.querySelector("summary")?.click();
        const detailValue = details?.querySelector("dd");
        return {
          backgroundScrollY: window.scrollY,
          closeVisible: document.querySelector(".version-history-dialog-header button")?.getBoundingClientRect().bottom <= innerHeight,
          detailOpen: details?.open ?? false,
          detailWrap: detailValue ? getComputedStyle(detailValue).overflowWrap : null,
          scrollTop: body.scrollTop
        };
      })()`,
      userGesture: true
    });
    assert.ok(scrolledArchiveState.scrollTop > 0);
    assert.equal(scrolledArchiveState.backgroundScrollY, sidebarBefore.scrollY);
    assert.equal(scrolledArchiveState.closeVisible, true);
    assert.equal(scrolledArchiveState.detailOpen, true);
    assert.equal(scrolledArchiveState.detailWrap, "anywhere");

    for (const [index, expected] of fixtureContract.newestFirst.entries()) {
      if (index > 0) {
        await openVersionArchive(client);
      }
      const viewTarget = await clickArchiveEntryAction(client, expected.id, "View");
      await waitFor(
        client,
        `Boolean(document.querySelector("[aria-label='View snapshot']"))`,
        `view snapshot dialog ${expected.id}`
      );
      const viewedSnapshot = await readSnapshotDialogState(client, "View snapshot");
      assert.deepEqual(viewTarget, {
        file: expected.file,
        id: expected.id,
        title: expected.title
      });
      assert.equal(viewedSnapshot.file, expected.file);
      assert.equal(viewedSnapshot.snapshotMarkdown, expected.markdown);
      assert.equal(viewedSnapshot.textareaCount, 1);
      assert.equal(viewedSnapshot.title, expected.title);
      await clickDialogButton(client, "[aria-label='View snapshot']", "Close");
    }

    const compareTargets = [
      fixtureContract.newestFirst[1],
      fixtureContract.newestFirst.at(-1)
    ];
    for (const expected of compareTargets) {
      await openVersionArchive(client);
      const compareTarget = await clickArchiveEntryAction(
        client,
        expected.id,
        "Compare"
      );
      await waitFor(
        client,
        `Boolean(document.querySelector("[aria-label='Compare snapshot']"))`,
        `compare snapshot dialog ${expected.id}`
      );
      const comparedSnapshot = await readSnapshotDialogState(
        client,
        "Compare snapshot"
      );
      assert.deepEqual(compareTarget, {
        file: expected.file,
        id: expected.id,
        title: expected.title
      });
      assert.equal(comparedSnapshot.currentMarkdown, fixtureContract.currentMarkdown);
      assert.equal(comparedSnapshot.file, expected.file);
      assert.equal(comparedSnapshot.identical, "No");
      assert.equal(
        comparedSnapshot.lineDifference,
        fixtureContract.currentMarkdown.split(/\r?\n/).length -
          expected.markdown.split(/\r?\n/).length
      );
      assert.equal(comparedSnapshot.snapshotMarkdown, expected.markdown);
      assert.equal(comparedSnapshot.snapshotLength, expected.markdown.length);
      assert.equal(comparedSnapshot.textareaCount, 2);
      assert.equal(comparedSnapshot.title, expected.title);
      await clickDialogButton(client, "[aria-label='Compare snapshot']", "Close");
    }

    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 800,
      mobile: false,
      width: 980
    });
    await openVersionArchive(client, "narrow archive");
    const narrowState = await evaluate(client, {
      expression: `(() => {
        const dialog = document.querySelector(".version-history-dialog");
        const rect = dialog?.getBoundingClientRect();
        const actionsFit = Array.from(document.querySelectorAll(".version-entry-full")).every((card) => {
          const cardRect = card.getBoundingClientRect();
          return Array.from(card.querySelectorAll("button")).every((button) => {
            const buttonRect = button.getBoundingClientRect();
            return buttonRect.right <= cardRect.right && buttonRect.left >= cardRect.left;
          });
        });
        return {
          actionsFit,
          bottom: rect?.bottom,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          left: rect?.left,
          right: rect?.right,
          top: rect?.top
        };
      })()`
    });
    assert.equal(narrowState.actionsFit, true);
    assert.equal(narrowState.horizontalOverflow, false);
    assert.deepEqual(
      [
        Math.round(narrowState.left),
        Math.round(980 - narrowState.right),
        Math.round(narrowState.top),
        Math.round(800 - narrowState.bottom)
      ],
      [16, 16, 16, 16],
      `Narrow archive shared dialog inset: ${JSON.stringify(narrowState)}`
    );

    await client.call("Input.dispatchKeyEvent", {
      code: "Escape",
      key: "Escape",
      type: "keyDown"
    });
    await client.call("Input.dispatchKeyEvent", {
      code: "Escape",
      key: "Escape",
      type: "keyUp"
    });
    await waitFor(client, `!document.querySelector(".version-history-dialog")`, "archive closed by Escape");
    await waitFor(
      client,
      `document.activeElement?.textContent?.trim() === "View all versions"`,
      "archive opener focus restored"
    );
    const closedState = await evaluate(client, {
      expression: `({
        activeCommentId: document.querySelector("article[aria-current='true']")
          ?.closest("[data-comment-id]")?.dataset.commentId ?? null,
        bodyOverflow: document.body.style.overflow,
        focusedText: document.activeElement?.textContent?.trim() ?? null,
        scrollY: window.scrollY
      })`
    });
    assert.equal(closedState.activeCommentId, sidebarBefore.activeCommentId);
    assert.equal(closedState.bodyOverflow, "");
    assert.equal(closedState.focusedText, "View all versions");
    assert.equal(closedState.scrollY, sidebarBefore.scrollY);

    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: viewportHeight,
      mobile: false,
      width: viewportWidth
    });
    await client.call("Page.reload");
    await waitForEditorShell(client);
    await clickButtonByText(client, "Open Project Folder");
    await waitForHistoryProject(client, fixtureContract);
    await openHistoryTool(client);
    const sidebarAfter = await getSidebarSignature(client);
    assert.deepEqual(sidebarAfter, sidebarBefore.signature);
    assert.equal(readFileSync(documentPath, "utf8"), documentBefore);
    assert.equal(readFileSync(patchesPath, "utf8"), patchesBefore);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);

    console.log(
      JSON.stringify(
        {
          archiveCount: archiveState.archiveCount,
          editorUrl,
          fixture: {
            currentVersionId: fixtureContract.currentVersionId,
            manifestOrder: fixtureContract.manifestOrder,
            newestFirst: fixtureContract.newestFirst.map(({ id, title }) => ({
              id,
              title
            })),
            snapshotCount: fixtureContract.snapshotCount
          },
          projectDir,
          selectedSnapshots: fixtureContract.snapshotCount,
          screenshots: screenshotPath ? [screenshotPath] : [],
          sourceDigest: sourceDigest.digest,
          variantDigest: variantDigest.digest,
          viewports: [
            `${viewportWidth}x${viewportHeight}`,
            "980x800"
          ]
        },
        null,
        2
      )
    );
    console.log("Version history browser tests passed.");
  }
  assert.equal(readFileSync(documentPath, "utf8"), documentBefore);
  assert.equal(readFileSync(patchesPath, "utf8"), patchesBefore);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
  assert.deepEqual(digestProjectTree(projectDir), variantDigest);
  assert.deepEqual(digestProjectTree(secondCopy.projectRoot), variantDigest);
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
} finally {
  await client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 1000);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 1000);
    }
    chrome.stderr?.destroy();
  }
  await fixtureServer?.forceClose();
  if (userDataDir) {
    rmSync(userDataDir, { force: true, recursive: true });
  }
  for (const copy of copies.reverse()) {
    copy.cleanup();
    assert.equal(existsSync(copy.temporaryRoot), false);
  }
  assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
}

async function clickArchiveEntryAction(client, versionId, action) {
  return evaluate(client, {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll(".version-entry-full"));
      const card = cards.find(
        (candidate) => candidate.dataset.versionId === ${JSON.stringify(versionId)}
      );
      if (!card) throw new Error("Archive entry ${versionId} not found");
      const button = Array.from(card.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(action)});
      if (!button) throw new Error("Archive action ${action} not found");
      const identity = {
        file: card.dataset.versionFile,
        id: card.dataset.versionId,
        title: card.querySelector("strong")?.textContent?.trim()
      };
      button.click();
      return identity;
    })()`,
    userGesture: true
  });
}

async function readSnapshotDialogState(client, ariaLabel) {
  return evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector(${JSON.stringify(`[aria-label='${ariaLabel}']`)});
      const textareas = Array.from(dialog?.querySelectorAll("textarea") ?? []);
      const summary = new Map(
        Array.from(dialog?.querySelectorAll(".snapshot-compare-summary > div") ?? [])
          .map((row) => [
            row.querySelector("dt")?.textContent?.trim() ?? "",
            row.querySelector("dd")?.textContent?.trim() ?? ""
          ])
      );
      return {
        currentMarkdown: textareas[1]?.value ?? null,
        file: Array.from(dialog?.querySelectorAll("p") ?? []).find((paragraph) => paragraph.title)?.title ?? null,
        identical: summary.get("Identical") ?? null,
        lineDifference: Number(summary.get("Line difference")),
        snapshotLength: Number(summary.get("Snapshot length")),
        snapshotMarkdown: textareas[0]?.value ?? null,
        textareaCount: textareas.length,
        title: dialog?.querySelector("h2")?.textContent?.trim() ?? null
      };
    })()`
  });
}

async function openVersionArchive(client, description = "reopened archive") {
  await clickButtonByText(client, "View all versions");
  await waitFor(
    client,
    `Boolean(document.querySelector(".version-history-dialog"))`,
    description
  );
}

async function waitForHistoryProject(client, fixtureContract) {
  await waitFor(
    client,
    `(() => {
      const status = Array.from(document.querySelectorAll("[aria-label='Workspace status'] *"))
        .map((element) => element.textContent?.trim() ?? "");
      return status.includes("Project: Synthetic Atlas") &&
        status.includes("Document: document.md") &&
        Boolean(document.querySelector(${JSON.stringify(
          `[data-comment-id="${VERSION_HISTORY_FIXTURE.activeCommentId}"] article`
        )})) &&
        document.querySelectorAll(".version-entry-compact").length === 3 &&
        document.querySelector(".version-history-panel h2")?.textContent?.includes(${JSON.stringify(
          String(fixtureContract.snapshotCount)
        )});
    })()`,
    "deterministic version-history project"
  );
}

async function openHistoryTool(client) {
  const initialState = await evaluate(client, {
    expression: `(() => {
      const details = document.querySelector("details.document-tools");
      const historyTab = Array.from(document.querySelectorAll("[role='tab']"))
        .find((tab) => tab.textContent?.trim() === "History");
      const panel = document.getElementById(historyTab?.getAttribute("aria-controls") ?? "");
      const initial = {
        controlsPanel: Boolean(historyTab?.getAttribute("aria-controls") && panel),
        panelHidden: panel?.hidden ?? true,
        selected: historyTab?.getAttribute("aria-selected") === "true"
      };
      if (details && !details.open) {
        details.querySelector("summary")?.click();
      }
      if (historyTab instanceof HTMLButtonElement && !initial.selected) {
        historyTab.click();
      }
      return initial;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `(() => {
      const details = document.querySelector("details.document-tools");
      const historyTab = Array.from(document.querySelectorAll("[role='tab']"))
        .find((tab) => tab.textContent?.trim() === "History");
      const panel = document.getElementById(historyTab?.getAttribute("aria-controls") ?? "");
      return Boolean(details?.open) &&
        historyTab?.getAttribute("aria-selected") === "true" &&
        panel?.hidden === false;
    })()`,
    "open History document tool"
  );
  return initialState;
}

async function clickDialogButton(client, selector, text) {
  await evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector(${JSON.stringify(selector)});
      const buttons = dialog ? Array.from(dialog.querySelectorAll("button")) : [];
      const button = buttons.find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error("Dialog button not found: ${text}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(client, `!document.querySelector(${JSON.stringify(selector)})`, `closed dialog ${selector}`);
}

async function getSidebarSignature(client) {
  return evaluate(client, {
    expression: `Array.from(document.querySelectorAll(".version-entry-compact")).map((card) => ({
      file: card.dataset.versionFile,
      id: card.dataset.versionId,
      title: card.querySelector("strong")?.textContent?.trim()
    }))`
  });
}

async function waitFor(client, expression, description) {
  let latestValue = null;

  for (let attempt = 0; attempt < 160; attempt += 1) {
    latestValue = await evaluate(client, { expression });
    if (latestValue) {
      return latestValue;
    }
    await delay(75);
  }

  throw new Error(
    `Timed out waiting for ${description}. Latest value: ${JSON.stringify(latestValue)}`
  );
}

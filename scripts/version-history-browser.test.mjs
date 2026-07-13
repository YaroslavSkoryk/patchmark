import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
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
  waitForProcessExit,
  waitForProjectComments
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const sourceProjectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const screenshotPath = process.env.PATCHMARK_SCREENSHOT_PATH;
const captureOnly = process.env.PATCHMARK_CAPTURE_ONLY === "1";
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 900);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1440);

if (!sourceProjectDir) {
  throw new Error("Set PATCHMARK_REAL_PROJECT_DIR to a real Patchmark project.");
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-version-history-"));
const projectDir = join(fixtureRoot, basename(sourceProjectDir));
cpSync(sourceProjectDir, projectDir, { recursive: true });
const documentPath = join(projectDir, "document.md");
const patchesPath = join(projectDir, ".patchmark", "patches.json");
const manifestPath = join(projectDir, ".patchmark", "manifest.json");
const documentBefore = readFileSync(documentPath, "utf8");
const patchesBefore = readFileSync(patchesPath, "utf8");
const manifestBefore = readFileSync(manifestPath, "utf8");
const storedVersions = JSON.parse(manifestBefore).versions ?? [];

assert.ok(storedVersions.length > 3, "Fixture needs more than three snapshots.");

const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for version history browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-version-history-chrome-"));
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
  await waitForProjectComments(client);
  await waitFor(
    client,
    `document.querySelectorAll(".version-entry-compact").length === 3`,
    "three recent version cards"
  );
  await evaluate(client, {
    expression: `(() => {
      window.scrollTo(0, Math.min(240, document.documentElement.scrollHeight - innerHeight));
      const comment = document.querySelector("[id^='patchmark-comment-card-']");
      comment?.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `Boolean(document.querySelector("[id^='patchmark-comment-card-'][data-active='true']"))`,
    "active comment before archive"
  );
  const sidebarBefore = await evaluate(client, {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll(".version-entry-compact"));
      return {
        activeCommentId: document.querySelector("[id^='patchmark-comment-card-'][data-active='true']")?.id ?? null,
        count: cards.length,
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

    const viewTarget = await clickArchiveEntryAction(client, 4, "View");
    await waitFor(
      client,
      `Boolean(document.querySelector("[aria-label='View snapshot']"))`,
      "view snapshot dialog"
    );
    const viewedSnapshot = await readSnapshotDialogIdentity(client, "View snapshot");
    assert.equal(viewedSnapshot.file, viewTarget.file);
    assert.equal(viewedSnapshot.title, viewTarget.title);
    await clickDialogButton(client, "[aria-label='View snapshot']", "Close");

    await clickButtonByText(client, "View all versions");
    await waitFor(client, `Boolean(document.querySelector(".version-history-dialog"))`, "reopened archive");
    const compareTarget = await clickArchiveEntryAction(client, 6, "Compare");
    await waitFor(
      client,
      `Boolean(document.querySelector("[aria-label='Compare snapshot']"))`,
      "compare snapshot dialog"
    );
    const comparedSnapshot = await readSnapshotDialogIdentity(client, "Compare snapshot");
    assert.equal(comparedSnapshot.file, compareTarget.file);
    assert.equal(comparedSnapshot.title, compareTarget.title);
    await clickDialogButton(client, "[aria-label='Compare snapshot']", "Close");

    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 800,
      mobile: false,
      width: 980
    });
    await clickButtonByText(client, "View all versions");
    await waitFor(client, `Boolean(document.querySelector(".version-history-dialog"))`, "narrow archive");
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
          left: rect?.left,
          right: rect?.right,
          top: rect?.top
        };
      })()`
    });
    assert.equal(narrowState.actionsFit, true);
    assert.ok(narrowState.left >= 20 && narrowState.right <= 960);
    assert.ok(narrowState.top >= 20 && narrowState.bottom <= 780);

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
    const closedState = await evaluate(client, {
      expression: `({
        activeCommentId: document.querySelector("[id^='patchmark-comment-card-'][data-active='true']")?.id ?? null,
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
    await waitForProjectComments(client);
    await waitFor(client, `document.querySelectorAll(".version-entry-compact").length === 3`, "reloaded recent versions");
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
          projectDir,
          screenshots: screenshotPath ? [screenshotPath] : [],
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
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function clickArchiveEntryAction(client, index, action) {
  return evaluate(client, {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll(".version-entry-full"));
      const card = cards[${index}];
      if (!card) throw new Error("Archive entry ${index} not found");
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

async function readSnapshotDialogIdentity(client, ariaLabel) {
  return evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector(${JSON.stringify(`[aria-label='${ariaLabel}']`)});
      return {
        file: Array.from(dialog?.querySelectorAll("p") ?? []).find((paragraph) => paragraph.title)?.title ?? null,
        title: dialog?.querySelector("h2")?.textContent?.trim() ?? null
      };
    })()`
  });
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

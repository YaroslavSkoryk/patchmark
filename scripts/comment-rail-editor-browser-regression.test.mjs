import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  COMMENT_RAIL_FIXTURE,
  applyCommentRailProject
} from "./lib/fixtures/apply-comment-rail-project.mjs";
import {
  PROJECT_FIXTURE_IDS,
  createProjectFixtureCopy,
  digestProjectTree,
  getProjectFixtureRoot
} from "./lib/project-fixture-foundation.mjs";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
let projectDir = null;
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 1000);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1440);
const movementTolerance = 1;
const scrollMovementTolerance = 2;
const nearTopScrollTolerance = 100;
const topCommentId = COMMENT_RAIL_FIXTURE.topCommentId;
const lowerCommentId = COMMENT_RAIL_FIXTURE.lowerCommentId;
const lineCommentId = COMMENT_RAIL_FIXTURE.lineCommentId;
const linkedMultiBlockCommentId = COMMENT_RAIL_FIXTURE.linkedCommentId;
const visualEvidenceDir = process.env.PATCHMARK_PHASE5_SCREENSHOT_DIR;
const shouldRunFullVisualAudit =
  process.env.PATCHMARK_PHASE5_FULL_VISUAL_AUDIT === "1";
const shouldRunFullVisualAuditOnly =
  process.env.PATCHMARK_PHASE5_AUDIT_ONLY === "1";

async function runActualEditorRegression() {
  const sourceRoot = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);
  const sourceDigest = digestProjectTree(sourceRoot);
  const fixtureCopy = createProjectFixtureCopy(PROJECT_FIXTURE_IDS.legacyCore);
  assert.deepEqual(digestProjectTree(fixtureCopy.projectRoot), sourceDigest);
  projectDir = fixtureCopy.projectRoot;

  try {
    const fixtureContract = applyCommentRailProject(projectDir);
    return await runFixtureEditorRegression(fixtureContract);
  } finally {
    projectDir = null;
    fixtureCopy.cleanup();
    assert.equal(existsSync(fixtureCopy.temporaryRoot), false);
    assert.deepEqual(digestProjectTree(sourceRoot), sourceDigest);
  }
}

async function runFixtureEditorRegression(fixtureContract) {

  if (!existsSync(join(projectDir, "document.md"))) {
    throw new Error(`${projectDir} does not contain document.md.`);
  }

  if (!existsSync(join(projectDir, ".patchmark", "manifest.json"))) {
    throw new Error(`${projectDir} does not contain .patchmark/manifest.json.`);
  }

  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the editor browser regression."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const fixtureInventory = inventoryProject(projectDir);
  const fixtureServer = await startFixtureFileServer(projectDir, fixtureInventory);
  const userDataDir = mkdtempSync(
    join(tmpdir(), "patchmark-editor-rail-chrome-")
  );
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
    {
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  let pageClient;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, "about:blank");

    pageClient = await CdpClient.connect(pageWsUrl);
    await pageClient.call("Page.enable");
    await pageClient.call("Runtime.enable");
    await pageClient.call("Page.addScriptToEvaluateOnNewDocument", {
      source: createProjectPickerShim({
        baseUrl: fixtureServer.baseUrl,
        directories: fixtureInventory.directories,
        files: fixtureInventory.files,
        projectName: basename(projectDir)
      })
    });
    await pageClient.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: viewportHeight,
      mobile: false,
      width: viewportWidth
    });
    await pageClient.call("Page.navigate", { url: editorUrl });
    await waitForEditorShell(pageClient);
    await clickButtonByText(pageClient, "Open Project Folder");
    await waitForProjectComments(pageClient);
    const closedState = await readCommentsRailSemanticState(pageClient);
    assert.equal(closedState.triggerExists, true);
    assert.equal(closedState.controlsPanel, true);
    assert.equal(closedState.expanded, !closedState.hidden);
    await ensureCommentsRailOpen(pageClient);
    const openState = await readCommentsRailSemanticState(pageClient);
    assert.equal(openState.expanded, true);
    assert.equal(openState.hidden, false);

    if (shouldRunFullVisualAuditOnly) {
      await waitForVisualEditorProjection(pageClient);
      const audit = await auditAllSelectedTextCommentHighlights(pageClient);
      console.log(
        JSON.stringify(
          {
            kind: "comment-rail-full-visual-audit-only",
            projectDir,
            url: editorUrl,
            audit
          },
          null,
          2
        )
      );
      console.log("Comment rail full visual audit passed.");
      return;
    }

    await scrollToTop(pageClient);

    const measurements = [];
    const initialMeasurement = await waitForStableState(
      pageClient,
      "before top activation",
      "none"
    );
    const targets = chooseScrollActivationTargets(initialMeasurement.rows);

    measurements.push(initialMeasurement);
    await activateComment(pageClient, targets.top.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "after top activation",
        targets.top.id
      )
    );
    await scrollCommentIntoView(pageClient, targets.lower.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "after scroll before lower activation",
        targets.top.id
      )
    );
    await activateComment(pageClient, targets.lower.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "after lower activation",
        targets.lower.id
      )
    );
    await scrollCommentIntoView(pageClient, targets.top.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "after scroll up before top reactivation",
        targets.lower.id
      )
    );
    await activateComment(pageClient, targets.top.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "after top reactivation",
        targets.top.id
      )
    );
    await scrollCommentIntoView(pageClient, targets.lower.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "second scroll before lower activation",
        targets.top.id
      )
    );
    await activateComment(pageClient, targets.lower.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "second lower activation",
        targets.lower.id
      )
    );
    await scrollCommentIntoView(pageClient, targets.top.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "second scroll up before top activation",
        targets.lower.id
      )
    );
    await activateComment(pageClient, targets.top.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        "second top reactivation",
        targets.top.id
      )
    );

    const layoutEvents = await readLayoutEvents(pageClient);

    assertActualEditorMeasurements(measurements, targets);
    const visualEvidence = visualEvidenceDir
      ? await capturePhase5VisualEvidence(pageClient, visualEvidenceDir)
      : [];
    await closeCommentsRail(pageClient);
    const finalRailState = await readCommentsRailSemanticState(pageClient);
    assert.equal(finalRailState.expanded, false);
    assert.equal(finalRailState.hidden, true);
    assert.equal(finalRailState.editorInteractive, true);
    printEditorSummary({
      fixtureContract,
      finalRailState,
      layoutEvents,
      measurements,
      projectDir,
      targets,
      url: editorUrl,
      visualEvidence
    });
    console.log("Comment rail actual-editor browser regression tests passed.");
  } finally {
    await pageClient?.close();
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 1000);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await waitForProcessExit(chrome, 1000);
    }
    await fixtureServer.close();
    rmSync(userDataDir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100
    });
  }
}

async function waitForVisualEditorProjection(client) {
  let latestState = null;

  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => ({
        editorTextLength: document.querySelector(".patchmark-prose")?.textContent?.length ?? 0,
        projectedRows: document.querySelectorAll(".comment-floating-item[data-comment-anchor-status='active']").length,
        visualError: document.body.textContent?.includes("Visual Mode could not render") ?? false
      }))()`
    });
    latestState = state;

    if (state.visualError) {
      throw new Error("Visual Mode reported a render error during the full audit.");
    }

    if (state.editorTextLength > 1_000 && state.projectedRows > 0) {
      await delay(300);
      return;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for Visual Mode projection.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function assertEditorIsReachable(url) {
  const response = await fetch(url);

  assert.equal(
    response.ok,
    true,
    `Expected editor to be reachable at ${url}; start the dev server first.`
  );
}

function inventoryProject(rootDir) {
  const files = [];
  const directories = [""];

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const fullPath = join(currentDir, entry);
      const relativePath = normalizeFixturePath(relative(rootDir, fullPath));
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        directories.push(relativePath);
        walk(fullPath);
      } else if (stats.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(rootDir);

  return { directories, files };
}

function normalizeFixturePath(path) {
  return path.split(sep).filter(Boolean).join("/");
}

async function startFixtureFileServer(
  rootDir,
  inventory,
  { persistWrites = true } = {}
) {
  const fileSet = new Set(inventory.files);
  const directorySet = new Set(inventory.directories);
  const memoryFiles = new Map();
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Methods",
      "DELETE, GET, OPTIONS, POST"
    );
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/write" && request.method === "POST") {
      const relativePath = normalizeFixturePath(
        requestUrl.searchParams.get("path") ?? ""
      );

      if (!relativePath || relativePath.split("/").includes("..")) {
        response.writeHead(400);
        response.end("invalid path");
        return;
      }

      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const content = Buffer.concat(chunks);

        if (persistWrites) {
          const fullPath = join(rootDir, relativePath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
        } else {
          memoryFiles.set(relativePath, content);
        }

        fileSet.add(relativePath);
        const pathParts = relativePath.split("/");
        pathParts.pop();
        while (pathParts.length > 0) {
          directorySet.add(pathParts.join("/"));
          pathParts.pop();
        }
        response.writeHead(204);
        response.end();
      });
      return;
    }

    if (requestUrl.pathname === "/exists" && request.method === "GET") {
      const relativePath = normalizeFixturePath(
        requestUrl.searchParams.get("path") ?? ""
      );
      const kind = requestUrl.searchParams.get("kind");
      const exists =
        kind === "directory"
          ? directorySet.has(relativePath)
          : fileSet.has(relativePath);
      response.writeHead(exists ? 204 : 404);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/file" && request.method === "DELETE") {
      const relativePath = normalizeFixturePath(
        requestUrl.searchParams.get("path") ?? ""
      );

      if (!relativePath || relativePath.split("/").includes("..")) {
        response.writeHead(400);
        response.end("invalid path");
        return;
      }

      if (persistWrites) {
        const fullPath = join(rootDir, relativePath);
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
        }
      } else {
        memoryFiles.delete(relativePath);
      }
      fileSet.delete(relativePath);
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname !== "/file") {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    const relativePath = normalizeFixturePath(
      requestUrl.searchParams.get("path") ?? ""
    );

    if (!fileSet.has(relativePath)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(relativePath)
    });
    response.end(
      memoryFiles.get(relativePath) ??
        Buffer.from(readFileSync(join(rootDir, relativePath), "utf8"))
    );
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start fixture file server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    forceClose: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function getContentType(path) {
  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (path.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function createProjectPickerShim({
  baseUrl,
  directories,
  filePickerPaths = [],
  files,
  projectName,
  pickerPaths = [""]
}) {
  return `(() => {
    const filePaths = new Set(${JSON.stringify(files)});
    const directoryPaths = new Set(${JSON.stringify(directories)});
    const overrides = new Map();
    const readLog = [];
    const lastModifiedByPath = new Map();
    const writeLog = [];
    const writeControls = {
      delayByPath: {},
      delayBySequence: {},
      failNextPath: null,
      failNextSequence: null
    };
    const writeStats = {
      activeWrites: 0,
      maximumActiveWrites: 0,
      nextSequence: 1
    };
    const filePickerQueue = ${JSON.stringify(filePickerPaths)};
    let filePickerIndex = 0;
    const pickerQueue = ${JSON.stringify(pickerPaths)};
    let pickerIndex = 0;

    function normalizePath(path) {
      return String(path).split("/").filter(Boolean).join("/");
    }

    function joinPath(directory, name) {
      return normalizePath(directory ? directory + "/" + name : name);
    }

    function notFound(message) {
      return new DOMException(message, "NotFoundError");
    }

    class PatchmarkFixtureFileHandle {
      constructor(path) {
        this.kind = "file";
        this.name = path.split("/").pop();
        this.path = normalizePath(path);
      }

      async getFile() {
        const startedAt = performance.now();
        const text = overrides.has(this.path)
          ? overrides.get(this.path)
          : await fetch(${JSON.stringify(baseUrl)} + "/file?path=" + encodeURIComponent(this.path)).then((response) => {
              if (!response.ok) {
                throw notFound("Missing fixture file: " + this.path);
              }

              return response.text();
            });

        readLog.push({
          path: this.path,
          bytes: new TextEncoder().encode(text).byteLength,
          startedAt,
          completedAt: performance.now()
        });
        return new File([text], this.name, {
          lastModified: lastModifiedByPath.get(this.path) ?? 1,
          type: this.name.endsWith(".json") ? "application/json" : "text/markdown"
        });
      }

      async createWritable() {
        const chunks = [];
        const path = this.path;

        return {
          async write(data) {
            if (data instanceof Blob) {
              chunks.push(await data.text());
            } else if (data instanceof ArrayBuffer) {
              chunks.push(new TextDecoder().decode(new Uint8Array(data)));
            } else if (ArrayBuffer.isView(data)) {
              chunks.push(new TextDecoder().decode(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              ));
            } else {
              chunks.push(String(data));
            }
          },
          async close() {
            const nextContent = chunks.join("");
            const sequence = writeStats.nextSequence;
            writeStats.nextSequence += 1;
            const event = {
              sequence,
              path,
              bytes: new TextEncoder().encode(nextContent).byteLength,
              startedAt: performance.now(),
              completedAt: null,
              status: "started"
            };
            writeLog.push(event);
            writeStats.activeWrites += 1;
            writeStats.maximumActiveWrites = Math.max(
              writeStats.maximumActiveWrites,
              writeStats.activeWrites
            );

            const delay = Number(
              writeControls.delayBySequence[sequence] ??
                writeControls.delayByPath[path] ??
                0
            );

            if (delay > 0) {
              await new Promise((resolve) => window.setTimeout(resolve, delay));
            }

            const shouldFail =
              writeControls.failNextSequence === sequence ||
              writeControls.failNextPath === path;

            if (writeControls.failNextSequence === sequence) {
              writeControls.failNextSequence = null;
            }

            if (writeControls.failNextPath === path) {
              writeControls.failNextPath = null;
            }

            if (shouldFail) {
              event.status = "failed";
              event.completedAt = performance.now();
              writeStats.activeWrites -= 1;
              throw new Error("Injected fixture write failure: " + path);
            }

            try {
              await fetch(
                ${JSON.stringify(baseUrl)} + "/write?path=" + encodeURIComponent(path),
                { method: "POST", body: nextContent }
              ).then((response) => {
                if (!response.ok) {
                  throw new Error("Could not persist fixture write: " + path);
                }
              });
              overrides.set(path, nextContent);
              lastModifiedByPath.set(path, Date.now() + sequence);
              filePaths.add(path);
              const parent = path.split("/").slice(0, -1).join("/");

              if (parent) {
                directoryPaths.add(parent);
              }
              event.status = "completed";
            } catch (error) {
              event.status = "failed";
              throw error;
            } finally {
              event.completedAt = performance.now();
              writeStats.activeWrites -= 1;
            }
          }
        };
      }
    }

    class PatchmarkFixtureDirectoryHandle {
      constructor(path, name) {
        this.kind = "directory";
        this.name = name;
        this.path = normalizePath(path);
      }

      async getFileHandle(name, options = {}) {
        const path = joinPath(this.path, name);

        if (!filePaths.has(path)) {
          if (!options.create) {
            const exists = await fetch(
              ${JSON.stringify(baseUrl)} + "/exists?kind=file&path=" + encodeURIComponent(path)
            ).then((response) => response.ok);
            if (!exists) {
              throw notFound("Missing fixture file: " + path);
            }
          } else {
            overrides.set(path, "");
          }

          filePaths.add(path);
        }

        return new PatchmarkFixtureFileHandle(path);
      }

      async getDirectoryHandle(name, options = {}) {
        const path = joinPath(this.path, name);

        if (!directoryPaths.has(path)) {
          if (!options.create) {
            const exists = await fetch(
              ${JSON.stringify(baseUrl)} + "/exists?kind=directory&path=" + encodeURIComponent(path)
            ).then((response) => response.ok);
            if (!exists) {
              throw notFound("Missing fixture directory: " + path);
            }
          }

          directoryPaths.add(path);
        }

        return new PatchmarkFixtureDirectoryHandle(path, name);
      }

      async removeEntry(name, options = {}) {
        const path = joinPath(this.path, name);

        if (filePaths.has(path)) {
          await fetch(
            ${JSON.stringify(baseUrl)} + "/file?path=" + encodeURIComponent(path),
            { method: "DELETE" }
          ).then((response) => {
            if (!response.ok) {
              throw new Error("Could not remove fixture file: " + path);
            }
          });
          filePaths.delete(path);
          overrides.delete(path);
          return;
        }

        if (directoryPaths.has(path) && options.recursive) {
          for (const filePath of [...filePaths]) {
            if (filePath.startsWith(path + "/")) {
              filePaths.delete(filePath);
              overrides.delete(filePath);
            }
          }
          for (const directoryPath of [...directoryPaths]) {
            if (directoryPath === path || directoryPath.startsWith(path + "/")) {
              directoryPaths.delete(directoryPath);
            }
          }
          return;
        }

        throw notFound("Missing fixture entry: " + path);
      }

      async *entries() {
        const prefix = this.path ? this.path + "/" : "";
        for (const filePath of filePaths) {
          if (!filePath.startsWith(prefix)) continue;
          const relativePath = filePath.slice(prefix.length);
          if (!relativePath || relativePath.includes("/")) continue;
          yield [relativePath, new PatchmarkFixtureFileHandle(filePath)];
        }
        for (const directoryPath of directoryPaths) {
          if (!directoryPath.startsWith(prefix)) continue;
          const relativePath = directoryPath.slice(prefix.length);
          if (!relativePath || relativePath.includes("/")) continue;
          yield [
            relativePath,
            new PatchmarkFixtureDirectoryHandle(directoryPath, relativePath)
          ];
        }
      }

      async isSameEntry(other) {
        return other?.kind === "directory" && other?.path === this.path;
      }

      async resolve(possibleDescendant) {
        if (!possibleDescendant || typeof possibleDescendant.path !== "string") {
          return null;
        }
        if (possibleDescendant.path === this.path) {
          return [];
        }
        const prefix = this.path ? this.path + "/" : "";
        if (!possibleDescendant.path.startsWith(prefix)) {
          return null;
        }
        const relativePath = possibleDescendant.path.slice(prefix.length);
        return relativePath ? relativePath.split("/") : [];
      }
    }

    try {
      window.localStorage.setItem("patchmark:debug-comment-layout", "1");
    } catch {}

    window.__patchmarkFixtureWrites = overrides;
    window.__patchmarkFixtureReadLog = readLog;
    window.__patchmarkFixtureWriteLog = writeLog;
    window.__patchmarkFixtureWriteControls = writeControls;
    window.__patchmarkFixtureWriteStats = writeStats;
    window.__patchmarkFixtureSetFile = async (path, content) => {
      const normalizedPath = normalizePath(path);
      await fetch(
        ${JSON.stringify(baseUrl)} + "/write?path=" + encodeURIComponent(normalizedPath),
        { method: "POST", body: String(content) }
      ).then((response) => {
        if (!response.ok) throw new Error("Could not set fixture file: " + normalizedPath);
      });
      overrides.set(normalizedPath, String(content));
      lastModifiedByPath.set(normalizedPath, Date.now());
      filePaths.add(normalizedPath);
      return true;
    };
    window.__patchmarkFixtureReadFile = async (path) => {
      const normalizedPath = normalizePath(path);
      return fetch(
        ${JSON.stringify(baseUrl)} + "/file?path=" + encodeURIComponent(normalizedPath)
      ).then((response) => {
        if (!response.ok) throw notFound("Missing fixture file: " + normalizedPath);
        return response.text();
      });
    };
    if (filePickerQueue.length > 0) {
      window.showOpenFilePicker = async () => {
        const selectedPath = normalizePath(
          filePickerQueue[Math.min(filePickerIndex, filePickerQueue.length - 1)] ?? ""
        );
        filePickerIndex += 1;
        return [new PatchmarkFixtureFileHandle(selectedPath)];
      };
    }
    window.showDirectoryPicker = async () => {
      const selectedPath = normalizePath(
        pickerQueue[Math.min(pickerIndex, pickerQueue.length - 1)] ?? ""
      );
      pickerIndex += 1;
      const selectedName = selectedPath.split("/").pop() || ${JSON.stringify(projectName)};
      return new PatchmarkFixtureDirectoryHandle(selectedPath, selectedName);
    };
  })();`;
}

function findChromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForDevToolsUrl(process) {
  let stderr = "";

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for Chrome DevTools URL. stderr:\n${stderr}`
        )
      );
    }, 10000);

    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);

      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    process.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Chrome exited before DevTools was available (code ${code}, signal ${signal}). stderr:\n${stderr}`
        )
      );
    });
  });
}

async function waitForProcessExit(process, timeoutMs) {
  if (process.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    delay(timeoutMs)
  ]);
}

async function createPage(browserWsUrl, url) {
  const browserEndpoint = new URL(browserWsUrl);
  const response = await fetch(
    `http://${browserEndpoint.host}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create Chrome target (${response.status} ${response.statusText}).`
    );
  }

  const target = await response.json();

  return target.webSocketDebuggerUrl;
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    const client = new CdpClient(socket);

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    return client;
  }

  constructor(socket) {
    this.listeners = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
        return;
      }

      const pendingCall = this.pending.get(message.id);

      if (!pendingCall) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error) {
        pendingCall.reject(new Error(message.error.message));
      } else {
        pendingCall.resolve(message.result);
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;

    this.socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  async close() {
    this.socket.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runActualEditorRegression();
}

async function waitForEditorShell(client) {
  let latestState = null;

  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((element) => element.textContent?.trim() === "Open Project Folder" && !element.disabled);

        return {
          hasButton: Boolean(button),
          hydrated: button
            ? Object.keys(button).some((key) => key.startsWith("__reactProps$"))
            : false
        };
      })()`
    });

    latestState = state;

    if (state.hasButton && state.hydrated) {
      return;
    }

    await delay(50);
  }

  throw new Error(
    `Timed out waiting for editor shell.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function waitForProjectComments(client) {
  let latestState = null;

  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await evaluate(client, {
      expression: `({
        comments: document.querySelectorAll(".comment-floating-item article[aria-label]").length,
        projectText: Array.from(document.querySelectorAll("*"))
          .some((element) => element.textContent?.includes("Project:")),
        alerts: Array.from(document.querySelectorAll("[role='alert'], .comments-error"))
          .map((element) => element.textContent?.trim())
          .filter(Boolean),
        statusText: Array.from(document.querySelectorAll("[aria-label='Workspace status'] *"))
          .map((element) => element.textContent?.trim())
          .filter(Boolean),
        bodyText: document.body.textContent?.slice(0, 1000)
      })`
    });

    latestState = state;

    if (state.comments >= 5 && state.projectText) {
      return;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for real project comments.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function ensureCommentsRailOpen(client) {
  const state = await readCommentsRailSemanticState(client);

  if (!state.hidden) {
    return;
  }

  await evaluate(client, {
    expression: `(() => {
      const trigger = document.querySelector(".application-comments-trigger");
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) {
        throw new Error("Comments trigger is unavailable");
      }
      trigger.click();
      return true;
    })()`,
    userGesture: true
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = await readCommentsRailSemanticState(client);
    if (next.expanded && !next.hidden) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for the Comments rail to open.");
}

async function closeCommentsRail(client) {
  const state = await readCommentsRailSemanticState(client);

  if (state.hidden) {
    return;
  }

  await evaluate(client, {
    expression: `(() => {
      const button = document.querySelector(".comments-panel-close");
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        throw new Error("Comments close control is unavailable");
      }
      button.click();
      return true;
    })()`,
    userGesture: true
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = await readCommentsRailSemanticState(client);
    if (!next.expanded && next.hidden) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for the Comments rail to close.");
}

async function readCommentsRailSemanticState(client) {
  return evaluate(client, {
    expression: `(() => {
      const trigger = document.querySelector(".application-comments-trigger");
      const panel = document.querySelector("#document-comments-panel");
      const visualButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Visual Mode");
      return {
        controlsPanel: trigger?.getAttribute("aria-controls") === "document-comments-panel",
        editorInteractive: visualButton instanceof HTMLButtonElement && !visualButton.disabled,
        expanded: trigger?.getAttribute("aria-expanded") === "true",
        hidden: panel?.hidden ?? true,
        modal: panel?.getAttribute("role") === "dialog",
        triggerExists: trigger instanceof HTMLButtonElement
      };
    })()`
  });
}

async function waitForStableState(client, label, expectedActiveId) {
  let previousMeasurement = null;
  let latestMeasurement = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const currentMeasurement = await measureEditorRail(client, label);

    latestMeasurement = currentMeasurement;

    if (currentMeasurement.activeId !== expectedActiveId) {
      previousMeasurement = null;
      await delay(75);
      continue;
    }

    if (
      previousMeasurement &&
      haveStableRows(previousMeasurement.rows, currentMeasurement.rows)
    ) {
      return currentMeasurement;
    }

    previousMeasurement = currentMeasurement;
    await delay(75);
  }

  throw new Error(
    `Timed out waiting for stable actual-editor state: ${label}.\n${JSON.stringify(
      latestMeasurement,
      null,
      2
    )}`
  );
}

function haveStableRows(firstRows, secondRows) {
  return firstRows.every((firstRow, index) => {
    const secondRow = secondRows[index];

    return (
      firstRow.id === secondRow.id &&
      firstRow.active === secondRow.active &&
      firstRow.measuredHeight === secondRow.measuredHeight &&
      Math.abs(firstRow.renderedDomTop - secondRow.renderedDomTop) <=
        movementTolerance
    );
  });
}

async function scrollToTop(client) {
  await evaluate(client, {
    expression: `window.scrollTo({ top: 0, left: 0, behavior: "instant" }); true`
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const scrollY = await evaluate(client, {
      expression: `Math.round(window.scrollY)`
    });

    if (scrollY === 0) {
      return;
    }

    await delay(50);
  }

  throw new Error("Timed out waiting for the editor page to scroll to top.");
}

async function scrollCommentIntoView(client, commentId) {
  let latestState = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const item = document.querySelector(${JSON.stringify(`[data-comment-id="${commentId}"]`)});

        if (!item) {
          throw new Error("Comment item not found: ${commentId}");
        }

        const rect = item.getBoundingClientRect();
        const desiredTop = 220;

        if (rect.top < desiredTop || rect.top > window.innerHeight - 260) {
          window.scrollTo({
            top: Math.max(0, Math.round(window.scrollY + rect.top - desiredTop)),
            left: 0,
            behavior: "instant"
          });
        }

        return {
          cardTop: Math.round(rect.top),
          cardBottom: Math.round(rect.bottom),
          scrollY: Math.round(window.scrollY),
          visible: rect.top >= 80 && rect.top <= window.innerHeight - 160
        };
      })()`
    });

    latestState = state;

    if (state.visible) {
      return state;
    }

    await delay(75);
  }

  throw new Error(
    `Timed out scrolling ${commentId} into view.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function clickButtonByText(client, text) {
  await evaluate(client, {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && !element.disabled);

      if (!button) {
        throw new Error("Button not found: ${text}");
      }

      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function activateComment(client, commentId) {
  await clickElementCenter(client, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(`[data-comment-id="${commentId}"]`)});
      const article = item?.querySelector("article[aria-label]");

      if (!article) {
        throw new Error("Comment card not found: ${commentId}");
      }

      const rect = article.getBoundingClientRect();

      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + Math.min(rect.height / 2, 80))
      };
    })()`
  });
}

async function clickElementCenter(client, { expression }) {
  const point = await evaluate(client, { expression });

  await client.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mouseMoved",
    x: point.x,
    y: point.y
  });
  await client.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
  await client.call("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function measureEditorRail(client, label) {
  return await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector("[data-regression-active-id]");
      const stage = document.querySelector(".comment-floating-stage");
      const rail = document.querySelector(".comments-rail");
      const editor = document.querySelector(".editor-panel");
      const stageRect = stage?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const documentScrollTop = Math.round(window.scrollY);
      const layoutEvents = window.__patchmarkCommentLayoutDebugEvents ?? [];
      const latestEvent = layoutEvents.at(-1) ?? null;
      const latestRowsById = Object.fromEntries(
        (latestEvent?.rows ?? []).map((row) => [row.commentId, row])
      );
      const rows = Array.from(document.querySelectorAll(".comment-floating-item")).map((item, order) => {
        const id = item.getAttribute("data-comment-id") ?? "";
        const article = item.querySelector("article[aria-label]");
        const itemRect = item.getBoundingClientRect();
        const articleRect = article?.getBoundingClientRect();
        const style = getComputedStyle(item);
        const debugRow = latestRowsById[id] ?? null;
        const preferredTop = numberOrNull(item.getAttribute("data-comment-preferred-top"));
        const anchorTargetY = debugRow?.anchorContainerTop ?? preferredTop;
        const anchorViewportTop = preferredTop !== null && stageRect
          ? Math.round(stageRect.top + preferredTop)
          : debugRow?.anchorViewportTop ?? null;
        const anchorDocumentY = anchorViewportTop !== null
          ? anchorViewportTop + documentScrollTop
          : null;

        return {
          id,
          order,
          active: article?.getAttribute("aria-current") === "true",
          anchorStatus: item.getAttribute("data-comment-anchor-status"),
          anchorKind: item.getAttribute("data-comment-anchor-kind"),
          commentStatus: item.getAttribute("data-comment-status"),
          commentType: item.getAttribute("data-comment-type"),
          threadCount: Number(item.getAttribute("data-comment-thread-count") ?? 0),
          patchImpactCount: Number(item.getAttribute("data-comment-patch-impact-count") ?? 0),
          pendingPatchCount: Number(item.getAttribute("data-comment-pending-patch-count") ?? 0),
          anchorStartOffset: numberOrNull(item.getAttribute("data-comment-anchor-start")),
          anchorEndOffset: numberOrNull(item.getAttribute("data-comment-anchor-end")),
          anchorDocumentY,
          anchorViewportTop,
          anchorTargetY,
          measuredHeight: Math.round(itemRect.height),
          articleHeight: articleRect ? Math.round(articleRect.height) : null,
          preferredTop,
          layoutTop: numberOrNull(item.getAttribute("data-comment-layout-top")),
          inlineTop: item.style.top || null,
          transform: style.transform === "none" ? null : style.transform,
          renderedDomTop: stageRect ? Math.round(itemRect.top - stageRect.top) : null,
          viewportTop: Math.round(itemRect.top),
          parentIdentity: \`\${item.parentElement?.tagName.toLowerCase()}.\${item.parentElement?.className}\`
        };
      });

      function numberOrNull(value) {
        if (value === null || value === "") {
          return null;
        }

        const number = Number(value);

        return Number.isFinite(number) ? number : null;
      }

      return {
        label: ${JSON.stringify(label)},
        activeId: document.querySelector("article[aria-current='true']")
          ?.getAttribute("aria-label")
          ?.replace(/^Active comment /, "") ?? "none",
        fixtureActiveId: root?.getAttribute("data-regression-active-id") ?? null,
        railScrollTop: rail?.scrollTop ?? null,
        documentScrollTop,
        editorScrollTop: editor?.scrollTop ?? null,
        stageOffsetTop: stageRect && railRect ? Math.round(stageRect.top - railRect.top) : null,
        stageHeight: stageRect ? Math.round(stageRect.height) : null,
        layoutPassCount: layoutEvents.length,
        latestLayoutPass: latestEvent?.layoutPass ?? null,
        rows
      };
    })()`
  });
}

async function readLayoutEvents(client) {
  return await evaluate(client, {
    expression: `(window.__patchmarkCommentLayoutDebugEvents ?? []).slice(-30)`
  });
}

async function capturePhase5VisualEvidence(client, outputDir) {
  mkdirSync(outputDir, { recursive: true });

  const evidence = [];

  evidence.push(
    await captureCommentHighlightEvidence({
      client,
      commentId: lowerCommentId,
      expectedVisibleText: "lower aurora relay phrase",
      label: "lower-aurora-relay",
      outputDir
    })
  );

  const hasLineComment = await evaluate(client, {
    expression: `Boolean(document.querySelector(${JSON.stringify(
      `[data-comment-id="${lineCommentId}"]`
    )}))`
  });

  if (hasLineComment) {
    evidence.push(
      await captureCommentHighlightEvidence({
        client,
        commentId: lineCommentId,
        expectedVisibleText: "violet relay signal",
        label: "violet-relay-signal",
        outputDir
      })
    );
  }

  const hasLinkedMultiBlockComment = await evaluate(client, {
    expression: `Boolean(document.querySelector(${JSON.stringify(
      `[data-comment-id="${linkedMultiBlockCommentId}"]`
    )}))`
  });

  if (hasLinkedMultiBlockComment) {
    evidence.push(
      await captureCommentHighlightEvidence({
        client,
        commentId: linkedMultiBlockCommentId,
        expectedVisibleText: "linked replacement now maps",
        label: "linked-synthetic-replacement",
        outputDir
      })
    );
  }

  if (shouldRunFullVisualAudit) {
    evidence.push(await auditAllSelectedTextCommentHighlights(client));
  }

  return evidence;
}

async function auditAllSelectedTextCommentHighlights(client) {
  const rows = await readAllCommentRows(client);
  const selectedRows = rows.filter((row) => row.anchorKind === "selected_text");
  const resolvedSelectedRows = selectedRows.filter(
    (row) => row.anchorStatus === "active"
  );
  const projectSelectedCommentCount = getProjectSelectedTextCommentCount();
  const unexpectedlyUnresolvedLinkedReplacements =
    findUnexpectedlyUnresolvedLinkedReplacementComments(rows);
  const failures = [];
  let projectionPasses = 0;
  let highlightPasses = 0;
  let findConsistencyPasses = 0;
  let railPositionPasses = 0;
  let switchRestorePasses = 0;

  for (const row of resolvedSelectedRows) {
    try {
      assert.equal(typeof row.anchorStartOffset, "number");
      assert.equal(typeof row.anchorEndOffset, "number");
      assert.ok(row.anchorEndOffset >= row.anchorStartOffset);
      projectionPasses += 1;

      await scrollCommentIntoView(client, row.id);
      await activateComment(client, row.id);
      const highlighted = await waitForActiveHighlightState(client, row.id);
      highlightPasses += 1;
      assert.deepEqual(
        getActiveTargetSignature(highlighted.activeRow),
        getActiveTargetSignature(row)
      );

      assert.equal(typeof highlighted.activeRow?.preferredTop, "number");
      assert.equal(typeof highlighted.activeRow?.layoutTop, "number");
      railPositionPasses += 1;

      await clickCommentFind(client, row.id);
      await waitForMarkdownSelection(client, row);
      findConsistencyPasses += 1;

      await clickButtonByText(client, "Visual Mode");
      await waitForVisualEditorProjection(client);
      await scrollCommentIntoView(client, row.id);
      await activateComment(client, row.id);
      const restored = await waitForActiveHighlightState(client, row.id);
      assert.deepEqual(
        getActiveTargetSignature(restored.activeRow),
        getActiveTargetSignature(row)
      );
      switchRestorePasses += 1;
    } catch (error) {
      failures.push({
        error: error instanceof Error ? error.message : String(error),
        id: row.id
      });
    }
  }

  assert.deepEqual(
    [...unexpectedlyUnresolvedLinkedReplacements, ...failures],
    [],
    "Every uniquely resolved selected-text comment should paint a visual highlight, and directly linked accepted replacements must not be silently excluded."
  );

  return {
    failedCount: failures.length,
    failures,
    findConsistencyPasses,
    highlightPasses,
    kind: "full-selected-text-visual-audit",
    passedCount: resolvedSelectedRows.length,
    projectionPasses,
    railPositionPasses,
    renderedRailRows: rows.length,
    resolvedSelectedTextCount: resolvedSelectedRows.length,
    selectedTextCount: projectSelectedCommentCount ?? selectedRows.length,
    switchRestorePasses,
    unexpectedlyUnresolvedLinkedReplacementCount:
      unexpectedlyUnresolvedLinkedReplacements.length
  };
}

async function waitForMarkdownSelection(client, row) {
  let latestState = null;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await evaluate(client, {
      expression: `(() => {
        const textarea = document.querySelector(".markdown-source-editor");
        return textarea
          ? {
              end: textarea.selectionEnd,
              hasFocus: document.activeElement === textarea,
              start: textarea.selectionStart
            }
          : null;
      })()`
    });
    latestState = state;

    if (
      state?.hasFocus &&
      state.start === row.anchorStartOffset &&
      state.end === row.anchorEndOffset
    ) {
      return;
    }

    await delay(100);
  }

  throw new Error(
    `Find selection did not match ${row.id}: expected ${row.anchorStartOffset}-${row.anchorEndOffset}, received ${JSON.stringify(
      latestState
    )}`
  );
}

async function clickCommentFind(client, commentId) {
  const location = await evaluate(client, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"]`
      )});
      const button = Array.from(item?.querySelectorAll("button") ?? [])
        .find((element) => /^Find(?: |$)/.test(element.textContent?.trim() ?? "") && !element.disabled);

      if (button) {
        button.click();
        return "direct";
      }

      const menuTrigger = item?.querySelector(".comment-action-menu-trigger");
      if (!(menuTrigger instanceof HTMLButtonElement) || menuTrigger.disabled) {
        throw new Error("Find action is unavailable for ${commentId}");
      }
      menuTrigger.click();
      return "menu";
    })()`,
    userGesture: true
  });

  if (location === "direct") {
    return;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const clicked = await evaluate(client, {
      expression: `(() => {
        const button = Array.from(document.querySelectorAll(".comment-action-menu-panel [role='menuitem']"))
          .find((element) => element.textContent?.trim() === "Find in document" && !element.disabled && element.getClientRects().length > 0);
        if (!button) return false;
        button.click();
        return true;
      })()`,
      userGesture: true
    });
    if (clicked) return;
    await delay(50);
  }
  throw new Error(`Find menu item not found for ${commentId}`);
}

function getActiveTargetSignature(row) {
  return row
    ? {
        anchorEndOffset: row.anchorEndOffset,
        anchorKind: row.anchorKind,
        anchorStartOffset: row.anchorStartOffset,
        anchorStatus: row.anchorStatus
      }
    : null;
}

function getProjectSelectedTextCommentCount() {
  const projectComments = readProjectCommentsForAudit();

  return projectComments
    ? projectComments.filter((comment) => comment.anchor?.kind === "selected_text")
        .length
    : null;
}

function findUnexpectedlyUnresolvedLinkedReplacementComments(rows) {
  const projectComments = readProjectCommentsForAudit();
  const projectPatches = readProjectPatchesForAudit();

  if (!projectComments || !projectPatches) {
    return [];
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return projectComments.flatMap((comment) => {
    if (comment.anchor?.kind !== "selected_text") {
      return [];
    }

    const row = rowsById.get(comment.id);

    if (row?.anchorStatus === "active") {
      return [];
    }

    const linkedAcceptedPatches = projectPatches.filter(
      (patch) =>
        patch.status === "accepted" &&
        patch.comment_id === comment.id &&
        getAuditPatchAppliedText(patch).trim()
    );
    const failedPatch = linkedAcceptedPatches.find((patch) =>
      hasHistoricalSelectedAnchorCoveredByPatchOriginalForAudit(comment, patch)
    );

    return failedPatch
      ? [
          {
            anchorStatus: row?.anchorStatus ?? "missing_from_rail",
            error:
              "Directly linked accepted patch has a non-empty replacement, but the selected-text comment is not actively positioned.",
            id: comment.id,
            patchId: failedPatch.id
          }
        ]
      : [];
  });
}

function readProjectCommentsForAudit() {
  return readProjectJsonForAudit(join(".patchmark", "comments.json"));
}

function readProjectPatchesForAudit() {
  return readProjectJsonForAudit(join(".patchmark", "patches.json"));
}

function readProjectJsonForAudit(relativePath) {
  if (!projectDir) {
    return null;
  }

  const filePath = join(projectDir, relativePath);

  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, "utf8"));
}

function hasHistoricalSelectedAnchorCoveredByPatchOriginalForAudit(
  comment,
  patch
) {
  const anchors = getHistoricalSelectedAnchorsForAudit(comment);

  return anchors.some((anchor) =>
    isSelectedAnchorCoveredByPatchOriginalForAudit(anchor, patch)
  );
}

function getHistoricalSelectedAnchorsForAudit(comment) {
  const anchors = [];

  if (comment.anchor?.kind === "selected_text") {
    anchors.push(comment.anchor);
  }

  for (const historyEntry of [...(comment.anchor_history ?? [])].reverse()) {
    if (historyEntry.format_version === 2) {
      for (const state of [historyEntry.next, historyEntry.previous]) {
        if (
          state?.kind === "selected_text" &&
          typeof state.selected_text_excerpt === "string" &&
          state.selected_text_excerpt.length === state.selected_text_length
        ) {
          anchors.push({
            kind: "selected_text",
            selected_text: state.selected_text_excerpt,
            selected_text_hash: state.selected_text_hash,
            markdown_start_offset: state.start,
            markdown_end_offset: state.end,
            containing_heading: state.containing_heading,
            containing_heading_path: state.containing_heading_path
          });
        }
      }
      continue;
    }

    if (historyEntry.new_anchor?.kind === "selected_text") {
      anchors.push(historyEntry.new_anchor);
    }

    if (historyEntry.previous_anchor?.kind === "selected_text") {
      anchors.push(historyEntry.previous_anchor);
    }
  }

  const seen = new Set();

  return anchors.filter((anchor) => {
    const key = [
      anchor.selected_text,
      anchor.markdown_start_offset ?? "",
      anchor.markdown_end_offset ?? "",
      anchor.anchor_context?.markdown_start_offset ?? "",
      anchor.anchor_context?.markdown_end_offset ?? "",
      anchor.anchor_context?.markdown_text ?? ""
    ].join("\u0000");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isSelectedAnchorCoveredByPatchOriginalForAudit(anchor, patch) {
  if (!anchor.selected_text?.trim() || !patch.original_text?.trim()) {
    return false;
  }

  const knownRange = getSelectedAnchorKnownRangeForAudit(anchor);
  const originalStart = patch.applied_start_offset;

  if (typeof originalStart === "number" && knownRange) {
    const relativeStart = knownRange.start - originalStart;
    const relativeEnd = knownRange.end - originalStart;

    if (
      relativeStart >= 0 &&
      relativeEnd >= relativeStart &&
      relativeEnd <= patch.original_text.length
    ) {
      const candidateText = patch.original_text.slice(relativeStart, relativeEnd);

      if (
        normalizeAuditMarkdownText(candidateText) ===
          normalizeAuditMarkdownText(anchor.selected_text) ||
        toAuditMarkdownPlainText(candidateText) ===
          toAuditMarkdownPlainText(anchor.selected_text)
      ) {
        return true;
      }
    }
  }

  return (
    countAuditTextMatches(patch.original_text, anchor.selected_text) === 1 ||
    countAuditTextMatches(
      toAuditMarkdownPlainText(patch.original_text),
      toAuditMarkdownPlainText(anchor.selected_text)
    ) === 1
  );
}

function getSelectedAnchorKnownRangeForAudit(anchor) {
  if (
    typeof anchor.markdown_start_offset === "number" &&
    typeof anchor.markdown_end_offset === "number"
  ) {
    return {
      start: anchor.markdown_start_offset,
      end: anchor.markdown_end_offset
    };
  }

  if (
    typeof anchor.anchor_context?.markdown_start_offset === "number" &&
    typeof anchor.anchor_context.markdown_end_offset === "number"
  ) {
    return {
      start: anchor.anchor_context.markdown_start_offset,
      end: anchor.anchor_context.markdown_end_offset
    };
  }

  return null;
}

function getAuditPatchAppliedText(patch) {
  return patch.applied_text ?? patch.suggested_text ?? "";
}

function countAuditTextMatches(text, searchText) {
  const normalizedText = normalizeAuditMarkdownText(text);
  const normalizedSearchText = normalizeAuditMarkdownText(searchText);

  if (!normalizedSearchText) {
    return 0;
  }

  let count = 0;
  let fromIndex = 0;

  while (fromIndex <= normalizedText.length) {
    const index = normalizedText.indexOf(normalizedSearchText, fromIndex);

    if (index === -1) {
      break;
    }

    count += 1;
    fromIndex = index + normalizedSearchText.length;
  }

  return count;
}

function normalizeAuditMarkdownText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function toAuditMarkdownPlainText(markdown) {
  return normalizeAuditMarkdownText(
    String(markdown ?? "")
      .split("\n")
      .map((line) => line.replace(/^\s*(?:>\s*)?(?:[-*+]\s+|\d+\.\s+)?/, ""))
      .join("\n")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/`/g, "")
  );
}

async function readAllCommentRows(client) {
  return await evaluate(client, {
    expression: `(() => {
      return Array.from(document.querySelectorAll(".comment-floating-item")).map((item, order) => ({
        anchorEndOffset: numberOrNull(item.getAttribute("data-comment-anchor-end")),
        anchorKind: item.getAttribute("data-comment-anchor-kind"),
        anchorStartOffset: numberOrNull(item.getAttribute("data-comment-anchor-start")),
        anchorStatus: item.getAttribute("data-comment-anchor-status"),
        commentStatus: item.getAttribute("data-comment-status"),
        id: item.getAttribute("data-comment-id") ?? "",
        layoutTop: numberOrNull(item.getAttribute("data-comment-layout-top")),
        preferredTop: numberOrNull(item.getAttribute("data-comment-preferred-top")),
        order
      }));

      function numberOrNull(value) {
        if (value === null || value === "") {
          return null;
        }

        const number = Number(value);

        return Number.isFinite(number) ? number : null;
      }
    })()`
  });
}

async function captureCommentHighlightEvidence({
  client,
  commentId,
  expectedVisibleText,
  label,
  outputDir,
  rejectVisibleText
}) {
  await scrollCommentIntoView(client, commentId);
  await activateComment(client, commentId);
  await waitForStableState(client, `phase5 ${label}`, commentId);

  const state = await waitForActiveHighlightState(client, commentId);

  assert.equal(state.activeId, commentId);
  assert.ok(
    state.highlightRectCount > 0,
    `${commentId} should paint a visible CSS Highlight range.`
  );
  assert.equal(
    state.editorText.includes(expectedVisibleText),
    true,
    `${commentId} rendered document text should include ${expectedVisibleText}.`
  );

  if (rejectVisibleText) {
    assert.equal(
      state.editorText.includes(rejectVisibleText),
      false,
      `${commentId} rendered document text should not expose raw Markdown URL syntax.`
    );
  }

  const screenshotPath = join(outputDir, `${label}.png`);

  await capturePageScreenshot(client, screenshotPath);

  return {
    activeId: state.activeId,
    anchorEndOffset: state.activeRow?.anchorEndOffset ?? null,
    anchorKind: state.activeRow?.anchorKind ?? null,
    anchorStartOffset: state.activeRow?.anchorStartOffset ?? null,
    commentId,
    highlightRectCount: state.highlightRectCount,
    screenshotPath
  };
}

async function waitForActiveHighlightState(client, commentId) {
  let latestState = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await readActiveHighlightState(client, commentId);

    latestState = state;

    if (state.activeId === commentId && state.highlightRectCount > 0) {
      return state;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for active highlight for ${commentId}.\n${JSON.stringify(
      latestState,
      null,
      2
    )}`
  );
}

async function readActiveHighlightState(client, commentId) {
  return await evaluate(client, {
    expression: `(() => {
      const item = document.querySelector(${JSON.stringify(
        `[data-comment-id="${commentId}"]`
      )});
      const activeId = document
        .querySelector("article[aria-current='true']")
        ?.getAttribute("aria-label")
        ?.replace(/^Active comment /, "") ?? "none";
      const activeRow = item
        ? {
            anchorEndOffset: numberOrNull(item.getAttribute("data-comment-anchor-end")),
            anchorKind: item.getAttribute("data-comment-anchor-kind"),
            anchorStartOffset: numberOrNull(item.getAttribute("data-comment-anchor-start")),
            anchorStatus: item.getAttribute("data-comment-anchor-status"),
            commentStatus: item.getAttribute("data-comment-status"),
            id: item.getAttribute("data-comment-id"),
            layoutTop: numberOrNull(item.getAttribute("data-comment-layout-top")),
            preferredTop: numberOrNull(item.getAttribute("data-comment-preferred-top"))
          }
        : null;
      const highlightNames = [
        "patchmark-comment-open-selected-anchor",
        "patchmark-comment-resolved-selected-anchor"
      ];
      let highlightRectCount = 0;

      for (const name of highlightNames) {
        const highlight = globalThis.CSS?.highlights?.get(name);

        if (!highlight) {
          continue;
        }

        for (const range of highlight) {
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) {
              highlightRectCount += 1;
            }
          }
        }
      }

      return {
        activeId,
        activeRow,
        editorText: document.querySelector(".patchmark-prose")?.textContent ?? "",
        highlightRectCount
      };

      function numberOrNull(value) {
        if (value === null || value === "") {
          return null;
        }

        const number = Number(value);

        return Number.isFinite(number) ? number : null;
      }
    })()`
  });
}

async function capturePageScreenshot(client, filePath) {
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });

  writeFileSync(filePath, Buffer.from(result.data, "base64"));
}

async function evaluate(client, { expression, userGesture = false }) {
  const result = await client.call("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
    );
  }

  return result.result.value;
}

function chooseScrollActivationTargets(rows) {
  const top = rows.find((row) => row.id === topCommentId);
  const lower = rows.find((row) => row.id === lowerCommentId);

  assert.ok(top, `Expected top whole-document comment ${topCommentId}.`);
  assert.ok(lower, `Expected lower Public reference comment ${lowerCommentId}.`);
  assert.equal(top.anchorKind, "document");
  assert.equal(top.commentStatus, "resolved");
  assert.equal(top.commentType, "research_needed");
  assert.ok(top.threadCount >= 10, "Top comment should contain a long thread.");
  assert.equal(lower.anchorKind, "selected_text");
  assert.ok(
    ["open", "resolved"].includes(lower.commentStatus),
    "Lower selected-text comment may be open or resolved; status must not affect geometry."
  );
  assert.equal(lower.commentType, "research_needed");
  assert.ok(
    lower.anchorTargetY - top.anchorTargetY > viewportHeight,
    "Lower comment should require substantial scrolling from the top comment."
  );

  return {
    lower,
    top
  };
}

function assertActualEditorMeasurements(measurements, targets) {
  const initial = measurements[0];
  const initialRows = Object.fromEntries(initial.rows.map((row) => [row.id, row]));
  const initialOrder = initial.rows.map((row) => row.id);
  const afterTop = findMeasurement(measurements, "after top activation");
  const firstScrollDown = findMeasurement(
    measurements,
    "after scroll before lower activation"
  );
  const afterLower = findMeasurement(measurements, "after lower activation");
  const firstScrollUp = findMeasurement(
    measurements,
    "after scroll up before top reactivation"
  );
  const afterTopAgain = findMeasurement(
    measurements,
    "after top reactivation"
  );
  const secondScrollDown = findMeasurement(
    measurements,
    "second scroll before lower activation"
  );
  const secondLower = findMeasurement(measurements, "second lower activation");
  const secondScrollUp = findMeasurement(
    measurements,
    "second scroll up before top activation"
  );
  const secondTop = findMeasurement(measurements, "second top reactivation");

  for (const measurement of measurements) {
    assert.deepEqual(
      measurement.rows.map((row) => row.id),
      initialOrder,
      `${measurement.label} should keep real comment order stable`
    );
    assert.equal(
      measurement.railScrollTop,
      initial.railScrollTop,
      `${measurement.label} should not scroll the rail`
    );
    assert.equal(
      measurement.editorScrollTop,
      initial.editorScrollTop,
      `${measurement.label} should not scroll the editor`
    );

    for (const row of measurement.rows) {
      const initialRow = initialRows[row.id];
      const expectedAnchorViewportTop =
        initialRow.anchorViewportTop === null
          ? null
          : initialRow.anchorViewportTop -
            (measurement.documentScrollTop - initial.documentScrollTop);

      assert.equal(
        row.anchorStatus,
        initialRow.anchorStatus,
        `${measurement.label} should keep ${row.id} anchor status stable`
      );
      assert.equal(
        row.anchorStartOffset,
        initialRow.anchorStartOffset,
        `${measurement.label} should keep ${row.id} anchor start stable`
      );
      assert.equal(
        row.anchorEndOffset,
        initialRow.anchorEndOffset,
        `${measurement.label} should keep ${row.id} anchor end stable`
      );
      assertNear(
        row.anchorTargetY,
        initialRow.anchorTargetY,
        scrollMovementTolerance,
        `${measurement.label} should keep ${row.id} anchor target stable`
      );
      assertNear(
        row.anchorDocumentY,
        initialRow.anchorDocumentY,
        scrollMovementTolerance,
        `${measurement.label} should keep ${row.id} document-relative anchor stable`
      );
      assertNear(
        row.anchorViewportTop,
        expectedAnchorViewportTop,
        scrollMovementTolerance,
        `${measurement.label} should move ${row.id} viewport anchor only by document scroll`
      );
      assert.equal(
        row.parentIdentity,
        initialRow.parentIdentity,
        `${measurement.label} should keep ${row.id} in the same parent`
      );
      assert.equal(
        row.transform,
        null,
        `${measurement.label} should not move ${row.id} through transform`
      );
      assertNear(
        row.layoutTop,
        row.renderedDomTop,
        movementTolerance,
        `${measurement.label} should render ${row.id} at layout top`
      );
    }
  }

  assertNearTopScroll(initial);
  assertNearTopScroll(afterTop);
  assertSubstantialDocumentScroll(firstScrollDown, targets.lower.id);
  assertNear(
    afterLower.documentScrollTop,
    firstScrollDown.documentScrollTop,
    scrollMovementTolerance,
    "Lower activation should not unexpectedly scroll the document"
  );
  assertSubstantialDocumentScroll(afterLower, targets.lower.id);
  assertNearTopScroll(firstScrollUp);
  assertNearTopScroll(afterTopAgain);
  assertSubstantialDocumentScroll(secondScrollDown, targets.lower.id);
  assertNear(
    secondLower.documentScrollTop,
    secondScrollDown.documentScrollTop,
    scrollMovementTolerance,
    "Second lower activation should not unexpectedly scroll the document"
  );
  assertSubstantialDocumentScroll(secondLower, targets.lower.id);
  assertNearTopScroll(secondScrollUp);
  assertNearTopScroll(secondTop);

  assertCardVisible(firstScrollDown, targets.lower.id);
  assertCardVisible(afterLower, targets.lower.id);
  assertCardVisible(firstScrollUp, targets.top.id);
  assertCardVisible(afterTopAgain, targets.top.id);
  assertCardVisible(secondScrollDown, targets.lower.id);
  assertCardVisible(secondLower, targets.lower.id);
  assertCardVisible(secondScrollUp, targets.top.id);
  assertCardVisible(secondTop, targets.top.id);

  assertNoEarlierCommentGathering(initial, afterLower, targets);
  assertNoEarlierCommentGathering(initial, secondLower, targets);

  assertRenderedTopsNear(
    afterTopAgain,
    afterTop,
    "Reactivating the top actual editor comment should be deterministic"
  );
  assertRenderedTopsNear(
    secondTop,
    afterTop,
    "Second top activation should not accumulate rail drift"
  );
  assertRenderedTopsNear(
    secondScrollDown,
    firstScrollDown,
    "Repeating top-scroll-lower setup should be deterministic"
  );
  assertRenderedTopsNear(
    secondLower,
    afterLower,
    "Repeating lower activation should not accumulate rail drift"
  );
}

function assertNearTopScroll(measurement) {
  assert.ok(
    measurement.documentScrollTop <= nearTopScrollTolerance,
    `${measurement.label} should be measured near the top of the document, got scrollY ${measurement.documentScrollTop}`
  );
}

function assertSubstantialDocumentScroll(measurement, visibleCommentId) {
  const minimumScroll = Math.max(500, Math.floor(viewportHeight * 0.6));

  assert.ok(
    measurement.documentScrollTop >= minimumScroll,
    `${measurement.label} should keep nonzero substantial document scroll before ${visibleCommentId}; got ${measurement.documentScrollTop}`
  );
}

function assertCardVisible(measurement, commentId) {
  const row = getRow(measurement, commentId);

  assert.ok(
    row.viewportTop >= 0 && row.viewportTop <= viewportHeight - 120,
    `${measurement.label} should keep ${commentId} visibly reachable in the viewport; top ${row.viewportTop}`
  );
}

function assertNoEarlierCommentGathering(initial, measurement, targets) {
  const initialRows = Object.fromEntries(initial.rows.map((row) => [row.id, row]));
  const initialLower = getRow(initial, targets.lower.id);
  const lowerRow = getRow(measurement, targets.lower.id);
  const topRow = getRow(measurement, targets.top.id);

  assert.ok(
    lowerRow.renderedDomTop - topRow.renderedDomTop > viewportHeight,
    `${measurement.label} should not gather ${targets.top.id} near ${targets.lower.id}`
  );

  for (const row of measurement.rows) {
    const initialRow = initialRows[row.id];

    if (
      initialRow.order < initialLower.order &&
      initialLower.anchorTargetY - initialRow.anchorTargetY > viewportHeight
    ) {
      assert.ok(
        lowerRow.renderedDomTop - row.renderedDomTop > viewportHeight / 2,
        `${measurement.label} should not pull earlier ${row.id} into the lower active card cluster`
      );
    }
  }
}

function assertRenderedTopsNear(actualMeasurement, expectedMeasurement, message) {
  const expectedRows = Object.fromEntries(
    expectedMeasurement.rows.map((row) => [row.id, row])
  );

  for (const actualRow of actualMeasurement.rows) {
    assertNear(
      actualRow.renderedDomTop,
      expectedRows[actualRow.id].renderedDomTop,
      scrollMovementTolerance,
      `${message}: ${actualRow.id}`
    );
  }
}

function findMeasurement(measurements, label) {
  const measurement = measurements.find((candidate) => candidate.label === label);

  assert.ok(measurement, `Missing measurement: ${label}.`);

  return measurement;
}

function getRow(measurement, commentId) {
  const row = measurement.rows.find((candidate) => candidate.id === commentId);

  assert.ok(row, `${measurement.label} should include ${commentId}.`);

  return row;
}

function assertNear(actual, expected, tolerance, message) {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, message);
    return;
  }

  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}; expected ${expected}, got ${actual}, tolerance ${tolerance}`
  );
}

function printEditorSummary({
  fixtureContract,
  finalRailState,
  layoutEvents,
  measurements,
  projectDir,
  targets,
  url,
  visualEvidence = []
}) {
  const compactRows = measurements[0].rows;
  const lowerIndex = compactRows.findIndex((row) => row.id === targets.lower.id);
  const interestingIds = new Set([
    targets.top.id,
    targets.lower.id,
    ...compactRows
      .slice(
        Math.max(0, lowerIndex - 3),
        lowerIndex + 4
      )
      .map((row) => row.id)
  ]);
  const summary = {
    fixtureContract: { ...fixtureContract, markdown: undefined },
    finalRailState,
    projectDir,
    url,
    targets,
    measurements: measurements.map((measurement) => ({
      label: measurement.label,
      activeId: measurement.activeId,
      layoutPassCount: measurement.layoutPassCount,
      scroll: {
        document: measurement.documentScrollTop,
        editor: measurement.editorScrollTop,
        rail: measurement.railScrollTop
      },
      rows: measurement.rows
        .filter((row) => interestingIds.has(row.id))
        .map((row) => ({
          id: row.id,
          order: row.order,
          active: row.active,
          anchorStatus: row.anchorStatus,
          anchorKind: row.anchorKind,
          commentStatus: row.commentStatus,
          commentType: row.commentType,
          threadCount: row.threadCount,
          patchImpactCount: row.patchImpactCount,
          pendingPatchCount: row.pendingPatchCount,
          anchorStartOffset: row.anchorStartOffset,
          anchorEndOffset: row.anchorEndOffset,
          anchorDocumentY: row.anchorDocumentY,
          anchorViewportTop: row.anchorViewportTop,
          anchorTargetY: row.anchorTargetY,
          measuredHeight: row.measuredHeight,
          layoutTop: row.layoutTop,
          renderedDomTop: row.renderedDomTop,
          viewportTop: row.viewportTop,
          parentIdentity: row.parentIdentity
        }))
    })),
    recentLayoutPasses: layoutEvents.map((event) => ({
      activeCommentId: event.activeCommentId,
      floatingStageOffsetTop: event.floatingStageOffsetTop,
      layoutPass: event.layoutPass,
      rowCount: event.rows.length,
      stageHeight: event.stageHeight
    })),
    visualEvidence
  };

  console.log(JSON.stringify(summary, null, 2));
}

export {
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
};

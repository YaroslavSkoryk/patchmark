import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const editorUrl = process.env.PATCHMARK_EDITOR_URL ?? "http://localhost:3117/";
const projectDir = process.env.PATCHMARK_REAL_PROJECT_DIR;
const viewportHeight = Number(process.env.PATCHMARK_BROWSER_HEIGHT ?? 10000);
const viewportWidth = Number(process.env.PATCHMARK_BROWSER_WIDTH ?? 1440);
const movementTolerance = 1;

async function runActualEditorRegression() {
  if (!projectDir) {
    throw new Error(
      "Set PATCHMARK_REAL_PROJECT_DIR to a copied Patchmark project fixture."
    );
  }

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

    const measurements = [];
    const initialMeasurement = await waitForStableState(
      pageClient,
      "initial",
      "none"
    );
    const targets = chooseActivationTargets(initialMeasurement.rows);

    measurements.push(initialMeasurement);
    await activateComment(pageClient, targets.c.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        `activate ${targets.c.id}`,
        targets.c.id
      )
    );
    await activateComment(pageClient, targets.e.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        `activate ${targets.e.id}`,
        targets.e.id
      )
    );
    await activateComment(pageClient, targets.b.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        `activate ${targets.b.id}`,
        targets.b.id
      )
    );
    await activateComment(pageClient, targets.c.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        `activate ${targets.c.id} again`,
        targets.c.id
      )
    );
    await closeActiveComment(pageClient);
    measurements.push(await waitForStableState(pageClient, "collapse", "none"));
    await activateComment(pageClient, targets.c.id);
    measurements.push(
      await waitForStableState(
        pageClient,
        `reactivate ${targets.c.id}`,
        targets.c.id
      )
    );

    const layoutEvents = await readLayoutEvents(pageClient);

    assertActualEditorMeasurements(measurements, targets);
    printEditorSummary({
      layoutEvents,
      measurements,
      projectDir,
      targets,
      url: editorUrl
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

async function startFixtureFileServer(rootDir, inventory) {
  const fileSet = new Set(inventory.files);
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

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
    response.end(Buffer.from(readFileSync(join(rootDir, relativePath), "utf8")));
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
  files,
  projectName
}) {
  return `(() => {
    const filePaths = new Set(${JSON.stringify(files)});
    const directoryPaths = new Set(${JSON.stringify(directories)});
    const overrides = new Map();

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
        const text = overrides.has(this.path)
          ? overrides.get(this.path)
          : await fetch(${JSON.stringify(baseUrl)} + "/file?path=" + encodeURIComponent(this.path)).then((response) => {
              if (!response.ok) {
                throw notFound("Missing fixture file: " + this.path);
              }

              return response.text();
            });

        return new File([text], this.name, { type: this.name.endsWith(".json") ? "application/json" : "text/markdown" });
      }

      async createWritable() {
        const chunks = [];
        const path = this.path;

        return {
          async write(data) {
            if (data instanceof Blob) {
              chunks.push(await data.text());
            } else {
              chunks.push(String(data));
            }
          },
          async close() {
            const nextContent = chunks.join("");

            overrides.set(path, nextContent);
            filePaths.add(path);
            const parent = path.split("/").slice(0, -1).join("/");

            if (parent) {
              directoryPaths.add(parent);
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
            throw notFound("Missing fixture file: " + path);
          }

          filePaths.add(path);
          overrides.set(path, "");
        }

        return new PatchmarkFixtureFileHandle(path);
      }

      async getDirectoryHandle(name, options = {}) {
        const path = joinPath(this.path, name);

        if (!directoryPaths.has(path)) {
          if (!options.create) {
            throw notFound("Missing fixture directory: " + path);
          }

          directoryPaths.add(path);
        }

        return new PatchmarkFixtureDirectoryHandle(path, name);
      }
    }

    try {
      window.localStorage.setItem("patchmark:debug-comment-layout", "1");
    } catch {}

    window.__patchmarkFixtureWrites = overrides;
    window.showDirectoryPicker = async () =>
      new PatchmarkFixtureDirectoryHandle("", ${JSON.stringify(projectName)});
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
    this.nextId = 1;
    this.pending = new Map();
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (!message.id) {
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

  async close() {
    this.socket.close();
  }
}

await runActualEditorRegression();

async function waitForEditorShell(client) {
  let latestState = null;

  for (let attempt = 0; attempt < 100; attempt += 1) {
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

async function closeActiveComment(client) {
  await clickElementCenter(client, {
    expression: `(() => {
      const activeArticle = document.querySelector("article[aria-current='true']");

      if (!activeArticle) {
        throw new Error("No active comment card found.");
      }

      const closeButton = Array.from(activeArticle.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Close details");

      if (!closeButton) {
        throw new Error("Close details button not found.");
      }

      const rect = closeButton.getBoundingClientRect();

      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
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
          anchorViewportTop: debugRow?.anchorViewportTop ?? null,
          anchorTargetY: debugRow?.anchorContainerTop ?? numberOrNull(item.getAttribute("data-comment-preferred-top")),
          measuredHeight: Math.round(itemRect.height),
          articleHeight: articleRect ? Math.round(articleRect.height) : null,
          preferredTop: numberOrNull(item.getAttribute("data-comment-preferred-top")),
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
        documentScrollTop: Math.round(window.scrollY),
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

function chooseActivationTargets(rows) {
  const candidates = rows.filter(
    (row) =>
      row.id &&
      row.anchorKind !== "document" &&
      row.viewportTop > 0 &&
      row.viewportTop < viewportHeight - 120
  );

  assert.ok(
    candidates.length >= 5,
    `Expected at least 5 visible positioned real comments, found ${candidates.length}.`
  );

  const preferredC =
    candidates.find((row) => row.id === "PM-COMMENT-0024") ??
    candidates.find((row) => row.patchImpactCount > 0 && row.threadCount >= 5) ??
    candidates[Math.floor(candidates.length / 2)];
  const cIndex = candidates.findIndex((row) => row.id === preferredC.id);
  const b = candidates[Math.max(0, cIndex - 2)];
  const e =
    candidates[Math.min(candidates.length - 1, cIndex + 2)] ??
    candidates[candidates.length - 1];

  assert.notEqual(b.id, preferredC.id, "B target should differ from C target.");
  assert.notEqual(e.id, preferredC.id, "E target should differ from C target.");

  return {
    b,
    c: preferredC,
    e
  };
}

function assertActualEditorMeasurements(measurements, targets) {
  const initial = measurements[0];
  const initialRows = Object.fromEntries(initial.rows.map((row) => [row.id, row]));
  const initialOrder = initial.rows.map((row) => row.id);
  const activeC = measurements.find(
    (measurement) => measurement.label === `activate ${targets.c.id}`
  );
  const activeCAgain = measurements.find(
    (measurement) => measurement.label === `activate ${targets.c.id} again`
  );
  const activeCReactivated = measurements.find(
    (measurement) => measurement.label === `reactivate ${targets.c.id}`
  );
  const collapsed = measurements.find(
    (measurement) => measurement.label === "collapse"
  );

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
      measurement.documentScrollTop,
      initial.documentScrollTop,
      `${measurement.label} should not scroll the document`
    );
    assert.equal(
      measurement.editorScrollTop,
      initial.editorScrollTop,
      `${measurement.label} should not scroll the editor`
    );

    for (const row of measurement.rows) {
      const initialRow = initialRows[row.id];

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
      assert.equal(
        row.anchorTargetY,
        initialRow.anchorTargetY,
        `${measurement.label} should keep ${row.id} anchor target stable`
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
      assert.ok(
        Math.abs(row.layoutTop - row.renderedDomTop) <= movementTolerance,
        `${measurement.label} should render ${row.id} at layout top`
      );
    }
  }

  for (const target of [targets.c, targets.e, targets.b]) {
    assertActivationInvariant(measurements, initial, target.id);
  }

  assert.deepEqual(
    pickRenderedTops(collapsed),
    pickRenderedTops(initial),
    "Collapsing the actual editor comment should restore compact positions"
  );
  assert.deepEqual(
    pickRenderedTops(activeCAgain),
    pickRenderedTops(activeC),
    "Reactivating the same actual editor comment should be deterministic"
  );
  assert.deepEqual(
    pickRenderedTops(activeCReactivated),
    pickRenderedTops(activeC),
    "Reactivating after collapse should reproduce the same actual editor positions"
  );
}

function assertActivationInvariant(measurements, initial, targetId) {
  const initialRows = Object.fromEntries(initial.rows.map((row) => [row.id, row]));
  const initialIndex = initial.rows.findIndex((row) => row.id === targetId);
  const measurement = measurements.find((candidate) =>
    candidate.label.startsWith(`activate ${targetId}`)
  );

  assert.ok(measurement, `Missing activation measurement for ${targetId}.`);

  for (const row of measurement.rows) {
    const rowInitial = initialRows[row.id];
    const rowInitialIndex = initial.rows.findIndex(
      (candidate) => candidate.id === row.id
    );

    if (rowInitialIndex <= initialIndex) {
      assert.ok(
        Math.abs(row.renderedDomTop - rowInitial.renderedDomTop) <=
          movementTolerance,
        `${targetId} activation should not pull ${row.id} away from its compact top`
      );
    } else {
      assert.ok(
        row.renderedDomTop >= rowInitial.renderedDomTop - movementTolerance,
        `${targetId} activation should not move downstream ${row.id} upward`
      );
    }
  }
}

function pickRenderedTops(measurement) {
  return Object.fromEntries(
    measurement.rows.map((row) => [row.id, row.renderedDomTop])
  );
}

function printEditorSummary({
  layoutEvents,
  measurements,
  projectDir,
  targets,
  url
}) {
  const compactRows = measurements[0].rows;
  const interestingIds = new Set([
    targets.b.id,
    targets.c.id,
    targets.e.id,
    ...compactRows
      .slice(
        Math.max(0, compactRows.findIndex((row) => row.id === targets.c.id) - 2),
        compactRows.findIndex((row) => row.id === targets.c.id) + 3
      )
      .map((row) => row.id)
  ]);
  const summary = {
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
          anchorStatus: row.anchorStatus,
          anchorKind: row.anchorKind,
          commentStatus: row.commentStatus,
          threadCount: row.threadCount,
          patchImpactCount: row.patchImpactCount,
          pendingPatchCount: row.pendingPatchCount,
          anchorStartOffset: row.anchorStartOffset,
          anchorEndOffset: row.anchorEndOffset,
          anchorTargetY: row.anchorTargetY,
          measuredHeight: row.measuredHeight,
          layoutTop: row.layoutTop,
          renderedDomTop: row.renderedDomTop,
          parentIdentity: row.parentIdentity
        }))
    })),
    recentLayoutPasses: layoutEvents.map((event) => ({
      activeCommentId: event.activeCommentId,
      floatingStageOffsetTop: event.floatingStageOffsetTop,
      layoutPass: event.layoutPass,
      rowCount: event.rows.length,
      stageHeight: event.stageHeight
    }))
  };

  console.log(JSON.stringify(summary, null, 2));
}

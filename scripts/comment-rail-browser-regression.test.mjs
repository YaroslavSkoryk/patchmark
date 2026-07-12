import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fixtureUrl =
  process.env.PATCHMARK_COMMENT_RAIL_URL ??
  "http://localhost:3117/comment-rail-regression";
const expectedCommentIds = [
  "PM-COMMENT-A",
  "PM-COMMENT-B",
  "PM-COMMENT-C",
  "PM-COMMENT-D",
  "PM-COMMENT-E"
];
const movementTolerance = 1;

async function runBrowserRegression() {
  const chromePath =
    process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the browser rail regression."
    );
  }

  await assertFixtureIsReachable(fixtureUrl);

  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-rail-chrome-"));
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
    const pageWsUrl = await createPage(browserWsUrl, fixtureUrl);

    pageClient = await CdpClient.connect(pageWsUrl);
    await pageClient.call("Page.enable");
    await pageClient.call("Runtime.enable");
    await pageClient.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 1800,
      mobile: false,
      width: 1440
    });
    await pageClient.call("Page.navigate", { url: fixtureUrl });
    await waitForFixture(pageClient);

    const measurements = [];

    measurements.push(await waitForStableState(pageClient, "initial", "none"));
    await clickComment(pageClient, "PM-COMMENT-C");
    measurements.push(
      await waitForStableState(pageClient, "activate C", "PM-COMMENT-C")
    );
    await clickComment(pageClient, "PM-COMMENT-E");
    measurements.push(
      await waitForStableState(pageClient, "activate E", "PM-COMMENT-E")
    );
    await clickComment(pageClient, "PM-COMMENT-B");
    measurements.push(
      await waitForStableState(pageClient, "activate B", "PM-COMMENT-B")
    );
    await clickComment(pageClient, "PM-COMMENT-C");
    measurements.push(
      await waitForStableState(pageClient, "activate C again", "PM-COMMENT-C")
    );
    await closeActiveComment(pageClient);
    measurements.push(
      await waitForStableState(pageClient, "collapse C", "none")
    );
    await clickComment(pageClient, "PM-COMMENT-C");
    measurements.push(
      await waitForStableState(pageClient, "reactivate C", "PM-COMMENT-C")
    );

    assertMeasurementSequence(measurements);
    printCoordinateSummary(measurements);
    console.log("Comment rail browser regression tests passed.");
  } finally {
    await pageClient?.close();
    chrome.kill("SIGTERM");
    await delay(100);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
    }
    rmSync(userDataDir, { force: true, recursive: true });
  }
}

async function assertFixtureIsReachable(url) {
  const response = await fetch(url);

  assert.equal(
    response.ok,
    true,
    `Expected regression fixture to be reachable at ${url}; start the dev server first.`
  );
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

await runBrowserRegression();

async function waitForFixture(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fixtureState = await evaluate(client, {
      expression: `({
        count: document.querySelectorAll(".comment-floating-item article").length,
        ready: document.querySelector("[data-regression-ready]")?.getAttribute("data-regression-ready")
      })`
    });

    if (
      fixtureState.count === expectedCommentIds.length &&
      fixtureState.ready === "true"
    ) {
      return;
    }

    await delay(50);
  }

  throw new Error("Timed out waiting for comment rail fixture to render.");
}

async function waitForStableState(client, label, expectedActiveId) {
  let previousMeasurement = null;
  let latestMeasurement = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const currentMeasurement = await measureRail(client, label);

    latestMeasurement = currentMeasurement;

    if (currentMeasurement.activeId !== expectedActiveId) {
      await delay(50);
      previousMeasurement = null;
      continue;
    }

    if (
      previousMeasurement &&
      haveStableRows(previousMeasurement.rows, currentMeasurement.rows)
    ) {
      return currentMeasurement;
    }

    previousMeasurement = currentMeasurement;
    await delay(50);
  }

  throw new Error(
    `Timed out waiting for stable state: ${label}.\n${JSON.stringify(
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

async function clickComment(client, commentId) {
  await clickElementCenter(client, {
    expression: `(() => {
      const article = Array.from(document.querySelectorAll("article[aria-label]"))
        .find((element) => element.getAttribute("aria-label")?.endsWith(${JSON.stringify(commentId)}));

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

async function measureRail(client, label) {
  return await evaluate(client, {
    expression: `(() => {
      const root = document.querySelector("[data-regression-active-id]");
      const stage = document.querySelector(".comment-floating-stage");
      const rail = document.querySelector(".comments-rail");
      const editor = document.querySelector("[data-regression-editor]");
      const documentSurface = document.querySelector("[data-regression-document]");
      const stageRect = stage?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const surfaceRect = documentSurface?.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll(".comment-floating-item")).map((item, order) => {
        const article = item.querySelector("article[aria-label]");
        const ariaLabel = article?.getAttribute("aria-label") ?? "";
        const id = ariaLabel.replace(/^Active comment |^Comment /, "");
        const itemRect = item.getBoundingClientRect();
        const articleRect = article?.getBoundingClientRect();
        const anchor = document.querySelector(\`[data-comment-anchor="\${id}"]\`);
        const anchorRect = anchor?.getBoundingClientRect();
        const style = getComputedStyle(item);

        return {
          id,
          order,
          active: article?.getAttribute("aria-current") === "true",
          anchorStartOffset: anchor ? Number(anchor.getAttribute("data-anchor-start")) : null,
          anchorEndOffset: anchor ? Number(anchor.getAttribute("data-anchor-end")) : null,
          anchorDomTop: anchorRect && surfaceRect ? Math.round(anchorRect.top - surfaceRect.top) : null,
          anchorViewportTop: anchorRect ? Math.round(anchorRect.top) : null,
          anchorTargetY: anchorRect && railRect ? Math.round(anchorRect.top - railRect.top) : null,
          measuredHeight: Math.round(itemRect.height),
          articleHeight: articleRect ? Math.round(articleRect.height) : null,
          layoutTop: Number.parseFloat(item.style.top || "NaN"),
          inlineTop: item.style.top || null,
          transform: style.transform === "none" ? null : style.transform,
          renderedDomTop: stageRect ? Math.round(itemRect.top - stageRect.top) : null,
          viewportTop: Math.round(itemRect.top),
          parentIdentity: \`\${item.parentElement?.tagName.toLowerCase()}.\${item.parentElement?.className}\`
        };
      });

      return {
        label: ${JSON.stringify(label)},
        activeId: root?.getAttribute("data-regression-active-id") ?? null,
        railScrollTop: rail?.scrollTop ?? null,
        documentScrollTop: Math.round(window.scrollY),
        editorScrollTop: editor?.scrollTop ?? null,
        stageOffsetTop: stageRect && railRect ? Math.round(stageRect.top - railRect.top) : null,
        stageHeight: stageRect ? Math.round(stageRect.height) : null,
        rows
      };
    })()`
  });
}

async function evaluate(
  client,
  { expression, userGesture = false }
) {
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

function assertMeasurementSequence(measurements) {
  const initialMeasurement = measurements[0];
  const initialRows = Object.fromEntries(
    initialMeasurement.rows.map((row) => [row.id, row])
  );
  const activeC = measurements.find(
    (measurement) => measurement.label === "activate C"
  );
  const activeCAgain = measurements.find(
    (measurement) => measurement.label === "activate C again"
  );
  const activeCReactivated = measurements.find(
    (measurement) => measurement.label === "reactivate C"
  );
  const collapsed = measurements.find(
    (measurement) => measurement.label === "collapse C"
  );

  for (const measurement of measurements) {
    assert.deepEqual(
      measurement.rows.map((row) => row.id),
      expectedCommentIds,
      `${measurement.label} should keep comment order stable`
    );
    assert.equal(
      measurement.railScrollTop,
      initialMeasurement.railScrollTop,
      `${measurement.label} should not scroll the rail`
    );
    assert.equal(
      measurement.documentScrollTop,
      initialMeasurement.documentScrollTop,
      `${measurement.label} should not scroll the document`
    );
    assert.equal(
      measurement.editorScrollTop,
      initialMeasurement.editorScrollTop,
      `${measurement.label} should not scroll the editor`
    );

    for (const row of measurement.rows) {
      const initialRow = initialRows[row.id];

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
        row.anchorDomTop,
        initialRow.anchorDomTop,
        `${measurement.label} should keep ${row.id} anchor DOM top stable`
      );
      assert.equal(
        row.anchorTargetY,
        initialRow.anchorTargetY,
        `${measurement.label} should keep ${row.id} anchor target Y stable`
      );
      assert.equal(
        row.transform,
        null,
        `${measurement.label} should not move ${row.id} through transform`
      );
      assert.ok(
        Math.abs(row.layoutTop - row.renderedDomTop) <= movementTolerance,
        `${measurement.label} should render ${row.id} at the helper top`
      );
    }
  }

  assertEarlierRowsRemainAtCompactTop(measurements, "activate C", [
    "PM-COMMENT-A",
    "PM-COMMENT-B",
    "PM-COMMENT-C"
  ]);
  assertEarlierRowsRemainAtCompactTop(measurements, "activate E", [
    "PM-COMMENT-A",
    "PM-COMMENT-B",
    "PM-COMMENT-C",
    "PM-COMMENT-D",
    "PM-COMMENT-E"
  ]);
  assertEarlierRowsRemainAtCompactTop(measurements, "activate B", [
    "PM-COMMENT-A",
    "PM-COMMENT-B"
  ]);
  assertEarlierRowsRemainAtCompactTop(measurements, "activate C again", [
    "PM-COMMENT-A",
    "PM-COMMENT-B",
    "PM-COMMENT-C"
  ]);
  assertEarlierRowsRemainAtCompactTop(measurements, "reactivate C", [
    "PM-COMMENT-A",
    "PM-COMMENT-B",
    "PM-COMMENT-C"
  ]);

  assert.deepEqual(
    pickRenderedTops(collapsed),
    pickRenderedTops(initialMeasurement),
    "Collapsing C should restore compact rail positions"
  );
  assert.deepEqual(
    pickRenderedTops(activeCAgain),
    pickRenderedTops(activeC),
    "Activating C again should reproduce the original C-active positions"
  );
  assert.deepEqual(
    pickRenderedTops(activeCReactivated),
    pickRenderedTops(activeC),
    "Reactivating C after collapse should reproduce the original C-active positions"
  );
}

function assertEarlierRowsRemainAtCompactTop(measurements, label, commentIds) {
  const initialRows = Object.fromEntries(
    measurements[0].rows.map((row) => [row.id, row])
  );
  const measurement = measurements.find(
    (currentMeasurement) => currentMeasurement.label === label
  );

  assert.ok(measurement, `Missing measurement: ${label}`);

  for (const row of measurement.rows.filter((currentRow) =>
    commentIds.includes(currentRow.id)
  )) {
    assert.ok(
      Math.abs(row.renderedDomTop - initialRows[row.id].renderedDomTop) <=
        movementTolerance,
      `${label} should not pull ${row.id} away from its compact top`
    );
  }
}

function pickRenderedTops(measurement) {
  return Object.fromEntries(
    measurement.rows.map((row) => [row.id, row.renderedDomTop])
  );
}

function printCoordinateSummary(measurements) {
  const summary = measurements.map((measurement) => ({
    label: measurement.label,
    activeId: measurement.activeId,
    tops: pickRenderedTops(measurement),
    heights: Object.fromEntries(
      measurement.rows.map((row) => [row.id, row.measuredHeight])
    ),
    scroll: {
      document: measurement.documentScrollTop,
      editor: measurement.editorScrollTop,
      rail: measurement.railScrollTop
    }
  }));

  console.log(JSON.stringify(summary, null, 2));
}

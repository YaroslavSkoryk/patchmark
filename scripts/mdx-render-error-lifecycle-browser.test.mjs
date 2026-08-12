import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  clickButtonByText,
  createPage,
  evaluate,
  findChromeExecutable,
  waitForDevToolsUrl,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl =
  process.env.PATCHMARK_MDX_LIFECYCLE_URL ??
  "http://127.0.0.1:3117/mdx-render-error-lifecycle-regression";
const artifactRoot =
  process.env.PATCHMARK_MDX_LIFECYCLE_ARTIFACT_ROOT ??
  mkdtempSync(join(tmpdir(), "patchmark-mdx-lifecycle-artifacts-"));
const supportedMarkdown =
  "# Lifecycle fixture\n\nSupported Markdown remains editable in Visual Mode.";
const unsupportedMarkdown = `${supportedMarkdown}\n\n<UnsupportedLifecycleWidget />`;

mkdirSync(artifactRoot, { recursive: true });

await run();

async function run() {
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the MDX lifecycle browser test."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-mdx-lifecycle-chrome-"));
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
  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const events = [];
  let client;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, "about:blank");
    client = await CdpClient.connect(pageWsUrl);
    client.on("Runtime.consoleAPICalled", (event) => {
      const message = event.args
        ?.map((argument) => argument.value ?? argument.description)
        .join(" ");
      if (event.type === "error") consoleErrors.push(message);
      if (event.type === "warning") consoleWarnings.push(message);
    });
    client.on("Runtime.exceptionThrown", (event) => {
      exceptions.push(
        event.exceptionDetails?.exception?.description ??
          event.exceptionDetails?.text ??
          "Unknown exception"
      );
    });
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 900,
      mobile: false,
      width: 1440
    });
    events.push({ event: "navigation_started", timestamp: Date.now() });
    await client.call("Page.navigate", { url: editorUrl });
    await waitFor(
      client,
      "lifecycle fixture",
      `document.querySelector("[data-lifecycle-fixture-ready='true']") !== null`
    );
    events.push({ event: "fixture_ready", timestamp: Date.now() });

    await assertSupportedVisualEditor(client);
    events.push({ event: "supported_visual_ready", timestamp: Date.now() });

    await installTransitionAudit(client);
    const postMountStartedAt = Date.now();
    await clickButtonByText(client, "Load unsupported after mount");
    events.push({ event: "post_mount_error_reported", timestamp: Date.now() });
    const postMountFallback = await waitForFallback(client);
    events.push({ event: "post_mount_fallback_visible", timestamp: Date.now() });
    assertFallback(postMountFallback);
    const postMountTransitions = await readTransitionAudit(client);
    assert.equal(postMountTransitions.alertTransitions, 1);
    assert.equal(postMountTransitions.fallbackTransitions, 1);

    await clickButtonByText(client, "Unmount editor");
    await waitForEditorUnmount(client);
    await clickButtonByText(client, "Mount supported editor");
    await assertSupportedVisualEditor(client);
    events.push({ event: "fresh_supported_remount_ready", timestamp: Date.now() });

    await clickButtonByText(client, "Unmount editor");
    await waitForEditorUnmount(client);
    await installTransitionAudit(client);
    const preMountStartedAt = Date.now();
    await clickButtonByText(client, "Mount unsupported editor");
    events.push({ event: "pre_mount_error_queued", timestamp: Date.now() });
    const preMountFallback = await waitForFallback(client);
    events.push({ event: "pre_mount_fallback_visible", timestamp: Date.now() });
    assertFallback(preMountFallback);
    const preMountTransitions = await readTransitionAudit(client);
    assert.equal(preMountTransitions.alertTransitions, 1);
    assert.equal(preMountTransitions.fallbackTransitions, 1);
    await capture(client, join(artifactRoot, "01-pre-mount-fallback.png"));

    await clickButtonByText(client, "Unmount editor");
    await waitForEditorUnmount(client);
    await clickButtonByText(client, "Mount supported editor");
    await assertSupportedVisualEditor(client);
    await delay(250);
    assert.equal(await hasFallback(client), false);
    events.push({ event: "consumed_error_not_replayed", timestamp: Date.now() });

    await clickButtonByText(client, "Load unsupported and unmount");
    await waitForEditorUnmount(client);
    await delay(250);
    assert.equal(await hasFallback(client), false);
    events.push({ event: "pending_work_unmounted", timestamp: Date.now() });

    await clickButtonByText(client, "Mount supported editor");
    await assertSupportedVisualEditor(client);
    await delay(250);
    assert.equal(await hasFallback(client), false);
    events.push({ event: "post_unmount_fresh_editor_ready", timestamp: Date.now() });
    await capture(client, join(artifactRoot, "02-fresh-supported-remount.png"));

    const unmountWarnings = [...consoleErrors, ...consoleWarnings].filter(
      (message) =>
        /state update.*unmounted|update on an unmounted|can't perform.*unmounted/i.test(
          message ?? ""
        )
    );
    assert.deepEqual(unmountWarnings, []);
    assert.deepEqual(exceptions, []);

    const evidence = {
      consoleErrors,
      consoleWarnings,
      developmentStrictMode: true,
      events,
      exceptions,
      freshProfile: true,
      postMountDurationMs: events.find(
        (event) => event.event === "post_mount_fallback_visible"
      ).timestamp - postMountStartedAt,
      postMountTransitions,
      preMountDurationMs: events.find(
        (event) => event.event === "pre_mount_fallback_visible"
      ).timestamp - preMountStartedAt,
      preMountTransitions,
      sourceSha256: createHash("sha256")
        .update(unsupportedMarkdown)
        .digest("hex"),
      sourceValue: unsupportedMarkdown
    };
    writeFileSync(
      join(artifactRoot, "lifecycle-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`
    );
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`MDX lifecycle evidence: ${artifactRoot}`);
    console.log("MDX render-error lifecycle browser test passed.");
  } finally {
    await client?.close().catch(() => undefined);
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    rmSync(userDataDir, { force: true, recursive: true });
  }
}

async function assertSupportedVisualEditor(client) {
  const state = await waitFor(
    client,
    "supported Visual editor",
    `(() => {
      const editor = document.querySelector("[aria-label='Lifecycle Visual editor']");
      return editor ? {
        editable: editor.getAttribute("contenteditable"),
        fallback: Boolean(document.querySelector(".visual-editor-fallback")),
        text: editor.textContent
      } : null;
    })()`
  );
  assert.equal(state.editable, "true");
  assert.equal(state.fallback, false);
  assert.match(state.text, /Supported Markdown remains editable/);
}

async function waitForFallback(client) {
  return await waitFor(
    client,
    "Markdown-safe fallback",
    `(() => {
      const error = document.querySelector(".visual-editor-error");
      const fallback = document.querySelector(".visual-editor-fallback textarea");
      return error && fallback ? {
        alertRole: error.getAttribute("role"),
        ariaLabel: fallback.getAttribute("aria-label"),
        error: error.textContent,
        fallbackReadOnly: fallback.readOnly,
        rawMarkdown: fallback.value,
        visualEditorPresent: Boolean(document.querySelector("[aria-label='Lifecycle Visual editor']"))
      } : null;
    })()`
  );
}

function assertFallback(state) {
  assert.equal(state.alertRole, "alert");
  assert.equal(
    state.ariaLabel,
    "Lifecycle Visual editor fallback Markdown editor"
  );
  assert.match(state.error, /could not render/i);
  assert.equal(state.fallbackReadOnly, false);
  assert.equal(state.rawMarkdown, unsupportedMarkdown);
  assert.equal(state.visualEditorPresent, false);
}

async function installTransitionAudit(client) {
  await evaluate(client, {
    expression: `(() => {
      window.__patchmarkMdxTransitionObserver?.disconnect();
      const readState = () => ({
        alert: Boolean(document.querySelector(".visual-editor-error")),
        fallback: Boolean(document.querySelector(".visual-editor-fallback"))
      });
      const initial = readState();
      window.__patchmarkMdxTransitionAudit = {
        alertPresent: initial.alert,
        alertTransitions: 0,
        fallbackPresent: initial.fallback,
        fallbackTransitions: 0
      };
      window.__patchmarkMdxTransitionObserver = new MutationObserver(() => {
        const next = readState();
        const audit = window.__patchmarkMdxTransitionAudit;
        if (!audit.alertPresent && next.alert) audit.alertTransitions += 1;
        if (!audit.fallbackPresent && next.fallback) audit.fallbackTransitions += 1;
        audit.alertPresent = next.alert;
        audit.fallbackPresent = next.fallback;
      });
      window.__patchmarkMdxTransitionObserver.observe(
        document.querySelector("[data-testid='lifecycle-editor-host']"),
        { childList: true, subtree: true }
      );
      return true;
    })()`
  });
}

async function readTransitionAudit(client) {
  await delay(100);
  return await evaluate(client, {
    expression: `window.__patchmarkMdxTransitionAudit`
  });
}

async function hasFallback(client) {
  return await evaluate(client, {
    expression: `Boolean(document.querySelector(".visual-editor-error, .visual-editor-fallback"))`
  });
}

async function waitForEditorUnmount(client) {
  await waitFor(
    client,
    "editor unmount",
    `document.querySelector("[data-testid='lifecycle-editor-host']")?.childElementCount === 0`
  );
}

async function waitFor(client, label, expression) {
  let latest = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (latest) return latest;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}.\n${JSON.stringify(latest, null, 2)}`
  );
}

async function capture(client, path) {
  const result = await client.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png"
  });
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

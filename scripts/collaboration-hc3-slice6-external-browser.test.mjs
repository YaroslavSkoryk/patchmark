import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { optimizedHarnessOutput } from "./collaboration-hc3-slice5-optimized-build.mjs";
import { startExternalQualificationServer } from "./collaboration-hc3-slice6-external-runner.mjs";
import { summarizeExternalQualificationEvidence, validateExternalQualificationEvidence } from "./lib/collaboration-hc3-slice6-evidence.mjs";
import {
  CdpClient,
  createPage,
  evaluate,
  findChromeExecutable,
  waitForDevToolsUrl,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for the Slice 6 external-runner qualification.");
const sourceCommit = "96aea97e939b8f7e5e21a1fcb3d30131a9e008eb";
const sessionId = "hc3q_external_runner_browser_test";
const port = 3140;
const origin = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(`${tmpdir()}/patchmark-hc3-slice6-external-chrome-`);
let runner;
let chrome;
let client;
let assertions = 0;
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

try {
  runner = await startExternalQualificationServer({
    host: "127.0.0.1",
    port,
    evidence_session_id: sessionId,
    source_commit: sourceCommit,
    readiness_manifest_sha256: "3".repeat(64)
  });
  const metadataResponse = await fetch(`${origin}/qualification-metadata.json`);
  const metadata = await metadataResponse.json();
  equal([metadata.authority, metadata.upload, metadata.signaling, metadata.telemetry, metadata.production_route], ["none", false, false, false, false], "external package has no authority, upload, signaling, telemetry, or production route");
  check(metadata.fixture_hashes.length >= 13 && metadata.fixture_hashes.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), "external metadata freezes every existing collaboration fixture hash without copying fixture contents");

  chrome = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-extensions",
    "--disable-sync", "--disable-features=Translate,MediaRouter", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const browserUrl = await waitForDevToolsUrl(chrome);
  const pageUrl = await createPage(browserUrl, "about:blank");
  client = await CdpClient.connect(pageUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.navigate", { url: `${origin}/owner/` });
  await waitFor("external evidence panel", `Boolean(document.querySelector('#hc3-slice6-evidence-panel'))`);
  await waitFor("optimized app", `Boolean(document.querySelector('[data-testid="hc3-slice5-optimized-host"]'))`);

  const entry = await value(`(() => ({
    session: document.querySelector('[data-testid="hc3-slice6-evidence-session"]')?.textContent,
    authority_runtime: Boolean(window.__patchmarkHc3ProductAuthorityRuntime),
    bridge_loaded: window.__patchmarkHc3Slice4BridgeEvidence?.loaded,
    evidence: window.__patchmarkHc3Slice6Evidence.snapshot(),
    policy_events: window.__patchmarkHc3Slice5PolicyEvents?.length,
    runtime_events: window.__patchmarkHc3Slice5RuntimeEvents?.length
  }))()`);
  check(entry.session.includes(sessionId), "the real browser surface displays its evidence-session identifier");
  equal([entry.authority_runtime, entry.bridge_loaded], [false, false], "the external package performs no authority work before explicit entry");
  equal([entry.evidence.authority, entry.evidence.synthetic_project, entry.evidence.capabilities.length], ["none", true, 13], "browser-reported capabilities are captured in an authority-free synthetic record");
  equal(entry.evidence.fixture_hashes, metadata.fixture_hashes, "the exported browser evidence carries the exact frozen fixture hash inventory");
  equal([entry.policy_events, entry.runtime_events], [0, 0], "the external package hydrates under strict CSP and Trusted Types without policy or runtime failures");

  await click("Open collaboration workspace");
  await waitFor("real workspace", `Boolean(document.querySelector('[data-testid="collaboration-qualification-workspace"]'))`);
  const opened = await value(`({
    loaded: window.__patchmarkHc3Slice4BridgeEvidence.loaded,
    instances: window.__patchmarkHc3Slice4BridgeEvidence.instanceCount,
    inspects: window.__patchmarkHc3Slice4BridgeEvidence.inspects
  })`);
  check(opened.loaded && opened.instances === 1 && opened.inspects >= 1, "the external package lazily assembles the real product authority runtime exactly once");
  await click("Set up collaboration");
  await waitFor("setup action", `[...document.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Create collaboration copy')`);
  await click("Create collaboration copy");
  await waitFor("durable foundation", `document.body.innerText.includes('Recovery kit required')`);
  const authority = await value(`window.__patchmarkHc3Slice4AuthorityHarness.evidence()`);
  check(authority.authority_invocations >= 1 && authority.real_calls.includes("hc1.initialize_replica"), "external UI actions reach the real HC-1 foundation boundary through the assembled authority driver");

  const syntheticDigest = createHash("sha256").update("synthetic artifact bytes").digest("hex");
  await evaluate(client, { expression: `window.__patchmarkHc3Slice6Evidence.recordArtifact(${JSON.stringify({ kind: "synthetic_test_artifact", byte_length: 24, sha256: syntheticDigest })}); window.__patchmarkHc3Slice6Evidence.recordAssertion(${JSON.stringify({ id: "real_authority_driver_reached", evidence_mode: "automated", status: "pass", detail_code: "hc1_foundation_boundary" })}); true` });
  const browserEvidence = validateExternalQualificationEvidence(await value("window.__patchmarkHc3Slice6Evidence.snapshot()"));
  equal([browserEvidence.artifacts[0].byte_length, browserEvidence.artifacts[0].sha256], [24, syntheticDigest], "external evidence stores artifact sizes and SHA-256 commitments, never artifact bytes");
  equal(summarizeExternalQualificationEvidence(browserEvidence).cleanup_confirmed, false, "browser execution cannot silently claim manual cleanup");
  const finalEvents = await value(`({ policy: window.__patchmarkHc3Slice5PolicyEvents.length, runtime: window.__patchmarkHc3Slice5RuntimeEvents.length, console: window.__patchmarkHc3Slice5ConsoleEvents.length })`);
  equal(finalEvents, { policy: 0, runtime: 0, console: 0 }, "real authority setup remains clean under the production-optimized policy");
  const version = await client.call("Browser.getVersion");

  process.stdout.write(`${JSON.stringify({
    assertions,
    browser: version.product,
    engine: version.jsVersion,
    evidence_session_id: sessionId,
    browser_reported_capabilities: browserEvidence.capabilities.length,
    real_authority_invocations: authority.authority_invocations,
    csp_violations: finalEvents.policy,
    authority: "none",
    production_route: false,
    status: "ok"
  }, null, 2)}\n`);
} finally {
  await client?.close().catch(() => undefined);
  chrome?.kill("SIGTERM");
  await waitForProcessExit(chrome, 1_500).catch(() => chrome?.kill("SIGKILL"));
  await runner?.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  rmSync(optimizedHarnessOutput, { recursive: true, force: true });
}

async function value(expression) { return evaluate(client, { expression }); }
async function click(label) {
  const result = await evaluate(client, { expression: `(() => { const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === ${JSON.stringify(label)}); if (!button) return false; button.click(); return true; })()`, userGesture: true });
  check(result, `button is available: ${label}`);
}
async function waitFor(label, expression) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await value(expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

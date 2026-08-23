import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  CdpClient,
  createPage,
  evaluate,
  findChromeExecutable,
  waitForDevToolsUrl,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const harnessCsp = "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'";
const harness = await startHarnessServer();
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 3 browser tests.");
const edgePath = process.env.PATCHMARK_EDGE_PATH ?? findEdgeExecutable();
const executions = [];
try {
  executions.push(await runBrowser(chromePath, "chrome"));
  if (edgePath && edgePath !== chromePath) executions.push(await runBrowser(edgePath, "edge"));
} finally {
  await harness.close();
}

process.stdout.write(`${JSON.stringify({
  assertions: executions.reduce((sum, entry) => sum + entry.assertions, 0),
  browsers: executions,
  edge_unavailable: !edgePath,
  oldest_qualified_chromium_unavailable: !executions.some((entry) => entry.major === 137),
  temporary_profiles_removed: true,
  indexeddb_databases_deleted: true,
  workers_terminated: true
}, null, 2)}\n`);

async function runBrowser(executable, label) {
  let assertions = 0;
  const profile = mkdtempSync(join(tmpdir(), `patchmark-hc2-slice3-${label}-`));
  const browser = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let browserClient;
  let pageClient;
  try {
    const browserWebSocketUrl = await waitForDevToolsUrl(browser);
    browserClient = await CdpClient.connect(browserWebSocketUrl);
    const version = await browserClient.call("Browser.getVersion");
    const pageWebSocketUrl = await createPage(browserWebSocketUrl, harness.url);
    pageClient = await CdpClient.connect(pageWebSocketUrl);
    await pageClient.call("Runtime.enable");
    await pageClient.call("Page.enable");
    await pageClient.call("Performance.enable");
    await waitReady(pageClient);
    const evidence = await evaluate(pageClient, {
      expression: `hc2s3.runBrowserEvidence(${JSON.stringify(`patchmark-hc2-slice3-${label}`)}).then(clean)`
    });
    for (const [name, expected] of Object.entries({
      ed_private_extractable: false,
      x_private_extractable: false,
      ed_public_extractable: true,
      x_public_extractable: true,
      restored_ed_private_extractable: false,
      restored_x_private_extractable: false,
      ed_private_export_rejected: true,
      x_private_export_rejected: true,
      ed_public_bytes: 32,
      x_public_bytes: 32,
      persisted_signature_status: "valid_signature",
      persisted_hpke_status: "opened",
      persisted_hpke_plaintext: "browser persisted X25519 key",
      final_header_enc_matches_returned: true,
      deterministic_ed25519_matches_rfc: true,
      database_deleted: true
    })) {
      assertions += 1; assert.deepEqual(evidence[name], expected, `${label}: ${name}`);
    }
    assertions += 1; assert.equal(evidence.deterministic_ed25519_signature_hex, "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    assertions += 1; assert.deepEqual(evidence.hpke_evidence, { sender_contexts_created: 1, recipient_contexts_created: 1, sender_seal_calls: 1, recipient_open_calls: 1 });
    const recovery = await evaluate(pageClient, { expression: "hc2s3.runRecoveryBenchmark().then(clean)" });
    assertions += 1; assert.equal(recovery.unlock_status, "unlocked");
    assertions += 1; assert.equal(recovery.unlock_plaintext, "browser recovery payload");
    assertions += 1; assert.equal(recovery.worker_terminated, true);
    assertions += 1; assert.equal(recovery.parameter_memory_bytes, 64 * 1024 * 1024);
    assertions += 1; assert.equal(recovery.parameter_opslimit, 3);
    assertions += 1; assert.equal(recovery.parallelism, "provider_managed_not_configurable");
    assertions += 1; assert.equal(recovery.samples_ms.length, 3);
    assertions += 1; assert(recovery.samples_ms.every((sample) => sample > 0 && Number.isFinite(sample)), "worker benchmark samples are finite");
    assertions += 1; assert(recovery.worst_ms >= recovery.median_ms, "worst runtime is not below median");
    const metrics = await pageClient.call("Performance.getMetrics");
    const heap = metrics.metrics.find((entry) => entry.name === "JSHeapUsedSize")?.value ?? null;
    assertions += 1; assert(heap === null || heap >= 0);
    const major = Number(/\/(\d+)\./.exec(version.product)?.[1] ?? 0);
    return {
      label,
      product: version.product,
      major,
      assertions,
      recovery_samples_ms: recovery.samples_ms,
      recovery_median_ms: recovery.median_ms,
      recovery_worst_ms: recovery.worst_ms,
      observable_js_heap_bytes_after_benchmark: heap,
      deterministic_ed25519_signature_hex: evidence.deterministic_ed25519_signature_hex
    };
  } finally {
    await pageClient?.close();
    await browserClient?.close();
    browser.kill("SIGTERM");
    await waitForProcessExit(browser, 1000);
    if (browser.exitCode === null) { browser.kill("SIGKILL"); await waitForProcessExit(browser, 1000); }
    rmSync(profile, { force: true, recursive: true });
  }
}

async function waitReady(client) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(client, { expression: "({ready:globalThis.__hc2Slice3Ready,error:globalThis.__hc2Slice3Error ?? null})" });
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for the Slice 3 browser harness.");
}

async function startHarnessServer() {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": harnessCsp, "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><title>HC-2 Slice 3</title>
          <script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script>
          <script type="module">globalThis.__hc2Slice3Ready=false;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==="bigint"?child.toString():child));try{globalThis.hc2s3=await import("/scripts/collaboration-hc2-slice3-browser-runtime.ts");globalThis.__hc2Slice3Ready=true;}catch(error){globalThis.__hc2Slice3Error=error?.stack??String(error);}</script>`);
        return;
      }
      if (isAllowedTypeScriptPath(requestUrl.pathname)) {
        const sourcePath = safeRepositoryPath(requestUrl.pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
          reportDiagnostics: true
        });
        const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
        if (errors.length) throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
        let output = transpiled.outputText;
        if (requestUrl.pathname.endsWith("/recovery-worker.ts")) {
          output = output.replace('from "libsodium-wrappers-sumo"', 'from "/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs"');
        }
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": harnessCsp, "Content-Type": "text/javascript; charset=utf-8" });
        response.end(output);
        return;
      }
      if (requestUrl.pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(requestUrl.pathname)) {
        const sourcePath = safeRepositoryPath(requestUrl.pathname);
        let output = readFileSync(sourcePath, "utf8");
        if (requestUrl.pathname.includes("libsodium-wrappers-sumo")) {
          output = output.replace('from"libsodium-sumo"', 'from"/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"');
        }
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": harnessCsp, "Content-Type": "text/javascript; charset=utf-8" });
        response.end(output);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Harness did not receive a loopback port.");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

function safeRepositoryPath(pathname) {
  const sourcePath = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!sourcePath.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Harness path escaped repository root.");
  return sourcePath;
}

function isAllowedTypeScriptPath(pathname) {
  return pathname === "/scripts/collaboration-hc2-slice3-browser-runtime.ts" || pathname.startsWith("/lib/collaboration/") && pathname.endsWith(".ts");
}

function findEdgeExecutable() {
  for (const candidate of [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev"
  ]) if (existsSync(candidate)) return candidate;
  return null;
}

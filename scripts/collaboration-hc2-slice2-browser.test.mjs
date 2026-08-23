import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
const harness = await startHarnessServer();
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 2 browser tests.");
const edgePath = process.env.PATCHMARK_EDGE_PATH ?? findEdgeExecutable();
const executions = [];
try {
  executions.push(await runBrowser(chromePath, "chrome"));
  if (edgePath && edgePath !== chromePath) executions.push(await runBrowser(edgePath, "edge"));
} finally {
  await harness.close();
}

const testedMajors = new Set(executions.map((entry) => Number(/\/(\d+)/.exec(entry.browser)?.[1] ?? 0)));
const unavailableMinimums = [];
for (const label of ["Chrome 137", "Edge 137"]) if (![...executions].some((entry) => entry.label === label.split(" ")[0].toLowerCase() && /\/137\./.test(entry.browser))) unavailableMinimums.push(label);
process.stdout.write(`${JSON.stringify({
  assertions: executions.reduce((sum, entry) => sum + entry.assertions, 0),
  tested_browsers: executions.map((entry) => entry.browser),
  real_contexts_per_browser: 3,
  indexeddb_cas: "real-strict-transactions",
  web_locks: "real-cross-context-and-crash-release",
  capability_probes: executions.map((entry) => entry.probes),
  qualified_minimums_not_available: unavailableMinimums,
  tested_major_versions: [...testedMajors].sort((a, b) => a - b),
  temporary_profiles_removed: true,
  databases_deleted: true
}, null, 2)}\n`);

async function runBrowser(executable, label) {
  let assertions = 0;
  const profile = mkdtempSync(join(tmpdir(), `patchmark-hc2-slice2-${label}-`));
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
  let first;
  let second;
  let crashClient;
  try {
    const browserWebSocketUrl = await waitForDevToolsUrl(browser);
    browserClient = await CdpClient.connect(browserWebSocketUrl);
    const version = await browserClient.call("Browser.getVersion");
    first = await openHarnessPage(browserWebSocketUrl);
    second = await openHarnessPage(browserWebSocketUrl);
    const database = `patchmark-hc2-slice2-browser-${label}`;
    const staleDatabase = `patchmark-hc2-slice2-browser-stale-${label}`;
    const probes = await evaluate(first.client, { expression: `hc2.runBrowserCapabilityProbe(${JSON.stringify(`patchmark-hc2-capability-probe-${label}`)}).then(clean)` });
    assertions += 1; assert.equal(probes.secure_context, true);
    assertions += 1; assert.equal(probes.top_level_context, true);
    assertions += 1; assert.equal(probes.ed25519, "available");
    assertions += 1; assert.equal(probes.x25519, "available");
    assertions += 1; assert.equal(probes.indexeddb, "available");
    assertions += 1; assert.equal(probes.indexeddb_strict_durability, "available");
    assertions += 1; assert.equal(probes.crypto_key_indexeddb_round_trip, "available");
    assertions += 1; assert.equal(probes.web_locks, "available");
    assertions += 1; assert.equal(probes.disposable_probe_keys_deleted, true);

    const project = entity("project", "a");
    const project2 = entity("project", "b");
    const device = entity("device", "c");
    const device2 = entity("device", "d");
    const device3 = entity("device", "e");
    await evaluate(first.client, { expression: `hc2.initializeStream(${json(database)}, ${json(project)}, ${json(device)}).then(clean)` });
    const draftA = casExpression(project, device, 0, null, null, reservation("f", 0, event("g"), batch("h"), 1), 0, event("g"));
    const draftB = casExpression(project, device, 0, null, null, reservation("i", 0, event("j"), batch("k"), 2), 0, event("j"));
    await startAsync(first.client, `hc2.reserveStream(${json(database)}, ${draftA})`, "raceResult");
    await startAsync(second.client, `hc2.reserveStream(${json(database)}, ${draftB})`, "raceResult");
    const raceA = await waitForValue(first.client, "globalThis.raceResult");
    const raceB = await waitForValue(second.client, "globalThis.raceResult");
    const winners = [raceA, raceB].filter((result) => result.status === "advanced");
    const losers = [raceA, raceB].filter((result) => result.status === "failed");
    assertions += 1; assert.equal(winners.length, 1, "one real IndexedDB CAS caller must win");
    assertions += 1; assert.equal(losers.length, 1, "one real IndexedDB CAS caller must lose");
    assertions += 1; assert(["pending_replacement", "generation_mismatch"].includes(losers[0].code), losers[0].code);
    const aWon = raceA.status === "advanced";
    const winningReservation = aWon ? reservation("f", 0, event("g"), batch("h"), 1) : reservation("i", 0, event("j"), batch("k"), 2);
    const winningEvent = aWon ? event("g") : event("j");
    const winningBatch = aWon ? batch("h") : batch("k");
    const finalize = await evaluate(first.client, { expression: `hc2.finalizeStream(${json(database)}, {project_id:${json(project)},device_id:${json(device)},expected_generation:1n,reservation:${winningReservation},committed_batch_id:${json(winningBatch)}}).then(clean)` });
    assertions += 1; assert.equal(finalize.status, "finalized");
    const retry = await evaluate(second.client, { expression: `hc2.reserveStream(${json(database)}, ${casExpression(project, device, 1, 0, winningEvent, reservation("l", 1, event("m"), batch("n"), 3), 1, event("m"))}).then(clean)` });
    assertions += 1; assert.equal(retry.status, "advanced", "losing tab must advance only after reading the new exact head");

    await Promise.all([
      evaluate(first.client, { expression: `hc2.initializeStream(${json(database)}, ${json(project)}, ${json(device2)}).then(clean)` }),
      evaluate(second.client, { expression: `hc2.initializeStream(${json(database)}, ${json(project)}, ${json(device3)}).then(clean)` })
    ]);
    await startAsync(first.client, `hc2.reserveStream(${json(database)}, ${casExpression(project, device2, 0, null, null, reservation("o", 0, event("p"), batch("q"), 4), 0, event("p"))})`, "deviceRace");
    await startAsync(second.client, `hc2.reserveStream(${json(database)}, ${casExpression(project, device3, 0, null, null, reservation("r", 0, event("s"), batch("t"), 5), 0, event("s"))})`, "deviceRace");
    assertions += 1; assert.equal((await waitForValue(first.client, "globalThis.deviceRace")).status, "advanced");
    assertions += 1; assert.equal((await waitForValue(second.client, "globalThis.deviceRace")).status, "advanced");
    await evaluate(first.client, { expression: `hc2.initializeStream(${json(database)}, ${json(project2)}, ${json(device)}).then(clean)` });
    const isolated = await evaluate(first.client, { expression: `hc2.reserveStream(${json(database)}, ${casExpression(project2, device, 0, null, null, reservation("u", 0, event("v"), batch("w"), 6), 0, event("v"))}).then(clean)` });
    assertions += 1; assert.equal(isolated.status, "advanced", "projects must remain isolated in one origin database");

    await evaluate(first.client, { expression: `hc2.beginHeldLock(${json(project)}, ${json(device)}); true` });
    await waitForExact(first.client, `hc2.currentLockState()`, "held");
    await evaluate(second.client, { expression: `hc2.beginHeldLock(${json(project)}, ${json(device)}); true` });
    await waitForExact(second.client, `hc2.currentLockState()`, "waiting");
    assertions += 1; assert.equal(await evaluate(second.client, { expression: `hc2.currentLockState()` }), "waiting");
    await evaluate(first.client, { expression: `hc2.releaseHeldLock(); true` });
    await evaluate(first.client, { expression: `hc2.waitHeldLockCompletion().then(() => true)` });
    await waitForExact(second.client, `hc2.currentLockState()`, "held");
    await evaluate(second.client, { expression: `hc2.releaseHeldLock(); true` });
    await evaluate(second.client, { expression: `hc2.waitHeldLockCompletion().then(() => true)` });
    assertions += 1; assert.equal(await evaluate(second.client, { expression: `hc2.currentLockState()` }), "released");

    crashClient = await openHarnessPage(browserWebSocketUrl);
    await evaluate(crashClient.client, { expression: `hc2.beginHeldLock(${json(project2)}, ${json(device2)}); true` });
    await waitForExact(crashClient.client, `hc2.currentLockState()`, "held");
    await evaluate(second.client, { expression: `hc2.beginHeldLock(${json(project2)}, ${json(device2)}); true` });
    await waitForExact(second.client, `hc2.currentLockState()`, "waiting");
    await browserClient.call("Target.closeTarget", { targetId: crashClient.targetId });
    await crashClient.client.close(); crashClient = null;
    await waitForExact(second.client, `hc2.currentLockState()`, "held");
    assertions += 1; assert.equal(await evaluate(second.client, { expression: `hc2.currentLockState()` }), "held", "closing a page must release its Web Lock");
    await evaluate(second.client, { expression: `hc2.releaseHeldLock(); true` });
    await evaluate(second.client, { expression: `hc2.waitHeldLockCompletion().then(() => true)` });

    await evaluate(first.client, { expression: `hc2.openStaleConnection(${json(staleDatabase)}).then(() => true)` });
    await evaluate(second.client, { expression: `hc2.upgradeDatabase(${json(staleDatabase)}).then(() => true)` });
    const staleWrite = await evaluate(first.client, { expression: `hc2.staleConnectionCanWrite(${json(project)}, ${json(device)}).then(Boolean)` });
    assertions += 1; assert.equal(staleWrite, false, "versionchange must close a stale schema connection before it can write");

    await evaluate(first.client, { expression: `hc2.deleteDatabase(${json(database)}).then(() => true)` });
    await evaluate(first.client, { expression: `hc2.deleteDatabase(${json(staleDatabase)}).then(() => true)` });
    return { label, browser: version.product, assertions, probes: {
      ed25519: probes.ed25519,
      x25519: probes.x25519,
      keypair_idb_round_trip: probes.crypto_key_indexeddb_round_trip,
      strict_durability: probes.indexeddb_strict_durability,
      opfs: probes.opfs,
      file_system_access: probes.file_system_access,
      persistence: probes.persistent_storage,
      estimate: probes.storage_estimate
    } };
  } finally {
    await crashClient?.client.close();
    await first?.client.close();
    await second?.client.close();
    await browserClient?.close();
    browser.kill("SIGTERM");
    await waitForProcessExit(browser, 1000);
    if (browser.exitCode === null) { browser.kill("SIGKILL"); await waitForProcessExit(browser, 1000); }
    rmSync(profile, { force: true, recursive: true });
  }
}

async function openHarnessPage(browserWebSocketUrl) {
  const webSocketUrl = await createPage(browserWebSocketUrl, harness.url);
  const client = await CdpClient.connect(webSocketUrl);
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await waitForExact(client, "globalThis.__hc2Ready", true);
  return { client, targetId: webSocketUrl.slice(webSocketUrl.lastIndexOf("/") + 1) };
}

async function startAsync(client, expression, slot) {
  await client.call("Runtime.evaluate", {
    awaitPromise: false,
    expression: `${expression}.then(value => { globalThis.${slot} = clean(value); }).catch(error => { globalThis.${slot} = {status:"threw",reason:error?.name ?? "Error"}; }); undefined`,
    returnByValue: true
  });
}

async function waitForValue(client, expression) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await evaluate(client, { expression: `${expression} ?? null` });
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function waitForExact(client, expression, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await evaluate(client, { expression });
    if (value === expected) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${expression} = ${JSON.stringify(expected)}`);
}

function casExpression(project, device, generation, sequence, previous, nextReservation, nextSequence, nextObject) {
  return `{project_id:${json(project)},device_id:${json(device)},expected_generation:${generation}n,expected_sequence:${sequence === null ? "null" : `${sequence}n`},expected_previous_object_id:${previous === null ? "null" : json(previous)},reservation:${nextReservation},next_sequence:${nextSequence}n,next_object_id:${json(nextObject)}}`;
}
function reservation(fill, sequence, objectId, batchId, byte) {
  return `{transaction_intent_id:${json(hc2Id("transaction-intent", fill))},next_sequence:${sequence}n,next_object_id:${json(objectId)},exact_signed_bytes_commitment:new Uint8Array(32).fill(${byte}),intended_batch_id:${json(batchId)}}`;
}
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function event(fill) { return `pm:semantic-event:v1:${fill.repeat(51)}a`; }
function batch(fill) { return hc2Id("portable-batch", fill); }
function hc2Id(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function json(value) { return JSON.stringify(value); }

async function startHarnessServer() {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><title>HC-2 Slice 2</title><script type="module">globalThis.__hc2Ready=false;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==="bigint"?child.toString():child));globalThis.hc2=await import("/scripts/collaboration-hc2-slice2-browser-runtime.ts");globalThis.__hc2Ready=true;</script>`);
        return;
      }
      if (isAllowedTypeScriptPath(requestUrl.pathname)) {
        const sourcePath = resolve(repositoryRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
        if (!sourcePath.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Harness path escaped repository root.");
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
          reportDiagnostics: true
        });
        const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
        if (errors.length) throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(transpiled.outputText);
        return;
      }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500, { "Content-Type": "text/plain" }); response.end(error instanceof Error ? error.stack : String(error)); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Harness did not receive a loopback port.");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function isAllowedTypeScriptPath(pathname) {
  return pathname === "/scripts/collaboration-hc2-slice2-browser-runtime.ts" || pathname.startsWith("/lib/collaboration/") && pathname.endsWith(".ts");
}

function findEdgeExecutable() {
  for (const candidate of [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev"
  ]) if (existsSync(candidate)) return candidate;
  return null;
}

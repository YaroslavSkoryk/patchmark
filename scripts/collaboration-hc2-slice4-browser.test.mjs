import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frozenFixture = JSON.parse(readFileSync(join(repositoryRoot, "scripts/fixtures/collaboration-hc2-slice4-v1.json"), "utf8"));
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'";
const server = await startServer();
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 4 browser tests.");
let assertions = 0;
let profileA;
let profileB;
let product = "unknown";
try {
  process.stderr.write("[hc2-slice4-browser] profile A start\n");
  const first = await withChrome("profile-a", async ({ browserUrl, version }) => {
    product = version.product;
    const firstUrl = await createPage(browserUrl, server.url);
    const secondUrl = await createPage(browserUrl, server.url);
    const firstPage = await CdpClient.connect(firstUrl);
    const secondPage = await CdpClient.connect(secondUrl);
    try {
      await Promise.all([ready(firstPage), ready(secondPage)]);
      const vector = await evaluate(firstPage, { expression: `hc2s4.verifyFrozenVector(${JSON.stringify(frozenFixture)})` });
      for (const [name, expected] of Object.entries({
        container_bytes: frozenFixture.recovery_kit.container_bytes,
        container_sha256: frozenFixture.recovery_kit.container_sha256,
        header_project_id: frozenFixture.identities.project_id,
        payload_bytes: frozenFixture.recovery_kit.payload_bytes,
        payload_sha256: frozenFixture.recovery_kit.payload_sha256,
        root_signatures: 2,
        epoch_commitment_id: frozenFixture.epoch_wrap.key_epoch_commitment_id,
        epoch_aad_hex: frozenFixture.epoch_wrap.aad_hex,
        epoch_ciphertext_hex: frozenFixture.epoch_wrap.ciphertext_and_tag_hex
      })) {
        assertions += 1; assert.deepEqual(vector[name], expected, `frozen Chrome vector: ${name}`);
      }
      const held = withTimeout(evaluate(firstPage, { expression: "hc2s4.holdCustodyCeremonyLock(250)" }), 10_000, "held custody ceremony Web Lock");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      const unavailable = await withTimeout(evaluate(secondPage, { expression: "hc2s4.custodyCeremonyLockUnavailable()" }), 10_000, "second-tab custody ceremony Web Lock probe");
      assertions += 1; assert.equal(unavailable, true, "same-profile second tab cannot enter the held project custody ceremony lock");
      await held;
      process.stderr.write("[hc2-slice4-browser] profile A custody start\n");
      const evidenceUrl = await createPage(browserUrl, `${server.url}profile-a`);
      const evidencePage = await CdpClient.connect(evidenceUrl);
      try { await ready(evidencePage); return waitForRunUrl(evidenceUrl, 120_000, "profile A custody", true); }
      finally { await evidencePage.close(); }
    } finally {
      await firstPage.close(); await secondPage.close();
    }
  });
  profileA = first.value;
  server.setProfileA(profileA);
  process.stderr.write("[hc2-slice4-browser] profile A complete; profile B start\n");
  for (const [name, expected] of Object.entries({
    old_device_id: "pm:device:v1:eeeeeeeeeeeeeeeeeeeeeeeeea",
    old_signing_key_id: "pm:public-key:v1:hhhhhhhhhhhhhhhhhhhhhhhhha",
    old_epoch_id: "pm:key-epoch:v1:nnnnnnnnnnnnnnnnnnnnnnnnna",
    ed_private_extractable: false,
    x_private_extractable: false,
    kek_extractable: false,
    device_signature_bytes: 64,
    root_signature_status: "signed",
    root_worker_terminated: true,
    epoch_callback_wiped: true,
    indexeddb_partial_install_rejected: true,
    indexeddb_partial_vault_absent: true,
    indexeddb_partial_epoch_absent: true,
    indexeddb_partial_journal_preserved: true
  })) {
    assertions += 1; assert.deepEqual(profileA[name], expected, `profile A: ${name}`);
  }

  const second = await withChrome("profile-b", async ({ browserUrl }) => {
    const pageUrl = await createPage(browserUrl, `${server.url}profile-b`);
    const page = await CdpClient.connect(pageUrl);
    try {
      await ready(page);
      return waitForRunUrl(pageUrl, 120_000, "profile B recovery", false);
    } finally { await page.close(); }
  });
  profileB = second.value;
  process.stderr.write("[hc2-slice4-browser] profile B complete\n");
  for (const [name, expected] of Object.entries({
    absent_before_open: true,
    new_device_id: "pm:device:v1:fffffffffffffffffffffffffa",
    new_signing_key_id: "pm:public-key:v1:kkkkkkkkkkkkkkkkkkkkkkkkka",
    new_epoch_id: "pm:key-epoch:v1:pppppppppppppppppppppppppa",
    ed_private_extractable: false,
    x_private_extractable: false,
    kek_extractable: false,
    replacement_signature_bytes: 64,
    recovery_complete: "verified_local_ceremony",
    root_worker_terminated: true,
    late_old_device_result: "superseded_control_branch"
  })) {
    assertions += 1; assert.deepEqual(profileB[name], expected, `profile B: ${name}`);
  }
  assertions += 1; assert.notEqual(profileB.new_device_id, profileA.old_device_id, "profile loss allocates a new device identity");
  assertions += 1; assert.notEqual(profileB.new_signing_key_id, profileA.old_signing_key_id, "profile loss allocates a new signing-key identity");
  assertions += 1; assert.notEqual(profileB.new_signing_public_hex, profileA.old_signing_public_hex, "profile loss generates new native signing key material");
  assertions += 1; assert.notEqual(profileB.new_epoch_id, profileA.old_epoch_id, "profile loss allocates a replacement epoch");
} finally {
  await server.close();
}

process.stdout.write(`${JSON.stringify({
  assertions,
  chrome: product,
  chrome_major: Number(/\/(\d+)\./.exec(product)?.[1] ?? 0),
  profile_a: publicProfileAReport(profileA),
  profile_b: profileB,
  separate_user_data_directories: true,
  same_profile_two_tab_exclusion: true,
  node_python_chrome_frozen_vector_equivalence: true,
  edge_not_tested: true,
  chromium_floor_not_inferred: true,
  temporary_profiles_removed: true,
  indexeddb_profile_b_deleted: true,
  servers_closed: true,
  workers_terminated: true
}, null, 2)}\n`);

function publicProfileAReport(value) {
  if (!value) return value;
  const publicEvidence = { ...value };
  delete publicEvidence.kit_hex;
  return publicEvidence;
}

async function withChrome(label, operation) {
  const profile = mkdtempSync(join(tmpdir(), `patchmark-hc2-slice4-${label}-`));
  const browser = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-extensions", "--disable-sync", "--disable-features=Translate,MediaRouter", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let client;
  try {
    const browserUrl = await waitForDevToolsUrl(browser);
    client = await CdpClient.connect(browserUrl);
    const version = await client.call("Browser.getVersion");
    return { value: await operation({ browserUrl, version }), version };
  } finally {
    await client?.close();
    browser.kill("SIGTERM");
    await waitForProcessExit(browser, 1000);
    if (browser.exitCode === null) { browser.kill("SIGKILL"); await waitForProcessExit(browser, 1000); }
    rmSync(profile, { recursive: true, force: true });
  }
}

async function ready(client) {
  await client.call("Runtime.enable"); await client.call("Page.enable");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(client, { expression: "({ready:globalThis.__hc2Slice4Ready,error:globalThis.__hc2Slice4Error??null})" });
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for HC-2 Slice 4 browser harness.");
}

async function startServer() {
  let profileAForServer = null;
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/" || requestUrl.pathname === "/profile-a" || requestUrl.pathname === "/profile-b") {
        const mode = requestUrl.pathname === "/profile-a" ? "profile-a" : requestUrl.pathname === "/profile-b" ? "profile-b" : "base";
        const profileInput = JSON.stringify(profileAForServer);
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><title>HC-2 Slice 4</title><script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script><script type="module">globalThis.__hc2Slice4Ready=false;globalThis.__hc2RunDone=false;globalThis.__hc2RunResult=null;globalThis.__hc2RunError=null;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==="bigint"?child.toString():child));try{globalThis.hc2s4=await import("/scripts/collaboration-hc2-slice4-browser-runtime.ts");globalThis.__hc2Slice4Ready=true;const mode=${JSON.stringify(mode)};const operation=mode==="profile-a"?globalThis.hc2s4.runProfileA("patchmark-hc2-slice4-profile"):mode==="profile-b"?globalThis.hc2s4.runProfileB("patchmark-hc2-slice4-profile",${profileInput}):null;if(operation)void operation.then(value=>{globalThis.__hc2RunResult=clean(value);globalThis.__hc2RunDone=true;},error=>{globalThis.__hc2RunError=error?.stack??String(error);globalThis.__hc2RunDone=true;});}catch(error){globalThis.__hc2Slice4Error=error?.stack??String(error);}</script>`);
        return;
      }
      if (requestUrl.pathname.endsWith(".ts") && (requestUrl.pathname.startsWith("/lib/collaboration/") || requestUrl.pathname === "/scripts/collaboration-hc2-slice4-browser-runtime.ts")) {
        const sourcePath = safePath(requestUrl.pathname);
        const result = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        const errors = (result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
        if (errors.length) throw new Error(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")).join("\n"));
        const output = result.outputText.replaceAll('from "libsodium-wrappers-sumo"', 'from "/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs"');
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/javascript; charset=utf-8" }); response.end(output); return;
      }
      if (requestUrl.pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(requestUrl.pathname)) {
        const sourcePath = safePath(requestUrl.pathname);
        let output = readFileSync(sourcePath, "utf8");
        if (requestUrl.pathname.includes("libsodium-wrappers-sumo")) output = output.replace('from"libsodium-sumo"', 'from"/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"');
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/javascript; charset=utf-8" }); response.end(output); return;
      }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500, { "Content-Type": "text/plain" }); response.end(error instanceof Error ? error.stack : String(error)); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser server did not receive a port.");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    setProfileA(value) { profileAForServer = value; },
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

function safePath(pathname) {
  const path = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!path.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Browser harness path escaped repository root.");
  return path;
}

function withTimeout(promise, milliseconds, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); })
  ]).finally(() => clearTimeout(timeout));
}

async function waitForRunUrl(webSocketUrl, milliseconds, label, reportStage) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < milliseconds) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const probe = await CdpClient.connect(webSocketUrl);
    try {
      const state = await withTimeout(evaluateSafe(probe, "({done:globalThis.__hc2RunDone,result:globalThis.__hc2RunResult,error:globalThis.__hc2RunError,stage:globalThis.__hc2s4Stage??'not-started'})"), 10_000, `${label} probe`);
      if (state.error) throw new Error(state.error);
      if (state.done) return state.result;
      if (reportStage && state.stage !== last) { process.stderr.write(`[hc2-slice4-browser] profile A stage: ${state.stage}\n`); last = state.stage; }
    } finally { await probe.close(); }
  }
  throw new Error(`${label} timed out after ${milliseconds}ms`);
}

async function evaluateSafe(client, expression) {
  const result = await cdpCall(client, "Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

function cdpCall(client, method, params = {}) {
  const id = client.nextId++;
  return new Promise((resolveCall, rejectCall) => {
    client.pending.set(id, { reject: rejectCall, resolve: resolveCall });
    client.socket.send(JSON.stringify({ id, method, params }));
  });
}

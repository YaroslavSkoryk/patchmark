import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CdpClient, createPage, evaluate, findChromeExecutable, waitForDevToolsUrl, waitForProcessExit }
  from "./comment-rail-editor-browser-regression.test.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(repositoryRoot, "scripts/fixtures/collaboration-hc2-slice5-v1.json"), "utf8"));
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 5 browser tests.");
const profileAPath = mkdtempSync(join(tmpdir(), "patchmark-hc2-slice5-owner-"));
const profileBPath = mkdtempSync(join(tmpdir(), "patchmark-hc2-slice5-candidate-"));
const databasePrefix = "patchmark-hc2-slice5-browser";
const state = { candidate: null, owner: null, proof: null, delivery: null };
const server = await startServer(state);
let assertions = 0;
let product = "unknown";
try {
  process.stderr.write("[hc2-slice5-browser] candidate setup\n");
  const candidate = await withChromeProfile(profileBPath, "/candidate-setup", async (value, version) => { product = version.product; return value; });
  state.candidate = candidate;
  assertions += 1; assert.equal(candidate.absent_before_open, true, "candidate profile starts without owner or candidate databases");
  assertions += 1; assert.equal(candidate.create_status, "stored", "candidate native keys persist once");
  assertions += 1; assert.equal(candidate.exact_retry_status, "exact_retry", "candidate key retry reopens exact persisted keys");
  assertions += 1; assert.equal(candidate.request_signature_verified, true, "candidate request uses persisted Ed25519 key");
  for (const key of ["signing_private_extractable", "recipient_private_extractable", "kek_extractable"]) {
    assertions += 1; assert.equal(candidate[key], false, `${key} remains nonextractable`);
  }

  process.stderr.write("[hc2-slice5-browser] owner challenge and frozen vector\n");
  const owner = await withChromeProfile(profileAPath, "/owner-challenge", (value) => value);
  state.owner = owner;
  assertions += 1; assert.equal(owner.isolated_from_candidate_profile, true, "owner user-data directory cannot see candidate IndexedDB");
  assertions += 1; assert.equal(owner.invitation_status, "stored", "owner stores accepted invitation evidence");
  assertions += 1; assert.equal(owner.invitation_retry_status, "exact_retry", "owner invitation retry is immutable");
  assertions += 1; assert.equal(owner.challenge_status, "stored", "owner stores one-use possession challenge");
  assertions += 1; assert.deepEqual(owner.vector, fixture.expected, "Chrome reproduces the exact frozen Node/Python vector");
  process.stderr.write("[hc2-slice5-browser] owner two-tab contention\n");
  const contention = await withChromeProfileTwoTabs(profileAPath, ["/owner-contention-first", "/owner-contention-second"]);
  assertions += 1; assert.equal(contention.filter((entry) => entry.outcome === "accepted").length, 1, "two owner tabs accept at most one competing invitation transition");
  assertions += 1; assert.equal(contention.filter((entry) => entry.outcome === "rejected").length, 1, "losing owner tab observes explicit CAS rejection");

  process.stderr.write("[hc2-slice5-browser] candidate proof after reopen\n");
  const proof = await withChromeProfile(profileBPath, "/candidate-proof", (value) => value);
  state.proof = proof;
  assertions += 1; assert.equal(proof.proof_verified, true, "candidate reopens X25519 key, opens challenge, and signs response with Ed25519");

  process.stderr.write("[hc2-slice5-browser] owner CAS and epoch deliveries\n");
  const delivery = await withChromeProfile(profileAPath, "/owner-finalize", (value) => value);
  state.delivery = delivery;
  assertions += 1; assert.equal(delivery.proof_verified, true, "owner verifies both candidate possession factors");
  assertions += 1; assert.equal(delivery.second_challenge_rejected, true, "challenge CAS rejects a different second consumption");
  assertions += 1; assert.equal(delivery.invitation_reuse_rejected, true, "invitation CAS rejects reuse");

  process.stderr.write("[hc2-slice5-browser] candidate install, final marker, and reopen\n");
  const opened = await withChromeProfile(profileBPath, "/candidate-open", (value) => value);
  assertions += 1; assert.equal(opened.opened_epoch_bytes, 32, "candidate opens the real replacement epoch bytes");
  assertions += 1; assert.equal(opened.installed_vault_reopened, true, "candidate installed vault reopens from IndexedDB");
  assertions += 1; assert.equal(opened.epoch_commitment_match, true, "owner and candidate derive the same epoch commitment");
  assertions += 1; assert.equal(opened.revoked_replacement_open_rejected, true, "revoked candidate cannot open an owner-only replacement epoch envelope");
  assertions += 1; assert.equal(opened.completion_written_after_open, true, "candidate completion marker is written only after authenticated open");
  assertions += 1; assert.equal(opened.pending_vault_removed_after_completion, true, "pending candidate vault is removed only after final completion");
  const major = Number(/\/(\d+)\./.exec(product)?.[1] ?? 0);
  assertions += 1; assert(major >= 137, `Chromium ${major} is below the frozen HC-2 floor 137`);

  process.stdout.write(`${JSON.stringify({ assertions, status: "ok", chrome: product, chrome_major: major,
    separate_user_data_directories: true, indexeddb_profile_isolation: true, node_python_chrome_vector_equivalence: true,
    webcrypto_ed25519_x25519_nonextractable_reopen: true, owner_two_tab_cas: true, candidate_epoch_install_and_reopen: true,
    revoked_device_replacement_open_rejected: true, edge_not_tested: true, chromium_floor_not_inferred_from_chrome: true,
    temporary_profiles_removed: true, servers_closed: true }, null, 2)}\n`);
} finally {
  await server.close();
  rmSync(profileAPath, { recursive: true, force: true });
  rmSync(profileBPath, { recursive: true, force: true });
}

async function withChromeProfile(profilePath, pathname, operation) {
  const browser = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-extensions", "--disable-sync", "--disable-features=Translate,MediaRouter", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  let browserClient; let page;
  try {
    const browserUrl = await waitForDevToolsUrl(browser); browserClient = await CdpClient.connect(browserUrl);
    const version = await browserClient.call("Browser.getVersion");
    const pageUrl = await createPage(browserUrl, `${server.url}${pathname.slice(1)}`); page = await CdpClient.connect(pageUrl);
    await page.call("Runtime.enable"); await page.call("Page.enable");
    const value = await waitForRun(page, pathname, 120_000);
    return operation(value, version);
  } finally {
    await page?.close(); await browserClient?.close(); browser.kill("SIGTERM"); await waitForProcessExit(browser, 1500);
    if (browser.exitCode === null) { browser.kill("SIGKILL"); await waitForProcessExit(browser, 1500); }
  }
}

async function withChromeProfileTwoTabs(profilePath, pathnames) {
  const browser = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-extensions", "--disable-sync", "--disable-features=Translate,MediaRouter", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  let browserClient; const pages = []; const results = [];
  try {
    const browserUrl = await waitForDevToolsUrl(browser); browserClient = await CdpClient.connect(browserUrl);
    for (const pathname of pathnames) {
      const pageUrl = await createPage(browserUrl, `${server.url}${pathname.slice(1)}`); const page = await CdpClient.connect(pageUrl); pages.push(page);
      await page.call("Runtime.enable"); await page.call("Page.enable");
      results.push(await waitForRun(page, pathname, 120_000));
    }
    return results;
  } finally {
    await Promise.all(pages.map((page) => page.close())); await browserClient?.close(); browser.kill("SIGTERM"); await waitForProcessExit(browser, 1500);
    if (browser.exitCode === null) { browser.kill("SIGKILL"); await waitForProcessExit(browser, 1500); }
  }
}

async function waitForRun(page, label, milliseconds) {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    const value = await evaluate(page, { expression: "({done:globalThis.__hc2Done??false,result:globalThis.__hc2Result??null,error:globalThis.__hc2Error??null})" });
    if (value.error) throw new Error(value.error);
    if (value.done) return value.result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} timed out after ${milliseconds}ms`);
}

async function startServer(sharedState) {
  const csp = "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'none'";
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const modes = {
        "/candidate-setup": `runtime.runCandidateSetup(${JSON.stringify(databasePrefix)})`,
        "/owner-challenge": `runtime.runOwnerChallenge(${JSON.stringify(databasePrefix)},${JSON.stringify(sharedState.candidate)},${JSON.stringify(fixture)})`,
        "/owner-contention-first": `runtime.runOwnerContention(${JSON.stringify(databasePrefix)},"first")`,
        "/owner-contention-second": `runtime.runOwnerContention(${JSON.stringify(databasePrefix)},"second")`,
        "/candidate-proof": `runtime.runCandidateProof(${JSON.stringify(databasePrefix)},${JSON.stringify(sharedState.candidate)},${JSON.stringify(sharedState.owner)})`,
        "/owner-finalize": `runtime.runOwnerFinalize(${JSON.stringify(databasePrefix)},${JSON.stringify(sharedState.candidate)},${JSON.stringify(sharedState.owner)},${JSON.stringify(sharedState.proof)})`,
        "/candidate-open": `runtime.runCandidateOpen(${JSON.stringify(databasePrefix)},${JSON.stringify(sharedState.delivery)})`
      };
      if (url.pathname in modes) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script><script type="module">globalThis.__hc2Done=false;try{const runtime=await import("/scripts/collaboration-hc2-slice5-browser-runtime.ts");const value=await ${modes[url.pathname]};globalThis.__hc2Result=value;globalThis.__hc2Done=true;}catch(error){globalThis.__hc2Error=error?.stack??String(error);globalThis.__hc2Done=true;}</script>`);
        return;
      }
      if (url.pathname.endsWith(".ts") && (url.pathname.startsWith("/lib/collaboration/") || url.pathname.startsWith("/scripts/collaboration-hc2-slice5-"))) {
        const sourcePath = safePath(url.pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        const errors = (transpiled.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
        if (errors.length) throw new Error(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")).join("\n"));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/javascript; charset=utf-8" }); response.end(transpiled.outputText); return;
      }
      if (url.pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(url.pathname)) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Content-Type": "text/javascript; charset=utf-8" }); response.end(readFileSync(safePath(url.pathname), "utf8")); return;
      }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500, { "Content-Type": "text/plain" }); response.end(error instanceof Error ? error.stack : String(error)); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Slice 5 browser server has no port.");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function safePath(pathname) {
  const path = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!path.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Browser harness path escaped repository root.");
  return path;
}

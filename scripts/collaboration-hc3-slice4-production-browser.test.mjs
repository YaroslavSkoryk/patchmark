import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

const root = new URL("..", import.meta.url).pathname;
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for the HC-3 Slice 4 production lock.");
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice4-production-project-"));
const projectRoot = join(fixtureRoot, "source-project");
createProjectFixture(projectRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory, { persistWrites: false });
const port = 3125;
const url = `http://127.0.0.1:${port}/?collaboration=development_shadow#pmhc3.v1.fake`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", `${port}`], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW: "development_shadow"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
const profile = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice4-production-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-background-networking", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let client;
let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

try {
  await waitForHttp(`http://127.0.0.1:${port}/`);
  const browserUrl = await waitForDevToolsUrl(chrome);
  const pageUrl = await createPage(browserUrl, "about:blank");
  client = await CdpClient.connect(pageUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: createProjectPickerShim({ baseUrl: fixtureServer.baseUrl, directories: inventory.directories, files: inventory.files, pickerPaths: ["source-project"], projectName: "hc3-production-source" }) });
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('patchmark-collaboration', 'development_shadow'); document.cookie = 'patchmark-collaboration=development_shadow; SameSite=Strict'; window.__patchmarkProductionCapabilityCalls = 0;` });
  await client.call("Page.navigate", { url });
  await waitForEditorShell(client);
  await click("File");
  await click("Open Project Folder");
  await waitFor("project", "document.querySelector('.application-breadcrumb-project')?.textContent?.includes('HC3 Production Source')");
  await click("File");
  const evidence = await evaluate(client, { expression: `(() => ({ menuLabels: Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()), collaborationText: document.body.innerText.includes('Collaboration…'), workspace: Boolean(document.querySelector('[data-testid="collaboration-qualification-workspace"]')), backdrop: Boolean(document.querySelector('[data-testid="collaboration-qualification-backdrop"]')), barHeight: document.querySelector('.application-bar')?.getBoundingClientRect().height, resources: performance.getEntriesByType('resource').map((entry) => entry.name), capabilityCalls: window.__patchmarkProductionCapabilityCalls }))()` });
  check(!evidence.menuLabels.includes("Collaboration…"), "production File menu contains no collaboration entry");
  equal([evidence.collaborationText, evidence.workspace, evidence.backdrop], [false, false, false], "production contains no visible or hidden collaboration DOM");
  equal(evidence.barHeight, 48, "production compact top panel remains unchanged");
  equal(evidence.capabilityCalls, 0, "attempted production activation performs no qualification capability work");
  check(!evidence.resources.some((entry) => /product-qualification|collaboration-qualification|qr-provider/.test(entry)), "production loads no lazy qualification resource");
  const version = await client.call("Browser.getVersion");
  process.stdout.write(`${JSON.stringify({ assertions, chrome: version.product, query_ignored: true, fragment_ignored: true, local_storage_ignored: true, cookie_ignored: true, public_environment_ignored: true, collaboration_dom: 0, compact_bar_height: evidence.barHeight, status: "ok" }, null, 2)}\n`);
} finally {
  await client?.close().catch(() => undefined);
  chrome.kill("SIGTERM");
  server.kill("SIGTERM");
  await waitForProcessExit(chrome, 1_000).catch(() => chrome.kill("SIGKILL"));
  await waitForProcessExit(server, 2_000).catch(() => server.kill("SIGKILL"));
  await fixtureServer.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function click(text) {
  await waitFor(`button ${text}`, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  await evaluate(client, { expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled); button.click(); return true; })()`, userGesture: true });
}
async function waitFor(label, expression) { for (let attempt = 0; attempt < 200; attempt += 1) { if (await evaluate(client, { expression })) return; await delay(50); } throw new Error(`Timed out waiting for ${label}`); }
async function waitForHttp(target) { for (let attempt = 0; attempt < 200; attempt += 1) { try { if ((await fetch(target)).ok) return; } catch {} await delay(100); } throw new Error("Production server did not become ready. Run npm run build first."); }

function createProjectFixture(root) {
  const metadata = join(root, ".patchmark"); const documentId = "doc_hc3_production"; const now = "2026-08-26T00:00:00.000Z";
  mkdirSync(join(metadata, "documents", documentId, "versions"), { recursive: true });
  for (const directory of ["context-packs", "imports", "recovery"]) mkdirSync(join(metadata, "documents", documentId, directory), { recursive: true });
  writeFileSync(join(root, "source.md"), "# HC3 Production Source\n\nUnchanged.\n");
  writeFileSync(join(metadata, "project.json"), `${JSON.stringify({ format: "patchmark-project", schema_version: 2, project_id: "prj_hc3_production", title: "HC3 Production Source", created_at: now, manifest_revision: 1, groups: [], documents: [{ document_id: documentId, path: "source.md", display_title: "Source", group_id: null, role: "research", status: "active", position: 1000, added_at: now, archived_at: null }] }, null, 2)}\n`);
  const store = join(metadata, "documents", documentId); writeFileSync(join(store, "manifest.json"), `${JSON.stringify({ schema_version: 1, project_id: "prj_hc3_production", document_id: documentId, project_name: "HC3 Production Source", document_file: "document.md", created_at: now, updated_at: now }, null, 2)}\n`); writeFileSync(join(store, "comments.json"), "[]\n"); writeFileSync(join(store, "patches.json"), "[]\n"); writeFileSync(join(store, "tasks.json"), "[]\n"); writeFileSync(join(store, "document.json"), `${JSON.stringify({ format: "patchmark-document-store", schema_version: 1, document_id: documentId, created_at: now, source: "created" }, null, 2)}\n`);
}

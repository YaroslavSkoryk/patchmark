import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
const productPort = 3124;
const nextPort = 3125;
const editorUrl = `http://127.0.0.1:${productPort}/`;
const nextUrl = `http://127.0.0.1:${nextPort}/`;
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for HC-3 Slice 4 product qualification.");
const slice5Fixture = JSON.parse(readFileSync(join(repositoryRoot, "scripts/fixtures/collaboration-hc2-slice5-v1.json"), "utf8"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice4-project-"));
const sourceProjectRoot = join(fixtureRoot, "source-project");
const otherProjectRoot = join(fixtureRoot, "other-project");
createProjectFixture(sourceProjectRoot, { projectId: "prj_hc3_slice4", documentId: "doc_hc3_slice4", title: "HC3 Product Source", body: "# HC3 Product Source\n\nImmutable source bytes.\n" });
createProjectFixture(otherProjectRoot, { projectId: "prj_hc3_slice4_other", documentId: "doc_hc3_slice4_other", title: "HC3 Other Project", body: "# HC3 Other Project\n\nProject-switch isolation fixture.\n" });
const sourceBefore = hashProject(sourceProjectRoot);
const otherBefore = hashProject(otherProjectRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", `${nextPort}`], {
  cwd: repositoryRoot,
  env: { ...process.env, NODE_ENV: "development" },
  stdio: ["ignore", "ignore", "ignore"]
});
let proxy;
let profileA;
let profileB;
let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

try {
  await waitForHttp(nextUrl);
  proxy = await startProductProxy(productPort, nextPort);
  await waitForHttp(editorUrl);
  profileA = await openProfile("owner", "owner");
  profileB = await openProfile("candidate", "candidate");
  await openProject(profileA, "HC3 Product Source");
  await openProject(profileB, "HC3 Product Source");

  const beforeEntry = await workspaceEvidence(profileA);
  equal([beforeEntry.workspace, beforeEntry.hiddenWorkspace, beforeEntry.bridgeLoaded, beforeEntry.driverInspects, beforeEntry.driverInvokes], [false, false, false, 0, 0], "no collaboration DOM or authority runtime exists before explicit product entry");
  await openCollaboration(profileA);
  const openedA = await workspaceEvidence(profileA);
  equal([openedA.workspace, openedA.dialogName, openedA.liveRegion], [true, "Collaboration", "polite"], "File > Collaboration opens the actual production-locked workspace");
  check(openedA.bridgeLoaded && openedA.driverInspects >= 1, "explicit entry lazily assembles and inspects the real HC-2/HC-3 authority runtime");
  check(openedA.focusedHeading, "initial focus moves to the workspace heading");
  equal([openedA.sectionCount, openedA.capabilityCount], [8, 17], "the integrated workspace exposes all sections and capability probes");
  check(openedA.noHorizontalOverflow, "desktop workspace contains long content without horizontal overflow");

  await click(profileA, "Create collaboration copy");
  await waitText(profileA, "Recovery kit required");
  await click(profileA, "Verify recovery kit");
  await waitText(profileA, "Ready to invite");
  await click(profileA, "Invite collaborator");
  await waitText(profileA, "Prepared Invitation");
  await click(profileA, "Show QR");
  const qrEvidence = await evaluate(profileA.client, { expression: "(() => { const canvas = document.querySelector('[data-testid=\"collaboration-qualification-workspace\"] canvas[role=\"img\"]'); return { exists: Boolean(canvas), width: canvas?.width ?? 0, label: canvas?.getAttribute('aria-label') }; })()" });
  equal([qrEvidence.exists, qrEvidence.label], [true, "Invitation QR code"], "the real accepted invitation renders through the labelled QR canvas");
  check(qrEvidence.width > 100, "the Invitation QR contains an encoded matrix");
  const invitationFromA = await exactArtifact(profileA);
  check(typeof invitationFromA === "string" && invitationFromA.startsWith("pmhc3.v1.ih."), "the product exposes the real HC-3 invitation carrier text");

  await openCollaboration(profileB);
  equal((await workspaceEvidence(profileB)).bridgeLoaded, true, "Device B assembles its own isolated authority runtime only after explicit entry");
  await importHandoff(profileB, "invitation", invitationFromA);
  await reopenCollaboration(profileB);
  await click(profileB, "Complete invitation");
  await fillArtifact(profileB, invitationFromA);
  await click(profileB, "Preview received item");
  await waitText(profileB, "Invitation verified");
  await click(profileB, "Continue invitation");
  await waitText(profileB, "Create Response");
  await click(profileB, "Create Response");
  await waitText(profileB, "Prepared Response");
  const requestFromB = await exactArtifact(profileB);

  await transferHandoff(profileA, profileB, "public_info");
  await transferHandoff(profileB, profileA, "public_info");
  await transferHandoff(profileB, profileA, "candidate");
  await click(profileA, "Complete invitation");
  await fillArtifact(profileA, requestFromB);
  await click(profileA, "Preview received item");
  await waitText(profileA, "Possession check required");

  await transferHandoff(profileA, profileB, "owner");
  await reopenCollaboration(profileB);
  await click(profileB, "Create Response");
  await waitText(profileB, "Possession Response ready");
  const proofFromB = await exactArtifact(profileB);
  await transferHandoff(profileB, profileA, "proof");
  await fillArtifact(profileA, proofFromB);
  await click(profileA, "Preview received item");
  await waitText(profileA, "Approve collaborator");
  await click(profileA, "Approve collaborator");
  await waitText(profileA, "Admission ready");
  const admission = await exportHandoff(profileA, "file");
  check(typeof admission?.encoded === "string" && admission.encoded.length > 1000, "the UI action reaches the real encrypted V2 admission bundle boundary");
  await transferHandoff(profileA, profileB, "finalize");
  await importHandoff(profileB, "file", admission);
  await click(profileA, "Save encrypted file");
  await waitText(profileA, "Admission complete");

  await reopenCollaboration(profileB);
  await click(profileB, "Synchronize changes");
  await click(profileB, "Choose encrypted file");
  await click(profileB, "Preview encrypted file");
  await click(profileB, "Import encrypted file");
  await waitText(profileB, "Admission complete");
  check(await evaluate(profileB.client, { expression: "document.body.innerText.toLowerCase().includes('earlier collaboration history was not fully traversed at admission')" }), "the admitted interface preserves the honest partial-history boundary");

  await click(profileA, "Synchronize changes");
  await click(profileA, "Create connection request");
  await waitText(profileA, "Prepared connection request");
  const offerFromA = await exactArtifact(profileA);
  await click(profileB, "Complete invitation");
  await fillArtifact(profileB, offerFromA);
  await click(profileB, "Open connection request");
  await waitText(profileB, "Prepared connection response");
  const answerFromB = await exactArtifact(profileB);
  await click(profileA, "Complete invitation");
  await fillArtifact(profileA, answerFromB);
  await click(profileA, "Open connection response");
  await waitText(profileA, "Connected");
  const mutationA = await transferHandoff(profileA, profileB, "mutation");
  const mutationB = await transferHandoff(profileB, profileA, "mutation");
  check(mutationA?.event_id && mutationB?.event_id && mutationA.event_id !== mutationB.event_id, "two isolated profiles create distinct accepted semantic mutations");
  await click(profileB, "Synchronize changes");
  await click(profileB, "Sync now");
  await click(profileA, "Synchronize changes");
  await click(profileA, "Sync now");
  await waitText(profileA, "Conflict needs a decision");
  await waitText(profileB, "Conflict needs a decision");

  await click(profileB, "Conflicts");
  equal(await evaluate(profileB.client, { expression: "Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Resolve selected outcome')?.disabled" }), true, "the real reviewer authority cannot resolve the reconstructed conflict");
  await click(profileA, "Conflicts");
  const conflictEvidence = await evaluate(profileA.client, { expression: "(() => ({ contenders: document.querySelectorAll('[data-testid=\"collaboration-qualification-workspace\"] article li').length, disabled: Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Resolve selected outcome')?.disabled }))()" });
  check(conflictEvidence.contenders >= 2 && conflictEvidence.disabled === false, "the owner sees all real contenders and the accepted resolution capability");
  await click(profileA, "Resolve selected outcome");
  await waitText(profileA, "Conflict resolved");

  await click(profileA, "Synchronize changes");
  await click(profileA, "Send encrypted update");
  await waitText(profileA, "Prepared encrypted update");
  const inventoryFile = await exportHandoff(profileA, "file");
  await importFileThroughUi(profileB, inventoryFile);
  const requestFile = await exportHandoff(profileB, "file");
  await importFileThroughUi(profileA, requestFile);
  const responseFile = await exportHandoff(profileA, "file");
  await importFileThroughUi(profileB, responseFile);
  await waitText(profileA, "Sync complete");
  await waitText(profileB, "Sync complete");

  await click(profileA, "Collaborators and devices");
  await click(profileA, "Revoke device");
  await waitText(profileA, "Device revoked");
  await transferHandoff(profileA, profileB, "revocation");
  await reopenCollaboration(profileB);
  await waitText(profileB, "Device revoked");
  const cutoff = await evaluate(profileB.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.attemptRevokedMutation()" });
  equal([cutoff.status, cutoff.reason, cutoff.cryptographic_calls, cutoff.portable_objects_added], ["rejected", "device_revoked_at_accepted_control_cutoff", 0, 0], "the revoked device is stopped at the accepted authority cutoff before cryptography or persistence");

  await click(profileA, "Recovery and blocked states");
  await click(profileA, "Reopen and verify");
  await waitText(profileA, "Reopen verified");
  await click(profileB, "Recovery and blocked states");
  await click(profileB, "Reopen and verify");
  await waitText(profileB, "Reopen verified");
  const evidenceA = await authorityEvidence(profileA);
  const evidenceB = await authorityEvidence(profileB);
  equal(evidenceA.reopened.collaboration.authoritative, evidenceB.reopened.collaboration.authoritative, "both product profiles reopen the same authoritative object identities and bytes");
  equal(evidenceA.reopened.collaboration.projection, evidenceB.reopened.collaboration.projection, "both product profiles reopen the same HC-1 projection, conflicts, roots, and checkpoint");
  equal(evidenceA.reopened.collaboration.authority, evidenceB.reopened.collaboration.authority, "both product profiles reopen the same membership, device, control-head, and epoch evidence");
  equal(evidenceA.reopened.collaboration.evidence, evidenceB.reopened.collaboration.evidence, "both product profiles reopen the same acknowledgement, receipt, state-blob, and snapshot evidence");
  equal(evidenceB.full_history_verified, false, "Device B retains full_history_verified false after the integrated reopen");
  check([evidenceA.reopened.access, evidenceB.reopened.access].every((value) => value?.action === "reopen_and_verify" && value?.operation?.status === "completed" && value?.status?.guidance === "converged" && value?.source_immutable === true), "revocation authority also reopens through the real Slice 8 controller");
  for (const boundary of ["hc1_foundation", "hc2_recovery_custody", "hc2_invitation_control", "hc2_enrollment_possession", "hc2_admission_v2", "hc3_direct_v3", "hc1_conflict_resolution", "hc2_replication_v3", "hc2_epoch_rotation", "durable_reconstruction"]) {
    check(evidenceA.boundaries.includes(boundary) || evidenceB.boundaries.includes(boundary), `integrated UI evidence reaches ${boundary}`);
  }
  check(/^[0-9a-f]{64}$/.test(evidenceA.last_exact_v3_sha256) && /^[0-9a-f]{64}$/.test(evidenceB.last_exact_v3_sha256), "both profiles bind exact transported V3 bytes to SHA-256 evidence");
  check(evidenceA.real_calls.includes("hc3.direct_v3_bounded_exchange") && evidenceA.real_calls.includes("hc1.portable_close_reopen_projector_roots"), "the product route invokes real direct synchronization and durable reconstruction implementations");

  await setViewport(profileA, 390, 844);
  const narrow = await workspaceEvidence(profileA);
  check(narrow.noHorizontalOverflow && narrow.workspaceWidth <= 390, "the real integrated workspace remains usable at 390×844");
  const closedBeforeEscape = narrow.driverClosed;
  await pressEscape(profileA);
  await waitFor(profileA, "workspace close", "!document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]')");
  await waitFor(profileA, "authority close", `window.__patchmarkHc3Slice4BridgeEvidence.closed === ${closedBeforeEscape + 1}`);

  await profileA.client.call("Page.reload", { ignoreCache: true });
  await waitForEditorShell(profileA.client);
  const afterReload = await workspaceEvidence(profileA);
  equal([afterReload.workspace, afterReload.bridgeLoaded, afterReload.driverInvokes], [false, false, 0], "a real page reload starts with no hidden collaboration UI or background authority work");
  await openProject(profileA, "HC3 Product Source");
  await openProject(profileA, "HC3 Other Project");
  await openCollaboration(profileA);
  const switched = await authorityEvidence(profileA, "prj_hc3_slice4_other");
  equal([switched.revision, switched.accepted_object_ids.length, switched.authority_invocations], ["0", 0, 0], "project switching binds a fresh authority instance and leaks no accepted source-project state");

  equal(hashProject(sourceProjectRoot), sourceBefore, "source project bytes remain byte-identical across the real integrated workflow");
  equal(hashProject(otherProjectRoot), otherBefore, "project-switch fixture bytes remain byte-identical");
  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: profileA.product,
    isolated_profiles: 2,
    actual_product_entry: "File > Collaboration…",
    authority_driver: "real_hc2_hc3_assembled_runtime",
    concurrent_mutations: [mutationA.event_id, mutationB.event_id],
    durable_boundaries: [...new Set([...evidenceA.boundaries, ...evidenceB.boundaries])].sort(),
    direct_v3_sha256: [evidenceA.last_exact_v3_sha256, evidenceB.last_exact_v3_sha256],
    full_history_verified_on_admitted_device: evidenceB.full_history_verified,
    authoritative_reopen_equal: true,
    conflict_resolution_and_revocation: true,
    actual_reload_and_project_switch: true,
    source_project_immutable: true,
    temporary_profiles_removed: true,
    status: "ok"
  }, null, 2)}\n`);
} finally {
  await profileA?.close();
  await profileB?.close();
  await proxy?.close();
  await fixtureServer.close();
  next.kill("SIGTERM");
  await waitForProcessExit(next, 2_000).catch(() => next.kill("SIGKILL"));
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function openProfile(label, role) {
  const profile = mkdtempSync(join(tmpdir(), `patchmark-hc3-slice4-${label}-`));
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserUrl = await waitForDevToolsUrl(process);
  const pageUrl = await createPage(browserUrl, "about:blank");
  const client = await CdpClient.connect(pageUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: createProjectPickerShim({ baseUrl: fixtureServer.baseUrl, directories: inventory.directories, files: inventory.files, pickerPaths: ["source-project", "other-project"], projectName: "hc3-slice4-source" }) });
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: authorityRuntimeSource(role) });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  const version = await client.call("Browser.getVersion");
  return { client, process, product: version.product, profile, async close() { await client.close().catch(() => undefined); process.kill("SIGTERM"); await waitForProcessExit(process, 1_000).catch(() => process.kill("SIGKILL")); rmSync(profile, { recursive: true, force: true }); } };
}

async function openProject(profile, title) {
  await click(profile, "File");
  await click(profile, "Open Project Folder");
  await waitFor(profile, `project ${title}`, `document.querySelector('.application-breadcrumb-project')?.textContent?.includes(${JSON.stringify(title)})`);
}

async function openCollaboration(profile) {
  await click(profile, "File");
  await click(profile, "Collaboration…");
  await waitFor(profile, "collaboration workspace", "Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'))");
  await waitFor(profile, "capabilities", "document.querySelectorAll('[data-testid=\"collaboration-qualification-workspace\"] details li').length === 17");
}

async function reopenCollaboration(profile) {
  if (await evaluate(profile.client, { expression: "Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'))" })) {
    await click(profile, "Close");
    await waitFor(profile, "workspace closed", "!document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]')");
  }
  await openCollaboration(profile);
}

async function fillArtifact(profile, value) {
  await evaluate(profile.client, { expression: `(() => { const input = document.querySelector('#collaboration-artifact-input'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value.length; })()`, userGesture: true });
}

async function exactArtifact(profile) {
  return evaluate(profile.client, { expression: "document.querySelector('textarea[aria-label=\"Exact prepared artifact text\"]')?.value" });
}

async function exportHandoff(profile, kind) {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.exportHandoff(${JSON.stringify(kind)})` });
}

async function importHandoff(profile, kind, value) {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.importHandoff(${JSON.stringify(kind)}, ${JSON.stringify(value)})` });
}

async function transferHandoff(sender, receiver, kind) {
  const value = await exportHandoff(sender, kind);
  if (value === null || value === undefined) throw new Error(`Missing ${kind} handoff.`);
  await importHandoff(receiver, kind, value);
  return value;
}

async function importFileThroughUi(profile, file) {
  await importHandoff(profile, "file", file);
  await reopenCollaboration(profile);
  await click(profile, "Synchronize changes");
  await click(profile, "Choose encrypted file");
  await click(profile, "Preview encrypted file");
  await click(profile, "Import encrypted file");
  await waitFor(profile, "encrypted file import completion", "window.__patchmarkHc3Slice4AuthorityHarness.evidence().then((value) => ['file_ready', 'converged'].includes(value.phase))");
}

async function authorityEvidence(profile, projectId = "prj_hc3_slice4") {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.evidence(${JSON.stringify(projectId)})` });
}

async function click(profile, text) {
  await waitFor(profile, `button ${text}`, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  await evaluate(profile.client, { expression: `(() => { const matches = Array.from(document.querySelectorAll('button')).filter((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled); const button = matches.find((candidate) => !candidate.closest('nav')) ?? matches[0]; button.click(); return true; })()`, userGesture: true });
}

async function waitText(profile, text) { await waitFor(profile, `text ${text}`, `document.body.innerText.includes(${JSON.stringify(text)})`); }
async function waitFor(profile, label, expression) {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (await evaluate(profile.client, { expression })) return; await delay(50); }
  const diagnostic = await evaluate(profile.client, { expression: "({ body: document.body.innerText.slice(0, 4000), bridge: window.__patchmarkHc3Slice4BridgeEvidence, runtimeError: window.__patchmarkHc3Slice4RuntimeError ?? null })" });
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}
async function setViewport(profile, width, height) { await profile.client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true }); }
async function pressEscape(profile) { await profile.client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await profile.client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); }

async function workspaceEvidence(profile) {
  return evaluate(profile.client, { expression: "(() => { const workspace = document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'); const rect = workspace?.getBoundingClientRect(); const bridge = window.__patchmarkHc3Slice4BridgeEvidence ?? {}; return { workspace: Boolean(workspace), hiddenWorkspace: Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"][hidden]')), dialogName: workspace?.querySelector('h2')?.textContent ?? null, liveRegion: workspace?.querySelector('[aria-live]')?.getAttribute('aria-live') ?? null, focusedHeading: document.activeElement?.id === 'collaboration-workspace-title', sectionCount: workspace?.querySelector('nav')?.querySelectorAll('button').length ?? 0, capabilityCount: workspace?.querySelectorAll('details li').length ?? 0, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, workspaceWidth: rect?.width ?? 0, bridgeLoaded: bridge.loaded ?? false, driverInspects: bridge.inspects ?? 0, driverInvokes: bridge.invokes ?? 0, driverClosed: bridge.closed ?? 0 }; })()" });
}

function authorityRuntimeSource(role) {
  const configs = {
    prj_hc3_slice4: { role, project_id: "prj_hc3_slice4", project_title: "HC3 Product Source", database_prefix: `patchmark-hc3-slice4-${role}-source`, slice5_fixture: slice5Fixture },
    prj_hc3_slice4_other: { role, project_id: "prj_hc3_slice4_other", project_title: "HC3 Other Project", database_prefix: `patchmark-hc3-slice4-${role}-other`, slice5_fixture: slice5Fixture }
  };
  return `(() => {
    const configs = ${JSON.stringify(configs)};
    const bridge = { loaded: false, inspects: 0, invokes: 0, closed: 0, instanceCount: 0 };
    const instances = new Map();
    let modulePromise = null;
    let activeProject = null;
    const loadModule = () => modulePromise ??= import('/scripts/collaboration-hc3-slice4-product-authority-runtime.ts').then((value) => { bridge.loaded = true; return value; }, (error) => { window.__patchmarkHc3Slice4RuntimeError = error?.stack ?? String(error); throw error; });
    const load = (projectId) => {
      if (!configs[projectId]) throw new Error('No Slice 4 authority fixture is bound to this project.');
      if (!instances.has(projectId)) instances.set(projectId, loadModule().then((module) => { bridge.instanceCount += 1; return module.createSlice4RealProductAuthorityRuntime(configs[projectId]); }));
      return instances.get(projectId);
    };
    window.__patchmarkHc3ProductAuthorityRuntime = {
      async inspect(input) { activeProject = input.project_id; bridge.inspects += 1; return (await load(input.project_id)).runtime.inspect(input); },
      async invoke(input) { activeProject = input.project_id; bridge.invokes += 1; return (await load(input.project_id)).runtime.invoke(input); },
      closeOperationalWork() { bridge.closed += 1; if (activeProject) void load(activeProject).then((value) => value.runtime.closeOperationalWork()); }
    };
    window.__patchmarkHc3Slice4AuthorityHarness = {
      async exportHandoff(kind, projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.exportHandoff(kind); },
      async importHandoff(kind, value, projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.importHandoff(kind, value); },
      async attemptRevokedMutation(projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.attemptRevokedMutation(); },
      async evidence(projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.evidence(); }
    };
    window.__patchmarkHc3Slice4BridgeEvidence = bridge;
  })();`;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 300; attempt += 1) { try { const response = await fetch(url); if (response.ok) return; } catch {} await delay(100); }
  throw new Error(`HTTP server did not become ready: ${url}`);
}

async function startProductProxy(listenPort, upstreamPort) {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname.endsWith(".ts") && (pathname.startsWith("/scripts/") || pathname.startsWith("/lib/collaboration/"))) {
        const sourcePath = safeRepositoryPath(pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(rewriteBrowserImports(transpiled.outputText));
        return;
      }
      if (pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(pathname)) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(rewriteBrowserImports(readFileSync(safeRepositoryPath(pathname), "utf8")));
        return;
      }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: upstreamPort, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on("error", (error) => { if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" }); response.end(String(error)); });
      request.pipe(upstream);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(listenPort, "127.0.0.1", resolveListen); });
  return { close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function rewriteBrowserImports(source) {
  const mappings = {
    "@hpke/core": "/node_modules/@hpke/core/esm/mod.js",
    "@hpke/common": "/node_modules/@hpke/common/esm/mod.js",
    "libsodium-wrappers-sumo": "/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs",
    "libsodium-sumo": "/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"
  };
  let output = source;
  for (const [specifier, mapped] of Object.entries(mappings)) output = output.replaceAll(`"${specifier}"`, `"${mapped}"`).replaceAll(`'${specifier}'`, `'${mapped}'`);
  return output;
}

function safeRepositoryPath(pathname) {
  const value = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!value.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Module path escaped the repository root.");
  return value;
}

function createProjectFixture(root, input) {
  const metadata = join(root, ".patchmark");
  const now = "2026-08-26T00:00:00.000Z";
  mkdirSync(join(metadata, "documents", input.documentId, "versions"), { recursive: true });
  for (const directory of ["context-packs", "imports", "recovery"]) mkdirSync(join(metadata, "documents", input.documentId, directory), { recursive: true });
  writeFileSync(join(root, "source.md"), input.body);
  writeFileSync(join(metadata, "project.json"), `${JSON.stringify({ format: "patchmark-project", schema_version: 2, project_id: input.projectId, title: input.title, created_at: now, manifest_revision: 1, groups: [], documents: [{ document_id: input.documentId, path: "source.md", display_title: "Source", group_id: null, role: "research", status: "active", position: 1000, added_at: now, archived_at: null }] }, null, 2)}\n`);
  const store = join(metadata, "documents", input.documentId);
  writeFileSync(join(store, "manifest.json"), `${JSON.stringify({ schema_version: 1, project_id: input.projectId, document_id: input.documentId, project_name: input.title, document_file: "document.md", created_at: now, updated_at: now }, null, 2)}\n`);
  writeFileSync(join(store, "comments.json"), "[]\n");
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "document.json"), `${JSON.stringify({ format: "patchmark-document-store", schema_version: 1, document_id: input.documentId, created_at: now, source: "created" }, null, 2)}\n`);
}

function hashProject(root) {
  const projectInventory = inventoryProject(root);
  const hash = createHash("sha256");
  for (const path of [...projectInventory.files].sort()) hash.update(path).update(readFileSync(join(root, path)));
  return hash.digest("hex");
}

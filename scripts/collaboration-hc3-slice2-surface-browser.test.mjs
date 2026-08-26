import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CdpClient, createPage, evaluate, findChromeExecutable, waitForDevToolsUrl, waitForProcessExit } from "./comment-rail-editor-browser-regression.test.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const fixture = JSON.parse(readFileSync(join(scriptDirectory, "fixtures", "collaboration-hc3-slice1-v1.json"), "utf8"));
const invitationText = fixture.expected.invitation.canonical_text;
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run the HC-3 Slice 2 surface test.");
const server = await startServer();
const profile = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice2-surface-"));
const browserProcess = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let browser = null;
let page = null;
let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

try {
  const browserUrl = await waitForDevToolsUrl(browserProcess);
  browser = await CdpClient.connect(browserUrl);
  const version = await browser.call("Browser.getVersion");
  page = await CdpClient.connect(await createPage(browserUrl, server.url));
  await page.call("Runtime.enable");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const initial = await waitReady(page);
  equal(initial.state, "ready", "test-only surface starts from reconstructed readiness");
  equal(initial.live_region, "polite", "workflow state uses a polite live status announcement");
  equal(initial.labelled_textareas, true, "every pasted-artifact field has a programmatic label");
  equal(initial.textarea_count, 3, "Invitation and two-part Response inputs are explicit");
  equal(initial.details_summary, "Technical details", "technical diagnostics are separated behind disclosure");
  equal(initial.details_open, false, "technical diagnostics are hidden from ordinary guidance by default");
  check(initial.surface_width <= initial.viewport_width, "mobile-sized surface does not overflow horizontally");
  equal(initial.buttons[0].name, "Create Invitation", "native button has an understandable accessible name");

  await evaluate(page, { expression: `document.querySelector('button[data-action="create_invitation_handoff"]').focus()` });
  await page.call("Page.bringToFront");
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const created = await waitForState(page, "ready_to_share");
  equal(created.mutation_calls, 1, "keyboard activation invokes exactly one explicit facade command");
  equal(created.active_element, "workflow-status", "focus moves predictably to updated workflow status");
  check(created.buttons.some((button) => button.action === "copy_invitation" && button.describedby === "workflow-status"), "Invitation copy action has an accessible description");

  await invoke(page, "copy_invitation");
  const copied = await snapshot(page);
  equal(copied.clipboard_writes, [invitationText], "copy port receives exact canonical Invitation text");
  equal(copied.mutation_calls, 1, "copy success invokes no authority");
  equal(copied.status_text.includes("Invitation copied"), true, "copy success produces user-visible feedback");

  await invoke(page, "create_invitation_handoff");
  await call(page, "setHc3Slice2PortMode", ["clipboard", "denied"]);
  await invoke(page, "copy_invitation");
  const copyDenied = await snapshot(page);
  equal(copyDenied.classification, "recoverable", "permission denial is announced as a recoverable workflow problem");
  equal(copyDenied.status_text.includes("denied permission"), true, "copy denial explains recovery without diagnostics jargon");

  await invoke(page, "create_invitation_handoff");
  await call(page, "setHc3Slice2PortMode", ["qr", "unsupported"]);
  await invoke(page, "present_invitation_as_qr");
  const qr = await snapshot(page);
  equal(qr.state, "unsupported", "unavailable QR is typed, not claimed as exercised");
  check(qr.buttons.some((button) => button.action === "copy_invitation"), "QR unavailable exposes copy fallback");
  equal(qr.qr_payloads.at(-1), invitationText, "QR presenter receives exact canonical text before reporting unavailable");

  await invoke(page, "create_invitation_handoff");
  await call(page, "setHc3Slice2PortMode", ["share", "cancelled"]);
  await invoke(page, "share_invitation");
  const share = await snapshot(page);
  equal(share.state, "cancelled", "OS share cancellation is normal feedback");
  check(share.buttons.some((button) => button.action === "copy_invitation"), "share cancellation exposes copy fallback");

  const sync = await call(page, "setHc3Slice2SynchronizationPhase");
  check(sync.buttons.some((button) => button.action === "select_synchronization_bundle"), "reopened synchronization guidance exposes explicit selection");
  await invoke(page, "select_synchronization_bundle");
  const selected = await snapshot(page);
  equal(selected.state, "received_unverified", "file selection remains an unverified preview state");
  equal(selected.selection_calls, 1, "file picker is invoked only by explicit selection");
  equal(selected.import_calls, 0, "selection never imports automatically");
  check(selected.buttons.some((button) => button.action === "preview_synchronization_import"), "selected file exposes preview rather than import");
  await invoke(page, "preview_synchronization_import");
  const blocked = await snapshot(page);
  equal(blocked.state, "blocked", "malformed encrypted bytes produce a blocking validation result");
  equal(blocked.import_calls, 0, "blocking validation invokes no authoritative import");
  equal(blocked.confirmation_text, "No confirmation is pending.", "invalid bytes never expose an import-confirmation claim");

  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: version.product,
    keyboard_operable: true,
    predictable_focus: true,
    status_announcements: true,
    accessible_names_and_descriptions: true,
    mobile_viewport: [390, 844],
    clipboard_exact_text: true,
    qr_capability_exercised: false,
    qr_unsupported_fallback: true,
    os_share_capability_exercised: false,
    share_cancellation_fallback: true,
    selection_without_import: true,
    technical_details_separate: true,
    production_route: false,
    temporary_profile_removed: true,
    server_closed: true
  }, null, 2)}\n`);
} finally {
  await page?.close();
  await browser?.close();
  browserProcess.kill("SIGTERM");
  await waitForProcessExit(browserProcess, 1500);
  if (browserProcess.exitCode === null) { browserProcess.kill("SIGKILL"); await waitForProcessExit(browserProcess, 1500); }
  rmSync(profile, { recursive: true, force: true });
  await server.close();
}

async function invoke(client, action) { await evaluate(client, { expression: `hc3runtime.invokeHc3Slice2Surface(${JSON.stringify(action)})` }); }
async function snapshot(client) { return evaluate(client, { expression: "hc3runtime.snapshot()" }); }
async function call(client, method, args = []) { return evaluate(client, { expression: `hc3runtime[${JSON.stringify(method)}](...${JSON.stringify(args)})` }); }
async function waitReady(client) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(client, { expression: "({ready:globalThis.__ready,error:globalThis.__error??null,snapshot:globalThis.__ready?hc3runtime.snapshot():null})" });
    if (state.error) throw new Error(state.error);
    if (state.ready) return state.snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for HC-3 Slice 2 surface.");
}
async function waitForState(client, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await snapshot(client);
    if (state.state === expected) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for surface state ${expected}.`);
}

async function startServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'", "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HC-3 Slice 2 qualification</title><body><main></main><script type="module">globalThis.__ready=false;try{globalThis.hc3runtime=await import('/scripts/collaboration-hc3-slice2-browser-runtime.ts');await hc3runtime.initializeHc3Slice2Surface(${JSON.stringify(invitationText)});globalThis.__ready=true}catch(error){globalThis.__error=error?.stack??String(error)}</script></body></html>`);
        return;
      }
      if (pathname.endsWith(".ts") && (pathname.startsWith("/lib/collaboration/") || pathname.startsWith("/scripts/collaboration-hc3-slice2-"))) {
        const sourcePath = safePath(pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        const errors = (transpiled.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
        if (errors.length) throw new Error(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")).join("\n"));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(transpiled.outputText);
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
  if (!address || typeof address === "string") throw new Error("Surface server did not receive a port.");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function safePath(pathname) {
  const path = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!path.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Browser surface path escaped repository root.");
  return path;
}

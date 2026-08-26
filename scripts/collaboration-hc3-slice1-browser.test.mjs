import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createHc3Slice1VectorActual } from "./collaboration-hc3-slice1-vector-runtime.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const vectorPath = join(repositoryRoot, "scripts", "fixtures", "collaboration-hc3-slice1-v1.json");
const vectors = JSON.parse(readFileSync(vectorPath, "utf8"));
const expected = await createHc3Slice1VectorActual(vectors);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-3 vectors.");

const harness = await startHarnessServer();
const profile = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice1-chrome-"));
const chrome = spawn(chromePath, [
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
  const browserWebSocketUrl = await waitForDevToolsUrl(chrome);
  browserClient = await CdpClient.connect(browserWebSocketUrl);
  const browserVersion = await browserClient.call("Browser.getVersion");
  const pageWebSocketUrl = await createPage(browserWebSocketUrl, harness.url);
  pageClient = await CdpClient.connect(pageWebSocketUrl);
  await pageClient.call("Runtime.enable");
  await pageClient.call("Page.enable");
  const outcome = await waitForOutcome(pageClient);
  assert.equal(outcome.status, "passed", outcome.error ?? "Browser HC-3 vectors failed.");
  assert.deepEqual(outcome.result, expected);
  assert.deepEqual(outcome.result, vectors.expected);
  process.stdout.write(`${JSON.stringify({
    browser: browserVersion.product,
    javascript: browserVersion.jsVersion,
    node_python_chrome_equivalence: true,
    canonical_carriers: Object.keys(vectors.expected).length,
    invitation_text_characters: vectors.expected.invitation.text_characters,
    offer_text_characters: vectors.expected.connection_offer.text_characters,
    answer_text_characters: vectors.expected.connection_answer.text_characters,
    temporary_profile_removed: true,
    production_imports_added: false
  }, null, 2)}\n`);
} finally {
  await pageClient?.close();
  await browserClient?.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 1000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 1000);
  }
  await harness.close();
  rmSync(profile, { force: true, recursive: true });
}

async function waitForOutcome(client) {
  let latest = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await evaluate(client, { expression: "globalThis.__patchmarkHc3Slice1Outcome ?? null" });
    if (latest?.status === "passed" || latest?.status === "failed") return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for browser HC-3 vectors: ${JSON.stringify(latest)}`);
}

async function startHarnessServer() {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        response.end(harnessHtml());
        return;
      }
      if (requestUrl.pathname === "/vectors.json") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        response.end(readFileSync(vectorPath));
        return;
      }
      if (isAllowedTypeScriptPath(requestUrl.pathname)) {
        const sourcePath = resolve(repositoryRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
        if (!sourcePath.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Harness path escaped the repository root.");
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
          reportDiagnostics: true
        });
        const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
        if (errors.length > 0) throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(transpiled.outputText);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser harness did not receive a loopback address.");
  return Object.freeze({
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
    url: `http://127.0.0.1:${address.port}/`
  });
}

function isAllowedTypeScriptPath(pathname) {
  return pathname === "/scripts/collaboration-hc3-slice1-vector-runtime.ts" ||
    pathname.startsWith("/lib/collaboration/") && pathname.endsWith(".ts");
}

function harnessHtml() {
  return `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>Patchmark HC-3 Slice 1 vectors</title>
  <body>
    <script type="module">
      globalThis.__patchmarkHc3Slice1Outcome = { status: "running" };
      try {
        const { createHc3Slice1VectorActual } = await import("/scripts/collaboration-hc3-slice1-vector-runtime.ts");
        const response = await fetch("/vectors.json", { cache: "no-store" });
        if (!response.ok) throw new Error("Vector fetch failed with " + response.status + ".");
        const result = await createHc3Slice1VectorActual(await response.json());
        globalThis.__patchmarkHc3Slice1Outcome = { status: "passed", result };
      } catch (error) {
        globalThis.__patchmarkHc3Slice1Outcome = { status: "failed", error: error instanceof Error ? error.stack : String(error) };
      }
    </script>
  </body>
</html>`;
}

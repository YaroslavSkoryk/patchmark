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
import { evaluateCollaborationRootVectors } from "./collaboration-root-vector-runtime.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const vectorPath = join(repositoryRoot, "scripts", "fixtures", "collaboration-roots-v1.json");
const vectors = JSON.parse(readFileSync(vectorPath, "utf8"));
const expected = await evaluateCollaborationRootVectors(vectors);
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run root vectors.");
}

const harness = await startHarnessServer();
const userDataDirectory = mkdtempSync(join(tmpdir(), "patchmark-hc-roots-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDirectory}`,
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
  const outcome = await waitForHarnessOutcome(pageClient);
  assert.equal(outcome.status, "passed", outcome.error ?? "Browser root vectors failed.");
  assert.deepEqual(outcome.result, expected);
  process.stdout.write(`${JSON.stringify({
    browser: browserVersion.product,
    javascript: browserVersion.jsVersion,
    protocol: browserVersion.protocolVersion,
    node_chrome_byte_equivalence: true,
    vectors: outcome.result,
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
  rmSync(userDataDirectory, { force: true, recursive: true });
}

async function waitForHarnessOutcome(client) {
  let latest = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await evaluate(client, {
      expression: "globalThis.__patchmarkCollaborationRootOutcome ?? null"
    });
    if (latest?.status === "passed" || latest?.status === "failed") return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for browser root vectors: ${JSON.stringify(latest)}`);
}

async function startHarnessServer() {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8"
        });
        response.end(harnessHtml());
        return;
      }
      if (requestUrl.pathname === "/vectors.json") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8"
        });
        response.end(readFileSync(vectorPath));
        return;
      }
      if (isAllowedTypeScriptPath(requestUrl.pathname)) {
        const sourcePath = resolve(repositoryRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
        if (!sourcePath.startsWith(`${repositoryRoot}${sep}`)) {
          throw new Error("Harness path escaped the repository root.");
        }
        const source = readFileSync(sourcePath, "utf8");
        const transpiled = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
          reportDiagnostics: true
        });
        const errors = (transpiled.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
        );
        if (errors.length > 0) {
          throw new Error(errors.map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
          ).join("\n"));
        }
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8"
        });
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
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Browser root harness did not receive a loopback address.");
  }
  return Object.freeze({
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
    url: `http://127.0.0.1:${address.port}/`
  });
}

function isAllowedTypeScriptPath(pathname) {
  return pathname === "/scripts/collaboration-root-vector-runtime.ts" ||
    pathname.startsWith("/lib/collaboration/") && pathname.endsWith(".ts");
}

function harnessHtml() {
  return `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>Patchmark collaboration root vectors</title>
  <body>
    <p>Running isolated collaboration root vectors.</p>
    <script type="module">
      globalThis.__patchmarkCollaborationRootOutcome = { status: "running" };
      try {
        const { evaluateCollaborationRootVectors } = await import(
          "/scripts/collaboration-root-vector-runtime.ts"
        );
        const response = await fetch("/vectors.json", { cache: "no-store" });
        if (!response.ok) throw new Error("Vector fetch failed with " + response.status + ".");
        const result = await evaluateCollaborationRootVectors(await response.json());
        globalThis.__patchmarkCollaborationRootOutcome = { status: "passed", result };
      } catch (error) {
        globalThis.__patchmarkCollaborationRootOutcome = {
          status: "failed",
          error: error instanceof Error ? error.stack : String(error)
        };
      }
    </script>
  </body>
</html>`;
}

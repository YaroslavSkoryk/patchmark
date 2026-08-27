import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOptimizedHarness, optimizedHarnessOutput } from "./collaboration-hc3-slice5-optimized-build.mjs";
import {
  createEvidenceSessionId,
  externalQualificationBootstrapSource,
  sha256File
} from "./lib/collaboration-hc3-slice6-evidence.mjs";
import {
  instrumentPolicyHtml,
  optimizedCollaborationPolicy
} from "./lib/collaboration-hc3-slice5-policy.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export const slice6ExternalRunnerMarker = "PATCHMARK_HC3_SLICE6_EXTERNAL_RUNNER_TEST_ONLY_V1";

export function externalQualificationFixtureHashes() {
  return Object.freeze(readdirSync(join(scriptDirectory, "fixtures"))
    .filter((name) => /^collaboration-.*\.json$/.test(name) && name !== "collaboration-hc3-slice6-qualification-template.json")
    .sort()
    .map((name) => Object.freeze({ path: `scripts/fixtures/${name}`, sha256: sha256File(join(scriptDirectory, "fixtures", name)) })));
}

export async function startExternalQualificationServer(input = {}) {
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? 3140;
  if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host)) throw new Error("External qualification host must be loopback or an explicit local-network listener.");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error("External qualification port is invalid.");
  const evidenceSessionId = input.evidence_session_id ?? createEvidenceSessionId();
  const sourceCommit = input.source_commit ?? currentCommit();
  const readinessManifestSha256 = input.readiness_manifest_sha256
    ?? sha256File(join(repositoryRoot, "docs/hc3/readiness-slice6.json"));
  await buildOptimizedHarness();

  const nonce = "patchmark-hc3-slice6-external";
  const policy = optimizedCollaborationPolicy(nonce);
  const assetNames = new Set(readdirSync(optimizedHarnessOutput));
  const fixtureHashes = externalQualificationFixtureHashes();
  const bootstrap = externalQualificationBootstrapSource({
    evidence_session_id: evidenceSessionId,
    source_commit: sourceCommit,
    readiness_manifest_sha256: readinessManifestSha256,
    fixture_hashes: fixtureHashes
  });
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const role = pathname === "/candidate/" ? "candidate" : pathname === "/owner/" || pathname === "/" ? "owner" : null;
      if (role) {
        const html = instrumentPolicyHtml(`<!doctype html><html data-patchmark-qualification-role="${role}" data-patchmark-evidence-session="${evidenceSessionId}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HC-3 external qualification</title><link rel="stylesheet" href="/assets/optimized-harness.css"></head><body><div id="root"></div><script defer src="/assets/optimized-harness.js"></script></body></html>`, nonce, bootstrap);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy": policy.header,
          "Content-Type": "text/html; charset=utf-8",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Patchmark-Qualification": slice6ExternalRunnerMarker
        });
        response.end(html);
        return;
      }
      if (pathname === "/qualification-metadata.json") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        response.end(`${JSON.stringify({
          authority: "none",
          evidence_session_id: evidenceSessionId,
          source_commit: sourceCommit,
          fixture_hashes: fixtureHashes,
          production_route: false,
          upload: false,
          signaling: false,
          telemetry: false
        }, null, 2)}\n`);
        return;
      }
      if (pathname.startsWith("/assets/")) {
        const asset = pathname.slice("/assets/".length);
        if (!assetNames.has(asset) || asset.includes("/") || asset.includes("..")) {
          response.writeHead(404).end();
          return;
        }
        const assetPath = join(optimizedHarnessOutput, asset);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": statSync(assetPath).size,
          "Content-Type": asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(readFileSync(assetPath));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "External qualification runner failure.");
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  return Object.freeze({
    authority: "none",
    evidence_session_id: evidenceSessionId,
    source_commit: sourceCommit,
    host,
    port,
    owner_path: "/owner/",
    candidate_path: "/candidate/",
    fixture_hashes: fixtureHashes,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.closeAllConnections?.();
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  });
}

function currentCommit() {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Unable to identify the reviewed source commit.");
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf("--port");
  const hostIndex = process.argv.indexOf("--host");
  const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : "127.0.0.1";
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3140;
  const runner = await startExternalQualificationServer({ host, port });
  process.stdout.write(`${JSON.stringify({
    marker: slice6ExternalRunnerMarker,
    authority: runner.authority,
    evidence_session_id: runner.evidence_session_id,
    owner_url: `http://${host}:${port}${runner.owner_path}`,
    candidate_url: `http://${host}:${port}${runner.candidate_path}`,
    fixture_hashes: runner.fixture_hashes,
    instructions: [
      "Use only synthetic qualification projects.",
      "Run owner and candidate in isolated browser profiles.",
      "Never expose this listener beyond a user-controlled local network.",
      "Press Ctrl-C, delete downloaded evidence and synthetic profiles, and confirm cleanup when finished."
    ]
  }, null, 2)}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await runner.close(); process.exit(0); });
}

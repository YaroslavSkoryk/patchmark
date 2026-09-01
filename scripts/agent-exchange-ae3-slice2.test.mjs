import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  probeExistingConnector,
  startUserLaunchedConnector
} from "../local-connector/application.ts";
import { isCodexProviderFailureDiagnostic } from "../local-connector/codex-exec-adapter.ts";
import { discoverCodexExecutable } from "../local-connector/codex-discovery.ts";
import {
  LOCAL_CONNECTOR_DEFAULT_PORT,
  LOCAL_CONNECTOR_ID,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LOCAL_CONNECTOR_VERSION,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS
} from "../lib/agent-exchange/local-connector-protocol.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodex = join(root, "scripts/fixtures/agent-exchange/fake-codex.mjs");
const origin = "http://127.0.0.1:3120";
const checks = [];
const temporaryRoot = await mkdtemp(join(tmpdir(), "patchmark-ae3-slice2-"));

try {
  await qualifyDiscovery();
  await qualifySourceLifecycle();
  await qualifyPackage();
  assert.deepEqual([...PUBLICLY_SUPPORTED_CODEX_VERSIONS], ["0.151.0"]);
  assert.equal(LOCAL_CONNECTOR_VERSION, "0.1.0");
  checks.push("connector and exact Codex versions are frozen independently");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

process.stdout.write(`${JSON.stringify({ checks, status: "ok" }, null, 2)}\n`);

async function qualifyDiscovery() {
  const missing = await discoverCodexExecutable({
    candidates: [join(temporaryRoot, "missing-codex")]
  });
  assert.equal(missing.compatibility, "unavailable");
  assert.equal(missing.executable, null);

  const inaccessible = join(temporaryRoot, "inaccessible-codex");
  await writeFile(inaccessible, "not executable\n", { mode: 0o600 });
  const inaccessibleResult = await discoverCodexExecutable({
    candidates: [inaccessible]
  });
  assert.equal(inaccessibleResult.inspections[0]?.compatibility, "inaccessible");

  const multiple = await discoverCodexExecutable({
    candidates: [fakeCodex, "/Applications/ChatGPT.app/Contents/Resources/codex"],
    createAdapter(executable) {
      return {
        async inspectCompatibility() {
          return executable === fakeCodex
            ? { codex_version: "0.152.0", compatibility: "unsupported" }
            : { codex_version: "0.151.0", compatibility: "supported" };
        }
      };
    }
  });
  assert.equal(multiple.executable, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(multiple.version, "0.151.0");
  assert.equal(multiple.candidates_found, 2);

  const fakeOutput = await discoverCodexExecutable({
    candidates: [fakeCodex],
    createAdapter() {
      return {
        async inspectCompatibility() {
          return { codex_version: null, compatibility: "unsupported" };
        }
      };
    }
  });
  assert.equal(fakeOutput.compatibility, "unavailable");
  assert.equal(fakeOutput.inspections[0]?.compatibility, "invalid");
  checks.push("fixed discovery fails closed for missing, inaccessible, fake, changed, and multiple installs");
}

async function qualifySourceLifecycle() {
  const port = await unusedPort();
  const firstOutput = [];
  const first = await startUserLaunchedConnector(
    { allowInsecureLoopbackOrigin: true, allowedOrigin: origin },
    { candidates: [fakeCodex], onOutput: (line) => firstOutput.push(line), port }
  );
  assert.equal(first.kind, "running");
  assert.equal(firstOutput.some((line) => line.includes("Patchmark pairing code:")), true);
  assert.equal(firstOutput.some((line) => line.includes("Press Ctrl+C to quit")), true);
  assert.equal(firstOutput.some((line) => line.includes(fakeCodex)), false);

  const secondOutput = [];
  const second = await startUserLaunchedConnector(
    { allowInsecureLoopbackOrigin: true, allowedOrigin: origin },
    { candidates: [fakeCodex], onOutput: (line) => secondOutput.push(line), port }
  );
  assert.equal(second.kind, "already_running");
  assert.equal(secondOutput.some((line) => line.includes("already running")), true);
  assert.equal(secondOutput.some((line) => line.includes("pairing code:")), false);
  assert.equal(await probeExistingConnector({ allowedOrigin: origin, port }), true);
  await first.value.connector.stop();

  const unrelated = createServer((_request, response) => {
    response.statusCode = 200;
    response.end("not Patchmark");
  });
  await listen(unrelated, port);
  await assert.rejects(
    startUserLaunchedConnector(
      { allowInsecureLoopbackOrigin: true, allowedOrigin: origin },
      { candidates: [fakeCodex], port }
    ),
    /in use by another application/
  );
  assert.equal(unrelated.listening, true);
  await close(unrelated);
  checks.push("single-instance reuse and unrelated-listener refusal are explicit and non-destructive");
}

async function qualifyPackage() {
  const firstOutput = join(temporaryRoot, "package-one");
  const secondOutput = join(temporaryRoot, "package-two");
  await mkdir(firstOutput);
  await mkdir(secondOutput);
  const firstBuild = await buildPackage(firstOutput);
  const secondBuild = await buildPackage(secondOutput);
  assert.equal(firstBuild.sha256, secondBuild.sha256);
  assert.equal(firstBuild.size_bytes, secondBuild.size_bytes);

  const packageDirectory = firstBuild.package_directory;
  const packagedFiles = await listFiles(packageDirectory);
  const relativeFiles = packagedFiles.map((path) => relative(packageDirectory, path));
  assert.deepEqual(relativeFiles, [
    "Patchmark Connector.command",
    "README.txt",
    "THIRD_PARTY_NOTICES.txt",
    "app/connector.js",
    "package-manifest.json",
    "runtime/bun"
  ]);
  assert.equal(relativeFiles.some((path) => /(?:^|\/)(?:node_modules|src)(?:\/|$)/.test(path)), false);
  assert.equal(relativeFiles.some((path) => /\.(?:map|ts|tsx)$/.test(path)), false);

  const appBytes = await readFile(join(packageDirectory, "app/connector.js"));
  assert.equal(appBytes.includes(Buffer.from(root)), false);
  assert.equal(appBytes.includes(Buffer.from("PATCHMARK_FAKE")), false);
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package-manifest.json"), "utf8"));
  assert.equal(manifest.connector.id, LOCAL_CONNECTOR_ID);
  assert.equal(manifest.connector.version, LOCAL_CONNECTOR_VERSION);
  assert.equal(manifest.protocol_version, LOCAL_CONNECTOR_PROTOCOL_VERSION);
  assert.deepEqual(manifest.supported_codex_versions, ["0.151.0"]);
  assert.equal(manifest.qualification_diagnostics, true);
  assert.equal(manifest.signature_status, "unsigned");
  for (const entry of manifest.files) {
    const path = join(packageDirectory, entry.path);
    assert.equal((await stat(path)).size, entry.size_bytes);
    assert.equal(await sha256(path), entry.sha256);
  }
  const runtimeLinks = await runCapture("/usr/bin/otool", [
    "-L",
    join(packageDirectory, "runtime/bun")
  ]);
  assert.doesNotMatch(runtimeLinks.stdout, /\/opt\/homebrew|\/Users\//);
  checks.push("package structure is self-contained, content-clean, hashed, and byte-reproducible");

  const home = join(temporaryRoot, "package-home");
  const installedCodex = join(home, ".local/bin/codex");
  await mkdir(dirname(installedCodex), { recursive: true });
  await writeFile(installedCodex, portableFakeCodex("0.151.0"), { mode: 0o755 });
  await chmod(installedCodex, 0o755);
  const launcher = join(packageDirectory, "Patchmark Connector.command");
  const first = launch(launcher, home);
  const firstPairingCode = await first.waitFor(/Patchmark pairing code: ([A-Za-z0-9_-]{43})/);
  await first.waitFor(/Detected Codex: 0\.151\.0 — supported/);
  const status = await jsonRequest({ method: "GET", path: "/v1/status" });
  assert.equal(status.status, 200);
  assert.equal(status.json.connector_id, LOCAL_CONNECTOR_ID);
  assert.equal(status.json.connector_version, LOCAL_CONNECTOR_VERSION);
  assert.deepEqual(status.json.supported_codex_versions, ["0.151.0"]);

  const paired = await jsonRequest({
    body: {
      pairing_code: firstPairingCode[1],
      protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
    },
    method: "POST",
    path: "/v1/pair"
  });
  assert.equal(paired.status, 200);
  const requestBytes = Buffer.from("packaged fake-provider smoke\n", "utf8");
  const exchange = await jsonRequest({
    body: {
      expected_response_protocol: "patchmark.comment_reply_import",
      expected_response_protocol_version: 2,
      max_response_bytes: 4096,
      operation_id: "ae3_slice2_packaged_fake",
      protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
      request_base64: requestBytes.toString("base64"),
      request_byte_length: requestBytes.byteLength,
      request_sha256: createHash("sha256").update(requestBytes).digest("hex")
    },
    method: "POST",
    path: "/v1/exchanges",
    token: paired.json.session_token
  });
  assert.equal(exchange.status, 200);

  await writeFile(
    installedCodex,
    portableFakeCodex("0.151.0", "matching-provider-failure"),
    { mode: 0o755 }
  );
  await chmod(installedCodex, 0o755);
  const failure = await jsonRequest({
    body: {
      expected_response_protocol: "patchmark.comment_reply_import",
      expected_response_protocol_version: 2,
      max_response_bytes: 4096,
      operation_id: "ae3_slice2_packaged_fake_failure",
      protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
      request_base64: requestBytes.toString("base64"),
      request_byte_length: requestBytes.byteLength,
      request_sha256: createHash("sha256").update(requestBytes).digest("hex")
    },
    method: "POST",
    path: "/v1/exchanges",
    token: paired.json.session_token
  });
  assert.equal(failure.status, 502);
  assert.deepEqual(failure.json, {
    error: { code: "provider_failed" },
    protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
  });
  const diagnostic = JSON.parse(
    Buffer.from(
      failure.headers["x-patchmark-qualification-diagnostic"],
      "base64url"
    ).toString("utf8")
  );
  assert.equal(isCodexProviderFailureDiagnostic(diagnostic), true);
  assert.equal(diagnostic.failure_source, "turn_failed");
  assert.equal(diagnostic.top_level_error_seen, true);
  assert.equal(diagnostic.turn_failed_seen, true);
  assert.equal(diagnostic.error_message_fingerprints_match, true);
  assert.equal(JSON.stringify(failure).includes("synthetic packaged failure"), false);

  const duplicate = launch(launcher, home);
  await duplicate.waitFor(/already running/);
  assert.equal((await duplicate.exited()).code, 0);
  assert.doesNotMatch(duplicate.output(), /Patchmark pairing code:/);
  first.child.kill("SIGTERM");
  assert.equal((await first.exited()).code, 0);
  await waitForPortClosed();

  const crashed = launch(launcher, home);
  const crashPairingCode = await crashed.waitFor(/Patchmark pairing code: ([A-Za-z0-9_-]{43})/);
  crashed.child.kill("SIGKILL");
  assert.equal((await crashed.exited()).signal, "SIGKILL");
  await waitForPortClosed();
  const relaunched = launch(launcher, home);
  const relaunchPairingCode = await relaunched.waitFor(/Patchmark pairing code: ([A-Za-z0-9_-]{43})/);
  assert.notEqual(crashPairingCode[1], relaunchPairingCode[1]);
  relaunched.child.kill("SIGINT");
  assert.equal((await relaunched.exited()).code, 0);
  await waitForPortClosed();

  await writeFile(installedCodex, portableFakeCodex("0.152.0"), { mode: 0o755 });
  await chmod(installedCodex, 0o755);
  const changed = launch(launcher, home);
  await changed.waitFor(/Detected Codex: 0\.152\.0 — unsupported/);
  const changedStatus = await jsonRequest({ method: "GET", path: "/v1/status" });
  assert.equal(changedStatus.json.compatibility, "unsupported");
  changed.child.kill("SIGTERM");
  await changed.exited();
  await waitForPortClosed();
  checks.push("the packaged runtime launches without Node/npm/Bun, exchanges, stops, crashes, relaunches, and rejects changed Codex");
}

async function buildPackage(output) {
  const result = await runCapture(process.execPath, [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    join(root, "scripts/package-agent-exchange-connector.mjs"),
    "--output",
    output,
    "--allow-origin",
    origin,
    "--qualification-loopback"
  ]);
  const match = /\{\n  "archive":[\s\S]+\n\}/.exec(result.stdout);
  assert.ok(match, result.stdout);
  return JSON.parse(match[0]);
}

function portableFakeCodex(version, scenario = "success") {
  const result = scenario === "matching-provider-failure"
    ? `printf '%s\\n' '{"type":"thread.started","thread_id":"packaged-fake"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"message":"synthetic packaged failure","type":"error"}'
printf '%s\\n' '{"error":{"message":"synthetic packaged failure"},"type":"turn.failed"}'
exit 9`
    : `printf '%s\\n' '{"type":"thread.started","thread_id":"packaged-fake"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"item":{"id":"reasoning","text":"synthetic reasoning","type":"reasoning"},"type":"item.completed"}'
printf '%s\\n' '{"item":{"id":"plan","items":[],"type":"todo_list"},"type":"item.started"}'
printf '%s\\n' '{"item":{"id":"plan","items":[],"type":"todo_list"},"type":"item.updated"}'
printf '%s\\n' '{"item":{"id":"plan","items":[],"type":"todo_list"},"type":"item.completed"}'
printf '%s\\n' '{"item":{"id":"message","text":"{}","type":"agent_message"},"type":"item.completed"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}'`;
  return `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'codex-cli ${version}\\n'
  exit 0
fi
while IFS= read -r ignored; do :; done
${result}
`;
}

function launch(launcher, home) {
  const child = spawn(launcher, [], {
    cwd: temporaryRoot,
    env: {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: temporaryRoot
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return {
    child,
    exited: () => new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit({ code: child.exitCode, signal: child.signalCode });
      } else {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }
    }),
    output: () => output,
    waitFor: async (pattern) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const match = pattern.exec(output);
        if (match) return match;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      throw new Error(`Timed out waiting for ${pattern}; output: ${output}`);
    }
  };
}

function jsonRequest({ body, method, path, token }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: "application/json", Origin: origin };
    if (bytes) {
      headers["Content-Length"] = String(bytes.byteLength);
      headers["Content-Type"] = "application/json";
    }
    if (token) headers.Authorization = `Patchmark ${token}`;
    const outgoing = request(
      {
        headers,
        host: "127.0.0.1",
        method,
        path,
        port: LOCAL_CONNECTOR_DEFAULT_PORT
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            headers: response.headers,
            json: text ? JSON.parse(text) : null,
            status: response.statusCode
          });
        });
      }
    );
    outgoing.once("error", rejectRequest);
    if (bytes) outgoing.write(bytes);
    outgoing.end();
  });
}

async function waitForPortClosed() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await jsonRequest({ method: "GET", path: "/v1/status" });
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Port ${LOCAL_CONNECTOR_DEFAULT_PORT} did not close.`);
}

async function unusedPort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await close(server);
  return port;
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port }, resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runCapture(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`${executable} failed (${code ?? signal}): ${stderr}`));
    });
  });
}

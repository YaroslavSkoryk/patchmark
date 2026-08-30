import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CODEX_EXEC_FIXED_ARGUMENTS,
  CodexAdapterError,
  CodexExecAdapter,
  createCodexEnvironment,
  extractFinalAgentMessage
} from "../local-connector/codex-exec-adapter.ts";
import { createPatchmarkLocalConnector } from "../local-connector/server.ts";
import { LocalCodexConnectorSession } from "../lib/agent-exchange/local-codex-connector.ts";
import {
  LOCAL_CONNECTOR_MAX_REQUEST_BYTES,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LocalConnectorError
} from "../lib/agent-exchange/local-connector-protocol.ts";
import { AgentExchangeOperationController } from "../lib/agent-exchange/operation-controller.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const fakeCodex = join(
  root,
  "scripts/fixtures/agent-exchange/fake-codex.mjs"
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "patchmark-agent-exchange-ae2-slice2-")
);
const assertions = [];
const check = (condition, message) => {
  assertions.push(message);
  assert.ok(condition, message);
};

try {
  await qualifyCodexAdapter();
  await qualifyHttpSecurityAndLifecycle();
  await qualifyBrowserConnectorOverRealHttpAndFakeCodex();
  await qualifyTypedProductFailureCause();
  await qualifyStaticBoundary();
  process.stdout.write(
    `${JSON.stringify(
      {
        assertions: assertions.length,
        codex_live_model_calls: 0,
        connector_dependencies_added: 0,
        fixed_arguments: CODEX_EXEC_FIXED_ARGUMENTS.length,
        production_release: {
          agent_exchange: false,
          human_collaboration: false
        },
        status: "ok"
      },
      null,
      2
    )}\n`
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
  assert.equal(existsSync(temporaryRoot), false);
}

async function qualifyCodexAdapter() {
  const capturePath = join(temporaryRoot, "codex-capture.json");
  const responseText = "{\"result\":\"résumé\"}\n";
  const injectionTarget = join(temporaryRoot, "must-not-exist");
  const requestBytes = new TextEncoder().encode(
    `first\r\nsecond\n雪\n$(touch ${injectionTarget}) \`touch ${injectionTarget}\`\n`
  );
  const beforeTemporaryDirectories = exchangeTemporaryDirectories();
  const adapter = createFakeAdapter("success", {
    PATCHMARK_FAKE_CAPTURE_PATH: capturePath,
    PATCHMARK_FAKE_RESPONSE_BASE64: Buffer.from(responseText).toString("base64")
  });
  const response = await adapter.exchange({
    maxResponseBytes: 4096,
    requestBytes,
    signal: new AbortController().signal
  });
  assert.equal(new TextDecoder().decode(response), responseText);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv, CODEX_EXEC_FIXED_ARGUMENTS);
  assert.deepEqual(Buffer.from(capture.stdinBase64, "base64"), Buffer.from(requestBytes));
  assert.equal(existsSync(injectionTarget), false, "canonical content never reaches a shell");
  assert.equal(capture.argv.some((value) => value.includes(injectionTarget)), false);
  check(
    capture.cwd.includes("/patchmark-codex-exchange-"),
    "Codex runs in a fresh connector-owned temporary cwd"
  );
  assert.equal(existsSync(capture.cwd), false, "operation cwd is removed after success");
  assert.deepEqual(exchangeTemporaryDirectories(), beforeTemporaryDirectories);
  check(!capture.environmentKeys.includes("OPENAI_API_KEY"), "provider keys are not forwarded through the filtered environment");
  check(!CODEX_EXEC_FIXED_ARGUMENTS.includes("--output-last-message"), "final output is selected from JSONL instead of an auxiliary file");
  check(!CODEX_EXEC_FIXED_ARGUMENTS.some((value) => value === "-m" || value === "--model"), "the browser cannot select a model");
  for (const required of [
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "read-only",
    "--json",
    "features.shell_tool=false",
    "features.plugins=false",
    'web_search="disabled"'
  ]) {
    check(CODEX_EXEC_FIXED_ARGUMENTS.includes(required), `fixed Codex profile contains ${required}`);
  }

  const multiple = await createFakeAdapter("multiple-final", {
    PATCHMARK_FAKE_RESPONSE_BASE64: Buffer.from("authoritative").toString("base64")
  }).exchange({
    maxResponseBytes: 1024,
    requestBytes: new TextEncoder().encode("request"),
    signal: new AbortController().signal
  });
  assert.equal(new TextDecoder().decode(multiple), "authoritative");
  check(true, "the last completed agent message is authoritative before turn completion");

  for (const [scenario, expectedCode] of [
    ["authentication-required", "authentication_required"],
    ["provider-failed", "provider_failed"],
    ["nonzero", "provider_failed"],
    ["malformed", "connector_protocol_error"],
    ["unknown-critical", "connector_protocol_error"],
    ["missing-final", "connector_protocol_error"],
    ["ambiguous-final", "connector_protocol_error"],
    ["tool-item", "connector_protocol_error"],
    ["stdout-oversized", "response_too_large"],
    ["stderr-oversized", "provider_failed"]
  ]) {
    await assert.rejects(
      createFakeAdapter(scenario).exchange({
        maxResponseBytes: 1024,
        requestBytes: new TextEncoder().encode("untrusted $(touch /tmp/nope) `pwd`"),
        signal: new AbortController().signal
      }),
      (error) => error instanceof CodexAdapterError && error.code === expectedCode,
      `${scenario} must fail as ${expectedCode}`
    );
    check(true, `${scenario} fails closed`);
  }

  const unsupported = createFakeAdapter("success", {
    PATCHMARK_FAKE_CODEX_VERSION: "99.0.0"
  });
  assert.deepEqual(await unsupported.inspectCompatibility(), {
    codex_version: "99.0.0",
    compatibility: "unsupported"
  });
  await assert.rejects(
    unsupported.exchange({
      maxResponseBytes: 1024,
      requestBytes: new Uint8Array([123, 125]),
      signal: new AbortController().signal
    }),
    (error) => error instanceof CodexAdapterError && error.code === "codex_unsupported"
  );
  await assert.rejects(
    adapter.exchange({
      maxResponseBytes: 1024,
      requestBytes: new Uint8Array([0xc3, 0x28]),
      signal: new AbortController().signal
    }),
    (error) => error instanceof CodexAdapterError && error.code === "invalid_request"
  );

  const abortController = new AbortController();
  const hanging = createFakeAdapter("hang", {}, 10_000).exchange({
    maxResponseBytes: 1024,
    requestBytes: new TextEncoder().encode("cancel me"),
    signal: abortController.signal
  });
  await delay(100);
  abortController.abort();
  await assert.rejects(
    hanging,
    (error) => error instanceof CodexAdapterError && error.code === "cancelled"
  );
  await delay(20);
  assert.deepEqual(exchangeTemporaryDirectories(), beforeTemporaryDirectories);
  check(true, "AbortSignal terminates the owned Codex process and removes its cwd");

  const childPidPath = join(temporaryRoot, "fake-grandchild.pid");
  const treeAbort = new AbortController();
  const treeExchange = createFakeAdapter("hang-with-child", {
    PATCHMARK_FAKE_CHILD_PID_PATH: childPidPath
  }, 10_000).exchange({
    maxResponseBytes: 1024,
    requestBytes: new TextEncoder().encode("cancel process tree"),
    signal: treeAbort.signal
  });
  await waitFor(() => existsSync(childPidPath));
  const childPid = Number(await readFile(childPidPath, "utf8"));
  treeAbort.abort();
  await assert.rejects(
    treeExchange,
    (error) => error instanceof CodexAdapterError && error.code === "cancelled"
  );
  await waitFor(() => !processExists(childPid));
  check(true, "cancellation removes a deterministic descendant process");

  const raceAbort = new AbortController();
  const raceExchange = createFakeAdapter("cancel-race").exchange({
    maxResponseBytes: 1024,
    requestBytes: new TextEncoder().encode("cancel near terminal output"),
    signal: raceAbort.signal
  });
  await delay(60);
  raceAbort.abort();
  await assert.rejects(
    raceExchange,
    (error) => error instanceof CodexAdapterError && error.code === "cancelled"
  );
  check(true, "cancellation racing terminal output discards the late result");

  const parsed = extractFinalAgentMessage(
    new TextEncoder().encode(
      [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ item: { type: "agent_message", text: "one" }, type: "item.completed" }),
        JSON.stringify({ item: { type: "agent_message", text: "two" }, type: "item.completed" }),
        JSON.stringify({ type: "turn.completed" })
      ].join("\n") + "\n"
    )
  );
  assert.deepEqual(parsed, { completed: true, failureCode: null, finalMessage: "two" });
}

async function qualifyHttpSecurityAndLifecycle() {
  let compatibilityCalls = 0;
  let exchangeCalls = 0;
  let mode = "success";
  let observedAbort = false;
  const responseBytes = new TextEncoder().encode("{\"safe\":true}");
  const adapter = {
    async inspectCompatibility() {
      compatibilityCalls += 1;
      return {
        codex_version: "0.148.0-alpha.15",
        compatibility: "supported"
      };
    },
    async exchange({ requestBytes, signal }) {
      exchangeCalls += 1;
      if (mode !== "accept-any" && mode !== "response-boundary") {
        assert.deepEqual(
          Buffer.from(requestBytes),
          Buffer.from(new TextEncoder().encode("canonical\n"))
        );
      }
      if (mode === "hold") {
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new CodexAdapterError("cancelled", "cancelled"));
            },
            { once: true }
          );
        });
      }
      if (mode === "response-boundary") {
        return new Uint8Array(responseBoundaryBytes);
      }
      return responseBytes;
    }
  };
  let responseBoundaryBytes = 0;
  const pairingCodes = [];
  const connector = createPatchmarkLocalConnector({
    adapter,
    allowedOrigins: ["https://patchmark.test", "https://staging.patchmark.test"],
    onPairingCode: (code) => pairingCodes.push(code),
    port: 0
  });
  const connectorOrigin = await connector.start();
  assert.equal(compatibilityCalls, 0, "connector startup does not access Codex");
  assert.equal(pairingCodes.length, 1);
  const port = Number(new URL(connectorOrigin).port);

  const absentOrigin = await rawRequest({ connectorOrigin, path: "/v1/status" });
  assert.equal(absentOrigin.status, 403);
  assert.equal(absentOrigin.headers["access-control-allow-origin"], undefined);
  const hostileOrigin = await rawRequest({
    connectorOrigin,
    origin: "https://evil.test",
    path: "/v1/status"
  });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(hostileOrigin.headers["access-control-allow-origin"], undefined);
  const hostileHost = await rawRequest({
    connectorOrigin,
    host: `localhost:${port}`,
    origin: "https://patchmark.test",
    path: "/v1/status"
  });
  assert.equal(hostileHost.status, 403);

  const preflight = await rawRequest({
    connectorOrigin,
    headers: {
      "Access-Control-Request-Headers": "authorization, content-type",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Private-Network": "true"
    },
    method: "OPTIONS",
    origin: "https://patchmark.test",
    path: "/v1/exchanges"
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://patchmark.test");
  assert.equal(preflight.headers["access-control-allow-private-network"], "true");
  const hostilePreflight = await rawRequest({
    connectorOrigin,
    headers: {
      "Access-Control-Request-Headers": "x-arbitrary-command",
      "Access-Control-Request-Method": "POST"
    },
    method: "OPTIONS",
    origin: "https://patchmark.test",
    path: "/v1/exchanges"
  });
  assert.equal(hostilePreflight.status, 403);

  const status = await rawRequest({
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/status"
  });
  assert.equal(status.status, 200);
  assert.equal(status.json.paired, false);
  assert.equal(status.json.compatibility, "supported");
  assert.equal(compatibilityCalls, 1);

  const wrongPair = await jsonRequest({
    body: { pairing_code: "A".repeat(43), protocol_version: 1 },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/pair"
  });
  assert.equal(wrongPair.status, 403);
  const paired = await jsonRequest({
    body: {
      pairing_code: pairingCodes[0],
      protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
    },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/pair"
  });
  assert.equal(paired.status, 200);
  assert.equal(pairingCodes.length, 2, "a consumed code is immediately rotated");
  const token = paired.json.session_token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const replay = await jsonRequest({
    body: { pairing_code: pairingCodes[0], protocol_version: 1 },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/pair"
  });
  assert.equal(replay.status, 403);
  const crossOriginToken = await rawRequest({
    connectorOrigin,
    origin: "https://staging.patchmark.test",
    path: "/v1/status",
    token
  });
  assert.equal(crossOriginToken.status, 200);
  assert.equal(crossOriginToken.json.paired, false);

  const canonical = new TextEncoder().encode("canonical\n");
  const exchangeBody = makeExchangeBody("ae2_operation_1", canonical);
  const unknownField = await jsonRequest({
    body: {
      ...exchangeBody,
      argv: ["--dangerously-bypass-approvals-and-sandbox"],
      cwd: "/",
      environment: { OPENAI_API_KEY: "browser-controlled" },
      executable: "/bin/sh",
      model: "browser-selected",
      path: "/tmp/project"
    },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(unknownField.status, 400);
  const badDigest = await jsonRequest({
    body: { ...exchangeBody, request_sha256: "0".repeat(64) },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(badDigest.status, 400);
  const badBase64 = await jsonRequest({
    body: { ...exchangeBody, request_base64: "YQ===" },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(badBase64.status, 400);
  const success = await jsonRequest({
    body: exchangeBody,
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(success.status, 200);
  assert.deepEqual(Buffer.from(success.json.response_base64, "base64"), Buffer.from(responseBytes));

  mode = "accept-any";
  const exactCeilingBytes = Buffer.alloc(LOCAL_CONNECTOR_MAX_REQUEST_BYTES, 0x61);
  const exactCeilingBody = makeExchangeBody("ae2_request_exact_ceiling", exactCeilingBytes);
  const exactCeiling = await jsonRequest({
    body: exactCeilingBody,
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(exactCeiling.status, 200);
  const plusOneMetadata = await jsonRequest({
    body: {
      ...exactCeilingBody,
      operation_id: "ae2_request_plus_one",
      request_byte_length: LOCAL_CONNECTOR_MAX_REQUEST_BYTES + 1
    },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(plusOneMetadata.status, 400);

  mode = "response-boundary";
  responseBoundaryBytes = 1024;
  const exactResponse = await jsonRequest({
    body: { ...exchangeBody, max_response_bytes: 1024, operation_id: "ae2_response_exact" },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(exactResponse.status, 200);
  assert.equal(exactResponse.json.response_byte_length, 1024);
  responseBoundaryBytes = 1025;
  const oversizedResponse = await jsonRequest({
    body: { ...exchangeBody, max_response_bytes: 1024, operation_id: "ae2_response_plus_one" },
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(oversizedResponse.status, 413);

  mode = "hold";
  observedAbort = false;
  const held = jsonRequest({
    body: makeExchangeBody("ae2_operation_hold", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  await waitFor(() => exchangeCalls >= 2);
  const busy = await jsonRequest({
    body: makeExchangeBody("ae2_operation_busy", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, "busy");
  const wrongCancel = await rawRequest({
    connectorOrigin,
    method: "DELETE",
    origin: "https://patchmark.test",
    path: "/v1/exchanges/not_the_owned_operation",
    token
  });
  assert.equal(wrongCancel.status, 404);
  const cancelled = await rawRequest({
    connectorOrigin,
    method: "DELETE",
    origin: "https://patchmark.test",
    path: "/v1/exchanges/ae2_operation_hold",
    token
  });
  assert.equal(cancelled.status, 204);
  const heldResult = await held;
  assert.equal(heldResult.status, 409);
  assert.equal(heldResult.json.error.code, "cancelled");
  assert.equal(observedAbort, true);

  mode = "success";
  const recovered = await jsonRequest({
    body: makeExchangeBody("ae2_operation_after_cancel", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(recovered.status, 200, "cancel leaves the global slot reusable");

  mode = "hold";
  observedAbort = false;
  const disconnected = abortableJsonRequest({
    body: makeExchangeBody("ae2_client_disconnect", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  await waitFor(() => exchangeCalls >= 7);
  disconnected.destroy();
  await disconnected.promise.catch(() => undefined);
  await waitFor(() => observedAbort);
  mode = "success";
  const afterDisconnect = await jsonRequest({
    body: makeExchangeBody("ae2_after_disconnect", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(afterDisconnect.status, 200, "client disconnect cleanup releases the slot");

  const missingToken = await jsonRequest({
    body: makeExchangeBody("ae2_missing_token", canonical),
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges"
  });
  assert.equal(missingToken.status, 401);
  const unknownEndpoint = await rawRequest({
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/run-command",
    token
  });
  assert.equal(unknownEndpoint.status, 404);
  const wrongVerb = await rawRequest({
    connectorOrigin,
    method: "PUT",
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(wrongVerb.status, 404);

  const oversizedBody = Buffer.alloc(Math.ceil((LOCAL_CONNECTOR_MAX_REQUEST_BYTES * 4) / 3) + 8192, 0x20);
  const oversized = await rawRequest({
    body: oversizedBody,
    connectorOrigin,
    headers: { "Content-Type": "application/json" },
    method: "POST",
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token
  });
  assert.equal(oversized.status, 413);

  const revoked = await rawRequest({
    connectorOrigin,
    method: "POST",
    origin: "https://patchmark.test",
    path: "/v1/revoke",
    token
  });
  assert.equal(revoked.status, 204);
  assert.equal(pairingCodes.length, 3, "revocation rotates the one-time pairing code");
  const afterRevoke = await rawRequest({
    connectorOrigin,
    origin: "https://patchmark.test",
    path: "/v1/status",
    token
  });
  assert.equal(afterRevoke.json.paired, false);
  await connector.stop();

  let shutdownAborted = false;
  let shutdownCode;
  const shutdownConnector = createPatchmarkLocalConnector({
    adapter: {
      async inspectCompatibility() {
        return { codex_version: "0.148.0-alpha.15", compatibility: "supported" };
      },
      async exchange({ signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            shutdownAborted = true;
            reject(new CodexAdapterError("cancelled", "cancelled"));
          }, { once: true });
        });
      }
    },
    allowedOrigins: ["https://patchmark.test"],
    onPairingCode: (code) => { shutdownCode = code; },
    port: 0
  });
  const shutdownOrigin = await shutdownConnector.start();
  const shutdownPair = await jsonRequest({
    body: { pairing_code: shutdownCode, protocol_version: 1 },
    connectorOrigin: shutdownOrigin,
    origin: "https://patchmark.test",
    path: "/v1/pair"
  });
  const shutdownExchange = jsonRequest({
    body: makeExchangeBody("ae2_shutdown", canonical),
    connectorOrigin: shutdownOrigin,
    origin: "https://patchmark.test",
    path: "/v1/exchanges",
    token: shutdownPair.json.session_token
  });
  await delay(25);
  await shutdownConnector.stop();
  await shutdownExchange;
  assert.equal(shutdownAborted, true, "connector shutdown aborts the owned operation");
}

async function qualifyBrowserConnectorOverRealHttpAndFakeCodex() {
  const responseText = JSON.stringify({
    protocol: "patchmark.comment_reply_import",
    protocol_version: 2,
    replies: [],
    patch_proposals: [],
    open_questions: []
  });
  let pairingCode;
  const adapter = createFakeAdapter("success", {
    PATCHMARK_FAKE_RESPONSE_BASE64: Buffer.from(responseText).toString("base64")
  });
  const server = createPatchmarkLocalConnector({
    adapter,
    allowedOrigins: ["https://patchmark.test"],
    onPairingCode: (value) => { pairingCode = value; },
    port: 0
  });
  const endpoint = await server.start();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", "https://patchmark.test");
    return originalFetch(input, { ...init, headers });
  };
  try {
    const session = new LocalCodexConnectorSession(endpoint);
    const connector = session.createConnector();
    assert.equal((await connector.checkPairingStatus({ signal: new AbortController().signal })).paired, false);
    await connector.pair({ pairing_code: pairingCode, signal: new AbortController().signal });
    assert.deepEqual(
      await connector.checkAvailability({ signal: new AbortController().signal }),
      { status: "available" }
    );
    const requestBytes = new TextEncoder().encode("exact portable review\r\n\n");
    const digest = createHash("sha256").update(requestBytes).digest("hex");
    const binding = {
      authority: "none",
      connector_id: connector.descriptor.id,
      connector_version: connector.descriptor.version,
      document_id: "document",
      expected_response_protocol: "patchmark.comment_reply_import",
      expected_response_protocol_version: 2,
      export_scope: {
        batch_type: "manual",
        document_id: "document",
        kind: "document",
        source: "manual"
      },
      max_response_bytes: 16 * 1024,
      operation_id: "ae2_browser_adapter_http",
      project_id: "project",
      request_byte_length: requestBytes.byteLength,
      request_sha256: digest,
      review_batch_id: "batch"
    };
    const result = await connector.submit({
      binding,
      request_bytes: requestBytes,
      signal: new AbortController().signal
    });
    assert.equal(new TextDecoder().decode(result.response_bytes), responseText);
    assert.equal(result.binding.response_byte_length, result.response_bytes.byteLength);
    assert.equal(result.binding.operation_id, binding.operation_id);
    check(true, "browser AgentConnector traverses the real HTTP server and fake codex exec adapter");
  } finally {
    globalThis.fetch = originalFetch;
    await server.stop();
  }
}

async function qualifyStaticBoundary() {
  const release = await readFile(join(root, "lib/release/product-release-state.ts"), "utf8");
  const nextConfig = await readFile(join(root, "next.config.ts"), "utf8");
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const server = await readFile(join(root, "local-connector/server.ts"), "utf8");
  const browserConnector = await readFile(join(root, "lib/agent-exchange/local-codex-connector.ts"), "utf8");
  const actions = await readFile(join(root, "components/agent-exchange/agent-exchange-actions.tsx"), "utf8");
  assert.match(release, /human_collaboration:\s*false/);
  assert.match(release, /agent_exchange:\s*false/);
  assert.match(nextConfig, /!productReleaseState\.agent_exchange/);
  assert.equal(packageJson.dependencies["@openai/codex-sdk"], undefined);
  assert.equal(packageJson.dependencies.express, undefined);
  assert.doesNotMatch(
    server,
    /0\.0\.0\.0|createSecureServer|WebSocket|from\s+["']node:child_process["']/
  );
  assert.doesNotMatch(browserConnector, /localStorage|sessionStorage|document\.cookie|indexedDB/);
  assert.doesNotMatch(browserConnector, /project_id.*JSON\.stringify|document_id.*JSON\.stringify|review_batch_id.*JSON\.stringify/);
  for (const label of [
    "Local Codex isn’t ready",
    "This Codex version isn’t supported",
    "Codex sign-in required",
    "Local Codex is busy",
    "Codex couldn’t complete the review"
  ]) {
    assert.ok(actions.includes(label), `product UI includes actionable state: ${label}`);
  }
  check(true, "production flags, loader removal, no-dependency runtime, and browser-memory custody remain explicit");
}

async function qualifyTypedProductFailureCause() {
  const prepared = {
    authority: "none",
    copy_request_bytes: () => new TextEncoder().encode("typed failure"),
    expected_response_protocol: "patchmark.comment_reply_import",
    expected_response_protocol_version: 2,
    max_response_bytes: 1024,
    project_id: "project",
    request_byte_length: 13,
    request_sha256: "a".repeat(64),
    review_batch_id: "batch",
    scope: {
      batch_type: "manual",
      document_id: "document",
      kind: "document",
      source: "manual"
    }
  };
  const operation = new AgentExchangeOperationController().begin({
    connector: {
      descriptor: { id: "typed.failure", version: "1" },
      async checkAvailability() {
        return { status: "available" };
      },
      async close() {},
      async submit() {
        throw new LocalConnectorError(
          "authentication_required",
          "synthetic authentication failure"
        );
      }
    },
    createOperationId: () => "ae2_typed_failure",
    importResponse: async () => undefined,
    prepared
  });
  await assert.rejects(operation.execute(), (error) => {
    return (
      error?.code === "connector_failed" &&
      error?.cause?.code === "authentication_required" &&
      !(error.cause instanceof LocalConnectorError) &&
      Object.keys(error.cause).join(",") === "code"
    );
  });
  check(true, "AE-1 preserves a typed local-provider cause without broadening authority");
}

function createFakeAdapter(scenario, extraEnvironment = {}, timeoutMs = 2000) {
  return new CodexExecAdapter({
    environment: {
      ...createCodexEnvironment(process.env),
      PATCHMARK_FAKE_CODEX_SCENARIO: scenario,
      ...extraEnvironment
    },
    executable: fakeCodex,
    operationTimeoutMs: timeoutMs
  });
}

function exchangeTemporaryDirectories() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("patchmark-codex-exchange-"))
    .sort();
}

function makeExchangeBody(operationId, bytes) {
  return {
    expected_response_protocol: "patchmark.comment_reply_import",
    expected_response_protocol_version: 2,
    max_response_bytes: 16 * 1024,
    operation_id: operationId,
    protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
    request_base64: Buffer.from(bytes).toString("base64"),
    request_byte_length: bytes.byteLength,
    request_sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function jsonRequest(input) {
  return rawRequest({
    ...input,
    body: Buffer.from(JSON.stringify(input.body)),
    headers: { ...input.headers, "Content-Type": "application/json" },
    method: input.method ?? "POST"
  });
}

function rawRequest({
  body,
  connectorOrigin,
  headers = {},
  host,
  method = "GET",
  origin,
  path,
  token
}) {
  const target = new URL(connectorOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          ...headers,
          ...(origin ? { Origin: origin } : {}),
          ...(token ? { Authorization: `Patchmark ${token}` } : {}),
          ...(host ? { Host: host } : {})
        },
        hostname: target.hostname,
        method,
        path,
        port: target.port
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (text) {
            try { json = JSON.parse(text); } catch {}
          }
          resolve({ headers: response.headers, json, status: response.statusCode, text });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function abortableJsonRequest({ body, connectorOrigin, origin, path, token }) {
  const target = new URL(connectorOrigin);
  const encoded = Buffer.from(JSON.stringify(body));
  let request;
  const promise = new Promise((resolve, reject) => {
    request = httpRequest(
      {
        headers: {
          Authorization: `Patchmark ${token}`,
          "Content-Length": String(encoded.byteLength),
          "Content-Type": "application/json",
          Origin: origin
        },
        hostname: target.hostname,
        method: "POST",
        path,
        port: target.port
      },
      (response) => {
        response.resume();
        response.once("end", resolve);
      }
    );
    request.once("error", reject);
    request.end(encoded);
  });
  return { destroy: () => request.destroy(), promise };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for qualification state.");
    await delay(10);
  }
}

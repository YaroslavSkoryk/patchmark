import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

import {
  CodexAdapterError,
  CodexExecAdapter,
  createCodexEnvironment,
  isCodexProviderFailureDiagnostic
} from "../local-connector/codex-exec-adapter.ts";
import { createPatchmarkLocalConnector } from "../local-connector/server.ts";
import { LOCAL_CONNECTOR_PROTOCOL_VERSION } from "../lib/agent-exchange/local-connector-protocol.ts";

const fakeCodex = new URL(
  "./fixtures/agent-exchange/fake-codex.mjs",
  import.meta.url
).pathname;
const checks = [];

const topLevel = await providerFailure("top-level-error");
assertDiagnostic(topLevel, {
  exit_code: 1,
  failure_source: "top_level_error",
  final_response_seen: false,
  terminal_event_seen: false,
  top_level_error_seen: true,
  top_level_event_type: "error",
  turn_failed_seen: false
});
assert.equal(topLevel.error_message_sha256, sha256("synthetic provider error"));
checks.push("top-level error is fingerprinted without retaining its prose");

const turnFailed = await providerFailure("provider-failed");
assertDiagnostic(turnFailed, {
  exit_code: 1,
  failure_source: "turn_failed",
  final_response_seen: false,
  terminal_event_seen: true,
  top_level_error_seen: false,
  top_level_event_type: "turn.failed",
  turn_failed_seen: true,
  turn_status: "failed",
  typed_error_code: null
});
checks.push("turn.failed is distinct from a top-level error");

const both = await providerFailure("top-level-and-turn-failed");
assertDiagnostic(both, {
  error_message_fingerprints_match: true,
  exit_code: 9,
  failure_source: "turn_failed",
  top_level_error_seen: true,
  top_level_event_type: "turn.failed",
  turn_failed_seen: true
});
checks.push("matching top-level and turn.failed fingerprints are recognized");

const itemError = await providerFailure("item-error");
assertDiagnostic(itemError, {
  exit_code: 1,
  failure_source: "process_exit",
  item_error_count: 1,
  item_error_phase: "in_turn",
  item_error_seen: true,
  item_type: "error",
  stream_integrity_compromised: false,
  terminal_event_seen: false
});
checks.push("non-fatal item diagnostics do not mask an independent process exit");

const structuredNonzero = await providerFailure("provider-failed");
assert.equal(structuredNonzero.failure_source, "turn_failed");
assert.equal(structuredNonzero.exit_code, 1);

const nonzero = await providerFailure("nonzero");
assertDiagnostic(nonzero, {
  exit_code: 7,
  failure_source: "process_exit",
  final_response_seen: true,
  terminal_event_seen: true
});

const signal = await providerFailure("signal-exit");
assertDiagnostic(signal, {
  exit_code: null,
  failure_source: "process_signal",
  signal_name: "SIGTERM",
  timeout_fired: false
});

const stderrOnly = await providerFailure("stderr-only");
assertDiagnostic(stderrOnly, {
  exit_code: 11,
  failure_source: "process_exit",
  stderr_present: true
});
assert.ok(stderrOnly.stderr_byte_length > 0);
assert.equal(
  stderrOnly.stderr_sha256,
  sha256("SYNTHETIC_STDERR_DO_NOT_EXPOSE\n")
);

const afterMetadata = await providerFailure("failure-after-inert-metadata");
assertDiagnostic(afterMetadata, {
  exit_code: 12,
  failure_source: "turn_failed",
  final_response_seen: false,
  terminal_event_seen: true,
  turn_failed_seen: true
});
checks.push("structured, process, signal, stderr-only, and inert-metadata failures remain distinct");

const timeout = await providerFailure("hang", 100);
assertDiagnostic(timeout, {
  failure_source: "operation_timeout",
  timeout_fired: true
});
assert.equal(
  timeout.exit_code !== null || timeout.signal_name !== null,
  true,
  "timeout termination must retain the observed process outcome"
);
checks.push("the operation timer is recorded separately from an external signal");

for (const [scenario, category] of [
  ["missing-final", "ambiguous_final_response"],
  ["ambiguous-final", "ambiguous_final_response"],
  ["malformed", "invalid_event_stream"]
]) {
  await assert.rejects(exchange(scenario), (error) => {
    return (
      error instanceof CodexAdapterError &&
      error.code === "connector_protocol_error" &&
      error.diagnostic?.category === category &&
      error.qualificationDiagnostic === null
    );
  });
}
checks.push("zero-final and malformed terminal streams stay protocol failures");

await qualifyHttpDiagnosticBoundary();

process.stdout.write(`${JSON.stringify({
  checks,
  codex_live_model_calls: 0,
  production_release: { agent_exchange: false, human_collaboration: false },
  status: "ok"
}, null, 2)}\n`);

function exchange(scenario, timeoutMs = 2_000) {
  return new CodexExecAdapter({
    environment: {
      ...createCodexEnvironment(process.env),
      PATCHMARK_FAKE_CODEX_SCENARIO: scenario
    },
    executable: fakeCodex,
    operationTimeoutMs: timeoutMs
  }).exchange({
    maxResponseBytes: 4_096,
    requestBytes: new TextEncoder().encode("synthetic diagnostic request"),
    signal: new AbortController().signal
  });
}

async function providerFailure(scenario, timeoutMs) {
  try {
    await exchange(scenario, timeoutMs);
  } catch (error) {
    assert.ok(error instanceof CodexAdapterError);
    assert.equal(error.code, "provider_failed");
    assert.equal(error.diagnostic, null);
    assert.equal(
      isCodexProviderFailureDiagnostic(error.qualificationDiagnostic),
      true
    );
    return error.qualificationDiagnostic;
  }
  assert.fail(`${scenario} unexpectedly succeeded`);
}

function assertDiagnostic(diagnostic, expected) {
  assert.equal(isCodexProviderFailureDiagnostic(diagnostic), true);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(diagnostic[key], value, key);
  }
}

async function qualifyHttpDiagnosticBoundary() {
  const exposed = await runHttpFailure(true);
  assert.equal(exposed.status, 502);
  assert.deepEqual(exposed.json, {
    error: { code: "provider_failed" },
    protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
  });
  const encoded = exposed.headers["x-patchmark-qualification-diagnostic"];
  assert.equal(typeof encoded, "string");
  const decodedText = Buffer.from(encoded, "base64url").toString("utf8");
  const diagnostic = JSON.parse(decodedText);
  assert.equal(isCodexProviderFailureDiagnostic(diagnostic), true);
  for (const forbidden of [
    "SYNTHETIC_PROVIDER_MESSAGE_DO_NOT_EXPOSE",
    "SYNTHETIC_STDERR_DO_NOT_EXPOSE",
    "Authorization",
    "Bearer",
    "reasoning",
    "credential",
    "session",
    "environment",
    "/Users/",
    "Patchmark pairing code"
  ]) {
    assert.equal(JSON.stringify(exposed).includes(forbidden), false, forbidden);
    assert.equal(decodedText.includes(forbidden), false, `decoded ${forbidden}`);
  }

  const hidden = await runHttpFailure(false);
  assert.equal(hidden.status, 502);
  assert.equal(
    hidden.headers["x-patchmark-qualification-diagnostic"],
    undefined
  );
  assert.deepEqual(hidden.json, exposed.json);

  const unsafe = await runHttpFailure(true, {
    async inspectCompatibility() {
      return { codex_version: "0.151.0", compatibility: "supported" };
    },
    async exchange() {
      throw new CodexAdapterError(
        "provider_failed",
        "synthetic unsafe qualification diagnostic",
        null,
        {
          ...afterMetadata,
          typed_error_code: "private/project?token=secret"
        }
      );
    }
  });
  assert.equal(
    unsafe.headers["x-patchmark-qualification-diagnostic"],
    undefined
  );
  checks.push("qualification metadata is header-gated and the product error body stays coarse");
}

async function runHttpFailure(includeQualificationDiagnostics, providedAdapter) {
  let pairingCode;
  const connector = createPatchmarkLocalConnector({
    adapter: providedAdapter ?? new CodexExecAdapter({
        environment: {
          ...createCodexEnvironment(process.env),
          PATCHMARK_FAKE_CODEX_SCENARIO: "failure-after-inert-metadata"
        },
        executable: fakeCodex
      }),
    allowedOrigins: ["https://patchmark.test"],
    includeQualificationDiagnostics,
    onPairingCode: (value) => { pairingCode = value; },
    port: 0
  });
  const connectorOrigin = await connector.start();
  try {
    const paired = await jsonRequest({
      body: {
        pairing_code: pairingCode,
        protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
      },
      connectorOrigin,
      path: "/v1/pair"
    });
    const bytes = Buffer.from("synthetic http diagnostic request", "utf8");
    return await jsonRequest({
      body: {
        expected_response_protocol: "patchmark.comment_reply_import",
        expected_response_protocol_version: 2,
        max_response_bytes: 4_096,
        operation_id: "ae3_slice2b_http_failure",
        protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
        request_base64: bytes.toString("base64"),
        request_byte_length: bytes.byteLength,
        request_sha256: sha256(bytes)
      },
      connectorOrigin,
      path: "/v1/exchanges",
      token: paired.json.session_token
    });
  } finally {
    await connector.stop();
  }
}

function jsonRequest({ body, connectorOrigin, path, token }) {
  const target = new URL(connectorOrigin);
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = httpRequest({
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Patchmark ${token}` } : {}),
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/json",
        Origin: "https://patchmark.test"
      },
      hostname: target.hostname,
      method: "POST",
      path,
      port: target.port
    }, (response) => {
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
    });
    outgoing.once("error", rejectRequest);
    outgoing.end(bytes);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

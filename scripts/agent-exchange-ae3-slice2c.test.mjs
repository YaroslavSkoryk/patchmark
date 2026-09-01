import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";

import {
  CODEX_0_151_0_ITEM_LIFECYCLE,
  CodexAdapterError,
  extractFinalAgentMessage
} from "../local-connector/codex-exec-adapter.ts";
import { createPatchmarkLocalConnector } from "../local-connector/server.ts";
import {
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  isLocalConnectorProtocolDiagnostic
} from "../lib/agent-exchange/local-connector-protocol.ts";

const fixtureUrl = new URL(
  "./fixtures/agent-exchange/codex-0.151.0-wire-fixtures.json",
  import.meta.url
);
const fakeCodex = new URL(
  "./fixtures/agent-exchange/fake-codex.mjs",
  import.meta.url
).pathname;
const frozen = JSON.parse(await readFile(fixtureUrl, "utf8"));
const events = frozen.events;
const checks = [];

assert.deepEqual(frozen.provenance, {
  codex_commit: "78c290807ce710180111df227df3b7a4fe845452",
  codex_tag: "rust-v0.151.0",
  source_files: [
    "codex-rs/exec/src/exec_events.rs",
    "codex-rs/exec/src/event_processor_with_jsonl_output.rs",
    "codex-rs/exec/src/event_processor_with_jsonl_output_tests.rs",
    "codex-rs/exec/src/lib.rs",
    "codex-rs/exec/src/lib_tests.rs",
    "codex-rs/exec/tests/event_processor_with_json_output.rs"
  ]
});
checks.push("frozen vectors retain exact tag, commit, and serializer provenance");

const exactSuccess = [
  events.thread_started,
  events.turn_started,
  events.reasoning_completed,
  events.todo_list_started,
  events.todo_list_updated,
  events.todo_list_completed,
  events.agent_message_completed,
  events.turn_completed
];
assert.deepEqual(extractFinalAgentMessage(jsonl(exactSuccess)), {
  completed: true,
  failureCode: null,
  finalMessage: "synthetic assistant response"
});
checks.push("exact lifecycle, inert metadata, final response, and token usage parse");

const additiveAgent = structuredClone(events.agent_message_completed);
additiveAgent.item.metadata = { synthetic: true };
assert.equal(
  extractFinalAgentMessage(
    jsonl([
      events.thread_started,
      events.turn_started,
      additiveAgent,
      events.turn_completed
    ])
  ).finalMessage,
  "synthetic assistant response"
);
checks.push("required fields are strict without an artificial exact-key set");

const preTurnError = [
  events.thread_started,
  events.pre_turn_error_completed,
  events.turn_started,
  events.turn_failed
];
assert.throws(() => legacyLifecycleGuard(preTurnError), /invalid_event_stream/);
assert.deepEqual(extractFinalAgentMessage(jsonl(preTurnError)), {
  completed: false,
  failureCode: "provider_failed",
  finalMessage: null
});
checks.push("the old pre-turn guard is reproduced and the corrected parser accepts the warning shape while preserving turn.failed");

assert.deepEqual(CODEX_0_151_0_ITEM_LIFECYCLE, {
  agent_message: ["item.completed"],
  collab_tool_call: ["item.started", "item.completed"],
  command_execution: ["item.started", "item.completed"],
  error: ["item.completed"],
  file_change: ["item.completed"],
  mcp_tool_call: ["item.started", "item.completed"],
  reasoning: ["item.completed"],
  todo_list: ["item.started", "item.updated", "item.completed"],
  web_search: ["item.started", "item.completed"]
});

for (const event of [
  { ...events.agent_message_completed, type: "item.started" },
  { ...events.agent_message_completed, type: "item.updated" },
  { ...events.reasoning_completed, type: "item.started" },
  { ...events.reasoning_completed, type: "item.updated" }
]) {
  assertProtocolFailure(
    [events.thread_started, events.turn_started, event],
    "invalid_event_stream",
    "invalid_lifecycle_phase"
  );
}
checks.push("only serializer-supported item lifecycle phases are accepted");

for (const fixtureName of [
  "command_execution_started",
  "command_execution_completed",
  "file_change_completed",
  "mcp_tool_call_started",
  "mcp_tool_call_completed",
  "collab_tool_call_started",
  "collab_tool_call_completed",
  "web_search_started",
  "web_search_completed"
]) {
  assertProtocolFailure(
    [events.thread_started, events.turn_started, events[fixtureName]],
    "forbidden_tool_event"
  );
}
checks.push("every exact authority-bearing variant fails on its first observed event");

const malformed = [
  [{ type: "item.completed" }, "missing_required_field", "item"],
  [{ type: "item.completed", item: [] }, "non_object", "item"],
  [{ type: "item.completed", item: { id: "x" } }, "missing_required_field", "type"],
  [{ type: "item.completed", item: { id: "x", type: 7 } }, "non_string", "type"],
  [{ type: "item.completed", item: { id: "x", type: "agent_message" } }, "missing_required_field", "text"],
  [{ type: "item.completed", item: { id: "x", text: 7, type: "agent_message" } }, "non_string", "text"],
  [{ type: "item.completed", item: { id: "", text: "x", type: "agent_message" } }, "empty_string", "id"],
  [{ type: "item.completed", item: { details: { id: "x", text: "x", type: "agent_message" } } }, "missing_required_field", "type"],
  [{ type: "item.updated", item: { id: "todo", items: {}, type: "todo_list" } }, "non_array", "items"]
];
for (const [event, kind, field] of malformed) {
  const error = captureProtocolFailure([
    events.thread_started,
    events.turn_started,
    event
  ]);
  assert.equal(error.diagnostic.invalid_field_kind, kind);
  assert.equal(error.diagnostic.invalid_field_name, field);
  assert.equal(isLocalConnectorProtocolDiagnostic(error.diagnostic), true);
}
assertProtocolFailure(
  [events.thread_started, events.turn_started, {
    type: "item.completed",
    item: { id: "x", type: "future_item" }
  }],
  "unsupported_item_type"
);
assertProtocolFailure(
  [events.thread_started, events.turn_started, { type: "turn.future" }],
  "unsupported_event_type"
);
checks.push("focused malformed, impossible-nesting, unknown-item, and unknown-event vectors fail closed");

const privacyEvent = {
  type: "item.completed",
  item: {
    id: "synthetic-id",
    text: {
      command: "curl https://secret.invalid/private",
      path: "/Users/private/project",
      reasoning: "SECRET_REASONING",
      request: "SECRET_REQUEST",
      response: "SECRET_RESPONSE",
      token: "SECRET_CREDENTIAL"
    },
    type: "agent_message"
  }
};
const privacyError = captureProtocolFailure([
  events.thread_started,
  events.turn_started,
  privacyEvent
]);
const privacyDiagnostic = JSON.stringify(privacyError.diagnostic);
for (const value of [
  "curl",
  "secret.invalid",
  "/Users/private",
  "SECRET_REASONING",
  "SECRET_REQUEST",
  "SECRET_RESPONSE",
  "SECRET_CREDENTIAL",
  "synthetic-id"
]) {
  assert.equal(privacyDiagnostic.includes(value), false, value);
}
assert.deepEqual(privacyError.diagnostic.sorted_item_key_names, [
  "id",
  "text",
  "type"
]);
checks.push("qualification diagnostics retain structural names and kinds but no values");

assert.deepEqual(fakeEvents("success"), [
  events.thread_started,
  events.turn_started,
  {
    ...events.agent_message_completed,
    item: { ...events.agent_message_completed.item, text: "{}" }
  },
  events.turn_completed
]);
assert.deepEqual(fakeEvents("metadata-lifecycle"), [
  events.thread_started,
  events.turn_started,
  events.reasoning_completed,
  events.todo_list_started,
  events.todo_list_updated,
  events.todo_list_completed,
  {
    ...events.agent_message_completed,
    item: { ...events.agent_message_completed.item, text: "{}" }
  },
  events.turn_completed
]);
checks.push("fake success and metadata streams are assembled from frozen exact vectors");

await qualifyStructuralHeaderBoundary();

process.stdout.write(`${JSON.stringify({
  checks,
  codex_live_model_calls: 0,
  corrected_wire_target: "0.151.0",
  status: "ok"
}, null, 2)}\n`);

function jsonl(sequence) {
  return Buffer.from(`${sequence.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function legacyLifecycleGuard(sequence) {
  let turnStarted = false;
  for (const event of sequence) {
    if (event.type === "turn.started") turnStarted = true;
    if (event.type?.startsWith("item.") && !turnStarted) {
      throw new Error("invalid_event_stream");
    }
  }
}

function captureProtocolFailure(sequence) {
  try {
    extractFinalAgentMessage(jsonl(sequence));
  } catch (error) {
    assert.ok(error instanceof CodexAdapterError);
    assert.equal(error.code, "connector_protocol_error");
    assert.equal(isLocalConnectorProtocolDiagnostic(error.diagnostic), true);
    return error;
  }
  assert.fail("stream unexpectedly succeeded");
}

function assertProtocolFailure(sequence, category, kind) {
  const error = captureProtocolFailure(sequence);
  assert.equal(error.diagnostic.category, category);
  if (kind !== undefined) assert.equal(error.diagnostic.invalid_field_kind, kind);
}

function fakeEvents(scenario) {
  const result = spawnSync(fakeCodex, ["exec", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATCHMARK_FAKE_CODEX_SCENARIO: scenario },
    input: "synthetic request",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function qualifyStructuralHeaderBoundary() {
  const generatedError = captureProtocolFailure([
    events.thread_started,
    events.turn_started,
    { type: "item.completed", item: { id: "private-id", type: "agent_message" } }
  ]);
  const adapter = {
    async inspectCompatibility() {
      return { codex_version: "0.151.0", compatibility: "supported" };
    },
    async exchange() {
      throw generatedError;
    }
  };
  const exposed = await httpFailure(adapter, true);
  assert.deepEqual(exposed.json, {
    error: { code: "connector_protocol_error" },
    protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
  });
  assert.equal(exposed.headers["x-patchmark-qualification-diagnostic"], undefined);
  const encoded = exposed.headers[
    "x-patchmark-qualification-structural-diagnostic"
  ];
  assert.equal(typeof encoded, "string");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  assert.equal(
    isLocalConnectorProtocolDiagnostic(JSON.parse(decoded)),
    true
  );
  assert.equal(decoded.includes("private-id"), false);

  const hidden = await httpFailure(adapter, false);
  assert.deepEqual(hidden.json, exposed.json);
  assert.equal(
    hidden.headers["x-patchmark-qualification-structural-diagnostic"],
    undefined
  );
  checks.push("structural evidence is qualification-header-only and product bodies stay coarse");
}

async function httpFailure(adapter, includeQualificationDiagnostics) {
  let pairingCode;
  const connector = createPatchmarkLocalConnector({
    adapter,
    allowedOrigins: ["https://patchmark.test"],
    includeQualificationDiagnostics,
    onPairingCode(value) { pairingCode = value; },
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
    const bytes = Buffer.from("synthetic wire request");
    return await jsonRequest({
      body: {
        expected_response_protocol: "patchmark.comment_reply_import",
        expected_response_protocol_version: 2,
        max_response_bytes: 4096,
        operation_id: "ae3_slice2c_structural_failure",
        protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
        request_base64: bytes.toString("base64"),
        request_byte_length: bytes.byteLength,
        request_sha256: createHash("sha256").update(bytes).digest("hex")
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
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      headers: {
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
      response.on("end", () => resolve({
        headers: response.headers,
        json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        status: response.statusCode
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(bytes);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CODEX_EXEC_ITEM_CLASSIFICATIONS,
  CodexAdapterError,
  CodexExecAdapter,
  createCodexEnvironment,
  extractFinalAgentMessage,
  isCodex01510StreamIntegrityWarning,
  isCodexProviderFailureDiagnostic
} from "../local-connector/codex-exec-adapter.ts";

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

assert.deepEqual(CODEX_EXEC_ITEM_CLASSIFICATIONS, {
  agent_message: "authoritative",
  collab_tool_call: "forbidden_authority",
  command_execution: "forbidden_authority",
  error: "non_fatal_diagnostic",
  file_change: "forbidden_authority",
  mcp_tool_call: "forbidden_authority",
  reasoning: "inert_metadata",
  todo_list: "inert_metadata",
  web_search: "forbidden_authority"
});
checks.push("the explicit 0.151.0 item classification table separates diagnostics from fatal and authority events");

const latestRealLifecycle = [
  events.thread_started,
  events.turn_started,
  events.runtime_warning_completed,
  events.agent_message_completed,
  events.turn_completed
];
assert.throws(
  () => legacyItemErrorFatalityGuard(latestRealLifecycle),
  /legacy_item_error_fatal/
);
assert.deepEqual(extractFinalAgentMessage(jsonl(latestRealLifecycle)), {
  completed: true,
  failureCode: null,
  finalMessage: "synthetic assistant response"
});
checks.push("the primary regression changes item error plus final response plus turn.completed from legacy failure to success");

assert.deepEqual(
  extractFinalAgentMessage(
    jsonl([
      events.thread_started,
      events.pre_turn_error_completed,
      events.turn_started,
      events.agent_message_completed,
      events.turn_completed
    ])
  ),
  {
    completed: true,
    failureCode: null,
    finalMessage: "synthetic assistant response"
  }
);
checks.push("a non-fatal warning before turn.started remains diagnostic and does not replace the assistant response");

for (const scenario of [
  "item-warning-success",
  "pre-turn-item-warning-success",
  "multiple-item-warning-success"
]) {
  assert.equal(await successfulText(scenario), "synthetic final response");
}
checks.push("one, pre-turn, and multiple item warnings all succeed under the complete terminal contract");

const turnFailed = await providerFailure("item-warning-turn-failed");
assertDiagnostic(turnFailed, {
  failure_source: "turn_failed",
  item_error_count: 1,
  item_error_phase: "in_turn",
  item_error_seen: true,
  stream_integrity_compromised: false,
  terminal_event_seen: true,
  turn_failed_seen: true,
  turn_status: "failed"
});

const nonzero = await providerFailure("item-warning-nonzero");
assertDiagnostic(nonzero, {
  exit_code: 7,
  failure_source: "process_exit",
  final_response_seen: true,
  item_error_count: 1,
  item_error_seen: true,
  stream_integrity_compromised: false,
  terminal_event_seen: true,
  turn_failed_seen: false,
  turn_status: "completed"
});
checks.push("turn.failed and non-zero exit remain independently fatal when an item warning is present");

await assertProtocolFailure(
  "item-warning-missing-final",
  "ambiguous_final_response"
);
await assertProtocolFailure(
  "item-warning-unknown-event",
  "unsupported_event_type"
);
await assertProtocolFailure(
  "item-warning-forbidden-tool",
  "forbidden_tool_event"
);
checks.push("missing final response, unknown event, and forbidden authority still fail closed after a warning");

const topLevel = await providerFailure("top-level-error-completed");
assertDiagnostic(topLevel, {
  exit_code: 0,
  failure_source: "top_level_error",
  final_response_seen: true,
  item_error_count: 0,
  item_error_seen: false,
  terminal_event_seen: true,
  top_level_error_seen: true,
  turn_failed_seen: false,
  turn_status: "completed"
});
checks.push("a top-level error remains fatal even with a final response, turn.completed, and exit zero");

assert.equal(
  isCodex01510StreamIntegrityWarning(
    "in-process app-server event stream lagged; dropped 7 events"
  ),
  true
);
for (const nonMatch of [
  "in-process app-server event stream lagged; dropped events",
  "warning: event stream lagged; dropped 7 events",
  "synthetic non-fatal runtime warning"
]) {
  assert.equal(isCodex01510StreamIntegrityWarning(nonMatch), false);
}
const streamIntegrity = await providerFailure("stream-integrity-warning");
assertDiagnostic(streamIntegrity, {
  exit_code: 0,
  failure_source: "stream_integrity",
  final_response_seen: true,
  item_error_count: 1,
  item_error_phase: "in_turn",
  item_error_seen: true,
  stream_integrity_compromised: true,
  terminal_event_seen: true,
  turn_status: "completed"
});
checks.push("the exact version-specific dropped-event warning is isolated and fails closed without broad prose matching");

for (const diagnostic of [turnFailed, nonzero, topLevel, streamIntegrity]) {
  const serialized = JSON.stringify(diagnostic);
  for (const raw of [
    "synthetic non-fatal runtime warning",
    "synthetic turn failure",
    "synthetic top-level error",
    "in-process app-server event stream lagged"
  ]) {
    assert.equal(serialized.includes(raw), false, raw);
  }
}
checks.push("qualification diagnostics retain bounded counts, phase, and fingerprints without provider prose");

process.stdout.write(
  `${JSON.stringify(
    {
      checks,
      codex_live_model_calls: 0,
      corrected_wire_target: "0.151.0",
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

function exchange(scenario) {
  return new CodexExecAdapter({
    environment: {
      ...createCodexEnvironment(process.env),
      PATCHMARK_FAKE_CODEX_SCENARIO: scenario,
      PATCHMARK_FAKE_RESPONSE_BASE64: Buffer.from(
        "synthetic final response"
      ).toString("base64")
    },
    executable: fakeCodex,
    operationTimeoutMs: 2_000
  }).exchange({
    maxResponseBytes: 4_096,
    requestBytes: new TextEncoder().encode("synthetic Slice 2D request"),
    signal: new AbortController().signal
  });
}

async function successfulText(scenario) {
  return new TextDecoder().decode(await exchange(scenario));
}

async function providerFailure(scenario) {
  try {
    await exchange(scenario);
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

async function assertProtocolFailure(scenario, category) {
  await assert.rejects(exchange(scenario), (error) => {
    return (
      error instanceof CodexAdapterError &&
      error.code === "connector_protocol_error" &&
      error.diagnostic?.category === category &&
      error.qualificationDiagnostic === null
    );
  });
}

function assertDiagnostic(diagnostic, expected) {
  assert.equal(isCodexProviderFailureDiagnostic(diagnostic), true);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(diagnostic[key], value, key);
  }
}

function legacyItemErrorFatalityGuard(sequence) {
  for (const event of sequence) {
    if (event.type === "item.completed" && event.item?.type === "error") {
      throw new Error("legacy_item_error_fatal");
    }
  }
}

function jsonl(sequence) {
  return Buffer.from(
    `${sequence.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
}

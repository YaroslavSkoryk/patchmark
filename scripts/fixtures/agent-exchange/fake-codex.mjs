#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.argv[2] === "--version") {
  process.stdout.write(
    `codex-cli ${process.env.PATCHMARK_FAKE_CODEX_VERSION ?? "0.151.0"}\n`
  );
  process.exit(0);
}

const inputChunks = [];
for await (const chunk of process.stdin) inputChunks.push(chunk);
const input = Buffer.concat(inputChunks);
if (process.env.PATCHMARK_FAKE_CAPTURE_PATH) {
  writeFileSync(
    process.env.PATCHMARK_FAKE_CAPTURE_PATH,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      environmentKeys: Object.keys(process.env).sort(),
      stdinBase64: input.toString("base64")
    })
  );
}

const scenario = process.env.PATCHMARK_FAKE_CODEX_SCENARIO ?? "success";
const wireFixtures = JSON.parse(
  readFileSync(
    new URL("./codex-0.151.0-wire-fixtures.json", import.meta.url),
    "utf8"
  )
).events;
const finalText = Buffer.from(
  process.env.PATCHMARK_FAKE_RESPONSE_BASE64 ?? "e30=",
  "base64"
).toString("utf8");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fixture = (name) => structuredClone(wireFixtures[name]);
const begin = () => {
  emit(fixture("thread_started"));
  emit(fixture("turn_started"));
};
const final = (text = finalText) => {
  const event = fixture("agent_message_completed");
  event.item.text = text;
  emit(event);
};
const complete = () => emit(fixture("turn_completed"));

function patchmarkResponse() {
  const prompt = input.toString("utf8");
  let request;
  for (const match of prompt.matchAll(/```json\r?\n([\s\S]+?)\r?\n```/g)) {
    try {
      const candidate = JSON.parse(match[1]);
      if (candidate?.protocol === "patchmark.comment_export") {
        request = candidate;
        break;
      }
    } catch {
      // Only the canonical comment-export block is relevant to this fake.
    }
  }
  if (!request) throw new Error("The fake expected a Patchmark JSON prompt block.");
  const batch = request.review_batch;
  const commentId = request.comments?.[0]?.comment_id;
  return JSON.stringify({
    protocol: "patchmark.comment_reply_import",
    protocol_version: 2,
    review_batch_id: batch.review_batch_id,
    project_id: batch.project_id,
    document_id: batch.document_id,
    summary: "Deterministic local connector qualification response.",
    replies: [
      {
        comment_id: commentId,
        reply: "The local Codex connector returned this review reply.",
        reply_sources: [],
        suggested_user_action: "review"
      }
    ],
    patch_proposals: [],
    open_questions: []
  });
}

switch (scenario) {
  case "success":
    begin();
    final();
    complete();
    break;
  case "metadata-lifecycle":
    begin();
    emit(fixture("reasoning_completed"));
    emit(fixture("todo_list_started"));
    emit(fixture("todo_list_updated"));
    emit(fixture("todo_list_completed"));
    final();
    complete();
    break;
  case "item-warning-success":
    begin();
    emit(fixture("runtime_warning_completed"));
    final();
    complete();
    break;
  case "pre-turn-item-warning-success":
    emit(fixture("thread_started"));
    emit(fixture("pre_turn_error_completed"));
    emit(fixture("turn_started"));
    final();
    complete();
    break;
  case "multiple-item-warning-success":
    begin();
    emit(fixture("runtime_warning_completed"));
    {
      const secondWarning = fixture("runtime_warning_completed");
      secondWarning.item.id = "item_runtime_warning_2";
      secondWarning.item.message = "synthetic second non-fatal runtime warning";
      emit(secondWarning);
    }
    final();
    complete();
    break;
  case "patchmark-item-warning-success":
    begin();
    emit(fixture("runtime_warning_completed"));
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 0));
    final(patchmarkResponse());
    complete();
    break;
  case "delay":
    begin();
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 250));
    final();
    complete();
    break;
  case "patchmark-delay":
    begin();
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 250));
    final(patchmarkResponse());
    complete();
    break;
  case "cancel-race":
    begin();
    await delay(40);
    final();
    complete();
    await delay(80);
    break;
  case "authentication-required":
    begin();
    {
      const event = fixture("turn_failed");
      event.error.message = "synthetic authentication required";
      event.error.code = "authentication_required";
      emit(event);
    }
    process.exitCode = 1;
    break;
  case "provider-failed":
    begin();
    {
      const event = fixture("turn_failed");
      event.error.message = "synthetic provider unavailable";
      emit(event);
    }
    process.exitCode = 1;
    break;
  case "top-level-error":
    {
      const event = fixture("top_level_error");
      event.message = "synthetic provider error";
      emit(event);
    }
    process.exitCode = 1;
    break;
  case "top-level-and-turn-failed": {
    const message = "synthetic matching provider failure";
    begin();
    const topLevel = fixture("top_level_error");
    topLevel.message = message;
    emit(topLevel);
    const failed = fixture("turn_failed");
    failed.error.message = message;
    emit(failed);
    process.exitCode = 9;
    break;
  }
  case "top-level-error-completed":
    begin();
    emit(fixture("top_level_error"));
    final();
    complete();
    break;
  case "item-error":
    begin();
    {
      const event = fixture("pre_turn_error_completed");
      event.item.message = "synthetic provider error";
      emit(event);
    }
    process.exitCode = 1;
    break;
  case "item-warning-turn-failed":
    begin();
    emit(fixture("runtime_warning_completed"));
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 0));
    emit(fixture("turn_failed"));
    process.exitCode = 1;
    break;
  case "item-warning-nonzero":
    begin();
    emit(fixture("runtime_warning_completed"));
    final();
    complete();
    process.exitCode = 7;
    break;
  case "item-warning-missing-final":
    begin();
    emit(fixture("runtime_warning_completed"));
    complete();
    break;
  case "item-warning-unknown-event":
    begin();
    emit(fixture("runtime_warning_completed"));
    emit({ type: "turn.maybe_completed" });
    break;
  case "item-warning-forbidden-tool":
    begin();
    emit(fixture("runtime_warning_completed"));
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 0));
    emit(fixture("command_execution_started"));
    final();
    complete();
    break;
  case "stream-integrity-warning":
    begin();
    emit(fixture("stream_integrity_warning_completed"));
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 0));
    final();
    complete();
    break;
  case "pre-turn-error":
    emit(fixture("thread_started"));
    emit(fixture("pre_turn_error_completed"));
    emit(fixture("turn_started"));
    emit(fixture("turn_failed"));
    process.exitCode = 1;
    break;
  case "nonzero":
    begin();
    final();
    complete();
    process.exitCode = 7;
    break;
  case "signal-exit":
    begin();
    process.kill(process.pid, "SIGTERM");
    break;
  case "stderr-only":
    process.stderr.write("SYNTHETIC_STDERR_DO_NOT_EXPOSE\n");
    process.exitCode = 11;
    break;
  case "malformed":
    process.stdout.write("{not-json}\n");
    break;
  case "unknown-critical":
    begin();
    emit({ type: "turn.maybe_completed" });
    break;
  case "unknown-item":
    begin();
    emit({
      item: { id: "fake-unknown", status: "pending", type: "response_metadata" },
      type: "item.started"
    });
    break;
  case "missing-final":
    begin();
    complete();
    break;
  case "failure-after-inert-metadata":
    begin();
    emit(fixture("reasoning_completed"));
    emit(fixture("todo_list_completed"));
    {
      const event = fixture("turn_failed");
      event.error.message = "SYNTHETIC_PROVIDER_MESSAGE_DO_NOT_EXPOSE";
      emit(event);
    }
    process.exitCode = 12;
    break;
  case "multiple-final":
    begin();
    final("superseded");
    final();
    complete();
    break;
  case "ambiguous-final":
    begin();
    final();
    complete();
    final("late");
    break;
  case "tool-item":
    begin();
    emit(fixture("command_execution_started"));
    break;
  case "forbidden-item":
    begin();
    {
      const itemType = process.env.PATCHMARK_FAKE_ITEM_TYPE ?? "command_execution";
      const fixtureName = {
        collab_tool_call: "collab_tool_call_started",
        command_execution: "command_execution_started",
        error: "pre_turn_error_completed",
        file_change: "file_change_completed",
        mcp_tool_call: "mcp_tool_call_started",
        web_search: "web_search_started"
      }[itemType];
      const event = fixtureName
        ? fixture(fixtureName)
        : { item: { id: "unknown-item", type: itemType }, type: "item.started" };
      event.type = process.env.PATCHMARK_FAKE_TOP_LEVEL_TYPE ?? event.type;
      if (Object.hasOwn(event.item, "status")) {
        event.item.status =
          process.env.PATCHMARK_FAKE_ITEM_STATUS ?? event.item.status;
      }
      emit(event);
    }
    break;
  case "forbidden-item-hang":
    begin();
    emit({
      item: { id: "forbidden-item", status: "in_progress", type: "command_execution" },
      type: "item.started"
    });
    await new Promise(() => undefined);
    break;
  case "stdout-oversized":
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    break;
  case "stderr-oversized":
    process.stderr.write("x".repeat(96 * 1024));
    await delay(100);
    break;
  case "hang":
    begin();
    await delay(60 * 60 * 1000);
    break;
  case "hang-with-child": {
    begin();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { shell: false, stdio: "ignore" }
    );
    if (process.env.PATCHMARK_FAKE_CHILD_PID_PATH) {
      writeFileSync(process.env.PATCHMARK_FAKE_CHILD_PID_PATH, String(child.pid));
    }
    await new Promise(() => undefined);
    break;
  }
  default:
    process.stderr.write("unknown fake scenario\n");
    process.exitCode = 64;
}

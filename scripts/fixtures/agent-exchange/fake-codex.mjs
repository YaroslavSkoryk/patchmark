#!/usr/bin/env node

import { writeFileSync } from "node:fs";
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
const finalText = Buffer.from(
  process.env.PATCHMARK_FAKE_RESPONSE_BASE64 ?? "e30=",
  "base64"
).toString("utf8");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const begin = () => {
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
};
const final = (text = finalText) =>
  emit({
    item: { id: "fake-message", text, type: "agent_message" },
    type: "item.completed"
  });

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
    emit({ type: "turn.completed", usage: {} });
    break;
  case "delay":
    begin();
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 250));
    final();
    emit({ type: "turn.completed", usage: {} });
    break;
  case "patchmark-delay":
    begin();
    await delay(Number(process.env.PATCHMARK_FAKE_DELAY_MS ?? 250));
    final(patchmarkResponse());
    emit({ type: "turn.completed", usage: {} });
    break;
  case "cancel-race":
    begin();
    await delay(40);
    final();
    emit({ type: "turn.completed", usage: {} });
    await delay(80);
    break;
  case "authentication-required":
    begin();
    emit({ error: { code: "authentication_required" }, type: "turn.failed" });
    process.exitCode = 1;
    break;
  case "provider-failed":
    begin();
    emit({ error: { code: "provider_unavailable" }, type: "turn.failed" });
    process.exitCode = 1;
    break;
  case "nonzero":
    begin();
    final();
    emit({ type: "turn.completed", usage: {} });
    process.exitCode = 7;
    break;
  case "malformed":
    process.stdout.write("{not-json}\n");
    break;
  case "unknown-critical":
    begin();
    emit({ type: "turn.maybe_completed" });
    break;
  case "missing-final":
    begin();
    emit({ type: "turn.completed", usage: {} });
    break;
  case "multiple-final":
    begin();
    final("superseded");
    final();
    emit({ type: "turn.completed", usage: {} });
    break;
  case "ambiguous-final":
    begin();
    final();
    emit({ type: "turn.completed", usage: {} });
    final("late");
    break;
  case "tool-item":
    begin();
    emit({
      item: { command: "pwd", id: "forbidden-tool", type: "command_execution" },
      type: "item.started"
    });
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
    await new Promise(() => undefined);
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

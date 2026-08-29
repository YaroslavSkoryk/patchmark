import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AgentExchangeOperationController } from "../lib/agent-exchange/operation-controller.ts";
import {
  agentExchangeDisabled,
  getAgentExchangeProductQualificationState,
  loadAgentExchangeProductQualification
} from "../lib/agent-exchange/entrypoint.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const runtime = process.env.NODE_ENV === "production" ? "production" : "test";
const assertions = [];
const check = (value, message) => {
  assertions.push(message);
  assert.ok(value, message);
};

const entrypoint = await source("lib/agent-exchange/entrypoint.ts");
const loader = await source("lib/agent-exchange/qualification-loader.ts");
const driver = await source("lib/agent-exchange/product-driver.ts");
const actions = await source("components/agent-exchange/agent-exchange-actions.tsx");
const styles = await source("components/agent-exchange/agent-exchange-actions.module.css");
const editor = await source("components/document-editor.tsx");
const commentsPanel = await source("components/comments-panel.tsx");
const guidedReview = await source("components/guided-review/guided-review-wizard.tsx");
const nextConfig = await source("next.config.ts");
const release = await source("lib/release/product-release-state.ts");

check(/agent_exchange:\s*false/.test(release), "Agent Exchange release literal remains false");
check(/human_collaboration:\s*false/.test(release), "Human Collaboration release literal remains false");
check(entrypoint.includes('import("./qualification-loader.ts")'), "product implementation remains behind the qualification loader");
check(loader.includes("agent-exchange-actions.tsx"), "qualification loader alone owns the product UI edge");
check(loader.includes("product-driver.ts"), "qualification loader alone owns the injected driver edge");
check(nextConfig.includes("!productReleaseState.agent_exchange"), "production bundler removes the disabled Agent Exchange loader");
check(editor.includes('from "@/lib/agent-exchange/entrypoint"'), "DocumentEditor uses only the lightweight Agent Exchange entrypoint");
check(!/(?:operation-controller|prepared-exchange|product-driver|qualification-loader)/.test(editor), "DocumentEditor has no direct implementation import");
check(commentsPanel.includes("reviewDeliveryActions"), "Comments owns the adjacent review-delivery slot");
check(guidedReview.includes("renderProposalDeliveryAction"), "Guided Review proposal owns the same-scope delivery slot");
check(guidedReview.includes("activeBatchDeliveryActions"), "Guided Review active batch owns exact-snapshot delivery actions");

for (const label of [
  "Send to agent",
  "Sending",
  "Waiting for agent",
  "Agent response ready",
  "Review replies and suggestions",
  "Couldn’t reach agent",
  "Use manual export instead",
  "Cancel"
]) {
  check(actions.includes(label), `qualification UI exposes ${label}`);
  if (label !== "Cancel") {
    check(!editor.includes(label), `production shell contains no ${label} product copy`);
  }
}
check(actions.includes('role="status"'), "operational status uses a status role");
check(actions.includes('aria-live="polite"'), "operational status uses a polite live region");
check(styles.includes("overflow-wrap: anywhere"), "long bounded errors wrap");
check(styles.includes("forced-colors: active"), "forced-colors focus and border rules exist");
check(styles.includes("prefers-reduced-motion: reduce"), "reduced-motion rules exist");
check(styles.includes("max-width: 100%"), "operational surface is fluid");
check(driver.includes("createConnector"), "driver constructs a connector only through explicit product initiation");
check(!/(?:fetch\s*\(|WebSocket|RTCPeerConnection|indexedDB|localStorage|sessionStorage|setTimeout|setInterval|new\s+Worker)/.test(driver), "qualification driver seam owns no ambient capability");
check(editor.includes("reviewBatchExportLockRef.current"), "tracked export has a synchronous re-entry lock");
check(editor.includes("agentExchangeInitiationLockRef.current"), "operation initiation has a synchronous re-entry lock");
check(editor.includes("copy_manual_fallback_bytes()"), "manual fallback copies the operation's Prepared Exchange bytes");
check(editor.includes("importProjectCommentReplyResponseBytes"), "automatic transport reuses the strict shared byte importer");
check(editor.includes("invalidateAgentExchangeForNavigation"), "project/document navigation invalidates transient ownership");
check(editor.includes("openComments();"), "response review returns to the existing Comments surface");

const phaseEvidence = [];
let resolveResponse;
const responsePromise = new Promise((resolve) => {
  resolveResponse = resolve;
});
const prepared = Object.freeze({
  authority: "none",
  copy_request_bytes: () => new Uint8Array([1, 2, 3]),
  expected_response_protocol: "patchmark.comment_reply_import",
  expected_response_protocol_version: 2,
  max_response_bytes: 1024,
  project_id: "project",
  request_byte_length: 3,
  request_sha256: "a".repeat(64),
  review_batch_id: "review_batch_slice2",
  scope: Object.freeze({
    batch_type: "manual",
    document_id: "document",
    kind: "document",
    source: "manual"
  })
});
const connector = {
  descriptor: Object.freeze({ id: "qualification.slice2", version: "1" }),
  async checkAvailability() {
    return { status: "available" };
  },
  async submit({ binding }) {
    await responsePromise;
    const response = new TextEncoder().encode("{}");
    return {
      binding: {
        ...binding,
        response_byte_length: response.byteLength,
        response_protocol: "patchmark.comment_reply_import",
        response_protocol_version: 2
      },
      response_bytes: response
    };
  },
  close() {}
};
const controller = new AgentExchangeOperationController();
const operation = controller.begin({
  connector,
  createOperationId: () => "agent_exchange_slice2_phase_test",
  importResponse: async () => "imported",
  prepared
});
operation.subscribe((phase) => phaseEvidence.push(phase));
const execution = operation.execute();
await Promise.resolve();
await Promise.resolve();
check(phaseEvidence.includes("submitting"), "typed operation reports submission");
check(phaseEvidence.includes("waiting"), "typed operation reports the distinct wait state");
resolveResponse();
assert.equal(await execution, "imported");
assert.equal(operation.phase(), "completed");

if (runtime === "production") {
  assert.equal(
    getAgentExchangeProductQualificationState("agent_exchange_qualification").mode,
    "disabled"
  );
  assert.equal(
    loadAgentExchangeProductQualification("agent_exchange_qualification"),
    agentExchangeDisabled
  );
}

process.stdout.write(`${JSON.stringify({
  assertions: assertions.length,
  phaseEvidence,
  productionRelease: { agent_exchange: false, human_collaboration: false },
  status: "ok"
}, null, 2)}\n`);

function source(path) {
  return readFile(join(root, path), "utf8");
}

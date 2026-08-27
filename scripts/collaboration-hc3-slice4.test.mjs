import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createHc3ProductAuthorityDriver,
  detectHc3ProductCapabilities,
  parseHc3ProductAuthorityEvidence,
  parseHc3ProductSnapshot,
  unavailableHc3ProductSnapshot,
  validateHc3ProductActionInput
} from "../lib/collaboration/hc3/index.ts";
import { Hc3ExplicitQrScanner } from "../lib/collaboration/hc3/qr-scanner.ts";
import { decodeHc3QrImage, renderHc3QrMatrix } from "../lib/collaboration/hc3/qr-provider.ts";
import {
  getCollaborationProductQualificationState,
  loadCollaborationProductQualification
} from "../lib/collaboration-shadow/entrypoint.ts";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (actual, message) => { assertions += 1; assert.ok(actual, message); };
const throws = (operation, pattern, message) => { assertions += 1; assert.throws(operation, pattern, message); };
const rejects = async (operation, pattern, message) => { assertions += 1; await assert.rejects(operation, pattern, message); };

const slice1 = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc3-slice1-v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc3-slice4-v1.json", import.meta.url), "utf8"));
const invitation = slice1.expected.invitation.canonical_text;
const qr = renderHc3QrMatrix({ artifact_kind: "handoff", text: invitation });
equal(qr.exact_text, invitation, "QR encodes the exact strict HC-3 text");
equal({ error_correction: qr.error_correction, encoding: qr.encoding, mask: qr.mask, border_modules: qr.border_modules, module_count: qr.module_count }, {
  error_correction: fixture.expected.error_correction,
  encoding: fixture.expected.encoding,
  mask: fixture.expected.mask,
  border_modules: fixture.expected.border_modules,
  module_count: fixture.expected.module_count
}, "QR settings and dimensions equal literal frozen expectations");
equal(createHash("sha256").update(Buffer.from(qr.cells.flat().map(Number))).digest("hex"), fixture.expected.matrix_sha256, "QR matrix equals its frozen independent digest");
equal(decodeHc3QrImage(raster(qr, 4)), invitation, "local image decoder returns the exact strict artifact");
throws(() => renderHc3QrMatrix({ artifact_kind: "handoff", text: `${invitation}x` }), /checksum|invalid|decode/i, "QR rendering rejects substituted artifacts");
throws(() => renderHc3QrMatrix({ artifact_kind: "handoff", text: "x".repeat(2_954) }), /eligible/i, "QR rendering enforces the frozen single-symbol limit before encoding");

const blocked = unavailableHc3ProductSnapshot({ project_id: "project-local-1", project_title: "Example project" });
equal([blocked.authority, blocked.stage, blocked.technical_diagnostic_code], ["none", "blocked", "qualification_driver_unavailable"], "missing injected authority is represented honestly");
const ready = productSnapshot({
  stage: "ready_to_invite",
  title: "Ready to invite",
  explanation: "Create an Invitation when the recovery kit is verified.",
  recommended_action: "create_invitation",
  available_actions: ["create_invitation"],
  recovery_kit_verified: true
});
equal(parseHc3ProductSnapshot(ready).available_actions, ["create_invitation"], "product snapshot is an authority-free validated presentation");
throws(() => parseHc3ProductSnapshot({ ...ready, recommended_action: "revoke_device" }), /currently available/i, "presentation cannot recommend an unauthorized action");
throws(() => parseHc3ProductSnapshot({ ...ready, explanation: "Show private key bytes" }), /secret-bearing/i, "presentation rejects secret-bearing guidance");
equal(validateHc3ProductActionInput({ action: "create_invitation", expected_revision: BigInt(3), project_id: "project-local-1", role: "reviewer" }), {
  action: "create_invitation", expected_revision: BigInt(3), project_id: "project-local-1", role: "reviewer"
}, "every UI action carries a current evidence revision and explicit role");
throws(() => validateHc3ProductActionInput({ action: "resolve_conflict", expected_revision: BigInt(3), project_id: "project-local-1", contender_ids: ["not-an-opaque-id"] }), /opaque/i, "conflict action cannot forge a non-opaque contender set");

const authorityRuntime = {
  async inspect() {
    return authorityEvidence("inspect", "durable_reconstruction", ready);
  },
  async invoke(input) {
    return authorityEvidence(input.action, "hc2_invitation_control", productSnapshot({
      revision: BigInt(8),
      stage: "waiting_for_response",
      title: "Invitation ready",
      explanation: "The accepted HC-2 invitation is ready for explicit handoff.",
      recommended_action: null,
      available_actions: ["cancel_invitation"],
      recovery_kit_verified: true
    }));
  }
};
const authorityDriver = createHc3ProductAuthorityDriver({ project_id: "project-local-1", runtime: authorityRuntime });
equal((await authorityDriver.inspect({ project_id: "project-local-1" })).revision, BigInt(7), "assembled driver reconstructs its presentation from durable authority evidence");
equal((await authorityDriver.invoke({ action: "create_invitation", expected_revision: BigInt(7), project_id: "project-local-1", role: "reviewer" })).revision, BigInt(8), "assembled driver accepts a correctly bound real HC-2 authority transition");
await rejects(() => authorityDriver.invoke({ action: "create_invitation", expected_revision: BigInt(7), project_id: "project-local-1", role: "reviewer" }), /stale/i, "assembled driver rejects a stale UI revision before authority invocation");
throws(() => parseHc3ProductAuthorityEvidence(authorityEvidence("create_invitation", "hc3_direct_v3", productSnapshot({ revision: BigInt(8) }))), /V3.*(?:digest|bytes)/i, "direct/V3 evidence cannot omit its exact transported-byte digest");

const originalEnvironment = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = "production";
  const productionState = getCollaborationProductQualificationState("development_shadow");
  equal(productionState.mode, "disabled", "production ignores the injected development qualification state");
  const productionDispatch = loadCollaborationProductQualification("development_shadow");
  check(!(productionDispatch instanceof Promise), "production gate returns synchronously before a dynamic import");
  equal(Object.isFrozen(productionDispatch), true, "production disabled result is frozen");
  process.env.NODE_ENV = "development";
  equal(getCollaborationProductQualificationState("development_shadow").mode, "development_shadow", "non-production accepts only explicit injected qualification state");
  equal(getCollaborationProductQualificationState("true").mode, "disabled", "arbitrary signals do not activate qualification");
} finally {
  process.env.NODE_ENV = originalEnvironment;
}

const matrix = await detectHc3ProductCapabilities({
  isSecureContext: true,
  navigator: { clipboard: { writeText: async () => undefined } },
  crypto: webcrypto,
  RTCPeerConnection: class {
    createDataChannel() { return { close() {} }; }
    close() {}
  },
  document: { createElement() {} }
});
equal(matrix.user_agent_inspected, false, "capabilities never rely on browser names");
equal(matrix.capabilities.find((entry) => entry.name === "webrtc_data_channels")?.state, "available", "explicit no-server data-channel probe reports capability");
equal(matrix.capabilities.find((entry) => entry.name === "indexeddb")?.state, "fallback", "missing durable storage maps to a declared blocked fallback");
equal(matrix.capabilities.length, 17, "all required capability categories are represented");

const scannerEvidence = fakeScanner(invitation);
const scanner = new Hc3ExplicitQrScanner(scannerEvidence.environment);
equal(await scanner.scan({ artifact_kind: "handoff", on_capability: (name) => scannerEvidence.capabilities.push(name) }), invitation, "explicit native scan parses through the strict HC-3 parser");
equal(scannerEvidence.capabilities, ["Camera with native QR detection"], "scanner reports the invoked capability");
equal(scannerEvidence.trackStops, 1, "successful scan stops every media track");
const cancelledEvidence = fakeScanner(null);
const cancelled = new Hc3ExplicitQrScanner(cancelledEvidence.environment);
const pending = cancelled.scan({ artifact_kind: "handoff", on_capability() {} });
await Promise.resolve();
await Promise.resolve();
cancelled.cancel();
await rejects(() => pending, /cancelled/i, "explicit cancellation rejects the pending scan");
equal(cancelledEvidence.trackStops, 1, "cancelled scan stops every media track");

process.stdout.write(`${JSON.stringify({ assertions, qr_provider: "qr@0.6.0", qr_matrix_sha256: fixture.expected.matrix_sha256, capability_categories: matrix.capabilities.length, production_gate: "disabled_sync_frozen", status: "ok" }, null, 2)}\n`);

function raster(value, scale) {
  const width = value.module_count * scale;
  const rgba = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) {
    const dark = value.cells[Math.floor(y / scale)][Math.floor(x / scale)];
    const offset = (y * width + x) * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = dark ? 0 : 255;
    rgba[offset + 3] = 255;
  }
  return { artifact_kind: value.artifact_kind, width, height: width, rgba };
}

function productSnapshot(overrides = {}) {
  return {
    schema_version: 1, record_kind: "hc3_product_qualification_snapshot", authority: "none", revision: BigInt(7),
    project_id: "project-local-1", project_title: "Example project", stage: "setup_required", title: "Set up collaboration",
    explanation: "Create a separate collaboration copy.", recommended_action: "create_collaboration_copy",
    available_actions: ["create_collaboration_copy"], artifact: null, collaborators: [], conflicts: [], pending_invitation_count: 0,
    recovery_kit_verified: false, current_epoch_id: null, full_history_verified: null, source_project_immutable: true,
    direct_connection_state: "idle", encrypted_file_fallback_available: true, technical_diagnostic_code: null, ...overrides
  };
}

function authorityEvidence(action, boundary, snapshot) {
  return {
    schema_version: 1,
    record_kind: "hc3_product_authority_evidence",
    authority: "hc2_hc3",
    action,
    project_id: snapshot.project_id,
    revision: snapshot.revision,
    boundary,
    durable_revalidation: true,
    accepted_object_ids: ["pm:control-event:v1:aaaaaaaaaaaaaaaaaaaaaaaaaa"],
    exact_v3_sha256: null,
    snapshot
  };
}

function fakeScanner(decoded) {
  let trackStops = 0;
  const listeners = new Map();
  const track = { stop() { trackStops += 1; } };
  const video = { muted: false, playsInline: false, srcObject: null, async play() {} };
  const environment = {
    document: { visibilityState: "visible", addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } },
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks() { return [track]; } }; } } },
    request_animation_frame(callback) { if (decoded) queueMicrotask(() => callback(0)); return 1; }, cancel_animation_frame() {},
    create_detector: () => ({ async detect() { return decoded ? [{ rawValue: decoded }] : []; } }), create_video: () => video
  };
  return { capabilities: [], environment, get trackStops() { return trackStops; } };
}

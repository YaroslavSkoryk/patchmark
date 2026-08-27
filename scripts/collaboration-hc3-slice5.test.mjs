import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  classifyHc3CapabilityOperationFailure,
  containsSensitiveDiagnosticMaterial,
  createHc3BrowserPorts,
  createHc3EncryptedBundleSelectionAdapter,
  detectHc3ProductCapabilities,
  hc3ProductCapabilityNames,
  hc3ProductCapabilityStates,
  safeHc3DiagnosticMessage,
  safeHc3DisplayLabel
} from "../lib/collaboration/hc3/index.ts";
import { Hc3ExplicitQrScanner } from "../lib/collaboration/hc3/qr-scanner.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const slice1 = JSON.parse(await readFile(new URL("./fixtures/collaboration-hc3-slice1-v1.json", import.meta.url), "utf8"));
const invitation = slice1.expected.invitation.canonical_text;
let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (actual, message) => { assertions += 1; assert.ok(actual, message); };
const rejects = async (operation, pattern, message) => { assertions += 1; await assert.rejects(operation, pattern, message); };

equal(hc3ProductCapabilityStates, [
  "supported", "unsupported", "permission_required", "permission_denied",
  "temporarily_unavailable", "lost_during_operation", "incompatible_result", "not_exercised"
], "capability state contract is exact and exhaustive");

let peersClosed = 0;
let channelsClosed = 0;
const matrix = await detectHc3ProductCapabilities({
  isSecureContext: true,
  navigator: {
    clipboard: { async writeText() {} },
    async share() {},
    canShare() { return false; }
  },
  document: { createElement() {} },
  crypto: webcrypto,
  createImageBitmap: async () => { throw new Error("not invoked"); },
  showOpenFilePicker() {},
  showSaveFilePicker() {},
  BarcodeDetector: class { static async getSupportedFormats() { return ["code_128"]; } },
  RTCPeerConnection: class {
    createDataChannel() { return { ordered: true, close() { channelsClosed += 1; } }; }
    close() { peersClosed += 1; }
  }
});
equal(matrix.authority, "none", "capability evidence has no authority");
equal(matrix.permission_bearing_operations_invoked, false, "entry probe invokes no permission-bearing operation");
equal(matrix.user_agent_inspected, false, "capability decisions do not inspect a user agent");
equal(matrix.capabilities.length, hc3ProductCapabilityNames.length, "every required capability is present once");
equal(matrix.capabilities.find((entry) => entry.name === "clipboard_write")?.state, "permission_required", "clipboard permission is deferred to its user action");
equal(matrix.capabilities.find((entry) => entry.name === "camera_access")?.state, "unsupported", "camera absence is explicit without prompting");
equal(matrix.capabilities.find((entry) => entry.name === "native_qr_scanning")?.state, "incompatible_result", "native detector without QR support is incompatible, not supported");
equal(matrix.capabilities.find((entry) => entry.name === "web_share_files")?.state, "incompatible_result", "canShare functional rejection is not inferred as support");
equal([channelsClosed, peersClosed], [1, 1], "WebRTC capability probe closes channel and peer");

const denied = classifyHc3CapabilityOperationFailure({
  capability: "clipboard_write", phase: "before_operation", error: named("NotAllowedError"),
  fallback: "manual_copy", resources_released: true
});
equal([denied.state, denied.recovery, denied.automatic_retry, denied.prepared_artifact_preserved], ["permission_denied", "use_fallback", false, true], "permission denial is typed, recoverable and never retries automatically");
const revoked = classifyHc3CapabilityOperationFailure({
  capability: "camera_access", phase: "during_operation", error: named("NotAllowedError"),
  fallback: "image_or_paste", resources_released: true
});
equal([revoked.state, revoked.resources_released], ["lost_during_operation", true], "permission loss during an operation is distinct and records cleanup");
equal(classifyHc3CapabilityOperationFailure({ capability: "indexeddb", phase: "during_operation", error: named("QuotaExceededError"), fallback: null, resources_released: true }).state, "temporarily_unavailable", "quota pressure is typed without inventing replacement authority");
equal(classifyHc3CapabilityOperationFailure({ capability: "web_share_files", phase: "result_validation", error: named("TypeError"), fallback: "save_file", resources_released: true }).state, "incompatible_result", "an incompatible platform result selects a declared fallback");

let authorityMutations = 0;
let clipboardAttempts = 0;
let shareAttempts = 0;
const presentationPorts = createHc3BrowserPorts({
  is_secure_context: true,
  navigator: {
    clipboard: { async writeText(text) { clipboardAttempts += 1; check(text === invitation, "clipboard receives exact prepared text"); throw named("NotAllowedError"); } },
    async share(data) { shareAttempts += 1; check(data.text === invitation, "share receives exact prepared text"); throw named("AbortError"); }
  }
});
equal((await presentationPorts.clipboard.writeText({ text: invitation })).status, "permission_denied", "clipboard denial fails safely");
equal((await presentationPorts.share.share({ mode: "text", text: invitation, title: "Invitation" })).status, "cancelled", "share cancellation remains normal and recoverable");
equal([clipboardAttempts, shareAttempts, authorityMutations], [1, 1, 0], "presentation failure and success paths never mutate authority");

let committedWrite = null;
let abortedWrites = 0;
const failingSave = createHc3BrowserPorts({
  is_secure_context: true,
  async show_save_file_picker() {
    return { async createWritable() { return {
      async write(bytes) { committedWrite = Uint8Array.from(bytes); },
      async close() { throw named("QuotaExceededError"); },
      async abort() { abortedWrites += 1; }
    }; } };
  }
});
const exactBundle = Uint8Array.from([9, 8, 7, 6, 5]);
equal((await failingSave.save.save({ exact_bytes: exactBundle, filename: "update.pmcb", media_type: "application/vnd.patchmark.collaboration-bundle" })).status, "failed", "save failure after write is typed without changing committed V3 bytes");
equal([...committedWrite], [...exactBundle], "save port writes the exact prepared bytes before the induced close failure");
equal(abortedWrites, 1, "failed native save aborts its writable handle");

let revokedUrls = 0;
const download = createHc3BrowserPorts({
  is_secure_context: true,
  create_blob(parts) { return Uint8Array.from(parts[0]); },
  create_object_url() { return "blob:patchmark-slice5"; },
  revoke_object_url(url) { if (url === "blob:patchmark-slice5") revokedUrls += 1; },
  create_anchor() { return { href: "", download: "", rel: "", click() { throw new Error("download interrupted"); }, remove() {} }; }
});
equal((await download.save.save({ exact_bytes: exactBundle, filename: "update.pmcb", media_type: "application/vnd.patchmark.collaboration-bundle" })).status, "failed", "interrupted download fails without presenting authority success");
equal(revokedUrls, 1, "object URL is revoked when download setup throws");

for (const [label, size, bytes] of [
  ["partial", 5, [1, 2, 3]],
  ["appended", 3, [1, 2, 3, 4]],
  ["truncated", 6, [1, 2, 3, 4, 5]]
]) {
  const selection = createHc3EncryptedBundleSelectionAdapter({
    is_secure_context: true,
    async show_open_file_picker() { return [{ async getFile() { return { size, type: "application/vnd.patchmark.collaboration-bundle", name: `${label}.pmcb`, async arrayBuffer() { return Uint8Array.from(bytes).buffer; } }; } }]; }
  });
  equal((await selection.select({ maximum_byte_length: 1024n })).status, "failed", `${label} read is rejected before preview`);
}
const selectedSource = Uint8Array.from([1, 3, 3, 7]);
const hintOnly = createHc3EncryptedBundleSelectionAdapter({
  is_secure_context: true,
  async show_open_file_picker() { return [{ async getFile() { return { size: selectedSource.length, type: "text/plain", name: "looks-safe.txt", async arrayBuffer() { return selectedSource.buffer; } }; } }]; }
});
const selected = await hintOnly.select({ maximum_byte_length: 1024n });
equal(selected.status, "success", "MIME and extension remain non-authoritative hints when exact bytes are bounded");
if (selected.status === "success") {
  selectedSource.fill(0);
  equal([...selected.value.exact_bytes], [1, 3, 3, 7], "selection copies exact bytes so later file substitution cannot alter the previewed input");
}

const permissionHarness = scannerHarness({ getUserMediaError: named("NotAllowedError") });
await rejects(() => new Hc3ExplicitQrScanner(permissionHarness.environment).scan({ artifact_kind: "handoff", on_capability() {} }), /NotAllowedError/i, "camera denial fails before retaining a frame");
equal(permissionHarness.trackStops, 0, "camera denial creates no track to leak");

const endedHarness = scannerHarness({ detections: [] });
const endedScanner = new Hc3ExplicitQrScanner(endedHarness.environment);
const endedScan = endedScanner.scan({ artifact_kind: "handoff", on_capability() {} });
await settle();
endedHarness.endTrack();
await rejects(() => endedScan, /cancelled/i, "track ending during scanning cancels explicitly");
equal([endedHarness.trackStops, endedHarness.listenerCount], [1, 0], "track-end cleanup stops media and removes listeners");

const hiddenHarness = scannerHarness({ detections: [] });
const hiddenScanner = new Hc3ExplicitQrScanner(hiddenHarness.environment);
const hiddenScan = hiddenScanner.scan({ artifact_kind: "handoff", on_capability() {} });
await settle();
hiddenHarness.hidePage();
await rejects(() => hiddenScan, /cancelled/i, "visibility loss cancels scanning");
equal([hiddenHarness.trackStops, hiddenHarness.listenerCount], [1, 0], "visibility cleanup leaves no track or listener");

const malformedHarness = scannerHarness({ detections: [{ rawValue: `safe-looking-${"x".repeat(32)}` }] });
await rejects(() => new Hc3ExplicitQrScanner(malformedHarness.environment).scan({ artifact_kind: "handoff", on_capability() {} }), /invalid|format|carrier|malformed/i, "safe-looking malformed QR text fails strict parsing");
equal(malformedHarness.trackStops, 1, "malformed scanner result stops every track");

const repeatedHarness = scannerHarness({ detections: [] });
const repeatedScanner = new Hc3ExplicitQrScanner(repeatedHarness.environment);
const firstScan = repeatedScanner.scan({ artifact_kind: "handoff", on_capability() {} });
await settle();
await rejects(() => repeatedScanner.scan({ artifact_kind: "handoff", on_capability() {} }), /already active/i, "repeated scan cannot create a second camera operation");
repeatedScanner.cancel();
await rejects(() => firstScan, /cancelled/i, "explicit unmount-style cancellation rejects pending scan");
equal(repeatedHarness.trackStops, 1, "repeated scan cleanup stops one and only one track");

check(containsSensitiveDiagnosticMaterial(`failed at /Users/example/private-key pmhc3.${"a".repeat(200)}`), "secret-bearing diagnostic material is detected");
equal(safeHc3DiagnosticMessage(new Error(`open /Users/example/project pmhc3.${"a".repeat(200)}`)), "The operation failed safely. Technical code: collaboration_operation_failed.", "diagnostics redact artifact text and local absolute paths");
equal(safeHc3DisplayLabel("\u202eOwner<script>alert(1)</script>"), "Owner<script>alert(1)</script>", "bidi controls are removed while React retains text-only rendering");

const workspaceSource = await readFile(join(root, "components/collaboration/collaboration-qualification-workspace.tsx"), "utf8");
for (const pattern of [/dangerouslySetInnerHTML/, /\.innerHTML\s*=/, /insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function/]) {
  check(!pattern.test(workspaceSource), `integrated collaboration surface avoids injection sink ${pattern}`);
}
for (const requiredGuidance of ["not confidential", "approximate size and timing", "cannot erase", "non-extractable", "plaintext"]) {
  check(workspaceSource.toLowerCase().includes(requiredGuidance), `ordinary-language guidance covers ${requiredGuidance}`);
}
const hc3Sources = await sourceText(join(root, "lib", "collaboration", "hc3"));
check(!/console\.(?:log|info|warn|error|debug|table)\s*\(/.test(hc3Sources), "HC-3 runtime contains no artifact-bearing console diagnostics");
check(!/dangerouslySetInnerHTML|insertAdjacentHTML/.test(hc3Sources), "HC-3 runtime introduces no raw HTML interpolation");

const slice4Browser = await readFile(join(root, "scripts", "collaboration-hc3-slice4-browser.test.mjs"), "utf8");
for (const policyPart of ["default-src 'self'", "'strict-dynamic'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"]) {
  check(slice4Browser.includes(policyPart), `strict product qualification contains ${policyPart}`);
}
check(!slice4Browser.includes("unsafe-eval"), "strict qualification never admits unsafe-eval");
check(slice4Browser.includes("style-src-attr 'unsafe-inline'"), "the isolated profile records the narrow framework style-attribute exception");
const directAdapterSource = await readFile(join(root, "lib", "collaboration", "hc3", "direct-webrtc-adapter.ts"), "utf8");
check(directAdapterSource.includes("iceServers: Object.freeze([])"), "real WebRTC adapter retains an empty ICE-server list under the strict policy");

const readiness = JSON.parse(await readFile(join(root, "docs", "hc3", "readiness-slice5.json"), "utf8"));
equal([readiness.production_enabled, readiness.classification], [false, "conditional"], "readiness evidence cannot enable production and preserves conditional decision");
const requiredReadiness = [
  "real_authority_driver_integration", "production_lock", "project_copy_immutability", "recovery", "enrollment", "admission",
  "direct_synchronization", "encrypted_file_fallback", "conflict_resolution", "revocation", "durable_reopen", "non_extractable_custody",
  "storage_failure", "clipboard_share_file_permissions", "qr_rendering", "qr_scanning", "camera_lifecycle", "webrtc_reachability",
  "strict_csp", "trusted_types", "accessibility", "responsive_behavior", "multi_engine_coverage", "physical_device_coverage",
  "dependency_advisories", "qr_dependency_maintenance", "plaintext_at_rest", "metadata_exposure", "diagnostic_secrecy", "cleanup",
  "independent_security_review"
];
equal(readiness.items.map((entry) => entry.requirement), requiredReadiness, "machine-readable readiness matrix covers every mandatory decision item");
check(readiness.items.every((entry) => ["pass", "conditional", "blocked", "not_exercised"].includes(entry.status) && typeof entry.blocks_production_enablement === "boolean"), "readiness states are closed and explicitly blocking or non-blocking");
check(readiness.items.filter((entry) => entry.status !== "pass").every((entry) => entry.follow_up && entry.residual_risk), "missing evidence is never converted into a pass");

process.stdout.write(`${JSON.stringify({
  assertions,
  capability_categories: matrix.capabilities.length,
  capability_states: hc3ProductCapabilityStates,
  hostile_boundaries: ["clipboard", "share", "save", "download", "file_read", "camera", "visibility", "qr_parse", "diagnostics"],
  authority_mutations_from_presentation_failures: authorityMutations,
  readiness: readiness.classification,
  production_enabled: readiness.production_enabled,
  status: "ok"
}, null, 2)}\n`);

function named(name) {
  const error = new Error(`${name} induced by Slice 5 qualification`);
  error.name = name;
  return error;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function scannerHarness(input) {
  let trackStops = 0;
  const trackListeners = new Map();
  const documentListeners = new Map();
  const track = {
    stop() { trackStops += 1; },
    addEventListener(name, listener) { trackListeners.set(name, listener); },
    removeEventListener(name) { trackListeners.delete(name); }
  };
  const document = {
    visibilityState: "visible",
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    removeEventListener(name) { documentListeners.delete(name); }
  };
  const environment = {
    document,
    navigator: { mediaDevices: { async getUserMedia() { if (input.getUserMediaError) throw input.getUserMediaError; return { getTracks() { return [track]; } }; } } },
    request_animation_frame() { return 1; },
    cancel_animation_frame() {},
    create_detector: () => ({ async detect() { return input.detections ?? []; } }),
    create_video: () => ({ muted: false, playsInline: false, srcObject: null, async play() {} })
  };
  return {
    environment,
    get trackStops() { return trackStops; },
    get listenerCount() { return trackListeners.size + documentListeners.size; },
    endTrack() { trackListeners.get("ended")?.(); },
    hidePage() { document.visibilityState = "hidden"; documentListeners.get("visibilitychange")?.(); }
  };
}

async function sourceText(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(await sourceText(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) output.push(await readFile(path, "utf8"));
  }
  return output.join("\n");
}

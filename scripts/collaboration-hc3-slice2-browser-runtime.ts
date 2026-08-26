/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- qualification-only DOM driver crosses browser structural ports.
import {
  extractHc2HandoffPayload,
  Hc3DisabledManualWorkflow,
  parseHc3ArtifactText,
  portFailure,
  success
} from "../lib/collaboration/hc3/index.ts";
import { mountHc3Slice2QualificationSurface } from "./collaboration-hc3-slice2-surface.ts";

let surface = null;
let evidence = null;
let invitation = null;
let clipboardMode = "success";
let qrMode = "unsupported";
let shareMode = "cancelled";
const clipboardWrites = [];
const qrPayloads = [];
let shareCalls = 0;
let selectionCalls = 0;
let importCalls = 0;
let mutationCalls = 0;

export async function initializeHc3Slice2Surface(invitationText) {
  const carrier = parseHc3ArtifactText(invitationText).carrier;
  if (carrier.artifact_kind !== "invitation_handoff") throw new Error("Browser surface requires an Invitation fixture.");
  invitation = extractHc2HandoffPayload(carrier);
  evidence = baseEvidence();
  const facade = new Hc3DisabledManualWorkflow({
    evidence: { async readEvidence() { return structuredClone(evidence); } },
    operations: operations(),
    ports: ports(),
    sha256_factory: { createSha256() { throw new Error("Hashing is reached only after an explicit preview."); } }
  });
  surface = await mountHc3Slice2QualificationSurface(document.querySelector("main"), facade);
  return snapshot();
}

export async function invokeHc3Slice2Surface(action) {
  await requiredSurface().invoke(action);
  return snapshot();
}

export function setHc3Slice2PortMode(port, mode) {
  if (port === "clipboard") clipboardMode = mode;
  else if (port === "qr") qrMode = mode;
  else if (port === "share") shareMode = mode;
  else throw new Error("Unknown test port.");
  return true;
}

export async function setHc3Slice2SynchronizationPhase() {
  evidence = { ...evidence, revision: evidence.revision + 1n, phase: "synchronization_required", membership_state: "active", epoch_state: "current", continuity_state: "verified" };
  await requiredSurface().invoke("reconstruct_workflow_guidance_after_reopen");
  return snapshot();
}

export function snapshot() {
  const status = document.querySelector("#workflow-status");
  const buttons = [...document.querySelectorAll("button")];
  const textareas = [...document.querySelectorAll("textarea")];
  const details = document.querySelector("details");
  return clean({
    state: status?.dataset.state ?? null,
    classification: status?.dataset.classification ?? null,
    status_text: status?.textContent ?? "",
    active_element: document.activeElement?.id || document.activeElement?.dataset?.action || document.activeElement?.tagName || null,
    buttons: buttons.map((button) => ({ action: button.dataset.action, name: button.textContent, describedby: button.getAttribute("aria-describedby"), disabled: button.disabled })),
    textarea_count: textareas.length,
    labelled_textareas: textareas.every((input) => Boolean(document.querySelector(`label[for="${input.id}"]`))),
    live_region: status?.getAttribute("aria-live"),
    confirmation_text: document.querySelector("#confirmation-boundary")?.textContent ?? "",
    details_summary: details?.querySelector("summary")?.textContent ?? "",
    details_open: details?.open ?? false,
    surface_width: document.querySelector("main")?.getBoundingClientRect().width ?? 0,
    viewport_width: innerWidth,
    clipboard_writes: [...clipboardWrites],
    qr_payloads: [...qrPayloads],
    share_calls: shareCalls,
    selection_calls: selectionCalls,
    import_calls: importCalls,
    mutation_calls: mutationCalls
  });
}

function operations() {
  return {
    async createInvitation({ expected_revision }) { cas(expected_revision); mutationCalls += 1; evidence = { ...evidence, revision: evidence.revision + 1n, phase: "invitation_created", invitation_state: "active" }; return invitation; },
    async inspectInvitation({ invitation: value }) { return preview("invitation", value.intended_role, "invitation_handoff", [value.invitation_id]); },
    async beginEnrollment() { throw new Error("not used by surface qualification"); },
    async createEnrollmentResponse() { throw new Error("not used by surface qualification"); },
    async inspectEnrollmentResponse() { throw new Error("not used by surface qualification"); },
    async authorizeAdmission() { throw new Error("not used by surface qualification"); },
    async prepareAdmissionBundle() { throw new Error("not used by surface qualification"); },
    async previewEncryptedBundle() { throw Object.assign(new Error("truncated file"), { code: "truncated_file" }); },
    async confirmAdmissionImport() { importCalls += 1; throw new Error("must not import automatically"); },
    async prepareSynchronizationBundle() { throw Object.assign(new Error("not prepared in surface test"), { code: "test_export_unavailable" }); },
    async confirmSynchronizationImport() { importCalls += 1; throw new Error("must not import automatically"); },
    async inspectConvergence() { return { converged: false, more_required: true, diagnostic_code: "manual_exchange_required" }; }
  };
}

function ports() {
  return {
    clipboard: { async writeText({ text }) { clipboardWrites.push(`${text}`); if (clipboardMode === "success") return success({ written_characters: text.length }); if (clipboardMode === "denied") return portFailure("permission_denied", "clipboard_permission_denied", "keep_artifact_for_manual_copy"); return portFailure("failed", "clipboard_write_failed", "keep_artifact_for_manual_copy"); } },
    qr: { async present({ text }) { qrPayloads.push(`${text}`); if (qrMode === "success") return success({ presented_text: `${text}` }); return portFailure("unsupported", "qr_unavailable", "copy_or_share"); } },
    share: { async share() { shareCalls += 1; return shareMode === "success" ? success({ mode: "text" }) : portFailure("cancelled", "share_cancelled", "copy_artifact"); } },
    save: { async save() { return portFailure("unsupported", "file_save_unavailable", null); } },
    select: { async select() { selectionCalls += 1; return success({ exact_bytes: Uint8Array.of(1, 2, 3, 4), reported_size: 4n, media_type_hint: "application/vnd.patchmark.collaboration-bundle", extension_hint: ".pmcb" }); } },
    metadata: { async inspect(value) { return success({ authority: "none", reported_size: value.reported_size, media_type_hint: value.media_type_hint, extension_hint: value.extension_hint }); } },
    confirmation: { async confirm() { return success({ confirmed: true }); } },
    capabilities: { async detect() { return success({ authority: "none", secure_context: true, clipboard_write: true, text_share: false, encrypted_file_share: false, native_file_save: false, native_file_open: true, browser_download: true, qr_presentation: false }); } }
  };
}

function baseEvidence() { return { schema_version: 1, record_kind: "hc3_workflow_evidence", authority: "none", revision: 0n, source_project_immutable: true, phase: "ready_to_invite", portable_state: "verified", custody_state: "available", invitation_state: "absent", membership_state: "not_enrolled", epoch_state: "absent", continuity_state: "none", pending_journal_count: 0, blockers: [] }; }
function preview(purpose, role, artifactKind, opaque) { return { authority: "none", purpose, structural_state: "valid", intended_for_local_device: "unknown", role, encrypted_byte_length: null, required_action: "Review and explicitly continue.", technical_details: { artifact_kind: artifactKind, opaque_identifiers: opaque, diagnostic_code: null } }; }
function cas(revision) { if (revision !== evidence.revision) throw Object.assign(new Error("stale evidence"), { code: "stale_control" }); }
function requiredSurface() { if (!surface) throw new Error("Surface is not mounted."); return surface; }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }

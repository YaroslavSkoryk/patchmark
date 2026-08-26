import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import {
  deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity,
  derivePossessionProofIdentity,
  parseEnrollmentRequestCore,
  parseEnrollmentRequestRecord,
  parseInvitationEvidenceCore,
  parseInvitationHandoffCore,
  parsePossessionProofRecord,
  parsePossessionResponseCore
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { hc2ProtocolLimits } from "../lib/collaboration/hc2/limits.ts";
import { encodeAlgorithmTaggedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { createEncryptedContainerRecordV2 } from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import { createEncryptedContainerRecordV3 } from "../lib/collaboration/hc2/transport-v3-contracts.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_ENVELOPE_MAGIC } from "../lib/collaboration/hc2/versions.ts";
import {
  createHc3BrowserPorts,
  createHc3EncryptedBundleSaveAdapter,
  createHc3EncryptedBundleSelectionAdapter,
  createHc3WorkflowStatus,
  deriveHc3WorkflowStatus,
  Hc3DisabledManualWorkflow,
  hc3WorkflowCommands,
  hc3WorkflowStateKinds,
  portFailure,
  success
} from "../lib/collaboration/hc3/index.ts";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

const records = await handoffRecords();
const admissionBytes = await encryptedBundleBytes(2);
const synchronizationBytes = await encryptedBundleBytes(3);
const sourceDigest = createHash("sha256").update("immutable-source-project").digest("hex");
let observedSourceDigest = sourceDigest;
let evidence = baseEvidence();
let mutationCalls = 0;
let previewCalls = 0;
let admissionImports = 0;
let synchronizationImports = 0;
let nextPreviewFailure = null;
const imported = new Set();

const operations = Object.freeze({
  async createInvitation({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "invitation_created", invitation_state: "active" });
    return records.handoff;
  },
  async inspectInvitation({ invitation }) {
    previewCalls += 1; equal(invitation.invitation_id, records.handoff.invitation_id, "invitation preview receives the exact HC-2 handoff");
    return safePreview("invitation", { role: invitation.intended_role, artifact_kind: "invitation_handoff", opaque_identifiers: [invitation.invitation_id] });
  },
  async beginEnrollment({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "waiting_for_response", membership_state: "pending" });
    return operation("completed");
  },
  async createEnrollmentResponse({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "waiting_for_response" });
    return { request: records.request, possession_proof: records.proof };
  },
  async inspectEnrollmentResponse({ request, possession_proof }) {
    previewCalls += 1;
    equal(request.request_id, records.request.request_id, "response preview receives the exact enrollment request");
    equal(possession_proof.proof_id, records.proof.proof_id, "response preview receives the exact possession proof");
    return safePreview("enrollment_response", { role: "editor", artifact_kind: "enrollment_response", opaque_identifiers: [request.request_id, possession_proof.proof_id] });
  },
  async authorizeAdmission({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "admission_ready", invitation_state: "consumed" });
    return operation("completed");
  },
  async prepareAdmissionBundle({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "admission_ready" }); return Uint8Array.from(admissionBytes);
  },
  async previewEncryptedBundle({ purpose, exact_bytes }) {
    previewCalls += 1;
    if (nextPreviewFailure) { const code = nextPreviewFailure; nextPreviewFailure = null; throw Object.assign(new Error(code), { code }); }
    return safePreview(purpose === "admission" ? "admission" : "encrypted_update", {
      artifact_kind: purpose === "admission" ? "encrypted_admission" : "encrypted_update",
      encrypted_byte_length: BigInt(exact_bytes.byteLength), intended_for_local_device: true
    });
  },
  async confirmAdmissionImport({ exact_bytes, expected_revision }) {
    cas(expected_revision); mutationCalls += 1; admissionImports += 1;
    const key = hex(exact_bytes); const duplicate = imported.has(key); imported.add(key);
    patch({ phase: "admitted", membership_state: "active", epoch_state: "current", continuity_state: "verified" });
    return operation(duplicate ? "duplicate" : "completed");
  },
  async prepareSynchronizationBundle({ expected_revision }) {
    cas(expected_revision); mutationCalls += 1; patch({ phase: "synchronization_required" }); return Uint8Array.from(synchronizationBytes);
  },
  async confirmSynchronizationImport({ exact_bytes, expected_revision }) {
    cas(expected_revision); mutationCalls += 1; synchronizationImports += 1;
    const key = hex(exact_bytes); const duplicate = imported.has(key); imported.add(key);
    patch({ phase: duplicate ? evidence.phase : "converged", continuity_state: "verified" });
    return operation(duplicate ? "duplicate" : "completed");
  },
  async inspectConvergence() {
    return { converged: evidence.phase === "converged", more_required: evidence.phase !== "converged", diagnostic_code: evidence.phase === "converged" ? null : "manual_exchange_required" };
  }
});

const portState = {
  clipboard: success({ written_characters: 0 }), qr: success({ presented_text: "" }), share: success({ mode: "text" }),
  save: success({ exact_byte_length: 0n }), selected: null, confirmation: success({ confirmed: true }),
  copied: [], presented: [], shared: [], saved: [], port_calls: 0
};
const ports = fakePorts(portState);
const dependencies = Object.freeze({ evidence: { async readEvidence() { assertSource(); return structuredClone(evidence); } }, operations, ports, sha256_factory: nodeSha256Factory() });
const workflow = new Hc3DisabledManualWorkflow(dependencies);

equal(mutationCalls, 0, "facade construction invokes no HC-2 operation");
equal(portState.port_calls, 0, "facade construction invokes no browser port");
equal((await workflow.inspectCollaborationReadiness()).status.state, "ready", "read-only readiness reconstructs ready guidance");
equal(mutationCalls, 0, "readiness inspection performs no mutation");

const invitation = await workflow.createInvitationHandoff();
equal(invitation.status.state, "ready_to_share", "explicit invitation creation prepares a carrier");
equal(invitation.text_artifacts[0].purpose, "invitation", "invitation uses user-facing purpose");
const invitationText = invitation.text_artifacts[0].text;
const mutationAfterInvitation = mutationCalls;
portState.clipboard = success({ written_characters: invitationText.length });
await workflow.copyInvitation(); await workflow.copyInvitation();
equal(portState.copied, [invitationText, invitationText], "repeated copies use exact immutable Invitation text");
equal(mutationCalls, mutationAfterInvitation, "copying never invokes authority");

portState.qr = success({ presented_text: invitationText });
equal((await workflow.presentInvitationAsQr()).status.state, "completed", "eligible Invitation reaches explicit QR presenter");
portState.qr = success({ presented_text: `${invitationText}x` });
equal((await workflow.presentInvitationAsQr()).status.technical_diagnostic_code, "qr_payload_mutated", "QR presenter mutation fails closed");
portState.qr = portFailure("unsupported", "qr_unavailable", "copy_or_share");
equal((await workflow.presentInvitationAsQr()).status.state, "unsupported", "QR unsupported result exposes fallback");

portState.share = portFailure("cancelled", "share_cancelled", "copy_artifact");
equal((await workflow.shareInvitation()).status.state, "cancelled", "share cancellation is normal and recoverable");
portState.share = portFailure("failed", "share_failed", "copy_artifact");
equal((await workflow.shareInvitation()).status.artifact_available, true, "share failure keeps exact Invitation available");

const candidate = new Hc3DisabledManualWorkflow(dependencies);
const beforeOpen = mutationCalls;
const opened = await candidate.inspectReceivedInvitation(invitationText);
equal(opened.status.state, "received_unverified", "opening Invitation creates only a safe preview");
equal(mutationCalls, beforeOpen, "opening Invitation does not consume it");
equal(opened.preview.role, "editor", "safe preview exposes only offered role");
await candidate.cancelCurrentOperationalStep();
equal(mutationCalls, beforeOpen, "cancellation before confirmation mutates nothing");
equal((await candidate.beginEnrollment()).status.technical_diagnostic_code, "invitation_preview_required", "cancelled preview cannot begin enrollment");
await candidate.inspectReceivedInvitation(invitationText);
equal((await candidate.beginEnrollment()).authoritative_status, "completed", "explicit begin delegates to HC-2 once");

const response = await candidate.createEnrollmentResponse();
equal(response.text_artifacts.map((item) => item.purpose), ["enrollment_request", "possession_proof"], "Response preserves exact request and possession-proof carriers");
portState.clipboard = success({ written_characters: response.text_artifacts[0].text.length });
await candidate.copyEnrollmentResponse("enrollment_request");
portState.clipboard = portFailure("permission_denied", "clipboard_permission_denied", "keep_artifact_for_manual_copy");
equal((await candidate.copyEnrollmentResponse("possession_proof")).status.state, "blocked", "clipboard denial is typed without consuming Response");

const owner = new Hc3DisabledManualWorkflow(dependencies);
const inspectedResponse = await owner.inspectReceivedEnrollmentResponse({ request_text: response.text_artifacts[0].text, possession_proof_text: response.text_artifacts[1].text });
equal(inspectedResponse.status.confirmation_required, true, "Response inspection requires separate authorization");
const beforeAuthorizationCancel = mutationCalls;
await owner.cancelCurrentOperationalStep();
equal(mutationCalls, beforeAuthorizationCancel, "Response cancellation invokes no authority");
await owner.inspectReceivedEnrollmentResponse({ request_text: response.text_artifacts[0].text, possession_proof_text: response.text_artifacts[1].text });
equal((await owner.authorizeAdmission()).authoritative_status, "completed", "explicit authorization delegates to HC-2 CAS boundary");

portState.save = portFailure("permission_denied", "file_save_permission_denied", "retry_same_artifact");
const failedSave = await owner.exportAdmissionBundle();
equal(failedSave.encrypted_artifact.evidence.bundle_version, 2, "admission export preserves exact V2 bytes");
const admissionFilename = failedSave.encrypted_artifact.filename;
const admissionPreparedHex = hex(failedSave.encrypted_artifact.exact_bytes);
portState.save = success({ exact_byte_length: BigInt(admissionBytes.length) });
const savedAdmission = await owner.exportAdmissionBundle();
equal(savedAdmission.encrypted_artifact.filename, admissionFilename, "save retry retains opaque filename");
equal(hex(savedAdmission.encrypted_artifact.exact_bytes), admissionPreparedHex, "save retry retains byte-identical V2 artifact");

portState.selected = selectedFile(admissionBytes, "text/plain", ".txt");
const beforeSelection = mutationCalls;
equal((await candidate.selectAdmissionBundle()).status.state, "received_unverified", "selection alone is unverified");
equal(mutationCalls, beforeSelection, "selection alone does not import");
const admissionPreview = await candidate.previewAdmissionImport();
equal(admissionPreview.status.state, "ready_for_confirmation", "valid V2 bytes require confirmation despite incorrect MIME and extension hints");
equal(mutationCalls, beforeSelection, "preview does not import");

const reloadedBeforeConfirmation = new Hc3DisabledManualWorkflow(dependencies);
equal((await reloadedBeforeConfirmation.confirmAdmissionImport()).status.technical_diagnostic_code, "file_selection_required", "reload discards ephemeral preview and requires reselection");
portState.confirmation = portFailure("cancelled", "confirmation_cancelled", null);
equal((await candidate.confirmAdmissionImport()).status.state, "cancelled", "confirmation cancellation mutates nothing");
equal(mutationCalls, beforeSelection, "cancelled confirmation invokes no import");
portState.confirmation = success({ confirmed: true });
equal((await candidate.confirmAdmissionImport()).authoritative_status, "completed", "confirmed V2 import reaches HC-2 once");
equal(admissionImports, 1, "admission import invocation count is exact");
const reopenedAfterCommit = new Hc3DisabledManualWorkflow(dependencies);
equal((await reopenedAfterCommit.reconstructWorkflowGuidanceAfterReopen()).status.state, "ready", "reopen derives admitted guidance from durable evidence without presentation state");

portState.selected = selectedFile(admissionBytes, "application/vnd.patchmark.collaboration-bundle", ".pmcb");
await candidate.selectAdmissionBundle(); await candidate.previewAdmissionImport();
equal((await candidate.confirmAdmissionImport()).authoritative_status, "duplicate", "confirmed exact V2 duplicate is idempotent");
equal(admissionImports, 2, "duplicate is still one explicit authoritative invocation");

portState.save = portFailure("cancelled", "file_save_cancelled", "retry_same_artifact");
const failedSyncSave = await candidate.exportSynchronizationBundle();
equal(failedSyncSave.encrypted_artifact.evidence.bundle_version, 3, "synchronization export preserves exact V3 bytes");
const syncPrepared = hex(failedSyncSave.encrypted_artifact.exact_bytes);
portState.save = success({ exact_byte_length: BigInt(synchronizationBytes.length) });
equal(hex((await candidate.exportSynchronizationBundle()).encrypted_artifact.exact_bytes), syncPrepared, "V3 save retry uses identical prepared bytes");

portState.selected = selectedFile(synchronizationBytes, "", ".bin");
await owner.selectSynchronizationBundle();
await owner.previewSynchronizationImport();
equal((await owner.confirmSynchronizationImport()).authoritative_status, "completed", "explicit V3 import delegates atomically");
equal((await owner.inspectConvergence()).status.state, "completed", "convergence is reported only from reopened evidence");
portState.selected = selectedFile(synchronizationBytes, "", ".pmcb");
await owner.selectSynchronizationBundle(); await owner.previewSynchronizationImport();
equal((await owner.confirmSynchronizationImport()).authoritative_status, "duplicate", "confirmed exact V3 duplicate is idempotent");
equal(synchronizationImports, 2, "V3 duplicate requires a second explicit confirmation and creates no automatic work");

for (const [bytes, code] of [
  [new Uint8Array(), "workflow_validation_failed"],
  [admissionBytes.slice(0, -1), "workflow_validation_failed"],
  [concat(admissionBytes, Uint8Array.of(0)), "workflow_validation_failed"],
  [synchronizationBytes, "mixed_or_wrong_bundle_version"]
]) {
  portState.selected = selectedFile(bytes, "application/vnd.patchmark.collaboration-bundle", ".pmcb");
  const selected = await candidate.selectAdmissionBundle();
  if (bytes.length === 0) equal(selected.status.state, "received_unverified", "test port can expose empty selection to facade validation");
  equal((await candidate.previewAdmissionImport()).status.technical_diagnostic_code, code, `invalid admission bytes fail closed: ${code}`);
}

for (const code of ["wrong_recipient", "wrong_project", "stale_control", "stale_epoch", "revoked_device", "gap", "replay", "fork"]) {
  portState.selected = selectedFile(admissionBytes, "", ".pmcb");
  await candidate.selectAdmissionBundle(); nextPreviewFailure = code;
  equal((await candidate.previewAdmissionImport()).status.technical_diagnostic_code, code, `${code} remains typed and fail closed`);
}

const beforePresentationFailures = mutationCalls;
for (const outcome of [
  portFailure("unsupported", "clipboard_unavailable", "keep_artifact_for_manual_copy"),
  portFailure("permission_denied", "clipboard_permission_denied", "keep_artifact_for_manual_copy"),
  portFailure("failed", "clipboard_write_failed", "keep_artifact_for_manual_copy")
]) { portState.clipboard = outcome; await workflow.copyInvitation(); }
equal(mutationCalls, beforePresentationFailures, "clipboard failures never mutate authoritative state");

await adapterFailureMatrix();

for (const state of hc3WorkflowStateKinds) equal(createHc3WorkflowStatus(state).authority, "none", `${state} presentation state is authority-free`);
equal(hc3WorkflowCommands.length, 23, "workflow exposes the complete explicit Slice 2 command surface");
equal(new Set(hc3WorkflowCommands).size, hc3WorkflowCommands.length, "workflow command names are unique");

for (const corrupt of [
  { portable_state: "corrupt" }, { portable_state: "forked" }, { continuity_state: "fork" },
  { epoch_state: "mismatched" }, { membership_state: "revoked" }, { source_project_immutable: false }, { blockers: ["ambiguous_control"] }
]) equal(deriveHc3WorkflowStatus({ ...baseEvidence(), phase: "converged", ...corrupt }).state, "blocked", "corrupt, forked, revoked, substituted, or ambiguous evidence fails closed");

observedSourceDigest = "changed";
equal((await workflow.inspectCollaborationReadiness()).status.state, "blocked", "source-project immutability guard crosses the workflow as a typed failure");
observedSourceDigest = sourceDigest;

process.stdout.write(`${JSON.stringify({
  assertions,
  explicit_commands: hc3WorkflowCommands.length,
  presentation_states: hc3WorkflowStateKinds.length,
  authoritative_mutation_calls: mutationCalls,
  read_only_preview_calls: previewCalls,
  admission_import_invocations: admissionImports,
  synchronization_import_invocations: synchronizationImports,
  source_project_immutable: true,
  automatic_imports: 0,
  background_actions: 0,
  status: "ok"
}, null, 2)}\n`);

async function adapterFailureMatrix() {
  const unavailable = createHc3BrowserPorts({ is_secure_context: false });
  equal((await unavailable.clipboard.writeText({ text: invitationText })).status, "unsupported", "clipboard unavailable is typed");
  equal((await unavailable.share.share({ mode: "text", text: invitationText, title: "Invitation" })).status, "unsupported", "share unsupported is typed");
  equal((await unavailable.qr.present({ text: invitationText })).status, "unsupported", "QR unsupported is typed");
  equal((await unavailable.select.select({ maximum_byte_length: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes })).status, "unsupported", "file selection unsupported is typed");

  const denied = createHc3BrowserPorts({ is_secure_context: true, navigator: { clipboard: { async writeText() { throw named("NotAllowedError"); } }, async share() { throw named("AbortError"); } } });
  equal((await denied.clipboard.writeText({ text: invitationText })).status, "permission_denied", "clipboard denial is distinguished");
  equal((await denied.share.share({ mode: "text", text: invitationText, title: "Invitation" })).status, "cancelled", "share cancellation is distinguished");

  let revoked = 0; let clicks = 0;
  const download = createHc3EncryptedBundleSaveAdapter({ is_secure_context: true,
    create_blob() { return {}; }, create_object_url() { return "blob:test"; }, revoke_object_url() { revoked += 1; },
    create_anchor() { return { href: "", download: "", rel: "", click() { clicks += 1; }, remove() {} }; }
  });
  equal((await download.save({ exact_bytes: admissionBytes, filename: "patchmark-a.pmcb", media_type: "application/vnd.patchmark.collaboration-bundle" })).status, "success", "explicit browser download fallback succeeds");
  equal([clicks, revoked], [1, 1], "download clicks once and deterministically revokes object URL");
  const failedDownload = createHc3EncryptedBundleSaveAdapter({ is_secure_context: true,
    create_blob() { return {}; }, create_object_url() { throw new Error("setup"); }, revoke_object_url() {},
    create_anchor() { throw new Error("not reached"); }
  });
  equal((await failedDownload.save({ exact_bytes: admissionBytes, filename: "patchmark-a.pmcb", media_type: "application/vnd.patchmark.collaboration-bundle" })).status, "failed", "partial download setup is typed");

  for (const [file, code] of [
    [{ size: 0, type: "", name: "empty.pmcb", async arrayBuffer() { return new ArrayBuffer(0); } }, "empty_file"],
    [{ size: Number(hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes + BigInt(1)), type: "", name: "large.pmcb", async arrayBuffer() { throw new Error("must not read"); } }, "oversized_file"]
  ]) {
    const selection = createHc3EncryptedBundleSelectionAdapter({ is_secure_context: true, async show_open_file_picker() { return [{ async getFile() { return file; } }]; } });
    const outcome = await selection.select({ maximum_byte_length: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes });
    equal(outcome.status === "success" ? "success" : outcome.diagnostic_code, code, `${code} rejects before authoritative validation`);
  }
  const cancelled = createHc3EncryptedBundleSelectionAdapter({ is_secure_context: true, async show_open_file_picker() { throw named("AbortError"); } });
  equal((await cancelled.select({ maximum_byte_length: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes })).status, "cancelled", "file selection cancellation is typed");
  const lost = createHc3EncryptedBundleSelectionAdapter({ is_secure_context: true, async show_open_file_picker() { throw named("NotAllowedError"); } });
  equal((await lost.select({ maximum_byte_length: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes })).status, "permission_denied", "file permission loss is typed");
}

function fakePorts(state) {
  return Object.freeze({
    clipboard: { async writeText({ text }) { state.port_calls += 1; state.copied.push(`${text}`); return state.clipboard.status === "success" ? success({ written_characters: text.length }) : state.clipboard; } },
    qr: { async present({ text }) { state.port_calls += 1; state.presented.push(`${text}`); return state.qr; } },
    share: { async share(input) { state.port_calls += 1; state.shared.push(structuredClone(input)); return state.share; } },
    save: { async save(input) { state.port_calls += 1; state.saved.push(Uint8Array.from(input.exact_bytes)); return state.save.status === "success" ? success({ exact_byte_length: BigInt(input.exact_bytes.length) }) : state.save; } },
    select: { async select() { state.port_calls += 1; return state.selected ? success(selectedFile(state.selected.exact_bytes, state.selected.media_type_hint, state.selected.extension_hint)) : portFailure("cancelled", "file_selection_cancelled", null); } },
    metadata: { async inspect(input) { state.port_calls += 1; return success({ authority: "none", reported_size: input.reported_size, media_type_hint: input.media_type_hint, extension_hint: input.extension_hint }); } },
    confirmation: { async confirm() { state.port_calls += 1; return state.confirmation; } },
    capabilities: { async detect() { state.port_calls += 1; return success({ authority: "none", secure_context: true, clipboard_write: true, text_share: true, encrypted_file_share: false, native_file_save: false, native_file_open: true, browser_download: true, qr_presentation: true }); } }
  });
}

function baseEvidence() {
  return { schema_version: 1, record_kind: "hc3_workflow_evidence", authority: "none", revision: 0n,
    source_project_immutable: true, phase: "ready_to_invite", portable_state: "verified", custody_state: "available",
    invitation_state: "absent", membership_state: "not_enrolled", epoch_state: "absent", continuity_state: "none",
    pending_journal_count: 0, blockers: [] };
}
function patch(values) { evidence = Object.freeze({ ...evidence, ...values, revision: evidence.revision + 1n }); assertSource(); }
function cas(revision) { equal(revision, evidence.revision, "authoritative operation binds the revalidated durable revision"); assertSource(); }
function assertSource() { if (observedSourceDigest !== sourceDigest) throw Object.assign(new Error("source changed"), { code: "source_project_changed" }); }
function operation(status) { return Object.freeze({ status, diagnostic_code: null }); }
function safePreview(purpose, input = {}) { return Object.freeze({ authority: "none", purpose, structural_state: "valid", intended_for_local_device: input.intended_for_local_device ?? "unknown", role: input.role ?? null, encrypted_byte_length: input.encrypted_byte_length ?? null, required_action: "Review and explicitly continue.", technical_details: Object.freeze({ artifact_kind: input.artifact_kind ?? purpose, opaque_identifiers: Object.freeze(input.opaque_identifiers ?? []), diagnostic_code: null }) }); }
function selectedFile(bytes, media_type_hint, extension_hint) { return Object.freeze({ exact_bytes: Uint8Array.from(bytes), reported_size: BigInt(bytes.length), media_type_hint, extension_hint }); }
function nodeSha256Factory() { return Object.freeze({ createSha256() { const hash = createHash("sha256"); return { update(bytes) { hash.update(bytes); }, digest() { return new Uint8Array(hash.digest()); } }; } }); }
function hex(bytes) { return Buffer.from(bytes).toString("hex"); }
function concat(left, right) { const value = new Uint8Array(left.length + right.length); value.set(left); value.set(right, left.length); return value; }
function named(name) { return Object.assign(new Error(name), { name }); }

async function handoffRecords() {
  const ids = { project: entity("project", "a"), invitation: entity("invitation", "b"), ownerMembership: entity("membership", "c"), ownerPerson: entity("person", "d"), ownerDevice: entity("device", "e"), scope: entity("access-scope", "f"), candidatePerson: entity("person", "g"), candidateMembership: entity("membership", "h"), candidateDevice: entity("device", "j"), signingKey: entity("public-key", "k"), recipientKey: entity("public-key", "m"), control: hc1Digest("control-event", "n") };
  const invitationEvidence = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project, invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice, intended_role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: ids.control, creation_control_sequence: 2n, valid_through_control_sequence: 12n, accepted_invitation_action_id: hc1Digest("control-action", "p"), accepted_invitation_control_event_id: ids.control, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
  const invitationEvidenceId = (await deriveInvitationEvidenceIdentity(invitationEvidence)).id;
  const handoff = parseInvitationHandoffCore({ schema_version: 1, record_kind: "invitation_handoff_core", authority: "none", project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationEvidenceId, accepted_invitation_control_event_id: ids.control, intended_role: "editor", access_scope: "project_wide", suite_id: HC2_CRYPTO_SUITE_ID });
  const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person", project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationEvidenceId, accepted_invitation_control_event_id: ids.control, candidate_person_id: ids.candidatePerson, existing_membership_id: null, proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice, signing_key_id: ids.signingKey, signing_public_key_bytes: encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.signingKey, raw_public_key: new Uint8Array(32).fill(0x31) }), recipient_key_id: ids.recipientKey, recipient_public_key_bytes: encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.recipientKey, raw_public_key: new Uint8Array(32).fill(0x32) }), intended_role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, bound_control_head_id: ids.control, request_nonce: new Uint8Array(32).fill(0x33), suite_id: HC2_CRYPTO_SUITE_ID });
  const requestId = (await deriveEnrollmentRequestIdentity(requestCore)).id;
  const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestId, core: requestCore, algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x34) });
  const proofCore = parsePossessionResponseCore({ schema_version: 1, record_kind: "possession_response_core", authority: "none", project_id: ids.project, invitation_id: ids.invitation, request_id: requestId, challenge_id: hc2Digest("possession-challenge", "q"), challenge_commitment: new Uint8Array(32).fill(0x35), challenge_response: new Uint8Array(32).fill(0x36), candidate_person_id: ids.candidatePerson, candidate_device_id: ids.candidateDevice, signing_key_id: ids.signingKey, recipient_key_id: ids.recipientKey, bound_control_head_id: ids.control, suite_id: HC2_CRYPTO_SUITE_ID });
  const proof = parsePossessionProofRecord({ record_version: 1, record_kind: "possession_proof", authority: "none", proof_id: (await derivePossessionProofIdentity(proofCore)).id, core: proofCore, algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x37) });
  return { handoff, request, proof };
}
async function encryptedBundleBytes(version) { return encodeCanonicalCbor(canonicalProtocolValue([await encryptedContainer(version)])); }
async function encryptedContainer(version) { const ciphertext = new Uint8Array(version === 2 ? 48 : 49).fill(version === 2 ? 0xa2 : 0xa3); const header = { magic: HC2_ENVELOPE_MAGIC, envelope_version: version, suite_id: HC2_CRYPTO_SUITE_ID, encapsulated_key_bytes: new Uint8Array(32).fill(version), envelope_id: (version === 2 ? "a" : "b").repeat(26), recipient_routing_tag: new Uint8Array(32).fill(version + 1), chunk_ordinal: 0, chunk_count: 1, ciphertext_length: BigInt(ciphertext.length) }; return version === 2 ? createEncryptedContainerRecordV2({ schema_version: 2, record_kind: "encrypted_container_core_v2", public_header: header, ciphertext_bytes: ciphertext }) : createEncryptedContainerRecordV3({ schema_version: 3, record_kind: "encrypted_container_core_v3", public_header: header, ciphertext_bytes: ciphertext }); }
function entity(kind, char) { return `pm:${kind}:v1:${char.repeat(25)}a`; }
function hc1Digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }
function hc2Digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }

import type {
  EnrollmentRequestRecord,
  InvitationHandoffCore,
  PossessionProofRecord
} from "../hc2/enrollment-contracts.ts";
import { hc2ProtocolLimits } from "../hc2/limits.ts";
import {
  createHc3EncryptedBundleFilename,
  hc3EncryptedBundleFileMetadata,
  inspectHc3EncryptedBundleFile,
  type Hc3EncryptedBundleFileEvidence
} from "./bundle-files.ts";
import {
  createHc3HandoffCarrier,
  extractHc2HandoffPayload,
  type Hc3HandoffCarrier
} from "./contracts.ts";
import { assessHc3SingleQrEligibility } from "./qr.ts";
import {
  formatHc3ArtifactText,
  parseHc3ArtifactText,
  type Hc3ArtifactText
} from "./text.ts";
import {
  createHc3WorkflowStatus,
  deriveHc3WorkflowStatus,
  parseHc3SafePreview,
  parseHc3WorkflowEvidence,
  type Hc3SafePreview,
  type Hc3WorkflowCommand,
  type Hc3WorkflowEvidence,
  type Hc3WorkflowStatus
} from "./workflow-contracts.ts";
import {
  copyPortValue,
  type Hc3AuthoritativeOperationResult,
  type Hc3PortResult,
  type Hc3SelectedEncryptedFile,
  type Hc3WorkflowDependencies
} from "./workflow-ports.ts";

export type Hc3PreparedTextArtifact = Readonly<{
  authority: "none";
  purpose: "invitation" | "enrollment_request" | "possession_proof";
  text: Hc3ArtifactText;
}>;

export type Hc3PreparedEncryptedArtifact = Readonly<{
  authority: "none";
  purpose: "admission" | "encrypted_update";
  filename: string;
  media_type: string;
  exact_bytes: Uint8Array;
  evidence: Hc3EncryptedBundleFileEvidence;
}>;

export type Hc3WorkflowCommandResult = Readonly<{
  authority: "none";
  command: Hc3WorkflowCommand;
  status: Hc3WorkflowStatus;
  preview: Hc3SafePreview | null;
  text_artifacts: readonly Hc3PreparedTextArtifact[];
  encrypted_artifact: Hc3PreparedEncryptedArtifact | null;
  port_status: Hc3PortResult<unknown>["status"] | null;
  authoritative_status: Hc3AuthoritativeOperationResult["status"] | null;
}>;

type ReceivedResponse = Readonly<{
  request: EnrollmentRequestRecord;
  possession_proof: PossessionProofRecord;
}>;

type SelectedBundle = Readonly<{
  selected: Hc3SelectedEncryptedFile;
  inspection: Hc3EncryptedBundleFileEvidence | null;
  preview: Hc3SafePreview | null;
}>;

/**
 * Authority-free manual workflow coordination. It owns only ephemeral carrier,
 * selection, and preview state. HC-2 remains the only mutation boundary.
 */
export class Hc3DisabledManualWorkflow {
  readonly #dependencies: Hc3WorkflowDependencies;
  #invitation: Hc3PreparedTextArtifact | null = null;
  #response: readonly Hc3PreparedTextArtifact[] = Object.freeze([]);
  #receivedInvitation: InvitationHandoffCore | null = null;
  #receivedResponse: ReceivedResponse | null = null;
  #admission: Hc3PreparedEncryptedArtifact | null = null;
  #synchronization: Hc3PreparedEncryptedArtifact | null = null;
  #selectedAdmission: SelectedBundle | null = null;
  #selectedSynchronization: SelectedBundle | null = null;

  constructor(dependencies: Hc3WorkflowDependencies) {
    if (!dependencies?.evidence || !dependencies.operations || !dependencies.ports || !dependencies.sha256_factory) {
      throw new Error("HC-3 manual workflow requires explicit evidence, operation, browser-port, and SHA-256 dependencies.");
    }
    this.#dependencies = dependencies;
  }

  inspectCollaborationReadiness(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("inspect_collaboration_readiness", async () => {
      const evidence = await this.#readEvidence();
      return this.#result("inspect_collaboration_readiness", deriveHc3WorkflowStatus(evidence));
    });
  }

  createInvitationHandoff(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("create_invitation_handoff", async () => {
      const before = await this.#readMutableEvidence();
      const invitation = await this.#dependencies.operations.createInvitation({ expected_revision: before.revision });
      const carrier = createHc3HandoffCarrier({ artifact_kind: "invitation_handoff", payload: invitation });
      this.#invitation = freezeText("invitation", formatHc3ArtifactText(carrier));
      await this.#readEvidence();
      return this.#result("create_invitation_handoff", createHc3WorkflowStatus("ready_to_share", {
        explanation: "The Invitation is ready. Copy, show, or share it explicitly; creating it did not transmit anything.",
        actions: ["copy_invitation", "present_invitation_as_qr", "share_invitation"],
        artifact_available: true
      }), { text_artifacts: [this.#invitation] });
    });
  }

  copyInvitation(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("copy_invitation", async () => {
      const artifact = required(this.#invitation, "invitation_not_prepared");
      const outcome = await safePort(() => this.#dependencies.ports.clipboard.writeText({ text: artifact.text }), "clipboard_write_failed", "keep_artifact_for_manual_copy");
      return this.#portResult("copy_invitation", outcome, [artifact], "Invitation copied.");
    });
  }

  presentInvitationAsQr(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("present_invitation_as_qr", async () => {
      const artifact = required(this.#invitation, "invitation_not_prepared");
      const eligibility = assessHc3SingleQrEligibility(artifact.text);
      if (!eligibility.eligible) return this.#result("present_invitation_as_qr", createHc3WorkflowStatus("unsupported", {
        explanation: "This Invitation is too large for one QR code. Copy or share the exact text instead.",
        actions: ["copy_invitation", "share_invitation"], artifact_available: true, diagnostic_code: "qr_oversized"
      }), { text_artifacts: [artifact], port_status: "unsupported" });
      const outcome = await safePort(() => this.#dependencies.ports.qr.present({ text: artifact.text }), "qr_presentation_failed", "copy_or_share");
      if (outcome.status === "success" && outcome.value.presented_text !== artifact.text) {
        return this.#result("present_invitation_as_qr", createHc3WorkflowStatus("blocked", {
          explanation: "The QR presenter changed the Invitation. Nothing was accepted; use copy instead.",
          actions: ["copy_invitation", "share_invitation"], artifact_available: true, diagnostic_code: "qr_payload_mutated"
        }), { text_artifacts: [artifact], port_status: "failed" });
      }
      return this.#portResult("present_invitation_as_qr", outcome, [artifact], "Invitation is ready to scan.");
    });
  }

  shareInvitation(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("share_invitation", async () => {
      const artifact = required(this.#invitation, "invitation_not_prepared");
      const outcome = await safePort(() => this.#dependencies.ports.share.share({ mode: "text", text: artifact.text, title: "Invitation" }), "share_failed", "copy_artifact");
      return this.#portResult("share_invitation", outcome, [artifact], "Invitation handed to the operating-system share sheet.");
    });
  }

  inspectReceivedInvitation(text: string): Promise<Hc3WorkflowCommandResult> {
    return this.#run("inspect_received_invitation", async () => {
      const parsed = parseHc3ArtifactText(text);
      if (parsed.carrier.artifact_kind !== "invitation_handoff") throw coded("wrong_artifact_purpose");
      const invitation = extractHc2HandoffPayload(parsed.carrier as Hc3HandoffCarrier<"invitation_handoff">);
      const evidence = await this.#readEvidence();
      const preview = parseHc3SafePreview(await this.#dependencies.operations.inspectInvitation({ invitation, evidence }));
      if (preview.purpose !== "invitation") throw coded("preview_purpose_mismatch");
      this.#receivedInvitation = invitation;
      return this.#result("inspect_received_invitation", createHc3WorkflowStatus("received_unverified", {
        explanation: "The Invitation is structurally valid. Opening it did not consume it or grant membership.",
        actions: ["begin_enrollment", "cancel_current_operational_step"]
      }), { preview });
    });
  }

  beginEnrollment(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("begin_enrollment", async () => {
      const invitation = required(this.#receivedInvitation, "invitation_preview_required");
      const before = await this.#readMutableEvidence();
      const operation = parseOperation(await this.#dependencies.operations.beginEnrollment({ invitation, expected_revision: before.revision }));
      const after = await this.#readEvidence();
      return this.#result("begin_enrollment", deriveAfterOperation(after, operation, "Enrollment started. Create the Response explicitly."), { authoritative_status: operation.status });
    });
  }

  createEnrollmentResponse(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("create_enrollment_response", async () => {
      const before = await this.#readMutableEvidence();
      const response = await this.#dependencies.operations.createEnrollmentResponse({ expected_revision: before.revision });
      const request = createHc3HandoffCarrier({ artifact_kind: "enrollment_request", payload: response.request });
      const proof = createHc3HandoffCarrier({ artifact_kind: "possession_proof", payload: response.possession_proof });
      this.#response = Object.freeze([
        freezeText("enrollment_request", formatHc3ArtifactText(request)),
        freezeText("possession_proof", formatHc3ArtifactText(proof))
      ]);
      await this.#readEvidence();
      return this.#result("create_enrollment_response", createHc3WorkflowStatus("ready_to_share", {
        explanation: "The Response has two exact parts. Share both; neither part grants membership by itself.",
        actions: ["copy_enrollment_response", "share_enrollment_response"], artifact_available: true
      }), { text_artifacts: this.#response });
    });
  }

  copyEnrollmentResponse(part: "enrollment_request" | "possession_proof" = "enrollment_request"): Promise<Hc3WorkflowCommandResult> {
    return this.#run("copy_enrollment_response", async () => {
      const artifact = required(this.#response.find((item) => item.purpose === part) ?? null, "response_not_prepared");
      const outcome = await safePort(() => this.#dependencies.ports.clipboard.writeText({ text: artifact.text }), "clipboard_write_failed", "keep_artifact_for_manual_copy");
      return this.#portResult("copy_enrollment_response", outcome, this.#response, `${part === "enrollment_request" ? "Response" : "Verification"} copied.`);
    });
  }

  shareEnrollmentResponse(part: "enrollment_request" | "possession_proof" = "enrollment_request"): Promise<Hc3WorkflowCommandResult> {
    return this.#run("share_enrollment_response", async () => {
      const artifact = required(this.#response.find((item) => item.purpose === part) ?? null, "response_not_prepared");
      const outcome = await safePort(() => this.#dependencies.ports.share.share({ mode: "text", text: artifact.text, title: "Response" }), "share_failed", "copy_artifact");
      return this.#portResult("share_enrollment_response", outcome, this.#response, "Response handed to the operating-system share sheet.");
    });
  }

  inspectReceivedEnrollmentResponse(input: Readonly<{ request_text: string; possession_proof_text: string }>): Promise<Hc3WorkflowCommandResult> {
    return this.#run("inspect_received_enrollment_response", async () => {
      const requestCarrier = parseHc3ArtifactText(input.request_text).carrier;
      const proofCarrier = parseHc3ArtifactText(input.possession_proof_text).carrier;
      if (requestCarrier.artifact_kind !== "enrollment_request" || proofCarrier.artifact_kind !== "possession_proof") throw coded("response_parts_mismatched");
      const request = extractHc2HandoffPayload(requestCarrier as Hc3HandoffCarrier<"enrollment_request">);
      const possessionProof = extractHc2HandoffPayload(proofCarrier as Hc3HandoffCarrier<"possession_proof">);
      const evidence = await this.#readEvidence();
      const preview = parseHc3SafePreview(await this.#dependencies.operations.inspectEnrollmentResponse({ request, possession_proof: possessionProof, evidence }));
      if (preview.purpose !== "enrollment_response") throw coded("preview_purpose_mismatch");
      this.#receivedResponse = Object.freeze({ request, possession_proof: possessionProof });
      return this.#result("inspect_received_enrollment_response", createHc3WorkflowStatus("ready_for_confirmation", {
        explanation: "The Response is structurally valid. Revalidate it, then explicitly authorize admission.",
        actions: ["authorize_admission", "cancel_current_operational_step"], confirmation_required: true
      }), { preview });
    });
  }

  authorizeAdmission(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("authorize_admission", async () => {
      const response = required(this.#receivedResponse, "response_preview_required");
      const before = await this.#readMutableEvidence();
      const operation = parseOperation(await this.#dependencies.operations.authorizeAdmission({ ...response, expected_revision: before.revision }));
      const after = await this.#readEvidence();
      return this.#result("authorize_admission", deriveAfterOperation(after, operation, "Admission authorized. Export the encrypted admission file explicitly."), { authoritative_status: operation.status });
    });
  }

  exportAdmissionBundle(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("export_admission_bundle", async () => {
      if (!this.#admission) this.#admission = await this.#prepareBundle("admission");
      const artifact = this.#admission;
      const outcome = await safePort(() => this.#dependencies.ports.save.save({
        exact_bytes: Uint8Array.from(artifact.exact_bytes), filename: artifact.filename, media_type: artifact.media_type
      }), "file_save_failed", "retry_same_artifact");
      return this.#bundlePortResult("export_admission_bundle", outcome, artifact, "Encrypted admission file saved.");
    });
  }

  selectAdmissionBundle(): Promise<Hc3WorkflowCommandResult> {
    return this.#selectBundle("select_admission_bundle", "admission");
  }

  previewAdmissionImport(): Promise<Hc3WorkflowCommandResult> {
    return this.#previewBundle("preview_admission_import", "admission");
  }

  confirmAdmissionImport(): Promise<Hc3WorkflowCommandResult> {
    return this.#confirmBundle("confirm_admission_import", "admission");
  }

  exportSynchronizationBundle(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("export_synchronization_bundle", async () => {
      if (!this.#synchronization) this.#synchronization = await this.#prepareBundle("synchronization");
      const artifact = this.#synchronization;
      const outcome = await safePort(() => this.#dependencies.ports.save.save({
        exact_bytes: Uint8Array.from(artifact.exact_bytes), filename: artifact.filename, media_type: artifact.media_type
      }), "file_save_failed", "retry_same_artifact");
      return this.#bundlePortResult("export_synchronization_bundle", outcome, artifact, "Encrypted update saved.");
    });
  }

  selectSynchronizationBundle(): Promise<Hc3WorkflowCommandResult> {
    return this.#selectBundle("select_synchronization_bundle", "synchronization");
  }

  previewSynchronizationImport(): Promise<Hc3WorkflowCommandResult> {
    return this.#previewBundle("preview_synchronization_import", "synchronization");
  }

  confirmSynchronizationImport(): Promise<Hc3WorkflowCommandResult> {
    return this.#confirmBundle("confirm_synchronization_import", "synchronization");
  }

  inspectConvergence(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("inspect_convergence", async () => {
      const evidence = await this.#readEvidence();
      const convergence = await this.#dependencies.operations.inspectConvergence({ evidence });
      const status = convergence.converged && !convergence.more_required
        ? createHc3WorkflowStatus("completed", { explanation: "Sync complete. Reopened authoritative and projected evidence matches." })
        : createHc3WorkflowStatus("ready", { explanation: "More manual exchanges are required. Export another Encrypted update explicitly.", actions: ["export_synchronization_bundle", "select_synchronization_bundle"], diagnostic_code: convergence.diagnostic_code });
      return this.#result("inspect_convergence", status);
    });
  }

  cancelCurrentOperationalStep(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("cancel_current_operational_step", async () => {
      this.#receivedInvitation = null;
      this.#receivedResponse = null;
      this.#selectedAdmission = null;
      this.#selectedSynchronization = null;
      return this.#result("cancel_current_operational_step", createHc3WorkflowStatus("cancelled", {
        explanation: "The preview or selection was cleared. No authoritative operation was invoked; prepared outbound artifacts remain available for retry.",
        artifact_available: Boolean(this.#invitation || this.#response.length || this.#admission || this.#synchronization)
      }));
    });
  }

  reconstructWorkflowGuidanceAfterReopen(): Promise<Hc3WorkflowCommandResult> {
    return this.#run("reconstruct_workflow_guidance_after_reopen", async () => {
      this.#receivedInvitation = null;
      this.#receivedResponse = null;
      this.#selectedAdmission = null;
      this.#selectedSynchronization = null;
      const evidence = await this.#readEvidence();
      return this.#result("reconstruct_workflow_guidance_after_reopen", deriveHc3WorkflowStatus(evidence));
    });
  }

  async #prepareBundle(purpose: "admission" | "synchronization"): Promise<Hc3PreparedEncryptedArtifact> {
    const before = await this.#readMutableEvidence();
    const prepared = purpose === "admission"
      ? await this.#dependencies.operations.prepareAdmissionBundle({ expected_revision: before.revision })
      : await this.#dependencies.operations.prepareSynchronizationBundle({ expected_revision: before.revision });
    const exact = Uint8Array.from(prepared);
    const evidence = await inspectHc3EncryptedBundleFile({ exact_bytes: exact, sha256_factory: this.#dependencies.sha256_factory });
    const expectedVersion = purpose === "admission" ? 2 : 3;
    if (evidence.bundle_version !== expectedVersion) throw coded(purpose === "admission" ? "admission_requires_v2" : "synchronization_requires_v3");
    const metadata = hc3EncryptedBundleFileMetadata();
    await this.#readEvidence();
    return Object.freeze({
      authority: "none",
      purpose: purpose === "admission" ? "admission" : "encrypted_update",
      filename: createHc3EncryptedBundleFilename(evidence.sha256),
      media_type: metadata.media_type,
      exact_bytes: exact,
      evidence
    });
  }

  #selectBundle(command: "select_admission_bundle" | "select_synchronization_bundle", purpose: "admission" | "synchronization"): Promise<Hc3WorkflowCommandResult> {
    return this.#run(command, async () => {
      const selected = await safePort(() => this.#dependencies.ports.select.select({ maximum_byte_length: hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes }), "file_selection_failed", null);
      if (selected.status !== "success") return this.#failedPort(command, selected);
      const copied = copySelected(selected.value);
      const metadata = await safePort(() => this.#dependencies.ports.metadata.inspect(copySelected(copied)), "file_metadata_failed", null);
      if (metadata.status !== "success") return this.#failedPort(command, metadata);
      const value: SelectedBundle = Object.freeze({ selected: copied, inspection: null, preview: null });
      if (purpose === "admission") this.#selectedAdmission = value;
      else this.#selectedSynchronization = value;
      return this.#result(command, createHc3WorkflowStatus("received_unverified", {
        explanation: `The selected ${purpose === "admission" ? "admission file" : "Encrypted update"} has not been imported. Preview it explicitly before confirmation.`,
        actions: [purpose === "admission" ? "preview_admission_import" : "preview_synchronization_import", "cancel_current_operational_step"]
      }), { port_status: "success" });
    });
  }

  #previewBundle(command: "preview_admission_import" | "preview_synchronization_import", purpose: "admission" | "synchronization"): Promise<Hc3WorkflowCommandResult> {
    return this.#run(command, async () => {
      const selected = required(purpose === "admission" ? this.#selectedAdmission : this.#selectedSynchronization, "file_selection_required");
      const inspection = await inspectHc3EncryptedBundleFile({ exact_bytes: Uint8Array.from(selected.selected.exact_bytes), sha256_factory: this.#dependencies.sha256_factory });
      const expectedVersion = purpose === "admission" ? 2 : 3;
      if (inspection.bundle_version !== expectedVersion) throw coded("mixed_or_wrong_bundle_version");
      const evidence = await this.#readEvidence();
      const preview = parseHc3SafePreview(await this.#dependencies.operations.previewEncryptedBundle({ purpose, exact_bytes: Uint8Array.from(selected.selected.exact_bytes), evidence }));
      const expectedPurpose = purpose === "admission" ? "admission" : "encrypted_update";
      if (preview.purpose !== expectedPurpose) throw coded("preview_purpose_mismatch");
      const updated = Object.freeze({ selected: selected.selected, inspection, preview });
      if (purpose === "admission") this.#selectedAdmission = updated;
      else this.#selectedSynchronization = updated;
      return this.#result(command, createHc3WorkflowStatus("ready_for_confirmation", {
        explanation: `The ${expectedPurpose === "admission" ? "admission file" : "Encrypted update"} is structurally valid, but acceptance still depends on current HC-2 authority.`,
        actions: [purpose === "admission" ? "confirm_admission_import" : "confirm_synchronization_import", "cancel_current_operational_step"],
        confirmation_required: true
      }), { preview });
    });
  }

  #confirmBundle(command: "confirm_admission_import" | "confirm_synchronization_import", purpose: "admission" | "synchronization"): Promise<Hc3WorkflowCommandResult> {
    return this.#run(command, async () => {
      const selected = required(purpose === "admission" ? this.#selectedAdmission : this.#selectedSynchronization, "file_selection_required");
      if (!selected.inspection || !selected.preview) throw coded("file_preview_required");
      if (this.#dependencies.ports.confirmation) {
        const confirmation = await safePort(() => this.#dependencies.ports.confirmation!.confirm({
          title: purpose === "admission" ? "Import admission file?" : "Import Encrypted update?",
          explanation: "Patchmark will revalidate current project authority and then perform one atomic import."
        }), "confirmation_failed", null);
        if (confirmation.status !== "success") return this.#failedPort(command, confirmation);
      }
      const before = await this.#readMutableEvidence();
      const exact = Uint8Array.from(selected.selected.exact_bytes);
      const operation = parseOperation(purpose === "admission"
        ? await this.#dependencies.operations.confirmAdmissionImport({ exact_bytes: exact, expected_revision: before.revision })
        : await this.#dependencies.operations.confirmSynchronizationImport({ exact_bytes: exact, expected_revision: before.revision }));
      const after = await this.#readEvidence();
      const explanation = operation.status === "duplicate"
        ? "This exact file was already accepted. No additional object or authority was created."
        : purpose === "admission"
          ? "Admission completed and was verified after durable reopen."
          : "Encrypted update imported atomically and verified after durable reopen.";
      return this.#result(command, deriveAfterOperation(after, operation, explanation), { preview: selected.preview, authoritative_status: operation.status });
    });
  }

  async #readEvidence(): Promise<Hc3WorkflowEvidence> {
    return parseHc3WorkflowEvidence(await this.#dependencies.evidence.readEvidence());
  }

  async #readMutableEvidence(): Promise<Hc3WorkflowEvidence> {
    const evidence = await this.#readEvidence();
    if (deriveHc3WorkflowStatus(evidence).state === "blocked") throw coded("authoritative_evidence_blocked");
    return evidence;
  }

  async #run(command: Hc3WorkflowCommand, operation: () => Promise<Hc3WorkflowCommandResult>): Promise<Hc3WorkflowCommandResult> {
    try {
      return await operation();
    } catch (error) {
      return this.#result(command, createHc3WorkflowStatus("blocked", {
        explanation: recoveryExplanation(diagnosticCode(error)),
        actions: ["cancel_current_operational_step", "reconstruct_workflow_guidance_after_reopen"],
        diagnostic_code: diagnosticCode(error)
      }));
    }
  }

  #portResult(
    command: Hc3WorkflowCommand,
    port: Hc3PortResult<unknown>,
    artifacts: readonly Hc3PreparedTextArtifact[],
    completedExplanation: string
  ): Hc3WorkflowCommandResult {
    if (port.status !== "success") return this.#failedPort(command, port, artifacts);
    const nextActions = artifacts.some((artifact) => artifact.purpose === "invitation")
      ? ["copy_invitation", "present_invitation_as_qr", "share_invitation"] as const
      : ["copy_enrollment_response", "share_enrollment_response"] as const;
    return this.#result(command, createHc3WorkflowStatus("completed", {
      explanation: completedExplanation,
      actions: nextActions,
      artifact_available: true
    }), { text_artifacts: artifacts, port_status: "success" });
  }

  #bundlePortResult(
    command: Hc3WorkflowCommand,
    port: Hc3PortResult<unknown>,
    artifact: Hc3PreparedEncryptedArtifact,
    completedExplanation: string
  ): Hc3WorkflowCommandResult {
    if (port.status !== "success") return this.#failedPort(command, port, [], artifact);
    return this.#result(command, createHc3WorkflowStatus("completed", {
      explanation: completedExplanation,
      artifact_available: true
    }), { encrypted_artifact: artifact, port_status: "success" });
  }

  #failedPort(
    command: Hc3WorkflowCommand,
    port: Exclude<Hc3PortResult<unknown>, { status: "success" }>,
    artifacts: readonly Hc3PreparedTextArtifact[] = [],
    encryptedArtifact: Hc3PreparedEncryptedArtifact | null = null
  ): Hc3WorkflowCommandResult {
    const state = port.status === "cancelled" ? "cancelled" : port.status === "unsupported" ? "unsupported" : "blocked";
    return this.#result(command, createHc3WorkflowStatus(state, {
      explanation: portExplanation(port.status, port.fallback),
      actions: retryActions(command, port.fallback),
      artifact_available: Boolean(artifacts.length || encryptedArtifact),
      classification: port.status === "failed" || port.status === "permission_denied" ? "recoverable" : undefined,
      diagnostic_code: port.diagnostic_code
    }), { text_artifacts: artifacts, encrypted_artifact: encryptedArtifact, port_status: port.status });
  }

  #result(command: Hc3WorkflowCommand, status: Hc3WorkflowStatus, partial: Partial<Omit<Hc3WorkflowCommandResult, "authority" | "command" | "status">> = {}): Hc3WorkflowCommandResult {
    return Object.freeze({
      authority: "none",
      command,
      status,
      preview: partial.preview ?? null,
      text_artifacts: Object.freeze([...(partial.text_artifacts ?? [])].map(copyTextArtifact)),
      encrypted_artifact: partial.encrypted_artifact ? copyEncryptedArtifact(partial.encrypted_artifact) : null,
      port_status: partial.port_status ?? null,
      authoritative_status: partial.authoritative_status ?? null
    });
  }
}

function parseOperation(value: unknown): Hc3AuthoritativeOperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("operation_result_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "diagnostic_code,status") throw coded("operation_result_invalid");
  if (record.status !== "completed" && record.status !== "duplicate" && record.status !== "more_required") throw coded("operation_status_invalid");
  if (record.diagnostic_code !== null && (typeof record.diagnostic_code !== "string" || !/^[a-z0-9_]{1,64}$/.test(record.diagnostic_code))) throw coded("operation_diagnostic_invalid");
  return Object.freeze({ status: record.status, diagnostic_code: record.diagnostic_code as string | null });
}

function deriveAfterOperation(evidence: Hc3WorkflowEvidence, operation: Hc3AuthoritativeOperationResult, explanation: string): Hc3WorkflowStatus {
  const derived = deriveHc3WorkflowStatus(evidence);
  if (derived.state === "blocked") return derived;
  if (operation.status === "more_required") return createHc3WorkflowStatus("ready", {
    explanation: "The operation completed, but another explicit manual exchange is required.",
    actions: ["export_synchronization_bundle", "select_synchronization_bundle"], diagnostic_code: operation.diagnostic_code
  });
  return createHc3WorkflowStatus("completed", { explanation, diagnostic_code: operation.diagnostic_code });
}

async function safePort<T>(
  operation: () => Promise<Hc3PortResult<T>>,
  fallbackCode: string,
  fallback: string | null
): Promise<Hc3PortResult<T>> {
  try {
    const result = await operation();
    if (!result || typeof result !== "object" || !("status" in result)) throw new Error("invalid port result");
    if (result.status === "success") return Object.freeze({ status: "success", value: copyPortValue(result.value) });
    if (!["cancelled", "unsupported", "permission_denied", "failed"].includes(result.status)) throw new Error("invalid port status");
    return Object.freeze({ status: result.status, diagnostic_code: result.diagnostic_code, fallback: result.fallback });
  } catch {
    return Object.freeze({ status: "failed", diagnostic_code: fallbackCode, fallback });
  }
}

function required<T>(value: T | null, code: string): T {
  if (value === null) throw coded(code);
  return value;
}

function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function diagnosticCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)) return error.code;
  return "workflow_validation_failed";
}

function recoveryExplanation(code: string): string {
  const messages: Record<string, string> = {
    wrong_recipient: "This encrypted file is for a different device. Ask for a new file addressed to this device.",
    wrong_project: "This artifact belongs to a different project. Return to the intended local project.",
    stale_control: "The project authority changed after this artifact was prepared. Exchange a current artifact.",
    stale_epoch: "This encrypted file uses an old key epoch. Ask an active device for a current update.",
    revoked_device: "A device involved in this handoff is revoked. A current authorized device must prepare a new artifact.",
    gap: "This update depends on missing earlier records. Exchange another dependency-closed update first.",
    replay: "This artifact conflicts with accepted stream continuity. Reopen the project and inspect synchronization guidance.",
    fork: "The replicas contain a conflicting history. Automatic selection is forbidden; resolve the fork through authoritative recovery.",
    file_preview_required: "Preview the selected file before confirming import.",
    response_preview_required: "Inspect the Response before authorizing admission.",
    invitation_preview_required: "Inspect the Invitation before beginning enrollment."
  };
  return messages[code] ?? "Validation failed safely. Nothing was accepted; inspect the artifact and current local project state before retrying.";
}

function portExplanation(status: Exclude<Hc3PortResult<unknown>, { status: "success" }>["status"], fallback: string | null): string {
  if (status === "cancelled") return "The operating-system action was cancelled. Nothing changed, and the same artifact remains available.";
  if (status === "unsupported") return fallback ? `This capability is unavailable. Use the ${fallback.replaceAll("_", " ")} fallback.` : "This capability is unavailable on this platform.";
  if (status === "permission_denied") return "The browser or operating system denied permission. Nothing changed; adjust permission or choose a fallback.";
  return "The browser action failed. Nothing changed, and the exact prepared artifact remains available for retry.";
}

function retryActions(command: Hc3WorkflowCommand, fallback: string | null): readonly Hc3WorkflowCommand[] {
  if (fallback === "copy_artifact" || fallback === "copy_or_share" || fallback === "keep_artifact_for_manual_copy") return command.includes("response")
    ? ["copy_enrollment_response"] : ["copy_invitation", "share_invitation"];
  if (command === "export_admission_bundle") return ["export_admission_bundle"];
  if (command === "export_synchronization_bundle") return ["export_synchronization_bundle"];
  return ["cancel_current_operational_step"];
}

function freezeText(purpose: Hc3PreparedTextArtifact["purpose"], text: Hc3ArtifactText): Hc3PreparedTextArtifact {
  return Object.freeze({ authority: "none", purpose, text });
}

function copyTextArtifact(value: Hc3PreparedTextArtifact): Hc3PreparedTextArtifact {
  return Object.freeze({ ...value });
}

function copyEncryptedArtifact(value: Hc3PreparedEncryptedArtifact): Hc3PreparedEncryptedArtifact {
  return Object.freeze({ ...value, exact_bytes: Uint8Array.from(value.exact_bytes), evidence: Object.freeze({ ...value.evidence, container_ids: Object.freeze([...value.evidence.container_ids]) }) });
}

function copySelected(value: Hc3SelectedEncryptedFile): Hc3SelectedEncryptedFile {
  if (!(value.exact_bytes instanceof Uint8Array) || value.reported_size !== BigInt(value.exact_bytes.byteLength)) throw coded("selected_file_size_mismatch");
  return Object.freeze({ ...value, exact_bytes: Uint8Array.from(value.exact_bytes) });
}

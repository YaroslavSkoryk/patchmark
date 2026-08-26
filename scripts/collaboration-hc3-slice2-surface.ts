import type {
  Hc3WorkflowCommand,
  Hc3WorkflowCommandResult
} from "../lib/collaboration/hc3/index.ts";

export interface Hc3Slice2SurfaceFacade {
  inspectCollaborationReadiness(): Promise<Hc3WorkflowCommandResult>;
  createInvitationHandoff(): Promise<Hc3WorkflowCommandResult>;
  copyInvitation(): Promise<Hc3WorkflowCommandResult>;
  presentInvitationAsQr(): Promise<Hc3WorkflowCommandResult>;
  shareInvitation(): Promise<Hc3WorkflowCommandResult>;
  inspectReceivedInvitation(text: string): Promise<Hc3WorkflowCommandResult>;
  beginEnrollment(): Promise<Hc3WorkflowCommandResult>;
  createEnrollmentResponse(): Promise<Hc3WorkflowCommandResult>;
  copyEnrollmentResponse(): Promise<Hc3WorkflowCommandResult>;
  shareEnrollmentResponse(): Promise<Hc3WorkflowCommandResult>;
  inspectReceivedEnrollmentResponse(input: Readonly<{ request_text: string; possession_proof_text: string }>): Promise<Hc3WorkflowCommandResult>;
  authorizeAdmission(): Promise<Hc3WorkflowCommandResult>;
  exportAdmissionBundle(): Promise<Hc3WorkflowCommandResult>;
  selectAdmissionBundle(): Promise<Hc3WorkflowCommandResult>;
  previewAdmissionImport(): Promise<Hc3WorkflowCommandResult>;
  confirmAdmissionImport(): Promise<Hc3WorkflowCommandResult>;
  exportSynchronizationBundle(): Promise<Hc3WorkflowCommandResult>;
  selectSynchronizationBundle(): Promise<Hc3WorkflowCommandResult>;
  previewSynchronizationImport(): Promise<Hc3WorkflowCommandResult>;
  confirmSynchronizationImport(): Promise<Hc3WorkflowCommandResult>;
  inspectConvergence(): Promise<Hc3WorkflowCommandResult>;
  cancelCurrentOperationalStep(): Promise<Hc3WorkflowCommandResult>;
  reconstructWorkflowGuidanceAfterReopen(): Promise<Hc3WorkflowCommandResult>;
}

const labels: Readonly<Record<Hc3WorkflowCommand, string>> = Object.freeze({
  inspect_collaboration_readiness: "Check readiness",
  create_invitation_handoff: "Create Invitation",
  copy_invitation: "Copy Invitation",
  present_invitation_as_qr: "Show Invitation as QR",
  share_invitation: "Share Invitation",
  inspect_received_invitation: "Preview Invitation",
  begin_enrollment: "Continue with enrollment",
  create_enrollment_response: "Create Response",
  copy_enrollment_response: "Copy Response",
  share_enrollment_response: "Share Response",
  inspect_received_enrollment_response: "Preview Response",
  authorize_admission: "Authorize admission",
  export_admission_bundle: "Save admission file",
  select_admission_bundle: "Select admission file",
  preview_admission_import: "Preview admission import",
  confirm_admission_import: "Confirm admission import",
  export_synchronization_bundle: "Save Encrypted update",
  select_synchronization_bundle: "Select Encrypted update",
  preview_synchronization_import: "Preview Encrypted update",
  confirm_synchronization_import: "Confirm update import",
  inspect_convergence: "Verify Sync complete",
  cancel_current_operational_step: "Cancel",
  reconstruct_workflow_guidance_after_reopen: "Recheck after reopen"
});

export async function mountHc3Slice2QualificationSurface(
  root: HTMLElement,
  facade: Hc3Slice2SurfaceFacade
): Promise<Readonly<{ destroy(): void; invoke(action: Hc3WorkflowCommand): Promise<void> }>> {
  root.replaceChildren();
  root.setAttribute("data-testid", "hc3-slice2-test-only-surface");
  root.style.cssText = "box-sizing:border-box;max-width:42rem;margin:0 auto;padding:1rem;font:16px/1.5 system-ui;color:#171717";

  const heading = element("h1", "Manual collaboration");
  const intro = element("p", "Exchange Invitations, Responses, and Encrypted updates directly. Patchmark does not contact a cloud service.");
  const status = element("section");
  status.id = "workflow-status";
  status.tabIndex = -1;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");

  const invitationLabel = element("label", "Invitation or link");
  invitationLabel.htmlFor = "received-invitation";
  const invitationInput = document.createElement("textarea");
  invitationInput.id = "received-invitation";
  invitationInput.rows = 3;
  invitationInput.autocomplete = "off";
  invitationInput.setAttribute("aria-describedby", "artifact-privacy-note");

  const requestLabel = element("label", "Response");
  requestLabel.htmlFor = "received-response";
  const requestInput = document.createElement("textarea");
  requestInput.id = "received-response";
  requestInput.rows = 3;
  requestInput.autocomplete = "off";

  const proofLabel = element("label", "Response verification");
  proofLabel.htmlFor = "received-proof";
  const proofInput = document.createElement("textarea");
  proofInput.id = "received-proof";
  proofInput.rows = 3;
  proofInput.autocomplete = "off";

  const privacy = element("p", "Artifacts are not trusted until you preview and explicitly confirm them. Local filenames and paths are never shown.");
  privacy.id = "artifact-privacy-note";
  const actions = element("div");
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "Available collaboration actions");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:.75rem;margin-block:1rem";

  const confirmation = element("p");
  confirmation.id = "confirmation-boundary";
  confirmation.setAttribute("role", "note");

  const details = document.createElement("details");
  const summary = element("summary", "Technical details");
  const detailText = document.createElement("pre");
  detailText.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
  details.append(summary, detailText);

  for (const input of [invitationInput, requestInput, proofInput]) input.style.cssText = "box-sizing:border-box;width:100%;max-width:100%;margin-block:.25rem 1rem";
  root.append(heading, intro, status, invitationLabel, invitationInput, requestLabel, requestInput, proofLabel, proofInput, privacy, confirmation, actions, details);

  let destroyed = false;
  let current = await facade.inspectCollaborationReadiness();
  render(current, false);

  async function invoke(action: Hc3WorkflowCommand): Promise<void> {
    if (destroyed) return;
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    current = await invokeFacade(facade, action, { invitation: invitationInput.value, request: requestInput.value, proof: proofInput.value });
    render(current, true);
  }

  function render(result: Hc3WorkflowCommandResult, moveFocus: boolean): void {
    status.replaceChildren(element("h2", result.status.title), element("p", result.status.explanation));
    status.setAttribute("data-state", result.status.state);
    status.setAttribute("data-classification", result.status.classification);
    confirmation.textContent = result.status.confirmation_required
      ? "Confirmation required: previewing alone will not change membership or project data."
      : "No confirmation is pending.";
    actions.replaceChildren();
    for (const action of result.status.available_actions) {
      const button = element("button", labels[action]);
      button.type = "button";
      button.dataset.action = action;
      button.setAttribute("aria-describedby", result.status.confirmation_required ? "confirmation-boundary" : "workflow-status");
      button.addEventListener("click", () => { void invoke(action); });
      actions.append(button);
    }
    detailText.textContent = JSON.stringify({
      state: result.status.state,
      diagnostic_code: result.status.technical_diagnostic_code,
      preview: result.preview?.technical_details ?? null
    }, null, 2);
    if (moveFocus) status.focus();
  }

  return Object.freeze({ destroy() { destroyed = true; root.replaceChildren(); }, invoke });
}

async function invokeFacade(
  facade: Hc3Slice2SurfaceFacade,
  action: Hc3WorkflowCommand,
  input: Readonly<{ invitation: string; request: string; proof: string }>
): Promise<Hc3WorkflowCommandResult> {
  switch (action) {
    case "inspect_collaboration_readiness": return facade.inspectCollaborationReadiness();
    case "create_invitation_handoff": return facade.createInvitationHandoff();
    case "copy_invitation": return facade.copyInvitation();
    case "present_invitation_as_qr": return facade.presentInvitationAsQr();
    case "share_invitation": return facade.shareInvitation();
    case "inspect_received_invitation": return facade.inspectReceivedInvitation(input.invitation);
    case "begin_enrollment": return facade.beginEnrollment();
    case "create_enrollment_response": return facade.createEnrollmentResponse();
    case "copy_enrollment_response": return facade.copyEnrollmentResponse();
    case "share_enrollment_response": return facade.shareEnrollmentResponse();
    case "inspect_received_enrollment_response": return facade.inspectReceivedEnrollmentResponse({ request_text: input.request, possession_proof_text: input.proof });
    case "authorize_admission": return facade.authorizeAdmission();
    case "export_admission_bundle": return facade.exportAdmissionBundle();
    case "select_admission_bundle": return facade.selectAdmissionBundle();
    case "preview_admission_import": return facade.previewAdmissionImport();
    case "confirm_admission_import": return facade.confirmAdmissionImport();
    case "export_synchronization_bundle": return facade.exportSynchronizationBundle();
    case "select_synchronization_bundle": return facade.selectSynchronizationBundle();
    case "preview_synchronization_import": return facade.previewSynchronizationImport();
    case "confirm_synchronization_import": return facade.confirmSynchronizationImport();
    case "inspect_convergence": return facade.inspectConvergence();
    case "cancel_current_operational_step": return facade.cancelCurrentOperationalStep();
    case "reconstruct_workflow_guidance_after_reopen": return facade.reconstructWorkflowGuidanceAfterReopen();
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  return value;
}

import type { EventControlProjectState } from "../event-control-types.ts";
import {
  parseControlActionCore,
  parseControlActionRecord,
  parseControlEventRecordStructure,
  type ControlActionRecord,
  type ControlEventRecord,
  type Hc2InvitationCancelAction,
  type Hc2InvitationCreateAction
} from "../control.ts";
import type {
  AccessScopeId,
  ControlEventId,
  DeviceId,
  InvitationId,
  MembershipId,
  PersonId,
  ProjectId
} from "../identities.ts";
import { deriveControlActionIdentity, deriveControlEventCoreIdentity } from "../preimages.ts";
import type { CollaborationRole } from "../capabilities.ts";
import type { UInt64 } from "../validation.ts";
import {
  deriveInvitationEvidenceIdentity,
  deriveInvitationHandoffIdentity,
  parseAcceptedMembershipState,
  parseInvitationEvidenceCore,
  parseInvitationHandoffCore,
  type AcceptedMembershipState,
  type InvitationEvidenceCore,
  type InvitationHandoffCore
} from "./enrollment-contracts.ts";
import type { InvitationEvidenceId, InvitationHandoffId } from "./identities.ts";
import { HC2_CRYPTO_SUITE_ID } from "./versions.ts";

export function createInvitationAction(input: Readonly<{
  project_id: ProjectId;
  invitation_id: InvitationId;
  inviting_membership_id: MembershipId;
  inviting_person_id: PersonId;
  inviting_device_id: DeviceId;
  intended_role: CollaborationRole;
  access_scope_id: AccessScopeId;
  creation_control_head_id: ControlEventId;
  valid_through_control_sequence: UInt64;
}>): Hc2InvitationCreateAction {
  return parseControlActionCore({
    schema_version: 1,
    project_id: input.project_id,
    action_kind: "hc2_invitation_create",
    invitation_id: input.invitation_id,
    inviting_membership_id: input.inviting_membership_id,
    inviting_person_id: input.inviting_person_id,
    inviting_device_id: input.inviting_device_id,
    intended_role: input.intended_role,
    access_scope: "project_wide",
    access_scope_id: input.access_scope_id,
    creation_control_head_id: input.creation_control_head_id,
    valid_through_control_sequence: input.valid_through_control_sequence,
    suite_id: HC2_CRYPTO_SUITE_ID
  }) as Hc2InvitationCreateAction;
}

export function createInvitationCancelAction(input: Readonly<{
  project_id: ProjectId;
  invitation_id: InvitationId;
  invitation_control_event_id: ControlEventId;
}>): Hc2InvitationCancelAction {
  return parseControlActionCore({
    schema_version: 1,
    project_id: input.project_id,
    action_kind: "hc2_invitation_cancel",
    invitation_id: input.invitation_id,
    invitation_control_event_id: input.invitation_control_event_id,
    suite_id: HC2_CRYPTO_SUITE_ID
  }) as Hc2InvitationCancelAction;
}

export async function materializeAcceptedInvitation(input: Readonly<{
  previous_state: AcceptedMembershipState;
  action: ControlActionRecord;
  event: ControlEventRecord;
  reconstructed_state: EventControlProjectState;
}>): Promise<Readonly<{
  evidence: InvitationEvidenceCore;
  evidence_id: InvitationEvidenceId;
  handoff: InvitationHandoffCore;
  handoff_id: InvitationHandoffId;
  next_state: AcceptedMembershipState;
}>> {
  const previous = parseAcceptedMembershipState(input.previous_state);
  const action = parseControlActionRecord(input.action);
  const event = parseControlEventRecordStructure(input.event);
  if (action.core.action_kind !== "hc2_invitation_create" || event.core.control_kind !== "ordinary") {
    throw new Error("Accepted invitation evidence requires an ordinary invitation-create control event.");
  }
  await assertAcceptedControlRecord(action, event, input.reconstructed_state);
  assertOwnerControl(previous, action.core.inviting_membership_id, action.core.inviting_person_id, action.core.inviting_device_id);
  if (action.core.project_id !== previous.project_id || action.core.creation_control_head_id !== previous.control_head_id ||
      event.core.previous_control_id !== previous.control_head_id || event.core.control_sequence !== previous.control_sequence + BigInt(1) ||
      action.core.valid_through_control_sequence < event.core.control_sequence || event.core.key_epoch_id !== previous.current_epoch_id ||
      event.core.key_epoch_commitment !== previous.current_epoch_commitment) {
    throw new Error("Invitation creation does not extend the exact accepted control state or validity boundary.");
  }
  const evidence = parseInvitationEvidenceCore({
    schema_version: 1,
    record_kind: "invitation_evidence_core",
    authority: "none",
    project_id: previous.project_id,
    invitation_id: action.core.invitation_id,
    inviting_membership_id: action.core.inviting_membership_id,
    inviting_person_id: action.core.inviting_person_id,
    inviting_device_id: action.core.inviting_device_id,
    intended_role: action.core.intended_role,
    access_scope: "project_wide",
    access_scope_id: action.core.access_scope_id,
    creation_control_head_id: previous.control_head_id,
    creation_control_sequence: event.core.control_sequence,
    valid_through_control_sequence: action.core.valid_through_control_sequence,
    accepted_invitation_action_id: action.action_id,
    accepted_invitation_control_event_id: event.control_event_id,
    status: "accepted",
    suite_id: HC2_CRYPTO_SUITE_ID
  });
  const evidenceIdentity = await deriveInvitationEvidenceIdentity(evidence);
  const handoff = parseInvitationHandoffCore({
    schema_version: 1,
    record_kind: "invitation_handoff_core",
    authority: "none",
    project_id: previous.project_id,
    invitation_id: evidence.invitation_id,
    invitation_evidence_id: evidenceIdentity.id,
    accepted_invitation_control_event_id: event.control_event_id,
    intended_role: evidence.intended_role,
    access_scope: "project_wide",
    suite_id: HC2_CRYPTO_SUITE_ID
  });
  const handoffIdentity = await deriveInvitationHandoffIdentity(handoff);
  const nextState = parseAcceptedMembershipState({
    ...previous,
    control_head_id: event.control_event_id,
    control_sequence: event.core.control_sequence
  });
  return Object.freeze({ evidence, evidence_id: evidenceIdentity.id, handoff, handoff_id: handoffIdentity.id, next_state: nextState });
}

export async function applyAcceptedInvitationCancellation(input: Readonly<{
  previous_state: AcceptedMembershipState;
  evidence: InvitationEvidenceCore;
  action: ControlActionRecord;
  event: ControlEventRecord;
  reconstructed_state: EventControlProjectState;
}>): Promise<AcceptedMembershipState> {
  const previous = parseAcceptedMembershipState(input.previous_state);
  const evidence = parseInvitationEvidenceCore(input.evidence);
  const action = parseControlActionRecord(input.action);
  const event = parseControlEventRecordStructure(input.event);
  if (action.core.action_kind !== "hc2_invitation_cancel" || event.core.control_kind !== "ordinary") throw new Error("Invitation cancellation requires its ordinary control action.");
  const eventCore = event.core;
  await assertAcceptedControlRecord(action, event, input.reconstructed_state);
  const device = previous.devices.find((entry) => entry.device_id === eventCore.issuer_device_id);
  if (!device) throw new Error("Invitation cancellation issuer is absent from accepted state.");
  assertOwnerControl(previous, device.membership_id, device.person_id, device.device_id);
  if (action.core.project_id !== previous.project_id || action.core.invitation_id !== evidence.invitation_id ||
      action.core.invitation_control_event_id !== evidence.accepted_invitation_control_event_id ||
      eventCore.previous_control_id !== previous.control_head_id || eventCore.control_sequence !== previous.control_sequence + BigInt(1) ||
      eventCore.key_epoch_id !== previous.current_epoch_id || eventCore.key_epoch_commitment !== previous.current_epoch_commitment ||
      previous.consumed_invitation_ids.includes(evidence.invitation_id) || previous.cancelled_invitation_ids.includes(evidence.invitation_id)) {
    throw new Error("Invitation cancellation does not extend the exact unused invitation state.");
  }
  return parseAcceptedMembershipState({ ...previous, control_head_id: event.control_event_id, control_sequence: eventCore.control_sequence,
    cancelled_invitation_ids: Object.freeze([...previous.cancelled_invitation_ids, evidence.invitation_id].sort()) });
}

async function assertAcceptedControlRecord(action: ControlActionRecord, event: ControlEventRecord, state: EventControlProjectState): Promise<void> {
  const [actionIdentity, eventIdentity] = await Promise.all([deriveControlActionIdentity(action.core), deriveControlEventCoreIdentity(event.core)]);
  if (actionIdentity.id !== action.action_id || eventIdentity.id !== event.control_event_id || event.core.control_kind !== "ordinary" ||
      event.core.action_id !== action.action_id || !state.accepted_control_event_ids.includes(event.control_event_id)) {
    throw new Error("Invitation control evidence is not an accepted identity-bound HC-1 event.");
  }
}

function assertOwnerControl(state: AcceptedMembershipState, membershipId: MembershipId, personId: PersonId, deviceId: DeviceId): void {
  const membership = state.memberships.find((entry) => entry.membership_id === membershipId);
  const device = state.devices.find((entry) => entry.device_id === deviceId);
  if (!membership || membership.status !== "active" || membership.role !== "owner" || membership.person_id !== personId ||
      !device || device.status !== "active" || device.membership_id !== membershipId || device.person_id !== personId ||
      deviceId !== state.active_control_device_id) {
    throw new Error("Only the designated accepted owner control device may change invitation authority.");
  }
}

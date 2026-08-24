import { capabilitiesForRole, roleHasCapability } from "../capabilities.ts";
import type { ControlAuthorityState, DeviceAuthorityFact } from "../event-control-types.ts";
import {
  parseDigestId,
  type ControlEventId,
  type DeviceId,
  type InvitationId
} from "../identities.ts";
import { deriveControlStateRoot } from "../projection-roots.ts";
import {
  deriveDeliverySetIdentity,
  deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity,
  deriveMembershipTransitionIdentity,
  derivePossessionProofIdentity,
  deriveRecipientManifestIdentity,
  parseAcceptedMembershipState,
  parseDeliverySetCore,
  parseEnrollmentRequestRecord,
  parseInvitationEvidenceCore,
  parseMembershipTransitionCore,
  parsePossessionProofRecord,
  parseRecipientManifestCore,
  type AcceptedMembershipState,
  type DeliverySetCore,
  type EnrollmentRequestRecord,
  type InvitationEvidenceCore,
  type MembershipDeviceFact,
  type MembershipFact,
  type MembershipTransitionCore,
  type PossessionProofRecord,
  type RecipientManifestCore,
  type RecipientManifestEntry
} from "./enrollment-contracts.ts";
import type { MembershipTransitionId } from "./identities.ts";

export type VerifiedMembershipTransition = Readonly<{
  status: "verified";
  transition_id: MembershipTransitionId;
  next_state: AcceptedMembershipState;
  resulting_authority: ControlAuthorityState;
  recipient_manifest: RecipientManifestCore;
  delivery_set: DeliverySetCore;
}>;

export type MembershipTransitionRejection = Readonly<{
  status: "rejected";
  reason: string;
}>;

export type PrepareMembershipTransitionInput = Omit<
  MembershipTransitionCore,
  "schema_version" | "record_kind" | "authority" | "recipient_manifest_id" | "delivery_set_id" | "resulting_control_state_root"
>;

export async function prepareMembershipTransition(input: Readonly<{
  previous_state: AcceptedMembershipState;
  transition: PrepareMembershipTransitionInput;
}>): Promise<Readonly<{
  transition: MembershipTransitionCore;
  transition_id: MembershipTransitionId;
  recipient_manifest: RecipientManifestCore;
  delivery_set: DeliverySetCore;
}>> {
  const previous = parseAcceptedMembershipState(input.previous_state);
  const placeholder = "a".repeat(52);
  const provisional = parseMembershipTransitionCore({
    schema_version: 1,
    record_kind: "membership_epoch_transition_core",
    authority: "none",
    ...input.transition,
    recipient_manifest_id: `pm:recipient-manifest:v1:${placeholder}`,
    delivery_set_id: `pm:delivery-set:v1:${placeholder}`,
    resulting_control_state_root: `pm:control-state-root:v1:${placeholder}`
  });
  assertOwnerAuthority(previous, provisional);
  const post = applyMutation(previous, provisional);
  const manifest = parseRecipientManifestCore({ schema_version: 1, record_kind: "epoch_recipient_manifest_core", authority: "none", project_id: previous.project_id, previous_control_head_id: previous.control_head_id, mutation_kind: provisional.mutation_kind, replacement_epoch_id: provisional.replacement_epoch_id, replacement_epoch_commitment: provisional.replacement_epoch_commitment, recipients: activeRecipients(post.memberships, post.devices), suite_id: provisional.suite_id });
  const manifestId = (await deriveRecipientManifestIdentity(manifest)).id;
  const deliverySet = parseDeliverySetCore({ schema_version: 1, record_kind: "epoch_delivery_set_core", authority: "none", project_id: previous.project_id, previous_control_head_id: previous.control_head_id, recipient_manifest_id: manifestId, replacement_epoch_id: provisional.replacement_epoch_id, replacement_epoch_commitment: provisional.replacement_epoch_commitment, recipient_device_ids: manifest.recipients.map((entry) => entry.device_id), suite_id: provisional.suite_id });
  const deliverySetId = (await deriveDeliverySetIdentity(deliverySet)).id;
  const activeOwners = post.memberships.filter((entry) => entry.status === "active" && entry.role === "owner");
  if (activeOwners.length === 0) throw new Error("A membership transition must retain at least one accepted owner.");
  const ownerPersonId = activeOwners.map((entry) => entry.person_id).sort()[0];
  const root = await deriveControlStateRoot({ schema_version: 1, object_kind: "control_state_commitment", project_id: previous.project_id, owner_person_id: ownerPersonId, active_control_device_id: provisional.replacement_active_control_device_id, offline_root_key_id: previous.offline_root_key_id, key_epoch_id: provisional.replacement_epoch_id, key_epoch_commitment: provisional.replacement_epoch_commitment, merge_policy: previous.merge_policy, root_sequence: previous.root_sequence, recovery_last_uncontested_control_id: null, device_authorities: deviceAuthorityFacts(post.memberships, post.devices) });
  const transition = parseMembershipTransitionCore({ ...provisional, recipient_manifest_id: manifestId, delivery_set_id: deliverySetId, resulting_control_state_root: root.id });
  const identity = await deriveMembershipTransitionIdentity(transition);
  return Object.freeze({ transition, transition_id: identity.id, recipient_manifest: manifest, delivery_set: deliverySet });
}

export async function deriveRecipientManifest(input: Readonly<{
  previous_state: AcceptedMembershipState;
  transition: MembershipTransitionCore;
}>): Promise<Readonly<{ post_memberships: readonly MembershipFact[]; post_devices: readonly MembershipDeviceFact[]; manifest: RecipientManifestCore }>> {
  const previous = parseAcceptedMembershipState(input.previous_state);
  const transition = parseMembershipTransitionCore(input.transition);
  assertOwnerAuthority(previous, transition);
  const post = applyMutation(previous, transition);
  const recipients = activeRecipients(post.memberships, post.devices);
  const manifest = parseRecipientManifestCore({
    schema_version: 1,
    record_kind: "epoch_recipient_manifest_core",
    authority: "none",
    project_id: previous.project_id,
    previous_control_head_id: previous.control_head_id,
    mutation_kind: transition.mutation_kind,
    replacement_epoch_id: transition.replacement_epoch_id,
    replacement_epoch_commitment: transition.replacement_epoch_commitment,
    recipients,
    suite_id: transition.suite_id
  });
  return Object.freeze({ post_memberships: post.memberships, post_devices: post.devices, manifest });
}

export async function verifyMembershipTransition(input: Readonly<{
  previous_state: AcceptedMembershipState;
  transition: MembershipTransitionCore;
  recipient_manifest: RecipientManifestCore;
  delivery_set: DeliverySetCore;
  accepted_control_event_id: ControlEventId;
  invitation_evidence?: InvitationEvidenceCore;
  enrollment_request?: EnrollmentRequestRecord;
  possession_proof?: PossessionProofRecord;
}>): Promise<VerifiedMembershipTransition | MembershipTransitionRejection> {
  try {
    const previous = parseAcceptedMembershipState(input.previous_state);
    const transition = parseMembershipTransitionCore(input.transition);
    const manifest = parseRecipientManifestCore(input.recipient_manifest);
    const deliverySet = parseDeliverySetCore(input.delivery_set);
    const acceptedControlEventId = parseDigestId("control-event", input.accepted_control_event_id);
    if (transition.project_id !== previous.project_id || transition.previous_control_head_id !== previous.control_head_id ||
        transition.expected_control_sequence !== previous.control_sequence + BigInt(1) || transition.previous_epoch_id !== previous.current_epoch_id) {
      throw new Error("Transition does not extend the exact accepted control and epoch head.");
    }
    await assertEnrollmentEvidence(transition, input.invitation_evidence, input.enrollment_request, input.possession_proof, previous);
    assertOwnerAuthority(previous, transition);
    const post = applyMutation(previous, transition);
    const expectedManifest = (await deriveRecipientManifest({ previous_state: previous, transition })).manifest;
    const expectedManifestIdentity = await deriveRecipientManifestIdentity(expectedManifest);
    const suppliedManifestIdentity = await deriveRecipientManifestIdentity(manifest);
    if (expectedManifestIdentity.id !== transition.recipient_manifest_id || suppliedManifestIdentity.id !== transition.recipient_manifest_id ||
        !sameBytes(expectedManifestIdentity.canonical_preimage_bytes, suppliedManifestIdentity.canonical_preimage_bytes)) {
      throw new Error("Recipient manifest is not the exact post-transition active-device set.");
    }
    const expectedDevices = manifest.recipients.map((entry) => entry.device_id);
    if (deliverySet.project_id !== previous.project_id || deliverySet.previous_control_head_id !== previous.control_head_id ||
        deliverySet.recipient_manifest_id !== transition.recipient_manifest_id || deliverySet.replacement_epoch_id !== transition.replacement_epoch_id ||
        deliverySet.replacement_epoch_commitment !== transition.replacement_epoch_commitment || deliverySet.suite_id !== transition.suite_id ||
        !sameStrings(deliverySet.recipient_device_ids, expectedDevices)) {
      throw new Error("Delivery-set core differs from the complete accepted-recipient manifest.");
    }
    const deliveryIdentity = await deriveDeliverySetIdentity(deliverySet);
    if (deliveryIdentity.id !== transition.delivery_set_id) throw new Error("Delivery-set identity does not match the control transition.");
    const activeOwners = post.memberships.filter((entry) => entry.status === "active" && entry.role === "owner");
    if (activeOwners.length === 0) throw new Error("A membership transition must retain at least one accepted owner.");
    const ownerPersonId = activeOwners.map((entry) => entry.person_id).sort()[0];
    const facts = deviceAuthorityFacts(post.memberships, post.devices);
    const root = await deriveControlStateRoot({
      schema_version: 1,
      object_kind: "control_state_commitment",
      project_id: previous.project_id,
      owner_person_id: ownerPersonId,
      active_control_device_id: transition.replacement_active_control_device_id,
      offline_root_key_id: previous.offline_root_key_id,
      key_epoch_id: transition.replacement_epoch_id,
      key_epoch_commitment: transition.replacement_epoch_commitment,
      merge_policy: previous.merge_policy,
      root_sequence: previous.root_sequence,
      recovery_last_uncontested_control_id: null,
      device_authorities: facts
    });
    if (root.id !== transition.resulting_control_state_root) throw new Error("Transition resulting control-state root is incorrect.");
    const transitionIdentity = await deriveMembershipTransitionIdentity(transition);
    const nextState = parseAcceptedMembershipState({
      ...previous,
      owner_person_id: ownerPersonId,
      control_head_id: acceptedControlEventId,
      control_sequence: transition.expected_control_sequence,
      active_control_device_id: transition.replacement_active_control_device_id,
      current_epoch_id: transition.replacement_epoch_id,
      current_epoch_commitment: transition.replacement_epoch_commitment,
      memberships: post.memberships,
      devices: post.devices,
      consumed_invitation_ids: transition.invitation_evidence_id === null
        ? previous.consumed_invitation_ids
        : sortedUnique([...previous.consumed_invitation_ids, requiredInvitation(input.invitation_evidence)]),
      cancelled_invitation_ids: previous.cancelled_invitation_ids
    });
    return Object.freeze({
      status: "verified" as const,
      transition_id: transitionIdentity.id,
      next_state: nextState,
      resulting_authority: Object.freeze({
        schema_version: 1 as const,
        project_id: previous.project_id,
        control_event_id: acceptedControlEventId,
        control_state_root: root.id,
        active_control_device_id: nextState.active_control_device_id,
        offline_root_key_id: nextState.offline_root_key_id,
        key_epoch_id: nextState.current_epoch_id,
        key_epoch_commitment: nextState.current_epoch_commitment,
        device_authorities: facts
      }),
      recipient_manifest: manifest,
      delivery_set: deliverySet
    });
  } catch (error) {
    return Object.freeze({ status: "rejected" as const, reason: safeError(error) });
  }
}

export function assertInvitationUsable(input: Readonly<{
  state: AcceptedMembershipState;
  evidence: InvitationEvidenceCore;
}>): void {
  const state = parseAcceptedMembershipState(input.state);
  const evidence = parseInvitationEvidenceCore(input.evidence);
  if (evidence.project_id !== state.project_id || evidence.creation_control_sequence > state.control_sequence ||
      state.control_sequence > evidence.valid_through_control_sequence) {
    throw new Error("Invitation is outside its deterministic control-sequence validity boundary.");
  }
  if (state.consumed_invitation_ids.includes(evidence.invitation_id) || state.cancelled_invitation_ids.includes(evidence.invitation_id)) {
    throw new Error("Invitation is already consumed or cancelled.");
  }
}

async function assertEnrollmentEvidence(
  transition: MembershipTransitionCore,
  invitationValue: InvitationEvidenceCore | undefined,
  requestValue: EnrollmentRequestRecord | undefined,
  proofValue: PossessionProofRecord | undefined,
  previous: AcceptedMembershipState
): Promise<void> {
  const enrollment = transition.mutation_kind === "new_membership" || transition.mutation_kind === "additional_device";
  if (!enrollment) {
    if (invitationValue || requestValue || proofValue) throw new Error("Non-enrollment transition cannot consume enrollment evidence.");
    return;
  }
  if (!invitationValue || !requestValue || !proofValue) throw new Error("Enrollment transition requires all possession evidence.");
  const invitation = parseInvitationEvidenceCore(invitationValue);
  const request = parseEnrollmentRequestRecord(requestValue);
  const proof = parsePossessionProofRecord(proofValue);
  assertInvitationUsable({ state: previous, evidence: invitation });
  const [invitationIdentity, requestIdentity, proofIdentity] = await Promise.all([
    deriveInvitationEvidenceIdentity(invitation),
    deriveEnrollmentRequestIdentity(request.core),
    derivePossessionProofIdentity(proof.core)
  ]);
  if (invitationIdentity.id !== transition.invitation_evidence_id || requestIdentity.id !== request.request_id ||
      proofIdentity.id !== proof.proof_id || request.request_id !== transition.enrollment_request_id || proof.proof_id !== transition.possession_proof_id ||
      request.core.invitation_evidence_id !== transition.invitation_evidence_id || request.core.project_id !== transition.project_id ||
      request.core.candidate_person_id !== transition.person_id || request.core.candidate_device_id !== transition.device_id ||
      request.core.signing_key_id !== transition.signing_key_id || request.core.recipient_key_id !== transition.recipient_key_id ||
      !sameBytes(request.core.signing_public_key_bytes, requiredBytes(transition.signing_public_key_bytes)) ||
      !sameBytes(request.core.recipient_public_key_bytes, requiredBytes(transition.recipient_public_key_bytes)) ||
      request.core.intended_role !== transition.role || request.core.access_scope !== transition.access_scope ||
      request.core.access_scope_id !== transition.access_scope_id || request.core.bound_control_head_id !== previous.control_head_id ||
      proof.core.request_id !== request.request_id || proof.core.candidate_person_id !== transition.person_id ||
      proof.core.candidate_device_id !== transition.device_id || proof.core.signing_key_id !== transition.signing_key_id ||
      proof.core.recipient_key_id !== transition.recipient_key_id || proof.core.bound_control_head_id !== previous.control_head_id ||
      invitation.invitation_id !== request.core.invitation_id || invitation.intended_role !== transition.role ||
      invitation.access_scope !== transition.access_scope) {
    throw new Error("Enrollment evidence does not bind the exact accepted transition.");
  }
  if (transition.mutation_kind === "new_membership" && request.core.enrollment_kind !== "new_person") throw new Error("New membership requires a new-person request.");
  if (transition.mutation_kind === "additional_device" && (request.core.enrollment_kind !== "additional_device" || request.core.existing_membership_id !== transition.membership_id)) throw new Error("Additional-device request is not bound to the existing membership.");
}

function assertOwnerAuthority(state: AcceptedMembershipState, transition: MembershipTransitionCore): void {
  if (transition.project_id !== state.project_id || transition.previous_control_head_id !== state.control_head_id ||
      transition.expected_control_sequence !== state.control_sequence + BigInt(1) || transition.authorizing_owner_device_id !== state.active_control_device_id ||
      transition.previous_active_control_device_id !== state.active_control_device_id) {
    throw new Error("Only the exact designated current control device may authorize the transition.");
  }
  const membership = state.memberships.find((entry) => entry.membership_id === transition.authorizing_owner_membership_id);
  const device = state.devices.find((entry) => entry.device_id === transition.authorizing_owner_device_id);
  if (!membership || membership.status !== "active" || membership.role !== "owner" || membership.person_id !== transition.authorizing_owner_person_id ||
      !device || device.status !== "active" || device.person_id !== membership.person_id || device.membership_id !== membership.membership_id ||
      !roleHasCapability(membership.role, "invite_person") || !roleHasCapability(membership.role, "rotate_key_epoch")) {
    throw new Error("Authorizing device lacks accepted owner control and epoch capabilities.");
  }
  if (transition.previous_epoch_id !== state.current_epoch_id || transition.replacement_epoch_id === state.current_epoch_id) throw new Error("Membership/device authority change requires a fresh epoch identity.");
}

function applyMutation(state: AcceptedMembershipState, transition: MembershipTransitionCore): Readonly<{ memberships: readonly MembershipFact[]; devices: readonly MembershipDeviceFact[] }> {
  const memberships = state.memberships.map(copyMembership);
  const devices = state.devices.map(copyDevice);
  const membershipIndex = memberships.findIndex((entry) => entry.membership_id === transition.membership_id);
  const deviceIndex = transition.device_id === null ? -1 : devices.findIndex((entry) => entry.device_id === transition.device_id);
  const keyIds = new Set(devices.flatMap((entry) => [entry.signing_key_id, entry.recipient_key_id]));
  const keyBytes = new Set(devices.flatMap((entry) => [bytesKey(entry.signing_public_key_bytes), bytesKey(entry.recipient_public_key_bytes)]));
  switch (transition.mutation_kind) {
    case "new_membership":
      if (membershipIndex !== -1 || memberships.some((entry) => entry.person_id === transition.person_id && entry.status === "active") || deviceIndex !== -1 ||
          keyIds.has(requiredValue(transition.signing_key_id)) || keyIds.has(requiredValue(transition.recipient_key_id)) ||
          keyBytes.has(bytesKey(requiredBytes(transition.signing_public_key_bytes))) || keyBytes.has(bytesKey(requiredBytes(transition.recipient_public_key_bytes)))) throw new Error("New membership reuses an accepted identity or canonical public key.");
      memberships.push(Object.freeze({ membership_id: transition.membership_id, person_id: transition.person_id, role: transition.role, access_scope: transition.access_scope, access_scope_id: transition.access_scope_id, status: "active" }));
      devices.push(newDeviceFact(transition));
      break;
    case "additional_device": {
      const membership = memberships[membershipIndex];
      if (!membership || membership.status !== "active" || membership.person_id !== transition.person_id || membership.role !== transition.role || membership.access_scope_id !== transition.access_scope_id || deviceIndex !== -1 ||
          keyIds.has(requiredValue(transition.signing_key_id)) || keyIds.has(requiredValue(transition.recipient_key_id)) ||
          keyBytes.has(bytesKey(requiredBytes(transition.signing_public_key_bytes))) || keyBytes.has(bytesKey(requiredBytes(transition.recipient_public_key_bytes)))) throw new Error("Additional device does not bind an exact active membership or uses duplicate identities.");
      devices.push(newDeviceFact(transition));
      break;
    }
    case "role_change": {
      const membership = memberships[membershipIndex];
      if (!membership || membership.status !== "active" || membership.person_id !== transition.person_id || membership.access_scope_id !== transition.access_scope_id || membership.role === transition.role) throw new Error("Role change target is invalid or unchanged.");
      memberships[membershipIndex] = Object.freeze({ ...membership, role: transition.role });
      break;
    }
    case "device_revocation":
      revokeDevices(devices, transition.revoked_device_ids, transition.revocation_cutoffs);
      break;
    case "membership_revocation": {
      const membership = memberships[membershipIndex];
      if (!membership || membership.status !== "active" || membership.person_id !== transition.person_id) throw new Error("Membership revocation target is not active.");
      const activeDeviceIds = devices.filter((entry) => entry.membership_id === membership.membership_id && entry.status === "active").map((entry) => entry.device_id).sort();
      if (!sameStrings(activeDeviceIds, transition.revoked_device_ids)) throw new Error("Membership revocation must revoke every active device exactly.");
      memberships[membershipIndex] = Object.freeze({ ...membership, status: "revoked" });
      revokeDevices(devices, transition.revoked_device_ids, transition.revocation_cutoffs);
      break;
    }
  }
  memberships.sort(byId((entry) => entry.membership_id)); devices.sort(byId((entry) => entry.device_id));
  const activeControl = devices.find((entry) => entry.device_id === transition.replacement_active_control_device_id);
  if (!activeControl || activeControl.status !== "active") throw new Error("Replacement control device is not active after the transition.");
  if (transition.revoked_device_ids.includes(state.active_control_device_id) && transition.replacement_active_control_device_id === state.active_control_device_id) throw new Error("Designated control-device revocation requires an exact active replacement in the same transition.");
  if (memberships.filter((entry) => entry.status === "active" && entry.role === "owner").length === 0) throw new Error("Transition would remove the final owner.");
  return Object.freeze({ memberships: Object.freeze(memberships), devices: Object.freeze(devices) });
}

function activeRecipients(memberships: readonly MembershipFact[], devices: readonly MembershipDeviceFact[]): readonly RecipientManifestEntry[] {
  const byMembership = new Map(memberships.map((entry) => [entry.membership_id, entry]));
  return Object.freeze(devices.filter((entry) => entry.status === "active").map((device) => {
    const membership = byMembership.get(device.membership_id);
    if (!membership || membership.status !== "active") throw new Error("Active recipient has no active membership.");
    return Object.freeze({ membership_id: membership.membership_id, person_id: membership.person_id, device_id: device.device_id, role: membership.role, access_scope: membership.access_scope, signing_key_id: device.signing_key_id, recipient_key_id: device.recipient_key_id, recipient_public_key_bytes: Uint8Array.from(device.recipient_public_key_bytes) as typeof device.recipient_public_key_bytes });
  }).sort(byId((entry) => entry.device_id)));
}

function deviceAuthorityFacts(memberships: readonly MembershipFact[], devices: readonly MembershipDeviceFact[]): readonly DeviceAuthorityFact[] {
  const byMembership = new Map(memberships.map((entry) => [entry.membership_id, entry]));
  return Object.freeze(devices.map((device) => {
    const membership = byMembership.get(device.membership_id);
    if (!membership) throw new Error("Device membership is missing.");
    return Object.freeze({ device_id: device.device_id, person_id: device.person_id, signing_key_id: device.signing_key_id, role: membership.role, capabilities: Object.freeze([...capabilitiesForRole(membership.role)]), status: device.status, maximum_accepted_semantic_sequence: device.maximum_accepted_semantic_sequence });
  }).sort(byId((entry) => entry.device_id)));
}

function revokeDevices(devices: MembershipDeviceFact[], ids: readonly DeviceId[], cutoffs: MembershipTransitionCore["revocation_cutoffs"]): void {
  for (let index = 0; index < ids.length; index += 1) {
    const target = devices.findIndex((entry) => entry.device_id === ids[index]);
    if (target < 0 || devices[target].status !== "active") throw new Error("Revoked device is not currently active.");
    devices[target] = Object.freeze({ ...devices[target], status: "revoked", maximum_accepted_semantic_sequence: cutoffs[index].maximum_accepted_semantic_sequence });
  }
}

function newDeviceFact(transition: MembershipTransitionCore): MembershipDeviceFact {
  return Object.freeze({ membership_id: transition.membership_id, person_id: transition.person_id, device_id: requiredValue(transition.device_id), signing_key_id: requiredValue(transition.signing_key_id), signing_public_key_bytes: Uint8Array.from(requiredBytes(transition.signing_public_key_bytes)) as MembershipDeviceFact["signing_public_key_bytes"], recipient_key_id: requiredValue(transition.recipient_key_id), recipient_public_key_bytes: Uint8Array.from(requiredBytes(transition.recipient_public_key_bytes)) as MembershipDeviceFact["recipient_public_key_bytes"], status: "active", maximum_accepted_semantic_sequence: null });
}

function copyMembership(value: MembershipFact): MembershipFact { return Object.freeze({ ...value }); }
function copyDevice(value: MembershipDeviceFact): MembershipDeviceFact { return Object.freeze({ ...value, signing_public_key_bytes: Uint8Array.from(value.signing_public_key_bytes) as MembershipDeviceFact["signing_public_key_bytes"], recipient_public_key_bytes: Uint8Array.from(value.recipient_public_key_bytes) as MembershipDeviceFact["recipient_public_key_bytes"] }); }
function requiredValue<T>(value: T | null): T { if (value === null) throw new Error("Required transition value is absent."); return value; }
function requiredBytes(value: Uint8Array | null): Uint8Array { return requiredValue(value); }
function requiredInvitation(value: InvitationEvidenceCore | undefined): InvitationId { if (!value) throw new Error("Invitation evidence is absent."); return parseInvitationEvidenceCore(value).invitation_id; }
function sortedUnique<T extends string>(values: readonly T[]): readonly T[] { const result = [...new Set(values)].sort(); if (result.length !== values.length) throw new Error("Identity set contains duplicates."); return Object.freeze(result); }
function byId<T>(key: (value: T) => string): (left: T, right: T) => number { return (left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function bytesKey(value: Uint8Array): string { let result = ""; for (const byte of value) result += byte.toString(16).padStart(2, "0"); return result; }
function safeError(error: unknown): string { return error instanceof Error && error.message ? error.message : "membership_transition_rejected"; }

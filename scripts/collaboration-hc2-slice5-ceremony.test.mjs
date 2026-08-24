import assert from "node:assert/strict";

import { capabilitiesForRole } from "../lib/collaboration/capabilities.ts";
import { parseAttestationRecord } from "../lib/collaboration/checkpoints.ts";
import { parseControlEventCoreStructure, parseControlEventRecordStructure } from "../lib/collaboration/control.ts";
import { EventControlStore } from "../lib/collaboration/event-control-store.ts";
import { deriveAttestationIdentity, deriveControlEventCoreIdentity } from "../lib/collaboration/preimages.ts";
import { deriveControlStateRoot } from "../lib/collaboration/projection-roots.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveAdmissionPackageIdentity,
  deriveEnrollmentCeremonyIdentity,
  deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity,
  deriveMembershipTransitionIdentity,
  parseAcceptedMembershipState,
  parseAdmissionPackageRecord,
  parseEnrollmentRequestCore,
  parseEnrollmentRequestRecord,
  parseInvitationEvidenceCore
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { Hc2InMemoryCustodyStore } from "../lib/collaboration/hc2/custody-store.ts";
import { Hc2DeviceVaultService } from "../lib/collaboration/hc2/device-vault.ts";
import { Hc2EnrollmentCustodyService, Hc2InMemoryEnrollmentCandidateStore } from "../lib/collaboration/hc2/enrollment-custody.ts";
import {
  enrollmentSenderFailureStages,
  runOwnerEnrollmentTransition
} from "../lib/collaboration/hc2/enrollment-ceremony.ts";
import { Hc2InMemoryEnrollmentStore } from "../lib/collaboration/hc2/enrollment-store.ts";
import { buildPossessionResponse, createPossessionChallenge } from "../lib/collaboration/hc2/epoch-delivery.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { HC2_CRYPTO_SUITE_ID } from "../lib/collaboration/hc2/versions.ts";

const ids = Object.freeze({ project: entity("project", "a"), scope: entity("access-scope", "b"), ownerPerson: entity("person", "c"),
  ownerMembership: entity("membership", "d"), ownerDevice: entity("device", "e"), ownerSigning: entity("public-key", "f"),
  ownerRecipient: entity("public-key", "g"), root: entity("public-key", "h"), candidatePerson: entity("person", "j"),
  candidateMembership: entity("membership", "k"), candidateDevice: entity("device", "m"), candidateSigning: entity("public-key", "n"),
  candidateRecipient: entity("public-key", "p"), invitation: entity("invitation", "q"), epoch1: entity("key-epoch", "r"), epoch2: entity("key-epoch", "s") });
let assertions = 0;
for (let stageIndex = 0; stageIndex < enrollmentSenderFailureStages.length; stageIndex += 1) {
  const stage = enrollmentSenderFailureStages[stageIndex];
  const scenario = await createScenario(stageIndex);
  let injected = 0;
  await assert.rejects(() => runOwnerEnrollmentTransition({ ...scenario.input, failure_injector(context) {
    if (context.stage === stage && injected === 0) { injected += 1; throw new Error(`injected:${stage}`); }
  } }), /injected:/);
  assertions += 1; assert.equal(injected, 1, `${stage} was reached and cut exactly once`);
  const journalAfterCut = await scenario.store.readTransition(ids.project, scenario.ceremonyId);
  const immutableDeliveries = journalAfterCut?.journaled_deliveries.map((entry) => ({ id: entry.delivery_id, bytes: Uint8Array.from(entry.exact_bytes) })) ?? [];
  const resumed = await runOwnerEnrollmentTransition(scenario.input);
  assertions += 1; assert.equal(resumed.transition.status, "verified", `${stage} exact retry verifies accepted authority`);
  assertions += 1; assert.equal(resumed.deliveries.length, 2, `${stage} exact retry restores the complete recipient set`);
  assertions += 1; assert.equal(resumed.admission_package?.core.full_history_verified, false, `${stage} exact retry preserves admission honesty`);
  const completion = await scenario.store.readCompletionMarker(ids.project, scenario.ceremonyId);
  assertions += 1; assert.equal(completion?.completion, "verified_reopen_complete", `${stage} completion marker is last`);
  for (const prior of immutableDeliveries) {
    const current = (await scenario.store.readTransition(ids.project, scenario.ceremonyId))?.journaled_deliveries.find((entry) => entry.delivery_id === prior.id);
    assertions += 1; assert(current && sameBytes(current.exact_bytes, prior.bytes), `${stage} preserves journaled envelope bytes`);
  }
  const exactRetry = await runOwnerEnrollmentTransition(scenario.input);
  assertions += 1; assert.equal(exactRetry.event.control_event_id, resumed.event.control_event_id, `${stage} completed retry keeps the control identity`);
  assertions += 1; assert.deepEqual(exactRetry.deliveries.map((entry) => entry.delivery_id), resumed.deliveries.map((entry) => entry.delivery_id), `${stage} completed retry keeps delivery identities`);
  assertions += 1; assert.equal(scenario.batchIds.size, 1, `${stage} publishes one immutable complete batch identity`);
}

process.stdout.write(`${JSON.stringify({ assertions, failure_stages: enrollmentSenderFailureStages.length,
  exact_retries: enrollmentSenderFailureStages.length, status: "ok" })}\n`);

async function createScenario(index) {
  const ownerStore = new Hc2InMemoryCustodyStore();
  const ownerVault = new Hc2DeviceVaultService({ store: ownerStore, random: scriptedRandom([fill(32, 0x11 + index), fill(12, 0x21 + index)]) });
  const preparedOwner = await ownerVault.prepare({ project_id: ids.project, person_id: ids.ownerPerson, device_id: ids.ownerDevice,
    access_scope_id: ids.scope, generation: 0n, signing_key_id: ids.ownerSigning, recipient_key_id: ids.ownerRecipient,
    offline_root_key_id: ids.root, key_epoch_id: ids.epoch1, recovery_kit_sha256: fill(32, 0x31) });
  const authorityRoot = await deriveControlStateRoot({ schema_version: 1, object_kind: "control_state_commitment", project_id: ids.project,
    owner_person_id: ids.ownerPerson, active_control_device_id: ids.ownerDevice, offline_root_key_id: ids.root,
    key_epoch_id: ids.epoch1, key_epoch_commitment: preparedOwner.public_binding.current_epoch_commitment, merge_policy: "manual", root_sequence: 0n,
    recovery_last_uncontested_control_id: null, device_authorities: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson,
      signing_key_id: ids.ownerSigning, role: "owner", capabilities: capabilitiesForRole("owner"), status: "active", maximum_accepted_semantic_sequence: null }] });
  const genesisCore = parseControlEventCoreStructure({ schema_version: 1, object_kind: "control_event_core", control_kind: "genesis", project_id: ids.project,
    control_sequence: 0n, previous_control_id: null, root_sequence: 0n, previous_root_control_id: null, owner_person_id: ids.ownerPerson,
    offline_root_key_id: ids.root, initial_active_control_device_id: ids.ownerDevice,
    initial_memberships: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, role: "owner", access_scope_id: ids.scope, status: "active" }],
    initial_authorized_devices: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson, signing_key_id: ids.ownerSigning, status: "active" }],
    initial_key_epoch_id: ids.epoch1, initial_key_epoch_commitment: preparedOwner.public_binding.current_epoch_commitment,
    resulting_control_state_root: authorityRoot.id });
  const genesisId = (await deriveControlEventCoreIdentity(genesisCore)).id;
  let journal = (await ownerStore.beginCeremony({ schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation",
    ceremony_id: `slice5-ceremony-owner-${index}`, plan_sha256: fill(32, 0x41), project_id: ids.project, person_id: ids.ownerPerson,
    device_id: ids.ownerDevice, lost_device_id: null, root_key_id: ids.root, key_epoch_id: ids.epoch1,
    recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned" })).journal;
  journal = { ...journal, recovery_kit_sha256: fill(32, 0x31), accepted_control_head_id: genesisId, phase: "kit_verified" };
  await ownerVault.install({ handle: preparedOwner.handle, accepted_control_head_id: genesisId, journal });
  const ownerCustody = await ownerVault.loadAndVerify(authority(preparedOwner.public_binding, genesisId));
  const state = parseAcceptedMembershipState({ schema_version: 1, record_kind: "accepted_membership_state", project_id: ids.project,
    owner_person_id: ids.ownerPerson, control_head_id: genesisId, control_sequence: 0n, root_sequence: 0n, merge_policy: "manual",
    active_control_device_id: ids.ownerDevice, offline_root_key_id: ids.root, current_epoch_id: ids.epoch1,
    current_epoch_commitment: preparedOwner.public_binding.current_epoch_commitment,
    memberships: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, role: "owner", access_scope: "project_wide", access_scope_id: ids.scope, status: "active" }],
    devices: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, device_id: ids.ownerDevice, signing_key_id: ids.ownerSigning,
      signing_public_key_bytes: preparedOwner.public_binding.signing_public_key_bytes, recipient_key_id: ids.ownerRecipient,
      recipient_public_key_bytes: preparedOwner.public_binding.recipient_public_key_bytes, status: "active", maximum_accepted_semantic_sequence: null }],
    consumed_invitation_ids: [], cancelled_invitation_ids: [] });
  const acceptedAuthorities = new Map([[genesisId, acceptedAuthority(state, authorityRoot.id, preparedOwner.public_binding.current_epoch_commitment)]]);
  const events = new EventControlStore({ backend: memoryBackend(), attestation_verifier: { async verify(request) { return { outcome: "verified", binding: request }; } },
    control_transition_verifier: { async verify(request) { const found = acceptedAuthorities.get(request.control_event_id);
      return found ? { outcome: "verified", binding: request, resulting_authority: found } : { outcome: "invalid", reason: "unregistered transition" }; } } });
  const genesisAttestation = await attestation(genesisId, ids.root); await events.putAttestationRecord(genesisAttestation);
  await events.putControlEvent(parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event", control_event_id: genesisId,
    core: genesisCore, authority_attestation_id: genesisAttestation.attestation_id }));

  const invitation = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project,
    invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice,
    intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: genesisId,
    creation_control_sequence: 0n, valid_through_control_sequence: 8n, accepted_invitation_action_id: digest("control-action", "x"),
    accepted_invitation_control_event_id: genesisId, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
  const invitationIdentity = await deriveInvitationEvidenceIdentity(invitation);
  const candidateStore = new Hc2InMemoryEnrollmentCandidateStore(); const candidateFinal = new Hc2InMemoryCustodyStore();
  const candidateCustody = new Hc2EnrollmentCustodyService({ pending_store: candidateStore, custody_store: candidateFinal,
    random: scriptedRandom([fill(12, 0x51)]) });
  const candidate = await candidateCustody.createCandidate({ project_id: ids.project, person_id: ids.candidatePerson, device_id: ids.candidateDevice,
    access_scope_id: ids.scope, generation: 0n, signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
    offline_root_key_id: ids.root, bound_control_head_id: genesisId });
  const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person",
    project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationIdentity.id,
    accepted_invitation_control_event_id: genesisId, candidate_person_id: ids.candidatePerson, existing_membership_id: null,
    proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice, signing_key_id: ids.candidateSigning,
    signing_public_key_bytes: candidate.public_binding.signing_public_key_bytes, recipient_key_id: ids.candidateRecipient,
    recipient_public_key_bytes: candidate.public_binding.recipient_public_key_bytes, intended_role: "reviewer", access_scope: "project_wide",
    access_scope_id: ids.scope, bound_control_head_id: genesisId, request_nonce: fill(32, 0x61), suite_id: HC2_CRYPTO_SUITE_ID });
  const requestIdentity = await deriveEnrollmentRequestIdentity(requestCore);
  const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestIdentity.id,
    core: requestCore, algorithm: "ed25519", signature_bytes: await candidateCustody.signPending({ project_id: ids.project,
      device_id: ids.candidateDevice, preimage: buildEnrollmentSignaturePreimage("enrollment_request", ids.project, requestIdentity.id) }) });
  const hpke = new SingleShotHpkeProvider({ keys: new Hc2NativeKeyRegistry(crypto.subtle) });
  const challenge = await createPossessionChallenge({ request, current_control_head_id: genesisId, random: scriptedRandom([fill(32, 0x62)]), hpke });
  const proof = await buildPossessionResponse({ envelope: challenge.envelope, request,
    open: (value) => candidateCustody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }),
    sign: (preimage) => candidateCustody.signPending({ project_id: ids.project, device_id: ids.candidateDevice, preimage }) });
  const store = new Hc2InMemoryEnrollmentStore();
  await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: ids.invitation, evidence: invitation,
    status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
  await store.putChallenge({ schema_version: 1, record_kind: "stored_possession_challenge", project_id: ids.project,
    challenge: challenge.envelope, expected_response_sha256: challenge.expected_response_sha256, status: "pending", consumed_proof_id: null });
  const plan = { project_id: ids.project, mutation_kind: "new_membership", previous_control_head_id: genesisId, expected_control_sequence: 1n,
    authorizing_owner_membership_id: ids.ownerMembership, authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice,
    invitation_evidence_id: invitationIdentity.id, enrollment_request_id: request.request_id, possession_proof_id: proof.proof_id,
    membership_id: ids.candidateMembership, person_id: ids.candidatePerson, role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope,
    device_id: ids.candidateDevice, signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
    signing_public_key_bytes: candidate.public_binding.signing_public_key_bytes, recipient_public_key_bytes: candidate.public_binding.recipient_public_key_bytes,
    revoked_device_ids: [], revocation_cutoffs: [], previous_active_control_device_id: ids.ownerDevice,
    replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: ids.epoch1, suite_id: HC2_CRYPTO_SUITE_ID };
  const ceremonyId = (await deriveEnrollmentCeremonyIdentity({ schema_version: 1,
    record_kind: "enrollment_ceremony_plan_core", project_id: ids.project, mutation_kind: "new_membership", previous_control_head_id: genesisId,
    expected_control_sequence: 1n, invitation_evidence_id: invitationIdentity.id, enrollment_request_id: request.request_id,
    possession_proof_id: proof.proof_id, membership_id: ids.candidateMembership, person_id: ids.candidatePerson, device_id: ids.candidateDevice,
    previous_epoch_id: ids.epoch1, replacement_epoch_id: ids.epoch2, suite_id: HC2_CRYPTO_SUITE_ID })).id;
  const batchIds = new Set();
  const input = { transition: plan, replacement_epoch_id: ids.epoch2, previous_state: state, invitation_evidence: invitation,
    enrollment_request: request, possession_proof: proof, owner_custody: ownerCustody, vault: ownerVault,
    random: scriptedRandom([fill(32, 0x70 + index), fill(12, 0x80 + index), fill(32, 0x90 + index), fill(12, 0xa0 + index)]), hpke,
    locks: { async runCustodyCeremonyExclusive({ operation }) { return { status: "completed", value: await operation() }; } }, store, events,
    register_control_transition(registration) { acceptedAuthorities.set(registration.event.control_event_id, registration.transition.resulting_authority); },
    async publish_complete_batch(batch) { batchIds.add(batch.marker.batch_id); },
    construct_admission(context) { return dummyAdmission(context, ids.ownerSigning); } };
  return { input, store, ceremonyId, batchIds };
}

async function dummyAdmission(context, ownerKeyId) {
  const state = context.accepted_state; const delivery = context.deliveries.find((entry) => entry.header_core.recipient_device_id === ids.candidateDevice);
  const core = { schema_version: 1, record_kind: "current_state_admission_package_core", authority: "none", project_id: ids.project,
    transition_id: (await deriveMembershipTransitionIdentity(context.transition)).id,
    accepted_control_action_id: context.action.action_id, accepted_control_event_id: state.control_head_id,
    resulting_control_state_root: context.transition.resulting_control_state_root, admitted_membership_id: ids.candidateMembership,
    admitted_person_id: ids.candidatePerson, admitted_device_id: ids.candidateDevice, admitted_role: "reviewer", access_scope: "project_wide",
    signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient, key_epoch_id: state.current_epoch_id,
    key_epoch_commitment: state.current_epoch_commitment, recipient_manifest_id: context.transition.recipient_manifest_id,
    delivery_set_id: context.transition.delivery_set_id, recipient_delivery_id: delivery.delivery_id,
    checkpoint_id: digest("semantic-event", "a"), projection_root: digest("projection-root", "b"), semantic_state_root: digest("semantic-state-root", "c"),
    revision_heads_root: digest("revision-heads-root", "d"), conflict_set_root: digest("conflict-set-root", "e"),
    accepted_history_root: digest("accepted-history-root", "f"), state_blob_id: digest("state-blob", "g"), snapshot_id: digest("snapshot", "h"),
    semantic_frontier: [], revision_manifest: [], conflict_manifest: [], reducer_version: "patchmark/hc1/reducer/v1",
    admission_boundary_sha256: fill(32, 0xb1), owner_signing_key_id: ownerKeyId, full_history_verified: false, suite_id: HC2_CRYPTO_SUITE_ID };
  const identity = await deriveAdmissionPackageIdentity(core);
  return parseAdmissionPackageRecord({ record_version: 1, record_kind: "current_state_admission_package", authority: "none",
    admission_package_id: identity.id, core, owner_signature_bytes: fill(64, 0xb2) });
}

function acceptedAuthority(state, root, commitment) { return { schema_version: 1, project_id: ids.project, control_event_id: state.control_head_id,
  control_state_root: root, active_control_device_id: ids.ownerDevice, offline_root_key_id: ids.root, key_epoch_id: ids.epoch1,
  key_epoch_commitment: commitment, device_authorities: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson,
    signing_key_id: ids.ownerSigning, role: "owner", capabilities: capabilitiesForRole("owner"), status: "active", maximum_accepted_semantic_sequence: null }] }; }
function authority(binding, head) { return { project_id: binding.project_id, person_id: binding.person_id, device_id: binding.device_id,
  access_scope_id: binding.access_scope_id, signing_key_id: binding.signing_key_id, recipient_key_id: binding.recipient_key_id,
  accepted_control_head_id: head, offline_root_key_id: binding.offline_root_key_id, key_epoch_id: binding.current_epoch_id,
  key_epoch_commitment: binding.current_epoch_commitment, device_status: "active" }; }
async function attestation(subjectId, signerKeyId) { const core = { schema_version: 1, object_kind: "attestation_core", project_id: ids.project,
  subject_kind: "control_event", subject_id: subjectId, signer_key_id: signerKeyId, algorithm: "ed25519", signature_bytes: fill(64, 0xc1) };
  const identity = await deriveAttestationIdentity(core); return parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: identity.id, core }); }
function memoryBackend() { const bytes = new Map(); return { async read(address) { const value = bytes.get(address); return value ? Uint8Array.from(value) : null; },
  async write(address, value) { bytes.set(address, Uint8Array.from(value)); }, async delete(address) { bytes.delete(address); },
  async list(prefix) { return [...bytes.keys()].filter((entry) => entry.startsWith(prefix)).sort(); } }; }
function scriptedRandom(values) { const remaining = values.map((value) => Uint8Array.from(value)); return { async randomBytes(length) { const value = remaining.shift();
  if (!value || value.length !== length) throw new Error(`scripted random missing ${length} bytes`); return Uint8Array.from(value); } }; }
function fill(length, value) { return new Uint8Array(length).fill(value & 0xff); }
function sameBytes(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function entity(kind, char) { return `pm:${kind}:v1:${char.repeat(25)}a`; }
function digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }

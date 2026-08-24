import assert from "node:assert/strict";

import { capabilitiesForRole } from "../lib/collaboration/capabilities.ts";
import { parseAttestationRecord, parseProjectionSnapshotRecord } from "../lib/collaboration/checkpoints.ts";
import { parseControlEventCoreStructure, parseControlEventRecordStructure } from "../lib/collaboration/control.ts";
import { EventControlStore } from "../lib/collaboration/event-control-store.ts";
import { deriveAttestationIdentity, deriveControlEventCoreIdentity, deriveProjectionSnapshotIdentity } from "../lib/collaboration/preimages.ts";
import { deriveControlStateRoot } from "../lib/collaboration/projection-roots.ts";
import { parseCanonicalStateBlobRecord, deriveCanonicalStateBlobIdentity } from "../lib/collaboration/state-snapshots.ts";
import { parseAcceptedMembershipState, parseEnrollmentRequestCore, parseEnrollmentRequestRecord, parseEpochDeliveryHeaderCore,
  parseInvitationEvidenceCore, parseMembershipTransitionCore, buildEnrollmentSignaturePreimage, deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity } from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { createAdmissionPackage, verifyAdmissionPackage } from "../lib/collaboration/hc2/admission-package.ts";
import { admitCandidateDevice, candidateAdmissionFailureStages } from "../lib/collaboration/hc2/candidate-admission.ts";
import { Hc2InMemoryCustodyStore } from "../lib/collaboration/hc2/custody-store.ts";
import { Hc2DeviceVaultService } from "../lib/collaboration/hc2/device-vault.ts";
import { Hc2EnrollmentCustodyService, Hc2InMemoryEnrollmentCandidateStore } from "../lib/collaboration/hc2/enrollment-custody.ts";
import { Hc2InMemoryEnrollmentStore } from "../lib/collaboration/hc2/enrollment-store.ts";
import { Hc2InMemoryEpochReceiptStore, parseEpochReceiptReservation } from "../lib/collaboration/hc2/receipt-store.ts";
import { createPossessionChallenge, buildPossessionResponse, verifyEnrollmentRequestSignature, verifyPossessionProof,
  createEpochDeliveryEnvelope, openEpochDelivery, verifyCompleteEpochDeliverySet } from "../lib/collaboration/hc2/epoch-delivery.ts";
import { createEpochReceipt, verifyEpochReceipt } from "../lib/collaboration/hc2/epoch-receipt.ts";
import { createInvitationAction, materializeAcceptedInvitation } from "../lib/collaboration/hc2/invitation-authority.ts";
import { prepareMembershipTransition, verifyMembershipTransition } from "../lib/collaboration/hc2/membership-authority.ts";
import { deriveEpochCommitment } from "../lib/collaboration/hc2/epoch-custody.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { HC2_CRYPTO_SUITE_ID } from "../lib/collaboration/hc2/versions.ts";

let assertions = 0;
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const rejects = async (operation, matcher) => { assertions += 1; await assert.rejects(operation, matcher); };
const throws = (operation, matcher) => { assertions += 1; assert.throws(operation, matcher); };

const ids = Object.freeze({
  project: entity("project", "a"), scope: entity("access-scope", "b"), ownerPerson: entity("person", "c"), ownerMembership: entity("membership", "d"),
  ownerDevice: entity("device", "e"), ownerSigning: entity("public-key", "f"), ownerRecipient: entity("public-key", "g"), root: entity("public-key", "h"),
  candidatePerson: entity("person", "j"), candidateMembership: entity("membership", "k"), candidateDevice: entity("device", "m"),
  candidateSigning: entity("public-key", "n"), candidateRecipient: entity("public-key", "p"), invitation: entity("invitation", "q"),
  epoch1: entity("key-epoch", "r"), epoch2: entity("key-epoch", "s"), epoch3: entity("key-epoch", "t"),
  control1: digest("control-event", "u"), control2: digest("control-event", "v"), control3: digest("control-event", "w")
});

const ownerCustodyStore = new Hc2InMemoryCustodyStore();
const ownerVault = new Hc2DeviceVaultService({ store: ownerCustodyStore, random: scriptedRandom([new Uint8Array(32).fill(0x11), new Uint8Array(12).fill(0x12)]) });
const ownerPrepared = await ownerVault.prepare({ project_id: ids.project, person_id: ids.ownerPerson, device_id: ids.ownerDevice, access_scope_id: ids.scope,
  generation: 0n, signing_key_id: ids.ownerSigning, recipient_key_id: ids.ownerRecipient, offline_root_key_id: ids.root, key_epoch_id: ids.epoch1,
  recovery_kit_sha256: new Uint8Array(32).fill(0x13) });
let ownerJournal = (await ownerCustodyStore.beginCeremony({ schema_version: 1, record_kind: "custody_ceremony_journal", ceremony_kind: "initial_foundation",
  ceremony_id: "slice5-owner", plan_sha256: new Uint8Array(32).fill(0x14), project_id: ids.project, person_id: ids.ownerPerson, device_id: ids.ownerDevice,
  lost_device_id: null, root_key_id: ids.root, key_epoch_id: ids.epoch1, recovery_kit_sha256: null, accepted_control_head_id: null, phase: "planned" })).journal;
ownerJournal = { ...ownerJournal, recovery_kit_sha256: new Uint8Array(32).fill(0x13), accepted_control_head_id: ids.control1, phase: "kit_verified" };
await ownerVault.install({ handle: ownerPrepared.handle, accepted_control_head_id: ids.control1, journal: ownerJournal });
let ownerCustody = await ownerVault.loadAndVerify(authority(ownerPrepared.public_binding, ids.control1));
check(ownerCustody.public_binding.signing_public_key_bytes.length > 32, "owner custody exposes only tagged public Ed25519 bytes");

const candidateCustodyStore = new Hc2InMemoryCustodyStore();
const candidateStore = new Hc2InMemoryEnrollmentCandidateStore();
const candidateCustody = new Hc2EnrollmentCustodyService({ pending_store: candidateStore, custody_store: candidateCustodyStore,
  random: scriptedRandom([new Uint8Array(12).fill(0x33)]) });
const candidate = await candidateCustody.createCandidate({ project_id: ids.project, person_id: ids.candidatePerson, device_id: ids.candidateDevice,
  access_scope_id: ids.scope, generation: 0n, signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
  offline_root_key_id: ids.root, bound_control_head_id: ids.control1 });
equal(candidate.public_binding.signing_key_id, ids.candidateSigning, "candidate custody binds the requested signing-key identity");
check(candidate.public_binding.signing_public_key_bytes.length > 32 && candidate.public_binding.recipient_public_key_bytes.length > 32, "candidate exports only canonical public keys");

const invitation = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project,
  invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice,
  intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: ids.control1,
  creation_control_sequence: 0n, valid_through_control_sequence: 8n, accepted_invitation_action_id: digest("control-action", "x"),
  accepted_invitation_control_event_id: ids.control1, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
const invitationId = (await deriveInvitationEvidenceIdentity(invitation)).id;
const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person",
  project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationId, accepted_invitation_control_event_id: ids.control1,
  candidate_person_id: ids.candidatePerson, existing_membership_id: null, proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice,
  signing_key_id: ids.candidateSigning, signing_public_key_bytes: candidate.public_binding.signing_public_key_bytes, recipient_key_id: ids.candidateRecipient,
  recipient_public_key_bytes: candidate.public_binding.recipient_public_key_bytes, intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope,
  bound_control_head_id: ids.control1, request_nonce: new Uint8Array(32).fill(0x23), suite_id: HC2_CRYPTO_SUITE_ID });
const requestId = (await deriveEnrollmentRequestIdentity(requestCore)).id;
const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestId, core: requestCore,
  algorithm: "ed25519", signature_bytes: await candidateCustody.signPending({ project_id: ids.project, device_id: ids.candidateDevice,
    preimage: buildEnrollmentSignaturePreimage("enrollment_request", ids.project, requestId) }) });
check(await verifyEnrollmentRequestSignature({ request }), "candidate Ed25519 enrollment-request signature verifies after persisted-key reopen");
check(!(await verifyEnrollmentRequestSignature({ request: { ...request, signature_bytes: new Uint8Array(64) } })), "wrong enrollment-request signature fails closed");
throws(() => parseEnrollmentRequestCore({ ...requestCore, access_scope: "document_only" }), /scope|project.wide/i);

const hpke = new SingleShotHpkeProvider({ keys: new Hc2NativeKeyRegistry(crypto.subtle) });
const challenge = await createPossessionChallenge({ request, current_control_head_id: ids.control1, random: scriptedRandom([new Uint8Array(32).fill(0x24)]), hpke });
const proof = await buildPossessionResponse({ envelope: challenge.envelope, request,
  open: (value) => candidateCustody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }),
  sign: (preimage) => candidateCustody.signPending({ project_id: ids.project, device_id: ids.candidateDevice, preimage }) });
check(await verifyPossessionProof({ proof, request, challenge: challenge.envelope, expected_response_sha256: challenge.expected_response_sha256, current_control_head_id: ids.control1 }), "separate X25519 challenge and Ed25519 response prove both private keys");
check(!(await verifyPossessionProof({ proof, request, challenge: challenge.envelope, expected_response_sha256: new Uint8Array(32), current_control_head_id: ids.control1 })), "substituted possession response fails closed");

const enrollmentStore = new Hc2InMemoryEnrollmentStore();
await enrollmentStore.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: ids.invitation, evidence: invitation, status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
await enrollmentStore.putChallenge({ schema_version: 1, record_kind: "stored_possession_challenge", project_id: ids.project, challenge: challenge.envelope,
  expected_response_sha256: challenge.expected_response_sha256, status: "pending", consumed_proof_id: null });
await enrollmentStore.consumeChallenge(ids.project, challenge.envelope.challenge_id, proof.proof_id, ids.control1);
await rejects(() => enrollmentStore.consumeChallenge(ids.project, challenge.envelope.challenge_id, digest("possession-proof", "z"), ids.control1), /CAS|control-head/i);

const state1 = parseAcceptedMembershipState({ schema_version: 1, record_kind: "accepted_membership_state", project_id: ids.project, owner_person_id: ids.ownerPerson,
  control_head_id: ids.control1, control_sequence: 0n, root_sequence: 0n, merge_policy: "manual", active_control_device_id: ids.ownerDevice,
  offline_root_key_id: ids.root, current_epoch_id: ids.epoch1, current_epoch_commitment: ownerCustody.public_binding.current_epoch_commitment,
  memberships: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, role: "owner", access_scope: "project_wide", access_scope_id: ids.scope, status: "active" }],
  devices: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, device_id: ids.ownerDevice, signing_key_id: ids.ownerSigning,
    signing_public_key_bytes: ownerCustody.public_binding.signing_public_key_bytes, recipient_key_id: ids.ownerRecipient,
    recipient_public_key_bytes: ownerCustody.public_binding.recipient_public_key_bytes, status: "active", maximum_accepted_semantic_sequence: null }],
  consumed_invitation_ids: [], cancelled_invitation_ids: [] });
const epoch2Secret = new Uint8Array(32).fill(0x42); const epoch2Commitment = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch2, epoch_secret: epoch2Secret });
const prepared = await prepareMembershipTransition({ previous_state: state1, transition: { project_id: ids.project, mutation_kind: "new_membership", previous_control_head_id: ids.control1,
  expected_control_sequence: 1n, authorizing_owner_membership_id: ids.ownerMembership, authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice,
  invitation_evidence_id: invitationId, enrollment_request_id: request.request_id, possession_proof_id: proof.proof_id, membership_id: ids.candidateMembership,
  person_id: ids.candidatePerson, role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, device_id: ids.candidateDevice,
  signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient, signing_public_key_bytes: candidate.public_binding.signing_public_key_bytes,
  recipient_public_key_bytes: candidate.public_binding.recipient_public_key_bytes, revoked_device_ids: [], revocation_cutoffs: [],
  previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: ids.epoch1,
  replacement_epoch_id: ids.epoch2, replacement_epoch_commitment: epoch2Commitment.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
const verified = await verifyMembershipTransition({ previous_state: state1, transition: prepared.transition, recipient_manifest: prepared.recipient_manifest,
  delivery_set: prepared.delivery_set, accepted_control_event_id: ids.control2, invitation_evidence: invitation, enrollment_request: request, possession_proof: proof });
equal(verified.status, "verified", "owner-controlled enrollment transition verifies");
if (verified.status !== "verified") throw new Error(verified.reason);
equal((await verifyMembershipTransition({ previous_state: { ...state1, control_head_id: ids.control3 }, transition: prepared.transition,
  recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, accepted_control_event_id: ids.control2,
  invitation_evidence: invitation, enrollment_request: request, possession_proof: proof })).status, "rejected", "stale accepted control heads fail closed");
equal((await verifyMembershipTransition({ previous_state: { ...state1, memberships: state1.memberships.map((entry) => ({ ...entry, role: "editor" })) },
  transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set,
  accepted_control_event_id: ids.control2, invitation_evidence: invitation, enrollment_request: request, possession_proof: proof })).status,
  "rejected", "downgraded owners cannot authorize enrollment or rotation");
equal(verified.recipient_manifest.recipients.map((entry) => entry.device_id), [ids.candidateDevice, ids.ownerDevice].sort(), "recipient manifest includes every post-state active device, including offline devices");
equal(verified.next_state.memberships.find((entry) => entry.membership_id === ids.candidateMembership)?.role, "reviewer", "requested reviewer remains reviewer without promotion");
check(!verified.resulting_authority.device_authorities.find((entry) => entry.device_id === ids.candidateDevice)?.capabilities.includes("create_revision"), "reviewer enrollment cannot acquire edit authority");

const envelopes = [];
for (let index = 0; index < prepared.recipient_manifest.recipients.length; index += 1) {
  const recipient = prepared.recipient_manifest.recipients[index];
  envelopes.push(await createEpochDeliveryEnvelope({ header_core: deliveryHeader(prepared, recipient, index, ids.control2),
    recipient_public_key_bytes: recipient.recipient_public_key_bytes, public_commitment_bytes: epoch2Commitment.public_commitment_bytes,
    epoch_secret: Uint8Array.from(epoch2Secret), hpke }));
}
equal((await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, envelopes })).status,
  "verified", "complete recipient-specific delivery set verifies");
equal((await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest,
  delivery_set: prepared.delivery_set, envelopes: [...envelopes].reverse() })).status, "verified", "delivery verification is independent of arrival order");
equal((await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, envelopes: envelopes.slice(1) })).status,
  "rejected", "missing accepted recipient envelope fails closed");
equal((await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, envelopes: [...envelopes, envelopes[0]] })).status,
  "rejected", "duplicate or extra recipient envelope fails closed");
const substitutedEnvelope = { ...envelopes[0], ciphertext_bytes: Uint8Array.from(envelopes[0].ciphertext_bytes) };
substitutedEnvelope.ciphertext_bytes[substitutedEnvelope.ciphertext_bytes.length - 1] ^= 1;
equal((await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest,
  delivery_set: prepared.delivery_set, envelopes: [substitutedEnvelope, ...envelopes.slice(1)] })).status, "rejected",
  "substituted ciphertext under a frozen delivery identity fails closed");
const corruptRecipients = prepared.recipient_manifest.recipients.map((entry, index) => index === 0
  ? { ...entry, recipient_public_key_bytes: Uint8Array.from(entry.recipient_public_key_bytes) }
  : entry);
corruptRecipients[0].recipient_public_key_bytes[corruptRecipients[0].recipient_public_key_bytes.length - 1] ^= 1;
equal((await verifyMembershipTransition({ previous_state: state1, transition: prepared.transition,
  recipient_manifest: { ...prepared.recipient_manifest, recipients: corruptRecipients }, delivery_set: prepared.delivery_set,
  accepted_control_event_id: ids.control2, invitation_evidence: invitation, enrollment_request: request, possession_proof: proof })).status,
  "rejected", "corrupt recipient public keys cannot enter the accepted manifest");
const candidateEnvelope = envelopes.find((entry) => entry.header_core.recipient_device_id === ids.candidateDevice);
let openedCandidate;
await openEpochDelivery({ envelope: candidateEnvelope, expected_project_id: ids.project, expected_device_id: ids.candidateDevice,
  open: (value) => candidateCustody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }),
  use(plaintext) { openedCandidate = Uint8Array.from(plaintext.epoch_secret); equal(plaintext.key_epoch_commitment, epoch2Commitment.key_epoch_commitment, "candidate opens exact accepted epoch"); } });
equal(openedCandidate, epoch2Secret, "candidate receives the real 32-byte replacement epoch only through bounded open");

await enrollmentStore.consumeInvitation(ids.project, ids.invitation, "accepted", ids.control2, prepared.transition_id);
await rejects(() => enrollmentStore.consumeInvitation(ids.project, ids.invitation, "accepted", ids.control3, digest("membership-transition", "z")), /CAS|terminal/i);

const epoch3Secret = new Uint8Array(32).fill(0x55); const epoch3Commitment = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch3, epoch_secret: epoch3Secret });
const revocation = await prepareMembershipTransition({ previous_state: verified.next_state, transition: { project_id: ids.project, mutation_kind: "device_revocation",
  previous_control_head_id: ids.control2, expected_control_sequence: 2n, authorizing_owner_membership_id: ids.ownerMembership, authorizing_owner_person_id: ids.ownerPerson,
  authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: null, enrollment_request_id: null, possession_proof_id: null,
  membership_id: ids.candidateMembership, person_id: ids.candidatePerson, role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope,
  device_id: null, signing_key_id: null, recipient_key_id: null, signing_public_key_bytes: null, recipient_public_key_bytes: null,
  revoked_device_ids: [ids.candidateDevice], revocation_cutoffs: [{ device_id: ids.candidateDevice, maximum_accepted_semantic_sequence: 0n }],
  previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: ids.epoch2,
  replacement_epoch_id: ids.epoch3, replacement_epoch_commitment: epoch3Commitment.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
const revoked = await verifyMembershipTransition({ previous_state: verified.next_state, transition: revocation.transition, recipient_manifest: revocation.recipient_manifest,
  delivery_set: revocation.delivery_set, accepted_control_event_id: ids.control3 });
equal(revoked.status, "verified", "device revocation verifies only with a replacement epoch");
if (revoked.status !== "verified") throw new Error(revoked.reason);
equal(revoked.recipient_manifest.recipients.map((entry) => entry.device_id), [ids.ownerDevice], "revoked device is excluded from the replacement epoch recipient manifest");
equal(revoked.resulting_authority.device_authorities.find((entry) => entry.device_id === ids.candidateDevice)?.status, "revoked", "revoked device authority remains explicit with cutoff");
throws(() => parseMembershipTransitionCore({ ...revocation.transition, replacement_epoch_id: ids.epoch2 }), /rotate|fresh|epoch/i);
await testAdditionalDeviceRoleAndMembershipRevocation(verified.next_state);

const evidence = await admissionEvidence(verified.next_state, prepared.transition);
const admission = await createAdmissionPackage({ transition: prepared.transition, accepted_state: verified.next_state,
  accepted_control_action_id: digest("control-action", "y"), recipient_delivery: candidateEnvelope, evidence,
  owner_signing_key_id: ownerCustody.public_binding.signing_key_id,
  sign: (preimage) => ownerVault.signDevice({ custody: ownerCustody, preimage }) });
equal((await verifyAdmissionPackage({ package: admission, accepted_state: verified.next_state, transition: prepared.transition,
  recipient_delivery: candidateEnvelope, evidence })).status, "verified", "owner-signed admission package verifies real HC-1 state, snapshot, and boundary identities");
await testCandidateAdmissionFailureRetries({ state: verified.next_state, transition: prepared.transition, admission, delivery: candidateEnvelope, evidence });
const receipt = await createEpochReceipt({ accepted_state: verified.next_state, admission_package: admission, delivery: candidateEnvelope, acknowledgement_sequence: 0n,
  previous_acknowledgement_id: null, sign: (preimage) => candidateCustody.signPending({ project_id: ids.project, device_id: ids.candidateDevice, preimage }) });
equal((await verifyEpochReceipt({ receipt, accepted_state: verified.next_state, admission_package: admission, delivery: candidateEnvelope })).status, "verified",
  "new-device receipt binds accepted authority, epoch, delivery, checkpoint, projection, and admission boundary");
const receiptStore = new Hc2InMemoryEpochReceiptStore();
const reservation = parseEpochReceiptReservation({ schema_version: 1, record_kind: "epoch_receipt_sequence_reservation", project_id: ids.project,
  device_id: ids.candidateDevice, acknowledgement_sequence: 0n, previous_acknowledgement_id: null, intended_receipt_id: receipt.receipt_id, state: "pending" });
equal(await receiptStore.reserve(reservation), "reserved", "receipt sequence reserves through CAS");
equal(await receiptStore.reserve(reservation), "exact_retry", "identical receipt reservation is idempotent");
equal(await receiptStore.reserve({ ...reservation, intended_receipt_id: digest("epoch-receipt", "z") }), "conflict", "competing same-device receipt sequence conflicts explicitly");
equal(await receiptStore.write(receipt), "stored", "receipt immutable bytes store before commit");
equal(await receiptStore.commit(receipt), "committed", "receipt reservation commits only after exact immutable record write");
equal(await receiptStore.commit(receipt), "exact_retry", "identical committed receipt is idempotent");

check(!JSON.stringify({ request: scrub(request), challenge: scrub(challenge.envelope), proof: scrub(proof), deliveries: envelopes.map(scrub) }).includes("epoch_secret"),
  "portable and transactional artifacts do not serialize plaintext epoch secrets");
await testInvitationThroughRealHc1Store();
process.stdout.write(`${JSON.stringify({ assertions, recipients: envelopes.length, revocation_recipients: revoked.recipient_manifest.recipients.length, status: "ok" })}\n`);

async function testInvitationThroughRealHc1Store() {
  const root = await deriveControlStateRoot({ schema_version: 1, object_kind: "control_state_commitment", project_id: ids.project, owner_person_id: ids.ownerPerson,
    active_control_device_id: ids.ownerDevice, offline_root_key_id: ids.root, key_epoch_id: ids.epoch1,
    key_epoch_commitment: ownerCustody.public_binding.current_epoch_commitment, merge_policy: "manual", root_sequence: 0n,
    recovery_last_uncontested_control_id: null, device_authorities: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson,
      signing_key_id: ids.ownerSigning, role: "owner", capabilities: capabilitiesForRole("owner"), status: "active", maximum_accepted_semantic_sequence: null }] });
  const genesisCore = parseControlEventCoreStructure({ schema_version: 1, object_kind: "control_event_core", control_kind: "genesis", project_id: ids.project,
    control_sequence: 0n, previous_control_id: null, root_sequence: 0n, previous_root_control_id: null, owner_person_id: ids.ownerPerson,
    offline_root_key_id: ids.root, initial_active_control_device_id: ids.ownerDevice,
    initial_memberships: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, role: "owner", access_scope_id: ids.scope, status: "active" }],
    initial_authorized_devices: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson, signing_key_id: ids.ownerSigning, status: "active" }],
    initial_key_epoch_id: ids.epoch1, initial_key_epoch_commitment: ownerCustody.public_binding.current_epoch_commitment, resulting_control_state_root: root.id });
  const genesisId = (await deriveControlEventCoreIdentity(genesisCore)).id;
  const initialAuthority = { schema_version: 1, project_id: ids.project, control_event_id: genesisId, control_state_root: root.id,
    active_control_device_id: ids.ownerDevice, offline_root_key_id: ids.root, key_epoch_id: ids.epoch1,
    key_epoch_commitment: ownerCustody.public_binding.current_epoch_commitment, device_authorities: [{ device_id: ids.ownerDevice, person_id: ids.ownerPerson,
      signing_key_id: ids.ownerSigning, role: "owner", capabilities: capabilitiesForRole("owner"), status: "active", maximum_accepted_semantic_sequence: null }] };
  const acceptedAuthorities = new Map([[genesisId, initialAuthority]]);
  const events = new EventControlStore({ backend: memoryBackend(), attestation_verifier: { async verify(request) { return { outcome: "verified", binding: request }; } },
    control_transition_verifier: { async verify(request) { const authority = acceptedAuthorities.get(request.control_event_id); return authority ? { outcome: "verified", binding: request, resulting_authority: authority } : { outcome: "invalid", reason: "unregistered test transition" }; } } });
  const genesisAttestation = await makeAttestation(genesisId, ids.root);
  await events.putAttestationRecord(genesisAttestation);
  await events.putControlEvent(parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event", control_event_id: genesisId,
    core: genesisCore, authority_attestation_id: genesisAttestation.attestation_id }));
  const actionCore = createInvitationAction({ project_id: ids.project, invitation_id: entity("invitation", "z"), inviting_membership_id: ids.ownerMembership,
    inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice, intended_role: "editor", access_scope_id: ids.scope,
    creation_control_head_id: genesisId, valid_through_control_sequence: 9n });
  const actionStored = await events.putControlAction(actionCore);
  const eventCore = parseControlEventCoreStructure({ schema_version: 1, object_kind: "control_event_core", control_kind: "ordinary", project_id: ids.project,
    control_sequence: 1n, previous_control_id: genesisId, issuer_device_id: ids.ownerDevice, action_id: actionStored.id,
    resulting_control_state_root: root.id, key_epoch_id: ids.epoch1, key_epoch_commitment: ownerCustody.public_binding.current_epoch_commitment });
  const eventId = (await deriveControlEventCoreIdentity(eventCore)).id;
  acceptedAuthorities.set(eventId, { ...initialAuthority, control_event_id: eventId });
  const eventAttestation = await makeAttestation(eventId, ids.ownerSigning);
  await events.putAttestationRecord(eventAttestation);
  const event = parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event", control_event_id: eventId, core: eventCore,
    authority_attestation_id: eventAttestation.attestation_id });
  const ingested = await events.putControlEvent(event);
  const previous = parseAcceptedMembershipState({ ...state1, control_head_id: genesisId });
  const accepted = await materializeAcceptedInvitation({ previous_state: previous, action: actionStored.value, event, reconstructed_state: ingested.state });
  equal(accepted.next_state.control_head_id, eventId, "real HC-1 store accepts and reconstructs invitation control evidence");
  equal(accepted.handoff.authority, "none", "invitation handoff remains authority-free after accepted HC-1 reconstruction");
  check(!("epoch_secret" in accepted.handoff) && !("owner_private_key" in accepted.handoff), "invitation handoff contains neither epoch nor owner private material");
}

async function testAdditionalDeviceRoleAndMembershipRevocation(initialState) {
  const second = Object.freeze({ invitation: entity("invitation", "r"), device: entity("device", "o"), signing: entity("public-key", "q"),
    recipient: entity("public-key", "s"), epoch4: entity("key-epoch", "v"), epoch5: entity("key-epoch", "x"), epoch6: entity("key-epoch", "y"),
    control4: digest("control-event", "m"), control5: digest("control-event", "n"), control6: digest("control-event", "p") });
  const finalStore = new Hc2InMemoryCustodyStore(); const pendingStore = new Hc2InMemoryEnrollmentCandidateStore();
  const custody = new Hc2EnrollmentCustodyService({ pending_store: pendingStore, custody_store: finalStore, random: scriptedRandom([new Uint8Array(12).fill(0x71)]) });
  const created = await custody.createCandidate({ project_id: ids.project, person_id: ids.candidatePerson, device_id: second.device,
    access_scope_id: ids.scope, generation: 0n, signing_key_id: second.signing, recipient_key_id: second.recipient,
    offline_root_key_id: ids.root, bound_control_head_id: ids.control2 });
  const invitation = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project,
    invitation_id: second.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice,
    intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: ids.control2,
    creation_control_sequence: 1n, valid_through_control_sequence: 9n, accepted_invitation_action_id: digest("control-action", "r"),
    accepted_invitation_control_event_id: ids.control2, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
  const invitationIdentity = await deriveInvitationEvidenceIdentity(invitation);
  const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "additional_device",
    project_id: ids.project, invitation_id: second.invitation, invitation_evidence_id: invitationIdentity.id,
    accepted_invitation_control_event_id: ids.control2, candidate_person_id: ids.candidatePerson, existing_membership_id: ids.candidateMembership,
    proposed_membership_id: ids.candidateMembership, candidate_device_id: second.device, signing_key_id: second.signing,
    signing_public_key_bytes: created.public_binding.signing_public_key_bytes, recipient_key_id: second.recipient,
    recipient_public_key_bytes: created.public_binding.recipient_public_key_bytes, intended_role: "reviewer", access_scope: "project_wide",
    access_scope_id: ids.scope, bound_control_head_id: ids.control2, request_nonce: new Uint8Array(32).fill(0x72), suite_id: HC2_CRYPTO_SUITE_ID });
  const requestIdentity = await deriveEnrollmentRequestIdentity(requestCore);
  const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestIdentity.id,
    core: requestCore, algorithm: "ed25519", signature_bytes: await custody.signPending({ project_id: ids.project, device_id: second.device,
      preimage: buildEnrollmentSignaturePreimage("enrollment_request", ids.project, requestIdentity.id) }) });
  const challenge = await createPossessionChallenge({ request, current_control_head_id: ids.control2,
    random: scriptedRandom([new Uint8Array(32).fill(0x73)]), hpke });
  const proof = await buildPossessionResponse({ envelope: challenge.envelope, request,
    open: (value) => custody.openPendingEnvelope({ project_id: ids.project, device_id: second.device, ...value }),
    sign: (preimage) => custody.signPending({ project_id: ids.project, device_id: second.device, preimage }) });
  check(await verifyPossessionProof({ proof, request, challenge: challenge.envelope, expected_response_sha256: challenge.expected_response_sha256,
    current_control_head_id: ids.control2 }), "additional device independently proves its Ed25519 and X25519 keys");
  const epoch4 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: second.epoch4, epoch_secret: new Uint8Array(32).fill(0x74) });
  const addition = await prepareMembershipTransition({ previous_state: initialState, transition: { project_id: ids.project, mutation_kind: "additional_device",
    previous_control_head_id: ids.control2, expected_control_sequence: 2n, authorizing_owner_membership_id: ids.ownerMembership,
    authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: invitationIdentity.id,
    enrollment_request_id: request.request_id, possession_proof_id: proof.proof_id, membership_id: ids.candidateMembership,
    person_id: ids.candidatePerson, role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, device_id: second.device,
    signing_key_id: second.signing, recipient_key_id: second.recipient, signing_public_key_bytes: created.public_binding.signing_public_key_bytes,
    recipient_public_key_bytes: created.public_binding.recipient_public_key_bytes, revoked_device_ids: [], revocation_cutoffs: [],
    previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: ids.epoch2,
    replacement_epoch_id: second.epoch4, replacement_epoch_commitment: epoch4.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
  const added = await verifyMembershipTransition({ previous_state: initialState, transition: addition.transition,
    recipient_manifest: addition.recipient_manifest, delivery_set: addition.delivery_set, accepted_control_event_id: second.control4,
    invitation_evidence: invitation, enrollment_request: request, possession_proof: proof });
  equal(added.status, "verified", "additional-device enrollment verifies under the existing membership"); if (added.status !== "verified") throw new Error(added.reason);
  equal(added.recipient_manifest.recipients.map((entry) => entry.device_id), [ids.ownerDevice, ids.candidateDevice, second.device].sort(),
    "additional-device rotation includes all three active devices");

  const epoch5 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: second.epoch5, epoch_secret: new Uint8Array(32).fill(0x75) });
  await rejects(() => prepareMembershipTransition({ previous_state: added.next_state, transition: { project_id: ids.project, mutation_kind: "role_change",
    previous_control_head_id: second.control4, expected_control_sequence: 3n, authorizing_owner_membership_id: ids.ownerMembership,
    authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: null,
    enrollment_request_id: null, possession_proof_id: null, membership_id: ids.ownerMembership, person_id: ids.ownerPerson,
    role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, device_id: null, signing_key_id: null, recipient_key_id: null,
    signing_public_key_bytes: null, recipient_public_key_bytes: null, revoked_device_ids: [], revocation_cutoffs: [],
    previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: second.epoch4,
    replacement_epoch_id: second.epoch5, replacement_epoch_commitment: epoch5.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } }), /final owner|at least one/i);
  const roleChange = await prepareMembershipTransition({ previous_state: added.next_state, transition: { project_id: ids.project, mutation_kind: "role_change",
    previous_control_head_id: second.control4, expected_control_sequence: 3n, authorizing_owner_membership_id: ids.ownerMembership,
    authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: null,
    enrollment_request_id: null, possession_proof_id: null, membership_id: ids.candidateMembership, person_id: ids.candidatePerson,
    role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, device_id: null, signing_key_id: null, recipient_key_id: null,
    signing_public_key_bytes: null, recipient_public_key_bytes: null, revoked_device_ids: [], revocation_cutoffs: [],
    previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: second.epoch4,
    replacement_epoch_id: second.epoch5, replacement_epoch_commitment: epoch5.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
  const changed = await verifyMembershipTransition({ previous_state: added.next_state, transition: roleChange.transition,
    recipient_manifest: roleChange.recipient_manifest, delivery_set: roleChange.delivery_set, accepted_control_event_id: second.control5 });
  equal(changed.status, "verified", "owner-controlled role change requires and verifies a fresh epoch"); if (changed.status !== "verified") throw new Error(changed.reason);
  equal(changed.next_state.memberships.find((entry) => entry.membership_id === ids.candidateMembership)?.role, "editor", "role changes only to the explicit accepted role");

  const epoch6 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: second.epoch6, epoch_secret: new Uint8Array(32).fill(0x76) });
  const revokedDevices = [ids.candidateDevice, second.device].sort();
  const membershipRevocation = await prepareMembershipTransition({ previous_state: changed.next_state, transition: { project_id: ids.project,
    mutation_kind: "membership_revocation", previous_control_head_id: second.control5, expected_control_sequence: 4n,
    authorizing_owner_membership_id: ids.ownerMembership, authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice,
    invitation_evidence_id: null, enrollment_request_id: null, possession_proof_id: null, membership_id: ids.candidateMembership,
    person_id: ids.candidatePerson, role: "editor", access_scope: "project_wide", access_scope_id: ids.scope, device_id: null,
    signing_key_id: null, recipient_key_id: null, signing_public_key_bytes: null, recipient_public_key_bytes: null,
    revoked_device_ids: revokedDevices, revocation_cutoffs: revokedDevices.map((device_id) => ({ device_id, maximum_accepted_semantic_sequence: 0n })),
    previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: second.epoch5,
    replacement_epoch_id: second.epoch6, replacement_epoch_commitment: epoch6.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
  const removed = await verifyMembershipTransition({ previous_state: changed.next_state, transition: membershipRevocation.transition,
    recipient_manifest: membershipRevocation.recipient_manifest, delivery_set: membershipRevocation.delivery_set, accepted_control_event_id: second.control6 });
  equal(removed.status, "verified", "membership revocation atomically revokes all member devices and rotates the epoch"); if (removed.status !== "verified") throw new Error(removed.reason);
  equal(removed.recipient_manifest.recipients.map((entry) => entry.device_id), [ids.ownerDevice], "membership-revoked devices receive no replacement epoch");
}

async function testCandidateAdmissionFailureRetries(input) {
  const basePending = await candidateStore.readPendingVault(ids.project, ids.candidateDevice);
  check(basePending !== null, "candidate failure suite starts from persisted pending non-extractable custody");
  for (let index = 0; index < candidateAdmissionFailureStages.length; index += 1) {
    const stage = candidateAdmissionFailureStages[index];
    const pending = new Hc2InMemoryEnrollmentCandidateStore();
    await pending.putPendingVault(basePending);
    const final = new Hc2InMemoryCustodyStore();
    const custody = new Hc2EnrollmentCustodyService({ pending_store: pending, custody_store: final,
      random: scriptedRandom([new Uint8Array(12).fill(0x90 + index)]) });
    const receipts = new Hc2InMemoryEpochReceiptStore();
    const admissionInput = {
      accepted_state: input.state, transition: input.transition, admission_package: input.admission, delivery: input.delivery,
      evidence: input.evidence, custody, ceremony_id: `slice5-candidate-retry-${index}`, acknowledgement_sequence: 0n,
      previous_acknowledgement_id: null,
      async reserve_receipt(value) {
        const outcome = await receipts.reserve(parseEpochReceiptReservation({ schema_version: 1, record_kind: "epoch_receipt_sequence_reservation",
          project_id: value.core.project_id, device_id: value.core.device_id, acknowledgement_sequence: value.core.acknowledgement_sequence,
          previous_acknowledgement_id: value.core.previous_acknowledgement_id, intended_receipt_id: value.receipt_id, state: "pending" }));
        if (outcome === "conflict") throw new Error("Candidate receipt reservation CAS conflict.");
        return outcome;
      },
      async write_receipt(value) { await receipts.write(value); },
      async commit_receipt(value) { await receipts.commit(value); }
    };
    let injected = 0;
    await rejects(() => admitCandidateDevice({ ...admissionInput, async failure_injector(candidateStage) {
      if (candidateStage === stage && injected === 0) { injected += 1; throw new Error(`candidate-injected:${stage}`); }
    } }), /candidate-injected:/);
    equal(injected, 1, `${stage} candidate crash cut is reached exactly once`);
    const resumed = await admitCandidateDevice(admissionInput);
    equal(resumed.full_history_verified, false, `${stage} exact retry does not inflate the candidate's history claim`);
    equal((await receipts.list(ids.project, ids.candidateDevice)).map((entry) => entry.receipt_id), [resumed.receipt.receipt_id],
      `${stage} exact retry commits one immutable acknowledgement`);
    equal((await pending.readCompletionMarker(ids.project, ids.candidateDevice))?.completion, "epoch_installed_and_acknowledged",
      `${stage} writes the candidate completion marker last`);
    equal(await pending.readPendingVault(ids.project, ids.candidateDevice), null, `${stage} removes pending custody only after verified completion`);
  }
}

async function admissionEvidence(state, transition) {
  const checkpointId = digest("semantic-event", "a");
  const boundaryRevisions = Object.freeze([{ document_id: entity("document", "b"), revision_id: digest("document-revision", "b"), traversal: "complete" }]);
  const projection = { schema_version: 1, object_kind: "collaboration_projection", reducer_version: "patchmark-hc-reducer-v1",
    project_id: state.project_id, project_title: { register_version: 1, state: "unset", resolved_value: null, last_uncontested_value: null, contenders: [] },
    group_order: [], groups: [], document_order: [], documents: [], review_batches: [], rewrite_sessions: [], revision_heads: [], conflicts: [],
    reduction_rejections: [], replayed_event_ids: [], accepted_frontier: [], event_provenance: [] };
  const stateCore = { schema_version: 1, object_kind: "canonical_state_blob_core", project_id: state.project_id,
    reducer_version: "patchmark-hc-reducer-v1", checkpoint_id: checkpointId, control_head_id: state.control_head_id,
    semantic_state_root: digest("semantic-state-root", "c"), revision_heads_root: digest("revision-heads-root", "d"),
    conflict_set_root: digest("conflict-set-root", "e"), projection_root: digest("projection-root", "b"), projection };
  const stateIdentity = await deriveCanonicalStateBlobIdentity(stateCore);
  const stateBlob = parseCanonicalStateBlobRecord({ record_version: 1, object_kind: "canonical_state_blob", state_blob_id: stateIdentity.id, core: stateCore });
  const snapshotCore = { schema_version: 1, object_kind: "projection_snapshot_core", project_id: state.project_id, checkpoint_id: checkpointId,
    reducer_version: "patchmark-hc-reducer-v1", state_blob_id: stateBlob.state_blob_id, semantic_state_root: stateCore.semantic_state_root,
    revision_heads_root: stateCore.revision_heads_root, conflict_set_root: stateCore.conflict_set_root, projection_root: stateCore.projection_root,
    boundary_revisions: boundaryRevisions, live_conflict_dependencies: [] };
  const snapshotIdentity = await deriveProjectionSnapshotIdentity(snapshotCore);
  const snapshot = parseProjectionSnapshotRecord({ record_version: 1, object_kind: "projection_snapshot", snapshot_id: snapshotIdentity.id,
    core: snapshotCore, producer_attestation_id: null }, checkpointId);
  return Object.freeze({ checkpoint_verification: Object.freeze({ status: "full_history_verified", checkpoint_id: checkpointId }), state_blob: stateBlob, snapshot,
    admission_boundary: Object.freeze({ schema_version: 1, object_kind: "admission_boundary", project_id: state.project_id,
      admitted_membership_id: transition.membership_id, admitted_person_id: transition.person_id, admitted_device_id: transition.device_id,
      owner_authorized_control_event_id: state.control_head_id, checkpoint_id: checkpointId, snapshot_id: snapshot.snapshot_id,
      admission_key_epoch_id: transition.replacement_epoch_id, boundary_revisions: boundaryRevisions, sealed_prior_history: Object.freeze({
        accepted_history_root: digest("accepted-history-root", "f"), parent_traversal: "unavailable_before_admission", prior_plaintext: "not_provided",
        verification_basis: "owner_authorized_current_state" }), replica_scope: "complete_current_state" }),
    semantic_frontier: Object.freeze([]), revision_manifest: Object.freeze(boundaryRevisions.map((entry) => entry.revision_id)), conflict_manifest: Object.freeze([]) });
}

async function makeAttestation(subjectId, signerKeyId) { const core = { schema_version: 1, object_kind: "attestation_core", project_id: ids.project,
  subject_kind: "control_event", subject_id: subjectId, signer_key_id: signerKeyId, algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x91) };
  const identity = await deriveAttestationIdentity(core); return parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: identity.id, core }); }

function memoryBackend() { const bytes = new Map(); return { async read(address) { const value = bytes.get(address); return value === undefined ? null : Uint8Array.from(value); },
  async write(address, value) { bytes.set(address, Uint8Array.from(value)); }, async delete(address) { bytes.delete(address); },
  async list(prefix) { return [...bytes.keys()].filter((address) => address.startsWith(prefix)).sort(); } }; }

function deliveryHeader(prepared, recipient, index, controlEventId) { return parseEpochDeliveryHeaderCore({ schema_version: 1, record_kind: "epoch_delivery_header_core", authority: "none",
  project_id: ids.project, transition_id: prepared.transition_id, accepted_control_event_id: controlEventId, delivery_set_id: prepared.transition.delivery_set_id,
  recipient_manifest_id: prepared.transition.recipient_manifest_id, key_epoch_id: prepared.transition.replacement_epoch_id,
  key_epoch_commitment: prepared.transition.replacement_epoch_commitment, recipient_membership_id: recipient.membership_id, recipient_person_id: recipient.person_id,
  recipient_device_id: recipient.device_id, recipient_key_id: recipient.recipient_key_id, recipient_ordinal: BigInt(index),
  recipient_count: BigInt(prepared.recipient_manifest.recipients.length), suite_id: HC2_CRYPTO_SUITE_ID }); }

function authority(binding, head) { return { project_id: binding.project_id, person_id: binding.person_id, device_id: binding.device_id, access_scope_id: binding.access_scope_id,
  signing_key_id: binding.signing_key_id, recipient_key_id: binding.recipient_key_id, accepted_control_head_id: head, offline_root_key_id: binding.offline_root_key_id,
  key_epoch_id: binding.current_epoch_id, key_epoch_commitment: binding.current_epoch_commitment, device_status: "active" }; }
function entity(kind, char) { return `pm:${kind}:v1:${char.repeat(25)}a`; }
function digest(kind, char) { return `pm:${kind}:v1:${char.repeat(51)}a`; }
function scrub(value) { return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child instanceof Uint8Array ? Buffer.from(child).toString("hex") : child)); }
function scriptedRandom(values) { const remaining = values.map((value) => Uint8Array.from(value)); return { async randomBytes(length) { const value = remaining.shift(); if (!value || value.length !== length) throw new Error(`scripted random expected ${length} bytes`); return Uint8Array.from(value); } }; }

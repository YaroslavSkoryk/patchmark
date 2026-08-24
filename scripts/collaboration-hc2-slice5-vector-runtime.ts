/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- frozen-vector orchestration intentionally feeds strict parsers from unbranded JSON.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { parseControlActionCore, parseControlEventCoreStructure } from "../lib/collaboration/control.ts";
import { deriveControlActionIdentity, deriveControlEventCoreIdentity } from "../lib/collaboration/preimages.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";
import {
  buildEnrollmentSignaturePreimage, deriveAdmissionPackageIdentity, deriveEnrollmentRequestIdentity, deriveEpochReceiptIdentity,
  deriveInvitationEvidenceIdentity, parseAcceptedMembershipState,
  parseAdmissionPackageCore, parseEnrollmentRequestCore, parseEnrollmentRequestRecord, parseEpochDeliveryHeaderCore,
  parseEpochReceiptCore, parseInvitationEvidenceCore
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { buildBoundHpkeAad } from "../lib/collaboration/hc2/envelope.ts";
import { createInvitationAction } from "../lib/collaboration/hc2/invitation-authority.ts";
import { createEpochDeliveryEnvelope, createPossessionChallenge, buildPossessionResponse } from "../lib/collaboration/hc2/epoch-delivery.ts";
import { deriveEpochCommitment } from "../lib/collaboration/hc2/epoch-custody.ts";
import { prepareMembershipTransition } from "../lib/collaboration/hc2/membership-authority.ts";
import { decodeAlgorithmTaggedPublicKey, encodeAlgorithmTaggedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID } from "../lib/collaboration/hc2/versions.ts";

export type Slice5VectorInput = Readonly<{
  candidate_ed25519_seed_hex: string;
  candidate_ed25519_public_hex: string;
  owner_ed25519_public_hex: string;
  candidate_x25519_ikm_hex: string;
  owner_x25519_ikm_hex: string;
  challenge_ephemeral_ikm_hex: string;
  candidate_delivery_ephemeral_ikm_hex: string;
  owner_delivery_ephemeral_ikm_hex: string;
  challenge_plaintext_hex: string;
  epoch1_secret_hex: string;
  epoch2_secret_hex: string;
  epoch3_secret_hex: string;
}>;

export async function createHc2Slice5VectorActual(input: Slice5VectorInput) {
  const suite = hpkeSuite();
  const candidateX = await suite.kem.deriveKeyPair(hex(input.candidate_x25519_ikm_hex)); const ownerX = await suite.kem.deriveKeyPair(hex(input.owner_x25519_ikm_hex));
  const candidateXRaw = new Uint8Array(await suite.kem.serializePublicKey(candidateX.publicKey)); const ownerXRaw = new Uint8Array(await suite.kem.serializePublicKey(ownerX.publicKey));
  const candidateSigning = encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.candidateSigning, raw_public_key: hex(input.candidate_ed25519_public_hex) });
  const ownerSigning = encodeAlgorithmTaggedPublicKey({ algorithm: "ed25519", key_id: ids.ownerSigning, raw_public_key: hex(input.owner_ed25519_public_hex) });
  const candidateRecipient = encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.candidateRecipient, raw_public_key: candidateXRaw });
  const ownerRecipient = encodeAlgorithmTaggedPublicKey({ algorithm: "x25519", key_id: ids.ownerRecipient, raw_public_key: ownerXRaw });
  const invitationAction = createInvitationAction({ project_id: ids.project, invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership,
    inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice, intended_role: "reviewer", access_scope_id: ids.scope,
    creation_control_head_id: ids.control1, valid_through_control_sequence: 12n });
  const invitationActionIdentity = await deriveControlActionIdentity(invitationAction);
  const invitation = parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none", project_id: ids.project,
    invitation_id: ids.invitation, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson, inviting_device_id: ids.ownerDevice,
    intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, creation_control_head_id: ids.control1,
    creation_control_sequence: 1n, valid_through_control_sequence: 12n, accepted_invitation_action_id: invitationActionIdentity.id,
    accepted_invitation_control_event_id: ids.control1, status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID });
  const invitationIdentity = await deriveInvitationEvidenceIdentity(invitation);
  const requestCore = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person",
    project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationIdentity.id, accepted_invitation_control_event_id: ids.control1,
    candidate_person_id: ids.candidatePerson, existing_membership_id: null, proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice,
    signing_key_id: ids.candidateSigning, signing_public_key_bytes: candidateSigning, recipient_key_id: ids.candidateRecipient,
    recipient_public_key_bytes: candidateRecipient, intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope,
    bound_control_head_id: ids.control1, request_nonce: new Uint8Array(32).fill(0x71), suite_id: HC2_CRYPTO_SUITE_ID });
  const requestIdentity = await deriveEnrollmentRequestIdentity(requestCore); const requestPreimage = buildEnrollmentSignaturePreimage("enrollment_request", ids.project, requestIdentity.id);
  const candidatePrivate = await crypto.subtle.importKey("pkcs8", concatHex("302e020100300506032b657004220420", input.candidate_ed25519_seed_hex), "Ed25519", false, ["sign"]);
  const requestSignature = new Uint8Array(await crypto.subtle.sign("Ed25519", candidatePrivate, requestPreimage));
  const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: requestIdentity.id,
    core: requestCore, algorithm: "ed25519", signature_bytes: requestSignature });
  const challengeProvider = new DeterministicHpkeSender(input.challenge_ephemeral_ikm_hex);
  const challenge = await createPossessionChallenge({ request, current_control_head_id: ids.control1,
    random: fixedRandom(hex(input.challenge_plaintext_hex)), hpke: challengeProvider });
  const proof = await buildPossessionResponse({ envelope: challenge.envelope, request,
    open: (value) => openDeterministic(value, input.candidate_x25519_ikm_hex),
    sign: async (preimage) => new Uint8Array(await crypto.subtle.sign("Ed25519", candidatePrivate, preimage)) });
  const epoch1 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch1, epoch_secret: hex(input.epoch1_secret_hex) });
  const epoch2 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch2, epoch_secret: hex(input.epoch2_secret_hex) });
  const state = parseAcceptedMembershipState({ schema_version: 1, record_kind: "accepted_membership_state", project_id: ids.project, owner_person_id: ids.ownerPerson,
    control_head_id: ids.control1, control_sequence: 1n, root_sequence: 0n, merge_policy: "manual", active_control_device_id: ids.ownerDevice,
    offline_root_key_id: ids.root, current_epoch_id: ids.epoch1, current_epoch_commitment: epoch1.key_epoch_commitment,
    memberships: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, role: "owner", access_scope: "project_wide", access_scope_id: ids.scope, status: "active" }],
    devices: [{ membership_id: ids.ownerMembership, person_id: ids.ownerPerson, device_id: ids.ownerDevice, signing_key_id: ids.ownerSigning,
      signing_public_key_bytes: ownerSigning, recipient_key_id: ids.ownerRecipient, recipient_public_key_bytes: ownerRecipient, status: "active", maximum_accepted_semantic_sequence: null }],
    consumed_invitation_ids: [], cancelled_invitation_ids: [] });
  const prepared = await prepareMembershipTransition({ previous_state: state, transition: { project_id: ids.project, mutation_kind: "new_membership",
    previous_control_head_id: ids.control1, expected_control_sequence: 2n, authorizing_owner_membership_id: ids.ownerMembership,
    authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: invitationIdentity.id,
    enrollment_request_id: request.request_id, possession_proof_id: proof.proof_id, membership_id: ids.candidateMembership, person_id: ids.candidatePerson,
    role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, device_id: ids.candidateDevice, signing_key_id: ids.candidateSigning,
    recipient_key_id: ids.candidateRecipient, signing_public_key_bytes: candidateSigning, recipient_public_key_bytes: candidateRecipient,
    revoked_device_ids: [], revocation_cutoffs: [], previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice,
    previous_epoch_id: ids.epoch1, replacement_epoch_id: ids.epoch2, replacement_epoch_commitment: epoch2.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
  const transitionAction = parseControlActionCore({ schema_version: 1, project_id: ids.project, action_kind: "hc2_membership_epoch_transition",
    transition_id: prepared.transition_id, transition_kind: "new_membership", recipient_manifest_id: prepared.transition.recipient_manifest_id,
    delivery_set_id: prepared.transition.delivery_set_id, previous_key_epoch_id: ids.epoch1, replacement_key_epoch_id: ids.epoch2,
    replacement_key_epoch_commitment: epoch2.key_epoch_commitment, replacement_active_control_device_id: ids.ownerDevice, suite_id: HC2_CRYPTO_SUITE_ID });
  const transitionActionIdentity = await deriveControlActionIdentity(transitionAction);
  const eventCore = parseControlEventCoreStructure({ schema_version: 1, object_kind: "control_event_core", control_kind: "ordinary", project_id: ids.project,
    control_sequence: 2n, previous_control_id: ids.control1, issuer_device_id: ids.ownerDevice, action_id: transitionActionIdentity.id,
    resulting_control_state_root: prepared.transition.resulting_control_state_root, key_epoch_id: ids.epoch2, key_epoch_commitment: epoch2.key_epoch_commitment });
  const eventIdentity = await deriveControlEventCoreIdentity(eventCore);
  const deliveries = [];
  const ephemeral = [input.candidate_delivery_ephemeral_ikm_hex, input.owner_delivery_ephemeral_ikm_hex];
  for (let index = 0; index < prepared.recipient_manifest.recipients.length; index += 1) {
    const recipient = prepared.recipient_manifest.recipients[index];
    deliveries.push(await createEpochDeliveryEnvelope({ header_core: parseEpochDeliveryHeaderCore({ schema_version: 1, record_kind: "epoch_delivery_header_core", authority: "none",
      project_id: ids.project, transition_id: prepared.transition_id, accepted_control_event_id: eventIdentity.id, delivery_set_id: prepared.transition.delivery_set_id,
      recipient_manifest_id: prepared.transition.recipient_manifest_id, key_epoch_id: ids.epoch2, key_epoch_commitment: epoch2.key_epoch_commitment,
      recipient_membership_id: recipient.membership_id, recipient_person_id: recipient.person_id, recipient_device_id: recipient.device_id,
      recipient_key_id: recipient.recipient_key_id, recipient_ordinal: BigInt(index), recipient_count: BigInt(prepared.recipient_manifest.recipients.length), suite_id: HC2_CRYPTO_SUITE_ID }),
      recipient_public_key_bytes: recipient.recipient_public_key_bytes, public_commitment_bytes: epoch2.public_commitment_bytes,
      epoch_secret: hex(input.epoch2_secret_hex), hpke: new DeterministicHpkeSender(ephemeral[index]) }));
  }
  const admissionCore = parseAdmissionPackageCore({ schema_version: 1, record_kind: "current_state_admission_package_core", authority: "none", project_id: ids.project,
    transition_id: prepared.transition_id, accepted_control_action_id: transitionActionIdentity.id, accepted_control_event_id: eventIdentity.id,
    resulting_control_state_root: prepared.transition.resulting_control_state_root, admitted_membership_id: ids.candidateMembership, admitted_person_id: ids.candidatePerson,
    admitted_device_id: ids.candidateDevice, admitted_role: "reviewer", access_scope: "project_wide", signing_key_id: ids.candidateSigning,
    recipient_key_id: ids.candidateRecipient, key_epoch_id: ids.epoch2, key_epoch_commitment: epoch2.key_epoch_commitment,
    recipient_manifest_id: prepared.transition.recipient_manifest_id, delivery_set_id: prepared.transition.delivery_set_id,
    recipient_delivery_id: deliveries.find((entry) => entry.header_core.recipient_device_id === ids.candidateDevice)!.delivery_id,
    checkpoint_id: digest("semantic-event", "a"), projection_root: digest("projection-root", "b"), semantic_state_root: digest("semantic-state-root", "c"),
    revision_heads_root: digest("revision-heads-root", "d"), conflict_set_root: digest("conflict-set-root", "e"), accepted_history_root: digest("accepted-history-root", "f"),
    state_blob_id: digest("state-blob", "g"), snapshot_id: digest("snapshot", "h"), semantic_frontier: [], revision_manifest: [], conflict_manifest: [],
    reducer_version: "patchmark/hc1/reducer/v1", admission_boundary_sha256: new Uint8Array(32).fill(0x81), owner_signing_key_id: ids.ownerSigning,
    full_history_verified: false, suite_id: HC2_CRYPTO_SUITE_ID });
  const admissionIdentity = await deriveAdmissionPackageIdentity(admissionCore);
  const receiptCore = parseEpochReceiptCore({ schema_version: 1, record_kind: "epoch_delivery_receipt_core", authority: "none", project_id: ids.project,
    person_id: ids.candidatePerson, membership_id: ids.candidateMembership, role: "reviewer", device_id: ids.candidateDevice,
    signing_key_id: ids.candidateSigning, acknowledgement_sequence: 0n, previous_acknowledgement_id: null, accepted_control_event_id: eventIdentity.id,
    key_epoch_id: ids.epoch2, key_epoch_commitment: epoch2.key_epoch_commitment, delivery_id: admissionCore.recipient_delivery_id,
    checkpoint_id: admissionCore.checkpoint_id, projection_root: admissionCore.projection_root, admission_package_id: admissionIdentity.id,
    admission_boundary_sha256: admissionCore.admission_boundary_sha256, suite_id: HC2_CRYPTO_SUITE_ID });
  const receiptIdentity = await deriveEpochReceiptIdentity(receiptCore); const receiptPreimage = buildEnrollmentSignaturePreimage("epoch_receipt", ids.project, receiptIdentity.id);
  const receiptSignature = new Uint8Array(await crypto.subtle.sign("Ed25519", candidatePrivate, receiptPreimage));
  const epoch3 = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch3, epoch_secret: hex(input.epoch3_secret_hex) });
  const acceptedState = parseAcceptedMembershipState({ ...state, control_head_id: eventIdentity.id, control_sequence: 2n, current_epoch_id: ids.epoch2,
    current_epoch_commitment: epoch2.key_epoch_commitment, memberships: [...state.memberships, { membership_id: ids.candidateMembership, person_id: ids.candidatePerson,
      role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope, status: "active" }], devices: [...state.devices, {
      membership_id: ids.candidateMembership, person_id: ids.candidatePerson, device_id: ids.candidateDevice, signing_key_id: ids.candidateSigning,
      signing_public_key_bytes: candidateSigning, recipient_key_id: ids.candidateRecipient, recipient_public_key_bytes: candidateRecipient,
      status: "active", maximum_accepted_semantic_sequence: null }].sort((a, b) => a.device_id < b.device_id ? -1 : 1), consumed_invitation_ids: [ids.invitation] });
  const revocation = await prepareMembershipTransition({ previous_state: acceptedState, transition: { project_id: ids.project, mutation_kind: "device_revocation",
    previous_control_head_id: eventIdentity.id, expected_control_sequence: 3n, authorizing_owner_membership_id: ids.ownerMembership,
    authorizing_owner_person_id: ids.ownerPerson, authorizing_owner_device_id: ids.ownerDevice, invitation_evidence_id: null, enrollment_request_id: null,
    possession_proof_id: null, membership_id: ids.candidateMembership, person_id: ids.candidatePerson, role: "reviewer", access_scope: "project_wide",
    access_scope_id: ids.scope, device_id: null, signing_key_id: null, recipient_key_id: null, signing_public_key_bytes: null, recipient_public_key_bytes: null,
    revoked_device_ids: [ids.candidateDevice], revocation_cutoffs: [{ device_id: ids.candidateDevice, maximum_accepted_semantic_sequence: 0n }],
    previous_active_control_device_id: ids.ownerDevice, replacement_active_control_device_id: ids.ownerDevice, previous_epoch_id: ids.epoch2,
    replacement_epoch_id: ids.epoch3, replacement_epoch_commitment: epoch3.key_epoch_commitment, suite_id: HC2_CRYPTO_SUITE_ID } });
  return Object.freeze({
    invitation: { action_id: invitationActionIdentity.id, action_canonical_sha256: await hashCanonical(invitationAction), evidence_id: invitationIdentity.id },
    enrollment_request: { request_id: requestIdentity.id, canonical_sha256: await hashBytes(requestIdentity.canonical_preimage_bytes), signature_preimage_hex: toHex(requestPreimage), signature_hex: toHex(requestSignature) },
    challenge: { challenge_id: challenge.envelope.challenge_id, header_sha256: await hashCanonical(challenge.envelope.header_core), encapsulated_key_hex: toHex(challenge.envelope.public_header.encapsulated_key_bytes), ciphertext_hex: toHex(challenge.envelope.ciphertext_bytes), proof_id: proof.proof_id, response_preimage_hex: toHex(buildEnrollmentSignaturePreimage("possession_response", ids.project, proof.proof_id)), response_signature_hex: toHex(proof.signature_bytes) },
    transition: { transition_id: prepared.transition_id, control_action_id: transitionActionIdentity.id, control_event_id: eventIdentity.id, resulting_control_state_root: prepared.transition.resulting_control_state_root, recipient_manifest_id: prepared.transition.recipient_manifest_id, delivery_set_id: prepared.transition.delivery_set_id, recipient_device_ids: prepared.recipient_manifest.recipients.map((entry) => entry.device_id), epoch_commitment_id: epoch2.key_epoch_commitment, epoch_public_commitment_hex: toHex(epoch2.public_commitment_bytes) },
    deliveries: await Promise.all(deliveries.map(async (entry) => ({ delivery_id: entry.delivery_id, recipient_device_id: entry.header_core.recipient_device_id, recipient_key_id: entry.header_core.recipient_key_id, header_sha256: await hashCanonical(entry.header_core), encapsulated_key_hex: toHex(entry.public_header.encapsulated_key_bytes), ciphertext_bytes: entry.ciphertext_bytes.length, ciphertext_sha256: await hashBytes(entry.ciphertext_bytes) }))),
    admission: { admission_package_id: admissionIdentity.id, projection_root: admissionCore.projection_root, admission_boundary_sha256_hex: toHex(admissionCore.admission_boundary_sha256), full_history_verified: false },
    receipt: { receipt_id: receiptIdentity.id, signature_preimage_hex: toHex(receiptPreimage), signature_hex: toHex(receiptSignature) },
    revocation: { transition_id: revocation.transition_id, resulting_control_state_root: revocation.transition.resulting_control_state_root, recipient_manifest_id: revocation.transition.recipient_manifest_id, recipient_device_ids: revocation.recipient_manifest.recipients.map((entry) => entry.device_id), replacement_epoch_commitment_id: epoch3.key_epoch_commitment },
    rejections: ["invitation_reuse", "stale_control_head", "wrong_ed25519", "wrong_x25519", "missing_delivery", "duplicate_delivery", "extra_delivery", "revoked_recipient", "same_epoch", "final_owner_removal", "selective_scope", "self_authorization"]
  });
}

class DeterministicHpkeSender {
  readonly #ephemeralIkm: Uint8Array;
  constructor(value: string) { this.#ephemeralIkm = hex(value); }
  async sealBound(input: { recipient_public_key: Uint8Array; info: Uint8Array; plaintext: Uint8Array; finalize_aad: (enc: Uint8Array) => Uint8Array }) {
    const suite = hpkeSuite(); const decoded = decodeAlgorithmTaggedPublicKey(input.recipient_public_key, "x25519");
    const recipient = await suite.kem.deserializePublicKey(decoded.raw_public_key); const ephemeral = await suite.kem.deriveKeyPair(this.#ephemeralIkm);
    const sender = await suite.createSenderContext({ recipientPublicKey: recipient, info: input.info, ekm: ephemeral });
    const aad = input.finalize_aad(new Uint8Array(sender.enc)); return { ciphertext_bytes: new Uint8Array(await sender.seal(input.plaintext, aad)) };
  }
}
async function openDeterministic(input: Readonly<{ info: Uint8Array; public_header: Parameters<typeof buildBoundHpkeAad>[0]; ciphertext_bytes: Uint8Array }>, recipientIkm: string) {
  try { const suite = hpkeSuite(); const recipient = await suite.kem.deriveKeyPair(hex(recipientIkm)); const context = await suite.createRecipientContext({ recipientKey: recipient,
    enc: input.public_header.encapsulated_key_bytes, info: input.info }); return { status: "opened" as const, plaintext: new Uint8Array(await context.open(input.ciphertext_bytes, buildBoundHpkeAad(input.public_header))) }; }
  catch { return { status: "rejected" as const }; }
}
function fixedRandom(value: Uint8Array) { let used = false; return { async randomBytes(length: number) { if (used || value.length !== length) throw new Error("fixed vector random source was reused"); used = true; return Uint8Array.from(value); } }; }
function hpkeSuite() { return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }); }
async function hashCanonical(value: unknown) { return hashBytes(encodeCanonicalCbor(canonicalProtocolValue(value))); }
async function hashBytes(value: Uint8Array) { return toHex(await sha256(value)); }
function entity(kind: string, fill: string) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind: string, fill: string) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hex(value: string) { return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []); }
function concatHex(prefix: string, suffix: string) { const left = hex(prefix); const right = hex(suffix); const result = new Uint8Array(left.length + right.length); result.set(left); result.set(right, left.length); return result; }
function toHex(value: Uint8Array) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

const ids = Object.freeze({ project: entity("project", "a"), scope: entity("access-scope", "b"), ownerPerson: entity("person", "c"), ownerMembership: entity("membership", "d"),
  ownerDevice: entity("device", "e"), ownerSigning: entity("public-key", "f"), ownerRecipient: entity("public-key", "g"), root: entity("public-key", "h"),
  candidatePerson: entity("person", "j"), candidateMembership: entity("membership", "k"), candidateDevice: entity("device", "m"), candidateSigning: entity("public-key", "n"),
  candidateRecipient: entity("public-key", "p"), invitation: entity("invitation", "q"), epoch1: entity("key-epoch", "r"), epoch2: entity("key-epoch", "s"),
  epoch3: entity("key-epoch", "t"), control1: digest("control-event", "u") });

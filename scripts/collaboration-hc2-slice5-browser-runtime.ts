/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- browser evidence crosses branded protocol values through an explicit JSON shuttle.
import { createHc2Slice5VectorActual, type Slice5VectorInput } from "./collaboration-hc2-slice5-vector-runtime.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveEnrollmentRequestIdentity,
  deriveInvitationEvidenceIdentity,
  parseEnrollmentRequestCore,
  parseEnrollmentRequestRecord,
  parseEpochDeliveryHeaderCore,
  parseInvitationEvidenceCore,
  parsePossessionChallengeEnvelope,
  parsePossessionProofRecord
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { Hc2IndexedDbCustodyStore } from "../lib/collaboration/hc2/custody-store.ts";
import {
  Hc2EnrollmentCustodyService,
  Hc2IndexedDbEnrollmentCandidateStore
} from "../lib/collaboration/hc2/enrollment-custody.ts";
import { Hc2IndexedDbEnrollmentStore } from "../lib/collaboration/hc2/enrollment-store.ts";
import {
  buildPossessionResponse,
  createEpochDeliveryEnvelope,
  createPossessionChallenge,
  openEpochDelivery,
  verifyEnrollmentRequestSignature,
  verifyPossessionProof
} from "../lib/collaboration/hc2/epoch-delivery.ts";
import { deriveEpochCommitment } from "../lib/collaboration/hc2/epoch-custody.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { exportAndEncodePublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import { HC2_CRYPTO_SUITE_ID } from "../lib/collaboration/hc2/versions.ts";

const ids = Object.freeze({
  project: entity("project", "a"), scope: entity("access-scope", "b"), ownerPerson: entity("person", "c"),
  ownerMembership: entity("membership", "d"), ownerDevice: entity("device", "e"), ownerRecipient: entity("public-key", "g"), root: entity("public-key", "h"),
  candidatePerson: entity("person", "j"), candidateMembership: entity("membership", "k"), candidateDevice: entity("device", "m"),
  candidateSigning: entity("public-key", "n"), candidateRecipient: entity("public-key", "p"), invitation: entity("invitation", "q"),
  epoch2: entity("key-epoch", "s"), epoch3: entity("key-epoch", "t"), control1: digest("control-event", "u"), control2: digest("control-event", "v"),
  transition: digest("membership-transition", "w"), manifest: digest("recipient-manifest", "x"), deliverySet: digest("delivery-set", "y"),
  admission: digest("admission-package", "z"), contentionInvitation: entity("invitation", "r")
});

export async function verifyFrozenVector(fixture: Readonly<{ inputs: Slice5VectorInput }>) {
  return createHc2Slice5VectorActual(fixture.inputs);
}

export async function runCandidateSetup(databasePrefix: string) {
  const absentBeforeOpen = !(await indexedDB.databases()).some((entry) => entry.name?.startsWith(databasePrefix));
  const resources = await candidateResources(databasePrefix);
  try {
    const created = await resources.custody.createCandidate({ project_id: ids.project, person_id: ids.candidatePerson,
      device_id: ids.candidateDevice, access_scope_id: ids.scope, generation: 0n, signing_key_id: ids.candidateSigning,
      recipient_key_id: ids.candidateRecipient, offline_root_key_id: ids.root, bound_control_head_id: ids.control1 });
    const reopened = await resources.custody.reopenCandidate(ids.project, ids.candidateDevice);
    const exactRetry = await resources.custody.createCandidate({ project_id: ids.project, person_id: ids.candidatePerson,
      device_id: ids.candidateDevice, access_scope_id: ids.scope, generation: 0n, signing_key_id: ids.candidateSigning,
      recipient_key_id: ids.candidateRecipient, offline_root_key_id: ids.root, bound_control_head_id: ids.control1 });
    const invitation = invitationEvidence(ids.invitation);
    const invitationIdentity = await deriveInvitationEvidenceIdentity(invitation);
    const core = parseEnrollmentRequestCore({ schema_version: 1, record_kind: "enrollment_request_core", authority: "none", enrollment_kind: "new_person",
      project_id: ids.project, invitation_id: ids.invitation, invitation_evidence_id: invitationIdentity.id,
      accepted_invitation_control_event_id: ids.control1, candidate_person_id: ids.candidatePerson, existing_membership_id: null,
      proposed_membership_id: ids.candidateMembership, candidate_device_id: ids.candidateDevice, signing_key_id: ids.candidateSigning,
      signing_public_key_bytes: reopened.signing_public_key_bytes, recipient_key_id: ids.candidateRecipient,
      recipient_public_key_bytes: reopened.recipient_public_key_bytes, intended_role: "reviewer", access_scope: "project_wide",
      access_scope_id: ids.scope, bound_control_head_id: ids.control1, request_nonce: new Uint8Array(32).fill(0x61), suite_id: HC2_CRYPTO_SUITE_ID });
    const identity = await deriveEnrollmentRequestIdentity(core);
    const request = parseEnrollmentRequestRecord({ record_version: 1, record_kind: "enrollment_request", authority: "none", request_id: identity.id,
      core, algorithm: "ed25519", signature_bytes: await resources.custody.signPending({ project_id: ids.project, device_id: ids.candidateDevice,
        preimage: buildEnrollmentSignaturePreimage("enrollment_request", ids.project, identity.id) }) });
    const pending = await resources.pending.readPendingVault(ids.project, ids.candidateDevice);
    if (!pending) throw new Error("Candidate pending vault was not reopened from IndexedDB.");
    return toPortable({ absent_before_open: absentBeforeOpen, create_status: created.status, exact_retry_status: exactRetry.status,
      request_signature_verified: await verifyEnrollmentRequestSignature({ request }), request, invitation,
      signing_private_extractable: pending.signing_key_pair.privateKey.extractable,
      recipient_private_extractable: pending.recipient_key_pair.privateKey.extractable,
      kek_extractable: pending.local_kek.extractable,
      candidate_database_names: (await indexedDB.databases()).map((entry) => entry.name).filter(Boolean).sort() });
  } finally { resources.close(); }
}

export async function runOwnerChallenge(databasePrefix: string, candidatePortable: unknown, fixture: Readonly<{ inputs: Slice5VectorInput }>) {
  const isolatedFromCandidate = !(await indexedDB.databases()).some((entry) => entry.name?.startsWith(databasePrefix));
  const candidate = fromPortable(candidatePortable) as { request: unknown; invitation: unknown };
  const request = parseEnrollmentRequestRecord(candidate.request);
  const invitation = parseInvitationEvidenceCore(candidate.invitation);
  if (!(await verifyEnrollmentRequestSignature({ request }))) throw new Error("Owner rejected the candidate Ed25519 request signature.");
  const hpke = new SingleShotHpkeProvider({ keys: new Hc2NativeKeyRegistry(crypto.subtle) });
  const challenge = await createPossessionChallenge({ request, current_control_head_id: ids.control1,
    random: fixedRandom(new Uint8Array(32).fill(0x62)), hpke });
  const store = new Hc2IndexedDbEnrollmentStore({ indexed_db: indexedDB, database_name: `${databasePrefix}-owner-enrollment` });
  await store.open();
  try {
    const invitationStatus = await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: ids.invitation,
      evidence: invitation, status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
    const invitationRetry = await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: ids.invitation,
      evidence: invitation, status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
    const contention = invitationEvidence(ids.contentionInvitation);
    await store.putInvitation({ schema_version: 1, record_kind: "stored_invitation", invitation_id: ids.contentionInvitation,
      evidence: contention, status: "accepted", terminal_control_event_id: null, consumed_transition_id: null });
    const challengeStatus = await store.putChallenge({ schema_version: 1, record_kind: "stored_possession_challenge", project_id: ids.project,
      challenge: challenge.envelope, expected_response_sha256: challenge.expected_response_sha256, status: "pending", consumed_proof_id: null });
    const vector = await createHc2Slice5VectorActual(fixture.inputs);
    return toPortable({ isolated_from_candidate_profile: isolatedFromCandidate, invitation_status: invitationStatus,
      invitation_retry_status: invitationRetry, challenge_status: challengeStatus, challenge: challenge.envelope,
      expected_response_sha256: challenge.expected_response_sha256, vector });
  } finally { store.close(); }
}

export async function runOwnerContention(databasePrefix: string, contender: "first" | "second") {
  const store = new Hc2IndexedDbEnrollmentStore({ indexed_db: indexedDB, database_name: `${databasePrefix}-owner-enrollment` }); await store.open();
  try {
    await store.consumeInvitation(ids.project, ids.contentionInvitation, "accepted", ids.control2,
      digest("membership-transition", contender === "first" ? "d" : "e"));
    return { outcome: "accepted", contender };
  } catch { return { outcome: "rejected", contender }; }
  finally { store.close(); }
}

export async function runCandidateProof(databasePrefix: string, candidatePortable: unknown, ownerPortable: unknown) {
  const candidate = fromPortable(candidatePortable) as { request: unknown };
  const owner = fromPortable(ownerPortable) as { challenge: unknown; expected_response_sha256: Uint8Array };
  const request = parseEnrollmentRequestRecord(candidate.request);
  const challenge = parsePossessionChallengeEnvelope(owner.challenge);
  const resources = await candidateResources(databasePrefix);
  try {
    await resources.custody.reopenCandidate(ids.project, ids.candidateDevice);
    const proof = await buildPossessionResponse({ envelope: challenge, request,
      open: (value) => resources.custody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }),
      sign: (preimage) => resources.custody.signPending({ project_id: ids.project, device_id: ids.candidateDevice, preimage }) });
    return toPortable({ proof, proof_verified: await verifyPossessionProof({ proof, request, challenge,
      expected_response_sha256: owner.expected_response_sha256, current_control_head_id: ids.control1 }) });
  } finally { resources.close(); }
}

export async function runOwnerFinalize(databasePrefix: string, candidatePortable: unknown, ownerPortable: unknown, proofPortable: unknown) {
  const candidate = fromPortable(candidatePortable) as { request: unknown };
  const owner = fromPortable(ownerPortable) as { challenge: unknown; expected_response_sha256: Uint8Array };
  const proofValue = fromPortable(proofPortable) as { proof: unknown };
  const request = parseEnrollmentRequestRecord(candidate.request); const challenge = parsePossessionChallengeEnvelope(owner.challenge);
  const proof = parsePossessionProofRecord(proofValue.proof);
  const verified = await verifyPossessionProof({ proof, request, challenge, expected_response_sha256: owner.expected_response_sha256,
    current_control_head_id: ids.control1 });
  if (!verified) throw new Error("Owner rejected candidate possession proof.");
  const store = new Hc2IndexedDbEnrollmentStore({ indexed_db: indexedDB, database_name: `${databasePrefix}-owner-enrollment` }); await store.open();
  try {
    await store.consumeChallenge(ids.project, challenge.challenge_id, proof.proof_id, ids.control1);
    let secondChallengeRejected = false;
    try { await store.consumeChallenge(ids.project, challenge.challenge_id, digest("possession-proof", "a"), ids.control2); }
    catch { secondChallengeRejected = true; }
    await store.consumeInvitation(ids.project, ids.invitation, "accepted", ids.control2, ids.transition);
    let invitationReuseRejected = false;
    try { await store.consumeInvitation(ids.project, ids.invitation, "accepted", ids.control2, digest("membership-transition", "b")); }
    catch { invitationReuseRejected = true; }
    const commitment = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch2, epoch_secret: new Uint8Array(32).fill(0x63) });
    const envelope = await createEpochDeliveryEnvelope({ header_core: parseEpochDeliveryHeaderCore({ schema_version: 1,
      record_kind: "epoch_delivery_header_core", authority: "none", project_id: ids.project, transition_id: ids.transition,
      accepted_control_event_id: ids.control2, delivery_set_id: ids.deliverySet, recipient_manifest_id: ids.manifest,
      key_epoch_id: ids.epoch2, key_epoch_commitment: commitment.key_epoch_commitment, recipient_membership_id: ids.candidateMembership,
      recipient_person_id: ids.candidatePerson, recipient_device_id: ids.candidateDevice, recipient_key_id: ids.candidateRecipient,
      recipient_ordinal: 0n, recipient_count: 1n, suite_id: HC2_CRYPTO_SUITE_ID }),
      recipient_public_key_bytes: request.core.recipient_public_key_bytes, public_commitment_bytes: commitment.public_commitment_bytes,
      epoch_secret: new Uint8Array(32).fill(0x63), hpke: new SingleShotHpkeProvider({ keys: new Hc2NativeKeyRegistry(crypto.subtle) }) });
    const ownerPair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    const ownerRecipient = await exportAndEncodePublicKey({ subtle: crypto.subtle, algorithm: "x25519", key_id: ids.ownerRecipient, public_key: ownerPair.publicKey });
    const replacement = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch3, epoch_secret: new Uint8Array(32).fill(0x64) });
    const revocationEnvelope = await createEpochDeliveryEnvelope({ header_core: parseEpochDeliveryHeaderCore({ schema_version: 1,
      record_kind: "epoch_delivery_header_core", authority: "none", project_id: ids.project, transition_id: digest("membership-transition", "f"),
      accepted_control_event_id: digest("control-event", "g"), delivery_set_id: digest("delivery-set", "h"),
      recipient_manifest_id: digest("recipient-manifest", "j"), key_epoch_id: ids.epoch3, key_epoch_commitment: replacement.key_epoch_commitment,
      recipient_membership_id: ids.ownerMembership, recipient_person_id: ids.ownerPerson, recipient_device_id: ids.ownerDevice,
      recipient_key_id: ids.ownerRecipient, recipient_ordinal: 0n, recipient_count: 1n, suite_id: HC2_CRYPTO_SUITE_ID }),
      recipient_public_key_bytes: ownerRecipient, public_commitment_bytes: replacement.public_commitment_bytes,
      epoch_secret: new Uint8Array(32).fill(0x64), hpke: new SingleShotHpkeProvider({ keys: new Hc2NativeKeyRegistry(crypto.subtle) }) });
    return toPortable({ proof_verified: verified, second_challenge_rejected: secondChallengeRejected,
      invitation_reuse_rejected: invitationReuseRejected, envelope, public_commitment_bytes: commitment.public_commitment_bytes,
      revocation_envelope: revocationEnvelope });
  } finally { store.close(); }
}

export async function runCandidateOpen(databasePrefix: string, deliveryPortable: unknown) {
  const owner = fromPortable(deliveryPortable) as { envelope: unknown; public_commitment_bytes: Uint8Array; revocation_envelope: unknown };
  const resources = await candidateResources(databasePrefix); const envelope = owner.envelope as Parameters<typeof openEpochDelivery>[0]["envelope"];
  try {
    let openedSecret: Uint8Array | null = null;
    await openEpochDelivery({ envelope, expected_project_id: ids.project, expected_device_id: ids.candidateDevice,
      open: (value) => resources.custody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }),
      async use(plaintext) {
        openedSecret = Uint8Array.from(plaintext.epoch_secret);
        await resources.custody.installDeliveredEpoch({ project_id: ids.project, device_id: ids.candidateDevice,
          accepted_control_event_id: ids.control2, key_epoch_id: ids.epoch2, key_epoch_commitment: envelope.header_core.key_epoch_commitment,
          public_commitment_bytes: plaintext.public_commitment_bytes, epoch_secret: Uint8Array.from(plaintext.epoch_secret),
          admission_plan_sha256: new Uint8Array(32).fill(0x65), ceremony_id: "slice5-browser-admission" });
      } });
    if (!openedSecret || !openedSecret.every((byte) => byte === 0x63)) throw new Error("Candidate did not open the accepted replacement epoch.");
    const loaded = await resources.custody.loadInstalled({ project_id: ids.project, person_id: ids.candidatePerson, device_id: ids.candidateDevice,
      access_scope_id: ids.scope, signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
      accepted_control_head_id: ids.control2, offline_root_key_id: ids.root, key_epoch_id: ids.epoch2,
      key_epoch_commitment: envelope.header_core.key_epoch_commitment, device_status: "active" });
    let revokedOpenRejected = false;
    try { await openEpochDelivery({ envelope: owner.revocation_envelope, expected_project_id: ids.project, expected_device_id: ids.candidateDevice,
      open: (value) => resources.custody.openPendingEnvelope({ project_id: ids.project, device_id: ids.candidateDevice, ...value }), use() {} }); }
    catch { revokedOpenRejected = true; }
    await resources.custody.finalizeAdmission({ project_id: ids.project, device_id: ids.candidateDevice, accepted_control_event_id: ids.control2,
      key_epoch_id: ids.epoch2, key_epoch_commitment: envelope.header_core.key_epoch_commitment, ceremony_id: "slice5-browser-admission",
      admission_package_id: ids.admission, receipt_id: digest("epoch-receipt", "c") });
    resources.close();
    const reopened = await candidateResources(databasePrefix);
    try {
      const reopenedLoaded = await reopened.custody.loadInstalled({ project_id: ids.project, person_id: ids.candidatePerson, device_id: ids.candidateDevice,
        access_scope_id: ids.scope, signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
        accepted_control_head_id: ids.control2, offline_root_key_id: ids.root, key_epoch_id: ids.epoch2,
        key_epoch_commitment: envelope.header_core.key_epoch_commitment, device_status: "active" });
      const marker = await reopened.pending.readCompletionMarker(ids.project, ids.candidateDevice);
      return { opened_epoch_bytes: openedSecret.length, epoch_commitment_match: loaded.public_binding.current_epoch_commitment === envelope.header_core.key_epoch_commitment,
        completion_written_after_open: marker?.completion === "epoch_installed_and_acknowledged", installed_vault_reopened: reopenedLoaded.public_binding.device_id === ids.candidateDevice,
        revoked_replacement_open_rejected: revokedOpenRejected, pending_vault_removed_after_completion: (await reopened.pending.readPendingVault(ids.project, ids.candidateDevice)) === null };
    } finally { reopened.close(); }
  } finally { resources.close(); }
}

async function candidateResources(prefix: string) {
  const pending = new Hc2IndexedDbEnrollmentCandidateStore({ indexed_db: indexedDB, database_name: `${prefix}-candidate-pending` }); await pending.open();
  const final = new Hc2IndexedDbCustodyStore({ indexed_db: indexedDB, database_name: `${prefix}-candidate-custody` });
  if ((await final.open()).status !== "opened") throw new Error("Candidate custody database failed to open.");
  const custody = new Hc2EnrollmentCustodyService({ pending_store: pending, custody_store: final, random: new WebCryptoRandomSource() });
  return { pending, final, custody, close() { pending.close(); final.close(); } };
}

function invitationEvidence(invitationId: string) { return parseInvitationEvidenceCore({ schema_version: 1, record_kind: "invitation_evidence_core", authority: "none",
  project_id: ids.project, invitation_id: invitationId, inviting_membership_id: ids.ownerMembership, inviting_person_id: ids.ownerPerson,
  inviting_device_id: ids.ownerDevice, intended_role: "reviewer", access_scope: "project_wide", access_scope_id: ids.scope,
  creation_control_head_id: ids.control1, creation_control_sequence: 1n, valid_through_control_sequence: 9n,
  accepted_invitation_action_id: digest("control-action", "d"), accepted_invitation_control_event_id: ids.control1,
  status: "accepted", suite_id: HC2_CRYPTO_SUITE_ID }); }
function fixedRandom(value: Uint8Array) { let used = false; return { async randomBytes(length: number) { if (used || length !== value.length) throw new Error("Fixed browser random was reused."); used = true; return Uint8Array.from(value); } }; }
function toPortable(value: unknown): unknown { if (typeof value === "bigint") return { __bigint: value.toString() }; if (value instanceof Uint8Array) return { __bytes_hex: toHex(value) }; if (Array.isArray(value)) return value.map(toPortable); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPortable(child)])); return value; }
function fromPortable(value: unknown): unknown { if (Array.isArray(value)) return value.map(fromPortable); if (value && typeof value === "object") { const record = value as Record<string, unknown>; if (typeof record.__bytes_hex === "string") return fromHex(record.__bytes_hex); if (typeof record.__bigint === "string") return BigInt(record.__bigint); return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, fromPortable(child)])); } return value; }
function toHex(value: Uint8Array) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string) { return Uint8Array.from(value.match(/../g)?.map((entry) => Number.parseInt(entry, 16)) ?? []); }
function entity(kind: string, char: string) { return `pm:${kind}:v1:${char.repeat(25)}a`; }
function digest(kind: string, char: string) { return `pm:${kind}:v1:${char.repeat(51)}a`; }

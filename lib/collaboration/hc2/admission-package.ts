import { encodeCanonicalCbor } from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import {
  parseAdmissionBoundary,
  parseProjectionSnapshotRecord,
  type AdmissionBoundary,
  type ProjectionSnapshotRecord
} from "../checkpoints.ts";
import type { FullHistoryCheckpointVerificationResult } from "../checkpoint-verification.ts";
import {
  parseDigestId,
  type CheckpointId,
  type DocumentRevisionId,
  type SemanticEventId
} from "../identities.ts";
import { deriveProjectionSnapshotIdentity } from "../preimages.ts";
import { sha256 } from "../sha256.ts";
import {
  deriveCanonicalStateBlobIdentity,
  parseCanonicalStateBlobRecord,
  type CanonicalStateBlobRecord
} from "../state-snapshots.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveAdmissionPackageIdentity,
  parseAcceptedMembershipState,
  parseAdmissionPackageCore,
  parseAdmissionPackageRecord,
  parseEpochDeliveryEnvelope,
  parseMembershipTransitionCore,
  type AcceptedMembershipState,
  type AdmissionPackageRecord,
  type EpochDeliveryEnvelope,
  type MembershipTransitionCore
} from "./enrollment-contracts.ts";
import { importEncodedPublicKey } from "./providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_PROJECT_WIDE_ACCESS_SCOPE } from "./versions.ts";

export type AdmissionPackageEvidence = Readonly<{
  checkpoint_verification: Extract<FullHistoryCheckpointVerificationResult, { status: "full_history_verified" }>;
  state_blob: CanonicalStateBlobRecord;
  snapshot: ProjectionSnapshotRecord;
  admission_boundary: AdmissionBoundary;
  semantic_frontier: readonly SemanticEventId[];
  revision_manifest: readonly DocumentRevisionId[];
  conflict_manifest: readonly string[];
}>;

export async function createAdmissionPackage(input: Readonly<{
  transition: MembershipTransitionCore;
  accepted_state: AcceptedMembershipState;
  accepted_control_action_id: AdmissionPackageRecord["core"]["accepted_control_action_id"];
  recipient_delivery: EpochDeliveryEnvelope;
  evidence: AdmissionPackageEvidence;
  owner_signing_key_id: AdmissionPackageRecord["core"]["owner_signing_key_id"];
  sign: (preimage: ReturnType<typeof buildEnrollmentSignaturePreimage>) => Promise<Uint8Array>;
}>): Promise<AdmissionPackageRecord> {
  const transition = parseMembershipTransitionCore(input.transition); const state = parseAcceptedMembershipState(input.accepted_state); const delivery = parseEpochDeliveryEnvelope(input.recipient_delivery);
  if (state.control_head_id !== delivery.header_core.accepted_control_event_id || state.control_head_id === transition.previous_control_head_id || state.current_epoch_id !== transition.replacement_epoch_id || state.current_epoch_commitment !== transition.replacement_epoch_commitment) throw new Error("Admission package requires the accepted post-transition authority state.");
  const targetDevice = required(transition.device_id, "Admission requires an enrolled device."); const membership = state.memberships.find((entry) => entry.membership_id === transition.membership_id); const device = state.devices.find((entry) => entry.device_id === targetDevice);
  if (!membership || membership.status !== "active" || !device || device.status !== "active" || device.membership_id !== membership.membership_id || delivery.header_core.recipient_device_id !== device.device_id || delivery.header_core.recipient_key_id !== device.recipient_key_id) throw new Error("Admission target does not match accepted membership and delivery authority.");
  const verified = await verifyEvidence(input.evidence, state.control_head_id, transition, device.device_id);
  const core = parseAdmissionPackageCore({ schema_version: 1, record_kind: "current_state_admission_package_core", authority: "none", project_id: state.project_id, transition_id: delivery.header_core.transition_id, accepted_control_action_id: input.accepted_control_action_id, accepted_control_event_id: state.control_head_id, resulting_control_state_root: transition.resulting_control_state_root, admitted_membership_id: membership.membership_id, admitted_person_id: membership.person_id, admitted_device_id: device.device_id, admitted_role: membership.role, access_scope: HC2_PROJECT_WIDE_ACCESS_SCOPE, signing_key_id: device.signing_key_id, recipient_key_id: device.recipient_key_id, key_epoch_id: state.current_epoch_id, key_epoch_commitment: state.current_epoch_commitment, recipient_manifest_id: transition.recipient_manifest_id, delivery_set_id: transition.delivery_set_id, recipient_delivery_id: delivery.delivery_id, checkpoint_id: verified.checkpoint_id, projection_root: verified.state_blob.core.projection_root, semantic_state_root: verified.state_blob.core.semantic_state_root, revision_heads_root: verified.state_blob.core.revision_heads_root, conflict_set_root: verified.state_blob.core.conflict_set_root, accepted_history_root: verified.accepted_history_root, state_blob_id: verified.state_blob.state_blob_id, snapshot_id: verified.snapshot.snapshot_id, semantic_frontier: input.evidence.semantic_frontier, revision_manifest: input.evidence.revision_manifest, conflict_manifest: input.evidence.conflict_manifest, reducer_version: verified.state_blob.core.reducer_version, admission_boundary_sha256: verified.boundary_sha256, owner_signing_key_id: input.owner_signing_key_id, full_history_verified: false, suite_id: HC2_CRYPTO_SUITE_ID });
  const identity = await deriveAdmissionPackageIdentity(core); const signature = await input.sign(buildEnrollmentSignaturePreimage("admission_package", core.project_id, identity.id));
  return parseAdmissionPackageRecord({ record_version: 1, record_kind: "current_state_admission_package", authority: "none", admission_package_id: identity.id, core, owner_signature_bytes: signature });
}

export async function verifyAdmissionPackage(input: Readonly<{
  package: AdmissionPackageRecord;
  accepted_state: AcceptedMembershipState;
  transition: MembershipTransitionCore;
  recipient_delivery: EpochDeliveryEnvelope;
  evidence: AdmissionPackageEvidence;
  subtle?: SubtleCrypto;
}>): Promise<Readonly<{ status: "verified"; full_history_verified: false; boundary: AdmissionBoundary }> | Readonly<{ status: "rejected"; reason: string }>> {
  try {
    const record = parseAdmissionPackageRecord(input.package); const state = parseAcceptedMembershipState(input.accepted_state); const transition = parseMembershipTransitionCore(input.transition); const delivery = parseEpochDeliveryEnvelope(input.recipient_delivery);
    const identity = await deriveAdmissionPackageIdentity(record.core); if (identity.id !== record.admission_package_id) throw new Error("Admission package identity mismatch.");
    if (record.core.project_id !== state.project_id || record.core.accepted_control_event_id !== state.control_head_id || record.core.resulting_control_state_root !== transition.resulting_control_state_root || record.core.key_epoch_id !== state.current_epoch_id || record.core.key_epoch_commitment !== state.current_epoch_commitment || record.core.recipient_delivery_id !== delivery.delivery_id || record.core.delivery_set_id !== transition.delivery_set_id || record.core.recipient_manifest_id !== transition.recipient_manifest_id || record.core.full_history_verified !== false) throw new Error("Admission package authority, epoch, or delivery binding is invalid.");
    const ownerDevice = state.devices.find((entry) => entry.signing_key_id === record.core.owner_signing_key_id && entry.status === "active"); const ownerMembership = ownerDevice ? state.memberships.find((entry) => entry.membership_id === ownerDevice.membership_id) : null;
    if (!ownerDevice || !ownerMembership || ownerMembership.status !== "active" || ownerMembership.role !== "owner") throw new Error("Admission package signer is not an accepted owner.");
    const imported = await importEncodedPublicKey({ subtle: input.subtle ?? requireSubtle(), encoded: ownerDevice.signing_public_key_bytes, expected_algorithm: "ed25519" });
    if (!(await (input.subtle ?? requireSubtle()).verify("Ed25519", imported.public_key, asArrayBuffer(record.owner_signature_bytes), asArrayBuffer(buildEnrollmentSignaturePreimage("admission_package", record.core.project_id, record.admission_package_id))))) throw new Error("Admission package owner signature is invalid.");
    const evidence = await verifyEvidence(input.evidence, state.control_head_id, transition, record.core.admitted_device_id);
    if (record.core.checkpoint_id !== evidence.checkpoint_id || record.core.state_blob_id !== evidence.state_blob.state_blob_id || record.core.snapshot_id !== evidence.snapshot.snapshot_id || record.core.projection_root !== evidence.state_blob.core.projection_root || record.core.semantic_state_root !== evidence.state_blob.core.semantic_state_root || record.core.revision_heads_root !== evidence.state_blob.core.revision_heads_root || record.core.conflict_set_root !== evidence.state_blob.core.conflict_set_root || record.core.accepted_history_root !== evidence.accepted_history_root || record.core.reducer_version !== evidence.state_blob.core.reducer_version || !sameBytes(record.core.admission_boundary_sha256, evidence.boundary_sha256) || !sameStrings(record.core.semantic_frontier, input.evidence.semantic_frontier) || !sameStrings(record.core.revision_manifest, input.evidence.revision_manifest) || !sameStrings(record.core.conflict_manifest, input.evidence.conflict_manifest)) throw new Error("Admission package current-state evidence is incomplete or substituted.");
    return Object.freeze({ status: "verified" as const, full_history_verified: false as const, boundary: evidence.boundary });
  } catch (error) { return Object.freeze({ status: "rejected" as const, reason: error instanceof Error ? error.message : "admission_package_rejected" }); }
}

async function verifyEvidence(evidence: AdmissionPackageEvidence, controlHead: AdmissionPackageRecord["core"]["accepted_control_event_id"], transition: MembershipTransitionCore, deviceId: AdmissionPackageRecord["core"]["admitted_device_id"]) {
  if (evidence.checkpoint_verification.status !== "full_history_verified") throw new Error("Admission creation requires a full-history-verified owner checkpoint.");
  const checkpointId = evidence.checkpoint_verification.checkpoint_id; const stateBlob = parseCanonicalStateBlobRecord(evidence.state_blob); const snapshot = parseProjectionSnapshotRecord(evidence.snapshot, checkpointId); const boundary = parseAdmissionBoundary(evidence.admission_boundary, { checkpoint_id: checkpointId, snapshot_id: snapshot.snapshot_id });
  const [stateIdentity, snapshotIdentity] = await Promise.all([deriveCanonicalStateBlobIdentity(stateBlob.core), deriveProjectionSnapshotIdentity(snapshot.core)]);
  if (stateIdentity.id !== stateBlob.state_blob_id || snapshotIdentity.id !== snapshot.snapshot_id || stateBlob.core.checkpoint_id !== checkpointId || snapshot.core.checkpoint_id !== checkpointId || snapshot.core.state_blob_id !== stateBlob.state_blob_id || snapshot.core.projection_root !== stateBlob.core.projection_root || snapshot.core.semantic_state_root !== stateBlob.core.semantic_state_root || snapshot.core.revision_heads_root !== stateBlob.core.revision_heads_root || snapshot.core.conflict_set_root !== stateBlob.core.conflict_set_root || stateBlob.core.control_head_id !== controlHead || boundary.project_id !== transition.project_id || boundary.admitted_membership_id !== transition.membership_id || boundary.admitted_person_id !== transition.person_id || boundary.admitted_device_id !== deviceId || boundary.owner_authorized_control_event_id !== controlHead || boundary.admission_key_epoch_id !== transition.replacement_epoch_id) throw new Error("HC-1 admission checkpoint, state blob, snapshot, or boundary binding is invalid.");
  const acceptedHistoryRoot = parseDigestId("accepted-history-root", boundary.sealed_prior_history.accepted_history_root); const boundarySha256 = Uint8Array.from(await sha256(encodeCanonicalCbor(canonicalProtocolValue(boundary))));
  return Object.freeze({ checkpoint_id: checkpointId as CheckpointId, state_blob: stateBlob, snapshot, boundary, boundary_sha256: boundarySha256, accepted_history_root: acceptedHistoryRoot });
}

function required<T>(value: T | null, message: string): T { if (value === null) throw new Error(message); return value; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((entry, index) => entry === right[index]); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function asArrayBuffer(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
function requireSubtle(): SubtleCrypto { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable."); return globalThis.crypto.subtle; }

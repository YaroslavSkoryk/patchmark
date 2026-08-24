import {
  canonicalArray,
  canonicalText,
  encodeCanonicalCbor
} from "../canonical-cbor.ts";
import { canonicalProtocolValue } from "../canonical-protocol.ts";
import type { CollaborationRole } from "../capabilities.ts";
import { collaborationRoles } from "../capabilities.ts";
import {
  parseDigestId,
  parseEntityId,
  type AccessScopeId,
  type AcceptedHistoryRootId,
  type AcknowledgementId,
  type CheckpointId,
  type ConflictSetRootId,
  type ControlActionId,
  type ControlEventId,
  type ControlStateRootId,
  type DeviceId,
  type DocumentRevisionId,
  type InvitationId,
  type KeyEpochCommitmentId,
  type KeyEpochId,
  type MembershipId,
  type PersonId,
  type ProjectId,
  type ProjectionRootId,
  type PublicKeyId,
  type RevisionHeadsRootId,
  type SemanticEventId,
  type SemanticStateRootId,
  type SnapshotId,
  type StateBlobId
} from "../identities.ts";
import { sha256 } from "../sha256.ts";
import {
  expectBytes,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectUInt64,
  freezeRecord,
  type UInt64
} from "../validation.ts";
import type {
  AlgorithmTaggedPublicKeyBytes,
  SenderSignaturePreimageBytes
} from "./crypto-contracts.ts";
import { parseHc2CryptoSuiteId } from "./crypto-contracts.ts";
import { parsePublicEnvelopeHeader, type PublicEnvelopeHeader } from "./envelope.ts";
import {
  deriveHc2Identity,
  parseHc2DigestId,
  type AdmissionPackageId,
  type DeliverySetId,
  type EnrollmentBatchId,
  type EnrollmentRequestId,
  type EpochDeliveryId,
  type EpochReceiptId,
  type InvitationEvidenceId,
  type MembershipTransitionId,
  type PossessionChallengeId,
  type PossessionProofId,
  type RecipientManifestId
} from "./identities.ts";
import { hc2ProtocolLimits } from "./limits.ts";
import { decodeAlgorithmTaggedPublicKey } from "./providers/public-key-codec.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_ENROLLMENT_SCHEMA_VERSION,
  HC2_PROJECT_WIDE_ACCESS_SCOPE,
  hc2SignatureDomains
} from "./versions.ts";

declare const enrollmentPreimageBrand: unique symbol;

export type Hc2EnrollmentSignaturePreimage = SenderSignaturePreimageBytes & {
  readonly [enrollmentPreimageBrand]: "hc2-enrollment-signature-preimage";
};

export type Hc2ProjectWideScope = typeof HC2_PROJECT_WIDE_ACCESS_SCOPE;
export type EnrollmentKind = "new_person" | "additional_device";
export type MembershipMutationKind =
  | "new_membership"
  | "additional_device"
  | "role_change"
  | "device_revocation"
  | "membership_revocation";

export type InvitationEvidenceCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "invitation_evidence_core";
  authority: "none";
  project_id: ProjectId;
  invitation_id: InvitationId;
  inviting_membership_id: MembershipId;
  inviting_person_id: PersonId;
  inviting_device_id: DeviceId;
  intended_role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  access_scope_id: AccessScopeId;
  creation_control_head_id: ControlEventId;
  creation_control_sequence: UInt64;
  valid_through_control_sequence: UInt64;
  accepted_invitation_action_id: ControlActionId;
  accepted_invitation_control_event_id: ControlEventId;
  status: "accepted";
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type InvitationHandoffCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "invitation_handoff_core";
  authority: "none";
  project_id: ProjectId;
  invitation_id: InvitationId;
  invitation_evidence_id: InvitationEvidenceId;
  accepted_invitation_control_event_id: ControlEventId;
  intended_role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type EnrollmentRequestCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "enrollment_request_core";
  authority: "none";
  enrollment_kind: EnrollmentKind;
  project_id: ProjectId;
  invitation_id: InvitationId;
  invitation_evidence_id: InvitationEvidenceId;
  accepted_invitation_control_event_id: ControlEventId;
  candidate_person_id: PersonId;
  existing_membership_id: MembershipId | null;
  proposed_membership_id: MembershipId;
  candidate_device_id: DeviceId;
  signing_key_id: PublicKeyId;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  intended_role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  access_scope_id: AccessScopeId;
  bound_control_head_id: ControlEventId;
  request_nonce: Uint8Array;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type EnrollmentRequestRecord = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "enrollment_request";
  authority: "none";
  request_id: EnrollmentRequestId;
  core: EnrollmentRequestCore;
  algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export type PossessionChallengeHeaderCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "possession_challenge_header_core";
  authority: "none";
  project_id: ProjectId;
  invitation_id: InvitationId;
  request_id: EnrollmentRequestId;
  candidate_person_id: PersonId;
  candidate_device_id: DeviceId;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  signing_public_key_sha256: Uint8Array;
  recipient_public_key_sha256: Uint8Array;
  challenge_commitment: Uint8Array;
  bound_control_head_id: ControlEventId;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type PossessionChallengeEnvelope = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "possession_challenge_envelope";
  authority: "none";
  challenge_id: PossessionChallengeId;
  header_core: PossessionChallengeHeaderCore;
  public_header: PublicEnvelopeHeader;
  ciphertext_bytes: Uint8Array;
}>;

export type PossessionResponseCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "possession_response_core";
  authority: "none";
  project_id: ProjectId;
  invitation_id: InvitationId;
  request_id: EnrollmentRequestId;
  challenge_id: PossessionChallengeId;
  challenge_commitment: Uint8Array;
  challenge_response: Uint8Array;
  candidate_person_id: PersonId;
  candidate_device_id: DeviceId;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  bound_control_head_id: ControlEventId;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type PossessionProofRecord = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "possession_proof";
  authority: "none";
  proof_id: PossessionProofId;
  core: PossessionResponseCore;
  algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export type MembershipFact = Readonly<{
  membership_id: MembershipId;
  person_id: PersonId;
  role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  access_scope_id: AccessScopeId;
  status: "active" | "revoked";
}>;

export type MembershipDeviceFact = Readonly<{
  membership_id: MembershipId;
  person_id: PersonId;
  device_id: DeviceId;
  signing_key_id: PublicKeyId;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
  status: "active" | "revoked";
  maximum_accepted_semantic_sequence: UInt64 | null;
}>;

export type AcceptedMembershipState = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "accepted_membership_state";
  project_id: ProjectId;
  owner_person_id: PersonId;
  control_head_id: ControlEventId;
  control_sequence: UInt64;
  root_sequence: UInt64;
  merge_policy: "manual" | "auto_safe";
  active_control_device_id: DeviceId;
  offline_root_key_id: PublicKeyId;
  current_epoch_id: KeyEpochId;
  current_epoch_commitment: KeyEpochCommitmentId;
  memberships: readonly MembershipFact[];
  devices: readonly MembershipDeviceFact[];
  consumed_invitation_ids: readonly InvitationId[];
  cancelled_invitation_ids: readonly InvitationId[];
}>;

export type RecipientManifestEntry = Readonly<{
  membership_id: MembershipId;
  person_id: PersonId;
  device_id: DeviceId;
  role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes;
}>;

export type RecipientManifestCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_recipient_manifest_core";
  authority: "none";
  project_id: ProjectId;
  previous_control_head_id: ControlEventId;
  mutation_kind: MembershipMutationKind;
  replacement_epoch_id: KeyEpochId;
  replacement_epoch_commitment: KeyEpochCommitmentId;
  recipients: readonly RecipientManifestEntry[];
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type DeliverySetCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_set_core";
  authority: "none";
  project_id: ProjectId;
  previous_control_head_id: ControlEventId;
  recipient_manifest_id: RecipientManifestId;
  replacement_epoch_id: KeyEpochId;
  replacement_epoch_commitment: KeyEpochCommitmentId;
  recipient_device_ids: readonly DeviceId[];
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type MembershipTransitionCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "membership_epoch_transition_core";
  authority: "none";
  project_id: ProjectId;
  mutation_kind: MembershipMutationKind;
  previous_control_head_id: ControlEventId;
  expected_control_sequence: UInt64;
  authorizing_owner_membership_id: MembershipId;
  authorizing_owner_person_id: PersonId;
  authorizing_owner_device_id: DeviceId;
  invitation_evidence_id: InvitationEvidenceId | null;
  enrollment_request_id: EnrollmentRequestId | null;
  possession_proof_id: PossessionProofId | null;
  membership_id: MembershipId;
  person_id: PersonId;
  role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  access_scope_id: AccessScopeId;
  device_id: DeviceId | null;
  signing_key_id: PublicKeyId | null;
  recipient_key_id: PublicKeyId | null;
  signing_public_key_bytes: AlgorithmTaggedPublicKeyBytes | null;
  recipient_public_key_bytes: AlgorithmTaggedPublicKeyBytes | null;
  revoked_device_ids: readonly DeviceId[];
  revocation_cutoffs: readonly Readonly<{
    device_id: DeviceId;
    maximum_accepted_semantic_sequence: UInt64;
  }>[];
  previous_active_control_device_id: DeviceId;
  replacement_active_control_device_id: DeviceId;
  previous_epoch_id: KeyEpochId;
  replacement_epoch_id: KeyEpochId;
  replacement_epoch_commitment: KeyEpochCommitmentId;
  recipient_manifest_id: RecipientManifestId;
  delivery_set_id: DeliverySetId;
  resulting_control_state_root: ControlStateRootId;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type EpochDeliveryHeaderCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_header_core";
  authority: "none";
  project_id: ProjectId;
  transition_id: MembershipTransitionId;
  accepted_control_event_id: ControlEventId;
  delivery_set_id: DeliverySetId;
  recipient_manifest_id: RecipientManifestId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  recipient_membership_id: MembershipId;
  recipient_person_id: PersonId;
  recipient_device_id: DeviceId;
  recipient_key_id: PublicKeyId;
  recipient_ordinal: UInt64;
  recipient_count: UInt64;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type EpochDeliveryEnvelope = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_envelope";
  authority: "none";
  delivery_id: EpochDeliveryId;
  header_core: EpochDeliveryHeaderCore;
  public_header: PublicEnvelopeHeader;
  ciphertext_bytes: Uint8Array;
}>;

export type EpochDeliveryPlaintext = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_plaintext";
  project_id: ProjectId;
  accepted_control_event_id: ControlEventId;
  delivery_set_id: DeliverySetId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  public_commitment_bytes: Uint8Array;
  epoch_secret: Uint8Array;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type AdmissionPackageCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "current_state_admission_package_core";
  authority: "none";
  project_id: ProjectId;
  transition_id: MembershipTransitionId;
  accepted_control_action_id: ControlActionId;
  accepted_control_event_id: ControlEventId;
  resulting_control_state_root: ControlStateRootId;
  admitted_membership_id: MembershipId;
  admitted_person_id: PersonId;
  admitted_device_id: DeviceId;
  admitted_role: CollaborationRole;
  access_scope: Hc2ProjectWideScope;
  signing_key_id: PublicKeyId;
  recipient_key_id: PublicKeyId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  recipient_manifest_id: RecipientManifestId;
  delivery_set_id: DeliverySetId;
  recipient_delivery_id: EpochDeliveryId;
  checkpoint_id: CheckpointId;
  projection_root: ProjectionRootId;
  semantic_state_root: SemanticStateRootId;
  revision_heads_root: RevisionHeadsRootId;
  conflict_set_root: ConflictSetRootId;
  accepted_history_root: AcceptedHistoryRootId;
  state_blob_id: StateBlobId;
  snapshot_id: SnapshotId;
  semantic_frontier: readonly SemanticEventId[];
  revision_manifest: readonly DocumentRevisionId[];
  conflict_manifest: readonly string[];
  reducer_version: string;
  admission_boundary_sha256: Uint8Array;
  owner_signing_key_id: PublicKeyId;
  full_history_verified: false;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type AdmissionPackageRecord = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "current_state_admission_package";
  authority: "none";
  admission_package_id: AdmissionPackageId;
  core: AdmissionPackageCore;
  owner_signature_bytes: Uint8Array;
}>;

export type EpochReceiptCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_receipt_core";
  authority: "none";
  project_id: ProjectId;
  person_id: PersonId;
  membership_id: MembershipId;
  role: CollaborationRole;
  device_id: DeviceId;
  signing_key_id: PublicKeyId;
  acknowledgement_sequence: UInt64;
  previous_acknowledgement_id: AcknowledgementId | null;
  accepted_control_event_id: ControlEventId;
  key_epoch_id: KeyEpochId;
  key_epoch_commitment: KeyEpochCommitmentId;
  delivery_id: EpochDeliveryId;
  checkpoint_id: CheckpointId;
  projection_root: ProjectionRootId;
  admission_package_id: AdmissionPackageId;
  admission_boundary_sha256: Uint8Array;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export type EpochReceiptRecord = Readonly<{
  record_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "epoch_delivery_receipt";
  authority: "none";
  receipt_id: EpochReceiptId;
  core: EpochReceiptCore;
  algorithm: "ed25519";
  signature_bytes: Uint8Array;
}>;

export type EnrollmentBatchMarker = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "enrollment_batch_marker";
  authority: "none";
  batch_id: EnrollmentBatchId;
  project_id: ProjectId;
  transition_id: MembershipTransitionId;
  accepted_control_event_id: ControlEventId;
  recipient_manifest_id: RecipientManifestId;
  delivery_set_id: DeliverySetId;
  required_delivery_ids: readonly EpochDeliveryId[];
  completion: "complete_delivery_set";
}>;

export type EnrollmentCeremonyPlanCore = Readonly<{
  schema_version: typeof HC2_ENROLLMENT_SCHEMA_VERSION;
  record_kind: "enrollment_ceremony_plan_core";
  project_id: ProjectId;
  mutation_kind: MembershipMutationKind;
  previous_control_head_id: ControlEventId;
  expected_control_sequence: UInt64;
  invitation_evidence_id: InvitationEvidenceId | null;
  enrollment_request_id: EnrollmentRequestId | null;
  possession_proof_id: PossessionProofId | null;
  membership_id: MembershipId;
  person_id: PersonId;
  device_id: DeviceId | null;
  previous_epoch_id: KeyEpochId;
  replacement_epoch_id: KeyEpochId;
  suite_id: typeof HC2_CRYPTO_SUITE_ID;
}>;

export function parseInvitationEvidenceCore(value: unknown): InvitationEvidenceCore {
  const record = exact(value, "invitation evidence", [
    "schema_version", "record_kind", "authority", "project_id", "invitation_id", "inviting_membership_id",
    "inviting_person_id", "inviting_device_id", "intended_role", "access_scope", "access_scope_id",
    "creation_control_head_id", "creation_control_sequence", "valid_through_control_sequence",
    "accepted_invitation_action_id", "accepted_invitation_control_event_id", "status", "suite_id"
  ]);
  const creationSequence = expectUInt64(record.creation_control_sequence, "invitation creation sequence");
  const validThrough = expectUInt64(record.valid_through_control_sequence, "invitation validity boundary");
  if (validThrough < creationSequence) throw new Error("Invitation validity boundary precedes creation.");
  return freezeRecord({
    schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "invitation_evidence_core", "invitation kind"),
    authority: literal(record.authority, "none", "invitation authority"), project_id: project(record.project_id),
    invitation_id: parseEntityId("invitation", record.invitation_id), inviting_membership_id: parseEntityId("membership", record.inviting_membership_id),
    inviting_person_id: parseEntityId("person", record.inviting_person_id), inviting_device_id: parseEntityId("device", record.inviting_device_id),
    intended_role: role(record.intended_role), access_scope: scope(record.access_scope), access_scope_id: parseEntityId("access-scope", record.access_scope_id),
    creation_control_head_id: control(record.creation_control_head_id), creation_control_sequence: creationSequence,
    valid_through_control_sequence: validThrough, accepted_invitation_action_id: parseDigestId("control-action", record.accepted_invitation_action_id),
    accepted_invitation_control_event_id: control(record.accepted_invitation_control_event_id), status: literal(record.status, "accepted", "invitation status"),
    suite_id: parseHc2CryptoSuiteId(record.suite_id)
  });
}

export function parseInvitationHandoffCore(value: unknown): InvitationHandoffCore {
  const record = exact(value, "invitation handoff", ["schema_version", "record_kind", "authority", "project_id", "invitation_id", "invitation_evidence_id", "accepted_invitation_control_event_id", "intended_role", "access_scope", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "invitation_handoff_core", "handoff kind"), authority: literal(record.authority, "none", "handoff authority"),
    project_id: project(record.project_id), invitation_id: parseEntityId("invitation", record.invitation_id), invitation_evidence_id: parseHc2DigestId("invitation-evidence", record.invitation_evidence_id),
    accepted_invitation_control_event_id: control(record.accepted_invitation_control_event_id), intended_role: role(record.intended_role), access_scope: scope(record.access_scope), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseEnrollmentRequestCore(value: unknown): EnrollmentRequestCore {
  const record = exact(value, "enrollment request", ["schema_version", "record_kind", "authority", "enrollment_kind", "project_id", "invitation_id", "invitation_evidence_id", "accepted_invitation_control_event_id", "candidate_person_id", "existing_membership_id", "proposed_membership_id", "candidate_device_id", "signing_key_id", "signing_public_key_bytes", "recipient_key_id", "recipient_public_key_bytes", "intended_role", "access_scope", "access_scope_id", "bound_control_head_id", "request_nonce", "suite_id"]);
  const enrollmentKind = expectEnum(record.enrollment_kind, ["new_person", "additional_device"] as const, "enrollment kind");
  const existingMembership = record.existing_membership_id === null ? null : parseEntityId("membership", record.existing_membership_id);
  if ((enrollmentKind === "additional_device") !== (existingMembership !== null)) throw new Error("Only additional-device enrollment may bind an existing membership.");
  const signingKey = parseEntityId("public-key", record.signing_key_id);
  const recipientKey = parseEntityId("public-key", record.recipient_key_id);
  const signingPublic = publicKey(record.signing_public_key_bytes, "ed25519", signingKey);
  const recipientPublic = publicKey(record.recipient_public_key_bytes, "x25519", recipientKey);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "enrollment_request_core", "request kind"), authority: literal(record.authority, "none", "request authority"), enrollment_kind: enrollmentKind,
    project_id: project(record.project_id), invitation_id: parseEntityId("invitation", record.invitation_id), invitation_evidence_id: parseHc2DigestId("invitation-evidence", record.invitation_evidence_id), accepted_invitation_control_event_id: control(record.accepted_invitation_control_event_id),
    candidate_person_id: parseEntityId("person", record.candidate_person_id), existing_membership_id: existingMembership, proposed_membership_id: parseEntityId("membership", record.proposed_membership_id), candidate_device_id: parseEntityId("device", record.candidate_device_id),
    signing_key_id: signingKey, signing_public_key_bytes: signingPublic, recipient_key_id: recipientKey, recipient_public_key_bytes: recipientPublic,
    intended_role: role(record.intended_role), access_scope: scope(record.access_scope), access_scope_id: parseEntityId("access-scope", record.access_scope_id), bound_control_head_id: control(record.bound_control_head_id), request_nonce: digest(record.request_nonce, "request nonce"), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseEnrollmentRequestRecord(value: unknown): EnrollmentRequestRecord {
  const record = exact(value, "signed enrollment request", ["record_version", "record_kind", "authority", "request_id", "core", "algorithm", "signature_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "enrollment_request", "signed request kind"), authority: literal(record.authority, "none", "signed request authority"),
    request_id: parseHc2DigestId("enrollment-request", record.request_id), core: parseEnrollmentRequestCore(record.core), algorithm: literal(record.algorithm, "ed25519", "request signature algorithm"), signature_bytes: signature(record.signature_bytes) });
}

export function parsePossessionChallengeHeaderCore(value: unknown): PossessionChallengeHeaderCore {
  const record = exact(value, "possession challenge header", ["schema_version", "record_kind", "authority", "project_id", "invitation_id", "request_id", "candidate_person_id", "candidate_device_id", "signing_key_id", "recipient_key_id", "signing_public_key_sha256", "recipient_public_key_sha256", "challenge_commitment", "bound_control_head_id", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "possession_challenge_header_core", "challenge kind"), authority: literal(record.authority, "none", "challenge authority"), project_id: project(record.project_id), invitation_id: parseEntityId("invitation", record.invitation_id),
    request_id: parseHc2DigestId("enrollment-request", record.request_id), candidate_person_id: parseEntityId("person", record.candidate_person_id), candidate_device_id: parseEntityId("device", record.candidate_device_id), signing_key_id: parseEntityId("public-key", record.signing_key_id), recipient_key_id: parseEntityId("public-key", record.recipient_key_id),
    signing_public_key_sha256: digest(record.signing_public_key_sha256, "signing key digest"), recipient_public_key_sha256: digest(record.recipient_public_key_sha256, "recipient key digest"), challenge_commitment: digest(record.challenge_commitment, "challenge commitment"), bound_control_head_id: control(record.bound_control_head_id), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parsePossessionChallengeEnvelope(value: unknown): PossessionChallengeEnvelope {
  const record = exact(value, "possession challenge envelope", ["record_version", "record_kind", "authority", "challenge_id", "header_core", "public_header", "ciphertext_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "possession_challenge_envelope", "challenge envelope kind"), authority: literal(record.authority, "none", "challenge envelope authority"), challenge_id: parseHc2DigestId("possession-challenge", record.challenge_id), header_core: parsePossessionChallengeHeaderCore(record.header_core), public_header: parsePublicEnvelopeHeader(record.public_header), ciphertext_bytes: boundedBytes(record.ciphertext_bytes, 256, "challenge ciphertext") });
}

export function parsePossessionResponseCore(value: unknown): PossessionResponseCore {
  const record = exact(value, "possession response", ["schema_version", "record_kind", "authority", "project_id", "invitation_id", "request_id", "challenge_id", "challenge_commitment", "challenge_response", "candidate_person_id", "candidate_device_id", "signing_key_id", "recipient_key_id", "bound_control_head_id", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "possession_response_core", "response kind"), authority: literal(record.authority, "none", "response authority"), project_id: project(record.project_id), invitation_id: parseEntityId("invitation", record.invitation_id), request_id: parseHc2DigestId("enrollment-request", record.request_id), challenge_id: parseHc2DigestId("possession-challenge", record.challenge_id), challenge_commitment: digest(record.challenge_commitment, "challenge commitment"), challenge_response: digest(record.challenge_response, "challenge response"), candidate_person_id: parseEntityId("person", record.candidate_person_id), candidate_device_id: parseEntityId("device", record.candidate_device_id), signing_key_id: parseEntityId("public-key", record.signing_key_id), recipient_key_id: parseEntityId("public-key", record.recipient_key_id), bound_control_head_id: control(record.bound_control_head_id), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parsePossessionProofRecord(value: unknown): PossessionProofRecord {
  const record = exact(value, "possession proof", ["record_version", "record_kind", "authority", "proof_id", "core", "algorithm", "signature_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "possession_proof", "proof kind"), authority: literal(record.authority, "none", "proof authority"), proof_id: parseHc2DigestId("possession-proof", record.proof_id), core: parsePossessionResponseCore(record.core), algorithm: literal(record.algorithm, "ed25519", "proof signature algorithm"), signature_bytes: signature(record.signature_bytes) });
}

export function parseMembershipFact(value: unknown): MembershipFact {
  const record = exact(value, "membership fact", ["membership_id", "person_id", "role", "access_scope", "access_scope_id", "status"]);
  return freezeRecord({ membership_id: parseEntityId("membership", record.membership_id), person_id: parseEntityId("person", record.person_id), role: role(record.role), access_scope: scope(record.access_scope), access_scope_id: parseEntityId("access-scope", record.access_scope_id), status: expectEnum(record.status, ["active", "revoked"] as const, "membership status") });
}

export function parseMembershipDeviceFact(value: unknown): MembershipDeviceFact {
  const record = exact(value, "membership device fact", ["membership_id", "person_id", "device_id", "signing_key_id", "signing_public_key_bytes", "recipient_key_id", "recipient_public_key_bytes", "status", "maximum_accepted_semantic_sequence"]);
  const signingKey = parseEntityId("public-key", record.signing_key_id); const recipientKey = parseEntityId("public-key", record.recipient_key_id);
  return freezeRecord({ membership_id: parseEntityId("membership", record.membership_id), person_id: parseEntityId("person", record.person_id), device_id: parseEntityId("device", record.device_id), signing_key_id: signingKey,
    signing_public_key_bytes: publicKey(record.signing_public_key_bytes, "ed25519", signingKey), recipient_key_id: recipientKey, recipient_public_key_bytes: publicKey(record.recipient_public_key_bytes, "x25519", recipientKey),
    status: expectEnum(record.status, ["active", "revoked"] as const, "device status"), maximum_accepted_semantic_sequence: record.maximum_accepted_semantic_sequence === null ? null : expectUInt64(record.maximum_accepted_semantic_sequence, "device cutoff") });
}

export function parseAcceptedMembershipState(value: unknown): AcceptedMembershipState {
  const record = exact(value, "accepted membership state", ["schema_version", "record_kind", "project_id", "owner_person_id", "control_head_id", "control_sequence", "root_sequence", "merge_policy", "active_control_device_id", "offline_root_key_id", "current_epoch_id", "current_epoch_commitment", "memberships", "devices", "consumed_invitation_ids", "cancelled_invitation_ids"]);
  const memberships = sortedObjects(record.memberships, "memberships", parseMembershipFact, (entry) => entry.membership_id);
  const devices = sortedObjects(record.devices, "membership devices", parseMembershipDeviceFact, (entry) => entry.device_id);
  const activeMembershipByPerson = new Map(memberships.filter((entry) => entry.status === "active").map((entry) => [entry.person_id, entry]));
  for (const device of devices) {
    const membership = memberships.find((entry) => entry.membership_id === device.membership_id);
    if (!membership || membership.person_id !== device.person_id || (device.status === "active" && membership.status !== "active")) throw new Error("Device and membership authority bindings are inconsistent.");
  }
  if (activeMembershipByPerson.size !== memberships.filter((entry) => entry.status === "active").length) throw new Error("A person cannot have multiple active memberships.");
  uniqueAcross(devices.flatMap((entry) => [entry.signing_key_id, entry.recipient_key_id]), "device public-key identities");
  uniqueAcross(devices.flatMap((entry) => [bytesKey(entry.signing_public_key_bytes), bytesKey(entry.recipient_public_key_bytes)]), "device canonical public-key bytes");
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "accepted_membership_state", "membership state kind"), project_id: project(record.project_id), owner_person_id: parseEntityId("person", record.owner_person_id), control_head_id: control(record.control_head_id), control_sequence: expectUInt64(record.control_sequence, "control sequence"), root_sequence: expectUInt64(record.root_sequence, "root sequence"), merge_policy: expectEnum(record.merge_policy, ["manual", "auto_safe"] as const, "merge policy"), active_control_device_id: parseEntityId("device", record.active_control_device_id), offline_root_key_id: parseEntityId("public-key", record.offline_root_key_id), current_epoch_id: parseEntityId("key-epoch", record.current_epoch_id), current_epoch_commitment: parseDigestId("key-epoch-commitment", record.current_epoch_commitment), memberships, devices,
    consumed_invitation_ids: sortedStrings(record.consumed_invitation_ids, "consumed invitations", (entry) => parseEntityId("invitation", entry)), cancelled_invitation_ids: sortedStrings(record.cancelled_invitation_ids, "cancelled invitations", (entry) => parseEntityId("invitation", entry)) });
}

export function parseRecipientManifestEntry(value: unknown): RecipientManifestEntry {
  const record = exact(value, "recipient manifest entry", ["membership_id", "person_id", "device_id", "role", "access_scope", "signing_key_id", "recipient_key_id", "recipient_public_key_bytes"]);
  const recipientKey = parseEntityId("public-key", record.recipient_key_id);
  return freezeRecord({ membership_id: parseEntityId("membership", record.membership_id), person_id: parseEntityId("person", record.person_id), device_id: parseEntityId("device", record.device_id), role: role(record.role), access_scope: scope(record.access_scope), signing_key_id: parseEntityId("public-key", record.signing_key_id), recipient_key_id: recipientKey, recipient_public_key_bytes: publicKey(record.recipient_public_key_bytes, "x25519", recipientKey) });
}

export function parseRecipientManifestCore(value: unknown): RecipientManifestCore {
  const record = exact(value, "recipient manifest", ["schema_version", "record_kind", "authority", "project_id", "previous_control_head_id", "mutation_kind", "replacement_epoch_id", "replacement_epoch_commitment", "recipients", "suite_id"]);
  const recipients = sortedObjects(record.recipients, "recipient manifest", parseRecipientManifestEntry, (entry) => entry.device_id);
  if (recipients.length === 0 || recipients.length > hc2ProtocolLimits.maximum_active_devices_per_project) throw new Error("Recipient manifest size is invalid.");
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "epoch_recipient_manifest_core", "recipient manifest kind"), authority: literal(record.authority, "none", "recipient manifest authority"), project_id: project(record.project_id), previous_control_head_id: control(record.previous_control_head_id), mutation_kind: mutation(record.mutation_kind), replacement_epoch_id: parseEntityId("key-epoch", record.replacement_epoch_id), replacement_epoch_commitment: parseDigestId("key-epoch-commitment", record.replacement_epoch_commitment), recipients, suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseDeliverySetCore(value: unknown): DeliverySetCore {
  const record = exact(value, "delivery set", ["schema_version", "record_kind", "authority", "project_id", "previous_control_head_id", "recipient_manifest_id", "replacement_epoch_id", "replacement_epoch_commitment", "recipient_device_ids", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "epoch_delivery_set_core", "delivery set kind"), authority: literal(record.authority, "none", "delivery set authority"), project_id: project(record.project_id), previous_control_head_id: control(record.previous_control_head_id), recipient_manifest_id: parseHc2DigestId("recipient-manifest", record.recipient_manifest_id), replacement_epoch_id: parseEntityId("key-epoch", record.replacement_epoch_id), replacement_epoch_commitment: parseDigestId("key-epoch-commitment", record.replacement_epoch_commitment), recipient_device_ids: sortedStrings(record.recipient_device_ids, "delivery recipients", (entry) => parseEntityId("device", entry)), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseMembershipTransitionCore(value: unknown): MembershipTransitionCore {
  const record = exact(value, "membership transition", ["schema_version", "record_kind", "authority", "project_id", "mutation_kind", "previous_control_head_id", "expected_control_sequence", "authorizing_owner_membership_id", "authorizing_owner_person_id", "authorizing_owner_device_id", "invitation_evidence_id", "enrollment_request_id", "possession_proof_id", "membership_id", "person_id", "role", "access_scope", "access_scope_id", "device_id", "signing_key_id", "recipient_key_id", "signing_public_key_bytes", "recipient_public_key_bytes", "revoked_device_ids", "revocation_cutoffs", "previous_active_control_device_id", "replacement_active_control_device_id", "previous_epoch_id", "replacement_epoch_id", "replacement_epoch_commitment", "recipient_manifest_id", "delivery_set_id", "resulting_control_state_root", "suite_id"]);
  const kind = mutation(record.mutation_kind);
  const deviceId = nullableEntity("device", record.device_id); const signingKey = nullableEntity("public-key", record.signing_key_id); const recipientKey = nullableEntity("public-key", record.recipient_key_id);
  const signingPublic = record.signing_public_key_bytes === null ? null : publicKey(record.signing_public_key_bytes, "ed25519", required(signingKey, "Signing key ID is required with public bytes."));
  const recipientPublic = record.recipient_public_key_bytes === null ? null : publicKey(record.recipient_public_key_bytes, "x25519", required(recipientKey, "Recipient key ID is required with public bytes."));
  if ((kind === "new_membership" || kind === "additional_device") !== (deviceId !== null && signingPublic !== null && recipientPublic !== null)) throw new Error("Enrollment transitions require one exact candidate device and both public keys.");
  const invitation = nullableHc2("invitation-evidence", record.invitation_evidence_id); const request = nullableHc2("enrollment-request", record.enrollment_request_id); const proof = nullableHc2("possession-proof", record.possession_proof_id);
  if ((kind === "new_membership" || kind === "additional_device") !== (invitation !== null && request !== null && proof !== null)) throw new Error("Enrollment transitions require invitation, request, and possession proof evidence.");
  const cutoffs = sortedObjects(record.revocation_cutoffs, "revocation cutoffs", (entry) => { const item = exact(entry, "revocation cutoff", ["device_id", "maximum_accepted_semantic_sequence"]); return freezeRecord({ device_id: parseEntityId("device", item.device_id), maximum_accepted_semantic_sequence: expectUInt64(item.maximum_accepted_semantic_sequence, "revocation cutoff") }); }, (entry) => entry.device_id);
  const revoked = sortedStrings(record.revoked_device_ids, "revoked devices", (entry) => parseEntityId("device", entry));
  if ((kind === "device_revocation" || kind === "membership_revocation") !== (revoked.length > 0 && cutoffs.length === revoked.length)) throw new Error("Revocation transitions require exact device cutoffs.");
  if (cutoffs.some((entry, index) => entry.device_id !== revoked[index])) throw new Error("Revocation cutoffs differ from revoked devices.");
  const previousEpoch = parseEntityId("key-epoch", record.previous_epoch_id); const replacementEpoch = parseEntityId("key-epoch", record.replacement_epoch_id);
  if (previousEpoch === replacementEpoch) throw new Error("Every membership/device transition must rotate the epoch.");
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "membership_epoch_transition_core", "transition kind"), authority: literal(record.authority, "none", "transition evidence authority"), project_id: project(record.project_id), mutation_kind: kind, previous_control_head_id: control(record.previous_control_head_id), expected_control_sequence: expectUInt64(record.expected_control_sequence, "expected control sequence"), authorizing_owner_membership_id: parseEntityId("membership", record.authorizing_owner_membership_id), authorizing_owner_person_id: parseEntityId("person", record.authorizing_owner_person_id), authorizing_owner_device_id: parseEntityId("device", record.authorizing_owner_device_id), invitation_evidence_id: invitation, enrollment_request_id: request, possession_proof_id: proof, membership_id: parseEntityId("membership", record.membership_id), person_id: parseEntityId("person", record.person_id), role: role(record.role), access_scope: scope(record.access_scope), access_scope_id: parseEntityId("access-scope", record.access_scope_id), device_id: deviceId, signing_key_id: signingKey, recipient_key_id: recipientKey, signing_public_key_bytes: signingPublic, recipient_public_key_bytes: recipientPublic, revoked_device_ids: revoked, revocation_cutoffs: cutoffs, previous_active_control_device_id: parseEntityId("device", record.previous_active_control_device_id), replacement_active_control_device_id: parseEntityId("device", record.replacement_active_control_device_id), previous_epoch_id: previousEpoch, replacement_epoch_id: replacementEpoch, replacement_epoch_commitment: parseDigestId("key-epoch-commitment", record.replacement_epoch_commitment), recipient_manifest_id: parseHc2DigestId("recipient-manifest", record.recipient_manifest_id), delivery_set_id: parseHc2DigestId("delivery-set", record.delivery_set_id), resulting_control_state_root: parseDigestId("control-state-root", record.resulting_control_state_root), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseEpochDeliveryHeaderCore(value: unknown): EpochDeliveryHeaderCore {
  const record = exact(value, "epoch delivery header", ["schema_version", "record_kind", "authority", "project_id", "transition_id", "accepted_control_event_id", "delivery_set_id", "recipient_manifest_id", "key_epoch_id", "key_epoch_commitment", "recipient_membership_id", "recipient_person_id", "recipient_device_id", "recipient_key_id", "recipient_ordinal", "recipient_count", "suite_id"]);
  const ordinal = expectUInt64(record.recipient_ordinal, "recipient ordinal"); const count = expectUInt64(record.recipient_count, "recipient count"); if (count === BigInt(0) || ordinal >= count) throw new Error("Recipient ordinal is outside the delivery set.");
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "epoch_delivery_header_core", "epoch delivery header kind"), authority: literal(record.authority, "none", "delivery header authority"), project_id: project(record.project_id), transition_id: parseHc2DigestId("membership-transition", record.transition_id), accepted_control_event_id: control(record.accepted_control_event_id), delivery_set_id: parseHc2DigestId("delivery-set", record.delivery_set_id), recipient_manifest_id: parseHc2DigestId("recipient-manifest", record.recipient_manifest_id), key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id), key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment), recipient_membership_id: parseEntityId("membership", record.recipient_membership_id), recipient_person_id: parseEntityId("person", record.recipient_person_id), recipient_device_id: parseEntityId("device", record.recipient_device_id), recipient_key_id: parseEntityId("public-key", record.recipient_key_id), recipient_ordinal: ordinal, recipient_count: count, suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseEpochDeliveryEnvelope(value: unknown): EpochDeliveryEnvelope {
  const record = exact(value, "epoch delivery envelope", ["record_version", "record_kind", "authority", "delivery_id", "header_core", "public_header", "ciphertext_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "epoch_delivery_envelope", "epoch delivery envelope kind"), authority: literal(record.authority, "none", "epoch envelope authority"), delivery_id: parseHc2DigestId("epoch-delivery", record.delivery_id), header_core: parseEpochDeliveryHeaderCore(record.header_core), public_header: parsePublicEnvelopeHeader(record.public_header), ciphertext_bytes: boundedBytes(record.ciphertext_bytes, 1024, "epoch delivery ciphertext") });
}

export function parseEpochDeliveryPlaintext(value: unknown): EpochDeliveryPlaintext {
  const record = exact(value, "epoch delivery plaintext", ["schema_version", "record_kind", "project_id", "accepted_control_event_id", "delivery_set_id", "key_epoch_id", "key_epoch_commitment", "public_commitment_bytes", "epoch_secret", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "epoch_delivery_plaintext", "epoch plaintext kind"), project_id: project(record.project_id), accepted_control_event_id: control(record.accepted_control_event_id), delivery_set_id: parseHc2DigestId("delivery-set", record.delivery_set_id), key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id), key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment), public_commitment_bytes: digest(record.public_commitment_bytes, "epoch commitment bytes"), epoch_secret: digest(record.epoch_secret, "epoch secret"), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseAdmissionPackageCore(value: unknown): AdmissionPackageCore {
  const record = exact(value, "admission package", ["schema_version", "record_kind", "authority", "project_id", "transition_id", "accepted_control_action_id", "accepted_control_event_id", "resulting_control_state_root", "admitted_membership_id", "admitted_person_id", "admitted_device_id", "admitted_role", "access_scope", "signing_key_id", "recipient_key_id", "key_epoch_id", "key_epoch_commitment", "recipient_manifest_id", "delivery_set_id", "recipient_delivery_id", "checkpoint_id", "projection_root", "semantic_state_root", "revision_heads_root", "conflict_set_root", "accepted_history_root", "state_blob_id", "snapshot_id", "semantic_frontier", "revision_manifest", "conflict_manifest", "reducer_version", "admission_boundary_sha256", "owner_signing_key_id", "full_history_verified", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "current_state_admission_package_core", "admission package kind"), authority: literal(record.authority, "none", "admission authority"), project_id: project(record.project_id), transition_id: parseHc2DigestId("membership-transition", record.transition_id), accepted_control_action_id: parseDigestId("control-action", record.accepted_control_action_id), accepted_control_event_id: control(record.accepted_control_event_id), resulting_control_state_root: parseDigestId("control-state-root", record.resulting_control_state_root), admitted_membership_id: parseEntityId("membership", record.admitted_membership_id), admitted_person_id: parseEntityId("person", record.admitted_person_id), admitted_device_id: parseEntityId("device", record.admitted_device_id), admitted_role: role(record.admitted_role), access_scope: scope(record.access_scope), signing_key_id: parseEntityId("public-key", record.signing_key_id), recipient_key_id: parseEntityId("public-key", record.recipient_key_id), key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id), key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment), recipient_manifest_id: parseHc2DigestId("recipient-manifest", record.recipient_manifest_id), delivery_set_id: parseHc2DigestId("delivery-set", record.delivery_set_id), recipient_delivery_id: parseHc2DigestId("epoch-delivery", record.recipient_delivery_id), checkpoint_id: parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId, projection_root: parseDigestId("projection-root", record.projection_root), semantic_state_root: parseDigestId("semantic-state-root", record.semantic_state_root), revision_heads_root: parseDigestId("revision-heads-root", record.revision_heads_root), conflict_set_root: parseDigestId("conflict-set-root", record.conflict_set_root), accepted_history_root: parseDigestId("accepted-history-root", record.accepted_history_root), state_blob_id: parseDigestId("state-blob", record.state_blob_id), snapshot_id: parseDigestId("snapshot", record.snapshot_id), semantic_frontier: sortedStrings(record.semantic_frontier, "admission frontier", (entry) => parseDigestId("semantic-event", entry)), revision_manifest: sortedStrings(record.revision_manifest, "revision manifest", (entry) => parseDigestId("document-revision", entry)), conflict_manifest: sortedStrings(record.conflict_manifest, "conflict manifest", parseSafeConflictId), reducer_version: safeText(record.reducer_version, "reducer version"), admission_boundary_sha256: digest(record.admission_boundary_sha256, "admission boundary digest"), owner_signing_key_id: parseEntityId("public-key", record.owner_signing_key_id), full_history_verified: literal(record.full_history_verified, false, "admission history claim"), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseAdmissionPackageRecord(value: unknown): AdmissionPackageRecord {
  const record = exact(value, "signed admission package", ["record_version", "record_kind", "authority", "admission_package_id", "core", "owner_signature_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "current_state_admission_package", "signed admission kind"), authority: literal(record.authority, "none", "signed admission authority"), admission_package_id: parseHc2DigestId("admission-package", record.admission_package_id), core: parseAdmissionPackageCore(record.core), owner_signature_bytes: signature(record.owner_signature_bytes) });
}

export function parseEpochReceiptCore(value: unknown): EpochReceiptCore {
  const record = exact(value, "epoch receipt", ["schema_version", "record_kind", "authority", "project_id", "person_id", "membership_id", "role", "device_id", "signing_key_id", "acknowledgement_sequence", "previous_acknowledgement_id", "accepted_control_event_id", "key_epoch_id", "key_epoch_commitment", "delivery_id", "checkpoint_id", "projection_root", "admission_package_id", "admission_boundary_sha256", "suite_id"]);
  const sequence = expectUInt64(record.acknowledgement_sequence, "receipt sequence"); const previous = record.previous_acknowledgement_id === null ? null : parseDigestId("acknowledgement", record.previous_acknowledgement_id);
  if ((sequence === BigInt(0)) !== (previous === null)) throw new Error("Receipt predecessor semantics are invalid.");
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "epoch_delivery_receipt_core", "receipt kind"), authority: literal(record.authority, "none", "receipt authority"), project_id: project(record.project_id), person_id: parseEntityId("person", record.person_id), membership_id: parseEntityId("membership", record.membership_id), role: role(record.role), device_id: parseEntityId("device", record.device_id), signing_key_id: parseEntityId("public-key", record.signing_key_id), acknowledgement_sequence: sequence, previous_acknowledgement_id: previous, accepted_control_event_id: control(record.accepted_control_event_id), key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id), key_epoch_commitment: parseDigestId("key-epoch-commitment", record.key_epoch_commitment), delivery_id: parseHc2DigestId("epoch-delivery", record.delivery_id), checkpoint_id: parseDigestId("semantic-event", record.checkpoint_id) as CheckpointId, projection_root: parseDigestId("projection-root", record.projection_root), admission_package_id: parseHc2DigestId("admission-package", record.admission_package_id), admission_boundary_sha256: digest(record.admission_boundary_sha256, "admission boundary digest"), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export function parseEpochReceiptRecord(value: unknown): EpochReceiptRecord {
  const record = exact(value, "signed epoch receipt", ["record_version", "record_kind", "authority", "receipt_id", "core", "algorithm", "signature_bytes"]);
  return freezeRecord({ record_version: version(record.record_version), record_kind: literal(record.record_kind, "epoch_delivery_receipt", "signed receipt kind"), authority: literal(record.authority, "none", "signed receipt authority"), receipt_id: parseHc2DigestId("epoch-receipt", record.receipt_id), core: parseEpochReceiptCore(record.core), algorithm: literal(record.algorithm, "ed25519", "receipt signature algorithm"), signature_bytes: signature(record.signature_bytes) });
}

export function parseEnrollmentBatchMarker(value: unknown): EnrollmentBatchMarker {
  const record = exact(value, "enrollment batch marker", ["schema_version", "record_kind", "authority", "batch_id", "project_id", "transition_id", "accepted_control_event_id", "recipient_manifest_id", "delivery_set_id", "required_delivery_ids", "completion"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "enrollment_batch_marker", "enrollment batch kind"), authority: literal(record.authority, "none", "enrollment batch authority"), batch_id: parseHc2DigestId("enrollment-batch", record.batch_id), project_id: project(record.project_id), transition_id: parseHc2DigestId("membership-transition", record.transition_id), accepted_control_event_id: control(record.accepted_control_event_id), recipient_manifest_id: parseHc2DigestId("recipient-manifest", record.recipient_manifest_id), delivery_set_id: parseHc2DigestId("delivery-set", record.delivery_set_id), required_delivery_ids: sortedStrings(record.required_delivery_ids, "required deliveries", (entry) => parseHc2DigestId("epoch-delivery", entry)), completion: literal(record.completion, "complete_delivery_set", "enrollment batch completion") });
}

export function parseEnrollmentCeremonyPlanCore(value: unknown): EnrollmentCeremonyPlanCore {
  const record = exact(value, "enrollment ceremony plan", ["schema_version", "record_kind", "project_id", "mutation_kind", "previous_control_head_id", "expected_control_sequence", "invitation_evidence_id", "enrollment_request_id", "possession_proof_id", "membership_id", "person_id", "device_id", "previous_epoch_id", "replacement_epoch_id", "suite_id"]);
  return freezeRecord({ schema_version: version(record.schema_version), record_kind: literal(record.record_kind, "enrollment_ceremony_plan_core", "ceremony plan kind"), project_id: project(record.project_id), mutation_kind: mutation(record.mutation_kind), previous_control_head_id: control(record.previous_control_head_id), expected_control_sequence: expectUInt64(record.expected_control_sequence, "ceremony control sequence"), invitation_evidence_id: nullableHc2("invitation-evidence", record.invitation_evidence_id), enrollment_request_id: nullableHc2("enrollment-request", record.enrollment_request_id), possession_proof_id: nullableHc2("possession-proof", record.possession_proof_id), membership_id: parseEntityId("membership", record.membership_id), person_id: parseEntityId("person", record.person_id), device_id: nullableEntity("device", record.device_id), previous_epoch_id: parseEntityId("key-epoch", record.previous_epoch_id), replacement_epoch_id: parseEntityId("key-epoch", record.replacement_epoch_id), suite_id: parseHc2CryptoSuiteId(record.suite_id) });
}

export const deriveInvitationEvidenceIdentity = (value: InvitationEvidenceCore) => derive("invitation-evidence", parseInvitationEvidenceCore(value));
export const deriveInvitationHandoffIdentity = (value: InvitationHandoffCore) => derive("invitation-handoff", parseInvitationHandoffCore(value));
export const deriveEnrollmentRequestIdentity = (value: EnrollmentRequestCore) => derive("enrollment-request", parseEnrollmentRequestCore(value));
export const derivePossessionChallengeIdentity = (value: PossessionChallengeHeaderCore) => derive("possession-challenge", parsePossessionChallengeHeaderCore(value));
export const derivePossessionProofIdentity = (value: PossessionResponseCore) => derive("possession-proof", parsePossessionResponseCore(value));
export const deriveMembershipTransitionIdentity = (value: MembershipTransitionCore) => derive("membership-transition", parseMembershipTransitionCore(value));
export const deriveRecipientManifestIdentity = (value: RecipientManifestCore) => derive("recipient-manifest", parseRecipientManifestCore(value));
export const deriveDeliverySetIdentity = (value: DeliverySetCore) => derive("delivery-set", parseDeliverySetCore(value));
export const deriveEpochDeliveryIdentity = (value: Omit<EpochDeliveryEnvelope, "delivery_id">) => derive("epoch-delivery", { ...value, header_core: parseEpochDeliveryHeaderCore(value.header_core), public_header: parsePublicEnvelopeHeader(value.public_header), ciphertext_bytes: boundedBytes(value.ciphertext_bytes, 1024, "epoch delivery ciphertext") });
export const deriveAdmissionPackageIdentity = (value: AdmissionPackageCore) => derive("admission-package", parseAdmissionPackageCore(value));
export const deriveEpochReceiptIdentity = (value: EpochReceiptCore) => derive("epoch-receipt", parseEpochReceiptCore(value));
export const deriveEnrollmentCeremonyIdentity = (value: EnrollmentCeremonyPlanCore) => derive("enrollment-ceremony", parseEnrollmentCeremonyPlanCore(value));
export const deriveEnrollmentBatchIdentity = (value: Omit<EnrollmentBatchMarker, "batch_id">) => derive("enrollment-batch", { ...value, required_delivery_ids: sortedStrings(value.required_delivery_ids, "required deliveries", (entry) => parseHc2DigestId("epoch-delivery", entry)) });

export function buildEnrollmentSignaturePreimage(kind: "enrollment_request" | "possession_response" | "admission_package" | "epoch_receipt", projectId: ProjectId, identity: EnrollmentRequestId | PossessionProofId | AdmissionPackageId | EpochReceiptId): Hc2EnrollmentSignaturePreimage {
  const domain = kind === "enrollment_request" ? hc2SignatureDomains.enrollmentRequest : kind === "possession_response" ? hc2SignatureDomains.possessionResponse : kind === "admission_package" ? hc2SignatureDomains.admissionPackage : hc2SignatureDomains.epochReceipt;
  return encodeCanonicalCbor(canonicalArray([canonicalText(domain), canonicalText(project(projectId)), canonicalText(identity)])) as Hc2EnrollmentSignaturePreimage;
}

export async function digestPublicKeyBytes(value: AlgorithmTaggedPublicKeyBytes): Promise<Uint8Array> { return Uint8Array.from(await sha256(Uint8Array.from(value))); }
export async function digestChallengePlaintext(value: Uint8Array): Promise<Uint8Array> { const bytes = boundedBytes(value, 64, "challenge plaintext"); if (bytes.length !== 32) throw new Error("Possession challenge must contain exactly 32 bytes."); return Uint8Array.from(await sha256(bytes)); }
export async function digestEnrollmentHeader(value: PossessionChallengeHeaderCore | EpochDeliveryHeaderCore): Promise<Uint8Array> { return Uint8Array.from(await sha256(encodeCanonicalCbor(canonicalProtocolValue(value)))); }

async function derive<TKind extends Parameters<typeof deriveHc2Identity>[0]>(kind: TKind, value: unknown) {
  const bytes = encodeCanonicalCbor(canonicalProtocolValue(value));
  if (BigInt(bytes.length) > hc2ProtocolLimits.maximum_enrollment_record_canonical_bytes) throw new Error("Enrollment record exceeds the HC-2 bounded canonical size.");
  return deriveHc2Identity(kind, canonicalProtocolValue(value));
}

function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> { return expectExactRecord(value, label, [...keys]); }
function version(value: unknown): typeof HC2_ENROLLMENT_SCHEMA_VERSION { return expectLiteral(value, HC2_ENROLLMENT_SCHEMA_VERSION, "enrollment schema version"); }
function literal<T extends string | number | boolean>(value: unknown, expected: T, label: string): T { return expectLiteral(value, expected, label); }
function project(value: unknown): ProjectId { return parseEntityId("project", value); }
function control(value: unknown): ControlEventId { return parseDigestId("control-event", value); }
function role(value: unknown): CollaborationRole { return expectEnum(value, collaborationRoles, "collaboration role"); }
function scope(value: unknown): Hc2ProjectWideScope { return expectLiteral(value, HC2_PROJECT_WIDE_ACCESS_SCOPE, "HC-2 access scope"); }
function mutation(value: unknown): MembershipMutationKind { return expectEnum(value, ["new_membership", "additional_device", "role_change", "device_revocation", "membership_revocation"] as const, "membership mutation kind"); }
function digest(value: unknown, label: string): Uint8Array { const bytes = expectBytes(value, label); if (bytes.length !== 32) throw new Error(`${label} must contain exactly 32 bytes.`); return Uint8Array.from(bytes); }
function bytesKey(value: Uint8Array): string { let result = ""; for (const byte of value) result += byte.toString(16).padStart(2, "0"); return result; }
function signature(value: unknown): Uint8Array { const bytes = expectBytes(value, "Ed25519 signature"); if (bytes.length !== 64) throw new Error("Ed25519 signature must contain exactly 64 bytes."); return Uint8Array.from(bytes); }
function boundedBytes(value: unknown, maximum: number, label: string): Uint8Array { const bytes = expectBytes(value, label); if (bytes.length === 0 || bytes.length > maximum) throw new Error(`${label} exceeds its exact bound.`); return Uint8Array.from(bytes); }
function publicKey(value: unknown, algorithm: "ed25519" | "x25519", keyId: PublicKeyId): AlgorithmTaggedPublicKeyBytes { const bytes = boundedBytes(value, 512, `${algorithm} public key`) as AlgorithmTaggedPublicKeyBytes; const decoded = decodeAlgorithmTaggedPublicKey(bytes, algorithm); if (decoded.key_id !== keyId) throw new Error(`${algorithm} public key identity is inconsistent.`); return bytes; }
function safeText(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} is invalid.`); return value; }
function parseSafeConflictId(value: unknown): string { if (typeof value !== "string" || !value.startsWith("pm:derived-conflict:v1:")) throw new Error("Conflict manifest identity is invalid."); return parseDigestId("derived-conflict", value); }
function nullableEntity<TKind extends "device" | "public-key">(kind: TKind, value: unknown) { return value === null ? null : parseEntityId(kind, value); }
function nullableHc2<TKind extends "invitation-evidence" | "enrollment-request" | "possession-proof">(kind: TKind, value: unknown) { return value === null ? null : parseHc2DigestId(kind, value); }
function required<T>(value: T | null, message: string): T { if (value === null) throw new Error(message); return value; }
function sortedStrings<T extends string>(value: unknown, label: string, parse: (entry: unknown) => T): readonly T[] { if (!Array.isArray(value) || value.length > hc2ProtocolLimits.maximum_active_devices_per_project) throw new Error(`${label} must be a bounded array.`); const result = value.map(parse); for (let index = 1; index < result.length; index += 1) if (result[index - 1] >= result[index]) throw new Error(`${label} must be sorted and unique.`); return Object.freeze(result); }
function sortedObjects<T>(value: unknown, label: string, parse: (entry: unknown) => T, key: (entry: T) => string): readonly T[] { if (!Array.isArray(value) || value.length > hc2ProtocolLimits.maximum_active_devices_per_project) throw new Error(`${label} must be a bounded array.`); const result = value.map(parse); for (let index = 1; index < result.length; index += 1) if (key(result[index - 1]) >= key(result[index])) throw new Error(`${label} must be sorted and unique.`); return Object.freeze(result); }
function uniqueAcross(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label} must be globally unique.`); }

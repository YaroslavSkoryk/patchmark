import { encodeCanonicalCbor } from "../canonical-cbor.ts";
import { buildSignaturePreimage, deriveAttestationIdentity, deriveControlActionIdentity, deriveControlEventCoreIdentity } from "../preimages.ts";
import { parseAttestationRecord, type AttestationRecord } from "../checkpoints.ts";
import { parseControlActionCore, parseControlEventCoreStructure, parseControlEventRecordStructure, type ControlActionRecord, type ControlEventRecord } from "../control.ts";
import { EventControlStore } from "../event-control-store.ts";
import type { ControlEventId, KeyEpochId } from "../identities.ts";
import { sha256 } from "../sha256.ts";
import type { SenderSignaturePreimageBytes, RandomSource, RecipientEnvelopeProvider } from "./crypto-contracts.ts";
import {
  deriveEnrollmentBatchIdentity,
  deriveEnrollmentCeremonyIdentity,
  deriveMembershipTransitionIdentity,
  parseEnrollmentBatchMarker,
  parseEnrollmentCeremonyPlanCore,
  parseAdmissionPackageRecord,
  parseEpochDeliveryHeaderCore,
  type AdmissionPackageRecord,
  type DeliverySetCore,
  type EnrollmentBatchMarker,
  type EnrollmentRequestRecord,
  type EpochDeliveryEnvelope,
  type InvitationEvidenceCore,
  type MembershipTransitionCore,
  type PossessionProofRecord,
  type RecipientManifestCore
} from "./enrollment-contracts.ts";
import { Hc2DeviceVaultService } from "./device-vault.ts";
import type { LoadedDeviceCustody } from "./custody-types.ts";
import { createEpochDeliveryEnvelope, decodeEpochDeliveryEnvelope, encodeEpochDeliveryEnvelope, verifyCompleteEpochDeliverySet, verifyEnrollmentRequestSignature, verifyPossessionProof } from "./epoch-delivery.ts";
import {
  parseEnrollmentLocalCompletionMarker,
  parseEnrollmentTransitionJournal,
  type EnrollmentTransitionJournal,
  type Hc2EnrollmentStore
} from "./enrollment-store.ts";
import { prepareMembershipTransition, verifyMembershipTransition, type PrepareMembershipTransitionInput, type VerifiedMembershipTransition } from "./membership-authority.ts";
import { Hc2WebLocksAdapter } from "./web-locks.ts";
import { HC2_CRYPTO_SUITE_ID } from "./versions.ts";

export const enrollmentSenderFailureStages = Object.freeze([
  "before_plan_write",
  "after_plan_before_control_reservation",
  "before_epoch_generation",
  "after_epoch_generation_before_local_wrap",
  "after_local_wrap_before_journal",
  "before_invitation_consumption",
  "before_each_recipient_envelope",
  "after_recipient_envelope_before_journal",
  "after_partial_delivery_journal",
  "before_control_action_write",
  "after_control_action_before_attestation_write",
  "after_attestation_before_control_event_write",
  "after_control_event_before_batch_marker",
  "before_complete_batch_marker",
  "after_batch_marker_before_indexeddb_finalization",
  "after_indexeddb_finalization_before_reopen",
  "before_admission_construction",
  "before_local_completion_marker"
] as const);
export type EnrollmentSenderFailureStage = (typeof enrollmentSenderFailureStages)[number];
export type EnrollmentSenderFailureInjector = (context: Readonly<{ stage: EnrollmentSenderFailureStage; recipient_index?: number }>) => void | Promise<void>;

export type EnrollmentControlRegistration = Readonly<{
  action: ControlActionRecord;
  event: ControlEventRecord;
  transition: VerifiedMembershipTransition;
}>;

export type EnrollmentPublishedBatch = Readonly<{
  marker: EnrollmentBatchMarker;
  transition: MembershipTransitionCore;
  recipient_manifest: RecipientManifestCore;
  delivery_set: DeliverySetCore;
  deliveries: readonly EpochDeliveryEnvelope[];
  action: ControlActionRecord;
  attestation: AttestationRecord;
  event: ControlEventRecord;
}>;

export async function runOwnerEnrollmentTransition(input: Readonly<{
  transition: Omit<PrepareMembershipTransitionInput, "replacement_epoch_id" | "replacement_epoch_commitment">;
  replacement_epoch_id: KeyEpochId;
  previous_state: Parameters<typeof prepareMembershipTransition>[0]["previous_state"];
  invitation_evidence?: InvitationEvidenceCore;
  enrollment_request?: EnrollmentRequestRecord;
  possession_proof?: PossessionProofRecord;
  owner_custody: LoadedDeviceCustody;
  vault: Hc2DeviceVaultService;
  random: RandomSource;
  hpke: RecipientEnvelopeProvider;
  locks: Hc2WebLocksAdapter;
  store: Hc2EnrollmentStore;
  events: EventControlStore;
  register_control_transition: (registration: EnrollmentControlRegistration) => Promise<void> | void;
  publish_complete_batch: (batch: EnrollmentPublishedBatch) => Promise<void>;
  construct_admission?: (context: Readonly<{ transition: MembershipTransitionCore; accepted_state: VerifiedMembershipTransition["next_state"]; action: ControlActionRecord; deliveries: readonly EpochDeliveryEnvelope[] }>) => Promise<AdmissionPackageRecord>;
  failure_injector?: EnrollmentSenderFailureInjector;
}>): Promise<Readonly<{
  transition: VerifiedMembershipTransition;
  action: ControlActionRecord;
  event: ControlEventRecord;
  deliveries: readonly EpochDeliveryEnvelope[];
  batch_marker: EnrollmentBatchMarker;
  owner_custody: LoadedDeviceCustody;
  admission_package: AdmissionPackageRecord | null;
}>> {
  const plan = parseEnrollmentCeremonyPlanCore({
    schema_version: 1, record_kind: "enrollment_ceremony_plan_core", project_id: input.transition.project_id,
    mutation_kind: input.transition.mutation_kind, previous_control_head_id: input.transition.previous_control_head_id,
    expected_control_sequence: input.transition.expected_control_sequence, invitation_evidence_id: input.transition.invitation_evidence_id,
    enrollment_request_id: input.transition.enrollment_request_id, possession_proof_id: input.transition.possession_proof_id,
    membership_id: input.transition.membership_id, person_id: input.transition.person_id, device_id: input.transition.device_id,
    previous_epoch_id: input.transition.previous_epoch_id, replacement_epoch_id: input.replacement_epoch_id, suite_id: HC2_CRYPTO_SUITE_ID
  });
  const planIdentity = await deriveEnrollmentCeremonyIdentity(plan);
  const planSha256 = Uint8Array.from(await sha256(planIdentity.canonical_preimage_bytes));
  const locked = await input.locks.runCustodyCeremonyExclusive({ project_id: plan.project_id, operation: async () => {
    let ownerCustody = input.owner_custody;
    await inject(input.failure_injector, "before_plan_write");
    const initial = parseEnrollmentTransitionJournal({ schema_version: 1, record_kind: "enrollment_transition_journal", ceremony_id: planIdentity.id,
      plan_sha256: planSha256, project_id: plan.project_id, authorizing_device_id: input.transition.authorizing_owner_device_id,
      previous_control_head_id: plan.previous_control_head_id, replacement_epoch_id: plan.replacement_epoch_id, phase: "planned", wrapped_epoch: null,
      transition_id: null, accepted_control_event_id: null, journaled_deliveries: [], batch_marker: null });
    let journal = (await input.store.beginTransition(initial)).journal;
    await inject(input.failure_injector, "after_plan_before_control_reservation");
    if (journal.phase === "planned") journal = await advance(input.store, journal, "control_reserved");

    if (journal.phase === "control_reserved") {
      await inject(input.failure_injector, "before_epoch_generation");
      const secret = Uint8Array.from(await input.random.randomBytes(32)); const nonce = Uint8Array.from(await input.random.randomBytes(12));
      if (secret.length !== 32 || nonce.length !== 12) throw new Error("Random provider returned an invalid epoch secret or wrapping nonce.");
      try {
        await inject(input.failure_injector, "after_epoch_generation_before_local_wrap");
        const wrapped = await input.vault.wrapEpochForRotation({ custody: ownerCustody, key_epoch_id: plan.replacement_epoch_id, epoch_secret: secret, nonce });
        const prepared = await prepareMembershipTransition({ previous_state: input.previous_state, transition: { ...input.transition, replacement_epoch_id: plan.replacement_epoch_id, replacement_epoch_commitment: wrapped.key_epoch_commitment } });
        const artifacts = await controlArtifacts(ownerCustody, input.vault, prepared.transition);
        await inject(input.failure_injector, "after_local_wrap_before_journal");
        journal = await input.store.advanceTransition("control_reserved", parseEnrollmentTransitionJournal({ ...journal, phase: "epoch_wrapped", wrapped_epoch: wrapped,
          transition_id: prepared.transition_id, accepted_control_event_id: artifacts.event.control_event_id }));
      } finally { secret.fill(0); nonce.fill(0); }
    }

    const wrapped = required(journal.wrapped_epoch, "Wrapped replacement epoch is absent from the ceremony journal.");
    const prepared = await prepareMembershipTransition({ previous_state: input.previous_state, transition: { ...input.transition, replacement_epoch_id: plan.replacement_epoch_id, replacement_epoch_commitment: wrapped.key_epoch_commitment } });
    if (prepared.transition_id !== journal.transition_id) throw new Error("Reconstructed transition conflicts with its immutable journal identity.");
    if (["indexeddb_finalized", "reopen_verified", "admission_ready", "complete"].includes(journal.phase)) {
      ownerCustody = await loadRotatedCustody(input.vault, input.owner_custody, prepared.transition, required(journal.accepted_control_event_id, "Accepted enrollment control event is absent."));
    }
    const artifacts = await controlArtifacts(ownerCustody, input.vault, prepared.transition);
    if (artifacts.event.control_event_id !== journal.accepted_control_event_id) throw new Error("Reconstructed control event conflicts with its immutable journal identity.");
    const verified = await verifyMembershipTransition({ previous_state: input.previous_state, transition: prepared.transition,
      recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, accepted_control_event_id: artifacts.event.control_event_id,
      ...(input.invitation_evidence ? { invitation_evidence: input.invitation_evidence } : {}), ...(input.enrollment_request ? { enrollment_request: input.enrollment_request } : {}),
      ...(input.possession_proof ? { possession_proof: input.possession_proof } : {}) });
    if (verified.status !== "verified") throw new Error(verified.reason);

    if (journal.phase === "epoch_wrapped" && input.invitation_evidence) {
      await inject(input.failure_injector, "before_invitation_consumption");
      if (!input.enrollment_request || !input.possession_proof || !(await verifyEnrollmentRequestSignature({ request: input.enrollment_request }))) {
        throw new Error("Owner approval requires a valid candidate enrollment-request signature.");
      }
      const storedChallenge = await input.store.readChallenge(plan.project_id, input.possession_proof.core.challenge_id);
      if (!storedChallenge || !(await verifyPossessionProof({ proof: input.possession_proof, request: input.enrollment_request,
        challenge: storedChallenge.challenge, expected_response_sha256: storedChallenge.expected_response_sha256,
        current_control_head_id: plan.previous_control_head_id }))) throw new Error("Owner approval requires an unmodified Ed25519/X25519 possession proof.");
      await input.store.consumeChallenge(plan.project_id, storedChallenge.challenge.challenge_id, input.possession_proof.proof_id, plan.previous_control_head_id);
      await input.store.consumeInvitation(plan.project_id, input.invitation_evidence.invitation_id, "accepted", artifacts.event.control_event_id, prepared.transition_id);
    }
    if (journal.phase === "epoch_wrapped") journal = await advance(input.store, journal, "delivery_partial");
    if (journal.phase === "delivery_partial") {
      for (let index = 0; index < prepared.recipient_manifest.recipients.length; index += 1) {
        const recipient = prepared.recipient_manifest.recipients[index];
        const existing = journal.journaled_deliveries.map((entry) => decodeEpochDeliveryEnvelope(entry.exact_bytes)).find((entry) => entry.header_core.recipient_device_id === recipient.device_id);
        if (existing) continue;
        await inject(input.failure_injector, "before_each_recipient_envelope", index);
        const envelope = await input.vault.withPendingEpoch({ custody: ownerCustody, wrapped_epoch: wrapped, use: (epochSecret) => createEpochDeliveryEnvelope({
          header_core: parseEpochDeliveryHeaderCore({ schema_version: 1, record_kind: "epoch_delivery_header_core", authority: "none", project_id: plan.project_id,
            transition_id: prepared.transition_id, accepted_control_event_id: artifacts.event.control_event_id, delivery_set_id: prepared.transition.delivery_set_id,
            recipient_manifest_id: prepared.transition.recipient_manifest_id, key_epoch_id: prepared.transition.replacement_epoch_id,
            key_epoch_commitment: prepared.transition.replacement_epoch_commitment, recipient_membership_id: recipient.membership_id,
            recipient_person_id: recipient.person_id, recipient_device_id: recipient.device_id, recipient_key_id: recipient.recipient_key_id,
            recipient_ordinal: BigInt(index), recipient_count: BigInt(prepared.recipient_manifest.recipients.length), suite_id: HC2_CRYPTO_SUITE_ID }),
          recipient_public_key_bytes: recipient.recipient_public_key_bytes, public_commitment_bytes: wrapped.public_commitment_bytes,
          epoch_secret: Uint8Array.from(epochSecret), hpke: input.hpke }) });
        await inject(input.failure_injector, "after_recipient_envelope_before_journal", index);
        journal = await input.store.advanceTransition("delivery_partial", parseEnrollmentTransitionJournal({ ...journal,
          journaled_deliveries: [...journal.journaled_deliveries, { delivery_id: envelope.delivery_id, exact_bytes: encodeEpochDeliveryEnvelope(envelope) }] }));
        await inject(input.failure_injector, "after_partial_delivery_journal", index);
      }
      journal = await advance(input.store, journal, "delivery_complete");
    }
    const deliveries = journal.journaled_deliveries.map((entry) => decodeEpochDeliveryEnvelope(entry.exact_bytes));
    const completeSet = await verifyCompleteEpochDeliverySet({ transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set, envelopes: deliveries });
    if (completeSet.status !== "verified") throw new Error(completeSet.reason);

    if (journal.phase === "delivery_complete") {
      await input.register_control_transition({ action: artifacts.action, event: artifacts.event, transition: verified });
      await inject(input.failure_injector, "before_control_action_write");
      await input.events.putControlAction(artifacts.action.core);
      await inject(input.failure_injector, "after_control_action_before_attestation_write");
      await input.events.putAttestationRecord(artifacts.attestation);
      await inject(input.failure_injector, "after_attestation_before_control_event_write");
      const ingested = await input.events.putControlEvent(artifacts.event);
      if (!ingested.state.accepted_control_event_ids.includes(artifacts.event.control_event_id)) {
        const classification = ingested.state.control_classifications.find((entry) => entry.object_id === artifacts.event.control_event_id);
        throw new Error(`Membership control transition was not accepted by HC-1 reconstruction${classification ? `: ${classification.reason}: ${classification.detail}` : "."}`);
      }
      journal = await advance(input.store, journal, "control_committed");
    }
    if (journal.phase === "control_committed") {
      await inject(input.failure_injector, "after_control_event_before_batch_marker");
      const markerWithoutId = Object.freeze({ schema_version: 1 as const, record_kind: "enrollment_batch_marker" as const, authority: "none" as const,
        project_id: plan.project_id, transition_id: prepared.transition_id, accepted_control_event_id: artifacts.event.control_event_id,
        recipient_manifest_id: prepared.transition.recipient_manifest_id, delivery_set_id: prepared.transition.delivery_set_id,
        required_delivery_ids: Object.freeze(deliveries.map((entry) => entry.delivery_id).sort()), completion: "complete_delivery_set" as const });
      const markerIdentity = await deriveEnrollmentBatchIdentity(markerWithoutId);
      const marker = parseEnrollmentBatchMarker({ ...markerWithoutId, batch_id: markerIdentity.id });
      await inject(input.failure_injector, "before_complete_batch_marker");
      await input.publish_complete_batch({ marker, transition: prepared.transition, recipient_manifest: prepared.recipient_manifest, delivery_set: prepared.delivery_set,
        deliveries, action: artifacts.action, attestation: artifacts.attestation, event: artifacts.event });
      journal = await input.store.advanceTransition("control_committed", parseEnrollmentTransitionJournal({ ...journal, phase: "batch_visible", batch_marker: marker }));
    }
    if (journal.phase === "batch_visible") {
      await inject(input.failure_injector, "after_batch_marker_before_indexeddb_finalization");
      let rotation: Awaited<ReturnType<Hc2DeviceVaultService["commitEpochRotation"]>>;
      try {
        rotation = await input.vault.commitEpochRotation({ custody: ownerCustody, expected_control_head_id: plan.previous_control_head_id,
          replacement_control_head_id: artifacts.event.control_event_id, wrapped_epoch: wrapped });
      } catch {
        ownerCustody = await loadRotatedCustody(input.vault, input.owner_custody, prepared.transition, artifacts.event.control_event_id);
        rotation = await input.vault.commitEpochRotation({ custody: ownerCustody, expected_control_head_id: plan.previous_control_head_id,
          replacement_control_head_id: artifacts.event.control_event_id, wrapped_epoch: wrapped });
      }
      journal = await advance(input.store, journal, "indexeddb_finalized");
      ownerCustody = rotation.custody;
    }
    if (journal.phase === "indexeddb_finalized") {
      await inject(input.failure_injector, "after_indexeddb_finalization_before_reopen");
      const reopened = await input.events.reopenProject(plan.project_id);
      if (!reopened.accepted_control_event_ids.includes(artifacts.event.control_event_id)) throw new Error("Reopen reconstruction rejected the membership transition.");
      journal = await advance(input.store, journal, "reopen_verified");
    }
    let admission: AdmissionPackageRecord | null = null;
    if (journal.phase === "reopen_verified") {
      await inject(input.failure_injector, "before_admission_construction");
      const enrollment = prepared.transition.mutation_kind === "new_membership" || prepared.transition.mutation_kind === "additional_device";
      if (enrollment && !input.construct_admission) throw new Error("Enrollment cannot complete before constructing the verified HC-1 admission package.");
      admission = input.construct_admission ? parseAdmissionPackageRecord(await input.construct_admission({ transition: prepared.transition, accepted_state: verified.next_state, action: artifacts.action, deliveries })) : null;
      journal = await advance(input.store, journal, "admission_ready");
    }
    if (journal.phase === "admission_ready") journal = await advance(input.store, journal, "complete");
    if (journal.phase !== "complete" || !journal.batch_marker) throw new Error("Enrollment ceremony did not reach complete state.");
    if (admission === null && input.construct_admission) {
      admission = parseAdmissionPackageRecord(await input.construct_admission({ transition: prepared.transition, accepted_state: verified.next_state,
        action: artifacts.action, deliveries }));
    }
    await inject(input.failure_injector, "before_local_completion_marker");
    await input.store.writeCompletionMarker(parseEnrollmentLocalCompletionMarker({ schema_version: 1, record_kind: "enrollment_transition_completion_marker",
      ceremony_id: journal.ceremony_id, project_id: journal.project_id, accepted_control_event_id: artifacts.event.control_event_id,
      transition_id: prepared.transition_id, batch_id: journal.batch_marker.batch_id, completion: "verified_reopen_complete" }));
    return Object.freeze({ transition: verified, action: artifacts.action, event: artifacts.event, deliveries: Object.freeze(deliveries), batch_marker: journal.batch_marker,
      owner_custody: ownerCustody, admission_package: admission });
  }});
  if (locked.status !== "completed") throw new Error(`Enrollment Web Lock did not complete: ${locked.reason}`);
  return locked.value;
}

async function loadRotatedCustody(
  vault: Hc2DeviceVaultService,
  prior: LoadedDeviceCustody,
  transition: MembershipTransitionCore,
  controlEventId: ControlEventId
): Promise<LoadedDeviceCustody> {
  const binding = prior.public_binding;
  return vault.loadAndVerify({ project_id: binding.project_id, person_id: binding.person_id, device_id: binding.device_id,
    access_scope_id: binding.access_scope_id, signing_key_id: binding.signing_key_id, recipient_key_id: binding.recipient_key_id,
    accepted_control_head_id: controlEventId, offline_root_key_id: binding.offline_root_key_id, key_epoch_id: transition.replacement_epoch_id,
    key_epoch_commitment: transition.replacement_epoch_commitment, device_status: "active" });
}

async function controlArtifacts(custody: LoadedDeviceCustody, vault: Hc2DeviceVaultService, transition: MembershipTransitionCore): Promise<Readonly<{ action: ControlActionRecord; attestation: AttestationRecord; event: ControlEventRecord }>> {
  const actionCore = parseControlActionCore({ schema_version: 1, project_id: transition.project_id, action_kind: "hc2_membership_epoch_transition",
    transition_id: (await deriveMembershipTransitionIdentity(transition)).id,
    transition_kind: transition.mutation_kind, recipient_manifest_id: transition.recipient_manifest_id, delivery_set_id: transition.delivery_set_id,
    previous_key_epoch_id: transition.previous_epoch_id, replacement_key_epoch_id: transition.replacement_epoch_id,
    replacement_key_epoch_commitment: transition.replacement_epoch_commitment, replacement_active_control_device_id: transition.replacement_active_control_device_id, suite_id: HC2_CRYPTO_SUITE_ID });
  const actionIdentity = await deriveControlActionIdentity(actionCore);
  const action: ControlActionRecord = Object.freeze({ record_version: 1, object_kind: "control_action", action_id: actionIdentity.id, core: actionCore });
  const eventCore = parseControlEventCoreStructure({ schema_version: 1, object_kind: "control_event_core", control_kind: "ordinary", project_id: transition.project_id,
    control_sequence: transition.expected_control_sequence, previous_control_id: transition.previous_control_head_id, issuer_device_id: transition.authorizing_owner_device_id,
    action_id: action.action_id, resulting_control_state_root: transition.resulting_control_state_root, key_epoch_id: transition.replacement_epoch_id,
    key_epoch_commitment: transition.replacement_epoch_commitment });
  const eventIdentity = await deriveControlEventCoreIdentity(eventCore);
  const signature = await vault.signDevice({ custody, preimage: encodeCanonicalCbor(buildSignaturePreimage("control_event", transition.project_id, eventIdentity.id)) as SenderSignaturePreimageBytes });
  const attestationCore = { schema_version: 1 as const, object_kind: "attestation_core" as const, project_id: transition.project_id, subject_kind: "control_event" as const,
    subject_id: eventIdentity.id, signer_key_id: custody.public_binding.signing_key_id, algorithm: "ed25519" as const, signature_bytes: signature };
  const attestationIdentity = await deriveAttestationIdentity(attestationCore);
  const attestation = parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: attestationIdentity.id, core: attestationCore });
  const event = parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event", control_event_id: eventIdentity.id, core: eventCore, authority_attestation_id: attestation.attestation_id });
  return Object.freeze({ action, attestation, event });
}

async function advance(store: Hc2EnrollmentStore, journal: EnrollmentTransitionJournal, phase: EnrollmentTransitionJournal["phase"]): Promise<EnrollmentTransitionJournal> { return store.advanceTransition(journal.phase, parseEnrollmentTransitionJournal({ ...journal, phase })); }
async function inject(injector: EnrollmentSenderFailureInjector | undefined, stage: EnrollmentSenderFailureStage, recipientIndex?: number): Promise<void> { if (injector) await injector(Object.freeze({ stage, ...(recipientIndex === undefined ? {} : { recipient_index: recipientIndex }) })); }
function required<T>(value: T | null, message: string): T { if (value === null) throw new Error(message); return value; }

import { sha256 } from "../sha256.ts";
import type { AcknowledgementId } from "../identities.ts";
import type { UInt64 } from "../validation.ts";
import { verifyAdmissionPackage, type AdmissionPackageEvidence } from "./admission-package.ts";
import {
  parseAcceptedMembershipState,
  parseAdmissionPackageRecord,
  parseEpochDeliveryEnvelope,
  parseMembershipTransitionCore,
  type AcceptedMembershipState,
  type AdmissionPackageRecord,
  type EpochDeliveryEnvelope,
  type EpochReceiptRecord,
  type MembershipTransitionCore
} from "./enrollment-contracts.ts";
import { Hc2EnrollmentCustodyService } from "./enrollment-custody.ts";
import { createEpochReceipt, verifyEpochReceipt } from "./epoch-receipt.ts";
import { openEpochDelivery } from "./epoch-delivery.ts";

export const candidateAdmissionFailureStages = Object.freeze([
  "before_admission_verification",
  "before_recipient_epoch_open",
  "after_recipient_epoch_open_before_local_wrapping",
  "after_local_wrapping_before_reopen",
  "after_reopen_before_receipt_reservation",
  "before_receipt_write",
  "after_receipt_write_before_commit",
  "before_final_completion_marker"
] as const);
export type CandidateAdmissionFailureStage = (typeof candidateAdmissionFailureStages)[number];
export type CandidateAdmissionFailureInjector = (stage: CandidateAdmissionFailureStage) => void | Promise<void>;

export async function admitCandidateDevice(input: Readonly<{
  accepted_state: AcceptedMembershipState;
  transition: MembershipTransitionCore;
  admission_package: AdmissionPackageRecord;
  delivery: EpochDeliveryEnvelope;
  evidence: AdmissionPackageEvidence;
  custody: Hc2EnrollmentCustodyService;
  ceremony_id: string;
  acknowledgement_sequence: UInt64;
  previous_acknowledgement_id: AcknowledgementId | null;
  reserve_receipt: (receipt: EpochReceiptRecord) => Promise<"reserved" | "exact_retry">;
  write_receipt: (receipt: EpochReceiptRecord) => Promise<void>;
  commit_receipt: (receipt: EpochReceiptRecord) => Promise<void>;
  failure_injector?: CandidateAdmissionFailureInjector;
}>): Promise<Readonly<{ receipt: EpochReceiptRecord; full_history_verified: false }>> {
  const state = parseAcceptedMembershipState(input.accepted_state);
  const transition = parseMembershipTransitionCore(input.transition);
  const admission = parseAdmissionPackageRecord(input.admission_package);
  const delivery = parseEpochDeliveryEnvelope(input.delivery);
  await inject(input.failure_injector, "before_admission_verification");
  const verifiedAdmission = await verifyAdmissionPackage({ package: admission, accepted_state: state, transition, recipient_delivery: delivery, evidence: input.evidence });
  if (verifiedAdmission.status !== "verified" || verifiedAdmission.full_history_verified !== false) throw new Error(verifiedAdmission.status === "rejected" ? verifiedAdmission.reason : "Admission history claim is invalid.");
  await inject(input.failure_injector, "before_recipient_epoch_open");
  await openEpochDelivery({
    envelope: delivery,
    expected_project_id: admission.core.project_id,
    expected_device_id: admission.core.admitted_device_id,
    open: (request) => input.custody.openPendingEnvelope({ project_id: admission.core.project_id, device_id: admission.core.admitted_device_id, ...request }),
    use: async (plaintext) => {
      await inject(input.failure_injector, "after_recipient_epoch_open_before_local_wrapping");
      await input.custody.installDeliveredEpoch({
        project_id: plaintext.project_id,
        device_id: admission.core.admitted_device_id,
        accepted_control_event_id: plaintext.accepted_control_event_id,
        key_epoch_id: plaintext.key_epoch_id,
        key_epoch_commitment: plaintext.key_epoch_commitment,
        public_commitment_bytes: plaintext.public_commitment_bytes,
        epoch_secret: plaintext.epoch_secret,
        admission_plan_sha256: Uint8Array.from(await sha256(admission.core.admission_boundary_sha256)),
        ceremony_id: input.ceremony_id
      });
    }
  });
  await inject(input.failure_injector, "after_local_wrapping_before_reopen");
  await input.custody.loadInstalled({ project_id: state.project_id, person_id: admission.core.admitted_person_id, device_id: admission.core.admitted_device_id,
    access_scope_id: state.memberships.find((entry) => entry.membership_id === admission.core.admitted_membership_id)?.access_scope_id ?? fail("Admitted membership is missing."),
    signing_key_id: admission.core.signing_key_id, recipient_key_id: admission.core.recipient_key_id, accepted_control_head_id: admission.core.accepted_control_event_id,
    offline_root_key_id: state.offline_root_key_id, key_epoch_id: admission.core.key_epoch_id, key_epoch_commitment: admission.core.key_epoch_commitment, device_status: "active" });
  await inject(input.failure_injector, "after_reopen_before_receipt_reservation");
  const receipt = await createEpochReceipt({ accepted_state: state, admission_package: admission, delivery, acknowledgement_sequence: input.acknowledgement_sequence,
    previous_acknowledgement_id: input.previous_acknowledgement_id,
    sign: (preimage) => input.custody.signPending({ project_id: state.project_id, device_id: admission.core.admitted_device_id, preimage }) });
  await input.reserve_receipt(receipt);
  await inject(input.failure_injector, "before_receipt_write");
  await input.write_receipt(receipt);
  await inject(input.failure_injector, "after_receipt_write_before_commit");
  await input.commit_receipt(receipt);
  const verifiedReceipt = await verifyEpochReceipt({ receipt, accepted_state: state, admission_package: admission, delivery });
  if (verifiedReceipt.status !== "verified") throw new Error(verifiedReceipt.reason);
  await inject(input.failure_injector, "before_final_completion_marker");
  await input.custody.finalizeAdmission({ project_id: state.project_id, device_id: admission.core.admitted_device_id, accepted_control_event_id: admission.core.accepted_control_event_id,
    key_epoch_id: admission.core.key_epoch_id, key_epoch_commitment: admission.core.key_epoch_commitment, ceremony_id: input.ceremony_id,
    admission_package_id: admission.admission_package_id, receipt_id: receipt.receipt_id });
  return Object.freeze({ receipt, full_history_verified: false as const });
}

async function inject(injector: CandidateAdmissionFailureInjector | undefined, stage: CandidateAdmissionFailureStage): Promise<void> { if (injector) await injector(stage); }
function fail(message: string): never { throw new Error(message); }

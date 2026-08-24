import { parseDigestId } from "../identities.ts";
import type { UInt64 } from "../validation.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveEpochReceiptIdentity,
  parseAcceptedMembershipState,
  parseAdmissionPackageRecord,
  parseEpochDeliveryEnvelope,
  parseEpochReceiptCore,
  parseEpochReceiptRecord,
  type AcceptedMembershipState,
  type AdmissionPackageRecord,
  type EpochDeliveryEnvelope,
  type EpochReceiptRecord
} from "./enrollment-contracts.ts";
import { importEncodedPublicKey } from "./providers/public-key-codec.ts";
import { HC2_CRYPTO_SUITE_ID } from "./versions.ts";

export async function createEpochReceipt(input: Readonly<{
  accepted_state: AcceptedMembershipState;
  admission_package: AdmissionPackageRecord;
  delivery: EpochDeliveryEnvelope;
  acknowledgement_sequence: UInt64;
  previous_acknowledgement_id: EpochReceiptRecord["core"]["previous_acknowledgement_id"];
  sign: (preimage: ReturnType<typeof buildEnrollmentSignaturePreimage>) => Promise<Uint8Array>;
}>): Promise<EpochReceiptRecord> {
  const state = parseAcceptedMembershipState(input.accepted_state);
  const admission = parseAdmissionPackageRecord(input.admission_package);
  const delivery = parseEpochDeliveryEnvelope(input.delivery);
  const membership = state.memberships.find((entry) => entry.membership_id === admission.core.admitted_membership_id);
  const device = state.devices.find((entry) => entry.device_id === admission.core.admitted_device_id);
  if (!membership || membership.status !== "active" || !device || device.status !== "active" || device.membership_id !== membership.membership_id ||
      admission.core.accepted_control_event_id !== state.control_head_id || admission.core.key_epoch_id !== state.current_epoch_id ||
      admission.core.key_epoch_commitment !== state.current_epoch_commitment || admission.core.recipient_delivery_id !== delivery.delivery_id ||
      delivery.header_core.recipient_device_id !== device.device_id || delivery.header_core.recipient_key_id !== device.recipient_key_id) {
    throw new Error("Epoch receipt requires exact accepted admission, device, and delivery authority.");
  }
  const core = parseEpochReceiptCore({
    schema_version: 1,
    record_kind: "epoch_delivery_receipt_core",
    authority: "none",
    project_id: state.project_id,
    person_id: membership.person_id,
    membership_id: membership.membership_id,
    role: membership.role,
    device_id: device.device_id,
    signing_key_id: device.signing_key_id,
    acknowledgement_sequence: input.acknowledgement_sequence,
    previous_acknowledgement_id: input.previous_acknowledgement_id,
    accepted_control_event_id: state.control_head_id,
    key_epoch_id: state.current_epoch_id,
    key_epoch_commitment: state.current_epoch_commitment,
    delivery_id: delivery.delivery_id,
    checkpoint_id: admission.core.checkpoint_id,
    projection_root: admission.core.projection_root,
    admission_package_id: admission.admission_package_id,
    admission_boundary_sha256: admission.core.admission_boundary_sha256,
    suite_id: HC2_CRYPTO_SUITE_ID
  });
  const identity = await deriveEpochReceiptIdentity(core);
  const signature = await input.sign(buildEnrollmentSignaturePreimage("epoch_receipt", core.project_id, identity.id));
  return parseEpochReceiptRecord({ record_version: 1, record_kind: "epoch_delivery_receipt", authority: "none", receipt_id: identity.id, core, algorithm: "ed25519", signature_bytes: signature });
}

export async function verifyEpochReceipt(input: Readonly<{
  receipt: EpochReceiptRecord;
  accepted_state: AcceptedMembershipState;
  admission_package: AdmissionPackageRecord;
  delivery: EpochDeliveryEnvelope;
  subtle?: SubtleCrypto;
}>): Promise<Readonly<{ status: "verified" }> | Readonly<{ status: "rejected"; reason: string }>> {
  try {
    const receipt = parseEpochReceiptRecord(input.receipt);
    const state = parseAcceptedMembershipState(input.accepted_state);
    const admission = parseAdmissionPackageRecord(input.admission_package);
    const delivery = parseEpochDeliveryEnvelope(input.delivery);
    const identity = await deriveEpochReceiptIdentity(receipt.core);
    if (identity.id !== receipt.receipt_id || receipt.core.project_id !== state.project_id || receipt.core.accepted_control_event_id !== state.control_head_id ||
        receipt.core.key_epoch_id !== state.current_epoch_id || receipt.core.key_epoch_commitment !== state.current_epoch_commitment ||
        receipt.core.delivery_id !== delivery.delivery_id || receipt.core.admission_package_id !== admission.admission_package_id ||
        receipt.core.checkpoint_id !== admission.core.checkpoint_id || receipt.core.projection_root !== admission.core.projection_root ||
        receipt.core.device_id !== admission.core.admitted_device_id || receipt.core.membership_id !== admission.core.admitted_membership_id ||
        receipt.core.person_id !== admission.core.admitted_person_id || receipt.core.role !== admission.core.admitted_role ||
        !sameBytes(receipt.core.admission_boundary_sha256, admission.core.admission_boundary_sha256)) throw new Error("Epoch receipt binding is invalid.");
    const device = state.devices.find((entry) => entry.device_id === receipt.core.device_id && entry.status === "active");
    if (!device || device.signing_key_id !== receipt.core.signing_key_id) throw new Error("Epoch receipt signer is not the accepted device.");
    const imported = await importEncodedPublicKey({ subtle: input.subtle ?? requireSubtle(), encoded: device.signing_public_key_bytes, expected_algorithm: "ed25519" });
    const verified = await (input.subtle ?? requireSubtle()).verify("Ed25519", imported.public_key, asArrayBuffer(receipt.signature_bytes), asArrayBuffer(buildEnrollmentSignaturePreimage("epoch_receipt", receipt.core.project_id, receipt.receipt_id)));
    if (!verified) throw new Error("Epoch receipt signature is invalid.");
    parseDigestId("control-event", receipt.core.accepted_control_event_id);
    return Object.freeze({ status: "verified" as const });
  } catch (error) { return Object.freeze({ status: "rejected" as const, reason: error instanceof Error ? error.message : "epoch_receipt_rejected" }); }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function asArrayBuffer(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
function requireSubtle(): SubtleCrypto { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable."); return globalThis.crypto.subtle; }

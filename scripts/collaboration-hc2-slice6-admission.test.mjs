import assert from "node:assert/strict";

import { deriveMarkdownBlobIdentity } from "../lib/collaboration/preimages.ts";
import { createChunkPayloadCore } from "../lib/collaboration/hc2/envelope.ts";
import {
  buildEnrollmentSignaturePreimage,
  deriveAdmissionPackageIdentity,
  deriveEpochReceiptIdentity,
  parseAdmissionPackageCore,
  parseAdmissionPackageRecord,
  parseEpochDeliveryHeaderCore,
  parseEpochReceiptCore,
  parseEpochReceiptRecord
} from "../lib/collaboration/hc2/enrollment-contracts.ts";
import { createEpochDeliveryEnvelope, openEpochDelivery } from "../lib/collaboration/hc2/epoch-delivery.ts";
import { deriveEpochCommitment } from "../lib/collaboration/hc2/epoch-custody.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { SingleShotHpkeV2Provider } from "../lib/collaboration/hc2/providers/hpke-v2-provider.ts";
import { deriveTransportStreamIdV2, prepareEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-v2-crypto.ts";
import { importEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-import.ts";
import { InMemoryTransportStreamJournalV2 } from "../lib/collaboration/hc2/transport-stream-store.ts";
import { InMemoryTransportAttachmentByteBackend, PortableTransportAttachmentStoreV2 } from "../lib/collaboration/hc2/transport-attachment-store.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";
import { HC2_TRANSPORT_PROFILE_ID } from "../lib/collaboration/hc2/transport-v2-versions.ts";

let assertions = 0;
const equal = (left, right, message) => { assertions += 1; assert.deepEqual(left, right, message); };
const check = (value, message) => { assertions += 1; assert(value, message); };
const acceptedExportAuthority = Object.freeze({
  async verify() { return Object.freeze({ status: "accepted", epoch_key_available: true }); }
});

const ids = Object.freeze({ project: entity("project", "a"), scope: entity("access-scope", "b"), ownerPerson: entity("person", "c"),
  ownerMembership: entity("membership", "d"), ownerDevice: entity("device", "e"), ownerSigning: entity("public-key", "f"), ownerRecipient: entity("public-key", "g"),
  candidatePerson: entity("person", "h"), candidateMembership: entity("membership", "j"), candidateDevice: entity("device", "k"),
  candidateSigning: entity("public-key", "m"), candidateRecipient: entity("public-key", "n"), epoch: entity("key-epoch", "p"), control: digest("control-event", "q") });

const registry = new Hc2NativeKeyRegistry(crypto.subtle);
const ownerSigning = await registry.generateDeviceSigningKey(ids.ownerSigning);
const candidateSigning = await registry.generateDeviceSigningKey(ids.candidateSigning);
const ownerRecipient = await registry.generateRecipientKeyPair(ids.ownerRecipient);
const candidateRecipient = await registry.generateRecipientKeyPair(ids.candidateRecipient);
const hpkeV1 = new SingleShotHpkeProvider({ keys: registry });
const epochSecret = new Uint8Array(32).fill(0x62);
const epoch = await deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch, epoch_secret: epochSecret });
const delivery = await createEpochDeliveryEnvelope({
  header_core: parseEpochDeliveryHeaderCore({ schema_version: 1, record_kind: "epoch_delivery_header_core", authority: "none",
    project_id: ids.project, transition_id: hc2("membership-transition", "a"), accepted_control_event_id: ids.control,
    delivery_set_id: hc2("delivery-set", "b"), recipient_manifest_id: hc2("recipient-manifest", "c"),
    key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment, recipient_membership_id: ids.candidateMembership,
    recipient_person_id: ids.candidatePerson, recipient_device_id: ids.candidateDevice, recipient_key_id: ids.candidateRecipient,
    recipient_ordinal: 0n, recipient_count: 1n, suite_id: HC2_CRYPTO_SUITE_ID }),
  recipient_public_key_bytes: candidateRecipient.public_key,
  public_commitment_bytes: epoch.public_commitment_bytes,
  epoch_secret: Uint8Array.from(epochSecret),
  hpke: hpkeV1
});
const admissionCore = parseAdmissionPackageCore({ schema_version: 1, record_kind: "current_state_admission_package_core", authority: "none",
  project_id: ids.project, transition_id: delivery.header_core.transition_id, accepted_control_action_id: digest("control-action", "d"),
  accepted_control_event_id: ids.control, resulting_control_state_root: digest("control-state-root", "e"),
  admitted_membership_id: ids.candidateMembership, admitted_person_id: ids.candidatePerson, admitted_device_id: ids.candidateDevice,
  admitted_role: "reviewer", access_scope: "project_wide", signing_key_id: ids.candidateSigning, recipient_key_id: ids.candidateRecipient,
  key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment, recipient_manifest_id: delivery.header_core.recipient_manifest_id,
  delivery_set_id: delivery.header_core.delivery_set_id, recipient_delivery_id: delivery.delivery_id, checkpoint_id: digest("semantic-event", "f"),
  projection_root: digest("projection-root", "g"), semantic_state_root: digest("semantic-state-root", "h"),
  revision_heads_root: digest("revision-heads-root", "j"), conflict_set_root: digest("conflict-set-root", "k"),
  accepted_history_root: digest("accepted-history-root", "m"), state_blob_id: digest("state-blob", "n"), snapshot_id: digest("snapshot", "p"),
  semantic_frontier: [], revision_manifest: [], conflict_manifest: [], reducer_version: "patchmark/hc1/reducer/v1",
  admission_boundary_sha256: new Uint8Array(32).fill(0x91), owner_signing_key_id: ids.ownerSigning,
  full_history_verified: false, suite_id: HC2_CRYPTO_SUITE_ID });
const admissionIdentity = await deriveAdmissionPackageIdentity(admissionCore);
const admission = parseAdmissionPackageRecord({ record_version: 1, record_kind: "current_state_admission_package", authority: "none",
  admission_package_id: admissionIdentity.id, core: admissionCore,
  owner_signature_bytes: await sign(registry, ownerSigning.handle, buildEnrollmentSignaturePreimage("admission_package", ids.project, admissionIdentity.id)) });

const markdown = new TextEncoder().encode("# Admission snapshot\n");
const blob = await deriveMarkdownBlobIdentity(ids.project, markdown);
const chunk = await createChunkPayloadCore({ project_id: ids.project, scope_id: ids.scope, sender_person_id: ids.ownerPerson,
  sender_device_id: ids.ownerDevice, recipient_device_id: ids.candidateDevice, recipient_key_id: ids.candidateRecipient,
  key_epoch_id: ids.epoch, accepted_control_head_id: ids.control, bundle_kind: "enrollment_delivery",
  objects: [{ object_kind: "markdown-blob", object_id: blob.id, exact_bytes: markdown, dependency_ids: [], dependency_depth: 0 }] });
const admissionStream = await deriveTransportStreamIdV2({ project_id: ids.project, purpose: "admission", sender_person_id: ids.ownerPerson,
  sender_membership_id: ids.ownerMembership, sender_device_id: ids.ownerDevice, recipient_person_id: ids.candidatePerson,
  recipient_membership_id: ids.candidateMembership, recipient_device_id: ids.candidateDevice, recipient_key_id: ids.candidateRecipient, stream_generation: 0n });
const admissionCommon = common({ purpose: "admission", senderPerson: ids.ownerPerson, senderMembership: ids.ownerMembership,
  senderDevice: ids.ownerDevice, senderSigning: ids.ownerSigning, recipientAuthority: "candidate_transition", recipientPerson: ids.candidatePerson,
  recipientMembership: ids.candidateMembership, recipientDevice: ids.candidateDevice, recipientKey: ids.candidateRecipient,
  streamId: admissionStream, payloadCount: 4 });
const admissionBundle = await prepareEncryptedTransportBundleV2({ common_binding: admissionCommon,
  non_manifest_payloads: [
    { schema_version: 2, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk },
    { schema_version: 2, payload_kind: "admission_attachment", admission_package: admission },
    { schema_version: 2, payload_kind: "epoch_delivery_attachment", epoch_delivery: delivery }
  ], recipient_public_key: candidateRecipient.public_key, random: randomSource(0x71), signatures: signatureProvider(registry, ownerSigning.handle, ownerSigning.public_key),
  authority: acceptedExportAuthority, hpke: new SingleShotHpkeV2Provider({ keys: registry }) });

for (const cut of ["after_staging", "after_data", "after_attachment_marker", "before_batch_marker"]) {
  const backend = new InMemoryTransportAttachmentByteBackend();
  const failing = new PortableTransportAttachmentStoreV2({ backend, inject_failure(stage) { if (stage === cut) throw new Error(`injected_${cut}`); } });
  const attachment = await failing.createAttachment(ids.project, { schema_version: 2, payload_kind: "admission_attachment", admission_package: admission });
  assertions += 1;
  await assert.rejects(() => failing.commitBatch({ project_id: ids.project, manifest_id: admissionBundle.manifest_id, attachments: [attachment], hc1_object_ids: [] }), new RegExp(`injected_${cut}`));
  equal(await failing.readVisibleBatch(admissionBundle.manifest_id), null, `${cut} cannot publish a partial HC-2 import batch`);
}
{
  const failing = new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() });
  const attachment = await failing.createAttachment(ids.project, { schema_version: 2, payload_kind: "admission_attachment", admission_package: admission });
  assertions += 1;
  await assert.rejects(() => failing.commitBatch({ project_id: ids.project, manifest_id: admissionBundle.manifest_id, attachments: [attachment], hc1_object_ids: [],
    async before_visibility() { throw new Error("injected_admission_completion"); } }), /injected_admission_completion/);
  equal(await failing.readVisibleBatch(admissionBundle.manifest_id), null, "failed admission completion cannot publish the combined marker");
}

{
  const baseStreams = new InMemoryTransportStreamJournalV2();
  let failFinalization = true;
  const streams = {
    classifyInbound: (input) => baseStreams.classifyInbound(input),
    async commitInbound(input) {
      if (failFinalization) {
        failFinalization = false;
        return Object.freeze({ status: "conflict" });
      }
      return baseStreams.commitInbound(input);
    }
  };
  const backend = new InMemoryTransportAttachmentByteBackend();
  const attachments = new PortableTransportAttachmentStoreV2({ backend });
  const hc1Bytes = new Map();
  const input = {
    containers: admissionBundle.containers,
    recipient_key_pair: candidateRecipient,
    signatures: signatureProvider(registry, ownerSigning.handle, ownerSigning.public_key),
    hpke: new SingleShotHpkeV2Provider({ keys: registry }),
    authority: {
      async verify() { return Object.freeze({ status: "accepted", epoch_key_available: true }); },
      async installAdmissionBeforeVisibility() {}
    },
    streams,
    hc1: {
      async stageAndCommitObject(value) { hc1Bytes.set(value.object_id, Uint8Array.from(value.exact_bytes)); },
      async hasCommittedObject(id) { return hc1Bytes.has(id); }
    },
    attachments
  };
  const interrupted = await importEncryptedTransportBundleV2(input);
  equal([interrupted.status, interrupted.reason], ["rejected", "atomic_commit_failed"],
    "failure after batch visibility but before stream finalization is reported without advancing continuity");
  check((await attachments.readVisibleBatch(admissionBundle.manifest_id, (id) => input.hc1.hasCommittedObject(id))) !== null,
    "the durable batch marker survives a post-visibility stream finalization failure");
  const resumed = await importEncryptedTransportBundleV2(input);
  equal(resumed.status, "imported", "an exact retry idempotently reopens the durable batch and finalizes the stream CAS");
}

let installedEpoch = null;
let installCalls = 0;
const targetBytes = new Map();
const attachmentStore = new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() });
const imported = await importEncryptedTransportBundleV2({ containers: admissionBundle.containers, recipient_key_pair: candidateRecipient,
  signatures: signatureProvider(registry, ownerSigning.handle, ownerSigning.public_key), hpke: new SingleShotHpkeV2Provider({ keys: registry }),
  authority: {
    async verify({ common_binding, payloads }) {
      const packagePayload = payloads.find((entry) => entry.payload_kind === "admission_attachment");
      const deliveryPayload = payloads.find((entry) => entry.payload_kind === "epoch_delivery_attachment");
      const validOwner = await verify(registry, ownerSigning.public_key, buildEnrollmentSignaturePreimage("admission_package", ids.project, admissionIdentity.id), admission.owner_signature_bytes);
      return packagePayload?.admission_package.admission_package_id === admissionIdentity.id && deliveryPayload?.epoch_delivery.delivery_id === delivery.delivery_id &&
        common_binding.accepted_control_head_id === admission.core.accepted_control_event_id && common_binding.key_epoch_commitment === admission.core.key_epoch_commitment &&
        admission.core.full_history_verified === false && validOwner ? { status: "accepted", epoch_key_available: true } : { status: "rejected", reason: "admission_binding" };
    },
    async installAdmissionBeforeVisibility() {
      installCalls += 1;
      await openEpochDelivery({ envelope: delivery, expected_project_id: ids.project, expected_device_id: ids.candidateDevice,
        open: (value) => hpkeV1.openBound({ recipient_key_pair: candidateRecipient, ...value }),
        use(plaintext) { installedEpoch = Uint8Array.from(plaintext.epoch_secret); } });
    }
  }, streams: new InMemoryTransportStreamJournalV2(),
  hc1: { async stageAndCommitObject(value) { targetBytes.set(value.object_id, Uint8Array.from(value.exact_bytes)); }, async hasCommittedObject(id) { return targetBytes.has(id); } },
  attachments: attachmentStore });
equal(imported.status, "imported", "candidate imports the verified admission bundle");
equal(imported.full_history_verified, false, "current-state admission never upgrades to full-history verification");
equal(installCalls, 1, "accepted state and epoch installation runs exactly once before visibility marker");
equal(installedEpoch, epochSecret, "candidate installs the exact authenticated replacement epoch");
check((await attachmentStore.readVisibleBatch(admissionBundle.manifest_id)) !== null, "combined HC-1 and HC-2 batch becomes visible only after admission install");

const receiptCore = parseEpochReceiptCore({ schema_version: 1, record_kind: "epoch_delivery_receipt_core", authority: "none", project_id: ids.project,
  person_id: ids.candidatePerson, membership_id: ids.candidateMembership, role: "reviewer", device_id: ids.candidateDevice,
  signing_key_id: ids.candidateSigning, acknowledgement_sequence: 0n, previous_acknowledgement_id: null,
  accepted_control_event_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment,
  delivery_id: delivery.delivery_id, checkpoint_id: admission.core.checkpoint_id, projection_root: admission.core.projection_root,
  admission_package_id: admission.admission_package_id, admission_boundary_sha256: admission.core.admission_boundary_sha256,
  suite_id: HC2_CRYPTO_SUITE_ID });
const receiptIdentity = await deriveEpochReceiptIdentity(receiptCore);
const receipt = parseEpochReceiptRecord({ record_version: 1, record_kind: "epoch_delivery_receipt", authority: "none", receipt_id: receiptIdentity.id,
  core: receiptCore, algorithm: "ed25519", signature_bytes: await sign(registry, candidateSigning.handle,
    buildEnrollmentSignaturePreimage("epoch_receipt", ids.project, receiptIdentity.id)) });
const receiptStream = await deriveTransportStreamIdV2({ project_id: ids.project, purpose: "replication", sender_person_id: ids.candidatePerson,
  sender_membership_id: ids.candidateMembership, sender_device_id: ids.candidateDevice, recipient_person_id: ids.ownerPerson,
  recipient_membership_id: ids.ownerMembership, recipient_device_id: ids.ownerDevice, recipient_key_id: ids.ownerRecipient, stream_generation: 0n });
const receiptBundle = await prepareEncryptedTransportBundleV2({ common_binding: common({ purpose: "replication", senderPerson: ids.candidatePerson,
  senderMembership: ids.candidateMembership, senderDevice: ids.candidateDevice, senderSigning: ids.candidateSigning,
  recipientAuthority: "accepted_member", recipientPerson: ids.ownerPerson, recipientMembership: ids.ownerMembership,
  recipientDevice: ids.ownerDevice, recipientKey: ids.ownerRecipient, streamId: receiptStream, payloadCount: 2 }),
  non_manifest_payloads: [{ schema_version: 2, payload_kind: "receipt_attachment", epoch_receipt: receipt }],
  recipient_public_key: ownerRecipient.public_key, authority: acceptedExportAuthority,
  random: randomSource(0x81), signatures: signatureProvider(registry, candidateSigning.handle, candidateSigning.public_key),
  hpke: new SingleShotHpkeV2Provider({ keys: registry }) });
const reverse = await importEncryptedTransportBundleV2({ containers: receiptBundle.containers, recipient_key_pair: ownerRecipient,
  signatures: signatureProvider(registry, candidateSigning.handle, candidateSigning.public_key), hpke: new SingleShotHpkeV2Provider({ keys: registry }),
  authority: { async verify({ payloads }) { const value = payloads.find((entry) => entry.payload_kind === "receipt_attachment");
    const valid = await verify(registry, candidateSigning.public_key, buildEnrollmentSignaturePreimage("epoch_receipt", ids.project, receiptIdentity.id), receipt.signature_bytes);
    return value?.epoch_receipt.receipt_id === receiptIdentity.id && valid ? { status: "accepted", epoch_key_available: true } : { status: "rejected", reason: "receipt" }; } },
  streams: new InMemoryTransportStreamJournalV2(), hc1: { async stageAndCommitObject() {}, async hasCommittedObject() { return false; } },
  attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
equal(reverse.status, "imported", "owner imports the separately signed reverse receipt attachment");
equal(reverse.attachment_count, 1, "reverse receipt remains first-class HC-2 attachment evidence");
process.stdout.write(`${JSON.stringify({ assertions, admission_status: imported.status, reverse_receipt_status: reverse.status,
  full_history_verified: imported.full_history_verified, epoch_installed_before_visibility: true, status: "ok" }, null, 2)}\n`);

function common(value) { return Object.freeze({ transport_profile_id: HC2_TRANSPORT_PROFILE_ID, project_id: ids.project, purpose: value.purpose,
  sender_person_id: value.senderPerson, sender_membership_id: value.senderMembership, sender_device_id: value.senderDevice,
  sender_signing_key_id: value.senderSigning, recipient_authority: value.recipientAuthority, recipient_person_id: value.recipientPerson,
  recipient_membership_id: value.recipientMembership, recipient_device_id: value.recipientDevice, recipient_key_id: value.recipientKey,
  accepted_control_head_id: ids.control, key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment,
  stream_id: value.streamId, stream_generation: 0n, bundle_sequence: 0n, previous_bundle_manifest_id: null,
  payload_count: value.payloadCount, limit_profile_id: HC2_LIMIT_PROFILE_ID, crypto_suite_id: HC2_CRYPTO_SUITE_ID }); }
function signatureProvider(registry, handle, publicKey) { return { sign: (preimage) => sign(registry, handle, preimage), verify: ({ preimage, signature_bytes }) => verify(registry, publicKey, preimage, signature_bytes) }; }
async function sign(registry, handle, preimage) { return new Uint8Array(await registry.subtle.sign("Ed25519", registry.resolveSigningKey(handle), preimage)); }
async function verify(registry, encoded, preimage, signature) { const key = await importEncodedPublicKey({ subtle: registry.subtle, encoded, expected_algorithm: "ed25519" }); return registry.subtle.verify("Ed25519", key.public_key, signature, preimage); }
function randomSource(fill) { return { async randomBytes(length) { return new Uint8Array(length).fill(fill); } }; }
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hc2(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }

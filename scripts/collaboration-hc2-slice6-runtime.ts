/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- cross-runtime evidence intentionally exercises branded protocols through strict runtime parsers.
import { deriveMarkdownBlobIdentity } from "../lib/collaboration/preimages.ts";
import { createChunkPayloadCore } from "../lib/collaboration/hc2/envelope.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { SingleShotHpkeV2Provider } from "../lib/collaboration/hc2/providers/hpke-v2-provider.ts";
import { parsePublicEnvelopeHeaderV2 } from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import {
  deriveTransportStreamIdV2,
  openEncryptedTransportContainerV2,
  prepareEncryptedTransportBundleV2
} from "../lib/collaboration/hc2/transport-v2-crypto.ts";
import {
  InMemoryTransportStreamJournalV2,
  IndexedDbTransportStreamJournalV2
} from "../lib/collaboration/hc2/transport-stream-store.ts";
import {
  InMemoryTransportAttachmentByteBackend,
  PortableTransportAttachmentStoreV2
} from "../lib/collaboration/hc2/transport-attachment-store.ts";
import { importEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-import.ts";
import { exportEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-export.ts";
import {
  readCanonicalTransportBundleV2,
  writeCanonicalTransportBundleV2
} from "../lib/collaboration/hc2/transport-bundle-framing.ts";
import { parsePublicEnvelopeHeader } from "../lib/collaboration/hc2/envelope.ts";
import { HC2_CRYPTO_SUITE_ID, HC2_LIMIT_PROFILE_ID } from "../lib/collaboration/hc2/versions.ts";
import { HC2_TRANSPORT_PROFILE_ID, HC2_TRANSPORT_SCHEMA_VERSION } from "../lib/collaboration/hc2/transport-v2-versions.ts";

const ids = Object.freeze({
  project: entity("project", "a"), scope: entity("access-scope", "b"), senderPerson: entity("person", "c"),
  senderMembership: entity("membership", "d"), senderDevice: entity("device", "e"), senderSigning: entity("public-key", "f"),
  recipientPerson: entity("person", "g"), recipientMembership: entity("membership", "h"), recipientDevice: entity("device", "j"),
  recipientKey: entity("public-key", "k"), epoch: entity("key-epoch", "m"), control: digest("control-event", "n"),
  epochCommitment: digest("key-epoch-commitment", "p")
});
const acceptedExportAuthority = Object.freeze({
  async verify() { return Object.freeze({ status: "accepted", epoch_key_available: true }); }
});

export async function runSlice6CoreEvidence() {
  const registry = new Hc2NativeKeyRegistry(crypto.subtle);
  const signing = await registry.generateDeviceSigningKey(ids.senderSigning);
  const recipient = await registry.generateRecipientKeyPair(ids.recipientKey);
  const signatureProvider = signatures(registry, signing.handle, signing.public_key);
  const hpke = new SingleShotHpkeV2Provider({ keys: registry });
  const markdown = new TextEncoder().encode("# HC-2 Slice 6\n\nPortable encrypted replication.\n");
  const blob = await deriveMarkdownBlobIdentity(ids.project, markdown);
  const chunk = await createChunkPayloadCore({
    project_id: ids.project,
    scope_id: ids.scope,
    sender_person_id: ids.senderPerson,
    sender_device_id: ids.senderDevice,
    recipient_device_id: ids.recipientDevice,
    recipient_key_id: ids.recipientKey,
    key_epoch_id: ids.epoch,
    accepted_control_head_id: ids.control,
    bundle_kind: "collaboration_exchange",
    objects: [{ object_kind: "markdown-blob", object_id: blob.id, exact_bytes: markdown, dependency_ids: [], dependency_depth: 0 }]
  });
  const streamId = await deriveTransportStreamIdV2({
    project_id: ids.project,
    purpose: "replication",
    sender_person_id: ids.senderPerson,
    sender_membership_id: ids.senderMembership,
    sender_device_id: ids.senderDevice,
    recipient_person_id: ids.recipientPerson,
    recipient_membership_id: ids.recipientMembership,
    recipient_device_id: ids.recipientDevice,
    recipient_key_id: ids.recipientKey,
    stream_generation: 0n
  });
  const common = Object.freeze({
    transport_profile_id: HC2_TRANSPORT_PROFILE_ID,
    project_id: ids.project,
    purpose: "replication",
    sender_person_id: ids.senderPerson,
    sender_membership_id: ids.senderMembership,
    sender_device_id: ids.senderDevice,
    sender_signing_key_id: ids.senderSigning,
    recipient_authority: "accepted_member",
    recipient_person_id: ids.recipientPerson,
    recipient_membership_id: ids.recipientMembership,
    recipient_device_id: ids.recipientDevice,
    recipient_key_id: ids.recipientKey,
    accepted_control_head_id: ids.control,
    key_epoch_id: ids.epoch,
    key_epoch_commitment: ids.epochCommitment,
    stream_id: streamId,
    stream_generation: 0n,
    bundle_sequence: 0n,
    previous_bundle_manifest_id: null,
    payload_count: 2,
    limit_profile_id: HC2_LIMIT_PROFILE_ID,
    crypto_suite_id: HC2_CRYPTO_SUITE_ID
  });
  const bundle = await prepareEncryptedTransportBundleV2({
    common_binding: common,
    non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
    recipient_public_key: recipient.public_key,
    authority: acceptedExportAuthority,
    random: fixedRandom(),
    signatures: signatureProvider,
    hpke
  });
  const forbidden = ["project_id", "person_id", "membership_id", "device_id", "control", "epoch", "purpose", "stream_id"];
  const publicHeaderKeys = Object.keys(bundle.containers[0].core.public_header).sort();
  const publicHeaderText = JSON.stringify(bundle.containers.map((entry) => entry.core.public_header), (_, child) => typeof child === "bigint" ? child.toString() : child);
  const publicPrivacy = forbidden.every((term) => !publicHeaderText.includes(term));
  let v1RejectsV2 = false;
  try { parsePublicEnvelopeHeader(bundle.containers[0].core.public_header); } catch { v1RejectsV2 = true; }
  let v2RejectsV1 = false;
  try { parsePublicEnvelopeHeaderV2({ ...bundle.containers[0].core.public_header, envelope_version: 1 }); } catch { v2RejectsV1 = true; }
  const fileChunks = [];
  const written = await writeCanonicalTransportBundleV2({
    containers: bundle.containers,
    sink: {
      async write(bytes) { fileChunks.push(Uint8Array.from(bytes)); },
      async close() {},
      async abort() { fileChunks.length = 0; }
    },
    sha256: nodeHasher()
  });
  const fileBytes = concat(fileChunks);
  const reread = [];
  const reopened = await readCanonicalTransportBundleV2({
    source: { async *chunks() { for (let offset = 0; offset < fileBytes.length; offset += 37) yield fileBytes.slice(offset, offset + 37); } },
    sha256: nodeHasher(),
    async on_container(container, exact) { reread.push({ container, exact }); }
  });
  const targetBytes = new Map();
  const openDiagnostics = [];
  for (const container of reread.map((entry) => entry.container)) openDiagnostics.push(await openEncryptedTransportContainerV2({ container, recipient_key_pair: recipient, signatures: signatureProvider, hpke }));
  const attachments = new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() });
  const streams = new InMemoryTransportStreamJournalV2();
  const target = {
    async stageAndCommitObject(value) { targetBytes.set(value.object_id, Uint8Array.from(value.exact_bytes)); },
    async hasCommittedObject(id) { return targetBytes.has(id); }
  };
  const authority = { async verify() { return { status: "accepted", epoch_key_available: true }; } };
  const imported = await importEncryptedTransportBundleV2({
    containers: reread.map((entry) => entry.container),
    recipient_key_pair: recipient,
    signatures: signatureProvider,
    hpke,
    authority,
    streams,
    hc1: target,
    attachments
  });
  const duplicate = await importEncryptedTransportBundleV2({
    containers: reread.map((entry) => entry.container), recipient_key_pair: recipient, signatures: signatureProvider,
    hpke, authority, streams, hc1: target, attachments
  });
  const tampered = structuredClone(bundle.containers);
  tampered[0].core.ciphertext_bytes[tampered[0].core.ciphertext_bytes.length - 1] ^= 1;
  const rejectedTamper = await importEncryptedTransportBundleV2({
    containers: tampered, recipient_key_pair: recipient, signatures: signatureProvider,
    hpke, authority, streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() })
  });
  const wrongRecipient = await registry.generateRecipientKeyPair(entity("public-key", "z"));
  const wrongRecipientResult = await importEncryptedTransportBundleV2({ containers: bundle.containers, recipient_key_pair: wrongRecipient,
    signatures: signatureProvider, hpke, authority, streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const missingContainer = await importEncryptedTransportBundleV2({ containers: bundle.containers.slice(0, 1), recipient_key_pair: recipient,
    signatures: signatureProvider, hpke, authority, streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const reordered = await importEncryptedTransportBundleV2({ containers: [...bundle.containers].reverse(), recipient_key_pair: recipient,
    signatures: signatureProvider, hpke, authority, streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const staleAuthority = await importEncryptedTransportBundleV2({ containers: bundle.containers, recipient_key_pair: recipient,
    signatures: signatureProvider, hpke, authority: { async verify() { return { status: "rejected", reason: "stale_control_head" }; } },
    streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const unavailableEpoch = await importEncryptedTransportBundleV2({ containers: bundle.containers, recipient_key_pair: recipient,
    signatures: signatureProvider, hpke, authority: { async verify() { return { status: "accepted", epoch_key_available: false }; } },
    streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const invalidSignatureBundle = await prepareEncryptedTransportBundleV2({ common_binding: common,
    non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
    recipient_public_key: recipient.public_key, authority: acceptedExportAuthority, random: fixedRandom(),
    signatures: { async sign() { return new Uint8Array(64); }, async verify() { return false; } },
    hpke: new SingleShotHpkeV2Provider({ keys: registry }) });
  const invalidSignature = await importEncryptedTransportBundleV2({ containers: invalidSignatureBundle.containers, recipient_key_pair: recipient,
    signatures: signatureProvider, hpke, authority, streams: new InMemoryTransportStreamJournalV2(), hc1: target,
    attachments: new PortableTransportAttachmentStoreV2({ backend: new InMemoryTransportAttachmentByteBackend() }) });
  const outputChunks = [];
  const exportStreams = new InMemoryTransportStreamJournalV2();
  const exportInput = { bundle, streams: exportStreams,
    async create_sink() { outputChunks.length = 0; return { async write(bytes) { outputChunks.push(Uint8Array.from(bytes)); }, async close() {}, async abort() { outputChunks.length = 0; } }; },
    async reopen_source() { const exact = concat(outputChunks); return { async *chunks() { for (let offset = 0; offset < exact.length; offset += 41) yield exact.slice(offset, offset + 41); } }; },
    create_sha256: nodeHasher };
  const exported = await exportEncryptedTransportBundleV2(exportInput);
  const exportRetry = await exportEncryptedTransportBundleV2(exportInput);
  let abortedOnPartialWrite = false;
  let partialWriteRejected = false;
  try {
    let writes = 0;
    await writeCanonicalTransportBundleV2({ containers: bundle.containers,
      sink: { async write() { writes += 1; if (writes === 2) throw new Error("injected_partial_write"); }, async close() {}, async abort() { abortedOnPartialWrite = true; } },
      sha256: nodeHasher() });
  } catch { partialWriteRejected = true; }
  let signatureCreationRejected = false;
  try {
    await prepareEncryptedTransportBundleV2({ common_binding: common,
      non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
      recipient_public_key: recipient.public_key, authority: acceptedExportAuthority, random: fixedRandom(),
      signatures: { async sign() { throw new Error("injected_signature_failure"); }, async verify() { return false; } }, hpke });
  } catch { signatureCreationRejected = true; }
  let hpkeSetupRejected = false;
  try {
    await prepareEncryptedTransportBundleV2({ common_binding: common,
      non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
      recipient_public_key: recipient.public_key, authority: acceptedExportAuthority, random: fixedRandom(), signatures: signatureProvider,
      hpke: { async sealBound() { throw new Error("injected_hpke_setup_failure"); }, async openBound() { return { status: "rejected", reason: "authentication_failed" }; } } });
  } catch { hpkeSetupRejected = true; }
  let rejectedExportCryptoCalls = 0;
  let exportAuthorityRejected = false;
  try {
    await prepareEncryptedTransportBundleV2({ common_binding: common,
      non_manifest_payloads: [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk }],
      recipient_public_key: recipient.public_key,
      authority: { async verify() { return { status: "rejected", reason: "recipient_revoked" }; } },
      random: { async randomBytes(length) { rejectedExportCryptoCalls += 1; return new Uint8Array(length); } },
      signatures: { async sign() { rejectedExportCryptoCalls += 1; return new Uint8Array(64); }, async verify() { return false; } },
      hpke: { async sealBound() { rejectedExportCryptoCalls += 1; throw new Error("unreachable"); }, async openBound() { return { status: "rejected", reason: "authentication_failed" }; } } });
  } catch { exportAuthorityRejected = true; }
  return clean({
    bundle_manifest_id: bundle.manifest_id,
    container_ids: bundle.containers.map((entry) => entry.container_id),
    public_header_keys: publicHeaderKeys,
    public_privacy: publicPrivacy,
    v1_rejects_v2: v1RejectsV2,
    v2_rejects_v1: v2RejectsV1,
    file_bytes: Number(written.byte_length),
    file_sha256: hex(written.sha256),
    reopen_same_length: written.byte_length === reopened.byte_length,
    reopen_same_digest: hex(written.sha256) === hex(reopened.sha256),
    imported_status: imported.status,
    open_diagnostics: openDiagnostics.map((entry) => entry.status === "opened" ? "opened" : entry.reason),
    imported_reason: imported.status === "rejected" ? `${imported.reason}:${imported.detail ?? ""}` : null,
    duplicate_status: duplicate.status,
    duplicate_reason: duplicate.status === "rejected" ? `${duplicate.reason}:${duplicate.detail ?? ""}` : null,
    tamper_status: rejectedTamper.status,
    tamper_reason: rejectedTamper.status === "rejected" ? rejectedTamper.reason : null,
    wrong_recipient_reason: wrongRecipientResult.status === "rejected" ? wrongRecipientResult.reason : null,
    missing_container_reason: missingContainer.status === "rejected" ? missingContainer.reason : null,
    reordered_reason: reordered.status === "rejected" ? reordered.reason : null,
    stale_authority_reason: staleAuthority.status === "rejected" ? staleAuthority.reason : null,
    unavailable_epoch_reason: unavailableEpoch.status === "rejected" ? unavailableEpoch.reason : null,
    invalid_signature_reason: invalidSignature.status === "rejected" ? invalidSignature.reason : null,
    export_status: exported.status,
    export_retry_status: exportRetry.status,
    partial_write_rejected: partialWriteRejected,
    partial_write_aborted: abortedOnPartialWrite,
    signature_creation_rejected: signatureCreationRejected,
    hpke_setup_rejected: hpkeSetupRejected,
    export_authority_rejected_before_crypto: exportAuthorityRejected && rejectedExportCryptoCalls === 0,
    imported_object_byte_identical: hex(targetBytes.get(blob.id)) === hex(markdown),
    hpke_evidence: hpke.evidence()
  });
}

export async function runIndexedDbTransportEvidence(databaseName) {
  const journal = new IndexedDbTransportStreamJournalV2({ indexed_db: indexedDB, database_name: databaseName });
  await journal.open();
  const stream = Object.freeze({ project_id: ids.project, purpose: "replication", sender_person_id: ids.senderPerson,
    sender_membership_id: ids.senderMembership, sender_device_id: ids.senderDevice, sender_signing_key_id: ids.senderSigning,
    recipient_person_id: ids.recipientPerson, recipient_membership_id: ids.recipientMembership, recipient_device_id: ids.recipientDevice,
    recipient_key_id: ids.recipientKey, stream_id: `pm:transport-stream:v2:${"r".repeat(51)}a`, stream_generation: 0n });
  const first = `pm:bundle-manifest:v2:${"s".repeat(51)}a`;
  const competitor = `pm:bundle-manifest:v2:${"t".repeat(51)}a`;
  const reserved = await journal.reserveOutbound({ stream, manifest_id: first, bundle_sequence: 0n, previous_manifest_id: null });
  const conflict = await journal.reserveOutbound({ stream, manifest_id: competitor, bundle_sequence: 0n, previous_manifest_id: null });
  await journal.appendOutboundContainer({ stream, manifest_id: first, ordinal: 0, exact_bytes: Uint8Array.of(1, 2, 3) });
  await journal.markOutboundReopenedVerified({ stream, manifest_id: first,
    evidence: { byte_length: 3n, sha256: new Uint8Array(32), container_ids: [`pm:encrypted-container:v2:${"u".repeat(51)}a`] } });
  const completed = await journal.completeOutbound({ stream, manifest_id: first });
  await journal.commitInbound({ stream, manifest_id: first, bundle_sequence: 0n, previous_manifest_id: null });
  journal.close();
  const reopened = new IndexedDbTransportStreamJournalV2({ indexed_db: indexedDB, database_name: databaseName });
  await reopened.open();
  const plan = await reopened.readOutbound(stream, first);
  const inbound = await reopened.classifyInbound({ stream, manifest_id: first, bundle_sequence: 0n, previous_manifest_id: null });
  await reopened.deleteDatabase();
  return clean({ reserved: reserved.status, competing_reservation: conflict.status, completed: completed.status,
    reopened_status: plan?.status ?? null, reopened_exact_bytes: plan ? hex(plan.exact_container_bytes[0]) : null,
    inbound_after_reopen: inbound, database_deleted: true });
}

function signatures(registry, handle, encodedPublic) {
  return {
    async sign(preimage) { return new Uint8Array(await registry.subtle.sign("Ed25519", registry.resolveSigningKey(handle), preimage)); },
    async verify({ preimage, signature_bytes }) {
      const imported = await importEncodedPublicKey({ subtle: registry.subtle, encoded: encodedPublic, expected_algorithm: "ed25519" });
      return registry.subtle.verify("Ed25519", imported.public_key, signature_bytes, preimage);
    }
  };
}

function fixedRandom() { let value = 0x40; return { async randomBytes(length) { const result = new Uint8Array(length).fill(value); value += 1; return result; } }; }
function nodeHasher() { const chunks = []; return { update(bytes) { chunks.push(Uint8Array.from(bytes)); }, async digest() { return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(chunks))); } }; }
function concat(chunks) { const length = chunks.reduce((sum, entry) => sum + entry.length, 0); const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes; }
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hex(value) { return Array.from(value ?? [], (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }

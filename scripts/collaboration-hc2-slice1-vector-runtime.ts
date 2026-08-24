import { bytesToHex, hexToBytes } from "../lib/collaboration/bytes.ts";
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { deriveMarkdownBlobIdentity } from "../lib/collaboration/preimages.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";
import { classifyHc2Record, hc2AuthorityClasses, type Hc2RecordKind } from "../lib/collaboration/hc2/authority.ts";
import {
  buildEnvelopeAad,
  buildEnvelopeSignaturePreimage,
  buildHpkeInfo,
  createChunkPayloadCore,
  createEncryptedContainerRecord,
  deriveBundleRoot,
  deriveChunkCommitment,
  parseEncryptedContainerCore,
  parseSignedPlaintextCore,
  parseSignedPlaintextRecord,
  validateSignedPlaintextRecordCiphertextLength,
  type PublicEnvelopeHeader
} from "../lib/collaboration/hc2/envelope.ts";
import { deriveHc2Identity } from "../lib/collaboration/hc2/identities.ts";
import {
  calculateEncryptedContainerBudgetBytes,
  calculateHc2AesGcmCiphertextLength,
  calculatePortableBundleEncodedLength,
  calculateRequiredQuotaBytes,
  hc2ProtocolLimits
} from "../lib/collaboration/hc2/limits.ts";
import {
  buildWriterContinuitySignaturePreimage,
  createObjectCommitMarker,
  createPortableBatchMarker,
  deriveRecoveryRecipientEpochEnvelope,
  deriveTransactionIntentCommitment,
  deriveWriterContinuityIdentity,
  encodeMaterializationStatus,
  encodeReplicaMetadataCore,
  parseMaterializationStatus,
  parseReplicaMetadataCore
} from "../lib/collaboration/hc2/records.ts";
import {
  HC2_ENVELOPE_VERSION,
  HC2_HPKE_INFO_PROTOCOL_DOMAIN,
  HC2_MATERIALIZATION_SCHEMA_VERSION,
  HC2_REPLICA_SCHEMA_VERSION,
  HC2_TRANSACTION_INTENT_SCHEMA_VERSION,
  HC2_WRITER_CONTINUITY_SCHEMA_VERSION
} from "../lib/collaboration/hc2/versions.ts";

type VectorInput = Readonly<{
  profile: "patchmark-hc2-slice1-v1";
  ids: Readonly<Record<string, string>>;
  operation_id: string;
  envelope_id: string;
  markdown_utf8_hex: string;
  fixed_bytes: Readonly<{
    writer_signature_hex: string;
    envelope_signature_hex: string;
    hpke_enc_hex: string;
    recipient_tag_hex: string;
    ciphertext_hex: string;
    recovery_envelope_hex: string;
  }>;
  expected?: unknown;
}>;

export async function createHc2Slice1VectorActual(vectors: VectorInput) {
  if (vectors.profile !== "patchmark-hc2-slice1-v1") {
    throw new Error("Unknown HC-2 Slice 1 vector profile.");
  }
  const ids = vectors.ids;
  const markdownBytes = hexToBytes(vectors.markdown_utf8_hex);
  const markdown = await deriveMarkdownBlobIdentity(ids.project as never, markdownBytes);
  const objectMarker = await createObjectCommitMarker({
    project_id: ids.project as never,
    object_kind: "markdown-blob",
    object_id: markdown.id,
    exact_stored_bytes: markdownBytes
  });
  const writerCore = {
    schema_version: HC2_WRITER_CONTINUITY_SCHEMA_VERSION,
    record_kind: "writer_continuity_evidence" as const,
    project_id: ids.project as never,
    device_id: ids.device as never,
    evidence_sequence: BigInt(0),
    previous_continuity_id: null,
    transition: "same_device_continuation" as const,
    previous_device_id: null,
    operation_id: vectors.operation_id as never,
    predecessor_batch_id: null,
    authority: "operational_evidence_only" as const
  };
  const writer = await deriveWriterContinuityIdentity({
    core: writerCore,
    signer_device_id: ids.device as never,
    signature_algorithm: "ed25519",
    signature_bytes: hexToBytes(vectors.fixed_bytes.writer_signature_hex)
  });
  const batch = await createPortableBatchMarker({
    project_id: ids.project as never,
    predecessor_batch_id: null,
    object_entries: [{
      object_kind: "markdown-blob",
      object_id: markdown.id,
      stored_length: BigInt(markdownBytes.length),
      stored_sha256: objectMarker.core.stored_sha256,
      dependency_ids: [],
      object_commit_marker_id: objectMarker.marker_id
    }],
    writer_continuity_id: writer.continuity_id,
    storage_schema_version: 1,
    protocol_version: 1,
    recovery_policy: "mandatory_before_collaboration"
  });
  const signedBytesCommitment = await sha256(markdownBytes);
  const transaction = await deriveTransactionIntentCommitment({
    schema_version: HC2_TRANSACTION_INTENT_SCHEMA_VERSION,
    record_kind: "transaction_intent",
    project_id: ids.project as never,
    device_id: ids.device as never,
    operation_id: vectors.operation_id as never,
    expected_generation: BigInt(0),
    expected_sequence: null,
    expected_previous_object_id: null,
    planned_objects: [{
      object_kind: "markdown-blob",
      object_id: markdown.id,
      signed_bytes_commitment: signedBytesCommitment
    }],
    intended_batch_id: batch.batch_id,
    state: "pending",
    authority: "local_transactional_only"
  });
  const replica = parseReplicaMetadataCore({
    schema_version: HC2_REPLICA_SCHEMA_VERSION,
    record_kind: "portable_replica_metadata",
    project_id: ids.project,
    collaboration_schema_version: 1,
    storage_schema_version: 1,
    addressing_version: 1,
    protocol_name: "patchmark.human-collaboration",
    protocol_version: 1,
    bootstrap_control_event_id: ids.control_head,
    at_rest_disclosure_version: 1,
    recovery_policy: "mandatory_before_collaboration"
  });
  const recovery = await deriveRecoveryRecipientEpochEnvelope({
    schema_version: 1,
    record_kind: "recovery_recipient_epoch_envelope",
    project_id: ids.project as never,
    key_epoch_id: ids.key_epoch as never,
    recipient_kind: "person_recovery_key",
    recipient_key_id: ids.recovery_key as never,
    suite_id: "patchmark/hc2/crypto-suite/v1",
    encrypted_epoch_bytes: hexToBytes(vectors.fixed_bytes.recovery_envelope_hex),
    authority: "portable_encrypted_recovery"
  });
  const materialization = parseMaterializationStatus({
    schema_version: HC2_MATERIALIZATION_SCHEMA_VERSION,
    record_kind: "materialization_status",
    project_id: ids.project,
    projection_root_id: ids.projection_root,
    checkpoint_id: ids.checkpoint,
    expected_document_sha256: await sha256(markdownBytes),
    status: "complete",
    failure_code: null,
    authority: "materialized_projection_only"
  });
  const chunk = await createChunkPayloadCore({
    project_id: ids.project as never,
    scope_id: ids.access_scope as never,
    sender_person_id: ids.person as never,
    sender_device_id: ids.device as never,
    recipient_device_id: ids.recipient_device as never,
    recipient_key_id: ids.recipient_key as never,
    key_epoch_id: ids.key_epoch as never,
    accepted_control_head_id: ids.control_head as never,
    bundle_kind: "collaboration_exchange",
    objects: [{
      object_kind: "markdown-blob",
      object_id: markdown.id,
      exact_bytes: markdownBytes,
      dependency_ids: [],
      dependency_depth: 0
    }]
  });
  const chunkCommitment = await deriveChunkCommitment(chunk);
  const bundle = await deriveBundleRoot({
    schema_version: HC2_ENVELOPE_VERSION,
    record_kind: "bundle_root_core",
    chunk_commitment_ids: [chunkCommitment.commitment_id]
  });
  const signedCore = parseSignedPlaintextCore({
    schema_version: HC2_ENVELOPE_VERSION,
    record_kind: "signed_plaintext_core",
    payload_core: chunk,
    bundle_root_id: bundle.bundle_root_id,
    chunk_ordinal: 0,
    chunk_count: 1
  });
  const header: PublicEnvelopeHeader = {
    magic: "PATCHMARK-HC2-BUNDLE",
    envelope_version: HC2_ENVELOPE_VERSION,
    suite_id: "patchmark/hc2/crypto-suite/v1",
    encapsulated_key_bytes: hexToBytes(vectors.fixed_bytes.hpke_enc_hex),
    envelope_id: vectors.envelope_id as never,
    recipient_routing_tag: hexToBytes(vectors.fixed_bytes.recipient_tag_hex),
    chunk_ordinal: 0,
    chunk_count: 1,
    ciphertext_length: BigInt(hexToBytes(vectors.fixed_bytes.ciphertext_hex).length)
  };
  const aad = buildEnvelopeAad(header);
  const info = buildHpkeInfo(header);
  const signaturePreimage = await buildEnvelopeSignaturePreimage(header, signedCore);
  const signedRecord = parseSignedPlaintextRecord({
    record_version: HC2_ENVELOPE_VERSION,
    record_kind: "signed_plaintext_record",
    core: signedCore,
    sender_device_signature: {
      algorithm: "ed25519",
      signer_device_id: ids.device,
      signer_key_id: ids.signing_key,
      signature_bytes: hexToBytes(vectors.fixed_bytes.envelope_signature_hex)
    }
  });
  validateSignedPlaintextRecordCiphertextLength(signedRecord, header);
  const container = await createEncryptedContainerRecord(parseEncryptedContainerCore({
    container_version: HC2_ENVELOPE_VERSION,
    record_kind: "encrypted_container_core",
    public_header: header,
    ciphertext: hexToBytes(vectors.fixed_bytes.ciphertext_hex)
  }));

  const identities = await Promise.all([
    deriveHc2Identity("object-commit-marker", canonicalProtocolValue(objectMarker.core)),
    deriveHc2Identity("portable-batch", canonicalProtocolValue(batch.core)),
    deriveHc2Identity("writer-continuity", canonicalProtocolValue(writer.record)),
    deriveHc2Identity("recovery-envelope", canonicalProtocolValue(recovery.core)),
    deriveHc2Identity("transaction-intent", canonicalProtocolValue(transaction.core)),
    deriveHc2Identity("chunk-commitment", canonicalProtocolValue(chunk)),
    deriveHc2Identity("bundle-root", canonicalProtocolValue(bundle.core)),
    deriveHc2Identity("encrypted-container", canonicalProtocolValue(container.core))
  ]);

  const canonical = (value: unknown) => encodeCanonicalCbor(canonicalProtocolValue(value));
  const summarize = async (bytes: Uint8Array) => ({
    byte_length: bytes.length,
    sha256_hex: bytesToHex(await sha256(bytes))
  });
  const identityResult = async (index: number) => ({
    id: identities[index].id,
    canonical_preimage: await summarize(identities[index].canonical_preimage_bytes)
  });

  const writerSignaturePreimage = buildWriterContinuitySignaturePreimage(writerCore);
  const maximumCiphertext = calculateHc2AesGcmCiphertextLength(
    hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes
  );
  const maximumContainer = calculateEncryptedContainerBudgetBytes(
    maximumCiphertext,
    hc2ProtocolLimits.maximum_public_header_canonical_bytes,
    hc2ProtocolLimits.maximum_encrypted_container_framing_bytes
  );
  const maximumBundle = hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes;
  const bundleLengths: bigint[] = [];
  let remainingBundle = maximumBundle - BigInt(1);
  while (remainingBundle > maximumContainer) {
    bundleLengths.push(maximumContainer);
    remainingBundle -= maximumContainer;
  }
  bundleLengths.push(remainingBundle);

  return {
    profile: vectors.profile,
    domains: {
      hpke_info: HC2_HPKE_INFO_PROTOCOL_DOMAIN,
      signature: "patchmark/hc2/signature/envelope-chunk/v1"
    },
    canonical_cores: {
      replica: await summarize(encodeReplicaMetadataCore(replica)),
      object_commit_marker: await summarize(canonical(objectMarker.core)),
      writer_continuity: await summarize(canonical(writer.record)),
      portable_batch: await summarize(canonical(batch.core)),
      transaction_intent: await summarize(canonical(transaction.core)),
      recovery_envelope: await summarize(canonical(recovery.core)),
      materialization_status: await summarize(encodeMaterializationStatus(materialization)),
      chunk_payload: await summarize(canonical(chunk)),
      bundle_root: await summarize(canonical(bundle.core)),
      signed_plaintext_core: await summarize(canonical(signedCore)),
      signed_plaintext_record: await summarize(canonical(signedRecord)),
      public_header: await summarize(canonical(header)),
      encrypted_container_core: await summarize(canonical(container.core))
    },
    identities: {
      markdown_blob_id: markdown.id,
      object_commit_marker: await identityResult(0),
      portable_batch: await identityResult(1),
      writer_continuity: await identityResult(2),
      recovery_envelope: await identityResult(3),
      transaction_intent: await identityResult(4),
      chunk_commitment: await identityResult(5),
      bundle_root: await identityResult(6),
      encrypted_container: await identityResult(7)
    },
    preimages: {
      writer_signature: await summarize(writerSignaturePreimage),
      hpke_info_hex: bytesToHex(info),
      envelope_aad_hex: bytesToHex(aad),
      envelope_aad_sha256_hex: bytesToHex(signaturePreimage.aad_digest),
      sender_signature_preimage: await summarize(signaturePreimage.signature_preimage)
    },
    authority: {
      classes: [...hc2AuthorityClasses],
      authoritative_device_examples: [
        "active_root_key_handle", "device_kek_handle", "device_pending_reservation_continuity", "device_recipient_key_handle", "device_signing_key_handle",
        "device_stream_generation", "device_stream_high_water", "wrapped_local_epoch_secret"
      ].map((kind) => classifyHc2Record(kind as Hc2RecordKind).authority),
      operational_device_examples: [
        "browser_directory_handle", "browser_file_handle", "editor_focus", "editor_selection", "editor_state",
        "local_path", "permission_observation", "reading_bookmark", "storage_estimate_observation"
      ].map((kind) => classifyHc2Record(kind as Hc2RecordKind).authority)
    },
    limits: {
      profile_id: hc2ProtocolLimits.profile_id,
      profile_version: hc2ProtocolLimits.profile_version,
      object_count: chunk.manifest.length,
      object_bytes: markdownBytes.length,
      ciphertext_bytes: container.core.ciphertext.length,
      maximum_canonical_object_bytes: Number(hc2ProtocolLimits.maximum_canonical_object_bytes),
      maximum_total_object_bytes_per_chunk: Number(hc2ProtocolLimits.maximum_total_object_bytes_per_chunk),
      maximum_manifest_canonical_bytes: Number(hc2ProtocolLimits.maximum_manifest_canonical_bytes),
      maximum_chunk_payload_core_structural_overhead_bytes: Number(hc2ProtocolLimits.maximum_chunk_payload_core_structural_overhead_bytes),
      maximum_chunk_payload_core_canonical_bytes: Number(hc2ProtocolLimits.maximum_chunk_payload_core_canonical_bytes),
      maximum_signed_plaintext_core_structural_overhead_bytes: Number(hc2ProtocolLimits.maximum_signed_plaintext_core_structural_overhead_bytes),
      maximum_signed_plaintext_core_canonical_bytes: Number(hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes),
      maximum_signed_plaintext_record_structural_overhead_bytes: Number(hc2ProtocolLimits.maximum_signed_plaintext_record_structural_overhead_bytes),
      maximum_signed_plaintext_record_canonical_bytes: Number(hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes),
      aes_256_gcm_authentication_tag_bytes: Number(hc2ProtocolLimits.aes_256_gcm_authentication_tag_bytes),
      maximum_aead_ciphertext_bytes: Number(maximumCiphertext),
      maximum_public_header_canonical_bytes: Number(hc2ProtocolLimits.maximum_public_header_canonical_bytes),
      maximum_encrypted_container_framing_bytes: Number(hc2ProtocolLimits.maximum_encrypted_container_framing_bytes),
      maximum_encrypted_container_canonical_bytes: Number(maximumContainer),
      maximum_portable_bundle_canonical_bytes: Number(maximumBundle),
      maximum_objects_per_chunk: hc2ProtocolLimits.maximum_objects_per_chunk,
      maximum_chunks_per_bundle: hc2ProtocolLimits.maximum_chunks_per_bundle,
      maximum_dependency_depth: hc2ProtocolLimits.maximum_dependency_depth,
      fixed_recovery_headroom_bytes: Number(hc2ProtocolLimits.fixed_recovery_headroom_bytes),
      maximum_supported_byte_count: Number(hc2ProtocolLimits.maximum_supported_byte_count),
      maximum_bundle_array_fixture_count: bundleLengths.length,
      maximum_bundle_array_fixture_bytes: Number(calculatePortableBundleEncodedLength(bundleLengths)),
      maximum_required_quota_bytes: Number(calculateRequiredQuotaBytes(maximumBundle)),
      compression: hc2ProtocolLimits.compression
    }
  };
}

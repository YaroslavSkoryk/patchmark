import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { hexToBytes } from "../lib/collaboration/bytes.ts";
import {
  HC2_ABSOLUTE_CHROMIUM_FLOOR,
  HC2_COORDINATION_SCHEMA_VERSION,
  HC2_ENVELOPE_VERSION,
  HC2_PLATFORM_POLICY_VERSION,
  HC2_RECOVERY_POLICY_VERSION,
  assertHc2AesGcmCiphertextLength,
  assertHc2EncodedLayerByteLength,
  buildEnvelopeAad,
  calculateChunkPayloadCoreBudgetBytes,
  calculateEncryptedContainerBudgetBytes,
  calculateHc2AesGcmCiphertextLength,
  calculatePortableBundleEncodedLength,
  calculateRequiredQuotaBytes,
  calculateSignedPlaintextCoreBudgetBytes,
  calculateSignedPlaintextRecordBudgetBytes,
  classifyHc2Record,
  createChunkPayloadCore,
  createEncryptedContainerRecord,
  deriveBundleRoot,
  deriveHc2Identity,
  evaluateCollaborationPlatformPolicy,
  evaluateCompareAndAdvanceStream,
  evaluateHc2RecoveryReadiness,
  hc2AuthorityByRecordKind,
  hc2AuthorityClasses,
  hc2BatchAddress,
  hc2CryptoSuite,
  hc2MaterializationStatusAddress,
  hc2ObjectAddresses,
  hc2ProtocolLimits,
  hc2RecordKinds,
  hc2ReplicaMetadataAddress,
  hc2TransactionIntentAddress,
  parseBundleRootCore,
  parseEncryptedContainerCore,
  parseHc2AuthorityClass,
  parseHc2CryptoSuiteId,
  parseHc2DevicePrivateAuthoritativeState,
  parseHc2DevicePrivateOperationalState,
  parseHc2LimitProfileId,
  parseHc2PortableAddress,
  parsePlatformPolicyReasonCode,
  parsePortableBatchMarkerCore,
  parsePublicEnvelopeHeader,
  parseReplicaMetadataCore,
  parseSignedPlaintextCore,
  validateCompleteEncryptedContainerSet,
  verifyCompleteEncryptedContainerSet
} from "../lib/collaboration/hc2/index.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { createHc2Slice1VectorActual } from "./collaboration-hc2-slice1-vector-runtime.ts";

const vectorUrl = new URL("./fixtures/collaboration-hc2-slice1-v1.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorUrl, "utf8"));
let assertions = 0;

const check = (condition, message) => {
  assertions += 1;
  assert(condition, message);
};
const throws = (operation, pattern) => {
  assertions += 1;
  assert.throws(operation, pattern);
};

const actual = await createHc2Slice1VectorActual(vectors);
const { profile, ...actualExpected } = actual;
assertions += 1;
assert.equal(profile, vectors.profile);
assertions += 1;
assert.deepEqual(actualExpected, vectors.expected, "frozen HC-2 vectors changed");

const readyObservation = Object.freeze({
  policy_version: HC2_PLATFORM_POLICY_VERSION,
  engine_family: "chromium",
  engine_version: { major: HC2_ABSOLUTE_CHROMIUM_FLOOR, minor: 0, build: 0, patch: 0 },
  qualified_release_window: "qualified",
  secure_context: true,
  top_level_context: true,
  ed25519: "available",
  x25519: "available",
  crypto_key_indexeddb_round_trip: "available",
  indexeddb: "available",
  indexeddb_strict_durability: "available",
  web_locks: "available",
  file_system_access: "available",
  folder_state: "verified_writable",
  folder_permission: "readwrite",
  storage_estimate: "sufficient",
  persistent_storage: "granted",
  private_context: "not_detected",
  recovery_kit: "ready",
  lifecycle: "initial_enablement"
});

check(evaluateCollaborationPlatformPolicy(readyObservation).readiness === "write_ready", "Chromium 137 with every probe must be ready");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, engine_version: { major: 136, minor: 0, build: 0, patch: 0 } }).readiness === "unsupported", "Chromium 136 must reject");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, qualified_release_window: "unqualified" }).reason_codes.includes("qualified_release_required"), "unqualified release must reject");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, ed25519: "unavailable" }).readiness === "unsupported", "runtime crypto probe must override version");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, persistent_storage: "denied" }).readiness === "write_ready_with_durability_warning", "persistence denial must warn, not block");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, private_context: "detected" }).readiness === "unsupported", "private context must reject");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, folder_state: "verified_read_only", folder_permission: "read" }).readiness === "verified_read_only", "read-only folder must stay verifiable");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, recovery_kit: "missing" }).reason_codes.includes("recovery_kit_required"), "initial enablement needs recovery kit");
check(evaluateCollaborationPlatformPolicy({ ...readyObservation, lifecycle: "browser_state_missing_after_authoring" }).readiness === "recovery_required", "lost browser state must require recovery");
const sortedReasons = evaluateCollaborationPlatformPolicy({
  ...readyObservation,
  engine_version: { major: 136, minor: 0, build: 0, patch: 0 },
  qualified_release_window: "unqualified",
  secure_context: false
}).reason_codes;
check(sortedReasons.join() === [...new Set(sortedReasons)].sort().join(), "reason codes must be sorted and unique");
throws(() => parsePlatformPolicyReasonCode("future_reason"), /Unknown/);
throws(() => evaluateCollaborationPlatformPolicy({ ...readyObservation, policy_version: 2 }), /version/);
throws(() => evaluateCollaborationPlatformPolicy({
  ...readyObservation,
  engine_version: { major: 137, minor: 0, build: 0, patch: 0, channel: "stable" }
}), /four-part|versioned fields/);

check(new Set(hc2RecordKinds).size === hc2RecordKinds.length, "authority record kinds must be unique");
check(new Set(hc2AuthorityClasses).size === hc2AuthorityClasses.length, "authority classifications must be unique");
check(Object.keys(hc2AuthorityByRecordKind).length === hc2RecordKinds.length, "authority classification must be exhaustive");
for (const kind of hc2RecordKinds) {
  const classification = classifyHc2Record(kind);
  check(classification.authority === hc2AuthorityByRecordKind[kind], `${kind} must have one frozen authority`);
}
for (const authoritativeKind of [
  "device_private_key_handle", "person_private_key_handle", "active_root_key_handle", "device_signing_key_handle",
  "device_recipient_key_handle", "device_kek_handle", "wrapped_local_epoch_secret", "device_stream_generation",
  "device_stream_high_water", "device_sequence_continuity", "device_pending_reservation_continuity", "key_vault_security_metadata"
]) {
  check(classifyHc2Record(authoritativeKind).authority === "device_private_authoritative", `${authoritativeKind} must be local cryptographic or continuity authority only`);
  parseHc2DevicePrivateAuthoritativeState({
    classification_version: 1,
    record_kind: authoritativeKind,
    authority: "device_private_authoritative"
  });
}
for (const operationalKind of [
  "browser_directory_handle", "browser_file_handle", "permission_grant", "permission_observation", "local_path",
  "project_folder_binding", "local_path_binding", "reading_bookmark", "active_document", "editor_state",
  "editor_selection", "editor_focus", "unsaved_recovery_draft", "private_review_override", "local_alias",
  "diagnostic_state", "cache_preferences", "ui_state", "capability_probe_observation", "storage_estimate_observation",
  "persistence_observation", "credential_reference"
]) {
  check(classifyHc2Record(operationalKind).authority === "device_private_operational", `${operationalKind} must remain operational and non-authoritative`);
  parseHc2DevicePrivateOperationalState({
    classification_version: 1,
    record_kind: operationalKind,
    authority: "device_private_operational"
  });
}
throws(() => parseHc2DevicePrivateAuthoritativeState({ classification_version: 1, record_kind: "browser_directory_handle", authority: "device_private_authoritative" }), /not device_private_authoritative/);
throws(() => parseHc2DevicePrivateAuthoritativeState({ classification_version: 1, record_kind: "local_path", authority: "device_private_authoritative", path: "/tmp/project" }), /unexpected field/);
throws(() => parseHc2DevicePrivateAuthoritativeState({ classification_version: 1, record_kind: "permission_observation", authority: "device_private_authoritative" }), /not device_private_authoritative/);
throws(() => parseHc2DevicePrivateOperationalState({ classification_version: 1, record_kind: "device_stream_high_water", authority: "device_private_operational" }), /not device_private_operational/);
throws(() => parseHc2AuthorityClass("device_private_future"), /Unknown/);
throws(() => classifyHc2Record("unknown_private_state"), /Unknown/);

const markdownId = actualExpected.identities.markdown_blob_id;
const objectAddresses = hc2ObjectAddresses("markdown-blob", markdownId);
check(objectAddresses.data.startsWith(".patchmark/patchmark-collaboration/v1/data/markdown-blob/"), "object data address must use portable root");
check(hc2ReplicaMetadataAddress.endsWith("replica.cbor"), "replica address must be fixed");
check(hc2MaterializationStatusAddress.endsWith("materialization/current.cbor"), "materialization address must be fixed");
check(hc2BatchAddress(actualExpected.identities.portable_batch.id).includes("/batches/"), "batch address must use its digest");
check(hc2TransactionIntentAddress(vectors.operation_id).endsWith("/intent.cbor"), "transaction intent address must be strict");
for (const invalid of [
  "/.patchmark/patchmark-collaboration/v1/replica.cbor",
  ".patchmark/patchmark-collaboration/v1/../secret",
  ".patchmark\\patchmark-collaboration\\v1\\replica.cbor",
  objectAddresses.data.toUpperCase(),
  `${objectAddresses.data}=`,
  objectAddresses.data.replace("markdown-blob", "unknown")
]) throws(() => parseHc2PortableAddress(invalid), /portable|namespace|Base32|canonical|stored-object/);
throws(() => hc2ObjectAddresses("document-revision", markdownId), /document-revision ID/);

const replica = {
  schema_version: 1,
  record_kind: "portable_replica_metadata",
  project_id: vectors.ids.project,
  collaboration_schema_version: 1,
  storage_schema_version: 1,
  addressing_version: 1,
  protocol_name: "patchmark.human-collaboration",
  protocol_version: 1,
  bootstrap_control_event_id: vectors.ids.control_head,
  at_rest_disclosure_version: 1,
  recovery_policy: "mandatory_before_collaboration"
};
parseReplicaMetadataCore(replica);
for (const forbidden of ["private_key", "folder_path", "browser_handle", "mutable_head", "raw_epoch_secret", "cache_state"]) {
  throws(() => parseReplicaMetadataCore({ ...replica, [forbidden]: "forbidden" }), /unexpected field/);
}
const operationalDescriptor = parseHc2DevicePrivateOperationalState({
  classification_version: 1,
  record_kind: "editor_state",
  authority: "device_private_operational"
});
const authoritativeDescriptor = parseHc2DevicePrivateAuthoritativeState({
  classification_version: 1,
  record_kind: "device_stream_high_water",
  authority: "device_private_authoritative"
});
throws(() => parseReplicaMetadataCore({ ...replica, local_operational_state: operationalDescriptor }), /unexpected field/);
throws(() => parseReplicaMetadataCore({ ...replica, local_authoritative_state: authoritativeDescriptor }), /unexpected field/);

const batchEntry = {
  object_kind: "markdown-blob",
  object_id: markdownId,
  stored_length: BigInt(6),
  stored_sha256: hexToBytes("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"),
  dependency_ids: [],
  object_commit_marker_id: actualExpected.identities.object_commit_marker.id
};
const batchId = actualExpected.identities.portable_batch.id;
const batchCore = {
  schema_version: 1,
  record_kind: "portable_batch_marker",
  project_id: vectors.ids.project,
  predecessor_batch_id: null,
  object_entries: [batchEntry],
  batch_root: hexToBytes("69b5d15753c95a1594fd59159bf4c8543ed64ee67aca63bdcd92cb740be66ddc"),
  writer_continuity_id: actualExpected.identities.writer_continuity.id,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
};
parsePortableBatchMarkerCore(batchCore);
throws(() => parsePortableBatchMarkerCore({ ...batchCore, batch_id: batchId }), /unexpected field/);
throws(() => parsePortableBatchMarkerCore({ ...batchCore, object_entries: [batchEntry, batchEntry] }), /sorted and unique/);
const laterEntry = {
  ...batchEntry,
  object_kind: "semantic-event",
  object_id: vectors.ids.checkpoint
};
throws(() => parsePortableBatchMarkerCore({ ...batchCore, object_entries: [laterEntry, batchEntry] }), /sorted and unique/);
throws(() => parsePortableBatchMarkerCore({ ...batchCore, object_entries: [{ ...batchEntry, dependency_ids: [markdownId, markdownId] }] }), /sorted and unique/);
throws(() => parsePortableBatchMarkerCore({ ...batchCore, editor_state: operationalDescriptor }), /unexpected field/);
throws(() => parsePortableBatchMarkerCore({ ...batchCore, key_vault_state: authoritativeDescriptor }), /unexpected field/);

const transactionId = actualExpected.identities.transaction_intent.id;
const eventId = vectors.ids.checkpoint;
const reservation = {
  transaction_intent_id: transactionId,
  next_sequence: BigInt(0),
  next_object_id: eventId,
  exact_signed_bytes_commitment: new Uint8Array(32).fill(3),
  intended_batch_id: batchId
};
const stream = {
  schema_version: HC2_COORDINATION_SCHEMA_VERSION,
  project_id: vectors.ids.project,
  device_id: vectors.ids.device,
  generation: BigInt(0),
  allocated_sequence: null,
  allocated_object_id: null,
  pending_reservation: null,
  continuity: "unambiguous"
};
const advanceInput = {
  project_id: vectors.ids.project,
  device_id: vectors.ids.device,
  expected_generation: BigInt(0),
  expected_sequence: null,
  expected_previous_object_id: null,
  reservation,
  next_sequence: BigInt(0),
  next_object_id: eventId
};
const advanced = evaluateCompareAndAdvanceStream(stream, advanceInput);
check(advanced.status === "advanced", "exact genesis reservation must advance once");
if (advanced.status !== "advanced") throw new Error("unreachable");
check(evaluateCompareAndAdvanceStream(advanced.state, advanceInput).status === "idempotent_pending_retry", "identical pending retry must be idempotent");
check(evaluateCompareAndAdvanceStream(advanced.state, { ...advanceInput, reservation: { ...reservation, exact_signed_bytes_commitment: new Uint8Array(32).fill(4) } }).status === "failed", "different pending replacement must fail");
check(evaluateCompareAndAdvanceStream(stream, { ...advanceInput, next_sequence: BigInt(2), reservation: { ...reservation, next_sequence: BigInt(2) } }).status === "failed", "noncontiguous successor must fail");
check(evaluateCompareAndAdvanceStream({ ...stream, continuity: "ambiguous" }, advanceInput).status === "failed", "ambiguous continuity must fail closed");

check(parseHc2CryptoSuiteId(hc2CryptoSuite.suite_id) === hc2CryptoSuite.suite_id, "exact suite must parse");
throws(() => parseHc2CryptoSuiteId("patchmark/hc2/crypto-suite/v2"), /Unknown/);
throws(() => parseHc2LimitProfileId("patchmark/hc2/limits/v2"), /Unknown/);
throws(() => parseBundleRootCore({ schema_version: 1, record_kind: "bundle_root_core", chunk_commitment_ids: [] }), /nonempty/);
const sparseCommitments = new Array(2);
sparseCommitments[1] = actualExpected.identities.chunk_commitment.id;
throws(() => parseBundleRootCore({ schema_version: 1, record_kind: "bundle_root_core", chunk_commitment_ids: sparseCommitments }), /dense/);
const MiB = BigInt(1024 * 1024);
const KiB = BigInt(1024);
const maximumBundleBytes = BigInt(256) * MiB;
const maximumObjectBytes = BigInt(16) * MiB;
const maximumRecordBytes = BigInt(18) * MiB;
check(hc2ProtocolLimits.maximum_canonical_object_bytes === maximumObjectBytes, "object limit must measure 16 MiB of canonical bytes");
check(hc2ProtocolLimits.maximum_total_object_bytes_per_chunk === maximumObjectBytes, "chunk object total must be independently bounded at 16 MiB");
check(hc2ProtocolLimits.maximum_manifest_canonical_bytes === MiB, "manifest must be bounded at one canonical MiB");
check(hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes === maximumRecordBytes, "complete signed plaintext record must have an 18 MiB budget");
check(hc2ProtocolLimits.maximum_public_header_canonical_bytes === BigInt(4) * KiB, "complete public header/AAD must have a 4 KiB budget");
check(hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes === maximumRecordBytes + BigInt(64) * KiB, "complete encrypted container must include bounded header and framing overhead");
check(hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes === maximumBundleBytes, "complete portable bundle must be bounded at 256 MiB");

for (const [layer, maximum] of [
  ["canonical_object", hc2ProtocolLimits.maximum_canonical_object_bytes],
  ["chunk_object_total", hc2ProtocolLimits.maximum_total_object_bytes_per_chunk],
  ["manifest", hc2ProtocolLimits.maximum_manifest_canonical_bytes],
  ["signed_plaintext_record", hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes],
  ["public_header", hc2ProtocolLimits.maximum_public_header_canonical_bytes],
  ["encrypted_container", hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes],
  ["portable_bundle", hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes]
]) {
  check(assertHc2EncodedLayerByteLength(layer, maximum) === maximum, `${layer} exact maximum must validate`);
  throws(() => assertHc2EncodedLayerByteLength(layer, maximum + BigInt(1)), /outside/);
}
throws(() => assertHc2EncodedLayerByteLength("unknown_layer", BigInt(0)), /Unknown/);
throws(() => assertHc2EncodedLayerByteLength("canonical_object", Number.MAX_SAFE_INTEGER), /outside/);

const maximumChunkPayloadBudget = calculateChunkPayloadCoreBudgetBytes(
  maximumObjectBytes,
  MiB,
  hc2ProtocolLimits.maximum_chunk_payload_core_structural_overhead_bytes
);
check(maximumChunkPayloadBudget === hc2ProtocolLimits.maximum_chunk_payload_core_canonical_bytes, "maximum objects, manifest, and bounded metadata must fit the complete chunk core");
const maximumSignedCoreBudget = calculateSignedPlaintextCoreBudgetBytes(
  maximumChunkPayloadBudget,
  hc2ProtocolLimits.maximum_signed_plaintext_core_structural_overhead_bytes
);
check(maximumSignedCoreBudget === hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes, "signed core wrapper must fit above the complete chunk core");
const maximumSignedRecordBudget = calculateSignedPlaintextRecordBudgetBytes(
  maximumSignedCoreBudget,
  hc2ProtocolLimits.maximum_signed_plaintext_record_structural_overhead_bytes
);
check(maximumSignedRecordBudget === maximumRecordBytes, "signature record wrapper must fit above the signed core");
const maximumCiphertextBytes = calculateHc2AesGcmCiphertextLength(maximumSignedRecordBudget);
check(maximumCiphertextBytes === maximumRecordBytes + BigInt(16), "AES-256-GCM must add exactly its 16-byte authentication tag");
check(assertHc2AesGcmCiphertextLength(maximumSignedRecordBudget, maximumCiphertextBytes) === maximumCiphertextBytes, "exact ciphertext declaration must validate");
throws(() => assertHc2AesGcmCiphertextLength(maximumSignedRecordBudget, maximumCiphertextBytes - BigInt(1)), /must equal/);
throws(() => calculateHc2AesGcmCiphertextLength(BigInt(1), "patchmark/hc2/crypto-suite/v2"), /Unknown/);
const maximumContainerBudget = calculateEncryptedContainerBudgetBytes(
  maximumCiphertextBytes,
  hc2ProtocolLimits.maximum_public_header_canonical_bytes,
  hc2ProtocolLimits.maximum_encrypted_container_framing_bytes
);
check(maximumContainerBudget === hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes, "container formula must exactly include ciphertext, header, encapsulated key, and framing");

const bundleContainerLengths = [];
let remainingBundleBytes = maximumBundleBytes - BigInt(1);
while (remainingBundleBytes > hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes) {
  bundleContainerLengths.push(hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes);
  remainingBundleBytes -= hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes;
}
bundleContainerLengths.push(remainingBundleBytes);
check(calculatePortableBundleEncodedLength(bundleContainerLengths) === maximumBundleBytes, "bundle limit must count exact canonical array framing and transferred record bytes");
const oversizedBundleLengths = [...bundleContainerLengths];
oversizedBundleLengths[oversizedBundleLengths.length - 1] += BigInt(1);
throws(() => calculatePortableBundleEncodedLength(oversizedBundleLengths), /outside/);
const sparseBundleLengths = new Array(2);
sparseBundleLengths[1] = BigInt(1);
throws(() => calculatePortableBundleEncodedLength(sparseBundleLengths), /dense/);
throws(() => calculatePortableBundleEncodedLength(new Array(4097).fill(BigInt(1))), /bounded/);

check(calculateRequiredQuotaBytes(maximumBundleBytes) === BigInt(576) * MiB, "quota must be 2x bounded operation plus 64 MiB");
throws(() => calculateRequiredQuotaBytes(maximumBundleBytes + BigInt(1)), /outside/);
throws(() => calculateRequiredQuotaBytes(BigInt(-1)), /limit/);

const emptyChunkInput = {
  project_id: vectors.ids.project,
  scope_id: vectors.ids.access_scope,
  sender_person_id: vectors.ids.person,
  sender_device_id: vectors.ids.device,
  recipient_device_id: vectors.ids.recipient_device,
  recipient_key_id: vectors.ids.recipient_key,
  key_epoch_id: vectors.ids.key_epoch,
  accepted_control_head_id: vectors.ids.control_head,
  bundle_kind: "collaboration_exchange",
  objects: []
};
const emptyChunk = await createChunkPayloadCore(emptyChunkInput);
check(emptyChunk.manifest.length === 0 && emptyChunk.object_bytes.length === 0, "empty chunk must be structurally valid and bounded");
const oneSmallObjectChunk = await createChunkPayloadCore({ ...emptyChunkInput, objects: [{
  object_kind: "markdown-blob",
  object_id: actualExpected.identities.markdown_blob_id,
  exact_bytes: new Uint8Array([0x61]),
  dependency_ids: [],
  dependency_depth: 0
}] });
check(oneSmallObjectChunk.object_bytes[0].exact_bytes.length === 1, "one small object must fit a chunk");
const realisticMaximumObject = new Uint8Array(Number(maximumObjectBytes));
const maximumObjectChunk = await createChunkPayloadCore({ ...emptyChunkInput, objects: [{
  object_kind: "markdown-blob",
  object_id: actualExpected.identities.markdown_blob_id,
  exact_bytes: realisticMaximumObject,
  dependency_ids: [],
  dependency_depth: 0
}] });
check(maximumObjectChunk.object_bytes[0].exact_bytes.length === Number(maximumObjectBytes), "one realistic 16 MiB object must fit through canonical ChunkPayloadCore validation");
throws(() => assertHc2EncodedLayerByteLength("canonical_object", maximumObjectBytes + BigInt(1)), /outside/);
await assert.rejects(
  () => createChunkPayloadCore({ ...emptyChunkInput, objects: new Array(1025).fill({
    object_kind: "markdown-blob",
    object_id: actualExpected.identities.markdown_blob_id,
    exact_bytes: new Uint8Array(),
    dependency_ids: [],
    dependency_depth: 0
  }) }),
  /bounded/
);
assertions += 1;
await assert.rejects(
  () => createChunkPayloadCore({ ...emptyChunkInput, objects: [{
    object_kind: "markdown-blob",
    object_id: actualExpected.identities.markdown_blob_id,
    exact_bytes: new Uint8Array(),
    dependency_ids: [],
    dependency_depth: 257
  }] }),
  /dependency depth/
);
assertions += 1;
await assert.rejects(
  () => createChunkPayloadCore({ ...emptyChunkInput, objects: [
    { object_kind: "markdown-blob", object_id: actualExpected.identities.markdown_blob_id, exact_bytes: realisticMaximumObject, dependency_ids: [], dependency_depth: 0 },
    { object_kind: "document-revision", object_id: vectors.ids.checkpoint, exact_bytes: new Uint8Array([1]), dependency_ids: [], dependency_depth: 0 }
  ] }),
  /chunk_object_total/
);
assertions += 1;

const recoveryBase = {
  policy_version: HC2_RECOVERY_POLICY_VERSION,
  platform_supported: true,
  folder: "verified_writable",
  recovery_kit: "ready",
  browser_state: "continuous",
  key_vault_continuity: "unambiguous",
  persistent_storage: "granted",
  quota: "sufficient",
  opfs: "unused",
  profile_state: "single_writer",
  lifecycle: "existing_project"
};
check(evaluateHc2RecoveryReadiness(recoveryBase).readiness === "fully_ready", "continuous state must be ready");
check(evaluateHc2RecoveryReadiness({ ...recoveryBase, persistent_storage: "denied" }).readiness === "ready_with_persistence_warning", "persistence denial must warn");
const lostVault = evaluateHc2RecoveryReadiness({ ...recoveryBase, browser_state: "key_vault_missing", key_vault_continuity: "absent" });
check(lostVault.readiness === "new_device_enrollment_required" && lostVault.must_create_new_device, "lost key vault must create a new device");
check(evaluateHc2RecoveryReadiness({ ...recoveryBase, opfs: "missing" }).readiness === "fully_ready", "OPFS loss must not trigger recovery");
check(evaluateHc2RecoveryReadiness({ ...recoveryBase, profile_state: "conflicting_writer" }).readiness === "concurrent_profile_conflict", "profile conflict must fail closed");

const header = {
  magic: "PATCHMARK-HC2-BUNDLE",
  envelope_version: HC2_ENVELOPE_VERSION,
  suite_id: hc2CryptoSuite.suite_id,
  encapsulated_key_bytes: hexToBytes(vectors.fixed_bytes.hpke_enc_hex),
  envelope_id: vectors.envelope_id,
  recipient_routing_tag: hexToBytes(vectors.fixed_bytes.recipient_tag_hex),
  chunk_ordinal: 0,
  chunk_count: 1,
  ciphertext_length: BigInt(hexToBytes(vectors.fixed_bytes.ciphertext_hex).length)
};
parsePublicEnvelopeHeader(header);
const copiedHeaderInput = {
  ...header,
  encapsulated_key_bytes: Uint8Array.from(header.encapsulated_key_bytes),
  recipient_routing_tag: Uint8Array.from(header.recipient_routing_tag)
};
const copiedHeader = parsePublicEnvelopeHeader(copiedHeaderInput);
copiedHeaderInput.encapsulated_key_bytes.fill(0);
copiedHeaderInput.recipient_routing_tag.fill(0);
check(copiedHeader.encapsulated_key_bytes[0] === 0x55 && copiedHeader.recipient_routing_tag[0] === 0x66, "header parsing must copy accepted bytes");
for (const forbidden of ["project_id", "document_id", "event_kind", "frontier", "checkpoint_id", "object_hash"]) {
  throws(() => parsePublicEnvelopeHeader({ ...header, [forbidden]: "plaintext" }), /unexpected field/);
}
throws(() => parsePublicEnvelopeHeader({ ...header, envelope_version: 2 }), /version/);
throws(() => parsePublicEnvelopeHeader({ ...header, suite_id: "downgraded" }), /suite/);
throws(() => parsePublicEnvelopeHeader({ ...header, chunk_ordinal: 1 }), /ordinal/);

const ciphertext = hexToBytes(vectors.fixed_bytes.ciphertext_hex);
const containerA = await createEncryptedContainerRecord(parseEncryptedContainerCore({
  container_version: 1,
  record_kind: "encrypted_container_core",
  public_header: header,
  ciphertext
}));
check(validateCompleteEncryptedContainerSet([containerA]).chunk_count === 1, "complete one-chunk bundle must validate");
check((await verifyCompleteEncryptedContainerSet([containerA])).chunk_count === 1, "complete set must verify every container identity");
throws(() => parseEncryptedContainerCore({ ...containerA.core, container_id: containerA.container_id }), /unexpected field/);
throws(() => parseEncryptedContainerCore({ ...containerA.core, ciphertext: ciphertext.slice(1) }), /length/);
throws(() => validateCompleteEncryptedContainerSet([containerA, containerA]), /incomplete|duplicate/);
await assert.rejects(
  () => verifyCompleteEncryptedContainerSet([{
    ...containerA,
    container_id: `${containerA.container_id.slice(0, -52)}${containerA.container_id.slice(-52).replace(/^./, containerA.container_id.slice(-52).startsWith("a") ? "b" : "a")}`
  }]),
  /identity verification/
);
assertions += 1;

const movedHeader = { ...header, envelope_id: "ddddddddddddddddddddddddda" };
const movedContainer = await createEncryptedContainerRecord(parseEncryptedContainerCore({
  container_version: 1,
  record_kind: "encrypted_container_core",
  public_header: movedHeader,
  ciphertext: new Uint8Array(ciphertext).fill(0x89)
}));
check(movedContainer.container_id !== containerA.container_id, "fresh encryption framing must produce a distinct container ID");
check(actualExpected.identities.markdown_blob_id === markdownId, "transport identity changes must not change HC-1 object identity");

const firstOfTwo = await createEncryptedContainerRecord(parseEncryptedContainerCore({
  container_version: 1,
  record_kind: "encrypted_container_core",
  public_header: { ...header, chunk_count: 2, chunk_ordinal: 0 },
  ciphertext
}));
const foreignSecond = await createEncryptedContainerRecord(parseEncryptedContainerCore({
  container_version: 1,
  record_kind: "encrypted_container_core",
  public_header: { ...movedHeader, chunk_count: 2, chunk_ordinal: 1 },
  ciphertext: new Uint8Array(ciphertext).fill(0x8a)
}));
throws(() => validateCompleteEncryptedContainerSet([firstOfTwo, foreignSecond]), /across bundles/);

const commitmentA = actualExpected.identities.chunk_commitment.id;
const commitmentBIdentity = await deriveHc2Identity("chunk-commitment", canonicalProtocolValue({ alternate: true }));
const rootForward = await deriveBundleRoot({ schema_version: 1, record_kind: "bundle_root_core", chunk_commitment_ids: [commitmentA, commitmentBIdentity.id] });
const rootReverse = await deriveBundleRoot({ schema_version: 1, record_kind: "bundle_root_core", chunk_commitment_ids: [commitmentBIdentity.id, commitmentA] });
check(rootForward.bundle_root_id !== rootReverse.bundle_root_id, "chunk reordering must change the ordered bundle root");
throws(() => parseBundleRootCore({ ...rootForward.core, chunk_commitment_ids: [commitmentA, commitmentA] }), /unique/);
throws(() => parseBundleRootCore({ ...rootForward.core, editor_state: operationalDescriptor }), /unexpected field/);
throws(() => parseBundleRootCore({ ...rootForward.core, device_continuity: authoritativeDescriptor }), /unexpected field/);
const aadBefore = buildEnvelopeAad(header);
const aadAfter = buildEnvelopeAad({ ...header, encapsulated_key_bytes: new Uint8Array(32).fill(1) });
check(Buffer.from(aadBefore).compare(Buffer.from(aadAfter)) !== 0, "public header mutation must change exact AAD");
const fakeSignedCore = {
  schema_version: 1,
  record_kind: "signed_plaintext_core",
  payload_core: {},
  bundle_root_id: actualExpected.identities.bundle_root.id,
  chunk_ordinal: 0,
  chunk_count: 1,
  signature: new Uint8Array(64)
};
throws(() => parseSignedPlaintextCore(fakeSignedCore), /unexpected field|chunk payload/);
throws(() => parseSignedPlaintextCore({
  schema_version: 1,
  record_kind: "signed_plaintext_core",
  payload_core: emptyChunk,
  bundle_root_id: actualExpected.identities.bundle_root.id,
  chunk_ordinal: 0,
  chunk_count: 4097
}), /chunk count/);
throws(() => parseSignedPlaintextCore({
  schema_version: 1,
  record_kind: "signed_plaintext_core",
  payload_core: emptyChunk,
  bundle_root_id: actualExpected.identities.bundle_root.id,
  chunk_ordinal: 0,
  chunk_count: 1,
  selection_state: operationalDescriptor
}), /unexpected field/);
check(actualExpected.identities.bundle_root.id === vectors.expected.identities.bundle_root.id, "operational state cannot alter a bundle root because it cannot enter the canonical root core");
check(actualExpected.preimages.sender_signature_preimage.sha256_hex === vectors.expected.preimages.sender_signature_preimage.sha256_hex, "operational state cannot alter the frozen signature preimage");
check(actualExpected.identities.markdown_blob_id === vectors.expected.identities.markdown_blob_id, "operational state cannot alter canonical object IDs");
check(vectors.ids.checkpoint === "pm:semantic-event:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaada", "operational state remains outside frozen checkpoint identity");
check(vectors.ids.projection_root === "pm:projection-root:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "operational state remains outside frozen projection-root identity");

const sourceFiles = [
  "lib/collaboration/hc2/crypto-contracts.ts",
  "lib/collaboration/hc2/platform-policy.ts",
  "lib/collaboration/hc2/index.ts"
];
const source = (await Promise.all(sourceFiles.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")))).join("\n");
for (const forbiddenApi of ["exportPrivateKey", "serializePrivateKey", "generateRecipientKey", "senderNonce", "reusableContext"]) {
  check(!source.includes(forbiddenApi), `contract surface must exclude ${forbiddenApi}`);
}

const rootIndex = await readFile(new URL("../lib/collaboration/index.ts", import.meta.url), "utf8");
check(!rootIndex.includes("./hc2/"), "HC-2 contract namespace must not enter the production collaboration barrel");

process.stdout.write(`${JSON.stringify({
  assertions,
  frozen_fixture: vectorUrl.pathname,
  canonical_cores: Object.keys(vectors.expected.canonical_cores).length,
  digest_identities: Object.keys(vectors.expected.identities).length - 1,
  platform_floor: HC2_ABSOLUTE_CHROMIUM_FLOOR,
  recovery_headroom_bytes: Number(hc2ProtocolLimits.fixed_recovery_headroom_bytes),
  production_imports_added: false
}, null, 2)}\n`);

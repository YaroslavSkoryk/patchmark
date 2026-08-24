import assert from "node:assert/strict";

import {
  hc2ProtocolLimits,
  assertDenseArray,
  assertHc2EncodedLayerByteLength,
  calculateEncryptedContainerBudgetBytes,
  calculateRequiredQuotaBytes,
  calculateSignedPlaintextCoreBudgetBytes,
  calculateSignedPlaintextRecordBudgetBytes
} from "../lib/collaboration/hc2/limits.ts";
import { parsePublicEnvelopeHeaderV2 } from "../lib/collaboration/hc2/transport-v2-contracts.ts";
import { InMemoryTransportStreamJournalV2 } from "../lib/collaboration/hc2/transport-stream-store.ts";
import { resolveDeterministicHc1Closure } from "../lib/collaboration/hc2/transport-object-closure.ts";
import { readCanonicalTransportBundleV2 } from "../lib/collaboration/hc2/transport-bundle-framing.ts";
import { deriveAttestationIdentity, deriveMarkdownBlobIdentity, deriveDocumentRevisionIdentity } from "../lib/collaboration/preimages.ts";
import { parseDocumentRevisionCore } from "../lib/collaboration/content.ts";
import { parseAttestationRecord } from "../lib/collaboration/checkpoints.ts";
import { encodeStoredAttestation } from "../lib/collaboration/event-storage-codec.ts";
import { createChunkPayloadCore } from "../lib/collaboration/hc2/envelope.ts";
import { runSlice6CoreEvidence } from "./collaboration-hc2-slice6-runtime.ts";

let assertions = 0;
const check = (value, message) => { assertions += 1; assert(value, message); };
const equal = (left, right, message) => { assertions += 1; assert.deepEqual(left, right, message); };

const evidence = await runSlice6CoreEvidence();
equal(evidence.public_header_keys, [
  "chunk_count", "chunk_ordinal", "ciphertext_length", "encapsulated_key_bytes",
  "envelope_id", "envelope_version", "magic", "recipient_routing_tag", "suite_id"
], "v2 public transport header exposes only opaque routing and cryptographic framing");
equal(evidence.public_privacy, true, "public header contains no semantic identifiers or transport purpose");
equal(evidence.v1_rejects_v2, true, "frozen v1 parser rejects v2 without fallback");
equal(evidence.v2_rejects_v1, true, "v2 parser rejects v1 without fallback");
check(evidence.bundle_manifest_id.startsWith("pm:bundle-manifest:v2:"), "manifest uses the independent v2 identity namespace");
check(evidence.container_ids.every((id) => id.startsWith("pm:encrypted-container:v2:")), "containers use independent v2 identities");
equal(evidence.reopen_same_length, true, "incremental reopen verifies exact file length");
equal(evidence.reopen_same_digest, true, "incremental reopen verifies exact file digest");
equal(evidence.open_diagnostics, ["opened", "opened"], "manifest and HC-1 chunk independently authenticate, decode, and verify signatures");
equal(evidence.imported_status, "imported", "verified encrypted bundle imports atomically");
equal(evidence.imported_object_byte_identical, true, "HC-1 canonical bytes remain byte-identical across transport");
equal(evidence.duplicate_status, "duplicate", "exact replay is a no-op only after visible batch proof");
equal(evidence.tamper_status, "rejected", "tampered ciphertext fails closed");
equal(evidence.tamper_reason, "authentication_failed", "ciphertext tamper fails at HPKE authentication without semantic oracle");
equal(evidence.wrong_recipient_reason, "authentication_failed", "wrong recipient private key fails at HPKE authentication");
equal(evidence.missing_container_reason, "manifest_invalid", "missing container fails complete-set validation");
equal(evidence.reordered_reason, "manifest_invalid", "reordered containers fail dense canonical ordering");
equal(evidence.stale_authority_reason, "authority_rejected", "stale accepted control authority fails before mutation");
equal(evidence.unavailable_epoch_reason, "epoch_key_unavailable", "missing accepted epoch custody fails before mutation");
equal(evidence.invalid_signature_reason, "signature_or_binding_invalid", "authenticated ciphertext with an invalid inner sender signature fails closed");
equal(evidence.export_status, "completed", "outbound stream advances only after close and exact reopen verification");
equal(evidence.export_retry_status, "resumed_completed", "completed outbound retry returns the journaled immutable result without resealing");
equal(evidence.partial_write_rejected && evidence.partial_write_aborted, true, "partial framing write aborts the sink and cannot complete a stream");
equal(evidence.signature_creation_rejected, true, "sender-signature failure produces no encrypted bundle");
equal(evidence.hpke_setup_rejected, true, "HPKE setup failure produces no encrypted bundle");
equal(evidence.export_authority_rejected_before_crypto, true,
  "revoked or stale recipient authority rejects export before randomness, signing, or HPKE can produce ciphertext");
equal(evidence.hpke_evidence.sender_contexts_created, 2, "one fresh HPKE sender context is used per payload");
equal(evidence.hpke_evidence.sender_seal_calls, 2, "each HPKE sender context seals exactly once");

const closureProject = entity("project", "r");
const closureBytes = new TextEncoder().encode("dependency closure\n");
const closureBlob = await deriveMarkdownBlobIdentity(closureProject, closureBytes);
const revision = await deriveDocumentRevisionIdentity(parseDocumentRevisionCore({ schema_version: 1, object_kind: "document_revision_core",
  ancestry_kind: "genesis", project_id: closureProject, document_id: entity("document", "s"), markdown_blob_id: closureBlob.id, parent_revision_ids: [] }));
const closureMap = new Map([[closureBlob.id, closureBytes], [revision.id, revision.canonical_bytes]]);
const closure = await resolveDeterministicHc1Closure({ project_id: closureProject,
  roots: [{ kind: "document-revision", id: revision.id }], source: { async readExactObject({ id }) { return closureMap.get(id) ?? null; } } });
equal(closure.map((entry) => [entry.object_id, entry.dependency_depth]), [[closureBlob.id, 0], [revision.id, 1]],
  "real HC-1 dependency closure is deterministic and dependency-first");
const signedSubject = digestId("semantic-event", "u");
const attestationCore = { schema_version: 1, object_kind: "attestation_core", project_id: closureProject,
  subject_kind: "semantic_event", subject_id: signedSubject, signer_key_id: entity("public-key", "v"),
  algorithm: "ed25519", signature_bytes: new Uint8Array(64).fill(0x6a) };
const attestationIdentity = await deriveAttestationIdentity(attestationCore);
const attestationRecord = parseAttestationRecord({ record_version: 1, object_kind: "attestation",
  attestation_id: attestationIdentity.id, core: attestationCore });
const attestationBytes = encodeStoredAttestation(attestationRecord);
const attestationClosure = await resolveDeterministicHc1Closure({ project_id: closureProject,
  roots: [{ kind: "attestation", id: attestationIdentity.id }],
  source: { async readExactObject({ id }) { return id === attestationIdentity.id ? attestationBytes : null; } } });
equal(attestationClosure.map((entry) => [entry.object_id, entry.dependency_ids, entry.dependency_depth]),
  [[attestationIdentity.id, [], 0]],
  "an attestation binds its subject without manufacturing a cyclic storage dependency back to that subject");
assertions += 1;
await assert.rejects(() => resolveDeterministicHc1Closure({ project_id: closureProject,
  roots: [{ kind: "document-revision", id: revision.id }], source: { async readExactObject({ id }) { return id === revision.id ? revision.canonical_bytes : null; } } }), /missing/i,
  "missing transitive HC-1 dependency fails closed");

for (const [layer, maximum] of [
  ["canonical_object", hc2ProtocolLimits.maximum_canonical_object_bytes],
  ["chunk_object_total", hc2ProtocolLimits.maximum_total_object_bytes_per_chunk],
  ["manifest", hc2ProtocolLimits.maximum_manifest_canonical_bytes],
  ["chunk_payload_core", hc2ProtocolLimits.maximum_chunk_payload_core_canonical_bytes],
  ["signed_plaintext_core", hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes],
  ["signed_plaintext_record", hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes],
  ["aead_ciphertext", hc2ProtocolLimits.maximum_aead_ciphertext_bytes],
  ["public_header", hc2ProtocolLimits.maximum_public_header_canonical_bytes],
  ["encrypted_container", hc2ProtocolLimits.maximum_encrypted_container_canonical_bytes],
  ["portable_bundle", hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes]
]) {
  equal(assertHc2EncodedLayerByteLength(layer, maximum), maximum, `${layer} accepts its exact frozen byte limit`);
  assertions += 1;
  assert.throws(() => assertHc2EncodedLayerByteLength(layer, maximum + 1n), /outside/i, `${layer} rejects exact +1 without allocating the payload`);
}
equal(calculateSignedPlaintextCoreBudgetBytes(
  hc2ProtocolLimits.maximum_chunk_payload_core_canonical_bytes,
  hc2ProtocolLimits.maximum_signed_plaintext_core_structural_overhead_bytes
), hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes,
"the unchanged maximum HC-1 chunk plus the complete v2 wrapper headroom exactly fits the frozen signed-core limit");
equal(calculateSignedPlaintextRecordBudgetBytes(
  hc2ProtocolLimits.maximum_signed_plaintext_core_canonical_bytes,
  hc2ProtocolLimits.maximum_signed_plaintext_record_structural_overhead_bytes
), hc2ProtocolLimits.maximum_signed_plaintext_record_canonical_bytes,
"the maximum v2 signed core plus its record wrapper headroom exactly fits the frozen plaintext limit");
equal(calculateEncryptedContainerBudgetBytes(0n, 0n, hc2ProtocolLimits.maximum_encrypted_container_framing_bytes),
  hc2ProtocolLimits.maximum_encrypted_container_framing_bytes, "container framing accepts its exact headroom");
assertions += 1;
assert.throws(() => calculateEncryptedContainerBudgetBytes(0n, 0n, hc2ProtocolLimits.maximum_encrypted_container_framing_bytes + 1n), /outside|bounded/i,
  "container framing rejects exact +1");
check(calculateRequiredQuotaBytes(hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes * 2n,
  "quota calculation preserves the fixed recovery headroom at the maximum bundle limit");
assertions += 1;
assert.throws(() => calculateRequiredQuotaBytes(hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes + 1n), /outside/i,
  "quota calculation rejects bundle +1");
equal(assertDenseArray(new Array(hc2ProtocolLimits.maximum_objects_per_chunk).fill(null), hc2ProtocolLimits.maximum_objects_per_chunk, "object count").length,
  hc2ProtocolLimits.maximum_objects_per_chunk, "object count exact limit is accepted");
assertions += 1;
assert.throws(() => assertDenseArray(new Array(hc2ProtocolLimits.maximum_objects_per_chunk + 1).fill(null), hc2ProtocolLimits.maximum_objects_per_chunk, "object count"), /bounded/i,
  "object count +1 is rejected");
equal(assertDenseArray(new Array(hc2ProtocolLimits.maximum_chunks_per_bundle).fill(null), hc2ProtocolLimits.maximum_chunks_per_bundle, "payload count").length,
  hc2ProtocolLimits.maximum_chunks_per_bundle, "payload count exact limit is accepted");
assertions += 1;
assert.throws(() => assertDenseArray(new Array(hc2ProtocolLimits.maximum_chunks_per_bundle + 1).fill(null), hc2ProtocolLimits.maximum_chunks_per_bundle, "payload count"), /bounded/i,
  "payload count +1 is rejected");
const depthInput = { project_id: closureProject, scope_id: entity("access-scope", "t"), sender_person_id: entity("person", "u"),
  sender_device_id: entity("device", "v"), recipient_device_id: entity("device", "w"), recipient_key_id: entity("public-key", "x"),
  key_epoch_id: entity("key-epoch", "y"), accepted_control_head_id: digestId("control-event", "z"), bundle_kind: "collaboration_exchange",
  objects: [{ object_kind: "markdown-blob", object_id: digestId("markdown-blob", "y"), exact_bytes: Uint8Array.of(0x61), dependency_ids: [], dependency_depth: hc2ProtocolLimits.maximum_dependency_depth }] };
equal((await createChunkPayloadCore(depthInput)).manifest[0].dependency_depth, hc2ProtocolLimits.maximum_dependency_depth,
  "dependency depth exact limit is accepted");
assertions += 1;
await assert.rejects(() => createChunkPayloadCore({ ...depthInput, objects: [{ ...depthInput.objects[0], dependency_depth: hc2ProtocolLimits.maximum_dependency_depth + 1 }] }), /depth/i,
  "dependency depth +1 is rejected");

const journal = new InMemoryTransportStreamJournalV2();
const stream = streamFixture();
const manifest0 = v2("bundle-manifest", "a");
const manifest1 = v2("bundle-manifest", "b");
equal(await journal.classifyInbound({ stream, manifest_id: manifest0, bundle_sequence: 0n, previous_manifest_id: null }), "next", "genesis is accepted only at an empty transport head");
equal((await journal.commitInbound({ stream, manifest_id: manifest0, bundle_sequence: 0n, previous_manifest_id: null })).status, "committed", "genesis advances by CAS");
equal(await journal.classifyInbound({ stream, manifest_id: manifest0, bundle_sequence: 0n, previous_manifest_id: null }), "duplicate", "same manifest at same sequence is an exact duplicate");
equal(await journal.classifyInbound({ stream, manifest_id: manifest1, bundle_sequence: 0n, previous_manifest_id: null }), "stale_replay", "different same-sequence bundle is stale/fork evidence");
equal(await journal.classifyInbound({ stream, manifest_id: manifest1, bundle_sequence: 2n, previous_manifest_id: manifest0 }), "gap", "sequence gap is explicit");
equal(await journal.classifyInbound({ stream, manifest_id: manifest1, bundle_sequence: 1n, previous_manifest_id: v2("bundle-manifest", "c") }), "fork", "wrong predecessor is explicit fork evidence");
equal(await journal.classifyInbound({ stream, manifest_id: manifest1, bundle_sequence: 1n, previous_manifest_id: manifest0 }), "next", "exact next predecessor is accepted");
const outboundContention = new InMemoryTransportStreamJournalV2();
equal((await outboundContention.reserveOutbound({ stream, manifest_id: manifest0, bundle_sequence: 0n, previous_manifest_id: null })).status, "reserved",
  "first outbound stream reservation succeeds");
equal((await outboundContention.reserveOutbound({ stream, manifest_id: manifest1, bundle_sequence: 0n, previous_manifest_id: null })).status, "conflict",
  "competing same-stream outbound plan cannot reserve the same position");

assertions += 1;
assert.throws(() => parsePublicEnvelopeHeaderV2({
  magic: "PATCHMARK-HC2-BUNDLE", envelope_version: 2, suite_id: "patchmark/hc2/crypto-suite/v1",
  encapsulated_key_bytes: new Uint8Array(32), envelope_id: "a".repeat(26), recipient_routing_tag: new Uint8Array(32),
  chunk_ordinal: 0, chunk_count: 1, ciphertext_length: hc2ProtocolLimits.maximum_aead_ciphertext_bytes + 1n
}), /outside/i, "header rejects the ciphertext +1 boundary before allocation");

for (const invalid of [Uint8Array.of(0x81), Uint8Array.of(0x9f, 0xff)]) {
  assertions += 1;
  await assert.rejects(() => readCanonicalTransportBundleV2({
    source: { async *chunks() { yield invalid; } },
    sha256: { update() {}, digest() { return new Uint8Array(32); } },
    async on_container() {}
  }), /incomplete|indefinite|unsupported/i, "truncated or indefinite outer framing fails closed");
}

process.stdout.write(`${JSON.stringify({ assertions, status: "ok", ...evidence }, null, 2)}\n`);

function streamFixture() {
  return Object.freeze({
    project_id: entity("project", "a"), purpose: "replication", sender_person_id: entity("person", "b"),
    sender_membership_id: entity("membership", "c"), sender_device_id: entity("device", "d"), sender_signing_key_id: entity("public-key", "e"),
    recipient_person_id: entity("person", "f"), recipient_membership_id: entity("membership", "g"), recipient_device_id: entity("device", "h"),
    recipient_key_id: entity("public-key", "j"), stream_id: v2("transport-stream", "k"), stream_generation: 0n
  });
}
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function v2(kind, fill) { return `pm:${kind}:v2:${fill.repeat(51)}a`; }
function digestId(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }

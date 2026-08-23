import assert from "node:assert/strict";

import { bytesEqual } from "../lib/collaboration/bytes.ts";
import { parseDocumentRevisionCore } from "../lib/collaboration/content.ts";
import { parseAcknowledgementRecord, parseAttestationRecord, parseProjectionSnapshotRecord } from "../lib/collaboration/checkpoints.ts";
import { parseControlActionRecord, parseControlEventRecordStructure } from "../lib/collaboration/control.ts";
import {
  encodeStoredAttestation,
  encodeStoredControlAction,
  encodeStoredControlEvent,
  encodeStoredSemanticEvent,
  encodeStoredSemanticPayload
} from "../lib/collaboration/event-storage-codec.ts";
import {
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventCoreIdentity,
  deriveAcknowledgementIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveProjectionSnapshotIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity
} from "../lib/collaboration/preimages.ts";
import { parseSemanticEventRecordStructure, parseSemanticPayloadRecord } from "../lib/collaboration/semantic.ts";
import { deriveCanonicalStateBlobIdentity, parseCanonicalStateBlobRecord } from "../lib/collaboration/state-snapshots.ts";
import { sha256 } from "../lib/collaboration/sha256.ts";
import {
  Hc1CanonicalPortableObjectVerifier,
  Hc2FolderError,
  Hc2InMemoryCoordinationStore,
  Hc2OpfsCacheAdapter,
  Hc2PortableFolderAdapter,
  Hc2PortableMutationCoordinator,
  Hc2PortableReplicaStore,
  Hc2SingleCutFailureInjector,
  Hc2WebLocksAdapter,
  createObjectCommitMarker,
  createPortableBatchMarker,
  deriveTransactionIntentCommitment,
  deriveWriterContinuityIdentity,
  evaluateHc2StorageAdaptation,
  encodeProtocolRecord,
  hc2ObjectAddresses,
  hc2BatchAddress,
  hc2StorageFailureCuts,
  parseHc2PortableAddress,
  reconstructHc2Folder
} from "../lib/collaboration/hc2/index.ts";
import { parseWriterContinuityRecord } from "../lib/collaboration/hc2/records.ts";

let assertions = 0;
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const rejects = async (operation, pattern) => { assertions += 1; await assert.rejects(operation, pattern); };

const project = entity("project", "a");
const otherProject = entity("project", "b");
const device = entity("device", "c");
const otherDevice = entity("device", "d");
const documentId = entity("document", "e");
const bootstrapControl = digestId("control-event", "f");
const event0 = digestId("semantic-event", "g");
const event1 = digestId("semantic-event", "h");
const event2 = digestId("semantic-event", "i");
const transactionId = hc2DigestId("transaction-intent", "j");
const encoder = new TextEncoder();

async function main() {
const root = new MemoryDirectory();
const folder = new Hc2PortableFolderAdapter(root);
const verifier = new Hc1CanonicalPortableObjectVerifier(project);
const replica = new Hc2PortableReplicaStore({ folder, object_verifier: verifier });
await replica.installReplicaMetadata(replicaMetadata(project));
equal(await folder.queryPermission("readwrite"), "granted", "memory FSA must expose explicit permission observation");

const first = await commitMarkdown(replica, project, "# One\n", null);
equal((await replica.verifyBatchById(first.batch.batch_id)).status, "visible", "commit-last batch must be visible after full verification");
const rebuilt = await reconstructHc2Folder(replica);
equal(rebuilt.status, "verified", "folder-only reconstruction must verify a complete chain");
equal(rebuilt.frontier_batch_id, first.batch.batch_id, "reconstruction must derive the chain frontier");
equal(rebuilt.can_resume_existing_device_authoring, false, "folder evidence must not recreate old authoring identity");

const copiedAddress = hc2ObjectAddresses("markdown-blob", first.id).data;
const copiedRead = await folder.read(copiedAddress);
copiedRead[0] ^= 0xff;
check(!bytesEqual(copiedRead, await folder.read(copiedAddress)), "folder reads must return copied bytes");
await rejects(() => folder.write(copiedAddress, encoder.encode("different"), "immutable"), (error) => error instanceof Hc2FolderError && error.code === "already_exists_different");
await rejects(() => folder.deleteOwned(copiedAddress), (error) => error instanceof Hc2FolderError && error.code === "delete_not_owned");
await rejects(() => folder.deleteOwned(hc2ObjectAddresses("markdown-blob", first.id).staging), (error) => error instanceof Hc2FolderError && error.code === "delete_not_owned");
for (const invalid of ["/absolute", ".patchmark/patchmark-collaboration/v1/../x", ".patchmark\\x"]) {
  assertions += 1;
  assert.throws(() => parseHc2PortableAddress(invalid));
}

root.children.set("unrelated-user-file.txt", new MemoryFileHandle(encoder.encode("preserve me"), root.faults));
check((await folder.list()).every((address) => !address.includes("unrelated")), "scanner must ignore unrelated user files");
check(root.children.has("unrelated-user-file.txt"), "scanner must preserve unrelated user files");

const revisionCore = parseDocumentRevisionCore({
  schema_version: 1,
  object_kind: "document_revision_core",
  ancestry_kind: "genesis",
  project_id: project,
  document_id: documentId,
  markdown_blob_id: first.id,
  parent_revision_ids: []
});
const revisionIdentity = await deriveDocumentRevisionIdentity(revisionCore);
const verifiedRevision = await verifier.verifyExactObject({ object_kind: "document-revision", object_id: revisionIdentity.id, exact_bytes: revisionIdentity.canonical_bytes });
equal(verifiedRevision.dependency_ids, [first.id], "real HC-1 revision verification must expose its blob closure");
await rejects(() => verifier.verifyExactObject({ object_kind: "document-revision", object_id: digestId("document-revision", "k"), exact_bytes: revisionIdentity.canonical_bytes }), /identity/);

const person = entity("person", "f");
const membership = entity("membership", "g");
const scope = entity("access-scope", "h");
const signingKey = entity("public-key", "i");
const rootKey = entity("public-key", "j");
const keyEpoch = entity("key-epoch", "k");
const stateRoot = digestId("control-state-root", "l");
const keyCommitment = digestId("key-epoch-commitment", "m");
const actionCore = { schema_version: 1, project_id: project, action_kind: "membership_role_change", membership_id: membership, person_id: person, next_role: "owner" };
const actionIdentity = await deriveControlActionIdentity(actionCore);
const actionRecord = parseControlActionRecord({ record_version: 1, object_kind: "control_action", action_id: actionIdentity.id, core: actionCore });
equal((await verifier.verifyExactObject({ object_kind: "control-action", object_id: actionIdentity.id, exact_bytes: encodeStoredControlAction(actionRecord) })).object_id, actionIdentity.id, "real HC-1 control-action codec must verify");
const controlCore = {
  schema_version: 1,
  object_kind: "control_event_core",
  control_kind: "genesis",
  project_id: project,
  control_sequence: 0n,
  previous_control_id: null,
  root_sequence: 0n,
  previous_root_control_id: null,
  owner_person_id: person,
  offline_root_key_id: rootKey,
  initial_active_control_device_id: device,
  initial_memberships: [{ membership_id: membership, person_id: person, role: "owner", access_scope_id: scope, status: "active" }],
  initial_authorized_devices: [{ device_id: device, person_id: person, signing_key_id: signingKey, status: "active" }],
  initial_key_epoch_id: keyEpoch,
  initial_key_epoch_commitment: keyCommitment,
  resulting_control_state_root: stateRoot
};
const controlIdentity = await deriveControlEventCoreIdentity(controlCore);
const controlAttestationCore = { schema_version: 1, object_kind: "attestation_core", project_id: project, subject_kind: "control_event", subject_id: controlIdentity.id, signer_key_id: rootKey, algorithm: "ed25519", signature_bytes: new Uint8Array([1, 2, 3]) };
const controlAttestationIdentity = await deriveAttestationIdentity(controlAttestationCore);
const controlAttestation = parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: controlAttestationIdentity.id, core: controlAttestationCore });
equal((await verifier.verifyExactObject({ object_kind: "attestation", object_id: controlAttestationIdentity.id, exact_bytes: encodeStoredAttestation(controlAttestation) })).object_id, controlAttestationIdentity.id, "real HC-1 attestation codec must verify without manufacturing authority");
const controlRecord = parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event", control_event_id: controlIdentity.id, core: controlCore, authority_attestation_id: controlAttestationIdentity.id });
equal((await verifier.verifyExactObject({ object_kind: "control-event", object_id: controlIdentity.id, exact_bytes: encodeStoredControlEvent(controlRecord) })).object_id, controlIdentity.id, "real HC-1 control-event codec must verify");
const payloadCore = { schema_version: 1, project_id: project, semantic_kind: "project_genesis", data: { genesis_revision_ids: [revisionIdentity.id] } };
const payloadIdentity = await deriveSemanticPayloadIdentity(payloadCore);
const payloadRecord = parseSemanticPayloadRecord({ record_version: 1, object_kind: "semantic_payload", payload_id: payloadIdentity.id, core: payloadCore });
equal((await verifier.verifyExactObject({ object_kind: "semantic-payload", object_id: payloadIdentity.id, exact_bytes: encodeStoredSemanticPayload(payloadRecord) })).object_id, payloadIdentity.id, "real HC-1 semantic-payload codec must verify");
const semanticCore = {
  schema_version: 1,
  object_kind: "semantic_event_core",
  device_chain_position: "first",
  project_id: project,
  semantic_kind: "project_genesis",
  author_device_id: device,
  device_sequence: 0n,
  previous_device_event_id: null,
  causal_parent_event_ids: [],
  authorizing_control_head_id: controlIdentity.id,
  key_epoch_id: keyEpoch,
  semantic_payload_id: payloadIdentity.id,
  complete_known_frontier: true
};
const semanticIdentity = await deriveSemanticEventCoreIdentity(semanticCore);
const semanticAttestationCore = { schema_version: 1, object_kind: "attestation_core", project_id: project, subject_kind: "semantic_event", subject_id: semanticIdentity.id, signer_key_id: signingKey, algorithm: "ed25519", signature_bytes: new Uint8Array([4, 5, 6]) };
const semanticAttestationIdentity = await deriveAttestationIdentity(semanticAttestationCore);
const semanticRecord = parseSemanticEventRecordStructure({ record_version: 1, object_kind: "semantic_event", event_id: semanticIdentity.id, core: semanticCore, author_attestation_ids: [semanticAttestationIdentity.id] });
equal((await verifier.verifyExactObject({ object_kind: "semantic-event", object_id: semanticIdentity.id, exact_bytes: encodeStoredSemanticEvent(semanticRecord) })).object_id, semanticIdentity.id, "real HC-1 semantic-event codec must verify separately from semantic acceptance");
const semanticStateRoot = digestId("semantic-state-root", "n");
const revisionHeadsRoot = digestId("revision-heads-root", "o");
const conflictSetRoot = digestId("conflict-set-root", "p");
const projectionRoot = digestId("projection-root", "q");
const checkpointPayloadCore = {
  schema_version: 1,
  project_id: project,
  semantic_kind: "consolidation_checkpoint",
  data: {
    base_frontier_event_ids: [semanticIdentity.id],
    base_frontier_root: digestId("frontier-root", "r"),
    accepted_history_root: digestId("accepted-history-root", "s"),
    resolution_operations: [],
    result_semantic_state_root: semanticStateRoot,
    result_revision_heads_root: revisionHeadsRoot,
    result_conflict_set_root: conflictSetRoot,
    projection_root: projectionRoot,
    reducer_version: "patchmark-hc-reducer-v1",
    authorizing_control_head_id: controlIdentity.id
  }
};
const checkpointPayloadIdentity = await deriveSemanticPayloadIdentity(checkpointPayloadCore);
const checkpointPayloadRecord = parseSemanticPayloadRecord({ record_version: 1, object_kind: "semantic_payload", payload_id: checkpointPayloadIdentity.id, core: checkpointPayloadCore });
const checkpointCore = {
  schema_version: 1,
  object_kind: "semantic_event_core",
  device_chain_position: "subsequent",
  project_id: project,
  semantic_kind: "consolidation_checkpoint",
  author_device_id: device,
  device_sequence: 1n,
  previous_device_event_id: semanticIdentity.id,
  causal_parent_event_ids: [semanticIdentity.id],
  authorizing_control_head_id: controlIdentity.id,
  key_epoch_id: keyEpoch,
  semantic_payload_id: checkpointPayloadIdentity.id,
  complete_known_frontier: true
};
const checkpointIdentity = await deriveSemanticEventCoreIdentity(checkpointCore);
const checkpointAttestationCore = { schema_version: 1, object_kind: "attestation_core", project_id: project, subject_kind: "semantic_event", subject_id: checkpointIdentity.id, signer_key_id: signingKey, algorithm: "ed25519", signature_bytes: new Uint8Array([7, 8, 9]) };
const checkpointAttestationIdentity = await deriveAttestationIdentity(checkpointAttestationCore);
const checkpointRecord = parseSemanticEventRecordStructure({ record_version: 1, object_kind: "semantic_event", event_id: checkpointIdentity.id, core: checkpointCore, author_attestation_ids: [checkpointAttestationIdentity.id] });
equal((await verifier.verifyExactObject({ object_kind: "semantic-payload", object_id: checkpointPayloadIdentity.id, exact_bytes: encodeStoredSemanticPayload(checkpointPayloadRecord) })).object_id, checkpointPayloadIdentity.id, "real HC-1 checkpoint payload must verify as immutable storage evidence");
equal((await verifier.verifyExactObject({ object_kind: "semantic-event", object_id: checkpointIdentity.id, exact_bytes: encodeStoredSemanticEvent(checkpointRecord) })).object_id, checkpointIdentity.id, "real HC-1 checkpoint event must verify without claiming global completeness");
const projection = {
  schema_version: 1,
  object_kind: "collaboration_projection",
  reducer_version: "patchmark-hc-reducer-v1",
  project_id: project,
  project_title: { register_version: 1, state: "unset", resolved_value: null, last_uncontested_value: null, contenders: [] },
  group_order: [], groups: [], document_order: [], documents: [], review_batches: [], rewrite_sessions: [], revision_heads: [], conflicts: [],
  reduction_rejections: [], replayed_event_ids: [], accepted_frontier: [], event_provenance: []
};
const stateBlobCore = {
  schema_version: 1,
  object_kind: "canonical_state_blob_core",
  project_id: project,
  reducer_version: "patchmark-hc-reducer-v1",
  checkpoint_id: checkpointIdentity.id,
  control_head_id: controlIdentity.id,
  semantic_state_root: semanticStateRoot,
  revision_heads_root: revisionHeadsRoot,
  conflict_set_root: conflictSetRoot,
  projection_root: projectionRoot,
  projection
};
const stateBlobIdentity = await deriveCanonicalStateBlobIdentity(stateBlobCore);
const stateBlobRecord = parseCanonicalStateBlobRecord({ record_version: 1, object_kind: "canonical_state_blob", state_blob_id: stateBlobIdentity.id, core: stateBlobCore });
equal((await verifier.verifyExactObject({ object_kind: "state-blob", object_id: stateBlobIdentity.id, exact_bytes: encodeProtocolRecord(stateBlobRecord) })).object_id, stateBlobIdentity.id, "real HC-1 state-blob codec must verify");
const snapshotCore = {
  schema_version: 1,
  object_kind: "projection_snapshot_core",
  project_id: project,
  checkpoint_id: checkpointIdentity.id,
  reducer_version: "patchmark-hc-reducer-v1",
  state_blob_id: stateBlobIdentity.id,
  semantic_state_root: semanticStateRoot,
  revision_heads_root: revisionHeadsRoot,
  conflict_set_root: conflictSetRoot,
  projection_root: projectionRoot,
  boundary_revisions: [{ document_id: documentId, revision_id: revisionIdentity.id, traversal: "complete" }],
  live_conflict_dependencies: []
};
const snapshotIdentity = await deriveProjectionSnapshotIdentity(snapshotCore);
const snapshotRecord = parseProjectionSnapshotRecord({ record_version: 1, object_kind: "projection_snapshot", snapshot_id: snapshotIdentity.id, core: snapshotCore, producer_attestation_id: null }, checkpointIdentity.id);
equal((await verifier.verifyExactObject({ object_kind: "snapshot", object_id: snapshotIdentity.id, exact_bytes: encodeProtocolRecord(snapshotRecord) })).object_id, snapshotIdentity.id, "real HC-1 snapshot codec must verify without claiming global checkpoint completeness");
const acknowledgementCore = {
  schema_version: 1,
  object_kind: "acknowledgement_core",
  chain_position: "first",
  project_id: project,
  device_id: device,
  acknowledgement_sequence: 0n,
  previous_acknowledgement_id: null,
  observed_control_head_id: controlIdentity.id,
  acknowledged_checkpoint_id: checkpointIdentity.id,
  observed_semantic_frontier: [checkpointIdentity.id],
  projection_root: projectionRoot
};
const acknowledgementIdentity = await deriveAcknowledgementIdentity(acknowledgementCore);
const acknowledgementRecord = parseAcknowledgementRecord({ record_version: 1, object_kind: "acknowledgement", acknowledgement_id: acknowledgementIdentity.id, core: acknowledgementCore, attestation_id: controlAttestationIdentity.id }, checkpointIdentity.id);
equal((await verifier.verifyExactObject({ object_kind: "acknowledgement", object_id: acknowledgementIdentity.id, exact_bytes: encodeProtocolRecord(acknowledgementRecord) })).object_id, acknowledgementIdentity.id, "real HC-1 acknowledgement codec must verify without manufacturing acknowledgement authority");
const semanticAttestation = parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: semanticAttestationIdentity.id, core: semanticAttestationCore });
const checkpointAttestation = parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: checkpointAttestationIdentity.id, core: checkpointAttestationCore });
const familyRoot = new MemoryDirectory();
const familyFolder = new Hc2PortableFolderAdapter(familyRoot);
const familyReplica = new Hc2PortableReplicaStore({ folder: familyFolder, object_verifier: verifier });
await familyReplica.installReplicaMetadata(replicaMetadata(project));
const familyObjects = [
  { object_kind: "markdown-blob", object_id: first.id, exact_bytes: first.bytes },
  { object_kind: "document-revision", object_id: revisionIdentity.id, exact_bytes: revisionIdentity.canonical_bytes },
  { object_kind: "control-action", object_id: actionIdentity.id, exact_bytes: encodeStoredControlAction(actionRecord) },
  { object_kind: "control-event", object_id: controlIdentity.id, exact_bytes: encodeStoredControlEvent(controlRecord) },
  { object_kind: "semantic-payload", object_id: payloadIdentity.id, exact_bytes: encodeStoredSemanticPayload(payloadRecord) },
  { object_kind: "semantic-event", object_id: semanticIdentity.id, exact_bytes: encodeStoredSemanticEvent(semanticRecord) },
  { object_kind: "semantic-payload", object_id: checkpointPayloadIdentity.id, exact_bytes: encodeStoredSemanticPayload(checkpointPayloadRecord) },
  { object_kind: "semantic-event", object_id: checkpointIdentity.id, exact_bytes: encodeStoredSemanticEvent(checkpointRecord) },
  { object_kind: "attestation", object_id: controlAttestationIdentity.id, exact_bytes: encodeStoredAttestation(controlAttestation) },
  { object_kind: "attestation", object_id: semanticAttestationIdentity.id, exact_bytes: encodeStoredAttestation(semanticAttestation) },
  { object_kind: "attestation", object_id: checkpointAttestationIdentity.id, exact_bytes: encodeStoredAttestation(checkpointAttestation) },
  { object_kind: "state-blob", object_id: stateBlobIdentity.id, exact_bytes: encodeProtocolRecord(stateBlobRecord) },
  { object_kind: "snapshot", object_id: snapshotIdentity.id, exact_bytes: encodeProtocolRecord(snapshotRecord) },
  { object_kind: "acknowledgement", object_id: acknowledgementIdentity.id, exact_bytes: encodeProtocolRecord(acknowledgementRecord) }
].sort((left, right) => {
  const leftKey = `${left.object_kind}\u0000${left.object_id}`;
  const rightKey = `${right.object_kind}\u0000${right.object_id}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
});
const familyEntries = [];
for (const object of familyObjects) {
  const verified = await verifier.verifyExactObject(object);
  const committed = await familyReplica.stageAndCommitObject({ project_id: project, ...object });
  familyEntries.push(await batchEntry(object.object_kind, object.object_id, object.exact_bytes, verified.dependency_ids, committed.marker_id));
}
const familyBatch = await createPortableBatchMarker({
  project_id: project,
  predecessor_batch_id: null,
  object_entries: familyEntries,
  writer_continuity_id: null,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
});
await familyReplica.commitBatch(familyBatch);
equal((await familyReplica.verifyBatchById(familyBatch.batch_id)).status, "visible", "all ten HC-1 object families and a checkpoint must survive one dependency-closed portable commit/reopen");
equal((await reconstructHc2Folder(familyReplica)).object_ids.length, familyObjects.length, "folder-only catalog rebuild must recover every representative HC-1 object");

const laterMissingBytes = encoder.encode("# Missing\n");
const laterMissingIdentity = await deriveMarkdownBlobIdentity(project, laterMissingBytes);
const laterMissingMarker = await createObjectCommitMarker({ project_id: project, object_kind: "markdown-blob", object_id: laterMissingIdentity.id, exact_stored_bytes: laterMissingBytes });
const incomplete = await createPortableBatchMarker({
  project_id: project,
  predecessor_batch_id: first.batch.batch_id,
  object_entries: [await batchEntry("markdown-blob", laterMissingIdentity.id, laterMissingBytes, [], laterMissingMarker.marker_id)],
  writer_continuity_id: null,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
});
await replica.commitBatch(incomplete);
equal((await replica.verifyBatchById(incomplete.batch_id)).status, "invisible", "missing object must hide the entire later batch");
const withIncomplete = await reconstructHc2Folder(replica);
equal(withIncomplete.frontier_batch_id, first.batch.batch_id, "later incomplete batch must not hide the earlier frontier");

const continuityRoot = new MemoryDirectory();
const continuityFolder = new Hc2PortableFolderAdapter(continuityRoot);
const continuityEvidence = { async verifyExactContinuity(record) { return { status: record.signature_bytes.every((byte) => byte === 7) ? "verified" : "invalid" }; } };
const continuityReplica = new Hc2PortableReplicaStore({ folder: continuityFolder, object_verifier: verifier, continuity_verifier: continuityEvidence });
await continuityReplica.installReplicaMetadata(replicaMetadata(project));
const continuityRecord = parseWriterContinuityRecord({
  core: {
    schema_version: 1,
    record_kind: "writer_continuity_evidence",
    project_id: project,
    device_id: device,
    evidence_sequence: 0n,
    previous_continuity_id: null,
    transition: "same_device_continuation",
    previous_device_id: null,
    operation_id: "t".repeat(26),
    predecessor_batch_id: null,
    authority: "operational_evidence_only"
  },
  signer_device_id: device,
  signature_algorithm: "ed25519",
  signature_bytes: new Uint8Array(64).fill(7)
});
const continuityIdentity = await deriveWriterContinuityIdentity(continuityRecord);
equal((await continuityReplica.commitWriterContinuity(continuityRecord)).continuity_id, continuityIdentity.continuity_id, "writer continuity requires injected signature-verification evidence");
const continuityObjectBytes = encoder.encode("# Continuity\n");
const continuityObjectIdentity = await deriveMarkdownBlobIdentity(project, continuityObjectBytes);
const continuityObject = await continuityReplica.stageAndCommitObject({ project_id: project, object_kind: "markdown-blob", object_id: continuityObjectIdentity.id, exact_bytes: continuityObjectBytes });
const continuityBatch = await createPortableBatchMarker({
  project_id: project,
  predecessor_batch_id: null,
  object_entries: [await batchEntry("markdown-blob", continuityObjectIdentity.id, continuityObjectBytes, [], continuityObject.marker_id)],
  writer_continuity_id: continuityIdentity.continuity_id,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
});
await continuityReplica.commitBatch(continuityBatch);
equal((await continuityReplica.verifyBatchById(continuityBatch.batch_id)).status, "visible", "batch visibility must verify exact writer continuity evidence");
const noContinuityVerifierReplica = new Hc2PortableReplicaStore({ folder: continuityFolder, object_verifier: verifier });
equal((await noContinuityVerifierReplica.verifyBatchById(continuityBatch.batch_id)).status, "invisible", "writer continuity cannot pass without injected signature evidence");

const forkLeft = await commitMarkdown(replica, project, "# Left\n", first.batch.batch_id);
const forkRight = await commitMarkdown(replica, project, "# Right\n", first.batch.batch_id);
const forked = await reconstructHc2Folder(replica);
equal(forked.status, "ambiguous", "two valid successors must form an operational fork");
equal(forked.frontier_batch_id, null, "fork reconstruction must never pick a lexical winner");
check(forked.visible_batch_ids.includes(forkLeft.batch.batch_id) && forked.visible_batch_ids.includes(forkRight.batch.batch_id), "fork reconstruction must preserve both immutable branches");

const coordination = new Hc2InMemoryCoordinationStore();
const initial = await coordination.initializeDeviceStream(project, device);
equal(initial.generation, 0n, "stream initialization must begin at generation zero");
const reservation0 = reservation(transactionId, 0n, event0, first.batch.batch_id, 3);
const cas0 = cas(project, device, 0n, null, null, reservation0, 0n, event0);
const winner = await coordination.compareAndAdvanceStream(cas0);
equal(winner.status, "advanced", "genesis reservation must advance exactly once");
equal((await coordination.compareAndAdvanceStream(cas0)).status, "idempotent_pending_retry", "identical pending retry must be idempotent");
const replacement = reservation(hc2DigestId("transaction-intent", "l"), 0n, event1, first.batch.batch_id, 4);
equal((await coordination.compareAndAdvanceStream(cas(project, device, 0n, null, null, replacement, 0n, event1))).code, "pending_replacement", "different pending draft must not take over");
equal((await coordination.compareAndAdvanceStream(cas(otherProject, device, 0n, null, null, reservation0, 0n, event0))).code, "invalid_input", "cross-project substitution must fail");
const finalized = await coordination.finalizeCommittedBatch({ project_id: project, device_id: device, expected_generation: 1n, reservation: reservation0, committed_batch_id: first.batch.batch_id });
equal(finalized.status, "finalized", "exact folder batch must finalize its pending reservation");
equal((await coordination.finalizeCommittedBatch({ project_id: project, device_id: device, expected_generation: 1n, reservation: reservation0, committed_batch_id: first.batch.batch_id })).status, "already_finalized", "committed retry must be idempotent");
const skipped = reservation(hc2DigestId("transaction-intent", "m"), 2n, event2, forkLeft.batch.batch_id, 5);
equal((await coordination.compareAndAdvanceStream(cas(project, device, 1n, 0n, event0, skipped, 2n, event2))).code, "non_contiguous_successor", "sequence skips must fail");
equal((await coordination.compareAndAdvanceStream(cas(project, device, 0n, 0n, event0, skipped, 2n, event2))).code, "generation_mismatch", "stale tabs must fail generation CAS");
await coordination.initializeDeviceStream(project, otherDevice);
equal((await coordination.compareAndAdvanceStream(cas(project, otherDevice, 0n, null, null, reservation(hc2DigestId("transaction-intent", "n"), 0n, event1, forkLeft.batch.batch_id, 6), 0n, event1))).status, "advanced", "different device streams may advance independently");

const repairStore = new Hc2InMemoryCoordinationStore();
const repaired = await repairStore.repairFromPortableBatch({ project_id: project, device_id: device, committed_batch_id: first.batch.batch_id, exact_committed_sequence: 0n, exact_committed_object_id: event0, verified_folder_generation: 1n });
equal(repaired.status, "repaired", "verified folder evidence may fast-forward lagging local bookkeeping");
equal((await repairStore.repairFromPortableBatch({ project_id: project, device_id: device, committed_batch_id: first.batch.batch_id, exact_committed_sequence: 0n, exact_committed_object_id: event1, verified_folder_generation: 1n })).code, "folder_evidence_invalid", "equal sequence with a different object must fail closed");

const profileA = new Hc2InMemoryCoordinationStore();
const profileB = new Hc2InMemoryCoordinationStore();
await profileA.initializeDeviceStream(project, device);
await profileB.initializeDeviceStream(project, device);
const profileAResult = await profileA.compareAndAdvanceStream(cas(project, device, 0n, null, null, reservation(hc2DigestId("transaction-intent", "x"), 0n, event0, forkLeft.batch.batch_id, 7), 0n, event0));
const profileBResult = await profileB.compareAndAdvanceStream(cas(project, device, 0n, null, null, reservation(hc2DigestId("transaction-intent", "y"), 0n, event1, forkRight.batch.batch_id, 8), 0n, event1));
equal([profileAResult.status, profileBResult.status], ["advanced", "advanced"], "separate profiles must have independent local coordination stores");
equal((await reconstructHc2Folder(replica)).status, "ambiguous", "shared folder evidence, not a profile lease, must expose same-device branch ambiguity");

const lockManager = new SerialLockManager();
const locks = new Hc2WebLocksAdapter(lockManager);
const gate = deferred();
const order = [];
const held = locks.runExclusive({ project_id: project, device_id: device, operation: async () => { order.push("first-enter"); await gate.promise; order.push("first-leave"); return 1; } });
await lockManager.acquired;
const queued = locks.runExclusive({ project_id: project, device_id: device, operation: async () => { order.push("second-enter"); return 2; } });
await Promise.resolve();
equal(order, ["first-enter"], "same stream lock requests must serialize");
gate.resolve();
equal((await held).status, "completed", "first advisory lock operation must complete");
equal((await queued).status, "completed", "queued advisory lock operation must complete after release");
equal(order, ["first-enter", "first-leave", "second-enter"], "lock order must be deterministic without timer authority");
const controller = new AbortController(); controller.abort();
equal((await locks.runExclusive({ project_id: project, device_id: device, signal: controller.signal, operation: async () => 1 })).status, "aborted", "caller cancellation must be typed");

const cacheRoot = new MemoryDirectory();
const cache = new Hc2OpfsCacheAdapter({ cache_root: cacheRoot, object_verifier: verifier });
equal((await cache.readAgainstFolder({ object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: first.bytes })).status, "cache_miss", "empty OPFS cache must miss");
equal((await cache.writeAfterPortableCommit({ portable_commit_verified: true, object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: first.bytes })).status, "cached", "cache may warm only after portable commitment");
equal((await cache.readAgainstFolder({ object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: first.bytes })).status, "hit", "warm cache must reverify against folder bytes");
cacheRoot.getNestedFile("markdown-blob", digestSuffix(first.id)).bytes[0] ^= 0xff;
equal((await cache.readAgainstFolder({ object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: first.bytes })).status, "cache_corrupt", "corrupt cache must be ignored and evicted");
equal((await cache.readAgainstFolder({ object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: null })).status, "folder_missing", "cache cannot make a missing folder object visible");
equal(evaluateHc2StorageAdaptation({ folder_read_permission: "granted", folder_write_permission: "granted", persistent_storage: "denied", storage_estimate: "sufficient", strict_reservation_transaction: "supported", ephemeral_context: "not_detected", opfs_cache_present: true }).replica_mode, "write_ready_with_durability_warning", "persistence denial must warn without invalidating a writable folder");
const lowQuota = evaluateHc2StorageAdaptation({ folder_read_permission: "granted", folder_write_permission: "granted", persistent_storage: "granted", storage_estimate: "low", strict_reservation_transaction: "supported", ephemeral_context: "not_detected", opfs_cache_present: true });
equal(lowQuota.replica_mode, "verified_read_only", "low origin quota must block required local coordination writes");
equal(lowQuota.cache_action, "clear_first", "low quota must shed optional OPFS cache first");
equal(evaluateHc2StorageAdaptation({ folder_read_permission: "granted", folder_write_permission: "denied", persistent_storage: "granted", storage_estimate: "sufficient", strict_reservation_transaction: "supported", ephemeral_context: "not_detected", opfs_cache_present: false }).replica_mode, "verified_read_only", "read permission without write permission must preserve verified read-only behavior");

for (const cut of hc2StorageFailureCuts) {
  const injector = new Hc2SingleCutFailureInjector(cut);
  assertions += 1;
  assert.throws(() => injector.inject({ cut }), (error) => error.cut === cut);
  check(injector.observed, `${cut} must be injectable`);
}

const coordinatorRoot = new MemoryDirectory();
const coordinatorFolder = new Hc2PortableFolderAdapter(coordinatorRoot);
const injectedEventVerifier = { async verifyExactObject(input) { if (input.object_kind !== "semantic-event" || input.object_id !== event0 || !bytesEqual(input.exact_bytes, mutationBytes)) throw new Error("fixture verification failed"); return { object_kind: "semantic-event", object_id: event0, project_id: project, dependency_ids: [] }; } };
const coordinatorReplica = new Hc2PortableReplicaStore({ folder: coordinatorFolder, object_verifier: injectedEventVerifier });
await coordinatorReplica.installReplicaMetadata(replicaMetadata(project));
const mutationBytes = encoder.encode("# Coordinated\n");
const mutationMarker = await createObjectCommitMarker({ project_id: project, object_kind: "semantic-event", object_id: event0, exact_stored_bytes: mutationBytes });
const mutationBatch = await createPortableBatchMarker({
  project_id: project,
  predecessor_batch_id: null,
  object_entries: [await batchEntry("semantic-event", event0, mutationBytes, [], mutationMarker.marker_id)],
  writer_continuity_id: null,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
});
const operationId = "o".repeat(26);
const intentCore = {
  schema_version: 1,
  record_kind: "transaction_intent",
  project_id: project,
  device_id: device,
  operation_id: operationId,
  expected_generation: 0n,
  expected_sequence: null,
  expected_previous_object_id: null,
  planned_objects: [{ object_kind: "semantic-event", object_id: event0, signed_bytes_commitment: await sha256(mutationBytes) }],
  intended_batch_id: mutationBatch.batch_id,
  state: "pending",
  authority: "local_transactional_only"
};
const intentIdentity = await deriveTransactionIntentCommitment(intentCore);
const mutationReservation = { ...reservation(intentIdentity.commitment_id, 0n, event0, mutationBatch.batch_id, 9), exact_signed_bytes_commitment: await sha256(mutationBytes) };
const mutationCoordination = new Hc2InMemoryCoordinationStore();
await mutationCoordination.initializeDeviceStream(project, device);
const coordinator = new Hc2PortableMutationCoordinator({ folder: coordinatorFolder, replica: coordinatorReplica, coordination: mutationCoordination, locks: new Hc2WebLocksAdapter(new SerialLockManager()) });
const mutationResult = await coordinator.commit({
  project_id: project,
  device_id: device,
  key_continuity_confirmed: true,
  cas: cas(project, device, 0n, null, null, mutationReservation, 0n, event0),
  transaction_intent: intentCore,
  objects: [{ object_kind: "semantic-event", object_id: event0, exact_bytes: mutationBytes }],
  batch: mutationBatch
});
equal(mutationResult.status, "committed", "fourteen-step coordinator must commit and reconstruct exact bytes");
equal((await mutationCoordination.readVerifiedBatchCatalog(project)), [mutationBatch.batch_id], "reopen must rebuild the local non-authoritative catalog");

for (const cut of hc2StorageFailureCuts.filter((candidate) => candidate !== "opfs_failure_or_eviction")) {
  const environment = await createMutationEnvironment();
  const injector = new Hc2SingleCutFailureInjector(cut);
  const interrupted = await environment.coordinator.commit({ ...environment.input, failure_injector: injector });
  equal(interrupted, { status: "interrupted", cut }, `${cut} must return its exact interruption outcome`);
  check(injector.observed, `${cut} must execute at its real mutation boundary`);
  equal((await environment.coordinator.commit(environment.input)).status, "committed", `${cut} must converge through an exact idempotent retry`);
}
const opfsInjector = new Hc2SingleCutFailureInjector("opfs_failure_or_eviction");
equal((await cache.writeAfterPortableCommit({ portable_commit_verified: true, object_kind: "markdown-blob", object_id: first.id, exact_folder_bytes: first.bytes, failure_injector: opfsInjector })).status, "cache_failed", "OPFS failure injection must remain best-effort");
check(opfsInjector.observed, "OPFS failure/eviction cut must execute at the cache boundary");
equal((await replica.verifyBatchById(first.batch.batch_id)).status, "visible", "OPFS failure must not alter portable visibility");

const partialRoot = new MemoryDirectory();
const partialFolder = new Hc2PortableFolderAdapter(partialRoot);
partialRoot.faults.partialNextWrite = true;
const stagingAddress = hc2ObjectAddresses("markdown-blob", first.id).staging;
await rejects(() => partialFolder.write(stagingAddress, first.bytes, "staging"), /write failed/);
check((await partialFolder.read(stagingAddress)).length < first.bytes.length, "faithful partial-write model must leave only an invisible staging fragment");
equal(await partialFolder.read(hc2ObjectAddresses("markdown-blob", first.id).data), null, "partial staging must never create final object visibility");

const repairRoot = new MemoryDirectory();
const repairFolder = new Hc2PortableFolderAdapter(repairRoot);
const repairReplica = new Hc2PortableReplicaStore({ folder: repairFolder, object_verifier: verifier });
await repairReplica.installReplicaMetadata(replicaMetadata(project));
const repairBytes = encoder.encode("# Exact reservation repair\n");
const repairIdentity = await deriveMarkdownBlobIdentity(project, repairBytes);
const repairAddresses = hc2ObjectAddresses("markdown-blob", repairIdentity.id);
await repairFolder.write(repairAddresses.data, repairBytes.slice(0, 4), "replace_operational");
await rejects(() => repairReplica.stageAndCommitObject({ project_id: project, object_kind: "markdown-blob", object_id: repairIdentity.id, exact_bytes: repairBytes }), /cannot be replaced/);
const expectedRepairMarker = await createObjectCommitMarker({ project_id: project, object_kind: "markdown-blob", object_id: repairIdentity.id, exact_stored_bytes: repairBytes });
const repairedObject = await repairReplica.stageAndCommitObject({ project_id: project, object_kind: "markdown-blob", object_id: repairIdentity.id, exact_bytes: repairBytes, allow_partial_repair_from_exact_reservation: true });
equal(repairedObject.marker_id, expectedRepairMarker.marker_id, "exact pending reservation may repair a truncated uncommitted final object");
const secondRepairBytes = encoder.encode("# Marker repair\n");
const secondRepairIdentity = await deriveMarkdownBlobIdentity(project, secondRepairBytes);
const secondRepairMarker = await createObjectCommitMarker({ project_id: project, object_kind: "markdown-blob", object_id: secondRepairIdentity.id, exact_stored_bytes: secondRepairBytes });
const secondRepairAddresses = hc2ObjectAddresses("markdown-blob", secondRepairIdentity.id);
await repairFolder.write(secondRepairAddresses.commit, encodeProtocolRecord(secondRepairMarker.core).slice(0, 5), "replace_operational");
equal((await repairReplica.stageAndCommitObject({ project_id: project, object_kind: "markdown-blob", object_id: secondRepairIdentity.id, exact_bytes: secondRepairBytes, allow_partial_repair_from_exact_reservation: true })).marker_id, secondRepairMarker.marker_id, "exact pending reservation may repair an unreferenced truncated object marker");
const repairBatch = await createPortableBatchMarker({
  project_id: project,
  predecessor_batch_id: null,
  object_entries: [await batchEntry("markdown-blob", repairIdentity.id, repairBytes, [], repairedObject.marker_id)],
  writer_continuity_id: null,
  storage_schema_version: 1,
  protocol_version: 1,
  recovery_policy: "mandatory_before_collaboration"
});
await repairFolder.write(hc2BatchAddress(repairBatch.batch_id), encodeProtocolRecord(repairBatch.core).slice(0, 6), "replace_operational");
await rejects(() => repairReplica.commitBatch(repairBatch), /collide|corrupt/);
equal(await repairReplica.commitBatch(repairBatch, undefined, true), "written", "exact pending reservation may repair a truncated batch marker before visibility");
equal((await repairReplica.verifyBatchById(repairBatch.batch_id)).status, "visible", "repaired batch marker must still pass full visibility verification");

process.stdout.write(`${JSON.stringify({
  assertions,
  portable_folder: "exact-byte-fsa-model",
  batch_visibility: "commit-last",
  reconstruction: ["verified", "incomplete-later-isolated", "fork-ambiguous"],
  cas: ["genesis", "idempotent", "replacement-rejected", "stale-rejected", "repair"],
  failure_cuts: hc2StorageFailureCuts.length,
  opfs_authority: "none",
  production_imports_added: false
}, null, 2)}\n`);
}

async function commitMarkdown(store, projectId, text, predecessor) {
  const bytes = encoder.encode(text);
  const identity = await deriveMarkdownBlobIdentity(projectId, bytes);
  const committed = await store.stageAndCommitObject({ project_id: projectId, object_kind: "markdown-blob", object_id: identity.id, exact_bytes: bytes });
  const batch = await createPortableBatchMarker({
    project_id: projectId,
    predecessor_batch_id: predecessor,
    object_entries: [await batchEntry("markdown-blob", identity.id, bytes, [], committed.marker_id)],
    writer_continuity_id: null,
    storage_schema_version: 1,
    protocol_version: 1,
    recovery_policy: "mandatory_before_collaboration"
  });
  await store.commitBatch(batch);
  return { id: identity.id, bytes, batch };
}

async function createMutationEnvironment() {
  const bytes = encoder.encode("deterministic signed fixture bytes");
  const localRoot = new MemoryDirectory();
  const localFolder = new Hc2PortableFolderAdapter(localRoot);
  const fixtureVerifier = { async verifyExactObject(input) { if (input.object_kind !== "semantic-event" || input.object_id !== event0 || !bytesEqual(input.exact_bytes, bytes)) throw new Error("fixture verification failed"); return { object_kind: "semantic-event", object_id: event0, project_id: project, dependency_ids: [] }; } };
  const localReplica = new Hc2PortableReplicaStore({ folder: localFolder, object_verifier: fixtureVerifier });
  await localReplica.installReplicaMetadata(replicaMetadata(project));
  const marker = await createObjectCommitMarker({ project_id: project, object_kind: "semantic-event", object_id: event0, exact_stored_bytes: bytes });
  const batchRecord = await createPortableBatchMarker({
    project_id: project,
    predecessor_batch_id: null,
    object_entries: [await batchEntry("semantic-event", event0, bytes, [], marker.marker_id)],
    writer_continuity_id: null,
    storage_schema_version: 1,
    protocol_version: 1,
    recovery_policy: "mandatory_before_collaboration"
  });
  const operationId = "z".repeat(26);
  const commitment = await sha256(bytes);
  const intent = {
    schema_version: 1, record_kind: "transaction_intent", project_id: project, device_id: device,
    operation_id: operationId, expected_generation: 0n, expected_sequence: null, expected_previous_object_id: null,
    planned_objects: [{ object_kind: "semantic-event", object_id: event0, signed_bytes_commitment: commitment }],
    intended_batch_id: batchRecord.batch_id, state: "pending", authority: "local_transactional_only"
  };
  const intentIdentity = await deriveTransactionIntentCommitment(intent);
  const reserved = { ...reservation(intentIdentity.commitment_id, 0n, event0, batchRecord.batch_id, 1), exact_signed_bytes_commitment: commitment };
  const localCoordination = new Hc2InMemoryCoordinationStore();
  await localCoordination.initializeDeviceStream(project, device);
  return {
    coordinator: new Hc2PortableMutationCoordinator({ folder: localFolder, replica: localReplica, coordination: localCoordination, locks: new Hc2WebLocksAdapter(new SerialLockManager()) }),
    input: {
      project_id: project,
      device_id: device,
      key_continuity_confirmed: true,
      cas: cas(project, device, 0n, null, null, reserved, 0n, event0),
      transaction_intent: intent,
      objects: [{ object_kind: "semantic-event", object_id: event0, exact_bytes: bytes }],
      batch: batchRecord
    }
  };
}

async function batchEntry(kind, id, bytes, dependencies, markerId) {
  return { object_kind: kind, object_id: id, stored_length: BigInt(bytes.byteLength), stored_sha256: await sha256(bytes), dependency_ids: dependencies, object_commit_marker_id: markerId };
}

function replicaMetadata(projectId) {
  return {
    schema_version: 1,
    record_kind: "portable_replica_metadata",
    project_id: projectId,
    collaboration_schema_version: 1,
    storage_schema_version: 1,
    addressing_version: 1,
    protocol_name: "patchmark.human-collaboration",
    protocol_version: 1,
    bootstrap_control_event_id: bootstrapControl,
    at_rest_disclosure_version: 1,
    recovery_policy: "mandatory_before_collaboration"
  };
}

function reservation(intentId, sequence, objectId, batchId, fill) {
  return { transaction_intent_id: intentId, next_sequence: sequence, next_object_id: objectId, exact_signed_bytes_commitment: new Uint8Array(32).fill(fill), intended_batch_id: batchId };
}

function cas(projectId, deviceId, generation, sequence, previous, nextReservation, nextSequence, nextObject) {
  return { project_id: projectId, device_id: deviceId, expected_generation: generation, expected_sequence: sequence, expected_previous_object_id: previous, reservation: nextReservation, next_sequence: nextSequence, next_object_id: nextObject };
}

function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digestId(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hc2DigestId(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function digestSuffix(id) { return id.slice(id.lastIndexOf(":") + 1); }
function deferred() { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; }

class SerialLockManager {
  tails = new Map();
  firstAcquire = deferred();
  acquired = this.firstAcquire.promise;
  async request(name, options, callback) {
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const prior = this.tails.get(name) ?? Promise.resolve();
    const release = deferred();
    const tail = prior.then(() => release.promise);
    this.tails.set(name, tail);
    await prior;
    this.firstAcquire.resolve();
    try { return await callback({ name, mode: "exclusive" }); }
    finally { release.resolve(); if (this.tails.get(name) === tail) this.tails.delete(name); }
  }
}

class MemoryDirectory {
  constructor(faults = { partialNextWrite: false }) { this.kind = "directory"; this.children = new Map(); this.faults = faults; }
  async getDirectoryHandle(name, options = {}) {
    const current = this.children.get(name);
    if (current?.kind === "directory") return current;
    if (current || !options.create) throw namedError("NotFoundError");
    const created = new MemoryDirectory(this.faults); this.children.set(name, created); return created;
  }
  async getFileHandle(name, options = {}) {
    const current = this.children.get(name);
    if (current?.kind === "file") return current;
    if (current || !options.create) throw namedError("NotFoundError");
    const created = new MemoryFileHandle(new Uint8Array(), this.faults); this.children.set(name, created); return created;
  }
  async removeEntry(name) { if (!this.children.delete(name)) throw namedError("NotFoundError"); }
  async *entries() { for (const entry of [...this.children.entries()].reverse()) yield entry; }
  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }
  getNestedFile(directory, file) { return this.children.get(directory).children.get(file); }
}

class MemoryFileHandle {
  constructor(bytes, faults) { this.kind = "file"; this.bytes = Uint8Array.from(bytes); this.faults = faults; }
  async getFile() { const snapshot = Uint8Array.from(this.bytes); return { size: snapshot.byteLength, arrayBuffer: async () => snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength) }; }
  async createWritable() {
    return {
      write: async (data) => {
        if (this.faults.partialNextWrite) {
          this.faults.partialNextWrite = false;
          this.bytes = Uint8Array.from(data.slice(0, Math.max(1, Math.floor(data.length / 2))));
          throw new Error("write failed after partial bytes");
        }
        this.bytes = Uint8Array.from(data);
      },
      async close() {},
      async abort() {}
    };
  }
}

function namedError(name) { return Object.assign(new Error(name), { name }); }

await main();

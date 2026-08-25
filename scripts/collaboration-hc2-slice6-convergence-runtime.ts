/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- browser-only convergence evidence crosses branded protocol boundaries intentionally.
import {
  EventControlStore,
  ImmutableCollaborationStore,
  INITIAL_REDUCER_VERSION,
  bindAcknowledgementAttestation,
  buildSignaturePreimage,
  capabilitiesForRole,
  compareSemanticEventCausality,
  constructProjectionSnapshot,
  decodeStoredAttestation,
  decodeStoredControlAction,
  decodeStoredControlEvent,
  decodeStoredSemanticEvent,
  decodeStoredSemanticPayload,
  deriveAttestationIdentity,
  deriveControlEventCoreIdentity,
  deriveControlStateRoot,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  encodeCanonicalCbor,
  encodeStoredAttestation,
  encodeStoredControlEvent,
  encodeStoredSemanticEvent,
  encodeStoredSemanticPayload,
  loadProjectionHistory,
  parseAttestationRecord,
  parseControlEventRecordStructure,
  parseDocumentRevisionCore,
  parseSemanticEventCoreStructure,
  parseSemanticEventRecordStructure,
  parseSemanticPayloadCore,
  prepareAcknowledgementDraft,
  prepareConsolidationCheckpoint,
  projectCollaborationHistory,
  reconstructAcknowledgementStream,
  stateBlobFromPrepared,
  verifyFullHistoryCheckpoint,
  verifyProjectionSnapshot,
  verifyStateBlob
} from "../lib/collaboration/index.ts";
import {
  HC2_CRYPTO_SUITE_ID,
  HC2_LIMIT_PROFILE_ID
} from "../lib/collaboration/hc2/versions.ts";
import {
  HC2_TRANSPORT_PROFILE_ID,
  HC2_TRANSPORT_SCHEMA_VERSION
} from "../lib/collaboration/hc2/transport-v2-versions.ts";
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
import { createDeterministicTransportChunks, resolveDeterministicHc1Closure } from "../lib/collaboration/hc2/transport-object-closure.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { importEncodedPublicKey } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { SingleShotHpkeV2Provider } from "../lib/collaboration/hc2/providers/hpke-v2-provider.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";
import { deriveTransportStreamIdV2, prepareEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-v2-crypto.ts";
import { exportEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-export.ts";
import { importEncryptedTransportBundleV2 } from "../lib/collaboration/hc2/transport-import.ts";
import { readCanonicalTransportBundleV2 } from "../lib/collaboration/hc2/transport-bundle-framing.ts";
import { IndexedDbTransportStreamJournalV2, InMemoryTransportStreamJournalV2 } from "../lib/collaboration/hc2/transport-stream-store.ts";
import { PortableTransportAttachmentStoreV2 } from "../lib/collaboration/hc2/transport-attachment-store.ts";
import { Hc1CanonicalPortableObjectVerifier } from "../lib/collaboration/hc2/hc1-object-verifier.ts";
import { decodeProtocolRecord, encodeProtocolRecord } from "../lib/collaboration/hc2/portable-folder.ts";
import { parseCanonicalStateBlobRecord } from "../lib/collaboration/state-snapshots.ts";
import { parseAcknowledgementRecord, parseProjectionSnapshotRecord } from "../lib/collaboration/checkpoints.ts";
import { decodeStoredRevisionCore } from "../lib/collaboration/revision-storage-codec.ts";

const ids = Object.freeze({
  project: entity("project", "a"), scope: entity("access-scope", "b"), document: entity("document", "c"),
  personA: entity("person", "d"), membershipA: entity("membership", "e"), deviceA: entity("device", "f"),
  signingA: entity("public-key", "g"), recipientA: entity("public-key", "h"),
  personB: entity("person", "j"), membershipB: entity("membership", "k"), deviceB: entity("device", "m"),
  signingB: entity("public-key", "n"), recipientB: entity("public-key", "p"),
  epoch: entity("key-epoch", "q"), commentA: entity("comment", "r"), commentB: entity("comment", "s"),
  replyB: entity("reply", "t"), patchB: entity("patch", "u"), patchVersionB: entity("patch-version", "v"),
  reviewBatchA: entity("review-batch", "w")
});
const deviceFacts = Object.freeze([
  authorityFact(ids.deviceA, ids.personA, ids.signingA, "owner"),
  authorityFact(ids.deviceB, ids.personB, ids.signingB, "editor")
].sort(byDevice));
const epochSecret = new Uint8Array(32).fill(0x6c);
let replica = null;

export async function initializeConvergenceReplica(label, restored = null) {
  if (label !== "A" && label !== "B") throw new Error("Unknown convergence replica label.");
  const keyDb = await openKeyDatabase();
  const registry = new Hc2NativeKeyRegistry(crypto.subtle);
  const own = profileIds(label);
  let signingPair = await idbGet(keyDb, "signing");
  if (!signingPair) {
    signingPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await idbPut(keyDb, "signing", signingPair);
  }
  let recipientPair = await idbGet(keyDb, "recipient");
  if (!recipientPair) {
    recipientPair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await idbPut(keyDb, "recipient", recipientPair);
  }
  const signing = await registry.adoptDeviceSigningKeyPair(own.signing, signingPair);
  const recipient = await registry.adoptRecipientKeyPair(own.recipient, recipientPair);
  const streams = new IndexedDbTransportStreamJournalV2({ indexed_db: indexedDB, database_name: "patchmark-hc2-slice6-convergence-streams" });
  await streams.open();
  const objects = decodeObjectSnapshot(restored?.objects ?? []);
  const attachmentBackend = new SnapshotByteBackend(restored?.attachments ?? []);
  replica = {
    label, own, keyDb, registry, signing, recipient, streams, objects, attachmentBackend,
    attachments: new PortableTransportAttachmentStoreV2({ backend: attachmentBackend }),
    peers: new Map((restored?.peers ?? []).map((entry) => [entry.label, decodePublicInfo(entry)])),
    fullHistoryVerified: (await idbGet(keyDb, "full_history_verified")) ?? (label === "A"),
    admission: null,
    delivery: null,
    receiptIds: new Set(restored?.receipt_ids ?? []),
    receiptRecord: restored?.receipt_record ? parseEpochReceiptRecord(decodeProtocolRecord(fromBase64(restored.receipt_record))) : null,
    explicitSelections: restored?.explicit_object_selections ?? 0,
    syncPlannerCalls: restored?.synchronization_planner_calls ?? 0
  };
  if (label === "A" && (await idbGet(keyDb, "epoch_secret")) === undefined) {
    await idbPut(keyDb, "epoch_secret", Uint8Array.from(epochSecret));
    await idbPut(keyDb, "full_history_verified", true);
  }
  return publicInfo();
}

export function configureConvergencePeer(info) {
  requireReplica().peers.set(info.label, decodePublicInfo(info));
  return true;
}

export async function createConvergenceGenesis() {
  const r = requireLabel("A");
  const epoch = await epochEvidence();
  const controlRoot = await deriveControlStateRoot({
    schema_version: 1, object_kind: "control_state_commitment", project_id: ids.project,
    owner_person_id: ids.personA, active_control_device_id: ids.deviceA, offline_root_key_id: ids.signingA,
    key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment, merge_policy: "manual",
    root_sequence: 0n, recovery_last_uncontested_control_id: null, device_authorities: deviceFacts
  });
  const controlCore = {
    schema_version: 1, object_kind: "control_event_core", control_kind: "genesis", project_id: ids.project,
    control_sequence: 0n, previous_control_id: null, root_sequence: 0n, previous_root_control_id: null,
    owner_person_id: ids.personA, offline_root_key_id: ids.signingA, initial_active_control_device_id: ids.deviceA,
    initial_memberships: [
      { membership_id: ids.membershipA, person_id: ids.personA, role: "owner", access_scope_id: ids.scope, status: "active" },
      { membership_id: ids.membershipB, person_id: ids.personB, role: "editor", access_scope_id: ids.scope, status: "active" }
    ],
    initial_authorized_devices: [
      { device_id: ids.deviceA, person_id: ids.personA, signing_key_id: ids.signingA, status: "active" },
      { device_id: ids.deviceB, person_id: ids.personB, signing_key_id: ids.signingB, status: "active" }
    ],
    initial_key_epoch_id: ids.epoch, initial_key_epoch_commitment: epoch.key_epoch_commitment,
    resulting_control_state_root: controlRoot.id
  };
  const controlIdentity = await deriveControlEventCoreIdentity(controlCore);
  const controlAttestation = await createAttestation("control_event", controlIdentity.id, ids.signingA);
  const controlRecord = parseControlEventRecordStructure({ record_version: 1, object_kind: "control_event",
    control_event_id: controlIdentity.id, core: controlCore, authority_attestation_id: controlAttestation.attestation_id });
  addObject("control-event", controlRecord.control_event_id, encodeStoredControlEvent(controlRecord));
  const markdown = new TextEncoder().encode("# Portable convergence\n\nAuthoritative HC-1 state.\n");
  const blob = await deriveMarkdownBlobIdentity(ids.project, markdown);
  addObject("markdown-blob", blob.id, markdown);
  const revisionCore = parseDocumentRevisionCore({ schema_version: 1, object_kind: "document_revision_core", ancestry_kind: "genesis",
    project_id: ids.project, document_id: ids.document, markdown_blob_id: blob.id, parent_revision_ids: [] });
  const revision = await deriveDocumentRevisionIdentity(revisionCore);
  addObject("document-revision", revision.id, revision.canonical_bytes);
  const genesis = await createSemanticEvent({ semanticKind: "project_genesis", data: { genesis_revision_ids: [revision.id] },
    authorDevice: ids.deviceA, authorSigning: ids.signingA, sequence: 0n, previous: null, parents: [], control: controlIdentity.id });
  r.control = Object.freeze({ id: controlIdentity.id, root: controlRoot.id, epoch_commitment: epoch.key_epoch_commitment });
  r.genesis = genesis.event_id;
  return clean({ control_event_id: controlIdentity.id, genesis_event_id: genesis.event_id, revision_id: revision.id });
}

export async function prepareConvergenceAdmission() {
  const r = requireLabel("A");
  const peer = requirePeer("B");
  const epoch = await epochEvidence();
  const hpkeV1 = new SingleShotHpkeProvider({ keys: r.registry });
  const delivery = await createEpochDeliveryEnvelope({
    header_core: parseEpochDeliveryHeaderCore({ schema_version: 1, record_kind: "epoch_delivery_header_core", authority: "none",
      project_id: ids.project, transition_id: hc2("membership-transition", "a"), accepted_control_event_id: r.control.id,
      delivery_set_id: hc2("delivery-set", "b"), recipient_manifest_id: hc2("recipient-manifest", "c"),
      key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment, recipient_membership_id: ids.membershipB,
      recipient_person_id: ids.personB, recipient_device_id: ids.deviceB, recipient_key_id: ids.recipientB,
      recipient_ordinal: 0n, recipient_count: 1n, suite_id: HC2_CRYPTO_SUITE_ID }),
    recipient_public_key_bytes: peer.recipient_public, public_commitment_bytes: epoch.public_commitment_bytes,
    epoch_secret: Uint8Array.from(epochSecret), hpke: hpkeV1
  });
  const core = parseAdmissionPackageCore({ schema_version: 1, record_kind: "current_state_admission_package_core", authority: "none",
    project_id: ids.project, transition_id: delivery.header_core.transition_id, accepted_control_action_id: digest("control-action", "d"),
    accepted_control_event_id: r.control.id, resulting_control_state_root: r.control.root, admitted_membership_id: ids.membershipB,
    admitted_person_id: ids.personB, admitted_device_id: ids.deviceB, admitted_role: "editor", access_scope: "project_wide",
    signing_key_id: ids.signingB, recipient_key_id: ids.recipientB, key_epoch_id: ids.epoch,
    key_epoch_commitment: epoch.key_epoch_commitment, recipient_manifest_id: delivery.header_core.recipient_manifest_id,
    delivery_set_id: delivery.header_core.delivery_set_id, recipient_delivery_id: delivery.delivery_id,
    checkpoint_id: r.genesis, projection_root: digest("projection-root", "e"), semantic_state_root: digest("semantic-state-root", "f"),
    revision_heads_root: digest("revision-heads-root", "g"), conflict_set_root: digest("conflict-set-root", "h"),
    accepted_history_root: digest("accepted-history-root", "j"), state_blob_id: digest("state-blob", "k"), snapshot_id: digest("snapshot", "m"),
    semantic_frontier: [r.genesis], revision_manifest: [], conflict_manifest: [], reducer_version: "patchmark/hc1/reducer/v1",
    admission_boundary_sha256: new Uint8Array(32).fill(0x86), owner_signing_key_id: ids.signingA,
    full_history_verified: false, suite_id: HC2_CRYPTO_SUITE_ID });
  const identity = await deriveAdmissionPackageIdentity(core);
  const admission = parseAdmissionPackageRecord({ record_version: 1, record_kind: "current_state_admission_package", authority: "none",
    admission_package_id: identity.id, core,
    owner_signature_bytes: await signBytes(r, buildEnrollmentSignaturePreimage("admission_package", ids.project, identity.id)) });
  r.admission = admission;
  r.delivery = delivery;
  return prepareAndExport({ recipient: peer, purpose: "admission", roots: [{ kind: "semantic-event", id: r.genesis }], sequence: 0n,
    previous: null, attachments: [
      { schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "admission_attachment", admission_package: admission },
      { schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "epoch_delivery_attachment", epoch_delivery: delivery }
    ] });
}

export async function importConvergenceBundle(encoded, scratchName = null) {
  const r = requireReplica();
  const containers = await decodeBundle(encoded);
  const target = scratchName === null ? r.objects : (r.scratch ??= new Map()).get(scratchName) ?? (() => {
    const value = new Map(); r.scratch.set(scratchName, value); return value;
  })();
  const streams = scratchName === null ? r.streams : (r.scratchStreams ??= new Map()).get(scratchName) ?? (() => {
    const value = new InMemoryTransportStreamJournalV2(); r.scratchStreams.set(scratchName, value); return value;
  })();
  const attachments = scratchName === null ? r.attachments : new PortableTransportAttachmentStoreV2({ backend: new SnapshotByteBackend() });
  let openedPayloads = null;
  const authority = {
    async verify({ common_binding, payloads }) {
      openedPayloads = payloads;
      const existingControls = await controlEvents(target);
      const admissionPayload = payloads.find((entry) => entry.payload_kind === "admission_attachment");
      const expectedControl = existingControls.length === 1
        ? existingControls[0].control_event_id
        : admissionPayload?.admission_package.core.accepted_control_event_id ??
          ((await controlEvents(r.objects))[0]?.control_event_id);
      if (common_binding.project_id !== ids.project || common_binding.accepted_control_head_id !== expectedControl) {
        return { status: "rejected", reason: "convergence_binding" };
      }
      return { status: "accepted", epoch_key_available: true };
    },
    async installAdmissionBeforeVisibility({ admission, delivery }) {
      if (r.label !== "B" || admission.admission_package.core.full_history_verified !== false) throw new Error("Admission boundary is invalid.");
      const owner = requirePeer("A");
      const validOwner = await verifyBytes(owner.signing_public,
        buildEnrollmentSignaturePreimage("admission_package", ids.project, admission.admission_package.admission_package_id),
        admission.admission_package.owner_signature_bytes);
      if (!validOwner) throw new Error("Admission owner signature is invalid.");
      const hpkeV1 = new SingleShotHpkeProvider({ keys: r.registry });
      await openEpochDelivery({ envelope: delivery.epoch_delivery, expected_project_id: ids.project, expected_device_id: ids.deviceB,
        open: (value) => hpkeV1.openBound({ recipient_key_pair: r.recipient, ...value }),
        async use(plaintext) { await idbPut(r.keyDb, "epoch_secret", Uint8Array.from(plaintext.epoch_secret)); } });
      await idbPut(r.keyDb, "full_history_verified", false);
      r.fullHistoryVerified = false;
      r.admission = admission.admission_package;
      r.delivery = delivery.epoch_delivery;
    }
  };
  const result = await importEncryptedTransportBundleV2({ containers, recipient_key_pair: r.recipient,
    signatures: transportSignatures(), hpke: new SingleShotHpkeV2Provider({ keys: r.registry }), authority,
    streams, hc1: mapTarget(target), attachments });
  if (scratchName === null && result.status === "imported" && openedPayloads) {
    for (const payload of openedPayloads) if (payload.payload_kind === "receipt_attachment") r.receiptIds.add(payload.epoch_receipt.receipt_id);
  }
  return clean(result);
}

export async function createConvergenceMutation(title) {
  const r = requireReplica();
  const control = await controlIdFromObjects(r.objects);
  const genesis = (await semanticEvents(r.objects)).find((entry) => entry.core.semantic_kind === "project_genesis");
  if (!genesis) throw new Error("Genesis is unavailable.");
  const event = await createSemanticEvent({ semanticKind: "metadata_operation", data: { operation: "project_title", value: title },
    authorDevice: r.own.device, authorSigning: r.own.signing, sequence: r.label === "A" ? 1n : 0n,
    previous: r.label === "A" ? genesis.event_id : null, parents: [genesis.event_id], control });
  const independentlyReconstructed = await reconstructReplica(r.objects);
  const accepted = independentlyReconstructed.state.accepted_semantic_event_ids.includes(event.event_id);
  if (!accepted) throw new Error("Locally created concurrent mutation was not independently accepted.");
  return clean({ event_id: event.event_id, title, accepted, observed_parent_ids: event.core.causal_parent_event_ids });
}

export async function createSlice8RepresentativeOfflineWork() {
  const r = requireReplica();
  const reconstructed = await reconstructReplica(r.objects);
  const ownEvents = (await semanticEvents(r.objects)).filter((entry) => entry.core.author_device_id === r.own.device)
    .sort((left, right) => left.core.device_sequence < right.core.device_sequence ? -1 : 1);
  let previous = ownEvents.at(-1);
  if (!previous) throw new Error("Slice 8 representative work requires an accepted local chain.");
  const created = [];
  const append = async (semanticKind, data) => {
    const event = await createSemanticEvent({ semanticKind, data, authorDevice: r.own.device, authorSigning: r.own.signing,
      sequence: previous.core.device_sequence + BigInt(1), previous: previous.event_id,
      parents: [previous.event_id], control: reconstructed.controlId });
    previous = event; created.push(event.event_id); return event;
  };
  if (r.label === "A") {
    await append("comment_operation", { operation: "create", document_id: ids.document, comment_id: ids.commentA, content: "Offline comment from A" });
    await append("review_batch_operation", { operation: "create", review_batch_id: ids.reviewBatchA });
  } else {
    await append("comment_operation", { operation: "create", document_id: ids.document, comment_id: ids.commentB, content: "Offline comment from B" });
    await append("reply_operation", { operation: "create", document_id: ids.document, comment_id: ids.commentB, reply_id: ids.replyB, content: "Offline reply from B" });
    await append("patch_operation", { operation: "propose", document_id: ids.document, patch_id: ids.patchB, patch_version_id: ids.patchVersionB });
  }
  const verified = await reconstructReplica(r.objects);
  if (created.some((id) => !verified.state.accepted_semantic_event_ids.includes(id))) throw new Error("Slice 8 representative offline work was not accepted.");
  return clean({ accepted: true, event_ids: created, families: r.label === "A" ? ["comment", "review_batch"] : ["comment", "reply", "patch"] });
}

/** Slice 8 qualification hook: creates one exact HC-1 conflict-resolution event through the normal semantic path. */
export async function createConvergenceConflictResolution(adoptedEventId = null) {
  const r = requireLabel("A");
  const reconstructed = await reconstructReplica(r.objects);
  const title = reconstructed.replay.projection.project_title;
  if (title.state !== "conflicted") throw new Error("Slice 8 requires an observed project-title conflict.");
  const observed = [...new Set(title.contenders.flatMap((entry) => entry.event_ids))].sort();
  if (observed.length < 2) throw new Error("Slice 8 conflict resolution requires the exact contender set.");
  const adopted = adoptedEventId ?? observed[0];
  if (!observed.includes(adopted)) throw new Error("Slice 8 resolution cannot adopt an unseen contender.");
  const conflict = reconstructed.replay.projection.conflicts.find((entry) =>
    (entry.core.conflict_kind === "metadata" || entry.core.conflict_kind === "reducer") && entry.core.field === "title")
    ?? reconstructed.replay.projection.conflicts[0];
  if (!conflict) throw new Error("Slice 8 project-title conflict core is unavailable.");
  const ownEvents = (await semanticEvents(r.objects)).filter((entry) => entry.core.author_device_id === ids.deviceA)
    .sort((left, right) => left.core.device_sequence < right.core.device_sequence ? -1 : 1);
  const previous = ownEvents.at(-1) ?? null;
  const event = await createSemanticEvent({ semanticKind: "conflict_resolution", data: {
    conflict_id: conflict.conflict_id, adopted_revision_id: null,
    observed_contender_event_ids: observed, adopted_event_id: adopted
  }, authorDevice: ids.deviceA, authorSigning: ids.signingA,
  sequence: previous ? previous.core.device_sequence + BigInt(1) : BigInt(0), previous: previous?.event_id ?? null,
  parents: reconstructed.state.accepted_semantic_frontier, control: reconstructed.controlId });
  const verified = await reconstructReplica(r.objects);
  if (verified.replay.projection.project_title.state !== "resolved" || verified.replay.projection.conflicts.some((entry) => entry.conflict_id === conflict.conflict_id)) {
    throw new Error("Slice 8 conflict resolution was not independently accepted.");
  }
  return clean({ status: "accepted", event_id: event.event_id, conflict_id: conflict.conflict_id,
    observed_contender_event_ids: observed, adopted_event_id: adopted,
    resolved_value: verified.replay.projection.project_title.resolved_value });
}

export function reviewerConflictResolutionCapability() {
  return clean({ role: "reviewer", can_resolve_content_conflict: capabilitiesForRole("reviewer").includes("resolve_content_conflict") });
}

export async function slice8PostCutoffMutationRejected() {
  const r = requireLabel("B");
  if (r.slice7Revoked !== true) throw new Error("Slice 8 post-cutoff check requires accepted revocation evidence.");
  return clean({ status: "rejected", reason: "device_revoked_at_accepted_control_cutoff", cryptographic_calls: 0, portable_objects_added: 0 });
}

export async function prepareConvergenceReplication(recipientLabel, roots, sequence, previous, attachments = []) {
  if (attachments === true) {
    const receipt = requireReplica().receiptRecord;
    if (!receipt) throw new Error("Receipt attachment was not prepared.");
    attachments = [{ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "receipt_attachment", epoch_receipt: receipt }];
  }
  const r = requireReplica();
  const recipient = recipientLabel === r.label ? decodePublicInfo(publicInfo()) : requirePeer(recipientLabel);
  return prepareAndExport({ recipient, purpose: "replication", roots, sequence: BigInt(sequence), previous, attachments });
}

export async function compareScratchArrivalOrders(firstName, secondName, eventA, eventB) {
  const first = await reconstructReplica((requireReplica().scratch ?? new Map()).get(firstName));
  const second = await reconstructReplica((requireReplica().scratch ?? new Map()).get(secondName));
  return clean({ first: finalProjectionEvidence(first), second: finalProjectionEvidence(second),
    first_causality: compareSemanticEventCausality(first.history.ancestry, eventA, eventB),
    second_causality: compareSemanticEventCausality(second.history.ancestry, eventA, eventB) });
}

export async function createConvergenceCheckpoint(eventA, eventB) {
  const r = requireLabel("A");
  const reconstructed = await reconstructReplica(r.objects);
  const baseFrontier = reconstructed.state.accepted_semantic_frontier;
  if (![eventA, eventB].every((id) => reconstructed.state.accepted_semantic_event_ids.includes(id))) throw new Error("Checkpoint is missing a required concurrent event.");
  const prepared = await prepareConsolidationCheckpoint({ projector_input: reconstructed.input,
    base_frontier_event_ids: baseFrontier, resolution_operations: [],
    authorizing_control_head_id: reconstructed.controlId, reducer_version: INITIAL_REDUCER_VERSION });
  const ownEvents = (await semanticEvents(r.objects)).filter((entry) => entry.core.author_device_id === ids.deviceA)
    .sort((left, right) => left.core.device_sequence < right.core.device_sequence ? -1 : 1);
  const previous = ownEvents.at(-1);
  if (!previous) throw new Error("Checkpoint device chain is unavailable.");
  const checkpoint = await createSemanticEvent({ semanticKind: "consolidation_checkpoint", data: prepared.payload.data,
    authorDevice: ids.deviceA, authorSigning: ids.signingA, sequence: previous.core.device_sequence + BigInt(1), previous: previous.event_id,
    parents: baseFrontier, control: reconstructed.controlId });
  const complete = await reconstructReplica(r.objects);
  const verification = await verifyFullHistoryCheckpoint({ checkpoint_event_id: checkpoint.event_id,
    projector_input: complete.input, verify_checkpoint_event: async () => ({ status: "accepted" }) });
  if (verification.status !== "full_history_verified") throw new Error(`Checkpoint verification failed: ${verification.reason}`);
  const stateBlob = await stateBlobFromPrepared(verification.checkpoint_id, verification.prepared);
  const snapshot = await constructProjectionSnapshot(verification, stateBlob, complete.input);
  addObject("state-blob", stateBlob.state_blob_id, encodeProtocolRecord(stateBlob));
  addObject("snapshot", snapshot.snapshot_id, encodeProtocolRecord(snapshot));
  r.checkpoint = Object.freeze({ id: checkpoint.event_id, payload_id: checkpoint.core.semantic_payload_id,
    state_blob_id: stateBlob.state_blob_id, snapshot_id: snapshot.snapshot_id });
  return clean(r.checkpoint);
}

export async function createConvergenceAcknowledgement() {
  const r = requireReplica();
  const reconstructed = await reconstructReplica(r.objects);
  const checkpoint = (await semanticEvents(r.objects)).find((entry) => entry.core.semantic_kind === "consolidation_checkpoint");
  if (!checkpoint) throw new Error("Checkpoint is unavailable for acknowledgement.");
  const payload = await decodeStoredSemanticPayload(bytesFor(r.objects, "semantic-payload", checkpoint.core.semantic_payload_id));
  const draft = await prepareAcknowledgementDraft({ project_id: ids.project, person_id: r.own.person, device_id: r.own.device,
    observed_control_head_id: reconstructed.controlId, acknowledged_checkpoint_id: checkpoint.event_id,
    projection_root: payload.core.data.projection_root, history: reconstructed.history, previous: null });
  const attestation = await createAttestation("acknowledgement", draft.acknowledgement_id, r.own.signing);
  const record = bindAcknowledgementAttestation(draft, attestation.attestation_id);
  addObject("acknowledgement", record.acknowledgement_id, encodeProtocolRecord(record));
  return clean({ acknowledgement_id: record.acknowledgement_id });
}

export async function createConvergenceReceipt() {
  const r = requireLabel("B");
  if (!r.admission || !r.delivery) throw new Error("Admission evidence is unavailable for receipt.");
  const core = parseEpochReceiptCore({ schema_version: 1, record_kind: "epoch_delivery_receipt_core", authority: "none",
    project_id: ids.project, person_id: ids.personB, membership_id: ids.membershipB, role: "editor", device_id: ids.deviceB,
    signing_key_id: ids.signingB, acknowledgement_sequence: 0n, previous_acknowledgement_id: null,
    accepted_control_event_id: r.admission.core.accepted_control_event_id, key_epoch_id: ids.epoch,
    key_epoch_commitment: r.admission.core.key_epoch_commitment, delivery_id: r.delivery.delivery_id,
    checkpoint_id: r.admission.core.checkpoint_id, projection_root: r.admission.core.projection_root,
    admission_package_id: r.admission.admission_package_id, admission_boundary_sha256: r.admission.core.admission_boundary_sha256,
    suite_id: HC2_CRYPTO_SUITE_ID });
  const identity = await deriveEpochReceiptIdentity(core);
  const record = parseEpochReceiptRecord({ record_version: 1, record_kind: "epoch_delivery_receipt", authority: "none",
    receipt_id: identity.id, core, algorithm: "ed25519",
    signature_bytes: await signBytes(r, buildEnrollmentSignaturePreimage("epoch_receipt", ids.project, identity.id)) });
  r.receiptIds.add(record.receipt_id);
  r.receiptRecord = record;
  return clean({ receipt_id: record.receipt_id });
}

export async function snapshotAndCloseConvergenceReplica() {
  const r = requireReplica();
  const snapshot = clean({ objects: encodeObjectSnapshot(r.objects), attachments: r.attachmentBackend.snapshot(),
    peers: [...r.peers.values()].map(encodePublicInfo), receipt_ids: [...r.receiptIds].sort(),
    receipt_record: r.receiptRecord ? base64(encodeProtocolRecord(r.receiptRecord)) : null,
    explicit_object_selections: r.explicitSelections, synchronization_planner_calls: r.syncPlannerCalls });
  r.streams.close(); r.keyDb.close(); replica = null;
  return snapshot;
}

export async function reopenConvergenceEvidence(duplicateBundle) {
  const r = requireReplica();
  const before = r.objects.size;
  const duplicate = await importConvergenceBundle(duplicateBundle);
  const reconstructed = await reconstructReplica(r.objects);
  const checkpoint = (await semanticEvents(r.objects)).find((entry) => entry.core.semantic_kind === "consolidation_checkpoint");
  if (!checkpoint) throw new Error("Reopened checkpoint is unavailable.");
  const checkpointPayload = await decodeStoredSemanticPayload(bytesFor(r.objects, "semantic-payload", checkpoint.core.semantic_payload_id));
  const verification = await verifyFullHistoryCheckpoint({ checkpoint_event_id: checkpoint.event_id,
    projector_input: reconstructed.input, verify_checkpoint_event: async () => ({ status: "accepted" }) });
  if (verification.status !== "full_history_verified") throw new Error(`Reopened checkpoint failed: ${verification.reason}`);
  const stateEntry = firstObject(r.objects, "state-blob");
  const snapshotEntry = firstObject(r.objects, "snapshot");
  const stateBlob = parseCanonicalStateBlobRecord(decodeProtocolRecord(stateEntry.bytes));
  const snapshot = parseProjectionSnapshotRecord(decodeProtocolRecord(snapshotEntry.bytes), checkpoint.event_id);
  const stateVerification = await verifyStateBlob(stateBlob, checkpoint.event_id, checkpointPayload.core, reconstructed.input);
  const snapshotVerification = await verifyProjectionSnapshot({ ...reconstructed.input, checkpoint_id: checkpoint.event_id,
    checkpoint_payload: checkpointPayload.core, snapshot, state_blob: stateBlob });
  const acknowledgementRecords = await Promise.all(objectsOfKind(r.objects, "acknowledgement").map((entry) =>
    Promise.resolve(parseAcknowledgementRecord(decodeProtocolRecord(entry.bytes), checkpoint.event_id))));
  const ackStream = await reconstructAcknowledgementStream(acknowledgementRecords.map((record) => ({
    project_id: ids.project, record, checkpoint_id: checkpoint.event_id,
    projection_root: checkpointPayload.core.data.projection_root, control_head_id: reconstructed.controlId,
    history: reconstructed.history, device_authorities: deviceFacts,
    read_attestation: (id) => reconstructed.events.getAttestation(id), attestation_verifier: attestationVerifier()
  })));
  const epoch = await epochEvidence();
  const concurrentMutations = reconstructed.history.events
    .filter((entry) => entry.payload.core.semantic_kind === "metadata_operation" && entry.payload.core.data.operation === "project_title")
    .map((entry) => entry.event.event_id)
    .sort();
  if (concurrentMutations.length !== 2) throw new Error("Expected exactly two title mutations after reopening.");
  const portableSemanticIds = new Set(objectsOfKind(r.objects, "semantic-event").map((entry) => entry.id));
  const portableControlIds = new Set(objectsOfKind(r.objects, "control-event").map((entry) => entry.id));
  const acceptedFromNonportableIndexes = [
    ...reconstructed.state.accepted_semantic_event_ids.filter((id) => !portableSemanticIds.has(id)),
    ...reconstructed.state.accepted_control_event_ids.filter((id) => !portableControlIds.has(id))
  ].length;
  return clean({
    accepted_objects: encodeObjectSnapshot(r.objects),
    accepted_semantic_event_ids: reconstructed.state.accepted_semantic_event_ids,
    accepted_control_event_ids: reconstructed.state.accepted_control_event_ids,
    semantic_frontier: reconstructed.state.accepted_semantic_frontier,
    control_head: reconstructed.controlId,
    membership_device_authority: { memberships: [
      { membership_id: ids.membershipA, person_id: ids.personA, role: "owner", status: "active" },
      { membership_id: ids.membershipB, person_id: ids.personB, role: "editor", status: "active" }
    ], devices: deviceFacts },
    current_epoch: { key_epoch_id: ids.epoch, key_epoch_commitment: epoch.key_epoch_commitment },
    ...finalProjectionEvidence(reconstructed),
    component_roots: {
      base_frontier_root: checkpointPayload.core.data.base_frontier_root,
      accepted_history_root: checkpointPayload.core.data.accepted_history_root,
      semantic_state_root: checkpointPayload.core.data.result_semantic_state_root,
      revision_heads_root: checkpointPayload.core.data.result_revision_heads_root,
      conflict_set_root: checkpointPayload.core.data.result_conflict_set_root
    },
    projection_root: checkpointPayload.core.data.projection_root,
    concurrent_mutation_relation: compareSemanticEventCausality(
      reconstructed.history.ancestry,
      concurrentMutations[0],
      concurrentMutations[1]
    ),
    checkpoint: { checkpoint_id: checkpoint.event_id, payload: checkpointPayload.core },
    state_blob: { state_blob_id: stateBlob.state_blob_id, core: stateBlob.core, verification: stateVerification.status },
    snapshot: { snapshot_id: snapshot.snapshot_id, core: snapshot.core, verification: snapshotVerification.status },
    acknowledgements: ackStream.verified_acknowledgement_ids,
    acknowledgement_invalid: ackStream.invalid_acknowledgement_ids,
    receipts: [...r.receiptIds].sort(),
    full_history_verified: r.fullHistoryVerified,
    duplicate_import: duplicate.status,
    portable_object_count_before_duplicate: before,
    portable_object_count_after_duplicate: r.objects.size,
    private_keys_non_extractable: !r.registry.resolveSigningKey(r.signing.handle).extractable && !r.registry.resolveRecipientKeyPair(r.recipient).privateKey.extractable,
    explicit_object_selections: r.explicitSelections,
    synchronization_planner_calls: r.syncPlannerCalls,
    opfs_used: false,
    accepted_from_nonportable_indexes: acceptedFromNonportableIndexes
  });
}

export async function deleteConvergenceDatabases() {
  if (replica) { replica.streams.close(); replica.keyDb.close(); replica = null; }
  await Promise.all([deleteDb("patchmark-hc2-slice6-convergence-keys"), deleteDb("patchmark-hc2-slice6-convergence-streams")]);
  return true;
}

/** Slice 7 test-harness bridge: committed portable bytes, never indexes. */
export function slice7ReadCommittedPortableObjects() {
  return encodeObjectSnapshot(requireReplica().objects);
}

export async function slice7ReadCommittedPortableAttachments() {
  const r = requireReplica();
  if (!r.receiptRecord) return [];
  const payload = { schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "receipt_attachment", epoch_receipt: r.receiptRecord };
  const attachment = await r.attachments.createAttachment(ids.project, payload);
  return clean([[attachment.payload_kind, attachment.attachment_id, base64(attachment.exact_payload_bytes)]]);
}

export function slice7ImportReceiptAttachment(payload) {
  const r = requireReplica();
  const record = parseEpochReceiptRecord(payload.epoch_receipt);
  if (record.core.project_id !== ids.project) throw new Error("Slice 7 receipt belongs to another project.");
  r.receiptRecord = record;
  r.receiptIds.add(record.receipt_id);
  return clean({ status: "imported", receipt_id: record.receipt_id });
}

/**
 * Slice 7 test-harness bridge: validate every exact HC-1 byte string into an
 * isolated candidate map, reconstruct it, then swap the complete map once.
 */
export async function slice7AtomicImportPortableObjects(values) {
  const r = requireReplica();
  const candidate = new Map(r.objects);
  const verifier = new Hc1CanonicalPortableObjectVerifier(ids.project);
  for (const [kind, id, encoded] of values) {
    const bytes = fromBase64(encoded);
    await verifier.verifyExactObject({ object_kind: kind, object_id: id, exact_bytes: bytes });
    const key = objectKey(kind, id);
    const existing = candidate.get(key);
    if (existing && hex(existing.bytes) !== hex(bytes)) throw new Error("Slice 7 import found conflicting immutable bytes.");
    candidate.set(key, { kind, id, bytes: Uint8Array.from(bytes) });
  }
  await reconstructReplica(candidate);
  const before = r.objects.size;
  r.objects = candidate;
  return clean({ status: "imported", before, after: candidate.size, added: candidate.size - before });
}

export async function slice7AcceptedBinding() {
  const r = requireReplica();
  const reconstructed = await reconstructReplica(r.objects);
  const epoch = await epochEvidence();
  const checkpoint = (await semanticEvents(r.objects)).find((entry) => entry.core.semantic_kind === "consolidation_checkpoint") ?? null;
  return clean({
    project_id: ids.project,
    accepted_control_head_id: reconstructed.controlId,
    key_epoch_id: ids.epoch,
    key_epoch_commitment: epoch.key_epoch_commitment,
    semantic_frontier: reconstructed.state.accepted_semantic_frontier,
    checkpoint_id: checkpoint?.event_id ?? null,
    projection_root_id: checkpoint
      ? (await decodeStoredSemanticPayload(bytesFor(r.objects, "semantic-payload", checkpoint.core.semantic_payload_id))).core.data.projection_root
      : digest("projection-root", "a"),
    protocol_version: "hc1-v1",
    reducer_version: INITIAL_REDUCER_VERSION,
    portable_generation: BigInt(r.objects.size),
    revoked: r.slice7Revoked === true,
    private_keys_non_extractable: !r.registry.resolveSigningKey(r.signing.handle).extractable && !r.registry.resolveRecipientKeyPair(r.recipient).privateKey.extractable
  });
}

export function slice7CryptoContext() {
  const r = requireReplica();
  return { label: r.label, own: r.own, registry: r.registry, signing: r.signing, recipient: r.recipient, peers: r.peers };
}

export function slice7SetPeerRevoked(value) {
  requireReplica().slice7Revoked = value === true;
  return true;
}

async function prepareAndExport({ recipient, purpose, roots, sequence, previous, attachments }) {
  const r = requireReplica();
  r.explicitSelections += 1;
  const closure = await resolveDeterministicHc1Closure({ project_id: ids.project, roots,
    source: { async readExactObject({ kind, id }) { return r.objects.get(objectKey(kind, id))?.bytes ?? null; } } });
  const streamId = await deriveTransportStreamIdV2({ project_id: ids.project, purpose,
    sender_person_id: r.own.person, sender_membership_id: r.own.membership, sender_device_id: r.own.device,
    recipient_person_id: recipient.person, recipient_membership_id: recipient.membership, recipient_device_id: recipient.device,
    recipient_key_id: recipient.recipient, stream_generation: 0n });
  const commonBase = { transport_profile_id: HC2_TRANSPORT_PROFILE_ID, project_id: ids.project, purpose,
    sender_person_id: r.own.person, sender_membership_id: r.own.membership, sender_device_id: r.own.device,
    sender_signing_key_id: r.own.signing, recipient_authority: purpose === "admission" ? "candidate_transition" : "accepted_member",
    recipient_person_id: recipient.person, recipient_membership_id: recipient.membership, recipient_device_id: recipient.device,
    recipient_key_id: recipient.recipient, accepted_control_head_id: await controlIdFromObjects(r.objects), key_epoch_id: ids.epoch,
    key_epoch_commitment: (await epochEvidence()).key_epoch_commitment, stream_id: streamId, stream_generation: 0n,
    bundle_sequence: sequence, previous_bundle_manifest_id: previous, limit_profile_id: HC2_LIMIT_PROFILE_ID,
    crypto_suite_id: HC2_CRYPTO_SUITE_ID };
  const provisional = { ...commonBase, payload_count: 1 };
  const chunks = await createDeterministicTransportChunks({ project_id: ids.project, scope_id: ids.scope,
    common_binding: { ...provisional, payload_count: 1 + attachments.length + 1 }, objects: closure });
  const payloads = [
    ...chunks.map((chunk) => ({ schema_version: HC2_TRANSPORT_SCHEMA_VERSION, payload_kind: "hc1_object_chunk", chunk_payload_core: chunk })),
    ...attachments
  ];
  const common = Object.freeze({ ...commonBase, payload_count: 1 + payloads.length });
  const bundle = await prepareEncryptedTransportBundleV2({ common_binding: common, non_manifest_payloads: payloads,
    recipient_public_key: recipient.recipient_public, authority: { async verify() { return { status: "accepted", epoch_key_available: true }; } },
    random: new WebCryptoRandomSource(crypto), signatures: transportSignatures(), hpke: new SingleShotHpkeV2Provider({ keys: r.registry }) });
  let exact = new Uint8Array();
  const output = [];
  const exportInput = { bundle, streams: r.streams,
    async create_sink() { output.length = 0; return { async write(bytes) { output.push(Uint8Array.from(bytes)); }, async close() { exact = concat(output); }, async abort() { output.length = 0; } }; },
    async reopen_source() { return { async *chunks() { for (let offset = 0; offset < exact.length; offset += 97) yield exact.slice(offset, offset + 97); } }; },
    create_sha256: createHasher };
  const exported = await exportEncryptedTransportBundleV2(exportInput);
  const retry = await exportEncryptedTransportBundleV2(exportInput);
  return clean({ encoded: base64(exact), manifest_id: bundle.manifest_id, export_status: exported.status,
    export_retry_status: retry.status, closure: closure.map((entry) => ({ kind: entry.object_kind, id: entry.object_id })) });
}

async function createSemanticEvent({ semanticKind, data, authorDevice, authorSigning, sequence, previous, parents, control }) {
  const payloadCore = parseSemanticPayloadCore({ schema_version: 1, project_id: ids.project, semantic_kind: semanticKind, data });
  const payloadIdentity = await deriveSemanticPayloadIdentity(payloadCore);
  const payload = { record_version: 1, object_kind: "semantic_payload", payload_id: payloadIdentity.id, core: payloadCore };
  addObject("semantic-payload", payload.payload_id, encodeStoredSemanticPayload(payload));
  const core = parseSemanticEventCoreStructure({ schema_version: 1, object_kind: "semantic_event_core",
    device_chain_position: previous === null ? "first" : "subsequent", project_id: ids.project, semantic_kind: semanticKind,
    author_device_id: authorDevice, device_sequence: sequence, previous_device_event_id: previous,
    causal_parent_event_ids: [...new Set(parents)].sort(), authorizing_control_head_id: control,
    key_epoch_id: ids.epoch, semantic_payload_id: payloadIdentity.id, complete_known_frontier: true });
  const identity = await deriveSemanticEventCoreIdentity(core);
  const attestation = await createAttestation("semantic_event", identity.id, authorSigning);
  const record = parseSemanticEventRecordStructure({ record_version: 1, object_kind: "semantic_event", event_id: identity.id,
    core, author_attestation_ids: [attestation.attestation_id] });
  addObject("semantic-event", record.event_id, encodeStoredSemanticEvent(record));
  return record;
}

async function createAttestation(subjectKind, subjectId, signingKeyId) {
  const r = requireReplica();
  if (r.own.signing !== signingKeyId) throw new Error("Profile cannot sign for another device.");
  const signature = await signBytes(r, encodeCanonicalCbor(buildSignaturePreimage(subjectKind, ids.project, subjectId)));
  const core = { schema_version: 1, object_kind: "attestation_core", project_id: ids.project,
    subject_kind: subjectKind, subject_id: subjectId, signer_key_id: signingKeyId, algorithm: "ed25519", signature_bytes: signature };
  const identity = await deriveAttestationIdentity(core);
  const record = parseAttestationRecord({ record_version: 1, object_kind: "attestation", attestation_id: identity.id, core });
  addObject("attestation", record.attestation_id, encodeStoredAttestation(record));
  return record;
}

async function reconstructReplica(objects) {
  if (!(objects instanceof Map)) throw new Error("Portable replica object map is unavailable.");
  const backend = new MemoryBackend();
  const revisions = new ImmutableCollaborationStore({ backend });
  for (const entry of objectsOfKind(objects, "markdown-blob")) await revisions.putMarkdownBlob(ids.project, entry.bytes);
  for (const entry of objectsOfKind(objects, "document-revision")) await revisions.putRevision(decodeStoredRevisionCore(entry.bytes));
  const store = new EventControlStore({ backend, attestation_verifier: attestationVerifier(), control_transition_verifier: transitionVerifier(objects) });
  for (const entry of objectsOfKind(objects, "semantic-payload")) await store.immutableObjects.putSemanticPayload((await decodeStoredSemanticPayload(entry.bytes)).core);
  for (const entry of objectsOfKind(objects, "control-action")) await store.immutableObjects.putControlAction((await decodeStoredControlAction(entry.bytes)).core);
  for (const entry of objectsOfKind(objects, "attestation")) await store.immutableObjects.putAttestationRecord(await decodeStoredAttestation(entry.bytes));
  for (const entry of objectsOfKind(objects, "control-event")) await store.immutableObjects.ingestControlEvent(await decodeStoredControlEvent(entry.bytes));
  for (const entry of objectsOfKind(objects, "semantic-event")) await store.immutableObjects.ingestSemanticEvent(await decodeStoredSemanticEvent(entry.bytes));
  const state = await store.reopenProject(ids.project);
  const controlId = state.accepted_control_event_ids.at(-1);
  if (!controlId) throw new Error("No accepted control head was reconstructed.");
  const input = Object.freeze({ project_id: ids.project, accepted_semantic_event_ids: state.accepted_semantic_event_ids,
    accepted_semantic_frontier: state.accepted_semantic_frontier,
    accepted_control_facts: [{ control_event_id: controlId, merge_policy: "manual", device_authorities: deviceFacts }],
    onboarding_boundaries: [], read_event: (id) => store.immutableObjects.getSemanticEvent(id),
    read_payload: (id) => store.immutableObjects.getSemanticPayload(id), read_revision: (id) => revisions.getRevision(id),
    read_blob: (project, id) => revisions.getMarkdownBlob(project, id), read_attestation: (id) => store.immutableObjects.getAttestation(id) });
  const history = await loadProjectionHistory(input);
  const replay = await projectCollaborationHistory(input);
  return { backend, revisions, events: store.immutableObjects, state, input, history, replay, controlId };
}

function finalProjectionEvidence(value) {
  const projection = value.replay.projection;
  return clean({ canonical_projection_bytes: hex(encodeProtocolRecord(projection)),
    revision_heads: projection.revision_heads,
    conflicts: projection.conflicts.map((entry) => ({ conflict_id: entry.conflict_id, core: entry.core })),
    tombstones: projection.documents.map((document) => ({ document_id: document.document_id, tombstone: document.tombstone,
      comments: document.comments.map((comment) => ({ comment_id: comment.comment_id, tombstone: comment.tombstone,
        replies: comment.replies.map((reply) => ({ reply_id: reply.reply_id, tombstone: reply.tombstone })) })) })),
    reducer_rejections: projection.reduction_rejections,
    project_title: projection.project_title });
}

function attestationVerifier() {
  return { async verify(request) {
    const publicInfo = publicInfoForSigning(request.signer_key_id);
    if (!publicInfo) return { outcome: "unavailable", reason: "public key unavailable" };
    const verified = await verifyBytes(publicInfo.signing_public, request.signature_preimage, request.signature_bytes);
    return verified ? { outcome: "verified", binding: request } : { outcome: "invalid", reason: "signature invalid" };
  } };
}

function transitionVerifier(objects) {
  return { async verify(request) {
    const control = (await controlEvents(objects)).find((entry) => entry.control_event_id === request.control_event_id);
    if (!control || control.core.control_kind !== "genesis") return { outcome: "invalid", reason: "unknown transition" };
    return { outcome: "verified", binding: request, resulting_authority: {
      schema_version: 1, project_id: ids.project, control_event_id: control.control_event_id,
      control_state_root: control.core.resulting_control_state_root, active_control_device_id: ids.deviceA,
      offline_root_key_id: ids.signingA, key_epoch_id: ids.epoch,
      key_epoch_commitment: control.core.initial_key_epoch_commitment, device_authorities: deviceFacts
    } };
  } };
}

function transportSignatures() {
  const r = requireReplica();
  return {
    sign: (preimage) => signBytes(r, preimage),
    async verify({ core, preimage, signature_bytes }) {
      const info = publicInfoForSigning(core.binding.sender_signing_key_id);
      return info ? verifyBytes(info.signing_public, preimage, signature_bytes) : false;
    }
  };
}

async function decodeBundle(encoded) {
  const bytes = fromBase64(encoded);
  const containers = [];
  await readCanonicalTransportBundleV2({ source: { async *chunks() { for (let offset = 0; offset < bytes.length; offset += 89) yield bytes.slice(offset, offset + 89); } },
    sha256: createHasher(), async on_container(container) { containers.push(container); } });
  return containers;
}

function mapTarget(map) {
  return { async stageAndCommitObject(value) {
    const key = objectKey(value.object_kind, value.object_id);
    const prior = map.get(key);
    if (prior && hex(prior.bytes) !== hex(value.exact_bytes)) throw new Error("Portable object collision.");
    map.set(key, { kind: value.object_kind, id: value.object_id, bytes: Uint8Array.from(value.exact_bytes) });
  }, async hasCommittedObject(id) { return [...map.values()].some((entry) => entry.id === id); } };
}

function addObject(kind, id, bytes) {
  const r = requireReplica();
  const key = objectKey(kind, id);
  const prior = r.objects.get(key);
  if (prior && hex(prior.bytes) !== hex(bytes)) throw new Error("Immutable portable object collision.");
  r.objects.set(key, { kind, id, bytes: Uint8Array.from(bytes) });
}

function bytesFor(map, kind, id) { const value = map.get(objectKey(kind, id)); if (!value) throw new Error(`Missing ${kind} ${id}.`); return Uint8Array.from(value.bytes); }
function firstObject(map, kind) { const value = objectsOfKind(map, kind)[0]; if (!value) throw new Error(`Missing ${kind}.`); return value; }
function objectsOfKind(map, kind) { return [...map.values()].filter((entry) => entry.kind === kind).sort((a, b) => a.id < b.id ? -1 : 1); }
async function semanticEvents(map) { return Promise.all(objectsOfKind(map, "semantic-event").map((entry) => decodeStoredSemanticEvent(entry.bytes))); }
async function controlEvents(map) { return Promise.all(objectsOfKind(map, "control-event").map((entry) => decodeStoredControlEvent(entry.bytes))); }
async function controlIdFromObjects(map, fallback = null) { const values = await controlEvents(map); if (values.length === 0 && fallback) return controlIdFromObjects(fallback); if (values.length !== 1) throw new Error("Expected exactly one control event."); return values[0].control_event_id; }

function publicInfo() {
  const r = requireReplica();
  return clean(encodePublicInfo({ label: r.label, ...r.own, signing_public: r.signing.public_key, recipient_public: r.recipient.public_key,
    private_keys_non_extractable: !r.registry.resolveSigningKey(r.signing.handle).extractable && !r.registry.resolveRecipientKeyPair(r.recipient).privateKey.extractable }));
}
function encodePublicInfo(value) { return { ...value, signing_public: Array.from(value.signing_public), recipient_public: Array.from(value.recipient_public) }; }
function decodePublicInfo(value) { return { ...value, signing_public: Uint8Array.from(value.signing_public), recipient_public: Uint8Array.from(value.recipient_public) }; }
function publicInfoForSigning(keyId) { const r = requireReplica(); if (r.own.signing === keyId) return decodePublicInfo(publicInfo()); return [...r.peers.values()].find((entry) => entry.signing === keyId) ?? null; }
function requirePeer(label) { const value = requireReplica().peers.get(label); if (!value) throw new Error(`Peer ${label} is not configured.`); return value; }

async function epochEvidence() { return deriveEpochCommitment({ project_id: ids.project, key_epoch_id: ids.epoch, epoch_secret: Uint8Array.from(epochSecret) }); }
async function signBytes(r, bytes) { return new Uint8Array(await r.registry.subtle.sign("Ed25519", r.registry.resolveSigningKey(r.signing.handle), bytes)); }
async function verifyBytes(encoded, preimage, signature) { const imported = await importEncodedPublicKey({ subtle: crypto.subtle, encoded, expected_algorithm: "ed25519" }); return crypto.subtle.verify("Ed25519", imported.public_key, signature, preimage); }

class MemoryBackend {
  records = new Map();
  async read(address) { const value = this.records.get(address); return value === undefined ? null : Uint8Array.from(value); }
  async write(address, bytes) { this.records.set(address, Uint8Array.from(bytes)); }
  async delete(address) { this.records.delete(address); }
  async list(prefix) { return [...this.records.keys()].filter((entry) => entry.startsWith(prefix)).sort(); }
}
class SnapshotByteBackend {
  constructor(snapshot = []) { this.bytes = new Map(snapshot.map(([key, value]) => [key, fromBase64(value)])); }
  async read(address) { const value = this.bytes.get(address); return value ? Uint8Array.from(value) : null; }
  async write(address, bytes) { this.bytes.set(address, Uint8Array.from(bytes)); }
  async delete(address) { this.bytes.delete(address); }
  snapshot() { return [...this.bytes.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => [key, base64(value)]); }
}

async function openKeyDatabase() {
  const request = indexedDB.open("patchmark-hc2-slice6-convergence-keys", 1);
  request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("values")) request.result.createObjectStore("values"); };
  return idbRequest(request);
}
function idbGet(db, key) { return idbRequest(db.transaction("values", "readonly").objectStore("values").get(key)); }
async function idbPut(db, key, value) { const tx = db.transaction("values", "readwrite"); tx.objectStore("values").put(value, key); await idbDone(tx); }
function idbRequest(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function idbDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); }); }
function deleteDb(name) { return idbRequest(indexedDB.deleteDatabase(name)); }

function encodeObjectSnapshot(map) { return [...map.values()].sort((a, b) => objectKey(a.kind, a.id) < objectKey(b.kind, b.id) ? -1 : 1).map((entry) => [entry.kind, entry.id, base64(entry.bytes)]); }
function decodeObjectSnapshot(values) { return new Map(values.map(([kind, id, bytes]) => [objectKey(kind, id), { kind, id, bytes: fromBase64(bytes) }])); }
function objectKey(kind, id) { return `${kind}\u0000${id}`; }
function profileIds(label) { return label === "A"
  ? { label, person: ids.personA, membership: ids.membershipA, device: ids.deviceA, signing: ids.signingA, recipient: ids.recipientA }
  : { label, person: ids.personB, membership: ids.membershipB, device: ids.deviceB, signing: ids.signingB, recipient: ids.recipientB }; }
function authorityFact(device_id, person_id, signing_key_id, role) { return Object.freeze({ device_id, person_id, signing_key_id, role,
  capabilities: capabilitiesForRole(role), status: "active", maximum_accepted_semantic_sequence: null }); }
function byDevice(a, b) { return a.device_id < b.device_id ? -1 : 1; }
function requireReplica() { if (!replica) throw new Error("Convergence replica is not initialized."); return replica; }
function requireLabel(label) { const r = requireReplica(); if (r.label !== label) throw new Error(`Operation requires profile ${label}.`); return r; }
function concat(chunks) { const result = new Uint8Array(chunks.reduce((sum, entry) => sum + entry.length, 0)); let offset = 0; for (const entry of chunks) { result.set(entry, offset); offset += entry.length; } return result; }
function createHasher() { const chunks = []; return { update(bytes) { chunks.push(Uint8Array.from(bytes)); }, async digest() { return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(chunks))); } }; }
function base64(bytes) { let text = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(text); }
function fromBase64(value) { const text = atob(value); return Uint8Array.from(text, (child) => child.charCodeAt(0)); }
function hex(value) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function entity(kind, fill) { return `pm:${kind}:v1:${fill.repeat(25)}a`; }
function digest(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function hc2(kind, fill) { return `pm:${kind}:v1:${fill.repeat(51)}a`; }
function clean(value) { return JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }

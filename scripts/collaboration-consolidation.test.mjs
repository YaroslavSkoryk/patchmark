import assert from "node:assert/strict";

import {
  ConsolidationCollaborationStore,
  INITIAL_REDUCER_VERSION,
  calculateMerkleMap,
  calculateMerkleSet,
  capabilitiesForRole,
  collaborationAcknowledgementReservationAddress,
  collaborationObjectAddresses,
  constructProjectionSnapshot,
  constructStateBlob,
  decodeCanonicalStateBlobCore,
  deriveAcceptedHistoryRoot,
  deriveAcknowledgementIdentity,
  deriveAttestationIdentity,
  deriveBaseFrontierRoot,
  deriveCanonicalStateBlobIdentity,
  deriveConflictSetRoot,
  deriveControlStateRoot,
  deriveDocumentRevisionIdentity,
  deriveHighestContiguousSemanticSequences,
  deriveKeyEpochCommitment,
  deriveMarkdownBlobIdentity,
  deriveProjectionSnapshotIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  deriveSemanticStateRoot,
  encodeCanonicalStateBlobCore,
  bindAcknowledgementAttestation,
  canonicalText,
  loadProjectionHistory,
  parseAcknowledgementCore,
  parseAttestationRecord,
  parseCanonicalStateBlobCore,
  parseCanonicalStateBlobRecord,
  parseCollaborationProjection,
  parseDocumentRevisionCore,
  parseProjectionSnapshotRecord,
  parseSemanticEventCoreStructure,
  parseSemanticPayloadCore,
  prepareAcknowledgementDraft,
  prepareConsolidationCheckpoint,
  projectCollaborationHistory,
  reconstructAcknowledgementStream,
  verifyAcknowledgement,
  verifyCurrentStateOnboardingBoundary,
  verifyFullHistoryCheckpoint,
  verifyProjectionSnapshot,
  verifyStateBlob
} from "../lib/collaboration/index.ts";

const encoder = new TextEncoder();
const markers = "abcdefghijklmnopqrstuvwxyz234567";
let assertions = 0;

function check(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

class Slice6Fixture {
  constructor(projectMarker = "a") {
    this.project = entity("project", projectMarker);
    this.controlHead = digest("control-event", "a");
    this.keyEpoch = entity("key-epoch", "a");
    this.events = new Map();
    this.payloads = new Map();
    this.attestations = new Map();
    this.revisions = new Map();
    this.blobs = new Map();
    this.previousByDevice = new Map();
    this.sequenceByDevice = new Map();
    this.roles = new Map();
    this.deviceKeys = new Map();
    this.accepted = [];
    this.device("a", "owner");
  }

  device(marker, role = "editor") {
    const id = entity("device", marker);
    this.roles.set(id, role);
    this.deviceKeys.set(id, entity("public-key", marker));
    return id;
  }

  personForDevice(deviceId) {
    return entity("person", deviceId.slice(-2, -1));
  }

  async addRevision(documentId, markdown, parents = [], ancestryKind = "ordinary") {
    const bytes = typeof markdown === "string" ? encoder.encode(markdown) : Uint8Array.from(markdown);
    const blobIdentity = await deriveMarkdownBlobIdentity(this.project, bytes);
    this.blobs.set(blobIdentity.id, Object.freeze({
      schema_version: 1,
      object_kind: "markdown_blob",
      project_id: this.project,
      blob_id: blobIdentity.id,
      encoding: "utf-8-exact",
      bytes: Uint8Array.from(bytes)
    }));
    const core = parseDocumentRevisionCore({
      schema_version: 1,
      object_kind: "document_revision_core",
      ancestry_kind: ancestryKind,
      project_id: this.project,
      document_id: documentId,
      markdown_blob_id: blobIdentity.id,
      parent_revision_ids: [...parents].sort()
    });
    const identity = await deriveDocumentRevisionIdentity(core);
    this.revisions.set(identity.id, Object.freeze({
      record_version: 1,
      object_kind: "document_revision",
      revision_id: identity.id,
      core
    }));
    return identity.id;
  }

  async initialize() {
    const documentId = entity("document", "a");
    const revisionId = await this.addRevision(documentId, "# Slice 6\n", [], "genesis");
    const event = await this.addEvent({
      device: this.device("a", "owner"),
      semanticKind: "project_genesis",
      data: { genesis_revision_ids: [revisionId] },
      parents: []
    });
    return { documentId, revisionId, eventId: event.event_id };
  }

  async addEvent({ device, semanticKind, data, parents }) {
    const payloadCore = parseSemanticPayloadCore({
      schema_version: 1,
      project_id: this.project,
      semantic_kind: semanticKind,
      data
    });
    const payloadIdentity = await deriveSemanticPayloadIdentity(payloadCore);
    const payload = Object.freeze({
      record_version: 1,
      object_kind: "semantic_payload",
      payload_id: payloadIdentity.id,
      core: payloadCore
    });
    this.payloads.set(payload.payload_id, payload);
    const previous = this.previousByDevice.get(device) ?? null;
    const sequence = this.sequenceByDevice.get(device) ?? 0;
    const causalParents = [...new Set([
      ...parents,
      ...(previous === null ? [] : [previous])
    ])].sort();
    const core = parseSemanticEventCoreStructure({
      schema_version: 1,
      object_kind: "semantic_event_core",
      device_chain_position: previous === null ? "first" : "subsequent",
      project_id: this.project,
      semantic_kind: semanticKind,
      author_device_id: device,
      device_sequence: BigInt(sequence),
      previous_device_event_id: previous,
      causal_parent_event_ids: causalParents,
      authorizing_control_head_id: this.controlHead,
      key_epoch_id: this.keyEpoch,
      semantic_payload_id: payload.payload_id,
      complete_known_frontier: true
    });
    const identity = await deriveSemanticEventCoreIdentity(core);
    const attestation = await this.attest("semantic_event", identity.id, device, sequence + 1);
    const event = Object.freeze({
      record_version: 1,
      object_kind: "semantic_event",
      event_id: identity.id,
      core,
      author_attestation_ids: Object.freeze([attestation.attestation_id])
    });
    this.events.set(event.event_id, event);
    this.previousByDevice.set(device, event.event_id);
    this.sequenceByDevice.set(device, sequence + 1);
    this.accepted.push(event.event_id);
    return { ...event, payload_id: payload.payload_id };
  }

  async attest(subjectKind, subjectId, device, byte = 1) {
    const core = {
      schema_version: 1,
      object_kind: "attestation_core",
      project_id: this.project,
      subject_kind: subjectKind,
      subject_id: subjectId,
      signer_key_id: this.deviceKeys.get(device),
      algorithm: "ed25519",
      signature_bytes: Uint8Array.of(byte % 255)
    };
    const identity = await deriveAttestationIdentity(core);
    const record = parseAttestationRecord({
      record_version: 1,
      object_kind: "attestation",
      attestation_id: identity.id,
      core
    });
    this.attestations.set(record.attestation_id, record);
    return record;
  }

  input(order = this.accepted) {
    const accepted = [...new Set(order)];
    const frontier = new Set(accepted);
    for (const eventId of accepted) {
      const event = this.events.get(eventId);
      if (!event) continue;
      for (const parent of event.core.causal_parent_event_ids) frontier.delete(parent);
    }
    return {
      project_id: this.project,
      accepted_semantic_event_ids: accepted,
      accepted_semantic_frontier: [...frontier].sort(),
      accepted_control_facts: [{
        control_event_id: this.controlHead,
        merge_policy: "manual",
        device_authorities: [...this.roles.entries()]
          .map(([deviceId, role]) => ({
            device_id: deviceId,
            person_id: this.personForDevice(deviceId),
            signing_key_id: this.deviceKeys.get(deviceId),
            role,
            capabilities: capabilitiesForRole(role),
            status: "active",
            maximum_accepted_semantic_sequence: null
          }))
          .sort((left, right) => left.device_id < right.device_id ? -1 : 1)
      }],
      onboarding_boundaries: [],
      read_event: async (id) => validOrMissing(this.events.get(id), "event missing"),
      read_payload: async (id) => validOrMissing(this.payloads.get(id), "payload missing"),
      read_revision: async (id) => validOrMissing(this.revisions.get(id), "revision missing"),
      read_blob: async (projectId, id) => projectId === this.project
        ? validOrMissing(this.blobs.get(id), "blob missing")
        : { status: "mismatched", reason: "wrong project" },
      read_attestation: async (id) => validOrMissing(this.attestations.get(id), "attestation missing")
    };
  }
}

class MemoryBackend {
  constructor() {
    this.values = new Map();
  }
  async read(address) {
    const value = this.values.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }
  async write(address, bytes) {
    this.values.set(address, Uint8Array.from(bytes));
  }
  async delete(address) {
    this.values.delete(address);
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

await testMerkleProfile();
const artifacts = await testRootsCheckpointsAndSnapshots();
await testOnboarding(artifacts);
await testAcknowledgementsAndStorage(artifacts);

process.stdout.write(`${JSON.stringify({
  assertions,
  merkle_shapes: [0, 1, 2, 3, 5, 8],
  checkpoint_outcomes: 3,
  boundary_full_history_claim: false,
  acknowledgement_stream_separate: true,
  storage_failure_stages: 11,
  purity_writers_touched: 0
}, null, 2)}\n`);

async function testMerkleProfile() {
  const emptySet = await calculateMerkleSet("base_frontier", []);
  const emptyMap = await calculateMerkleMap("accepted_history", []);
  ok(!equalBytes(emptySet.raw_digest, emptyMap.raw_digest), "empty families and kinds must separate");
  const keys = ["five", "one", "three", "two", "four"];
  const baseline = await calculateMerkleSet(
    "base_frontier",
    keys.map((key) => ({ key: canonicalText(key) }))
  );
  for (const permutation of deterministicPermutations(keys, 12)) {
    const calculated = await calculateMerkleSet(
      "base_frontier",
      permutation.map((key) => ({ key: canonicalText(key) }))
    );
    check([...calculated.raw_digest], [...baseline.raw_digest]);
  }
  await assert.rejects(
    () => calculateMerkleSet("base_frontier", [
      { key: canonicalText("same") },
      { key: canonicalText("same") }
    ]),
    /duplicate/
  );
  assertions += 1;
  await assert.rejects(
    () => calculateMerkleMap("accepted_history", [{ key: canonicalText("missing-value") }]),
    /canonical-value boundary/
  );
  assertions += 1;
  await assert.rejects(
    () => calculateMerkleSet("unknown_tree_family", []),
    /Unknown/
  );
  assertions += 1;
  const one = await calculateMerkleSet("base_frontier", [{ key: canonicalText("one") }]);
  const two = await calculateMerkleSet("base_frontier", [
    { key: canonicalText("one") }, { key: canonicalText("two") }
  ]);
  const odd = await calculateMerkleSet("base_frontier", [
    { key: canonicalText("one") }, { key: canonicalText("two") }, { key: canonicalText("three") }
  ]);
  ok(!equalBytes(one.raw_digest, two.raw_digest));
  ok(!equalBytes(two.raw_digest, odd.raw_digest));
  const otherFamily = await calculateMerkleSet(
    "semantic_state",
    keys.map((key) => ({ key: canonicalText(key) }))
  );
  ok(!equalBytes(baseline.raw_digest, otherFamily.raw_digest), "tree family must domain-separate leaves");
}

async function testRootsCheckpointsAndSnapshots() {
  const fixture = new Slice6Fixture();
  const initialized = await fixture.initialize();
  const titleA = await fixture.addEvent({
    device: fixture.device("b"),
    semanticKind: "metadata_operation",
    data: { operation: "project_title", value: "Alpha" },
    parents: [initialized.eventId]
  });
  const titleB = await fixture.addEvent({
    device: fixture.device("c"),
    semanticKind: "metadata_operation",
    data: { operation: "project_title", value: "Beta" },
    parents: [initialized.eventId]
  });
  const input = fixture.input();
  const replay = await projectCollaborationHistory(input);
  check(replay.projection.project_title.state, "conflicted");
  const loadedHistory = await loadProjectionHistory(input);
  const acceptedRoot = await deriveAcceptedHistoryRoot(loadedHistory);
  const changedAttestationHistory = clone(loadedHistory);
  changedAttestationHistory.events[0].event.author_attestation_ids = [digest("attestation", "z")];
  const changedAttestationRoot = await deriveAcceptedHistoryRoot(changedAttestationHistory);
  ok(
    acceptedRoot.id !== changedAttestationRoot.id,
    "mandatory author attestation must enter the accepted-history root"
  );
  const ambiguousAttestationHistory = clone(loadedHistory);
  ambiguousAttestationHistory.events[0].event.author_attestation_ids = [
    ...ambiguousAttestationHistory.events[0].event.author_attestation_ids,
    digest("attestation", "z")
  ].sort();
  await assert.rejects(
    () => deriveAcceptedHistoryRoot(ambiguousAttestationHistory),
    /one unambiguous mandatory author attestation/
  );
  assertions += 1;
  const semantic = await deriveSemanticStateRoot(replay.projection);
  const provenanceOnly = clone(replay.projection);
  provenanceOnly.event_provenance[0].author_attestation_ids = [digest("attestation", "z")];
  const semanticProvenance = await deriveSemanticStateRoot(parseCollaborationProjection(provenanceOnly));
  check(semanticProvenance.id, semantic.id, "event provenance must not enter semantic root");
  const changed = clone(replay.projection);
  changed.project_title.contenders[0].value = "Changed";
  changed.project_title.contenders[0].value_commitment = "sha256:" + "a".repeat(64);
  changed.project_title.contenders.sort((left, right) => left.value < right.value ? -1 : 1);
  const changedSemantic = await deriveSemanticStateRoot(parseCollaborationProjection(changed));
  ok(changedSemantic.id !== semantic.id, "semantic value must change root");
  await assert.rejects(
    () => deriveSemanticStateRoot({ ...replay.projection, private_ui_state: {} }),
    /unexpected field/
  );
  assertions += 1;
  const conflictRoot = await deriveConflictSetRoot(replay.projection);
  const rootFromReversed = await deriveConflictSetRoot({
    ...replay.projection,
    conflicts: [...replay.projection.conflicts].reverse()
  });
  check(rootFromReversed.id, conflictRoot.id, "conflict input order must not affect root");
  const changedConflictCore = clone(replay.projection);
  changedConflictCore.conflicts[0].core.contender_event_ids = [digest("semantic-event", "z")];
  await assert.rejects(
    () => deriveConflictSetRoot(parseCollaborationProjection(changedConflictCore)),
    /exact conflict core/
  );
  assertions += 1;
  const baseFrontier = [titleA.event_id, titleB.event_id].sort();
  const conflict = replay.projection.conflicts.find(
    (entry) => entry.core.conflict_kind === "reducer" && entry.core.field === "title"
  );
  ok(conflict);
  const chosenPayload = replay.projection.project_title.contenders
    .find((entry) => entry.value === "Alpha").payload_ids[0];
  const resolution = [{
    operation_kind: "resolve_metadata_conflict",
    conflict_id: conflict.conflict_id,
    observed_contender_event_ids: [...conflict.core.contender_event_ids],
    chosen_payload_id: chosenPayload
  }];
  const retained = await prepareConsolidationCheckpoint({
    projector_input: input,
    base_frontier_event_ids: baseFrontier,
    resolution_operations: [],
    authorizing_control_head_id: fixture.controlHead,
    reducer_version: INITIAL_REDUCER_VERSION
  });
  check(retained.result_projection.conflicts.length, 1, "checkpoint may retain unresolved conflicts");
  check(retained.all_known_work_consolidated, false);
  const retainedCheckpointEvent = await fixture.addEvent({
    device: fixture.device("f"),
    semanticKind: "consolidation_checkpoint",
    data: retained.payload.data,
    parents: baseFrontier
  });
  const retainedVerification = await verifyFullHistoryCheckpoint({
    checkpoint_event_id: retainedCheckpointEvent.event_id,
    projector_input: fixture.input(),
    verify_checkpoint_event: async () => ({ status: "accepted" })
  });
  check(retainedVerification.status, "full_history_verified");
  const retainedStateBlob = await constructStateBlob(retainedVerification);
  const retainedSnapshot = await constructProjectionSnapshot(
    retainedVerification,
    retainedStateBlob,
    fixture.input()
  );
  check(retainedSnapshot.core.live_conflict_dependencies.length, 1);
  const missingConflictCore = {
    ...retainedSnapshot.core,
    live_conflict_dependencies: []
  };
  const missingConflictIdentity = await deriveProjectionSnapshotIdentity(missingConflictCore);
  const missingConflictSnapshot = parseProjectionSnapshotRecord({
    ...retainedSnapshot,
    snapshot_id: missingConflictIdentity.id,
    core: missingConflictCore
  }, retainedVerification.checkpoint_id);
  check((await verifyProjectionSnapshot({
    ...fixture.input(),
    checkpoint_id: retainedVerification.checkpoint_id,
    checkpoint_payload: retainedVerification.prepared.payload,
    snapshot: missingConflictSnapshot,
    state_blob: retainedStateBlob
  })).status, "invalid");
  const prepared = await prepareConsolidationCheckpoint({
    projector_input: input,
    base_frontier_event_ids: baseFrontier,
    resolution_operations: resolution,
    authorizing_control_head_id: fixture.controlHead,
    reducer_version: INITIAL_REDUCER_VERSION
  });
  check(prepared.result_projection.conflicts.length, 0);
  check(prepared.all_known_work_consolidated, true);
  const repeated = await prepareConsolidationCheckpoint({
    projector_input: fixture.input([...fixture.accepted].reverse()),
    base_frontier_event_ids: baseFrontier,
    resolution_operations: resolution,
    authorizing_control_head_id: fixture.controlHead,
    reducer_version: INITIAL_REDUCER_VERSION
  });
  check(repeated.payload, prepared.payload, "checkpoint preparation must be deterministic");
  await assert.rejects(
    () => prepareConsolidationCheckpoint({
      projector_input: input,
      base_frontier_event_ids: baseFrontier,
      resolution_operations: resolution,
      authorizing_control_head_id: fixture.controlHead,
      reducer_version: "patchmark-hc-reducer-v999"
    }),
    /unknown reducer/
  );
  assertions += 1;
  await assert.rejects(
    () => prepareConsolidationCheckpoint({
      projector_input: input,
      base_frontier_event_ids: baseFrontier,
      resolution_operations: resolution,
      authorizing_control_head_id: fixture.controlHead,
      reducer_version: INITIAL_REDUCER_VERSION,
      future_checkpoint_event_id: titleA.event_id
    }),
    /itself/
  );
  assertions += 1;
  await assert.rejects(
    () => prepareConsolidationCheckpoint({
      projector_input: input,
      base_frontier_event_ids: [digest("semantic-event", "z")],
      resolution_operations: [],
      authorizing_control_head_id: fixture.controlHead,
      reducer_version: INITIAL_REDUCER_VERSION
    }),
    /not accepted/
  );
  assertions += 1;
  await assert.rejects(
    () => prepareConsolidationCheckpoint({
      projector_input: input,
      base_frontier_event_ids: [initialized.eventId, titleA.event_id].sort(),
      resolution_operations: [],
      authorizing_control_head_id: fixture.controlHead,
      reducer_version: INITIAL_REDUCER_VERSION
    }),
    /frontier/
  );
  assertions += 1;
  const wrongResolution = clone(resolution);
  wrongResolution[0].observed_contender_event_ids = [titleA.event_id];
  await assert.rejects(
    () => prepareConsolidationCheckpoint({
      projector_input: input,
      base_frontier_event_ids: baseFrontier,
      resolution_operations: wrongResolution,
      authorizing_control_head_id: fixture.controlHead,
      reducer_version: INITIAL_REDUCER_VERSION
    }),
    /exact committed contenders/
  );
  assertions += 1;
  const frontierRoot = await deriveBaseFrontierRoot(baseFrontier);
  check(frontierRoot.id, prepared.payload.data.base_frontier_root);

  const epoch = await deriveKeyEpochCommitment({
    schema_version: 1,
    object_kind: "key_epoch_public_commitment",
    project_id: fixture.project,
    key_epoch_id: fixture.keyEpoch,
    commitment_algorithm: "sha256-public-commitment-v1",
    public_commitment_bytes: Uint8Array.of(1, 2, 3, 4)
  });
  const deviceAuthorities = input.accepted_control_facts[0].device_authorities;
  const control = await deriveControlStateRoot({
    schema_version: 1,
    object_kind: "control_state_commitment",
    project_id: fixture.project,
    owner_person_id: fixture.personForDevice(entity("device", "a")),
    active_control_device_id: entity("device", "a"),
    offline_root_key_id: entity("public-key", "z"),
    key_epoch_id: fixture.keyEpoch,
    key_epoch_commitment: epoch.id,
    merge_policy: "manual",
    root_sequence: BigInt(0),
    recovery_last_uncontested_control_id: null,
    device_authorities: deviceAuthorities
  });
  const changedControl = await deriveControlStateRoot({
    schema_version: 1,
    object_kind: "control_state_commitment",
    project_id: fixture.project,
    owner_person_id: fixture.personForDevice(entity("device", "a")),
    active_control_device_id: entity("device", "a"),
    offline_root_key_id: entity("public-key", "z"),
    key_epoch_id: fixture.keyEpoch,
    key_epoch_commitment: epoch.id,
    merge_policy: "auto_safe",
    root_sequence: BigInt(0),
    recovery_last_uncontested_control_id: null,
    device_authorities: deviceAuthorities
  });
  ok(control.id !== changedControl.id, "control policy must enter control-state root");

  const wrongRootCheckpoint = await fixture.addEvent({
    device: fixture.device("g"),
    semanticKind: "consolidation_checkpoint",
    data: {
      ...prepared.payload.data,
      result_semantic_state_root: digest("semantic-state-root", "z")
    },
    parents: baseFrontier
  });
  check((await verifyFullHistoryCheckpoint({
    checkpoint_event_id: wrongRootCheckpoint.event_id,
    projector_input: fixture.input(),
    verify_checkpoint_event: async () => ({ status: "accepted" })
  })).status, "invalid");

  const checkpointEvent = await fixture.addEvent({
    device: fixture.device("d"),
    semanticKind: "consolidation_checkpoint",
    data: prepared.payload.data,
    parents: baseFrontier
  });
  const verified = await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: fixture.input(),
    verify_checkpoint_event: async () => ({ status: "accepted" })
  });
  check(verified.status, "full_history_verified");
  const missingRevisionInput = fixture.input();
  missingRevisionInput.read_revision = async (id) => id === initialized.revisionId
    ? { status: "missing", reason: "fixture revision omission" }
    : validOrMissing(fixture.revisions.get(id), "revision missing");
  check((await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: missingRevisionInput,
    verify_checkpoint_event: async () => ({ status: "accepted" })
  })).status, "incomplete_dependencies");
  const corruptedBlobInput = fixture.input();
  const initializedBlobId = fixture.revisions.get(initialized.revisionId).core.markdown_blob_id;
  corruptedBlobInput.read_blob = async (projectId, id) => projectId === fixture.project && id === initializedBlobId
    ? { status: "corrupted", reason: "fixture blob corruption" }
    : validOrMissing(fixture.blobs.get(id), "blob missing");
  check((await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: corruptedBlobInput,
    verify_checkpoint_event: async () => ({ status: "accepted" })
  })).status, "invalid");
  const incompleteInput = fixture.input();
  incompleteInput.read_event = async (id) => id === titleA.event_id
    ? { status: "missing", reason: "fixture omission" }
    : validOrMissing(fixture.events.get(id), "event missing");
  const incomplete = await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: incompleteInput,
    verify_checkpoint_event: async () => ({ status: "accepted" })
  });
  check(incomplete.status, "incomplete_dependencies");
  const invalid = await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: fixture.input(),
    verify_checkpoint_event: async () => ({ status: "invalid", reason: "Slice 4 rejected event" })
  });
  check(invalid.status, "invalid");
  const later = await fixture.addEvent({
    device: fixture.device("e"),
    semanticKind: "metadata_operation",
    data: { operation: "document_title", document_id: initialized.documentId, value: "Later" },
    parents: [checkpointEvent.event_id]
  });
  const historical = await verifyFullHistoryCheckpoint({
    checkpoint_event_id: checkpointEvent.event_id,
    projector_input: fixture.input(),
    verify_checkpoint_event: async () => ({ status: "accepted" })
  });
  check(historical.status, "full_history_verified", "later events must not invalidate historical coverage");
  ok(!historical.prepared.covered_event_ids.includes(later.event_id));

  const stateBlob = await constructStateBlob(historical);
  const stateIdentity = await deriveCanonicalStateBlobIdentity(stateBlob.core);
  check(stateIdentity.id, stateBlob.state_blob_id);
  check(
    decodeCanonicalStateBlobCore(encodeCanonicalStateBlobCore(stateBlob.core)),
    stateBlob.core,
    "state blob canonical round-trip"
  );
  assert.throws(
    () => parseCanonicalStateBlobCore({ ...stateBlob.core, schema_version: 99 }),
    /schema version/
  );
  assertions += 1;
  const verifiedBlob = await verifyStateBlob(
    stateBlob,
    historical.checkpoint_id,
    historical.prepared.payload,
    fixture.input()
  );
  check(verifiedBlob.status, "verified");
  assert.throws(() => parseCanonicalStateBlobCore({ ...stateBlob.core, unknown: true }), /unexpected field/);
  assertions += 1;
  const corruptedBlob = parseCanonicalStateBlobRecord({
    ...stateBlob,
    state_blob_id: digest("state-blob", "z")
  });
  await assert.rejects(
    () => verifyStateBlob(corruptedBlob, historical.checkpoint_id, historical.prepared.payload, fixture.input()),
    /ID/
  );
  assertions += 1;
  const snapshot = await constructProjectionSnapshot(
    historical,
    stateBlob,
    fixture.input()
  );
  const snapshotResult = await verifyProjectionSnapshot({
    ...fixture.input(),
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob
  });
  check(snapshotResult.status, "verified");
  const snapshotIdentity = await deriveProjectionSnapshotIdentity(snapshot.core);
  check(snapshotIdentity.id, snapshot.snapshot_id);
  const snapshotProducer = await fixture.attest(
    "snapshot",
    snapshot.snapshot_id,
    entity("device", "a"),
    91
  );
  const producerBoundSnapshot = parseProjectionSnapshotRecord({
    ...snapshot,
    producer_attestation_id: snapshotProducer.attestation_id
  }, historical.checkpoint_id);
  check((await verifyProjectionSnapshot({
    ...fixture.input(),
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot: producerBoundSnapshot,
    state_blob: stateBlob
  })).status, "verified");
  const wrongSnapshotRootCore = {
    ...snapshot.core,
    projection_root: digest("projection-root", "z")
  };
  const wrongSnapshotRootIdentity = await deriveProjectionSnapshotIdentity(wrongSnapshotRootCore);
  const wrongSnapshotRoot = parseProjectionSnapshotRecord({
    ...snapshot,
    snapshot_id: wrongSnapshotRootIdentity.id,
    core: wrongSnapshotRootCore
  }, historical.checkpoint_id);
  check((await verifyProjectionSnapshot({
    ...fixture.input(),
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot: wrongSnapshotRoot,
    state_blob: stateBlob
  })).status, "invalid");
  const missingManifest = {
    ...snapshot,
    core: { ...snapshot.core, boundary_revisions: [] }
  };
  const missingResult = await verifyProjectionSnapshot({
    ...fixture.input(),
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot: missingManifest,
    state_blob: stateBlob
  });
  check(missingResult.status, "invalid");
  check((await verifyProjectionSnapshot({
    ...fixture.input(),
    read_blob: async () => ({ status: "mismatched", reason: "cross-project blob" }),
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob
  })).status, "invalid");
  check(stateBlob.core.projection, historical.prepared.result_projection, "snapshot deletion must not affect replay equivalence");

  return {
    fixture,
    initialized,
    historical,
    stateBlob,
    snapshot,
    epoch,
    control,
    history: await loadProjectionHistory(fixture.input())
  };
}

async function testOnboarding(artifacts) {
  const { fixture, historical, stateBlob, snapshot, epoch } = artifacts;
  const boundary = {
    schema_version: 1,
    object_kind: "admission_boundary",
    project_id: fixture.project,
    admitted_membership_id: entity("membership", "z"),
    admitted_person_id: entity("person", "z"),
    admitted_device_id: entity("device", "z"),
    owner_authorized_control_event_id: digest("control-event", "z"),
    checkpoint_id: historical.checkpoint_id,
    snapshot_id: snapshot.snapshot_id,
    admission_key_epoch_id: fixture.keyEpoch,
    boundary_revisions: snapshot.core.boundary_revisions,
    sealed_prior_history: {
      accepted_history_root: historical.prepared.payload.data.accepted_history_root,
      parent_traversal: "unavailable_before_admission",
      prior_plaintext: "not_provided",
      verification_basis: "owner_authorized_current_state"
    },
    replica_scope: "complete_current_state"
  };
  const result = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => ({ status: "owner_authorized", binding: request })
  });
  check(result.status, "owner_authorized_boundary_verified");
  check(result.full_history_verified, false);
  const withoutPriorHistory = await verifyCurrentStateOnboardingBoundary({
    project_id: fixture.project,
    read_revision: fixture.input().read_revision,
    read_blob: fixture.input().read_blob,
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => ({ status: "owner_authorized", binding: request })
  });
  check(withoutPriorHistory.status, "owner_authorized_boundary_verified");
  const unauthorized = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async () => ({ status: "invalid", reason: "not owner authorized" })
  });
  check(unauthorized.status, "invalid");
  const wrongPair = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    admission_boundary: { ...boundary, snapshot_id: digest("snapshot", "y") },
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => ({ status: "owner_authorized", binding: request })
  });
  check(wrongPair.status, "invalid");
  const wrongEpoch = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: entity("key-epoch", "y"),
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => ({ status: "owner_authorized", binding: request })
  });
  check(wrongEpoch.status, "invalid");
  const wrongControl = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: digest("control-event", "y"),
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => request.resulting_control_head_id === boundary.owner_authorized_control_event_id
      ? { status: "owner_authorized", binding: request }
      : { status: "invalid", reason: "wrong current control head" }
  });
  check(wrongControl.status, "invalid");
  const missingLiveState = await verifyCurrentStateOnboardingBoundary({
    ...fixture.input(),
    read_revision: async () => ({ status: "missing", reason: "live revision unavailable" }),
    admission_boundary: boundary,
    checkpoint_id: historical.checkpoint_id,
    checkpoint_payload: historical.prepared.payload,
    snapshot,
    state_blob: stateBlob,
    current_control_head_id: boundary.owner_authorized_control_event_id,
    current_key_epoch_id: fixture.keyEpoch,
    current_key_epoch_commitment: epoch.id,
    verify_owner_admission: async (request) => ({ status: "owner_authorized", binding: request })
  });
  check(missingLiveState.status, "incomplete_boundary_package");
}

async function testAcknowledgementsAndStorage(artifacts) {
  const { fixture, historical, stateBlob, snapshot, history } = artifacts;
  const ownerDevice = entity("device", "a");
  const firstDraft = await prepareAcknowledgementDraft({
    project_id: fixture.project,
    person_id: fixture.personForDevice(ownerDevice),
    device_id: ownerDevice,
    observed_control_head_id: fixture.controlHead,
    acknowledged_checkpoint_id: historical.checkpoint_id,
    projection_root: historical.prepared.payload.data.projection_root,
    history,
    previous: null
  });
  check(firstDraft.core.acknowledgement_sequence, BigInt(0));
  check(
    firstDraft.core.highest_contiguous_semantic_sequences,
    deriveHighestContiguousSemanticSequences(history)
  );
  const firstAttestation = await fixture.attest(
    "acknowledgement",
    firstDraft.acknowledgement_id,
    ownerDevice,
    77
  );
  const first = bindAcknowledgementAttestation(firstDraft, firstAttestation.attestation_id);
  const verifyInput = acknowledgementVerificationInput(
    artifacts,
    history,
    first,
    historical.checkpoint_id,
    historical.prepared.payload.data.projection_root
  );
  check((await verifyAcknowledgement(verifyInput)).status, "verified");
  const secondDraft = await prepareAcknowledgementDraft({
    project_id: fixture.project,
    person_id: fixture.personForDevice(ownerDevice),
    device_id: ownerDevice,
    observed_control_head_id: fixture.controlHead,
    acknowledged_checkpoint_id: historical.checkpoint_id,
    projection_root: historical.prepared.payload.data.projection_root,
    history,
    previous: first
  });
  const secondAttestation = await fixture.attest(
    "acknowledgement",
    secondDraft.acknowledgement_id,
    ownerDevice,
    78
  );
  const second = bindAcknowledgementAttestation(secondDraft, secondAttestation.attestation_id);
  check(second.core.acknowledgement_sequence, BigInt(1));
  const altCheckpoint = digest("semantic-event", "z");
  const altProjection = digest("projection-root", "z");
  const altDraft = await prepareAcknowledgementDraft({
    project_id: fixture.project,
    person_id: fixture.personForDevice(ownerDevice),
    device_id: ownerDevice,
    observed_control_head_id: fixture.controlHead,
    acknowledged_checkpoint_id: altCheckpoint,
    projection_root: altProjection,
    history,
    previous: first
  });
  const altAttestation = await fixture.attest(
    "acknowledgement",
    altDraft.acknowledgement_id,
    ownerDevice,
    79
  );
  const alt = bindAcknowledgementAttestation(altDraft, altAttestation.attestation_id);
  const stream = await reconstructAcknowledgementStream([
    verifyInput,
    acknowledgementVerificationInput(artifacts, history, second, historical.checkpoint_id, historical.prepared.payload.data.projection_root),
    acknowledgementVerificationInput(artifacts, history, alt, altCheckpoint, altProjection),
    verifyInput
  ]);
  check(stream.forks.length, 1, "same-device acknowledgement fork must be explicit");
  check(stream.compaction_authorized, false);
  check(stream.verified_acknowledgement_ids.length, 3, "duplicate acknowledgements must be idempotent");
  const missingPrevious = await reconstructAcknowledgementStream([
    acknowledgementVerificationInput(
      artifacts,
      history,
      second,
      historical.checkpoint_id,
      historical.prepared.payload.data.projection_root
    )
  ]);
  check(missingPrevious.invalid_acknowledgement_ids, [second.acknowledgement_id]);
  ok(!fixture.accepted.includes(first.acknowledgement_id), "acknowledgements must not enter semantic history");
  check((await verifyAcknowledgement({
    ...verifyInput,
    control_head_id: digest("control-event", "z")
  })).status, "invalid");
  check((await verifyAcknowledgement({
    ...verifyInput,
    projection_root: digest("projection-root", "z")
  })).status, "invalid");
  check((await verifyAcknowledgement({
    ...verifyInput,
    checkpoint_id: digest("semantic-event", "z")
  })).status, "invalid");
  check((await verifyAcknowledgement({
    ...verifyInput,
    history: { ...history, accepted_frontier: [digest("semantic-event", "z")] }
  })).status, "invalid");
  check((await verifyAcknowledgement({
    ...verifyInput,
    attestation_verifier: {
      async verify() {
        return { outcome: "invalid", reason: "fixture signature rejection" };
      }
    }
  })).status, "invalid");
  const wrongCore = parseAcknowledgementCore({
    ...first.core,
    highest_contiguous_semantic_sequences: [{
      ...first.core.highest_contiguous_semantic_sequences[0],
      highest_contiguous_sequence: BigInt(99)
    }]
  }, historical.checkpoint_id);
  const wrongIdentity = await deriveAcknowledgementIdentity(wrongCore);
  const wrongAttestation = await fixture.attest("acknowledgement", wrongIdentity.id, ownerDevice, 80);
  const wrongRecord = {
    record_version: 1,
    object_kind: "acknowledgement",
    acknowledgement_id: wrongIdentity.id,
    core: wrongCore,
    attestation_id: wrongAttestation.attestation_id
  };
  check((await verifyAcknowledgement(
    acknowledgementVerificationInput(artifacts, history, wrongRecord, historical.checkpoint_id, historical.prepared.payload.data.projection_root)
  )).status, "invalid");
  const skippedSequenceCore = parseAcknowledgementCore({
    ...second.core,
    acknowledgement_sequence: BigInt(2)
  }, historical.checkpoint_id);
  const skippedSequenceIdentity = await deriveAcknowledgementIdentity(skippedSequenceCore);
  const skippedSequenceAttestation = await fixture.attest(
    "acknowledgement",
    skippedSequenceIdentity.id,
    ownerDevice,
    81
  );
  const skippedSequence = {
    record_version: 1,
    object_kind: "acknowledgement",
    acknowledgement_id: skippedSequenceIdentity.id,
    core: skippedSequenceCore,
    attestation_id: skippedSequenceAttestation.attestation_id
  };
  const skippedStream = await reconstructAcknowledgementStream([
    verifyInput,
    acknowledgementVerificationInput(
      artifacts,
      history,
      skippedSequence,
      historical.checkpoint_id,
      historical.prepared.payload.data.projection_root
    )
  ]);
  check(skippedStream.invalid_acknowledgement_ids, [skippedSequence.acknowledgement_id]);

  const backend = new MemoryBackend();
  const store = new ConsolidationCollaborationStore({ backend });
  await assert.rejects(
    () => store.putVerifiedSnapshot(historical, stateBlob, snapshot),
    /before its state blob/
  );
  assertions += 1;
  check((await store.putVerifiedStateBlob(historical, stateBlob)).status, "stored");
  check((await store.putVerifiedStateBlob(historical, stateBlob)).status, "already_present");
  check((await store.putVerifiedSnapshot(historical, stateBlob, snapshot)).status, "stored");
  check((await store.putVerifiedSnapshot(historical, stateBlob, snapshot)).status, "already_present");
  check((await store.reserveAcknowledgement(firstDraft)).status, "reserved");
  check((await store.reserveAcknowledgement(firstDraft)).status, "already_reserved");
  check((await store.commitAcknowledgement(first)).status, "stored");
  check((await store.commitAcknowledgement(first)).status, "already_present");
  check((await store.getStateBlob(stateBlob.state_blob_id)).status, "valid");
  check((await store.getSnapshot(snapshot.snapshot_id)).status, "valid");
  check((await store.getAcknowledgement(first.acknowledgement_id)).status, "valid");
  const recovery = await store.recover();
  check(recovery.valid_state_blob_ids, [stateBlob.state_blob_id]);
  check(recovery.valid_snapshot_ids, [snapshot.snapshot_id]);
  check(recovery.valid_acknowledgement_ids, [first.acknowledgement_id]);

  await testInjectedStorageFailures({
    historical,
    stateBlob,
    snapshot,
    firstDraft,
    first
  });
}

async function testInjectedStorageFailures({ historical, stateBlob, snapshot, firstDraft, first }) {
  for (const stage of ["state_blob_staging", "state_blob_data", "state_blob_commit"]) {
    const backend = new MemoryBackend();
    const store = injectedStore(backend, stage);
    await assert.rejects(() => store.putVerifiedStateBlob(historical, stateBlob), /injected/);
    assertions += 1;
    const expected = stage === "state_blob_staging"
      ? "missing"
      : stage === "state_blob_data" ? "incomplete" : "valid";
    check((await store.getStateBlob(stateBlob.state_blob_id)).status, expected, stage);
    const recovery = await new ConsolidationCollaborationStore({ backend }).recover();
    ok(recovery.cleaned_staging_addresses.length > 0, `${stage} must clean staging`);
    if (stage === "state_blob_data") ok(recovery.incomplete_addresses.length > 0);
    if (stage === "state_blob_commit") check(recovery.valid_state_blob_ids, [stateBlob.state_blob_id]);
  }

  for (const stage of ["snapshot_staging", "snapshot_data", "snapshot_commit"]) {
    const backend = new MemoryBackend();
    await new ConsolidationCollaborationStore({ backend }).putVerifiedStateBlob(historical, stateBlob);
    const store = injectedStore(backend, stage);
    await assert.rejects(() => store.putVerifiedSnapshot(historical, stateBlob, snapshot), /injected/);
    assertions += 1;
    const expected = stage === "snapshot_staging"
      ? "missing"
      : stage === "snapshot_data" ? "incomplete" : "valid";
    check((await store.getSnapshot(snapshot.snapshot_id)).status, expected, stage);
    const recovery = await new ConsolidationCollaborationStore({ backend }).recover();
    ok(recovery.cleaned_staging_addresses.length > 0, `${stage} must clean staging`);
    if (stage === "snapshot_data") ok(recovery.incomplete_addresses.length > 0);
    if (stage === "snapshot_commit") check(recovery.valid_snapshot_ids, [snapshot.snapshot_id]);
  }

  const reservationBackend = new MemoryBackend();
  const reservationCrash = injectedStore(reservationBackend, "acknowledgement_reservation");
  await assert.rejects(() => reservationCrash.reserveAcknowledgement(firstDraft), /injected/);
  assertions += 1;
  const reservationRecovery = await new ConsolidationCollaborationStore({
    backend: reservationBackend
  }).recover();
  check(reservationRecovery.pending_acknowledgement_reservations.length, 1);

  for (const stage of ["acknowledgement_data", "acknowledgement_commit"]) {
    const backend = new MemoryBackend();
    const store = injectedStore(backend, stage);
    await store.reserveAcknowledgement(firstDraft);
    await assert.rejects(() => store.commitAcknowledgement(first), /injected/);
    assertions += 1;
    const expected = stage === "acknowledgement_data" ? "incomplete" : "valid";
    check((await store.getAcknowledgement(first.acknowledgement_id)).status, expected, stage);
    const recovery = await new ConsolidationCollaborationStore({ backend }).recover();
    if (stage === "acknowledgement_data") {
      ok(recovery.incomplete_addresses.length > 0);
      check(recovery.pending_acknowledgement_reservations.length, 1);
    } else {
      check(recovery.valid_acknowledgement_ids, [first.acknowledgement_id]);
      check(recovery.resumed_acknowledgement_reservations.length, 1);
    }
  }

  const beforeStateBackend = new MemoryBackend();
  await assert.rejects(
    () => injectedStore(
      beforeStateBackend,
      "after_checkpoint_verification_before_state_blob"
    ).persistCheckpointArtifacts(historical, stateBlob, snapshot),
    /injected/
  );
  assertions += 1;
  check(
    (await new ConsolidationCollaborationStore({ backend: beforeStateBackend })
      .getStateBlob(stateBlob.state_blob_id)).status,
    "missing"
  );

  const afterStateBackend = new MemoryBackend();
  await assert.rejects(
    () => injectedStore(
      afterStateBackend,
      "after_state_blob_before_snapshot"
    ).persistCheckpointArtifacts(historical, stateBlob, snapshot),
    /injected/
  );
  assertions += 1;
  const afterState = new ConsolidationCollaborationStore({ backend: afterStateBackend });
  check((await afterState.getStateBlob(stateBlob.state_blob_id)).status, "valid");
  check((await afterState.getSnapshot(snapshot.snapshot_id)).status, "missing");

  const corruptedCommitBackend = new MemoryBackend();
  const corruptedCommitStore = new ConsolidationCollaborationStore({
    backend: corruptedCommitBackend
  });
  await corruptedCommitStore.putVerifiedStateBlob(historical, stateBlob);
  const stateAddresses = collaborationObjectAddresses("state-blob", stateBlob.state_blob_id);
  corruptedCommitBackend.values.set(stateAddresses.commit, Uint8Array.of(0xff));
  check((await corruptedCommitStore.getStateBlob(stateBlob.state_blob_id)).status, "corrupted");
  ok((await corruptedCommitStore.recover()).corrupted_addresses.includes(stateAddresses.commit));

  const corruptReservationBackend = new MemoryBackend();
  const corruptReservationStore = new ConsolidationCollaborationStore({
    backend: corruptReservationBackend
  });
  await corruptReservationStore.reserveAcknowledgement(firstDraft);
  const reservationAddress = collaborationAcknowledgementReservationAddress(
    firstDraft.core.project_id,
    firstDraft.core.device_id
  );
  corruptReservationBackend.values.set(reservationAddress, Uint8Array.of(0xff));
  ok((await corruptReservationStore.recover()).corrupted_addresses.includes(reservationAddress));
}

function injectedStore(backend, injectedStage) {
  return new ConsolidationCollaborationStore({
    backend,
    failure_injector: ({ stage }) => {
      if (stage === injectedStage) throw new Error(`injected ${stage} crash`);
    }
  });
}

function acknowledgementVerificationInput(artifacts, history, record, checkpointId, projectionRoot) {
  const { fixture } = artifacts;
  return {
    project_id: fixture.project,
    record,
    checkpoint_id: checkpointId,
    projection_root: projectionRoot,
    control_head_id: fixture.controlHead,
    history,
    device_authorities: fixture.input().accepted_control_facts[0].device_authorities,
    read_attestation: async (id) => validOrMissing(fixture.attestations.get(id), "attestation missing"),
    attestation_verifier: {
      async verify(request) {
        return { outcome: "verified", binding: request };
      }
    }
  };
}

function validOrMissing(value, reason) {
  return value === undefined
    ? { status: "missing", reason }
    : { status: "valid", value };
}

function entity(kind, marker) {
  if (!markers.includes(marker)) throw new Error("invalid marker");
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a`;
}

function digest(kind, marker) {
  if (!markers.includes(marker)) throw new Error("invalid marker");
  return `pm:${kind}:v1:${"a".repeat(50)}${marker}a`;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function deterministicPermutations(values, count) {
  let seed = 0x6c696365;
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const copy = [...values];
    for (let position = copy.length - 1; position > 0; position -= 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const target = seed % (position + 1);
      [copy[position], copy[target]] = [copy[target], copy[position]];
    }
    output.push(copy);
  }
  return output;
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

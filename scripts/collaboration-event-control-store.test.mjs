import assert from "node:assert/strict";

import {
  EventControlStore,
  ImmutableCollaborationStore,
  authorityConflictClassificationReasons,
  buildSignaturePreimage,
  capabilitiesForRole,
  collaborationEventControlStateIndexAddress,
  collaborationObjectAddresses,
  collaborationSemanticReservationAddress,
  decodeStoredSemanticEvent,
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventCoreIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  deriveReviewResponseEvidence,
  encodeCanonicalCbor,
  parseAttestationRecord,
  parseControlEventRecordStructure,
  parseDocumentRevisionCore,
  parseSemanticEventCoreStructure,
  parseSemanticEventRecordStructure,
  permanentInvalidClassificationReasons,
  retryableClassificationReasons
} from "../lib/collaboration/index.ts";

class DeterministicMemoryBackend {
  records = new Map();
  writes = [];
  partialStage = null;
  failOperation = null;

  async read(address) {
    if (this.failOperation === "read") throw new Error("injected backend read failure");
    const value = this.records.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }

  async write(address, bytes, context) {
    if (this.failOperation === "write") throw new Error("injected backend write failure");
    const copy = Uint8Array.from(bytes);
    this.writes.push({ address, bytes: copy, stage: context.stage });
    this.records.set(
      address,
      this.partialStage === context.stage
        ? copy.slice(0, Math.max(1, Math.floor(copy.length / 2)))
        : copy
    );
  }

  async delete(address) {
    if (this.failOperation === "delete") throw new Error("injected backend delete failure");
    this.records.delete(address);
  }

  async list(prefix) {
    if (this.failOperation === "list") throw new Error("injected backend list failure");
    return [...this.records.keys()].filter((address) => address.startsWith(prefix)).sort();
  }

  corrupt(address, mutate = (bytes) => bytes.slice(0, Math.max(1, bytes.length - 1))) {
    const existing = this.records.get(address);
    assert(existing, `expected ${address} to exist before corruption`);
    this.records.set(address, Uint8Array.from(mutate(Uint8Array.from(existing))));
  }
}

const ids = Object.freeze({
  project: entity("project", "a"),
  projectB: entity("project", "b"),
  owner: entity("person", "c"),
  deviceA: entity("device", "d"),
  deviceB: entity("device", "e"),
  rootKey: entity("public-key", "f"),
  signingKeyA: entity("public-key", "g"),
  signingKeyB: entity("public-key", "h"),
  membership: entity("membership", "i"),
  scope: entity("access-scope", "j"),
  keyEpoch: entity("key-epoch", "k"),
  keyEpoch2: entity("key-epoch", "l"),
  document: entity("document", "m"),
  stateRoot0: digest("control-state-root", "a"),
  stateRoot1: digest("control-state-root", "b"),
  stateRoot2: digest("control-state-root", "c"),
  selectedStateRoot: digest("control-state-root", "d"),
  keyCommit0: digest("key-epoch-commitment", "e"),
  keyCommit1: digest("key-epoch-commitment", "f"),
  missingEvent: digest("semantic-event", "g"),
  missingAttestation: digest("attestation", "h")
});

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert(condition, message);
};

async function createHarness(options = {}) {
  const backend = options.backend ?? new DeterministicMemoryBackend();
  const transitionAuthorities = new Map();
  const acceptedSignatures = new Map();
  let attestationVerificationCount = 0;
  let objectFailureStage = options.objectFailureStage ?? null;
  let sliceFailureStage = options.sliceFailureStage ?? null;

  const attestationVerifier = {
    async verify(request) {
      attestationVerificationCount += 1;
      const key = attestationFixtureKey(
        request.subject_kind,
        request.subject_id,
        request.signer_key_id
      );
      const expected = acceptedSignatures.get(key);
      if (!expected || !sameBytes(expected, request.signature_bytes)) {
        return { outcome: "invalid", reason: "fixture signature does not match its exact binding" };
      }
      if (options.attestationUnavailable) {
        return { outcome: "unavailable", reason: "fixture public key material unavailable" };
      }
      if (options.badAttestationBinding) {
        return {
          outcome: "verified",
          binding: { ...request, project_id: ids.projectB }
        };
      }
      return { outcome: "verified", binding: request };
    }
  };
  const transitionVerifier = {
    async verify(request) {
      const authority = transitionAuthorities.get(request.control_event_id);
      if (!authority) return { outcome: "invalid", reason: "unregistered fixture transition" };
      if (options.transitionUnavailable) {
        return { outcome: "unavailable", reason: "fixture control state unavailable" };
      }
      if (options.badTransitionBinding) {
        return {
          outcome: "verified",
          binding: { ...request, resulting_control_state_root: ids.stateRoot2 },
          resulting_authority: authority
        };
      }
      return { outcome: "verified", binding: request, resulting_authority: authority };
    }
  };
  const store = new EventControlStore({
    backend,
    attestation_verifier: attestationVerifier,
    control_transition_verifier: transitionVerifier,
    object_failure_injector: async (context) => {
      if (
        objectFailureStage === context.stage &&
        (!options.objectFailureKind || options.objectFailureKind === context.object_kind)
      ) {
        objectFailureStage = null;
        throw new Error(`injected object failure at ${context.stage}`);
      }
    },
    failure_injector: async (context) => {
      if (sliceFailureStage === context.stage) {
        sliceFailureStage = null;
        throw new Error(`injected Slice 4 failure at ${context.stage}`);
      }
    }
  });
  const revisions = new ImmutableCollaborationStore({ backend });
  const blob = await revisions.putMarkdownBlob(ids.project, new TextEncoder().encode("# Genesis\n"));
  const revision = await revisions.putRevision(parseDocumentRevisionCore({
    schema_version: 1,
    object_kind: "document_revision_core",
    ancestry_kind: "genesis",
    project_id: ids.project,
    document_id: ids.document,
    markdown_blob_id: blob.id,
    parent_revision_ids: []
  }));

  const genesisCore = {
    schema_version: 1,
    object_kind: "control_event_core",
    control_kind: "genesis",
    project_id: ids.project,
    control_sequence: 0n,
    previous_control_id: null,
    root_sequence: 0n,
    previous_root_control_id: null,
    owner_person_id: ids.owner,
    offline_root_key_id: ids.rootKey,
    initial_active_control_device_id: ids.deviceA,
    initial_memberships: [{
      membership_id: ids.membership,
      person_id: ids.owner,
      role: "owner",
      access_scope_id: ids.scope,
      status: "active"
    }],
    initial_authorized_devices: [
      {
        device_id: ids.deviceA,
        person_id: ids.owner,
        signing_key_id: ids.signingKeyA,
        status: "active"
      },
      {
        device_id: ids.deviceB,
        person_id: ids.owner,
        signing_key_id: ids.signingKeyB,
        status: "active"
      }
    ],
    initial_key_epoch_id: ids.keyEpoch,
    initial_key_epoch_commitment: ids.keyCommit0,
    resulting_control_state_root: ids.stateRoot0
  };
  const genesisIdentity = await deriveControlEventCoreIdentity(genesisCore);
  const genesisAuthority = authorityState({
    controlEventId: genesisIdentity.id,
    stateRoot: ids.stateRoot0,
    activeDeviceId: ids.deviceA,
    keyEpochId: ids.keyEpoch,
    keyCommitment: ids.keyCommit0
  });
  transitionAuthorities.set(genesisIdentity.id, genesisAuthority);
  const genesisAttestation = await makeAttestation({
    projectId: ids.project,
    subjectKind: "control_event",
    subjectId: genesisIdentity.id,
    signerKeyId: ids.rootKey,
    signature: bytes(1, 2, 3),
    acceptedSignatures
  });
  const genesisRecord = parseControlEventRecordStructure({
    record_version: 1,
    object_kind: "control_event",
    control_event_id: genesisIdentity.id,
    core: genesisCore,
    authority_attestation_id: genesisAttestation.attestation_id
  });
  await store.putAttestationRecord(genesisAttestation);
  const genesisIngest = await store.ingestControlEvent(genesisRecord);
  if (!options.allowInvalidGenesis) {
    assert(genesisIngest.state.accepted_control_event_ids.includes(genesisIdentity.id));
  }

  return {
    backend,
    store,
    revisions,
    revision,
    blob,
    genesisCore,
    genesisRecord,
    genesisAuthority,
    genesisState: genesisIngest.state,
    acceptedSignatures,
    transitionAuthorities,
    setObjectFailureStage(stage) { objectFailureStage = stage; },
    setSliceFailureStage(stage) { sliceFailureStage = stage; },
    getAttestationVerificationCount() { return attestationVerificationCount; }
  };
}

async function putProjectGenesisPayload(harness) {
  return harness.store.putSemanticPayload({
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "project_genesis",
    data: { genesis_revision_ids: [harness.revision.id] }
  });
}

async function putMetadataPayload(harness, value) {
  return harness.store.putSemanticPayload({
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "metadata_operation",
    data: { operation: "project_title", value }
  });
}

async function makeSemanticEvent(harness, options) {
  const core = parseSemanticEventCoreStructure({
    schema_version: 1,
    object_kind: "semantic_event_core",
    device_chain_position: options.previousEventId === null ? "first" : "subsequent",
    project_id: options.projectId ?? ids.project,
    semantic_kind: options.payload.value.core.semantic_kind,
    author_device_id: options.deviceId ?? ids.deviceA,
    device_sequence: options.sequence,
    previous_device_event_id: options.previousEventId,
    causal_parent_event_ids: [...options.parents].sort(),
    authorizing_control_head_id: options.controlHeadId ?? harness.genesisRecord.control_event_id,
    key_epoch_id: options.keyEpochId ?? ids.keyEpoch,
    semantic_payload_id: options.payload.id,
    complete_known_frontier: true
  });
  const identity = await deriveSemanticEventCoreIdentity(core);
  const key = options.signingKeyId ??
    ((options.deviceId ?? ids.deviceA) === ids.deviceB ? ids.signingKeyB : ids.signingKeyA);
  const attestation = await makeAttestation({
    projectId: options.attestationProjectId ?? (options.projectId ?? ids.project),
    subjectKind: options.attestationSubjectKind ?? "semantic_event",
    subjectId: options.attestationSubjectId ?? identity.id,
    signerKeyId: options.attestationKeyId ?? key,
    signature: options.signature ?? bytes(Number(options.sequence) + 10),
    acceptedSignatures: harness.acceptedSignatures,
    registerSignature: options.registerSignature !== false
  });
  const record = parseSemanticEventRecordStructure({
    record_version: 1,
    object_kind: "semantic_event",
    event_id: identity.id,
    core,
    author_attestation_ids: options.attestationIds ?? [attestation.attestation_id]
  });
  return { core, identity, attestation, record };
}

async function makeAttestation(options) {
  const core = {
    schema_version: 1,
    object_kind: "attestation_core",
    project_id: options.projectId,
    subject_kind: options.subjectKind,
    subject_id: options.subjectId,
    signer_key_id: options.signerKeyId,
    algorithm: "ed25519",
    signature_bytes: Uint8Array.from(options.signature)
  };
  const identity = await deriveAttestationIdentity(core);
  if (options.registerSignature !== false) {
    options.acceptedSignatures.set(
      attestationFixtureKey(options.subjectKind, options.subjectId, options.signerKeyId),
      Uint8Array.from(options.signature)
    );
  }
  return parseAttestationRecord({
    record_version: 1,
    object_kind: "attestation",
    attestation_id: identity.id,
    core
  });
}

async function makeOrdinaryControl(harness, options) {
  const action = options.action ?? await harness.store.putControlAction({
    schema_version: 1,
    project_id: ids.project,
    action_kind: "membership_role_change",
    membership_id: ids.membership,
    person_id: ids.owner,
    next_role: "owner"
  });
  const core = {
    schema_version: 1,
    object_kind: "control_event_core",
    control_kind: "ordinary",
    project_id: ids.project,
    control_sequence: options.sequence,
    previous_control_id: options.previous.control_event_id,
    issuer_device_id: options.issuerDeviceId ?? ids.deviceA,
    action_id: action.id,
    resulting_control_state_root: options.stateRoot,
    key_epoch_id: options.keyEpochId ?? ids.keyEpoch,
    key_epoch_commitment: options.keyCommitment ?? ids.keyCommit0
  };
  const identity = await deriveControlEventCoreIdentity(core);
  const nextAuthority = options.authorityFactory
    ? options.authorityFactory(identity.id)
    : options.authority ?? authorityState({
    controlEventId: identity.id,
    stateRoot: options.stateRoot,
    activeDeviceId: options.activeDeviceId ?? ids.deviceA,
    keyEpochId: options.keyEpochId ?? ids.keyEpoch,
    keyCommitment: options.keyCommitment ?? ids.keyCommit0
    });
  harness.transitionAuthorities.set(identity.id, nextAuthority);
  const issuer = options.issuerDeviceId ?? ids.deviceA;
  const key = issuer === ids.deviceB ? ids.signingKeyB : ids.signingKeyA;
  const attestation = await makeAttestation({
    projectId: ids.project,
    subjectKind: "control_event",
    subjectId: identity.id,
    signerKeyId: key,
    signature: options.signature ?? bytes(Number(options.sequence) + 40),
    acceptedSignatures: harness.acceptedSignatures
  });
  const record = parseControlEventRecordStructure({
    record_version: 1,
    object_kind: "control_event",
    control_event_id: identity.id,
    core,
    authority_attestation_id: attestation.attestation_id
  });
  return { action, core, identity, authority: nextAuthority, attestation, record };
}

async function makeRootRecovery(harness, options) {
  const action = await harness.store.putControlAction({
    schema_version: 1,
    project_id: ids.project,
    action_kind: "root_recovery",
    last_uncontested_control_id: options.base.control_event_id,
    selected_membership_device_state_root: options.stateRoot,
    revocation_sequence_cutoffs: options.cutoffs ?? [],
    replacement_active_control_device_id: options.activeDeviceId ?? ids.deviceB,
    replacement_key_epoch_id: options.keyEpochId ?? ids.keyEpoch2,
    replacement_key_epoch_commitment: options.keyCommitment ?? ids.keyCommit1,
    observed_conflicting_tip_ids: [...options.observedTips].sort(),
    supersession_policy: "supersede_all_ordinary_descendants_outside_recovery_chain"
  });
  const core = {
    schema_version: 1,
    object_kind: "control_event_core",
    control_kind: "root_recovery",
    project_id: ids.project,
    control_sequence: options.controlSequence ?? 1n,
    previous_control_id: options.base.control_event_id,
    root_sequence: options.rootSequence ?? 1n,
    previous_root_control_id: options.previousRoot.control_event_id,
    issuer_root_key_id: ids.rootKey,
    action_id: action.id,
    resulting_control_state_root: options.stateRoot,
    key_epoch_id: options.keyEpochId ?? ids.keyEpoch2,
    key_epoch_commitment: options.keyCommitment ?? ids.keyCommit1
  };
  const identity = await deriveControlEventCoreIdentity(core);
  const nextAuthority = authorityState({
    controlEventId: identity.id,
    stateRoot: options.stateRoot,
    activeDeviceId: options.activeDeviceId ?? ids.deviceB,
    keyEpochId: options.keyEpochId ?? ids.keyEpoch2,
    keyCommitment: options.keyCommitment ?? ids.keyCommit1
  });
  harness.transitionAuthorities.set(identity.id, nextAuthority);
  const attestation = await makeAttestation({
    projectId: ids.project,
    subjectKind: "control_event",
    subjectId: identity.id,
    signerKeyId: ids.rootKey,
    signature: options.signature ?? bytes(80, Number(options.rootSequence ?? 1n)),
    acceptedSignatures: harness.acceptedSignatures
  });
  const record = parseControlEventRecordStructure({
    record_version: 1,
    object_kind: "control_event",
    control_event_id: identity.id,
    core,
    authority_attestation_id: attestation.attestation_id
  });
  return { action, core, identity, authority: nextAuthority, attestation, record };
}

async function setupSemanticBase() {
  const harness = await createHarness();
  const genesisPayload = await putProjectGenesisPayload(harness);
  const event0 = await makeSemanticEvent(harness, {
    payload: genesisPayload,
    sequence: 0n,
    previousEventId: null,
    parents: []
  });
  await harness.store.putAttestationRecord(event0.attestation);
  await harness.store.ingestSemanticEvent(event0.record);
  const payload1 = await putMetadataPayload(harness, "Base one");
  const event1 = await makeSemanticEvent(harness, {
    payload: payload1,
    sequence: 1n,
    previousEventId: event0.identity.id,
    parents: [event0.identity.id]
  });
  await harness.store.putAttestationRecord(event1.attestation);
  await harness.store.ingestSemanticEvent(event1.record);
  return { harness, event0, event1 };
}

async function setupReviewEvidenceBase() {
  const base = await setupSemanticBase();
  const reviewBatchId = entity("review-batch", "a");
  const createPayload = await base.harness.store.putSemanticPayload({
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "review_batch_operation",
    data: { operation: "create", review_batch_id: reviewBatchId }
  });
  const createEvent = await makeSemanticEvent(base.harness, {
    payload: createPayload,
    sequence: 2n,
    previousEventId: base.event1.identity.id,
    parents: [base.event1.identity.id]
  });
  await base.harness.store.putAttestationRecord(createEvent.attestation);
  await base.harness.store.ingestSemanticEvent(createEvent.record);
  return { ...base, reviewBatchId, createEvent };
}

function authorityState(options) {
  return Object.freeze({
    schema_version: 1,
    project_id: ids.project,
    control_event_id: options.controlEventId,
    control_state_root: options.stateRoot,
    active_control_device_id: options.activeDeviceId,
    offline_root_key_id: ids.rootKey,
    key_epoch_id: options.keyEpochId,
    key_epoch_commitment: options.keyCommitment,
    device_authorities: Object.freeze([
      authorityFact(ids.deviceA, ids.signingKeyA),
      authorityFact(ids.deviceB, ids.signingKeyB)
    ])
  });
}

function authorityFact(deviceId, signingKeyId) {
  return Object.freeze({
    device_id: deviceId,
    person_id: ids.owner,
    signing_key_id: signingKeyId,
    role: "owner",
    capabilities: Object.freeze([...capabilitiesForRole("owner")]),
    status: "active",
    maximum_accepted_semantic_sequence: null
  });
}

function entity(kind, fill) {
  return `pm:${kind}:v1:${fill.repeat(25)}a`;
}

function digest(kind, fill) {
  return `pm:${kind}:v1:${fill.repeat(51)}a`;
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function attestationFixtureKey(kind, subjectId, keyId) {
  return `${kind}\n${subjectId}\n${keyId}`;
}

function classification(state, id) {
  return state.semantic_classifications.find((entry) => entry.object_id === id) ??
    state.control_classifications.find((entry) => entry.object_id === id);
}

function normalizeSemanticState(state) {
  return {
    accepted: [...state.accepted_semantic_event_ids].sort(),
    frontier: [...state.accepted_semantic_frontier].sort(),
    forks: state.semantic_forks.map((fork) => ({
      device_id: fork.device_id,
      sequence: fork.device_sequence.toString(),
      contenders: [...fork.contender_event_ids].sort()
    }))
  };
}

// Core immutable storage, semantic chain, late dependency promotion, and frontier.
const basic = await createHarness();
const genesisPayload = await putProjectGenesisPayload(basic);
const event0 = await makeSemanticEvent(basic, {
  payload: genesisPayload,
  sequence: 0n,
  previousEventId: null,
  parents: []
});
await basic.store.putAttestationRecord(event0.attestation);
let state = (await basic.store.ingestSemanticEvent(event0.record)).state;
check(classification(state, event0.identity.id).reason === "accepted", "first event should be accepted");
check(state.accepted_semantic_frontier[0] === event0.identity.id, "first event should form frontier");

const titlePayload = await putMetadataPayload(basic, "One");
const event1 = await makeSemanticEvent(basic, {
  payload: titlePayload,
  sequence: 1n,
  previousEventId: event0.identity.id,
  parents: [event0.identity.id]
});
await basic.store.putAttestationRecord(event1.attestation);
state = (await basic.store.ingestSemanticEvent(event1.record)).state;
check(state.accepted_semantic_event_ids.length === 2, "subsequent event should be accepted");
check(state.accepted_semantic_frontier[0] === event1.identity.id, "accepted child should replace parent in frontier");
const duplicate = await basic.store.ingestSemanticEvent(event1.record);
check(duplicate.object.status === "already_present", "exact duplicate event should be idempotent");

const parentPayload = await putMetadataPayload(basic, "Parent");
const lateParent = await makeSemanticEvent(basic, {
  payload: parentPayload,
  sequence: 2n,
  previousEventId: event1.identity.id,
  parents: [event1.identity.id]
});
const childPayload = await putMetadataPayload(basic, "Child");
const waitingChild = await makeSemanticEvent(basic, {
  payload: childPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [lateParent.identity.id]
});
await basic.store.putAttestationRecord(waitingChild.attestation);
state = (await basic.store.ingestSemanticEvent(waitingChild.record)).state;
check(classification(state, waitingChild.identity.id).reason === "missing_causal_parent", "missing parent should quarantine");
await basic.store.putAttestationRecord(lateParent.attestation);
state = (await basic.store.ingestSemanticEvent(lateParent.record)).state;
check(classification(state, waitingChild.identity.id).reason === "accepted", "late parent should promote child");
check(state.accepted_semantic_frontier.includes(waitingChild.identity.id), "promoted child should enter frontier");

// Immutable namespace and corruption behavior.
assert.throws(
  () => collaborationObjectAddresses("semantic-event", basic.genesisRecord.control_event_id),
  /semantic-event ID/
);
assert.throws(
  () => collaborationObjectAddresses("semantic-event", "../escape"),
  /semantic-event ID/
);
const eventAddress = collaborationObjectAddresses("semantic-event", event1.identity.id);
const originalEventBytes = await basic.backend.read(eventAddress.data);
basic.backend.corrupt(eventAddress.data, (value) => Uint8Array.from([...value.slice(0, -1), value.at(-1) ^ 1]));
const corruptedEvent = await basic.store.immutableObjects.getSemanticEvent(event1.identity.id);
check(corruptedEvent.status === "corrupted", "corrupted event bytes must fail closed");
basic.backend.records.set(eventAddress.data, originalEventBytes);
check((await basic.store.immutableObjects.getSemanticEvent(event1.identity.id)).status === "valid", "restored exact bytes should verify");

// Missing and incorrectly bound attestations remain pending or permanently invalid.
const attestationCases = await setupSemanticBase();
const missingAttPayload = await putMetadataPayload(attestationCases.harness, "Missing attestation");
const missingAttEvent = await makeSemanticEvent(attestationCases.harness, {
  payload: missingAttPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [attestationCases.event1.identity.id]
});
state = (await attestationCases.harness.store.ingestSemanticEvent(missingAttEvent.record)).state;
check(classification(state, missingAttEvent.identity.id).reason === "missing_attestation", "missing attestation should remain retryable");
await attestationCases.harness.store.putAttestationRecord(missingAttEvent.attestation);
state = await attestationCases.harness.store.reconstructProject(ids.project);
check(classification(state, missingAttEvent.identity.id).reason === "accepted", "late attestation should promote after full revalidation");

const wrongKeyPayload = await putMetadataPayload(attestationCases.harness, "Wrong key");
const wrongKeyEvent = await makeSemanticEvent(attestationCases.harness, {
  payload: wrongKeyPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [attestationCases.event1.identity.id],
  attestationKeyId: ids.signingKeyA
});
await attestationCases.harness.store.putAttestationRecord(wrongKeyEvent.attestation);
state = (await attestationCases.harness.store.ingestSemanticEvent(wrongKeyEvent.record)).state;
check(classification(state, wrongKeyEvent.identity.id).reason === "invalid_attestation", "wrong signer key should be permanently invalid");

const alteredPayload = await putMetadataPayload(attestationCases.harness, "Altered signature");
const alteredEvent = await makeSemanticEvent(attestationCases.harness, {
  payload: alteredPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [attestationCases.event1.identity.id],
  signature: bytes(201),
  registerSignature: false
});
attestationCases.harness.acceptedSignatures.set(
  attestationFixtureKey("semantic_event", alteredEvent.identity.id, ids.signingKeyB),
  bytes(202)
);
await attestationCases.harness.store.putAttestationRecord(alteredEvent.attestation);
state = (await attestationCases.harness.store.ingestSemanticEvent(alteredEvent.record)).state;
check(classification(state, alteredEvent.identity.id).reason === "invalid_attestation", "altered signature should be rejected by bound verifier");

const wrongSubjectPayload = await putMetadataPayload(attestationCases.harness, "Wrong subject");
const wrongSubjectEvent = await makeSemanticEvent(attestationCases.harness, {
  payload: wrongSubjectPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [attestationCases.event1.identity.id],
  attestationSubjectId: attestationCases.event1.identity.id
});
await attestationCases.harness.store.putAttestationRecord(wrongSubjectEvent.attestation);
state = (await attestationCases.harness.store.ingestSemanticEvent(wrongSubjectEvent.record)).state;
check(classification(state, wrongSubjectEvent.identity.id).reason === "invalid_attestation", "wrong subject should be rejected");

await assert.rejects(
  attestationCases.harness.store.putAttestationCore({
    schema_version: 1,
    object_kind: "attestation_core",
    project_id: ids.project,
    subject_kind: "semantic_event",
    subject_id: attestationCases.harness.genesisRecord.control_event_id,
    signer_key_id: ids.signingKeyA,
    algorithm: "ed25519",
    signature_bytes: bytes(1)
  }),
  /semantic-event ID/
);
assert.throws(
  () => parseSemanticEventRecordStructure({
    ...missingAttEvent.record,
    author_attestation_ids: [
      missingAttEvent.attestation.attestation_id,
      missingAttEvent.attestation.attestation_id
    ]
  }),
  /sorted and unique/
);
assert.throws(
  () => parseSemanticEventRecordStructure({
    ...missingAttEvent.record,
    author_attestation_ids: []
  }),
  /must not be empty|exactly one mandatory author attestation/
);
assertions += 1;
assert.throws(
  () => parseSemanticEventRecordStructure({
    ...missingAttEvent.record,
    author_attestation_ids: [
      missingAttEvent.attestation.attestation_id,
      digest("attestation", "z")
    ].sort()
  }),
  /exactly one mandatory author attestation/
);
assertions += 1;
await assert.rejects(
  attestationCases.harness.store.putAttestationCore({
    ...missingAttEvent.attestation.core,
    algorithm: "unknown"
  }),
  /attestation algorithm/
);
const verificationCount = attestationCases.harness.getAttestationVerificationCount();
await attestationCases.harness.store.reopenProject(ids.project);
check(attestationCases.harness.getAttestationVerificationCount() > verificationCount, "reopening should reverify stored attestations");

// Review-response evidence is verified during reconstruction, including its
// exact same-project/review contribution relationship.
const validReview = await setupReviewEvidenceBase();
const responseImportId = "review-import-1";
const contributionPayload = await validReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "reply_operation",
  data: {
    operation: "create",
    document_id: ids.document,
    comment_id: entity("comment", "a"),
    reply_id: entity("reply", "a"),
    content: "Shared response contribution",
    review_batch_id: validReview.reviewBatchId,
    response_import_id: responseImportId
  }
});
const contributionEvent = await makeSemanticEvent(validReview.harness, {
  payload: contributionPayload,
  sequence: 3n,
  previousEventId: validReview.createEvent.identity.id,
  parents: [validReview.createEvent.identity.id]
});
await validReview.harness.store.putAttestationRecord(contributionEvent.attestation);
await validReview.harness.store.ingestSemanticEvent(contributionEvent.record);
const validEvidence = await deriveReviewResponseEvidence({
  schema_version: 1,
  project_id: ids.project,
  review_batch_id: validReview.reviewBatchId,
  response_import_id: responseImportId,
  contribution_payload_ids: [contributionPayload.id]
});
const validResponsePayload = await validReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "review_batch_operation",
  data: {
    operation: "respond",
    review_batch_id: validReview.reviewBatchId,
    response_evidence_commitment: validEvidence.commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: [contributionPayload.id]
  }
});
const validResponseEvent = await makeSemanticEvent(validReview.harness, {
  payload: validResponsePayload,
  sequence: 4n,
  previousEventId: contributionEvent.identity.id,
  parents: [contributionEvent.identity.id]
});
await validReview.harness.store.putAttestationRecord(validResponseEvent.attestation);
state = (await validReview.harness.store.ingestSemanticEvent(
  validResponseEvent.record
)).state;
check(
  classification(state, validResponseEvent.identity.id).reason === "accepted",
  "a response with an exact causally prior contribution must be accepted"
);
state = await validReview.harness.store.reopenProject(ids.project);
check(
  classification(state, validResponseEvent.identity.id).reason === "accepted",
  "reopening must reproduce the same accepted review evidence"
);

const missingReview = await setupReviewEvidenceBase();
const missingContributionId = digest("semantic-payload", "z");
const missingEvidence = await deriveReviewResponseEvidence({
  schema_version: 1,
  project_id: ids.project,
  review_batch_id: missingReview.reviewBatchId,
  response_import_id: responseImportId,
  contribution_payload_ids: [missingContributionId]
});
const missingResponsePayload = await missingReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "review_batch_operation",
  data: {
    operation: "respond",
    review_batch_id: missingReview.reviewBatchId,
    response_evidence_commitment: missingEvidence.commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: [missingContributionId]
  }
});
const missingResponseEvent = await makeSemanticEvent(missingReview.harness, {
  payload: missingResponsePayload,
  sequence: 3n,
  previousEventId: missingReview.createEvent.identity.id,
  parents: [missingReview.createEvent.identity.id]
});
await missingReview.harness.store.putAttestationRecord(missingResponseEvent.attestation);
state = (await missingReview.harness.store.ingestSemanticEvent(
  missingResponseEvent.record
)).state;
check(
  classification(state, missingResponseEvent.identity.id).reason === "missing_payload",
  "a nonexistent review contribution must remain fail-closed and pending"
);

const unrelatedReview = await setupReviewEvidenceBase();
const unrelatedContribution = await unrelatedReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "reply_operation",
  data: {
    operation: "create",
    document_id: ids.document,
    comment_id: entity("comment", "b"),
    reply_id: entity("reply", "b"),
    content: "Unrelated response contribution",
    review_batch_id: entity("review-batch", "b"),
    response_import_id: responseImportId
  }
});
const unrelatedContributionEvent = await makeSemanticEvent(
  unrelatedReview.harness,
  {
    payload: unrelatedContribution,
    sequence: 3n,
    previousEventId: unrelatedReview.createEvent.identity.id,
    parents: [unrelatedReview.createEvent.identity.id]
  }
);
await unrelatedReview.harness.store.putAttestationRecord(
  unrelatedContributionEvent.attestation
);
await unrelatedReview.harness.store.ingestSemanticEvent(
  unrelatedContributionEvent.record
);
const unrelatedEvidence = await deriveReviewResponseEvidence({
  schema_version: 1,
  project_id: ids.project,
  review_batch_id: unrelatedReview.reviewBatchId,
  response_import_id: responseImportId,
  contribution_payload_ids: [unrelatedContribution.id]
});
const unrelatedResponsePayload = await unrelatedReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "review_batch_operation",
  data: {
    operation: "respond",
    review_batch_id: unrelatedReview.reviewBatchId,
    response_evidence_commitment: unrelatedEvidence.commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: [unrelatedContribution.id]
  }
});
const unrelatedResponseEvent = await makeSemanticEvent(unrelatedReview.harness, {
  payload: unrelatedResponsePayload,
  sequence: 4n,
  previousEventId: unrelatedContributionEvent.identity.id,
  parents: [unrelatedContributionEvent.identity.id]
});
await unrelatedReview.harness.store.putAttestationRecord(
  unrelatedResponseEvent.attestation
);
state = (await unrelatedReview.harness.store.ingestSemanticEvent(
  unrelatedResponseEvent.record
)).state;
check(
  classification(state, unrelatedResponseEvent.identity.id).reason ===
    "forbidden_or_circular_reference",
  "an unrelated-review contribution must be permanently invalid"
);

const foreignReview = await setupReviewEvidenceBase();
const foreignContribution = await foreignReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.projectB,
  semantic_kind: "reply_operation",
  data: {
    operation: "create",
    document_id: ids.document,
    comment_id: entity("comment", "c"),
    reply_id: entity("reply", "c"),
    content: "Foreign response contribution",
    review_batch_id: foreignReview.reviewBatchId,
    response_import_id: responseImportId
  }
});
const foreignEvidence = await deriveReviewResponseEvidence({
  schema_version: 1,
  project_id: ids.project,
  review_batch_id: foreignReview.reviewBatchId,
  response_import_id: responseImportId,
  contribution_payload_ids: [foreignContribution.id]
});
const foreignResponsePayload = await foreignReview.harness.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "review_batch_operation",
  data: {
    operation: "respond",
    review_batch_id: foreignReview.reviewBatchId,
    response_evidence_commitment: foreignEvidence.commitment,
    response_import_id: responseImportId,
    contribution_payload_ids: [foreignContribution.id]
  }
});
const foreignResponseEvent = await makeSemanticEvent(foreignReview.harness, {
  payload: foreignResponsePayload,
  sequence: 3n,
  previousEventId: foreignReview.createEvent.identity.id,
  parents: [foreignReview.createEvent.identity.id]
});
await foreignReview.harness.store.putAttestationRecord(
  foreignResponseEvent.attestation
);
state = (await foreignReview.harness.store.ingestSemanticEvent(
  foreignResponseEvent.record
)).state;
check(
  classification(state, foreignResponseEvent.identity.id).reason ===
    "cross_project_reference",
  "a foreign-project contribution must be permanently invalid"
);

// Same-device forks are authority-free, demote provisional acceptance, and quarantine descendants.
async function buildForkState(order) {
  const setup = await setupSemanticBase();
  const payloadA = await putMetadataPayload(setup.harness, "Fork A");
  const payloadB = await putMetadataPayload(setup.harness, "Fork B");
  const branchA = await makeSemanticEvent(setup.harness, {
    payload: payloadA,
    sequence: 2n,
    previousEventId: setup.event1.identity.id,
    parents: [setup.event1.identity.id],
    signature: bytes(61)
  });
  const branchB = await makeSemanticEvent(setup.harness, {
    payload: payloadB,
    sequence: 2n,
    previousEventId: setup.event1.identity.id,
    parents: [setup.event1.identity.id],
    signature: bytes(62)
  });
  for (const branch of [branchA, branchB]) {
    await setup.harness.store.putAttestationRecord(branch.attestation);
  }
  let forkState;
  for (const name of order) {
    forkState = (await setup.harness.store.ingestSemanticEvent(
      name === "A" ? branchA.record : branchB.record
    )).state;
  }
  const descendantPayload = await putMetadataPayload(setup.harness, "Fork descendant");
  const descendant = await makeSemanticEvent(setup.harness, {
    payload: descendantPayload,
    sequence: 3n,
    previousEventId: branchA.identity.id,
    parents: [branchA.identity.id],
    signature: bytes(63)
  });
  await setup.harness.store.putAttestationRecord(descendant.attestation);
  forkState = (await setup.harness.store.ingestSemanticEvent(descendant.record)).state;
  return { setup, branchA, branchB, descendant, state: forkState };
}

const forkAB = await buildForkState(["A", "B"]);
const forkBA = await buildForkState(["B", "A"]);
check(forkAB.state.semantic_forks.length === 1, "same sequence should create one semantic fork record");
check(classification(forkAB.state, forkAB.branchA.identity.id).reason === "same_device_fork", "first provisional branch should be demoted");
check(classification(forkAB.state, forkAB.branchB.identity.id).reason === "same_device_fork", "second branch should be disputed");
check(classification(forkAB.state, forkAB.descendant.identity.id).reason === "dependency_quarantined", "fork descendant should be quarantined");
check(
  JSON.stringify(normalizeSemanticState(forkAB.state)) ===
    JSON.stringify(normalizeSemanticState(forkBA.state)),
  "semantic fork result should be arrival-order independent"
);
const forkDuplicate = await forkAB.setup.harness.store.ingestSemanticEvent(forkAB.branchB.record);
check(forkDuplicate.object.status === "already_present", "exact duplicate should not create another fork");

// Strict ordinary control, control forks, root recovery supersession, and root fork freeze.
const controls = await createHarness();
const ordinaryA = await makeOrdinaryControl(controls, {
  previous: controls.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(71)
});
await controls.store.putAttestationRecord(ordinaryA.attestation);
state = (await controls.store.ingestControlEvent(ordinaryA.record)).state;
check(classification(state, ordinaryA.identity.id).reason === "accepted", "designated active control device should extend control chain");

const nonDesignated = await makeOrdinaryControl(controls, {
  previous: ordinaryA.record,
  sequence: 2n,
  stateRoot: ids.stateRoot2,
  issuerDeviceId: ids.deviceB,
  signature: bytes(72)
});
await controls.store.putAttestationRecord(nonDesignated.attestation);
state = (await controls.store.ingestControlEvent(nonDesignated.record)).state;
check(classification(state, nonDesignated.identity.id).reason === "non_designated_control_issuer", "editor authority must not imply control authority");

const forkControl = await createHarness();
const controlA = await makeOrdinaryControl(forkControl, {
  previous: forkControl.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(73)
});
const controlB = await makeOrdinaryControl(forkControl, {
  previous: forkControl.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot2,
  action: controlA.action,
  signature: bytes(74)
});
for (const branch of [controlA, controlB]) {
  await forkControl.store.putAttestationRecord(branch.attestation);
  state = (await forkControl.store.ingestControlEvent(branch.record)).state;
}
check(state.control_forks.length === 1, "two ordinary children should create a control fork");
check(classification(state, controlA.identity.id).reason === "control_fork", "earlier control child should be demoted");
check(classification(state, controlB.identity.id).reason === "control_fork", "later control child should remain disputed");

const reverseControlFork = await createHarness();
const reverseA = await makeOrdinaryControl(reverseControlFork, {
  previous: reverseControlFork.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(73)
});
const reverseB = await makeOrdinaryControl(reverseControlFork, {
  previous: reverseControlFork.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot2,
  action: reverseA.action,
  signature: bytes(74)
});
for (const branch of [reverseB, reverseA]) {
  await reverseControlFork.store.putAttestationRecord(branch.attestation);
  state = (await reverseControlFork.store.ingestControlEvent(branch.record)).state;
}
check(
  JSON.stringify(state.control_forks.map((fork) => fork.conflicting_tip_ids)) ===
    JSON.stringify((await forkControl.store.reconstructProject(ids.project)).control_forks.map((fork) => fork.conflicting_tip_ids)),
  "control fork evidence should be independent of branch arrival order"
);

const recovery = await makeRootRecovery(forkControl, {
  base: forkControl.genesisRecord,
  previousRoot: forkControl.genesisRecord,
  observedTips: [controlA.identity.id, controlB.identity.id],
  stateRoot: ids.selectedStateRoot,
  signature: bytes(75)
});
await forkControl.store.putAttestationRecord(recovery.attestation);
state = (await forkControl.store.ingestControlEvent(recovery.record)).state;
check(classification(state, recovery.identity.id).reason === "accepted", "valid root recovery should be accepted");
check(classification(state, controlA.identity.id).reason === "superseded_control_branch", "root recovery should supersede first fork branch");
check(classification(state, controlB.identity.id).reason === "superseded_control_branch", "root recovery should supersede second fork branch");
check(state.control_forks.length === 0, "resolved ordinary branches should no longer freeze control");

const lateDescendant = await makeOrdinaryControl(forkControl, {
  previous: controlA.record,
  sequence: 2n,
  stateRoot: ids.stateRoot2,
  action: controlA.action,
  signature: bytes(76)
});
await forkControl.store.putAttestationRecord(lateDescendant.attestation);
state = (await forkControl.store.ingestControlEvent(lateDescendant.record)).state;
check(classification(state, lateDescendant.identity.id).reason === "superseded_control_branch", "late branch descendant should be superseded deterministically");

const secondRecovery = await makeRootRecovery(forkControl, {
  base: forkControl.genesisRecord,
  previousRoot: forkControl.genesisRecord,
  observedTips: [controlA.identity.id],
  stateRoot: ids.stateRoot2,
  signature: bytes(77)
});
await forkControl.store.putAttestationRecord(secondRecovery.attestation);
state = (await forkControl.store.ingestControlEvent(secondRecovery.record)).state;
check(state.root_forks.length === 1, "two root children should create a root fork");
check(state.accepted_control_event_ids.length === 0, "root fork should freeze the complete control protocol");

const genesisFork = await createHarness();
const alternateGenesisCore = {
  ...genesisFork.genesisCore,
  resulting_control_state_root: ids.stateRoot1
};
const alternateGenesisIdentity = await deriveControlEventCoreIdentity(alternateGenesisCore);
genesisFork.transitionAuthorities.set(
  alternateGenesisIdentity.id,
  authorityState({
    controlEventId: alternateGenesisIdentity.id,
    stateRoot: ids.stateRoot1,
    activeDeviceId: ids.deviceA,
    keyEpochId: ids.keyEpoch,
    keyCommitment: ids.keyCommit0
  })
);
const alternateGenesisAttestation = await makeAttestation({
  projectId: ids.project,
  subjectKind: "control_event",
  subjectId: alternateGenesisIdentity.id,
  signerKeyId: ids.rootKey,
  signature: bytes(78),
  acceptedSignatures: genesisFork.acceptedSignatures
});
await genesisFork.store.putAttestationRecord(alternateGenesisAttestation);
state = (await genesisFork.store.ingestControlEvent(parseControlEventRecordStructure({
  record_version: 1,
  object_kind: "control_event",
  control_event_id: alternateGenesisIdentity.id,
  core: alternateGenesisCore,
  authority_attestation_id: alternateGenesisAttestation.attestation_id
}))).state;
check(state.root_forks.length === 1, "incompatible root-authorized genesis records should freeze authority");
check(state.accepted_control_event_ids.length === 0, "incompatible genesis must not gain an arrival-order winner");

const invalidRecoveryHarness = await createHarness();
const observedBranch = await makeOrdinaryControl(invalidRecoveryHarness, {
  previous: invalidRecoveryHarness.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(79)
});
await invalidRecoveryHarness.store.putAttestationRecord(observedBranch.attestation);
await invalidRecoveryHarness.store.ingestControlEvent(observedBranch.record);
const invalidCutoffRecovery = await makeRootRecovery(invalidRecoveryHarness, {
  base: invalidRecoveryHarness.genesisRecord,
  previousRoot: invalidRecoveryHarness.genesisRecord,
  observedTips: [observedBranch.identity.id],
  stateRoot: ids.selectedStateRoot,
  cutoffs: [{ device_id: ids.deviceA, maximum_accepted_semantic_sequence: 0n }],
  signature: bytes(80)
});
await invalidRecoveryHarness.store.putAttestationRecord(invalidCutoffRecovery.attestation);
state = (await invalidRecoveryHarness.store.ingestControlEvent(invalidCutoffRecovery.record)).state;
check(classification(state, invalidCutoffRecovery.identity.id).reason === "invalid_previous_link", "recovery must apply exact cutoff facts returned by transition verification");

const missingTipRecovery = await makeRootRecovery(invalidRecoveryHarness, {
  base: invalidRecoveryHarness.genesisRecord,
  previousRoot: invalidRecoveryHarness.genesisRecord,
  observedTips: [digest("control-event", "n")],
  stateRoot: ids.stateRoot2,
  signature: bytes(81)
});
await invalidRecoveryHarness.store.putAttestationRecord(missingTipRecovery.attestation);
state = (await invalidRecoveryHarness.store.ingestControlEvent(missingTipRecovery.record)).state;
check(classification(state, missingTipRecovery.identity.id).reason === "control_state_unavailable", "recovery with an unavailable observed tip must remain pending");

// Crash-safe local sequence reservations, idempotent concurrency, and reopening.
function localRequest(harness, payload, parents = []) {
  return {
    project_id: ids.project,
    author_device_id: ids.deviceA,
    semantic_kind: payload.value.core.semantic_kind,
    semantic_payload_id: payload.id,
    causal_parent_event_ids: [...parents].sort(),
    authorizing_control_head_id: harness.genesisRecord.control_event_id,
    key_epoch_id: ids.keyEpoch,
    complete_known_frontier: true,
    async create_attestations(request) {
      return [await makeAttestation({
        projectId: request.project_id,
        subjectKind: "semantic_event",
        subjectId: request.event_id,
        signerKeyId: request.expected_signing_key_id,
        signature: bytes(91),
        acceptedSignatures: harness.acceptedSignatures
      })];
    }
  };
}

const local = await createHarness();
const localPayload = await putProjectGenesisPayload(local);
const localAppendRequest = localRequest(local, localPayload);
const concurrentResults = await Promise.all([
  local.store.appendLocalSemanticEvent(localAppendRequest),
  local.store.appendLocalSemanticEvent(localAppendRequest)
]);
check(concurrentResults.filter((result) => result.status === "committed").length === 1, "concurrent identical append should commit once");
check(concurrentResults.filter((result) => result.status === "already_committed").length === 1, "concurrent retry should converge idempotently");
check(concurrentResults[0].event.event_id === concurrentResults[1].event.event_id, "concurrent append should bind one exact event");
let reservation = await local.store.getSequenceReservation(ids.project, ids.deviceA);
check(reservation.status === "valid" && reservation.value.reservation_state === "committed", "sequence commits only with its bound event");
const localReopened = await local.store.reopenProject(ids.project);
check(localReopened.accepted_semantic_event_ids.includes(concurrentResults[0].event.event_id), "reopening should reconstruct committed local event");

const ambiguousLocal = await createHarness();
const ambiguousLocalPayload = await putProjectGenesisPayload(ambiguousLocal);
const ambiguousLocalRequest = {
  ...localRequest(ambiguousLocal, ambiguousLocalPayload),
  async create_attestations(request) {
    return Promise.all([91, 92].map((signature) => makeAttestation({
      projectId: request.project_id,
      subjectKind: "semantic_event",
      subjectId: request.event_id,
      signerKeyId: request.expected_signing_key_id,
      signature: bytes(signature),
      acceptedSignatures: ambiguousLocal.acceptedSignatures
    })));
  }
};
await assert.rejects(
  () => ambiguousLocal.store.appendLocalSemanticEvent(ambiguousLocalRequest),
  /exactly one mandatory author attestation/
);
assertions += 1;

for (const failureStage of [
  "before_reservation_write",
  "after_reservation_before_attestation_storage",
  "after_attestation_storage_before_event_storage",
  "after_event_commit_before_sequence_index_update"
]) {
  const crash = await createHarness();
  const payload = await putProjectGenesisPayload(crash);
  const request = localRequest(crash, payload);
  crash.setSliceFailureStage(failureStage);
  await assert.rejects(crash.store.appendLocalSemanticEvent(request), /injected Slice 4 failure/);
  reservation = await crash.store.getSequenceReservation(ids.project, ids.deviceA);
  if (failureStage === "before_reservation_write") {
    check(reservation.status === "missing", "pre-reservation crash must not allocate a sequence");
    const retried = await crash.store.appendLocalSemanticEvent(request);
    check(retried.status === "committed", "retry after pre-reservation crash should allocate normally");
  } else {
    check(reservation.status === "valid" && reservation.value.reservation_state === "pending", `${failureStage} should leave an explicit pending reservation`);
    const recovered = await crash.store.reopenProject(ids.project);
    reservation = await crash.store.getSequenceReservation(ids.project, ids.deviceA);
    check(reservation.status === "valid" && reservation.value.reservation_state === "committed", `${failureStage} should complete exact reservation on reopening`);
    check(recovered.accepted_semantic_event_ids.length === 1, `${failureStage} recovery should accept exact bound event`);
  }
}

const visibilityCrash = await createHarness({
  objectFailureKind: "semantic-event"
});
const visibilityPayload = await putProjectGenesisPayload(visibilityCrash);
visibilityCrash.setObjectFailureStage("after_verification_before_committed_visibility");
await assert.rejects(
  visibilityCrash.store.appendLocalSemanticEvent(localRequest(visibilityCrash, visibilityPayload)),
  /injected object failure/
);
reservation = await visibilityCrash.store.getSequenceReservation(ids.project, ids.deviceA);
check(reservation.status === "valid" && reservation.value.reservation_state === "pending", "event visibility crash should retain exact reservation");
state = await visibilityCrash.store.reopenProject(ids.project);
check(state.accepted_semantic_event_ids.length === 1, "reopening should complete event interrupted before visibility");

for (const objectStage of [
  "before_first_write",
  "after_write_before_verification"
]) {
  const interrupted = await createHarness({ objectFailureKind: "semantic-event" });
  const payload = await putProjectGenesisPayload(interrupted);
  const event = await makeSemanticEvent(interrupted, {
    payload,
    sequence: 0n,
    previousEventId: null,
    parents: []
  });
  await interrupted.store.putAttestationRecord(event.attestation);
  interrupted.setObjectFailureStage(objectStage);
  await assert.rejects(
    interrupted.store.ingestSemanticEvent(event.record),
    /injected object failure/
  );
  const interruptedRead = await interrupted.store.immutableObjects.getSemanticEvent(
    event.identity.id
  );
  check(
    interruptedRead.status === (objectStage === "before_first_write" ? "missing" : "incomplete"),
    `${objectStage} should never expose a partial event as valid`
  );
  const retried = await interrupted.store.ingestSemanticEvent(event.record);
  check(classification(retried.state, event.identity.id).reason === "accepted", `${objectStage} retry should converge on the exact event`);
}

for (const partialStage of ["staging", "object_data", "commit_marker"]) {
  const interrupted = await createHarness();
  const payload = await putProjectGenesisPayload(interrupted);
  const event = await makeSemanticEvent(interrupted, {
    payload,
    sequence: 0n,
    previousEventId: null,
    parents: []
  });
  await interrupted.store.putAttestationRecord(event.attestation);
  interrupted.backend.partialStage = partialStage;
  await assert.rejects(interrupted.store.immutableObjects.ingestSemanticEvent(event.record));
  const interruptedRead = await interrupted.store.immutableObjects.getSemanticEvent(
    event.identity.id
  );
  check(interruptedRead.status !== "valid", `partial ${partialStage} write must fail closed`);
  interrupted.backend.partialStage = null;
  const retried = await interrupted.store.ingestSemanticEvent(event.record);
  check(classification(retried.state, event.identity.id).reason === "accepted", `partial ${partialStage} retry should converge safely`);
}

const partialReservation = await createHarness();
const partialPayload = await putProjectGenesisPayload(partialReservation);
partialReservation.backend.partialStage = "sequence_reservation";
await assert.rejects(
  partialReservation.store.appendLocalSemanticEvent(localRequest(partialReservation, partialPayload)),
  /reservation write was incomplete/
);
partialReservation.backend.partialStage = null;
reservation = await partialReservation.store.getSequenceReservation(ids.project, ids.deviceA);
check(reservation.status === "corrupted", "partial reservation must be explicitly corrupted");
await assert.rejects(
  partialReservation.store.appendLocalSemanticEvent(localRequest(partialReservation, partialPayload)),
  (error) => error.code === "chain_blocked"
);

const reopenFailure = await createHarness();
reopenFailure.setSliceFailureStage("during_reopening");
await assert.rejects(reopenFailure.store.reopenProject(ids.project), /during_reopening/);

// Derived classification/frontier indexes are non-authoritative and rebuildable.
const indexAddress = collaborationEventControlStateIndexAddress(ids.project);
check((await basic.store.getProjectStateIndex(ids.project)).status === "valid", "derived state index should verify");
const stateBeforeIndexCorruption = await basic.store.reconstructProject(ids.project);
basic.backend.corrupt(indexAddress);
check((await basic.store.getProjectStateIndex(ids.project)).status === "corrupted", "corrupted derived index should be detected");
const rebuiltState = await basic.store.reconstructProject(ids.project);
check((await basic.store.getProjectStateIndex(ids.project)).status === "valid", "reconstruction should replace corrupted derived index");
check(
  JSON.stringify(normalizeSemanticState(stateBeforeIndexCorruption)) ===
    JSON.stringify(normalizeSemanticState(rebuiltState)),
  "corrupted index must not override authoritative immutable records"
);
const authoritativeEventAddress = collaborationObjectAddresses(
  "semantic-event",
  event0.identity.id
);
const authoritativeEventBytes = await basic.backend.read(authoritativeEventAddress.data);
basic.backend.corrupt(authoritativeEventAddress.data);
const corruptedAuthorityState = await basic.store.reconstructProject(ids.project);
check(!corruptedAuthorityState.accepted_semantic_event_ids.includes(event0.identity.id), "apparently valid derived index cannot validate corrupted authoritative event");
check(corruptedAuthorityState.invalid_object_ids.includes(event0.identity.id), "corrupted authoritative event should remain explicit audit evidence");
basic.backend.records.set(authoritativeEventAddress.data, authoritativeEventBytes);
await basic.store.reconstructProject(ids.project);

const reservationAddress = collaborationSemanticReservationAddress(ids.project, ids.deviceA);
check(local.backend.records.has(reservationAddress), "reservation should remain in strict project/device namespace");
const localReservation = await local.store.getSequenceReservation(ids.project, ids.deviceA);
assert.equal(localReservation.status, "valid");
const decodedLocalEvent = await decodeStoredSemanticEvent(localReservation.value.event_record_bytes);
check(decodedLocalEvent.event_id === concurrentResults[0].event.event_id, "reservation should preserve exact canonical event bytes");

const signaturePreimage = encodeCanonicalCbor(
  buildSignaturePreimage("semantic_event", ids.project, event0.identity.id)
);
check(signaturePreimage.length > 32, "signature verification should bind the exact Slice 2 preimage");

const nextLocalPayload = await putMetadataPayload(local, "Local second");
const nextLocal = await local.store.appendLocalSemanticEvent(
  localRequest(local, nextLocalPayload, [concurrentResults[0].event.event_id])
);
check(nextLocal.event.core.device_sequence === 1n, "local allocator should increment the exact committed sequence");
check(nextLocal.event.core.previous_device_event_id === concurrentResults[0].event.event_id, "local allocator should bind the exact previous device event");
const competingPayloadA = await putMetadataPayload(local, "Competing A");
const competingPayloadB = await putMetadataPayload(local, "Competing B");
const competing = await Promise.allSettled([
  local.store.appendLocalSemanticEvent(
    localRequest(local, competingPayloadA, [nextLocal.event.event_id])
  ),
  local.store.appendLocalSemanticEvent(
    localRequest(local, competingPayloadB, [nextLocal.event.event_id])
  )
]);
check(competing.filter((result) => result.status === "fulfilled").length === 1, "concurrent different appends should serialize to one next event");
check(competing.filter((result) => result.status === "rejected").length === 1, "stale concurrent append must not reuse the allocated sequence");
const localEvents = await local.store.immutableObjects.scan("semantic-event");
const localSequences = localEvents
  .filter((entry) => entry.result.status === "valid")
  .map((entry) => entry.result.value.core.device_sequence.toString());
check(new Set(localSequences).size === localSequences.length, "local append must never assign one sequence to two events");

// Immutable-first imported objects classify missing payload/action and promote later.
const missingDependencies = await setupSemanticBase();
const deferredPayloadCore = {
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "metadata_operation",
  data: { operation: "project_title", value: "Deferred payload" }
};
const deferredPayloadIdentity = await deriveSemanticPayloadIdentity(deferredPayloadCore);
const deferredPayloadFixture = {
  id: deferredPayloadIdentity.id,
  value: {
    record_version: 1,
    object_kind: "semantic_payload",
    payload_id: deferredPayloadIdentity.id,
    core: deferredPayloadCore
  }
};
const deferredEvent = await makeSemanticEvent(missingDependencies.harness, {
  payload: deferredPayloadFixture,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [missingDependencies.event1.identity.id]
});
await missingDependencies.harness.store.putAttestationRecord(deferredEvent.attestation);
state = (await missingDependencies.harness.store.ingestSemanticEvent(deferredEvent.record)).state;
check(classification(state, deferredEvent.identity.id).reason === "missing_payload", "imported event should preserve identity while payload is missing");
await missingDependencies.harness.store.putSemanticPayload(deferredPayloadCore);
state = await missingDependencies.harness.store.reconstructProject(ids.project);
check(classification(state, deferredEvent.identity.id).reason === "accepted", "late payload should promote imported event");

const missingActionHarness = await createHarness();
const deferredActionCore = {
  schema_version: 1,
  project_id: ids.project,
  action_kind: "membership_role_change",
  membership_id: ids.membership,
  person_id: ids.owner,
  next_role: "owner"
};
const deferredActionIdentity = await deriveControlActionIdentity(deferredActionCore);
const missingActionCore = {
  schema_version: 1,
  object_kind: "control_event_core",
  control_kind: "ordinary",
  project_id: ids.project,
  control_sequence: 1n,
  previous_control_id: missingActionHarness.genesisRecord.control_event_id,
  issuer_device_id: ids.deviceA,
  action_id: deferredActionIdentity.id,
  resulting_control_state_root: ids.stateRoot1,
  key_epoch_id: ids.keyEpoch,
  key_epoch_commitment: ids.keyCommit0
};
const missingActionIdentity = await deriveControlEventCoreIdentity(missingActionCore);
missingActionHarness.transitionAuthorities.set(
  missingActionIdentity.id,
  authorityState({
    controlEventId: missingActionIdentity.id,
    stateRoot: ids.stateRoot1,
    activeDeviceId: ids.deviceA,
    keyEpochId: ids.keyEpoch,
    keyCommitment: ids.keyCommit0
  })
);
const missingActionAttestation = await makeAttestation({
  projectId: ids.project,
  subjectKind: "control_event",
  subjectId: missingActionIdentity.id,
  signerKeyId: ids.signingKeyA,
  signature: bytes(111),
  acceptedSignatures: missingActionHarness.acceptedSignatures
});
const missingActionRecord = parseControlEventRecordStructure({
  record_version: 1,
  object_kind: "control_event",
  control_event_id: missingActionIdentity.id,
  core: missingActionCore,
  authority_attestation_id: missingActionAttestation.attestation_id
});
await missingActionHarness.store.putAttestationRecord(missingActionAttestation);
state = (await missingActionHarness.store.ingestControlEvent(missingActionRecord)).state;
check(classification(state, missingActionIdentity.id).reason === "missing_action", "imported control should quarantine while its action is missing");
await missingActionHarness.store.putControlAction(deferredActionCore);
state = await missingActionHarness.store.reconstructProject(ids.project);
check(classification(state, missingActionIdentity.id).reason === "accepted", "late action should promote imported control after full validation");

// Verifier success must carry exact structural binding, not a generic boolean.
const badAttestationBinding = await createHarness({
  badAttestationBinding: true,
  allowInvalidGenesis: true
});
check(
  classification(
    badAttestationBinding.genesisState,
    badAttestationBinding.genesisRecord.control_event_id
  ).reason === "invalid_attestation",
  "attestation verifier result bound to another project must fail"
);
const badTransitionBinding = await createHarness({
  badTransitionBinding: true,
  allowInvalidGenesis: true
});
check(
  classification(
    badTransitionBinding.genesisState,
    badTransitionBinding.genesisRecord.control_event_id
  ).disposition === "permanently_invalid",
  "generic or mismatched transition success must fail closed"
);
const unavailableAttestation = await createHarness({
  attestationUnavailable: true,
  allowInvalidGenesis: true
});
check(
  classification(
    unavailableAttestation.genesisState,
    unavailableAttestation.genesisRecord.control_event_id
  ).reason === "missing_verification_material",
  "temporarily unavailable public-key verification material should remain retryable"
);
const unavailableTransition = await createHarness({
  transitionUnavailable: true,
  allowInvalidGenesis: true
});
check(
  classification(
    unavailableTransition.genesisState,
    unavailableTransition.genesisRecord.control_event_id
  ).reason === "control_state_unavailable",
  "temporarily unavailable transition state should remain retryable"
);

// Strict insertion APIs require dependencies before immutable commitment.
const strict = await createHarness();
const strictPayloadCore = {
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "metadata_operation",
  data: { operation: "project_title", value: "Strict missing" }
};
const strictPayloadIdentity = await deriveSemanticPayloadIdentity(strictPayloadCore);
const strictCore = parseSemanticEventCoreStructure({
  schema_version: 1,
  object_kind: "semantic_event_core",
  device_chain_position: "first",
  project_id: ids.project,
  semantic_kind: "metadata_operation",
  author_device_id: ids.deviceB,
  device_sequence: 0n,
  previous_device_event_id: null,
  causal_parent_event_ids: [event0.identity.id],
  authorizing_control_head_id: strict.genesisRecord.control_event_id,
  key_epoch_id: ids.keyEpoch,
  semantic_payload_id: strictPayloadIdentity.id,
  complete_known_frontier: true
});
const strictIdentity = await deriveSemanticEventCoreIdentity(strictCore);
const strictAttestation = await makeAttestation({
  projectId: ids.project,
  subjectKind: "semantic_event",
  subjectId: strictIdentity.id,
  signerKeyId: ids.signingKeyB,
  signature: bytes(112),
  acceptedSignatures: strict.acceptedSignatures
});
const strictRecord = parseSemanticEventRecordStructure({
  record_version: 1,
  object_kind: "semantic_event",
  event_id: strictIdentity.id,
  core: strictCore,
  author_attestation_ids: [strictAttestation.attestation_id]
});
await assert.rejects(
  strict.store.putSemanticEvent(strictRecord),
  (error) => error.code === "dependency_missing"
);
check((await strict.store.immutableObjects.getSemanticEvent(strictIdentity.id)).status === "missing", "strict put must not commit before its payload");

// Project isolation excludes unrelated valid objects from classifications and frontiers.
const foreignPayload = await basic.store.putSemanticPayload({
  schema_version: 1,
  project_id: ids.projectB,
  semantic_kind: "metadata_operation",
  data: { operation: "project_title", value: "Foreign" }
});
const foreignCore = parseSemanticEventCoreStructure({
  schema_version: 1,
  object_kind: "semantic_event_core",
  device_chain_position: "first",
  project_id: ids.projectB,
  semantic_kind: "metadata_operation",
  author_device_id: ids.deviceB,
  device_sequence: 0n,
  previous_device_event_id: null,
  causal_parent_event_ids: [event0.identity.id],
  authorizing_control_head_id: basic.genesisRecord.control_event_id,
  key_epoch_id: ids.keyEpoch,
  semantic_payload_id: foreignPayload.id,
  complete_known_frontier: true
});
const foreignIdentity = await deriveSemanticEventCoreIdentity(foreignCore);
const foreignAttestation = await makeAttestation({
  projectId: ids.projectB,
  subjectKind: "semantic_event",
  subjectId: foreignIdentity.id,
  signerKeyId: ids.signingKeyB,
  signature: bytes(113),
  acceptedSignatures: basic.acceptedSignatures
});
await basic.store.putAttestationRecord(foreignAttestation);
await basic.store.ingestSemanticEvent(parseSemanticEventRecordStructure({
  record_version: 1,
  object_kind: "semantic_event",
  event_id: foreignIdentity.id,
  core: foreignCore,
  author_attestation_ids: [foreignAttestation.attestation_id]
}));
state = await basic.store.reconstructProject(ids.project);
check(!state.semantic_classifications.some((entry) => entry.object_id === foreignIdentity.id), "foreign project event must not enter local classification state");
check(!state.accepted_semantic_frontier.includes(foreignIdentity.id), "foreign project event must not affect local frontier");

// Capability and revocation facts are evaluated at the exact referenced control head.
const capabilitySetup = await setupSemanticBase();
const reviewerControl = await makeOrdinaryControl(capabilitySetup.harness, {
  previous: capabilitySetup.harness.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(114),
  authorityFactory(controlEventId) {
    return Object.freeze({
      ...authorityState({
        controlEventId,
        stateRoot: ids.stateRoot1,
        activeDeviceId: ids.deviceA,
        keyEpochId: ids.keyEpoch,
        keyCommitment: ids.keyCommit0
      }),
      device_authorities: Object.freeze([
        authorityFact(ids.deviceA, ids.signingKeyA),
        Object.freeze({
          ...authorityFact(ids.deviceB, ids.signingKeyB),
          role: "reviewer",
          capabilities: Object.freeze([...capabilitiesForRole("reviewer")])
        })
      ])
    });
  }
});
await capabilitySetup.harness.store.putAttestationRecord(reviewerControl.attestation);
await capabilitySetup.harness.store.ingestControlEvent(reviewerControl.record);
const deniedPayload = await putMetadataPayload(capabilitySetup.harness, "Denied metadata");
const deniedEvent = await makeSemanticEvent(capabilitySetup.harness, {
  payload: deniedPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [capabilitySetup.event1.identity.id],
  controlHeadId: reviewerControl.identity.id,
  signature: bytes(115)
});
await capabilitySetup.harness.store.putAttestationRecord(deniedEvent.attestation);
state = (await capabilitySetup.harness.store.ingestSemanticEvent(deniedEvent.record)).state;
check(classification(state, deniedEvent.identity.id).reason === "capability_denied", "reviewer should not gain metadata-edit capability");

const revocationSetup = await setupSemanticBase();
const beforeRevocationPayload = await putMetadataPayload(revocationSetup.harness, "Before revoke");
const beforeRevocation = await makeSemanticEvent(revocationSetup.harness, {
  payload: beforeRevocationPayload,
  deviceId: ids.deviceB,
  sequence: 0n,
  previousEventId: null,
  parents: [revocationSetup.event1.identity.id],
  signature: bytes(116)
});
await revocationSetup.harness.store.putAttestationRecord(beforeRevocation.attestation);
await revocationSetup.harness.store.ingestSemanticEvent(beforeRevocation.record);
const revokedControl = await makeOrdinaryControl(revocationSetup.harness, {
  previous: revocationSetup.harness.genesisRecord,
  sequence: 1n,
  stateRoot: ids.stateRoot1,
  signature: bytes(117),
  authorityFactory(controlEventId) {
    return Object.freeze({
      ...authorityState({
        controlEventId,
        stateRoot: ids.stateRoot1,
        activeDeviceId: ids.deviceA,
        keyEpochId: ids.keyEpoch,
        keyCommitment: ids.keyCommit0
      }),
      device_authorities: Object.freeze([
        authorityFact(ids.deviceA, ids.signingKeyA),
        Object.freeze({
          ...authorityFact(ids.deviceB, ids.signingKeyB),
          status: "revoked",
          maximum_accepted_semantic_sequence: 0n
        })
      ])
    });
  }
});
await revocationSetup.harness.store.putAttestationRecord(revokedControl.attestation);
await revocationSetup.harness.store.ingestControlEvent(revokedControl.record);
const afterRevocationPayload = await putMetadataPayload(revocationSetup.harness, "After revoke");
const afterRevocation = await makeSemanticEvent(revocationSetup.harness, {
  payload: afterRevocationPayload,
  deviceId: ids.deviceB,
  sequence: 1n,
  previousEventId: beforeRevocation.identity.id,
  parents: [beforeRevocation.identity.id],
  controlHeadId: revokedControl.identity.id,
  signature: bytes(118)
});
await revocationSetup.harness.store.putAttestationRecord(afterRevocation.attestation);
state = (await revocationSetup.harness.store.ingestSemanticEvent(afterRevocation.record)).state;
check(classification(state, afterRevocation.identity.id).reason === "revoked_device_sequence", "sequence beyond revocation cutoff must be rejected");

// Event and attestation IDs remain separate: changing only the record attestation cannot change core identity.
const replacementAttestation = await makeAttestation({
  projectId: ids.project,
  subjectKind: "semantic_event",
  subjectId: event0.identity.id,
  signerKeyId: ids.signingKeyA,
  signature: bytes(119),
  acceptedSignatures: basic.acceptedSignatures
});
const unchangedIdentity = await deriveSemanticEventCoreIdentity(event0.core);
check(unchangedIdentity.id === event0.identity.id, "attestation changes must remain outside semantic event identity");
await basic.store.putAttestationRecord(replacementAttestation);
const multipleAttestationState = await basic.store.reconstructProject(ids.project);
const event0Attestations = multipleAttestationState.attestation_index.find(
  (entry) => entry.subject_kind === "semantic_event" && entry.subject_id === event0.identity.id
);
check(event0Attestations.attestation_ids.length === 2, "attestation index should preserve multiple authenticated references without duplicating event");
await assert.rejects(
  basic.store.immutableObjects.ingestSemanticEvent({
    ...event0.record,
    author_attestation_ids: [replacementAttestation.attestation_id]
  }),
  (error) => error.code === "mismatched"
);

await assert.rejects(
  basic.store.immutableObjects.ingestSemanticEvent({
    ...event0.record,
    event_id: event1.identity.id
  }),
  (error) => error.code === "mismatched"
);
basic.backend.failOperation = "read";
await assert.rejects(
  basic.store.immutableObjects.getSemanticEvent(event0.identity.id),
  (error) => error.code === "backend_failed"
);
basic.backend.failOperation = null;
check(
  (await basic.store.immutableObjects.getSemanticEvent(digest("semantic-event", "o"))).status === "missing",
  "ordinary not-found must remain distinct from backend failure"
);

// Category catalogs remain strict and complete.
check(retryableClassificationReasons.length === 10, "retryable categories should remain exhaustive");
check(authorityConflictClassificationReasons.length === 9, "authority categories should remain exhaustive");
check(permanentInvalidClassificationReasons.length === 11, "permanent-invalid categories should remain exhaustive");
check(new Set([
  ...retryableClassificationReasons,
  ...authorityConflictClassificationReasons,
  ...permanentInvalidClassificationReasons
]).size === 30, "classification categories must be disjoint");

console.log(JSON.stringify({
  assertions,
  immutableObjectFamilies: 5,
  retryableCategories: retryableClassificationReasons.length,
  authorityConflictCategories: authorityConflictClassificationReasons.length,
  permanentInvalidCategories: permanentInvalidClassificationReasons.length
}, null, 2));

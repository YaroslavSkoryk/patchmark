import assert from "node:assert/strict";

const originalSetTimeout = globalThis.setTimeout;
const originalLocalStorage = globalThis.localStorage;
const originalIndexedDb = globalThis.indexedDB;
let sideEffectCalls = 0;

globalThis.setTimeout = (...args) => {
  sideEffectCalls += 1;
  return originalSetTimeout(...args);
};
globalThis.localStorage = new Proxy(
  {},
  {
    get() {
      sideEffectCalls += 1;
      return undefined;
    }
  }
);
globalThis.indexedDB = new Proxy(
  {},
  {
    get() {
      sideEffectCalls += 1;
      return undefined;
    }
  }
);

const collaboration = await import("../lib/collaboration/index.ts");

globalThis.setTimeout = originalSetTimeout;
if (originalLocalStorage === undefined) {
  delete globalThis.localStorage;
} else {
  globalThis.localStorage = originalLocalStorage;
}
if (originalIndexedDb === undefined) {
  delete globalThis.indexedDB;
} else {
  globalThis.indexedDB = originalIndexedDb;
}
assert.equal(sideEffectCalls, 0, "Collaboration contract imports must be inert.");

const {
  adaptLegacyIdentity,
  adoptTrustedExistingIdentity,
  assertCheckpointMatchesEvent,
  capabilitiesForRole,
  checkpointIdForEvent,
  classifyExistingIdentity,
  collaborationCapabilities,
  collaborationRoles,
  digestIdKinds,
  entityIdKinds,
  parseAdmissionBoundary,
  parseAcknowledgementRecord,
  parseAttestationRecord,
  parseControlActionRecord,
  parseControlEventCore,
  parseDerivedControlForkRecord,
  parseDeterministicMergeCandidate,
  parseDevicePrivateState,
  parseDigestId,
  parseDocumentRevisionCore,
  parseDocumentRevisionRecord,
  parseEntityId,
  parseIdentityMigrationPlan,
  parseLegacyIdentityAlias,
  parseMergeAuthorization,
  parseMergeKeyCore,
  parseMarkdownBlobDescription,
  parseProjectionSnapshotCore,
  parseProjectionSnapshotRecord,
  parseProtocolEnvelope,
  parseSemanticEventCore,
  parseSemanticEventRecord,
  parseSemanticPayloadCore,
  parseSemanticPayloadRecord,
  roleHasCapability
} = collaboration;

function entity(kind, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a`;
}

function digest(kind, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(50)}${marker}a`;
}

const ids = {
  project: entity("project"),
  otherProject: entity("project", "b"),
  person: entity("person"),
  otherPerson: entity("person", "b"),
  device: entity("device"),
  otherDevice: entity("device", "b"),
  rootKey: entity("public-key"),
  deviceKey: entity("public-key", "b"),
  scope: entity("access-scope"),
  document: entity("document"),
  otherDocument: entity("document", "b"),
  group: entity("group"),
  comment: entity("comment"),
  reply: entity("reply"),
  patch: entity("patch"),
  patchVersion: entity("patch-version"),
  membership: entity("membership"),
  otherMembership: entity("membership", "b"),
  epoch: entity("key-epoch"),
  nextEpoch: entity("key-epoch", "b"),
  mergeKey: digest("merge-key"),
  externalCandidate: entity("external-import-candidate"),
  revisionA: digest("document-revision"),
  revisionB: digest("document-revision", "b"),
  revisionC: digest("document-revision", "c"),
  markdownBlob: digest("markdown-blob"),
  payloadA: digest("semantic-payload"),
  payloadB: digest("semantic-payload", "b"),
  checkpointPayload: digest("semantic-payload", "c"),
  eventA: digest("semantic-event"),
  eventB: digest("semantic-event", "b"),
  checkpointEvent: digest("semantic-event", "c"),
  controlGenesis: digest("control-event"),
  controlOrdinary: digest("control-event", "b"),
  controlOther: digest("control-event", "c"),
  action: digest("control-action"),
  recoveryAction: digest("control-action", "b"),
  attestation: digest("attestation"),
  attestationB: digest("attestation", "b"),
  snapshot: digest("snapshot"),
  acknowledgement: digest("acknowledgement"),
  conflict: digest("derived-conflict"),
  stateRoot: digest("semantic-state-root"),
  revisionHeadsRoot: digest("revision-heads-root"),
  conflictSetRoot: digest("conflict-set-root"),
  frontierRoot: digest("frontier-root"),
  historyRoot: digest("accepted-history-root"),
  projectionRoot: digest("projection-root"),
  controlStateRoot: digest("control-state-root"),
  epochCommitment: digest("key-epoch-commitment"),
  nextEpochCommitment: digest("key-epoch-commitment", "b"),
  stateBlob: digest("state-blob")
};

for (const kind of entityIdKinds) {
  assert.equal(parseEntityId(kind, entity(kind)), entity(kind));
}
for (const kind of digestIdKinds) {
  assert.equal(parseDigestId(kind, digest(kind)), digest(kind));
  const wrongKind = digestIdKinds.find((candidate) => candidate !== kind);
  assert.throws(() => parseDigestId(kind, digest(wrongKind)), /namespace/);
}
assert.throws(() => parseDigestId("document-revision", ids.stateRoot), /namespace/);
assert.throws(() => parseDigestId("document-revision", ids.mergeKey), /namespace/);
assert.throws(() => parseEntityId("merge-key", entity("merge-key")), /unsupported/);
assert.throws(() => parseEntityId("project", "prj_existing"), /canonical/);

const productionUuid = "123e4567-e89b-42d3-a456-426614174000";
const migrationScopeId = `prj_${productionUuid}`;
const preservedProductionIds = [
  ["project", `prj_${productionUuid}`, "project_uuid_v4"],
  ["document", `doc_${productionUuid}`, "document_uuid_v4"],
  ["group", `grp_${productionUuid}`, "group_uuid_v4"],
  ["review-batch", `review_batch_${productionUuid}`, "review_batch_uuid_v4"],
  ["rewrite-session", `rewrite_session_${productionUuid}`, "rewrite_session_uuid_v4"],
  ["rewrite-review", `rewrite_review_${productionUuid}`, "rewrite_review_uuid_v4"]
];
const preservedAdoptions = preservedProductionIds.map(
  ([identityKind, existingId, sourceFormat]) => {
    const classification = classifyExistingIdentity(identityKind, existingId);
    assert.equal(classification.disposition, "preserve_candidate");
    assert.equal(classification.source_format, sourceFormat);
    const adoption = adoptTrustedExistingIdentity({
      schema_version: 1,
      object_kind: "trusted_identity_adoption_input",
      source: "trusted_local_project_migration",
      identity_kind: identityKind,
      existing_id: existingId,
      source_format: sourceFormat,
      collision_verification: {
        requirement: "project_wide_exact_identity_uniqueness",
        status: "verified_unique",
        migration_scope_id: migrationScopeId
      }
    });
    assert.equal(adoption.authoritative_id, existingId);
    return adoption;
  }
);
assert.throws(
  () =>
    adoptTrustedExistingIdentity({
      schema_version: 1,
      object_kind: "trusted_identity_adoption_input",
      source: "trusted_local_project_migration",
      identity_kind: "project",
      existing_id: "prj_arbitrary",
      source_format: "project_uuid_v4",
      collision_verification: {
        requirement: "project_wide_exact_identity_uniqueness",
        status: "verified_unique",
        migration_scope_id: migrationScopeId
      }
    }),
  /does not match/
);
assert.throws(
  () =>
    adoptTrustedExistingIdentity({
      schema_version: 1,
      object_kind: "trusted_identity_adoption_input",
      source: "trusted_local_project_migration",
      identity_kind: "project",
      existing_id: migrationScopeId,
      source_format: "project_uuid_v4",
      collision_verification: {
        requirement: "project_wide_exact_identity_uniqueness",
        status: "pending",
        migration_scope_id: migrationScopeId
      }
    }),
  /status/
);

for (const [kind, oldId, reason] of [
  ["comment", "PM-COMMENT-0001", "document_local_sequence"],
  ["reply", "PM-THREAD-0001", "comment_local_sequence"],
  ["patch", "PM-PATCH-0001", "document_local_sequence"],
  ["patch-group", "PM-PATCH-GROUP-0001", "document_local_sequence"],
  ["import", "PM-IMPORT-20260820-010203-004", "timestamp_derived"],
  ["snapshot", "snapshot-20260820-010203-004", "timestamp_derived"]
]) {
  const classification = classifyExistingIdentity(kind, oldId);
  assert.equal(classification.disposition, "replace_and_alias");
  assert.equal(classification.replacement_reason, reason);
}
assert.equal(
  classifyExistingIdentity("project", "prj_mep9abc-a1b2c3").replacement_reason,
  "timestamp_derived"
);
assert.equal(
  classifyExistingIdentity("rewrite-session", "rewrite_session_mep9abc-a1b2c3")
    .replacement_reason,
  "timestamp_derived"
);
assert.equal(
  classifyExistingIdentity("rewrite-review", "rewrite_review_mep9abc-a1b2c3")
    .replacement_reason,
  "timestamp_derived"
);
assert.equal(
  classifyExistingIdentity("project", "prj_legacy_deadbeef")
    .replacement_reason,
  "collision_prone_derived"
);

const legacyComment = adaptLegacyIdentity({
  identityKind: "comment",
  legacyId: "PM-COMMENT-0001",
  scope: {
    scope_kind: "document",
    project_legacy_id: migrationScopeId,
    document_legacy_id: `doc_${productionUuid}`
  }
});
const legacyReply = adaptLegacyIdentity({
  identityKind: "reply",
  legacyId: "PM-THREAD-0001",
  scope: {
    scope_kind: "comment",
    project_legacy_id: migrationScopeId,
    document_legacy_id: `doc_${productionUuid}`,
    comment_legacy_id: "PM-COMMENT-0001"
  }
});
const legacyGroup = adaptLegacyIdentity({
  identityKind: "group",
  legacyId: "grp_malformed",
  scope: {
    scope_kind: "project",
    project_legacy_id: migrationScopeId
  }
});
assert.equal(parseLegacyIdentityAlias(legacyComment).scope.scope_kind, "document");
assert.equal(parseLegacyIdentityAlias(legacyReply).scope.scope_kind, "comment");
assert.equal(parseLegacyIdentityAlias(legacyGroup).scope.scope_kind, "project");
assert.equal(legacyComment.authority, "none");
assert.notEqual(legacyComment, ids.comment);
assert.throws(() => parseEntityId("comment", legacyComment.legacy_id));
assert.throws(
  () =>
    adaptLegacyIdentity({
      identityKind: "reply",
      legacyId: "PM-THREAD-0001",
      scope: {
        scope_kind: "document",
        project_legacy_id: migrationScopeId,
        document_legacy_id: `doc_${productionUuid}`
      }
    }),
  /requires comment scope/
);

const migrationPlan = parseIdentityMigrationPlan({
  schema_version: 1,
  object_kind: "identity_migration_plan",
  migration_scope_id: migrationScopeId,
  collision_policy: "project_wide_exact_identity_uniqueness_required",
  entries: [
    {
      decision: "replace_and_alias",
      identity_kind: "comment",
      previous_id: legacyComment.legacy_id,
      replacement_reason: "document_local_sequence",
      authoritative_id: ids.comment,
      legacy_alias: legacyComment
    },
    {
      decision: "preserve_exact_authoritative",
      adoption: preservedAdoptions[0]
    }
  ]
});
assert.equal(
  migrationPlan.collision_policy,
  "project_wide_exact_identity_uniqueness_required"
);
assert.equal(
  migrationPlan.entries[1].adoption.collision_verification.requirement,
  "project_wide_exact_identity_uniqueness"
);
assert.throws(
  () =>
    parseIdentityMigrationPlan({
      ...migrationPlan,
      entries: [
        {
          decision: "preserve_exact_authoritative",
          adoption: preservedAdoptions[0]
        },
        {
          decision: "preserve_exact_authoritative",
          adoption: preservedAdoptions[0]
        }
      ]
    }),
  /sorted and unique/
);
assert.throws(
  () =>
    parseIdentityMigrationPlan({
      ...migrationPlan,
      collision_policy: "trust_source_strings"
    }),
  /collision policy/
);

const genesisRevision = {
  schema_version: 1,
  object_kind: "document_revision_core",
  ancestry_kind: "genesis",
  project_id: ids.project,
  document_id: ids.document,
  markdown_blob_id: ids.markdownBlob,
  parent_revision_ids: []
};
assert.equal(parseDocumentRevisionCore(genesisRevision).ancestry_kind, "genesis");
assert.equal(
  parseMarkdownBlobDescription({
    schema_version: 1,
    object_kind: "markdown_blob",
    project_id: ids.project,
    blob_id: ids.markdownBlob,
    encoding: "utf-8-exact",
    bytes: new TextEncoder().encode("# Exact\r\n")
  }).bytes.length,
  9
);
assert.equal(
  parseDocumentRevisionRecord({
    record_version: 1,
    object_kind: "document_revision",
    revision_id: ids.revisionA,
    core: genesisRevision
  }).revision_id,
  ids.revisionA
);

const ordinaryRevision = {
  ...genesisRevision,
  ancestry_kind: "ordinary",
  parent_revision_ids: [ids.revisionA, ids.revisionB]
};
assert.equal(parseDocumentRevisionCore(ordinaryRevision).ancestry_kind, "ordinary");
assert.throws(() =>
  parseDocumentRevisionCore({ ...ordinaryRevision, parent_revision_ids: [] })
);
assert.throws(() =>
  parseDocumentRevisionCore({
    ...ordinaryRevision,
    parent_revision_ids: [ids.revisionB, ids.revisionA]
  })
);
assert.throws(() =>
  parseDocumentRevisionCore({
    ...ordinaryRevision,
    parent_revision_ids: [ids.revisionA, ids.revisionA]
  })
);

const admissionRevision = {
  ...genesisRevision,
  ancestry_kind: "admission_boundary",
  parent_revision_ids: [ids.revisionA],
  sealed_parent_history_root: ids.historyRoot,
  parent_traversal: "unavailable_before_admission",
  prior_plaintext: "not_provided"
};
assert.equal(
  parseDocumentRevisionCore(admissionRevision).parent_traversal,
  "unavailable_before_admission"
);

for (const forbidden of [
  "revision_id",
  "creating_event_id",
  "author_device_id",
  "signature",
  "created_at"
]) {
  assert.throws(
    () => parseDocumentRevisionCore({ ...genesisRevision, [forbidden]: "forbidden" }),
    /unexpected field/
  );
}

const genesisPayloadRecord = parseSemanticPayloadRecord({
  record_version: 1,
  object_kind: "semantic_payload",
  payload_id: ids.payloadA,
  core: {
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "project_genesis",
    data: { genesis_revision_ids: [ids.revisionA] }
  }
});

const genesisEventCore = {
  schema_version: 1,
  object_kind: "semantic_event_core",
  device_chain_position: "first",
  project_id: ids.project,
  semantic_kind: "project_genesis",
  author_device_id: ids.device,
  device_sequence: BigInt(0),
  previous_device_event_id: null,
  causal_parent_event_ids: [],
  authorizing_control_head_id: ids.controlGenesis,
  key_epoch_id: ids.epoch,
  semantic_payload_id: ids.payloadA,
  complete_known_frontier: true,
  display_timestamp: "2026-08-20T00:00:00.000Z"
};
assert.equal(
  parseSemanticEventCore(genesisEventCore, genesisPayloadRecord)
    .device_chain_position,
  "first"
);

const genesisEventRecord = parseSemanticEventRecord(
  {
    record_version: 1,
    object_kind: "semantic_event",
    event_id: ids.eventA,
    core: genesisEventCore,
    author_attestation_ids: [ids.attestation]
  },
  genesisPayloadRecord
);
assert.equal(genesisEventRecord.event_id, ids.eventA);

const adoptionPayloadRecord = parseSemanticPayloadRecord({
  record_version: 1,
  object_kind: "semantic_payload",
  payload_id: ids.payloadB,
  core: {
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "revision_adoption",
    data: { document_id: ids.document, revision_id: ids.revisionB }
  }
});

const ordinaryEventCore = {
  ...genesisEventCore,
  device_chain_position: "subsequent",
  semantic_kind: "revision_adoption",
  device_sequence: BigInt(1),
  previous_device_event_id: ids.eventA,
  causal_parent_event_ids: [ids.eventA],
  semantic_payload_id: ids.payloadB
};
assert.equal(
  parseSemanticEventCore(ordinaryEventCore, adoptionPayloadRecord)
    .previous_device_event_id,
  ids.eventA
);
assert.throws(() =>
  parseSemanticEventCore(
    { ...ordinaryEventCore, semantic_kind: "project_genesis" },
    adoptionPayloadRecord
  )
);
assert.throws(() =>
  parseSemanticEventCore(
    { ...ordinaryEventCore, causal_parent_event_ids: [ids.eventB, ids.eventA] },
    adoptionPayloadRecord
  )
);
assert.throws(() =>
  parseSemanticEventCore(
    { ...ordinaryEventCore, causal_parent_event_ids: [ids.eventA, ids.eventA] },
    adoptionPayloadRecord
  )
);
for (const forbidden of ["event_id", "signature", "attestations", "payload"] ) {
  assert.throws(
    () =>
      parseSemanticEventCore(
        { ...ordinaryEventCore, [forbidden]: "forbidden" },
        adoptionPayloadRecord
      ),
    /unexpected field/
  );
}

const checkpointPayload = parseSemanticPayloadCore({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "consolidation_checkpoint",
  data: {
    base_frontier_event_ids: [ids.eventA, ids.eventB],
    base_frontier_root: ids.frontierRoot,
    accepted_history_root: ids.historyRoot,
    resolution_operations: [],
    result_semantic_state_root: ids.stateRoot,
    result_revision_heads_root: ids.revisionHeadsRoot,
    result_conflict_set_root: ids.conflictSetRoot,
    projection_root: ids.projectionRoot,
    reducer_version: "patchmark-hc-reducer-v1",
    authorizing_control_head_id: ids.controlOrdinary
  }
});
const checkpointEventLike = {
  semantic_kind: "consolidation_checkpoint",
  project_id: ids.project,
  causal_parent_event_ids: [ids.eventA, ids.eventB],
  authorizing_control_head_id: ids.controlOrdinary
};
assert.doesNotThrow(() =>
  assertCheckpointMatchesEvent(checkpointPayload, checkpointEventLike)
);
assert.throws(() =>
  assertCheckpointMatchesEvent(checkpointPayload, {
    ...checkpointEventLike,
    causal_parent_event_ids: [ids.eventA]
  })
);
const selfReferencingCheckpoint = parseSemanticPayloadCore({
  schema_version: 1,
  project_id: ids.project,
  semantic_kind: "consolidation_checkpoint",
  data: {
    ...checkpointPayload.data,
    base_frontier_event_ids: [ids.checkpointEvent]
  }
});
assert.throws(() =>
  assertCheckpointMatchesEvent(
    selfReferencingCheckpoint,
    {
      ...checkpointEventLike,
      causal_parent_event_ids: [ids.checkpointEvent]
    },
    ids.checkpointEvent
  )
);
assert.throws(() =>
  parseSemanticPayloadCore({
    ...checkpointPayload,
    checkpoint_id: ids.checkpointEvent
  })
);
const checkpointId = checkpointIdForEvent(
  ids.checkpointEvent,
  checkpointEventLike,
  checkpointPayload
);
assert.equal(checkpointId, ids.checkpointEvent);
assert.throws(() =>
  checkpointIdForEvent(
    ids.eventA,
    {
      ...checkpointEventLike,
      semantic_kind: "revision_adoption"
    },
    checkpointPayload
  )
);

const boundaryRevision = {
  document_id: ids.document,
  revision_id: ids.revisionB,
  traversal: "boundary_root"
};
const snapshotCore = parseProjectionSnapshotCore(
  {
    schema_version: 1,
    object_kind: "projection_snapshot_core",
    project_id: ids.project,
    checkpoint_id: ids.checkpointEvent,
    reducer_version: "patchmark-hc-reducer-v1",
    state_blob_id: ids.stateBlob,
    semantic_state_root: ids.stateRoot,
    revision_heads_root: ids.revisionHeadsRoot,
    conflict_set_root: ids.conflictSetRoot,
    projection_root: ids.projectionRoot,
    boundary_revisions: [boundaryRevision],
    live_conflict_dependencies: []
  },
  checkpointId
);
assert.equal(snapshotCore.checkpoint_id, ids.checkpointEvent);
assert.equal(
  parseProjectionSnapshotRecord(
    {
      record_version: 1,
      object_kind: "projection_snapshot",
      snapshot_id: ids.snapshot,
      core: snapshotCore,
      producer_attestation_id: ids.attestation
    },
    checkpointId
  ).snapshot_id,
  ids.snapshot
);

const admission = parseAdmissionBoundary(
  {
    schema_version: 1,
    object_kind: "admission_boundary",
    project_id: ids.project,
    admitted_membership_id: ids.otherMembership,
    admitted_person_id: ids.otherPerson,
    admitted_device_id: ids.otherDevice,
    owner_authorized_control_event_id: ids.controlOrdinary,
    checkpoint_id: ids.checkpointEvent,
    snapshot_id: ids.snapshot,
    admission_key_epoch_id: ids.nextEpoch,
    boundary_revisions: [boundaryRevision],
    sealed_prior_history: {
      accepted_history_root: ids.historyRoot,
      parent_traversal: "unavailable_before_admission",
      prior_plaintext: "not_provided",
      verification_basis: "owner_authorized_current_state"
    },
    replica_scope: "complete_current_state"
  },
  { checkpoint_id: checkpointId, snapshot_id: ids.snapshot }
);
assert.equal(admission.replica_scope, "complete_current_state");
assert.equal(
  admission.sealed_prior_history.prior_plaintext,
  "not_provided"
);

const acknowledgement = parseAcknowledgementRecord(
  {
    record_version: 1,
    object_kind: "acknowledgement",
    acknowledgement_id: ids.acknowledgement,
    core: {
      schema_version: 1,
      object_kind: "acknowledgement_core",
      chain_position: "first",
      project_id: ids.project,
      device_id: ids.device,
      acknowledgement_sequence: BigInt(0),
      previous_acknowledgement_id: null,
      observed_control_head_id: ids.controlOrdinary,
      acknowledged_checkpoint_id: ids.checkpointEvent,
      observed_semantic_frontier: [ids.checkpointEvent],
      projection_root: ids.projectionRoot
    },
    attestation_id: ids.attestation
  },
  checkpointId
);
assert.equal(acknowledgement.core.chain_position, "first");

const attestation = parseAttestationRecord({
  record_version: 1,
  object_kind: "attestation",
  attestation_id: ids.attestation,
  core: {
    schema_version: 1,
    object_kind: "attestation_core",
    project_id: ids.project,
    subject_kind: "semantic_event",
    subject_id: ids.eventA,
    signer_key_id: ids.deviceKey,
    algorithm: "ed25519",
    signature_bytes: new Uint8Array([1, 2, 3])
  }
});
assert.equal(attestation.core.subject_id, ids.eventA);

const controlGenesisCore = parseControlEventCore({
  schema_version: 1,
  object_kind: "control_event_core",
  control_kind: "genesis",
  project_id: ids.project,
  control_sequence: BigInt(0),
  previous_control_id: null,
  root_sequence: BigInt(0),
  previous_root_control_id: null,
  owner_person_id: ids.person,
  offline_root_key_id: ids.rootKey,
  initial_active_control_device_id: ids.device,
  initial_memberships: [
    {
      membership_id: ids.membership,
      person_id: ids.person,
      role: "owner",
      access_scope_id: ids.scope,
      status: "active"
    }
  ],
  initial_authorized_devices: [
    {
      device_id: ids.device,
      person_id: ids.person,
      signing_key_id: ids.deviceKey,
      status: "active"
    }
  ],
  initial_key_epoch_id: ids.epoch,
  initial_key_epoch_commitment: ids.epochCommitment,
  resulting_control_state_root: ids.controlStateRoot
});
assert.equal(controlGenesisCore.control_kind, "genesis");
assert.throws(() =>
  parseControlEventCore({
    ...controlGenesisCore,
    initial_active_control_device_id: ids.otherDevice
  })
);

const membershipAction = parseControlActionRecord({
  record_version: 1,
  object_kind: "control_action",
  action_id: ids.action,
  core: {
    schema_version: 1,
    project_id: ids.project,
    action_kind: "membership_grant",
    membership_id: ids.otherMembership,
    person_id: ids.otherPerson,
    role: "reviewer",
    access_scope_id: ids.scope
  }
});

const ordinaryControlCore = {
  schema_version: 1,
  object_kind: "control_event_core",
  control_kind: "ordinary",
  project_id: ids.project,
  control_sequence: BigInt(1),
  previous_control_id: ids.controlGenesis,
  issuer_device_id: ids.device,
  action_id: ids.action,
  resulting_control_state_root: ids.controlStateRoot,
  key_epoch_id: ids.epoch,
  key_epoch_commitment: ids.epochCommitment
};
const ordinaryContext = {
  expected_previous_control_id: ids.controlGenesis,
  expected_control_sequence: BigInt(1),
  designated_active_control_device_id: ids.device,
  expected_project_id: ids.project
};
assert.equal(
  parseControlEventCore(ordinaryControlCore, {
    action: membershipAction,
    ordinary_context: ordinaryContext
  }).control_kind,
  "ordinary"
);
assert.throws(() => parseControlEventCore(ordinaryControlCore), /context/);
assert.throws(() =>
  parseControlEventCore(ordinaryControlCore, {
    action: membershipAction,
    ordinary_context: {
      ...ordinaryContext,
      designated_active_control_device_id: ids.otherDevice
    }
  })
);

const recoveryAction = parseControlActionRecord({
  record_version: 1,
  object_kind: "control_action",
  action_id: ids.recoveryAction,
  core: {
    schema_version: 1,
    project_id: ids.project,
    action_kind: "root_recovery",
    last_uncontested_control_id: ids.controlGenesis,
    selected_membership_device_state_root: ids.controlStateRoot,
    revocation_sequence_cutoffs: [
      {
        device_id: ids.otherDevice,
        maximum_accepted_semantic_sequence: BigInt(7)
      }
    ],
    replacement_active_control_device_id: ids.device,
    replacement_key_epoch_id: ids.nextEpoch,
    replacement_key_epoch_commitment: ids.nextEpochCommitment,
    observed_conflicting_tip_ids: [ids.controlOrdinary, ids.controlOther],
    supersession_policy:
      "supersede_all_ordinary_descendants_outside_recovery_chain"
  }
});
const recoveryCore = parseControlEventCore(
  {
    schema_version: 1,
    object_kind: "control_event_core",
    control_kind: "root_recovery",
    project_id: ids.project,
    control_sequence: BigInt(1),
    previous_control_id: ids.controlGenesis,
    root_sequence: BigInt(1),
    previous_root_control_id: ids.controlGenesis,
    issuer_root_key_id: ids.rootKey,
    action_id: ids.recoveryAction,
    resulting_control_state_root: ids.controlStateRoot,
    key_epoch_id: ids.nextEpoch,
    key_epoch_commitment: ids.nextEpochCommitment
  },
  { action: recoveryAction }
);
assert.equal(recoveryCore.control_kind, "root_recovery");
assert.notEqual(recoveryCore.control_kind, ordinaryControlCore.control_kind);

const controlFork = parseDerivedControlForkRecord({
  schema_version: 1,
  object_kind: "derived_control_fork",
  authority: "none",
  quarantine_state: "control_projection_frozen",
  conflict_id: ids.conflict,
  project_id: ids.project,
  last_uncontested_control_id: ids.controlGenesis,
  conflicting_tip_ids: [ids.controlOrdinary, ids.controlOther]
});
assert.equal(controlFork.authority, "none");

for (const role of collaborationRoles) {
  const capabilities = capabilitiesForRole(role);
  assert.ok(capabilities.length > 0);
  for (const capability of collaborationCapabilities) {
    assert.equal(
      roleHasCapability(role, capability),
      capabilities.includes(capability)
    );
  }
}
assert.equal(roleHasCapability("owner", "recover_control"), true);
assert.equal(roleHasCapability("editor", "adopt_revision"), true);
assert.equal(roleHasCapability("editor", "invite_person"), false);
assert.equal(roleHasCapability("reviewer", "create_comment"), true);
assert.equal(roleHasCapability("reviewer", "adopt_revision"), false);
assert.equal(roleHasCapability("reviewer", "authorize_safe_merge"), false);

const mergeKeyCoreInput = {
  schema_version: 1,
  object_kind: "merge_key_core",
  project_id: ids.project,
  document_id: ids.document,
  parent_revision_ids: [ids.revisionA, ids.revisionB],
  base_revision_id: ids.revisionA,
  result_revision_id: ids.revisionC,
  merge_algorithm_id: "patchmark-merge",
  merge_algorithm_version: "v1"
};
const mergeKeyCore = parseMergeKeyCore(mergeKeyCoreInput);
assert.equal(mergeKeyCore.object_kind, "merge_key_core");
assert.throws(() =>
  parseMergeKeyCore({
    ...mergeKeyCoreInput,
    parent_revision_ids: [ids.revisionB, ids.revisionA]
  })
);
assert.throws(() =>
  parseMergeKeyCore({
    ...mergeKeyCoreInput,
    parent_revision_ids: [ids.revisionA, ids.revisionA]
  })
);
for (const changedIdentityInput of [
  { ...mergeKeyCoreInput, project_id: ids.otherProject },
  { ...mergeKeyCoreInput, document_id: ids.otherDocument },
  {
    ...mergeKeyCoreInput,
    parent_revision_ids: [ids.revisionA, ids.revisionC]
  },
  { ...mergeKeyCoreInput, base_revision_id: ids.revisionB },
  { ...mergeKeyCoreInput, result_revision_id: ids.revisionB },
  { ...mergeKeyCoreInput, merge_algorithm_id: "patchmark-tree-merge" },
  { ...mergeKeyCoreInput, merge_algorithm_version: "v2" }
]) {
  assert.notDeepEqual(parseMergeKeyCore(changedIdentityInput), mergeKeyCore);
}
for (const forbidden of [
  "merge_key_id",
  "author_id",
  "person_id",
  "author_device_id",
  "signature",
  "attestation",
  "timestamp",
  "proposer_device_id",
  "proposer_selection",
  "authorization_mode"
]) {
  assert.throws(
    () => parseMergeKeyCore({ ...mergeKeyCoreInput, [forbidden]: "forbidden" }),
    /unexpected field/
  );
}

const mergeCandidate = parseDeterministicMergeCandidate({
  schema_version: 1,
  object_kind: "deterministic_merge_candidate",
  authority: "none",
  merge_key_id: ids.mergeKey,
  merge_key_core: mergeKeyCoreInput,
  outcome: "proven_safe"
});
assert.equal(mergeCandidate.authority, "none");

const explicitAuthorization = parseMergeAuthorization({
  schema_version: 1,
  object_kind: "merge_authorization",
  authorization_mode: "explicit_editor",
  merge_key_id: ids.mergeKey,
  authorizing_device_id: ids.device,
  authorizing_role: "editor"
});
const policyAuthorization = parseMergeAuthorization({
  schema_version: 1,
  object_kind: "merge_authorization",
  authorization_mode: "policy_authorized_proven_safe",
  merge_key_id: ids.mergeKey,
  eligible_device_id: ids.device,
  eligible_role: "editor",
  policy_control_head_id: ids.controlOrdinary,
  required_outcome: "proven_safe"
});
assert.notEqual(
  explicitAuthorization.authorization_mode,
  policyAuthorization.authorization_mode
);
assert.equal(explicitAuthorization.merge_key_id, policyAuthorization.merge_key_id);
assert.equal(explicitAuthorization.merge_key_id, mergeCandidate.merge_key_id);

const externalCandidate = parseDevicePrivateState({
  schema_version: 1,
  state_scope: "device_private",
  private_kind: "external_markdown_import_candidate",
  project_id: ids.project,
  device_id: ids.device,
  candidate_id: ids.externalCandidate,
  document_id: ids.document,
  filesystem_binding_id: "binding:one",
  base_materialized_revision_id: ids.revisionA,
  external_blob_id: ids.markdownBlob,
  detected_frontier_root: ids.frontierRoot,
  detected_projection_root: ids.projectionRoot,
  detected_control_head_id: ids.controlOrdinary,
  authority: "none",
  detected_at: "2026-08-20T00:00:00.000Z"
});
assert.equal(externalCandidate.state_scope, "device_private");
assert.throws(() => parseSemanticPayloadCore(externalCandidate));

assert.throws(() =>
  parseSemanticPayloadCore({
    schema_version: 2,
    project_id: ids.project,
    semantic_kind: "project_genesis",
    data: { genesis_revision_ids: [ids.revisionA] }
  })
);
assert.throws(() =>
  parseSemanticPayloadCore({
    schema_version: 1,
    project_id: ids.project,
    semantic_kind: "future_authority_kind",
    data: {}
  })
);
assert.throws(() =>
  parseProtocolEnvelope(
    {
      protocol: "patchmark.human-collaboration",
      protocol_version: 2,
      object_kind: "document_revision",
      body: ordinaryRevision
    },
    "document_revision",
    parseDocumentRevisionCore
  )
);
assert.throws(() =>
  parseProtocolEnvelope(
    {
      protocol: "patchmark.human-collaboration",
      protocol_version: 1,
      object_kind: "future_object",
      body: ordinaryRevision
    },
    "document_revision",
    parseDocumentRevisionCore
  )
);

process.stdout.write(
  `${JSON.stringify(
    {
      inertImports: true,
      brandedEntityIds: entityIdKinds.length,
      brandedDigestIds: digestIdKinds.length,
      explicitLegacyAliases: true,
      trustedStableIdentityAdoption: true,
      nonCircularRevisions: true,
      nonCircularSemanticEvents: true,
      checkpointEventIdentity: true,
      snapshotAndAdmissionBoundary: true,
      designatedControlDevice: true,
      rootRecoveryDistinct: true,
      exhaustiveCapabilities: true,
      mergeAuthoritySeparated: true,
      mergeKeyDigestCore: true,
      externalCandidatesPrivate: true,
      unknownVersionsFailClosed: true
    },
    null,
    2
  )}\n`
);

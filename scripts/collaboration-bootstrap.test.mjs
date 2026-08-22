import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_PLAN_SCHEMA_VERSION,
  ConsolidationCollaborationStore,
  abandonIncompleteBootstrapDestination,
  bootstrapCompleteMarkerAddress,
  bootstrapConstructionStages,
  bootstrapJournalAddress,
  deriveAttestationIdentity,
  deriveSourceInventoryCommitment,
  executeCollaborationBootstrap,
  normalizeTrustedLegacyUuidIdentity,
  parseAttestationRecord,
  parseCollaborationBootstrapImportData,
  parseNormalizedDuplicationSourceInventory,
  planCurrentStateAdmission,
  planDuplicateAsCollaborationProject,
  planNativeCollaborationBootstrap,
  readBootstrapDestinationStatus,
  verifyBootstrapProjectionEquivalence,
  verifyCollaborationBootstrapPlan
} from "../lib/collaboration/index.ts";
import {
  fixtureSnapshotsEqual,
  readFixtureMarkdown,
  snapshotFixtureBytes
} from "./collaboration-bootstrap-fixture-adapter.ts";

class DeterministicMemoryBackend {
  records = new Map();
  writes = [];

  async read(address) {
    const value = this.records.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }

  async write(address, bytes, context) {
    const copy = Uint8Array.from(bytes);
    this.records.set(address, copy);
    this.writes.push({ address, bytes: copy, stage: context.stage });
  }

  async delete(address) {
    this.records.delete(address);
  }

  async list(prefix) {
    return [...this.records.keys()].filter((address) => address.startsWith(prefix)).sort();
  }

  corrupt(address) {
    const value = this.records.get(address);
    assert(value, `expected ${address} before corruption`);
    const next = Uint8Array.from(value);
    next[Math.max(0, next.length - 1)] ^= 0xff;
    this.records.set(address, next);
  }
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const legacyFixture = path.join(currentDirectory, "fixtures/projects/core-legacy");
const multiFixture = path.join(currentDirectory, "fixtures/projects/core-multidoc");
const encoder = new TextEncoder();
const privateSentinels = Object.freeze([
  "/Users/private/Patchmark/secret.md",
  "PRIVATE_FILE_HANDLE_SENTINEL",
  "LOCAL_INSTANCE_SENTINEL",
  "BOOKMARK_SENTINEL",
  "ACTIVE_DOCUMENT_SENTINEL",
  "VISUAL_EDITOR_SENTINEL",
  "SELECTION_SCROLL_SENTINEL",
  "REVIEW_DEFER_SENTINEL",
  "https://private.invalid/chat/sentinel",
  "RECOVERY_DRAFT_SENTINEL",
  "EXTERNAL_CANDIDATE_SENTINEL"
]);

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert(condition, message);
};

const ids = Object.freeze({
  nativeProject: entity("project", "a"),
  duplicateProject: entity("project", "b"),
  emptyProject: entity("project", "w"),
  multiProject: entity("project", "x"),
  emptyDocument: entity("document", "y"),
  owner: entity("person", "c"),
  member: entity("membership", "d"),
  scope: entity("access-scope", "e"),
  device: entity("device", "f"),
  signingKey: entity("public-key", "g"),
  rootKey: entity("public-key", "h"),
  epoch: entity("key-epoch", "i"),
  nextEpoch: entity("key-epoch", "j"),
  nativeGroup: entity("group", "k"),
  nativeDocument: entity("document", "l"),
  nativeComment: entity("comment", "m"),
  nativeReply: entity("reply", "n"),
  nativePatch: entity("patch", "o"),
  nativePatchVersion: entity("patch-version", "p"),
  nativeReview: entity("review-batch", "q"),
  nativeRewrite: entity("rewrite-session", "r"),
  admittedMembership: entity("membership", "s"),
  admittedPerson: entity("person", "t"),
  admittedDevice: entity("device", "u"),
  admittedKey: entity("public-key", "v")
});

const nativeInput = Object.freeze({
  schema_version: 1,
  object_kind: "native_collaboration_bootstrap_input",
  protocol_version: 1,
  reducer_version: "patchmark-hc-reducer-v1",
  project_id: ids.nativeProject,
  project_title: "Native collaboration",
  project_metadata: [{ key: "classification", value: "shared" }],
  owner_person_id: ids.owner,
  owner_membership_id: ids.member,
  owner_access_scope_id: ids.scope,
  owner_device_id: ids.device,
  owner_device_signing_key_id: ids.signingKey,
  offline_root_public_key_id: ids.rootKey,
  initial_key_epoch_number: 0n,
  initial_key_epoch_id: ids.epoch,
  initial_key_epoch_public_commitment_bytes: bytes(1, 2, 3, 4),
  initial_merge_policy: "manual",
  group_order: [ids.nativeGroup],
  groups: [{ group_id: ids.nativeGroup, title: "Plan", position: "0001" }],
  document_order: [ids.nativeDocument],
  documents: [{
    document_id: ids.nativeDocument,
    markdown_bytes: encoder.encode("# Native\n\nExact bytes.\n"),
    title: "Native",
    logical_path: "native.md",
    position: "0001",
    group_id: ids.nativeGroup,
    archive_status: "active",
    tombstone: false,
    shared_roles: ["decision"],
    comments: [{
      comment_id: ids.nativeComment,
      body: "Current comment",
      anchor: "document:document",
      status: "resolved",
      tombstone: false,
      imported_provenance: null,
      imported_history: [],
      replies: [{
        reply_id: ids.nativeReply,
        body: "Current reply",
        tombstone: false,
        imported_provenance: null,
        imported_history: []
      }]
    }],
    patches: [{
      patch_id: ids.nativePatch,
      versions: [{
        patch_version_id: ids.nativePatchVersion,
        revision_source: "document_current",
        dependency_patch_version_ids: [],
        decision: "accepted",
        target_provenance: "native-current",
        imported_provenance: null
      }]
    }],
    reference_document_ids: []
  }],
  initial_review_batches: [{
    review_batch_id: ids.nativeReview,
    lifecycle: "responded",
    response_hash: "sha256:fixture-response",
    imported_provenance: null
  }],
  initial_rewrite_sessions: [{
    rewrite_session_id: ids.nativeRewrite,
    document_id: ids.nativeDocument,
    outcome: "applied",
    applies_current_revision: true,
    imported_provenance: null
  }]
});

const noIoTrap = new Proxy({}, {
  get() {
    throw new Error("pure planner attempted an injected I/O capability");
  }
});
void noIoTrap;
const nativePlan = await planNativeCollaborationBootstrap(nativeInput);
const repeatedNativePlan = await planNativeCollaborationBootstrap(nativeInput);
check(nativePlan.plan_commitment === repeatedNativePlan.plan_commitment, "native planning must be deterministic");
check(nativePlan.authority === "none", "dry-run plan must remain authority-free");
check(nativePlan.expected_shared_state.legacy_aliases.length === 0, "native plan must not contain aliases");
check(nativePlan.semantic_event_core.device_sequence === 0n, "bootstrap event sequence must be exactly zero");
await verifyCollaborationBootstrapPlan(nativePlan);
await assert.rejects(
  () => planNativeCollaborationBootstrap({ ...nativeInput, protocol_version: 2 }),
  /protocol version/
);
assertions += 1;

const emptyPlan = await planNativeCollaborationBootstrap({
  ...nativeInput,
  project_id: ids.emptyProject,
  project_title: "Empty native project",
  project_metadata: [],
  group_order: [],
  groups: [],
  document_order: [ids.emptyDocument],
  documents: [{
    ...nativeInput.documents[0],
    document_id: ids.emptyDocument,
    markdown_bytes: new Uint8Array(),
    title: "",
    logical_path: "untitled.md",
    group_id: null,
    shared_roles: [],
    comments: [],
    patches: []
  }],
  initial_review_batches: [],
  initial_rewrite_sessions: []
});
check(emptyPlan.revision_objects.length === 1, "empty new project must use one exact empty-document genesis revision");
const emptyResult = await executeCollaborationBootstrap({
  plan: emptyPlan,
  backend: new DeterministicMemoryBackend(),
  facilities: fixtureFacilities(emptyPlan)
});
check(emptyResult.status === "complete_local_foundation", `empty native project must form a verified local foundation: ${emptyResult.reason ?? emptyResult.status}`);
await assert.rejects(
  () => planNativeCollaborationBootstrap({
    ...nativeInput,
    documents: [{ ...nativeInput.documents[0], markdown_bytes: bytes(0xff) }]
  }),
  /well-formed UTF-8/
);
assertions += 1;

const nativeBackend = new DeterministicMemoryBackend();
const nativeFacilities = fixtureFacilities(nativePlan);
const nativeResult = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: nativeBackend,
  facilities: nativeFacilities
});
check(nativeResult.status === "complete_local_foundation", `native execution must complete its local foundation at ${nativeResult.journal?.current_stage ?? "none"}: ${nativeResult.reason ?? nativeResult.status}`);
check(
  nativeBackend.writes.at(-1).address === bootstrapCompleteMarkerAddress(ids.nativeProject),
  "complete marker must be the final write"
);
const nativeStatus = await readBootstrapDestinationStatus(nativeBackend, ids.nativeProject);
check(nativeStatus.status === "complete_local_foundation", "complete destination status must require a marker");
const nativeRetry = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: nativeBackend,
  facilities: nativeFacilities
});
check(nativeRetry.status === "complete_local_foundation" && nativeRetry.resumed, "identical complete retry must reopen and verify");

const consolidation = new ConsolidationCollaborationStore({ backend: nativeBackend });
const nativeStateBlob = await consolidation.getStateBlob(nativeResult.marker.state_blob_id);
check(nativeStateBlob.status === "valid", "native state blob must reopen");
verifyBootstrapProjectionEquivalence(
  nativeStateBlob.value.core.projection,
  nativePlan.expected_shared_state
);
assert.throws(
  () => verifyBootstrapProjectionEquivalence(
    nativeStateBlob.value.core.projection,
    { ...nativePlan.expected_shared_state, project_title: "wrong" }
  ),
  /does not exactly match/
);
assertions += 1;

const nativeSnapshot = await consolidation.getSnapshot(nativeResult.marker.snapshot_id);
check(nativeSnapshot.status === "valid", "native snapshot must reopen");
const admission = await planCurrentStateAdmission({
  schema_version: 1,
  object_kind: "current_state_admission_plan_input",
  protocol_version: 1,
  project_id: ids.nativeProject,
  owner_control_head_id: nativePlan.expected_control_event_id,
  current_key_epoch_id: ids.epoch,
  checkpoint_id: nativeResult.marker.checkpoint_id,
  state_blob_id: nativeResult.marker.state_blob_id,
  snapshot: nativeSnapshot.value,
  admitted_membership_id: ids.admittedMembership,
  admitted_person_id: ids.admittedPerson,
  admitted_device_id: ids.admittedDevice,
  admitted_device_signing_key_id: ids.admittedKey,
  admitted_role: "reviewer",
  admitted_access_scope_id: ids.scope,
  next_key_epoch_id: ids.nextEpoch,
  next_key_epoch_public_commitment_bytes: bytes(9, 8, 7)
});
check(admission.authority === "none", "admission construction must remain an authority-free draft");
check(admission.limitations.includes("no_invitation"), "admission draft must not invite or deliver keys");

const legacyBefore = await snapshotFixtureBytes(legacyFixture);
const multiBefore = await snapshotFixtureBytes(multiFixture);
const legacyMarkdown = await readFixtureMarkdown(legacyFixture, "document.md");
const sourceInventory = makeLegacyInventory(legacyMarkdown);
const parsedInventory = parseNormalizedDuplicationSourceInventory(sourceInventory);
const sourceCommitment = await deriveSourceInventoryCommitment(parsedInventory);
const privateOnlyChanged = {
  ...sourceInventory,
  private_state: {
    ...sourceInventory.private_state,
    absolute_paths: ["/another/private/path.md"]
  }
};
check(
  await deriveSourceInventoryCommitment(privateOnlyChanged) === sourceCommitment,
  "private values must not enter the shared source commitment"
);

const allocations = destinationAllocations(parsedInventory, ids.duplicateProject);
const duplicateInput = {
  schema_version: 1,
  object_kind: "duplicate_collaboration_bootstrap_input",
  protocol_version: 1,
  reducer_version: "patchmark-hc-reducer-v1",
  destination_project_id: ids.duplicateProject,
  owner_person_id: ids.owner,
  owner_membership_id: ids.member,
  owner_access_scope_id: ids.scope,
  owner_device_id: ids.device,
  owner_device_signing_key_id: ids.signingKey,
  offline_root_public_key_id: ids.rootKey,
  initial_key_epoch_number: 0n,
  initial_key_epoch_id: ids.epoch,
  initial_key_epoch_public_commitment_bytes: bytes(5, 6, 7),
  initial_merge_policy: "auto_safe",
  source_inventory: parsedInventory,
  destination_identity_allocations: allocations,
  collision_snapshot: {
    schema_version: 1,
    object_kind: "destination_collision_snapshot",
    registry_generation: "fixture-registry-1",
    verification_scope: "all_preallocated_destination_identities",
    checked_authoritative_ids: allocations.map((entry) => entry.authoritative_id).sort(),
    occupied_authoritative_ids: [],
    trusted_legacy_ids_verified_unique: []
  }
};
const duplicatePlan = await planDuplicateAsCollaborationProject(duplicateInput);
check(duplicatePlan.source_inventory_commitment === sourceCommitment, "duplicate plan must bind exact source shared bytes");
check(duplicatePlan.excluded_private_fields.length >= 10, "duplicate plan must report populated private exclusions");
check(duplicatePlan.expected_shared_state.legacy_aliases.length >= 6, "legacy identities must survive only as scoped aliases");
check(
  duplicatePlan.identity_mappings.some((entry) => entry.source_id === "PM-COMMENT-1" && entry.disposition === "replace_and_alias"),
  "document-local sequential comments must be replaced"
);
check(
  duplicatePlan.identity_mappings.find((entry) => entry.source_id === "PM-THREAD-1").alias.scope.scope_kind === "comment",
  "reply aliases must remain parent-comment scoped"
);
check(
  duplicatePlan.expected_shared_state.earlier_collaboration_history === "does_not_exist",
  "duplicated authenticated history must begin at the import boundary"
);
check(
  duplicatePlan.expected_shared_state.imported_legacy_versions.length === 1,
  "manual history must remain imported evidence only"
);

const duplicateCanonicalBytes = collectSharedCanonicalBytes(duplicatePlan);
for (const sentinel of privateSentinels) {
  check(!duplicateCanonicalBytes.includes(sentinel), `private sentinel must not enter shared objects: ${sentinel}`);
}
assert.throws(
  () => parseCollaborationBootstrapImportData({
    ...duplicatePlan.expected_shared_state,
    legacy_aliases: [{
      ...duplicatePlan.expected_shared_state.legacy_aliases[0],
      authority: "owner"
    }]
  }, ids.duplicateProject),
  /authority must be "none"/
);
assertions += 1;

const duplicateBackend = new DeterministicMemoryBackend();
const duplicateFacilities = fixtureFacilities(duplicatePlan);
const duplicateResult = await executeCollaborationBootstrap({
  plan: duplicatePlan,
  backend: duplicateBackend,
  facilities: duplicateFacilities,
  current_source_inventory: parsedInventory
});
check(duplicateResult.status === "complete_local_foundation", `legacy fixture duplication must complete at ${duplicateResult.journal?.current_stage ?? "none"}: ${duplicateResult.reason ?? duplicateResult.status}`);
check(
  duplicateResult.marker.semantic_event_id === duplicatePlan.expected_semantic_event_id,
  "duplicate must authenticate one planned current-state boundary"
);
const duplicateConsolidation = new ConsolidationCollaborationStore({ backend: duplicateBackend });
const duplicateState = await duplicateConsolidation.getStateBlob(duplicateResult.marker.state_blob_id);
check(duplicateState.status === "valid", "duplicate state blob must reopen");
check(
  duplicateState.value.core.projection.replayed_event_ids.length === 1,
  "state projection must not contain fabricated historic events"
);
const duplicateSharedBytes = collectSharedCanonicalBytes({
  payload: duplicatePlan.semantic_payload_core,
  state_blob: duplicateState.value
});
for (const sentinel of privateSentinels) {
  check(!duplicateSharedBytes.includes(sentinel), `private sentinel must not enter state blob: ${sentinel}`);
}

const multiInventory = parseNormalizedDuplicationSourceInventory(
  await makeMultiInventory(multiFixture)
);
const multiAllocations = destinationAllocations(multiInventory, ids.multiProject);
const multiInput = {
  ...duplicateInput,
  destination_project_id: ids.multiProject,
  source_inventory: multiInventory,
  destination_identity_allocations: multiAllocations,
  collision_snapshot: {
    ...duplicateInput.collision_snapshot,
    registry_generation: "fixture-registry-multi",
    checked_authoritative_ids: multiAllocations.map((entry) => entry.authoritative_id).sort(),
    occupied_authoritative_ids: []
  }
};
const multiPlan = await planDuplicateAsCollaborationProject(multiInput);
check(multiPlan.expected_shared_state.documents.length === 3, "multi-document fixture must preserve all documents");
check(multiPlan.expected_shared_state.groups.length === 2, "multi-document fixture must preserve groups");
check(
  multiPlan.expected_shared_state.documents.some((entry) => entry.tombstone),
  "multi-document plan must preserve deleted-document current state"
);
check(
  multiPlan.expected_shared_state.documents.some((entry) => entry.archive_status === "archived"),
  "multi-document plan must preserve archived-document current state"
);
const multiResult = await executeCollaborationBootstrap({
  plan: multiPlan,
  backend: new DeterministicMemoryBackend(),
  facilities: fixtureFacilities(multiPlan),
  current_source_inventory: multiInventory
});
check(multiResult.status === "complete_local_foundation", `multi-document duplication must complete: ${multiResult.reason ?? multiResult.status}`);

const duplicateLegacyInventory = parseNormalizedDuplicationSourceInventory({
  ...await makeMultiInventory(multiFixture),
  documents: (await makeMultiInventory(multiFixture)).documents.map((document) => ({
    ...document,
    legacy_id: "doc_duplicate_across_documents"
  }))
});
const duplicateLegacyAllocations = destinationAllocations(
  duplicateLegacyInventory,
  ids.multiProject
);
const duplicateLegacyPlan = await planDuplicateAsCollaborationProject({
  ...multiInput,
  source_inventory: duplicateLegacyInventory,
  destination_identity_allocations: duplicateLegacyAllocations,
  collision_snapshot: {
    ...multiInput.collision_snapshot,
    checked_authoritative_ids: duplicateLegacyAllocations.map((entry) => entry.authoritative_id).sort()
  }
});
check(
  duplicateLegacyPlan.expected_shared_state.identity_migration_plan.entries.filter(
    (entry) => entry.decision === "replace_and_alias" && entry.replacement_reason === "duplicate_in_migration_scope"
  ).length >= 3,
  "duplicate legacy IDs across documents must all be replaced"
);

const changedInventory = parseNormalizedDuplicationSourceInventory({
  ...sourceInventory,
  documents: [{
    ...sourceInventory.documents[0],
    markdown_bytes: encoder.encode("# changed after planning\n")
  }]
});
const sourceChangedBackend = new DeterministicMemoryBackend();
const sourceChanged = await executeCollaborationBootstrap({
  plan: duplicatePlan,
  backend: sourceChangedBackend,
  facilities: fixtureFacilities(duplicatePlan),
  current_source_inventory: changedInventory
});
check(sourceChanged.status === "source_changed", "changed source must reject stale execution");
check(sourceChangedBackend.writes.length === 0, "source-changed rejection must perform zero destination writes");

await assert.rejects(
  () => planDuplicateAsCollaborationProject({
    ...duplicateInput,
    collision_snapshot: {
      ...duplicateInput.collision_snapshot,
      occupied_authoritative_ids: [ids.duplicateProject]
    }
  }),
  /already exists/
);
assertions += 1;
await assert.rejects(
  () => planDuplicateAsCollaborationProject({
    ...duplicateInput,
    source_inventory: {
      ...sourceInventory,
      source_validation: {
        ...sourceInventory.source_validation,
        persistence_generation: "unresolved"
      }
    }
  }),
  /resolved_clean/
);
assertions += 1;
await assert.rejects(
  () => planDuplicateAsCollaborationProject({
    ...duplicateInput,
    source_inventory: {
      ...sourceInventory,
      documents: [{
        ...sourceInventory.documents[0],
        reference_document_source_keys: ["missing-document"]
      }]
    }
  }),
  /missing document/
);
assertions += 1;

const collisionPlanInput = makeTrustedUuidInventoryInput(duplicateInput);
await assert.rejects(
  () => planDuplicateAsCollaborationProject(collisionPlanInput),
  /Trusted legacy UUID adoption requires explicit/
);
assertions += 1;
const trustedLegacyId = collisionPlanInput.source_inventory.source_project.legacy_id;
const trustedPlan = await planDuplicateAsCollaborationProject({
  ...collisionPlanInput,
  collision_snapshot: {
    ...collisionPlanInput.collision_snapshot,
    trusted_legacy_ids_verified_unique: [trustedLegacyId]
  }
});
check(
  trustedPlan.identity_mappings.some((entry) =>
    entry.disposition === "trusted_adopt" &&
    entry.authoritative_id === collisionPlanInput.destination_project_id
  ),
  "valid UUID-v4 legacy identity must be classified as trusted adoption after collision verification"
);
await assert.rejects(
  () => planDuplicateAsCollaborationProject({
    ...collisionPlanInput,
    collision_snapshot: {
      ...collisionPlanInput.collision_snapshot,
      occupied_authoritative_ids: [collisionPlanInput.destination_project_id],
      trusted_legacy_ids_verified_unique: [trustedLegacyId]
    }
  }),
  /already exists in the destination registry/
);
assertions += 1;

for (const stage of bootstrapConstructionStages) {
  const backend = new DeterministicMemoryBackend();
  const facilities = fixtureFacilities(nativePlan);
  let fired = false;
  const failed = await executeCollaborationBootstrap({
    plan: nativePlan,
    backend,
    facilities,
    failure_injector(current) {
      if (!fired && current === stage) {
        fired = true;
        throw new Error(`injected bootstrap failure at ${stage}`);
      }
    }
  });
  check(fired, `failure injection must reach ${stage}`);
  check(failed.status !== "complete_local_foundation", `failure at ${stage} must not report complete`);
  check(!backend.records.has(bootstrapCompleteMarkerAddress(ids.nativeProject)), `failure at ${stage} must not leave a complete marker`);
  if (stage === "append_semantic_bootstrap_event" || stage === "persist_snapshot_and_boundary") {
    const resumed = await executeCollaborationBootstrap({ plan: nativePlan, backend, facilities });
    check(resumed.status === "complete_local_foundation", `retry after ${stage} must resume exact identities: ${resumed.reason ?? resumed.status}`);
  }
}

const takeoverBackend = new DeterministicMemoryBackend();
await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: takeoverBackend,
  facilities: fixtureFacilities(nativePlan),
  failure_injector(stage) {
    if (stage === "establish_isolated_destination") throw new Error("pause for takeover test");
  }
});
const otherPlan = await planNativeCollaborationBootstrap({
  ...nativeInput,
  project_title: "Different frozen plan"
});
const takeover = await executeCollaborationBootstrap({
  plan: otherPlan,
  backend: takeoverBackend,
  facilities: fixtureFacilities(otherPlan)
});
check(takeover.status === "destination_conflict", "different plan must not take over an incomplete destination");

const corruptJournalBackend = new DeterministicMemoryBackend();
await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: corruptJournalBackend,
  facilities: fixtureFacilities(nativePlan),
  failure_injector(stage) {
    if (stage === "persist_markdown_blobs") throw new Error("pause before journal corruption");
  }
});
corruptJournalBackend.corrupt(bootstrapJournalAddress(ids.nativeProject));
const corruptJournal = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: corruptJournalBackend,
  facilities: fixtureFacilities(nativePlan)
});
check(corruptJournal.status === "destination_conflict", "corrupt journal must fail closed");

const corruptObjectBackend = new DeterministicMemoryBackend();
await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: corruptObjectBackend,
  facilities: fixtureFacilities(nativePlan),
  failure_injector(stage) {
    if (stage === "calculate_control_state") throw new Error("pause after immutable content");
  }
});
const immutableDataAddress = [...corruptObjectBackend.records.keys()].find(
  (address) => address.includes("/data/markdown-blob/")
);
assert(immutableDataAddress);
corruptObjectBackend.corrupt(immutableDataAddress);
const corruptObject = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: corruptObjectBackend,
  facilities: fixtureFacilities(nativePlan)
});
check(corruptObject.status !== "complete_local_foundation", "corrupt destination object must fail closed");

for (const slice4Failure of [
  "after_reservation_before_attestation_storage",
  "after_event_commit_before_sequence_index_update"
]) {
  const backend = new DeterministicMemoryBackend();
  const facilities = fixtureFacilities(nativePlan);
  let fired = false;
  const partial = await executeCollaborationBootstrap({
    plan: nativePlan,
    backend,
    facilities,
    semantic_journal_failure_injector(context) {
      if (!fired && context.stage === slice4Failure) {
        fired = true;
        throw new Error(`injected Slice 4 partial event at ${slice4Failure}`);
      }
    }
  });
  check(fired && partial.status === "incomplete", `Slice 4 partial write must interrupt at ${slice4Failure}`);
  const recovered = await executeCollaborationBootstrap({ plan: nativePlan, backend, facilities });
  check(recovered.status === "complete_local_foundation", `Slice 4 journal must recover ${slice4Failure}`);
}

const partialBlobBackend = new DeterministicMemoryBackend();
let partialBlobFired = false;
const partialBlob = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: partialBlobBackend,
  facilities: fixtureFacilities(nativePlan),
  content_store_failure_injector(context) {
    if (!partialBlobFired && context.object_kind === "markdown-blob" && context.stage === "after_verification_before_committed_visibility") {
      partialBlobFired = true;
      throw new Error("injected partial Markdown commit");
    }
  }
});
check(partialBlobFired && partialBlob.status === "incomplete", "partial Markdown object must remain incomplete");
const partialBlobRecovered = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: partialBlobBackend,
  facilities: fixtureFacilities(nativePlan)
});
check(partialBlobRecovered.status === "complete_local_foundation", "partial Markdown object must recover on exact retry");

const abandonedBackend = new DeterministicMemoryBackend();
await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: abandonedBackend,
  facilities: fixtureFacilities(nativePlan),
  failure_injector(stage) {
    if (stage === "persist_baseline_revisions") throw new Error("pause for abandonment");
  }
});
const abandoned = await abandonIncompleteBootstrapDestination(
  abandonedBackend,
  ids.nativeProject,
  nativePlan.plan_commitment
);
check(abandoned.destination_status === "abandoned", "incomplete destination must support local abandonment");
const afterAbandon = await executeCollaborationBootstrap({
  plan: nativePlan,
  backend: abandonedBackend,
  facilities: fixtureFacilities(nativePlan)
});
check(afterAbandon.status === "destination_conflict", "abandoned attempt must not resume silently");

const legacyAfter = await snapshotFixtureBytes(legacyFixture);
const multiAfter = await snapshotFixtureBytes(multiFixture);
check(fixtureSnapshotsEqual(legacyBefore, legacyAfter), "legacy source fixture bytes must remain unchanged");
check(fixtureSnapshotsEqual(multiBefore, multiAfter), "multi-document source fixture bytes must remain unchanged");

console.log(JSON.stringify({
  assertions,
  native_plan_version: BOOTSTRAP_PLAN_SCHEMA_VERSION,
  construction_stages: bootstrapConstructionStages.length,
  private_sentinels: privateSentinels.length,
  source_fixtures_unchanged: true
}, null, 2));

function fixtureFacilities(plan) {
  const accepted = new Map();
  const key = (kind, subjectId, signerKeyId) => `${kind}\n${subjectId}\n${signerKeyId}`;
  const make = async (kind, subjectId, signerKeyId) => {
    const signature = encoder.encode(`fixture:${kind}:${subjectId.slice(-12)}`);
    accepted.set(key(kind, subjectId, signerKeyId), signature);
    const core = {
      schema_version: 1,
      object_kind: "attestation_core",
      project_id: plan.destination_project_id,
      subject_kind: kind,
      subject_id: subjectId,
      signer_key_id: signerKeyId,
      algorithm: "ed25519",
      signature_bytes: signature
    };
    const identity = await deriveAttestationIdentity(core);
    return parseAttestationRecord({
      record_version: 1,
      object_kind: "attestation",
      attestation_id: identity.id,
      core
    });
  };
  return Object.freeze({
    attestation_verifier: {
      async verify(request) {
        const expected = accepted.get(key(request.subject_kind, request.subject_id, request.signer_key_id));
        if (!expected || !sameBytes(expected, request.signature_bytes)) {
          return { outcome: "invalid", reason: "fixture signature is not registered" };
        }
        return { outcome: "verified", binding: request };
      }
    },
    control_transition_verifier: {
      async verify(request) {
        if (
          request.control_kind !== "genesis" ||
          request.control_event_id !== plan.expected_control_event_id ||
          request.resulting_control_state_root !== plan.control_state_root
        ) {
          return { outcome: "invalid", reason: "fixture accepts only the exact planned genesis" };
        }
        return {
          outcome: "verified",
          binding: request,
          resulting_authority: {
            schema_version: 1,
            project_id: plan.destination_project_id,
            control_event_id: plan.expected_control_event_id,
            control_state_root: plan.control_state_root,
            active_control_device_id: plan.owner_device_id,
            offline_root_key_id: plan.control_genesis_core.offline_root_key_id,
            key_epoch_id: plan.initial_key_epoch_id,
            key_epoch_commitment: plan.initial_key_epoch_commitment,
            device_authorities: plan.control_state.device_authorities
          }
        };
      }
    },
    create_control_genesis_attestation(request) {
      return make("control_event", request.control_event_id, request.signer_key_id);
    },
    async create_semantic_attestations(request) {
      return [await make("semantic_event", request.event_id, request.expected_signing_key_id)];
    }
  });
}

function makeLegacyInventory(markdownBytes) {
  return {
    schema_version: 1,
    object_kind: "normalized_duplication_source_inventory",
    source_kind: "legacy_single_document",
    source_schema_name: "patchmark-legacy-project",
    source_schema_version: "1",
    source_project: {
      source_key: "project",
      legacy_id: "prj_fixture_atlas",
      title: "Synthetic Atlas"
    },
    project_metadata: [{ key: "fixture", value: "core-legacy" }],
    group_order: [],
    groups: [],
    document_order: ["document:atlas"],
    documents: [{
      source_key: "document:atlas",
      legacy_id: "doc_fixture_atlas",
      markdown_bytes: Uint8Array.from(markdownBytes),
      title: "Synthetic Atlas",
      logical_path: "document.md",
      position: "0001",
      group_source_key: null,
      archive_status: "archived",
      tombstone: false,
      shared_roles: ["decision"],
      comments: [{
        source_key: "document:atlas/comment:1",
        legacy_id: "PM-COMMENT-1",
        body: "Imported current body",
        anchor: "selected_text:clockwork observatory",
        status: "resolved",
        tombstone: false,
        imported_provenance: "legacy label: Alice",
        imported_history: [
          { field: "body", value: "Earlier body", advisory_order: 0n },
          { field: "body", value: "Imported current body", advisory_order: 1n }
        ],
        replies: [{
          source_key: "document:atlas/comment:1/reply:1",
          legacy_id: "PM-THREAD-1",
          body: "Imported reply",
          tombstone: true,
          imported_provenance: "legacy label: Reviewer",
          imported_history: []
        }]
      }],
      patches: [{
        source_key: "document:atlas/patch:1",
        legacy_id: "PM-PATCH-1",
        versions: [
          {
            source_key: "document:atlas/patch:1/version:1",
            legacy_id: "patch-version-1",
            revision_source: null,
            dependency_source_keys: [],
            decision: "rejected",
            target_provenance: "legacy-selection",
            imported_provenance: "model label only"
          },
          {
            source_key: "document:atlas/patch:1/version:2",
            legacy_id: "patch-version-2",
            revision_source: "document_current",
            dependency_source_keys: ["document:atlas/patch:1/version:1"],
            decision: "accepted",
            target_provenance: "legacy-selection",
            imported_provenance: "model label only"
          }
        ]
      }],
      reference_document_source_keys: []
    }],
    review_batches: [{
      source_key: "document:atlas/review:1",
      legacy_id: "review-1",
      document_source_key: "document:atlas",
      lifecycle: "responded",
      response_hash: "sha256:legacy-review",
      imported_provenance: "legacy review label"
    }],
    rewrite_sessions: [{
      source_key: "document:atlas/rewrite:1",
      legacy_id: "rewrite_session_abc-def",
      document_source_key: "document:atlas",
      outcome: "applied",
      applies_current_revision: true,
      imported_provenance: "human rewrite terminal evidence"
    }],
    manual_versions: [{
      document_source_key: "document:atlas",
      markdown_bytes: encoder.encode("# Imported legacy version\n"),
      advisory_order: 0n,
      imported_provenance: "legacy manifest order only"
    }],
    source_validation: {
      ownership: "verified",
      persistence_generation: "resolved_clean",
      mixed_source_project_identities: false
    },
    private_state: {
      filesystem_handles: [privateSentinels[1]],
      absolute_paths: [privateSentinels[0]],
      locate_repair_paths: ["/Volumes/private/repair.md"],
      active_document: [privateSentinels[4]],
      editor_mode: [privateSentinels[5]],
      selection: [privateSentinels[6]],
      scroll: [privateSentinels[6]],
      focused_comment: ["FOCUSED_COMMENT_SENTINEL"],
      group_collapse_state: ["COLLAPSE_SENTINEL"],
      reading_bookmarks: [privateSentinels[3]],
      review_defer_overrides: [privateSentinels[7]],
      local_project_instance_id: [privateSentinels[2]],
      source_chat_urls: [privateSentinels[8]],
      recovery_drafts: [privateSentinels[9]],
      external_import_candidates: [privateSentinels[10]],
      local_diagnostics: ["DIAGNOSTIC_SENTINEL"],
      materialization_receipts: ["MATERIALIZATION_SENTINEL"],
      browser_persistence_identifiers: ["BROWSER_DB_SENTINEL"]
    }
  };
}

async function makeMultiInventory(root) {
  const [evidence, operations, summary] = await Promise.all([
    readFixtureMarkdown(root, "evidence.md"),
    readFixtureMarkdown(root, "operations.md"),
    readFixtureMarkdown(root, "summary.md")
  ]);
  const document = (source_key, legacy_id, markdown_bytes, title, position, options = {}) => ({
    source_key,
    legacy_id,
    markdown_bytes,
    title,
    logical_path: `${source_key.slice(source_key.indexOf(":") + 1)}.md`,
    position,
    group_source_key: options.group ?? null,
    archive_status: options.archived ? "archived" : "active",
    tombstone: options.deleted ?? false,
    shared_roles: [options.role ?? "reference"],
    comments: [],
    patches: [],
    reference_document_source_keys: options.references ?? []
  });
  return {
    schema_version: 1,
    object_kind: "normalized_duplication_source_inventory",
    source_kind: "multi_document",
    source_schema_name: "patchmark-project",
    source_schema_version: "2",
    source_project: {
      source_key: "project",
      legacy_id: "prj_fixture_constellation",
      title: "Synthetic Constellation"
    },
    project_metadata: [{ key: "fixture", value: "core-multidoc" }],
    group_order: ["group:plan", "group:research"],
    groups: [
      { source_key: "group:plan", legacy_id: "group_plan", title: "Plan", position: "0001" },
      { source_key: "group:research", legacy_id: "group_research", title: "Research", position: "0002" }
    ],
    document_order: ["document:operations", "document:evidence", "document:summary"],
    documents: [
      document("document:evidence", "doc_evidence", evidence, "Constellation Evidence", "0002", {
        group: "group:research",
        archived: true,
        role: "evidence"
      }),
      document("document:operations", "doc_operations", operations, "Orbital Garden Operations", "0001", {
        group: "group:plan",
        role: "decision",
        references: ["document:evidence"]
      }),
      document("document:summary", "doc_summary", summary, "Quiet Orbit Summary", "0003", {
        deleted: true,
        role: "summary"
      })
    ],
    review_batches: [],
    rewrite_sessions: [],
    manual_versions: [],
    source_validation: {
      ownership: "verified",
      persistence_generation: "resolved_clean",
      mixed_source_project_identities: false
    },
    private_state: Object.fromEntries([
      "filesystem_handles",
      "absolute_paths",
      "locate_repair_paths",
      "active_document",
      "editor_mode",
      "selection",
      "scroll",
      "focused_comment",
      "group_collapse_state",
      "reading_bookmarks",
      "review_defer_overrides",
      "local_project_instance_id",
      "source_chat_urls",
      "recovery_drafts",
      "external_import_candidates",
      "local_diagnostics",
      "materialization_receipts",
      "browser_persistence_identifiers"
    ].map((key) => [key, []]))
  };
}

function destinationAllocations(inventory, projectId) {
  const kinds = new Map([["project", "project"]]);
  for (const group of inventory.groups) kinds.set(group.source_key, "group");
  for (const document of inventory.documents) {
    kinds.set(document.source_key, "document");
    for (const comment of document.comments) {
      kinds.set(comment.source_key, "comment");
      for (const reply of comment.replies) kinds.set(reply.source_key, "reply");
    }
    for (const patch of document.patches) {
      kinds.set(patch.source_key, "patch");
      for (const version of patch.versions) kinds.set(version.source_key, "patch-version");
    }
  }
  for (const review of inventory.review_batches) kinds.set(review.source_key, "review-batch");
  for (const rewrite of inventory.rewrite_sessions) kinds.set(rewrite.source_key, "rewrite-session");
  const fills = "bcdefghijklmnopqrstuvwxyz234567";
  let index = 0;
  return [...kinds].map(([source_key, identity_kind]) => ({
    source_key,
    identity_kind,
    authoritative_id: source_key === "project"
      ? projectId
      : entity(identity_kind, fills[index++])
  })).sort((left, right) => left.source_key.localeCompare(right.source_key));
}

function makeTrustedUuidInventoryInput(input) {
  const legacyId = "prj_123e4567-e89b-42d3-a456-426614174000";
  const destinationProjectId = normalizeTrustedLegacyUuidIdentity("project", legacyId);
  return {
    ...input,
    destination_project_id: destinationProjectId,
    source_inventory: {
      ...input.source_inventory,
      source_project: {
        ...input.source_inventory.source_project,
        legacy_id: legacyId
      }
    },
    destination_identity_allocations: input.destination_identity_allocations.map((allocation) =>
      allocation.source_key === "project"
        ? { ...allocation, authoritative_id: destinationProjectId }
        : allocation
    ),
    collision_snapshot: {
      ...input.collision_snapshot,
      checked_authoritative_ids: input.collision_snapshot.checked_authoritative_ids
        .map((id) => id === input.destination_project_id ? destinationProjectId : id)
        .sort(),
      trusted_legacy_ids_verified_unique: []
    }
  };
}

function collectSharedCanonicalBytes(value) {
  return JSON.stringify(value, (_key, child) => {
    if (typeof child === "bigint") return child.toString();
    if (child instanceof Uint8Array) return [...child];
    return child;
  });
}

function entity(kind, fill) {
  return `pm:${kind}:v1:${fill.repeat(25)}a`;
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

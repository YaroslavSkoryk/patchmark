import assert from "node:assert/strict";

import {
  createCollaborationShadowEntrypoint,
  isCollaborationShadowDisabled
} from "../lib/collaboration-shadow/entrypoint.ts";
import { resolveCollaborationShadowFeatureState } from "../lib/collaboration-shadow/feature-state.ts";
import {
  COLLABORATION_SHADOW_NAMESPACE,
  assertProductionCollaborationAddress
} from "../lib/collaboration-shadow/experimental-namespace.ts";
import {
  initializeDevelopmentCollaborationShadow,
  processDevelopmentShadowMutation,
  readDevelopmentShadowRuntimeStatus,
  resetDevelopmentCollaborationShadowForTests
} from "../lib/collaboration-shadow/shadow-implementation.ts";
import {
  deriveAttestationIdentity,
  parseAttestationRecord,
  parseNormalizedDuplicationSourceInventory,
  planDuplicateAsCollaborationProject,
  planNativeCollaborationBootstrap
} from "../lib/collaboration/index.ts";

const encoder = new TextEncoder();
let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert(condition, message);
};

const productionAttempt = resolveCollaborationShadowFeatureState({
  runtime: "production",
  enable_signal: "development_shadow"
});
check(productionAttempt.mode === "disabled", "production must ignore an attempted shadow enable signal");
check(resolveCollaborationShadowFeatureState({ runtime: "development", enable_signal: undefined }).mode === "disabled", "missing signal must disable shadowing");
check(resolveCollaborationShadowFeatureState({ runtime: "development", enable_signal: "unknown" }).mode === "disabled", "unknown signal must disable shadowing");
check(resolveCollaborationShadowFeatureState({
  runtime: "test",
  enable_signal: "development_shadow",
  conflicting_signal: "anything"
}).mode === "disabled", "conflicting configuration must disable shadowing");
check(resolveCollaborationShadowFeatureState({
  runtime: "test",
  enable_signal: "development_shadow"
}).mode === "development_shadow", "test shadowing requires the one explicit signal");

const disabledCounters = Object.fromEntries([
  "directory",
  "indexeddb",
  "storage",
  "webcrypto",
  "random",
  "fetch",
  "socket",
  "worker",
  "timer",
  "dynamic_import",
  "store_open",
  "receipt_factory",
  "materialize",
  "react_update"
].map((key) => [key, 0]));
const disabledEntrypoint = createCollaborationShadowEntrypoint({
  get_feature_state: () => productionAttempt,
  load_heavy_module: async () => {
    disabledCounters.dynamic_import += 1;
    return {
      async processDevelopmentShadowMutation() {
        disabledCounters.store_open += 1;
        throw new Error("disabled heavy module was evaluated");
      }
    };
  }
});
for (let operation = 0; operation < 25; operation += 1) {
  const returned = disabledEntrypoint(() => {
    disabledCounters.receipt_factory += 1;
    disabledCounters.directory += 1;
    disabledCounters.indexeddb += 1;
    disabledCounters.storage += 1;
    disabledCounters.webcrypto += 1;
    disabledCounters.random += 1;
    disabledCounters.fetch += 1;
    disabledCounters.socket += 1;
    disabledCounters.worker += 1;
    disabledCounters.timer += 1;
    disabledCounters.materialize += 1;
    disabledCounters.react_update += 1;
    throw new Error("disabled factory was invoked");
  });
  check(isCollaborationShadowDisabled(returned), "disabled dispatch must return its synchronous immutable sentinel");
  check(!(returned instanceof Promise), "disabled dispatch must not allocate a promise");
}
check(Object.values(disabledCounters).every((count) => count === 0), "disabled mode must leave every collaboration activity counter at zero");
let isolatedFactoryCalls = 0;
const failingEnabledEntrypoint = createCollaborationShadowEntrypoint({
  get_feature_state: () => ({
    mode: "development_shadow",
    reason: "explicit_development_or_test_enable"
  }),
  load_heavy_module: async () => ({
    async processDevelopmentShadowMutation() {
      throw new Error("injected shadow failure");
    }
  })
});
const isolatedFailure = await failingEnabledEntrypoint(() => {
  isolatedFactoryCalls += 1;
  return {};
});
check(isolatedFactoryCalls === 1, "enabled development dispatch may invoke its lazy receipt factory exactly once");
check(isolatedFailure.outcome === "shadow_unavailable", "shadow exceptions must collapse to a development-only diagnostic result");
assert.throws(
  () => assertProductionCollaborationAddress(`${COLLABORATION_SHADOW_NAMESPACE}instances/example/object`),
  /not production-openable/
);
assertions += 1;
check((await processDevelopmentShadowMutation({ unexpected: true })).outcome === "shadow_unavailable", "unknown receipt versions and fields must fail closed inside shadow mode");

class MemoryBackend {
  records = new Map();
  writes = [];

  async read(address) {
    const value = this.records.get(address);
    return value === undefined ? null : Uint8Array.from(value);
  }

  async write(address, bytes, context) {
    const copy = Uint8Array.from(bytes);
    this.records.set(address, copy);
    this.writes.push({ address, bytes: copy, context });
  }

  async delete(address) {
    this.records.delete(address);
  }

  async list(prefix) {
    return [...this.records.keys()].filter((address) => address.startsWith(prefix)).sort();
  }

  corruptFirstObject() {
    const key = this.writes.find((write) => write.context.stage === "object_data")?.address;
    if (!key) throw new Error("expected one shadow object to corrupt");
    const next = Uint8Array.from(this.records.get(key));
    next[0] ^= 0xff;
    this.records.set(key, next);
  }

  corruptAddressContaining(fragment) {
    const key = [...this.records.keys()].find((address) => address.includes(fragment));
    if (!key) throw new Error(`expected an address containing ${fragment}`);
    const next = Uint8Array.from(this.records.get(key));
    next[Math.max(0, next.length - 2)] ^= 0xff;
    this.records.set(key, next);
  }
}

const ids = Object.freeze({
  shadowProject: entity("project", "a"),
  duplicateProject: entity("project", "b"),
  owner: entity("person", "c"),
  membership: entity("membership", "d"),
  scope: entity("access-scope", "e"),
  device: entity("device", "f"),
  signingKey: entity("public-key", "g"),
  rootKey: entity("public-key", "h"),
  epoch: entity("key-epoch", "i"),
  group: entity("group", "j"),
  document: entity("document", "k"),
  duplicateDocument: entity("document", "l")
});

const nativeInput = Object.freeze({
  schema_version: 1,
  object_kind: "native_collaboration_bootstrap_input",
  protocol_version: 1,
  reducer_version: "patchmark-hc-reducer-v1",
  project_id: ids.shadowProject,
  project_title: "Shadow source",
  project_metadata: [],
  owner_person_id: ids.owner,
  owner_membership_id: ids.membership,
  owner_access_scope_id: ids.scope,
  owner_device_id: ids.device,
  owner_device_signing_key_id: ids.signingKey,
  offline_root_public_key_id: ids.rootKey,
  initial_key_epoch_number: 0n,
  initial_key_epoch_id: ids.epoch,
  initial_key_epoch_public_commitment_bytes: Uint8Array.of(1, 2, 3),
  initial_merge_policy: "manual",
  group_order: [ids.group],
  groups: [{ group_id: ids.group, title: "Plan", position: "0001" }],
  document_order: [ids.document],
  documents: [{
    document_id: ids.document,
    markdown_bytes: encoder.encode("# Shadow source\n"),
    title: "Source document",
    logical_path: "document.md",
    position: "0001",
    group_id: ids.group,
    archive_status: "active",
    tombstone: false,
    shared_roles: [],
    comments: [],
    patches: [],
    reference_document_ids: []
  }],
  initial_review_batches: [],
  initial_rewrite_sessions: []
});
const nativePlan = await planNativeCollaborationBootstrap(nativeInput);
const nativeBackend = new MemoryBackend();
const sourceProjectId = "legacy-project";
const sourceDocumentId = "legacy-document";
const sourceGroupId = "legacy-group";
const instanceCommitment = "legacy-project:2026-08-22T00:00:00Z";
let sourceState = legacyState("# Shadow source\n");
let allocatorIndex = 0;
const allocator = Object.freeze({
  capability: "injected_secure_identity_allocator_v1",
  allocate({ identity_kind }) {
    const fills = "mnopqrstuvwxyz234567";
    return entity(identity_kind, fills[allocatorIndex++]);
  }
});
const nativeInitialization = await initializeDevelopmentCollaborationShadow({
  feature_environment: { runtime: "test", enable_signal: "development_shadow" },
  source_project_instance_commitment: instanceCommitment,
  source_project_id: sourceProjectId,
  initial_legacy_shared_state: sourceState,
  source_identity_bindings: [
    { identity_kind: "project", source_identity: sourceProjectId, source_key: "project" },
    { identity_kind: "group", source_identity: sourceGroupId, source_key: ids.group },
    { identity_kind: "document", source_identity: sourceDocumentId, source_key: ids.document }
  ],
  bootstrap: { kind: "native", input: nativeInput },
  backend: nativeBackend,
  facilities: fixtureFacilities(nativePlan),
  identity_allocator: allocator
});
check(nativeInitialization.status === "complete_experimental_foundation", `native shadow initialization must complete: ${nativeInitialization.reason ?? nativeInitialization.status}`);
check(nativeBackend.writes.every((write) => write.address.startsWith(COLLABORATION_SHADOW_NAMESPACE)), "every shadow write must remain below the experimental top-level namespace");
check(nativeBackend.writes.every((write) => !write.address.includes("/.patchmark/")), "shadow writes must never enter source .patchmark storage");
const nativeMetadata = readDevelopmentShadowRuntimeStatus(sourceProjectId).metadata;
check(nativeMetadata.mode === "development_shadow" && nativeMetadata.authority === "none", "shadow metadata must declare development-only non-authority");
check([
  nativeMetadata.exportable,
  nativeMetadata.synchronizable,
  nativeMetadata.production_openable,
  nativeMetadata.invitations_allowed,
  nativeMetadata.export_exchange_allowed,
  nativeMetadata.synchronization_allowed,
  nativeMetadata.materialization_allowed,
  nativeMetadata.production_credentials
].every((capability) => capability === false), "shadow metadata must deny invitation, export, sync, materialization, production open, and credentials");

let generation = 0;
async function mutate(nextState, mutationKind, mutationKey) {
  generation += 1;
  const sourceBytesBefore = serializeFixtureState(nextState);
  const result = await processDevelopmentShadowMutation(receipt({
    nextState,
    mutationKind,
    mutationKey,
    generation
  }));
  check(
    serializeFixtureState(nextState) === sourceBytesBefore,
    `shadow processing must not mutate source fixture bytes for ${mutationKey}`
  );
  if (result.outcome === "equivalent") sourceState = nextState;
  return result;
}

let next = withDocumentContent(sourceState, (content) => ({
  ...content,
  exact_markdown_bytes: encoder.encode("# Shadow source\n\nSaved.\n")
}));
check((await mutate(next, "document_save", "explicit_save")).outcome === "equivalent", "Markdown save must produce an equivalent shadow revision");

next = {
  ...sourceState,
  project_title: "Renamed shadow source",
  groups: [{ ...sourceState.groups[0], title: "Renamed plan" }],
  documents: [{
    ...sourceState.documents[0],
    title: "Renamed source document",
    logical_path: "renamed.md",
    archive_status: "archived"
  }]
};
check((await mutate(next, "shared_metadata_mutation", "document_metadata:legacy-document")).outcome === "equivalent", "project, document, group, path, and archive metadata must mirror at commit-last boundaries");

next = {
  ...sourceState,
  documents: [{ ...sourceState.documents[0], archive_status: "active" }]
};
check((await mutate(next, "shared_metadata_mutation", "document_restore:legacy-document")).outcome === "equivalent", "document restore must remain a diagnostic-only shadow transition");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: [{
    source_comment_id: "comment-1",
    body: "Review this.",
    anchor: { kind: "document", key: "document" },
    status: "open",
    trash_status: "active",
    tombstone: false,
    replies: []
  }]
}));
check((await mutate(next, "comment_mutation", "update_comment_state")).outcome === "equivalent", "new legacy comment must receive an exact injected shadow identity");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: [{
    ...content.comments[0],
    body: "Reviewed and resolved.",
    anchor: { kind: "section", key: "Plan" },
    status: "resolved",
    replies: [{ source_reply_id: "reply-1", body: "Done.", tombstone: false }]
  }]
}));
check((await mutate(next, "comment_mutation", "human_reanchor:comment-1")).outcome === "equivalent", "comment edit, resolve, reanchor, and reply create must remain equivalent");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: [{ ...content.comments[0], trash_status: "trashed" }]
}));
check((await mutate(next, "comment_mutation", "trash_comment:comment-1")).outcome === "equivalent", "comment trash must remain reversible and distinct from permanent deletion");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: [{ ...content.comments[0], trash_status: "active" }]
}));
check((await mutate(next, "comment_mutation", "restore_comment:comment-1")).outcome === "equivalent", "comment restore must reactivate the same shadow identity");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: [{
    ...content.comments[0],
    status: "open",
    replies: [{ ...content.comments[0].replies[0], body: "Done and verified." }]
  }]
}));
check((await mutate(next, "comment_mutation", "update_comment_state")).outcome === "equivalent", "comment reopen and reply edit must update the existing shadow identities");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  patches: [{
    source_patch_id: "patch-1",
    source_comment_id: "comment-1",
    version_fingerprint: "patch-v1",
    dependency_source_patch_ids: [],
    target_provenance: "fixture-target",
    status: "pending"
  }]
}));
check((await mutate(next, "patch_import", "import_chatgpt_response")).outcome === "equivalent", "patch import must append a mapped proposal without source mutation");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  patches: [{
    ...content.patches[0],
    version_fingerprint: "patch-v2",
    target_provenance: "fixture-target-edited"
  }]
}));
check((await mutate(next, "patch_edit", "update_patch_anchor:patch-1")).outcome === "equivalent", "patch edit must create a new mapped version before a final decision");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  exact_markdown_bytes: encoder.encode("# Shadow source\n\nAccepted.\n"),
  patches: [{ ...content.patches[0], status: "accepted" }]
}));
check((await mutate(next, "patch_decision", "accept_patch:patch-1")).outcome === "equivalent", "accepted patch must bind its exact Markdown revision");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  patches: [...content.patches, {
    source_patch_id: "patch-2",
    source_comment_id: "comment-1",
    version_fingerprint: "patch-2-v1",
    dependency_source_patch_ids: ["patch-1"],
    target_provenance: "fixture-dependent-target",
    status: "pending"
  }]
}));
check((await mutate(next, "patch_import", "import_chatgpt_response")).outcome === "equivalent", "dependent patch import must resolve the exact prior shadow patch version");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  patches: content.patches.map((patch) =>
    patch.source_patch_id === "patch-2" ? { ...patch, status: "rejected" } : patch
  )
}));
check((await mutate(next, "patch_decision", "reject_patch:patch-2")).outcome === "equivalent", "rejected patch must record an exact terminal decision without changing Markdown");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  review_batches: [{
    source_review_batch_id: "review-1",
    lifecycle: "active",
    response_hash: null
  }]
}));
check((await mutate(next, "review_batch_mutation", "create_review_batch:review-1")).outcome === "equivalent", "review creation must shadow after commit");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  review_batches: [{
    ...content.review_batches[0],
    lifecycle: "responded",
    response_hash: "a".repeat(64)
  }]
}));
check((await mutate(next, "review_batch_mutation", "record_review_batch_response:review-1")).outcome === "equivalent", "review response must shadow exact response hash");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  review_batches: [...content.review_batches, {
    source_review_batch_id: "review-2",
    lifecycle: "active",
    response_hash: null
  }]
}));
check((await mutate(next, "review_batch_mutation", "create_review_batch:review-2")).outcome === "equivalent", "a second review lifecycle must start with its own mapped identity");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  review_batches: content.review_batches.map((batch) =>
    batch.source_review_batch_id === "review-2" ? { ...batch, lifecycle: "cancelled" } : batch
  )
}));
check((await mutate(next, "review_batch_mutation", "cancel_review_batch:review-2")).outcome === "equivalent", "review cancellation must remain a diagnostic shadow lifecycle transition");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  rewrite_sessions: [{ source_rewrite_session_id: "rewrite-1", outcome: "active" }]
}));
check((await mutate(next, "rewrite_terminal", "human_rewrite:rewrite-1")).outcome === "equivalent", "rewrite creation must map before its terminal operation");
next = withDocumentContent(sourceState, (content) => ({
  ...content,
  exact_markdown_bytes: encoder.encode("# Shadow source\n\nHuman rewrite.\n"),
  rewrite_sessions: [{ source_rewrite_session_id: "rewrite-1", outcome: "applied" }]
}));
check((await mutate(next, "rewrite_terminal", "human_rewrite:rewrite-1")).outcome === "equivalent", "Human Rewrite apply must adopt exact changed Markdown");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  rewrite_sessions: [...content.rewrite_sessions, {
    source_rewrite_session_id: "rewrite-2",
    outcome: "active"
  }]
}));
check((await mutate(next, "rewrite_terminal", "human_rewrite:rewrite-2")).outcome === "equivalent", "a second Human Rewrite session must receive an isolated shadow identity");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  rewrite_sessions: content.rewrite_sessions.map((rewrite) =>
    rewrite.source_rewrite_session_id === "rewrite-2" ? { ...rewrite, outcome: "discarded" } : rewrite
  )
}));
check((await mutate(next, "rewrite_terminal", "discard_human_rewrite:rewrite-2")).outcome === "equivalent", "discarded Human Rewrite must close without adopting Markdown");

next = withDocumentContent(sourceState, (content) => ({
  ...content,
  comments: []
}));
check((await mutate(next, "comment_mutation", "delete_comment_permanently:comment-1")).outcome === "equivalent", "permanent comment deletion must create an irreversible tombstone only after durable source removal");

const equivalentMetadata = readDevelopmentShadowRuntimeStatus(sourceProjectId).metadata;
check(equivalentMetadata.latest_roots !== null && Object.values(equivalentMetadata.latest_roots).every((root) => typeof root === "string" && root.length > 0), "every equivalent mutation sequence must finish with persisted semantic, revision-head, and conflict roots");
check(equivalentMetadata.identity_mappings.some((mapping) =>
  mapping.identity_kind === "comment" &&
  mapping.source_identity === "comment-1" &&
  mapping.origin === "development_allocated" &&
  mapping.authority === "none"
), "new legacy entities must retain scoped authority-free development mappings");

const staleReceipt = receipt({
  nextState: sourceState,
  mutationKind: "document_save",
  mutationKey: "explicit_save",
  generation
});
const staleSourceBytes = serializeFixtureState(sourceState);
check((await processDevelopmentShadowMutation(staleReceipt)).outcome === "source_changed_before_shadow", "non-advancing source lineage must fail closed");
check(serializeFixtureState(sourceState) === staleSourceBytes, "source lineage failure must leave normalized source bytes unchanged");
check(readDevelopmentShadowRuntimeStatus(sourceProjectId).metadata.bootstrap_status === "requires_rebootstrap", "a divergence must require explicit rebootstrap");
check((await processDevelopmentShadowMutation(receipt({
  nextState: sourceState,
  mutationKind: "document_save",
  mutationKey: "explicit_save",
  generation: generation + 1
}))).outcome === "shadow_unavailable", "later receipts must not continue after divergence");

await resetDevelopmentCollaborationShadowForTests();
const duplicate = makeDuplicateFixture();
const duplicatePlan = await planDuplicateAsCollaborationProject(duplicate.input);
const duplicateBackend = new MemoryBackend();
const initializeDuplicateShadow = (backend, identityAllocator = allocator) =>
  initializeDevelopmentCollaborationShadow({
    feature_environment: { runtime: "test", enable_signal: "development_shadow" },
    source_project_instance_commitment: "legacy-duplicate:fixture",
    source_project_id: "legacy-duplicate",
    initial_legacy_shared_state: duplicate.sourceState,
    source_identity_bindings: [],
    bootstrap: {
      kind: "duplicate",
      input: duplicate.input,
      current_source_inventory: duplicate.inventory
    },
    backend,
    facilities: fixtureFacilities(duplicatePlan),
    identity_allocator: identityAllocator
  });
const duplicateInitialization = await initializeDuplicateShadow(duplicateBackend);
check(duplicateInitialization.status === "complete_experimental_foundation", `duplicated source foundation must initialize explicitly: ${duplicateInitialization.reason ?? duplicateInitialization.status}`);

const unavailable = await processDevelopmentShadowMutation({
  ...receipt({ nextState: duplicate.sourceState, mutationKind: "document_save", mutationKey: "explicit_save", generation: 1 }),
  source_project_id: "not-initialized"
});
check(unavailable.outcome === "shadow_unavailable", "an enabled hook without explicit initialization must remain unavailable");

const duplicateSourceBytes = serializeFixtureState(duplicate.sourceState);
duplicateBackend.corruptFirstObject();
const corruptResult = await processDevelopmentShadowMutation({
  schema_version: 1,
  object_kind: "collaboration_shadow_mutation_receipt",
  source_project_instance_commitment: "legacy-duplicate:fixture",
  source_project_id: "legacy-duplicate",
  source_document_id: "legacy-duplicate-document",
  mutation_kind: "document_save",
  mutation_key: "explicit_save",
  legacy_commit: {
    commit_kind: "project_save",
    status: "committed",
    generation: 1,
    commit_id: "duplicate-commit-1",
    changed_files: ["document"],
    source_state_commitment: "duplicate-source-state-1"
  },
  committed_shared_state: duplicate.sourceState
});
check(corruptResult.outcome === "shadow_corrupt", `a corrupt immutable shadow object must fail closed and require rebootstrap: ${corruptResult.outcome} (${corruptResult.diagnostic})`);
check(serializeFixtureState(duplicate.sourceState) === duplicateSourceBytes, "corrupt shadow evidence must not alter normalized source bytes");

await resetDevelopmentCollaborationShadowForTests("legacy-duplicate");
const missingMappingBackend = new MemoryBackend();
check((await initializeDuplicateShadow(missingMappingBackend, {
  capability: "injected_secure_identity_allocator_v1",
  allocate() {
    return entity("comment", "x");
  }
})).status === "complete_experimental_foundation", "missing-mapping fixture must begin from a complete duplicated foundation");
const missingMappingState = withDuplicateDocumentContent(duplicate.sourceState, (content) => ({
  ...content,
  comments: ["missing-map-comment-a", "missing-map-comment-b"].map((sourceCommentId) => ({
    source_comment_id: sourceCommentId,
    body: "Allocator collision must fail closed.",
    anchor: { kind: "document", key: "document" },
    status: "open",
    trash_status: "active",
    tombstone: false,
    replies: []
  }))
}));
const missingMappingBytes = serializeFixtureState(missingMappingState);
check((await processDevelopmentShadowMutation(duplicateReceipt({
  nextState: missingMappingState,
  mutationKind: "comment_mutation",
  mutationKey: "update_comment_state",
  generation: 1
}))).outcome === "missing_mapping", "occupied injected identities must report missing_mapping and require explicit rebootstrap");
check(serializeFixtureState(missingMappingState) === missingMappingBytes, "missing identity mapping failure must leave source bytes unchanged");

await resetDevelopmentCollaborationShadowForTests("legacy-duplicate");
const missingDependencyBackend = new MemoryBackend();
check((await initializeDuplicateShadow(missingDependencyBackend)).status === "complete_experimental_foundation", "missing-dependency fixture must begin from a complete duplicated foundation");
const missingDependencyState = withDuplicateDocumentContent(duplicate.sourceState, (content) => ({
  ...content,
  patches: [{
    source_patch_id: "dependent-patch",
    source_comment_id: null,
    version_fingerprint: "dependent-patch-v1",
    dependency_source_patch_ids: ["absent-parent-patch"],
    target_provenance: "fixture-missing-parent",
    status: "pending"
  }]
}));
const missingDependencyBytes = serializeFixtureState(missingDependencyState);
check((await processDevelopmentShadowMutation(duplicateReceipt({
  nextState: missingDependencyState,
  mutationKind: "patch_import",
  mutationKey: "import_chatgpt_response",
  generation: 1
}))).outcome === "shadow_dependency_missing", "an unmapped patch dependency must fail closed without source repair");
check(serializeFixtureState(missingDependencyState) === missingDependencyBytes, "missing dependency failure must leave source bytes unchanged");

console.log(JSON.stringify({
  assertions,
  disabled_activity_counters: disabledCounters,
  enabled_mutation_boundaries: 22,
  namespace: COLLABORATION_SHADOW_NAMESPACE,
  native_foundation: nativeInitialization.status,
  duplicate_foundation: duplicateInitialization.status,
  production_lockout: productionAttempt.mode
}, null, 2));

function legacyState(markdown) {
  return {
    project_title: "Shadow source",
    group_order: [sourceGroupId],
    groups: [{ source_group_id: sourceGroupId, title: "Plan", position: "0001" }],
    document_order: [sourceDocumentId],
    documents: [{
      source_document_id: sourceDocumentId,
      title: "Source document",
      logical_path: "document.md",
      position: "0001",
      source_group_id: sourceGroupId,
      archive_status: "active",
      tombstone: false,
      content: {
        exact_markdown_bytes: encoder.encode(markdown),
        comments: [],
        patches: [],
        review_batches: [],
        rewrite_sessions: []
      }
    }]
  };
}

function withDocumentContent(state, update) {
  const document = state.documents[0];
  return {
    ...state,
    documents: [{ ...document, content: update(document.content) }]
  };
}

function withDuplicateDocumentContent(state, update) {
  const document = state.documents[0];
  return {
    ...state,
    documents: [{ ...document, content: update(document.content) }]
  };
}

function receipt({ nextState, mutationKind, mutationKey, generation }) {
  return {
    schema_version: 1,
    object_kind: "collaboration_shadow_mutation_receipt",
    source_project_instance_commitment: instanceCommitment,
    source_project_id: sourceProjectId,
    source_document_id: sourceDocumentId,
    mutation_kind: mutationKind,
    mutation_key: mutationKey,
    legacy_commit: {
      commit_kind: "project_save",
      status: "committed",
      generation,
      commit_id: `commit-${generation}`,
      changed_files: ["document"],
      source_state_commitment: `source-state-${generation}`
    },
    committed_shared_state: nextState
  };
}

function duplicateReceipt({ nextState, mutationKind, mutationKey, generation }) {
  return {
    schema_version: 1,
    object_kind: "collaboration_shadow_mutation_receipt",
    source_project_instance_commitment: "legacy-duplicate:fixture",
    source_project_id: "legacy-duplicate",
    source_document_id: "legacy-duplicate-document",
    mutation_kind: mutationKind,
    mutation_key: mutationKey,
    legacy_commit: {
      commit_kind: "project_save",
      status: "committed",
      generation,
      commit_id: `duplicate-commit-${generation}`,
      changed_files: ["document"],
      source_state_commitment: `duplicate-source-state-${generation}`
    },
    committed_shared_state: nextState
  };
}

function fixtureFacilities(plan) {
  const accepted = new Map();
  const key = (kind, subjectId, signerKeyId) => `${kind}\n${subjectId}\n${signerKeyId}`;
  const make = async (kind, subjectId, signerKeyId) => {
    const signature = encoder.encode(`shadow-fixture:${kind}:${subjectId.slice(-12)}`);
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
  return {
    attestation_verifier: {
      async verify(request) {
        const expected = accepted.get(key(request.subject_kind, request.subject_id, request.signer_key_id));
        return expected && sameBytes(expected, request.signature_bytes)
          ? { outcome: "verified", binding: request }
          : { outcome: "invalid", reason: "unregistered test attestation" };
      }
    },
    control_transition_verifier: {
      async verify(request) {
        if (request.control_kind !== "genesis" || request.control_event_id !== plan.expected_control_event_id) {
          return { outcome: "invalid", reason: "fixture accepts exact genesis only" };
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
  };
}

function makeDuplicateFixture() {
  const markdown = encoder.encode("# Duplicated source\n");
  const privateKeys = [
    "filesystem_handles", "absolute_paths", "locate_repair_paths", "active_document",
    "editor_mode", "selection", "scroll", "focused_comment", "group_collapse_state",
    "reading_bookmarks", "review_defer_overrides", "local_project_instance_id",
    "source_chat_urls", "recovery_drafts", "external_import_candidates",
    "local_diagnostics", "materialization_receipts", "browser_persistence_identifiers"
  ];
  const inventory = parseNormalizedDuplicationSourceInventory({
    schema_version: 1,
    object_kind: "normalized_duplication_source_inventory",
    source_kind: "legacy_single_document",
    source_schema_name: "patchmark-legacy-project",
    source_schema_version: "1",
    source_project: { source_key: "project", legacy_id: "legacy-duplicate", title: "Duplicated source" },
    project_metadata: [],
    group_order: [],
    groups: [],
    document_order: ["document"],
    documents: [{
      source_key: "document",
      legacy_id: "legacy-duplicate-document",
      markdown_bytes: markdown,
      title: "Duplicated source",
      logical_path: "document.md",
      position: "0001",
      group_source_key: null,
      archive_status: "active",
      tombstone: false,
      shared_roles: [],
      comments: [],
      patches: [],
      reference_document_source_keys: []
    }],
    review_batches: [],
    rewrite_sessions: [],
    manual_versions: [],
    source_validation: {
      ownership: "verified",
      persistence_generation: "resolved_clean",
      mixed_source_project_identities: false
    },
    private_state: Object.fromEntries(privateKeys.map((key) => [key, []]))
  });
  const allocations = [
    { source_key: "document", identity_kind: "document", authoritative_id: ids.duplicateDocument },
    { source_key: "project", identity_kind: "project", authoritative_id: ids.duplicateProject }
  ];
  const input = {
    schema_version: 1,
    object_kind: "duplicate_collaboration_bootstrap_input",
    protocol_version: 1,
    reducer_version: "patchmark-hc-reducer-v1",
    destination_project_id: ids.duplicateProject,
    owner_person_id: ids.owner,
    owner_membership_id: ids.membership,
    owner_access_scope_id: ids.scope,
    owner_device_id: ids.device,
    owner_device_signing_key_id: ids.signingKey,
    offline_root_public_key_id: ids.rootKey,
    initial_key_epoch_number: 0n,
    initial_key_epoch_id: ids.epoch,
    initial_key_epoch_public_commitment_bytes: Uint8Array.of(4, 5, 6),
    initial_merge_policy: "manual",
    source_inventory: inventory,
    destination_identity_allocations: allocations,
    collision_snapshot: {
      schema_version: 1,
      object_kind: "destination_collision_snapshot",
      registry_generation: "shadow-test",
      verification_scope: "all_preallocated_destination_identities",
      checked_authoritative_ids: allocations.map((entry) => entry.authoritative_id).sort(),
      occupied_authoritative_ids: [],
      trusted_legacy_ids_verified_unique: []
    }
  };
  return {
    inventory,
    input,
    sourceState: {
      project_title: "Duplicated source",
      group_order: [],
      groups: [],
      document_order: ["legacy-duplicate-document"],
      documents: [{
        source_document_id: "legacy-duplicate-document",
        title: "Duplicated source",
        logical_path: "document.md",
        position: "0001",
        source_group_id: null,
        archive_status: "active",
        tombstone: false,
        content: {
          exact_markdown_bytes: markdown,
          comments: [], patches: [], review_batches: [], rewrite_sessions: []
        }
      }]
    }
  };
}

function entity(kind, fill) {
  return `pm:${kind}:v1:${fill.repeat(25)}a`;
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function serializeFixtureState(value) {
  return JSON.stringify(value, (_key, child) =>
    child instanceof Uint8Array ? [...child] : child
  );
}

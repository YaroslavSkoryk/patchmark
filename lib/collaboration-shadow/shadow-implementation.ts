import type {
  CollaborationShadowMutationReceipt,
  CollaborationShadowResult,
  ShadowEquivalenceOutcome,
  ShadowLegacyComment,
  ShadowLegacyDocument,
  ShadowLegacyDocumentContent,
  ShadowLegacyPatch,
  ShadowLegacySharedState
} from "./contracts.ts";
import { COLLABORATION_SHADOW_NAMESPACE_VERSION } from "./contracts.ts";
import { resolveCollaborationShadowFeatureState, type CollaborationShadowFeatureEnvironment } from "./feature-state.ts";
import { ExperimentalShadowBackend } from "./experimental-namespace.ts";
import { parseCollaborationShadowMutationReceipt, parseLegacySharedState } from "./receipt-parser.ts";
import {
  executeCollaborationBootstrap,
  type BootstrapExecutionFacilities,
  type BootstrapCompleteMarker
} from "../collaboration/bootstrap-executor.ts";
import {
  planDuplicateAsCollaborationProject,
  planNativeCollaborationBootstrap,
  type CollaborationBootstrapPlan,
  type DestinationIdentityKind,
  type DuplicateCollaborationBootstrapInput,
  type NativeCollaborationBootstrapInput,
  type NormalizedDuplicationSourceInventory
} from "../collaboration/bootstrap-planner.ts";
import type { CollaborationByteStorageBackend } from "../collaboration/storage.ts";
import { EventControlStore } from "../collaboration/event-control-store.ts";
import type { EventControlProjectState } from "../collaboration/event-control-types.ts";
import { ImmutableCollaborationStore } from "../collaboration/immutable-store.ts";
import { parseSemanticPayloadCore } from "../collaboration/semantic.ts";
import { projectCollaborationHistory } from "../collaboration/projector.ts";
import {
  deriveReviewResponseEvidence,
  parseReviewResponseImportId
} from "../collaboration/review-response-evidence.ts";
import type {
  CollaborationProjection,
  CollaborationProjectorInput,
  ProjectedValueRegister
} from "../collaboration/projection-types.ts";
import {
  deriveConflictSetRoot,
  deriveRevisionHeadsRoot,
  deriveSemanticStateRoot
} from "../collaboration/projection-roots.ts";
import {
  parseEntityId,
  type CommentId,
  type DocumentId,
  type DocumentRevisionId,
  type PatchId,
  type PatchVersionId,
  type ProjectId,
  type ReviewBatchId,
  type SemanticPayloadId
} from "../collaboration/identities.ts";

const SHADOW_METADATA_SCHEMA_VERSION = 1 as const;
const metadataWriteContext = Object.freeze({ stage: "object_data" as const });

export type DevelopmentShadowIdentityAllocator = Readonly<{
  capability: "injected_secure_identity_allocator_v1";
  allocate: (request: Readonly<{
    identity_kind: DestinationIdentityKind;
    source_identity: string;
    source_project_id: string;
    source_document_id: string | null;
  }>) => string | Promise<string>;
}>;

export type DevelopmentShadowIdentityBinding = Readonly<{
  identity_kind: DestinationIdentityKind;
  source_identity: string;
  source_key: string;
}>;

export type InitializeDevelopmentShadowInput = Readonly<{
  feature_environment: CollaborationShadowFeatureEnvironment;
  source_project_instance_commitment: string;
  source_project_id: string;
  initial_legacy_shared_state: ShadowLegacySharedState | unknown;
  source_identity_bindings: readonly DevelopmentShadowIdentityBinding[];
  bootstrap:
    | Readonly<{
        kind: "duplicate";
        input: DuplicateCollaborationBootstrapInput | unknown;
        current_source_inventory: NormalizedDuplicationSourceInventory | unknown;
      }>
    | Readonly<{
        kind: "native";
        input: NativeCollaborationBootstrapInput | unknown;
      }>;
  backend: CollaborationByteStorageBackend;
  facilities: BootstrapExecutionFacilities;
  identity_allocator: DevelopmentShadowIdentityAllocator;
}>;

export type DevelopmentShadowInitializationResult =
  | Readonly<{
      status: "disabled";
      shadow_project_id: null;
    }>
  | Readonly<{
      status: "complete_experimental_foundation";
      shadow_project_id: ProjectId;
      marker: BootstrapCompleteMarker;
      namespace_prefix: string;
    }>
  | Readonly<{
      status: "initialization_failed";
      shadow_project_id: ProjectId | null;
      reason: string;
    }>;

type ShadowIdentityMapping = Readonly<{
  identity_kind: DestinationIdentityKind;
  source_identity: string;
  source_key: string;
  authoritative_id: string;
  origin: "slice7_frozen" | "development_allocated";
  authority: "none";
  scope_source_document_id: string | null;
}>;

type ShadowRoots = Readonly<{
  semantic_state_root: string;
  revision_heads_root: string;
  conflict_set_root: string;
}>;

type ShadowMetadata = Readonly<{
  schema_version: typeof SHADOW_METADATA_SCHEMA_VERSION;
  object_kind: "collaboration_shadow_container_metadata";
  shadow_schema_version: typeof COLLABORATION_SHADOW_NAMESPACE_VERSION;
  mode: "development_shadow";
  authority: "none";
  exportable: false;
  synchronizable: false;
  production_openable: false;
  source_project_instance_commitment: string;
  source_project_id: string;
  shadow_project_id: ProjectId;
  bootstrap_status: "complete" | "diverged" | "invalid" | "requires_rebootstrap";
  plan_commitment: string;
  source_inventory_commitment: string | null;
  identity_map_commitment: string;
  identity_mappings: readonly ShadowIdentityMapping[];
  latest_source_state_commitment: string;
  latest_project_save_generation: number | null;
  latest_registry_revision: number | null;
  latest_roots: ShadowRoots | null;
  latest_outcome: ShadowEquivalenceOutcome;
  failure_reason: string | null;
  invitations_allowed: false;
  export_exchange_allowed: false;
  synchronization_allowed: false;
  materialization_allowed: false;
  production_credentials: false;
}>;

type Runtime = {
  backend: ExperimentalShadowBackend;
  plan: CollaborationBootstrapPlan;
  facilities: BootstrapExecutionFacilities;
  identityAllocator: DevelopmentShadowIdentityAllocator;
  mappings: Map<string, ShadowIdentityMapping>;
  patchVersions: Map<string, PatchVersionId>;
  contributionPayloads: Map<string, SemanticPayloadId>;
  metadata: ShadowMetadata;
  sourceState: ShadowLegacySharedState;
};

class ShadowProcessingError extends Error {
  readonly outcome: ShadowEquivalenceOutcome;

  constructor(outcome: ShadowEquivalenceOutcome, message: string) {
    super(message);
    this.name = "ShadowProcessingError";
    this.outcome = outcome;
  }
}

const runtimes = new Map<string, Runtime>();

export async function initializeDevelopmentCollaborationShadow(
  input: InitializeDevelopmentShadowInput
): Promise<DevelopmentShadowInitializationResult> {
  const feature = resolveCollaborationShadowFeatureState(input.feature_environment);
  if (feature.mode === "disabled") {
    return Object.freeze({ status: "disabled" as const, shadow_project_id: null });
  }
  let plan: CollaborationBootstrapPlan | null = null;
  try {
    requireIdentityAllocator(input.identity_allocator);
    const sourceState = parseLegacySharedState(input.initial_legacy_shared_state);
    const backend = new ExperimentalShadowBackend({
      backend: input.backend,
      source_project_instance_commitment: input.source_project_instance_commitment
    });
    let currentInventory: NormalizedDuplicationSourceInventory | undefined;
    if (input.bootstrap.kind === "duplicate") {
      plan = await planDuplicateAsCollaborationProject(input.bootstrap.input);
      currentInventory = input.bootstrap.current_source_inventory as NormalizedDuplicationSourceInventory;
    } else {
      plan = await planNativeCollaborationBootstrap(input.bootstrap.input);
    }
    const execution = await executeCollaborationBootstrap({
      plan,
      backend,
      facilities: input.facilities,
      ...(currentInventory ? { current_source_inventory: currentInventory } : {})
    });
    if (execution.status !== "complete_local_foundation") {
      return Object.freeze({
        status: "initialization_failed" as const,
        shadow_project_id: plan.destination_project_id,
        reason: `Slice 7 foundation did not complete: ${execution.status}`
      });
    }
    const mappings = buildFrozenMappings(
      plan,
      input.source_identity_bindings,
      sourceState,
      input.source_project_id
    );
    const runtime: Runtime = {
      backend,
      plan,
      facilities: input.facilities,
      identityAllocator: input.identity_allocator,
      mappings,
      patchVersions: new Map(),
      contributionPayloads: new Map(),
      metadata: createInitialMetadata(
        input,
        plan,
        execution.marker,
        [...new Set(mappings.values())]
      ),
      sourceState,
    };
    initializePatchVersions(runtime);
    const projection = await replay(runtime);
    await assertProjectionEquivalent(runtime, projection, sourceState);
    runtime.metadata = Object.freeze({
      ...runtime.metadata,
      latest_roots: await deriveRoots(runtime, projection),
      latest_outcome: "equivalent" as const
    });
    await writeMetadata(runtime);
    runtimes.set(input.source_project_id, runtime);
    return Object.freeze({
      status: "complete_experimental_foundation" as const,
      shadow_project_id: plan.destination_project_id,
      marker: execution.marker,
      namespace_prefix: backend.instance_prefix
    });
  } catch (error) {
    return Object.freeze({
      status: "initialization_failed" as const,
      shadow_project_id: plan?.destination_project_id ?? null,
      reason: errorMessage(error)
    });
  }
}

export async function processDevelopmentShadowMutation(
  value: unknown
): Promise<CollaborationShadowResult> {
  let receipt: CollaborationShadowMutationReceipt;
  try {
    receipt = parseCollaborationShadowMutationReceipt(value);
  } catch (error) {
    return result("shadow_unavailable", null, null, true, errorMessage(error));
  }
  const runtime = runtimes.get(receipt.source_project_id);
  if (!runtime) {
    return result(
      "shadow_unavailable",
      receipt.source_project_id,
      null,
      true,
      "No explicitly initialized development shadow foundation is available."
    );
  }
  if (runtime.metadata.bootstrap_status !== "complete") {
    return result(
      "shadow_unavailable",
      receipt.source_project_id,
      runtime.plan.destination_project_id,
      true,
      "The development shadow requires explicit reset and rebootstrap."
    );
  }
  try {
    if (
      receipt.source_project_instance_commitment !==
      runtime.metadata.source_project_instance_commitment
    ) {
      throw new ShadowProcessingError(
        "source_changed_before_shadow",
        "The receipt belongs to another source project instance."
      );
    }
    verifyReceiptLineage(runtime, receipt);
    await verifyPersistedMetadata(runtime);
    const beforeProjection = await replay(runtime);
    if (runtime.metadata.latest_roots !== null) {
      const reopenedRoots = await deriveRoots(runtime, beforeProjection);
      if (!sameRoots(reopenedRoots, runtime.metadata.latest_roots)) {
        throw new ShadowProcessingError(
          "root_mismatch",
          "Reopened shadow roots differ from the last verified roots."
        );
      }
    }
    const nextSourceState = mergeLegacySourceState(
      runtime.sourceState,
      receipt.committed_shared_state
    );
    await applySourceDifference(runtime, runtime.sourceState, nextSourceState, receipt);
    const projection = await replay(runtime);
    await assertProjectionEquivalent(runtime, projection, nextSourceState);
    const roots = await deriveRoots(runtime, projection);
    runtime.sourceState = nextSourceState;
    runtime.metadata = Object.freeze({
      ...runtime.metadata,
      identity_mappings: Object.freeze([...new Set(runtime.mappings.values())].sort(mappingCompare)),
      latest_source_state_commitment: receipt.legacy_commit.source_state_commitment,
      latest_project_save_generation: receipt.legacy_commit.commit_kind === "project_save"
        ? receipt.legacy_commit.generation
        : runtime.metadata.latest_project_save_generation,
      latest_registry_revision: receipt.legacy_commit.commit_kind === "project_registry"
        ? receipt.legacy_commit.manifest_revision
        : runtime.metadata.latest_registry_revision,
      latest_roots: roots,
      latest_outcome: "equivalent" as const,
      failure_reason: null
    });
    await writeMetadata(runtime);
    return result(
      "equivalent",
      receipt.source_project_id,
      runtime.plan.destination_project_id,
      false,
      "The shadow projection and normalized legacy shared state are equivalent."
    );
  } catch (error) {
    const outcome = error instanceof ShadowProcessingError
      ? error.outcome
      : classifyUnexpectedFailure(error);
    await markDiverged(runtime, outcome, errorMessage(error));
    return result(
      outcome,
      receipt.source_project_id,
      runtime.plan.destination_project_id,
      true,
      errorMessage(error)
    );
  }
}

export async function resetDevelopmentCollaborationShadowForTests(
  sourceProjectId?: string
): Promise<void> {
  if (sourceProjectId === undefined) runtimes.clear();
  else runtimes.delete(sourceProjectId);
}

export function readDevelopmentShadowRuntimeStatus(sourceProjectId: string): Readonly<{
  initialized: boolean;
  metadata: ShadowMetadata | null;
}> {
  const runtime = runtimes.get(sourceProjectId);
  return Object.freeze({ initialized: Boolean(runtime), metadata: runtime?.metadata ?? null });
}

function createInitialMetadata(
  input: InitializeDevelopmentShadowInput,
  plan: CollaborationBootstrapPlan,
  _marker: BootstrapCompleteMarker,
  mappings: readonly ShadowIdentityMapping[]
): ShadowMetadata {
  return Object.freeze({
    schema_version: SHADOW_METADATA_SCHEMA_VERSION,
    object_kind: "collaboration_shadow_container_metadata" as const,
    shadow_schema_version: COLLABORATION_SHADOW_NAMESPACE_VERSION,
    mode: "development_shadow" as const,
    authority: "none" as const,
    exportable: false as const,
    synchronizable: false as const,
    production_openable: false as const,
    source_project_instance_commitment: input.source_project_instance_commitment,
    source_project_id: input.source_project_id,
    shadow_project_id: plan.destination_project_id,
    bootstrap_status: "complete" as const,
    plan_commitment: plan.plan_commitment,
    source_inventory_commitment: plan.source_inventory_commitment,
    identity_map_commitment: plan.identity_map_commitment,
    identity_mappings: Object.freeze([...mappings].sort(mappingCompare)),
    latest_source_state_commitment: "explicit-initialization",
    latest_project_save_generation: null,
    latest_registry_revision: null,
    latest_roots: null,
    latest_outcome: "equivalent" as const,
    failure_reason: null,
    invitations_allowed: false as const,
    export_exchange_allowed: false as const,
    synchronization_allowed: false as const,
    materialization_allowed: false as const,
    production_credentials: false as const
  });
}

function buildFrozenMappings(
  plan: CollaborationBootstrapPlan,
  bindings: readonly DevelopmentShadowIdentityBinding[],
  sourceState: ShadowLegacySharedState,
  sourceProjectId: string
): Map<string, ShadowIdentityMapping> {
  const bySourceKey = new Map(plan.identity_mappings.map((mapping) => [mapping.source_key, mapping]));
  const output = new Map<string, ShadowIdentityMapping>();
  for (const mapping of plan.identity_mappings) {
    addMapping(output, Object.freeze({
      identity_kind: mapping.identity_kind,
      source_identity: mapping.source_id ?? mapping.source_key,
      source_key: mapping.source_key,
      authoritative_id: mapping.authoritative_id,
      origin: "slice7_frozen" as const,
      authority: "none" as const,
      scope_source_document_id: null
    }));
    if (mapping.source_id !== null && mapping.source_id !== mapping.source_key) {
      addMapping(output, Object.freeze({
        identity_kind: mapping.identity_kind,
        source_identity: mapping.source_key,
        source_key: mapping.source_key,
        authoritative_id: mapping.authoritative_id,
        origin: "slice7_frozen" as const,
        authority: "none" as const,
        scope_source_document_id: null
      }));
    }
  }
  for (const binding of bindings) {
    const mapping = bySourceKey.get(binding.source_key);
    if (!mapping || mapping.identity_kind !== binding.identity_kind) {
      throw new Error("A source identity binding does not match the frozen Slice 7 identity map.");
    }
    addMapping(output, Object.freeze({
      identity_kind: binding.identity_kind,
      source_identity: binding.source_identity,
      source_key: binding.source_key,
      authoritative_id: mapping.authoritative_id,
      origin: "slice7_frozen" as const,
      authority: "none" as const,
      scope_source_document_id: sourceDocumentScope(sourceState, binding)
    }));
  }
  const projectMapping = [...output.values()].find(
    (mapping) => mapping.identity_kind === "project" && mapping.source_identity === sourceProjectId
  );
  if (!projectMapping || projectMapping.authoritative_id !== plan.destination_project_id) {
    throw new Error("The initialized source project ID is not bound to the shadow project ID.");
  }
  return output;
}

function sourceDocumentScope(
  state: ShadowLegacySharedState,
  binding: DevelopmentShadowIdentityBinding
): string | null {
  if (binding.identity_kind === "document") return binding.source_identity;
  for (const document of state.documents) {
    const content = document.content;
    if (!content) continue;
    if (
      (binding.identity_kind === "comment" && content.comments.some((item) => item.source_comment_id === binding.source_identity)) ||
      (binding.identity_kind === "reply" && content.comments.some((item) => item.replies.some((reply) => reply.source_reply_id === binding.source_identity))) ||
      (binding.identity_kind === "patch" && content.patches.some((item) => item.source_patch_id === binding.source_identity)) ||
      (binding.identity_kind === "review-batch" && content.review_batches.some((item) => item.source_review_batch_id === binding.source_identity)) ||
      (binding.identity_kind === "rewrite-session" && content.rewrite_sessions.some((item) => item.source_rewrite_session_id === binding.source_identity))
    ) {
      return document.source_document_id;
    }
  }
  return null;
}

function addMapping(
  mappings: Map<string, ShadowIdentityMapping>,
  mapping: ShadowIdentityMapping
): void {
  const key = mappingKey(mapping.identity_kind, mapping.source_identity);
  const existing = mappings.get(key);
  if (existing && existing.authoritative_id !== mapping.authoritative_id) {
    throw new Error("A source identity maps ambiguously to multiple shadow identities.");
  }
  mappings.set(key, mapping);
}

function initializePatchVersions(runtime: Runtime): void {
  for (const document of runtime.sourceState.documents) {
    for (const patch of document.content?.patches ?? []) {
      const patchId = resolveIdentity(runtime, "patch", patch.source_patch_id) as PatchId;
      const projected = runtime.plan.expected_shared_state.documents
        .flatMap((entry) => entry.patches)
        .find((entry) => entry.patch_id === patchId);
      const version = projected?.versions.at(-1);
      if (version) runtime.patchVersions.set(patchVersionKey(document.source_document_id, patch.source_patch_id), version.patch_version_id);
    }
  }
}

function verifyReceiptLineage(runtime: Runtime, receipt: CollaborationShadowMutationReceipt): void {
  if (receipt.legacy_commit.commit_kind === "project_save") {
    const previous = runtime.metadata.latest_project_save_generation;
    if (previous !== null && receipt.legacy_commit.generation <= previous) {
      throw new ShadowProcessingError(
        "source_changed_before_shadow",
        "The legacy save receipt does not advance the initialized source lineage."
      );
    }
  } else {
    const previous = runtime.metadata.latest_registry_revision;
    if (previous !== null && receipt.legacy_commit.manifest_revision <= previous) {
      throw new ShadowProcessingError(
        "source_changed_before_shadow",
        "The registry receipt does not advance the initialized source lineage."
      );
    }
  }
  if (!receipt.committed_shared_state.documents.some(
    (document) => document.source_document_id === receipt.source_document_id
  )) {
    throw new ShadowProcessingError(
      "source_changed_before_shadow",
      "The committed receipt no longer contains its source document."
    );
  }
}

function mergeLegacySourceState(
  previous: ShadowLegacySharedState,
  next: ShadowLegacySharedState
): ShadowLegacySharedState {
  const previousDocuments = new Map(previous.documents.map((document) => [document.source_document_id, document]));
  return parseLegacySharedState({
    ...next,
    documents: next.documents.map((document) => ({
      ...document,
      content: mergeLegacyDocumentContent(
        previousDocuments.get(document.source_document_id)?.content ?? null,
        document.content
      )
    }))
  });
}

function mergeLegacyDocumentContent(
  previous: ShadowLegacyDocumentContent | null,
  next: ShadowLegacyDocumentContent | null
): ShadowLegacyDocumentContent | null {
  if (next === null) return previous;
  if (previous === null) return next;
  const previousReviews = new Map(
    previous.review_batches.map((batch) => [batch.source_review_batch_id, batch])
  );
  return Object.freeze({
    ...next,
    review_batches: Object.freeze(next.review_batches.map((batch) => {
      const prior = previousReviews.get(batch.source_review_batch_id);
      if (!prior || prior.lifecycle !== "responded") return batch;
      if (
        batch.lifecycle !== "responded" ||
        batch.response_import_id !== prior.response_import_id ||
        batch.contribution_source_refs.some((reference) =>
          !prior.contribution_source_refs.includes(reference)
        )
      ) {
        throw new ShadowProcessingError(
          "projection_mismatch",
          "A committed source review response attempted to change immutable evidence."
        );
      }
      return Object.freeze({
        ...batch,
        contribution_source_refs: prior.contribution_source_refs
      });
    }))
  });
}

async function applySourceDifference(
  runtime: Runtime,
  previous: ShadowLegacySharedState,
  next: ShadowLegacySharedState,
  receipt: CollaborationShadowMutationReceipt
): Promise<void> {
  await applyMetadataDifference(runtime, previous, next);
  const previousDocuments = new Map(previous.documents.map((document) => [document.source_document_id, document]));
  for (const document of next.documents) {
    const prior = previousDocuments.get(document.source_document_id);
    if (!prior) await createDocumentMetadata(runtime, document);
    if (document.content !== null) {
      await applyDocumentContentDifference(
        runtime,
        prior?.content ?? null,
        document,
        receipt
      );
    }
  }
  for (const removed of previous.documents.filter(
    (document) => !next.documents.some((candidate) => candidate.source_document_id === document.source_document_id)
  )) {
    await appendPayload(runtime, {
      schema_version: 1,
      project_id: runtime.plan.destination_project_id,
      semantic_kind: "metadata_operation",
      data: {
        operation: "document_delete",
        document_id: resolveIdentity(runtime, "document", removed.source_document_id)
      }
    });
  }
}

async function applyMetadataDifference(
  runtime: Runtime,
  previous: ShadowLegacySharedState,
  next: ShadowLegacySharedState
): Promise<void> {
  if (previous.project_title !== next.project_title) {
    await appendPayload(runtime, metadataPayload(runtime, { operation: "project_title", value: next.project_title }));
  }
  const previousGroups = new Map(previous.groups.map((group) => [group.source_group_id, group]));
  for (const group of next.groups) {
    const prior = previousGroups.get(group.source_group_id);
    const groupId = prior
      ? resolveIdentity(runtime, "group", group.source_group_id)
      : await resolveOrAllocate(runtime, "group", group.source_group_id, null);
    if (!prior) {
      await appendPayload(runtime, metadataPayload(runtime, {
        operation: "group_create",
        group_id: groupId,
        value: group.title
      }));
      await appendPayload(runtime, metadataPayload(runtime, {
        operation: "group_position",
        group_id: groupId,
        value: group.position
      }));
    } else {
      if (prior.title !== group.title) {
        await appendPayload(runtime, metadataPayload(runtime, {
          operation: "group_rename",
          group_id: groupId,
          value: group.title
        }));
      }
      if (prior.position !== group.position) {
        await appendPayload(runtime, metadataPayload(runtime, {
          operation: "group_position",
          group_id: groupId,
          value: group.position
        }));
      }
    }
  }
  if (previous.groups.some((group) => !next.groups.some((candidate) => candidate.source_group_id === group.source_group_id))) {
    throw new ShadowProcessingError(
      "shadow_dependency_missing",
      "The Slice 5 reducer does not authorize group deletion in this shadow seam."
    );
  }
  const previousDocuments = new Map(previous.documents.map((document) => [document.source_document_id, document]));
  for (const document of next.documents) {
    const prior = previousDocuments.get(document.source_document_id);
    if (!prior) continue;
    const id = resolveIdentity(runtime, "document", document.source_document_id);
    if (prior.title !== document.title) await appendPayload(runtime, metadataPayload(runtime, { operation: "document_title", document_id: id, value: document.title }));
    if (prior.logical_path !== document.logical_path) await appendPayload(runtime, metadataPayload(runtime, { operation: "document_path", document_id: id, value: document.logical_path }));
    if (prior.position !== document.position) await appendPayload(runtime, metadataPayload(runtime, { operation: "document_position", document_id: id, value: document.position }));
    if (prior.archive_status !== document.archive_status) await appendPayload(runtime, metadataPayload(runtime, {
      operation: document.archive_status === "archived" ? "document_archive" : "document_restore",
      document_id: id
    }));
    if (prior.source_group_id !== document.source_group_id) {
      if (document.source_group_id === null) {
        throw new ShadowProcessingError(
          "shadow_dependency_missing",
          "The Slice 5 reducer does not authorize clearing a document group."
        );
      }
      await appendPayload(runtime, metadataPayload(runtime, {
        operation: "document_group",
        document_id: id,
        group_id: resolveIdentity(runtime, "group", document.source_group_id)
      }));
    }
    if (!prior.tombstone && document.tombstone) {
      await appendPayload(runtime, metadataPayload(runtime, { operation: "document_delete", document_id: id }));
    }
  }
}

async function createDocumentMetadata(runtime: Runtime, document: ShadowLegacyDocument): Promise<void> {
  const documentId = await resolveOrAllocate(
    runtime,
    "document",
    document.source_document_id,
    document.source_document_id
  );
  await appendPayload(runtime, metadataPayload(runtime, { operation: "document_create", document_id: documentId }));
  await appendPayload(runtime, metadataPayload(runtime, { operation: "document_title", document_id: documentId, value: document.title }));
  await appendPayload(runtime, metadataPayload(runtime, { operation: "document_path", document_id: documentId, value: document.logical_path }));
  await appendPayload(runtime, metadataPayload(runtime, { operation: "document_position", document_id: documentId, value: document.position }));
  if (document.source_group_id !== null) {
    await appendPayload(runtime, metadataPayload(runtime, {
      operation: "document_group",
      document_id: documentId,
      group_id: resolveIdentity(runtime, "group", document.source_group_id)
    }));
  }
  if (document.archive_status === "archived") {
    await appendPayload(runtime, metadataPayload(runtime, { operation: "document_archive", document_id: documentId }));
  }
}

async function applyDocumentContentDifference(
  runtime: Runtime,
  previous: ShadowLegacyDocumentContent | null,
  document: ShadowLegacyDocument,
  receipt: CollaborationShadowMutationReceipt
): Promise<void> {
  const next = document.content;
  if (!next) return;
  const documentId = resolveIdentity(runtime, "document", document.source_document_id) as DocumentId;
  let newRevisionId: DocumentRevisionId | null = null;
  if (!previous || !bytesEqual(previous.exact_markdown_bytes, next.exact_markdown_bytes)) {
    newRevisionId = await storeAndAdoptRevision(runtime, documentId, next.exact_markdown_bytes);
  }
  await applyReviewCreations(
    runtime,
    document.source_document_id,
    previous?.review_batches ?? [],
    next.review_batches
  );
  const responseBatches = reviewResponseBatchMap(runtime, next.review_batches);
  await applyCommentDifference(runtime, document.source_document_id, documentId, previous?.comments ?? [], next.comments, responseBatches);
  await applyPatchDifference(runtime, document.source_document_id, documentId, previous?.patches ?? [], next.patches, newRevisionId, receipt, responseBatches);
  await applyReviewTerminals(runtime, previous?.review_batches ?? [], next.review_batches);
  await applyRewriteDifference(runtime, document.source_document_id, documentId, previous?.rewrite_sessions ?? [], next.rewrite_sessions, newRevisionId);
}

async function storeAndAdoptRevision(
  runtime: Runtime,
  documentId: DocumentId,
  bytes: Uint8Array
): Promise<DocumentRevisionId> {
  const revisions = new ImmutableCollaborationStore({ backend: runtime.backend });
  const projection = await replay(runtime);
  const parents = projection.revision_heads.find(
    (entry) => entry.document_id === documentId
  )?.head_revision_ids ?? [];
  const blob = await revisions.putMarkdownBlob(runtime.plan.destination_project_id, bytes);
  const revision = await revisions.putRevision(parents.length === 0
    ? {
        schema_version: 1,
        object_kind: "document_revision_core",
        ancestry_kind: "genesis",
        project_id: runtime.plan.destination_project_id,
        document_id: documentId,
        markdown_blob_id: blob.id,
        parent_revision_ids: Object.freeze([]) as readonly []
      }
    : {
        schema_version: 1,
        object_kind: "document_revision_core",
        ancestry_kind: "ordinary",
        project_id: runtime.plan.destination_project_id,
        document_id: documentId,
        markdown_blob_id: blob.id,
        parent_revision_ids: Object.freeze([...parents].sort())
      });
  await appendPayload(runtime, {
    schema_version: 1,
    project_id: runtime.plan.destination_project_id,
    semantic_kind: "revision_adoption",
    data: { document_id: documentId, revision_id: revision.id }
  });
  return revision.id;
}

async function applyCommentDifference(
  runtime: Runtime,
  sourceDocumentId: string,
  documentId: DocumentId,
  previous: readonly ShadowLegacyComment[],
  next: readonly ShadowLegacyComment[],
  responseBatches: ReadonlyMap<string, ReviewBatchId>
): Promise<void> {
  const previousById = new Map(previous.map((comment) => [comment.source_comment_id, comment]));
  for (const comment of next) {
    const prior = previousById.get(comment.source_comment_id);
    const commentId = (prior
      ? resolveIdentity(runtime, "comment", comment.source_comment_id)
      : await resolveOrAllocate(runtime, "comment", comment.source_comment_id, sourceDocumentId)) as CommentId;
    if (!prior) {
      await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "comment_operation",
        data: {
          operation: "create",
          document_id: documentId,
          comment_id: commentId,
          content: comment.body,
          anchor: sharedAnchor(comment)
        }
      });
      if (comment.status === "resolved") await appendCommentStatus(runtime, documentId, commentId, "resolve");
      if (comment.trash_status === "trashed") await appendCommentStatus(runtime, documentId, commentId, "trash");
      if (comment.tombstone) await appendCommentStatus(runtime, documentId, commentId, "delete");
    } else if (!prior.tombstone) {
      if (prior.body !== comment.body) {
        await appendPayload(runtime, {
          schema_version: 1,
          project_id: runtime.plan.destination_project_id,
          semantic_kind: "comment_operation",
          data: { operation: "edit", document_id: documentId, comment_id: commentId, content: comment.body }
        });
      }
      if (prior.anchor.kind !== comment.anchor.kind || prior.anchor.key !== comment.anchor.key) {
        await appendPayload(runtime, {
          schema_version: 1,
          project_id: runtime.plan.destination_project_id,
          semantic_kind: "comment_operation",
          data: { operation: "reanchor", document_id: documentId, comment_id: commentId, anchor: sharedAnchor(comment) }
        });
      }
      if (prior.status !== comment.status) {
        await appendCommentStatus(runtime, documentId, commentId, comment.status === "resolved" ? "resolve" : "reopen");
      }
      if (prior.trash_status !== comment.trash_status) {
        await appendCommentStatus(runtime, documentId, commentId, comment.trash_status === "trashed" ? "trash" : "restore");
      }
      if (!prior.tombstone && comment.tombstone) await appendCommentStatus(runtime, documentId, commentId, "delete");
    } else if (!comment.tombstone) {
      throw new ShadowProcessingError(
        "shadow_dependency_missing",
        "The source attempted to resurrect a collaboration tombstone."
      );
    }
    await applyReplyDifference(
      runtime,
      sourceDocumentId,
      comment.source_comment_id,
      documentId,
      commentId as CommentId,
      prior?.replies ?? [],
      comment.replies,
      responseBatches
    );
  }
  for (const removed of previous.filter(
    (comment) => !next.some((candidate) => candidate.source_comment_id === comment.source_comment_id)
  )) {
    if (!removed.tombstone) {
      await appendCommentStatus(
        runtime,
        documentId,
        resolveIdentity(runtime, "comment", removed.source_comment_id) as CommentId,
        "delete"
      );
    }
  }
}

async function applyReplyDifference(
  runtime: Runtime,
  sourceDocumentId: string,
  sourceCommentId: string,
  documentId: DocumentId,
  commentId: CommentId,
  previous: ShadowLegacyComment["replies"],
  next: ShadowLegacyComment["replies"],
  responseBatches: ReadonlyMap<string, ReviewBatchId>
): Promise<void> {
  const previousById = new Map(previous.map((reply) => [reply.source_reply_id, reply]));
  for (const reply of next) {
    const prior = previousById.get(reply.source_reply_id);
    const replyId = prior
      ? resolveIdentity(runtime, "reply", reply.source_reply_id)
      : await resolveOrAllocate(runtime, "reply", reply.source_reply_id, sourceDocumentId);
    if (
      !prior ||
      prior.body !== reply.body ||
      prior.source_import_id !== reply.source_import_id
    ) {
      const reviewProvenance = reviewContributionProvenance(
        responseBatches,
        reply.source_import_id
      );
      const payloadId = await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "reply_operation",
        data: {
          operation: prior ? "edit" : "create",
          document_id: documentId,
          comment_id: commentId,
          reply_id: replyId,
          content: reply.body,
          ...reviewProvenance
        }
      });
      if (reply.source_import_id !== null) {
        runtime.contributionPayloads.set(
          `reply:${sourceCommentId}:${reply.source_reply_id}`,
          payloadId
        );
      }
    }
    if ((!prior && reply.tombstone) || (prior && !prior.tombstone && reply.tombstone)) {
      await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "reply_operation",
        data: { operation: "delete", document_id: documentId, comment_id: commentId, reply_id: replyId }
      });
    }
  }
  for (const removed of previous.filter(
    (reply) => !next.some((candidate) => candidate.source_reply_id === reply.source_reply_id)
  )) {
    if (!removed.tombstone) {
      await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "reply_operation",
        data: {
          operation: "delete",
          document_id: documentId,
          comment_id: commentId,
          reply_id: resolveIdentity(runtime, "reply", removed.source_reply_id)
        }
      });
    }
  }
}

async function applyPatchDifference(
  runtime: Runtime,
  sourceDocumentId: string,
  documentId: DocumentId,
  previous: readonly ShadowLegacyPatch[],
  next: readonly ShadowLegacyPatch[],
  newRevisionId: DocumentRevisionId | null,
  receipt: CollaborationShadowMutationReceipt,
  responseBatches: ReadonlyMap<string, ReviewBatchId>
): Promise<void> {
  const previousById = new Map(previous.map((patch) => [patch.source_patch_id, patch]));
  for (const patch of next) {
    const prior = previousById.get(patch.source_patch_id);
    const patchId = prior
      ? resolveIdentity(runtime, "patch", patch.source_patch_id) as PatchId
      : await resolveOrAllocate(runtime, "patch", patch.source_patch_id, sourceDocumentId) as PatchId;
    const versionKey = patchVersionKey(sourceDocumentId, patch.source_patch_id);
    let patchVersionId = runtime.patchVersions.get(versionKey);
    const versionChanged = !prior ||
      prior.version_fingerprint !== patch.version_fingerprint ||
      prior.source_import_id !== patch.source_import_id ||
      (newRevisionId !== null && receipt.mutation_key.startsWith("accept_patch:"));
    if (versionChanged) {
      patchVersionId = await resolveOrAllocate(
        runtime,
        "patch-version",
        `${patch.source_patch_id}@${patch.version_fingerprint}@${receipt.legacy_commit.source_state_commitment}`,
        sourceDocumentId
      ) as PatchVersionId;
      const dependencies = patch.dependency_source_patch_ids.map((dependency) => {
        const version = runtime.patchVersions.get(patchVersionKey(sourceDocumentId, dependency));
        if (!version) {
          throw new ShadowProcessingError(
            "shadow_dependency_missing",
            `Shadow patch dependency ${dependency} has no mapped version.`
          );
        }
        return version;
      }).sort();
      const reviewProvenance = reviewContributionProvenance(
        responseBatches,
        patch.source_import_id
      );
      const payloadId = await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "patch_operation",
        data: {
          operation: prior ? "edit" : "propose",
          document_id: documentId,
          patch_id: patchId,
          patch_version_id: patchVersionId,
          ...(newRevisionId !== null && receipt.mutation_key.startsWith("accept_patch:")
            ? { revision_id: newRevisionId }
            : {}),
          dependency_patch_version_ids: dependencies,
          ...(patch.target_provenance === null ? {} : { target_provenance: patch.target_provenance }),
          ...reviewProvenance
        }
      });
      if (patch.source_import_id !== null) {
        runtime.contributionPayloads.set(
          `patch:${patch.source_patch_id}`,
          payloadId
        );
      }
      runtime.patchVersions.set(versionKey, patchVersionId);
    }
    if (!patchVersionId) {
      throw new ShadowProcessingError("missing_mapping", "A source patch has no exact shadow version mapping.");
    }
    if (patch.status === "stale") {
      throw new ShadowProcessingError(
        "shadow_dependency_missing",
        "The Slice 5 reducer has no authoritative stale-patch transition."
      );
    }
    if (
      patch.status !== "pending" &&
      (!prior || prior.status !== patch.status || versionChanged)
    ) {
      await appendPayload(runtime, {
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        semantic_kind: "patch_operation",
        data: {
          operation: "decide",
          document_id: documentId,
          patch_id: patchId,
          patch_version_id: patchVersionId,
          decision: patch.status
        }
      });
    }
  }
}

async function applyReviewCreations(
  runtime: Runtime,
  sourceDocumentId: string,
  previous: ShadowLegacyDocumentContent["review_batches"],
  next: ShadowLegacyDocumentContent["review_batches"]
): Promise<void> {
  const previousById = new Map(previous.map((batch) => [batch.source_review_batch_id, batch]));
  for (const batch of next) {
    const prior = previousById.get(batch.source_review_batch_id);
    const id = prior
      ? resolveIdentity(runtime, "review-batch", batch.source_review_batch_id)
      : await resolveOrAllocate(runtime, "review-batch", batch.source_review_batch_id, sourceDocumentId);
    if (!prior) {
      await appendPayload(runtime, reviewPayload(runtime, { operation: "create", review_batch_id: id }));
    }
  }
}

function reviewResponseBatchMap(
  runtime: Runtime,
  batches: ShadowLegacyDocumentContent["review_batches"]
): ReadonlyMap<string, ReviewBatchId> {
  const output = new Map<string, ReviewBatchId>();
  for (const batch of batches) {
    if (batch.response_import_id === null) continue;
    const id = resolveIdentity(
      runtime,
      "review-batch",
      batch.source_review_batch_id
    ) as ReviewBatchId;
    if (output.has(batch.response_import_id)) {
      throw new ShadowProcessingError(
        "projection_mismatch",
        "A source response import ID is ambiguously shared by review batches."
      );
    }
    output.set(batch.response_import_id, id);
  }
  return output;
}

function reviewContributionProvenance(
  batches: ReadonlyMap<string, ReviewBatchId>,
  sourceImportId: string | null
): Readonly<Record<string, string>> {
  if (sourceImportId === null) return Object.freeze({});
  const reviewBatchId = batches.get(sourceImportId);
  if (!reviewBatchId) {
    throw new ShadowProcessingError(
      "projection_mismatch",
      "A source contribution import ID has no unique review batch."
    );
  }
  return Object.freeze({
    review_batch_id: reviewBatchId,
    response_import_id: sourceImportId
  });
}

async function applyReviewTerminals(
  runtime: Runtime,
  previous: ShadowLegacyDocumentContent["review_batches"],
  next: ShadowLegacyDocumentContent["review_batches"]
): Promise<void> {
  const previousById = new Map(
    previous.map((batch) => [batch.source_review_batch_id, batch])
  );
  for (const batch of next) {
    const prior = previousById.get(batch.source_review_batch_id);
    const id = resolveIdentity(
      runtime,
      "review-batch",
      batch.source_review_batch_id
    ) as ReviewBatchId;
    if (
      prior?.lifecycle === "responded" &&
      (batch.lifecycle !== "responded" ||
        batch.response_import_id !== prior.response_import_id ||
        !sameStringArray(
          batch.contribution_source_refs,
          prior.contribution_source_refs
        ))
    ) {
      throw new ShadowProcessingError(
        "projection_mismatch",
        "A committed review response cannot be rewritten or reopened."
      );
    }
    if (batch.lifecycle === prior?.lifecycle) continue;
    if (batch.lifecycle === "responded") {
      if (batch.response_import_id === null) {
        throw new ShadowProcessingError(
          "projection_mismatch",
          "A responded review batch lacks a source response import ID."
        );
      }
      const contributionPayloadIds = batch.contribution_source_refs.map(
        (reference) => {
          const payloadId = runtime.contributionPayloads.get(reference);
          if (!payloadId) {
            throw new ShadowProcessingError(
              "shadow_dependency_missing",
              `Review contribution ${reference} was not materialized as an immutable payload.`
            );
          }
          return payloadId;
        }
      ).sort();
      if (new Set(contributionPayloadIds).size !== contributionPayloadIds.length) {
        throw new ShadowProcessingError(
          "projection_mismatch",
          "Distinct source contributions cannot collapse to one payload identity."
        );
      }
      const evidence = await deriveReviewResponseEvidence({
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        review_batch_id: id,
        response_import_id: parseReviewResponseImportId(batch.response_import_id),
        contribution_payload_ids: contributionPayloadIds
      });
      await appendPayload(runtime, reviewPayload(runtime, {
        operation: "respond",
        review_batch_id: id,
        response_evidence_commitment: evidence.commitment,
        response_import_id: parseReviewResponseImportId(batch.response_import_id),
        contribution_payload_ids: contributionPayloadIds
      }));
    } else if (batch.lifecycle === "cancelled") {
      await appendPayload(
        runtime,
        reviewPayload(runtime, { operation: "cancel", review_batch_id: id })
      );
    }
  }
}

async function applyRewriteDifference(
  runtime: Runtime,
  sourceDocumentId: string,
  documentId: DocumentId,
  previous: ShadowLegacyDocumentContent["rewrite_sessions"],
  next: ShadowLegacyDocumentContent["rewrite_sessions"],
  newRevisionId: DocumentRevisionId | null
): Promise<void> {
  const previousById = new Map(previous.map((rewrite) => [rewrite.source_rewrite_session_id, rewrite]));
  for (const rewrite of next) {
    const prior = previousById.get(rewrite.source_rewrite_session_id);
    const id = prior
      ? resolveIdentity(runtime, "rewrite-session", rewrite.source_rewrite_session_id)
      : await resolveOrAllocate(runtime, "rewrite-session", rewrite.source_rewrite_session_id, sourceDocumentId);
    if (!prior) {
      await appendPayload(runtime, rewritePayload(runtime, {
        operation: "create",
        document_id: documentId,
        rewrite_session_id: id
      }));
    }
    if (rewrite.outcome !== prior?.outcome && rewrite.outcome !== "active") {
      if (rewrite.outcome === "applied" && !newRevisionId) {
        throw new ShadowProcessingError(
          "shadow_dependency_missing",
          "An applied Human Rewrite receipt did not contain changed Markdown bytes."
        );
      }
      await appendPayload(runtime, rewritePayload(runtime, {
        operation: rewrite.outcome === "applied" ? "apply" : "discard",
        document_id: documentId,
        rewrite_session_id: id,
        ...(rewrite.outcome === "applied" ? { revision_id: newRevisionId } : {})
      }));
    }
  }
}

async function appendCommentStatus(
  runtime: Runtime,
  documentId: DocumentId,
  commentId: CommentId,
  operation: "resolve" | "reopen" | "trash" | "restore" | "delete"
): Promise<void> {
  await appendPayload(runtime, {
    schema_version: 1,
    project_id: runtime.plan.destination_project_id,
    semantic_kind: "comment_operation",
    data: { operation, document_id: documentId, comment_id: commentId }
  });
}

async function appendPayload(runtime: Runtime, value: unknown): Promise<SemanticPayloadId> {
  const payload = parseSemanticPayloadCore(value);
  const events = createEventStore(runtime);
  const stored = await events.putSemanticPayload(payload);
  const state = await events.reconstructProject(runtime.plan.destination_project_id);
  const appended = await events.appendLocalSemanticEvent({
    project_id: runtime.plan.destination_project_id,
    author_device_id: runtime.plan.owner_device_id,
    semantic_kind: payload.semantic_kind,
    semantic_payload_id: stored.id,
    causal_parent_event_ids: Object.freeze([...state.accepted_semantic_frontier].sort()),
    authorizing_control_head_id: runtime.plan.expected_control_event_id,
    key_epoch_id: runtime.plan.initial_key_epoch_id,
    complete_known_frontier: true,
    create_attestations: runtime.facilities.create_semantic_attestations
  });
  if (!appended.event.event_id) throw new Error("Shadow semantic append did not return an event identity.");
  return stored.id;
}

async function replay(runtime: Runtime): Promise<CollaborationProjection> {
  const events = createEventStore(runtime);
  const revisions = new ImmutableCollaborationStore({ backend: runtime.backend });
  const state = await events.reopenProject(runtime.plan.destination_project_id);
  if (state.invalid_object_ids.length > 0 || state.accepted_semantic_event_ids.length === 0) {
    throw new ShadowProcessingError(
      "shadow_corrupt",
      "Reopened shadow history contains invalid or missing immutable event evidence."
    );
  }
  return (await projectCollaborationHistory(projectorBoundary(runtime, state, events, revisions))).projection;
}

function projectorBoundary(
  runtime: Runtime,
  state: EventControlProjectState,
  events: EventControlStore,
  revisions: ImmutableCollaborationStore
): CollaborationProjectorInput {
  return Object.freeze({
    project_id: runtime.plan.destination_project_id,
    accepted_semantic_event_ids: state.accepted_semantic_event_ids,
    accepted_semantic_frontier: state.accepted_semantic_frontier,
    accepted_control_facts: Object.freeze([{
      control_event_id: runtime.plan.expected_control_event_id,
      merge_policy: runtime.plan.initial_merge_policy,
      device_authorities: runtime.plan.control_state.device_authorities
    }]),
    onboarding_boundaries: Object.freeze([]),
    read_event: (id) => events.immutableObjects.getSemanticEvent(id),
    read_payload: (id) => events.immutableObjects.getSemanticPayload(id),
    read_revision: (id) => revisions.getRevision(id),
    read_blob: (projectId, id) => revisions.getMarkdownBlob(projectId, id),
    read_attestation: (id) => events.immutableObjects.getAttestation(id)
  });
}

function createEventStore(runtime: Runtime): EventControlStore {
  return new EventControlStore({
    backend: runtime.backend,
    attestation_verifier: runtime.facilities.attestation_verifier,
    control_transition_verifier: runtime.facilities.control_transition_verifier
  });
}

async function deriveRoots(
  runtime: Runtime,
  projection: CollaborationProjection
): Promise<ShadowRoots> {
  const revisions = new ImmutableCollaborationStore({ backend: runtime.backend });
  const [semantic, revision, conflict] = await Promise.all([
    deriveSemanticStateRoot(projection),
    deriveRevisionHeadsRoot(projection, {
      project_id: runtime.plan.destination_project_id,
      read_revision: (id) => revisions.getRevision(id),
      read_blob: (projectId, id) => revisions.getMarkdownBlob(projectId, id)
    }),
    deriveConflictSetRoot(projection)
  ]);
  return Object.freeze({
    semantic_state_root: semantic.id,
    revision_heads_root: revision.id,
    conflict_set_root: conflict.id
  });
}

async function assertProjectionEquivalent(
  runtime: Runtime,
  projection: CollaborationProjection,
  source: ShadowLegacySharedState
): Promise<void> {
  requireRegister(projection.project_title, source.project_title, "project title");
  const expectedGroupOrder = source.group_order.map((id) => resolveIdentity(runtime, "group", id));
  const expectedDocumentOrder = source.document_order.map((id) => resolveIdentity(runtime, "document", id));
  requireStringArray(projection.group_order, expectedGroupOrder, "group order");
  requireStringArray(projection.document_order, expectedDocumentOrder, "document order");
  for (const group of source.groups) {
    const id = resolveIdentity(runtime, "group", group.source_group_id);
    const projected = projection.groups.find((candidate) => candidate.group_id === id);
    if (!projected) throw new ShadowProcessingError("projection_mismatch", "A normalized source group is missing from the shadow projection.");
    requireRegister(projected.title, group.title, "group title");
    requireRegister(projected.position, group.position, "group position");
  }
  for (const document of source.documents) {
    const id = resolveIdentity(runtime, "document", document.source_document_id) as DocumentId;
    const projected = projection.documents.find((candidate) => candidate.document_id === id);
    if (!projected) throw new ShadowProcessingError("projection_mismatch", "A normalized source document is missing from the shadow projection.");
    requireRegister(projected.title, document.title, "document title");
    requireRegister(projected.logical_path, document.logical_path, "document path");
    requireRegister(projected.position, document.position, "document position");
    requireRegister(projected.archive_status, document.archive_status, "document archive status");
    if (document.source_group_id === null) {
      if (projected.group.state !== "unset") throw new ShadowProcessingError("projection_mismatch", "Document group differs from normalized source state.");
    } else {
      requireRegister(projected.group, resolveIdentity(runtime, "group", document.source_group_id), "document group");
    }
    if (document.content) {
      await assertDocumentContentEquivalent(runtime, projection, projected, document);
    }
  }
  if (projection.conflicts.length > 0) {
    throw new ShadowProcessingError("projection_mismatch", "Shadow conflicts have no matching normalized legacy shared-state facts.");
  }
}

async function assertDocumentContentEquivalent(
  runtime: Runtime,
  projection: CollaborationProjection,
  projected: CollaborationProjection["documents"][number],
  sourceDocument: ShadowLegacyDocument
): Promise<void> {
  const content = sourceDocument.content!;
  const revisionHeads = projection.revision_heads.find(
    (entry) => entry.document_id === projected.document_id
  )?.head_revision_ids ?? [];
  if (revisionHeads.length !== 1) {
    throw new ShadowProcessingError(
      "projection_mismatch",
      "Normalized source Markdown requires one unambiguous shadow revision head."
    );
  }
  const revisions = new ImmutableCollaborationStore({ backend: runtime.backend });
  const revision = await revisions.getRevision(revisionHeads[0]);
  if (revision.status !== "valid") {
    throw new ShadowProcessingError("shadow_corrupt", "Current shadow revision cannot be reopened.");
  }
  const blob = await revisions.getMarkdownBlob(
    runtime.plan.destination_project_id,
    revision.value.core.markdown_blob_id
  );
  if (blob.status !== "valid") {
    throw new ShadowProcessingError("shadow_corrupt", "Current shadow Markdown blob cannot be reopened.");
  }
  if (!bytesEqual(blob.value.bytes, content.exact_markdown_bytes)) {
    throw new ShadowProcessingError(
      "projection_mismatch",
      "Current shadow Markdown bytes differ from the normalized legacy source."
    );
  }
  for (const comment of content.comments) {
    const id = resolveIdentity(runtime, "comment", comment.source_comment_id);
    const actual = projected.comments.find((candidate) => candidate.comment_id === id);
    if (!actual) throw new ShadowProcessingError("projection_mismatch", "A normalized source comment is missing from the shadow projection.");
    requireRegister(actual.body, comment.body, "comment body");
    requireRegister(actual.anchor, `${comment.anchor.kind}:${comment.anchor.key}`, "comment anchor");
    requireRegister(actual.status, comment.status, "comment status");
    if (comment.trash_status === "trashed") {
      if (actual.trash_status === undefined) {
        throw new ShadowProcessingError("projection_mismatch", "Trashed source comment is active in the shadow projection.");
      }
      requireRegister(actual.trash_status, "trashed", "comment trash status");
    } else if (actual.trash_status !== undefined) {
      requireRegister(actual.trash_status, "active", "comment trash status");
    }
    if (Boolean(actual.tombstone) !== comment.tombstone) throw new ShadowProcessingError("projection_mismatch", "Comment tombstone differs from normalized source state.");
    for (const reply of comment.replies) {
      const replyId = resolveIdentity(runtime, "reply", reply.source_reply_id);
      const actualReply = actual.replies.find((candidate) => candidate.reply_id === replyId);
      if (!actualReply) throw new ShadowProcessingError("projection_mismatch", "A normalized source reply is missing from the shadow projection.");
      requireRegister(actualReply.body, reply.body, "reply body");
      if (Boolean(actualReply.tombstone) !== reply.tombstone) throw new ShadowProcessingError("projection_mismatch", "Reply tombstone differs from normalized source state.");
    }
  }
  for (const patch of content.patches) {
    const patchId = resolveIdentity(runtime, "patch", patch.source_patch_id);
    const actual = projected.patches.find((candidate) => candidate.patch_id === patchId);
    const versionId = runtime.patchVersions.get(patchVersionKey(sourceDocument.source_document_id, patch.source_patch_id));
    const version = actual?.versions.find((candidate) => candidate.patch_version_id === versionId);
    if (!version) throw new ShadowProcessingError("projection_mismatch", "A normalized source patch version is missing from the shadow projection.");
    const expectedDecision = patch.status === "pending" || patch.status === "stale" ? "pending" : patch.status;
    if (expectedDecision === "pending") {
      if (version.decision.state !== "unset") {
        throw new ShadowProcessingError("projection_mismatch", "Shadow patch decision differs from normalized source state.");
      }
    } else {
      requireRegister(version.decision, expectedDecision, "patch decision");
    }
  }
  for (const batch of content.review_batches) {
    const id = resolveIdentity(runtime, "review-batch", batch.source_review_batch_id);
    const actual = projectedReview(runtime, id);
    requireRegister(actual.lifecycle, batch.lifecycle, "review lifecycle");
    if (batch.response_import_id === null) {
      requireUnsetRegister(
        actual.response_evidence_commitment,
        "review response evidence commitment"
      );
      requireUnsetRegister(actual.response_import_id, "review response import ID");
      requireStringArray(
        actual.contribution_payload_ids,
        [],
        "review contribution payload IDs"
      );
    } else {
      const mapped = batch.contribution_source_refs.map((reference) =>
        runtime.contributionPayloads.get(reference)
      );
      const contributionPayloadIds = mapped.every(
        (payloadId): payloadId is SemanticPayloadId => payloadId !== undefined
      )
        ? [...mapped].sort()
        : actual.contribution_payload_ids.length === 0
          ? []
          : (() => {
              throw new ShadowProcessingError(
                "projection_mismatch",
                "Review contribution mappings are incomplete for a nonempty projection."
              );
            })();
      const evidence = await deriveReviewResponseEvidence({
        schema_version: 1,
        project_id: runtime.plan.destination_project_id,
        review_batch_id: id as ReviewBatchId,
        response_import_id: parseReviewResponseImportId(
          batch.response_import_id
        ),
        contribution_payload_ids: contributionPayloadIds
      });
      requireRegister(
        actual.response_evidence_commitment,
        evidence.commitment,
        "review response evidence commitment"
      );
      requireRegister(
        actual.response_import_id,
        batch.response_import_id,
        "review response import ID"
      );
      requireStringArray(
        actual.contribution_payload_ids,
        contributionPayloadIds,
        "review contribution payload IDs"
      );
    }
  }
  for (const rewrite of content.rewrite_sessions) {
    const id = resolveIdentity(runtime, "rewrite-session", rewrite.source_rewrite_session_id);
    const actual = projectedRewrite(runtime, id);
    const expected = rewrite.outcome === "applied"
      ? actual.outcome.resolved_value
      : rewrite.outcome;
    if (rewrite.outcome === "applied") {
      if (!expected?.startsWith("applied:")) throw new ShadowProcessingError("projection_mismatch", "Applied rewrite revision is missing from shadow projection.");
    } else {
      requireRegister(actual.outcome, expected, "rewrite outcome");
    }
  }

  function projectedReview(_runtime: Runtime, id: string) {
    const value = projection.review_batches.find((candidate) => candidate.review_batch_id === id);
    if (!value) throw new ShadowProcessingError("projection_mismatch", "A normalized source review batch is missing from the shadow projection.");
    return value;
  }
  function projectedRewrite(_runtime: Runtime, id: string) {
    const value = projection.rewrite_sessions.find((candidate) => candidate.rewrite_session_id === id);
    if (!value) throw new ShadowProcessingError("projection_mismatch", "A normalized source rewrite is missing from the shadow projection.");
    return value;
  }
}

async function resolveOrAllocate(
  runtime: Runtime,
  kind: DestinationIdentityKind,
  sourceIdentity: string,
  sourceDocumentId: string | null
): Promise<string> {
  const existing = runtime.mappings.get(mappingKey(kind, sourceIdentity));
  if (existing) return existing.authoritative_id;
  const allocated = await runtime.identityAllocator.allocate({
    identity_kind: kind,
    source_identity: sourceIdentity,
    source_project_id: runtime.metadata.source_project_id,
    source_document_id: sourceDocumentId
  });
  const authoritative = parseEntityId(kind, allocated);
  if ([...new Set(runtime.mappings.values())].some((mapping) => mapping.authoritative_id === authoritative)) {
    throw new ShadowProcessingError("missing_mapping", "Injected identity allocator returned an occupied shadow identity.");
  }
  const mapping = Object.freeze({
    identity_kind: kind,
    source_identity: sourceIdentity,
    source_key: `development:${kind}:${sourceIdentity}`,
    authoritative_id: authoritative,
    origin: "development_allocated" as const,
    authority: "none" as const,
    scope_source_document_id: sourceDocumentId
  });
  addMapping(runtime.mappings, mapping);
  runtime.metadata = Object.freeze({
    ...runtime.metadata,
    identity_mappings: Object.freeze([...new Set(runtime.mappings.values())].sort(mappingCompare))
  });
  await writeMetadata(runtime);
  return authoritative;
}

function resolveIdentity(runtime: Runtime, kind: DestinationIdentityKind, sourceIdentity: string): string {
  const mapping = runtime.mappings.get(mappingKey(kind, sourceIdentity));
  if (!mapping) {
    throw new ShadowProcessingError(
      "missing_mapping",
      `No exact ${kind} mapping exists for source identity ${sourceIdentity}.`
    );
  }
  return parseEntityId(kind, mapping.authoritative_id);
}

async function writeMetadata(runtime: Runtime): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(runtime.metadata)}\n`);
  await runtime.backend.write(
    runtime.backend.metadata_address(),
    bytes,
    metadataWriteContext
  );
}

async function verifyPersistedMetadata(runtime: Runtime): Promise<void> {
  const stored = await runtime.backend.read(runtime.backend.metadata_address());
  if (stored === null) {
    throw new ShadowProcessingError("shadow_corrupt", "Experimental shadow metadata is missing.");
  }
  const expected = `${JSON.stringify(runtime.metadata)}\n`;
  let actual: string;
  try {
    actual = new TextDecoder("utf-8", { fatal: true }).decode(stored);
    JSON.parse(actual);
  } catch {
    throw new ShadowProcessingError("shadow_corrupt", "Experimental shadow metadata is corrupted.");
  }
  if (actual !== expected) {
    throw new ShadowProcessingError("shadow_corrupt", "Experimental shadow metadata differs from the active initialized runtime.");
  }
}

async function markDiverged(
  runtime: Runtime,
  outcome: ShadowEquivalenceOutcome,
  reason: string
): Promise<void> {
  runtime.metadata = Object.freeze({
    ...runtime.metadata,
    bootstrap_status: outcome === "shadow_corrupt" ? "invalid" : "requires_rebootstrap",
    latest_outcome: outcome,
    failure_reason: reason
  });
  await writeMetadata(runtime).catch(() => undefined);
}

function metadataPayload(runtime: Runtime, data: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    project_id: runtime.plan.destination_project_id,
    semantic_kind: "metadata_operation",
    data
  };
}

function reviewPayload(runtime: Runtime, data: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    project_id: runtime.plan.destination_project_id,
    semantic_kind: "review_batch_operation",
    data
  };
}

function rewritePayload(runtime: Runtime, data: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    project_id: runtime.plan.destination_project_id,
    semantic_kind: "rewrite_operation",
    data
  };
}

function sharedAnchor(comment: ShadowLegacyComment): Readonly<{
  anchor_kind: "document" | "section" | "selected_text";
  anchor_key: string;
}> {
  return Object.freeze({
    anchor_kind: comment.anchor.kind,
    anchor_key: comment.anchor.key
  });
}

function requireRegister(register: ProjectedValueRegister, expected: string | null, label: string): void {
  if (register.state !== "resolved" || register.resolved_value !== expected) {
    throw new ShadowProcessingError("projection_mismatch", `Shadow ${label} differs from normalized source state.`);
  }
}

function requireUnsetRegister(register: ProjectedValueRegister, label: string): void {
  if (register.state !== "unset") {
    throw new ShadowProcessingError(
      "projection_mismatch",
      `Shadow ${label} is unexpectedly set.`
    );
  }
}

function requireStringArray(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new ShadowProcessingError("projection_mismatch", `Shadow ${label} differs from normalized source state.`);
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameRoots(left: ShadowRoots, right: ShadowRoots): boolean {
  return left.semantic_state_root === right.semantic_state_root &&
    left.revision_heads_root === right.revision_heads_root &&
    left.conflict_set_root === right.conflict_set_root;
}

function mappingCompare(left: ShadowIdentityMapping, right: ShadowIdentityMapping): number {
  return `${left.identity_kind}\u0000${left.source_identity}`.localeCompare(
    `${right.identity_kind}\u0000${right.source_identity}`
  );
}

function mappingKey(kind: DestinationIdentityKind, sourceIdentity: string): string {
  return `${kind}\u0000${sourceIdentity}`;
}

function patchVersionKey(sourceDocumentId: string, sourcePatchId: string): string {
  return `${sourceDocumentId}\u0000${sourcePatchId}`;
}

function requireIdentityAllocator(value: DevelopmentShadowIdentityAllocator): void {
  if (
    !value ||
    value.capability !== "injected_secure_identity_allocator_v1" ||
    typeof value.allocate !== "function"
  ) {
    throw new Error("Development shadow initialization requires an injected secure identity allocator.");
  }
}

function classifyUnexpectedFailure(error: unknown): ShadowEquivalenceOutcome {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("missing") || message.includes("dependency")) return "shadow_dependency_missing";
  if (message.includes("corrupt") || message.includes("mismatch")) return "shadow_corrupt";
  return "projection_mismatch";
}

function result(
  outcome: ShadowEquivalenceOutcome,
  sourceProjectId: string | null,
  shadowProjectId: string | null,
  requiresRebootstrap: boolean,
  diagnostic: string
): CollaborationShadowResult {
  return Object.freeze({
    mode: "development_shadow" as const,
    outcome,
    source_project_id: sourceProjectId,
    shadow_project_id: shadowProjectId,
    requires_rebootstrap: requiresRebootstrap,
    diagnostic
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown development shadow failure.";
}
